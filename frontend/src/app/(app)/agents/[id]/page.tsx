'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import {
  ErrorBox, Loading, Empty, fmtRel, fmtTime, PageHeader, useRefreshKey, useConfirm,
  usePrompt, useToast,
} from '@/components/ui';
import { IconWarning } from '@/components/icons';
import { StatusDot } from '@/components/StatusDot';
import { AgentStatusPill, AgentDiscovery, AgentHealth, AgentHealthData, AgentLogs, SiteMultiSelect, getHubUrl } from '@/components/AgentBits';

type AgentSite = { site_id: number; site_name: string | null };
// Minimal shape needed for the "link to legacy agent" picker below — a local
// type rather than importing the full Agent type from the list page (this
// file's convention is self-contained local types, e.g. AgentDetail below).
type AgentListItem = { id: number; name: string; hostname: string | null; hub_agent_id?: string | null };
type AgentDevice = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null; snmp_enabled: boolean;
};
type AgentServiceCheck = {
  id: number; name: string; type: string; target: string; site_name: string | null;
  current_status: string; last_response_ms: number | null; last_checked_at: string | null;
};
type AgentDetail = {
  id: number; name: string; status: string; version: string | null;
  ip_address: string | null; hostname: string | null; disabled?: boolean;
  // hub_agent_id (Phase 3): set for a hub-enrolled agent — see the Agent type
  // in agents/page.tsx and CLAUDE.md's Phase 3/4a section for the full model.
  hub_agent_id?: string | null;
  last_seen_at: string | null; connected_at: string | null; created_at: string;
  sites: AgentSite[]; devices: AgentDevice[]; service_checks: AgentServiceCheck[];
  health?: AgentHealthData; latest_agent_version?: string | null;
};
type Site = { id: number; name: string };

function fmtMs(ms: number | null): string {
  return ms != null ? `${Number(ms).toFixed(0)} ms` : '—';
}

function groupDevices(devices: AgentDevice[]) {
  const map = new Map<string, { name: string; siteId: number | null; devices: AgentDevice[] }>();
  for (const d of devices) {
    const name = d.site_name || 'Unassigned';
    let g = map.get(name);
    if (!g) { g = { name, siteId: d.site_id, devices: [] }; map.set(name, g); }
    g.devices.push(d);
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ── Shared style snippets ──────────────────────────────────────
const CARD_STYLE: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '16px 20px',
};
const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  marginBottom: 8,
  letterSpacing: '0.06em',
};

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { confirm, ConfirmUI } = useConfirm();
  const { prompt, PromptUI } = usePrompt();
  const { toast, ToastUI } = useToast();
  const agent = useApi<AgentDetail>(`/api/agents/${params.id}`, 15000);
  const sites = useApi<Site[]>('/api/netvault/sites');
  const [editSites, setEditSites] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkTarget, setLinkTarget] = useState<number | ''>('');
  const [linkSaving, setLinkSaving] = useState(false);
  // Only fetched while the "Link to legacy agent" picker is open — this is a
  // hub-JWT-provisioned-row-only admin action (see the manual-link fallback
  // note in ws-server.js/server.js), so there's no reason to pull the whole
  // fleet list on every detail-page load.
  const allAgents = useApi<AgentListItem[]>(linking ? '/api/agents' : null);

  useRefreshKey(() => agent.reload());

  async function handleDelete() {
    if (!agent.data) return;
    if (!await confirm({
      title: 'Delete agent?',
      message: `Delete agent "${agent.data.name}"? Its devices will move back to local polling.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    await apiSend(`/api/agents/${params.id}`, 'DELETE');
    router.push('/agents');
  }

  async function handleToggleDisabled() {
    if (!agent.data) return;
    const next = !agent.data.disabled;
    if (next && !await confirm({
      title: 'Disable agent?',
      message: `Disable agent "${agent.data.name}"? It will be disconnected and refused until re-enabled. Its devices show as agent-offline.`,
      confirmLabel: 'Disable',
      danger: true,
    })) return;
    await apiSend(`/api/agents/${params.id}/disabled`, 'POST', { disabled: next });
    agent.reload();
  }

  async function handleRename() {
    if (!agent.data) return;
    const name = await prompt({
      title: 'Rename agent',
      label: 'Agent name',
      defaultValue: agent.data.name,
      confirmLabel: 'Rename',
    });
    if (!name || !name.trim() || name.trim() === agent.data.name) return;
    await apiSend(`/api/agents/${params.id}`, 'PUT', { name: name.trim() });
    agent.reload();
  }

  async function handleRestart() {
    if (!await confirm({
      title: 'Restart agent?',
      message: 'Restart this agent? It will reconnect within a few seconds.',
      confirmLabel: 'Restart',
      danger: true,
    })) return;
    try {
      await apiSend(`/api/agents/${params.id}/restart`, 'POST', {});
    } catch (e: any) {
      toast(e?.message || 'Restart failed', 'err');
    }
  }

  // Manual-link fallback (Phase 3 "duplicate row" fix, part 2): merges THIS
  // row (a hub-JWT-provisioned duplicate) into an admin-chosen legacy row —
  // for the ambiguous/no-hostname-yet cases ws-server.js's automatic
  // hostname link can't resolve on its own. The legacy row keeps its
  // id/history; this row is deleted, so we navigate to the legacy row after.
  async function handleLink() {
    if (!agent.data || linkTarget === '') return;
    if (!await confirm({
      title: 'Link to existing agent?',
      message: `Merge "${agent.data.name}" into the selected legacy agent? The legacy agent keeps its ` +
        `history and site assignment and is stamped with this agent's hub identity; this duplicate row ` +
        `is deleted.`,
      confirmLabel: 'Link & Merge',
      danger: true,
    })) return;
    setLinkSaving(true);
    try {
      await apiSend(`/api/agents/${params.id}/link-legacy`, 'POST', { legacy_agent_id: linkTarget });
      toast('Agents linked — redirecting to the merged agent…', 'ok');
      router.push(`/agents/${linkTarget}`);
    } catch (e: any) {
      toast(e?.message || 'Link failed', 'err');
      setLinkSaving(false);
    }
  }

  if (agent.error) return <ErrorBox message={agent.error} />;
  if (agent.loading && !agent.data) return <Loading label="Loading agent…" />;
  const a = agent.data;
  if (!a) return <Empty message="Agent not found." />;

  const groups = groupDevices(a.devices);
  const offline = a.status === 'offline';
  const statusLabel = a.status === 'online' ? 'Online' : a.status === 'offline' ? 'Offline' : 'Never';

  return (
    <div>
      {ConfirmUI}
      {PromptUI}
      {ToastUI}
      <PageHeader title={a.name} subtitle="Remote polling agent detail.">
        <AgentStatusPill status={a.status} />
        <Link href="/agents" className="sv-btn ghost">← Back to Agents</Link>
        <button className="sv-btn ghost" onClick={handleRename}>Rename</button>
        <button
          className="sv-btn ghost"
          onClick={handleRestart}
          disabled={a.status !== 'online' || !!a.hub_agent_id}
          title={a.hub_agent_id ? 'Managed by NocVault Hub — restart from the hub\'s Agents page' : undefined}
        >
          Restart
        </button>
        <button className="sv-btn ghost" onClick={handleToggleDisabled}>
          {a.disabled ? 'Enable Agent' : 'Disable Agent'}
        </button>
        <button
          className="sv-btn danger"
          onClick={handleDelete}
          disabled={!!a.hub_agent_id}
          title={a.hub_agent_id ? 'Managed by NocVault Hub — delete from the hub\'s Agents page' : undefined}
        >
          Delete Agent
        </button>
      </PageHeader>

      {a.disabled && (
        <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--red)', marginBottom: 12, fontSize: 'var(--text-base)', display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--red)' }}>
          <IconWarning width={16} height={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            This agent is <strong>disabled</strong> — its connection is refused and its devices are not being polled.
            Use <strong>Enable Agent</strong> to restore it.
          </span>
        </div>
      )}

      {/* Hub-enrolled note — restart/logs run from the hub's own command queue,
          not this app's local WS push (see CLAUDE.md's Phase 3/4a section).
          Also carries the manual-link fallback for the "duplicate row" case:
          this row is a hub-JWT auto-provisioned agent that ws-server.js's
          automatic hostname link couldn't confidently match to an existing
          legacy row — an admin can pick one here. */}
      {a.hub_agent_id && (
        <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--tint-info-fg)', marginBottom: 12, fontSize: 'var(--text-base)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <IconWarning width={16} height={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--tint-info-fg)' }} />
            <span>
              This agent is <strong>managed by the NocVault Hub</strong> — restart and log fetch run from{' '}
              <a href={`${getHubUrl()}/agents`} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>
                NetVault Hub → Agents
              </a>, not the buttons on this page. If this row is a duplicate of an existing legacy agent
              (e.g. it appeared after migrating that agent to the hub), you can merge them below.
            </span>
          </div>
          {!linking ? (
            <div style={{ marginTop: 10 }}>
              <button className="sv-btn ghost sm" onClick={() => setLinking(true)}>Link to existing agent…</button>
            </div>
          ) : (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select
                className="sv-select"
                value={linkTarget}
                onChange={(e) => setLinkTarget(e.target.value ? parseInt(e.target.value, 10) : '')}
                style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)', minWidth: 220 }}
              >
                <option value="">Select the legacy agent to merge into…</option>
                {(allAgents.data || [])
                  .filter((x) => x.id !== a.id && !x.hub_agent_id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>{x.name} {x.hostname ? `(${x.hostname})` : ''}</option>
                  ))}
              </select>
              <button className="sv-btn sm" onClick={handleLink} disabled={linkTarget === '' || linkSaving}>
                {linkSaving ? 'Merging…' : 'Link & Merge'}
              </button>
              <button className="sv-btn ghost sm" onClick={() => { setLinking(false); setLinkTarget(''); }} disabled={linkSaving}>
                Cancel
              </button>
              {allAgents.data && !allAgents.data.some((x) => x.id !== a.id && !x.hub_agent_id) && (
                <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>No legacy agents available to merge into.</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Row 1 — compact stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
        <StatCard label="Status" value={statusLabel} accent={a.status === 'online' ? 'var(--green)' : a.status === 'offline' ? 'var(--red)' : 'var(--text-muted)'} />
        <StatCard label="Devices" value={String(a.devices.length)} accent="var(--primary)" />
        <StatCard label="Version" value={a.version ? `v${a.version}` : '—'} accent="var(--text-muted)" />
        <StatCard label="Last Seen" value={fmtRel(a.last_seen_at)} accent="var(--text-muted)" />
      </div>

      {offline && (
        <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--yellow)', marginBottom: 12, fontSize: 'var(--text-base)' }}>
          ⚠ Agent is offline — its devices may be stale. Check the <strong>SpanVault-Agent</strong> service
          on {a.hostname ? <strong>{a.hostname}</strong> : 'the remote server'} (last seen {fmtRel(a.last_seen_at)}).
        </div>
      )}

      {/* Row 2 — Agent Info (40) / Assigned Sites (60) */}
      <div style={{ display: 'grid', gridTemplateColumns: '40fr 60fr', gap: 12, marginBottom: 12, alignItems: 'stretch' }}>
        {/* Left — Agent Info */}
        <div style={{ ...CARD_STYLE, display: 'flex', flexDirection: 'column' }}>
          <div style={SECTION_TITLE_STYLE}>Agent Info</div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: 6, columnGap: 12, fontSize: 'var(--text-sm)' }}>
            <dt style={{ color: 'var(--text-muted)' }}>IP</dt>
            <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{a.ip_address || '—'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Hostname</dt>
            <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{a.hostname || '—'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Connected</dt>
            <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{a.connected_at ? fmtTime(a.connected_at) : '—'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Created</dt>
            <dd style={{ margin: 0, color: 'var(--text-primary)' }}>{fmtTime(a.created_at)}</dd>
          </dl>
        </div>

        {/* Right — Assigned Sites */}
        <div style={{ ...CARD_STYLE, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ ...SECTION_TITLE_STYLE, marginBottom: 0 }}>Assigned Sites</span>
            <span style={{ flex: 1 }} />
            {!editSites && <button className="sv-btn ghost sm" onClick={() => setEditSites(true)}>Edit sites</button>}
          </div>
          {!editSites && (
            <p className="sv-muted" style={{ fontSize: 'var(--text-sm)', margin: '0 0 8px' }}>
              This agent polls <strong>every device in the sites assigned below</strong>. Assign a site here,
              then add devices to it (Devices → Import / + Add Device) or use <strong>Discover Devices</strong>.
            </p>
          )}
          {editSites ? (
            <SiteEditor
              agentId={a.id}
              allSites={sites.data || []}
              current={a.sites.map((s) => s.site_id)}
              onClose={() => setEditSites(false)}
              onSaved={() => { setEditSites(false); agent.reload(); }}
            />
          ) : a.sites.length ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={TH_STYLE}>Site</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Devices</th>
                </tr>
              </thead>
              <tbody>
                {a.sites.map((s) => {
                  const count = a.devices.filter((d) => d.site_id === s.site_id).length;
                  return (
                    <tr key={s.site_id} style={{ height: 36 }} className="sv-agent-site-row">
                      <td style={TD_STYLE}>
                        <Link href={`/sites/${s.site_id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>
                          {s.site_name || `Site ${s.site_id}`}
                        </Link>
                      </td>
                      <td style={{ ...TD_STYLE, textAlign: 'right', color: 'var(--text-muted)' }}>{count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty message="No sites assigned yet. Click “Edit sites” to assign one — every device in that site is then polled by this agent." />
          )}
        </div>
      </div>

      {a.version && a.latest_agent_version && a.version !== a.latest_agent_version && (
        <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--primary)', marginBottom: 12, fontSize: 'var(--text-base)' }}>
          ⬆ This agent is running v{a.version}; latest is v{a.latest_agent_version}. It updates itself
          automatically on its next config sync — no action needed.
        </div>
      )}

      {/* Row 2.25 — Agent host health, full width */}
      <div style={{ ...CARD_STYLE, marginBottom: 12 }}>
        <div style={SECTION_TITLE_STYLE}>Agent Host Health</div>
        <AgentHealth health={a.health ?? null} online={a.status === 'online'} />
      </div>

      {/* Row 2.5 — Zero-touch discovery, full width */}
      <div style={{ ...CARD_STYLE, marginBottom: 12 }}>
        <div style={SECTION_TITLE_STYLE}>Discover Devices on the Agent’s Network</div>
        {!a.sites.length && (
          <p className="sv-muted" style={{ fontSize: 'var(--text-sm)', margin: '0 0 8px' }}>
            Tip: assign a site above first — adopted devices are placed in one of this agent’s sites.
          </p>
        )}
        <AgentDiscovery agentId={a.id} online={a.status === 'online'} />
      </div>

      {/* Row 2.75 — Agent logs, full width */}
      <div style={{ ...CARD_STYLE, marginBottom: 12 }}>
        <div style={SECTION_TITLE_STYLE}>Agent Logs</div>
        <AgentLogs agentId={a.id} online={a.status === 'online'} hubEnrolled={!!a.hub_agent_id} />
      </div>

      {/* Row 3 — Devices grouped by site, full width */}
      <div style={{ ...CARD_STYLE, marginBottom: 12 }}>
        <div style={SECTION_TITLE_STYLE}>Devices Polled by This Agent</div>
        {!a.devices.length ? (
          <Empty message="No devices yet. Assign a site above, then import/add devices to it — or use Discover Devices to scan & adopt." />
        ) : (
          groups.map((g) => (
            <div key={g.name} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 'var(--text-base)', marginBottom: 4 }}>
                {g.siteId != null ? <Link href={`/sites/${g.siteId}`}>{g.name}</Link> : g.name}
                <span className="sv-muted" style={{ fontWeight: 400, fontSize: 'var(--text-sm)', marginLeft: 8 }}>
                  {g.devices.length} {g.devices.length === 1 ? 'device' : 'devices'}
                </span>
              </div>
              {g.devices.map((d) => (
                <div key={d.id} className="sv-dev-row" style={{ height: 36 }}>
                  <StatusDot status={d.current_status === 'agent_offline' ? 'unknown' : d.current_status} />
                  <div className="sv-dev-id">
                    <div className="nm">
                      <Link href={`/devices/${d.id}`} style={{ color: 'var(--primary)' }}>{d.name}</Link>
                    </div>
                    <div className="ip">{d.ip_address}{d.device_type ? ` · ${d.device_type}` : ''}</div>
                  </div>
                  <div className="sv-dev-lat">
                    {d.current_status === 'agent_offline' ? <span className="sv-muted">agent offline</span> : fmtMs(d.last_response_ms)}
                    <div className="sv-muted">{fmtRel(d.last_seen_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Row 4 — Service checks run by this agent, full width */}
      <div style={CARD_STYLE}>
        <div style={SECTION_TITLE_STYLE}>Service Checks Run by This Agent</div>
        {!a.service_checks.length ? (
          <Empty message="No service checks run by this agent." />
        ) : (
          a.service_checks.map((c) => (
            <div key={c.id} className="sv-dev-row" style={{ height: 36 }}>
              <StatusDot status={c.current_status} />
              <div className="sv-dev-id">
                <div className="nm">
                  <Link href={`/services/${c.id}`} style={{ color: 'var(--primary)' }}>{c.name}</Link>
                </div>
                <div className="ip">{c.target}{c.site_name ? ` · ${c.site_name}` : ''}</div>
              </div>
              <span className="sv-type-badge">{(c.type || '').toUpperCase()}</span>
              <div className="sv-dev-lat">
                {fmtMs(c.last_response_ms)}
                <div className="sv-muted">{fmtRel(c.last_checked_at)}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const TH_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  fontWeight: 600,
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
};
const TD_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
};

// ── Compact stat card (top-level component) ────────────────────
function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 'var(--radius-sm)',
        padding: '12px 16px',
        minHeight: 75,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }}
    >
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.1, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 4, letterSpacing: '0.04em' }}>
        {label}
      </div>
    </div>
  );
}

// ── Inline site editor (top-level component) ───────────────────
function SiteEditor({
  agentId, allSites, current, onClose, onSaved,
}: {
  agentId: number; allSites: Site[]; current: number[];
  onClose: () => void; onSaved: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set(current));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep selection in sync if the agent's current sites change underneath us.
  useEffect(() => { setSelected(new Set(current)); }, [current.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiSend(`/api/agents/${agentId}/sites`, 'POST', { site_ids: Array.from(selected) });
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Failed to save sites');
      setSaving(false);
    }
  }

  return (
    <div>
      {error && <div className="sv-err-inline">{error}</div>}
      <SiteMultiSelect sites={allSites} selected={selected} onToggle={toggle} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
        <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="sv-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Sites'}</button>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import {
  ErrorBox, Loading, Empty, fmtRel, fmtTime, PageHeader, useRefreshKey,
} from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import { AgentStatusPill, AgentInstall, AgentDiscovery, AgentHealth, AgentHealthData, AgentLogs, SiteMultiSelect } from '@/components/AgentBits';

type AgentSite = { site_id: number; site_name: string | null };
type AgentDevice = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null; snmp_enabled: boolean;
};
type AgentDetail = {
  id: number; name: string; status: string; version: string | null;
  ip_address: string | null; hostname: string | null; disabled?: boolean;
  last_seen_at: string | null; connected_at: string | null; created_at: string;
  sites: AgentSite[]; devices: AgentDevice[]; install_command: string;
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
  const agent = useApi<AgentDetail>(`/api/agents/${params.id}`, 15000);
  const sites = useApi<Site[]>('/api/netvault/sites');
  const [editSites, setEditSites] = useState(false);

  useRefreshKey(() => agent.reload());

  async function handleDelete() {
    if (!agent.data) return;
    if (!confirm(`Delete agent "${agent.data.name}"? Its devices will move back to local polling.`)) return;
    await apiSend(`/api/agents/${params.id}`, 'DELETE');
    router.push('/agents');
  }

  async function handleRotateKey() {
    if (!confirm('Rotate this agent\'s API key? The current key stops working immediately — you must re-run the install command (shown below) on the remote server.')) return;
    await apiSend(`/api/agents/${params.id}/rotate-key`, 'POST');
    agent.reload();
  }

  async function handleToggleDisabled() {
    if (!agent.data) return;
    const next = !agent.data.disabled;
    if (next && !confirm(`Disable agent "${agent.data.name}"? It will be disconnected and refused until re-enabled. Its devices show as agent-offline.`)) return;
    await apiSend(`/api/agents/${params.id}/disabled`, 'POST', { disabled: next });
    agent.reload();
  }

  async function handleRename() {
    if (!agent.data) return;
    const name = window.prompt('Rename agent:', agent.data.name);
    if (!name || !name.trim() || name.trim() === agent.data.name) return;
    await apiSend(`/api/agents/${params.id}`, 'PUT', { name: name.trim() });
    agent.reload();
  }

  async function handleRestart() {
    if (!confirm('Restart this agent? It will reconnect within a few seconds.')) return;
    try {
      await apiSend(`/api/agents/${params.id}/restart`, 'POST', {});
    } catch (e: any) {
      alert(e?.message || 'Restart failed');
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
      <PageHeader title={a.name} subtitle="Remote polling agent detail.">
        <AgentStatusPill status={a.status} />
        <Link href="/agents" className="sv-btn ghost">← Back to Agents</Link>
        <button className="sv-btn ghost" onClick={handleRename}>Rename</button>
        <button className="sv-btn ghost" onClick={handleRestart} disabled={a.status !== 'online'}>Restart</button>
        <button className="sv-btn ghost" onClick={handleToggleDisabled}>
          {a.disabled ? 'Enable Agent' : 'Disable Agent'}
        </button>
        <button className="sv-btn ghost" onClick={handleDelete}>Delete Agent</button>
      </PageHeader>

      {a.disabled && (
        <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--red)', marginBottom: 12, fontSize: 'var(--text-base)' }}>
          ⛔ This agent is <strong>disabled</strong> — its connection is refused and its devices are not being polled.
          Use <strong>Enable Agent</strong> to restore it.
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
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 16, marginBottom: 8 }}>
            <span style={{ ...SECTION_TITLE_STYLE, marginBottom: 0 }}>Install / Reconnect</span>
            <span style={{ flex: 1 }} />
            <button className="sv-btn ghost sm" onClick={handleRotateKey} title="Generate a new API key (old key stops working)">Rotate key</button>
          </div>
          <AgentInstall command={a.install_command} />
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
        <AgentLogs agentId={a.id} online={a.status === 'online'} />
      </div>

      {/* Row 3 — Devices grouped by site, full width */}
      <div style={CARD_STYLE}>
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

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import {
  ErrorBox, Loading, Empty, fmtRel, fmtTime, PageHeader, useRefreshKey,
} from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import { AgentStatusPill, AgentInstall, SiteMultiSelect } from '@/components/AgentBits';

type AgentSite = { site_id: number; site_name: string | null };
type AgentDevice = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null; snmp_enabled: boolean;
};
type AgentDetail = {
  id: number; name: string; status: string; version: string | null;
  ip_address: string | null; hostname: string | null;
  last_seen_at: string | null; connected_at: string | null; created_at: string;
  sites: AgentSite[]; devices: AgentDevice[]; install_command: string;
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

  if (agent.error) return <ErrorBox message={agent.error} />;
  if (agent.loading && !agent.data) return <Loading label="Loading agent…" />;
  const a = agent.data;
  if (!a) return <Empty message="Agent not found." />;

  const groups = groupDevices(a.devices);
  const offline = a.status === 'offline';

  return (
    <div>
      <PageHeader title={a.name} subtitle="Remote polling agent detail.">
        <Link href="/agents" className="sv-btn ghost">← Back to Agents</Link>
        <button className="sv-btn ghost" onClick={handleDelete}>Delete Agent</button>
      </PageHeader>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <AgentStatusPill status={a.status} />
        <span className="sv-muted" style={{ fontSize: 13 }}>{a.version ? `v${a.version}` : 'version unknown'}</span>
        {a.hostname && <span className="sv-muted" style={{ fontSize: 13 }}>· {a.hostname}</span>}
        {a.ip_address && <span className="sv-muted" style={{ fontSize: 13 }}>· {a.ip_address}</span>}
      </div>

      {/* Status cards */}
      <div className="sv-cards">
        <div className="sv-card total">
          <div className="num" style={{ fontSize: 20 }}>{a.status === 'online' ? 'Online' : a.status === 'offline' ? 'Offline' : 'Never'}</div>
          <div className="label">Status</div>
        </div>
        <div className="sv-card">
          <div className="num" style={{ fontSize: 20 }}>{fmtRel(a.last_seen_at)}</div>
          <div className="label">Last seen</div>
        </div>
        <div className="sv-card">
          <div className="num">{a.devices.length}</div>
          <div className="label">Devices</div>
        </div>
        <div className="sv-card">
          <div className="num">{a.sites.length}</div>
          <div className="label">Sites</div>
        </div>
      </div>

      {offline && (
        <div className="sv-panel" style={{ borderLeft: '4px solid var(--sv-warning)', marginBottom: 18 }}>
          ⚠ Agent is offline — its devices may be stale. Check the <strong>SpanVault-Agent</strong> service
          on {a.hostname ? <strong>{a.hostname}</strong> : 'the remote server'} (last seen {fmtRel(a.last_seen_at)}).
        </div>
      )}

      {/* Assigned sites */}
      <div className="sv-panel">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Assigned Sites</h2>
          <span style={{ flex: 1 }} />
          {!editSites && <button className="sv-btn ghost sm" onClick={() => setEditSites(true)}>Edit sites</button>}
        </div>
        {editSites ? (
          <SiteEditor
            agentId={a.id}
            allSites={sites.data || []}
            current={a.sites.map((s) => s.site_id)}
            onClose={() => setEditSites(false)}
            onSaved={() => { setEditSites(false); agent.reload(); }}
          />
        ) : a.sites.length ? (
          <div className="sv-agent-sites">
            {a.sites.map((s) => (
              <Link key={s.site_id} href={`/sites/${s.site_id}`} className="sv-pill unknown">
                {s.site_name || `Site ${s.site_id}`}
              </Link>
            ))}
          </div>
        ) : (
          <Empty message="No sites assigned. Edit sites to assign devices to this agent." />
        )}
      </div>

      {/* Devices grouped by site */}
      <div className="sv-panel">
        <h2 style={{ marginTop: 0 }}>Devices Polled by This Agent</h2>
        {!a.devices.length ? (
          <Empty message="No devices assigned to this agent yet." />
        ) : (
          groups.map((g) => (
            <div key={g.name} style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
                {g.siteId != null ? <Link href={`/sites/${g.siteId}`}>{g.name}</Link> : g.name}
                <span className="sv-muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
                  {g.devices.length} {g.devices.length === 1 ? 'device' : 'devices'}
                </span>
              </div>
              {g.devices.map((d) => (
                <div key={d.id} className="sv-dev-row">
                  <StatusDot status={d.current_status === 'agent_offline' ? 'unknown' : d.current_status} />
                  <div className="sv-dev-id">
                    <div className="nm">
                      <Link href={`/devices/${d.id}`} style={{ color: 'var(--sv-crimson)' }}>{d.name}</Link>
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

      {/* Reconnect / install info */}
      <div className="sv-panel">
        <h2 style={{ marginTop: 0 }}>Install / Reconnect</h2>
        <p className="sv-muted" style={{ fontSize: 13, marginTop: 0 }}>
          Run this on the remote server to (re)install the agent. Created {fmtTime(a.created_at)}.
        </p>
        <AgentInstall command={a.install_command} />
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

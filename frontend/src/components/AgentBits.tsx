'use client';

import { useMemo, useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { fmtRel, useTableSort, sortRows, SortTh } from '@/components/ui';

// Discovery rows never expire — a candidate this old may have been reassigned
// by DHCP to a different device since the agent last saw it.
const STALE_DISCOVERY_MS = 7 * 86400 * 1000;

type Site = { id: number; name: string };

// Hub URL — derived from the current page's own hostname, matching the same
// pattern used by TopBar.tsx / LicenseGuard.tsx / sso/page.tsx (each keeps
// its own small copy rather than a shared export — see CLAUDE.md's "no
// hardcoded IPs" section). Only ever rendered client-side (agent pages are
// 'use client'), so there's no SSR/hydration mismatch risk in practice.
export function getHubUrl(): string {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  return process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
}

// ── Status pill (online / offline / never connected) ───────────
export function AgentStatusPill({ status }: { status: string }) {
  const s = (status || 'never_connected').toLowerCase();
  if (s === 'online') return <span className="sv-agent-status online">● Online</span>;
  if (s === 'offline') return <span className="sv-agent-status offline">○ Offline</span>;
  return <span className="sv-agent-status never">○ Never connected</span>;
}

// ── Live log tail (pulled on demand from the agent) ────────────
// hubEnrolled: true for a hub-JWT agent (hub_agent_id set) — its logs are
// pulled from the NetVault hub's own command queue, not this app's local WS
// request/response, so the fetch button is replaced with a note instead of
// being wired to a call the API now refuses server-side anyway.
export function AgentLogs({ agentId, online, hubEnrolled }: { agentId: number; online: boolean; hubEnrolled?: boolean }) {
  const [polling, setPolling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const logs = useApi<{ lines: string[]; ts: number | null }>(
    `/api/agents/${agentId}/logs`, polling ? 2000 : 0);

  async function refresh() {
    setMsg(null);
    try {
      await apiSend(`/api/agents/${agentId}/logs/refresh`, 'POST', {});
      setPolling(true);
      setTimeout(() => logs.reload(), 1200);
      setTimeout(() => { setPolling(false); logs.reload(); }, 8000);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to request logs.');
    }
  }

  if (hubEnrolled) {
    return (
      <p className="sv-muted" style={{ fontSize: 'var(--text-base)', margin: 0 }}>
        Managed by NocVault Hub — this agent's logs are pulled from{' '}
        <a href={`${getHubUrl()}/agents`} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>
          NetVault Hub → Agents
        </a>, not this page.
      </p>
    );
  }

  const lines = logs.data?.lines || [];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button className="sv-btn ghost sm" onClick={refresh} disabled={!online}>
          {polling ? 'Fetching…' : 'Fetch logs'}
        </button>
        {!online && <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>Agent must be online.</span>}
      </div>
      {msg && <div className="sv-err-inline">{msg}</div>}
      {lines.length ? (
        <pre style={{
          margin: 0, maxHeight: 300, overflow: 'auto', fontSize: 'var(--text-xs)', lineHeight: 1.5,
          background: 'var(--bg-code, #0b1020)', color: 'var(--text-code, #cbd5e1)',
          padding: '10px 12px', borderRadius: 'var(--radius-sm)', whiteSpace: 'pre-wrap',
        }}>
          {lines.join('\n')}
        </pre>
      ) : (
        <p className="sv-muted" style={{ fontSize: 'var(--text-base)', margin: 0 }}>
          No logs yet — click <strong>Fetch logs</strong> to pull the agent’s recent output.
        </p>
      )}
    </div>
  );
}

// ── Agent host health ──────────────────────────────────────────
export type AgentHealthData = {
  cpu_pct: number | null; mem_pct: number | null; disk_pct: number | null;
  host_uptime_s: number | null; agent_uptime_s: number | null;
  device_count: number | null; buffer_depth: number | null;
} | null;

function pctColor(v: number | null): string {
  if (v == null) return 'var(--text-muted)';
  if (v >= 90) return 'var(--red)';
  if (v >= 70) return 'var(--yellow)';
  return 'var(--green)';
}
function fmtDuration(s: number | null): string {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function AgentHealth({ health, online }: { health: AgentHealthData; online: boolean }) {
  if (!online || !health) {
    return <p className="sv-muted" style={{ fontSize: 'var(--text-base)', margin: 0 }}>
      {online ? 'Waiting for the agent’s first health report…' : 'Agent offline — no live health data.'}
    </p>;
  }
  const metric = (label: string, v: number | null, unit = '%') => (
    <div style={{ flex: '1 1 80px', minWidth: 80 }}>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: pctColor(unit === '%' ? v : null) }}>
        {v == null ? '—' : `${v}${unit}`}
      </div>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {metric('Host CPU', health.cpu_pct)}
        {metric('Host Mem', health.mem_pct)}
        {metric('Disk', health.disk_pct)}
        <div style={{ flex: '1 1 90px', minWidth: 90 }}>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: (health.buffer_depth || 0) > 0 ? 'var(--yellow)' : 'var(--text-primary)' }}>
            {health.buffer_depth ?? 0}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em' }}>Buffered</div>
        </div>
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 10 }}>
        Agent up {fmtDuration(health.agent_uptime_s)} · host up {fmtDuration(health.host_uptime_s)} · polling {health.device_count ?? 0} device{health.device_count === 1 ? '' : 's'}
      </div>
    </div>
  );
}

// ── Zero-touch discovery: scan the agent's LAN + adopt devices ──
type Discovered = {
  id: number; ip_address: string; sys_name: string | null; sys_descr: string | null;
  snmp_ok: boolean; adopted: boolean; already_monitored: boolean; last_seen_at: string;
};

export function AgentDiscovery({ agentId, online }: { agentId: number; online: boolean }) {
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [subnets, setSubnets] = useState('');
  const [communities, setCommunities] = useState('');
  const disc = useApi<Discovered[]>(`/api/agents/${agentId}/discovered`, scanning ? 4000 : 0);
  const rows = disc.data || [];
  const { sort, onSort } = useTableSort();
  // Sorting sits on top of whatever the API returned — no default sort, so the
  // server's own ordering is what shows until a header is clicked.
  const sortedRows = useMemo(() => sortRows(rows, sort, {
    ip: (r) => r.ip_address,
    name: (r) => r.sys_name,
    snmp: (r) => (r.snmp_ok ? 1 : 0),
    lastseen: (r) => r.last_seen_at,
    status: (r) => (r.already_monitored || r.adopted ? 'monitored' : 'new'),
  }), [rows, sort]);

  async function scan() {
    setMsg(null);
    setBusy(true);
    try {
      const body: { subnets?: string[]; communities?: string[] } = {};
      const sn = subnets.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      const co = communities.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (sn.length) body.subnets = sn;
      if (co.length) body.communities = co;
      await apiSend(`/api/agents/${agentId}/discover`, 'POST', body);
      setScanning(true);
      setMsg(sn.length
        ? `Scanning ${sn.join(', ')}… new devices appear below as they are found.`
        : 'Scanning the agent’s local network… new devices appear below as they are found.');
      setTimeout(() => { setScanning(false); disc.reload(); }, 60000);
    } catch (e: any) {
      setMsg(e?.message || 'Failed to start the scan.');
    } finally {
      setBusy(false);
    }
  }

  function toggle(ip: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ip)) next.delete(ip); else next.add(ip);
      return next;
    });
  }

  async function adopt() {
    const ips = Array.from(selected);
    if (!ips.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiSend<{ adopted: number; skipped?: { ip_address: string; reason: string }[] }>(
        `/api/agents/${agentId}/discovered/adopt`, 'POST', { ips });
      const skipped = r.skipped || [];
      let text = `Adopted ${r.adopted} device${r.adopted === 1 ? '' : 's'} — now polled by this agent.`;
      if (skipped.length) {
        const ipList = skipped.map((s) => s.ip_address).join(', ');
        text += ` ${skipped.length} skipped (already monitored elsewhere): ${ipList}.`;
      }
      setMsg(text);
      setSelected(new Set());
      disc.reload();
    } catch (e: any) {
      setMsg(e?.message || 'Adopt failed.');
    } finally {
      setBusy(false);
    }
  }

  const adoptable = rows.filter((r) => !r.already_monitored && !r.adopted);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 10 }}>
        <label className="sv-field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>Subnets to scan <span className="sv-muted">(optional — blank = agent’s local /24)</span></span>
          <input className="sv-input" value={subnets} onChange={(e) => setSubnets(e.target.value)}
            placeholder="e.g. 192.168.6.0/24, 10.0.0.0/24" disabled={scanning} />
        </label>
        <label className="sv-field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>SNMP communities <span className="sv-muted">(optional — blank = public)</span></span>
          <input className="sv-input" value={communities} onChange={(e) => setCommunities(e.target.value)}
            placeholder="e.g. public, private" disabled={scanning} />
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <button className="sv-btn" onClick={scan} disabled={!online || busy || scanning}>
          {scanning ? 'Scanning…' : 'Scan for devices'}
        </button>
        {selected.size > 0 && (
          <button className="sv-btn ghost" onClick={adopt} disabled={busy}>
            Adopt {selected.size} selected
          </button>
        )}
        {!online && <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>Agent must be online to scan.</span>}
        <span style={{ flex: 1 }} />
        {!!rows.length && (
          <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
            {rows.length} found · {adoptable.length} new
          </span>
        )}
      </div>

      {msg && <div className="sv-err-inline" style={{ background: 'transparent', color: 'var(--text-muted)', borderColor: 'var(--border)' }}>{msg}</div>}

      {!rows.length ? (
        <p className="sv-muted" style={{ fontSize: 'var(--text-base)' }}>
          No devices discovered yet. Click <strong>Scan for devices</strong> — the agent will sweep its
          local network (ICMP + SNMP) and list everything it finds here for one-click adoption.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...DISC_TH, width: 34 }}></th>
              <SortTh label="IP" col="ip" sort={sort} onSort={onSort} style={DISC_TH} />
              <SortTh label="Name" col="name" sort={sort} onSort={onSort} style={DISC_TH} />
              <SortTh label="SNMP" col="snmp" sort={sort} onSort={onSort} style={DISC_TH} />
              <SortTh label="Last Seen" col="lastseen" sort={sort} onSort={onSort} style={DISC_TH} />
              <SortTh label="Status" col="status" sort={sort} onSort={onSort} style={DISC_TH} />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const taken = r.already_monitored || r.adopted;
              const lastSeenMs = r.last_seen_at ? Date.now() - new Date(r.last_seen_at).getTime() : null;
              const stale = lastSeenMs != null && !isNaN(lastSeenMs) && lastSeenMs > STALE_DISCOVERY_MS;
              return (
                <tr key={r.ip_address} style={{ height: 34 }}>
                  <td style={DISC_TD}>
                    <input
                      type="checkbox"
                      disabled={taken}
                      checked={selected.has(r.ip_address)}
                      onChange={() => toggle(r.ip_address)}
                    />
                  </td>
                  <td style={DISC_TD}>{r.ip_address}</td>
                  <td style={{ ...DISC_TD, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={r.sys_descr || ''}>
                    {r.sys_name || <span className="sv-muted">—</span>}
                  </td>
                  <td style={DISC_TD}>{r.snmp_ok ? '✓' : <span className="sv-muted">—</span>}</td>
                  <td style={DISC_TD} title={stale ? 'Seen more than 7 days ago — this IP may have been reassigned since.' : ''}>
                    <span style={stale ? { color: 'var(--yellow)', fontWeight: 700 } : { color: 'var(--text-muted)' }}>
                      {stale && '⚠ '}{fmtRel(r.last_seen_at)}
                    </span>
                  </td>
                  <td style={DISC_TD}>
                    {taken
                      ? <span className="sv-muted">monitored</span>
                      : <span style={{ color: 'var(--green)' }}>new</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const DISC_TH: React.CSSProperties = {
  fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600,
  textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border)',
};
const DISC_TD: React.CSSProperties = {
  fontSize: 'var(--text-sm)', padding: '6px 10px', borderBottom: '1px solid var(--border)',
};

// ── Multi-select site list (checkboxes) ────────────────────────
export function SiteMultiSelect({
  sites, selected, onToggle,
}: {
  sites: Site[]; selected: Set<number>; onToggle: (id: number) => void;
}) {
  if (!sites.length) return <p className="sv-muted" style={{ fontSize: 'var(--text-base)' }}>No sites available from NetVault.</p>;
  return (
    <div className="sv-site-picker">
      {sites.map((s) => (
        <label key={s.id} className={`sv-site-opt ${selected.has(s.id) ? 'on' : ''}`}>
          <input type="checkbox" checked={selected.has(s.id)} onChange={() => onToggle(s.id)} />
          <span>{s.name}</span>
        </label>
      ))}
    </div>
  );
}


'use client';

import { useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { useEscape } from '@/components/ui';

type Site = { id: number; name: string };

// ── Live "waiting for the agent to connect" indicator ──────────
// Polls the agent's status after the install command is shown, so the operator
// gets immediate feedback the moment the remote service connects.
export function AgentConnectWaiter({ agentId }: { agentId: number }) {
  const agent = useApi<{ status: string; hostname: string | null; version: string | null }>(
    `/api/agents/${agentId}`, 3000
  );
  const status = (agent.data?.status || '').toLowerCase();
  const online = status === 'online';
  return (
    <div className={`sv-agent-wait ${online ? 'ok' : ''}`} style={{
      display: 'flex', alignItems: 'center', gap: 10, marginTop: 14,
      padding: '10px 12px', borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border)',
      background: online ? 'rgba(34,197,94,0.08)' : 'var(--bg-subtle, transparent)',
    }}>
      <span style={{
        width: 10, height: 10, borderRadius: '50%', flex: 'none',
        background: online ? 'var(--green)' : 'var(--yellow)',
        boxShadow: online ? '0 0 0 3px rgba(34,197,94,0.25)' : 'none',
        animation: online ? 'none' : 'pulse 1.4s ease-in-out infinite',
      }} />
      {online ? (
        <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
          <strong>Connected!</strong> {agent.data?.hostname || 'agent'}
          {agent.data?.version ? ` · v${agent.data.version}` : ''} is online.
        </span>
      ) : (
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Waiting for the agent to connect… run the command above on the remote server.
        </span>
      )}
    </div>
  );
}

// ── Status pill (online / offline / never connected) ───────────
export function AgentStatusPill({ status }: { status: string }) {
  const s = (status || 'never_connected').toLowerCase();
  if (s === 'online') return <span className="sv-agent-status online">● Online</span>;
  if (s === 'offline') return <span className="sv-agent-status offline">○ Offline</span>;
  return <span className="sv-agent-status never">○ Never connected</span>;
}

// ── Install-command box with copy button ───────────────────────
export function AgentInstall({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be blocked */ }
  }
  return (
    <div className="sv-install-box">
      <code className="sv-install-cmd">{command}</code>
      <button className="sv-btn sm" onClick={copy}>{copied ? 'Copied!' : 'Copy command'}</button>
    </div>
  );
}

// ── Live log tail (pulled on demand from the agent) ────────────
export function AgentLogs({ agentId, online }: { agentId: number; online: boolean }) {
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

  const lines = logs.data?.lines || [];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button className="sv-btn ghost sm" onClick={refresh} disabled={!online}>
          {polling ? 'Fetching…' : 'Fetch logs'}
        </button>
        {!online && <span className="sv-muted" style={{ fontSize: 12 }}>Agent must be online.</span>}
      </div>
      {msg && <div className="sv-err-inline">{msg}</div>}
      {lines.length ? (
        <pre style={{
          margin: 0, maxHeight: 300, overflow: 'auto', fontSize: 11.5, lineHeight: 1.5,
          background: 'var(--bg-code, #0b1020)', color: 'var(--text-code, #cbd5e1)',
          padding: '10px 12px', borderRadius: 'var(--radius-sm)', whiteSpace: 'pre-wrap',
        }}>
          {lines.join('\n')}
        </pre>
      ) : (
        <p className="sv-muted" style={{ fontSize: 13, margin: 0 }}>
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
    return <p className="sv-muted" style={{ fontSize: 13, margin: 0 }}>
      {online ? 'Waiting for the agent’s first health report…' : 'Agent offline — no live health data.'}
    </p>;
  }
  const metric = (label: string, v: number | null, unit = '%') => (
    <div style={{ flex: '1 1 80px', minWidth: 80 }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: pctColor(unit === '%' ? v : null) }}>
        {v == null ? '—' : `${v}${unit}`}
      </div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {metric('Host CPU', health.cpu_pct)}
        {metric('Host Mem', health.mem_pct)}
        {metric('Disk', health.disk_pct)}
        <div style={{ flex: '1 1 90px', minWidth: 90 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: (health.buffer_depth || 0) > 0 ? 'var(--yellow)' : 'var(--text-primary)' }}>
            {health.buffer_depth ?? 0}
          </div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em' }}>Buffered</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
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
      const r = await apiSend<{ adopted: number }>(
        `/api/agents/${agentId}/discovered/adopt`, 'POST', { ips });
      setMsg(`Adopted ${r.adopted} device${r.adopted === 1 ? '' : 's'} — now polled by this agent.`);
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
          <span style={{ fontSize: 12 }}>Subnets to scan <span className="sv-muted">(optional — blank = agent’s local /24)</span></span>
          <input className="sv-input" value={subnets} onChange={(e) => setSubnets(e.target.value)}
            placeholder="e.g. 192.168.6.0/24, 10.0.0.0/24" disabled={scanning} />
        </label>
        <label className="sv-field" style={{ margin: 0, flex: 1, minWidth: 160 }}>
          <span style={{ fontSize: 12 }}>SNMP communities <span className="sv-muted">(optional — blank = public)</span></span>
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
        {!online && <span className="sv-muted" style={{ fontSize: 12 }}>Agent must be online to scan.</span>}
        <span style={{ flex: 1 }} />
        {!!rows.length && (
          <span className="sv-muted" style={{ fontSize: 12 }}>
            {rows.length} found · {adoptable.length} new
          </span>
        )}
      </div>

      {msg && <div className="sv-err-inline" style={{ background: 'transparent', color: 'var(--text-muted)', borderColor: 'var(--border)' }}>{msg}</div>}

      {!rows.length ? (
        <p className="sv-muted" style={{ fontSize: 13 }}>
          No devices discovered yet. Click <strong>Scan for devices</strong> — the agent will sweep its
          local network (ICMP + SNMP) and list everything it finds here for one-click adoption.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...DISC_TH, width: 34 }}></th>
              <th style={DISC_TH}>IP</th>
              <th style={DISC_TH}>Name</th>
              <th style={DISC_TH}>SNMP</th>
              <th style={DISC_TH}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const taken = r.already_monitored || r.adopted;
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
  fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600,
  textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border)',
};
const DISC_TD: React.CSSProperties = {
  fontSize: 12.5, padding: '6px 10px', borderBottom: '1px solid var(--border)',
};

// ── Multi-select site list (checkboxes) ────────────────────────
export function SiteMultiSelect({
  sites, selected, onToggle,
}: {
  sites: Site[]; selected: Set<number>; onToggle: (id: number) => void;
}) {
  if (!sites.length) return <p className="sv-muted" style={{ fontSize: 13 }}>No sites available from NetVault.</p>;
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

// ── New agent modal ────────────────────────────────────────────
export function NewAgentModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (created: { id: number; name: string; install_command: string }) => void;
}) {
  useEscape(onClose);
  const sites = useApi<Site[]>('/api/netvault/sites');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    if (!name.trim()) { setError('Agent name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await apiSend<{ id: number; name: string; install_command: string }>(
        '/api/agents', 'POST', { name: name.trim(), site_ids: Array.from(selected) }
      );
      onCreated({ id: created.id, name: created.name, install_command: created.install_command });
    } catch (e: any) {
      setError(e?.message || 'Failed to create agent');
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>New Agent</h2>
        {error && <div className="sv-err-inline">{error}</div>}
        <label className="sv-field">Agent Name
          <input
            className="sv-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Bangkok-Office"
            autoFocus
          />
        </label>
        <div className="sv-field" style={{ marginTop: 14 }}>
          <span style={{ marginBottom: 6 }}>Sites to poll
            <span className="sv-muted" style={{ fontWeight: 400 }}> — all devices in selected sites are polled by this agent</span>
          </span>
          {sites.loading && !sites.data ? <p className="sv-muted" style={{ fontSize: 13 }}>Loading sites…</p>
            : <SiteMultiSelect sites={sites.data || []} selected={selected} onToggle={toggle} />}
        </div>
        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={save} disabled={saving}>{saving ? 'Creating…' : 'Create Agent'}</button>
        </div>
      </div>
    </div>
  );
}

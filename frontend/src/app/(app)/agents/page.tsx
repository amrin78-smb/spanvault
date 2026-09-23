'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import {
  ErrorBox, fmtRel, fmtTime, PageHeader, TableSkeleton, EmptyState, useRefreshKey, Loading,
  useConfirm, useToast, useTableSort, sortRows, SortTh,
} from '@/components/ui';
import {
  IconAgents, IconArrowUp, IconArrowDown, IconClock, IconRepeat, IconWarning,
} from '@/components/icons';
import { AgentHealthData, getHubUrl } from '@/components/AgentBits';

type AgentSite = { site_id: number; site_name: string | null };
export type Agent = {
  id: number; name: string; status: string; version: string | null;
  ip_address: string | null; hostname: string | null; disabled?: boolean;
  // hub_agent_id (Phase 3): set for an agent enrolled via the NetVault hub
  // (hub-signed JWT auth on the WS data plane), null for a legacy api_key
  // agent. Hub-enrolled agents' restart/logs are driven by the hub's own
  // command queue, not this app's local WS push — see CLAUDE.md.
  hub_agent_id?: string | null;
  last_seen_at: string | null; connected_at: string | null; created_at: string;
  device_count: number; sites: AgentSite[];
  health?: AgentHealthData;
};

// Fleet-health threshold: flag an agent whose self-reported host disk usage
// is at or above this percentage (mirrors the red pctColor() threshold used
// on the agent detail page's health tiles — AgentBits.tsx).
const DISK_WARN_PCT = 90;

// An agent heartbeats every 30s and ws-server's monitor flips it to `offline`
// ~90s after the last one. A row still marked `online` whose last_seen_at is
// older than this is therefore NOT a healthy agent — it's one whose heartbeat
// stopped landing (the monitor hasn't caught up, the UPDATE is failing, or the
// clocks disagree). That state is invisible in a plain online/offline count,
// which is exactly why it gets its own tile — see gotchas.md's "heartbeat
// UPDATE" entry for the 16,665-occurrence production bug that presented this
// way.
const STALE_HEARTBEAT_MS = 150 * 1000;

type StatusFilter = 'all' | 'online' | 'offline' | 'disabled';

// Agent connection/enablement state, used by both the fleet-health rollup and
// the status filter dropdown so "N offline" always means the same thing as
// filtering to "Offline".
function agentMatchesStatus(a: Agent, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'disabled') return !!a.disabled;
  const online = (a.status || '').toLowerCase() === 'online';
  if (filter === 'online') return online && !a.disabled;
  // 'offline' — includes 'never_connected' and any other non-online state,
  // but not agents that are merely disabled (they get their own bucket).
  return !online && !a.disabled;
}

function isOnline(a: Agent): boolean {
  return (a.status || '').toLowerCase() === 'online' && !a.disabled;
}

// Heartbeat has stopped landing while the row still claims to be online.
function isStale(a: Agent, now: number): boolean {
  if (!isOnline(a)) return false;
  if (!a.last_seen_at) return true;
  const t = Date.parse(a.last_seen_at);
  if (Number.isNaN(t)) return false;
  return now - t > STALE_HEARTBEAT_MS;
}

// Numeric-aware version compare for dotted versions ("1.10.0" > "1.9.0").
// Only used to find the NEWEST version present in this fleet — SpanVault has
// no notion of the "correct" agent version (the hub owns agent updates and
// ships the signed bundle), so drift here means "behind another agent in the
// same fleet", never "behind a release SpanVault knows about".
function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] || '0', 10);
    const nb = parseInt(pb[i] || '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const c = (pa[i] || '').localeCompare(pb[i] || '');
      if (c) return c;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ── Status dot colour by agent connection state ────────────────
function dotColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'online') return 'var(--green)';
  if (s === 'offline') return 'var(--red)';
  return 'var(--text-muted)';
}

export default function AgentsPage() {
  const { canManageAgents, sessionLoading } = useRbac();
  const router = useRouter();
  const { confirm, ConfirmUI } = useConfirm();
  const { toast, ToastUI } = useToast();
  const agents = useApi<Agent[]>(canManageAgents ? '/api/agents' : null, 15000);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { sort, onSort } = useTableSort({ key: 'name', dir: 'asc' });

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function bulkDelete() {
    if (!await confirm({
      title: `Delete ${selected.size} agent(s)?`,
      message: `The ${selected.size} selected agent(s) will be removed and their devices will move back to local polling.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    // Skip hub-enrolled agents rather than firing a DELETE the server will 409 —
    // same pre-filter the bulk restart already does.
    for (const id of selected) {
      if (list.find((a) => a.id === id)?.hub_agent_id) continue;
      try { await apiSend(`/api/agents/${id}`, 'DELETE'); } catch { /* skip */ }
    }
    setSelected(new Set());
    agents.reload();
  }
  async function bulkDisable(disabled: boolean) {
    for (const id of selected) { try { await apiSend(`/api/agents/${id}/disabled`, 'POST', { disabled }); } catch { /* skip */ } }
    setSelected(new Set());
    agents.reload();
  }

  // Runs an existing single-agent action across every selected id, then
  // summarizes success/failure as one toast (used by bulk restart — there is no
  // bulk-specific backend endpoint, this just loops the same POST
  // /api/agents/:id/... route the single-agent detail page already uses).
  async function runBulk(ids: number[], action: (id: number) => Promise<any>, verbPast: string, note = '') {
    let ok = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await action(id);
        ok++;
      } catch (e: any) {
        const name = list.find((a) => a.id === id)?.name || `agent #${id}`;
        failures.push(`${name} failed: ${e?.message || 'request failed'}`);
      }
    }
    setSelected(new Set());
    agents.reload();
    if (failures.length) {
      toast(`${verbPast} ${ok} of ${ids.length}${note} — ${failures.join('; ')}`, 'err');
    } else {
      toast(`${verbPast} ${ok} of ${ids.length} agent${ids.length === 1 ? '' : 's'}${note}`, 'ok');
    }
  }

  // Hub-enrolled agents (hub_agent_id set) are restarted from the NetVault
  // hub's own command queue, not this app's local WS push (see CLAUDE.md's
  // Phase 3/4a section) — skip them from the bulk action rather than sending
  // a local restart the hub-managed agent doesn't need (and the API now
  // refuses server-side anyway; filtering here keeps the confirm dialog and
  // result toast honest about what actually happened).
  async function bulkRestart() {
    const ids = Array.from(selected);
    const hubManaged = ids.filter((id) => list.find((a) => a.id === id)?.hub_agent_id);
    const restartable = ids.filter((id) => !hubManaged.includes(id));
    if (!restartable.length) {
      toast(`All ${ids.length} selected agent(s) are hub-managed — restart them from NetVault Hub → Agents instead.`, 'err');
      return;
    }
    if (!await confirm({
      title: `Restart ${restartable.length} agent(s)?`,
      message: `Restart the ${restartable.length} selected agent(s)? Each will briefly disconnect and reconnect within a few seconds.` +
        (hubManaged.length ? ` ${hubManaged.length} of your ${ids.length} selected agent(s) are hub-managed and will be skipped — restart those from NetVault Hub → Agents.` : ''),
      confirmLabel: 'Restart',
      danger: true,
    })) return;
    const note = hubManaged.length ? ` (${hubManaged.length} hub-managed agent(s) skipped — use NetVault Hub → Agents)` : '';
    await runBulk(restartable, (id) => apiSend(`/api/agents/${id}/restart`, 'POST', {}), 'Restarted', note);
  }

  // Agents management is admin-only — bounce view-only roles to the dashboard.
  // Gated on sessionLoading so a fresh page load doesn't evaluate
  // canManageAgents against the pre-hydration 'viewer' default and redirect a
  // genuine admin away before their real role has loaded (see useRbac's
  // sessionLoading doc comment — same bug as Settings, fixed together).
  useEffect(() => {
    if (!sessionLoading && !canManageAgents) {
      router.replace('/?notice=' + encodeURIComponent('Agents access requires admin role'));
    }
  }, [sessionLoading, canManageAgents, router]);

  useRefreshKey(() => agents.reload());

  if (sessionLoading || !canManageAgents) {
    return <div className="sv-panel" style={{ marginTop: 20 }}><Loading /></div>;
  }

  async function handleDelete(a: Agent) {
    if (!await confirm({
      title: 'Delete agent?',
      message: `Delete agent "${a.name}"? Its ${a.device_count} device(s) will move back to local polling.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    await apiSend(`/api/agents/${a.id}`, 'DELETE');
    agents.reload();
  }

  const list = agents.data || [];
  const now = Date.now();

  // ── Fleet health rollup (every figure straight off GET /api/agents) ──
  const onlineCount = list.filter(isOnline).length;
  const offlineCount = list.filter((a) => agentMatchesStatus(a, 'offline')).length;
  const disabledCount = list.filter((a) => !!a.disabled).length;
  const staleCount = list.filter((a) => isStale(a, now)).length;
  const devicesAssigned = list.reduce((sum, a) => sum + (a.device_count || 0), 0);
  // Devices an ONLINE agent is actually polling right now vs devices stranded
  // on an offline/disabled one (those fall back to central polling).
  const devicesOnline = list.filter(isOnline).reduce((sum, a) => sum + (a.device_count || 0), 0);
  const devicesStranded = devicesAssigned - devicesOnline;
  const highDiskCount = list.filter((a) => (a.health?.disk_pct ?? -1) >= DISK_WARN_PCT).length;
  const sitesCovered = new Set(list.flatMap((a) => (a.sites || []).map((s) => s.site_id))).size;

  const versions = Array.from(new Set(list.map((a) => a.version).filter((v): v is string => !!v)));
  const newestVersion = versions.length ? versions.slice().sort(cmpVersion).pop() as string : null;
  const behindCount = newestVersion ? list.filter((a) => a.version && a.version !== newestVersion).length : 0;
  const unknownVersionCount = list.filter((a) => !a.version).length;

  const filtered = list.filter((a) => {
    if (!agentMatchesStatus(a, statusFilter)) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const haystack = `${a.name} ${a.hostname || ''} ${a.ip_address || ''}`.toLowerCase();
    return haystack.includes(q);
  });
  const rows = sortRows(filtered, sort, {
    name: (a) => a.name,
    host: (a) => a.hostname || a.ip_address,
    sites: (a) => (a.sites || []).length,
    devices: (a) => a.device_count,
    version: (a) => a.version,
    seen: (a) => a.last_seen_at,
  });
  const filtersActive = statusFilter !== 'all' || search.trim() !== '';
  const allSelected = rows.length > 0 && rows.every((a) => selected.has(a.id));
  const hubUrl = getHubUrl();

  return (
    <div>
      {ConfirmUI}
      {ToastUI}
      {/* Enrollment is owned by the NetVault hub (Phase 4) — agents are added
          there, then appear here for site assignment and device discovery. The
          guidance lives in exactly ONE place per state: this header action when
          the fleet is populated, the empty-state panel when it isn't. */}
      <PageHeader title="Agents" subtitle="Remote polling agents that monitor devices at sites the server can't reach directly.">
        {!!list.length && (
          <a className="sv-btn ghost sm" href={`${hubUrl}/agents`} target="_blank" rel="noreferrer"
            title="Agent enrollment is owned by the NocVault hub">
            Enroll an agent — NetVault Hub ↗
          </a>
        )}
      </PageHeader>

      {agents.error && <ErrorBox message={agents.error} />}

      {!!list.length && (
        <div className="sv-cards" style={{ marginBottom: 16 }}>
          <AgentStatTile
            icon={<IconAgents width={19} height={19} />} variant="total"
            value={list.length} label="Fleet"
            sub={`${devicesAssigned} devices · ${sitesCovered} site${sitesCovered === 1 ? '' : 's'}${disabledCount ? ` · ${disabledCount} disabled` : ''}`}
            tint={{ bg: 'var(--surface-subtle)', fg: 'var(--text-secondary)' }}
            // Never rendered as "active": an outline here on first paint would
            // imply a filter is applied when nothing is filtered.
            onClick={() => setStatusFilter('all')}
          />
          <AgentStatTile
            icon={<IconArrowUp width={19} height={19} />} variant="up"
            value={onlineCount} label="Online"
            sub={`${devicesOnline} device${devicesOnline === 1 ? '' : 's'} polled remotely`}
            tint={{ bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' }}
            active={statusFilter === 'online'}
            onClick={() => setStatusFilter('online')}
          />
          <AgentStatTile
            icon={<IconArrowDown width={19} height={19} />} variant="down"
            value={offlineCount} label="Offline"
            sub={offlineCount ? `${devicesStranded} device${devicesStranded === 1 ? '' : 's'} back on central polling` : 'Whole fleet reporting'}
            tint={{ bg: 'var(--tint-danger)', fg: 'var(--tint-danger-fg)' }}
            active={statusFilter === 'offline'}
            onClick={() => setStatusFilter('offline')}
          />
          <AgentStatTile
            icon={<IconClock width={19} height={19} />} variant="warning"
            value={staleCount} label="Stale Heartbeat"
            sub={`Online but silent > ${Math.round(STALE_HEARTBEAT_MS / 1000)}s`}
            tint={{ bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }}
          />
          <AgentStatTile
            icon={<IconRepeat width={19} height={19} />} variant="unknown"
            value={behindCount} label="Version Drift"
            sub={newestVersion
              ? `Newest in fleet v${newestVersion}${unknownVersionCount ? ` · ${unknownVersionCount} not reported` : ''}`
              : 'No agent has reported a version'}
            tint={{ bg: 'var(--tint-info)', fg: 'var(--tint-info-fg)' }}
          />
          {highDiskCount > 0 && (
            <AgentStatTile
              icon={<IconWarning width={19} height={19} />} variant="warning"
              value={highDiskCount} label="Disk Pressure"
              sub={`Host disk ≥ ${DISK_WARN_PCT}% full`}
              tint={{ bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }}
            />
          )}
        </div>
      )}

      {/* Search + status filter — mirrors the Devices page toolbar convention. */}
      {!!list.length && (
        <div
          className="sv-toolbar"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}
        >
          <input
            className="sv-input"
            placeholder="Search name, hostname or IP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ height: 32, padding: '0 10px', fontSize: 'var(--text-base)', minWidth: 240 }}
          />
          <select
            className="sv-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}
          >
            <option value="all">All statuses</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="disabled">Disabled</option>
          </select>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {rows.length === list.length
              ? `${list.length} agent${list.length === 1 ? '' : 's'}`
              : `${rows.length} of ${list.length} agents`}
          </span>
        </div>
      )}

      {selected.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 12px',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        }}>
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{selected.size} selected</span>
          <span style={{ flex: 1 }} />
          <button className="sv-btn ghost sm" onClick={bulkRestart}>Restart</button>
          <button className="sv-btn ghost sm" onClick={() => bulkDisable(true)}>Disable</button>
          <button className="sv-btn ghost sm" onClick={() => bulkDisable(false)}>Enable</button>
          <button className="sv-btn danger sm" onClick={bulkDelete}>Delete</button>
          <button className="sv-btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {agents.loading && !agents.data ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <TableSkeleton rows={4} cols={7} />
        </div>
      ) : rows.length ? (
        <div className="sv-panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="sv-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all agents"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((a) => a.id)))}
                    style={{ cursor: 'pointer' }}
                  />
                </th>
                <SortTh label="Agent" col="name" sort={sort} onSort={onSort} />
                <SortTh label="Host" col="host" sort={sort} onSort={onSort} />
                <SortTh label="Sites" col="sites" sort={sort} onSort={onSort} align="right" />
                <SortTh label="Devices" col="devices" sort={sort} onSort={onSort} align="right" />
                <SortTh label="Version" col="version" sort={sort} onSort={onSort} />
                <SortTh label="Last seen" col="seen" sort={sort} onSort={onSort} />
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  stale={isStale(a, now)}
                  behind={!!(newestVersion && a.version && a.version !== newestVersion)}
                  onDelete={handleDelete}
                  selected={selected.has(a.id)}
                  onToggleSelect={() => toggleSelect(a.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : list.length && filtersActive ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <EmptyState
            icon={<IconAgents width={26} height={26} />}
            title="No matching agents"
            message="No agents match the current search/filter. Clear the filters to see the full fleet."
            actionLabel="Clear filters"
            onAction={() => { setSearch(''); setStatusFilter('all'); }}
          />
        </div>
      ) : (
        <AgentsEmptyState hubUrl={hubUrl} />
      )}
    </div>
  );
}

// ── Fleet KPI tile (top-level component) ───────────────────────
// Same shape as the Services page's StatTile — the suite's bordered card with a
// status-keyed LEFT border (CLAUDE.md) plus a tinted icon disc. Rendered as a
// <button> when it doubles as a status filter, so it stays keyboard-reachable.
function AgentStatTile({ icon, value, label, sub, variant, tint, onClick, active }: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  sub?: string;
  variant: 'total' | 'up' | 'down' | 'warning' | 'unknown';
  tint: { bg: string; fg: string };
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <span
        aria-hidden
        style={{
          width: 42, height: 42, flex: '0 0 auto',
          borderRadius: '50%', /* intentional: true circle (stat tile icon) */
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: tint.bg, color: tint.fg,
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0, textAlign: 'left' }}>
        <span className="num" style={{ display: 'block', lineHeight: 1.1 }}>{value}</span>
        <span className="label" style={{ display: 'block' }}>{label}</span>
        {sub && (
          <span className="sv-muted" style={{ display: 'block', fontSize: 'var(--text-sm)', marginTop: 2 }}>
            {sub}
          </span>
        )}
      </span>
    </>
  );
  const style: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 14, font: 'inherit', textAlign: 'left',
    ...(onClick ? { cursor: 'pointer', width: '100%' } : {}),
    ...(active && onClick ? { outline: '2px solid var(--primary)', outlineOffset: -2 } : {}),
  };
  if (!onClick) return <div className={`sv-card ${variant}`} style={style}>{body}</div>;
  return (
    <button type="button" className={`sv-card ${variant}`} style={style} onClick={onClick}
      aria-pressed={!!active} title={`Filter to ${label.toLowerCase()}`}>
      {body}
    </button>
  );
}

// ── One agent row (top-level component) ────────────────────────
function AgentRow({ agent, stale, behind, onDelete, selected, onToggleSelect }: {
  agent: Agent;
  stale: boolean;
  behind: boolean;
  onDelete: (a: Agent) => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const siteCount = (agent.sites || []).length;
  const siteNames = (agent.sites || []).map((s) => s.site_name || `#${s.site_id}`).join(', ');
  const disk = agent.health?.disk_pct ?? null;
  return (
    <tr style={selected ? { background: 'var(--surface-subtle)' } : undefined}>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`select ${agent.name}`}
          style={{ cursor: 'pointer' }}
        />
      </td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            aria-label={`status: ${agent.status}`}
            title={agent.status}
            style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: dotColor(agent.status) }}
          />
          <Link href={`/agents/${agent.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            {agent.name}
          </Link>
          {agent.disabled && <RowBadge text="Disabled" bg="var(--tint-danger)" fg="var(--tint-danger-fg)" />}
          {stale && (
            <RowBadge
              text="Stale heartbeat" bg="var(--tint-warn)" fg="var(--tint-warn-fg)"
              title="Still marked online, but its heartbeat stopped landing"
            />
          )}
          {agent.hub_agent_id && (
            <RowBadge
              text="Hub-managed" bg="var(--tint-info)" fg="var(--tint-info-fg)"
              title="Enrolled via the NetVault hub — restart and logs run from the hub's Agents page"
            />
          )}
        </div>
      </td>
      <td>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{agent.ip_address || '—'}</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          {agent.hostname || 'no hostname'}
          {disk != null && disk >= DISK_WARN_PCT && (
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>{` · disk ${disk}%`}</span>
          )}
        </div>
      </td>
      <td style={{ textAlign: 'right' }} title={siteNames || 'No sites assigned'}>
        {siteCount || <span style={{ color: 'var(--text-muted)' }}>none</span>}
      </td>
      <td style={{ textAlign: 'right' }}>{agent.device_count}</td>
      <td>
        {agent.version
          ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: behind ? 'var(--yellow)' : undefined }}
              title={behind ? 'Behind the newest version running in this fleet' : undefined}>
              v{agent.version}
            </span>
          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </td>
      <td style={{ color: 'var(--text-muted)' }} title={agent.last_seen_at ? fmtTime(agent.last_seen_at) : undefined}>
        {fmtRel(agent.last_seen_at)}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <Link href={`/agents/${agent.id}`} className="sv-btn ghost sm">Configure</Link>
        {/* Hub-enrolled agents are deleted from the hub, which owns their identity
            and fans the removal back here — same split as restart/logs. */}
        <button
          className="sv-btn danger sm"
          style={{ marginLeft: 6 }}
          onClick={() => onDelete(agent)}
          disabled={!!agent.hub_agent_id}
          title={agent.hub_agent_id ? 'Managed by NocVault Hub — delete from the hub\'s Agents page' : undefined}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

function RowBadge({ text, bg, fg, title }: { text: string; bg: string; fg: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 'var(--text-xs)', fontWeight: 600, color: fg, background: bg,
        borderRadius: 'var(--radius-sm)', padding: '1px 7px', whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

// ── Empty state (top-level component) ──────────────────────────
// The single place the enrollment guidance lives when no agent exists (the
// populated view carries it as the header action instead — it used to be
// spelled out in a banner AND repeated verbatim in this panel).
function AgentsEmptyState({ hubUrl }: { hubUrl: string }) {
  return (
    <div className="sv-panel">
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        textAlign: 'center', padding: '36px 24px 28px',
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 'var(--radius)', marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}>
          <IconAgents width={26} height={26} />
        </div>
        <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>
          No agents enrolled
        </div>
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginTop: 6, maxWidth: 520 }}>
          SpanVault polls remote sites through the unified NocVault agent, which is enrolled and
          updated by the hub. Nothing is assigned to SpanVault yet — everything here stays empty
          until an agent connects.
        </div>
        <a className="sv-btn" style={{ marginTop: 18 }} href={`${hubUrl}/agents`} target="_blank" rel="noreferrer">
          Enroll an agent — NetVault Hub ↗
        </a>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14,
        borderTop: '1px solid var(--border)', paddingTop: 18,
      }}>
        <EmptyStep
          n={1} title="Enroll on the hub"
          body="Install the NocVault agent from NetVault → Agents. It registers with the hub, which owns its identity, version and restart controls."
        />
        <EmptyStep
          n={2} title="Assign its sites"
          body="Once it connects it appears here. Assign the sites it should own and every monitored device at those sites moves onto it."
        />
        <EmptyStep
          n={3} title="Discover devices"
          body="Run a subnet sweep from the agent and adopt what it finds straight into monitoring, keeping the SNMP credentials it discovered with."
        />
      </div>
    </div>
  );
}

function EmptyStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span
        aria-hidden
        style={{
          width: 22, height: 22, flex: '0 0 auto', borderRadius: '50%', /* intentional: numbered step disc */
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface-subtle)', border: '1px solid var(--border)',
          color: 'var(--text-secondary)', fontSize: 'var(--text-xs)', fontWeight: 700,
        }}
      >
        {n}
      </span>
      <span>
        <span style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {title}
        </span>
        <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 3 }}>
          {body}
        </span>
      </span>
    </div>
  );
}

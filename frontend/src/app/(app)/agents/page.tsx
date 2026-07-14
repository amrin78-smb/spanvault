'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import {
  ErrorBox, fmtRel, PageHeader, CardSkeleton, EmptyState, useRefreshKey, Loading, useConfirm, useToast,
} from '@/components/ui';
import { IconAgents } from '@/components/icons';
import { AgentInstall, AgentConnectWaiter, NewAgentModal, AgentHealthData } from '@/components/AgentBits';

type AgentSite = { site_id: number; site_name: string | null };
export type Agent = {
  id: number; name: string; status: string; version: string | null;
  ip_address: string | null; hostname: string | null; disabled?: boolean;
  last_seen_at: string | null; connected_at: string | null; created_at: string;
  device_count: number; sites: AgentSite[];
  health?: AgentHealthData; latest_agent_version?: string | null;
};

// Fleet-health threshold: flag an agent whose self-reported host disk usage
// is at or above this percentage (mirrors the red pctColor() threshold used
// on the agent detail page's health tiles — AgentBits.tsx).
const DISK_WARN_PCT = 90;

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

// ── Status dot colour by agent connection state ────────────────
function dotColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'online') return 'var(--green)';
  if (s === 'offline') return 'var(--red)';
  return 'var(--text-muted)';
}

export default function AgentsPage() {
  const { canManageAgents } = useRbac();
  const router = useRouter();
  const { confirm, ConfirmUI } = useConfirm();
  const { toast, ToastUI } = useToast();
  const agents = useApi<Agent[]>(canManageAgents ? '/api/agents' : null, 15000);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // After creating an agent, surface its install command in a modal.
  const [created, setCreated] = useState<{ id: number; name: string; install_command: string } | null>(null);

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
    for (const id of selected) { try { await apiSend(`/api/agents/${id}`, 'DELETE'); } catch { /* skip */ } }
    setSelected(new Set());
    agents.reload();
  }
  async function bulkDisable(disabled: boolean) {
    for (const id of selected) { try { await apiSend(`/api/agents/${id}/disabled`, 'POST', { disabled }); } catch { /* skip */ } }
    setSelected(new Set());
    agents.reload();
  }

  // Runs an existing single-agent action across every selected id, then
  // summarizes success/failure as one toast (used by bulk rotate-key/restart —
  // there is no bulk-specific backend endpoint, this just loops the same
  // POST /api/agents/:id/... routes the single-agent detail page already uses).
  async function runBulk(ids: number[], action: (id: number) => Promise<any>, verbPast: string) {
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
      toast(`${verbPast} ${ok} of ${ids.length} — ${failures.join('; ')}`, 'err');
    } else {
      toast(`${verbPast} ${ok} of ${ids.length} agent${ids.length === 1 ? '' : 's'}`, 'ok');
    }
  }

  async function bulkRotateKeys() {
    const ids = Array.from(selected);
    if (!await confirm({
      title: `Rotate keys for ${ids.length} agent(s)?`,
      message: `Rotate the API key for the ${ids.length} selected agent(s)? Each current key stops working immediately — you must re-run each agent's install command (shown on its detail page) on the remote server.`,
      confirmLabel: 'Rotate Keys',
      danger: true,
    })) return;
    await runBulk(ids, (id) => apiSend(`/api/agents/${id}/rotate-key`, 'POST'), 'Rotated');
  }

  async function bulkRestart() {
    const ids = Array.from(selected);
    if (!await confirm({
      title: `Restart ${ids.length} agent(s)?`,
      message: `Restart the ${ids.length} selected agent(s)? Each will briefly disconnect and reconnect within a few seconds.`,
      confirmLabel: 'Restart',
      danger: true,
    })) return;
    await runBulk(ids, (id) => apiSend(`/api/agents/${id}/restart`, 'POST', {}), 'Restarted');
  }

  // Agents management is admin-only — bounce view-only roles to the dashboard.
  useEffect(() => {
    if (!canManageAgents) {
      router.replace('/?notice=' + encodeURIComponent('Agents access requires admin role'));
    }
  }, [canManageAgents, router]);

  useRefreshKey(() => agents.reload());

  if (!canManageAgents) {
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
  const online = list.filter((a) => (a.status || '').toLowerCase() === 'online').length;
  const devicesAssigned = list.reduce((sum, a) => sum + (a.device_count || 0), 0);

  // Fleet health rollup — counts that need admin attention. Only shown when
  // non-zero (mirrors the suite's "quiet when healthy" convention used on the
  // main dashboard's KPI row and agent-offline group — nothing to show when
  // the fleet is clean).
  const offlineCount = list.filter((a) => agentMatchesStatus(a, 'offline')).length;
  const highDiskCount = list.filter((a) => (a.health?.disk_pct ?? -1) >= DISK_WARN_PCT).length;
  const outdatedCount = list.filter((a) => a.version && a.latest_agent_version && a.version !== a.latest_agent_version).length;
  const hasRollup = offlineCount > 0 || highDiskCount > 0 || outdatedCount > 0;

  const filtered = list.filter((a) => {
    if (!agentMatchesStatus(a, statusFilter)) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const haystack = `${a.name} ${a.hostname || ''}`.toLowerCase();
    return haystack.includes(q);
  });
  const filtersActive = statusFilter !== 'all' || search.trim() !== '';

  return (
    <div>
      {ConfirmUI}
      {ToastUI}
      <PageHeader title="Agents" subtitle="Remote polling agents that monitor devices at sites the server can't reach directly.">
        <button className="sv-btn" onClick={() => setShowNew(true)}>+ New Agent</button>
      </PageHeader>

      {agents.error && <ErrorBox message={agents.error} />}

      {/* Slim summary row — no cards */}
      {!!list.length && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '2px 0 14px' }}>
          {list.length} {list.length === 1 ? 'agent' : 'agents'} · {online} online · {devicesAssigned} {devicesAssigned === 1 ? 'device' : 'devices'} assigned
        </div>
      )}

      {/* Fleet health rollup — clickable where a matching status filter exists
          (offline → status filter); disk/version counts have no equivalent
          filter dimension so they render as static text. */}
      {hasRollup && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {offlineCount > 0 && (
            <button
              className="sv-chip"
              onClick={() => setStatusFilter('offline')}
              style={{
                height: 28, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center',
                color: 'var(--tint-danger-fg)', background: 'var(--tint-danger)', border: '1px solid transparent',
              }}
              title="Filter to offline agents"
            >
              {offlineCount} offline
            </button>
          )}
          {highDiskCount > 0 && (
            <span
              className="sv-chip"
              style={{
                height: 28, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center',
                color: 'var(--tint-warn-fg)', background: 'var(--tint-warn)', cursor: 'default',
              }}
              title={`Agent(s) with host disk usage at or above ${DISK_WARN_PCT}%`}
            >
              {highDiskCount} over {DISK_WARN_PCT}% disk
            </span>
          )}
          {outdatedCount > 0 && (
            <span
              className="sv-chip"
              style={{
                height: 28, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center',
                color: 'var(--tint-info-fg)', background: 'var(--tint-info)', cursor: 'default',
              }}
              title="Agent(s) running an outdated version"
            >
              {outdatedCount} outdated
            </span>
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
            placeholder="Search name or hostname…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ height: 32, padding: '0 10px', fontSize: 'var(--text-base)', minWidth: 220 }}
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
          <button className="sv-btn ghost sm" onClick={bulkRotateKeys}>Rotate Keys</button>
          <button className="sv-btn ghost sm" onClick={() => bulkDisable(true)}>Disable</button>
          <button className="sv-btn ghost sm" onClick={() => bulkDisable(false)}>Enable</button>
          <button className="sv-btn danger sm" onClick={bulkDelete}>Delete</button>
          <button className="sv-btn ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {agents.loading && !agents.data ? (
        <div className="sv-agent-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          <CardSkeleton count={3} height={120} />
        </div>
      ) : filtered.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {filtered.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              onDelete={handleDelete}
              selected={selected.has(a.id)}
              onToggleSelect={() => toggleSelect(a.id)}
            />
          ))}
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
        <div className="sv-panel" style={{ padding: 0 }}>
          <EmptyState
            icon={<IconAgents width={26} height={26} />}
            title="No agents yet"
            message="Create an agent and run its install command on a remote server to start distributed polling."
            actionLabel="+ New Agent"
            onAction={() => setShowNew(true)}
          />
        </div>
      )}

      {showNew && (
        <NewAgentModal
          onClose={() => setShowNew(false)}
          onCreated={(c) => { setShowNew(false); setCreated(c); agents.reload(); }}
        />
      )}

      {created && (
        <div className="sv-modal-backdrop" onClick={() => setCreated(null)}>
          <div className="sv-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Agent “{created.name}” created</h2>
            <p className="sv-muted" style={{ fontSize: 'var(--text-base)' }}>
              Run this on the remote server (PowerShell, as Administrator):
            </p>
            <AgentInstall command={created.install_command} />
            <AgentConnectWaiter agentId={created.id} />
            <div style={{ marginTop: 18, textAlign: 'right' }}>
              <button className="sv-btn" onClick={() => setCreated(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Single agent card (top-level component) ────────────────────
function AgentCard({ agent, onDelete, selected, onToggleSelect }: {
  agent: Agent; onDelete: (a: Agent) => void; selected: boolean; onToggleSelect: () => void;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-sm)',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 120,
      }}
    >
      {/* line 1 — checkbox + status dot + name + vendor badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`select ${agent.name}`}
          style={{ flex: 'none', cursor: 'pointer' }}
        />
        <span
          aria-label={`status: ${agent.status}`}
          title={agent.status}
          style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: dotColor(agent.status) }}
        />
        <Link
          href={`/agents/${agent.id}`}
          style={{ fontWeight: 600, fontSize: 'var(--text-md)', color: 'var(--text-primary)', textDecoration: 'none', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {agent.name}
        </Link>
        {agent.disabled && (
          <span
            style={{
              fontSize: 'var(--text-xs)', color: 'var(--red)', border: '1px solid var(--red)',
              borderRadius: 'var(--radius-sm)', padding: '1px 7px', flex: 'none', whiteSpace: 'nowrap',
            }}
          >
            Disabled
          </span>
        )}
        <span
          style={{
            fontSize: 'var(--text-xs)', color: 'var(--text-muted)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', padding: '1px 7px', flex: 'none', whiteSpace: 'nowrap',
          }}
        >
          SpanVault
        </span>
      </div>

      {/* line 2 — IP · hostname */}
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {agent.ip_address || '—'} · {agent.hostname || 'no hostname'}
      </div>

      {/* line 3 — devices · version */}
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
        {agent.device_count} {agent.device_count === 1 ? 'device' : 'devices'} · {agent.version ? `v${agent.version}` : 'v—'}
      </div>

      {/* line 4 — last seen */}
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        Last seen: {fmtRel(agent.last_seen_at)}
      </div>

      {/* footer — Configure (left) / Delete (right) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: 4 }}>
        <Link href={`/agents/${agent.id}`} className="sv-btn ghost sm">Configure</Link>
        <button className="sv-btn danger sm" onClick={() => onDelete(agent)}>Delete</button>
      </div>
    </div>
  );
}

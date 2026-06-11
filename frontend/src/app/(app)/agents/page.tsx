'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import {
  ErrorBox, fmtRel, PageHeader, CardSkeleton, EmptyState, useRefreshKey, Loading,
} from '@/components/ui';
import { IconAgents } from '@/components/icons';
import { AgentInstall, NewAgentModal } from '@/components/AgentBits';

type AgentSite = { site_id: number; site_name: string | null };
export type Agent = {
  id: number; name: string; status: string; version: string | null;
  ip_address: string | null; hostname: string | null;
  last_seen_at: string | null; connected_at: string | null; created_at: string;
  device_count: number; sites: AgentSite[];
};

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
  const agents = useApi<Agent[]>(canManageAgents ? '/api/agents' : null, 15000);
  const [showNew, setShowNew] = useState(false);
  // After creating an agent, surface its install command in a modal.
  const [created, setCreated] = useState<{ name: string; install_command: string } | null>(null);

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
    if (!confirm(`Delete agent "${a.name}"? Its ${a.device_count} device(s) will move back to local polling.`)) return;
    await apiSend(`/api/agents/${a.id}`, 'DELETE');
    agents.reload();
  }

  const list = agents.data || [];
  const online = list.filter((a) => (a.status || '').toLowerCase() === 'online').length;
  const devicesAssigned = list.reduce((sum, a) => sum + (a.device_count || 0), 0);

  return (
    <div>
      <PageHeader title="Agents" subtitle="Remote polling agents that monitor devices at sites the server can't reach directly.">
        <button className="sv-btn" onClick={() => setShowNew(true)}>+ New Agent</button>
      </PageHeader>

      {agents.error && <ErrorBox message={agents.error} />}

      {/* Slim summary row — no cards */}
      {!!list.length && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 14px' }}>
          {list.length} {list.length === 1 ? 'agent' : 'agents'} · {online} online · {devicesAssigned} {devicesAssigned === 1 ? 'device' : 'devices'} assigned
        </div>
      )}

      {agents.loading && !agents.data ? (
        <div className="sv-agent-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          <CardSkeleton count={3} height={120} />
        </div>
      ) : list.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {list.map((a) => (
            <AgentCard key={a.id} agent={a} onDelete={handleDelete} />
          ))}
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
            <p className="sv-muted" style={{ fontSize: 13 }}>
              Run this on the remote server (PowerShell, as Administrator):
            </p>
            <AgentInstall command={created.install_command} />
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
function AgentCard({ agent, onDelete }: { agent: Agent; onDelete: (a: Agent) => void }) {
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 120,
      }}
    >
      {/* line 1 — status dot + name + vendor badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-label={`status: ${agent.status}`}
          title={agent.status}
          style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: dotColor(agent.status) }}
        />
        <Link
          href={`/agents/${agent.id}`}
          style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', textDecoration: 'none', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {agent.name}
        </Link>
        <span
          style={{
            fontSize: 11, color: 'var(--text-muted)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', padding: '1px 7px', flex: 'none', whiteSpace: 'nowrap',
          }}
        >
          SpanVault
        </span>
      </div>

      {/* line 2 — IP · hostname */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {agent.ip_address || '—'} · {agent.hostname || 'no hostname'}
      </div>

      {/* line 3 — devices · version */}
      <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
        {agent.device_count} {agent.device_count === 1 ? 'device' : 'devices'} · {agent.version ? `v${agent.version}` : 'v—'}
      </div>

      {/* line 4 — last seen */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Last seen: {fmtRel(agent.last_seen_at)}
      </div>

      {/* footer — Configure (left) / Delete (right) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: 4 }}>
        <Link href={`/agents/${agent.id}`} className="sv-btn ghost sm">Configure</Link>
        <button className="sv-btn ghost sm" onClick={() => onDelete(agent)}>Delete</button>
      </div>
    </div>
  );
}

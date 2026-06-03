'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApi, apiSend } from '@/lib/api';
import {
  ErrorBox, fmtRel, PageHeader, CardSkeleton, EmptyState, useRefreshKey,
} from '@/components/ui';
import { IconAgents } from '@/components/icons';
import { AgentStatusPill, AgentInstall, NewAgentModal } from '@/components/AgentBits';

type AgentSite = { site_id: number; site_name: string | null };
export type Agent = {
  id: number; name: string; status: string; version: string | null;
  ip_address: string | null; hostname: string | null;
  last_seen_at: string | null; connected_at: string | null; created_at: string;
  device_count: number; sites: AgentSite[];
};

export default function AgentsPage() {
  const agents = useApi<Agent[]>('/api/agents', 15000);
  const [showNew, setShowNew] = useState(false);
  // After creating an agent, surface its install command in a modal.
  const [created, setCreated] = useState<{ name: string; install_command: string } | null>(null);

  useRefreshKey(() => agents.reload());

  async function handleDelete(a: Agent) {
    if (!confirm(`Delete agent "${a.name}"? Its ${a.device_count} device(s) will move back to local polling.`)) return;
    await apiSend(`/api/agents/${a.id}`, 'DELETE');
    agents.reload();
  }

  const list = agents.data || [];

  return (
    <div>
      <PageHeader title="Agents" subtitle="Remote polling agents that monitor devices at sites the server can't reach directly.">
        <button className="sv-btn" onClick={() => setShowNew(true)}>+ New Agent</button>
      </PageHeader>

      {agents.error && <ErrorBox message={agents.error} />}

      {agents.loading && !agents.data ? (
        <div className="sv-cards"><CardSkeleton count={3} height={150} /></div>
      ) : list.length ? (
        <div className="sv-agent-grid">
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
    <div className="sv-agent-card">
      <div className="sv-agent-card-head">
        <Link href={`/agents/${agent.id}`} className="nm">{agent.name}</Link>
        <AgentStatusPill status={agent.status} />
      </div>

      <div className="sv-agent-meta">
        <div><span className="k">Last seen</span><span className="v">{fmtRel(agent.last_seen_at)}</span></div>
        <div><span className="k">Version</span><span className="v">{agent.version ? `v${agent.version}` : '—'}</span></div>
        <div><span className="k">Host</span><span className="v">{agent.hostname || '—'}</span></div>
        <div><span className="k">IP</span><span className="v">{agent.ip_address || '—'}</span></div>
        <div><span className="k">Devices</span><span className="v">{agent.device_count}</span></div>
      </div>

      <div className="sv-agent-sites">
        {agent.sites.length ? agent.sites.map((s) => (
          <span key={s.site_id} className="sv-pill unknown">{s.site_name || `Site ${s.site_id}`}</span>
        )) : <span className="sv-muted" style={{ fontSize: 12 }}>No sites assigned</span>}
      </div>

      <div className="sv-agent-actions">
        <Link href={`/agents/${agent.id}`} className="sv-btn ghost sm">Configure</Link>
        <button className="sv-btn ghost sm" onClick={() => onDelete(agent)}>Delete</button>
      </div>
    </div>
  );
}

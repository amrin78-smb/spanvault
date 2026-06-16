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

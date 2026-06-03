'use client';

import { useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { useEscape } from '@/components/ui';

type Site = { id: number; name: string };

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
  onCreated: (created: { name: string; install_command: string }) => void;
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
      const created = await apiSend<{ name: string; install_command: string }>(
        '/api/agents', 'POST', { name: name.trim(), site_ids: Array.from(selected) }
      );
      onCreated({ name: created.name, install_command: created.install_command });
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

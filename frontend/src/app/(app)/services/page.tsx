'use client';

import { useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import {
  ErrorBox, fmtRel, PageHeader, TableSkeleton, EmptyState, useRefreshKey, useEscape,
} from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import { IconServices } from '@/components/icons';

// ── Types ──────────────────────────────────────────────────────
type ServiceType = 'http' | 'tcp' | 'ssl' | 'dns';

type ServiceParams = {
  port?: number | string;
  expect_status?: number | string;
  keyword?: string;
  ssl_warn_days?: number | string;
  timeout_ms?: number | string;
};

export type ServiceCheck = {
  id: number;
  name: string;
  type: ServiceType;
  target: string;
  site_id: number | null;
  site_name: string | null;
  agent_id: number | null;
  agent_name: string | null;
  interval_seconds: number;
  params: ServiceParams | null;
  current_status: string;
  last_response_ms: number | null;
  last_detail: string | null;
  last_checked_at: string | null;
  active: boolean;
  result_count?: number;
};

type Site = { id: number; name: string; code?: string | null; city?: string | null };
type Agent = { id: number; name: string };

const TYPE_OPTIONS: { value: ServiceType; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'tcp', label: 'TCP' },
  { value: 'ssl', label: 'SSL' },
  { value: 'dns', label: 'DNS' },
];

// Map a service status to a StatusDot status token.
function dotStatus(s: string): string {
  const v = (s || 'unknown').toLowerCase();
  if (v === 'up' || v === 'down' || v === 'warning') return v;
  return 'unknown';
}

function typeLabel(t: string): string {
  return (t || '').toUpperCase();
}

// ════════════════════════════════════════════════════════════
// Top-level components (never nested — CLAUDE.md rule).
// ════════════════════════════════════════════════════════════

// Add / Edit modal.
function ServiceCheckModal({
  initial, sites, agents, onClose, onSaved,
}: {
  initial: ServiceCheck | null;
  sites: Site[];
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  useEscape(onClose);
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [type, setType] = useState<ServiceType>(initial?.type || 'http');
  const [target, setTarget] = useState(initial?.target || '');
  const [siteId, setSiteId] = useState<string>(initial?.site_id != null ? String(initial.site_id) : '');
  const [agentId, setAgentId] = useState<string>(initial?.agent_id != null ? String(initial.agent_id) : '');
  const [interval, setInterval] = useState<string>(String(initial?.interval_seconds || 60));
  // Type-specific params.
  const [expectStatus, setExpectStatus] = useState<string>(
    initial?.params?.expect_status != null ? String(initial.params.expect_status) : '200');
  const [keyword, setKeyword] = useState<string>(initial?.params?.keyword != null ? String(initial.params.keyword) : '');
  const [port, setPort] = useState<string>(initial?.params?.port != null ? String(initial.params.port) : '');
  const [sslWarnDays, setSslWarnDays] = useState<string>(
    initial?.params?.ssl_warn_days != null ? String(initial.params.ssl_warn_days) : '14');
  const [timeoutMs, setTimeoutMs] = useState<string>(
    initial?.params?.timeout_ms != null ? String(initial.params.timeout_ms) : '5000');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildParams(): ServiceParams {
    const p: ServiceParams = {};
    const t = timeoutMs.trim();
    if (t) p.timeout_ms = parseInt(t, 10);
    if (type === 'http') {
      if (expectStatus.trim()) p.expect_status = parseInt(expectStatus, 10);
      if (keyword.trim()) p.keyword = keyword.trim();
    }
    if (type === 'tcp' || type === 'ssl') {
      if (port.trim()) p.port = parseInt(port, 10);
    }
    if (type === 'ssl') {
      if (sslWarnDays.trim()) p.ssl_warn_days = parseInt(sslWarnDays, 10);
    }
    return p;
  }

  async function save() {
    if (!name.trim()) { setError('Name is required'); return; }
    if (!target.trim()) { setError('Target is required'); return; }
    setSaving(true);
    setError(null);
    const site = siteId ? sites.find((s) => s.id === parseInt(siteId, 10)) : null;
    const body = {
      name: name.trim(),
      type,
      target: target.trim(),
      site_id: siteId ? parseInt(siteId, 10) : null,
      site_name: site ? site.name : null,
      agent_id: agentId ? parseInt(agentId, 10) : null,
      interval_seconds: parseInt(interval, 10) || 60,
      params: buildParams(),
    };
    try {
      if (editing && initial) await apiSend(`/api/service-checks/${initial.id}`, 'PUT', body);
      else await apiSend('/api/service-checks', 'POST', body);
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Failed to save service check');
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{editing ? 'Edit Service Check' : 'New Service Check'}</h2>
        {error && <div className="sv-err-inline">{error}</div>}

        <label className="sv-field">Name
          <input
            className="sv-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Public Website"
            autoFocus
          />
        </label>

        <label className="sv-field" style={{ marginTop: 12 }}>Type
          <select className="sv-select" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
            {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        <label className="sv-field" style={{ marginTop: 12 }}>Target
          <input
            className="sv-input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={
              type === 'http' ? 'https://example.com/health'
              : type === 'dns' ? 'example.com'
              : 'host.example.com'
            }
          />
        </label>

        {/* Type-specific params */}
        {type === 'http' && (
          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <label className="sv-field" style={{ flex: '0 0 140px' }}>Expect status
              <input className="sv-input" value={expectStatus}
                onChange={(e) => setExpectStatus(e.target.value)} placeholder="200" />
            </label>
            <label className="sv-field" style={{ flex: 1 }}>Body keyword (optional)
              <input className="sv-input" value={keyword}
                onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. OK" />
            </label>
          </div>
        )}
        {(type === 'tcp' || type === 'ssl') && (
          <label className="sv-field" style={{ marginTop: 12 }}>Port
            <input className="sv-input" value={port}
              onChange={(e) => setPort(e.target.value)} placeholder={type === 'ssl' ? '443' : 'e.g. 22'} />
          </label>
        )}
        {type === 'ssl' && (
          <label className="sv-field" style={{ marginTop: 12 }}>Warn when cert expires within (days)
            <input className="sv-input" value={sslWarnDays}
              onChange={(e) => setSslWarnDays(e.target.value)} placeholder="14" />
          </label>
        )}

        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <label className="sv-field" style={{ flex: 1 }}>Site (optional)
            <select className="sv-select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">— None —</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="sv-field" style={{ flex: 1 }}>Run from
            <select className="sv-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Central collector</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <label className="sv-field" style={{ flex: '0 0 160px' }}>Interval (seconds)
            <input className="sv-input" value={interval}
              onChange={(e) => setInterval(e.target.value)} placeholder="60" />
          </label>
          <label className="sv-field" style={{ flex: 1 }}>Timeout (ms)
            <input className="sv-input" value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)} placeholder="5000" />
          </label>
        </div>

        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : (editing ? 'Save Changes' : 'Create Check')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Single table row.
function ServiceRow({ check, canEdit, onEdit, onDelete }: {
  check: ServiceCheck;
  canEdit: boolean;
  onEdit: (c: ServiceCheck) => void;
  onDelete: (c: ServiceCheck) => void;
}) {
  return (
    <tr style={{ height: 44 }}>
      <td style={{ width: 28, paddingLeft: 12 }}>
        <StatusDot status={dotStatus(check.current_status)} size={10} title={check.current_status} />
      </td>
      <td style={{ whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--text-primary)' }}>
        {check.name}
        {!check.active && (
          <span className="sv-type-badge" style={{ fontSize: 10, marginLeft: 8 }}>Paused</span>
        )}
      </td>
      <td style={{ width: 1, whiteSpace: 'nowrap' }}>
        <span className="sv-type-badge">{typeLabel(check.type)}</span>
      </td>
      <td style={{ fontSize: 12, color: 'var(--text-primary)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={check.target}>
        {check.target}
      </td>
      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {check.agent_name || 'Central'}
      </td>
      <td style={{ fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', textAlign: 'right' }}>
        {check.last_response_ms != null ? `${check.last_response_ms} ms` : '—'}
      </td>
      <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={check.last_detail || ''}>
        {check.last_detail || '—'}
      </td>
      <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', textAlign: 'right' }}>
        {fmtRel(check.last_checked_at)}
      </td>
      {canEdit && (
        <td style={{ width: 1, textAlign: 'right', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button className="sv-btn ghost sm" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
              onClick={() => onEdit(check)}>Edit</button>
            <button className="sv-btn ghost sm" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
              onClick={() => onDelete(check)}>Delete</button>
          </span>
        </td>
      )}
    </tr>
  );
}

// ════════════════════════════════════════════════════════════
// Page
// ════════════════════════════════════════════════════════════
export default function ServicesPage() {
  const { canEdit } = useRbac();
  const checks = useApi<ServiceCheck[]>('/api/service-checks', 15000);
  const sites = useApi<Site[]>('/api/netvault/sites');
  const agents = useApi<Agent[]>(canEdit ? '/api/agents' : null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceCheck | null>(null);

  useRefreshKey(() => checks.reload());

  function openNew() { setEditing(null); setModalOpen(true); }
  function openEdit(c: ServiceCheck) { setEditing(c); setModalOpen(true); }

  async function handleDelete(c: ServiceCheck) {
    if (!confirm(`Delete service check "${c.name}"?`)) return;
    await apiSend(`/api/service-checks/${c.id}`, 'DELETE');
    checks.reload();
  }

  const list = checks.data || [];
  const up = list.filter((c) => (c.current_status || '').toLowerCase() === 'up').length;
  const down = list.filter((c) => (c.current_status || '').toLowerCase() === 'down').length;
  const warning = list.filter((c) => (c.current_status || '').toLowerCase() === 'warning').length;
  const colCount = canEdit ? 9 : 8;

  return (
    <div>
      <PageHeader title="Services" subtitle="Synthetic HTTP / TCP / SSL / DNS checks run by the collector or remote agents.">
        {canEdit && <button className="sv-btn" onClick={openNew}>+ New Check</button>}
      </PageHeader>

      {checks.error && <ErrorBox message={checks.error} />}

      {!!list.length && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 14px' }}>
          {list.length} {list.length === 1 ? 'check' : 'checks'} · {up} up · {down} down · {warning} warning
        </div>
      )}

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        {checks.loading && !checks.data ? (
          <TableSkeleton rows={5} cols={colCount} />
        ) : list.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Name</th>
                <th>Type</th>
                <th>Target</th>
                <th>Runs from</th>
                <th style={{ textAlign: 'right' }}>Response</th>
                <th>Detail</th>
                <th style={{ textAlign: 'right' }}>Checked</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <ServiceRow
                  key={c.id}
                  check={c}
                  canEdit={canEdit}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: '32px 24px' }}>
            <EmptyState
              icon={<IconServices width={24} height={24} />}
              title="No service checks yet"
              message="Add an HTTP, TCP, SSL, or DNS check to monitor service availability from the collector or a remote agent."
              actionLabel={canEdit ? '+ New Check' : undefined}
              onAction={canEdit ? openNew : undefined}
            />
          </div>
        )}
      </div>

      {modalOpen && (
        <ServiceCheckModal
          initial={editing}
          sites={sites.data || []}
          agents={agents.data || []}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); checks.reload(); }}
        />
      )}
    </div>
  );
}

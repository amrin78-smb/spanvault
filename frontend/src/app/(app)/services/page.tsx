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
  group_id: string | null;
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

// Severity ranking for aggregating a group's worst child status.
const STATUS_RANK: Record<string, number> = { down: 3, warning: 2, unknown: 1, up: 0 };

function worstStatus(checks: ServiceCheck[]): string {
  let worst = 'up';
  let rank = -1;
  for (const c of checks) {
    const s = dotStatus(c.current_status);
    const r = STATUS_RANK[s] ?? 1;
    if (r > rank) { rank = r; worst = s; }
  }
  return worst;
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
  // Edit mode: single type. Create mode: a set of selected types.
  const [type, setType] = useState<ServiceType>(initial?.type || 'http');
  const [types, setTypes] = useState<Set<ServiceType>>(
    new Set<ServiceType>(initial ? [initial.type] : ['http']));
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

  function toggleType(t: ServiceType) {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  // Single-type params (edit mode).
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

  // Flat shared params for the bulk create shape — include only keys relevant
  // to the union of selected types, omitting empty strings.
  function buildSharedParams(): ServiceParams {
    const p: ServiceParams = {};
    const t = timeoutMs.trim();
    if (t) p.timeout_ms = parseInt(t, 10);
    if (types.has('http')) {
      if (expectStatus.trim()) p.expect_status = parseInt(expectStatus, 10);
      if (keyword.trim()) p.keyword = keyword.trim();
    }
    if (types.has('tcp') || types.has('ssl')) {
      if (port.trim()) p.port = parseInt(port, 10);
    }
    if (types.has('ssl')) {
      if (sslWarnDays.trim()) p.ssl_warn_days = parseInt(sslWarnDays, 10);
    }
    return p;
  }

  async function save() {
    if (!name.trim()) { setError('Name is required'); return; }
    if (!target.trim()) { setError('Target is required'); return; }
    if (!editing && types.size === 0) { setError('Select at least one check type'); return; }
    setSaving(true);
    setError(null);
    const site = siteId ? sites.find((s) => s.id === parseInt(siteId, 10)) : null;
    try {
      if (editing && initial) {
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
        await apiSend(`/api/service-checks/${initial.id}`, 'PUT', body);
      } else {
        const body = {
          name: name.trim(),
          target: target.trim(),
          types: TYPE_OPTIONS.map((o) => o.value).filter((v) => types.has(v)),
          site_id: siteId ? parseInt(siteId, 10) : null,
          site_name: site ? site.name : null,
          agent_id: agentId ? parseInt(agentId, 10) : null,
          interval_seconds: parseInt(interval, 10) || 60,
          params: buildSharedParams(),
        };
        await apiSend('/api/service-checks', 'POST', body);
      }
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

        {editing ? (
          <label className="sv-field" style={{ marginTop: 12 }}>Type
            <select className="sv-select" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ) : (
          <div className="sv-field" style={{ marginTop: 12 }}>Check types
            <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
              {TYPE_OPTIONS.map((o) => (
                <label key={o.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', fontWeight: 400 }}>
                  <input type="checkbox" checked={types.has(o.value)} onChange={() => toggleType(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Select one or more — each type becomes a check sharing this target.
            </div>
          </div>
        )}

        <label className="sv-field" style={{ marginTop: 12 }}>Target
          <input
            className="sv-input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={
              editing
                ? (type === 'http' ? 'https://example.com/health'
                  : type === 'dns' ? 'example.com'
                  : 'host.example.com')
                : (types.has('http') ? 'https://example.com/health' : 'example.com')
            }
          />
          {!editing && types.has('http') && (types.has('tcp') || types.has('ssl') || types.has('dns')) && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Use a full URL for HTTP; the host part is reused for TCP/SSL/DNS.
            </span>
          )}
        </label>

        {/* Type-specific params — union of selected types in create mode, the single type in edit mode */}
        {(editing ? type === 'http' : types.has('http')) && (
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
        {(editing ? (type === 'tcp' || type === 'ssl') : (types.has('tcp') || types.has('ssl'))) && (
          <label className="sv-field" style={{ marginTop: 12 }}>Port
            <input className="sv-input" value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={editing ? (type === 'ssl' ? '443' : 'e.g. 22') : '443'} />
            {!editing && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                blank = 443 for SSL / derived from URL for TCP
              </span>
            )}
          </label>
        )}
        {(editing ? type === 'ssl' : types.has('ssl')) && (
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

// A multi-type group: header row + indented child sub-rows.
function GroupedServiceRows({ groupId, checks, canEdit, colCount, onEdit, onDelete, onDeleteGroup }: {
  groupId: string;
  checks: ServiceCheck[];
  canEdit: boolean;
  colCount: number;
  onEdit: (c: ServiceCheck) => void;
  onDelete: (c: ServiceCheck) => void;
  onDeleteGroup: (groupId: string, name: string) => void;
}) {
  const worst = worstStatus(checks);
  const worstCheck = checks.slice().sort(
    (a, b) => (STATUS_RANK[dotStatus(b.current_status)] ?? 1) - (STATUS_RANK[dotStatus(a.current_status)] ?? 1)
  )[0];
  const name = checks[0]?.name || 'Group';
  const target = checks[0]?.target || '';
  return (
    <>
      <tr style={{ height: 44, background: 'var(--bg-subtle, rgba(0,0,0,0.02))' }}>
        <td style={{ width: 28, paddingLeft: 12 }}>
          <StatusDot status={worst} size={10} title={worst} />
        </td>
        <td style={{ whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--text-primary)' }}>
          {name}
          <span style={{ display: 'inline-flex', gap: 4, marginLeft: 8, verticalAlign: 'middle' }}>
            {checks.map((c) => (
              <span key={c.id} className="sv-type-badge" style={{ fontSize: 10 }}>{typeLabel(c.type)}</span>
            ))}
          </span>
        </td>
        <td style={{ width: 1, whiteSpace: 'nowrap' }}>
          <span className="sv-type-badge" style={{ fontSize: 10 }}>{checks.length} types</span>
        </td>
        <td style={{ fontSize: 12, color: 'var(--text-primary)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={target}>
          {target}
        </td>
        <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {checks[0]?.agent_name || 'Central'}
        </td>
        <td />
        <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={worstCheck?.last_detail || ''}>
          {worstCheck?.last_detail || '—'}
        </td>
        <td />
        {canEdit && (
          <td style={{ width: 1, textAlign: 'right', whiteSpace: 'nowrap' }}>
            <button className="sv-btn ghost sm" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
              onClick={() => onDeleteGroup(groupId, name)}>Delete group</button>
          </td>
        )}
      </tr>
      {checks.map((c) => (
        <tr key={c.id} style={{ height: 40 }}>
          <td style={{ width: 28, paddingLeft: 28 }}>
            <StatusDot status={dotStatus(c.current_status)} size={9} title={c.current_status} />
          </td>
          <td style={{ whiteSpace: 'nowrap', paddingLeft: 28, color: 'var(--text-muted)', fontSize: 12 }}>
            <span className="sv-type-badge">{typeLabel(c.type)}</span>
            {!c.active && (
              <span className="sv-type-badge" style={{ fontSize: 10, marginLeft: 8 }}>Paused</span>
            )}
          </td>
          <td style={{ width: 1 }} />
          <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={c.target}>
            {c.target}
          </td>
          <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {c.agent_name || 'Central'}
          </td>
          <td style={{ fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', textAlign: 'right' }}>
            {c.last_response_ms != null ? `${c.last_response_ms} ms` : '—'}
          </td>
          <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={c.last_detail || ''}>
            {c.last_detail || '—'}
          </td>
          <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', textAlign: 'right' }}>
            {fmtRel(c.last_checked_at)}
          </td>
          {canEdit && (
            <td style={{ width: 1, textAlign: 'right', whiteSpace: 'nowrap' }}>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button className="sv-btn ghost sm" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
                  onClick={() => onEdit(c)}>Edit</button>
                <button className="sv-btn ghost sm" style={{ height: 24, padding: '0 10px', fontSize: 11 }}
                  onClick={() => onDelete(c)}>Delete</button>
              </span>
            </td>
          )}
        </tr>
      ))}
    </>
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

  async function handleDeleteGroup(groupId: string, name: string) {
    if (!confirm(`Delete all checks in group "${name}"?`)) return;
    await apiSend(`/api/service-checks/group/${groupId}`, 'DELETE');
    checks.reload();
  }

  const list = checks.data || [];
  const up = list.filter((c) => (c.current_status || '').toLowerCase() === 'up').length;
  const down = list.filter((c) => (c.current_status || '').toLowerCase() === 'down').length;
  const warning = list.filter((c) => (c.current_status || '').toLowerCase() === 'warning').length;
  const colCount = canEdit ? 9 : 8;

  // Build a render order: each grouped set renders together (header + children),
  // ungrouped checks render as individual rows. Order follows first appearance.
  type Block =
    | { kind: 'single'; check: ServiceCheck }
    | { kind: 'group'; groupId: string; checks: ServiceCheck[] };
  const groups = new Map<string, ServiceCheck[]>();
  const blocks: Block[] = [];
  for (const c of list) {
    if (c.group_id) {
      let g = groups.get(c.group_id);
      if (!g) {
        g = [];
        groups.set(c.group_id, g);
        blocks.push({ kind: 'group', groupId: c.group_id, checks: g });
      }
      g.push(c);
    } else {
      blocks.push({ kind: 'single', check: c });
    }
  }

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
              {blocks.map((b) => (
                b.kind === 'group' ? (
                  <GroupedServiceRows
                    key={`g-${b.groupId}`}
                    groupId={b.groupId}
                    checks={b.checks}
                    canEdit={canEdit}
                    colCount={colCount}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                    onDeleteGroup={handleDeleteGroup}
                  />
                ) : (
                  <ServiceRow
                    key={b.check.id}
                    check={b.check}
                    canEdit={canEdit}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                )
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

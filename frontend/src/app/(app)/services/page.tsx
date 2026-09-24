'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import {
  ErrorBox, fmtRel, fmtTime, PageHeader, TableSkeleton, EmptyState, useRefreshKey, useEscape, useConfirm,
  useTableSort, sortRows, SortTh, StatusBadge, Pager, useClientPagination,
} from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import {
  IconServices, IconChevronRight, IconShield, IconClock, IconArrowUp, IconArrowDown,
  IconPlug, IconRefresh, IconWarning, IconLink,
} from '@/components/icons';

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
  // Structured probe results. Written by the central collector; NULL on an
  // agent-run check until the agent module carries them too, and NULL on any
  // check that has not been polled since these columns were added.
  cert_issuer?: string | null;
  cert_valid_to?: string | null;
  cert_days_left?: number | null;
  dns_record_count?: number | null;
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

// Column sort accessors. Deliberately inverted vs STATUS_RANK above (down = 0)
// so the FIRST (ascending) click on Status surfaces the broken checks.
const STATUS_SORT_ORDER: Record<string, number> = { down: 0, warning: 1, unknown: 2, up: 3 };


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

// Pull a child check of a given type from a group's checks.
function childOfType(checks: ServiceCheck[], t: ServiceType): ServiceCheck | undefined {
  return checks.find((c) => c.type === t);
}

// Add / Edit / Group-edit modal.
function ServiceCheckModal({
  initial, group, sites, agents, onClose, onSaved,
}: {
  initial: ServiceCheck | null;
  group?: { groupId: string; checks: ServiceCheck[] } | null;
  sites: Site[];
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  useEscape(onClose);
  // Mode precedence: group-edit > single-edit > create.
  const groupEditing = !!group;
  const editing = !groupEditing && !!initial;
  // Multi-type checkbox UI is used for both create and group-edit modes.
  const multiType = !editing;

  // In group-edit mode, derive shared values from the group's children.
  const gChecks = group?.checks || [];
  const gHttp = childOfType(gChecks, 'http');
  const gTcp = childOfType(gChecks, 'tcp');
  const gSsl = childOfType(gChecks, 'ssl');
  const gFirst = gChecks[0];

  const [name, setName] = useState(
    groupEditing ? (gFirst?.name || '') : (initial?.name || ''));
  // Edit mode: single type. Create / group-edit mode: a set of selected types.
  const [type, setType] = useState<ServiceType>(initial?.type || 'http');
  const [types, setTypes] = useState<Set<ServiceType>>(
    groupEditing
      ? new Set<ServiceType>(gChecks.map((c) => c.type))
      : new Set<ServiceType>(initial ? [initial.type] : ['http']));
  const [target, setTarget] = useState(
    groupEditing ? ((gHttp?.target) ?? (gFirst?.target || '')) : (initial?.target || ''));
  const [siteId, setSiteId] = useState<string>(
    groupEditing
      ? (gFirst?.site_id != null ? String(gFirst.site_id) : '')
      : (initial?.site_id != null ? String(initial.site_id) : ''));
  const [agentId, setAgentId] = useState<string>(
    groupEditing
      ? (gFirst?.agent_id != null ? String(gFirst.agent_id) : '')
      : (initial?.agent_id != null ? String(initial.agent_id) : ''));
  const [interval, setInterval] = useState<string>(
    String((groupEditing ? gFirst?.interval_seconds : initial?.interval_seconds) || 60));
  // Type-specific params. In group-edit mode they come from the relevant child.
  const [expectStatus, setExpectStatus] = useState<string>(
    groupEditing
      ? (gHttp?.params?.expect_status != null ? String(gHttp.params.expect_status) : '200')
      : (initial?.params?.expect_status != null ? String(initial.params.expect_status) : '200'));
  const [keyword, setKeyword] = useState<string>(
    groupEditing
      ? (gHttp?.params?.keyword != null ? String(gHttp.params.keyword) : '')
      : (initial?.params?.keyword != null ? String(initial.params.keyword) : ''));
  const [port, setPort] = useState<string>(
    groupEditing
      ? ((gTcp?.params?.port ?? gSsl?.params?.port) != null ? String(gTcp?.params?.port ?? gSsl?.params?.port) : '')
      : (initial?.params?.port != null ? String(initial.params.port) : ''));
  const [sslWarnDays, setSslWarnDays] = useState<string>(
    groupEditing
      ? (gSsl?.params?.ssl_warn_days != null ? String(gSsl.params.ssl_warn_days) : '14')
      : (initial?.params?.ssl_warn_days != null ? String(initial.params.ssl_warn_days) : '14'));
  const [timeoutMs, setTimeoutMs] = useState<string>(
    groupEditing
      ? (gFirst?.params?.timeout_ms != null ? String(gFirst.params.timeout_ms) : '5000')
      : (initial?.params?.timeout_ms != null ? String(initial.params.timeout_ms) : '5000'));
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
    if (multiType && types.size === 0) { setError('Select at least one check type'); return; }
    setSaving(true);
    setError(null);
    const site = siteId ? sites.find((s) => s.id === parseInt(siteId, 10)) : null;
    try {
      if (groupEditing && group) {
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
        await apiSend(`/api/service-checks/group/${group.groupId}`, 'PUT', body);
      } else if (editing && initial) {
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
        <h2>{groupEditing ? 'Edit Service Group' : editing ? 'Edit Service Check' : 'New Service Check'}</h2>
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

        {!multiType ? (
          <label className="sv-field" style={{ marginTop: 12 }}>Type
            <select className="sv-select" value={type} onChange={(e) => setType(e.target.value as ServiceType)}>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ) : (
          <div className="sv-field" style={{ marginTop: 12 }}>Check types
            <div style={{ display: 'flex', gap: 16, marginTop: 6, flexWrap: 'wrap' }}>
              {TYPE_OPTIONS.map((o) => (
                <label key={o.value} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-base)', cursor: 'pointer', fontWeight: 400 }}>
                  <input type="checkbox" checked={types.has(o.value)} onChange={() => toggleType(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
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
              !multiType
                ? (type === 'http' ? 'https://example.com/health'
                  : type === 'dns' ? 'example.com'
                  : 'host.example.com')
                : (types.has('http') ? 'https://example.com/health' : 'example.com')
            }
          />
          {multiType && types.has('http') && (types.has('tcp') || types.has('ssl') || types.has('dns')) && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
              Use a full URL for HTTP; the host part is reused for TCP/SSL/DNS.
            </span>
          )}
        </label>

        {/* Type-specific params — union of selected types in create mode, the single type in edit mode */}
        {(!multiType ? type === 'http' : types.has('http')) && (
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
        {(!multiType ? (type === 'tcp' || type === 'ssl') : (types.has('tcp') || types.has('ssl'))) && (
          <label className="sv-field" style={{ marginTop: 12 }}>Port
            <input className="sv-input" value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={!multiType ? (type === 'ssl' ? '443' : 'e.g. 22') : '443'} />
            {multiType && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                blank = 443 for SSL; TCP/HTTP default to 443/https when SSL is ticked or the target is https, else port 80
              </span>
            )}
          </label>
        )}
        {(!multiType ? type === 'ssl' : types.has('ssl')) && (
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
            {saving ? 'Saving…' : (groupEditing || editing ? 'Save Changes' : 'Create Check')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Services list view. Every component below is TOP-LEVEL — defining one inside
// another remounts it on each render and drops input focus (CLAUDE.md rule).
// ════════════════════════════════════════════════════════════

// A service is a GROUP of per-type checks against one target (the API returns
// one row per check, tied by group_id). The page presents the group as the
// unit — one row, one pill per check type — which is how people think about
// "is itservice.thaiunion.com up", and folds a standalone check into a group
// of one so the rest of the code has a single shape to handle.
type ServiceGroup = {
  key: string;
  name: string;
  target: string;
  checks: ServiceCheck[];
  status: string;
  collector: string;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  ssl: ServiceCheck | null;
  paused: boolean;
  groupId: string | null;
};

// Days until a certificate expires, computed from the stored expiry at RENDER
// time rather than read from cert_days_left. The stored count is correct only
// on the day it was written; the date is correct forever.
function certDaysLeft(c: ServiceCheck | null): number | null {
  if (!c) return null;
  if (c.cert_valid_to) {
    const t = new Date(c.cert_valid_to).getTime();
    if (isFinite(t)) return Math.floor((t - Date.now()) / 86400000);
  }
  return c.cert_days_left ?? null;
}

function certTone(days: number | null): { bg: string; fg: string } | null {
  if (days === null) return null;
  if (days <= 14) return { bg: 'var(--tint-danger)', fg: 'var(--tint-danger-fg)' };
  if (days <= 60) return { bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' };
  return { bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' };
}

function buildGroups(list: ServiceCheck[]): ServiceGroup[] {
  const byKey = new Map<string, ServiceCheck[]>();
  for (const c of list) {
    const key = c.group_id || `check:${c.id}`;
    const arr = byKey.get(key) || [];
    arr.push(c);
    byKey.set(key, arr);
  }
  const out: ServiceGroup[] = [];
  for (const [key, checks] of byKey) {
    const ssl = checks.find((c) => c.type === 'ssl') || null;
    // The displayed target prefers a non-HTTP child: http stores a full URL
    // while dns/tcp/ssl store the bare host, and the host is what identifies
    // the service.
    const bare = checks.find((c) => c.type !== 'http');
    const latencies = checks.map((c) => c.last_response_ms).filter((v): v is number => v != null && isFinite(v));
    const stamps = checks.map((c) => c.last_checked_at).filter(Boolean) as string[];
    out.push({
      key,
      name: checks[0].name,
      target: (bare || checks[0]).target,
      checks: checks.slice().sort((a, b) =>
        TYPE_OPTIONS.findIndex((t) => t.value === a.type) - TYPE_OPTIONS.findIndex((t) => t.value === b.type)),
      status: worstStatus(checks),
      collector: checks[0].agent_name || 'Central',
      // Worst (highest) latency across the group: a service is only as quick as
      // its slowest check, and an average would hide one slow probe.
      latencyMs: latencies.length ? Math.max(...latencies) : null,
      lastCheckedAt: stamps.length ? stamps.slice().sort().pop() as string : null,
      ssl,
      paused: checks.every((c) => !c.active),
      groupId: checks[0].group_id,
    });
  }
  return out;
}

// ── Stat tile ────────────────────────────────────────────────
// The suite's stat card is a bordered card with a coloured LEFT BORDER keyed to
// status (CLAUDE.md). The mockup adds a tinted icon circle; this keeps both
// rather than trading one for the other, so Services still reads as the same
// family as every other page.
function StatTile({ icon, value, label, sub, variant, tint }: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  sub?: string;
  variant: 'total' | 'up' | 'down' | 'warning' | 'unknown';
  tint: { bg: string; fg: string };
}) {
  return (
    <div className={`sv-card ${variant}`} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
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
      <span style={{ minWidth: 0 }}>
        <span className="num" style={{ display: 'block', lineHeight: 1.1 }}>{value}</span>
        <span className="label" style={{ display: 'block' }}>{label}</span>
        {sub && (
          <span className="sv-muted" style={{ display: 'block', fontSize: 'var(--text-sm)', marginTop: 2 }}>
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

// ── Per-row overflow menu ────────────────────────────────────
// Modelled on RowMenu in devices/page.tsx: outside-click + Escape aware, with
// the ARIA the suite already uses.
// The menu is anchored with `position: fixed`, NOT `absolute`: the table now
// lives inside a `.sv-table-scroll` wrapper, and `overflow-x: auto` computes
// `overflow-y` to `auto` too — an absolutely positioned panel would be clipped
// by that wrapper (worst on the last row, where the whole menu falls below the
// table). Fixed escapes it; the trade-off is that the anchor has to be measured
// on open and the menu closed on any scroll.
function ServiceRowMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    // Capture phase: the wrapper / page scrollers don't bubble their scroll events.
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  function toggle() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((o) => !o);
  }
  if (!items.length) return null;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btnRef}
        className="sv-btn ghost sm"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        style={{ height: 26, padding: '0 8px' }}
      >
        ⋮
      </button>
      {open && pos && (
        <span
          className="sv-dropdown"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 50, minWidth: 150 }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={`sv-dropdown-item${it.danger ? ' danger' : ''}`}
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ── Expanded row: one card per check ─────────────────────────
function CheckCard({ check }: { check: ServiceCheck }) {
  const t = check.type;
  const icon = t === 'dns' ? <IconServices width={15} height={15} />
    : t === 'ssl' ? <IconShield width={15} height={15} />
      : t === 'tcp' ? <IconPlug width={15} height={15} />
        : <IconLink width={15} height={15} />;
  const port = check.params && check.params.port ? String(check.params.port) : null;
  const title = t === 'ssl' ? 'SSL Certificate'
    : t === 'tcp' ? `TCP Check${port ? ` (Port ${port})` : ''}`
      : t === 'dns' ? 'DNS Check' : 'HTTP Check';

  // Each check type gets the one fact that matters for it. Every value here is
  // a stored field — nothing is parsed out of the detail sentence.
  const rows: { k: string; v: React.ReactNode }[] = [
    { k: 'Response time', v: check.last_response_ms != null ? `${Math.round(check.last_response_ms)} ms` : '—' },
  ];
  if (t === 'dns') {
    rows.push({
      k: 'Records resolved',
      v: check.dns_record_count != null ? `${check.dns_record_count} record(s)` : '—',
    });
  } else if (t === 'tcp') {
    rows.push({ k: 'Connection', v: check.current_status === 'up' ? 'Successful' : (check.last_detail || 'Failed') });
  } else if (t === 'ssl') {
    const days = certDaysLeft(check);
    rows.push({
      k: 'Valid until',
      v: check.cert_valid_to
        ? `${new Date(check.cert_valid_to).toISOString().slice(0, 10)}${days !== null ? ` (${days} days)` : ''}`
        : '—',
    });
    rows.push({ k: 'Issuer', v: check.cert_issuer || '—' });
  } else {
    rows.push({ k: 'Result', v: check.last_detail || '—' });
  }
  rows.push({ k: 'Last checked', v: fmtRel(check.last_checked_at) });

  return (
    <div style={{
      flex: '1 1 260px', minWidth: 0, border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)', padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <StatusDot status={dotStatus(check.current_status)} size={9} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>{icon}</span>
        <strong style={{
          fontSize: 'var(--text-base)', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</strong>
        <span style={{ flex: 1 }} />
        <StatusBadge status={dotStatus(check.current_status)} />
      </div>
      {rows.map((r) => (
        <div key={r.k} style={{
          display: 'flex', justifyContent: 'space-between', gap: 12,
          padding: '4px 0', fontSize: 'var(--text-base)',
          borderTop: '1px solid var(--border-light)',
        }}>
          <span className="sv-muted">{r.k}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>
            {r.v}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Expanded row: certificate detail ─────────────────────────
function GroupCertificate({ group }: { group: ServiceGroup }) {
  const ssl = group.ssl;
  if (!ssl) {
    return <EmptyState title="No SSL check" message="This service has no SSL check, so there is no certificate to report. Add one by editing the service." />;
  }
  const days = certDaysLeft(ssl);
  const tone = certTone(days);
  const rows: { k: string; v: React.ReactNode }[] = [
    { k: 'Status', v: <StatusBadge status={dotStatus(ssl.current_status)} /> },
    { k: 'Host', v: ssl.target },
    { k: 'Issuer', v: ssl.cert_issuer || 'Not recorded yet' },
    { k: 'Valid until', v: ssl.cert_valid_to ? new Date(ssl.cert_valid_to).toISOString().slice(0, 10) : 'Not recorded yet' },
    { k: 'Expires in', v: days !== null ? `${days} days` : '—' },
    { k: 'Handshake', v: ssl.last_response_ms != null ? `${Math.round(ssl.last_response_ms)} ms` : '—' },
    { k: 'Last checked', v: fmtRel(ssl.last_checked_at) },
  ];
  return (
    <div>
      {tone && days !== null && (
        <div style={{
          background: tone.bg, color: tone.fg, border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 10,
          fontSize: 'var(--text-base)', fontWeight: 600,
        }}>
          {days < 0 ? 'This certificate has expired.' : `Certificate expires in ${days} days.`}
        </div>
      )}
      {!ssl.cert_issuer && !ssl.cert_valid_to && (
        <p className="sv-muted" style={{ fontSize: 'var(--text-sm)', marginTop: 0 }}>
          Certificate details are recorded on the next SSL poll. Checks run by a remote agent do not record them yet.
        </p>
      )}
      <table className="sv-table" style={{ margin: 0 }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <td className="sv-muted" style={{ width: 150 }}>{r.k}</td>
              <td>{r.v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Expanded row: recent results across the group's checks ───
function GroupHistory({ group }: { group: ServiceGroup }) {
  const [checkId, setCheckId] = useState<number>(group.checks[0].id);
  const active = group.checks.find((c) => c.id === checkId) || group.checks[0];
  // Results are per check — there is no group-level history endpoint — so the
  // user picks which check's history to read rather than seeing an interleaved
  // stream whose rows would be ambiguous.
  const res = useApi<{ rows: { ts: string; status: string; response_ms: number | null; detail: string | null }[]; uptime_pct: number | null; total: number }>(
    `/api/service-checks/${active.id}/results?range=24h&limit=25`
  );
  return (
    <div>
      <div className="sv-toolbar" style={{ marginBottom: 10 }}>
        <select className="sv-select" value={checkId} onChange={(e) => setCheckId(parseInt(e.target.value, 10))}>
          {group.checks.map((c) => <option key={c.id} value={c.id}>{typeLabel(c.type)} — {c.target}</option>)}
        </select>
        {res.data && res.data.uptime_pct != null && (
          <span className="sv-muted">{res.data.uptime_pct.toFixed(2)}% uptime over 24h · {res.data.total} checks</span>
        )}
        <span style={{ flex: 1 }} />
        <Link className="sv-btn ghost sm" href={`/services/${active.id}`}>Full history →</Link>
      </div>
      {res.error ? <ErrorBox message={res.error} />
        : res.loading && !res.data ? <TableSkeleton rows={4} cols={3} />
          : !res.data || !res.data.rows.length ? <EmptyState title="No results yet" message="This check has not recorded a result in the last 24 hours." />
            : (
              <table className="sv-table" style={{ margin: 0 }}>
                <thead><tr><th>When</th><th>Status</th><th>Response</th><th>Detail</th></tr></thead>
                <tbody>
                  {res.data.rows.map((r, i) => (
                    <tr key={`${r.ts}-${i}`}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.ts)}</td>
                      <td><StatusBadge status={dotStatus(r.status)} /></td>
                      <td>{r.response_ms != null ? `${Math.round(r.response_ms)} ms` : '—'}</td>
                      <td className="sv-muted">{r.detail || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
    </div>
  );
}

// ── Expanded row: alerts raised by this service's checks ─────
function GroupEvents({ group }: { group: ServiceGroup }) {
  // One request per check, using the service_check_id filter. Alerts are
  // site-scoped server-side, so this cannot show anything the caller may not
  // already see on the Alerts page.
  const ids = group.checks.map((c) => c.id);
  const a0 = useApi<any[]>(`/api/alerts?service_check_id=${ids[0]}&limit=25`);
  const a1 = useApi<any[]>(ids[1] ? `/api/alerts?service_check_id=${ids[1]}&limit=25` : null);
  const a2 = useApi<any[]>(ids[2] ? `/api/alerts?service_check_id=${ids[2]}&limit=25` : null);
  const rows = [...(a0.data || []), ...(a1.data || []), ...(a2.data || [])]
    .sort((x, y) => String(y.triggered_at).localeCompare(String(x.triggered_at)))
    .slice(0, 25);
  const loading = a0.loading && !a0.data;
  if (a0.error) return <ErrorBox message={a0.error} />;
  if (loading) return <TableSkeleton rows={3} cols={4} />;
  if (!rows.length) {
    return <EmptyState title="No events" message="No alerts have been raised for this service's checks." />;
  }
  return (
    <table className="sv-table" style={{ margin: 0 }}>
      <thead><tr><th>Triggered</th><th>Severity</th><th>Status</th><th>Message</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.triggered_at)}</td>
            <td><span className={`sv-badge ${r.severity === 'critical' ? 'down' : 'warning'}`}>{r.severity}</span></td>
            <td className="sv-muted">{r.status}</td>
            <td>{r.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const GROUP_TABS = [
  { key: 'checks', label: 'Checks' },
  { key: 'history', label: 'History' },
  { key: 'cert', label: 'Certificate' },
  { key: 'events', label: 'Events' },
];

// ── One service: summary row + expandable detail ─────────────
function ServiceGroupRow({ group, colCount, canEdit, onEdit, onDelete, onTogglePause }: {
  group: ServiceGroup;
  colCount: number;
  canEdit: boolean;
  onEdit: (g: ServiceGroup) => void;
  onDelete: (g: ServiceGroup) => void;
  onTogglePause: (g: ServiceGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('checks');
  const days = certDaysLeft(group.ssl);
  const tone = certTone(days);

  return (
    <>
      <tr onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer' }}>
        <td style={{ width: 1, whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <IconChevronRight
              width={14} height={14}
              style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', color: 'var(--text-muted)' }}
            />
            <StatusDot status={dotStatus(group.status)} size={10} title={group.status} />
          </span>
        </td>
        <td>
          {/* The name is NOT a stretched link: inside a click-to-toggle row a
              flexed link swallows the row's clicks (the 1.88.1 bug). It hugs
              its content and stops propagation instead. */}
          <span style={{ display: 'block', minWidth: 0 }}>
            <Link
              href={`/services/${group.checks[0].id}`}
              onClick={(e) => e.stopPropagation()}
              style={{ fontWeight: 600, color: 'var(--text-primary)', textDecoration: 'none' }}
            >
              {group.name}
            </Link>
            {group.paused && <span className="sv-badge unknown" style={{ marginLeft: 8 }}>Paused</span>}
            <span className="sv-muted" style={{ display: 'block', fontSize: 'var(--text-sm)' }}>{group.target}</span>
          </span>
        </td>
        <td className="sv-muted" style={{ minWidth: 0 }}>{group.target}</td>
        <td>
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {group.checks.map((c) => (
              <span key={c.id} className="sv-type-badge" style={{ marginTop: 0 }} title={`${typeLabel(c.type)} — ${c.current_status}`}>
                {typeLabel(c.type)}
              </span>
            ))}
          </span>
        </td>
        <td className="sv-muted" style={{ whiteSpace: 'nowrap' }}>{group.collector}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{group.latencyMs != null ? `${Math.round(group.latencyMs)} ms` : '—'}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {days === null ? <span className="sv-muted">—</span> : (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: tone!.bg, color: tone!.fg,
              padding: '2px 8px', borderRadius: 'var(--radius-pill)', fontSize: 'var(--text-sm)', fontWeight: 600,
            }}>
              <IconClock width={13} height={13} />
              {days < 0 ? 'Expired' : `Expires in ${days} days`}
              {group.ssl?.cert_valid_to && (
                <span style={{ opacity: 0.8, fontWeight: 400 }}>
                  ({new Date(group.ssl.cert_valid_to).toISOString().slice(0, 10)})
                </span>
              )}
            </span>
          )}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>{fmtRel(group.lastCheckedAt)}</td>
        <td style={{ width: 1, textAlign: 'right', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Link
              className="sv-btn ghost sm"
              href={`/services/${group.checks[0].id}`}
              onClick={(e) => e.stopPropagation()}
              style={{ height: 26, padding: '0 10px', fontSize: 'var(--text-xs)' }}
            >
              View details
            </Link>
            {canEdit && (
              <ServiceRowMenu
                items={[
                  { label: 'Edit service', onClick: () => onEdit(group) },
                  { label: group.paused ? 'Resume checks' : 'Pause checks', onClick: () => onTogglePause(group) },
                  { label: 'Delete service', onClick: () => onDelete(group), danger: true },
                ]}
              />
            )}
          </span>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={colCount} style={{ padding: '0 16px 14px 44px', background: 'var(--bg-primary)' }}>
            <div className="sv-tabs" style={{ marginTop: 0 }}>
              {GROUP_TABS.map((t) => (
                <button
                  key={t.key}
                  className={`sv-tab ${tab === t.key ? 'active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); setTab(t.key); }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div style={{ paddingTop: 12 }} onClick={(e) => e.stopPropagation()}>
              {tab === 'checks' && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {group.checks.map((c) => <CheckCard key={c.id} check={c} />)}
                </div>
              )}
              {tab === 'history' && <GroupHistory group={group} />}
              {tab === 'cert' && <GroupCertificate group={group} />}
              {tab === 'events' && <GroupEvents group={group} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
const PER_PAGE_OPTIONS = [10, 25, 50, 100];

// Sort accessors operate on the GROUP, not the individual check. Status is
// deliberately inverted (down first) so the first ascending click surfaces what
// is broken — the same convention the old per-check table used.
const GROUP_SORT_ACCESSORS = {
  status: (g: ServiceGroup) => STATUS_SORT_ORDER[dotStatus(g.status)] ?? 9,
  name: (g: ServiceGroup) => g.name.toLowerCase(),
  target: (g: ServiceGroup) => g.target.toLowerCase(),
  collector: (g: ServiceGroup) => g.collector.toLowerCase(),
  latency: (g: ServiceGroup) => g.latencyMs,
  cert: (g: ServiceGroup) => certDaysLeft(g.ssl),
  checked: (g: ServiceGroup) => g.lastCheckedAt,
};

export default function ServicesPage() {
  const { canEdit } = useRbac();
  const { confirm, ConfirmUI } = useConfirm();
  const checks = useApi<ServiceCheck[]>('/api/service-checks', 15000);
  const sites = useApi<Site[]>('/api/netvault/sites');
  const agents = useApi<Agent[]>(canEdit ? '/api/agents' : null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceCheck | null>(null);
  const [editingGroup, setEditingGroup] = useState<{ groupId: string; checks: ServiceCheck[] } | null>(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [collectorFilter, setCollectorFilter] = useState('all');
  const [perPage, setPerPage] = useState(10);
  const [err, setErr] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());

  // No initial sort: unsorted keeps the API's own ordering.
  const { sort, onSort } = useTableSort();
  useRefreshKey(() => checks.reload());

  // Stamp when a payload actually changes so "Updated Ns ago" reflects data,
  // not renders.
  useEffect(() => { if (checks.data) setFetchedAt(Date.now()); }, [checks.data]);
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const list = useMemo(() => checks.data || [], [checks.data]);
  const groups = useMemo(() => buildGroups(list), [list]);

  const collectors = useMemo(
    () => Array.from(new Set(groups.map((g) => g.collector))).sort(),
    [groups]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groups.filter((g) => {
      if (needle && !(g.name.toLowerCase().includes(needle) || g.target.toLowerCase().includes(needle))) return false;
      if (statusFilter !== 'all' && dotStatus(g.status) !== statusFilter) return false;
      if (typeFilter !== 'all' && !g.checks.some((c) => c.type === typeFilter)) return false;
      if (collectorFilter !== 'all' && g.collector !== collectorFilter) return false;
      return true;
    });
  }, [groups, q, statusFilter, typeFilter, collectorFilter]);

  const sorted = useMemo(() => sortRows(filtered, sort, GROUP_SORT_ACCESSORS), [filtered, sort]);
  const pg = useClientPagination(
    sorted, perPage,
    `${sort ? `${sort.key}:${sort.dir}` : ''}|${q}|${statusFilter}|${typeFilter}|${collectorFilter}|${perPage}`
  );

  // Tiles count SERVICES (groups), not individual checks — the page's unit.
  const upCount = groups.filter((g) => dotStatus(g.status) === 'up').length;
  const downCount = groups.filter((g) => dotStatus(g.status) === 'down').length;
  const warnCount = groups.filter((g) => dotStatus(g.status) === 'warning').length;
  const pct = (n: number) => (groups.length ? Math.round((n / groups.length) * 100) : 0);
  // "Expiring" counts certificates due within 60 days, from the stored expiry.
  const expiring = groups.filter((g) => {
    const d = certDaysLeft(g.ssl);
    return d !== null && d <= 60;
  }).length;

  const colCount = 9;

  function openNew() { setEditing(null); setEditingGroup(null); setModalOpen(true); }
  function openEditGroup(g: ServiceGroup) {
    if (g.groupId) { setEditing(null); setEditingGroup({ groupId: g.groupId, checks: g.checks }); }
    else { setEditingGroup(null); setEditing(g.checks[0]); }
    setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); setEditingGroup(null); }

  // Every mutation reports its failure. These used to await apiSend with no
  // try/catch, so a 403 from RBAC or a license write-block produced an
  // unhandled rejection and a row that simply did not disappear.
  async function handleDelete(g: ServiceGroup) {
    const many = g.checks.length > 1;
    const ok = await confirm({
      title: many ? 'Delete service?' : 'Delete service check?',
      message: many
        ? `Delete "${g.name}" and all ${g.checks.length} of its checks? Their history will be removed.`
        : `Delete service check "${g.name}"? Its history will be removed.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setErr(null);
    try {
      if (g.groupId) await apiSend(`/api/service-checks/group/${g.groupId}`, 'DELETE');
      else await apiSend(`/api/service-checks/${g.checks[0].id}`, 'DELETE');
      checks.reload();
    } catch (e: any) {
      setErr(e?.message || 'Failed to delete service');
    }
  }

  // Pause/resume: the API has always accepted `active` on a check; nothing in
  // the UI ever sent it.
  async function handleTogglePause(g: ServiceGroup) {
    const next = g.paused;
    setErr(null);
    try {
      for (const c of g.checks) await apiSend(`/api/service-checks/${c.id}`, 'PUT', { active: next });
      checks.reload();
    } catch (e: any) {
      setErr(e?.message || 'Failed to update service');
    }
  }

  return (
    <div>
      <PageHeader title="Services" subtitle="Synthetic availability and certificate monitoring">
        <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
          Updated {Math.max(0, Math.round((Date.now() - fetchedAt) / 1000))}s ago
        </span>
        <button
          className="sv-btn ghost sm"
          aria-label="Refresh services"
          title="Refresh"
          onClick={() => checks.reload()}
          disabled={checks.loading}
        >
          <IconRefresh width={14} height={14} />
        </button>
        {canEdit && <button className="sv-btn" onClick={openNew}>+ New Check</button>}
      </PageHeader>

      {err && <ErrorBox message={err} />}
      {checks.error && <ErrorBox message={checks.error} />}

      <div className="sv-cards" style={{ marginBottom: 16 }}>
        <StatTile
          icon={<IconServices width={19} height={19} />} variant="total"
          value={groups.length} label="Services" sub="Total configured services"
          tint={{ bg: 'var(--surface-subtle)', fg: 'var(--text-secondary)' }}
        />
        <StatTile
          icon={<IconArrowUp width={19} height={19} />} variant="up"
          value={upCount} label="Up" sub={`${pct(upCount)}% availability`}
          tint={{ bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' }}
        />
        <StatTile
          icon={<IconArrowDown width={19} height={19} />} variant="down"
          value={downCount} label="Down" sub={`${pct(downCount)}% of services`}
          tint={{ bg: 'var(--tint-danger)', fg: 'var(--tint-danger-fg)' }}
        />
        <StatTile
          icon={<IconWarning width={19} height={19} />} variant="warning"
          value={warnCount} label="Warning" sub={`${pct(warnCount)}% of services`}
          tint={{ bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }}
        />
        <StatTile
          icon={<IconShield width={19} height={19} />} variant="unknown"
          value={expiring} label="Expiring Certificates" sub="Within 60 days"
          tint={{ bg: 'var(--tint-info)', fg: 'var(--tint-info-fg)' }}
        />
      </div>

      {checks.loading && !checks.data ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <TableSkeleton rows={5} cols={colCount} />
        </div>
      ) : !list.length ? (
        <div className="sv-panel">
          <EmptyState
            icon={<IconServices width={26} height={26} />}
            title="No service checks yet"
            message="Add an HTTP, TCP, SSL, or DNS check to start monitoring availability and certificates."
            actionLabel={canEdit ? '+ New Check' : undefined}
            onAction={canEdit ? openNew : undefined}
          />
        </div>
      ) : (
        <>
          <div className="sv-toolbar">
            <input
              className="sv-input sv-input-md"
              placeholder="Search services or targets…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select className="sv-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All Status</option>
              <option value="up">Up</option>
              <option value="down">Down</option>
              <option value="warning">Warning</option>
              <option value="unknown">Unknown</option>
            </select>
            <select className="sv-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All Types</option>
              {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <select className="sv-select" value={collectorFilter} onChange={(e) => setCollectorFilter(e.target.value)}>
              <option value="all">All Collectors</option>
              {collectors.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {(q || statusFilter !== 'all' || typeFilter !== 'all' || collectorFilter !== 'all') && (
              <button
                className="sv-btn ghost sm"
                onClick={() => { setQ(''); setStatusFilter('all'); setTypeFilter('all'); setCollectorFilter('all'); }}
              >
                Clear
              </button>
            )}
            <span style={{ flex: 1 }} />
            <span className="sv-muted">{filtered.length} of {groups.length} services</span>
          </div>

          <div className="sv-panel" style={{ padding: 0 }}>
            {/* 9 columns overflow the ~1216px content area at 1512px wide, so the
                table scrolls inside this wrapper and the Actions column stays
                pinned to the right edge — before this the wrapper did not exist,
                the table spilled out of the panel and the row kebab rendered off
                the right of the viewport. */}
            <div className="sv-table-scroll">
              <table className="sv-table sv-table-pin-actions">
                <thead>
                  <tr>
                    <SortTh label="Status" col="status" sort={sort} onSort={onSort} />
                    <SortTh label="Service" col="name" sort={sort} onSort={onSort} />
                    <SortTh label="Target" col="target" sort={sort} onSort={onSort} />
                    <th>Checks</th>
                    <SortTh label="Collector" col="collector" sort={sort} onSort={onSort} />
                    <SortTh label="Latency" col="latency" sort={sort} onSort={onSort} />
                    <SortTh label="Certificate" col="cert" sort={sort} onSort={onSort} />
                    <SortTh label="Last Check" col="checked" sort={sort} onSort={onSort} />
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pg.pageRows.map((g) => (
                    <ServiceGroupRow
                      key={g.key}
                      group={g}
                      colCount={colCount}
                      canEdit={canEdit}
                      onEdit={openEditGroup}
                      onDelete={handleDelete}
                      onTogglePause={handleTogglePause}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <EmptyState
                title="No services match"
                message="Nothing matches the current filters. Clear them to see every configured service."
                actionLabel="Clear filters"
                onAction={() => { setQ(''); setStatusFilter('all'); setTypeFilter('all'); setCollectorFilter('all'); }}
              />
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
            <span className="sv-muted">
              Showing {filtered.length ? pg.start + 1 : 0}–{Math.min(pg.start + perPage, filtered.length)} of {filtered.length} services
            </span>
            <span style={{ flex: 1 }} />
            <label className="sv-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Rows per page
              <select
                className="sv-select sm"
                value={perPage}
                onChange={(e) => setPerPage(parseInt(e.target.value, 10))}
              >
                {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <Pager
              page={pg.page} pageCount={pg.pageCount} start={pg.start}
              perPage={perPage} total={pg.total} onPrev={pg.prev} onNext={pg.next}
            />
          </div>
        </>
      )}

      {ConfirmUI}

      {modalOpen && (
        <ServiceCheckModal
          initial={editing}
          group={editingGroup}
          sites={sites.data || []}
          agents={agents.data || []}
          onClose={closeModal}
          onSaved={() => { closeModal(); checks.reload(); }}
        />
      )}
    </div>
  );
}

'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { StatusBadge, ErrorBox, fmtTime, fmtRel, PageHeader, TableSkeleton, EmptyState, useRefreshKey, Pager, useClientPagination } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import SiteScopeBanner from '@/components/SiteScopeBanner';
import { IconNote, IconCheck } from '@/components/icons';

type Alert = {
  id: number; device_id: number; device_name: string; ip_address: string;
  alert_type: string; severity: string; message: string; metric_value: number | null;
  triggered_at: string; acknowledged_at: string | null; acknowledged_by: string | null;
  resolved_at: string | null; status: string; note: string | null;
  incident_id: number | null; incident_title: string | null;
  suppressed_by: number | null; suppression_reason: string | null; suppressed_by_name: string | null;
  agent_id?: number | null; agent_name?: string | null;
  service_check_id?: number | null; service_name?: string | null;
  wireless_ap_id?: number | null; wireless_controller_id?: number | null; wireless_name?: string | null;
};

// ── style tokens (kept inline since globals.css is not editable here) ──
const CARD_BORDER = '1px solid var(--border)';
// Opaque sticky table header (suite standard: never a semi-transparent tint).
const ALERT_TH_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600,
  letterSpacing: '0.06em', padding: '8px 12px', textAlign: 'left', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 5,
  background: 'var(--bg-card)', boxShadow: '0 1px 0 var(--border)',
};
const SECTION_HEADING: React.CSSProperties = {
  fontSize: 'var(--text-sm)', textTransform: 'uppercase', fontWeight: 600,
  color: 'var(--text-muted)', marginBottom: 8, letterSpacing: '0.06em',
};

// Pretty label for an alert_type token (e.g. "high_cpu" → "High Cpu",
// "rule_12" → "Custom Rule"). Shown as a small secondary badge.
function prettyType(t: string): string {
  if (!t) return 'Alert';
  if (/^rule_/.test(t)) return 'Custom Rule';
  if (/^recovery/.test(t)) return 'Recovery';
  if (t === 'agent_down') return 'Agent Down';
  if (t === 'service_down') return 'Service Down';
  if (t === 'ssl_expiring') return 'SSL Expiring';
  if (t === 'wireless_ap_down') return 'AP Down';
  if (t === 'wireless_controller_down') return 'Controller Down';
  if (t === 'wireless_high_util') return 'High Channel Util';
  if (t === 'wireless_ap_rebooted') return 'AP Rebooted';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Format a duration in seconds as a compact "Xh Ym" / "Xm" / "Xs" string.
function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// Quick-filter chips applied client-side over the fetched alert list.
// `last24h / lastnight / thisweek / critical / unack` are pure client filters;
// `suppressed` maps to the existing backend status filter (handled in the page).
const CHIPS = [
  { key: 'last24h', label: 'Last 24h' },
  { key: 'lastnight', label: 'Last night' },
  { key: 'thisweek', label: 'This week' },
  { key: 'critical', label: 'Critical only' },
  { key: 'unack', label: 'Unacknowledged' },
  { key: 'suppressed', label: 'Suppressed' },
];
function passesChips(a: Alert, active: Set<string>, search: string): boolean {
  if (search) {
    const q = search.toLowerCase();
    const hay = `${a.device_name || ''} ${a.agent_name || ''} ${a.service_name || ''} ${a.wireless_name || ''} ${a.ip_address || ''} ${a.message || ''} ${a.alert_type || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (!active.size) return true;
  const t = new Date(a.triggered_at).getTime();
  const now = Date.now();
  if (active.has('last24h') && t < now - 24 * 3600e3) return false;
  if (active.has('thisweek') && t < now - 7 * 24 * 3600e3) return false;
  if (active.has('lastnight')) {
    const h = new Date(a.triggered_at).getHours();
    if (!(h >= 20 || h < 8)) return false;
  }
  if (active.has('critical') && a.severity !== 'critical') return false;
  if (active.has('unack') && a.status !== 'active') return false;
  if (active.has('suppressed') && a.status !== 'suppressed') return false;
  return true;
}

// Incident groups per page (client-side). The fetch starts at ALERT_LIMIT_DEFAULT
// newest alerts and "Load older" grows it up to ALERT_LIMIT_MAX on demand.
const GROUPS_PER_PAGE = 50;
const ALERT_LIMIT_DEFAULT = 200;
const ALERT_LOAD_STEP = 200;
const ALERT_LIMIT_MAX = 1000;

type Group = { incidentId: number | null; title: string | null; alerts: Alert[] };
function buildGroups(list: Alert[]): Group[] {
  const byInc = new Map<number, Alert[]>();
  const groups: Group[] = [];
  for (const a of list) {
    if (a.incident_id != null) {
      const arr = byInc.get(a.incident_id);
      if (arr) { arr.push(a); }
      else { const fresh: Alert[] = [a]; byInc.set(a.incident_id, fresh); }
    } else {
      groups.push({ incidentId: null, title: null, alerts: [a] });
    }
  }
  for (const [incidentId, alerts] of byInc) {
    groups.push({ incidentId, title: alerts[0].incident_title || `Incident #${incidentId}`, alerts });
  }
  const newest = (g: Group) => Math.max(...g.alerts.map((x) => new Date(x.triggered_at).getTime()));
  groups.sort((a, b) => newest(b) - newest(a));
  return groups;
}
function worstSeverity(alerts: Alert[]): string {
  return alerts.some((a) => a.severity === 'critical') ? 'critical' : 'warning';
}
// Duration of an incident group inferred from the spread of its alert timestamps.
function groupDurationSec(alerts: Alert[]): number {
  const ts = alerts.map((a) => new Date(a.triggered_at).getTime()).filter((n) => isFinite(n));
  if (!ts.length) return 0;
  return (Math.max(...ts) - Math.min(...ts)) / 1000;
}

// ════════════════════════════════════════════════════════════
// Top-level presentational components (never nested — CLAUDE.md rule).
// ════════════════════════════════════════════════════════════

function AlertStatCard({ num, label, color }: { num: number; label: string; color: string }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: CARD_BORDER, borderLeft: `3px solid ${color}`,
      borderRadius: 'var(--radius-sm)', padding: '12px 16px', minHeight: 75,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
    }}>
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1 }}>{num}</div>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// Inline acknowledge note form. Kept top-level so it never remounts on parent
// re-render (prevents input focus loss). It owns no business state — value/handlers
// are passed in, so editing the note text does not re-create the component.
function AckNoteForm({
  value, onChange, onSave, onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px 10px',
      background: 'var(--bg-primary)', borderTop: CARD_BORDER,
    }}>
      <input
        className="sv-input"
        placeholder="Optional acknowledgement note…"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          if (e.key === 'Escape') onCancel();
        }}
        style={{ flex: 1, width: '100%', height: 32, padding: '4px 10px', fontSize: 'var(--text-sm)' }}
      />
      <button className="sv-btn sm" onClick={onSave}>Save</button>
      <button className="sv-btn ghost sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

export default function AlertsPage() {
  const { data: session } = useSession();
  const { canAcknowledgeAlerts } = useRbac();
  const [status, setStatus] = useState('active');
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [ackingId, setAckingId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [limit, setLimit] = useState(ALERT_LIMIT_DEFAULT);

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (severity) params.set('severity', severity);
  params.set('limit', String(limit));
  const alerts = useApi<Alert[]>(`/api/alerts?${params.toString()}`, 15000);

  useRefreshKey(() => alerts.reload());

  async function ack(a: Alert, note?: string) {
    await apiSend(`/api/alerts/${a.id}/acknowledge`, 'POST', {
      acknowledged_by: session?.user?.name || session?.user?.email || 'unknown',
      note: note || undefined,
    });
    setAckingId(null);
    setNoteText('');
    alerts.reload();
  }
  async function ackAll(list: Alert[]) {
    const active = list.filter((a) => a.status === 'active');
    for (const a of active) {
      await apiSend(`/api/alerts/${a.id}/acknowledge`, 'POST', {
        acknowledged_by: session?.user?.name || session?.user?.email || 'unknown',
      });
    }
    alerts.reload();
  }
  async function resolve(a: Alert) {
    await apiSend(`/api/alerts/${a.id}/resolve`, 'POST', {});
    alerts.reload();
  }

  function toggleChip(key: string) {
    setChips((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  function toggleIncident(id: number) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const all = alerts.data || [];
  const filtered = all.filter((a) => passesChips(a, chips, search.trim()));
  const groups = buildGroups(filtered);
  // Reset to page 1 when the filter identity changes (not when limit grows, so
  // "Load older" preserves the current page position).
  const groupPg = useClientPagination(
    groups, GROUPS_PER_PAGE,
    `${status}|${severity}|${search.trim()}|${[...chips].sort().join(',')}`,
  );
  // The server caps the fetch at `limit`; if it returned a full page, older
  // alerts likely exist. No total is available (endpoint returns a bare array),
  // so this is a heuristic, deliberately non-breaking for other callers.
  const canLoadOlder = all.length >= limit && limit < ALERT_LIMIT_MAX;
  const loadingOlder = alerts.loading && !!alerts.data;

  // Stat counts over the currently fetched set (pre-chip) for an at-a-glance summary.
  const cCritical = all.filter((a) => a.severity === 'critical' && a.status !== 'resolved').length;
  const cWarning = all.filter((a) => a.severity === 'warning' && a.status !== 'resolved').length;
  const cUnack = all.filter((a) => a.status === 'active').length;
  const cSuppressed = all.filter((a) => a.status === 'suppressed').length;

  // Inline action buttons (Acknowledge / Resolve) shown on row hover.
  function rowActions(a: Alert) {
    if (!canAcknowledgeAlerts) return null;
    return (
      <span style={{ display: 'inline-flex', gap: 6, whiteSpace: 'nowrap' }}>
        {a.status === 'active' && (
          <button
            className="sv-btn ghost sm"
            style={{ height: 24, padding: '0 10px', fontSize: 'var(--text-xs)' }}
            onClick={() => { setAckingId(ackingId === a.id ? null : a.id); setNoteText(''); }}
          >Ack</button>
        )}
        {a.status !== 'resolved' && a.status !== 'suppressed' && (
          <button
            className="sv-btn ghost sm"
            style={{ height: 24, padding: '0 10px', fontSize: 'var(--text-xs)' }}
            onClick={() => resolve(a)}
          >Resolve</button>
        )}
      </span>
    );
  }

  // Render a single alert as a table row, plus the inline ack form below it when
  // this row is being acknowledged. `indent` nests the row under an incident header.
  function alertRow(a: Alert, indent: boolean) {
    const suppressed = a.status === 'suppressed';
    const acking = ackingId === a.id;
    return (
      <Fragment key={a.id}>
        <tr style={{ height: 40, ...(suppressed ? { opacity: 0.6 } : {}) }}>
          {/* severity dot */}
          <td style={{ paddingLeft: indent ? 28 : 12, width: 28 }}>
            <StatusDot status={a.severity === 'critical' ? 'down' : 'warning'} size={9} />
          </td>
          {/* alert-type badge */}
          <td style={{ width: 1, whiteSpace: 'nowrap' }}>
            <span className="sv-type-badge">{prettyType(a.alert_type)}</span>
          </td>
          {/* device, or agent for agent_down alerts */}
          <td style={{ whiteSpace: 'nowrap' }}>
            {a.device_id == null && a.service_name ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Link href="/services" style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                  {a.service_name}
                </Link>
                <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>Service</span>
              </span>
            ) : a.device_id == null && a.agent_name ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Link href={`/agents/${a.agent_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                  {a.agent_name}
                </Link>
                <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>Agent</span>
              </span>
            ) : a.device_id == null && a.wireless_name ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Link href="/wireless" style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                  {a.wireless_name}
                </Link>
                <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>
                  {a.wireless_controller_id ? 'Controller' : 'AP'}
                </span>
              </span>
            ) : (
              <Link href={`/devices/${a.device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                {a.device_name || a.ip_address || `#${a.device_id}`}
              </Link>
            )}
          </td>
          {/* message (truncate at 300px) + note + suppression reason */}
          <td>
            <div
              title={a.message}
              style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}
            >{a.message}</div>
            {a.note && <div className="sv-alert-note" style={{ fontSize: 'var(--text-xs)', display: 'flex', alignItems: 'center', gap: 4 }}><IconNote width={12} height={12} /> {a.note}</div>}
            {suppressed && (
              <div style={{ fontSize: 'var(--text-xs)', fontStyle: 'italic', color: 'var(--text-muted)', marginTop: 2 }}>
                Suppressed{a.suppressed_by_name ? ` — ${a.suppressed_by_name} down`
                  : (a.suppression_reason ? ` — ${a.suppression_reason}` : '')}
              </div>
            )}
          </td>
          {/* status */}
          <td style={{ width: 1, whiteSpace: 'nowrap' }}><StatusBadge status={a.status} /></td>
          {/* time (right-aligned, muted; relative with absolute tooltip) */}
          <td title={fmtTime(a.triggered_at)} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
            {fmtRel(a.triggered_at)}
          </td>
          {/* hover actions */}
          <td style={{ width: 1, textAlign: 'right', whiteSpace: 'nowrap' }}>
            {rowActions(a)}
          </td>
        </tr>
        {acking && (
          <tr>
            <td colSpan={7} style={{ padding: 0 }}>
              <AckNoteForm
                value={noteText}
                onChange={setNoteText}
                onSave={() => ack(a, noteText)}
                onCancel={() => { setAckingId(null); setNoteText(''); }}
              />
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  return (
    <div>
      <PageHeader title="Alerts" subtitle="Network alerts raised by the collector." />

      <SiteScopeBanner />

      {/* ── Stat cards ───────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <AlertStatCard num={cCritical} label="Critical" color="var(--red)" />
        <AlertStatCard num={cWarning} label="Warning" color="var(--yellow)" />
        <AlertStatCard num={cUnack} label="Unacknowledged" color="var(--red)" />
        <AlertStatCard num={cSuppressed} label="Suppressed" color="var(--text-muted)" />
      </div>

      {/* ── Filter bar (2 rows) ──────────────────────────────── */}
      <div style={{
        background: 'var(--bg-card)', border: CARD_BORDER, borderRadius: 'var(--radius-sm)',
        padding: '12px 16px', marginBottom: 16,
      }}>
        {/* Row 1: status / severity / search */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="sv-select" value={status} onChange={(e) => setStatus(e.target.value)} style={{ height: 32 }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="suppressed">Suppressed</option>
          </select>
          <select className="sv-select" value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ height: 32 }}>
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
          <input
            className="sv-input"
            placeholder="Search device or message…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ height: 32, flex: 1, minWidth: 180 }}
          />
        </div>
        {/* Row 2: quick-filter chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {CHIPS.map((c) => (
            <button
              key={c.key}
              className={`sv-chip ${chips.has(c.key) ? 'active' : ''}`}
              onClick={() => toggleChip(c.key)}
              style={{ height: 24, fontSize: 'var(--text-xs)' }}
            >
              {c.label}
            </button>
          ))}
          {chips.size > 0 && (
            <button className="sv-chip clear" onClick={() => setChips(new Set())} style={{ height: 24, fontSize: 'var(--text-xs)' }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Alerts table ─────────────────────────────────────── */}
      {alerts.error && <ErrorBox message={alerts.error} />}
      <div style={{ background: 'var(--bg-card)', border: CARD_BORDER, borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        {alerts.loading && !alerts.data ? (
          <TableSkeleton rows={6} cols={6} />
        ) : groups.length ? (
          <table className="sv-table">
            <thead>
              <tr style={{ height: 34 }}>
                <th style={{ ...ALERT_TH_STYLE, width: 28 }} aria-label="Severity" />
                <th style={ALERT_TH_STYLE}>Type</th>
                <th style={ALERT_TH_STYLE}>Device</th>
                <th style={ALERT_TH_STYLE}>Message</th>
                <th style={ALERT_TH_STYLE}>Status</th>
                <th style={{ ...ALERT_TH_STYLE, textAlign: 'right' }}>Triggered</th>
                <th style={{ ...ALERT_TH_STYLE, textAlign: 'right' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {groupPg.pageRows.map((g) => {
                // Single-alert groups (incident or standalone) render as one row.
                if (g.incidentId == null || g.alerts.length === 1) {
                  return alertRow(g.alerts[0], false);
                }
                const open = expanded.has(g.incidentId);
                const sev = worstSeverity(g.alerts);
                const dur = fmtDuration(groupDurationSec(g.alerts));
                const hasActive = g.alerts.some((a) => a.status === 'active');
                return (
                  <Fragment key={`incgrp-${g.incidentId}`}>
                    <tr
                      className="sv-incident-head"
                      style={{ height: 36, background: sev === 'critical' ? 'var(--tint-danger)' : 'var(--tint-warn)' }}
                    >
                      <td
                        colSpan={6}
                        onClick={() => toggleIncident(g.incidentId!)}
                        style={{ cursor: 'pointer' }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <StatusDot status={sev === 'critical' ? 'down' : 'warning'} size={10} />
                          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{g.title}</span>
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{g.alerts.length} alerts</span>
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>· {dur}</span>
                          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--primary)' }}>
                            {open ? 'Collapse ▲' : 'Expand ▼'}
                          </span>
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {canAcknowledgeAlerts && hasActive && (
                          <button
                            className="sv-btn ghost sm"
                            style={{ height: 24, padding: '0 10px', fontSize: 'var(--text-xs)' }}
                            onClick={() => ackAll(g.alerts)}
                          >Ack All</button>
                        )}
                      </td>
                    </tr>
                    {open && g.alerts.map((a) => alertRow(a, true))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: '32px 24px' }}>
            <EmptyState
              icon={<IconCheck width={24} height={24} />}
              title="All clear"
              message="No alerts in this period."
            />
          </div>
        )}
      </div>

      {groups.length > 0 && (
        <Pager
          page={groupPg.page}
          pageCount={groupPg.pageCount}
          start={groupPg.start}
          perPage={GROUPS_PER_PAGE}
          total={groupPg.total}
          onPrev={groupPg.prev}
          onNext={groupPg.next}
          canLoadOlder={canLoadOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={() => setLimit((l) => Math.min(ALERT_LIMIT_MAX, l + ALERT_LOAD_STEP))}
          cappedNote={
            limit >= ALERT_LIMIT_MAX && all.length >= limit
              ? `Showing the newest ${limit.toLocaleString()} alerts. Narrow the filters or use Reports for older history.`
              : undefined
          }
        />
      )}
    </div>
  );
}

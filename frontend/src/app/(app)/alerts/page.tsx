'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { wirelessHref as sharedWirelessHref } from '@/lib/wirelessLinks';
import {
  StatusBadge, ErrorBox, fmtTime, fmtRel, PageHeader, TableSkeleton, EmptyState, useRefreshKey,
  Pager, useClientPagination, useTableSort, sortRows, SortTh, CHART_TOOLTIP, useConfirm, usePrompt, useToast,
} from '@/components/ui';
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
  wireless_client_mac?: string | null;
};

type VolumeBucket = { hour: string; critical: number; warning: number };
type VolumeResponse = { hours: number; buckets: VolumeBucket[] };

// ── style tokens ──────────────────────────────────────────────
const CARD_BORDER = '1px solid var(--border)';
// Opaque sticky table header (suite standard: never a semi-transparent tint).
const ALERT_TH_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600,
  letterSpacing: '0.06em', padding: '8px 12px', textAlign: 'left', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 5,
  background: 'var(--bg-card)', boxShadow: '0 1px 0 var(--border)',
};
const MICRO: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--text-muted)' };

// The alerts table's column count. Every full-width expansion row (the ack-note
// form) spans this, and every group-header row spans it MINUS the leading
// checkbox cell and the trailing actions cell — see the colSpan note on
// `.sv-table-pin-actions` in globals.css: the pinned-column rule deliberately
// excludes any `td[colspan]`, so a header row must keep a real, colspan-free
// LAST cell for the pin to apply to it.
const ALERT_COLS = 8;

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
  if (t === 'wireless_api_token_invalid') return 'API Token Invalid';
  if (t === 'wireless_high_util') return 'High Channel Util';
  if (t === 'wireless_ap_rebooted') return 'AP Rebooted';
  if (t === 'wireless_high_retry') return 'High Retry Rate';
  if (t === 'wireless_client_imbalance') return 'Client Band Imbalance';
  if (t === 'wireless_high_interference') return 'High Interference';
  if (t === 'wireless_degraded_noise_floor') return 'Degraded Noise Floor';
  if (t === 'wireless_roam_storm') return 'Roam Storm';
  if (t === 'wireless_weak_clients') return 'Weak Clients';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Where a wireless alert's entity-name link should point: AP-scoped alerts
// (wireless_ap_id set) deep-link straight into the specific AP's detail
// drawer on the Access Points tab; controller-scoped alerts (no AP, but
// wireless_controller_id set) go to the Controllers tab — there's no
// per-controller drawer deep-link today, so the tab is as specific as we can get.
// Thin wrapper over the shared rule in @/lib/wirelessLinks. The dashboard's
// Recent Events widget had its own bare '/wireless' link instead of this logic,
// so the same click behaved differently in two places; the rule now lives in
// one module so a third caller cannot diverge again.
function wirelessHref(a: Alert): string {
  return sharedWirelessHref(a.wireless_ap_id, a.wireless_controller_id);
}

// Same target the entity-name link in a row points to, used to make the
// whole row clickable. Returns null for alert types with no single obvious
// destination (row stays non-navigating; the Ack/Resolve buttons still work).
function rowHref(a: Alert): string | null {
  if (a.device_id != null) return `/devices/${a.device_id}`;
  if (a.service_name) return '/services';
  if (a.agent_name) return `/agents/${a.agent_id}`;
  if (a.wireless_name) return wirelessHref(a);
  return null;
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

// ════════════════════════════════════════════════════════════
// Correlation — one situation per row, not one line per symptom
// ════════════════════════════════════════════════════════════
// Measured on production (2026-09-23, 24h window): 727 alerts across 152
// distinct entities — a 4.8x collapse, with single APs contributing up to 30
// rows apiece (AP515-02: 17x high-retry + 9x interference + 4x imbalance).
// Reading that top-to-bottom is reading the same AP thirty times.
//
// The page already had an `incident_id` grouping mechanism (the
// `.sv-incident-head` row). It is kept and still takes precedence — but the
// collector has never populated `alerts.incident_id`: 0 of the newest 1000
// rows on production carry one, so in practice it grouped nothing. ENTITY
// grouping is layered under it using the same Group shape, the same header row
// and the same CSS class, so there is one grouping mechanism with two key
// sources rather than two parallel ones.
type GroupKind = 'single' | 'incident' | 'entity';
type Group = {
  key: string;            // stable across polls — drives the expand/collapse Set
  kind: GroupKind;
  incidentId: number | null;
  title: string;
  alerts: Alert[];
};

// Which "thing in the network" an alert is about. An alert row can hang off any
// one of five foreign keys (and a wireless-client alert hangs off a MAC, whose
// `wireless_clients` row is hard-deleted and re-created with a new id every
// reconnect — see gotchas.md — so the MAC, never a client row id, is the key).
// An alert that identifies nothing falls back to its own id, which can never
// collide, so it is always a group of one.
function entityKey(a: Alert): string {
  if (a.device_id != null) return `dev:${a.device_id}`;
  if (a.service_check_id != null) return `svc:${a.service_check_id}`;
  if (a.wireless_client_mac) return `wcl:${a.wireless_client_mac}`;
  if (a.wireless_ap_id != null) return `ap:${a.wireless_ap_id}`;
  if (a.wireless_controller_id != null) return `ctl:${a.wireless_controller_id}`;
  if (a.agent_id != null) return `agt:${a.agent_id}`;
  return `one:${a.id}`;
}
// Mirrors the entity-name cell's own precedence (device wins; otherwise
// service / agent / wireless), so the column sorts by what's actually shown.
function entityName(a: Alert): string {
  if (a.device_id == null) {
    return a.service_name || a.agent_name || a.wireless_name || a.ip_address || '';
  }
  return a.device_name || a.ip_address || `#${a.device_id}`;
}
function entityKindLabel(a: Alert): string {
  if (a.device_id != null) return 'Device';
  if (a.service_check_id != null) return 'Service';
  if (a.wireless_client_mac) return 'Client';
  if (a.wireless_ap_id != null) return 'AP';
  if (a.wireless_controller_id != null) return 'Controller';
  if (a.agent_id != null) return 'Agent';
  return 'Alert';
}

function buildGroups(list: Alert[], grouped: boolean): Group[] {
  if (!grouped) {
    // Flat chronological — the right view during an active incident, when the
    // question is "what happened next", not "what is broken".
    return list.map((a) => ({ key: `one:${a.id}`, kind: 'single' as GroupKind, incidentId: null, title: '', alerts: [a] }));
  }
  const byInc = new Map<number, Alert[]>();
  const byEnt = new Map<string, Alert[]>();
  const entOrder: string[] = [];
  for (const a of list) {
    if (a.incident_id != null) {
      const arr = byInc.get(a.incident_id);
      if (arr) arr.push(a);
      else byInc.set(a.incident_id, [a]);
    } else {
      const k = entityKey(a);
      const arr = byEnt.get(k);
      if (arr) arr.push(a);
      else { byEnt.set(k, [a]); entOrder.push(k); }
    }
  }
  const groups: Group[] = [];
  for (const [incidentId, alerts] of byInc) {
    groups.push({
      key: `inc:${incidentId}`, kind: 'incident', incidentId,
      title: alerts[0].incident_title || `Incident #${incidentId}`, alerts,
    });
  }
  for (const k of entOrder) {
    const alerts = byEnt.get(k)!;
    groups.push({
      key: `ent:${k}`,
      // A lone alert for an entity stays an ordinary row — wrapping one alert
      // in an expandable header would cost a click and show nothing new.
      kind: alerts.length > 1 ? 'entity' : 'single',
      incidentId: null,
      title: entityName(alerts[0]) || prettyType(alerts[0].alert_type),
      alerts,
    });
  }
  const newest = (g: Group) => Math.max(...g.alerts.map((x) => new Date(x.triggered_at).getTime()));
  groups.sort((a, b) => newest(b) - newest(a));
  return groups;
}

function worstSeverity(alerts: Alert[]): string {
  return alerts.some((a) => a.severity === 'critical') ? 'critical' : 'warning';
}
// Duration of a group inferred from the spread of its alert timestamps.
function groupDurationSec(alerts: Alert[]): number {
  const ts = alerts.map((a) => new Date(a.triggered_at).getTime()).filter((n) => isFinite(n));
  if (!ts.length) return 0;
  return (Math.max(...ts) - Math.min(...ts)) / 1000;
}
// "AP Down · High Retry Rate ×3" — the distinct symptom mix behind one header,
// capped so a 30-alert AP doesn't produce a header that wraps three lines.
function typeSummary(alerts: Alert[]): string {
  const counts = new Map<string, number>();
  for (const a of alerts) {
    const label = prettyType(a.alert_type);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
  return parts.length > 3 ? `${parts.slice(0, 3).join(' · ')} · +${parts.length - 3} more` : parts.join(' · ');
}

// ── Sort accessors ───────────────────────────────────────────────
// The table's rows are GROUPS (a standalone alert, an incident, or an entity
// with several alerts), so every sort key resolves against the group's
// representative alert — its first, i.e. most recent, member — except
// severity/triggered, which aggregate across the whole group the same way the
// header row displays. Ordering is worst/newest-first-friendly: `severityOrder`
// is deliberately inverted (critical = 0) so the FIRST (ascending) click
// surfaces criticals.
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1 };
function severityOrder(sev: string): number {
  return SEVERITY_ORDER[(sev || '').toLowerCase()] ?? 2;
}
function newestTriggered(alerts: Alert[]): number {
  const ts = alerts.map((a) => new Date(a.triggered_at).getTime()).filter((n) => isFinite(n));
  return ts.length ? Math.max(...ts) : 0;
}
const GROUP_SORT_ACCESSORS: Record<string, (g: Group) => unknown> = {
  severity: (g) => severityOrder(worstSeverity(g.alerts)),
  type: (g) => prettyType(g.alerts[0]?.alert_type || ''),
  device: (g) => entityName(g.alerts[0]),
  message: (g) => g.alerts[0]?.message || '',
  status: (g) => g.alerts[0]?.status || '',
  triggered: (g) => newestTriggered(g.alerts),
};

// ════════════════════════════════════════════════════════════
// Saved views
// ════════════════════════════════════════════════════════════
// STORAGE DECISION: localStorage, per-browser, NOT the database.
// SpanVault has no per-user preference store of any kind today — `app_settings`
// is a single global key/value table (it holds SMTP config and collector
// thresholds), and nothing in the schema is keyed by user id for preferences.
// Every existing preference in this app is already per-browser localStorage
// (theme, corner style, sidebar collapse, the dashboard's section + alert
// window, per-controller collapse on /wireless). A saved view follows that
// precedent rather than inventing a `user_preferences` table unilaterally.
// The trade-off is real and should be stated plainly in the UI: views do not
// follow the operator to another browser or machine. Promoting these to a
// server-side per-user store is a deliberate schema change for another day.
const VIEWS_KEY = 'sv-alerts-saved-views';
const GROUPED_KEY = 'sv-alerts-grouped';

type SavedView = {
  id: string; name: string;
  status: string; severity: string; search: string;
  chips: string[]; grouped: boolean;
};
function isSavedView(v: any): v is SavedView {
  return !!v && typeof v.id === 'string' && typeof v.name === 'string'
    && typeof v.status === 'string' && typeof v.severity === 'string'
    && typeof v.search === 'string' && Array.isArray(v.chips);
}
function loadViews(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedView).map((v) => ({ ...v, grouped: v.grouped !== false }));
  } catch { return []; }
}
function persistViews(views: SavedView[]) {
  try { window.localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); } catch { /* ignore */ }
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

// ── 24h alert-volume strip ────────────────────────────────────
// One bar per hour, stacked critical-over-warning, fed by GET
// /api/alerts/volume — a server-side aggregate, NOT a bucketing of the table's
// own rows. That matters: the table's fetch is capped and filtered by the
// status select, so bucketing it would draw "the shape of what happened to be
// fetched" and go blank on status=active. The strip therefore always shows the
// true 24h picture regardless of how the table below it is filtered.
// Clicking a bar focuses the table on that hour; clicking it again clears.
function AlertVolumeStrip({
  data, focus, onFocus, loading, error,
}: {
  data: { iso: string; label: string; critical: number; warning: number; total: number }[];
  focus: string | null;
  onFocus: (iso: string | null) => void;
  loading: boolean;
  error: string | null;
}) {
  const total = data.reduce((s, d) => s + d.total, 0);
  const crit = data.reduce((s, d) => s + d.critical, 0);
  let peak: { label: string; total: number } = { label: '—', total: 0 };
  for (const d of data) if (d.total > peak.total) peak = { label: d.label, total: d.total };
  const focused = focus ? data.find((d) => d.iso === focus) : null;
  return (
    <div style={{
      background: 'var(--bg-card)', border: CARD_BORDER, borderRadius: 'var(--radius-sm)',
      padding: '10px 14px 4px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 2 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          Volume · last 24h
        </span>
        {!error && (
          <span style={MICRO}>
            {total.toLocaleString()} triggered
            {crit > 0 && <> · <span style={{ color: 'var(--red)', fontWeight: 600 }}>{crit} critical</span></>}
            {peak.total > 0 && <> · peak {peak.total} at {peak.label}</>}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {focused ? (
          <button
            className="sv-chip active"
            onClick={() => onFocus(null)}
            style={{ height: 22, fontSize: 'var(--text-xs)', padding: '0 10px' }}
          >
            {focused.label}–{String((new Date(focused.iso).getHours() + 1) % 24).padStart(2, '0')}:00 · {focused.total} ✕
          </button>
        ) : (
          <span style={MICRO}>Click a bar to focus that hour</span>
        )}
      </div>
      {error ? (
        <div style={{ ...MICRO, padding: '14px 0 16px' }}>Volume unavailable — {error}</div>
      ) : loading && !data.length ? (
        <div style={{ ...MICRO, padding: '14px 0 16px' }}>Loading…</div>
      ) : (
        <ResponsiveContainer width="100%" height={84}>
          <BarChart
            data={data}
            margin={{ top: 4, right: 4, left: -28, bottom: 0 }}
            barCategoryGap="18%"
            onClick={(st: any) => {
              const iso = st?.activePayload?.[0]?.payload?.iso;
              if (iso) onFocus(iso === focus ? null : iso);
            }}
            style={{ cursor: 'pointer' }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={2} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={38} tickLine={false} axisLine={false} />
            <Tooltip {...CHART_TOOLTIP} cursor={{ fill: 'var(--surface-subtle)' }} />
            <Bar dataKey="warning" name="Warning" stackId="s" fill="var(--yellow)" />
            <Bar dataKey="critical" name="Critical" stackId="s" fill="var(--red)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
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
  const router = useRouter();
  const { data: session } = useSession();
  const { canAcknowledgeAlerts } = useRbac();
  const { confirm, ConfirmUI } = useConfirm();
  const { prompt, PromptUI } = usePrompt();
  const { toast, ToastUI } = useToast();
  const [status, setStatus] = useState('active');
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [grouped, setGrouped] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [hourFocus, setHourFocus] = useState<string | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [activeView, setActiveView] = useState('');
  const [ackingId, setAckingId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [limit, setLimit] = useState(ALERT_LIMIT_DEFAULT);
  // No initial sort: the default order stays buildGroups' newest-first.
  const { sort, onSort } = useTableSort();

  // localStorage is read AFTER mount, never during render — this component is
  // still server-rendered by Next, and reading it inline would produce a
  // hydration mismatch (and throw outright on the server).
  useEffect(() => {
    setViews(loadViews());
    try {
      const g = window.localStorage.getItem(GROUPED_KEY);
      if (g === '0') setGrouped(false);
    } catch { /* ignore */ }
  }, []);
  const setGroupedPersist = useCallback((g: boolean) => {
    setGrouped(g);
    try { window.localStorage.setItem(GROUPED_KEY, g ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (severity) params.set('severity', severity);
  params.set('limit', String(limit));
  const alerts = useApi<Alert[]>(`/api/alerts?${params.toString()}`, 15000);
  // Slower cadence than the list: this is an aggregate over a 24h window, it
  // moves by at most a handful of counts a minute, and it is one more scan of
  // a multi-million-row table — no reason to run it on the list's 15s poll.
  const volume = useApi<VolumeResponse>('/api/alerts/volume?hours=24', 60000);

  useRefreshKey(() => { alerts.reload(); volume.reload(); });

  const reloadAll = useCallback(() => { alerts.reload(); volume.reload(); }, [alerts, volume]);

  async function ack(a: Alert, note?: string) {
    await apiSend(`/api/alerts/${a.id}/acknowledge`, 'POST', {
      acknowledged_by: session?.user?.name || session?.user?.email || 'unknown',
      note: note || undefined,
    });
    setAckingId(null);
    setNoteText('');
    reloadAll();
  }
  async function resolve(a: Alert) {
    await apiSend(`/api/alerts/${a.id}/resolve`, 'POST', {});
    reloadAll();
  }

  // ── Bulk ────────────────────────────────────────────────────
  // ONE request per action, not a loop of single-id POSTs: the API grew
  // /api/alerts/bulk-acknowledge and /bulk-resolve, each a single UPDATE over
  // an id array under the same RBAC + site scoping as the single-id routes.
  // The response reports `updated` and `skipped` separately, so a partial
  // result (an id that raced to resolved, or one outside a site_admin's scope)
  // is stated honestly rather than silently swallowed.
  async function runBulk(kind: 'acknowledge' | 'resolve', ids: number[]) {
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const path = kind === 'acknowledge' ? '/api/alerts/bulk-acknowledge' : '/api/alerts/bulk-resolve';
      const body: Record<string, unknown> = { ids };
      // Attribution is re-derived server-side from the verified session header;
      // this is only the legacy fallback the single-id route already accepts.
      if (kind === 'acknowledge') body.acknowledged_by = session?.user?.name || session?.user?.email || 'unknown';
      const r = await apiSend<{ updated: number; requested: number; skipped: number[] }>(path, 'POST', body);
      const verb = kind === 'acknowledge' ? 'Acknowledged' : 'Resolved';
      if (r.skipped && r.skipped.length) {
        toast(`${verb} ${r.updated} of ${r.requested} — ${r.skipped.length} skipped (already ${kind === 'acknowledge' ? 'acknowledged/resolved' : 'resolved'}, or outside your sites).`, 'err');
      } else {
        toast(`${verb} ${r.updated} alert${r.updated === 1 ? '' : 's'}.`, 'ok');
      }
      setSelected(new Set());
    } catch (e: any) {
      toast(e?.message || 'Bulk action failed', 'err');
    } finally {
      setBulkBusy(false);
      reloadAll();
    }
  }

  function toggleChip(key: string) {
    setChips((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
    setActiveView('');
  }
  function toggleGroup(key: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  function toggleSelected(id: number) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function setManySelected(ids: number[], on: boolean) {
    setSelected((prev) => {
      const n = new Set(prev);
      for (const id of ids) { if (on) n.add(id); else n.delete(id); }
      return n;
    });
  }

  const all = useMemo(() => alerts.data || [], [alerts.data]);
  const filtered = useMemo(() => {
    const q = search.trim();
    const focusStart = hourFocus ? new Date(hourFocus).getTime() : 0;
    return all.filter((a) => {
      if (!passesChips(a, chips, q)) return false;
      if (hourFocus) {
        const t = new Date(a.triggered_at).getTime();
        if (!(t >= focusStart && t < focusStart + 3600e3)) return false;
      }
      return true;
    });
  }, [all, chips, search, hourFocus]);

  // Sort is applied to the grouped rows AFTER filtering, never instead of it.
  const groups = useMemo(
    () => sortRows(buildGroups(filtered, grouped), sort, GROUP_SORT_ACCESSORS),
    [filtered, grouped, sort],
  );
  // Reset to page 1 when the filter identity changes (not when limit grows, so
  // "Load older" preserves the current page position). Sort and grouping mode
  // are part of that identity — a re-sorted or re-grouped list starts at page 1.
  const groupPg = useClientPagination(
    groups, GROUPS_PER_PAGE,
    `${status}|${severity}|${search.trim()}|${[...chips].sort().join(',')}|${sort?.key ?? ''}:${sort?.dir ?? ''}|${grouped ? 'g' : 'f'}|${hourFocus ?? ''}`,
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

  // ── Volume strip data ───────────────────────────────────────
  const volData = useMemo(() => (volume.data?.buckets || []).map((b) => {
    const d = new Date(b.hour);
    return {
      iso: b.hour,
      label: `${String(d.getHours()).padStart(2, '0')}:00`,
      critical: b.critical,
      warning: b.warning,
      total: b.critical + b.warning,
    };
  }), [volume.data]);

  // ── Selection bookkeeping ───────────────────────────────────
  // A resolved alert has no action left, so it is not selectable — offering a
  // checkbox that can only ever produce a "skipped" result is worse than none.
  const selectableOnPage = useMemo(() => {
    const ids: number[] = [];
    for (const g of groupPg.pageRows) {
      for (const a of g.alerts) if (a.status !== 'resolved') ids.push(a.id);
    }
    return ids;
  }, [groupPg.pageRows]);
  const allPageSelected = selectableOnPage.length > 0 && selectableOnPage.every((id) => selected.has(id));
  // Selection survives the 15s poll (ids are stable), but an alert that has
  // since been resolved elsewhere must not stay counted in the bulk bar.
  const selectedAlerts = useMemo(
    () => all.filter((a) => selected.has(a.id) && a.status !== 'resolved'),
    [all, selected],
  );
  const selAckable = selectedAlerts.filter((a) => a.status === 'active').length;
  const selResolvable = selectedAlerts.filter((a) => a.status !== 'resolved' && a.status !== 'suppressed').length;

  // ── Saved views ─────────────────────────────────────────────
  function applyView(id: string) {
    setActiveView(id);
    if (!id) return;
    const v = views.find((x) => x.id === id);
    if (!v) return;
    setStatus(v.status);
    setSeverity(v.severity);
    setSearch(v.search);
    setChips(new Set(v.chips));
    setGroupedPersist(v.grouped);
    setHourFocus(null);
    setSelected(new Set());
  }
  async function saveCurrentView() {
    const name = await prompt({
      title: 'Save this view',
      message: 'Stores the current status, severity, search, quick filters and grouping mode under a name. Saved views live in THIS browser only — they do not follow you to another machine.',
      label: 'View name',
      defaultValue: '',
      placeholder: 'e.g. Unacked criticals',
      confirmLabel: 'Save view',
    });
    if (!name) return;
    const next: SavedView = {
      id: `v${Date.now().toString(36)}`,
      name: name.slice(0, 60),
      status, severity, search: search.trim(), chips: [...chips], grouped,
    };
    // Same name replaces rather than duplicating — re-saving is how you update one.
    const rest = views.filter((v) => v.name.toLowerCase() !== next.name.toLowerCase());
    const updated = [...rest, next].sort((a, b) => a.name.localeCompare(b.name));
    setViews(updated);
    persistViews(updated);
    setActiveView(next.id);
    toast(`Saved view “${next.name}”.`, 'ok');
  }
  async function deleteActiveView() {
    const v = views.find((x) => x.id === activeView);
    if (!v) return;
    if (!await confirm({
      title: 'Delete saved view?',
      message: `Remove “${v.name}” from this browser's saved views? The filters stay applied.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    const updated = views.filter((x) => x.id !== v.id);
    setViews(updated);
    persistViews(updated);
    setActiveView('');
  }

  // Inline action buttons (Acknowledge / Resolve) shown on row hover.
  function rowActions(a: Alert) {
    if (!canAcknowledgeAlerts) return null;
    return (
      <span style={{ display: 'inline-flex', gap: 6, whiteSpace: 'nowrap' }}>
        {a.status === 'active' && (
          <button
            className="sv-btn ghost sm"
            style={{ height: 24, padding: '0 10px', fontSize: 'var(--text-xs)' }}
            onClick={(e) => { e.stopPropagation(); setAckingId(ackingId === a.id ? null : a.id); setNoteText(''); }}
          >Ack</button>
        )}
        {a.status !== 'resolved' && a.status !== 'suppressed' && (
          <button
            className="sv-btn ghost sm"
            style={{ height: 24, padding: '0 10px', fontSize: 'var(--text-xs)' }}
            onClick={(e) => { e.stopPropagation(); resolve(a); }}
          >Resolve</button>
        )}
      </span>
    );
  }

  // Render a single alert as a table row, plus the inline ack form below it when
  // this row is being acknowledged. `indent` nests the row under a group header.
  function alertRow(a: Alert, indent: boolean) {
    const suppressed = a.status === 'suppressed';
    const acking = ackingId === a.id;
    const href = rowHref(a);
    const selectable = canAcknowledgeAlerts && a.status !== 'resolved';
    return (
      <Fragment key={a.id}>
        <tr
          style={{ height: 40, ...(suppressed ? { opacity: 0.6 } : {}), ...(href ? { cursor: 'pointer' } : {}) }}
          onClick={href ? () => router.push(href) : undefined}
          role={href ? 'button' : undefined}
          tabIndex={href ? 0 : undefined}
          onKeyDown={href ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); router.push(href); } } : undefined}
        >
          {/* select */}
          <td style={{ width: 34, paddingLeft: 12, paddingRight: 0 }} onClick={(e) => e.stopPropagation()}>
            {selectable && (
              <input
                type="checkbox"
                aria-label={`Select alert ${a.id}`}
                checked={selected.has(a.id)}
                onChange={() => toggleSelected(a.id)}
                style={{ cursor: 'pointer' }}
              />
            )}
          </td>
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
                <Link href="/services" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                  {a.service_name}
                </Link>
                <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>Service</span>
              </span>
            ) : a.device_id == null && a.agent_name ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Link href={`/agents/${a.agent_id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                  {a.agent_name}
                </Link>
                <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>Agent</span>
              </span>
            ) : a.device_id == null && a.wireless_name ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Link href={wirelessHref(a)} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                  {a.wireless_name}
                </Link>
                <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>
                  {a.wireless_client_mac ? 'Client' : a.wireless_controller_id ? 'Controller' : 'AP'}
                </span>
                {a.wireless_client_mac && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {a.wireless_client_mac}
                  </span>
                )}
              </span>
            ) : (
              <Link href={`/devices/${a.device_id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
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
          {/* hover actions — MUST stay the last cell and carry no colspan, or the
              `.sv-table-pin-actions` rule stops pinning it. */}
          <td style={{ width: 1, textAlign: 'right', whiteSpace: 'nowrap' }}>
            {rowActions(a)}
          </td>
        </tr>
        {acking && (
          <tr>
            <td colSpan={ALERT_COLS} style={{ padding: 0 }}>
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

  // Header row for a correlated group (incident or entity). Its LAST cell is a
  // real, colspan-free actions cell so the pinned-column rule still applies to
  // it, and it sets --sv-row-tint so that pinned cell keeps the row's tint over
  // its opaque base (the tint tokens are translucent in dark mode).
  function groupRow(g: Group) {
    const open = expanded.has(g.key);
    const sev = worstSeverity(g.alerts);
    const dur = fmtDuration(groupDurationSec(g.alerts));
    const newest = g.alerts.reduce((m, a) => (new Date(a.triggered_at) > new Date(m.triggered_at) ? a : m), g.alerts[0]);
    const hasActive = g.alerts.some((a) => a.status === 'active');
    const ids = g.alerts.filter((a) => a.status !== 'resolved').map((a) => a.id);
    const allSel = ids.length > 0 && ids.every((id) => selected.has(id));
    const tint = sev === 'critical' ? 'var(--tint-danger)' : 'var(--tint-warn)';
    const first = g.alerts[0];
    return (
      <Fragment key={g.key}>
        <tr
          className="sv-incident-head"
          style={{ height: 38, background: tint, ['--sv-row-tint' as string]: tint } as React.CSSProperties}
        >
          <td style={{ width: 34, paddingLeft: 12, paddingRight: 0 }} onClick={(e) => e.stopPropagation()}>
            {canAcknowledgeAlerts && ids.length > 0 && (
              <input
                type="checkbox"
                aria-label={`Select all ${ids.length} alerts for ${g.title}`}
                checked={allSel}
                onChange={() => setManySelected(ids, !allSel)}
                style={{ cursor: 'pointer' }}
              />
            )}
          </td>
          <td colSpan={ALERT_COLS - 2} onClick={() => toggleGroup(g.key)} style={{ cursor: 'pointer' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <StatusDot status={sev === 'critical' ? 'down' : 'warning'} size={10} />
              <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{g.title}</span>
              {g.kind === 'entity' && (
                <span className="sv-type-badge" style={{ marginTop: 0 }}>{entityKindLabel(first)}</span>
              )}
              <span style={MICRO}>{g.alerts.length} alerts</span>
              <span style={MICRO}>· worst: {sev === 'critical' ? 'Critical' : 'Warning'}</span>
              <span style={MICRO} title={fmtTime(newest.triggered_at)}>· {fmtRel(newest.triggered_at)}</span>
              {dur !== '0s' && <span style={MICRO}>· spans {dur}</span>}
              <span style={{ ...MICRO, color: 'var(--text-secondary)' }}>· {typeSummary(g.alerts)}</span>
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
                onClick={(e) => {
                  e.stopPropagation();
                  runBulk('acknowledge', g.alerts.filter((a) => a.status === 'active').map((a) => a.id));
                }}
                disabled={bulkBusy}
              >Ack All</button>
            )}
          </td>
        </tr>
        {open && g.alerts.map((a) => alertRow(a, true))}
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

      {/* ── 24h volume strip ─────────────────────────────────── */}
      <AlertVolumeStrip
        data={volData}
        focus={hourFocus}
        onFocus={(iso) => { setHourFocus(iso); setActiveView(''); }}
        loading={volume.loading}
        error={volume.error}
      />

      {/* ── Filter bar (3 rows) ──────────────────────────────── */}
      <div style={{
        background: 'var(--bg-card)', border: CARD_BORDER, borderRadius: 'var(--radius-sm)',
        padding: '12px 16px', marginBottom: 16,
      }}>
        {/* Row 1: status / severity / search */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="sv-select" value={status} onChange={(e) => { setStatus(e.target.value); setActiveView(''); }} style={{ height: 32, minWidth: 155 }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="suppressed">Suppressed</option>
          </select>
          <select className="sv-select" value={severity} onChange={(e) => { setSeverity(e.target.value); setActiveView(''); }} style={{ height: 32, minWidth: 145 }}>
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
          <input
            className="sv-input"
            placeholder="Search device or message…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setActiveView(''); }}
            style={{ height: 32, flex: 1, minWidth: 180 }}
          />
          {/* Grouping toggle — grouped correlates one situation per row; flat is
              the right view during a live incident, where the sequence matters. */}
          <div className="sv-segmented" role="group" aria-label="Row grouping">
            <button
              className={`sv-seg ${grouped ? 'on' : ''}`}
              onClick={() => setGroupedPersist(true)}
              title="One row per device/entity, expandable"
            >Grouped</button>
            <button
              className={`sv-seg ${grouped ? '' : 'on'}`}
              onClick={() => setGroupedPersist(false)}
              title="One row per alert, newest first"
            >Flat</button>
          </div>
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
          {hourFocus && (
            <button className="sv-chip active" onClick={() => setHourFocus(null)} style={{ height: 24, fontSize: 'var(--text-xs)' }}>
              Hour {String(new Date(hourFocus).getHours()).padStart(2, '0')}:00 ✕
            </button>
          )}
          {(chips.size > 0 || hourFocus) && (
            <button
              className="sv-chip clear"
              onClick={() => { setChips(new Set()); setHourFocus(null); setActiveView(''); }}
              style={{ height: 24, fontSize: 'var(--text-xs)' }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Row 3: saved views */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-light)' }}>
          <span style={{ ...MICRO, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.06em' }}>Saved views</span>
          <select
            className="sv-select"
            value={activeView}
            onChange={(e) => applyView(e.target.value)}
            style={{ height: 28, minWidth: 190, fontSize: 'var(--text-sm)' }}
            aria-label="Saved views"
          >
            <option value="">{views.length ? 'Select a saved view…' : 'No saved views yet'}</option>
            {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <button className="sv-btn ghost sm" onClick={saveCurrentView} style={{ height: 28 }}>Save current…</button>
          {activeView && (
            <button className="sv-btn danger sm" onClick={deleteActiveView} style={{ height: 28 }}>Delete</button>
          )}
          <span style={{ ...MICRO, marginLeft: 'auto' }}>Stored in this browser only</span>
        </div>
      </div>

      {/* ── Alerts table ─────────────────────────────────────── */}
      {alerts.error && <ErrorBox message={alerts.error} />}
      <div style={{ background: 'var(--bg-card)', border: CARD_BORDER, borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        {alerts.loading && !alerts.data ? (
          <TableSkeleton rows={6} cols={7} />
        ) : groups.length ? (
          // The card above is `overflow: hidden` (it clips the rounded corners),
          // which SILENTLY CUT OFF the actions cell — "Resolve" rendered as "Re" —
          // once the columns outgrew the ~1216px content area. The table now
          // scrolls inside this wrapper and the actions column is pinned right.
          <div className="sv-table-scroll">
            <table className="sv-table sv-table-pin-actions">
              <thead>
                <tr style={{ height: 34 }}>
                  <th style={{ ...ALERT_TH_STYLE, width: 34, paddingLeft: 12, paddingRight: 0 }}>
                    {canAcknowledgeAlerts && (
                      <input
                        type="checkbox"
                        aria-label="Select all alerts on this page"
                        checked={allPageSelected}
                        disabled={!selectableOnPage.length}
                        onChange={() => setManySelected(selectableOnPage, !allPageSelected)}
                        style={{ cursor: 'pointer' }}
                      />
                    )}
                  </th>
                  <SortTh label="Severity" col="severity" sort={sort} onSort={onSort} style={ALERT_TH_STYLE} />
                  <SortTh label="Type" col="type" sort={sort} onSort={onSort} style={ALERT_TH_STYLE} />
                  <SortTh label="Device" col="device" sort={sort} onSort={onSort} style={ALERT_TH_STYLE} />
                  <SortTh label="Message" col="message" sort={sort} onSort={onSort} style={ALERT_TH_STYLE} />
                  <SortTh label="Status" col="status" sort={sort} onSort={onSort} style={ALERT_TH_STYLE} />
                  <SortTh label="Triggered" col="triggered" sort={sort} onSort={onSort} align="right" style={{ ...ALERT_TH_STYLE, textAlign: 'right' }} />
                  <th style={{ ...ALERT_TH_STYLE, textAlign: 'right' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {groupPg.pageRows.map((g) => (
                  g.kind === 'single' || g.alerts.length === 1
                    ? alertRow(g.alerts[0], false)
                    : groupRow(g)
                ))}
              </tbody>
            </table>
          </div>
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

      {/* ── Bulk action bar ──────────────────────────────────────
          Sticky to the BOTTOM of the scroller rather than the top: it appears
          and disappears with the selection, and a top-sticky bar would have to
          push the page down (or leave a permanent gap) every time it did.
          Opaque background + z-index per the suite sticky rule. */}
      {canAcknowledgeAlerts && selectedAlerts.length > 0 && (
        <div className="sv-bulkbar" role="region" aria-label="Bulk alert actions">
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 700 }}>
            {selectedAlerts.length} selected
          </span>
          <span style={MICRO}>
            {selAckable} acknowledgeable · {selResolvable} resolvable
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="sv-btn ghost sm"
            disabled={bulkBusy || !selAckable}
            onClick={() => runBulk('acknowledge', selectedAlerts.filter((a) => a.status === 'active').map((a) => a.id))}
          >
            {bulkBusy ? 'Working…' : `Acknowledge ${selAckable}`}
          </button>
          <button
            className="sv-btn ghost sm"
            disabled={bulkBusy || !selResolvable}
            onClick={async () => {
              const ids = selectedAlerts.filter((a) => a.status !== 'resolved' && a.status !== 'suppressed').map((a) => a.id);
              if (!await confirm({
                title: `Resolve ${ids.length} alert${ids.length === 1 ? '' : 's'}?`,
                message: 'Resolving closes the alert. If the underlying condition is still true the collector will raise it again on the next poll.',
                confirmLabel: 'Resolve',
                danger: true,
              })) return;
              runBulk('resolve', ids);
            }}
          >
            {bulkBusy ? 'Working…' : `Resolve ${selResolvable}`}
          </button>
          <button className="sv-btn ghost sm" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

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

      {grouped && groups.length > 0 && filtered.length > groups.length && (
        <div style={{ ...MICRO, marginTop: 8 }}>
          {filtered.length.toLocaleString()} alerts correlated into {groups.length.toLocaleString()} situations.
        </div>
      )}

      {ConfirmUI}
      {PromptUI}
      {ToastUI}
    </div>
  );
}

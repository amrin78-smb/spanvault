'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { StatusDot } from '@/components/StatusDot';
import {
  PageHeader, ErrorBox, Empty, Loading, TableSkeleton, CardSkeleton,
  StatusBadge, fmtRel, fmtTime, fmtBps, CHART_TOOLTIP,
  useTableSort, sortRows, SortTh, Tabs, useUrlTab, InfoTip, Notice, SevTag,
  LoadError, TableScroll, Freshness, useConfirm,
} from '@/components/ui';
import {
  GradeBadge, TrendArrow, ConfidenceStars, fmtDuration, deviationLabel, deviationTooltip,
  MetricName, metricUnit, formatMetricValue,
  scoreColor, n,
  Overview, HealthRow, AnomalyRow, IncidentRow, ThresholdRow, PatternRow,
} from '@/components/intel';

// Day-of-week labels (0 = Sunday) for periodic-pattern descriptions.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// When → human phrase for a detected pattern (e.g. "Mondays at 09:00").
function patternWhen(p: PatternRow): string {
  const parts: string[] = [];
  if (p.day_of_week != null && DOW[p.day_of_week]) parts.push(`${DOW[p.day_of_week]}s`);
  if (p.hour_of_day != null) parts.push(`at ${String(p.hour_of_day).padStart(2, '0')}:00`);
  return parts.length ? parts.join(' ') : 'Recurring';
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'anomalies', label: 'Anomalies' },
  { key: 'patterns', label: 'Patterns' },
  { key: 'health', label: 'Health' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'incidents', label: 'Incidents' },
  { key: 'thresholds', label: 'Thresholds' },
];
const REFRESH_MS = 30000;

// ════════════════════════════════════════════════════════════════
// Shared inline-styled primitives (all top-level — never nested)
// ════════════════════════════════════════════════════════════════

// Compact stat card — ~75px tall, 24px value (weight 800), 11px uppercase label,
// 3px coloured left border.
function StatCardCompact({ label, value, accent, badge, hint, definition }: {
  label: string; value: React.ReactNode; accent: string; badge?: React.ReactNode; hint?: string;
  /** What the number measures, over what window and scope. */
  definition?: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`, borderRadius: 'var(--radius-sm)',
      padding: '12px 16px', minHeight: 75, display: 'flex', flexDirection: 'column',
      justifyContent: 'center', boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 600 }}>
        {label}
        {definition && <InfoTip label={label}>{definition}</InfoTip>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
        <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1, color: accent }}>{value}</span>
        {badge}
      </div>
      {hint && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

// Section card — 16px 20px padding, --bg-card, 1px border, radius-sm.
function SectionCard({ title, action, children, style, flush }: {
  title: string; action?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties; flush?: boolean;
}) {
  // flush: card padding is 0 so a table can span edge-to-edge, but the title still
  // needs its own padding — otherwise the header text sits against the card edge.
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: flush ? '0' : '16px 20px', minWidth: 0,
      display: 'flex', flexDirection: 'column', ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, ...(flush ? { padding: '16px 20px 0' } : null) }}>
        <span style={{ fontSize: 'var(--text-sm)', textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>{title}</span>
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      {children}
    </div>
  );
}

// Small score bar — 4px tall (or 6px), green<60 / yellow 60-80 / red>80 by the
// spec's progress-bar rule. NB: higher score = healthier, so map inversely:
// score>=80 green, 60-80 yellow, <60 red (matches scoreColor semantics).
function ScoreMiniBar({ score, width = 60, height = 4, showValue = true }: {
  score: number | string | null | undefined; width?: number; height?: number; showValue?: boolean;
}) {
  const s = n(score);
  const c = scoreColor(s);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width, height, borderRadius: 'var(--radius-pill)', background: 'var(--border)', overflow: 'hidden', flex: 'none' }}>
        <div style={{ width: `${s != null ? Math.max(2, Math.min(100, s)) : 0}%`, height: '100%', background: c, borderRadius: 'var(--radius-pill)' }} />
      </div>
      {showValue && (
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: c, minWidth: 24, textAlign: 'right' }}>
          {s != null ? Math.round(s) : '—'}
        </span>
      )}
    </div>
  );
}

// How many site rows the Overview's "Site Health Breakdown" panel shows before
// the "Show all" toggle. The panel used to be a fixed 220px scroll box, which is
// 33px (header row) + 4.5 × 41px (row) — so with more sites than fit, the 5th
// row was sliced horizontally through the middle of its text by the panel's
// bottom edge, with no visible scrollbar to explain why. The panel now sizes to
// the rows it renders (never a partial row, whatever a row's real height turns
// out to be) and the toggle below reveals the rest.
const SITE_PREVIEW_ROWS = 5;

// Header-slot toggle for a panel that previews the first N of a longer list.
// Renders nothing when everything already fits. Top-level per the project's
// "no component inside a component" rule.
function ShowAllToggle({ total, preview, expanded, onToggle, noun }: {
  total: number; preview: number; expanded: boolean; onToggle: () => void; noun: string;
}) {
  if (total <= preview) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="sv-link-btn sm"
    >
      {expanded ? 'Show less' : `Showing ${preview} of ${total} ${noun} — show all`}
    </button>
  );
}

// ════════════════════════════════════════════════════════════════

const TAB_KEYS = TABS.map((t) => t.key) as readonly string[];

export default function IntelligencePage() {
  // ?tab= is the addressable form; the historical #anchor deep link
  // (/intelligence#anomalies, still used by the dashboard's anomaly banner and
  // by bookmarks) is honoured on mount and must keep working.
  const { tab, setTab, setTabState } = useUrlTab<string>('tab', TAB_KEYS, 'overview');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab')) return;
    const h = (window.location.hash || '').replace('#', '');
    if (h && TABS.some((t) => t.key === h)) setTabState(h);
  }, [setTabState]);

  return (
    <div>
      <PageHeader title="Network Intelligence" subtitle="Statistical analytics across your monitored network — baselines, anomalies, health, capacity, incidents." />

      <Tabs
        ariaLabel="Intelligence sections"
        sticky
        active={tab}
        onChange={setTab}
        tabs={TABS.map((t) => ({ key: t.key, label: t.label }))}
      />

      {tab === 'overview' && <OverviewTab />}
      {tab === 'anomalies' && <AnomaliesTab />}
      {tab === 'patterns' && <PatternsTab />}
      {tab === 'health' && <HealthTab />}
      {tab === 'capacity' && <CapacityTab />}
      {tab === 'incidents' && <IncidentsTab />}
      {tab === 'thresholds' && <ThresholdsTab />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 1: OVERVIEW
// ════════════════════════════════════════════════════════════════
function OverviewTab() {
  const ov = useApi<Overview>('/api/intelligence/overview', REFRESH_MS);
  const d = ov.data;

  // One sort state per table on this tab. Declared above the early returns so
  // the hook order never changes between loading/loaded renders.
  const siteSort = useTableSort();
  const anomSort = useTableSort();
  const incSort = useTableSort();
  // Site Health Breakdown previews SITE_PREVIEW_ROWS rows; this reveals the rest.
  const [allSites, setAllSites] = useState(false);

  const siteRows = useMemo(() => sortRows(d?.sites || [], siteSort.sort, {
    site: (s) => s.site_name,
    score: (s) => s.score,
    grade: (s) => s.grade,
    trend: (s) => s.trend,
    devices: (s) => s.device_count,
    anomalies: (s) => s.anomaly_count,
  }), [d?.sites, siteSort.sort]);

  const anomalyRows = useMemo(() => sortRows(d?.recent_anomalies || [], anomSort.sort, {
    device: (a) => a.device_name,
    metric: (a) => a.metric,
    deviation: (a) => n(a.z_score),
    severity: (a) => a.severity,
    detected: (a) => a.detected_at,
  }), [d?.recent_anomalies, anomSort.sort]);

  const incidentRows = useMemo(() => sortRows(d?.recent_incidents || [], incSort.sort, {
    title: (i) => i.title,
    affected: (i) => i.affected_count,
    // Active incidents show their age instead of a duration — sort on the same
    // number the cell renders so the column stays self-consistent.
    duration: (i) => (i.status === 'active'
      ? (Date.now() - Date.parse(i.started_at)) / 1000
      : i.duration_seconds),
  }), [d?.recent_incidents, incSort.sort]);

  if (ov.loading && !d) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <CardSkeleton count={3} height={75} />
      </div>
    );
  }
  if (ov.error) return <ErrorBox message={ov.error} />;
  if (!d) return <Empty message="No intelligence data yet." />;

  const score = d.overall_score;
  const coverage = d.data_coverage_days || 0;
  const scoreC = scoreColor(score);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── Row 1: 3 compact stat cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <StatCardCompact
          label="Network Health Score"
          value={score != null ? Math.round(score) : '—'}
          accent={scoreC}
          badge={<GradeBadge grade={d.overall_grade} />}
          hint={`${d.device_count} device${d.device_count === 1 ? '' : 's'} · ${coverage}d of data`}
          definition={<>
            A 0–100 score per monitored device, averaged across the fleet. Each device&apos;s score
            blends four components: uptime, response time against that device&apos;s own rolling
            baseline, anomaly count and alert volume. Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60,
            F below. It is <b>not</b> availability — a device answering every ping can score a D.
          </>}
        />
        <StatCardCompact
          label="Active Anomalies"
          value={d.active_anomalies}
          accent={d.active_anomalies > 0 ? 'var(--yellow)' : 'var(--green)'}
          hint="Metrics outside their own baseline"
          definition="A metric whose current value sits several standard deviations from that device's rolling baseline. An anomaly is a statistical deviation, not a fault — and not an alert: nothing is notified for one."
        />
        <StatCardCompact
          label="Active Incidents"
          value={d.active_incidents}
          accent={d.active_incidents > 0 ? 'var(--red)' : 'var(--green)'}
          hint="Correlated multi-device outages"
          definition="The narrow concept the correlation engine produces: several device-down alerts in the same window and blast radius, grouped into one event with a root cause. Most alerts never become an incident, so zero incidents does not mean zero problems."
        />
      </div>

      {/* Zero incidents beside live anomalies or alerts is exactly where an
          all-clear would be wrong — so the card points at the workbenches that
          DO have something in them, instead of reading as "nothing is wrong". */}
      {d.active_incidents === 0 && (d.active_anomalies > 0 || (d.sites || []).some((x) => (x.anomaly_count || 0) > 0)) && (
        <Notice tone="info">
          <span>
            No correlated multi-device incidents are open. That is a narrow statement:{' '}
            <Link href="/intelligence?tab=anomalies" style={{ color: 'inherit', fontWeight: 600 }}>
              {d.active_anomalies} anomal{d.active_anomalies === 1 ? 'y is' : 'ies are'} active
            </Link>{' '}
            and the{' '}
            <Link href="/alerts?status=active" style={{ color: 'inherit', fontWeight: 600 }}>alert queue</Link>{' '}
            may still have outstanding work.
          </span>
        </Notice>
      )}

      {/* ── Data coverage banner (slim, only if < 7 days) ── */}
      {coverage < 7 && (
        <div style={{
          fontSize: 'var(--text-sm)', padding: '7px 14px', borderRadius: 'var(--radius-sm)',
          background: 'rgba(217,119,6,0.10)', color: 'var(--yellow)', border: '1px solid rgba(217,119,6,0.25)',
        }}>
          ⚡ {coverage} day{coverage === 1 ? '' : 's'} of data collected — baselines reliable after 7 days, patterns after 30 days.
        </div>
      )}

      {/* ── Row 2: Site Health (55) + At-Risk Devices (45) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '55fr 45fr', gap: 12, alignItems: 'stretch' }}>
        <SectionCard
          title="Site Health Breakdown"
          action={
            <ShowAllToggle
              total={siteRows.length} preview={SITE_PREVIEW_ROWS} expanded={allSites}
              onToggle={() => setAllSites((v) => !v)} noun="sites"
            />
          }
        >
          {!d.sites.length ? (
            <Empty message="No site health computed yet." />
          ) : (
            // No max-height: the panel is sized by the rows it renders, so a row
            // can never be cut in half by the panel's bottom edge (see
            // SITE_PREVIEW_ROWS).
            <div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <SortTh label="Site" col="site" sort={siteSort.sort} onSort={siteSort.onSort} style={TH_STYLE} />
                    <SortTh label="Score" col="score" sort={siteSort.sort} onSort={siteSort.onSort} style={TH_STYLE} />
                    <SortTh label="Grade" col="grade" sort={siteSort.sort} onSort={siteSort.onSort} style={TH_STYLE} />
                    <SortTh label="Trend" col="trend" sort={siteSort.sort} onSort={siteSort.onSort} style={TH_STYLE} />
                    <SortTh label="Devices" col="devices" sort={siteSort.sort} onSort={siteSort.onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                    <SortTh label="Anomalies" col="anomalies" sort={siteSort.sort} onSort={siteSort.onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                  </tr>
                </thead>
                <tbody>
                  {(allSites ? siteRows : siteRows.slice(0, SITE_PREVIEW_ROWS)).map((s) => (
                    <tr key={`${s.site_id}-${s.site_name}`} style={ROW_STYLE}>
                      <IntelTD>{s.site_id ? <Link href={`/sites/${s.site_id}`}>{s.site_name}</Link> : s.site_name}</IntelTD>
                      <IntelTD><ScoreMiniBar score={s.score} width={60} /></IntelTD>
                      <IntelTD><GradeBadge grade={s.grade} /></IntelTD>
                      <IntelTD><TrendArrow trend={s.trend} /></IntelTD>
                      <IntelTD right>{s.device_count}</IntelTD>
                      <IntelTD right style={{ color: s.anomaly_count > 0 ? 'var(--yellow)' : 'var(--text-muted)' }}>{s.anomaly_count}</IntelTD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="At-Risk Devices">
          {!d.at_risk_devices.length ? (
            <Empty message="No device health scores yet." />
          ) : (
            // Same rule as Site Health above: sized by its rows (the API already
            // caps this list at 5), never a clipped partial row. The two panels
            // stay the same height because the grid row stretches both cards.
            <div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {d.at_risk_devices.slice(0, SITE_PREVIEW_ROWS).map((dev) => (
                    <tr key={dev.id} style={ROW_STYLE}>
                      <IntelTD style={{ width: 18 }}><StatusDot status={dev.current_status} size={10} /></IntelTD>
                      <IntelTD><Link href={`/devices/${dev.id}`} style={{ fontWeight: 600 }}>{dev.name}</Link></IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }}>{dev.site_name || 'Unassigned'}</IntelTD>
                      <IntelTD><ScoreMiniBar score={dev.score} width={60} /></IntelTD>
                      <IntelTD><GradeBadge grade={dev.grade} /></IntelTD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── Row 3: Active Anomalies (50) + Active Incidents (50) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'stretch' }}>
        <SectionCard
          title="Active Anomalies"
          action={<span className="sv-badge warning">{d.active_anomalies}</span>}
        >
          {!d.recent_anomalies.length ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '4px 0' }}>No active anomalies ✓</div>
          ) : (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <SortTh label="Device" col="device" sort={anomSort.sort} onSort={anomSort.onSort} style={TH_STYLE} />
                    <SortTh label="Metric" col="metric" sort={anomSort.sort} onSort={anomSort.onSort} style={TH_STYLE} />
                    <SortTh label="Deviation" col="deviation" sort={anomSort.sort} onSort={anomSort.onSort} style={TH_STYLE} />
                    <SortTh label="Severity" col="severity" sort={anomSort.sort} onSort={anomSort.onSort} style={TH_STYLE} />
                    <SortTh label="Detected" col="detected" sort={anomSort.sort} onSort={anomSort.onSort} style={TH_STYLE} />
                  </tr>
                </thead>
                <tbody>
                  {anomalyRows.map((a) => (
                    <tr key={a.id} style={ROW_STYLE}>
                      <IntelTD><Link href={`/devices/${a.device_id}`} style={{ fontWeight: 600 }}>{a.device_name}</Link></IntelTD>
                      <IntelTD><MetricName metric={a.metric} /></IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }} title={deviationTooltip(a)}>{deviationLabel(a)}</IntelTD>
                      <IntelTD><StatusBadge status={a.severity} /></IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }} title={fmtTime(a.detected_at)}>{fmtRel(a.detected_at)}</IntelTD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Active Incidents"
          action={<span className={`sv-badge ${d.active_incidents > 0 ? 'down' : 'resolved'}`}>{d.active_incidents}</span>}
        >
          {!d.recent_incidents.length ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '4px 0' }}>No active incidents ✓</div>
          ) : (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <SortTh label="Title" col="title" sort={incSort.sort} onSort={incSort.onSort} style={TH_STYLE} />
                    <SortTh label="Affected" col="affected" sort={incSort.sort} onSort={incSort.onSort} style={TH_STYLE} />
                    <SortTh label="Duration" col="duration" sort={incSort.sort} onSort={incSort.onSort} style={TH_STYLE} />
                  </tr>
                </thead>
                <tbody>
                  {incidentRows.map((i) => (
                    <tr key={i.id} style={ROW_STYLE}>
                      <IntelTD>
                        <span style={{ color: 'var(--red)', marginRight: 6 }}>●</span>
                        <span style={{ fontWeight: 600 }}>{i.title}</span>
                      </IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }}>{i.affected_count} dev{i.affected_count === 1 ? '' : 's'}</IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }} title={fmtTime(i.started_at)}>
                        {i.status === 'active' ? `${fmtRel(i.started_at)}` : fmtDuration(i.duration_seconds)}
                      </IntelTD>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

// ── Shared compact-table cells (top-level helpers) ──────────────
const ROW_STYLE: React.CSSProperties = { height: 36 };
const TH_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600,
  letterSpacing: '0.06em', padding: '8px 12px', textAlign: 'left', whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
  background: 'var(--bg-card)', zIndex: 5,
};
const TD_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-sm)', color: 'var(--text-primary)', padding: '8px 12px',
  borderBottom: '1px solid var(--border-light)', verticalAlign: 'middle',
};

function IntelTD({ children, right, style, title }: {
  children: React.ReactNode; right?: boolean; style?: React.CSSProperties; title?: string;
}) {
  return (
    <td title={title} style={{ ...TD_STYLE, ...(right ? { textAlign: 'right' } : null), ...style }}>{children}</td>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 2: ANOMALIES
// ════════════════════════════════════════════════════════════════
// Human-review statuses an operator can set on an anomaly. 'active' is the
// engine state; the rest are review states mirrored from the PATCH endpoint's
// ANOMALY_REVIEW_STATUSES. The colour maps each to an existing status badge tone.
const ANOMALY_STATUS_META: Record<string, { label: string; badge: string }> = {
  active: { label: 'Active', badge: 'active' },
  reviewed: { label: 'Reviewed', badge: 'resolved' },
  suppressed: { label: 'Suppressed', badge: 'unknown' },
  escalated: { label: 'Escalated', badge: 'down' },
  resolved: { label: 'Resolved', badge: 'resolved' },
};
const ANOMALY_FILTERS = ['active', 'reviewed', 'escalated', 'suppressed', 'all'] as const;
// Must match the API's own default/ceiling in /api/intelligence/anomalies.
const DEFAULT_ANOMALY_LIMIT = 200;
const MAX_ANOMALY_LIMIT = 2000;

/** Read a result-set total the API reports out of band. Null when absent/unparseable. */
function headerCount(h: Headers | null | undefined): number | null {
  const raw = h?.get('X-Total-Count');
  if (raw == null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function AnomalyStatusBadge({ status }: { status: string }) {
  const m = ANOMALY_STATUS_META[(status || '').toLowerCase()] || { label: status || '—', badge: 'resolved' };
  return <span className={`sv-badge ${m.badge}`}>{m.label}</span>;
}

function AnomaliesTab() {
  const { canEdit } = useRbac();
  const [filter, setFilter] = useState<(typeof ANOMALY_FILTERS)[number]>('active');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The list is server-capped. Default 200 (unchanged), raisable on demand so a
  // full history is reachable without making every page load scan the table.
  const [limit, setLimit] = useState(DEFAULT_ANOMALY_LIMIT);
  const path = `/api/intelligence/anomalies?limit=${limit}${filter === 'all' ? '' : `&status=${filter}`}`;
  const api = useApi<AnomalyRow[]>(path, REFRESH_MS);
  // Count-only companion request: the "N active" badge used to count actives
  // within the loaded page, so under the "All" filter it reported a fraction of
  // the real number. limit=1 makes this a count query with one throwaway row.
  const activeApi = useApi<AnomalyRow[]>('/api/intelligence/anomalies?status=active&limit=1', REFRESH_MS);
  const { sort, onSort } = useTableSort();

  // A filter change resets the window — "show all" on one status shouldn't
  // silently carry a 2000-row fetch over to the next.
  useEffect(() => { setLimit(DEFAULT_ANOMALY_LIMIT); }, [filter]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(
    () => (api.data || []).filter((a) => !q || a.device_name.toLowerCase().includes(q.toLowerCase())),
    [api.data, q],
  );
  // Sort is applied on top of the status chips + device search, never instead of them.
  const rows = useMemo(() => sortRows(filtered, sort, {
    device: (a) => a.device_name,
    site: (a) => a.site_name,
    metric: (a) => a.metric,
    current: (a) => n(a.value),
    baseline: (a) => n(a.baseline_mean),
    deviation: (a) => n(a.z_score),
    severity: (a) => a.severity,
    detected: (a) => a.detected_at,
    status: (a) => a.status,
  }), [filtered, sort]);

  const activeCount = headerCount(activeApi.headers);
  // How many rows the server actually holds for this filter vs how many it sent.
  const total = headerCount(api.headers);
  const loaded = (api.data || []).length;
  const truncated = total != null && loaded < total;

  async function setStatus(a: AnomalyRow, status: string) {
    setBusy(a.id);
    try {
      await apiSend(`/api/intelligence/anomalies/${a.id}`, 'PATCH', { status });
      setToast(`Anomaly on ${a.device_name} marked ${status}`);
      api.reload();
    } catch (e: any) {
      setToast(e?.message || 'Failed to update anomaly');
    } finally {
      setBusy(null);
    }
  }

  async function createRule(a: AnomalyRow) {
    setBusy(a.id);
    try {
      const r = await apiSend<{ rule: { id: number; threshold: number } }>(
        `/api/intelligence/anomalies/${a.id}/create-rule`, 'POST', {});
      setToast(`Alert rule created for ${a.device_name} (${a.metric} > ${Math.round(Number(r.rule.threshold))})`);
    } catch (e: any) {
      setToast(e?.message || 'Failed to create alert rule');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}

      {/* Compact filter bar — single row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {ANOMALY_FILTERS.map((f) => (
          <button key={f} className={`sv-chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        {activeCount != null && (
          <span className="sv-badge warning" style={{ marginLeft: 2 }}>{activeCount} active</span>
        )}
        <input className="sv-input" placeholder="Filter by device…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ marginLeft: 'auto', minWidth: 160, maxWidth: 280, height: 32, padding: '0 12px' }} />
      </div>

      {/* Never present a capped page as if it were the whole set. */}
      {truncated && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: 'var(--tint-info)', color: 'var(--tint-info-fg)',
          border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 12px', fontSize: 'var(--text-sm)',
        }}>
          <span>
            Showing the {loaded.toLocaleString()} most recent of {total!.toLocaleString()} anomalies
            {filter !== 'all' ? ` in "${filter}"` : ''}.
            {/* Once the cap is reached the remainder is not loadable here at all,
                so say why rather than leaving a dead "Load 2,000 (max)" button
                sitting next to a list that already holds 2,000. */}
            {limit >= MAX_ANOMALY_LIMIT && ` ${MAX_ANOMALY_LIMIT.toLocaleString()} is the most this view loads — narrow by status or device to see the rest.`}
          </span>
          {limit < MAX_ANOMALY_LIMIT && (
            <button
              className="sv-btn ghost sm"
              onClick={() => setLimit(Math.min(MAX_ANOMALY_LIMIT, total!))}
            >
              {total! > MAX_ANOMALY_LIMIT
                ? `Load ${MAX_ANOMALY_LIMIT.toLocaleString()} (max)`
                : `Load all ${total!.toLocaleString()}`}
            </button>
          )}
        </div>
      )}

      <SectionCard title="Anomaly Detection &amp; Review" flush={rows.length > 0}>
        {api.loading && !api.data ? (
          <div style={{ padding: 16 }}><TableSkeleton rows={6} cols={9} /></div>
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No anomalies in this view — all devices behaving normally ✓" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <SortTh label="Device" col="device" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Site" col="site" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Metric" col="metric" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Current" col="current" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                  <SortTh label="Baseline" col="baseline" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                  <SortTh label="Deviation" col="deviation" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Severity" col="severity" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Detected" col="detected" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Status" col="status" sort={sort} onSort={onSort} style={TH_STYLE} />
                  {canEdit && <th style={{ ...TH_STYLE, textAlign: 'right' }}>Review</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const val = n(a.value);
                  const base = n(a.baseline_mean);
                  return (
                    <tr key={a.id} style={ROW_STYLE}>
                      <IntelTD><Link href={`/devices/${a.device_id}`}>{a.device_name}</Link></IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }}>{a.site_name || '—'}</IntelTD>
                      <IntelTD><MetricName metric={a.metric} /></IntelTD>
                      {/* Value and baseline carry the metric's unit, so a CPU
                          percentage and a response time are not both bare
                          numbers in the same column. */}
                      <IntelTD right style={{ fontWeight: 600 }}>{formatMetricValue(a.metric, val)}</IntelTD>
                      <IntelTD right style={{ color: 'var(--text-muted)' }}>{formatMetricValue(a.metric, base)}</IntelTD>
                      <IntelTD><span className={`sv-badge ${a.severity === 'critical' ? 'down' : 'warning'}`} title={deviationTooltip(a)}>{deviationLabel(a)}</span></IntelTD>
                      <IntelTD><SevTag sev={a.severity} /></IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }} title={fmtTime(a.detected_at)}>{fmtRel(a.detected_at)}</IntelTD>
                      <IntelTD><AnomalyStatusBadge status={a.status} /></IntelTD>
                      {canEdit && (
                        <IntelTD right>
                          <AnomalyActions
                            anomaly={a}
                            busy={busy === a.id}
                            onSetStatus={setStatus}
                            onCreateRule={createRule}
                          />
                        </IntelTD>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// Per-row anomaly review actions: a compact <select> to set the review status
// plus a one-click "create alert rule" button. Top-level component (never nested)
// per project rules. Only rendered for editors (RBAC-gated by the caller).
function AnomalyActions({ anomaly: a, busy, onSetStatus, onCreateRule }: {
  anomaly: AnomalyRow;
  busy: boolean;
  onSetStatus: (a: AnomalyRow, status: string) => void;
  onCreateRule: (a: AnomalyRow) => void;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
      <select
        className="sv-input"
        value=""
        disabled={busy}
        title="Set review status"
        onChange={(e) => { if (e.target.value) onSetStatus(a, e.target.value); }}
        style={{ height: 24, padding: '0 6px', fontSize: 'var(--text-sm)', width: 110 }}
      >
        <option value="">Set status…</option>
        <option value="reviewed">Reviewed</option>
        <option value="suppressed">Suppressed</option>
        <option value="escalated">Escalated</option>
        {a.status !== 'active' && <option value="active">Re-open (active)</option>}
      </select>
      <button
        className="sv-btn sm"
        style={{ height: 24, padding: '0 10px', fontSize: 'var(--text-sm)' }}
        disabled={busy}
        title="Create an alert rule pre-filled from this anomaly (device + metric + 3σ threshold)"
        onClick={() => onCreateRule(a)}
      >
        {busy ? <span className="sv-spinner-sm" /> : '+ Rule'}
      </button>
    </span>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB: PATTERNS — recurring behavioural patterns the engine has learned
// (~periodic spikes, weekday cycles). Read-only list; flush sticky table.
// ════════════════════════════════════════════════════════════════
function PatternsTab() {
  const [q, setQ] = useState('');
  const api = useApi<PatternRow[]>('/api/intelligence/patterns', REFRESH_MS);
  const { sort, onSort } = useTableSort();
  const filtered = useMemo(() => (api.data || []).filter((p) =>
    !q || p.device_name.toLowerCase().includes(q.toLowerCase()) || (p.metric || '').toLowerCase().includes(q.toLowerCase())),
    [api.data, q]);
  const rows = useMemo(() => sortRows(filtered, sort, {
    device: (p) => p.device_name,
    site: (p) => p.site_name,
    pattern: (p) => p.pattern_type,
    metric: (p) => p.metric,
    // "When" is a weekday/hour pair — fold it into one chronological-ish number
    // (weekday-less patterns land after the day-scoped ones).
    when: (p) => (p.day_of_week == null && p.hour_of_day == null
      ? null
      : (p.day_of_week ?? 7) * 24 + (p.hour_of_day ?? 0)),
    avg: (p) => n(p.avg_value),
    seen: (p) => p.occurrence_count,
    confidence: (p) => n(p.confidence),
  }), [filtered, sort]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', padding: '9px 14px',
        borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)',
        border: '1px solid var(--border)', borderLeft: '3px solid var(--primary)',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        {/* Copy tracks retention_raw_days (default 14d), not an aspirational 30 —
            raw samples are purged at that window, so that is all the engine sees. */}
        <span>
          Recurring time-of-day patterns in latency, CPU and memory, learned across the raw-history
          window (default 14 days). A metric qualifies only if it runs well above its own baseline
          <em> and</em> reaches a level worth acting on — a switch idling at 2% CPU rising to 6% is
          not a finding. <b>Confidence</b> is the share of observed days on which the metric was
          actually elevated in that hour: 8 of 14 days reads 57%. <b>Re-confirmed</b> is how many
          analysis passes have re-observed the pattern since it was first detected — a measure of
          how long it has persisted, not a count of occurrences.
        </span>
        <input className="sv-input" placeholder="Filter by device or metric…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ marginLeft: 'auto', minWidth: 160, maxWidth: 280, height: 32, padding: '0 12px' }} />
      </div>

      <SectionCard title="Detected Patterns" flush={rows.length > 0}>
        {api.loading && !api.data ? (
          <div style={{ padding: 16 }}><TableSkeleton rows={6} cols={7} /></div>
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No recurring patterns detected — a metric has to run 50% above its own baseline in the same hour on several separate days, and reach a level worth acting on (25% CPU/memory, 20ms latency), to qualify. A quiet estate legitimately has none." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <SortTh label="Device" col="device" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Site" col="site" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Pattern" col="pattern" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Metric" col="metric" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="When" col="when" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Avg vs Baseline" col="avg" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                  {/* NOT "how many days this happened". `occurrence_count` is
                      incremented once per detection pass that re-observed the
                      pattern (upsertPattern in api/intelligence.js), so on a
                      5-minute engine cycle "198" is a measure of how long the
                      pattern has persisted, not of 198 occurrences. The column
                      now says what the number is. Occurrence-per-day lives in
                      Confidence, which IS elevated_days / observed_days. */}
                  <SortTh label="Re-confirmed" col="seen" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                  <SortTh label="Confidence" col="confidence" sort={sort} onSort={onSort} style={TH_STYLE} />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const avg = n(p.avg_value);
                  const base = n(p.baseline_value);
                  return (
                    <tr key={p.id} style={ROW_STYLE}>
                      <IntelTD><Link href={`/devices/${p.device_id}`}>{p.device_name}</Link></IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }}>{p.site_name || '—'}</IntelTD>
                      <IntelTD title={p.description}>
                        <span className="sv-badge" style={{ textTransform: 'capitalize' }}>{(p.pattern_type || '').replace(/_/g, ' ') || '—'}</span>
                      </IntelTD>
                      <IntelTD><MetricName metric={p.metric} /></IntelTD>
                      <IntelTD style={{ color: 'var(--text-secondary)' }}>{patternWhen(p)}</IntelTD>
                      <IntelTD right>
                        <span style={{ fontWeight: 600 }}>{avg != null ? avg.toFixed(1) : '—'}</span>
                        <span style={{ color: 'var(--text-muted)' }}> / {base != null ? base.toFixed(1) : '—'}</span>
                      </IntelTD>
                      <IntelTD right style={{ color: 'var(--text-muted)' }}
                        title={`The detector has re-observed this pattern ${p.occurrence_count} time${p.occurrence_count === 1 ? '' : 's'} since it was first detected ${fmtRel(p.detected_at)}. It is not a count of occurrences or of days.`}>
                        {p.occurrence_count.toLocaleString()}×
                      </IntelTD>
                      <IntelTD>
                        <ConfidenceStars confidence={p.confidence} denominator="the share of observed days on which the metric was actually elevated in this hour" />
                      </IntelTD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 3: HEALTH
// ════════════════════════════════════════════════════════════════
function HealthTab() {
  const api = useApi<HealthRow[]>('/api/intelligence/health', REFRESH_MS);
  const { sort, onSort } = useTableSort();
  const rows = useMemo(() => sortRows(api.data || [], sort, {
    type: (r) => (r.kind === 'service' ? 'Service' : 'Device'),
    name: (r) => r.name,
    site: (r) => r.site_name,
    score: (r) => n(r.score),
    grade: (r) => r.grade,
    uptime: (r) => n(r.uptime_pct),
    response: (r) => n(r.response_score),
    // Services carry no anomaly component (the cell renders "—"), so leave
    // theirs empty and let sortRows park them last in both directions.
    anomalies: (r) => (r.kind === 'service' ? null : r.anomalies_7d),
    alerts: (r) => r.alerts_7d,
    trend: (r) => r.trend,
  }), [api.data, sort]);

  return (
    <SectionCard title="Health Scores" flush={rows.length > 0}>
      {api.loading && !api.data ? (
        <div style={{ padding: 16 }}><TableSkeleton rows={8} cols={10} /></div>
      ) : api.error ? (
        <ErrorBox message={api.error} />
      ) : !rows.length ? (
        <Empty message="Collecting baseline data — health scores appear once devices/services have monitoring history." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <SortTh label="Type" col="type" sort={sort} onSort={onSort} style={TH_STYLE} />
                <SortTh label="Name" col="name" sort={sort} onSort={onSort} style={TH_STYLE} />
                <SortTh label="Site" col="site" sort={sort} onSort={onSort} style={TH_STYLE} />
                <SortTh label="Score" col="score" sort={sort} onSort={onSort} style={TH_STYLE} />
                <SortTh label="Grade" col="grade" sort={sort} onSort={onSort} style={TH_STYLE} />
                <SortTh label="Uptime" col="uptime" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                <SortTh label="Response Trend" col="response" sort={sort} onSort={onSort} style={TH_STYLE} />
                <SortTh label="Anomalies 7d" col="anomalies" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                <SortTh label="Alerts 7d" col="alerts" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                <SortTh label="Trend" col="trend" sort={sort} onSort={onSort} style={TH_STYLE} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const up = n(r.uptime_pct);
                const respScore = n(r.response_score);
                const isService = r.kind === 'service';
                // Anomaly component doesn't apply to services (see
                // computeServiceHealthScores) — say so instead of showing a
                // misleading "20/20" that looks like a measured anomaly-free result.
                const breakdown =
                  `Uptime: ${Math.round(n(r.uptime_score) ?? 0)}/40\n` +
                  `Response: ${Math.round(n(r.response_score) ?? 0)}/20\n` +
                  `Anomaly: ${isService ? 'n/a (services)' : `${Math.round(n(r.anomaly_score) ?? 0)}/20`}\n` +
                  `Alert: ${Math.round(n(r.alert_score) ?? 0)}/20`;
                return (
                  <tr key={`${r.kind}-${r.id}`} style={ROW_STYLE}>
                    <IntelTD>
                      <span className="sv-type-badge">{isService ? 'Service' : 'Device'}</span>
                    </IntelTD>
                    <IntelTD>
                      <Link href={isService ? `/services/${r.id}` : `/devices/${r.id}`}>{r.name}</Link>
                    </IntelTD>
                    <IntelTD style={{ color: 'var(--text-muted)' }}>{r.site_name || '—'}</IntelTD>
                    <IntelTD title={breakdown}><ScoreMiniBar score={r.score} width={80} height={6} /></IntelTD>
                    <IntelTD><GradeBadge grade={r.grade} /></IntelTD>
                    <IntelTD right>{up != null ? `${up.toFixed(1)}%` : '—'}</IntelTD>
                    <IntelTD>
                      {respScore != null
                        ? <span style={{ color: respScore >= 15 ? 'var(--green)' : respScore >= 10 ? 'var(--yellow)' : 'var(--red)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{Math.round(respScore)}/20</span>
                        : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </IntelTD>
                    <IntelTD right style={{ color: isService ? 'var(--text-muted)' : (r.anomalies_7d > 0 ? 'var(--yellow)' : 'var(--text-muted)') }}>
                      {isService ? '—' : r.anomalies_7d}
                    </IntelTD>
                    <IntelTD right style={{ color: r.alerts_7d > 0 ? 'var(--red)' : 'var(--text-muted)' }}>{r.alerts_7d}</IntelTD>
                    <IntelTD><TrendArrow trend={r.trend} /></IntelTD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 4: CAPACITY
// ════════════════════════════════════════════════════════════════
type DeviceLite = { id: number; name: string; snmp_enabled: boolean; site_name: string | null };
type Forecast = {
  device_id: number; enough_data: boolean; days_collected: number;
  peak_in_bps?: number; peak_out_bps?: number;
  trend_in?: string; trend_out?: string; weekly_growth_in?: number; weekly_growth_out?: number;
  history?: { day: string; in_bps: number; out_bps: number }[];
  forecasts?: { days: number; proj_in_bps: number; proj_out_bps: number }[];
};

function CapacityTab() {
  const devices = useApi<DeviceLite[]>('/api/devices', 0);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const fc = useApi<Forecast>(deviceId ? `/api/intelligence/capacity?device_id=${deviceId}` : null, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <select
          className="sv-input"
          value={deviceId ?? ''}
          onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : null)}
          style={{ minWidth: 280, height: 32, padding: '0 12px' }}
        >
          <option value="">Select a device…</option>
          {(devices.data || []).map((d) => (
            <option key={d.id} value={d.id}>{d.name}{d.site_name ? ` · ${d.site_name}` : ''}</option>
          ))}
        </select>
      </div>

      {!deviceId ? (
        <SectionCard title="Capacity Forecasting"><Empty message="Select a device to view its bandwidth capacity forecast." /></SectionCard>
      ) : fc.loading && !fc.data ? (
        <SectionCard title="Capacity Forecasting"><Loading label="Analyzing bandwidth trend…" /></SectionCard>
      ) : fc.error ? (
        <ErrorBox message={fc.error} />
      ) : fc.data && fc.data.enough_data ? (
        <CapacityResult fc={fc.data} />
      ) : fc.data && fc.data.days_collected === 0 ? (
        <SectionCard title="Capacity Forecasting"><Empty message="No bandwidth sensors configured for this device. Enable SNMP and run discovery to add interface sensors." /></SectionCard>
      ) : (
        <SectionCard title="Capacity Forecasting">
          <Empty message={`Need at least 7 days of SNMP bandwidth data for forecasting. Currently have ${fc.data?.days_collected ?? 0} day(s). Check back in ${Math.max(0, 7 - (fc.data?.days_collected ?? 0))} day(s).`} />
        </SectionCard>
      )}
    </div>
  );
}

/**
 * Status against the OBSERVED PEAK, not against link capacity.
 *
 * `monitored_devices` carries no interface speed, so nothing here knows what a
 * link can actually carry. Every ratio on this tab is "projected traffic vs
 * the busiest day we have recorded", which is a useful early warning and is
 * NOT capacity utilisation — a 95%-of-peak projection on a link running at 2%
 * of a 10G port means nothing is about to saturate. The labels say "of
 * observed peak" so the two can never be confused.
 */
function capacityStatus(projMax: number, peak: number): { label: string; color: string } {
  if (!peak || peak <= 0) return { label: 'No peak recorded', color: 'var(--text-muted)' };
  const ratio = projMax / peak;
  if (ratio >= 0.85) return { label: 'Above 85% of observed peak', color: 'var(--red)' };
  if (ratio >= 0.70) return { label: 'Approaching observed peak', color: 'var(--yellow)' };
  return { label: 'Below 70% of observed peak', color: 'var(--green)' };
}

function CapacityResult({ fc }: { fc: Forecast }) {
  const history = fc.history || [];
  const forecasts = fc.forecasts || [];
  const peakIn = fc.peak_in_bps || 0;
  const peakOut = fc.peak_out_bps || 0;
  const lastIn = history.length ? history[history.length - 1].in_bps : 0;
  const lastOut = history.length ? history[history.length - 1].out_bps : 0;

  // Build chart series: solid actual, dashed projected (bridged at the last actual point).
  const inSeries = buildSeries(history.map((h) => ({ label: dayLabel(h.day), v: h.in_bps })), forecasts.map((f) => ({ label: `+${f.days}d`, v: f.proj_in_bps })));
  const outSeries = buildSeries(history.map((h) => ({ label: dayLabel(h.day), v: h.out_bps })), forecasts.map((f) => ({ label: `+${f.days}d`, v: f.proj_out_bps })));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'stretch' }}>
        <ForecastChart title="Inbound (In)" data={inSeries} peak={peakIn} />
        <ForecastChart title="Outbound (Out)" data={outSeries} peak={peakOut} />
      </div>

      <SectionCard title="Forecast" style={{ padding: 0 }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH_STYLE}>Timeframe</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Projected inbound</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Projected outbound</th>
                {/* One "Growth" column showed inbound only while sitting beside
                    both projections — the two directions grow independently. */}
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>In growth</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Out growth</th>
                <th style={TH_STYLE}>Against observed peak</th>
              </tr>
            </thead>
            <tbody>
              {forecasts.map((f) => {
                const st = capacityStatus(Math.max(f.proj_in_bps / (peakIn || 1), f.proj_out_bps / (peakOut || 1)) * Math.max(peakIn, peakOut), Math.max(peakIn, peakOut));
                // Per-horizon projected growth of inbound vs the latest actual, so
                // each row reflects its own projection instead of repeating one rate.
                const inGrowth = lastIn > 0 ? ((f.proj_in_bps - lastIn) / lastIn) * 100 : null;
                const outGrowth = lastOut > 0 ? ((f.proj_out_bps - lastOut) / lastOut) * 100 : null;
                return (
                  <tr key={f.days} style={ROW_STYLE}>
                    <IntelTD>{f.days} days</IntelTD>
                    <IntelTD right>{fmtBps(f.proj_in_bps)}</IntelTD>
                    <IntelTD right>{fmtBps(f.proj_out_bps)}</IntelTD>
                    <IntelTD right style={{ color: (inGrowth ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)' }}
                      title={inGrowth != null && inGrowth < 0 ? 'Inbound traffic is trending DOWN — the projection is below the most recent day.' : undefined}>
                      {inGrowth == null ? '—' : `${inGrowth >= 0 ? '+' : ''}${inGrowth.toFixed(1)}%`}
                    </IntelTD>
                    <IntelTD right style={{ color: (outGrowth ?? 0) > 0 ? 'var(--yellow)' : 'var(--green)' }}
                      title={outGrowth != null && outGrowth < 0 ? 'Outbound traffic is trending DOWN — the projection is below the most recent day.' : undefined}>
                      {outGrowth == null ? '—' : `${outGrowth >= 0 ? '+' : ''}${outGrowth.toFixed(1)}%`}
                    </IntelTD>
                    <IntelTD style={{ color: st.color, fontWeight: 600 }}>{st.label}</IntelTD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ margin: '8px 20px 14px' }}>
          <div className="sv-defs" style={{ margin: 0 }}>
            <span><b>Coverage:</b> {fc.days_collected} day{fc.days_collected === 1 ? '' : 's'} of daily SNMP interface totals.</span>
            <span><b>Peak observed:</b> in {fmtBps(peakIn)} · out {fmtBps(peakOut)}.</span>
            <span><b>Method:</b> a linear trend fitted to those daily totals and extended forward. No seasonality, and no confidence interval — the data behind it does not support one, so none is shown.</span>
          </div>
          {/* The one thing this tab must never imply. */}
          <Notice tone="info">
            <span>
              Everything here is measured against the <b>busiest day recorded</b>, not against link
              capacity: SpanVault does not know these interfaces&apos; configured speeds. A projection
              at 95% of observed peak means traffic is returning to its own high-water mark — it does
              not mean the link is nearly full, and no exhaustion date is implied.
            </span>
          </Notice>
        </div>
      </SectionCard>
    </div>
  );
}

type SeriesPoint = { label: string; actual: number | null; projected: number | null };
function buildSeries(actual: { label: string; v: number }[], projected: { label: string; v: number }[]): SeriesPoint[] {
  const out: SeriesPoint[] = actual.map((a) => ({ label: a.label, actual: a.v, projected: null }));
  if (out.length) out[out.length - 1].projected = out[out.length - 1].actual; // bridge
  for (const p of projected) out.push({ label: p.label, actual: null, projected: p.v });
  return out;
}
function dayLabel(day: string): string {
  const d = new Date(day);
  if (isNaN(d.getTime())) return String(day);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ForecastChart({ title, data, peak }: { title: string; data: SeriesPoint[]; peak: number }) {
  return (
    <SectionCard title={title}>
      {!data.length ? (
        <Empty message="No data." />
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
            <defs>
              <linearGradient id={`g-${title}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" fontSize={11} minTickGap={28} />
            <YAxis fontSize={11} width={64} tickFormatter={(v) => fmtBps(Number(v))} />
            <Tooltip {...CHART_TOOLTIP} formatter={(v: any, name: any) => [v == null ? '—' : fmtBps(Number(v)), name === 'actual' ? 'Actual' : 'Projected']} />
            {/* Labelled "of peak" — an unlabelled 80%/95% line on a bandwidth
                chart reads as 80%/95% of the LINK, which this is not. */}
            {peak > 0 && <ReferenceLine y={peak * 0.8} stroke="#e6a700" strokeDasharray="4 4" label={{ value: '80% of peak', position: 'right', fontSize: 10, fill: '#e6a700' }} />}
            {peak > 0 && <ReferenceLine y={peak * 0.95} stroke="#C8102E" strokeDasharray="4 4" label={{ value: '95% of peak', position: 'right', fontSize: 10, fill: '#C8102E' }} />}
            <Area type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={2} fill={`url(#g-${title})`} connectNulls={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="projected" stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 4" fill="none" connectNulls isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </SectionCard>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 5: INCIDENTS
// ════════════════════════════════════════════════════════════════
function IncidentsTab() {
  const [filter, setFilter] = useState<{ key: string; label: string }>({ key: 'active', label: 'Active' });
  const FILTERS = [
    { key: 'active', label: 'Active' },
    { key: 'resolved', label: 'Resolved' },
    { key: '7d', label: 'Last 7d' },
    { key: '30d', label: 'Last 30d' },
  ];
  let path = '/api/intelligence/incidents?limit=50';
  if (filter.key === 'active' || filter.key === 'resolved') path += `&status=${filter.key}`;
  else if (filter.key === '7d') path += '&days=7';
  else if (filter.key === '30d') path += '&days=30';

  const api = useApi<IncidentRow[]>(path, REFRESH_MS);
  const { sort, onSort } = useTableSort();
  // Sorting sits on top of the Active/Resolved/7d/30d filter chips above.
  const rows = useMemo(() => sortRows(api.data || [], sort, {
    status: (i) => i.status,
    title: (i) => i.title,
    rootcause: (i) => i.root_cause_device_name,
    affected: (i) => i.affected_count,
    // Active incidents render "—" for duration; keep them empty so they park last.
    duration: (i) => (i.status === 'active' ? null : i.duration_seconds),
    time: (i) => i.started_at,
  }), [api.data, sort]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.key} className={`sv-chip ${filter.key === f.key ? 'active' : ''}`} onClick={() => setFilter(f)}>{f.label}</button>
        ))}
      </div>

      <SectionCard title="Incident Timeline" style={{ padding: rows.length ? 0 : '16px 20px' }}>
        {api.loading && !api.data ? (
          <div style={{ padding: 16 }}><TableSkeleton rows={4} cols={6} /></div>
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No incidents in the selected period. Incidents are created when multiple devices go down simultaneously." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <SortTh label="Status" col="status" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Title" col="title" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Root Cause" col="rootcause" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Affected" col="affected" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Duration" col="duration" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Time" col="time" sort={sort} onSort={onSort} style={TH_STYLE} />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => <IncidentRowItem key={i.id} incident={i} />)}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function IncidentRowItem({ incident: i }: { incident: IncidentRow }) {
  const [open, setOpen] = useState(false);
  const active = i.status === 'active';
  const timeline = Array.isArray(i.timeline) ? i.timeline : [];
  const expandable = timeline.length > 0 || (i.affected_devices && i.affected_devices.length > 0);

  return (
    <>
      <tr
        style={{ ...ROW_STYLE, cursor: expandable ? 'pointer' : 'default' }}
        onClick={() => expandable && setOpen((o) => !o)}
      >
        <IntelTD>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: active ? 'var(--red)' : 'var(--green)' }}>●</span>
            <span className={`sv-badge ${active ? 'active' : 'resolved'}`}>{active ? 'Active' : 'Resolved'}</span>
          </span>
        </IntelTD>
        <IntelTD>
          {expandable && <span style={{ color: 'var(--text-muted)', marginRight: 6, fontSize: 'var(--text-xs)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>}
          <strong>{i.title}</strong>
        </IntelTD>
        <IntelTD style={{ color: 'var(--text-muted)' }}>
          {i.root_cause_device_id
            ? <Link href={`/devices/${i.root_cause_device_id}`} onClick={(e) => e.stopPropagation()}>{i.root_cause_device_name || `#${i.root_cause_device_id}`}</Link>
            : (i.root_cause_device_name || '—')}
        </IntelTD>
        <IntelTD right>{i.affected_count}</IntelTD>
        <IntelTD style={{ color: 'var(--text-muted)' }}>{active ? '—' : fmtDuration(i.duration_seconds)}</IntelTD>
        <IntelTD style={{ color: 'var(--text-muted)' }} title={fmtTime(i.started_at)}>{fmtRel(i.started_at)}</IntelTD>
      </tr>
      {open && expandable && (
        <tr>
          <td colSpan={6} style={{ padding: '0 12px 10px 40px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-light)' }}>
            {timeline.length > 0 && (
              <div style={{ paddingTop: 8 }}>
                <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>Timeline</div>
                {timeline.map((t, idx) => (
                  <div key={idx} style={{ height: 28, display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtTime(t.ts)}</span>
                    <span>{t.device} {t.event}</span>
                  </div>
                ))}
              </div>
            )}
            {i.affected_devices && i.affected_devices.length > 0 && (
              <div style={{ paddingTop: 6, fontSize: 'var(--text-sm)' }}>
                <span style={{ color: 'var(--text-muted)' }}>Devices: </span>{i.affected_devices.join(', ')}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ════════════════════════════════════════════════════════════════
// TAB 6: THRESHOLDS
// ════════════════════════════════════════════════════════════════
function ThresholdsTab() {
  const { canEdit } = useRbac();
  const api = useApi<ThresholdRow[]>('/api/intelligence/thresholds', REFRESH_MS);
  const [busy, setBusy] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { confirm, ConfirmUI } = useConfirm();
  const { sort, onSort } = useTableSort();
  const rows = useMemo(() => sortRows(api.data || [], sort, {
    device: (r) => r.device_name,
    site: (r) => r.site_name,
    metric: (r) => r.metric,
    current: (r) => n(r.current_threshold),
    recommended: (r) => n(r.recommended_threshold),
    reasoning: (r) => r.reasoning,
    confidence: (r) => n(r.confidence),
  }), [api.data, sort]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  async function apply(r: ThresholdRow) {
    setBusy(r.device_id);
    try {
      await apiSend(`/api/intelligence/thresholds/${r.device_id}/apply`, 'POST', {});
      setToast(`Updated ${r.metric} threshold to ${formatMetricValue(r.metric, r.recommended_threshold)} for ${r.device_name}`);
      api.reload();
    } catch (e: any) {
      setToast(e?.message || 'Failed to apply');
    } finally {
      setBusy(null);
    }
  }

  // Apply All used to change every high-confidence threshold on the estate
  // with one click and no statement of what it was about to do. It now shows
  // the exact scope and the exact per-device change first, and reports partial
  // failures instead of abandoning the batch on the first error.
  async function applyAll() {
    const high = rows.filter((r) => (n(r.confidence) ?? 0) >= 0.7);
    if (!high.length) return;
    const preview = high.slice(0, 8)
      .map((r) => `• ${r.device_name} — ${r.metric}: ${formatMetricValue(r.metric, r.current_threshold)} → ${formatMetricValue(r.metric, r.recommended_threshold)}`)
      .join('\n');
    const ok = await confirm({
      title: `Apply ${high.length} threshold change${high.length === 1 ? '' : 's'}?`,
      message: (
        <>
          <p style={{ marginTop: 0 }}>
            This changes the alert threshold on <b>{high.length} device{high.length === 1 ? '' : 's'}</b>{' '}
            — every recommendation at 70% confidence or above. Devices below that are not touched.
            Each change is written to the audit log.
          </p>
          <pre style={{
            margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 'var(--text-sm)',
            fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)',
          }}>{preview}{high.length > 8 ? `\n…and ${high.length - 8} more` : ''}</pre>
        </>
      ),
      confirmLabel: `Apply ${high.length}`,
    });
    if (!ok) return;
    setBulkBusy(true);
    let done = 0;
    const failed: string[] = [];
    for (const r of high) {
      try {
        await apiSend(`/api/intelligence/thresholds/${r.device_id}/apply`, 'POST', {});
        done += 1;
        setBulkProgress({ done, total: high.length });
      } catch {
        failed.push(r.device_name);
      }
    }
    setBulkProgress(null);
    setToast(failed.length
      ? `Applied ${done} of ${high.length}. Failed for ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}.`
      : `Applied ${done} recommendation${done === 1 ? '' : 's'}.`);
    api.reload();
    setBulkBusy(false);
  }

  const highCount = rows.filter((r) => (n(r.confidence) ?? 0) >= 0.7).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {ConfirmUI}
      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}

      <div style={{
        fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', padding: '9px 14px',
        borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)',
        border: '1px solid var(--border)', borderLeft: '3px solid var(--primary)',
      }}>
        Recommendations compare each device&apos;s configured alert threshold against its own
        statistical baseline over a rolling <b>30-day</b> window — the suggested value is twice the
        observed 99th percentile. <b>Confidence</b> is how well that baseline is supported by the
        samples behind it. There is no &quot;how many alerts would this have prevented&quot;
        simulation: replaying historical alerts against a hypothetical threshold is not something
        the stored data supports, so none is offered.
      </div>

      <SectionCard
        title="Smart Threshold Advisor"
        style={{ padding: rows.length ? 0 : '16px 20px' }}
        action={canEdit && highCount > 0 ? (
          <button className="sv-btn sm" onClick={applyAll} disabled={bulkBusy}>
            {bulkBusy
              ? <><span className="sv-spinner-sm" /> Applying {bulkProgress ? `${bulkProgress.done} of ${bulkProgress.total}` : ''}…</>
              : `Review and apply ${highCount} high-confidence…`}
          </button>
        ) : undefined}
      >
        {api.loading && !api.data ? (
          <div style={{ padding: 16 }}><TableSkeleton rows={6} cols={8} /></div>
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="Analyzing device behavior… Recommendations appear after 7+ days of data collection." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <SortTh label="Device" col="device" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Site" col="site" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Metric" col="metric" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Current" col="current" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                  <SortTh label="Recommended" col="recommended" sort={sort} onSort={onSort} align="right" style={{ ...TH_STYLE, textAlign: 'right' }} />
                  <SortTh label="Why" col="reasoning" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <SortTh label="Confidence" col="confidence" sort={sort} onSort={onSort} style={TH_STYLE} />
                  <th style={TH_STYLE}>Apply</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={ROW_STYLE}>
                    <IntelTD><Link href={`/devices/${r.device_id}`}>{r.device_name}</Link></IntelTD>
                    <IntelTD style={{ color: 'var(--text-muted)' }}>{r.site_name || '—'}</IntelTD>
                    <IntelTD><MetricName metric={r.metric} /></IntelTD>
                    {/* The unit comes from the metric. It was hardcoded "ms",
                        which rendered a CPU-percentage threshold as "69ms". */}
                    <IntelTD right>{formatMetricValue(r.metric, r.current_threshold)}</IntelTD>
                    <IntelTD right style={{ fontWeight: 700, color: 'var(--primary)' }}>
                      {formatMetricValue(r.metric, r.recommended_threshold)}
                    </IntelTD>
                    {/* The reasoning IS the evidence — truncating it at 60
                        characters behind a hover made the one column that
                        justifies the change the least readable on the row. */}
                    <IntelTD style={{ maxWidth: 420 }}>
                      <span style={{ display: 'block', lineHeight: 1.45 }}>{r.reasoning}</span>
                    </IntelTD>
                    <IntelTD>
                      <ConfidenceStars confidence={r.confidence} denominator="how well the 30-day baseline is supported by its samples" />
                    </IntelTD>
                    <IntelTD>
                      {canEdit ? (
                        <button
                          className="sv-btn sm"
                          style={{ height: 24, padding: '0 10px', fontSize: 'var(--text-sm)' }}
                          onClick={() => apply(r)}
                          disabled={busy === r.device_id}
                        >
                          {busy === r.device_id ? <span className="sv-spinner-sm" /> : 'Apply'}
                        </button>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </IntelTD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

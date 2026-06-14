'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { StatusDot } from '@/components/StatusDot';
import {
  PageHeader, ErrorBox, Empty, Loading, TableSkeleton, CardSkeleton,
  StatusBadge, fmtRel, fmtTime, fmtBps,
} from '@/components/ui';
import {
  GradeBadge, TrendArrow, ConfidenceStars, fmtDuration, deviationLabel, deviationTooltip,
  scoreColor, n,
  Overview, HealthRow, AnomalyRow, IncidentRow, ThresholdRow,
} from '@/components/intel';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'anomalies', label: 'Anomalies' },
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
function StatCardCompact({ label, value, accent, badge, hint }: {
  label: string; value: React.ReactNode; accent: string; badge?: React.ReactNode; hint?: string;
}) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderLeft: `3px solid ${accent}`, borderRadius: 'var(--radius-sm)',
      padding: '12px 16px', minHeight: 75, display: 'flex', flexDirection: 'column',
      justifyContent: 'center', boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
        <span style={{ fontSize: 24, fontWeight: 800, lineHeight: 1, color: accent }}>{value}</span>
        {badge}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

// Section card — 16px 20px padding, --bg-card, 1px border, radius-sm.
function SectionCard({ title, action, children, style }: {
  title: string; action?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '16px 20px', minWidth: 0,
      display: 'flex', flexDirection: 'column', ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>{title}</span>
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
      <div style={{ width, height, borderRadius: 2, background: 'var(--border)', overflow: 'hidden', flex: 'none' }}>
        <div style={{ width: `${s != null ? Math.max(2, Math.min(100, s)) : 0}%`, height: '100%', background: c, borderRadius: 2 }} />
      </div>
      {showValue && (
        <span style={{ fontSize: 12, fontWeight: 700, color: c, minWidth: 24, textAlign: 'right' }}>
          {s != null ? Math.round(s) : '—'}
        </span>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════

export default function IntelligencePage() {
  const [tab, setTab] = useState('overview');

  // Honour deep links like /intelligence#anomalies (used by dashboard banner).
  useEffect(() => {
    const h = (window.location.hash || '').replace('#', '');
    if (h && TABS.some((t) => t.key === h)) setTab(h);
  }, []);

  return (
    <div>
      <PageHeader title="Network Intelligence" subtitle="Statistical analytics across your monitored network — baselines, anomalies, health, capacity, incidents." />

      <div className="sv-tabs sticky">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`sv-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => { setTab(t.key); try { history.replaceState(null, '', `#${t.key}`); } catch { /* ignore */ } }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'anomalies' && <AnomaliesTab />}
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
        />
        <StatCardCompact
          label="Active Anomalies"
          value={d.active_anomalies}
          accent={d.active_anomalies > 0 ? 'var(--yellow)' : 'var(--green)'}
          hint="Devices outside their baseline"
        />
        <StatCardCompact
          label="Active Incidents"
          value={d.active_incidents}
          accent={d.active_incidents > 0 ? 'var(--red)' : 'var(--green)'}
          hint="Correlated outage events"
        />
      </div>

      {/* ── Data coverage banner (slim, only if < 7 days) ── */}
      {coverage < 7 && (
        <div style={{
          fontSize: 12.5, padding: '7px 14px', borderRadius: 'var(--radius-sm)',
          background: 'rgba(217,119,6,0.10)', color: 'var(--yellow)', border: '1px solid rgba(217,119,6,0.25)',
        }}>
          ⚡ {coverage} day{coverage === 1 ? '' : 's'} of data collected — baselines reliable after 7 days, patterns after 30 days.
        </div>
      )}

      {/* ── Row 2: Site Health (55) + At-Risk Devices (45) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '55fr 45fr', gap: 12, alignItems: 'stretch' }}>
        <SectionCard title="Site Health Breakdown">
          {!d.sites.length ? (
            <Empty message="No site health computed yet." />
          ) : (
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <IntelTH cols={['Site', 'Score', 'Grade', 'Trend']} rightCols={['Devices', 'Anomalies']} />
                </thead>
                <tbody>
                  {d.sites.map((s) => (
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
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {d.at_risk_devices.slice(0, 5).map((dev) => (
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
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '4px 0' }}>No active anomalies ✓</div>
          ) : (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <IntelTH cols={['Device', 'Metric', 'Deviation', 'Severity', 'Detected']} />
                </thead>
                <tbody>
                  {d.recent_anomalies.map((a) => (
                    <tr key={a.id} style={ROW_STYLE}>
                      <IntelTD><Link href={`/devices/${a.device_id}`} style={{ fontWeight: 600 }}>{a.device_name}</Link></IntelTD>
                      <IntelTD>{a.metric}</IntelTD>
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
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '4px 0' }}>No active incidents ✓</div>
          ) : (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <IntelTH cols={['Title', 'Affected', 'Duration']} />
                </thead>
                <tbody>
                  {d.recent_incidents.map((i) => (
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
  fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600,
  letterSpacing: '0.06em', padding: '8px 12px', textAlign: 'left', whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
  background: 'var(--bg-card)', zIndex: 1,
};
const TD_STYLE: React.CSSProperties = {
  fontSize: 12.5, color: 'var(--text-primary)', padding: '8px 12px',
  borderBottom: '1px solid var(--border-light)', verticalAlign: 'middle',
};

function IntelTH({ cols, rightCols = [] }: { cols: string[]; rightCols?: string[] }) {
  return (
    <tr>
      {cols.map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}
      {rightCols.map((c) => <th key={c} style={{ ...TH_STYLE, textAlign: 'right' }}>{c}</th>)}
    </tr>
  );
}

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
function AnomaliesTab() {
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('active');
  const [q, setQ] = useState('');
  const path = filter === 'all' ? '/api/intelligence/anomalies' : `/api/intelligence/anomalies?status=${filter}`;
  const api = useApi<AnomalyRow[]>(path, REFRESH_MS);

  const rows = (api.data || []).filter((a) => !q || a.device_name.toLowerCase().includes(q.toLowerCase()));
  const activeCount = (api.data || []).filter((a) => a.status === 'active').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Compact filter bar — single row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['all', 'active', 'resolved'] as const).map((f) => (
          <button key={f} className={`sv-chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        {filter !== 'resolved' && <span className="sv-badge warning" style={{ marginLeft: 2 }}>{activeCount} active</span>}
        <input className="sv-input" placeholder="Filter by device…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ marginLeft: 'auto', minWidth: 160, maxWidth: 280, height: 32, padding: '0 12px' }} />
      </div>

      <SectionCard title="Anomaly Detection" style={{ padding: rows.length ? '0' : '16px 20px' }}>
        {api.loading && !api.data ? (
          <div style={{ padding: 16 }}><TableSkeleton rows={6} cols={9} /></div>
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No anomalies detected — all devices behaving normally ✓" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Device', 'Site', 'Metric'].map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Current</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Baseline</th>
                  {['Deviation', 'Severity', 'Detected', 'Status'].map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}
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
                      <IntelTD>{a.metric}</IntelTD>
                      <IntelTD right style={{ fontWeight: 600 }}>{val != null ? val.toFixed(1) : '—'}</IntelTD>
                      <IntelTD right style={{ color: 'var(--text-muted)' }}>{base != null ? base.toFixed(1) : '—'}</IntelTD>
                      <IntelTD><span className={`sv-badge ${a.severity === 'critical' ? 'down' : 'warning'}`} title={deviationTooltip(a)}>{deviationLabel(a)}</span></IntelTD>
                      <IntelTD><StatusBadge status={a.severity} /></IntelTD>
                      <IntelTD style={{ color: 'var(--text-muted)' }} title={fmtTime(a.detected_at)}>{fmtRel(a.detected_at)}</IntelTD>
                      <IntelTD>{a.status === 'active'
                        ? <span className="sv-badge active">Active</span>
                        : <span className="sv-badge resolved">Resolved</span>}</IntelTD>
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
  const rows = api.data || [];

  return (
    <SectionCard title="Device Health Scores" style={{ padding: rows.length ? '0' : '16px 20px' }}>
      {api.loading && !api.data ? (
        <div style={{ padding: 16 }}><TableSkeleton rows={8} cols={9} /></div>
      ) : api.error ? (
        <ErrorBox message={api.error} />
      ) : !rows.length ? (
        <Empty message="Collecting baseline data — health scores appear once devices have monitoring history." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Device', 'Site', 'Score', 'Grade'].map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Uptime</th>
                {['Response Trend'].map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Anomalies 7d</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Alerts 7d</th>
                <th style={TH_STYLE}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const up = n(r.uptime_pct);
                const respScore = n(r.response_score);
                const breakdown =
                  `Uptime: ${Math.round(n(r.uptime_score) ?? 0)}/40\n` +
                  `Response: ${Math.round(n(r.response_score) ?? 0)}/20\n` +
                  `Anomaly: ${Math.round(n(r.anomaly_score) ?? 0)}/20\n` +
                  `Alert: ${Math.round(n(r.alert_score) ?? 0)}/20`;
                return (
                  <tr key={r.id} style={ROW_STYLE}>
                    <IntelTD><Link href={`/devices/${r.id}`}>{r.name}</Link></IntelTD>
                    <IntelTD style={{ color: 'var(--text-muted)' }}>{r.site_name || '—'}</IntelTD>
                    <IntelTD title={breakdown}><ScoreMiniBar score={r.score} width={80} height={6} /></IntelTD>
                    <IntelTD><GradeBadge grade={r.grade} /></IntelTD>
                    <IntelTD right>{up != null ? `${up.toFixed(1)}%` : '—'}</IntelTD>
                    <IntelTD>
                      {respScore != null
                        ? <span style={{ color: respScore >= 15 ? 'var(--green)' : respScore >= 10 ? 'var(--yellow)' : 'var(--red)', fontWeight: 600, fontSize: 12 }}>{Math.round(respScore)}/20</span>
                        : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </IntelTD>
                    <IntelTD right style={{ color: r.anomalies_7d > 0 ? 'var(--yellow)' : 'var(--text-muted)' }}>{r.anomalies_7d}</IntelTD>
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

function capacityStatus(projMax: number, peak: number): { label: string; color: string } {
  if (!peak || peak <= 0) return { label: 'OK', color: 'var(--green)' };
  const ratio = projMax / peak;
  if (ratio >= 0.85) return { label: '⚠ Plan upgrade', color: 'var(--red)' };
  if (ratio >= 0.70) return { label: 'Monitor', color: 'var(--yellow)' };
  return { label: 'OK', color: 'var(--green)' };
}

function CapacityResult({ fc }: { fc: Forecast }) {
  const history = fc.history || [];
  const forecasts = fc.forecasts || [];
  const peakIn = fc.peak_in_bps || 0;
  const peakOut = fc.peak_out_bps || 0;
  const lastIn = history.length ? history[history.length - 1].in_bps : 0;

  // Build chart series: solid actual, dashed projected (bridged at the last actual point).
  const inSeries = buildSeries(history.map((h) => ({ label: dayLabel(h.day), v: h.in_bps })), forecasts.map((f) => ({ label: `+${f.days}d`, v: f.proj_in_bps })));
  const outSeries = buildSeries(history.map((h) => ({ label: dayLabel(h.day), v: h.out_bps })), forecasts.map((f) => ({ label: `+${f.days}d`, v: f.proj_out_bps })));

  const growthInPct = lastIn > 0 ? ((fc.weekly_growth_in || 0) / lastIn) * 100 : 0;

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
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Proj In</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Proj Out</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Growth</th>
                <th style={TH_STYLE}>Status</th>
              </tr>
            </thead>
            <tbody>
              {forecasts.map((f) => {
                const st = capacityStatus(Math.max(f.proj_in_bps / (peakIn || 1), f.proj_out_bps / (peakOut || 1)) * Math.max(peakIn, peakOut), Math.max(peakIn, peakOut));
                return (
                  <tr key={f.days} style={ROW_STYLE}>
                    <IntelTD>{f.days} days</IntelTD>
                    <IntelTD right>{fmtBps(f.proj_in_bps)}</IntelTD>
                    <IntelTD right>{fmtBps(f.proj_out_bps)}</IntelTD>
                    <IntelTD right style={{ color: growthInPct > 0 ? 'var(--yellow)' : 'var(--green)' }}>
                      {growthInPct >= 0 ? '+' : ''}{growthInPct.toFixed(1)}%/wk
                    </IntelTD>
                    <IntelTD style={{ color: st.color, fontWeight: 600 }}>{st.label}</IntelTD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '8px 20px 12px' }}>
          Based on {fc.days_collected} days of data. Peak observed: In {fmtBps(peakIn)} · Out {fmtBps(peakOut)}.
          Reference lines mark 80% and 95% of peak.
        </p>
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
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
            <XAxis dataKey="label" fontSize={11} minTickGap={28} />
            <YAxis fontSize={11} width={64} tickFormatter={(v) => fmtBps(Number(v))} />
            <Tooltip formatter={(v: any, name: any) => [v == null ? '—' : fmtBps(Number(v)), name === 'actual' ? 'Actual' : 'Projected']} />
            {peak > 0 && <ReferenceLine y={peak * 0.8} stroke="#e6a700" strokeDasharray="4 4" label={{ value: '80%', position: 'right', fontSize: 10, fill: '#e6a700' }} />}
            {peak > 0 && <ReferenceLine y={peak * 0.95} stroke="#C8102E" strokeDasharray="4 4" label={{ value: '95%', position: 'right', fontSize: 10, fill: '#C8102E' }} />}
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
  const rows = api.data || [];

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
                <IntelTH cols={['Status', 'Title', 'Root Cause', 'Affected', 'Duration', 'Time']} />
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
          {expandable && <span style={{ color: 'var(--text-muted)', marginRight: 6, fontSize: 10, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>}
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
                <div style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 4 }}>Timeline</div>
                {timeline.map((t, idx) => (
                  <div key={idx} style={{ height: 28, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtTime(t.ts)}</span>
                    <span>{t.device} {t.event}</span>
                  </div>
                ))}
              </div>
            )}
            {i.affected_devices && i.affected_devices.length > 0 && (
              <div style={{ paddingTop: 6, fontSize: 12 }}>
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
  const [toast, setToast] = useState<string | null>(null);
  const rows = api.data || [];

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  async function apply(r: ThresholdRow) {
    setBusy(r.device_id);
    try {
      await apiSend(`/api/intelligence/thresholds/${r.device_id}/apply`, 'POST', {});
      setToast(`Updated threshold to ${Math.round(Number(r.recommended_threshold))}ms for ${r.device_name}`);
      api.reload();
    } catch (e: any) {
      setToast(e?.message || 'Failed to apply');
    } finally {
      setBusy(null);
    }
  }

  async function applyAll() {
    const high = rows.filter((r) => (n(r.confidence) ?? 0) >= 0.7);
    if (!high.length) return;
    setBulkBusy(true);
    try {
      for (const r of high) {
        await apiSend(`/api/intelligence/thresholds/${r.device_id}/apply`, 'POST', {});
      }
      setToast(`Applied ${high.length} high-confidence recommendation${high.length === 1 ? '' : 's'}`);
      api.reload();
    } catch (e: any) {
      setToast(e?.message || 'Bulk apply failed');
    } finally {
      setBulkBusy(false);
    }
  }

  const highCount = rows.filter((r) => (n(r.confidence) ?? 0) >= 0.7).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}

      <div style={{
        fontSize: 12.5, color: 'var(--text-secondary)', padding: '9px 14px',
        borderRadius: 'var(--radius-sm)', background: 'var(--bg-card)',
        border: '1px solid var(--border)', borderLeft: '3px solid var(--primary)',
      }}>
        Recommendations based on each device&apos;s actual behavior over the last 30 days — current thresholds compared against statistical baselines (2× p99).
      </div>

      <SectionCard
        title="Smart Threshold Advisor"
        style={{ padding: rows.length ? 0 : '16px 20px' }}
        action={canEdit && highCount > 0 ? (
          <button className="sv-btn sm" onClick={applyAll} disabled={bulkBusy}>
            {bulkBusy ? <><span className="sv-spinner-sm" /> Applying…</> : `Apply All High-Confidence (${highCount})`}
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
                  {['Device', 'Site', 'Metric'].map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Current</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right' }}>Recommended</th>
                  {['Reasoning', 'Confidence', 'Apply'].map((c) => <th key={c} style={TH_STYLE}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={ROW_STYLE}>
                    <IntelTD><Link href={`/devices/${r.device_id}`}>{r.device_name}</Link></IntelTD>
                    <IntelTD style={{ color: 'var(--text-muted)' }}>{r.site_name || '—'}</IntelTD>
                    <IntelTD>{r.metric}</IntelTD>
                    <IntelTD right>{n(r.current_threshold) ?? '—'}ms</IntelTD>
                    <IntelTD right style={{ fontWeight: 700, color: 'var(--primary)' }}>{Math.round(Number(r.recommended_threshold))}ms</IntelTD>
                    <IntelTD style={{ maxWidth: 280 }}>
                      <span title={r.reasoning} style={{ cursor: 'help' }}>
                        {r.reasoning.length > 60 ? `${r.reasoning.slice(0, 60)}… ` : r.reasoning}
                        <span style={{ color: 'var(--primary)' }}>ⓘ</span>
                      </span>
                    </IntelTD>
                    <IntelTD><ConfidenceStars confidence={r.confidence} /></IntelTD>
                    <IntelTD>
                      {canEdit ? (
                        <button
                          className="sv-btn sm"
                          style={{ height: 24, padding: '0 10px', fontSize: 12 }}
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

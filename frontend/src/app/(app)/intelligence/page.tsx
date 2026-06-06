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
  GradeBadge, ScoreBar, TrendArrow, ConfidenceStars, fmtDuration, deviationLabel, deviationTooltip,
  scoreColor, n,
  Overview, HealthRow, AnomalyRow, PatternRow, IncidentRow, ThresholdRow,
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

      <div className="sv-tabs">
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

  if (ov.loading && !d) return <div className="sv-dash-stats"><CardSkeleton count={3} height={120} /></div>;
  if (ov.error) return <ErrorBox message={ov.error} />;
  if (!d) return <Empty message="No intelligence data yet." />;

  const score = d.overall_score;
  const coverage = d.data_coverage_days || 0;

  return (
    <div>
      {/* ── Top: 3 score cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 18 }}>
        <ScoreHeroCard score={score} grade={d.overall_grade} trend={d.trend} deviceCount={d.device_count} coverage={coverage} />
        <CountCard label="Active Anomalies" value={d.active_anomalies} accent={d.active_anomalies > 0 ? 'var(--sv-warning)' : 'var(--sv-up)'} hint="Devices outside their baseline" />
        <CountCard label="Active Incidents" value={d.active_incidents} accent={d.active_incidents > 0 ? 'var(--sv-down)' : 'var(--sv-up)'} hint="Correlated outage events" />
      </div>

      {coverage < 7 && (
        <div className="sv-panel" style={{ borderLeft: '4px solid var(--sv-warning)', marginBottom: 18 }}>
          ⚡ Intelligence improves with more data — currently <strong>{coverage} day{coverage === 1 ? '' : 's'}</strong> collected.
          Baselines become reliable after 7 days, patterns after 30 days.
        </div>
      )}

      {/* ── Middle: site health + at-risk ── */}
      <div className="sv-dash-row r5050">
        <div className="sv-dash-card">
          <div className="sv-dash-head"><h2>Site Health Breakdown</h2></div>
          {!d.sites.length ? (
            <Empty message="No site health computed yet." />
          ) : (
            <table className="sv-table">
              <thead>
                <tr><th>Site</th><th>Score</th><th>Grade</th><th>Trend</th>
                  <th style={{ textAlign: 'right' }}>Devices</th><th style={{ textAlign: 'right' }}>Anomalies</th></tr>
              </thead>
              <tbody>
                {d.sites.map((s) => (
                  <tr key={`${s.site_id}-${s.site_name}`}>
                    <td>{s.site_id ? <Link href={`/sites/${s.site_id}`}>{s.site_name}</Link> : s.site_name}</td>
                    <td><ScoreBar score={s.score} width={80} /></td>
                    <td><GradeBadge grade={s.grade} /></td>
                    <td><TrendArrow trend={s.trend} /></td>
                    <td style={{ textAlign: 'right' }}>{s.device_count}</td>
                    <td style={{ textAlign: 'right', color: s.anomaly_count > 0 ? 'var(--sv-warning)' : 'var(--sv-muted)' }}>{s.anomaly_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="sv-dash-card">
          <div className="sv-dash-head"><h2>At-Risk Devices</h2></div>
          {!d.at_risk_devices.length ? (
            <Empty message="No device health scores yet." />
          ) : (
            d.at_risk_devices.map((dev) => (
              <div key={dev.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border-light)' }}>
                <StatusDot status={dev.current_status} size={11} />
                <Link href={`/devices/${dev.id}`} style={{ fontWeight: 600, minWidth: 120 }}>{dev.name}</Link>
                <span className="sv-muted" style={{ fontSize: 12, flex: 1 }}>{dev.site_name || 'Unassigned'}</span>
                <ScoreBar score={dev.score} width={90} />
                <GradeBadge grade={dev.grade} />
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Bottom: recent anomalies + incidents ── */}
      <div className="sv-dash-row r5050">
        <div className="sv-dash-card">
          <div className="sv-dash-head">
            <h2>Active Anomalies</h2>
            <span className="spacer" />
            <span className="sv-muted" style={{ fontSize: 13 }}>{d.active_anomalies}</span>
          </div>
          {!d.recent_anomalies.length ? (
            <Empty message="No active anomalies — all devices behaving normally ✓" />
          ) : (
            <>
              {d.recent_anomalies.map((a) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.severity === 'critical' ? 'var(--sv-down)' : 'var(--sv-warning)' }} />
                  <Link href={`/devices/${a.device_id}`} style={{ fontWeight: 600 }}>{a.device_name}</Link>
                  <span className="sv-muted" style={{ fontSize: 12.5 }} title={deviationTooltip(a)}>{a.metric} · {deviationLabel(a)}</span>
                  <span className="spacer" style={{ flex: 1 }} />
                  <span className="sv-muted" style={{ fontSize: 12 }}>{fmtRel(a.detected_at)}</span>
                </div>
              ))}
              <div style={{ marginTop: 10, textAlign: 'right' }}>
                <Link href="/intelligence#anomalies" className="sv-dash-link">View all →</Link>
              </div>
            </>
          )}
        </div>

        <div className="sv-dash-card">
          <div className="sv-dash-head">
            <h2>Active Incidents</h2>
            <span className="spacer" />
            <span className="sv-muted" style={{ fontSize: 13 }}>{d.active_incidents}</span>
          </div>
          {!d.recent_incidents.length ? (
            <Empty message="No active incidents ✓" />
          ) : (
            <>
              {d.recent_incidents.map((i) => (
                <div key={i.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'var(--sv-down)' }}>🔴</span>
                    <span style={{ fontWeight: 600 }}>{i.title}</span>
                  </div>
                  <div className="sv-muted" style={{ fontSize: 12, marginLeft: 24 }}>
                    {i.affected_count} affected · started {fmtRel(i.started_at)}
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 10, textAlign: 'right' }}>
                <Link href="/intelligence#incidents" className="sv-dash-link">View all →</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ScoreHeroCard({ score, grade, trend, deviceCount, coverage }: {
  score: number | null; grade: string | null; trend: string; deviceCount: number; coverage: number;
}) {
  const c = scoreColor(score);
  return (
    <div className="sv-panel" style={{ borderLeft: `4px solid ${c}` }}>
      <div className="sv-muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>Network Health Score</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '6px 0' }}>
        <span style={{ fontSize: 40, fontWeight: 800, color: c, lineHeight: 1 }}>{score != null ? Math.round(score) : '—'}</span>
        <span style={{ fontSize: 16, color: 'var(--sv-muted)' }}>/ 100</span>
        <GradeBadge grade={grade} />
      </div>
      <div style={{ height: 10, borderRadius: 6, background: 'var(--border)', overflow: 'hidden', margin: '8px 0' }}>
        <div style={{ width: `${score != null ? Math.max(2, Math.min(100, score)) : 0}%`, height: '100%', background: c }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
        <TrendArrow trend={trend} />
        <span className="sv-muted">{deviceCount} device{deviceCount === 1 ? '' : 's'} · {coverage}d of data</span>
      </div>
    </div>
  );
}

function CountCard({ label, value, accent, hint }: { label: string; value: number; accent: string; hint: string }) {
  return (
    <div className="sv-panel" style={{ borderLeft: `4px solid ${accent}` }}>
      <div className="sv-muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 40, fontWeight: 800, color: accent, lineHeight: 1.2 }}>{value}</div>
      <div className="sv-muted" style={{ fontSize: 12.5 }}>{hint}</div>
    </div>
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
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Anomaly Detection</h2>
        {filter !== 'resolved' && <span className="sv-badge warning">{activeCount} active</span>}
        <span className="sv-muted" style={{ fontSize: 13 }}>Devices behaving outside their normal baseline</span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {(['all', 'active', 'resolved'] as const).map((f) => (
          <button key={f} className={`sv-btn ${filter === f ? '' : 'ghost'} sm`} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <input className="sv-input" placeholder="Filter by device…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 160, maxWidth: 280 }} />
      </div>

      <div className="sv-panel">
        {api.loading && !api.data ? (
          <TableSkeleton rows={6} cols={8} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No anomalies detected — all devices behaving normally ✓" />
        ) : (
          <table className="sv-table">
            <thead>
              <tr><th>Device</th><th>Site</th><th>Metric</th><th style={{ textAlign: 'right' }}>Current</th>
                <th style={{ textAlign: 'right' }}>Baseline</th><th>Deviation</th><th>Severity</th><th>Detected</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const val = n(a.value);
                const base = n(a.baseline_mean);
                return (
                  <tr key={a.id}>
                    <td><Link href={`/devices/${a.device_id}`}>{a.device_name}</Link></td>
                    <td className="sv-muted">{a.site_name || '—'}</td>
                    <td>{a.metric}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{val != null ? val.toFixed(1) : '—'}</td>
                    <td style={{ textAlign: 'right' }} className="sv-muted">{base != null ? base.toFixed(1) : '—'}</td>
                    <td><span className={`sv-badge ${a.severity === 'critical' ? 'down' : 'warning'}`} title={deviationTooltip(a)}>{deviationLabel(a)}</span></td>
                    <td><StatusBadge status={a.severity} /></td>
                    <td className="sv-muted" title={fmtTime(a.detected_at)}>{fmtRel(a.detected_at)}</td>
                    <td>{a.status === 'active'
                      ? <span className="sv-badge active">Active</span>
                      : <span className="sv-badge resolved">Resolved</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
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
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 2px' }}>Device Health Scores</h2>
        <span className="sv-muted" style={{ fontSize: 13 }}>Composite score from uptime, response time, anomalies, and alerts (worst first)</span>
      </div>

      <div className="sv-panel">
        {api.loading && !api.data ? (
          <TableSkeleton rows={8} cols={8} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="Collecting baseline data — health scores appear once devices have monitoring history." />
        ) : (
          <table className="sv-table">
            <thead>
              <tr><th>Device</th><th>Site</th><th>Score</th><th>Grade</th>
                <th style={{ textAlign: 'right' }}>Uptime</th><th style={{ textAlign: 'right' }}>Anomalies 7d</th>
                <th style={{ textAlign: 'right' }}>Alerts 7d</th><th>Trend</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const up = n(r.uptime_pct);
                const breakdown =
                  `Uptime: ${Math.round(n(r.uptime_score) ?? 0)}/40\n` +
                  `Response: ${Math.round(n(r.response_score) ?? 0)}/20\n` +
                  `Anomaly: ${Math.round(n(r.anomaly_score) ?? 0)}/20\n` +
                  `Alert: ${Math.round(n(r.alert_score) ?? 0)}/20`;
                return (
                  <tr key={r.id}>
                    <td><Link href={`/devices/${r.id}`}>{r.name}</Link></td>
                    <td className="sv-muted">{r.site_name || '—'}</td>
                    <td title={breakdown}><ScoreBar score={r.score} /></td>
                    <td><GradeBadge grade={r.grade} /></td>
                    <td style={{ textAlign: 'right' }}>{up != null ? `${up.toFixed(1)}%` : '—'}</td>
                    <td style={{ textAlign: 'right', color: r.anomalies_7d > 0 ? 'var(--sv-warning)' : 'var(--sv-muted)' }}>{r.anomalies_7d}</td>
                    <td style={{ textAlign: 'right', color: r.alerts_7d > 0 ? 'var(--sv-down)' : 'var(--sv-muted)' }}>{r.alerts_7d}</td>
                    <td><TrendArrow trend={r.trend} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
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
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 2px' }}>Capacity Forecasting</h2>
        <span className="sv-muted" style={{ fontSize: 13 }}>Bandwidth trend analysis and utilization projections</span>
      </div>

      <div style={{ marginBottom: 16 }}>
        <select
          className="sv-input"
          value={deviceId ?? ''}
          onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : null)}
          style={{ minWidth: 280 }}
        >
          <option value="">Select a device…</option>
          {(devices.data || []).map((d) => (
            <option key={d.id} value={d.id}>{d.name}{d.site_name ? ` · ${d.site_name}` : ''}</option>
          ))}
        </select>
      </div>

      {!deviceId ? (
        <div className="sv-panel"><Empty message="Select a device to view its bandwidth capacity forecast." /></div>
      ) : fc.loading && !fc.data ? (
        <div className="sv-panel"><Loading label="Analyzing bandwidth trend…" /></div>
      ) : fc.error ? (
        <ErrorBox message={fc.error} />
      ) : fc.data && fc.data.enough_data ? (
        <CapacityResult fc={fc.data} />
      ) : fc.data && fc.data.days_collected === 0 ? (
        <div className="sv-panel"><Empty message="No bandwidth sensors configured for this device. Enable SNMP and run discovery to add interface sensors." /></div>
      ) : (
        <div className="sv-panel">
          <Empty message={`Need at least 7 days of SNMP bandwidth data for forecasting. Currently have ${fc.data?.days_collected ?? 0} day(s). Check back in ${Math.max(0, 7 - (fc.data?.days_collected ?? 0))} day(s).`} />
        </div>
      )}
    </div>
  );
}

function capacityStatus(projMax: number, peak: number): { label: string; color: string } {
  if (!peak || peak <= 0) return { label: 'OK', color: 'var(--sv-up)' };
  const ratio = projMax / peak;
  if (ratio >= 0.85) return { label: '⚠ Plan upgrade', color: 'var(--sv-down)' };
  if (ratio >= 0.70) return { label: 'Monitor', color: 'var(--sv-warning)' };
  return { label: 'OK', color: 'var(--sv-up)' };
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

  const growthInPct = lastIn > 0 ? ((fc.weekly_growth_in || 0) / lastIn) * 100 : 0;

  return (
    <div>
      <div className="sv-dash-row r5050">
        <ForecastChart title="Inbound (In)" data={inSeries} peak={peakIn} />
        <ForecastChart title="Outbound (Out)" data={outSeries} peak={peakOut} />
      </div>

      <div className="sv-panel" style={{ marginTop: 16 }}>
        <h2>Forecast</h2>
        <table className="sv-table">
          <thead>
            <tr><th>Timeframe</th><th style={{ textAlign: 'right' }}>Projected In</th>
              <th style={{ textAlign: 'right' }}>Projected Out</th><th style={{ textAlign: 'right' }}>Growth Rate</th><th>Status</th></tr>
          </thead>
          <tbody>
            {forecasts.map((f) => {
              const st = capacityStatus(Math.max(f.proj_in_bps / (peakIn || 1), f.proj_out_bps / (peakOut || 1)) * Math.max(peakIn, peakOut), Math.max(peakIn, peakOut));
              return (
                <tr key={f.days}>
                  <td>{f.days} days</td>
                  <td style={{ textAlign: 'right' }}>{fmtBps(f.proj_in_bps)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtBps(f.proj_out_bps)}</td>
                  <td style={{ textAlign: 'right', color: growthInPct > 0 ? 'var(--sv-warning)' : 'var(--sv-up)' }}>
                    {growthInPct >= 0 ? '+' : ''}{growthInPct.toFixed(1)}%/week
                  </td>
                  <td style={{ color: st.color, fontWeight: 600 }}>{st.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="sv-muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          Based on {fc.days_collected} days of data. Peak observed: In {fmtBps(peakIn)} · Out {fmtBps(peakOut)}.
          Reference lines mark 80% and 95% of peak.
        </p>
      </div>
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
    <div className="sv-dash-card">
      <div className="sv-dash-head"><h2>{title}</h2></div>
      {!data.length ? (
        <Empty message="No data." />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
            <defs>
              <linearGradient id={`g-${title}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
            <XAxis dataKey="label" fontSize={10} minTickGap={28} />
            <YAxis fontSize={10} width={64} tickFormatter={(v) => fmtBps(Number(v))} />
            <Tooltip formatter={(v: any, name: any) => [v == null ? '—' : fmtBps(Number(v)), name === 'actual' ? 'Actual' : 'Projected']} />
            {peak > 0 && <ReferenceLine y={peak * 0.8} stroke="#e6a700" strokeDasharray="4 4" label={{ value: '80%', position: 'right', fontSize: 10, fill: '#e6a700' }} />}
            {peak > 0 && <ReferenceLine y={peak * 0.95} stroke="#C8102E" strokeDasharray="4 4" label={{ value: '95%', position: 'right', fontSize: 10, fill: '#C8102E' }} />}
            <Area type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={2} fill={`url(#g-${title})`} connectNulls={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="projected" stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 4" fill="none" connectNulls isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
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
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 2px' }}>Incident Timeline</h2>
        <span className="sv-muted" style={{ fontSize: 13 }}>Correlated outage events with root cause analysis</span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.key} className={`sv-btn ${filter.key === f.key ? '' : 'ghost'} sm`} onClick={() => setFilter(f)}>{f.label}</button>
        ))}
      </div>

      {api.loading && !api.data ? (
        <div className="sv-panel"><TableSkeleton rows={4} cols={1} /></div>
      ) : api.error ? (
        <ErrorBox message={api.error} />
      ) : !rows.length ? (
        <div className="sv-panel">
          <Empty message="No incidents in the selected period. Incidents are created when multiple devices go down simultaneously." />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {rows.map((i) => <IncidentCard key={i.id} incident={i} />)}
        </div>
      )}
    </div>
  );
}

function IncidentCard({ incident: i }: { incident: IncidentRow }) {
  const active = i.status === 'active';
  const timeline = Array.isArray(i.timeline) ? i.timeline : [];
  return (
    <div className="sv-panel" style={{ borderLeft: `4px solid ${active ? 'var(--sv-down)' : 'var(--sv-up)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>{active ? '🔴' : '🟢'}</span>
        <span className={`sv-badge ${active ? 'active' : 'resolved'}`}>{active ? 'ACTIVE' : 'RESOLVED'}</span>
        <strong style={{ fontSize: 15 }}>{i.title}</strong>
        <span className="spacer" style={{ flex: 1 }} />
        {active
          ? <span className="sv-muted" style={{ fontSize: 12.5 }}>started {fmtRel(i.started_at)}</span>
          : <span className="sv-muted" style={{ fontSize: 12.5 }}>Resolved after {fmtDuration(i.duration_seconds)}</span>}
      </div>

      <div style={{ marginTop: 10, fontSize: 13, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6 }}>
        <div><span className="sv-muted">Root cause: </span>
          {i.root_cause_device_id
            ? <Link href={`/devices/${i.root_cause_device_id}`}>{i.root_cause_device_name || `#${i.root_cause_device_id}`}</Link>
            : (i.root_cause_device_name || '—')}
        </div>
        <div><span className="sv-muted">Started: </span>{fmtTime(i.started_at)}</div>
        <div><span className="sv-muted">Affected: </span>{i.affected_count} device{i.affected_count === 1 ? '' : 's'}</div>
      </div>

      {timeline.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="sv-muted" style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Timeline</div>
          {timeline.map((t, idx) => (
            <div key={idx} style={{ fontSize: 12.5, fontFamily: 'monospace', padding: '2px 0' }}>
              <span className="sv-muted">{fmtTime(t.ts)}</span> &nbsp; {t.device} {t.event}
            </div>
          ))}
        </div>
      )}

      {i.affected_devices && i.affected_devices.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5 }}>
          <span className="sv-muted">Devices: </span>{i.affected_devices.join(', ')}
        </div>
      )}
    </div>
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
    <div>
      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: '0 0 2px' }}>Smart Threshold Advisor</h2>
          <span className="sv-muted" style={{ fontSize: 13 }}>Recommended alert thresholds based on device behavior history</span>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        {canEdit && highCount > 0 && (
          <button className="sv-btn" onClick={applyAll} disabled={bulkBusy}>
            {bulkBusy ? <><span className="sv-spinner-sm" /> Applying…</> : `Apply All High-Confidence (${highCount})`}
          </button>
        )}
      </div>

      <div className="sv-panel" style={{ borderLeft: '4px solid var(--primary)', marginBottom: 16 }}>
        These recommendations are based on each device&apos;s actual behavior over the last 30 days.
        Current thresholds are compared against statistical baselines (2× p99) to suggest more accurate values.
      </div>

      <div className="sv-panel">
        {api.loading && !api.data ? (
          <TableSkeleton rows={6} cols={7} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="Analyzing device behavior… Recommendations appear after 7+ days of data collection." />
        ) : (
          <table className="sv-table">
            <thead>
              <tr><th>Device</th><th>Site</th><th>Metric</th><th style={{ textAlign: 'right' }}>Current</th>
                <th style={{ textAlign: 'right' }}>Recommended</th><th>Reasoning</th><th>Confidence</th><th>Action</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/devices/${r.device_id}`}>{r.device_name}</Link></td>
                  <td className="sv-muted">{r.site_name || '—'}</td>
                  <td>{r.metric}</td>
                  <td style={{ textAlign: 'right' }}>{n(r.current_threshold) ?? '—'}ms</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--primary)' }}>{Math.round(Number(r.recommended_threshold))}ms</td>
                  <td style={{ maxWidth: 280 }}>
                    <span title={r.reasoning} style={{ cursor: 'help' }}>
                      {r.reasoning.length > 70 ? `${r.reasoning.slice(0, 70)}… ` : r.reasoning}
                      <span style={{ color: 'var(--primary)' }}>ⓘ</span>
                    </span>
                  </td>
                  <td><ConfidenceStars confidence={r.confidence} /></td>
                  <td>
                    {canEdit ? (
                      <button className="sv-btn sm" onClick={() => apply(r)} disabled={busy === r.device_id}>
                        {busy === r.device_id ? <span className="sv-spinner-sm" /> : 'Apply'}
                      </button>
                    ) : (
                      <span className="sv-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

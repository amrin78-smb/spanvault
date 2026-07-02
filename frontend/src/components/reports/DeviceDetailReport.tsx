'use client';

import type { CSSProperties } from 'react';
import Link from 'next/link';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { StatusDot } from '@/components/StatusDot';
import { GradeBadge } from '@/components/intel';
import { fmtTime, fmtBps, Skeleton, CardSkeleton } from '@/components/ui';
import {
  SECTION_TITLE, PANEL, STAT_GRID, STAT_CARD, STAT_VALUE, STAT_LABEL, TH, TD,
  CHART_CARD, CHART_TITLE, CHART_NOTE, TOOLTIP_STYLE,
} from '@/components/reports/reportStyles';

/**
 * Pure presentational device-detail report.
 * Parent fetches GET /api/reports/device-detail and passes non-null `data`.
 * All helper components are defined at module scope (never nested) per project rules.
 */

// ── Data shape (mirrors GET /api/reports/device-detail) ────────
export type DeviceDetail = {
  device: {
    name: string;
    ip: string;
    site: string | null;
    type: string | null;
    vendor: string | null;
    snmp_enabled: boolean;
  };
  period: string;
  availability: {
    uptime_pct: number | null;
    total_checks: number;
    failed_checks: number;
    downtime_minutes: number;
    longest_outage_minutes: number;
  };
  response: {
    avg_ms: number | null;
    min_ms: number | null;
    max_ms: number | null;
    p95_ms: number | null;
  };
  health: { score: number | null; grade: string | null; trend: string | null };
  baseline: { mean_ms: number | null; p95_ms: number | null };
  analysis?: string;
  alerts: {
    id: number;
    alert_type: string;
    severity: string;
    message: string;
    triggered_at: string;
    resolved_at: string | null;
    acknowledged_by: string | null;
    status: string;
    duration_minutes: number;
  }[];
  uptime_by_day: { day: string; uptime_pct: number | null; total_checks: number }[];
  snmp_summary: {
    sensor_name: string;
    metric_name: string;
    category: string;
    current_value: number | string | null;
    baseline_mean: number | string | null;
  }[];
  topology: {
    from_port: string | null;
    to_port: string | null;
    protocol: string | null;
    to_device_id: number | null;
    neighbor_name: string | null;
    neighbor_ip: string | null;
  }[];
  // ── Phase 0+1 granular time-series (optional; older payloads omit it) ──
  range?: { from: string; to: string; bucket: string } | null;
  series?: {
    scalar?: ScalarPoint[];
    interfaces?: IfSeries[];
  } | null;
};

// One bucket of the device's scalar metrics. Any field may be null where the
// vendor/device doesn't supply it (e.g. cpu/mem on a non-SNMP host, GP tunnels
// only on Palo Alto firewalls).
export type ScalarPoint = {
  ts: string;
  latency_ms: number | null;
  packet_loss_pct: number | null;
  cpu_pct: number | null;
  mem_pct: number | null;
  session_count: number | null;
  session_util_pct: number | null;
  gp_tunnels: number | null;
};
export type IfSeries = {
  if_index: number;
  if_name: string;
  points: { ts: string; in_bps: number | null; out_bps: number | null; in_util_pct: number | null; out_util_pct: number | null }[];
};

// ── Helpers (module scope) ─────────────────────────────────────
function dash(v: number | string | null | undefined, suffix = ''): string {
  if (v === null || v === undefined || v === '') return '—';
  return `${v}${suffix}`;
}

function dayColor(d: { uptime_pct: number | null; total_checks: number }): string {
  if (d.total_checks === 0) return 'var(--sv-unknown)';
  const p = d.uptime_pct;
  if (p === null || p < 99) return 'var(--sv-down)';
  if (p < 99.9) return 'var(--sv-warning)';
  return 'var(--sv-up)';
}

function sevClass(severity: string): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'down') return 'down';
  if (s === 'warning' || s === 'medium') return 'warning';
  if (s === 'up' || s === 'info' || s === 'low') return 'up';
  return '';
}

// ── Report body copy (device-detail only) ──────────────────────
const ANALYSIS_BODY: CSSProperties = {
  fontSize: 'var(--text-base)',
  lineHeight: 1.6,
  color: 'var(--text-primary)',
  maxWidth: '70ch',
  margin: 0,
};

// ── Chart constants & helpers (module scope) ───────────────────
const CHART_HEIGHT = 230;
const MAX_IF_CHARTS = 6; // cap interface charts at the N busiest to avoid 300 charts.

const COLOR_LATENCY = '#C8102E'; // crimson
const COLOR_LOSS = '#d97706';    // amber
const COLOR_CPU = '#2563eb';     // blue
const COLOR_MEM = '#7c3aed';     // purple
const COLOR_SESS = '#16a34a';    // green
const COLOR_SESS_UTIL = '#2563eb';
const COLOR_GP = '#7c3aed';
const COLOR_IN = '#2563eb';
const COLOR_OUT = '#f97316';

function tickLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function seriesHasAny<T extends Record<string, any>>(arr: T[], keys: (keyof T)[]): boolean {
  return arr.some((p) => keys.some((k) => p[k] !== null && p[k] !== undefined));
}
function wantsMetric(selected: string[] | undefined, key: string): boolean {
  return !selected || selected.includes(key);
}

// ── Scalar metric charts (module-scope components) ─────────────
function LatencyLossChart({ data }: { data: ScalarPoint[] }) {
  const has = seriesHasAny(data, ['latency_ms', 'packet_loss_pct']);
  if (!has) return null;
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>Latency &amp; packet loss</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
          <YAxis yAxisId="ms" fontSize={11} width={44} stroke="var(--text-muted)" />
          <YAxis yAxisId="pct" orientation="right" fontSize={11} width={40} domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="var(--text-muted)" />
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={tickLabel}
            formatter={(v: any, n: any) => [v == null ? '—' : (n === 'Packet loss' ? `${v}%` : `${v} ms`), n]}
          />
          <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
          <Line yAxisId="ms" type="monotone" name="Latency" dataKey="latency_ms" stroke={COLOR_LATENCY} strokeWidth={2} dot={false} connectNulls={false} />
          <Line yAxisId="pct" type="monotone" name="Packet loss" dataKey="packet_loss_pct" stroke={COLOR_LOSS} strokeWidth={1.5} dot={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// CPU chart with optional p50/p95 baseline reference lines.
function CpuChart({ data, baseP50, baseP95 }: { data: ScalarPoint[]; baseP50: number | null; baseP95: number | null }) {
  if (!seriesHasAny(data, ['cpu_pct'])) return null;
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>CPU utilization (%)</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
          <YAxis fontSize={11} width={40} domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="var(--text-muted)" />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={tickLabel} formatter={(v: any) => [v == null ? '—' : `${v}%`, 'CPU']} />
          {baseP50 != null && (
            <ReferenceLine y={baseP50} stroke="var(--text-muted)" strokeDasharray="4 3"
              label={{ value: `p50 ${Math.round(baseP50)}%`, position: 'insideTopLeft', fontSize: 11, fill: 'var(--text-muted)' }} />
          )}
          {baseP95 != null && (
            <ReferenceLine y={baseP95} stroke={COLOR_LOSS} strokeDasharray="4 3"
              label={{ value: `p95 ${Math.round(baseP95)}%`, position: 'insideTopLeft', fontSize: 11, fill: COLOR_LOSS }} />
          )}
          <Line type="monotone" dataKey="cpu_pct" stroke={COLOR_CPU} strokeWidth={2} dot={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function MemChart({ data }: { data: ScalarPoint[] }) {
  if (!seriesHasAny(data, ['mem_pct'])) return null;
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>Memory utilization (%)</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
          <YAxis fontSize={11} width={40} domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="var(--text-muted)" />
          <Tooltip {...TOOLTIP_STYLE} labelFormatter={tickLabel} formatter={(v: any) => [v == null ? '—' : `${v}%`, 'Memory']} />
          <Line type="monotone" dataKey="mem_pct" stroke={COLOR_MEM} strokeWidth={2} dot={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Firewall session / GlobalProtect chart — only renders when present.
function SessionsChart({ data }: { data: ScalarPoint[] }) {
  const hasCount = seriesHasAny(data, ['session_count']);
  const hasUtil = seriesHasAny(data, ['session_util_pct']);
  const hasGp = seriesHasAny(data, ['gp_tunnels']);
  if (!hasCount && !hasUtil && !hasGp) return null;
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>Sessions &amp; tunnels</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
          <YAxis yAxisId="count" fontSize={11} width={48} allowDecimals={false} stroke="var(--text-muted)" />
          {hasUtil && (
            <YAxis yAxisId="pct" orientation="right" fontSize={11} width={40} domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="var(--text-muted)" />
          )}
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={tickLabel}
            formatter={(v: any, n: any) => [v == null ? '—' : (n === 'Session util' ? `${v}%` : v), n]}
          />
          <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
          {hasCount && <Line yAxisId="count" type="monotone" name="Sessions" dataKey="session_count" stroke={COLOR_SESS} strokeWidth={2} dot={false} connectNulls={false} />}
          {hasGp && <Line yAxisId="count" type="monotone" name="GP tunnels" dataKey="gp_tunnels" stroke={COLOR_GP} strokeWidth={1.5} dot={false} connectNulls={false} />}
          {hasUtil && <Line yAxisId="pct" type="monotone" name="Session util" dataKey="session_util_pct" stroke={COLOR_SESS_UTIL} strokeWidth={1.5} dot={false} connectNulls={false} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// One interface's in/out throughput. Axis unit chosen from the peak.
function InterfaceChart({ iface }: { iface: IfSeries }) {
  const pts = iface.points || [];
  const maxV = pts.reduce((m, p) => Math.max(m, p.in_bps ?? 0, p.out_bps ?? 0), 0);
  let div = 1; let unit = 'bps';
  if (maxV >= 1e9) { div = 1e9; unit = 'Gbps'; }
  else if (maxV >= 1e6) { div = 1e6; unit = 'Mbps'; }
  else if (maxV >= 1e3) { div = 1e3; unit = 'Kbps'; }
  const axisTick = (v: any) => String(Math.round((Number(v) / div) * 10) / 10);
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>{`${iface.if_name} · ${unit}`}</h3>
      {pts.length === 0 ? (
        <p style={CHART_NOTE}>No traffic samples for this interface.</p>
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <AreaChart data={pts} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
            <defs>
              <linearGradient id={`sv-if-in-${iface.if_index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_IN} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLOR_IN} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id={`sv-if-out-${iface.if_index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_OUT} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLOR_OUT} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
            <YAxis fontSize={11} width={40} tickFormatter={axisTick} stroke="var(--text-muted)" />
            <Tooltip {...TOOLTIP_STYLE} labelFormatter={tickLabel} formatter={(v: any, n: any) => [v == null ? '—' : fmtBps(Number(v)), n]} />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
            <Area type="monotone" name="In" dataKey="in_bps" stroke={COLOR_IN} strokeWidth={2} fill={`url(#sv-if-in-${iface.if_index})`} connectNulls={false} />
            <Area type="monotone" name="Out" dataKey="out_bps" stroke={COLOR_OUT} strokeWidth={2} fill={`url(#sv-if-out-${iface.if_index})`} connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// Peak in/out bps of an interface — used to rank the busiest for the cap.
function ifPeak(iface: IfSeries): number {
  return (iface.points || []).reduce((m, p) => Math.max(m, p.in_bps ?? 0, p.out_bps ?? 0), 0);
}

// Does this interface carry any usable data? Filters out interfaces with no
// samples at all, or whose bps/util fields are entirely null (an empty chart
// frame / "No traffic samples" card), before they're ranked and capped.
function ifHasData(iface: IfSeries): boolean {
  const pts = iface.points || [];
  return pts.some((p) =>
    p.in_bps != null || p.out_bps != null || p.in_util_pct != null || p.out_util_pct != null);
}

// ── Metric charts section (module-scope component) ─────────────
function DeviceMetricCharts({ data, selectedMetrics }: { data: DeviceDetail; selectedMetrics?: string[] }) {
  const series = data.series || null;
  const scalar = (series && Array.isArray(series.scalar)) ? series.scalar : [];
  const interfaces = (series && Array.isArray(series.interfaces)) ? series.interfaces : [];

  // Use the existing response baseline (ms) as CPU baseline reference only if the
  // payload carries CPU-percentage baselines — the existing baseline is latency
  // (ms), not CPU, so we don't misapply it. Reference lines are drawn only when a
  // dedicated cpu baseline exists on the point stream isn't available, so we pass
  // null here (kept as a hook for when the API adds cpu baselines).
  const cpuP50: number | null = null;
  const cpuP95: number | null = null;

  // Drop genuinely-empty interfaces (no samples / all-null bps+util) BEFORE
  // ranking + the cap, so empty-interface cards don't show and don't crowd out
  // real interfaces. Then rank by peak throughput and cap to the busiest N.
  const usableIfaces = interfaces.filter(ifHasData);
  const topIfaces = [...usableIfaces]
    .sort((a, b) => ifPeak(b) - ifPeak(a))
    .slice(0, MAX_IF_CHARTS);
  const hiddenIfaces = usableIfaces.length - topIfaces.length;

  const showLatency = wantsMetric(selectedMetrics, 'latency') && seriesHasAny(scalar, ['latency_ms', 'packet_loss_pct']);
  const showCpu = wantsMetric(selectedMetrics, 'cpu') && seriesHasAny(scalar, ['cpu_pct']);
  const showMem = wantsMetric(selectedMetrics, 'mem') && seriesHasAny(scalar, ['mem_pct']);
  const showSessions = wantsMetric(selectedMetrics, 'sessions') && seriesHasAny(scalar, ['session_count', 'session_util_pct', 'gp_tunnels']);
  const showInterfaces = wantsMetric(selectedMetrics, 'interfaces') && topIfaces.length > 0;

  const anything = showLatency || showCpu || showMem || showSessions || showInterfaces;
  if (!anything) return null;

  return (
    <>
      {showLatency && <LatencyLossChart data={scalar} />}
      {showCpu && <CpuChart data={scalar} baseP50={cpuP50} baseP95={cpuP95} />}
      {showMem && <MemChart data={scalar} />}
      {showSessions && <SessionsChart data={scalar} />}
      {showInterfaces && topIfaces.map((iface) => <InterfaceChart key={iface.if_index} iface={iface} />)}
      {showInterfaces && hiddenIfaces > 0 && (
        <p style={{ ...CHART_NOTE, margin: 0 }}>
          Showing the {topIfaces.length} busiest interfaces · {hiddenIfaces} lower-traffic interface{hiddenIfaces === 1 ? '' : 's'} hidden.
        </p>
      )}
    </>
  );
}

// ── Loading skeleton (module scope) ────────────────────────────
function DeviceReportSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="sv-panel"><Skeleton width={240} height={22} /></div>
      <div className="sv-cards"><CardSkeleton count={4} height={72} /></div>
      <div className="sv-panel"><Skeleton width="100%" height={120} /></div>
      <div className="sv-panel"><Skeleton width="100%" height={140} /></div>
    </div>
  );
}

// Empty defaults so a partial payload never crashes the render.
const EMPTY_AVAIL = { uptime_pct: null, total_checks: 0, failed_checks: 0, downtime_minutes: 0, longest_outage_minutes: 0 };
const EMPTY_RESPONSE = { avg_ms: null, min_ms: null, max_ms: null, p95_ms: null };
const EMPTY_HEALTH = { score: null, grade: null, trend: null };
const EMPTY_BASELINE = { mean_ms: null, p95_ms: null };

// ── Main report ────────────────────────────────────────────────
export default function DeviceDetailReport({ data, selectedMetrics }: { data?: DeviceDetail | null; selectedMetrics?: string[] }) {
  // The parent fetch may still be in flight (or a template switch may briefly
  // hand us the previous report's payload). Guard until a real device payload
  // is present rather than crashing on undefined sub-objects.
  if (!data || !data.device) return <DeviceReportSkeleton />;

  const device = data.device;
  const availability = data.availability || EMPTY_AVAIL;
  const response = data.response || EMPTY_RESPONSE;
  const health = data.health || EMPTY_HEALTH;
  const baseline = data.baseline || EMPTY_BASELINE;
  const alerts = data.alerts || [];
  const uptime_by_day = data.uptime_by_day || [];
  const snmp_summary = data.snmp_summary || [];
  const topology = data.topology || [];
  const analysis = (data.analysis || '').trim();

  const subline = [device.ip, device.type, device.site, device.vendor]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');

  // Derive the header status dot from availability instead of hardcoding 'up',
  // so a down/degraded device's report header reflects reality.
  const up = availability.uptime_pct;
  const headerStatus = up == null ? 'unknown' : up >= 99 ? 'up' : up >= 1 ? 'warning' : 'down';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1. Device header */}
      <div className="sv-panel" style={{ ...PANEL, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <StatusDot status={headerStatus} size={14} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{device.name}</h2>
            <div className="sv-muted" style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>{subline || '—'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right' }}>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: 0.5 }} className="sv-muted">
              Health score
            </div>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}>
              {health.score == null ? '—' : Math.round(health.score)}
            </div>
          </div>
          <GradeBadge grade={health.grade} />
        </div>
      </div>

      {/* 2. Stat cards */}
      <div style={STAT_GRID}>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>{availability.uptime_pct == null ? '—' : `${availability.uptime_pct}%`}</div>
          <div style={STAT_LABEL}>Uptime</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{response.avg_ms === null ? '—' : `${response.avg_ms} ms`}</div>
          <div style={STAT_LABEL}>Avg Response</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--yellow)' }}>
          <div style={STAT_VALUE}>{alerts.length}</div>
          <div style={STAT_LABEL}>Total Alerts</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--red)' }}>
          <div style={STAT_VALUE}>{`${availability.downtime_minutes} min`}</div>
          <div style={STAT_LABEL}>Downtime</div>
        </div>
      </div>

      {/* 2b. Device analysis (auto-generated interpretation of the numbers above) */}
      {analysis && (
        <div className="sv-panel" style={PANEL}>
          <h3 style={SECTION_TITLE}>Device analysis</h3>
          <p style={ANALYSIS_BODY}>{analysis}</p>
        </div>
      )}

      {/* 3. 90-day availability calendar */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>90-day availability</h3>
        {uptime_by_day.length === 0 ? (
          <div className="sv-muted">No availability data in this period.</div>
        ) : (
          <div className="sv-uptime-cal">
            {uptime_by_day.map((d, i) => (
              <span
                key={`${d.day}-${i}`}
                className="sv-uptime-day"
                style={{ background: dayColor(d) }}
                title={`${d.day} — ${d.uptime_pct ?? 'no data'}%`}
              />
            ))}
          </div>
        )}
      </div>

      {/* 4. Response time summary */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Response time</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th style={TH}>Metric</th>
              <th style={TH}>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={TD}>Avg (ms)</td><td style={TD}>{dash(response.avg_ms)}</td></tr>
            <tr><td style={TD}>Min (ms)</td><td style={TD}>{dash(response.min_ms)}</td></tr>
            <tr><td style={TD}>Max (ms)</td><td style={TD}>{dash(response.max_ms)}</td></tr>
            <tr><td style={TD}>P95 (ms)</td><td style={TD}>{dash(response.p95_ms)}</td></tr>
            <tr>
              <td style={TD}>Baseline (mean / p95 ms)</td>
              <td style={TD}>{`${dash(baseline.mean_ms)} / ${dash(baseline.p95_ms)}`}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 4b. Granular time-series charts (Phase 0+1) — only renders metrics that
          have data and are requested via selectedMetrics. */}
      <DeviceMetricCharts data={data} selectedMetrics={selectedMetrics} />

      {/* 5. Alert history */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Alert history</h3>
        {alerts.length === 0 ? (
          <div className="sv-muted">No alerts in this period.</div>
        ) : (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Triggered</th>
                <th style={TH}>Type</th>
                <th style={TH}>Severity</th>
                <th style={TH}>Message</th>
                <th style={TH}>Duration</th>
                <th style={TH}>Status</th>
                <th style={TH}>Ack&apos;d by</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td style={TD}>{fmtTime(a.triggered_at)}</td>
                  <td style={TD}>{a.alert_type}</td>
                  <td style={TD}><span className={`sv-badge ${sevClass(a.severity)}`}>{a.severity}</span></td>
                  <td style={TD}>{a.message}</td>
                  <td style={TD}>{`${a.duration_minutes} min`}</td>
                  <td style={TD}>{a.status}</td>
                  <td style={TD}>{a.acknowledged_by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 6. SNMP metrics */}
      {snmp_summary.length > 0 && (
        <div className="sv-panel" style={PANEL}>
          <h3 style={SECTION_TITLE}>SNMP metrics</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Sensor</th>
                <th style={TH}>Current</th>
                <th style={TH}>Baseline</th>
              </tr>
            </thead>
            <tbody>
              {snmp_summary.map((s, i) => (
                <tr key={`${s.sensor_name}-${s.metric_name}-${i}`}>
                  <td style={TD}>{s.sensor_name}</td>
                  <td style={TD}>{dash(s.current_value)}</td>
                  <td style={TD}>{dash(s.baseline_mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 7. Connected devices (topology) */}
      {topology.length > 0 && (
        <div className="sv-panel" style={PANEL}>
          <h3 style={SECTION_TITLE}>Connected devices</h3>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {topology.map((t, i) => {
              const name = t.neighbor_name || t.neighbor_ip || 'Unknown neighbor';
              const ports = t.from_port || t.to_port
                ? `${t.from_port || '?'}→${t.to_port || '?'}`
                : null;
              return (
                <li key={i}>
                  {t.to_device_id != null ? (
                    <Link href={`/devices/${t.to_device_id}`}>{name}</Link>
                  ) : (
                    <span>{name}</span>
                  )}
                  {t.neighbor_ip && <span className="sv-muted">{` · ${t.neighbor_ip}`}</span>}
                  {ports && <span className="sv-muted">{` · ${ports}`}</span>}
                  {t.protocol && <span className="sv-muted">{` · ${t.protocol.toUpperCase()}`}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

'use client';

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { StatusDot } from '@/components/StatusDot';
import { fmtTime, Skeleton, CardSkeleton } from '@/components/ui';
import {
  SECTION_TITLE, PANEL, STAT_GRID, STAT_CARD, STAT_VALUE, STAT_LABEL, TH, TD,
  CHART_CARD, CHART_TITLE, TOOLTIP_STYLE, dayColor,
} from '@/components/reports/reportStyles';

/**
 * Pure presentational service-detail report — mirrors DeviceDetailReport.
 * Parent fetches GET /api/reports/service-detail?service_check_id=X and passes
 * non-null `data`. All helper components are defined at module scope (never
 * nested) per project rules.
 */

// ── Data shape (mirrors GET /api/reports/service-detail) ───────
export type ServiceDetail = {
  service: {
    id: number;
    name: string;
    type: string;
    target: string;
    site: string | null;
    site_id: number | null;
    agent_id: number | null;
    agent_name: string | null;
    current_status: string;
    interval_seconds: number;
  };
  period: string;
  analysis?: string;
  availability: {
    uptime_pct: number | null;
    total_checks: number;
    failed_checks: number;
    up_checks: number;
    down_checks: number;
    warning_checks: number;
    downtime_minutes: number;
  };
  response: {
    avg_ms: number | null;
    min_ms: number | null;
    max_ms: number | null;
    p95_ms: number | null;
  };
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
  status_by_day: { day: string; uptime_pct: number | null; total_checks: number }[];
  range?: { from: string; to: string; bucket: string } | null;
  series?: { scalar?: ScalarPoint[] } | null;
};

export type ScalarPoint = {
  ts: string;
  response_ms: number | null;
  up_pct: number | null;
};

// ── Helpers (module scope) ─────────────────────────────────────
function dash(v: number | string | null | undefined, suffix = ''): string {
  if (v === null || v === undefined || v === '') return '—';
  return `${v}${suffix}`;
}

function sevClass(severity: string): string {
  const s = (severity || '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'down') return 'down';
  if (s === 'warning' || s === 'medium') return 'warning';
  if (s === 'up' || s === 'info' || s === 'low') return 'up';
  return '';
}

function statusDotStatus(status: string): 'up' | 'down' | 'warning' | 'unknown' {
  const s = (status || '').toLowerCase();
  if (s === 'up' || s === 'down' || s === 'warning') return s;
  return 'unknown';
}

const ANALYSIS_BODY: React.CSSProperties = {
  fontSize: 'var(--text-base)',
  lineHeight: 1.6,
  color: 'var(--text-primary)',
  maxWidth: '70ch',
  margin: 0,
};

// ── Chart constants & helpers (module scope) ───────────────────
const CHART_HEIGHT = 230;
const COLOR_RESPONSE = '#C8102E'; // crimson

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

// ── Response-time chart (module-scope component) ───────────────
function ResponseTimeChart({ data }: { data: ScalarPoint[] }) {
  if (!seriesHasAny(data, ['response_ms'])) return null;
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>Response time (ms)</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={data} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
          <YAxis fontSize={11} width={44} stroke="var(--text-muted)" />
          <Tooltip
            {...TOOLTIP_STYLE}
            labelFormatter={tickLabel}
            formatter={(v: any) => [v == null ? '—' : `${v} ms`, 'Response']}
          />
          <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
          <Line type="monotone" name="Response" dataKey="response_ms" stroke={COLOR_RESPONSE} strokeWidth={2} dot={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Metric charts section (module-scope component) ─────────────
function ServiceMetricCharts({ data, selectedMetrics }: { data: ServiceDetail; selectedMetrics?: string[] }) {
  const series = data.series || null;
  const scalar = (series && Array.isArray(series.scalar)) ? series.scalar : [];

  const showResponse = wantsMetric(selectedMetrics, 'response_time') && seriesHasAny(scalar, ['response_ms']);
  if (!showResponse) return null;

  return <ResponseTimeChart data={scalar} />;
}

// ── Loading skeleton (module scope) ────────────────────────────
function ServiceReportSkeleton() {
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
const EMPTY_AVAIL = {
  uptime_pct: null, total_checks: 0, failed_checks: 0, up_checks: 0, down_checks: 0,
  warning_checks: 0, downtime_minutes: 0,
};
const EMPTY_RESPONSE = { avg_ms: null, min_ms: null, max_ms: null, p95_ms: null };

// ── Main report ────────────────────────────────────────────────
export default function ServiceDetailReport({ data, selectedMetrics }: { data?: ServiceDetail | null; selectedMetrics?: string[] }) {
  // The parent fetch may still be in flight (or a template switch may briefly
  // hand us the previous report's payload). Guard until a real service payload
  // is present rather than crashing on undefined sub-objects.
  if (!data || !data.service) return <ServiceReportSkeleton />;

  const service = data.service;
  const availability = data.availability || EMPTY_AVAIL;
  const response = data.response || EMPTY_RESPONSE;
  const alerts = data.alerts || [];
  const status_by_day = data.status_by_day || [];
  const analysis = (data.analysis || '').trim();

  const subline = [service.type ? service.type.toUpperCase() : null, service.target, service.site, service.agent_name ? `Agent: ${service.agent_name}` : 'Central']
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1. Service header */}
      <div className="sv-panel" style={{ ...PANEL, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <StatusDot status={statusDotStatus(service.current_status)} size={14} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{service.name}</h2>
            <div className="sv-muted" style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>{subline || '—'}</div>
          </div>
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

      {/* 2b. Service analysis (auto-generated interpretation of the numbers above) */}
      {analysis && (
        <div className="sv-panel" style={PANEL}>
          <h3 style={SECTION_TITLE}>Service analysis</h3>
          <p style={ANALYSIS_BODY}>{analysis}</p>
        </div>
      )}

      {/* 3. 90-day status calendar */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>90-day status history</h3>
        {status_by_day.length === 0 ? (
          <div className="sv-muted">No status data in this period.</div>
        ) : (
          <div className="sv-uptime-cal">
            {status_by_day.map((d, i) => (
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

      {/* 4. Status & response summary */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Status &amp; response time</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th style={TH}>Metric</th>
              <th style={TH}>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={TD}>Total checks</td><td style={TD}>{dash(availability.total_checks)}</td></tr>
            <tr><td style={TD}>Up checks</td><td style={TD}>{dash(availability.up_checks)}</td></tr>
            <tr><td style={TD}>Down checks</td><td style={TD}>{dash(availability.down_checks)}</td></tr>
            <tr><td style={TD}>Warning checks</td><td style={TD}>{dash(availability.warning_checks)}</td></tr>
            <tr><td style={TD}>Avg response (ms)</td><td style={TD}>{dash(response.avg_ms)}</td></tr>
            <tr><td style={TD}>Min response (ms)</td><td style={TD}>{dash(response.min_ms)}</td></tr>
            <tr><td style={TD}>Max response (ms)</td><td style={TD}>{dash(response.max_ms)}</td></tr>
            <tr><td style={TD}>P95 response (ms)</td><td style={TD}>{dash(response.p95_ms)}</td></tr>
          </tbody>
        </table>
      </div>

      {/* 4b. Response-time trend chart */}
      <ServiceMetricCharts data={data} selectedMetrics={selectedMetrics} />

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
    </div>
  );
}

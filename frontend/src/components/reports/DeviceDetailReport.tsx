'use client';

import Link from 'next/link';
import { StatusDot } from '@/components/StatusDot';
import { GradeBadge } from '@/components/intel';
import { fmtTime, Skeleton, CardSkeleton } from '@/components/ui';

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

// ── Shared REPORT OUTPUT style constants (module scope) ─────────
const SECTION_TITLE: React.CSSProperties = {
  fontSize: 12,
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  letterSpacing: '0.06em',
  margin: '0 0 8px',
};
const PANEL: React.CSSProperties = { padding: 16 };
const STAT_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
  alignItems: 'stretch',
};
const STAT_CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderLeftWidth: 3,
  borderLeftColor: 'var(--text-muted)',
  borderRadius: 'var(--radius-sm)',
  padding: '12px 16px',
  minHeight: 75,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
};
const STAT_VALUE: React.CSSProperties = { fontSize: 24, fontWeight: 800, lineHeight: 1.1 };
const STAT_LABEL: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  letterSpacing: '0.04em',
  marginTop: 4,
};
const TH: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  padding: '8px 12px',
  textAlign: 'left',
};
const TD: React.CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-primary)',
  padding: '8px 12px',
  height: 36,
};

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
export default function DeviceDetailReport({ data }: { data?: DeviceDetail | null }) {
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

  const subline = [device.ip, device.type, device.site, device.vendor]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1. Device header */}
      <div className="sv-panel" style={{ ...PANEL, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <StatusDot status="up" size={14} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{device.name}</h2>
            <div className="sv-muted" style={{ fontSize: 12, marginTop: 2 }}>{subline || '—'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'right' }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }} className="sv-muted">
              Health score
            </div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {health.score === null ? '—' : Math.round(health.score)}
            </div>
          </div>
          <GradeBadge grade={health.grade} />
        </div>
      </div>

      {/* 2. Stat cards */}
      <div style={STAT_GRID}>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>{availability.uptime_pct === null ? '—' : `${availability.uptime_pct}%`}</div>
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

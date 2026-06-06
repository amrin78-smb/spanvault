'use client';

import Link from 'next/link';
import { StatusDot } from '@/components/StatusDot';
import { GradeBadge } from '@/components/intel';
import { fmtTime, fmtRel } from '@/components/ui';

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

// ── Main report ────────────────────────────────────────────────
export default function DeviceDetailReport({ data }: { data: DeviceDetail }) {
  const { device, availability, response, health, baseline, alerts, uptime_by_day, snmp_summary, topology } = data;

  const subline = [device.ip, device.type, device.site, device.vendor]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1. Device header */}
      <div className="sv-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <StatusDot status="up" size={14} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>{device.name}</h2>
            <div className="sv-muted" style={{ fontSize: 13, marginTop: 2 }}>{subline || '—'}</div>
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
      <div className="sv-cards">
        <div className="sv-card up">
          <div className="num">{availability.uptime_pct === null ? '—' : `${availability.uptime_pct}%`}</div>
          <div className="label">Uptime</div>
        </div>
        <div className="sv-card">
          <div className="num">{response.avg_ms === null ? '—' : `${response.avg_ms} ms`}</div>
          <div className="label">Avg Response</div>
        </div>
        <div className="sv-card warning">
          <div className="num">{alerts.length}</div>
          <div className="label">Total Alerts</div>
        </div>
        <div className="sv-card down">
          <div className="num">{`${availability.downtime_minutes} min`}</div>
          <div className="label">Downtime</div>
        </div>
      </div>

      {/* 3. 90-day availability calendar */}
      <div className="sv-panel">
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>90-day availability</h3>
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
      <div className="sv-panel">
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>Response time</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Avg (ms)</td><td>{dash(response.avg_ms)}</td></tr>
            <tr><td>Min (ms)</td><td>{dash(response.min_ms)}</td></tr>
            <tr><td>Max (ms)</td><td>{dash(response.max_ms)}</td></tr>
            <tr><td>P95 (ms)</td><td>{dash(response.p95_ms)}</td></tr>
            <tr>
              <td>Baseline (mean / p95 ms)</td>
              <td>{`${dash(baseline.mean_ms)} / ${dash(baseline.p95_ms)}`}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 5. Alert history */}
      <div className="sv-panel">
        <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>Alert history</h3>
        {alerts.length === 0 ? (
          <div className="sv-muted">No alerts in this period.</div>
        ) : (
          <table className="sv-table">
            <thead>
              <tr>
                <th>Triggered</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Message</th>
                <th>Duration</th>
                <th>Status</th>
                <th>Ack&apos;d by</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>{fmtTime(a.triggered_at)}</td>
                  <td>{a.alert_type}</td>
                  <td><span className={`sv-badge ${sevClass(a.severity)}`}>{a.severity}</span></td>
                  <td>{a.message}</td>
                  <td>{`${a.duration_minutes} min`}</td>
                  <td>{a.status}</td>
                  <td>{a.acknowledged_by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 6. SNMP metrics */}
      {snmp_summary.length > 0 && (
        <div className="sv-panel">
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>SNMP metrics</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th>Sensor</th>
                <th>Current</th>
                <th>Baseline</th>
              </tr>
            </thead>
            <tbody>
              {snmp_summary.map((s, i) => (
                <tr key={`${s.sensor_name}-${s.metric_name}-${i}`}>
                  <td>{s.sensor_name}</td>
                  <td>{dash(s.current_value)}</td>
                  <td>{dash(s.baseline_mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 7. Connected devices (topology) */}
      {topology.length > 0 && (
        <div className="sv-panel">
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>Connected devices</h3>
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

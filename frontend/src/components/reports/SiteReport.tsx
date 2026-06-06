'use client';

import { useState } from 'react';
import { GradeBadge } from '@/components/intel';

// ── Data shape (mirrors GET /api/reports/site-summary) ─────────
export type SiteDeviceRow = {
  name: string;
  ip: string;
  device_type: string | null;
  uptime_pct: number | null;
  avg_response_ms: number | null;
  alerts_count: number;
  sla_met: boolean;
  health_score: number | null;
  health_grade: string | null;
  downtime_minutes: number;
};
export type SiteSummary = {
  site_name: string;
  period: string;
  sla_target: number;
  devices: SiteDeviceRow[];
  summary: {
    total: number;
    up: number;
    down: number;
    avg_uptime: number | null;
    total_alerts: number;
  };
  top_issue: { name: string; uptime_pct: number | null } | null;
};

// ── Sort keys (module scope, never nested) ─────────────────────
type SortKey =
  | 'name'
  | 'device_type'
  | 'ip'
  | 'uptime_pct'
  | 'avg_response_ms'
  | 'alerts_count'
  | 'sla_met'
  | 'health_grade';
type SortDir = 'asc' | 'desc';

const NUMERIC_KEYS: SortKey[] = ['uptime_pct', 'avg_response_ms', 'alerts_count'];

// ── Helpers (module scope) ─────────────────────────────────────
function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || isNaN(Number(v))) return '—';
  return Number(v).toFixed(digits);
}

function uptimeBarColor(pct: number | null): string {
  if (pct == null) return '#94a3b8';
  if (pct >= 99) return '#15803d'; // green
  if (pct >= 95) return '#b45309'; // yellow/amber
  return '#b91c1c'; // red
}

function sortValue(row: SiteDeviceRow, key: SortKey): number | string {
  switch (key) {
    case 'name': return (row.name || '').toLowerCase();
    case 'device_type': return (row.device_type || '').toLowerCase();
    case 'ip': return (row.ip || '').toLowerCase();
    case 'uptime_pct': return row.uptime_pct == null ? -Infinity : Number(row.uptime_pct);
    case 'avg_response_ms': return row.avg_response_ms == null ? Infinity : Number(row.avg_response_ms);
    case 'alerts_count': return Number(row.alerts_count ?? 0);
    case 'sla_met': return row.sla_met ? 1 : 0;
    case 'health_grade': return (row.health_grade || 'ZZ').toUpperCase();
    default: return 0;
  }
}

const TH_RIGHT: React.CSSProperties = { textAlign: 'right' };
const TD_RIGHT: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export default function SiteReport({ data }: { data: SiteSummary }) {
  const [sortKey, setSortKey] = useState<SortKey>('uptime_pct');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  if (!data) return null;

  const devices = data.devices || [];
  const summary = data.summary || ({} as Partial<SiteSummary['summary']>);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(NUMERIC_KEYS.includes(key) ? 'asc' : 'asc');
    }
  }

  const rows = [...(data.devices || [])].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const columns: { key: SortKey; label: string; numeric?: boolean }[] = [
    { key: 'name', label: 'Device' },
    { key: 'device_type', label: 'Type' },
    { key: 'ip', label: 'IP' },
    { key: 'uptime_pct', label: 'Uptime %', numeric: true },
    { key: 'avg_response_ms', label: 'Avg ms', numeric: true },
    { key: 'alerts_count', label: 'Alerts', numeric: true },
    { key: 'sla_met', label: 'SLA' },
    { key: 'health_grade', label: 'Grade' },
  ];

  const sortIndicator = (key: SortKey) =>
    key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div>
      {/* 1. Site header */}
      <h2 style={{ margin: '0 0 4px' }}>{data.site_name ?? '—'}</h2>
      <div className="sv-muted" style={{ marginBottom: 16 }}>
        {summary.total ?? 0} devices · {fmtNum(summary.avg_uptime, 2)}% overall uptime ·{' '}
        {summary.total_alerts ?? 0} alerts
      </div>

      <div className="sv-cards" style={{ marginBottom: 20 }}>
        <div className="sv-card total">
          <div className="sv-muted">Devices</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.total ?? 0}</div>
        </div>
        <div className="sv-card up">
          <div className="sv-muted">Up</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.up ?? 0}</div>
        </div>
        <div className="sv-card down">
          <div className="sv-muted">Down</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{summary.down ?? 0}</div>
        </div>
        <div className="sv-card warning">
          <div className="sv-muted">Overall Uptime %</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{fmtNum(summary.avg_uptime, 2)}%</div>
        </div>
      </div>

      {/* 2. Devices table */}
      <div className="sv-panel">
        <table className="sv-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  style={{
                    cursor: 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                    ...(c.numeric ? TH_RIGHT : {}),
                  }}
                  title={`Sort by ${c.label}`}
                >
                  {c.label}
                  {sortIndicator(c.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const barColor = uptimeBarColor(d.uptime_pct);
              const barWidth = d.uptime_pct != null ? Math.max(0, Math.min(100, d.uptime_pct)) : 0;
              return (
                <tr
                  key={`${d.ip}-${d.name}-${i}`}
                  style={!d.sla_met ? { background: 'rgba(200,16,46,0.06)' } : undefined}
                >
                  <td>{d.name ?? '—'}</td>
                  <td>{d.device_type || '—'}</td>
                  <td>{d.ip ?? '—'}</td>
                  <td style={TD_RIGHT}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                      <span style={{ minWidth: 48, textAlign: 'right' }}>
                        {d.uptime_pct != null ? `${fmtNum(d.uptime_pct, 2)}%` : '—'}
                      </span>
                      <span
                        aria-hidden="true"
                        style={{
                          display: 'inline-block',
                          width: 70,
                          height: 6,
                          borderRadius: 4,
                          background: '#e2e8f0',
                          overflow: 'hidden',
                          flex: '0 0 auto',
                        }}
                      >
                        <span
                          style={{
                            display: 'block',
                            width: `${barWidth}%`,
                            height: '100%',
                            background: barColor,
                            borderRadius: 4,
                          }}
                        />
                      </span>
                    </div>
                  </td>
                  <td style={TD_RIGHT}>{fmtNum(d.avg_response_ms, 1)}</td>
                  <td style={TD_RIGHT}>{d.alerts_count ?? 0}</td>
                  <td>
                    <span className={`sv-badge ${d.sla_met ? 'up' : 'down'}`}>
                      {d.sla_met ? '✓ MET' : '✗ FAILED'}
                    </span>
                  </td>
                  <td>
                    <GradeBadge grade={d.health_grade} />
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="sv-muted" style={{ textAlign: 'center', padding: 16 }}>
                  No devices.
                </td>
              </tr>
            )}
          </tbody>
          {/* 3. Summary footer */}
          <tfoot>
            <tr style={{ fontWeight: 700, borderTop: '2px solid #e2e8f0' }}>
              <td>Total: {summary.total ?? 0}</td>
              <td />
              <td />
              <td style={TD_RIGHT}>{fmtNum(summary.avg_uptime, 2)}% avg</td>
              <td />
              <td style={TD_RIGHT}>{summary.total_alerts ?? 0}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

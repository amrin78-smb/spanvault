'use client';

import { useState } from 'react';
import { GradeBadge } from '@/components/intel';

type NetworkSummary = {
  generated_at: string;
  period: string;
  overall_health: { score: number | null; grade: string | null; trend: string | null };
  sites: {
    site_name: string;
    devices: number;
    up: number;
    down: number;
    warning: number;
    uptime_pct: number | null;
    avg_response_ms: number | null;
    alerts_count: number;
    grade: string | null;
  }[];
  totals: {
    devices: number;
    up: number;
    down: number;
    uptime_pct: number | null;
    total_alerts: number;
    avg_response_ms: number | null;
    mttr_minutes: number | null;
  };
  top_issues: {
    device_id: number;
    device_name: string;
    site_name: string;
    uptime_pct: number | null;
    downtime_minutes: number;
  }[];
  top_alerts: {
    device_id: number;
    device_name: string;
    site_name: string;
    alerts_count: number;
  }[];
};

type SiteRow = NetworkSummary['sites'][number];
type SortKey = keyof SiteRow;
type SortDir = 'asc' | 'desc';

const SITE_COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'site_name', label: 'Site', numeric: false },
  { key: 'devices', label: 'Devices', numeric: true },
  { key: 'up', label: 'Up', numeric: true },
  { key: 'down', label: 'Down', numeric: true },
  { key: 'uptime_pct', label: 'Uptime %', numeric: true },
  { key: 'avg_response_ms', label: 'Avg ms', numeric: true },
  { key: 'alerts_count', label: 'Alerts', numeric: true },
  { key: 'grade', label: 'Grade', numeric: false },
];

const GRADES = ['A', 'B', 'C', 'D', 'F'];

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return String(Math.round(v * 100) / 100);
}

function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '0';
  return String(v);
}

function uptimeColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return '#9ca3af';
  if (pct >= 99) return '#16a34a';
  if (pct >= 95) return '#eab308';
  return '#dc2626';
}

function compareSites(a: SiteRow, b: SiteRow, key: SortKey, dir: SortDir): number {
  const av = a[key];
  const bv = b[key];
  let cmp: number;
  if (av === null || av === undefined) {
    if (bv === null || bv === undefined) cmp = 0;
    else cmp = -1;
  } else if (bv === null || bv === undefined) {
    cmp = 1;
  } else if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  return dir === 'asc' ? cmp : -cmp;
}

export default function NetworkSummaryReport({ data }: { data: NetworkSummary }) {
  const [sortKey, setSortKey] = useState<SortKey>('uptime_pct');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sortedSites = [...data.sites].sort((a, b) => compareSites(a, b, sortKey, sortDir));

  const gradeCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const s of data.sites) {
    if (s.grade && Object.prototype.hasOwnProperty.call(gradeCounts, s.grade)) {
      gradeCounts[s.grade] += 1;
    }
  }

  return (
    <div>
      {/* 1. Headline stat cards */}
      <div className="sv-cards">
        <div className="sv-card total">
          <div className="num">{fmtCount(data.totals.devices)}</div>
          <div className="label">Total Devices</div>
        </div>
        <div className="sv-card up">
          <div className="num">{fmtNum(data.totals.uptime_pct)}%</div>
          <div className="label">Overall Uptime</div>
        </div>
        <div className="sv-card warning">
          <div className="num">{fmtCount(data.totals.total_alerts)}</div>
          <div className="label">Total Alerts</div>
        </div>
        <div className="sv-card">
          <div className="num">{fmtNum(data.totals.avg_response_ms)} ms</div>
          <div className="label">Avg Response</div>
        </div>
        <div className="sv-card">
          <div className="num">{fmtNum(data.totals.mttr_minutes)} min</div>
          <div className="label">Avg MTTR</div>
        </div>
      </div>

      {/* 2. Sites comparison table */}
      <div className="sv-panel" style={{ marginTop: 24 }}>
        <h3 style={{ marginTop: 0 }}>Sites</h3>
        <table className="sv-table">
          <thead>
            <tr>
              {SITE_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => onSort(col.key)}
                  style={{
                    cursor: 'pointer',
                    textAlign: col.numeric ? 'right' : 'left',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col.label}
                  {sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedSites.map((s, i) => (
              <tr key={`${s.site_name}-${i}`}>
                <td>{s.site_name}</td>
                <td style={{ textAlign: 'right' }}>{fmtCount(s.devices)}</td>
                <td style={{ textAlign: 'right' }}>{fmtCount(s.up)}</td>
                <td style={{ textAlign: 'right' }}>{fmtCount(s.down)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(s.uptime_pct)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNum(s.avg_response_ms)}</td>
                <td style={{ textAlign: 'right' }}>{fmtCount(s.alerts_count)}</td>
                <td>
                  <GradeBadge grade={s.grade} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 3. Top Issues */}
      <div className="sv-panel" style={{ marginTop: 24 }}>
        <h3 style={{ marginTop: 0 }}>Top Issues</h3>
        {data.top_issues.length === 0 ? (
          <div className="sv-muted">No issues in this period.</div>
        ) : (
          data.top_issues.slice(0, 5).map((issue) => {
            const pct = issue.uptime_pct;
            const width = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
            return (
              <div
                key={issue.device_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 0',
                  borderBottom: '1px solid #e5e7eb',
                }}
              >
                <div style={{ flex: '0 0 220px', minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{issue.device_name}</span>{' '}
                  <span className="sv-muted">· {issue.site_name}</span>
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 12,
                    background: '#e5e7eb',
                    borderRadius: 6,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${width}%`,
                      height: '100%',
                      background: uptimeColor(pct),
                    }}
                  />
                </div>
                <div style={{ flex: '0 0 90px', textAlign: 'right' }}>
                  {fmtNum(pct)}%
                </div>
                <div style={{ flex: '0 0 110px', textAlign: 'right' }} className="sv-muted">
                  {fmtCount(issue.downtime_minutes)} min down
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 4. Health grade distribution */}
      <div className="sv-panel" style={{ marginTop: 24 }}>
        <h3 style={{ marginTop: 0 }}>Health Grade Distribution</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {GRADES.map((g) => (
            <span key={g} className="sv-badge">
              {g}: {gradeCounts[g]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

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
};
const TD: React.CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-primary)',
  padding: '8px 12px',
  height: 36,
};

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

  if (!data) return null;

  const totals = data.totals || ({} as Partial<NetworkSummary['totals']>);
  const sites = data.sites || [];
  const topIssues = data.top_issues || [];

  const sortedSites = [...sites].sort((a, b) => compareSites(a, b, sortKey, sortDir));

  const gradeCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const s of sites) {
    if (s && s.grade && Object.prototype.hasOwnProperty.call(gradeCounts, s.grade)) {
      gradeCounts[s.grade] = Number(gradeCounts[s.grade] || 0) + 1;
    }
  }

  return (
    <div>
      {/* 1. Headline stat cards */}
      <div style={STAT_GRID}>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--primary)' }}>
          <div style={STAT_VALUE}>{fmtCount(totals.devices ?? 0)}</div>
          <div style={STAT_LABEL}>Total Devices</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>{fmtNum(totals.uptime_pct ?? null)}%</div>
          <div style={STAT_LABEL}>Overall Uptime</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--yellow)' }}>
          <div style={STAT_VALUE}>{fmtCount(totals.total_alerts ?? 0)}</div>
          <div style={STAT_LABEL}>Total Alerts</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{fmtNum(totals.avg_response_ms ?? null)} ms</div>
          <div style={STAT_LABEL}>Avg Response</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{fmtNum(totals.mttr_minutes ?? null)} min</div>
          <div style={STAT_LABEL}>Avg MTTR</div>
        </div>
      </div>

      {/* 2. Sites comparison table */}
      <div className="sv-panel" style={{ ...PANEL, marginTop: 16 }}>
        <h3 style={SECTION_TITLE}>Sites</h3>
        <table className="sv-table">
          <thead>
            <tr>
              {SITE_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => onSort(col.key)}
                  style={{
                    ...TH,
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
                <td style={TD}>{s.site_name}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.devices)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.up)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.down)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtNum(s.uptime_pct)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtNum(s.avg_response_ms)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.alerts_count)}</td>
                <td style={TD}>
                  <GradeBadge grade={s.grade} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 3. Top Issues */}
      <div className="sv-panel" style={{ ...PANEL, marginTop: 16 }}>
        <h3 style={SECTION_TITLE}>Top Issues</h3>
        {topIssues.length === 0 ? (
          <div className="sv-muted">No issues in this period.</div>
        ) : (
          topIssues.slice(0, 5).map((issue) => {
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
                  borderBottom: '1px solid var(--border-light)',
                }}
              >
                <div style={{ flex: '0 0 220px', minWidth: 0, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600 }}>{issue.device_name}</span>{' '}
                  <span className="sv-muted">· {issue.site_name}</span>
                </div>
                <div
                  style={{
                    flex: 1,
                    height: 4,
                    background: 'var(--border)',
                    borderRadius: 2,
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
                <div style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 12.5 }}>
                  {fmtNum(pct)}%
                </div>
                <div style={{ flex: '0 0 110px', textAlign: 'right', fontSize: 12.5 }} className="sv-muted">
                  {fmtCount(issue.downtime_minutes)} min down
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 4. Health grade distribution */}
      <div className="sv-panel" style={{ ...PANEL, marginTop: 16 }}>
        <h3 style={SECTION_TITLE}>Health Grade Distribution</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {GRADES.map((g) => (
            <span key={g} className="sv-badge">
              {g}: {Number(gradeCounts[g] ?? 0)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

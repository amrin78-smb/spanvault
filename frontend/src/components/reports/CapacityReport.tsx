'use client';

type CapacityRow = {
  device_name: string;
  site_name: string;
  interface: string;
  avg_in_mbps: number | null;
  avg_out_mbps: number | null;
  peak_in_mbps: number | null;
  peak_out_mbps: number | null;
  trend_in: 'increasing' | 'stable' | 'decreasing';
  proj_30d_in: number;
  proj_60d_in: number;
  proj_90d_in: number;
  utilization_pct: number | null;
};

function fmtMbps(value: number | null): string {
  if (value == null) return '—';
  return `${value.toFixed(2)} Mbps`;
}

function trendCell(trend: CapacityRow['trend_in']) {
  if (trend === 'increasing') {
    return <span style={{ color: 'var(--primary)', fontWeight: 600 }}>↑ increasing</span>;
  }
  if (trend === 'decreasing') {
    return <span className="sv-muted">↓ decreasing</span>;
  }
  return <span style={{ color: 'var(--sv-up)', fontWeight: 600 }}>→ stable</span>;
}

function isAtRisk(row: CapacityRow): boolean {
  if (row.utilization_pct != null && row.utilization_pct >= 80) return true;
  if (row.trend_in === 'increasing' && (row.proj_90d_in || 0) > (row.avg_in_mbps || 0) * 1.5) return true;
  return false;
}

// ── Shared REPORT OUTPUT style constants (module scope) ─────────
const PANEL: React.CSSProperties = { padding: 16 };
const TH: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  padding: '8px 12px',
  textAlign: 'left',
};
const TD: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--text-primary)',
  padding: '8px 12px',
  height: 36,
};
const NUM_TH: React.CSSProperties = { ...TH, textAlign: 'right' };
const NUM_COL: React.CSSProperties = {
  ...TD,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

export default function CapacityReport({ data }: { data: CapacityRow[] }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <div className="sv-panel" style={PANEL}>
      <table className="sv-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={TH}>Device</th>
            <th style={TH}>Interface</th>
            <th style={NUM_TH}>Avg In</th>
            <th style={NUM_TH}>Avg Out</th>
            <th style={NUM_TH}>Peak (In/Out)</th>
            <th style={TH}>Trend</th>
            <th style={NUM_TH}>30d</th>
            <th style={NUM_TH}>60d</th>
            <th style={NUM_TH}>90d</th>
            <th style={TH}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const atRisk = isAtRisk(row);
            return (
              <tr key={`${row.device_name}-${row.interface}-${index}`}>
                <td style={TD}>
                  {row.device_name || '—'}
                  {row.site_name ? (
                    <div className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>{row.site_name}</div>
                  ) : null}
                </td>
                <td style={TD}>{row.interface || '—'}</td>
                <td style={NUM_COL}>{fmtMbps(row.avg_in_mbps)}</td>
                <td style={NUM_COL}>{fmtMbps(row.avg_out_mbps)}</td>
                <td style={NUM_COL}>
                  {fmtMbps(row.peak_in_mbps)} / {fmtMbps(row.peak_out_mbps)}
                </td>
                <td style={TD}>{trendCell(row.trend_in)}</td>
                <td style={NUM_COL}>{fmtMbps(row.proj_30d_in)}</td>
                <td style={NUM_COL}>{fmtMbps(row.proj_60d_in)}</td>
                <td style={NUM_COL}>{fmtMbps(row.proj_90d_in)}</td>
                <td style={TD}>
                  {atRisk ? (
                    <span className="sv-badge down">At Risk</span>
                  ) : (
                    <span className="sv-badge up">OK</span>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="sv-muted" style={{ textAlign: 'center', padding: 24 }}>
                No bandwidth data.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

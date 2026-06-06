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
    return <span style={{ color: '#C8102E', fontWeight: 600 }}>↑ increasing</span>;
  }
  if (trend === 'decreasing') {
    return <span className="sv-muted">↓ decreasing</span>;
  }
  return <span style={{ color: 'var(--sv-up)', fontWeight: 600 }}>→ stable</span>;
}

function isAtRisk(row: CapacityRow): boolean {
  if (row.utilization_pct != null && row.utilization_pct >= 80) return true;
  if (row.trend_in === 'increasing' && row.proj_90d_in > (row.avg_in_mbps || 0) * 1.5) return true;
  return false;
}

const NUM_COL: React.CSSProperties = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

export default function CapacityReport({ data }: { data: CapacityRow[] }) {
  return (
    <div className="sv-panel">
      <table className="sv-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Device</th>
            <th>Interface</th>
            <th style={NUM_COL}>Avg In</th>
            <th style={NUM_COL}>Avg Out</th>
            <th style={NUM_COL}>Peak (In/Out)</th>
            <th>Trend</th>
            <th style={NUM_COL}>30d</th>
            <th style={NUM_COL}>60d</th>
            <th style={NUM_COL}>90d</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => {
            const atRisk = isAtRisk(row);
            return (
              <tr key={`${row.device_name}-${row.interface}-${index}`}>
                <td>
                  {row.device_name || '—'}
                  {row.site_name ? (
                    <div className="sv-muted" style={{ fontSize: 12 }}>{row.site_name}</div>
                  ) : null}
                </td>
                <td>{row.interface || '—'}</td>
                <td style={NUM_COL}>{fmtMbps(row.avg_in_mbps)}</td>
                <td style={NUM_COL}>{fmtMbps(row.avg_out_mbps)}</td>
                <td style={NUM_COL}>
                  {fmtMbps(row.peak_in_mbps)} / {fmtMbps(row.peak_out_mbps)}
                </td>
                <td>{trendCell(row.trend_in)}</td>
                <td style={NUM_COL}>{fmtMbps(row.proj_30d_in)}</td>
                <td style={NUM_COL}>{fmtMbps(row.proj_60d_in)}</td>
                <td style={NUM_COL}>{fmtMbps(row.proj_90d_in)}</td>
                <td>
                  {atRisk ? (
                    <span className="sv-badge down">At Risk</span>
                  ) : (
                    <span className="sv-badge up">OK</span>
                  )}
                </td>
              </tr>
            );
          })}
          {data.length === 0 ? (
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

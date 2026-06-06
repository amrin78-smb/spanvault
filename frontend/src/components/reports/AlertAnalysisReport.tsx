'use client';

type AlertAnalysis = {
  total_alerts: number;
  by_type: { key: string; count: number }[];
  by_severity: { key: string; count: number }[];
  by_site: { key: string; count: number }[];
  by_device: {
    device_id: number;
    device_name: string;
    site_name: string;
    count: number;
    mttr_minutes: number | null;
  }[];
  top_alerted: {
    device_id: number;
    device_name: string;
    site_name: string;
    count: number;
    mttr_minutes: number | null;
  }[];
  avg_mttr_minutes: number | null;
  busiest_hour: number | null; // 0-23
  busiest_day: number | null; // 0-6, 0=Sunday
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayName(day: number | null): string {
  if (day == null || day < 0 || day > 6) return '—';
  return DAY_NAMES[day];
}

function formatHour(hour: number | null): string {
  if (hour == null || hour < 0 || hour > 23) return '—';
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatMttr(mttr: number | null): string {
  if (mttr == null) return '—';
  return String(Math.round(mttr));
}

function severityBadgeClass(key: string): string {
  const k = (key || '').toLowerCase();
  if (k === 'critical' || k === 'down' || k === 'high' || k === 'error') {
    return 'sv-badge down';
  }
  if (k === 'warning' || k === 'warn' || k === 'medium') {
    return 'sv-badge warning';
  }
  if (k === 'info' || k === 'ok' || k === 'up' || k === 'low' || k === 'resolved') {
    return 'sv-badge up';
  }
  return 'sv-badge';
}

const numCellStyle: React.CSSProperties = { textAlign: 'right' };
const sectionStyle: React.CSSProperties = { marginTop: 24 };

export default function AlertAnalysisReport({ data }: { data: AlertAnalysis }) {
  if (!data) return null;

  const topAlerted = data.top_alerted || [];
  const byDevice = data.by_device || [];
  const byType = data.by_type || [];
  const bySeverity = data.by_severity || [];
  const bySite = data.by_site || [];

  const topRows = topAlerted.length > 0 ? topAlerted : byDevice;

  const hasPattern = data.busiest_day != null && data.busiest_hour != null;

  return (
    <div className="alert-analysis-report">
      {/* 1. Summary cards */}
      <div className="sv-cards">
        <div className="sv-card warning">
          <div className="sv-muted">Total Alerts</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{data.total_alerts ?? 0}</div>
        </div>
        <div className="sv-card total">
          <div className="sv-muted">Avg MTTR</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>
            {data.avg_mttr_minutes != null ? `${Math.round(data.avg_mttr_minutes)} min` : '—'}
          </div>
        </div>
        <div className="sv-card total">
          <div className="sv-muted">Busiest Hour</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{formatHour(data.busiest_hour)}</div>
        </div>
      </div>

      {/* 2. Pattern insight banner */}
      <div
        style={{
          marginTop: 20,
          padding: '12px 16px',
          borderRadius: 6,
          background: hasPattern ? '#fff4f5' : '#f3f4f6',
          borderLeft: `4px solid ${hasPattern ? '#C8102E' : '#9ca3af'}`,
          fontSize: 14,
        }}
      >
        {hasPattern
          ? `Most alerts occur on ${dayName(data.busiest_day)} around ${formatHour(data.busiest_hour)}.`
          : 'Not enough data to detect a pattern.'}
      </div>

      {/* 3. Top alerted devices */}
      <div className="sv-panel" style={sectionStyle}>
        <h3 style={{ marginTop: 0 }}>Top Alerted Devices</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Site</th>
              <th style={numCellStyle}>Alerts</th>
              <th style={numCellStyle}>MTTR (min)</th>
            </tr>
          </thead>
          <tbody>
            {topRows && topRows.length > 0 ? (
              topRows.map((d) => (
                <tr key={d.device_id}>
                  <td>{d.device_name}</td>
                  <td>{d.site_name}</td>
                  <td style={numCellStyle}>{d.count}</td>
                  <td style={numCellStyle}>{formatMttr(d.mttr_minutes)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="sv-muted">
                  No device alert data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 4. Breakdown tables side by side */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, ...sectionStyle }}>
        <div className="sv-panel" style={{ flex: '1 1 260px', minWidth: 240 }}>
          <h3 style={{ marginTop: 0 }}>By Type</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th>Type</th>
                <th style={numCellStyle}>Count</th>
              </tr>
            </thead>
            <tbody>
              {byType.length > 0 ? (
                byType.map((t) => (
                  <tr key={t.key}>
                    <td>{t.key}</td>
                    <td style={numCellStyle}>{t.count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} className="sv-muted">
                    No data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="sv-panel" style={{ flex: '1 1 260px', minWidth: 240 }}>
          <h3 style={{ marginTop: 0 }}>By Severity</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th style={numCellStyle}>Count</th>
              </tr>
            </thead>
            <tbody>
              {bySeverity.length > 0 ? (
                bySeverity.map((s) => (
                  <tr key={s.key}>
                    <td>
                      <span className={severityBadgeClass(s.key)}>{s.key}</span>
                    </td>
                    <td style={numCellStyle}>{s.count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} className="sv-muted">
                    No data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="sv-panel" style={{ flex: '1 1 260px', minWidth: 240 }}>
          <h3 style={{ marginTop: 0 }}>By Site</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th>Site</th>
                <th style={numCellStyle}>Count</th>
              </tr>
            </thead>
            <tbody>
              {bySite.length > 0 ? (
                bySite.map((s) => (
                  <tr key={s.key}>
                    <td>{s.key}</td>
                    <td style={numCellStyle}>{s.count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} className="sv-muted">
                    No data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

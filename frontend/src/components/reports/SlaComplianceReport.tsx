'use client';

type SlaCompliance = {
  sla_target: number;
  generated_at: string;
  summary: {
    total: number;
    meeting: number;
    failing: number;
    overall_uptime_pct: number | null;
    total_downtime_minutes: number;
  };
  devices: {
    device_name: string;
    site_name: string | null;
    uptime_pct: number | null;
    downtime_minutes: number | null;
    sla_met: boolean;
  }[];
};

function fmtNum(value: number | null): string {
  return value == null ? '—' : `${value}`;
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsv(devices: SlaCompliance['devices']): string {
  const header = ['Device', 'Site', 'Uptime %', 'Downtime', 'SLA Status'];
  const rows = devices.map((d) => [
    escapeCsv(d.device_name ?? ''),
    escapeCsv(d.site_name ?? ''),
    escapeCsv(d.uptime_pct == null ? '' : String(d.uptime_pct)),
    escapeCsv(d.downtime_minutes == null ? '' : String(d.downtime_minutes)),
    escapeCsv(d.sla_met ? 'PASS' : 'FAIL'),
  ].join(','));
  return [header.map(escapeCsv).join(','), ...rows].join('\r\n');
}

export default function SlaComplianceReport({ data }: { data: SlaCompliance }) {
  const { sla_target, generated_at, summary, devices } = data;

  // Failing devices first, then by uptime ascending (worst first), preserving order otherwise.
  const sortedDevices = devices
    .map((d, index) => ({ d, index }))
    .sort((a, b) => {
      if (a.d.sla_met !== b.d.sla_met) return a.d.sla_met ? 1 : -1;
      const au = a.d.uptime_pct == null ? Infinity : a.d.uptime_pct;
      const bu = b.d.uptime_pct == null ? Infinity : b.d.uptime_pct;
      if (au !== bu) return au - bu;
      return a.index - b.index;
    })
    .map((entry) => entry.d);

  function handleExportCsv() {
    if (typeof window === 'undefined') return;
    const csv = buildCsv(devices);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sla-compliance.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h2 style={{ margin: '0 0 4px 0' }}>SLA Compliance</h2>
      {generated_at ? (
        <div className="sv-muted" style={{ marginBottom: 16, fontSize: 13 }}>
          Generated {generated_at}
        </div>
      ) : null}

      {/* 1. Prominent SLA target banner */}
      <div
        className="sv-card total"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div>
          <div className="sv-muted" style={{ fontSize: 13, fontWeight: 600 }}>
            SLA Target
          </div>
          <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1.1, color: '#C8102E' }}>
            {sla_target}%
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {summary.meeting}/{summary.total}
          </div>
          <div className="sv-muted" style={{ fontSize: 13 }}>
            devices meeting SLA
          </div>
          <div style={{ marginTop: 8, fontSize: 15, fontWeight: 600 }}>
            Overall uptime: {summary.overall_uptime_pct == null ? '—' : `${summary.overall_uptime_pct}%`}
          </div>
        </div>
      </div>

      {/* 2. Summary cards */}
      <div className="sv-cards">
        <div className="sv-card up">
          <div className="num">
            {summary.meeting}/{summary.total}
          </div>
          <div className="label">Meeting SLA</div>
        </div>
        <div className="sv-card down">
          <div className="num">{summary.failing}</div>
          <div className="label">Failing</div>
        </div>
        <div className="sv-card total">
          <div className="num">
            {summary.overall_uptime_pct == null ? '—' : `${summary.overall_uptime_pct}%`}
          </div>
          <div className="label">Overall Uptime</div>
        </div>
        <div className="sv-card warning">
          <div className="num">{summary.total_downtime_minutes} min</div>
          <div className="label">Total Downtime</div>
        </div>
      </div>

      {/* 3. Export button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0 8px 0' }}>
        <button type="button" className="sv-btn ghost sm" onClick={handleExportCsv}>
          Export CSV
        </button>
      </div>

      {/* 4. Table */}
      <div className="sv-panel">
        <table className="sv-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Device</th>
              <th>Site</th>
              <th style={{ textAlign: 'right' }}>Uptime %</th>
              <th style={{ textAlign: 'right' }}>Downtime (min)</th>
              <th>SLA Status</th>
            </tr>
          </thead>
          <tbody>
            {sortedDevices.map((d, index) => {
              const rowBg = d.sla_met ? undefined : 'rgba(200,16,46,0.06)';
              const uptimeColor = d.uptime_pct == null ? undefined : d.sla_met ? '#1a7f37' : '#C8102E';
              return (
                <tr key={`${d.device_name}-${index}`} style={rowBg ? { background: rowBg } : undefined}>
                  <td>{d.device_name || '—'}</td>
                  <td className="sv-muted">{d.site_name || '—'}</td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      color: uptimeColor,
                      fontWeight: d.uptime_pct == null ? 400 : 600,
                    }}
                  >
                    {d.uptime_pct == null ? '—' : `${d.uptime_pct}%`}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtNum(d.downtime_minutes)}
                  </td>
                  <td>
                    <span className={`sv-badge ${d.sla_met ? 'up' : 'down'}`}>
                      {d.sla_met ? '✓ PASS' : '✗ FAIL'}
                    </span>
                  </td>
                </tr>
              );
            })}
            {sortedDevices.length === 0 ? (
              <tr>
                <td colSpan={5} className="sv-muted" style={{ textAlign: 'center', padding: 24 }}>
                  No data available.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

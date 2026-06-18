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
  risk_assessment?: {
    at_risk: {
      device_name: string;
      site_name: string | null;
      uptime_pct: number;
      minutes_to_breach: number | null;
    }[];
    trends: string[];
  };
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

// ── Shared REPORT OUTPUT style constants (module scope) ─────────
const SECTION_TITLE: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
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
  marginBottom: 16,
};
const STAT_CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderLeftWidth: 3,
  borderRadius: 'var(--radius-sm)',
  padding: '12px 16px',
  minHeight: 75,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
};
const STAT_VALUE: React.CSSProperties = { fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.1 };
const STAT_LABEL: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  letterSpacing: '0.04em',
  marginTop: 4,
};
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
const numTh: React.CSSProperties = { ...TH, textAlign: 'right' };

function buildCsv(devices: SlaCompliance['devices']): string {
  const header = ['Device', 'Site', 'Uptime %', 'Downtime', 'SLA Status'];
  const rows = (devices || []).map((d) => [
    escapeCsv(d.device_name ?? ''),
    escapeCsv(d.site_name ?? ''),
    escapeCsv(d.uptime_pct == null ? '' : String(d.uptime_pct)),
    escapeCsv(d.downtime_minutes == null ? '' : String(d.downtime_minutes)),
    escapeCsv(d.sla_met ? 'PASS' : 'FAIL'),
  ].join(','));
  return [header.map(escapeCsv).join(','), ...rows].join('\r\n');
}

export default function SlaComplianceReport({ data }: { data: SlaCompliance }) {
  if (!data) return null;

  const generated_at = data.generated_at;
  const sla_target = data.sla_target ?? 99.5;
  const summary = data.summary || ({} as SlaCompliance['summary']);
  const devices = data.devices || [];
  const riskAssessment = data.risk_assessment;

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
      <h2 style={SECTION_TITLE}>SLA Compliance</h2>
      {generated_at ? (
        <div className="sv-muted" style={{ marginBottom: 12, fontSize: 'var(--text-xs)' }}>
          Generated {generated_at}
        </div>
      ) : null}

      {/* 1. Prominent SLA target banner */}
      <div
        style={{
          ...STAT_CARD,
          borderLeftColor: 'var(--primary)',
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div>
          <div style={STAT_LABEL}>SLA Target</div>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.1, color: 'var(--primary)' }}>
            {sla_target}%
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
            {summary.meeting ?? 0}/{summary.total ?? 0}
          </div>
          <div className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>
            devices meeting SLA
          </div>
          <div style={{ marginTop: 4, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
            Overall uptime: {summary.overall_uptime_pct == null ? '—' : `${summary.overall_uptime_pct}%`}
          </div>
        </div>
      </div>

      {/* 2. Summary cards */}
      <div style={STAT_GRID}>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>
            {summary.meeting ?? 0}/{summary.total ?? 0}
          </div>
          <div style={STAT_LABEL}>Meeting SLA</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--red)' }}>
          <div style={STAT_VALUE}>{summary.failing ?? 0}</div>
          <div style={STAT_LABEL}>Failing</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--primary)' }}>
          <div style={STAT_VALUE}>
            {summary.overall_uptime_pct == null ? '—' : `${summary.overall_uptime_pct}%`}
          </div>
          <div style={STAT_LABEL}>Overall Uptime</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--yellow)' }}>
          <div style={STAT_VALUE}>{summary.total_downtime_minutes ?? 0} min</div>
          <div style={STAT_LABEL}>Total Downtime</div>
        </div>
      </div>

      {/* 3. Export button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0 8px 0' }}>
        <button type="button" className="sv-btn ghost sm" onClick={handleExportCsv}>
          Export CSV
        </button>
      </div>

      {/* 4. Table */}
      <div className="sv-panel" style={PANEL}>
        <table className="sv-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={TH}>Device</th>
              <th style={TH}>Site</th>
              <th style={numTh}>Uptime %</th>
              <th style={numTh}>Downtime (min)</th>
              <th style={TH}>SLA Status</th>
            </tr>
          </thead>
          <tbody>
            {sortedDevices.map((d, index) => {
              const rowBg = d.sla_met ? undefined : 'rgba(200,16,46,0.06)';
              const uptimeColor = d.uptime_pct == null ? undefined : d.sla_met ? '#1a7f37' : '#C8102E';
              return (
                <tr key={`${d.device_name}-${index}`} style={rowBg ? { background: rowBg } : undefined}>
                  <td style={TD}>{d.device_name || '—'}</td>
                  <td style={TD} className="sv-muted">{d.site_name || '—'}</td>
                  <td
                    style={{
                      ...TD,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      color: uptimeColor,
                      fontWeight: d.uptime_pct == null ? 400 : 600,
                    }}
                  >
                    {d.uptime_pct == null ? '—' : `${d.uptime_pct}%`}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtNum(d.downtime_minutes)}
                  </td>
                  <td style={TD}>
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

      {/* 5. Risk Assessment */}
      {riskAssessment ? (
        <div className="sv-panel" style={{ ...PANEL, marginTop: 16 }}>
          <h3 style={SECTION_TITLE}>Risk Assessment</h3>
          {(() => {
            const atRisk = riskAssessment.at_risk || [];
            const trends = riskAssessment.trends || [];
            if (atRisk.length === 0 && trends.length === 0) {
              return (
                <div className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
                  No SLA risks detected — all devices have comfortable headroom.
                </div>
              );
            }
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {atRisk.map((r, index) => (
                  <div key={`at-risk-${r.device_name}-${index}`} style={{ fontSize: 'var(--text-sm)' }}>
                    <span style={{ color: 'var(--yellow)', fontWeight: 700, marginRight: 6 }}>⚠</span>
                    At Risk: <strong>{r.device_name}</strong>
                    {r.site_name ? (
                      <span className="sv-muted"> ({r.site_name})</span>
                    ) : null}{' '}
                    at {r.uptime_pct}%
                    {r.minutes_to_breach != null
                      ? ` — ${r.minutes_to_breach} minutes from SLA breach`
                      : ''}
                  </div>
                ))}
                {trends.map((t, index) => (
                  <div key={`trend-${index}`} style={{ fontSize: 'var(--text-sm)' }}>
                    <span className="sv-muted" style={{ marginRight: 6 }}>›</span>
                    {t}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}

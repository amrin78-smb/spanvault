'use client';

import { SECTION_TITLE, PANEL, STAT_GRID, STAT_CARD, STAT_VALUE, STAT_LABEL, TH, TD } from '@/components/reports/reportStyles';

// Estate-wide: an alerted entity is either a device (alerts.device_id) or a
// service check (alerts.service_check_id) — `source` distinguishes which;
// exactly one of device_id/service_check_id is set per row (mirrors the
// LEFT JOIN in GET /api/reports/alert-analysis).
type AlertedEntity = {
  device_id: number | null;
  service_check_id: number | null;
  device_name: string;
  site_name: string;
  source: 'device' | 'service';
  count: number;
  mttr_minutes: number | null;
};
type AlertAnalysis = {
  total_alerts: number;
  by_type: { key: string; count: number }[];
  by_severity: { key: string; count: number }[];
  by_site: { key: string; count: number }[];
  by_device: AlertedEntity[];
  top_alerted: AlertedEntity[];
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

const numCellStyle: React.CSSProperties = { ...TD, textAlign: 'right' };
const numThStyle: React.CSSProperties = { ...TH, textAlign: 'right' };
const sectionStyle: React.CSSProperties = { marginTop: 16 };

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
      <div style={STAT_GRID}>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--yellow)' }}>
          <div style={STAT_LABEL}>Total Alerts</div>
          <div style={STAT_VALUE}>{data.total_alerts ?? 0}</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--primary)' }}>
          <div style={STAT_LABEL}>Avg MTTR</div>
          <div style={STAT_VALUE}>
            {data.avg_mttr_minutes != null ? `${Math.round(data.avg_mttr_minutes)} min` : '—'}
          </div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--primary)' }}>
          <div style={STAT_LABEL}>Busiest Hour</div>
          <div style={STAT_VALUE}>{formatHour(data.busiest_hour)}</div>
        </div>
      </div>

      {/* 2. Pattern insight banner */}
      <div
        style={{
          marginTop: 16,
          padding: '12px 16px',
          borderRadius: 'var(--radius-sm)',
          background: hasPattern ? 'var(--primary-light)' : 'var(--bg-primary)',
          borderLeft: `3px solid ${hasPattern ? 'var(--primary)' : 'var(--text-muted)'}`,
          fontSize: 'var(--text-sm)',
        }}
      >
        {hasPattern
          ? `Most alerts occur on ${dayName(data.busiest_day)} around ${formatHour(data.busiest_hour)}.`
          : 'Not enough data to detect a pattern.'}
      </div>

      {/* 3. Top alerted devices & services */}
      <div className="sv-panel" style={{ ...PANEL, ...sectionStyle }}>
        <h3 style={SECTION_TITLE}>Top Alerted</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th style={TH}>Name</th>
              <th style={TH}>Type</th>
              <th style={TH}>Site</th>
              <th style={numThStyle}>Alerts</th>
              <th style={numThStyle}>MTTR (min)</th>
            </tr>
          </thead>
          <tbody>
            {topRows && topRows.length > 0 ? (
              topRows.map((d) => (
                <tr key={`${d.source}-${d.device_id ?? d.service_check_id}`}>
                  <td style={TD}>{d.device_name}</td>
                  <td style={TD}>
                    <span className={d.source === 'service' ? 'sv-badge' : 'sv-badge up'}>
                      {d.source === 'service' ? 'Service' : 'Device'}
                    </span>
                  </td>
                  <td style={TD}>{d.site_name}</td>
                  <td style={numCellStyle}>{d.count}</td>
                  <td style={numCellStyle}>{formatMttr(d.mttr_minutes)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="sv-muted">
                  No alert data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 4. Breakdown tables side by side */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, ...sectionStyle }}>
        <div className="sv-panel" style={{ ...PANEL, flex: '1 1 260px', minWidth: 240 }}>
          <h3 style={SECTION_TITLE}>By Type</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Type</th>
                <th style={numThStyle}>Count</th>
              </tr>
            </thead>
            <tbody>
              {byType.length > 0 ? (
                byType.map((t) => (
                  <tr key={t.key}>
                    <td style={TD}>{t.key}</td>
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

        <div className="sv-panel" style={{ ...PANEL, flex: '1 1 260px', minWidth: 240 }}>
          <h3 style={SECTION_TITLE}>By Severity</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Severity</th>
                <th style={numThStyle}>Count</th>
              </tr>
            </thead>
            <tbody>
              {bySeverity.length > 0 ? (
                bySeverity.map((s) => (
                  <tr key={s.key}>
                    <td style={TD}>
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

        <div className="sv-panel" style={{ ...PANEL, flex: '1 1 260px', minWidth: 240 }}>
          <h3 style={SECTION_TITLE}>By Site</h3>
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Site</th>
                <th style={numThStyle}>Count</th>
              </tr>
            </thead>
            <tbody>
              {bySite.length > 0 ? (
                bySite.map((s) => (
                  <tr key={s.key}>
                    <td style={TD}>{s.key}</td>
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

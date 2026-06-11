'use client';

import { GradeBadge } from '@/components/intel';

type Executive = {
  period: string;
  generated_at: string;
  headline: string;
  overall_uptime_pct: number | null;
  total_incidents: number;
  total_downtime_minutes: number;
  sites_summary: {
    site: string;
    uptime_pct: number | null;
    health_grade: string | null;
    incidents: number;
  }[];
  biggest_incident: {
    title: string;
    duration_minutes: number | null;
    affected: number;
  } | null;
  improvement_vs_prev: { uptime_delta: number | null; alert_delta: number };
  vs_previous?: {
    uptime: { current: number | null; previous: number | null; delta: number | null };
    alerts: { current: number; previous: number; delta: number };
    incidents: { current: number; previous: number; delta: number };
  };
  recommendations: string[];
};

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
  textAlign: 'left',
};
const TD: React.CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text-primary)',
  padding: '8px 12px',
  height: 36,
};
const numCell: React.CSSProperties = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const numTh: React.CSSProperties = { ...TH, textAlign: 'right' };

function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v}%`;
}

// ── vs-previous comparison row styling/helpers (module scope) ──────
const VS_ROW: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  alignItems: 'baseline',
  gap: 12,
  padding: '8px 0',
  borderBottom: '1px solid var(--border)',
  fontVariantNumeric: 'tabular-nums',
};
const VS_LABEL: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--text-primary)',
};
const VS_VALUE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--text-primary)',
  textAlign: 'right',
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
};
const VS_DELTA: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textAlign: 'right',
  minWidth: 150,
};

// Renders the delta cell for a metric.
// `goodWhenUp` = positive delta is good (green). For alerts/incidents pass false.
function renderDelta(
  delta: number | null | undefined,
  goodWhenUp: boolean,
  unit: '%' | '',
): JSX.Element {
  if (delta === null || delta === undefined) {
    return <span style={{ ...VS_DELTA, color: 'var(--text-muted)' }}>—</span>;
  }
  const up = delta > 0;
  const flat = delta === 0;
  const isGood = flat ? true : up === goodWhenUp;
  const color = flat ? 'var(--text-muted)' : isGood ? 'var(--green)' : 'var(--primary)';
  const arrow = flat ? '→' : up ? '↑' : '↓';
  const sign = delta > 0 ? '+' : ''; // negatives carry their own minus sign
  return (
    <span style={{ ...VS_DELTA, color }}>
      ({arrow} {sign}
      {delta}
      {unit} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>vs last period</span>)
    </span>
  );
}

export default function ExecutiveSummaryReport({ data }: { data: Executive }) {
  if (!data) return null;

  const sitesSummary = data.sites_summary || [];
  const recommendations = data.recommendations || [];
  const uptimeDelta = data.improvement_vs_prev?.uptime_delta;
  const hasDelta = uptimeDelta !== null && uptimeDelta !== undefined;
  const deltaPositive = hasDelta && (uptimeDelta as number) >= 0;
  const vsPrev = data.vs_previous;

  return (
    <div>
      {/* 1. Headline */}
      <div style={{ marginBottom: 16 }}>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 700,
            lineHeight: 1.2,
            margin: 0,
            color: 'var(--text-primary)',
          }}
        >
          {data.headline || 'Network availability summary'}
        </h1>
        <div className="sv-muted" style={{ marginTop: 4, fontSize: 12 }}>
          Reporting period: {data.period || ''} · Generated{' '}
          {data.generated_at ? new Date(data.generated_at).toLocaleString() : '—'}
        </div>
      </div>

      {/* 2. KPI cards */}
      <div style={STAT_GRID}>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>{fmtPct(data.overall_uptime_pct)}</div>
          <div style={STAT_LABEL}>Overall Uptime</div>
          {hasDelta && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                fontWeight: 600,
                color: deltaPositive ? 'var(--green)' : 'var(--primary)',
              }}
            >
              {deltaPositive ? '+' : ''}
              {uptimeDelta}% vs previous period
            </div>
          )}
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--red)' }}>
          <div style={STAT_VALUE}>{data.total_incidents ?? '—'}</div>
          <div style={STAT_LABEL}>Total Incidents</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--yellow)' }}>
          <div style={STAT_VALUE}>{data.total_downtime_minutes ?? 0} min</div>
          <div style={STAT_LABEL}>Downtime</div>
        </div>
      </div>

      {/* 2b. Network performance vs previous period */}
      {vsPrev && (
        <div className="sv-panel" style={{ ...PANEL, marginBottom: 16 }}>
          <h3 style={SECTION_TITLE}>Network Performance vs Previous Period</h3>
          <div>
            <div style={VS_ROW}>
              <span style={VS_LABEL}>Uptime</span>
              <span style={VS_VALUE}>{fmtPct(vsPrev.uptime.current)}</span>
              {renderDelta(vsPrev.uptime.delta, true, '%')}
            </div>
            <div style={VS_ROW}>
              <span style={VS_LABEL}>Alerts</span>
              <span style={VS_VALUE}>{vsPrev.alerts.current}</span>
              {renderDelta(vsPrev.alerts.delta, false, '')}
            </div>
            <div style={{ ...VS_ROW, borderBottom: 'none' }}>
              <span style={VS_LABEL}>Incidents</span>
              <span style={VS_VALUE}>{vsPrev.incidents.current}</span>
              {renderDelta(vsPrev.incidents.delta, false, '')}
            </div>
          </div>
        </div>
      )}

      {/* 3. Sites table */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Sites Summary</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th style={TH}>Site</th>
              <th style={TH}>Grade</th>
              <th style={numTh}>Uptime %</th>
              <th style={numTh}>Incidents</th>
            </tr>
          </thead>
          <tbody>
            {sitesSummary.map((s, i) => (
              <tr key={`${s.site}-${i}`}>
                <td style={TD}>{s.site}</td>
                <td style={TD}>
                  <GradeBadge grade={s.health_grade} />
                </td>
                <td style={numCell}>{fmtPct(s.uptime_pct)}</td>
                <td style={numCell}>{s.incidents}</td>
              </tr>
            ))}
            {sitesSummary.length === 0 && (
              <tr>
                <td colSpan={4} className="sv-muted" style={{ textAlign: 'center' }}>
                  No site data for this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 4. Biggest incident highlight */}
      {data.biggest_incident && (
        <div
          style={{
            marginBottom: 16,
            padding: '16px 20px',
            border: '1px solid #f3b4bd',
            borderLeft: '3px solid var(--primary)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--primary-light)',
          }}
        >
          <div style={{ ...SECTION_TITLE, color: 'var(--primary)' }}>
            Biggest Incident
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            {data.biggest_incident.title}
          </div>
          <div className="sv-muted" style={{ marginTop: 4, fontSize: 12.5 }}>
            Lasted{' '}
            {data.biggest_incident.duration_minutes === null
              ? '—'
              : `${data.biggest_incident.duration_minutes} min`}{' '}
            · {data.biggest_incident.affected} device(s) affected
          </div>
        </div>
      )}

      {/* 5. Recommendations */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Recommendations</h3>
        {recommendations.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
            {recommendations.map((r, i) => (
              <li key={i} style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
                {r}
              </li>
            ))}
          </ul>
        ) : (
          <div className="sv-muted">No recommendations — network is performing well.</div>
        )}
      </div>
    </div>
  );
}

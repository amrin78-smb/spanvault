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
  recommendations: string[];
};

const numCell: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v}%`;
}

export default function ExecutiveSummaryReport({ data }: { data: Executive }) {
  const uptimeDelta = data.improvement_vs_prev?.uptime_delta;
  const hasDelta = uptimeDelta !== null && uptimeDelta !== undefined;
  const deltaPositive = hasDelta && (uptimeDelta as number) >= 0;

  return (
    <div>
      {/* 1. Headline */}
      <div style={{ marginBottom: 28 }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            lineHeight: 1.2,
            margin: 0,
            color: '#1a2744',
          }}
        >
          {data.headline}
        </h1>
        <div className="sv-muted" style={{ marginTop: 8, fontSize: 14 }}>
          Reporting period: {data.period} · Generated{' '}
          {new Date(data.generated_at).toLocaleString()}
        </div>
      </div>

      {/* 2. KPI cards */}
      <div className="sv-cards" style={{ marginBottom: 28 }}>
        <div className="sv-card up">
          <div className="num">{fmtPct(data.overall_uptime_pct)}</div>
          <div className="label">Overall Uptime</div>
          {hasDelta && (
            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                fontWeight: 600,
                color: deltaPositive ? '#16a34a' : '#C8102E',
              }}
            >
              {deltaPositive ? '+' : ''}
              {uptimeDelta}% vs previous period
            </div>
          )}
        </div>
        <div className="sv-card down">
          <div className="num">{data.total_incidents}</div>
          <div className="label">Total Incidents</div>
        </div>
        <div className="sv-card warning">
          <div className="num" style={{ fontSize: 24 }}>{data.total_downtime_minutes} min</div>
          <div className="label">Downtime</div>
        </div>
      </div>

      {/* 3. Sites table */}
      <div className="sv-panel" style={{ marginBottom: 28 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#1a2744' }}>
          Sites Summary
        </h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th>Site</th>
              <th>Grade</th>
              <th style={numCell}>Uptime %</th>
              <th style={numCell}>Incidents</th>
            </tr>
          </thead>
          <tbody>
            {data.sites_summary.map((s, i) => (
              <tr key={`${s.site}-${i}`}>
                <td>{s.site}</td>
                <td>
                  <GradeBadge grade={s.health_grade} />
                </td>
                <td style={numCell}>{fmtPct(s.uptime_pct)}</td>
                <td style={numCell}>{s.incidents}</td>
              </tr>
            ))}
            {data.sites_summary.length === 0 && (
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
            marginBottom: 28,
            padding: '16px 18px',
            border: '1px solid #f3b4bd',
            borderLeft: '4px solid #C8102E',
            borderRadius: 6,
            background: '#fdf2f4',
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: '#C8102E',
              marginBottom: 6,
            }}
          >
            Biggest Incident
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, color: '#1a2744' }}>
            {data.biggest_incident.title}
          </div>
          <div className="sv-muted" style={{ marginTop: 4, fontSize: 14 }}>
            Lasted{' '}
            {data.biggest_incident.duration_minutes === null
              ? '—'
              : `${data.biggest_incident.duration_minutes} min`}{' '}
            · {data.biggest_incident.affected} device(s) affected
          </div>
        </div>
      )}

      {/* 5. Recommendations */}
      <div className="sv-panel">
        <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700, color: '#1a2744' }}>
          Recommendations
        </h3>
        {data.recommendations.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
            {data.recommendations.map((r, i) => (
              <li key={i} style={{ fontSize: 14, color: '#1a2744' }}>
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

'use client';

import { GradeBadge } from '@/components/intel';

type WirelessOverview = {
  period: string;
  summary: {
    total_controllers: number;
    total_aps: number;
    online_aps: number;
    offline_aps: number;
    total_clients: number;
    avg_utilization: number | null;
    overall_health_score: number | null;
    overall_grade: string | null;
  };
  by_site: {
    site_name: string;
    controllers: number;
    aps: number;
    online_aps: number;
    clients: number;
    avg_utilization: number | null;
    health_grade: string | null;
  }[];
  top_aps_by_clients: {
    name: string;
    site_name: string;
    clients: number;
    util: number | null;
  }[];
  top_ssids: { ssid_name: string; client_count: number }[];
  offline_aps: { name: string; site_name: string; last_seen: string | null }[];
  high_util_aps: { name: string; site_name: string; util: number | null }[];
};

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
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: 12,
  alignItems: 'stretch',
};
const STAT_CARD: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderLeftWidth: 3,
  borderLeftColor: 'var(--text-muted)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px 14px',
  minHeight: 75,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
};
const STAT_VALUE: React.CSSProperties = { fontSize: 'var(--text-xl)', fontWeight: 800, lineHeight: 1.1 };
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

// ── Formatting helpers (module scope) ──────────────────────────
const fmtNum = (v: number | null | undefined): string =>
  v == null || Number.isNaN(Number(v)) ? '—' : String(Math.round(Number(v) * 10) / 10);

const fmtCount = (v: number | null | undefined): string =>
  v == null || Number.isNaN(Number(v)) ? '0' : String(v);

function fmtLastSeen(v: string | null | undefined): string {
  if (v == null) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function WirelessOverviewReport({ data }: { data: WirelessOverview }) {
  if (!data) return null;

  const summary = data.summary || ({} as Partial<WirelessOverview['summary']>);
  const bySite = data.by_site || [];
  const topAps = data.top_aps_by_clients || [];
  const topSsids = data.top_ssids || [];
  const offlineAps = data.offline_aps || [];

  const offlineCount = summary.offline_aps ?? 0;

  return (
    <div>
      {/* 1. Headline stat cards */}
      <div style={STAT_GRID}>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{fmtCount(summary.total_controllers ?? 0)}</div>
          <div style={STAT_LABEL}>Total Controllers</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{fmtCount(summary.total_aps ?? 0)}</div>
          <div style={STAT_LABEL}>Total APs</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>{fmtCount(summary.online_aps ?? 0)}</div>
          <div style={STAT_LABEL}>Online APs</div>
        </div>
        <div
          style={{
            ...STAT_CARD,
            borderLeftColor: offlineCount > 0 ? 'var(--primary)' : 'var(--text-muted)',
          }}
        >
          <div style={STAT_VALUE}>{fmtCount(offlineCount)}</div>
          <div style={STAT_LABEL}>Offline APs</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{fmtCount(summary.total_clients ?? 0)}</div>
          <div style={STAT_LABEL}>Total Clients</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{fmtNum(summary.avg_utilization ?? null)}%</div>
          <div style={STAT_LABEL}>Avg Utilization</div>
        </div>
        <div style={STAT_CARD}>
          <div style={{ ...STAT_VALUE, display: 'flex', alignItems: 'center', gap: 8 }}>
            {fmtNum(summary.overall_health_score ?? null)}
            <GradeBadge grade={summary.overall_grade ?? null} />
          </div>
          <div style={STAT_LABEL}>Overall Health</div>
        </div>
      </div>

      {/* 2. Site Breakdown table */}
      <div className="sv-panel" style={{ ...PANEL, marginTop: 16 }}>
        <h3 style={SECTION_TITLE}>Site Breakdown</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th style={TH}>Site</th>
              <th style={{ ...TH, textAlign: 'right' }}>Controllers</th>
              <th style={{ ...TH, textAlign: 'right' }}>APs</th>
              <th style={{ ...TH, textAlign: 'right' }}>Online</th>
              <th style={{ ...TH, textAlign: 'right' }}>Clients</th>
              <th style={{ ...TH, textAlign: 'right' }}>Avg Util %</th>
              <th style={TH}>Grade</th>
            </tr>
          </thead>
          <tbody>
            {bySite.map((s, i) => (
              <tr key={`${s.site_name}-${i}`}>
                <td style={TD}>{s.site_name}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.controllers)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.aps)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.online_aps)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtCount(s.clients)}</td>
                <td style={{ ...TD, textAlign: 'right' }}>{fmtNum(s.avg_utilization)}</td>
                <td style={TD}>
                  <GradeBadge grade={s.health_grade} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 3. Top APs by Clients + Top SSIDs side by side */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 16 }}>
        <div className="sv-panel" style={{ ...PANEL, flex: 1, minWidth: 280 }}>
          <h3 style={SECTION_TITLE}>Top APs by Clients</h3>
          {topAps.length === 0 ? (
            <div className="sv-muted">No access points in this period.</div>
          ) : (
            topAps.map((ap, i) => (
              <div
                key={`${ap.name}-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-light)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)' }}>
                  <span style={{ fontWeight: 600 }}>{ap.name}</span>{' '}
                  <span className="sv-muted">· {ap.site_name}</span>
                </div>
                <div style={{ flex: '0 0 80px', textAlign: 'right', fontSize: 'var(--text-sm)' }}>
                  {fmtCount(ap.clients)} clients
                </div>
                <div
                  style={{ flex: '0 0 60px', textAlign: 'right', fontSize: 'var(--text-sm)' }}
                  className="sv-muted"
                >
                  {fmtNum(ap.util)}%
                </div>
              </div>
            ))
          )}
        </div>

        <div className="sv-panel" style={{ ...PANEL, flex: 1, minWidth: 280 }}>
          <h3 style={SECTION_TITLE}>Top SSIDs</h3>
          {topSsids.length === 0 ? (
            <div className="sv-muted">No SSIDs in this period.</div>
          ) : (
            topSsids.map((s, i) => (
              <div
                key={`${s.ssid_name}-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-light)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                  {s.ssid_name}
                </div>
                <div style={{ flex: '0 0 90px', textAlign: 'right', fontSize: 'var(--text-sm)' }}>
                  {fmtCount(s.client_count)} clients
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 4. Offline APs (only when present) */}
      {offlineAps.length > 0 && (
        <div className="sv-panel" style={{ ...PANEL, marginTop: 16 }}>
          <h3 style={SECTION_TITLE}>Offline APs</h3>
          {offlineAps.map((ap, i) => (
            <div
              key={`${ap.name}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 0',
                borderBottom: '1px solid var(--border-light)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-sm)' }}>
                <span style={{ fontWeight: 600 }}>{ap.name}</span>{' '}
                <span className="sv-muted">· {ap.site_name}</span>
              </div>
              <div
                style={{ flex: '0 0 200px', textAlign: 'right', fontSize: 'var(--text-sm)' }}
                className="sv-muted"
              >
                {fmtLastSeen(ap.last_seen)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import React from 'react';

type WirelessCapacity = {
  period: string;
  licensed_aps: number | null;
  used_aps: number;
  capacity_pct: number | null;
  client_trend: { day: string; clients: number }[];
  peak_clients: { date: string | null; count: number } | null;
  avg_clients_per_ap: number | null;
  high_util_aps: { name: string; site_name: string | null; util: number | null }[];
  growth_rate: string;
  projected_capacity: { days_to_80pct: number | null; days_to_full: number | null };
};

const SECTION_TITLE: React.CSSProperties = { fontSize: 'var(--text-sm)', textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', margin: '0 0 8px' };
const PANEL: React.CSSProperties = { padding: 16 };
const STAT_GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'stretch' };
const STAT_CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeftWidth: 3, borderLeftColor: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', minHeight: 75, display: 'flex', flexDirection: 'column', justifyContent: 'center' };
const STAT_VALUE: React.CSSProperties = { fontSize: 'var(--text-xl)', fontWeight: 800, lineHeight: 1.1 };
const STAT_LABEL: React.CSSProperties = { fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em', marginTop: 4 };
const TH: React.CSSProperties = { fontSize: 'var(--text-xs)', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', padding: '8px 12px', textAlign: 'left' };
const TD: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-primary)', padding: '8px 12px', height: 36 };

function capacityColor(pct: number | null): string {
  if (pct === null) return 'var(--text-muted)';
  if (pct >= 90) return 'var(--primary)';
  if (pct >= 70) return 'var(--yellow)';
  return 'var(--green)';
}

function utilColor(util: number | null): string {
  if (util === null) return 'var(--text-muted)';
  if (util > 85) return 'var(--primary)';
  if (util > 70) return 'var(--yellow)';
  return 'var(--text-primary)';
}

function fmtNum(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return String(n);
}

export default function WirelessCapacityReport({ data }: { data: WirelessCapacity }) {
  if (!data) return null;

  const clientTrend = data.client_trend ?? [];
  const highUtilAps = data.high_util_aps ?? [];
  const projectedCapacity = data.projected_capacity ?? { days_to_80pct: null, days_to_full: null };
  const peakClients = data.peak_clients ?? null;

  const capPct = data.capacity_pct;
  const fillWidth = capPct === null ? 0 : Math.max(0, Math.min(100, capPct));

  const trendMax = clientTrend.reduce((m, d) => (d.clients > m ? d.clients : m), 0);
  const peakDay = peakClients?.date ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Capacity stat cards */}
      <section>
        <h3 style={SECTION_TITLE}>Capacity</h3>
        <div style={STAT_GRID}>
          <div style={STAT_CARD}>
            <div style={STAT_VALUE}>{fmtNum(data.licensed_aps)}</div>
            <div style={STAT_LABEL}>Licensed APs</div>
          </div>
          <div style={STAT_CARD}>
            <div style={STAT_VALUE}>{data.used_aps}</div>
            <div style={STAT_LABEL}>Used APs</div>
          </div>
          <div style={{ ...STAT_CARD, borderLeftColor: capacityColor(capPct) }}>
            <div style={STAT_VALUE}>{capPct === null ? '—' : `${capPct}%`}</div>
            <div style={STAT_LABEL}>Capacity %</div>
          </div>
          <div style={STAT_CARD}>
            <div style={STAT_VALUE}>{fmtNum(data.avg_clients_per_ap)}</div>
            <div style={STAT_LABEL}>Avg Clients/AP</div>
          </div>
          <div style={STAT_CARD}>
            <div style={STAT_VALUE}>{peakClients ? peakClients.count : '—'}</div>
            {peakClients && peakDay ? (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{peakDay}</div>
            ) : null}
            <div style={STAT_LABEL}>Peak Clients</div>
          </div>
          <div style={STAT_CARD}>
            <div style={STAT_VALUE}>{data.growth_rate}</div>
            <div style={STAT_LABEL}>Growth Rate</div>
          </div>
        </div>
      </section>

      {/* Licensed vs Used capacity bar */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Licensed vs Used</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              flex: 1,
              height: 24,
              background: 'var(--border-light)',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: `${fillWidth}%`,
                height: '100%',
                background: capacityColor(capPct),
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
            {data.used_aps} / {fmtNum(data.licensed_aps)}
          </div>
        </div>
      </section>

      {/* Client trend chart */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Client Trend (last 30 days)</h3>
        {clientTrend.length === 0 ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No trend data available.</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
            <div
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-muted)',
                writingMode: 'horizontal-tb',
                width: 40,
                textAlign: 'right',
                paddingRight: 4,
              }}
            >
              {trendMax}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 2,
                height: 120,
                flex: 1,
                borderLeft: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                paddingLeft: 4,
              }}
            >
              {clientTrend.map((d, i) => {
                const h = trendMax > 0 ? Math.max(2, (d.clients / trendMax) * 116) : 2;
                const isPeak = peakDay !== null && d.day === peakDay;
                return (
                  <div
                    key={`${d.day}-${i}`}
                    title={`${d.day}: ${d.clients}`}
                    style={{
                      flex: 1,
                      minWidth: 2,
                      height: h,
                      background: isPeak ? 'var(--primary)' : 'var(--green)',
                      borderRadius: '2px 2px 0 0',
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Growth projection */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Growth Projection</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
          <div>
            Days to 80% capacity:{' '}
            <strong>
              {projectedCapacity.days_to_80pct === null ? 'Not projected' : projectedCapacity.days_to_80pct}
            </strong>
          </div>
          <div>
            Days to full:{' '}
            <strong>
              {projectedCapacity.days_to_full === null ? 'Not projected' : projectedCapacity.days_to_full}
            </strong>
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 2 }}>
            Growth rate: {data.growth_rate}
          </div>
        </div>
      </section>

      {/* High utilization APs */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>High Utilization APs</h3>
        {highUtilAps.length === 0 ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No consistently high-utilization APs.</div>
        ) : (
          <table className="sv-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH}>Name</th>
                <th style={TH}>Site</th>
                <th style={{ ...TH, textAlign: 'right' }}>Util %</th>
              </tr>
            </thead>
            <tbody>
              {highUtilAps.map((ap, i) => (
                <tr key={`${ap.name}-${i}`}>
                  <td style={TD}>{ap.name}</td>
                  <td style={TD}>{ap.site_name ?? '—'}</td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: utilColor(ap.util) }}>
                    {ap.util === null ? '—' : `${ap.util}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

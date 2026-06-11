'use client';

type WirelessClients = {
  period: string;
  summary: {
    total_clients: number;
    problem_clients: number;
    low_signal_count: number;
    frequent_roamers: number;
    band_2g_pct: number | null;
    band_5g_pct: number | null;
  };
  problem_clients: {
    mac_address: string;
    hostname: string | null;
    ap_name: string | null;
    ssid_name: string | null;
    band: string | null;
    rssi_dbm: number | null;
    roaming_count: number;
    reason: string;
  }[];
  by_ssid: { ssid_name: string; client_count: number }[];
  by_band: { [band: string]: number };
  roaming_events_24h: number;
  busiest_aps: { name: string; clients: number }[];
};

// ── Shared REPORT OUTPUT style constants (module scope) ─────────
const SECTION_TITLE: React.CSSProperties = { fontSize: 12, textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', margin: '0 0 8px' };
const PANEL: React.CSSProperties = { padding: 16 };
const STAT_GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'stretch' };
const STAT_CARD: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeftWidth: 3, borderLeftColor: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', minHeight: 75, display: 'flex', flexDirection: 'column', justifyContent: 'center' };
const STAT_VALUE: React.CSSProperties = { fontSize: 22, fontWeight: 800, lineHeight: 1.1 };
const STAT_LABEL: React.CSSProperties = { fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em', marginTop: 4 };
const TH: React.CSSProperties = { fontSize: 11, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', padding: '8px 12px', textAlign: 'left' };
const TD: React.CSSProperties = { fontSize: 12.5, color: 'var(--text-primary)', padding: '8px 12px', height: 36 };

const SECTION: React.CSSProperties = { marginTop: 16 };
const NUM_TH: React.CSSProperties = { ...TH, textAlign: 'right' };
const NUM_TD: React.CSSProperties = { ...TD, textAlign: 'right' };

function bandColor(band: string): string {
  if (band === '2.4GHz') return 'var(--yellow)';
  if (band === '5GHz') return 'var(--primary)';
  if (band === '6GHz') return 'var(--green)';
  return 'var(--text-muted)';
}

function rssiColor(rssi: number | null): string {
  if (rssi == null) return 'var(--text-muted)';
  if (rssi < -75) return 'var(--primary)';
  if (rssi < -67) return 'var(--yellow)';
  return 'var(--green)';
}

function pctStr(v: number | null): string {
  if (v == null) return '0';
  return String(Math.round(v));
}

export default function WirelessClientReport({ data }: { data: WirelessClients }) {
  if (!data) return null;

  const summary = data.summary || ({} as WirelessClients['summary']);
  const problemClients = data.problem_clients || [];
  const byBand = data.by_band || {};
  const busiestAps = data.busiest_aps || [];

  const bandEntries = Object.entries(byBand);
  const bandTotal = bandEntries.reduce((acc, [, count]) => acc + (count || 0), 0);

  const problemBorder = (summary.problem_clients ?? 0) > 0 ? 'var(--primary)' : 'var(--text-muted)';

  return (
    <div className="wireless-client-report">
      {/* 1. Summary cards */}
      <div style={STAT_GRID}>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.total_clients ?? 0}</div>
          <div style={STAT_LABEL}>Total Clients</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: problemBorder }}>
          <div style={STAT_VALUE}>{summary.problem_clients ?? 0}</div>
          <div style={STAT_LABEL}>Problem Clients</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.low_signal_count ?? 0}</div>
          <div style={STAT_LABEL}>Low Signal</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.frequent_roamers ?? 0}</div>
          <div style={STAT_LABEL}>Frequent Roamers</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{data.roaming_events_24h ?? 0}</div>
          <div style={STAT_LABEL}>Roaming Events 24h</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>
            {`2.4G ${pctStr(summary.band_2g_pct)}% / 5G ${pctStr(summary.band_5g_pct)}%`}
          </div>
          <div style={STAT_LABEL}>Band Split</div>
        </div>
      </div>

      {/* 2. Band Distribution */}
      <div className="sv-panel" style={{ ...PANEL, ...SECTION }}>
        <h3 style={SECTION_TITLE}>Band Distribution</h3>
        {bandEntries.length > 0 && bandTotal > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {bandEntries.map(([band, count]) => {
              const pct = bandTotal > 0 ? ((count || 0) / bandTotal) * 100 : 0;
              return (
                <div key={band}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      marginBottom: 4,
                      color: 'var(--text-primary)',
                    }}
                  >
                    <span>{band}</span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {count} ({Math.round(pct)}%)
                    </span>
                  </div>
                  <div
                    style={{
                      height: 14,
                      background: 'var(--border-light)',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${pct}%`,
                        background: bandColor(band),
                        borderRadius: 'var(--radius-sm)',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="sv-muted">No band data in this period.</div>
        )}
      </div>

      {/* 3. Problem Clients */}
      <div className="sv-panel" style={{ ...PANEL, ...SECTION }}>
        <h3 style={SECTION_TITLE}>Problem Clients</h3>
        {problemClients.length > 0 ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Client</th>
                <th style={TH}>AP</th>
                <th style={TH}>SSID</th>
                <th style={TH}>Band</th>
                <th style={NUM_TH}>RSSI (dBm)</th>
                <th style={NUM_TH}>Roams</th>
                <th style={TH}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {problemClients.map((c) => (
                <tr key={c.mac_address}>
                  <td style={TD}>{c.hostname || c.mac_address}</td>
                  <td style={TD}>{c.ap_name || '—'}</td>
                  <td style={TD}>{c.ssid_name || '—'}</td>
                  <td style={TD}>{c.band || '—'}</td>
                  <td style={{ ...NUM_TD, color: rssiColor(c.rssi_dbm), fontWeight: 600 }}>
                    {c.rssi_dbm != null ? c.rssi_dbm : '—'}
                  </td>
                  <td style={NUM_TD}>{c.roaming_count}</td>
                  <td style={TD}>{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="sv-muted">No problem clients in this period.</div>
        )}
      </div>

      {/* 4. Busiest APs */}
      <div className="sv-panel" style={{ ...PANEL, ...SECTION }}>
        <h3 style={SECTION_TITLE}>Busiest APs</h3>
        <table className="sv-table">
          <thead>
            <tr>
              <th style={TH}>Name</th>
              <th style={NUM_TH}>Clients</th>
            </tr>
          </thead>
          <tbody>
            {busiestAps.length > 0 ? (
              busiestAps.map((ap) => (
                <tr key={ap.name}>
                  <td style={TD}>{ap.name}</td>
                  <td style={NUM_TD}>{ap.clients}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={2} className="sv-muted">
                  No AP data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

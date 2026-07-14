'use client';

import { SECTION_TITLE, PANEL, STAT_GRID, STAT_CARD, STAT_VALUE, STAT_LABEL, TH, TD, numTh, numCell } from '@/components/reports/reportStyles';

type BandwidthClient = {
  mac_address: string;
  controller_id: number;
  controller_name: string | null;
  site_name: string | null;
  hostname: string | null;
  ip_address: string | null;
  ap_name: string | null;
  ssid_name: string | null;
  // BIGINT columns come back from the API as numbers here (server.js coerces
  // via Number()), but keep the union so a raw string response still renders
  // instead of crashing — mirrors the defensive typing in wireless/page.tsx.
  avg_rx_bps: number | string | null;
  avg_tx_bps: number | string | null;
  avg_total_bps: number | string | null;
  peak_rx_bps: number | string | null;
  peak_tx_bps: number | string | null;
  peak_total_bps: number | string | null;
  sample_count: number;
};

type WirelessBandwidth = {
  period: string;
  requested_range?: string;
  capped_to_7d?: boolean;
  summary: {
    client_count: number;
    avg_total_bps: number | string | null;
  };
  clients: BandwidthClient[];
};

// Mirrors fmtBps() in frontend/src/app/(app)/wireless/page.tsx EXACTLY, so this
// report's figures never disagree with the live Wireless page or the PDF export.
function fmtBps(n: number | string | null | undefined): string {
  if (n == null) return '—';
  const v = Number(n);
  if (isNaN(v)) return '—';
  if (Math.abs(v) < 1e6) return `${(v / 1e3).toFixed(1)} Kbps`;
  return `${(v / 1e6).toFixed(1)} Mbps`;
}

export default function WirelessBandwidthReport({ data }: { data: WirelessBandwidth }) {
  if (!data) return null;

  const summary = data.summary || ({} as WirelessBandwidth['summary']);
  const clients = data.clients || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {data.capped_to_7d && (
        <div
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--tint-warn-fg)',
            background: 'var(--tint-warn)',
            border: '1px solid var(--tint-warn)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 12px',
          }}
        >
          Client bandwidth history is retained for 7 days — the requested range has been
          capped to the last 7 days.
        </div>
      )}

      {/* Summary KPI tiles */}
      <div style={STAT_GRID}>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.client_count ?? 0}</div>
          <div style={STAT_LABEL}>Clients With Bandwidth Data</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{fmtBps(summary.avg_total_bps)}</div>
          <div style={STAT_LABEL}>Average Bandwidth</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{clients[0] ? fmtBps(clients[0].avg_total_bps) : '—'}</div>
          <div style={STAT_LABEL}>Top Client (Avg)</div>
        </div>
      </div>

      {/* Top clients table */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Top Clients by Bandwidth</h3>
        {clients.length > 0 ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Client</th>
                <th style={TH}>AP</th>
                <th style={TH}>SSID</th>
                <th style={TH}>Controller / Site</th>
                <th style={numTh}>Avg Down</th>
                <th style={numTh}>Avg Up</th>
                <th style={numTh}>Peak Total</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={`${c.controller_id}-${c.mac_address}`}>
                  <td style={{ ...TD, fontWeight: 600 }}>
                    {c.hostname || c.mac_address}
                    {c.hostname && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {c.mac_address}
                      </div>
                    )}
                  </td>
                  <td style={TD}>{c.ap_name || '—'}</td>
                  <td style={TD}>{c.ssid_name || '—'}</td>
                  <td style={{ ...TD, color: 'var(--text-muted)' }}>
                    {c.controller_name || '—'}
                    {c.site_name ? ` · ${c.site_name}` : ''}
                  </td>
                  <td style={numCell} title={`${c.sample_count} sample(s)`}>{fmtBps(c.avg_rx_bps)}</td>
                  <td style={numCell}>{fmtBps(c.avg_tx_bps)}</td>
                  <td style={numCell}>{fmtBps(c.peak_total_bps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            No client bandwidth data in this period.
          </div>
        )}
      </section>
    </div>
  );
}

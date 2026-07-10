'use client';

import { SECTION_TITLE, PANEL, STAT_GRID, STAT_CARD, STAT_VALUE, STAT_LABEL, TH, TD, numTh, numCell } from '@/components/reports/reportStyles';

type RogueAp = {
  id: number;
  bssid: string;
  ssid: string | null;
  classification: string | null;
  channel: number | null;
  rssi_dbm: number | null;
  detecting_ap: string | null;
  last_seen_at: string | null;
  first_seen_at?: string | null;
  controller_name: string | null;
  site_name: string | null;
};

type SsidRow = {
  id: number;
  ssid_name: string;
  controller_name: string | null;
  site_name: string | null;
  encryption_type: string | null;
  clients_total: number;
  weak_encryption: boolean;
};

type WirelessSecurity = {
  period: string;
  summary: {
    rogue_total: number;
    rogue_needs_attention: number;
    rogue_informational: number;
    ssid_total: number;
    ssid_weak_encryption: number;
  };
  rogue_aps: RogueAp[];
  ssids: SsidRow[];
  recommendations: string[];
};

// Classification colour — mirrors rogueClassColor() in
// frontend/src/app/(app)/wireless/page.tsx EXACTLY: malicious/rogue = red,
// interfering = yellow, friendly/known = green, anything else = muted. Kept in
// lockstep so the Rogue APs live tab and this report never disagree.
function rogueClassColor(c: string | null): string {
  switch ((c || '').toLowerCase()) {
    case 'malicious':
    case 'rogue':
      return 'var(--red)';
    case 'interfering':
      return 'var(--yellow)';
    case 'friendly':
    case 'known':
      return 'var(--green)';
    default:
      return 'var(--text-muted)';
  }
}

// Encryption badge colours — mirrors EncryptionBadge/encryptionBadgeColor() in
// frontend/src/app/(app)/wireless/page.tsx (weak/open/WEP = amber tint, else
// green tint). Here every row gets a badge (including "no data"/null), since a
// report needs to visibly flag the missing-encryption-type case as weak too.
function encBadgeColors(weak: boolean): { bg: string; fg: string } {
  return weak
    ? { bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }
    : { bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' };
}

function fmtRel(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function WirelessSecurityReport({ data }: { data: WirelessSecurity }) {
  if (!data) return null;

  const summary = data.summary || ({} as WirelessSecurity['summary']);
  const rogueAps = data.rogue_aps || [];
  const ssids = data.ssids || [];
  const recommendations = data.recommendations || [];

  const attentionBorder = (summary.rogue_needs_attention ?? 0) > 0 ? 'var(--primary)' : 'var(--text-muted)';
  const weakBorder = (summary.ssid_weak_encryption ?? 0) > 0 ? 'var(--yellow)' : 'var(--text-muted)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary KPI tiles */}
      <div style={STAT_GRID}>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.rogue_total ?? 0}</div>
          <div style={STAT_LABEL}>Rogue APs Detected</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: attentionBorder }}>
          <div style={STAT_VALUE}>{summary.rogue_needs_attention ?? 0}</div>
          <div style={STAT_LABEL}>Needs Attention</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.rogue_informational ?? 0}</div>
          <div style={STAT_LABEL}>Informational</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.ssid_total ?? 0}</div>
          <div style={STAT_LABEL}>SSIDs Configured</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: weakBorder }}>
          <div style={STAT_VALUE}>{summary.ssid_weak_encryption ?? 0}</div>
          <div style={STAT_LABEL}>Weak / No Encryption</div>
        </div>
      </div>

      {/* Recommendations */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Recommendations</h3>
        {recommendations.length === 0 ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            No security issues found — no malicious/interfering/rogue APs and no weak-encryption SSIDs.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {recommendations.map((rec, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '8px 0',
                  borderBottom: i < recommendations.length - 1 ? '1px solid var(--border-light)' : 'none',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-primary)',
                }}
              >
                <span style={{ color: 'var(--primary)', fontWeight: 700, flex: '0 0 auto' }}>›</span>
                <span>{rec}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Rogue AP detail table */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Rogue / Neighboring AP Detections</h3>
        {rogueAps.length > 0 ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>BSSID</th>
                <th style={TH}>SSID</th>
                <th style={TH}>Classification</th>
                <th style={TH}>Channel</th>
                <th style={numTh}>RSSI</th>
                <th style={TH}>Detecting AP</th>
                <th style={TH}>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {rogueAps.map((r) => {
                const color = rogueClassColor(r.classification);
                return (
                  <tr key={r.id}>
                    <td style={{ ...TD, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{r.bssid}</td>
                    <td style={TD}>{r.ssid || '—'}</td>
                    <td style={TD}>
                      <span className="sv-badge" style={{ color, borderColor: color, textTransform: 'capitalize' }}>
                        {r.classification || 'unclassified'}
                      </span>
                    </td>
                    <td style={TD}>{r.channel != null ? `Ch ${r.channel}` : '—'}</td>
                    <td style={numCell}>{r.rssi_dbm != null ? `${r.rssi_dbm} dBm` : '—'}</td>
                    <td style={TD}>{r.detecting_ap || '—'}</td>
                    <td style={{ ...TD, color: 'var(--text-muted)' }}>{fmtRel(r.last_seen_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            No rogue APs detected in this period.
          </div>
        )}
      </section>

      {/* SSID encryption table — weak/no-encryption SSIDs sorted first (see API) */}
      <section className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>SSID Encryption Posture</h3>
        {ssids.length > 0 ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>SSID</th>
                <th style={TH}>Controller</th>
                <th style={TH}>Site</th>
                <th style={TH}>Encryption</th>
                <th style={numTh}>Clients</th>
              </tr>
            </thead>
            <tbody>
              {ssids.map((s) => {
                const colors = encBadgeColors(s.weak_encryption);
                return (
                  <tr key={s.id}>
                    <td style={{ ...TD, fontWeight: 600 }}>{s.ssid_name}</td>
                    <td style={{ ...TD, color: 'var(--text-muted)' }}>{s.controller_name || '—'}</td>
                    <td style={{ ...TD, color: 'var(--text-muted)' }}>{s.site_name || '—'}</td>
                    <td style={TD}>
                      <span
                        className="sv-badge"
                        style={{ color: colors.fg, background: colors.bg, borderColor: colors.bg }}
                        title={s.encryption_type || 'No encryption type reported'}
                      >
                        {s.encryption_type || 'Unknown / No Data'}
                      </span>
                    </td>
                    <td style={numCell}>{s.clients_total ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No SSIDs configured.</div>
        )}
      </section>
    </div>
  );
}

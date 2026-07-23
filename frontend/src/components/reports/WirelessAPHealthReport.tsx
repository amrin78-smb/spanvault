'use client';

import { GradeBadge } from '@/components/intel';
import { SECTION_TITLE, PANEL, STAT_GRID, STAT_CARD, STAT_VALUE, STAT_LABEL, TH, TD, utilColor } from '@/components/reports/reportStyles';

type WirelessAP = {
  name: string;
  controller_name: string | null;
  site_name: string | null;
  status: string;
  clients: number;
  radio_2g_channel: number | null;
  radio_5g_channel: number | null;
  radio_2g_util_pct: number | null;
  radio_5g_util_pct: number | null;
  noise_floor_2g: number | null;
  noise_floor_5g: number | null;
  uptime_seconds: number | null;
  health_score: number | null;
  health_grade: string | null;
  issues: string[];
};

type WirelessAPHealth = {
  period: string;
  aps: WirelessAP[];
  summary: {
    total: number;
    online: number;
    offline: number;
    avg_health_score: number | null;
    overloaded_count: number;
    high_util_count: number;
  };
};

// ── Helpers (module scope) ──────────────────────────────────────
function gradeFromScore(score: number | null): string {
  if (score == null) return '—';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function fmtUptime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function maxUtil(ap: WirelessAP): number | null {
  const a = ap.radio_2g_util_pct;
  const b = ap.radio_5g_util_pct;
  if (a == null && b == null) return null;
  return Math.max(a ?? -Infinity, b ?? -Infinity);
}

function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'online') return 'var(--green)';
  if (s === 'offline') return 'var(--primary)';
  return 'var(--text-muted)';
}

// ── Style constants (module scope) ──────────────────────────────

const NUM_TH: React.CSSProperties = { ...TH, textAlign: 'right' };
const NUM_TD: React.CSSProperties = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const ISSUES_STYLE: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--primary)', marginTop: 2 };

export default function WirelessAPHealthReport({ data }: { data: WirelessAPHealth }) {
  if (!data) return null;

  const aps = Array.isArray(data.aps) ? data.aps : [];
  const summary = data.summary || {
    total: 0,
    online: 0,
    offline: 0,
    avg_health_score: null,
    overloaded_count: 0,
    high_util_count: 0,
  };

  const avgScore = summary.avg_health_score;
  const avgGrade = gradeFromScore(avgScore);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Summary stat cards ── */}
      <div style={STAT_GRID}>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.total ?? 0}</div>
          <div style={STAT_LABEL}>Total APs</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>{summary.online ?? 0}</div>
          <div style={STAT_LABEL}>Online</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: (summary.offline ?? 0) > 0 ? 'var(--primary)' : 'var(--text-muted)' }}>
          <div style={STAT_VALUE}>{summary.offline ?? 0}</div>
          <div style={STAT_LABEL}>Offline</div>
        </div>
        <div style={STAT_CARD}>
          <div style={{ ...STAT_VALUE, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{avgScore == null ? '—' : Math.round(avgScore)}</span>
            <GradeBadge grade={avgGrade} />
          </div>
          <div style={STAT_LABEL}>Avg Health Score</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.overloaded_count ?? 0}</div>
          <div style={STAT_LABEL}>Overloaded</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{summary.high_util_count ?? 0}</div>
          <div style={STAT_LABEL}>High Util</div>
        </div>
      </div>

      {/* ── AP table ── */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>
          Access Points{data.period ? ` · ${data.period}` : ''}
        </h3>
        <table className="sv-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={TH}>Name</th>
              <th style={TH}>Site</th>
              <th style={TH}>Status</th>
              <th style={NUM_TH}>Clients</th>
              <th style={TH}>Ch 2.4/5</th>
              <th style={NUM_TH}>Util</th>
              <th style={TH}>Noise</th>
              <th style={NUM_TH}>Uptime</th>
              <th style={TH}>Grade</th>
            </tr>
          </thead>
          <tbody>
            {aps.map((ap, index) => {
              const util = maxUtil(ap);
              const hasIssues = Array.isArray(ap.issues) && ap.issues.length > 0;
              return (
                <tr key={`${ap.name}-${index}`}>
                  <td style={TD}>
                    {ap.name || '—'}
                    {hasIssues ? (
                      <div style={ISSUES_STYLE}>{ap.issues.join(', ')}</div>
                    ) : null}
                  </td>
                  <td style={TD}>{ap.site_name || '—'}</td>
                  <td style={TD}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: statusColor(ap.status) }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: statusColor(ap.status),
                        }}
                      />
                      {ap.status || '—'}
                    </span>
                  </td>
                  <td style={NUM_TD}>{ap.clients ?? 0}</td>
                  <td style={TD}>
                    {`${ap.radio_2g_channel ?? '—'} / ${ap.radio_5g_channel ?? '—'}`}
                  </td>
                  <td style={{ ...NUM_TD, color: utilColor(util) }}>
                    {util == null ? '—' : `${Math.round(util)}%`}
                  </td>
                  <td style={TD}>
                    {`${ap.noise_floor_2g ?? '—'} / ${ap.noise_floor_5g ?? '—'} dBm`}
                  </td>
                  <td style={NUM_TD}>{fmtUptime(ap.uptime_seconds)}</td>
                  <td style={TD}>
                    <GradeBadge grade={ap.health_grade} />
                  </td>
                </tr>
              );
            })}
            {aps.length === 0 ? (
              <tr>
                <td colSpan={9} className="sv-muted" style={{ textAlign: 'center', padding: 24 }}>
                  No access points.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

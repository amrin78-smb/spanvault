'use client';

import React from 'react';
import { GradeBadge } from '@/components/intel';
import { SECTION_TITLE, PANEL, STAT_GRID, STAT_CARD, STAT_VALUE, STAT_LABEL, TH, TD } from '@/components/reports/reportStyles';

type ChannelMap = { [channel: string]: number };

type WirelessRF = {
  period: string;
  overall_score: number | null;
  overall_grade: string | null;
  co_channel_affected: number;
  interference_score: number | null;
  band_steering_score: number | null;
  band_2g_pct: number | null;
  band_5g_pct: number | null;
  load_balance_score: number | null;
  overloaded_aps: number;
  recommendations: string[];
  channel_distribution: {
    '2.4GHz': ChannelMap;
    '5GHz': ChannelMap;
  };
  ap_health_distribution: { A: number; B: number; C: number; D: number; F: number };
  measured_interference_2g: number | null;
  measured_interference_5g: number | null;
  aps_reporting_interference: number;
  aps_high_interference: number;
  worst_interference_aps: { name: string; site_name: string | null; band: string; pct: number }[];
};

const GRADE_ORDER: Array<keyof WirelessRF['ap_health_distribution']> = ['A', 'B', 'C', 'D', 'F'];

function fmtScore(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : String(v);
}

function gradeBarColor(grade: string): string {
  if (grade === 'A') return 'var(--green)';
  if (grade === 'B' || grade === 'C') return 'var(--yellow)';
  return 'var(--primary)';
}

function sortChannels(keys: string[]): string[] {
  const numeric = keys.filter((k) => k.toLowerCase() !== 'other');
  const other = keys.filter((k) => k.toLowerCase() === 'other');
  numeric.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  });
  return [...numeric, ...other];
}

function ScoreCard({ label, value, badge }: { label: string; value: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div style={STAT_CARD}>
      <div style={{ ...STAT_VALUE, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{value}</span>
        {badge}
      </div>
      <div style={STAT_LABEL}>{label}</div>
    </div>
  );
}

function ChannelBars({ band, channels, color }: { band: string; channels: ChannelMap; color: string }) {
  const keys = sortChannels(Object.keys(channels));
  const counts = keys.map((k) => channels[k] || 0);
  const max = counts.length ? Math.max(...counts, 1) : 1;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>{band}</div>
      {keys.length === 0 ? (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No channel data.</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 120, paddingTop: 4 }}>
          {keys.map((k) => {
            const count = channels[k] || 0;
            const pct = Math.round((count / max) * 100);
            return (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 auto', minWidth: 40 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{count}</div>
                <div
                  style={{
                    width: 26,
                    height: `${Math.max(pct, 3)}%`,
                    minHeight: 4,
                    background: color,
                    borderRadius: 'var(--radius-sm)',
                  }}
                  title={`Channel ${k}: ${count}`}
                />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 6 }}>{k}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GradeBar({ grade, count, max }: { grade: string; count: number; max: number }) {
  const pct = Math.round((count / max) * 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 0', minWidth: 56 }}>
      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{count}</div>
      <div
        style={{
          width: '100%',
          maxWidth: 48,
          height: `${Math.max(pct, 3)}%`,
          minHeight: 4,
          background: gradeBarColor(grade),
          borderRadius: 'var(--radius-sm)',
        }}
        title={`Grade ${grade}: ${count}`}
      />
      <div style={{ marginTop: 8 }}>
        <GradeBadge grade={grade} />
      </div>
    </div>
  );
}

export default function WirelessRFReport({ data }: { data: WirelessRF }) {
  if (!data) return null;

  const recommendations = data.recommendations || [];
  const channelDistribution = data.channel_distribution || { '2.4GHz': {}, '5GHz': {} };
  const band2g = channelDistribution['2.4GHz'] || {};
  const band5g = channelDistribution['5GHz'] || {};
  const apHealth = data.ap_health_distribution || { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const worstInterferenceAps = data.worst_interference_aps || [];
  const apsHighInterference = data.aps_high_interference ?? 0;

  const gradeMax = Math.max(...GRADE_ORDER.map((g) => apHealth[g] || 0), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Health Scores */}
      <section style={PANEL}>
        <h3 style={SECTION_TITLE}>Health Scores</h3>
        <div style={STAT_GRID}>
          <ScoreCard
            label="Overall"
            value={fmtScore(data.overall_score)}
            badge={<GradeBadge grade={data.overall_grade} />}
          />
          <ScoreCard label="Interference Score" value={fmtScore(data.interference_score)} />
          <ScoreCard label="Band Steering Score" value={fmtScore(data.band_steering_score)} />
          <ScoreCard label="Load Balance Score" value={fmtScore(data.load_balance_score)} />
          <ScoreCard label="Co-Channel Affected" value={String(data.co_channel_affected ?? 0)} />
          <ScoreCard label="Overloaded APs" value={String(data.overloaded_aps ?? 0)} />
        </div>
      </section>

      {/* Measured Interference */}
      <section style={PANEL}>
        <h3 style={SECTION_TITLE}>Measured Interference</h3>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 12 }}>
          Real-time measured airtime interference per AP, distinct from the channel-plan-based
          Interference Score above.
        </div>
        <div style={STAT_GRID}>
          <ScoreCard label="2.4GHz Avg" value={data.measured_interference_2g == null ? '—' : `${fmtScore(data.measured_interference_2g)}%`} />
          <ScoreCard label="5GHz Avg" value={data.measured_interference_5g == null ? '—' : `${fmtScore(data.measured_interference_5g)}%`} />
          <ScoreCard label="APs Reporting" value={String(data.aps_reporting_interference ?? 0)} />
          <ScoreCard
            label="High Interference APs"
            value={
              <span style={{ color: apsHighInterference > 0 ? 'var(--tint-danger-fg)' : undefined }}>
                {String(apsHighInterference)}
              </span>
            }
          />
        </div>
        {worstInterferenceAps.length > 0 && (
          <table className="sv-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
            <thead>
              <tr>
                <th style={TH}>AP</th>
                <th style={TH}>Site</th>
                <th style={TH}>Band</th>
                <th style={{ ...TH, textAlign: 'right' }}>Interference %</th>
              </tr>
            </thead>
            <tbody>
              {worstInterferenceAps.map((ap, i) => (
                <tr key={`${ap.name}-${ap.band}-${i}`}>
                  <td style={TD}>{ap.name}</td>
                  <td style={TD}>{ap.site_name ?? '—'}</td>
                  <td style={TD}>{ap.band}</td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: ap.pct >= 25 ? 'var(--tint-danger-fg)' : 'var(--text-primary)' }}>
                    {ap.pct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Recommendations */}
      <section style={PANEL}>
        <h3 style={SECTION_TITLE}>Recommendations</h3>
        {recommendations.length === 0 ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            No RF recommendations — the wireless environment looks healthy.
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

      {/* Channel Distribution */}
      <section style={PANEL}>
        <h3 style={SECTION_TITLE}>Channel Distribution</h3>
        <ChannelBars band="2.4GHz" channels={band2g} color="var(--yellow)" />
        <ChannelBars band="5GHz" channels={band5g} color="var(--primary)" />
      </section>

      {/* AP Grade Distribution */}
      <section style={PANEL}>
        <h3 style={SECTION_TITLE}>AP Grade Distribution</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 140, paddingTop: 4 }}>
          {GRADE_ORDER.map((g) => (
            <GradeBar key={g} grade={g} count={apHealth[g] || 0} max={gradeMax} />
          ))}
        </div>
      </section>
    </div>
  );
}

'use client';

/**
 * Shared Intelligence-layer presentational helpers + types.
 * All components defined at module scope (never nested) per project rules.
 */

// ── Shared types (mirror api/intelligence.js output) ───────────
export type HealthRow = {
  id: number; name: string; site_id: number | null; site_name: string | null;
  current_status: string; score: number | string | null; grade: string | null;
  trend: string | null; uptime_score: number | string | null;
  response_score: number | string | null; anomaly_score: number | string | null;
  alert_score: number | string | null; uptime_pct: number | string | null;
  anomalies_7d: number; alerts_7d: number; computed_at?: string;
};
export type AnomalyRow = {
  id: number; device_id: number; device_name: string; site_id: number | null;
  site_name: string | null; metric: string; value: number | string;
  baseline_mean: number | string | null; baseline_stddev: number | string | null;
  z_score: number | string; severity: string; detected_at: string;
  resolved_at: string | null; status: string;
};
export type PatternRow = {
  id: number; device_id: number; device_name: string; site_name: string | null;
  pattern_type: string; metric: string; description: string;
  hour_of_day: number | null; day_of_week: number | null;
  avg_value: number | string | null; baseline_value: number | string | null;
  confidence: number | string | null; detected_at: string; last_seen_at: string;
  occurrence_count: number;
};
export type IncidentRow = {
  id: number; title: string; root_cause_device_id: number | null;
  root_cause_device_name: string | null; affected_count: number; severity: string;
  status: string; started_at: string; resolved_at: string | null;
  duration_seconds: number | null; summary: string | null;
  timeline: { ts: string; device: string; event: string; alert_id: number }[] | null;
  affected_devices: string[] | null;
};
export type ThresholdRow = {
  id: number; device_id: number; device_name: string; site_id: number | null;
  site_name: string | null; metric: string; current_threshold: number | string | null;
  recommended_threshold: number | string; reasoning: string;
  confidence: number | string | null; computed_at: string;
};
export type SiteScore = {
  site_id: number | null; site_name: string; score: number | null; grade: string | null;
  trend: string; device_count: number; anomaly_count: number;
};
export type Overview = {
  overall_score: number | null; overall_grade: string | null; trend: string;
  device_count: number; sites: SiteScore[]; at_risk_devices: HealthRow[];
  recent_anomalies: AnomalyRow[]; recent_incidents: IncidentRow[];
  active_anomalies: number; active_incidents: number; data_coverage_days: number;
};

// ── Numeric coercion ───────────────────────────────────────────
export function n(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return isNaN(x) ? null : x;
}

// ── Grade → colour ─────────────────────────────────────────────
export function gradeColor(grade: string | null | undefined): string {
  switch ((grade || '').toUpperCase()) {
    case 'A': return '#15803d'; // green
    case 'B': return '#2563eb'; // blue
    case 'C': return '#b45309'; // yellow/amber
    case 'D': return '#ea580c'; // orange
    case 'F': return '#b91c1c'; // red
    default:  return '#475569'; // grey
  }
}
export function scoreColor(score: number | null | undefined): string {
  if (score == null) return '#475569';
  if (score >= 90) return '#15803d';
  if (score >= 80) return '#2563eb';
  if (score >= 70) return '#b45309';
  if (score >= 60) return '#ea580c';
  return '#b91c1c';
}

// ── Grade badge ────────────────────────────────────────────────
export function GradeBadge({ grade }: { grade: string | null | undefined }) {
  const g = (grade || '?').toUpperCase();
  const c = gradeColor(grade);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 24, height: 24, padding: '0 7px', borderRadius: 6,
      fontWeight: 700, fontSize: 13, color: c, background: `${c}1a`,
    }}>{g}</span>
  );
}

// ── Score bar (fill + number) ──────────────────────────────────
export function ScoreBar({ score, width = 120 }: { score: number | string | null | undefined; width?: number }) {
  const s = n(score);
  const c = scoreColor(s);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width, height: 8, borderRadius: 5, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ width: `${s != null ? Math.max(2, Math.min(100, s)) : 0}%`, height: '100%', background: c, borderRadius: 5 }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color: c, minWidth: 30, textAlign: 'right' }}>
        {s != null ? Math.round(s) : '—'}
      </span>
    </div>
  );
}

// ── Trend arrow ────────────────────────────────────────────────
export function TrendArrow({ trend }: { trend: string | null | undefined }) {
  const t = (trend || 'stable').toLowerCase();
  const arrow = t === 'improving' ? '↑' : t === 'degrading' ? '↓' : '→';
  const color = t === 'improving' ? 'var(--sv-up)' : t === 'degrading' ? 'var(--sv-down)' : 'var(--sv-muted)';
  const label = t.charAt(0).toUpperCase() + t.slice(1);
  return (
    <span style={{ color, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {arrow} {label}
    </span>
  );
}

// ── Confidence stars (0-1 → 5 stars) ───────────────────────────
export function ConfidenceStars({ confidence }: { confidence: number | string | null | undefined }) {
  const c = n(confidence) ?? 0;
  const filled = Math.round(c * 5);
  return (
    <span title={`${Math.round(c * 100)}% confidence`} style={{ color: 'var(--primary)', fontSize: 13, letterSpacing: 1 }}>
      {'★'.repeat(filled)}<span style={{ color: 'var(--border)' }}>{'★'.repeat(5 - filled)}</span>
    </span>
  );
}

// ── Format a duration in seconds → "14m 28s" ───────────────────
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(Number(seconds))) return '—';
  let s = Math.floor(Number(seconds));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Anomaly deviation label: "2.8x above normal baseline" ──────
// Plain-language label for NOC users; the technical σ value lives in the
// tooltip via deviationTooltip().
export function deviationLabel(a: { value: number | string; baseline_mean: number | string | null; z_score: number | string }): string {
  const z = n(a.z_score) ?? 0;
  const val = n(a.value);
  const base = n(a.baseline_mean);
  const dir = val != null && base != null ? (val >= base ? 'above' : 'below') : '';
  return `${z.toFixed(1)}x ${dir} normal baseline`.trim();
}
// Technical detail for the tooltip: keeps the standard-deviation (σ) notation.
export function deviationTooltip(a: { value: number | string; baseline_mean: number | string | null; z_score: number | string }): string {
  const z = n(a.z_score) ?? 0;
  const val = n(a.value);
  const base = n(a.baseline_mean);
  const dir = val != null && base != null ? (val >= base ? 'above' : 'below') : '';
  return `${z.toFixed(1)}σ (standard deviations) ${dir} normal`.trim();
}

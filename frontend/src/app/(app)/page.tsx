'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { useApi } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { StatusDot } from '@/components/StatusDot';
import { useLicense, LicenseDisabledScreen } from '@/components/LicenseGuard';
import {
  ErrorBox, Empty, fmtRel, fmtTime,
  PageHeader, TableSkeleton, Skeleton, useRefreshKey, CHART_TOOLTIP,
} from '@/components/ui';
import {
  GradeBadge, scoreColor, n as intelNum, Overview, HealthRow,
} from '@/components/intel';
import {
  IconMonitor, IconSearch, IconRepeat, IconTool, IconWarning, IconCheck,
} from '@/components/icons';

// ── Types ──────────────────────────────────────────────────────
type Summary = {
  total: number; up: number; down: number; warning: number; unknown: number; active_alerts: number;
  agent_offline: number; agents_total: number; agents_online: number;
};
type AgentOfflineRow = {
  agent_id: number; agent_name: string; hostname: string | null;
  last_seen_at: string | null; device_count: number;
};
type Problem = {
  id: number; name: string; ip_address: string; site_id: number | null; site_name: string | null;
  current_status: string; last_response_ms: number | null; last_checked_at: string | null;
  last_seen_at: string | null; consecutive_failures: number;
  is_gateway: boolean; suppressed_in_site: number;
};
type Worst = {
  id: number; name: string; site_id: number | null; site_name: string | null;
  current_status: string; avg_ms: number | null; max_ms: number | null; packet_loss_pct: number | null;
};
type TrendPoint = { bucket: string; total_checks: number; up_checks: number; pct_up: number | null };
type SiteHealth = {
  site_id: number; site_name: string; total_devices: number; up_count: number;
  down_count: number; warning_count: number; unknown_count: number; avg_uptime_pct: number | null;
};
type EventRow = {
  id: number; device_id: number | null; device_name: string | null; site_id: number | null;
  site_name: string | null; alert_type: string; severity: string; status: string; message: string | null;
  triggered_at: string; resolved_at: string | null; event_at: string;
  service_check_id?: number | null; service_name?: string | null;
  wireless_ap_id?: number | null; wireless_controller_id?: number | null; wireless_name?: string | null;
  wireless_client_mac?: string | null;
};
// ── Enterprise panel types ─────────────────────────────────────
type OpsSummary = {
  mttr_minutes: number | string | null;
  mtta_minutes: number | string | null;
  unacked_count: number;
  open_incidents: number;
};
type OpenIncident = {
  id: number; title: string; affected_count: number; severity: string;
  started_at: string; root_cause_device_id: number | null;
  root_cause_device_name: string | null;
};
type SlaBreach = {
  id: number; name: string; site_id: number | null; site_name: string | null;
  uptime_pct: number | string | null;
};
type Sla = { overall_pct: number | null; sla_target: number; breaching: SlaBreach[] };
type CapacityRow = {
  id: number; name: string; site_id: number | null; site_name: string | null;
  metric: string; p95: number | string | null; p99: number | string | null;
};
type PatternRow = {
  id: number; device_id: number; device_name: string;
  pattern_type: string; metric: string; description: string | null;
  confidence: number | null; occurrence_count: number;
  hour_of_day: number | null; day_of_week: number | null;
};
type LeastReliable = {
  id: number; name: string; site_id: number | null; site_name: string | null;
  current_status: string; alert_count: number; outage_count: number;
  last_alert_at: string | null;
};
type TopTalker = {
  device_id: number; device_name: string; if_index: number; if_name: string;
  in_bps: number; out_bps: number;
};
type MaintenanceRow = {
  id: number; device_id: number | null; device_name: string | null; site_name: string | null;
  service_check_id: number | null; service_name: string | null; service_site_name: string | null;
  starts_at: string; ends_at: string; reason: string | null; state: 'active' | 'upcoming';
};
type MaintenanceData = { active: MaintenanceRow[]; upcoming: MaintenanceRow[] };
type WirelessIntel = {
  has_data: boolean;
  total_controllers: number;
  controllers_with_intel: number;
  overall_score: number;
  overall_grade: string;
  interference_score: number;
  capacity_score: number;
  band_steering_score: number;
  co_channel_pairs: number;
  overloaded_aps: number;
  critical_util_count: number;
  problem_clients: number;
};
type ServiceCheck = {
  id: number; name: string; type: 'http' | 'tcp' | 'ssl' | 'dns' | string;
  target: string; group_id: number | null; current_status: string;
  last_response_ms: number | null; last_detail: string | null; last_checked_at: string | null;
};

const REFRESH_MS = 30000;

// Shape returned by useApi() — kept explicit so child components can be typed.
type Api<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

// ── Shared inline-style tokens (global sizing spec) ────────────
const CARD_STYLE: React.CSSProperties = {
  padding: '16px 20px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};
const SECTION_HEADING: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  marginBottom: 8,
  letterSpacing: '0.06em',
};
// Quiet "eyebrow" label that sits ABOVE a row group (Performance / Availability /
// Predictive / etc.) to give the dashboard a scannable hierarchy. Deliberately
// lighter than the in-card SECTION_HEADING so it groups without competing.
const GROUP_LABEL: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  letterSpacing: '0.06em',
  margin: '2px 0 6px',
};

// ── Helpers (top-level) ────────────────────────────────────────
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function statusRank(s: string): number {
  if (s === 'down') return 0;
  if (s === 'warning') return 1;
  return 2;
}
function fmtSpan(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function durSince(ts: string | null | undefined): string {
  if (!ts) return '';
  return fmtSpan(Date.now() - new Date(ts).getTime());
}
function spanBetween(a: string | null | undefined, b: string | null | undefined): string {
  if (!a || !b) return '';
  return fmtSpan(new Date(b).getTime() - new Date(a).getTime());
}
function msColor(ms: number | null): string {
  if (ms == null) return 'var(--text-muted)';
  if (ms < 100) return 'var(--green)';
  if (ms <= 500) return 'var(--yellow)';
  return 'var(--red)';
}
function uptimeColor(p: number | null): string {
  if (p == null) return 'var(--text-muted)';
  if (p >= 99) return 'var(--green)';
  if (p >= 90) return 'var(--yellow)';
  return 'var(--red)';
}
function hhmm(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// Availability now vs ~1h ago (two 30-min buckets back) → trend signal.
function availTrend(points: TrendPoint[] | null | undefined): 'up' | 'down' | 'flat' | null {
  if (!points) return null;
  const valid = points.filter((p) => p.pct_up != null) as Required<TrendPoint>[];
  if (valid.length < 2) return null;
  const now = valid[valid.length - 1].pct_up as number;
  const then = valid[Math.max(0, valid.length - 3)].pct_up as number;
  const d = now - then;
  if (d > 0.1) return 'up';
  if (d < -0.1) return 'down';
  return 'flat';
}

// ── NOC fullscreen toggle (top-level component) ────────────────
// Enters browser fullscreen and applies a dark high-contrast theme via a body
// class. Escape (native fullscreen exit) is handled by the fullscreenchange
// listener, which clears the class.
function NocViewButton() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    function sync() {
      const fs = !!document.fullscreenElement;
      setOn(fs);
      document.body.classList.toggle('sv-noc', fs);
    }
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.body.classList.remove('sv-noc');
    };
  }, []);
  async function toggle() {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch (_e) { /* ignore */ }
      document.body.classList.remove('sv-noc');
      setOn(false);
    } else {
      try { await document.documentElement.requestFullscreen(); }
      catch (_e) { document.body.classList.add('sv-noc'); setOn(true); } // fallback: themed, not fullscreen
    }
  }
  return (
    <button className="sv-btn ghost" onClick={toggle} title="NOC fullscreen view (Esc to exit)">
      <IconMonitor width={15} height={15} style={{ verticalAlign: '-2px' }} /> {on ? 'Exit NOC' : 'NOC View'}
    </button>
  );
}

export default function DashboardPage() {
  const { canManageAgents } = useRbac();
  const { state: licenseState, loading: licenseLoading } = useLicense();
  const summary = useApi<Summary>('/api/dashboard/summary', REFRESH_MS);
  const problems = useApi<Problem[]>('/api/dashboard/problems', REFRESH_MS);
  const worst = useApi<Worst[]>('/api/dashboard/top-worst', REFRESH_MS);
  const trend = useApi<TrendPoint[]>('/api/dashboard/network-trend', REFRESH_MS);
  const sites = useApi<SiteHealth[]>('/api/dashboard/site-health', REFRESH_MS);
  const events = useApi<EventRow[]>('/api/dashboard/events', REFRESH_MS);
  const agentOffline = useApi<AgentOfflineRow[]>('/api/dashboard/agent-offline', REFRESH_MS);
  const intel = useApi<Overview>('/api/intelligence/overview', REFRESH_MS);
  const ops = useApi<OpsSummary>('/api/dashboard/ops-summary', REFRESH_MS);
  const incidents = useApi<OpenIncident[]>('/api/dashboard/incidents', REFRESH_MS);
  const sla = useApi<Sla>('/api/dashboard/sla', REFRESH_MS);
  const capacity = useApi<CapacityRow[]>('/api/dashboard/capacity', REFRESH_MS);
  const patterns = useApi<PatternRow[]>('/api/dashboard/patterns', REFRESH_MS);
  const leastReliable = useApi<LeastReliable[]>('/api/dashboard/least-reliable', REFRESH_MS);
  const topTalkers = useApi<TopTalker[]>('/api/dashboard/top-talkers', REFRESH_MS);
  const maintenance = useApi<MaintenanceData>('/api/dashboard/maintenance', REFRESH_MS);
  const services = useApi<ServiceCheck[]>('/api/service-checks', REFRESH_MS);

  const updatedAt = useUpdatedAt(summary.data);
  const ago = useSecondsAgo(updatedAt);

  // Global "R" shortcut / refresh button reloads every dashboard panel.
  useRefreshKey(() => {
    summary.reload(); problems.reload(); worst.reload();
    trend.reload(); sites.reload(); events.reload(); agentOffline.reload();
    intel.reload(); ops.reload(); incidents.reload(); sla.reload();
    capacity.reload(); patterns.reload(); leastReliable.reload(); topTalkers.reload();
    maintenance.reload(); services.reload();
  });

  const s = summary.data;
  const tDir = availTrend(trend.data);
  // DOWN card: availability improving means fewer down.
  const downTrend = tDir === 'up' ? 'good' : tDir === 'down' ? 'bad' : null;
  const downArrow = tDir === 'up' ? '↓' : tDir === 'down' ? '↑' : '';

  // License expired and grace period ended → lock the app behind a renewal screen.
  if (!licenseLoading && licenseState.disabled) {
    return <LicenseDisabledScreen />;
  }

  return (
    <div>
      <UpdatedNotice />
      <RedirectNotice />
      <PageHeader title="Dashboard" subtitle="Live network health across all monitored devices.">
        <span className="sv-muted" style={{ fontSize: 'var(--text-base)' }}>
          {updatedAt ? `Updated ${ago === 0 ? 'just now' : `${ago} second${ago === 1 ? '' : 's'} ago`}` : 'Loading…'}
        </span>
        <NocViewButton />
      </PageHeader>

      {/* ── KPI strip: status + operational metrics in a single row ── */}
      {summary.error && <ErrorBox message={summary.error} />}
      {summary.loading && !s ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 10 }}>
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} style={{ ...CARD_STYLE, height: 74, padding: '10px 13px' }}>
              <Skeleton height={20} width="55%" />
              <div style={{ height: 6 }} />
              <Skeleton height={9} width="75%" />
            </div>
          ))}
        </div>
      ) : s ? (
        <>
          {/* Single responsive KPI strip — deliberately narrowed to the 6 tiles
              that answer "is anything broken right now, and are we meeting our
              commitments": current-state (Down/Warning), actionable backlog
              (Unack'd), composite glance score (Health), the tracked commitment
              (SLA), and Total as the scale anchor those numbers sit against.
              Up/Alerts/Unknown/MTTR/MTTA/Wireless were dropped from this row —
              MTTR/MTTA are retrospective (better on Reports), Alerts overlaps
              Unack'd but is less actionable, and Wireless is a domain-specific
              count better surfaced on its own page. Agents/Services are back,
              but only when abnormal (AgentsTile/ServicesTile self-hide unless
              something is actually down) — they stay meta/boring noise when
              healthy, but earn their spot the moment they're not. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 10 }}>
            <StatTile href="/devices" color="var(--text-primary)" value={s.total} label="Total" />
            <StatTile href="/devices?status=down" color="var(--red)" value={s.down} label="Down"
              pulse={s.down > 0} trend={downTrend} arrow={downArrow} />
            <StatTile href="/devices?status=warning" color="var(--yellow)" value={s.warning} label="Warning"
              pulse={s.warning > 0} />
            <HealthScoreTile data={intel.data} />
            <SlaTile api={sla} />
            <OpsTile
              color={ops.data && ops.data.unacked_count > 0 ? 'var(--red)' : 'var(--green)'}
              value={ops.data ? ops.data.unacked_count : 0}
              label="Unack'd"
              alert={!!(ops.data && ops.data.unacked_count > 0)}
            />
            <AgentsTile canManageAgents={canManageAgents} agentsOnline={s.agents_online} agentsTotal={s.agents_total} />
            <ServicesTile checks={services.data || []} />
          </div>
        </>
      ) : null}

      {/* ── Anomaly banner (slim, only if anomalies) ── */}
      <AnomalyBanner data={intel.data} />

      {/* ── Maintenance windows (planned — active now or within 7 days) ── */}
      <MaintenanceGroup api={maintenance} />

      {/* ── Hero row: active problems + open incidents. Each card is hidden once
           it has loaded with nothing to show (still shown while loading or on
           error), so an all-healthy network reclaims the space and the cards
           below move up. The row collapses to one column if only one remains. ── */}
      {(() => {
        const showProblems = problems.error != null || problems.data == null || problems.data.length > 0;
        const showIncidents = incidents.error != null || incidents.data == null || incidents.data.length > 0;
        const shown = (showProblems ? 1 : 0) + (showIncidents ? 1 : 0);
        if (shown === 0) return null;
        return (
          <div style={{ marginBottom: 10 }}>
            <div style={{ ...GROUP_LABEL, color: 'var(--red)' }}>Needs Attention</div>
            <div style={{ display: 'grid', gridTemplateColumns: shown === 2 ? '1fr 1fr' : '1fr', gap: 10, alignItems: 'stretch' }}>
              {showProblems && <ActiveProblems api={problems} />}
              {showIncidents && <OpenIncidents api={incidents} />}
            </div>
          </div>
        );
      })()}

      {/* ── Agent-offline group (devices unreachable via an offline agent) ── */}
      <AgentOfflineGroup api={agentOffline} />

      {/* ── Performance / reliability (3-up): slowest · top talkers · least reliable ── */}
      <div style={GROUP_LABEL}>Performance</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, alignItems: 'stretch', marginBottom: 10 }}>
        <SlowestDevices api={worst} />
        <TopTalkers api={topTalkers} />
        <LeastReliableDevices api={leastReliable} />
      </div>

      {/* ── Availability (3-up): site health · trend · SLA breaches ── */}
      <div style={GROUP_LABEL}>Availability</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, alignItems: 'stretch', marginBottom: 10 }}>
        <SiteHealthCard api={sites} />
        <NetworkAvailabilityCard api={trend} />
        <SlaBreaches api={sla} />
      </div>

      {/* ── Predictive (3-up): approaching capacity · recurring patterns · at-risk ── */}
      <div style={GROUP_LABEL}>Predictive</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, alignItems: 'stretch', marginBottom: 10 }}>
        <ApproachingCapacity api={capacity} />
        <RecurringPatterns api={patterns} />
        <AtRiskDevices data={intel.data} />
      </div>

      {/* ── Recent events + wireless health (wireless self-hides → events fills) ── */}
      <div style={GROUP_LABEL}>Recent Activity</div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', marginBottom: 16 }}>
        <div style={{ ...CARD_STYLE, flex: 1, minWidth: 0, height: 220 }}>
          <div style={SECTION_HEADING}>Recent Events</div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px' }}>
            <RecentEvents api={events} />
          </div>
        </div>
        <ServiceProblems checks={services.data || []} />
        <WirelessHealthCard />
      </div>
    </div>
  );
}

// ── Redirect notice (top-level component) ──────────────────────
// Shows a dismissible banner when another page bounced the user here with a
// ?notice=... message (e.g. a view-only role hitting Settings or Agents).
function RedirectNotice() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const n = new URLSearchParams(window.location.search).get('notice');
    if (n) {
      setMsg(n);
      // Strip the param so a refresh doesn't re-show it.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);
  if (!msg) return null;
  return (
    <div
      onClick={() => setMsg(null)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        marginBottom: 12, borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', fontWeight: 600,
        cursor: 'pointer', color: '#92400e', background: 'rgba(217,119,6,0.10)',
        border: '1px solid rgba(217,119,6,0.30)',
      }}
    >
      <IconWarning width={15} height={15} aria-hidden style={{ flexShrink: 0 }} /><span>{msg}</span>
    </div>
  );
}

// Dismissible banner shown after the in-app updater redirects here. Mirrors
// RedirectNotice: reads the query param on mount (no useSearchParams → no
// Suspense requirement) and strips it so a refresh won't re-show it.
//
// Two distinct outcomes, both set by settings/page.tsx's UpdatingOverlay
// AFTER it has actually checked /api/system/last-update-status — never from
// the health-poll transition alone (that only proves something is answering,
// not which version):
//   ?updated=true          — a clean, non-rolled-back update. Green success.
//   ?updateRolledBack=true — the update failed and was automatically rolled
//                            back. Amber warning, NOT the green banner — a
//                            rolled-back run must never be presented as a
//                            success. (rollback-ALSO-failed never reaches
//                            here at all — the overlay does not auto-reload
//                            for that outcome, see UpdatingOverlay.)
// This is the single source of truth for what to show IMMEDIATELY after an
// update; UpdateFailureBanner (persistent, polls independently) is only
// relevant for a LATER page load — the overlay pre-dismisses it for this same
// event via sessionStorage before navigating here, so the two never show
// contradictory information at once.
function UpdatedNotice() {
  const [state, setState] = useState<'none' | 'success' | 'rolledback'>('none');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('updated') === 'true') {
      setState('success');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('updateRolledBack') === 'true') {
      setState('rolledback');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);
  if (state === 'none') return null;
  if (state === 'rolledback') {
    return (
      <div
        onClick={() => setState('none')}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
          marginBottom: 12, borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', fontWeight: 600,
          cursor: 'pointer', color: '#92400e', background: 'rgba(217,119,6,0.10)',
          border: '1px solid rgba(217,119,6,0.30)',
        }}
      >
        <IconWarning width={15} height={15} aria-hidden style={{ flexShrink: 0 }} />
        <span>An update failed and was automatically rolled back — SpanVault is running normally on the previous version. See Settings → Updates for details.</span>
      </div>
    );
  }
  return (
    <div
      onClick={() => setState('none')}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        marginBottom: 12, borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', fontWeight: 600,
        cursor: 'pointer', color: '#166534', background: 'rgba(22,163,74,0.10)',
        border: '1px solid rgba(22,163,74,0.30)',
      }}
    >
      <IconCheck width={15} height={15} aria-hidden style={{ flexShrink: 0 }} /><span>SpanVault updated successfully</span>
    </div>
  );
}

// ── KPI stat tile (clickable link) ─────────────────────────────
// Global stat-card style: ~75px height, 12px/16px padding, 24px/800 value,
// 11px uppercase muted label, 3px coloured left border.
function StatTile({
  href, value, label, color, pulse, trend, arrow,
}: {
  href: string; value: number | string; label: string; color: string;
  pulse?: boolean; trend?: 'good' | 'bad' | null; arrow?: string;
}) {
  const trendColor = trend === 'good' ? 'var(--green)' : trend === 'bad' ? 'var(--red)' : 'var(--text-muted)';
  return (
    <Link
      href={href}
      className={pulse ? 'sv-stat pulse' : undefined}
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
        height: 74, padding: '10px 13px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`, textDecoration: 'none', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</span>
        {trend && arrow ? <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: trendColor }}>{arrow}</span> : null}
      </div>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
        {label}
      </div>
    </Link>
  );
}

// ── Health-score stat tile (top-level component) ───────────────
function HealthScoreTile({ data }: { data: Overview | null }) {
  const score = data ? data.overall_score : null;
  const c = scoreColor(score);
  return (
    <Link
      href="/intelligence"
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
        height: 74, padding: '10px 13px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${c}`, textDecoration: 'none', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: c, lineHeight: 1 }}>
          {score != null ? Math.round(score) : '—'}
        </span>
        {data && <GradeBadge grade={data.overall_grade} />}
      </div>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
        Health
      </div>
    </Link>
  );
}

// ── Agents tile (manage-agents users; ONLY shown when abnormal) ─
// Inline strip tile; returns null unless the viewer can manage agents, at
// least one agent is registered, AND at least one is currently offline —
// deliberately noisy-free when healthy, so it only claims a slot in the KPI
// row the moment it's actually worth a glance.
function AgentsTile({ canManageAgents, agentsOnline, agentsTotal }: {
  canManageAgents: boolean; agentsOnline: number; agentsTotal: number;
}) {
  if (!canManageAgents || agentsTotal <= 0) return null;
  const down = agentsOnline < agentsTotal;
  if (!down) return null;
  return (
    <Link
      href="/agents"
      className="sv-stat pulse"
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
        height: 74, padding: '10px 13px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: '3px solid var(--red)', textDecoration: 'none', minWidth: 0,
      }}
    >
      <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
        {agentsOnline}/{agentsTotal}
      </span>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
        Agents
      </div>
    </Link>
  );
}

// ── Services KPI tile (ONLY shown when a service is down/warning) ─
// Inline strip tile; returns null unless at least one service check has a
// problem — same "earn your slot" rule as AgentsTile, so an all-healthy
// service fleet never occupies the top row.
function ServicesTile({ checks }: { checks: ServiceCheck[] }) {
  if (!checks.length) return null;
  const total = checks.length;
  let up = 0, down = 0, warning = 0;
  for (const c of checks) {
    const st = (c.current_status || '').toLowerCase();
    if (st === 'up') up += 1;
    else if (st === 'down') down += 1;
    else if (st === 'warning') warning += 1;
  }
  if (down === 0 && warning === 0) return null;
  const color = down > 0 ? 'var(--red)' : 'var(--yellow)';
  return (
    <Link
      href="/services"
      className="sv-stat pulse"
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
        height: 74, padding: '10px 13px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`, textDecoration: 'none', minWidth: 0,
      }}
    >
      <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
        {up}/{total}
      </span>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
        Services
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {down} down · {warning} warning
      </div>
    </Link>
  );
}

// ── Service problems list card (self-hides when no problems) ───
// Down/warning service checks only; down sorts before warning. Hides the whole
// card when everything is healthy, so it never strands an empty card in a flex row.
function ServiceProblems({ checks }: { checks: ServiceCheck[] }) {
  const rows = checks
    .filter((c) => {
      const st = (c.current_status || '').toLowerCase();
      return st === 'down' || st === 'warning';
    })
    .sort((a, b) => statusRank(a.current_status.toLowerCase()) - statusRank(b.current_status.toLowerCase()));
  if (!rows.length) return null;
  return (
    <div style={{ ...CARD_STYLE, flex: 1, minWidth: 0, height: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <StatusDot status="down" size={11} />
        <span style={SECTION_HEADING}>Service Problems</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {rows.map((c) => (
          <Link
            key={c.id}
            href="/services"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)',
              borderBottom: '1px solid var(--border-light)', textDecoration: 'none',
            }}
          >
            <StatusDot status={c.current_status} size={10} />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span style={{
              flexShrink: 0, fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
              color: 'var(--text-muted)', background: 'var(--border)', padding: '1px 6px', borderRadius: 4,
            }}>
              {(c.type || '').toUpperCase()}
            </span>
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.target}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>
              {c.last_detail || '—'}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Anomaly banner (slim, single-line, blue) ───────────────────
function AnomalyBanner({ data }: { data: Overview | null }) {
  if (!data || !data.active_anomalies) return null;
  const c = data.active_anomalies;
  return (
    <Link
      href="/intelligence#anomalies"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
        marginBottom: 12, borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-base)', fontWeight: 600,
        color: '#1d4ed8', background: 'rgba(37,99,235,0.10)',
        border: '1px solid rgba(37,99,235,0.30)', textDecoration: 'none',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <IconSearch width={15} height={15} aria-hidden />
        {c} {c === 1 ? 'anomaly' : 'anomalies'} detected
      </span>
      <span style={{ marginLeft: 'auto', fontWeight: 700 }}>View Intelligence →</span>
    </Link>
  );
}

// ── At-risk devices (health score < 70) (top-level component) ──
function AtRiskDevices({ data }: { data: Overview | null }) {
  const atRisk = (data && data.at_risk_devices ? data.at_risk_devices : [])
    .filter((d: HealthRow) => { const s = intelNum(d.score); return s != null && s < 70; });
  return (
    <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--yellow)', height: 220, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <StatusDot status="warning" size={11} />
        <span style={SECTION_HEADING}>At Risk</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{atRisk.length}</span>
      </div>
      {atRisk.length ? (
        <>
          <div style={{ flex: 1, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
            {atRisk.map((d: HealthRow) => {
              const s = intelNum(d.score);
              return (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, borderBottom: '1px solid var(--border-light)', fontSize: 'var(--text-sm)' }}>
                  <IconWarning width={14} height={14} aria-hidden style={{ color: 'var(--yellow)', flexShrink: 0 }} />
                  <Link href={`/devices/${d.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{d.name}</Link>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: scoreColor(s) }}>Health score {s != null ? Math.round(s) : '—'}/100</span>
                  <span style={{ color: 'var(--text-muted)' }}>({d.trend || 'stable'})</span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <Link href="/intelligence#health" className="sv-dash-link">View health scores →</Link>
          </div>
        </>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>
          No at-risk devices ✓
        </div>
      )}
    </div>
  );
}

// ── Active problems (top-level component) ──────────────────────
// Card is fixed 240px tall with an internal scroll region; problem rows are
// compact (36px). Down site gateways float to the top and show a red badge with
// the suppressed-device count inline (suppression logic preserved).
function ActiveProblems({ api }: { api: Api<Problem[]> }) {
  const list = api.data || [];
  const sorted = [...list].sort((a, b) => {
    // Down site gateways float to the very top — they're the root cause.
    const ga = a.is_gateway && a.current_status === 'down' ? 0 : 1;
    const gb = b.is_gateway && b.current_status === 'down' ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const r = statusRank(a.current_status) - statusRank(b.current_status);
    if (r) return r;
    // Longest-running first: older last_seen_at (down longer) comes first.
    const ta = new Date(a.last_seen_at || a.last_checked_at || 0).getTime();
    const tb = new Date(b.last_seen_at || b.last_checked_at || 0).getTime();
    return ta - tb;
  });
  const hasProblems = sorted.length > 0;

  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {hasProblems && <StatusDot status="down" size={11} />}
        <span style={SECTION_HEADING}>Active Problems</span>
        {hasProblems && <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{sorted.length}</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={3} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !hasProblems ? (
          <div style={{
            height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--green)',
          }}>
            <IconCheck width={28} height={28} aria-hidden />
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>All systems operational</div>
          </div>
        ) : (
          sorted.map((p) => {
            const down = p.current_status === 'down';
            const gwDown = p.is_gateway && down;
            const ms = num(p.last_response_ms);
            return (
              <div key={p.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}>
                  <StatusDot status={p.current_status} size={10} />
                  <Link href={`/devices/${p.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{p.name}</Link>
                  {gwDown && (
                    <span
                      title="Site gateway is down"
                      style={{
                        fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
                        color: '#fff', background: 'var(--red)', padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap',
                      }}
                    >
                      Gateway Down{p.suppressed_in_site > 0 ? ` · ${p.suppressed_in_site} suppressed` : ''}
                    </span>
                  )}
                  {p.site_id ? (
                    <Link href={`/sites/${p.site_id}`} style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.site_name}</Link>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>{p.site_name || 'Unassigned'}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  {down ? (
                    <span style={{ color: 'var(--red)', whiteSpace: 'nowrap' }}>
                      {durSince(p.last_seen_at) ? `down ${durSince(p.last_seen_at)}` : 'down'}
                    </span>
                  ) : (
                    <span style={{ color: msColor(ms), whiteSpace: 'nowrap' }}>
                      {ms != null ? `${ms.toFixed(0)} ms` : 'high latency'}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Slowest devices (top-level component) ──────────────────────
// Matches the Active Problems card height (240px). Compact 36px table rows;
// clicking a row navigates to the device detail page.
function SlowestDevices({ api }: { api: Api<Worst[]> }) {
  const rows = (api.data || []).slice(0, 5);
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={SECTION_HEADING}>Slowest Devices (Last 1h)</div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={5} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No ping data yet" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <Th style={{ width: 28, textAlign: 'left' }}>#</Th>
                <Th style={{ textAlign: 'left' }}>Device</Th>
                <Th style={{ textAlign: 'left' }}>Site</Th>
                <Th style={{ width: 64, textAlign: 'right' }}>Avg ms</Th>
                <Th style={{ width: 56, textAlign: 'right' }}>Loss%</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => {
                const avg = num(d.avg_ms);
                const loss = num(d.packet_loss_pct);
                return (
                  <tr
                    key={d.id}
                    style={{ height: 36, cursor: 'pointer' }}
                  >
                    <Td style={{ color: 'var(--text-muted)' }}>{i + 1}</Td>
                    <Td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Link href={`/devices/${d.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{d.name}</Link>
                    </Td>
                    <Td style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.site_name || '—'}</Td>
                    <Td style={{ textAlign: 'right', color: msColor(avg), fontWeight: 600 }}>{avg != null ? avg.toFixed(0) : '—'}</Td>
                    <Td style={{ textAlign: 'right', color: loss && loss > 0 ? 'var(--red)' : 'var(--text-muted)' }}>
                      {loss != null ? `${loss.toFixed(0)}%` : '—'}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Shared table cells (top-level) ─────────────────────────────
function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th style={{
      fontSize: 'var(--text-xs)', textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)',
      padding: '8px 12px', letterSpacing: '0.03em', borderBottom: '1px solid var(--border)', ...style,
    }}>{children}</th>
  );
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{
      fontSize: 'var(--text-sm)', color: 'var(--text-primary)', padding: '8px 12px',
      borderBottom: '1px solid var(--border-light)', ...style,
    }}>{children}</td>
  );
}

// ── Site health (top-level component) ──────────────────────────
// Card height 220px; up to 6 site rows (36px each) with a 4px progress bar,
// then scroll. Layout: "Site name | bar | % | X up · Y down".
function SiteHealthCard({ api }: { api: Api<SiteHealth[]> }) {
  // Worst first: lowest uptime at the top (sites with no data sort last).
  const rows = [...(api.data || [])].sort((a, b) => {
    const ua = a.avg_uptime_pct == null ? 101 : Number(a.avg_uptime_pct);
    const ub = b.avg_uptime_pct == null ? 101 : Number(b.avg_uptime_pct);
    return ua - ub;
  });
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={SECTION_HEADING}>Site Health (24h)</div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={3} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No monitored devices yet." />
        ) : (
          rows.map((st) => {
            const pct = num(st.avg_uptime_pct);
            const pills = [`${st.up_count} up`, `${st.down_count} down`];
            if (st.warning_count) pills.push(`${st.warning_count} warn`);
            return (
              <div key={st.site_id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, fontSize: 'var(--text-sm)' }}>
                <span style={{ width: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {st.site_id ? (
                    <Link href={`/sites/${st.site_id}`} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{st.site_name}</Link>
                  ) : <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{st.site_name}</span>}
                </span>
                <span style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                  <span style={{
                    display: 'block', height: '100%', borderRadius: 2,
                    width: `${pct != null ? Math.max(2, pct) : 0}%`, background: uptimeColor(pct),
                  }} />
                </span>
                <span style={{ width: 50, textAlign: 'right', color: uptimeColor(pct), fontWeight: 600 }}>
                  {pct != null ? `${pct.toFixed(1)}%` : '—'}
                </span>
                <span style={{ width: 110, textAlign: 'right', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {pills.join(' · ')}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Network availability card (top-level component) ────────────
function NetworkAvailabilityCard({ api }: { api: Api<TrendPoint[]> }) {
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={SECTION_HEADING}>Network Availability (24h)</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {api.loading && !api.data ? (
          <Skeleton height={160} radius={8} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : (
          <NetworkTrendChart data={api.data || []} />
        )}
      </div>
    </div>
  );
}

// ── Network availability trend chart (top-level component) ─────
function NetworkTrendChart({ data }: { data: TrendPoint[] }) {
  const pts = data
    .filter((d) => d.pct_up != null)
    .map((d) => ({ bucket: d.bucket, pct: Number(d.pct_up) }));
  if (!pts.length) return <Empty message="Collecting data…" />;

  const minVal = Math.min(...pts.map((p) => p.pct));
  const domainMin = Math.max(0, Math.min(95, Math.floor(minVal - 1)));
  // Fraction down from the top of the plot where the 95% reference line sits.
  const off = Math.max(0, Math.min(1, (100 - 95) / (100 - domainMin)));

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={pts} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="svAvail" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2e9e5b" stopOpacity={0.55} />
            <stop offset={`${off * 100}%`} stopColor="#2e9e5b" stopOpacity={0.22} />
            <stop offset={`${off * 100}%`} stopColor="#e6a700" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#C8102E" stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
        <XAxis dataKey="bucket" tickFormatter={hhmm} fontSize={11} minTickGap={44} tickLine={false} axisLine={false} />
        <YAxis domain={[domainMin, 100]} fontSize={11} width={40} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
        <Tooltip
          {...CHART_TOOLTIP}
          labelFormatter={(l) => fmtTime(String(l))}
          formatter={(v: any) => [`${Number(v).toFixed(1)}%`, 'Availability']}
        />
        <ReferenceLine y={95} stroke="#C8102E" strokeDasharray="4 4"
          label={{ value: '95%', position: 'right', fontSize: 'var(--text-xs)', fill: '#C8102E' }} />
        <Area type="monotone" dataKey="pct" stroke="#2e9e5b" strokeWidth={2}
          fill="url(#svAvail)" connectNulls isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Recent events (top-level component) ────────────────────────
function describeEvent(e: EventRow): { icon: string; text: string } {
  if (e.resolved_at) {
    if (e.alert_type === 'device_down') {
      const span = spanBetween(e.triggered_at, e.resolved_at);
      return { icon: '🟢', text: span ? `recovered after ${span} downtime` : 'recovered' };
    }
    return { icon: '🟢', text: `${humanEvent(e.alert_type)} cleared` };
  }
  if (e.alert_type === 'device_down' || e.severity === 'critical') {
    return { icon: '🔴', text: 'went DOWN' };
  }
  return { icon: '🟡', text: warnText(e.alert_type) };
}
function warnText(type: string): string {
  switch (type) {
    case 'high_latency': return 'response time exceeded threshold';
    case 'high_cpu':     return 'CPU exceeded threshold';
    case 'high_memory':  return 'memory exceeded threshold';
    case 'wireless_high_retry': return 'retry rate exceeded threshold';
    case 'wireless_client_imbalance': return 'client band imbalance detected';
    case 'wireless_high_interference': return 'interference exceeded threshold';
    case 'wireless_degraded_noise_floor': return 'noise floor degraded';
    case 'wireless_roam_storm': return 'roam storm detected';
    case 'wireless_weak_clients': return 'weak/low-rate clients detected';
    default:             return type.startsWith('rule_') ? 'alert rule triggered' : type.replace(/_/g, ' ');
  }
}
function humanEvent(type: string): string {
  switch (type) {
    case 'device_down':  return 'outage';
    case 'high_latency': return 'high latency';
    case 'high_cpu':     return 'high CPU';
    case 'high_memory':  return 'high memory';
    case 'wireless_high_retry': return 'high retry rate';
    case 'wireless_client_imbalance': return 'client band imbalance';
    case 'wireless_high_interference': return 'high interference';
    case 'wireless_degraded_noise_floor': return 'degraded noise floor';
    case 'wireless_roam_storm': return 'roam storm';
    case 'wireless_weak_clients': return 'weak clients';
    default:             return type.replace(/_/g, ' ');
  }
}

// Wireless AP/controller and service-check alerts have device_id = NULL — link
// to the entity that actually owns the event instead of falling through to
// /devices/null (mirrors the same device_id == null handling on /alerts).
function EventSubject({ e }: { e: EventRow }) {
  if (e.device_id == null && e.service_name) {
    return (
      <Link href="/services" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
        {e.service_name}
      </Link>
    );
  }
  if (e.device_id == null && e.wireless_name) {
    return (
      <Link href="/wireless" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
        {e.wireless_name}
      </Link>
    );
  }
  if (e.device_id == null) {
    return <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{e.message || 'Unknown event'}</span>;
  }
  return (
    <Link href={`/devices/${e.device_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
      {e.device_name || `#${e.device_id}`}
    </Link>
  );
}

function RecentEvents({ api }: { api: Api<EventRow[]> }) {
  const rows = (api.data || []).slice(0, 20);
  if (api.loading && !api.data) return <TableSkeleton rows={6} cols={2} />;
  if (api.error) return <ErrorBox message={api.error} />;
  if (!rows.length) return <Empty message="No events in the last 24 hours" />;
  return (
    <div>
      {rows.map((e) => {
        const { icon, text } = describeEvent(e);
        return (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)', padding: '0 4px' }}>
            <span title={fmtTime(e.event_at)} style={{ width: 64, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtRel(e.event_at)}</span>
            <span style={{ flexShrink: 0 }}>{icon}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <EventSubject e={e} />{' '}
              <span style={{ color: 'var(--text-primary)' }}>{text}</span>
            </span>
            <span style={{ flex: 1 }} />
            {e.wireless_client_mac && (
              <span title={e.wireless_client_mac} style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{e.wireless_client_mac}</span>
            )}
            {e.site_name && <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{e.site_name}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ── Agent-offline group (top-level component) ──────────────────
// Devices that can't be polled because their remote agent is offline. These are
// surfaced separately and NOT counted as "down" in the stat cards.
function AgentOfflineGroup({ api }: { api: Api<AgentOfflineRow[]> }) {
  const rows = api.data || [];
  if (!rows.length) return null;
  return (
    <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--yellow)', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <StatusDot status="warning" size={11} />
        <span style={SECTION_HEADING}>Agent Offline</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>
      </div>
      {rows.map((r) => (
        <div key={r.agent_id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}>
          <IconWarning width={14} height={14} aria-hidden style={{ color: 'var(--yellow)', flexShrink: 0 }} />
          <Link href={`/agents/${r.agent_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.agent_name}</Link>
          {r.hostname && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>· {r.hostname}</span>}
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {r.device_count} device{r.device_count === 1 ? '' : 's'} unreachable · last seen {fmtRel(r.last_seen_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Ops metrics (Unacknowledged) ────────────────────────────────
// Plain (non-link) KPI tile matching the StatTile visual spec.
function OpsTile({ value, label, color, alert }: {
  value: string | number; label: string; color: string; alert?: boolean;
}) {
  return (
    <div
      className={alert ? 'sv-stat pulse' : undefined}
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
        height: 74, padding: '10px 13px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`, minWidth: 0,
      }}
    >
      <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</span>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
        {label}
      </div>
    </div>
  );
}

// ── Open incidents (correlated alert groups) ───────────────────
function severityDotStatus(sev: string): string {
  if (sev === 'critical') return 'down';
  if (sev === 'warning') return 'warning';
  return 'unknown';
}
function OpenIncidents({ api }: { api: Api<OpenIncident[]> }) {
  const rows = api.data || [];
  const has = rows.length > 0;
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {has && <StatusDot status="down" size={11} />}
        <span style={SECTION_HEADING}>Open Incidents</span>
        {has && <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={4} cols={3} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !has ? (
          <div style={{
            height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--green)',
          }}>
            <IconCheck width={28} height={28} aria-hidden />
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>No open incidents</div>
          </div>
        ) : (
          rows.map((i) => {
            const age = durSince(i.started_at);
            return (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}>
                <StatusDot status={severityDotStatus(i.severity)} size={10} />
                {i.root_cause_device_id ? (
                  <Link href={`/devices/${i.root_cause_device_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {i.title}
                  </Link>
                ) : (
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</span>
                )}
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{i.affected_count} affected</span>
                <span style={{ flex: 1 }} />
                {age && <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{age}</span>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── 30-day SLA KPI tile ────────────────────────────────────────
function SlaTile({ api }: { api: Api<Sla> }) {
  const pct = num(api.data ? api.data.overall_pct : null);
  const target = api.data ? api.data.sla_target : null;
  const c = uptimeColor(pct);
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
        height: 74, padding: '10px 13px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${c}`, minWidth: 0,
      }}
    >
      <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: c, lineHeight: 1 }}>
        {pct != null ? `${pct.toFixed(1)}%` : '—'}
      </span>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
        SLA 30d
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        Target {target != null ? `${Number(target).toFixed(1)}%` : '—'}
      </div>
    </div>
  );
}

// ── SLA breaches panel (rolling 30-day uptime below target) ────
function SlaBreaches({ api }: { api: Api<Sla> }) {
  const rows = api.data ? api.data.breaching : [];
  const target = api.data ? api.data.sla_target : null;
  const hasBreaches = rows.length > 0;
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={SECTION_HEADING}>SLA Breaches (30d)</span>
        {target != null && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>target {Number(target).toFixed(1)}%</span>
        )}
        {hasBreaches && <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={3} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !hasBreaches ? (
          <div style={{
            height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--green)',
          }}>
            <IconCheck width={28} height={28} aria-hidden />
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>All devices meeting SLA</div>
          </div>
        ) : (
          rows.map((d) => {
            const pct = num(d.uptime_pct);
            return (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, fontSize: 'var(--text-sm)' }}>
                <span style={{ width: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <Link href={`/devices/${d.id}`} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{d.name}</Link>
                  {d.site_name && <span style={{ color: 'var(--text-muted)' }}> · {d.site_name}</span>}
                </span>
                <span style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                  <span style={{
                    display: 'block', height: '100%', borderRadius: 2,
                    width: `${pct != null ? Math.max(2, Math.min(100, pct)) : 0}%`, background: 'var(--red)',
                  }} />
                </span>
                <span style={{ width: 56, textAlign: 'right', color: 'var(--red)', fontWeight: 600 }}>
                  {pct != null ? `${pct.toFixed(1)}%` : '—'}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Approaching capacity (CPU/memory p95 >= 80%) ───────────────
function capacityMetricLabel(metric: string): string {
  if (metric === 'cpu_pct') return 'CPU';
  if (metric === 'mem_pct') return 'Memory';
  return metric;
}
function capacityColor(p: number | null): string {
  if (p == null) return 'var(--text-muted)';
  if (p >= 90) return 'var(--red)';
  if (p >= 80) return 'var(--yellow)';
  return 'var(--green)';
}
function ApproachingCapacity({ api }: { api: Api<CapacityRow[]> }) {
  const rows = api.data || [];
  const hasRows = rows.length > 0;
  return (
    <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--yellow)', height: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {hasRows && <StatusDot status="warning" size={11} />}
        <span style={SECTION_HEADING}>Approaching Capacity</span>
        {hasRows && <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={3} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !hasRows ? (
          <div style={{
            height: '100%', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 4, color: 'var(--green)',
          }}>
            <IconCheck width={28} height={28} aria-hidden />
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>No capacity concerns</div>
          </div>
        ) : (
          rows.map((c) => {
            const p95 = num(c.p95);
            const color = capacityColor(p95);
            return (
              <div
                key={`${c.id}-${c.metric}`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}
              >
                <Link
                  href={`/devices/${c.id}`}
                  style={{ width: 140, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={c.name}
                >
                  {c.name}
                </Link>
                <span style={{ width: 54, color: 'var(--text-muted)', flexShrink: 0 }}>{capacityMetricLabel(c.metric)}</span>
                <span style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                  <span style={{
                    display: 'block', height: '100%', borderRadius: 2,
                    width: `${p95 != null ? Math.min(100, Math.max(2, p95)) : 0}%`, background: color,
                  }} />
                </span>
                <span style={{ width: 48, textAlign: 'right', color, fontWeight: 600, flexShrink: 0 }}>
                  {p95 != null ? `${p95.toFixed(0)}%` : '—'}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Recurring patterns (predictive insight) ────────────────────
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function patternMetricLabel(metric: string): string {
  switch (metric) {
    case 'response_ms': return 'High latency';
    case 'cpu_pct':     return 'High CPU';
    case 'mem_pct':     return 'High memory';
    default:            return metric.replace(/_/g, ' ');
  }
}
function patternText(p: PatternRow): string {
  if (p.description && p.description.trim()) return p.description.trim();
  const parts: string[] = [patternMetricLabel(p.metric)];
  if (p.day_of_week != null && DOW_NAMES[p.day_of_week]) {
    parts.push(`every ${DOW_NAMES[p.day_of_week]}`);
  } else if (p.pattern_type === 'daily') {
    parts.push('daily');
  } else if (p.pattern_type === 'weekly') {
    parts.push('weekly');
  }
  if (p.hour_of_day != null) {
    const h = String(p.hour_of_day).padStart(2, '0');
    const h2 = String((p.hour_of_day + 1) % 24).padStart(2, '0');
    parts.push(`${h}:00-${h2}:00`);
  }
  return parts.join(' ');
}
function confColor(c: number): string {
  if (c >= 80) return 'var(--red)';
  if (c >= 60) return 'var(--yellow)';
  return 'var(--text-muted)';
}
function RecurringPatterns({ api }: { api: Api<PatternRow[]> }) {
  const rows = api.data || [];
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={SECTION_HEADING}>Recurring Patterns</span>
        {rows.length > 0 && <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={2} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No recurring patterns detected yet" />
        ) : (
          rows.map((p) => {
            const conf = num(p.confidence);
            const pct = conf != null ? Math.round(conf * 100) : null;
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}>
                <IconRepeat width={14} height={14} aria-hidden style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <Link href={`/devices/${p.device_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {p.device_name}
                  </Link>{' '}
                  <span style={{ color: 'var(--text-primary)' }}>{patternText(p)}</span>
                </span>
                <span style={{ flex: 1 }} />
                {pct != null && (
                  <span
                    title={`${p.occurrence_count} occurrence${p.occurrence_count === 1 ? '' : 's'}`}
                    style={{
                      flexShrink: 0, fontSize: 'var(--text-xs)', fontWeight: 700, color: '#fff',
                      background: confColor(pct), padding: '1px 7px', borderRadius: 10, whiteSpace: 'nowrap',
                    }}
                  >
                    {pct}%
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Least reliable devices (worst alert offenders, 30d) ────────
function LeastReliableDevices({ api }: { api: Api<LeastReliable[]> }) {
  const rows = (api.data || []).slice(0, 10);
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={SECTION_HEADING}>Least Reliable (30d)</div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={4} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No alerts in the last 30 days ✓" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <Th style={{ width: 28, textAlign: 'left' }}>#</Th>
                <Th style={{ textAlign: 'left' }}>Device</Th>
                <Th style={{ textAlign: 'left' }}>Site</Th>
                <Th style={{ width: 56, textAlign: 'right' }}>Alerts</Th>
                <Th style={{ width: 64, textAlign: 'right' }}>Outages</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => {
                const alerts = num(d.alert_count);
                const outages = num(d.outage_count);
                return (
                  <tr key={d.id} style={{ height: 36, cursor: 'pointer' }}>
                    <Td style={{ color: 'var(--text-muted)' }}>{i + 1}</Td>
                    <Td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Link href={`/devices/${d.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{d.name}</Link>
                    </Td>
                    <Td style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.site_name || '—'}</Td>
                    <Td style={{ textAlign: 'right', color: 'var(--red)', fontWeight: 600 }}>{alerts != null ? alerts : '—'}</Td>
                    <Td style={{ textAlign: 'right', color: outages && outages > 0 ? 'var(--red)' : 'var(--text-muted)' }}>
                      {outages != null ? outages : '—'}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Bandwidth top talkers (busiest interfaces, last 15m) ───────
function fmtBps(n: number | null | undefined): string {
  const v = num(n as number);
  if (v == null || v < 0) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} Gb/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} Mb/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} Kb/s`;
  return `${Math.round(v)} b/s`;
}
function TopTalkers({ api }: { api: Api<TopTalker[]> }) {
  const rows = api.data || [];
  return (
    <div style={{ ...CARD_STYLE, height: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={SECTION_HEADING}>Top Talkers</span>
        {rows.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
        {api.loading && !api.data ? (
          <TableSkeleton rows={5} cols={3} />
        ) : api.error ? (
          <ErrorBox message={api.error} />
        ) : !rows.length ? (
          <Empty message="No interface throughput data" />
        ) : (
          rows.map((t) => (
            <div
              key={`${t.device_id}-${t.if_index}`}
              style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}
            >
              <Link
                href={`/devices/${t.device_id}`}
                style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}
              >
                {t.device_name}
              </Link>
              <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                · {t.if_name}
              </span>
              <span style={{ flex: 1 }} />
              <span title="Inbound" style={{ color: 'var(--green)', whiteSpace: 'nowrap', fontWeight: 600 }}>▼ {fmtBps(t.in_bps)}</span>
              <span title="Outbound" style={{ color: '#C8102E', whiteSpace: 'nowrap', fontWeight: 600 }}>▲ {fmtBps(t.out_bps)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Maintenance windows group (planned, not problems) ──────────
function MaintenanceGroup({ api }: { api: Api<MaintenanceData> }) {
  const active = api.data?.active || [];
  const upcoming = api.data?.upcoming || [];
  const rows = [...active, ...upcoming];
  if (!rows.length) return null;
  return (
    <div style={{ ...CARD_STYLE, borderLeft: '3px solid #2563eb', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <IconTool width={15} height={15} aria-hidden style={{ color: '#2563eb', flexShrink: 0 }} />
        <span style={SECTION_HEADING}>Maintenance</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{rows.length}</span>
      </div>
      {rows.map((m) => {
        const isActive = m.state === 'active';
        return (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-light)' }}>
            <span
              style={{
                fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
                color: isActive ? '#fff' : 'var(--text-muted)',
                background: isActive ? '#2563eb' : 'var(--border)',
                padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              {isActive ? 'Active' : 'Upcoming'}
            </span>
            {m.device_id != null ? (
              <Link href={`/devices/${m.device_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                {m.device_name}
              </Link>
            ) : m.service_check_id != null ? (
              <Link href={`/services/${m.service_check_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                {m.service_name}
              </Link>
            ) : (
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>All devices/services</span>
            )}
            {(m.site_name || m.service_site_name) && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>· {m.site_name || m.service_site_name}</span>
            )}
            {m.reason && (
              <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {m.reason}</span>
            )}
            <span style={{ flex: 1 }} />
            <span title={`${fmtTime(m.starts_at)} → ${fmtTime(m.ends_at)}`} style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {fmtTime(m.starts_at)} → {fmtTime(m.ends_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Wireless health panel (self-fetching, hidden when no gear) ─
function WirelessHealthCard() {
  const wi = useApi<WirelessIntel>('/api/dashboard/wireless-intel', REFRESH_MS);
  const d = wi.data;
  if (!d || !d.has_data || d.total_controllers === 0) return null;
  const c = scoreColor(d.overall_score);
  return (
    <div style={{ ...CARD_STYLE, flex: 1, minWidth: 0, borderLeft: `3px solid ${c}`, height: 220, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={SECTION_HEADING}>Wireless Health</span>
        <Link href="/wireless" className="sv-dash-link" style={{ marginLeft: 'auto', fontSize: 'var(--text-sm)' }}>View →</Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: c, lineHeight: 1 }}>{d.overall_score}</span>
        <GradeBadge grade={d.overall_grade} />
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {d.controllers_with_intel} controller{d.controllers_with_intel === 1 ? '' : 's'}
        </span>
      </div>
      <IntelBar label="Interference" score={d.interference_score} />
      <IntelBar label="Capacity" score={d.capacity_score} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto', paddingTop: 10, fontSize: 'var(--text-xs)' }}>
        <WirelessChip n={d.overloaded_aps} label="overloaded AP" color="var(--yellow)"
          href="/wireless?tab=intelligence"
          title="Access points serving more than 25 clients. The Intelligence tab lists the specific APs by name in its capacity recommendations." />
        <WirelessChip n={d.co_channel_pairs} label="co-channel pair" color="var(--yellow)"
          href="/wireless?tab=intelligence"
          title="Pairs of access points sharing a 2.4GHz channel (co-channel interference) — a combinatorial count. The Intelligence tab shows how many APs are affected and the channel-planning fix." />
        <WirelessChip n={d.problem_clients} label="problem client" color="var(--red)"
          href="/wireless?tab=clients"
          title="Wireless clients flagged with connectivity / performance problems (weak signal, frequent roaming, etc.). See the Clients tab and toggle 'Problem only'." />
      </div>
    </div>
  );
}
function IntelBar({ label, score }: { label: string; score: number }) {
  const c = scoreColor(score);
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', marginBottom: 3 }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ color: c, fontWeight: 600 }}>{score}</span>
      </div>
      <span style={{ display: 'block', height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', borderRadius: 2, width: `${Math.max(2, pct)}%`, background: c }} />
      </span>
    </div>
  );
}
function WirelessChip({ n, label, color, href, title }: { n: number; label: string; color: string; href?: string; title?: string }) {
  const active = n > 0;
  const bg = active ? 'var(--bg-card)' : 'transparent';
  const bd = active ? color : 'var(--border)';
  const fg = active ? color : 'var(--text-muted)';
  const body = `${n} ${label}${n === 1 ? '' : 's'}`;
  if (href) {
    return (
      <Link href={href} title={title} style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 4,
        background: bg, border: `1px solid ${bd}`, color: fg, fontWeight: 600, whiteSpace: 'nowrap',
        textDecoration: 'none', cursor: 'pointer',
      }}>{body}</Link>
    );
  }
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 4,
      background: bg, border: `1px solid ${bd}`, color: fg, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{body}</span>
  );
}

// ── Hooks (top-level) ──────────────────────────────────────────
function useUpdatedAt(data: unknown): number | null {
  const [ts, setTs] = useState<number | null>(null);
  useEffect(() => {
    if (data) setTs(Date.now());
  }, [data]);
  return ts;
}

function useSecondsAgo(since: number | null): number {
  const [, setTick] = useState(0);
  const sinceRef = useRef(since);
  sinceRef.current = since;
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (since == null) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}

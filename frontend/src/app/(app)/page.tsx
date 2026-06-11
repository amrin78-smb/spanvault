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
  PageHeader, TableSkeleton, Skeleton, useRefreshKey,
} from '@/components/ui';
import {
  GradeBadge, scoreColor, n as intelNum, Overview, HealthRow,
} from '@/components/intel';

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
  id: number; device_id: number; device_name: string | null; site_id: number | null;
  site_name: string | null; alert_type: string; severity: string; status: string; message: string | null;
  triggered_at: string; resolved_at: string | null; event_at: string;
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
  fontSize: 12,
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  marginBottom: 8,
  letterSpacing: '0.06em',
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
      📺 {on ? 'Exit NOC' : 'NOC View'}
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

  const updatedAt = useUpdatedAt(summary.data);
  const ago = useSecondsAgo(updatedAt);

  // Global "R" shortcut / refresh button reloads every dashboard panel.
  useRefreshKey(() => {
    summary.reload(); problems.reload(); worst.reload();
    trend.reload(); sites.reload(); events.reload(); agentOffline.reload();
    intel.reload();
  });

  const s = summary.data;
  const tDir = availTrend(trend.data);
  // UP card: availability improving = good. DOWN card: improving means fewer down.
  const upTrend = tDir === 'up' ? 'good' : tDir === 'down' ? 'bad' : null;
  const upArrow = tDir === 'up' ? '↑' : tDir === 'down' ? '↓' : '';
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
        <span className="sv-muted" style={{ fontSize: 13 }}>
          {updatedAt ? `Updated ${ago === 0 ? 'just now' : `${ago} second${ago === 1 ? '' : 's'} ago`}` : 'Loading…'}
        </span>
        <NocViewButton />
      </PageHeader>

      {/* ── ROW 1: 7 KPI stat cards ─────────────────────── */}
      {summary.error && <ErrorBox message={summary.error} />}
      {summary.loading && !s ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12, marginBottom: 12 }}>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} style={{ ...CARD_STYLE, height: 75, padding: '12px 16px' }}>
              <Skeleton height={24} width="50%" />
              <div style={{ height: 6 }} />
              <Skeleton height={10} width="70%" />
            </div>
          ))}
        </div>
      ) : s ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 12, marginBottom: 12 }}>
            <StatTile href="/devices" color="var(--text-primary)" value={s.total} label="Total Devices" />
            <StatTile href="/devices?status=up" color="var(--green)" value={s.up} label="Up"
              trend={upTrend} arrow={upArrow} />
            <StatTile href="/devices?status=down" color="var(--red)" value={s.down} label="Down"
              pulse={s.down > 0} trend={downTrend} arrow={downArrow} />
            <StatTile href="/devices?status=warning" color="var(--yellow)" value={s.warning} label="Warning"
              pulse={s.warning > 0} />
            <StatTile href="/devices?status=unknown" color="var(--text-muted)" value={s.unknown} label="Unknown" />
            <StatTile href="/alerts?status=active" color="var(--red)" value={s.active_alerts} label="Active Alerts" />
            <HealthScoreTile data={intel.data} />
          </div>

          {/* Secondary tiles (wireless / agents) — preserved, shown only when present. */}
          <SecondaryTiles canManageAgents={canManageAgents} agentsOnline={s.agents_online} agentsTotal={s.agents_total} />
        </>
      ) : null}

      {/* ── ROW 2: anomaly banner (slim, only if anomalies) ── */}
      <AnomalyBanner data={intel.data} />

      {/* ── ROW 3: active problems (55%) + slowest devices (45%) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '55fr 45fr', gap: 12, alignItems: 'stretch', marginBottom: 12 }}>
        <ActiveProblems api={problems} />
        <SlowestDevices api={worst} />
      </div>

      {/* ── Agent-offline group (devices unreachable via an offline agent) ── */}
      <AgentOfflineGroup api={agentOffline} />

      {/* ── ROW 4: site health (50%) + availability trend (50%) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'stretch', marginBottom: 12 }}>
        <SiteHealthCard api={sites} />
        <NetworkAvailabilityCard api={trend} />
      </div>

      {/* ── ROW 5: at-risk (50%) + recent events (50%) — equal 200px height ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'stretch', marginBottom: 18 }}>
        <AtRiskDevices data={intel.data} />
        <div style={{ ...CARD_STYLE, height: 200, display: 'flex', flexDirection: 'column' }}>
          <div style={SECTION_HEADING}>Recent Events</div>
          <div style={{ flex: 1, overflowY: 'auto', margin: '0 -4px' }}>
            <RecentEvents api={events} />
          </div>
        </div>
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
        marginBottom: 12, borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
        cursor: 'pointer', color: '#92400e', background: 'rgba(217,119,6,0.10)',
        border: '1px solid rgba(217,119,6,0.30)',
      }}
    >
      <span aria-hidden>⚠</span><span>{msg}</span>
    </div>
  );
}

// Dismissible success banner shown after the in-app updater redirects here with
// ?updated=true. Mirrors RedirectNotice: reads the query param on mount (no
// useSearchParams → no Suspense requirement) and strips it so a refresh won't
// re-show it.
function UpdatedNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('updated') === 'true') {
      setShow(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);
  if (!show) return null;
  return (
    <div
      onClick={() => setShow(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        marginBottom: 12, borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
        cursor: 'pointer', color: '#166534', background: 'rgba(22,163,74,0.10)',
        border: '1px solid rgba(22,163,74,0.30)',
      }}
    >
      <span aria-hidden>✓</span><span>SpanVault updated successfully</span>
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
        height: 75, padding: '12px 16px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`, textDecoration: 'none', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</span>
        {trend && arrow ? <span style={{ fontSize: 13, fontWeight: 700, color: trendColor }}>{arrow}</span> : null}
      </div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
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
        height: 75, padding: '12px 16px', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderLeft: `3px solid ${c}`, textDecoration: 'none', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 24, fontWeight: 800, color: c, lineHeight: 1 }}>
          {score != null ? Math.round(score) : '—'}
        </span>
        {data && <GradeBadge grade={data.overall_grade} />}
      </div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
        Health Score
      </div>
    </Link>
  );
}

// ── Secondary tiles row (wireless + agents) ────────────────────
// Preserved from the original dashboard but kept out of the strict 7-KPI grid.
// Wireless self-fetches and hides until at least one AP exists; the agents tile
// only renders for users who can manage agents and when agents are registered.
function SecondaryTiles({ canManageAgents, agentsOnline, agentsTotal }: {
  canManageAgents: boolean; agentsOnline: number; agentsTotal: number;
}) {
  const wifi = useApi<WirelessSummaryLite>('/api/wireless/summary', REFRESH_MS);
  const ssids = useApi<WirelessSsidLite>('/api/wireless/ssids/summary', REFRESH_MS);
  const w = wifi.data;
  const showWifi = !!(w && w.total_aps);
  const showAgents = canManageAgents && agentsTotal > 0;
  if (!showWifi && !showAgents) return null;

  const wifiColor = w && w.offline_aps > 0 ? 'var(--red)' : 'var(--green)';
  const clients = w?.total_clients || 0;
  const ssidCount = ssids.data?.active_ssids ?? ssids.data?.total_ssids ?? 0;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
      {showWifi && w && (
        <Link
          href="/wireless"
          className={w.offline_aps > 0 ? 'sv-stat pulse' : undefined}
          style={{
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
            minWidth: 220, height: 75, padding: '12px 16px', borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderLeft: `3px solid ${wifiColor}`, textDecoration: 'none',
          }}
        >
          <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
            {w.online_aps}/{w.total_aps}
          </span>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
            Wireless APs Online
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {clients} client{clients === 1 ? '' : 's'} · {ssidCount} SSID{ssidCount === 1 ? '' : 's'}
          </div>
        </Link>
      )}
      {showAgents && (
        <Link
          href="/agents"
          className={agentsOnline < agentsTotal ? 'sv-stat pulse' : undefined}
          style={{
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2,
            minWidth: 220, height: 75, padding: '12px 16px', borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderLeft: `3px solid ${agentsOnline < agentsTotal ? 'var(--red)' : 'var(--green)'}`,
            textDecoration: 'none',
          }}
        >
          <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
            {agentsOnline}/{agentsTotal}
          </span>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 600 }}>
            Agents Online
          </div>
        </Link>
      )}
    </div>
  );
}

type WirelessSummaryLite = { total_aps: number; online_aps: number; offline_aps: number; total_clients: number };
type WirelessSsidLite = { total_ssids: number; active_ssids: number };

// ── Anomaly banner (slim, single-line, blue) ───────────────────
function AnomalyBanner({ data }: { data: Overview | null }) {
  if (!data || !data.active_anomalies) return null;
  const c = data.active_anomalies;
  return (
    <Link
      href="/intelligence#anomalies"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
        marginBottom: 12, borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 600,
        color: '#1d4ed8', background: 'rgba(37,99,235,0.10)',
        border: '1px solid rgba(37,99,235,0.30)', textDecoration: 'none',
      }}
    >
      <span>🔍 {c} {c === 1 ? 'anomaly' : 'anomalies'} detected</span>
      <span style={{ marginLeft: 'auto', fontWeight: 700 }}>View Intelligence →</span>
    </Link>
  );
}

// ── At-risk devices (health score < 70) (top-level component) ──
function AtRiskDevices({ data }: { data: Overview | null }) {
  const atRisk = (data && data.at_risk_devices ? data.at_risk_devices : [])
    .filter((d: HealthRow) => { const s = intelNum(d.score); return s != null && s < 70; });
  return (
    <div style={{ ...CARD_STYLE, borderLeft: '3px solid var(--yellow)', height: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <StatusDot status="warning" size={11} />
        <span style={SECTION_HEADING}>At Risk</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{atRisk.length}</span>
      </div>
      {atRisk.length ? (
        <>
          <div style={{ flex: 1, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
            {atRisk.map((d: HealthRow) => {
              const s = intelNum(d.score);
              return (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, borderBottom: '1px solid var(--border-light)', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--yellow)' }}>⚠</span>
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
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
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
    <div style={{ ...CARD_STYLE, height: 240 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {hasProblems && <StatusDot status="down" size={11} />}
        <span style={SECTION_HEADING}>Active Problems</span>
        {hasProblems && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{sorted.length}</span>}
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
            <div style={{ fontSize: 28 }}>✓</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>All systems operational</div>
          </div>
        ) : (
          sorted.map((p) => {
            const down = p.current_status === 'down';
            const gwDown = p.is_gateway && down;
            const ms = num(p.last_response_ms);
            return (
              <div key={p.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 12.5, borderBottom: '1px solid var(--border-light)' }}>
                  <StatusDot status={p.current_status} size={10} />
                  <Link href={`/devices/${p.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{p.name}</Link>
                  {gwDown && (
                    <span
                      title="Site gateway is down"
                      style={{
                        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
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
    <div style={{ ...CARD_STYLE, height: 240 }}>
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
      fontSize: 11, textTransform: 'uppercase', fontWeight: 600, color: 'var(--text-muted)',
      padding: '8px 12px', letterSpacing: '0.03em', borderBottom: '1px solid var(--border)', ...style,
    }}>{children}</th>
  );
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td style={{
      fontSize: 12.5, color: 'var(--text-primary)', padding: '8px 12px',
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
              <div key={st.site_id} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, fontSize: 12.5 }}>
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
          labelFormatter={(l) => fmtTime(String(l))}
          formatter={(v: any) => [`${Number(v).toFixed(1)}%`, 'Availability']}
        />
        <ReferenceLine y={95} stroke="#C8102E" strokeDasharray="4 4"
          label={{ value: '95%', position: 'right', fontSize: 11, fill: '#C8102E' }} />
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
    default:             return type.startsWith('rule_') ? 'alert rule triggered' : type.replace(/_/g, ' ');
  }
}
function humanEvent(type: string): string {
  switch (type) {
    case 'device_down':  return 'outage';
    case 'high_latency': return 'high latency';
    case 'high_cpu':     return 'high CPU';
    case 'high_memory':  return 'high memory';
    default:             return type.replace(/_/g, ' ');
  }
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
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, fontSize: 12.5, borderBottom: '1px solid var(--border-light)', padding: '0 4px' }}>
            <span title={fmtTime(e.event_at)} style={{ width: 64, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtRel(e.event_at)}</span>
            <span style={{ flexShrink: 0 }}>{icon}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <Link href={`/devices/${e.device_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {e.device_name || `#${e.device_id}`}
              </Link>{' '}
              <span style={{ color: 'var(--text-primary)' }}>{text}</span>
            </span>
            <span style={{ flex: 1 }} />
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
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{rows.length}</span>
      </div>
      {rows.map((r) => (
        <div key={r.agent_id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, fontSize: 12.5, borderBottom: '1px solid var(--border-light)' }}>
          <span style={{ color: 'var(--yellow)' }}>⚠</span>
          <Link href={`/agents/${r.agent_id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.agent_name}</Link>
          {r.hostname && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {r.hostname}</span>}
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {r.device_count} device{r.device_count === 1 ? '' : 's'} unreachable · last seen {fmtRel(r.last_seen_at)}
          </span>
        </div>
      ))}
    </div>
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

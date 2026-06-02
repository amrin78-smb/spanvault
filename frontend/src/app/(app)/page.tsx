'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { useApi } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { StatusBadge, Loading, ErrorBox, Empty, fmtRel, fmtTime } from '@/components/ui';

// ── Types ──────────────────────────────────────────────────────
type Summary = {
  total: number; up: number; down: number; warning: number; unknown: number; active_alerts: number;
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
  if (ms == null) return 'var(--sv-muted)';
  if (ms < 100) return 'var(--sv-up)';
  if (ms <= 500) return 'var(--sv-warning)';
  return 'var(--sv-down)';
}
function uptimeColor(p: number | null): string {
  if (p == null) return 'var(--sv-unknown)';
  if (p >= 99) return 'var(--sv-up)';
  if (p >= 90) return 'var(--sv-warning)';
  return 'var(--sv-down)';
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

export default function DashboardPage() {
  const summary = useApi<Summary>('/api/dashboard/summary', REFRESH_MS);
  const problems = useApi<Problem[]>('/api/dashboard/problems', REFRESH_MS);
  const worst = useApi<Worst[]>('/api/dashboard/top-worst', REFRESH_MS);
  const trend = useApi<TrendPoint[]>('/api/dashboard/network-trend', REFRESH_MS);
  const sites = useApi<SiteHealth[]>('/api/dashboard/site-health', REFRESH_MS);
  const events = useApi<EventRow[]>('/api/dashboard/events', REFRESH_MS);

  const updatedAt = useUpdatedAt(summary.data);
  const ago = useSecondsAgo(updatedAt);

  const s = summary.data;
  const tDir = availTrend(trend.data);
  // UP card: availability improving = good. DOWN card: improving means fewer down.
  const upTrend = tDir === 'up' ? 'good' : tDir === 'down' ? 'bad' : null;
  const upArrow = tDir === 'up' ? '↑' : tDir === 'down' ? '↓' : '';
  const downTrend = tDir === 'up' ? 'good' : tDir === 'down' ? 'bad' : null;
  const downArrow = tDir === 'up' ? '↓' : tDir === 'down' ? '↑' : '';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="sv-page-title">Dashboard</h1>
        <span className="sv-muted" style={{ fontSize: 13 }}>
          {updatedAt ? `Updated ${ago === 0 ? 'just now' : `${ago} second${ago === 1 ? '' : 's'} ago`}` : 'Loading…'}
        </span>
      </div>
      <p className="sv-page-sub">Live network health across all monitored devices.</p>

      {/* ── ROW 1: stat cards ───────────────────────────── */}
      {summary.error && <ErrorBox message={summary.error} />}
      {summary.loading && !s ? (
        <Loading />
      ) : s ? (
        <div className="sv-dash-stats">
          <StatLink href="/devices" variant="total" num={s.total} label="Total Devices" />
          <StatLink href="/devices?status=up" variant="up" num={s.up} label="Up"
            trend={upTrend} arrow={upArrow} />
          <StatLink href="/devices?status=down" variant="down" num={s.down} label="Down"
            pulse={s.down > 0} trend={downTrend} arrow={downArrow} />
          <StatLink href="/devices?status=warning" variant="warning" num={s.warning} label="Warning"
            pulse={s.warning > 0} />
          <StatLink href="/devices?status=unknown" variant="unknown" num={s.unknown} label="Unknown" />
          <StatLink href="/alerts?status=active" variant="alerts" num={s.active_alerts} label="Active Alerts" />
        </div>
      ) : null}

      {/* ── ROW 2: problems + slowest ───────────────────── */}
      <div className="sv-dash-row r6040">
        <ActiveProblems api={problems} />
        <SlowestDevices api={worst} />
      </div>

      {/* ── ROW 3: site health + availability trend ─────── */}
      <div className="sv-dash-row r5050">
        <SiteHealthCard api={sites} />
        <div className="sv-dash-card">
          <div className="sv-dash-head"><h2>Network Availability (24h)</h2></div>
          {trend.loading && !trend.data ? (
            <Loading />
          ) : trend.error ? (
            <ErrorBox message={trend.error} />
          ) : (
            <NetworkTrendChart data={trend.data || []} />
          )}
        </div>
      </div>

      {/* ── ROW 4: recent events ────────────────────────── */}
      <div className="sv-dash-card" style={{ marginBottom: 18 }}>
        <div className="sv-dash-head"><h2>Recent Events</h2></div>
        <RecentEvents api={events} />
      </div>
    </div>
  );
}

// ── Stat card (clickable link) ─────────────────────────────────
function StatLink({
  href, num, label, variant, pulse, trend, arrow,
}: {
  href: string; num: number; label: string;
  variant: 'total' | 'up' | 'down' | 'warning' | 'unknown' | 'alerts';
  pulse?: boolean; trend?: 'good' | 'bad' | null; arrow?: string;
}) {
  return (
    <Link href={href} className={`sv-stat ${variant}${pulse ? ' pulse' : ''}`}>
      <div className="sv-stat-top">
        <span className="num">{num}</span>
        {trend && arrow ? <span className={`trend ${trend}`}>{arrow}</span> : null}
      </div>
      <div className="label">{label}</div>
    </Link>
  );
}

// ── Active problems (top-level component) ──────────────────────
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
  const shown = sorted.slice(0, 8);

  return (
    <div className={`sv-dash-card ${hasProblems ? 'problems-bad' : 'problems-ok'}`}>
      <div className="sv-dash-head">
        {hasProblems && <StatusDot status="down" size={11} />}
        <h2>Active Problems</h2>
        <span className="spacer" />
        {hasProblems && <span className="sv-muted" style={{ fontSize: 13 }}>{sorted.length}</span>}
      </div>

      {api.loading && !api.data ? (
        <Loading />
      ) : api.error ? (
        <ErrorBox message={api.error} />
      ) : !hasProblems ? (
        <div className="sv-allclear">
          <div className="big">✓</div>
          <div className="txt">All systems operational</div>
        </div>
      ) : (
        <>
          {shown.map((p) => {
            const down = p.current_status === 'down';
            const gwDown = p.is_gateway && down;
            const ms = num(p.last_response_ms);
            return (
              <div key={p.id}>
                <div className="sv-prob">
                  <StatusDot status={p.current_status} size={11} />
                  <Link href={`/devices/${p.id}`} className="name">{p.name}</Link>
                  {gwDown && <span className="sv-gw-down-tag" title="Site gateway is down">Gateway Down</span>}
                  {p.site_id ? (
                    <Link href={`/sites/${p.site_id}`} className="site">{p.site_name}</Link>
                  ) : (
                    <span className="site">{p.site_name || 'Unassigned'}</span>
                  )}
                  <StatusBadge status={p.current_status} />
                  <span className="spacer" />
                  {down ? (
                    <span className="dur">{durSince(p.last_seen_at) ? `down for ${durSince(p.last_seen_at)}` : 'down'}</span>
                  ) : (
                    <span className="ms" style={{ color: msColor(ms) }}>
                      {ms != null ? `${ms.toFixed(0)} ms` : 'high latency'}
                    </span>
                  )}
                  {down && (
                    <span className="ms" style={{ color: 'var(--sv-down)' }}>Timeout</span>
                  )}
                </div>
                {gwDown && p.suppressed_in_site > 0 && (
                  <div className="sv-prob-sub">
                    ↳ {p.suppressed_in_site} device{p.suppressed_in_site === 1 ? '' : 's'} suppressed in {p.site_name || 'this site'}
                  </div>
                )}
              </div>
            );
          })}
          {sorted.length > shown.length && (
            <div style={{ marginTop: 10, textAlign: 'right' }}>
              <Link href="/devices" className="sv-dash-link">View all {sorted.length} problems →</Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Slowest devices (top-level component) ──────────────────────
function SlowestDevices({ api }: { api: Api<Worst[]> }) {
  const rows = (api.data || []).slice(0, 5);
  return (
    <div className="sv-dash-card">
      <div className="sv-dash-head"><h2>Slowest Devices (last 1h)</h2></div>
      {api.loading && !api.data ? (
        <Loading />
      ) : api.error ? (
        <ErrorBox message={api.error} />
      ) : !rows.length ? (
        <Empty message="No ping data yet" />
      ) : (
        <table className="sv-mini">
          <thead>
            <tr><th className="rank">#</th><th>Device</th><th>Site</th>
              <th style={{ textAlign: 'right' }}>Avg ms</th><th style={{ textAlign: 'right' }}>Loss</th></tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const avg = num(d.avg_ms);
              const loss = num(d.packet_loss_pct);
              return (
                <tr key={d.id}>
                  <td className="rank">{i + 1}</td>
                  <td><Link href={`/devices/${d.id}`} className="nm">{d.name}</Link></td>
                  <td className="sv-muted" style={{ whiteSpace: 'nowrap' }}>{d.site_name || '—'}</td>
                  <td className="num" style={{ color: msColor(avg) }}>{avg != null ? avg.toFixed(0) : '—'}</td>
                  <td className="num" style={{ color: loss && loss > 0 ? 'var(--sv-down)' : 'var(--sv-muted)' }}>
                    {loss != null ? `${loss.toFixed(0)}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Site health (top-level component) ──────────────────────────
function SiteHealthCard({ api }: { api: Api<SiteHealth[]> }) {
  // Worst first: lowest uptime at the top (sites with no data sort last).
  const rows = [...(api.data || [])].sort((a, b) => {
    const ua = a.avg_uptime_pct == null ? 101 : Number(a.avg_uptime_pct);
    const ub = b.avg_uptime_pct == null ? 101 : Number(b.avg_uptime_pct);
    return ua - ub;
  });
  return (
    <div className="sv-dash-card">
      <div className="sv-dash-head"><h2>Site Health (24h)</h2></div>
      {api.loading && !api.data ? (
        <Loading />
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
            <div key={st.site_id} className="sv-health">
              <span className="site">
                {st.site_id ? (
                  <Link href={`/sites/${st.site_id}`}>{st.site_name}</Link>
                ) : st.site_name}
              </span>
              <span className="bar">
                <span style={{ width: `${pct != null ? Math.max(2, pct) : 0}%`, background: uptimeColor(pct) }} />
              </span>
              <span className="pct" style={{ color: uptimeColor(pct) }}>
                {pct != null ? `${pct.toFixed(1)}%` : '—'}
              </span>
              <span className="pills">{pills.join(' · ')}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Network availability trend (top-level component) ───────────
function NetworkTrendChart({ data }: { data: TrendPoint[] }) {
  const pts = data
    .filter((d) => d.pct_up != null)
    .map((d) => ({ bucket: d.bucket, pct: Number(d.pct_up) }));
  if (!pts.length) return <Empty message="Collecting data…" />;

  const minVal = Math.min(...pts.map((p) => p.pct));
  const domainMin = Math.max(0, Math.min(95, Math.floor(minVal - 1)));
  // Fraction down from the top of the plot where the 99% line sits.
  const off = Math.max(0, Math.min(1, (100 - 99) / (100 - domainMin)));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={pts} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id="svAvail" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2e9e5b" stopOpacity={0.55} />
            <stop offset={`${off * 100}%`} stopColor="#2e9e5b" stopOpacity={0.22} />
            <stop offset={`${off * 100}%`} stopColor="#e6a700" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#C8102E" stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
        <XAxis dataKey="bucket" tickFormatter={hhmm} fontSize={10} minTickGap={44} />
        <YAxis domain={[domainMin, 100]} fontSize={10} width={42} tickFormatter={(v) => `${v}%`} />
        <Tooltip
          labelFormatter={(l) => fmtTime(String(l))}
          formatter={(v: any) => [`${Number(v).toFixed(1)}%`, 'Availability']}
        />
        <ReferenceLine y={99} stroke="#C8102E" strokeDasharray="4 4"
          label={{ value: '99%', position: 'right', fontSize: 10, fill: '#C8102E' }} />
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
  const rows = (api.data || []).slice(0, 10);
  if (api.loading && !api.data) return <Loading />;
  if (api.error) return <ErrorBox message={api.error} />;
  if (!rows.length) return <Empty message="No events in the last 24 hours" />;
  return (
    <div>
      {rows.map((e) => {
        const { icon, text } = describeEvent(e);
        return (
          <div key={e.id} className="sv-event">
            <span className="ico">{icon}</span>
            <span className="body">
              <Link href={`/devices/${e.device_id}`} className="dev">
                {e.device_name || `#${e.device_id}`}
              </Link>{' '}
              {text}
              {e.site_name && <span className="site"> · {e.site_name}</span>}
            </span>
            <span className="when" title={fmtTime(e.event_at)}>{fmtRel(e.event_at)}</span>
          </div>
        );
      })}
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

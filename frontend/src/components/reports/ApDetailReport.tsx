'use client';

import type { CSSProperties } from 'react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import { GradeBadge } from '@/components/intel';
import { fmtTime, fmtBps } from '@/components/ui';

/**
 * Pure presentational AP-detail report (Phase 0+1 granular wireless report).
 * Parent fetches GET /api/reports/ap-detail/:id and passes non-null `data`.
 * All helper components are defined at module scope (never nested) per project rules.
 *
 * Charts are keyed by metric: render a chart only if its key is in
 * `selectedMetrics`; if `selectedMetrics` is undefined, render all charts.
 *   clients     → clients_total / clients_2g / clients_5g
 *   radio_util  → radio_2g_util / radio_5g_util
 *   noise       → noise_floor_2g / noise_floor_5g (vendor-nullable)
 *   throughput  → throughput_in_bps / throughput_out_bps (vendor-nullable)
 *
 * series values may be null where a vendor doesn't report them — we render gaps
 * (connectNulls=false) and a "not reported by this AP/vendor" note when a whole
 * series is null. Never fabricate.
 */

// ── Data shape (mirrors GET /api/reports/ap-detail/:id) ─────────
export type ApSeriesPoint = {
  ts: string;
  clients_total: number | null;
  clients_2g: number | null;
  clients_5g: number | null;
  radio_2g_util: number | null;
  radio_5g_util: number | null;
  noise_floor_2g: number | null;
  noise_floor_5g: number | null;
  throughput_in_bps: number | null;
  throughput_out_bps: number | null;
};
export type ApDetail = {
  ap: {
    id: number;
    name: string;
    model: string | null;
    mac_address: string | null;
    ip_address: string | null;
    controller_name: string | null;
    site_name: string | null;
    firmware_version: string | null;
    uptime_seconds: number | null;
    status: string | null;
    radio_2g_channel: number | string | null;
    radio_5g_channel: number | string | null;
  };
  availability: {
    uptime_pct: number | null;
    sample_count: number;
    online_count: number;
    down_events: number;
    disconnects: number;
  };
  range: { from: string; to: string; bucket: string } | null;
  series: ApSeriesPoint[];
  intelligence: {
    health_score: number | null;
    health_grade: string | null;
    load_status: string | null;
    load_pct: number | null;
    band_ratio_healthy: boolean | null;
    channel_recommendation: string | null;
    co_channel_neighbors: number | null;
    issues: string[] | null;
    recommendations: string[] | null;
  } | null;
  current_clients: {
    mac_address: string;
    hostname: string | null;
    ip_address: string | null;
    ssid_name: string | null;
    band: string | null;
    channel: number | string | null;
    rssi_dbm: number | null;
    tx_rate_mbps: number | null;
    roaming_count: number | null;
    is_problem: boolean | null;
    is_sticky: boolean | null;
  }[];
  events: {
    ts: string;
    event_type: string;
    from_ap_name: string | null;
    to_ap_name: string | null;
    rssi_dbm: number | null;
    ssid_name: string | null;
  }[];
};

// Band line colours (suite signal colours; raw is fine for chart lines).
const COLOR_TOTAL = '#7c3aed'; // var(--purple) — combined
const COLOR_2G = '#f97316';    // orange — 2.4 GHz
const COLOR_5G = '#2563eb';    // blue   — 5 GHz
const COLOR_IN = '#2563eb';
const COLOR_OUT = '#f97316';

const CHART_HEIGHT = 230;

// ── Helpers (module scope) ─────────────────────────────────────
function dash(v: number | string | null | undefined, suffix = ''): string {
  if (v === null || v === undefined || v === '') return '—';
  return `${v}${suffix}`;
}

function fmtUptime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || isNaN(Number(sec))) return '—';
  const s = Number(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Short locale tick for a timestamp x-axis.
function tickLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Is at least one of the named keys non-null across the series?
function hasAny(series: ApSeriesPoint[], keys: (keyof ApSeriesPoint)[]): boolean {
  return series.some((p) => keys.some((k) => p[k] !== null && p[k] !== undefined));
}

// Should this metric render? (undefined selectedMetrics = render all)
function wants(selected: string[] | undefined, key: string): boolean {
  return !selected || selected.includes(key);
}

function statusVariant(status: string | null | undefined): string {
  const s = (status || '').toLowerCase();
  if (s === 'online' || s === 'up') return 'up';
  if (s === 'offline' || s === 'down') return 'down';
  if (s === 'warning' || s === 'degraded') return 'warning';
  return '';
}

// ── Shared REPORT OUTPUT style constants (module scope) ─────────
const SECTION_TITLE: CSSProperties = {
  fontSize: 'var(--text-sm)',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  letterSpacing: '0.06em',
  margin: '0 0 8px',
};
const PANEL: CSSProperties = { padding: 16 };
const STAT_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 12,
  alignItems: 'stretch',
};
const STAT_CARD: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderLeftWidth: 3,
  borderLeftColor: 'var(--text-muted)',
  borderRadius: 'var(--radius-sm)',
  padding: '12px 16px',
  minHeight: 75,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
};
const STAT_VALUE: CSSProperties = { fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.1 };
const STAT_LABEL: CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  letterSpacing: '0.04em',
  marginTop: 4,
};
const META_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: '10px 20px',
};
const META_LABEL: CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  letterSpacing: '0.04em',
};
const META_VALUE: CSSProperties = { fontSize: 'var(--text-base)', color: 'var(--text-primary)', marginTop: 2 };
const TH: CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  padding: '8px 12px',
  textAlign: 'left',
};
const TD: CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--text-primary)',
  padding: '8px 12px',
  height: 36,
};
// Chart card: fixed height, break-inside avoid for print (sv-panel already sets
// break-inside; sv-report-chart lets the page target chart blocks specifically).
const CHART_CARD: CSSProperties = { padding: 16, breakInside: 'avoid' };
const CHART_TITLE: CSSProperties = { ...SECTION_TITLE, margin: '0 0 4px' };
const CHART_NOTE: CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontStyle: 'italic' };

// ── Chart blocks (module-scope components) ─────────────────────
function ClientsChart({ series }: { series: ApSeriesPoint[] }) {
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>Connected clients</h3>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={series} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
          <YAxis fontSize={11} width={36} allowDecimals={false} stroke="var(--text-muted)" />
          <Tooltip labelFormatter={tickLabel} formatter={(v: any, n: any) => [v == null ? '—' : v, n]} />
          <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
          <Line type="monotone" name="Total" dataKey="clients_total" stroke={COLOR_TOTAL} strokeWidth={2} dot={false} connectNulls={false} />
          <Line type="monotone" name="2.4 GHz" dataKey="clients_2g" stroke={COLOR_2G} strokeWidth={1.5} dot={false} connectNulls={false} />
          <Line type="monotone" name="5 GHz" dataKey="clients_5g" stroke={COLOR_5G} strokeWidth={1.5} dot={false} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RadioUtilChart({ series }: { series: ApSeriesPoint[] }) {
  const has = hasAny(series, ['radio_2g_util', 'radio_5g_util']);
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>Radio utilization (%)</h3>
      {!has ? (
        <p style={CHART_NOTE}>Channel utilization not reported by this AP/vendor.</p>
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <LineChart data={series} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
            <YAxis fontSize={11} width={40} domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="var(--text-muted)" />
            <Tooltip labelFormatter={tickLabel} formatter={(v: any, n: any) => [v == null ? '—' : `${v}%`, n]} />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
            <Line type="monotone" name="2.4 GHz" dataKey="radio_2g_util" stroke={COLOR_2G} strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" name="5 GHz" dataKey="radio_5g_util" stroke={COLOR_5G} strokeWidth={2} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function NoiseChart({ series }: { series: ApSeriesPoint[] }) {
  const has = hasAny(series, ['noise_floor_2g', 'noise_floor_5g']);
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>Noise floor (dBm)</h3>
      {!has ? (
        <p style={CHART_NOTE}>Noise floor not reported by this AP/vendor.</p>
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <LineChart data={series} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
            <YAxis fontSize={11} width={44} tickFormatter={(v) => `${v}`} stroke="var(--text-muted)" />
            <Tooltip labelFormatter={tickLabel} formatter={(v: any, n: any) => [v == null ? '—' : `${v} dBm`, n]} />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
            <Line type="monotone" name="2.4 GHz" dataKey="noise_floor_2g" stroke={COLOR_2G} strokeWidth={2} dot={false} connectNulls={false} />
            <Line type="monotone" name="5 GHz" dataKey="noise_floor_5g" stroke={COLOR_5G} strokeWidth={2} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function ThroughputChart({ series }: { series: ApSeriesPoint[] }) {
  const has = hasAny(series, ['throughput_in_bps', 'throughput_out_bps']);
  // Pick one axis unit from the peak so ticks stay short; unit shown in title.
  const maxV = series.reduce((m, p) => Math.max(m, p.throughput_in_bps ?? 0, p.throughput_out_bps ?? 0), 0);
  let div = 1; let unit = 'bps';
  if (maxV >= 1e9) { div = 1e9; unit = 'Gbps'; }
  else if (maxV >= 1e6) { div = 1e6; unit = 'Mbps'; }
  else if (maxV >= 1e3) { div = 1e3; unit = 'Kbps'; }
  const axisTick = (v: any) => String(Math.round((Number(v) / div) * 10) / 10);
  return (
    <div className="sv-panel sv-report-chart" style={CHART_CARD}>
      <h3 style={CHART_TITLE}>{`Throughput · ${unit}`}</h3>
      {!has ? (
        <p style={CHART_NOTE}>Throughput not reported by this AP/vendor.</p>
      ) : (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <AreaChart data={series} margin={{ top: 6, right: 16, bottom: 4, left: 0 }}>
            <defs>
              <linearGradient id="sv-ap-in" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_IN} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLOR_IN} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="sv-ap-out" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_OUT} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLOR_OUT} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} stroke="var(--text-muted)" />
            <YAxis fontSize={11} width={40} tickFormatter={axisTick} stroke="var(--text-muted)" />
            <Tooltip labelFormatter={tickLabel} formatter={(v: any, n: any) => [v == null ? '—' : fmtBps(Number(v)), n]} />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
            <Area type="monotone" name="In" dataKey="throughput_in_bps" stroke={COLOR_IN} strokeWidth={2} fill="url(#sv-ap-in)" connectNulls={false} />
            <Area type="monotone" name="Out" dataKey="throughput_out_bps" stroke={COLOR_OUT} strokeWidth={2} fill="url(#sv-ap-out)" connectNulls={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── RF intelligence panel (module-scope component) ─────────────
function loadVariant(status: string | null | undefined): string {
  const s = (status || '').toLowerCase();
  if (s === 'overloaded' || s === 'high' || s === 'critical') return 'down';
  if (s === 'busy' || s === 'moderate' || s === 'warning') return 'warning';
  if (s === 'healthy' || s === 'normal' || s === 'idle' || s === 'low') return 'up';
  return '';
}

function RfIntelligence({ intel }: { intel: ApDetail['intelligence'] }) {
  if (!intel) return null;
  const issues = intel.issues || [];
  const recs = intel.recommendations || [];
  return (
    <div className="sv-panel" style={PANEL}>
      <h3 style={SECTION_TITLE}>RF intelligence</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1 }}>
            {intel.health_score === null ? '—' : Math.round(intel.health_score)}
          </span>
          <GradeBadge grade={intel.health_grade} />
        </div>
        {intel.load_status && (
          <span className={`sv-badge ${loadVariant(intel.load_status)}`}>
            Load: {intel.load_status}{intel.load_pct != null ? ` · ${Math.round(intel.load_pct)}%` : ''}
          </span>
        )}
        {intel.band_ratio_healthy != null && (
          <span className={`sv-badge ${intel.band_ratio_healthy ? 'up' : 'warning'}`}>
            Band balance {intel.band_ratio_healthy ? 'healthy' : 'skewed'}
          </span>
        )}
        {intel.co_channel_neighbors != null && (
          <span className={`sv-badge ${intel.co_channel_neighbors > 0 ? 'warning' : 'up'}`}>
            {intel.co_channel_neighbors} co-channel neighbor{intel.co_channel_neighbors === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {intel.channel_recommendation && (
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)', margin: '0 0 8px' }}>
          <strong>Channel:</strong> {intel.channel_recommendation}
        </p>
      )}
      {(issues.length > 0 || recs.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          {issues.length > 0 && (
            <div>
              <div style={META_LABEL}>Issues</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
                {issues.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            </div>
          )}
          {recs.length > 0 && (
            <div>
              <div style={META_LABEL}>Recommendations</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
                {recs.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main report ────────────────────────────────────────────────
export default function ApDetailReport({
  data,
  selectedMetrics,
}: {
  data?: ApDetail | null;
  selectedMetrics?: string[];
}) {
  if (!data || !data.ap) {
    return (
      <div className="sv-panel" style={{ ...PANEL, textAlign: 'center' }}>
        <p className="sv-muted" style={{ margin: 0 }}>No AP data available.</p>
      </div>
    );
  }

  const ap = data.ap;
  const av = data.availability || { uptime_pct: null, sample_count: 0, online_count: 0, down_events: 0, disconnects: 0 };
  const series = Array.isArray(data.series) ? data.series : [];
  const clients = Array.isArray(data.current_clients) ? data.current_clients : [];
  const events = Array.isArray(data.events) ? data.events : [];
  const hasSeries = series.length > 0;

  const subline = [ap.model, ap.ip_address, ap.controller_name, ap.site_name]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 1. Inventory header */}
      <div className="sv-panel" style={{ ...PANEL, marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{ap.name}</h2>
          {ap.status && <span className={`sv-badge ${statusVariant(ap.status)}`}>{ap.status}</span>}
        </div>
        {subline && <div className="sv-muted" style={{ fontSize: 'var(--text-sm)', margin: '-6px 0 12px' }}>{subline}</div>}
        <div style={META_GRID}>
          <div><div style={META_LABEL}>MAC</div><div style={META_VALUE}>{dash(ap.mac_address)}</div></div>
          <div><div style={META_LABEL}>IP address</div><div style={META_VALUE}>{dash(ap.ip_address)}</div></div>
          <div><div style={META_LABEL}>Controller</div><div style={META_VALUE}>{dash(ap.controller_name)}</div></div>
          <div><div style={META_LABEL}>Site</div><div style={META_VALUE}>{dash(ap.site_name)}</div></div>
          <div><div style={META_LABEL}>Firmware</div><div style={META_VALUE}>{dash(ap.firmware_version)}</div></div>
          <div><div style={META_LABEL}>Uptime</div><div style={META_VALUE}>{fmtUptime(ap.uptime_seconds)}</div></div>
          <div><div style={META_LABEL}>2.4 GHz channel</div><div style={META_VALUE}>{dash(ap.radio_2g_channel)}</div></div>
          <div><div style={META_LABEL}>5 GHz channel</div><div style={META_VALUE}>{dash(ap.radio_5g_channel)}</div></div>
        </div>
      </div>

      {/* 2. Availability stat cards */}
      <div style={STAT_GRID}>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--green)' }}>
          <div style={STAT_VALUE}>{av.uptime_pct === null ? '—' : `${av.uptime_pct}%`}</div>
          <div style={STAT_LABEL}>Uptime</div>
        </div>
        <div style={STAT_CARD}>
          <div style={STAT_VALUE}>{av.sample_count}</div>
          <div style={STAT_LABEL}>Samples</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--red)' }}>
          <div style={STAT_VALUE}>{av.down_events}</div>
          <div style={STAT_LABEL}>Down events</div>
        </div>
        <div style={{ ...STAT_CARD, borderLeftColor: 'var(--yellow)' }}>
          <div style={STAT_VALUE}>{av.disconnects}</div>
          <div style={STAT_LABEL}>Disconnects</div>
        </div>
      </div>

      {/* 3. Time-series charts (keyed by metric) */}
      {!hasSeries ? (
        <div className="sv-panel" style={PANEL}>
          <h3 style={SECTION_TITLE}>Trends</h3>
          <p style={CHART_NOTE}>No time-series samples in this period.</p>
        </div>
      ) : (
        <>
          {wants(selectedMetrics, 'clients') && <ClientsChart series={series} />}
          {wants(selectedMetrics, 'radio_util') && <RadioUtilChart series={series} />}
          {wants(selectedMetrics, 'noise') && <NoiseChart series={series} />}
          {wants(selectedMetrics, 'throughput') && <ThroughputChart series={series} />}
        </>
      )}

      {/* 4. RF intelligence */}
      <RfIntelligence intel={data.intelligence} />

      {/* 5. Current clients */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Current clients ({clients.length})</h3>
        {clients.length === 0 ? (
          <div className="sv-muted">No clients currently associated.</div>
        ) : (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Client</th>
                <th style={TH}>IP</th>
                <th style={TH}>SSID</th>
                <th style={TH}>Band</th>
                <th style={TH}>Ch</th>
                <th style={TH}>RSSI</th>
                <th style={TH}>Tx rate</th>
                <th style={TH}>Roams</th>
                <th style={TH}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c, i) => (
                <tr key={`${c.mac_address}-${i}`}>
                  <td style={TD}>{c.hostname || c.mac_address}</td>
                  <td style={TD}>{dash(c.ip_address)}</td>
                  <td style={TD}>{dash(c.ssid_name)}</td>
                  <td style={TD}>{dash(c.band)}</td>
                  <td style={TD}>{dash(c.channel)}</td>
                  <td style={TD}>{c.rssi_dbm == null ? '—' : `${c.rssi_dbm} dBm`}</td>
                  <td style={TD}>{c.tx_rate_mbps == null ? '—' : `${c.tx_rate_mbps} Mbps`}</td>
                  <td style={TD}>{c.roaming_count ?? 0}</td>
                  <td style={TD}>
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {c.is_problem && <span className="sv-badge down">Problem</span>}
                      {c.is_sticky && <span className="sv-badge warning">Sticky</span>}
                      {!c.is_problem && !c.is_sticky && <span className="sv-muted">—</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 6. Recent events (roam / join / leave / low_signal) */}
      <div className="sv-panel" style={PANEL}>
        <h3 style={SECTION_TITLE}>Recent events</h3>
        {events.length === 0 ? (
          <div className="sv-muted">No client events in this period.</div>
        ) : (
          <table className="sv-table">
            <thead>
              <tr>
                <th style={TH}>Time</th>
                <th style={TH}>Event</th>
                <th style={TH}>From → To</th>
                <th style={TH}>SSID</th>
                <th style={TH}>RSSI</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => {
                const fromTo = e.from_ap_name || e.to_ap_name
                  ? `${e.from_ap_name || '—'} → ${e.to_ap_name || '—'}`
                  : '—';
                return (
                  <tr key={i}>
                    <td style={TD}>{fmtTime(e.ts)}</td>
                    <td style={TD}>{e.event_type}</td>
                    <td style={TD}>{fromTo}</td>
                    <td style={TD}>{dash(e.ssid_name)}</td>
                    <td style={TD}>{e.rssi_dbm == null ? '—' : `${e.rssi_dbm} dBm`}</td>
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

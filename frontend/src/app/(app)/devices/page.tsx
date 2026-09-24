'use client';

import { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { vendorLabel } from '@/lib/vendor';
import { copyText } from '@/lib/clipboard';
import {
  ErrorBox, fmtRel, PageHeader, TableSkeleton, EmptyState, useRefreshKey,
  useTableSort, sortRows, SortTh, SortState,
} from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import SiteScopeBanner from '@/components/SiteScopeBanner';
import {
  IconDevices, IconArrowUp, IconArrowDown, IconWarning, IconInfo, IconGauge,
} from '@/components/icons';
import { DeviceForm, ImportModal } from '@/components/DeviceModals';
import { gradeColor, n as intelNum } from '@/components/intel';

type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
  snmp_enabled: boolean; poll_interval_seconds: number; netvault_device_id: string | null;
  latest_cpu_pct: number | null; latest_mem_pct: number | null;
  // Rolling 24h ICMP availability, already computed by the list route's `avail`
  // LATERAL. Arrives as a pg NUMERIC string. Nothing on the page read it before
  // the KPI strip.
  uptime_24h_pct: number | string | null;
  is_gateway: boolean; alert_suppressed: boolean; suppressed_by_device_id: number | null;
  agent_id: number | null; agent_name: string | null; agent_status: string | null;
  last_alert_at: string | null; last_alert_type: string | null; last_alert_severity: string | null;
  health_score: number | string | null; health_grade: string | null; health_trend: string | null;
  // Detected by the collector's SNMP parser.
  device_vendor: string | null;
  // Resolved from NetVault's inventory by the API (netvault_device_id, else IP
  // match). Null when the device isn't in NetVault or NetVault is unreachable.
  nv_vendor: string | null; nv_model: string | null;
  os_type: string | null; os_version: string | null;
};

// Quick-filter chips, revealed by the "More Filters" toggle (client-side, single-select).
const DEVICE_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'down', label: 'Down' },
  { key: 'warning', label: 'Warning' },
  { key: 'nosnmp', label: 'No SNMP' },
  { key: 'alertstoday', label: 'Has Alerts Today' },
];
function chipMatch(d: Device, chip: string): boolean {
  const s = (d.current_status || 'unknown').toLowerCase();
  switch (chip) {
    case 'down': return s === 'down';
    case 'warning': return s === 'warning';
    case 'nosnmp': return !d.snmp_enabled;
    case 'alertstoday': return d.last_alert_at != null;
    default: return true;
  }
}

type Site = { id: number; name: string };
type SiteGroup = { key: string; name: string; siteId: number | null; devices: Device[] };

// One aggregate response for EVERY device on the page, keyed by device id as a
// string (JSON object keys). 24 clock-aligned hourly buckets, oldest first.
// `metrics=ping` is requested, so cpu_pct/mem_pct come back null here.
type DeviceSeries = {
  response_ms: (number | null)[];
  cpu_pct: (number | null)[] | null;
  mem_pct: (number | null)[] | null;
};
type SparkMap = Record<string, DeviceSeries>;

// Row density. Persisted per browser in localStorage — see DENSITY_KEY.
type Density = 'comfortable' | 'compact';
type AgentGroupT = {
  key: string; agentId: number | null; agentName: string; agentStatus: string | null; devices: Device[];
};

const UNASSIGNED = 'Unassigned';
const LOCAL = 'Local Polling';
const SITES_PER_PAGE = 25;

// ── Row density ────────────────────────────────────────────────
// There is NO per-user preference table in this app (no user_preferences /
// user_settings anywhere in scripts/schema.sql, and app_settings is a global
// key/value store shared by every user — writing a per-user display choice
// there would make one operator's density the whole estate's). Every existing
// display preference — theme (lib/theme.ts), corner style (lib/corners.ts),
// sidebar collapse, the dashboard's section + alert window, the wireless page's
// per-controller collapse — is stored in localStorage, so this follows the same
// house pattern: per browser, not per account. Reads are wrapped in try/catch
// and happen AFTER mount (Safari private mode throws, and reading during render
// would desync the server-rendered HTML).
const DENSITY_KEY = 'sv-devices-density';
// Widths/sizes that can't live in CSS because the elements that use them are
// SVG attributes, not styled boxes.
const DENSITY_SIZES: Record<Density, { ring: number; sparkW: number; sparkH: number; accHead: number }> = {
  comfortable: { ring: 32, sparkW: 58, sparkH: 22, accHead: 40 },
  compact: { ring: 22, sparkW: 52, sparkH: 16, accHead: 32 },
};

// Cap on how many device ids go into one sparkline request. 13 devices live
// today, but this page paginates SITES, not devices, so a large estate would
// otherwise put every id in the querystring. Beyond the cap the column degrades
// to an em-dash rather than the request degrading.
const SPARK_MAX_DEVICES = 400;

// Top-level grouping by polling agent (agent_id null = local collector).
function groupByAgent(devices: Device[]): AgentGroupT[] {
  const map = new Map<string, AgentGroupT>();
  for (const d of devices) {
    const key = d.agent_id == null ? 'local' : `agent-${d.agent_id}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        agentId: d.agent_id ?? null,
        agentName: d.agent_id == null ? LOCAL : (d.agent_name || `Agent ${d.agent_id}`),
        agentStatus: d.agent_id == null ? null : (d.agent_status || 'offline'),
        devices: [],
      };
      map.set(key, g);
    }
    g.devices.push(d);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.agentId == null) return -1;
    if (b.agentId == null) return 1;
    return a.agentName.localeCompare(b.agentName);
  });
}

function groupBySite(devices: Device[]): SiteGroup[] {
  const map = new Map<string, SiteGroup>();
  for (const d of devices) {
    const name = d.site_name || UNASSIGNED;
    let g = map.get(name);
    if (!g) { g = { key: name, name, siteId: d.site_id, devices: [] }; map.set(name, g); }
    g.devices.push(d);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.name === UNASSIGNED) return 1;
    if (b.name === UNASSIGNED) return -1;
    return a.name.localeCompare(b.name);
  });
}

function countByStatus(devices: Device[]) {
  const c = { up: 0, down: 0, warning: 0, unknown: 0 };
  for (const d of devices) {
    const s = (d.current_status || 'unknown').toLowerCase();
    if (s === 'up') c.up++;
    else if (s === 'down') c.down++;
    else if (s === 'warning') c.warning++;
    else c.unknown++;
  }
  return c;
}

function worstStatus(devices: Device[]): string {
  const c = countByStatus(devices);
  if (c.down) return 'down';
  if (c.warning) return 'warning';
  if (c.up) return 'up';
  return 'unknown';
}

// Average health across a group, for the site-header ring. Devices with no
// computed score are skipped rather than counted as zero.
function avgHealth(devices: Device[]): { score: number | null; grade: string | null } {
  const vals: number[] = [];
  let best: string | null = null;
  for (const d of devices) {
    const s = intelNum(d.health_score);
    if (s != null) { vals.push(s); if (d.health_grade) best = best ?? d.health_grade; }
  }
  if (!vals.length) return { score: null, grade: null };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { score: avg, grade: gradeFromScore(avg) || best };
}

// The intelligence engine grades A–F; the list shows a word. Derived from the
// letter (not a second set of score thresholds) so this page can never disagree
// with the Intelligence page about the same device.
const GRADE_WORD: Record<string, string> = {
  A: 'Excellent', B: 'Good', C: 'Fair', D: 'Poor', F: 'Critical',
};
function gradeWord(grade: string | null): string {
  return GRADE_WORD[(grade || '').toUpperCase()] || '';
}
// Only used for the site-header average, where there is no stored letter grade.
function gradeFromScore(s: number): string | null {
  if (s >= 90) return 'A';
  if (s >= 80) return 'B';
  if (s >= 70) return 'C';
  if (s >= 60) return 'D';
  return 'F';
}

function statusLabel(s: string): string {
  const v = (s || 'unknown').toLowerCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// "high_latency" → "High latency"
function alertLabel(t: string | null): string {
  if (!t) return 'Alert';
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusTooltip(d: Device): string {
  const s = (d.current_status || 'unknown').toLowerCase();
  const seen = d.last_seen_at ? fmtRel(d.last_seen_at) : 'never';
  const ms = d.last_response_ms != null ? `${Number(d.last_response_ms).toFixed(0)}ms` : null;
  if (s === 'up') return `Up — last seen ${seen}${ms ? `, ${ms}` : ''}`;
  if (s === 'down') return `Down — last seen ${seen}`;
  if (s === 'warning') return `Warning${ms ? ` — ${ms}` : ''} — last seen ${seen}`;
  return `Unknown — last seen ${seen}`;
}

// ── Shared device-table column geometry ────────────────────────
// ONE column header is rendered for the page (DeviceTableHeader), not one per
// site accordion: with 7 sites and 13 devices the page used to repeat the full
// 9-column header 7 times, several times above a single data row. Every group
// table must therefore line its columns up with that one header, which per-table
// auto-sizing cannot do — so each table carries `table-layout: fixed` plus the
// shared <colgroup> below, making the widths deterministic and identical.
// Percentages (not px) so the grid still scales with the viewport; each list
// sums to 100.
type DeviceCol = {
  key: string; label: string;
  w: number;    // width % when the optional Version/OS column is hidden
  wOs: number;  // width % when it is shown
  osOnly?: boolean; right?: boolean; sortable?: boolean;
};
// The percentages below are the widths the old per-table auto-layout settled on
// in production (measured at a 1512px viewport: 1214px of table), rounded — so
// pinning them changes almost nothing visually while making every group's
// columns identical. They also used to differ BETWEEN groups (Device came out
// 156/169/194px on three sites of the same page), which the shared header would
// have made obvious.
//
// ⛔ Both lists MUST sum to exactly 100. The Latency (24h) column was added by
// taking 1 point off almost every other column and 2 off Health Score (which
// was the loosest — a 32px ring plus a one-word grade), rather than by giving
// the new column its own slice and letting the total drift: `table-layout:
// fixed` normalises an over- or under-100 colgroup differently from the header
// than from a group table whose rows have different content, so a total that is
// not 100 shows up as the header creeping out of line with the rows below it.
// There is an assertion right under this list that fails loudly in dev if a
// future edit breaks the invariant.
const DEVICE_COLUMNS: DeviceCol[] = [
  { key: 'name',      label: 'Device',         w: 15, wOs: 14 },
  { key: 'type',      label: 'Type',           w: 7,  wOs: 6 },
  { key: 'vendor',    label: 'Vendor / Model', w: 12, wOs: 11 },
  { key: 'ip',        label: 'IP Address',     w: 11, wOs: 10 },
  { key: 'os',        label: 'Version / OS',   w: 0,  wOs: 9, osOnly: true },
  { key: 'status',    label: 'Status',         w: 8,  wOs: 7 },
  { key: 'health',    label: 'Health Score',   w: 11, wOs: 10 },
  { key: 'latency',   label: 'Latency',        w: 10, wOs: 9 },
  { key: 'lastalert', label: 'Last Alert',     w: 10, wOs: 9 },
  { key: 'lastseen',  label: 'Last Seen',      w: 9,  wOs: 8 },
  { key: 'actions',   label: 'Actions',        w: 7,  wOs: 7, right: true, sortable: false },
];
// Dev-only guard for the invariant above. Stripped from the production bundle
// by the `process.env.NODE_ENV` check, so it costs nothing at runtime.
if (process.env.NODE_ENV !== 'production') {
  const sum = (k: 'w' | 'wOs') =>
    DEVICE_COLUMNS.filter((c) => (k === 'wOs' ? true : !c.osOnly)).reduce((a, c) => a + c[k], 0);
  if (sum('w') !== 100 || sum('wOs') !== 100) {
    // eslint-disable-next-line no-console
    console.error(
      `[devices] DEVICE_COLUMNS widths must each total 100 — got w=${sum('w')}, wOs=${sum('wOs')}. ` +
      'Every group table will drift out of line with the shared sticky header.'
    );
  }
}
function deviceCols(showOs: boolean) {
  return DEVICE_COLUMNS
    .filter((c) => showOs || !c.osOnly)
    .map((c) => ({ ...c, width: `${showOs ? c.wOs : c.w}%` }));
}
// Must be rendered by BOTH the shared header table and every group table, or
// their columns drift apart.
function DeviceCols({ showOs }: { showOs: boolean }) {
  return (
    <colgroup>
      {deviceCols(showOs).map((c) => <col key={c.key} style={{ width: c.width }} />)}
    </colgroup>
  );
}

// The page's single column header. Sticky so it stays visible while scrolling
// through the site groups: opaque background token + z-index 5 + a bottom
// separator, per the suite's sticky-header rule (a translucent header lets the
// scrolled rows bleed through and garbles the text in dark mode).
function DeviceTableHeader({ showOs, sort, onSort }: {
  showOs: boolean; sort: SortState; onSort: (col: string) => void;
}) {
  return (
    <div className="sv-sticky-thead sv-sticky-top">
      <table className="sv-table sv-dev-table">
        <DeviceCols showOs={showOs} />
        <thead>
          <tr>
            {deviceCols(showOs).map((c) => (
              c.sortable === false ? (
                <th key={c.key} style={{ textAlign: 'right', padding: '12px 10px' }}>{c.label}</th>
              ) : (
                <SortTh
                  key={c.key} label={c.label} col={c.key} sort={sort} onSort={onSort}
                  align={c.right ? 'right' : 'left'}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
                />
              )
            ))}
          </tr>
        </thead>
      </table>
    </div>
  );
}

// Column accessors for the device tables. One sort state lives on the page (it
// belongs to the single shared header); every group sorts its own rows with it,
// so the groups, the collapse/expand state and the site pagination are untouched.
const DEVICE_SORT: Record<string, (d: Device) => unknown> = {
  name: (d) => d.name,
  type: (d) => d.device_type,
  vendor: (d) => d.nv_vendor || vendorLabel(d.device_vendor),
  ip: (d) => d.ip_address,
  os: (d) => [d.os_type, d.os_version].filter(Boolean).join(' '),
  status: (d) => d.current_status,
  // health_score arrives as a numeric string (pg NUMERIC) or null — normalize so
  // unscored devices sort last instead of comparing as text.
  health: (d) => intelNum(d.health_score),
  // The sparkline shows the trend; the sortable value is the CURRENT reading —
  // the same number printed beside the line — so sorting matches what's on
  // screen. pg returns it as a numeric string; intelNum normalises it so a
  // never-polled device sorts last instead of comparing as text.
  latency: (d) => intelNum(d.last_response_ms),
  lastalert: (d) => d.last_alert_at,
  lastseen: (d) => d.last_seen_at,
};

// ── Density: the CSS half ──────────────────────────────────────
// Scoped to this page rather than added to globals.css: another agent owns that
// file right now. Everything here is a candidate to promote to a suite-wide
// `.sv-table[data-density]` rule later — it is written against `.sv-table`, not
// against anything devices-specific, precisely so it can move unchanged.
//
// Only paddings and the secondary sub-lines change. The colgroup percentages are
// untouched, so compact mode cannot pull a group table out of line with the
// shared sticky header — the widths are the same in both densities, only the row
// HEIGHT differs.
const DENSITY_CSS = `
.sv-dev-list[data-density="compact"] .sv-table td { padding: 5px 10px; }
.sv-dev-list[data-density="compact"] .sv-table th { padding: 7px 10px; }
.sv-dev-list[data-density="compact"] .sv-dev-sub { display: none; }
.sv-dev-list[data-density="compact"] .sv-acc { margin-bottom: 8px !important; }
`;

function DeviceDensityStyles() {
  return <style>{DENSITY_CSS}</style>;
}

// ── Density toggle ─────────────────────────────────────────────
// Uses the suite's existing `.segmented` control so it reads as the same family
// as the other in-page mode switches.
function DensityToggle({ density, onChange }: {
  density: Density; onChange: (d: Density) => void;
}) {
  return (
    <div
      className="segmented"
      role="group"
      aria-label="Row density"
      title="Row density"
    >
      {(['comfortable', 'compact'] as Density[]).map((d) => (
        <button
          key={d}
          type="button"
          className={density === d ? 'active' : ''}
          aria-pressed={density === d}
          onClick={() => onChange(d)}
          style={{ padding: '4px 10px', fontSize: 'var(--text-sm)' }}
        >
          {d === 'comfortable' ? 'Comfortable' : 'Compact'}
        </button>
      ))}
    </div>
  );
}

// Row-level context. `sparks` and the density sizes are needed only by the
// innermost DeviceRow, three levels below the page; threading them as props
// would have meant widening AgentGroup and SiteAccordion for data neither one
// reads. Context keeps those two signatures about grouping.
type DeviceRowCtxT = {
  sparks: SparkMap | null;
  sparksLoading: boolean;
  sizes: { ring: number; sparkW: number; sparkH: number; accHead: number };
};
const DeviceRowCtx = createContext<DeviceRowCtxT>({
  sparks: null, sparksLoading: false, sizes: DENSITY_SIZES.comfortable,
});

// ── Latency sparkline ──────────────────────────────────────────
// 24 clock-aligned hourly buckets of ICMP response time, from ONE aggregate
// request covering every device on the page (`GET /api/devices/sparklines`) —
// never one request per row.
//
// Hand-rolled inline SVG rather than recharts (which /wireless and the device
// detail page use for their full-size charts): a recharts chart mounts a
// ResponsiveContainer with a ResizeObserver per instance, which is far more
// machinery than a 24-point polyline needs when there is one per table row.
//
// Single series, so no legend — the column header names it. Encoding:
//   null   → a gap in the line (no ping samples landed in that hour)
//   0      → the device was down for that WHOLE hour; drawn as a short red tick
//            on the baseline. That is a reserved status colour used for a state,
//            not recycled as a series colour.
//   number → mean response time of that hour's successful pings
// The number beside the line is the device's CURRENT reading and wears a text
// token, never the line colour — colour never carries the value's meaning.
function LatencySpark({ series, currentMs, width, height, loading }: {
  series: (number | null)[] | null;
  currentMs: number | null;
  width: number;
  height: number;
  loading: boolean;
}) {
  const label = currentMs == null ? null : `${Math.round(currentMs)} ms`;

  // Positive readings only drive the scale: a 0 means "down", not "0 ms", and
  // flattening the scale onto it would squash every real reading against the top.
  const vals = (series || []).filter((v): v is number => v != null && v > 0);
  const hasLine = vals.length >= 2;

  let path: string[] = [];
  let downX: number[] = [];
  let lastPt: { x: number; y: number } | null = null;
  let min = 0; let max = 0; let avg = 0;

  if (series && series.length) {
    const n = series.length;
    const stepX = n > 1 ? (width - 2) / (n - 1) : 0;
    min = vals.length ? Math.min(...vals) : 0;
    max = vals.length ? Math.max(...vals) : 0;
    avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const span = max - min;
    const yOf = (v: number) =>
      span > 0
        ? (height - 1) - ((v - min) / span) * (height - 2)
        : height / 2; // a perfectly flat series draws down the middle, not on an edge
    let open = false;
    for (let i = 0; i < n; i++) {
      const v = series[i];
      const x = 1 + i * stepX;
      if (v === 0) { downX.push(x); open = false; continue; }
      if (v == null) { open = false; continue; }
      const y = yOf(v);
      path.push(`${open ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`);
      open = true;
      lastPt = { x, y };
    }
  }

  const downHours = (series || []).filter((v) => v === 0).length;
  const gapHours = (series || []).filter((v) => v == null).length;
  const tip = !series
    ? 'No response-time history for this device'
    : [
        `Response time, last 24h — min ${min.toFixed(1)} ms, avg ${avg.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
        downHours ? `${downHours} hour${downHours === 1 ? '' : 's'} down` : null,
        gapHours ? `${gapHours} hour${gapHours === 1 ? '' : 's'} with no samples` : null,
      ].filter(Boolean).join(' · ');

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <svg
        width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        style={{ flex: 'none', overflow: 'visible' }}
        role="img" aria-label={tip}
      >
        <title>{tip}</title>
        {hasLine && (
          <path
            d={path.join(' ')} fill="none" stroke="var(--tint-info-fg)"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          />
        )}
        {downX.map((x, i) => (
          <rect key={i} x={x - 0.75} y={height - 3} width="1.5" height="3" fill="var(--sv-down)" />
        ))}
        {lastPt && <circle cx={lastPt.x} cy={lastPt.y} r="1.8" fill="var(--tint-info-fg)" />}
        {!hasLine && !downX.length && !loading && (
          <line
            x1="1" y1={height / 2} x2={width - 1} y2={height / 2}
            stroke="var(--border)" strokeWidth="1" strokeDasharray="2 2"
          />
        )}
      </svg>
      {label ? (
        <span
          className="sv-muted"
          style={{ fontSize: 'var(--text-xs)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {label}
        </span>
      ) : (
        <span className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>—</span>
      )}
    </span>
  );
}

// ── KPI stat tile ──────────────────────────────────────────────
// Same shape as the tile on /services (bordered card, coloured left border keyed
// to status, tinted icon circle) so the two pages read as one family. Defined
// locally because that one lives inside services/page.tsx; if a third page wants
// it, promote this to components/ui.tsx rather than copying it again.
function DeviceStatTile({ icon, value, label, sub, variant, tint, title }: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  sub?: string;
  variant: 'total' | 'up' | 'down' | 'warning' | 'unknown';
  tint: { bg: string; fg: string };
  title?: string;
}) {
  return (
    <div className={`sv-card ${variant}`} style={{ display: 'flex', alignItems: 'center', gap: 14 }} title={title}>
      <span
        aria-hidden
        style={{
          width: 42, height: 42, flex: '0 0 auto',
          borderRadius: '50%', /* intentional: true circle (stat tile icon) */
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: tint.bg, color: tint.fg,
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="num" style={{ display: 'block', lineHeight: 1.1 }}>{value}</span>
        <span className="label" style={{ display: 'block' }}>{label}</span>
        {sub && (
          <span className="sv-muted" style={{ display: 'block', fontSize: 'var(--text-sm)', marginTop: 2 }}>
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

export default function DevicesPage() {
  const { canEdit } = useRbac();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [siteId, setSiteId] = useState('');
  const [type, setType] = useState('');
  const [vendor, setVendor] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [chip, setChip] = useState('all');
  const [moreOpen, setMoreOpen] = useState(false);
  // Sites start COLLAPSED, so the page opens on a per-site overview instead of
  // every device row at once. Tracking the OPENED keys (rather than the closed
  // ones) is what makes that the default: the set is empty before any device
  // data has loaded, and "empty" has to mean closed.
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set());
  // Agent groups keep the opposite default — collapsing those too would hide the
  // site summaries this page is meant to land on, leaving only agent names.
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  // One sort for the page's single shared column header; every group applies it
  // to its own rows.
  const { sort, onSort } = useTableSort();
  // Comfortable is the SSR default; the stored choice is applied after mount so
  // the server-rendered markup and the first client render always agree.
  const [density, setDensity] = useState<Density>('comfortable');
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(DENSITY_KEY);
      if (v === 'compact' || v === 'comfortable') setDensity(v);
    } catch { /* ignore — private mode / blocked storage */ }
  }, []);
  const changeDensity = (d: Density) => {
    setDensity(d);
    try { window.localStorage.setItem(DENSITY_KEY, d); } catch { /* ignore */ }
  };
  const sizes = DENSITY_SIZES[density];

  // Pre-select the status filter from the URL (?status=up|down|warning|unknown)
  // so dashboard stat-card links land on a filtered device list.
  useEffect(() => {
    const st = new URLSearchParams(window.location.search).get('status');
    if (st && ['up', 'down', 'warning', 'unknown'].includes(st)) setStatus(st);
  }, []);

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (siteId) params.set('site_id', siteId);
  const devices = useApi<Device[]>(`/api/devices?${params.toString()}`, 20000);
  const sites = useApi<Site[]>('/api/netvault/sites');

  const all = useMemo(() => devices.data || [], [devices.data]);

  // ONE aggregate request for the whole page's latency column. The id list is
  // sorted and joined into a stable string so the path — and therefore useApi's
  // fetch effect — only changes when the device SET changes, not on every 20s
  // device poll (the array identity is new each time). Built from `all`, not
  // from the client-side filtered `visible`, so changing a type/vendor chip
  // filters the rows without refetching any history.
  //
  // Polled at 5 minutes, not the list's 20s: the buckets are hourly, so a faster
  // poll would redraw an identical line and pay for the aggregate 15× over.
  const sparkIds = useMemo(
    () => all.map((d) => d.id).sort((a, b) => a - b).slice(0, SPARK_MAX_DEVICES).join(','),
    [all]
  );
  const sparks = useApi<SparkMap>(
    sparkIds ? `/api/devices/sparklines?metrics=ping&device_ids=${sparkIds}` : null,
    300000
  );

  useRefreshKey(() => { devices.reload(); sites.reload(); sparks.reload(); });
  // Memoised: a fresh object literal here would give every DeviceRow a new
  // context value on each render of this page (it re-renders every 20s on the
  // device poll), defeating the point of keeping the series out of props.
  const rowCtxValue = useMemo<DeviceRowCtxT>(
    () => ({ sparks: sparks.data ?? null, sparksLoading: sparks.loading, sizes }),
    [sparks.data, sparks.loading, sizes]
  );

  // Type / vendor option lists come from the loaded devices, so they only ever
  // offer values that actually match something.
  const typeOptions = useMemo(
    () => Array.from(new Set(all.map((d) => d.device_type).filter(Boolean) as string[])).sort(),
    [all]
  );
  const vendorOptions = useMemo(() => {
    const s = new Set<string>();
    for (const d of all) {
      const v = d.nv_vendor || vendorLabel(d.device_vendor);
      if (v) s.add(v);
    }
    return Array.from(s).sort();
  }, [all]);

  const visible = useMemo(() => all.filter((d) => {
    if (!chipMatch(d, chip)) return false;
    if (type && d.device_type !== type) return false;
    if (vendor && (d.nv_vendor || vendorLabel(d.device_vendor)) !== vendor) return false;
    return true;
  }), [all, chip, type, vendor]);

  // NetVault's os_type/os_version are unpopulated on this install (0 of 2,482
  // inventory rows), which would make "Version / OS" a column of nothing but
  // em-dashes. Show it only once at least one device actually reports an OS, so
  // it appears by itself the moment that data starts arriving.
  const showOs = useMemo(() => visible.some((d) => d.os_version || d.os_type), [visible]);

  const agentGroups = useMemo(() => groupByAgent(visible), [visible]);
  // Only show the agent grouping layer when at least one agent owns devices;
  // otherwise render site accordions flat.
  const hasAgents = agentGroups.some((g) => g.agentId !== null);
  const flatGroups = useMemo(() => groupBySite(visible), [visible]);

  const siteCount = flatGroups.length;
  const pageCount = Math.max(1, Math.ceil(siteCount / SITES_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pagedGroups = flatGroups.slice((safePage - 1) * SITES_PER_PAGE, safePage * SITES_PER_PAGE);

  // Reset to page 1 when the result COUNT changes (search/filter), not on every
  // data refresh — the array identity is new each poll, which would otherwise
  // yank the user back to page 1 every 20 seconds.
  useEffect(() => { setPage(1); }, [siteCount]);

  // ── KPI strip ────────────────────────────────────────────────
  // Counted over `visible` (the filtered set) so the tiles always agree with the
  // "Showing N devices across M sites" line and the rows underneath — a strip
  // that kept showing estate-wide totals while the list was filtered would be
  // two different answers on one screen.
  //
  // Every figure is derived from data the list route already returns; nothing
  // here is a placeholder or an estimate:
  //   up/down/warning/unknown — monitored_devices.current_status
  //   24h availability        — the route's `avail` LATERAL over ping_results
  //   health / degraded       — device_health_scores.score / .grade
  const kpi = useMemo(() => {
    const c = countByStatus(visible);
    const scores: number[] = [];
    const avail: number[] = [];
    let degraded = 0;
    for (const d of visible) {
      const s = intelNum(d.health_score);
      if (s != null) scores.push(s);
      const g = (d.health_grade || '').toUpperCase();
      if (g === 'D' || g === 'F') degraded++;
      const u = intelNum(d.uptime_24h_pct);
      if (u != null) avail.push(u);
    }
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      ...c,
      total: visible.length,
      scored: scores.length,
      avgHealth: mean(scores),
      avgAvail: mean(avail),
      degraded,
    };
  }, [visible]);
  const kpiPct = (n: number) => (kpi.total ? Math.round((n / kpi.total) * 100) : 0);
  // The health tile's left border reports the estate's own grade rather than
  // sitting neutral — the average IS a status, and a colourless tile next to
  // four coloured ones reads as "not applicable".
  const healthVariant: 'up' | 'warning' | 'down' | 'unknown' =
    kpi.avgHealth == null ? 'unknown' : kpi.avgHealth >= 80 ? 'up' : kpi.avgHealth >= 60 ? 'warning' : 'down';

  const siteKeys = hasAgents
    ? agentGroups.flatMap((g) => groupBySite(g.devices).map((s) => `${g.key}::${s.key}`))
    : flatGroups.map((g) => g.key);
  const agentKeys = agentGroups.map((g) => g.key);

  const expandAll = () => { setExpandedSites(new Set(siteKeys)); setCollapsedAgents(new Set()); };
  const collapseAll = () => { setExpandedSites(new Set()); setCollapsedAgents(new Set(agentKeys)); };
  const toggleSite = (k: string) => setExpandedSites((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleAgent = (k: string) => setCollapsedAgents((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // A search that returns matches into collapsed sections reads as "no results",
  // so an active query force-opens every site. This overrides rather than
  // rewrites the manual state, so clearing the search restores whatever the user
  // had open themselves.
  const forceOpen = q.trim().length > 0;

  return (
    <div>
      <PageHeader title="Devices" subtitle="All monitored devices and network inventory">
        {canEdit && (
          <>
            <button className="sv-btn ghost" onClick={() => setShowImport(true)}>Import from NetVault</button>
            <button className="sv-btn" onClick={() => setShowForm(true)}>+ Add Device</button>
          </>
        )}
      </PageHeader>

      <SiteScopeBanner />

      {/* Filter bar: search + site/type/vendor/status, then the More Filters chips. */}
      <div
        className="sv-toolbar"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}
      >
        <input
          className="sv-input"
          placeholder="Search by name, IP…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ height: 32, padding: '0 10px', fontSize: 'var(--text-base)', minWidth: 220 }}
        />
        <select className="sv-select" value={siteId} onChange={(e) => setSiteId(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Sites</option>
          {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="sv-select" value={type} onChange={(e) => setType(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Types</option>
          {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="sv-select" value={vendor} onChange={(e) => setVendor(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Vendors</option>
          {vendorOptions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="sv-select" value={status} onChange={(e) => setStatus(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Statuses</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
          <option value="warning">Warning</option>
          <option value="unknown">Unknown</option>
        </select>
        <button
          className={`sv-chip ${moreOpen || chip !== 'all' ? 'active' : ''}`}
          onClick={() => setMoreOpen((o) => !o)}
          style={{ height: 32, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          More Filters {chip !== 'all' && <span aria-hidden>•</span>}
        </button>
      </div>

      {moreOpen && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 }}>
          {DEVICE_CHIPS.map((c) => (
            <button
              key={c.key}
              className={`sv-chip ${chip === c.key ? 'active' : ''}`}
              onClick={() => setChip(c.key)}
              style={{ height: 30, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center' }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* KPI strip. Counted over the filtered set so it always agrees with the
          "Showing N devices" line directly beneath it. */}
      <div className="sv-cards" style={{ marginBottom: 12 }}>
        <DeviceStatTile
          variant="total" icon={<IconDevices width={20} height={20} />}
          tint={{ bg: 'var(--surface-subtle)', fg: 'var(--text-secondary)' }}
          value={kpi.total} label="DEVICES"
          sub={kpi.avgAvail == null ? undefined : `${kpi.avgAvail.toFixed(2)}% avail (24h)`}
        />
        <DeviceStatTile
          variant="up" icon={<IconArrowUp width={20} height={20} />}
          tint={{ bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' }}
          value={kpi.up} label="UP" sub={`${kpiPct(kpi.up)}% of devices`}
        />
        <DeviceStatTile
          variant="down" icon={<IconArrowDown width={20} height={20} />}
          tint={{ bg: 'var(--tint-danger)', fg: 'var(--tint-danger-fg)' }}
          value={kpi.down} label="DOWN" sub={`${kpiPct(kpi.down)}% of devices`}
        />
        <DeviceStatTile
          variant="warning" icon={<IconWarning width={20} height={20} />}
          tint={{ bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }}
          value={kpi.warning} label="WARNING" sub={`${kpiPct(kpi.warning)}% of devices`}
        />
        <DeviceStatTile
          variant={healthVariant} icon={<IconGauge width={20} height={20} />}
          tint={{ bg: 'var(--tint-info)', fg: 'var(--tint-info-fg)' }}
          value={kpi.avgHealth == null ? '—' : Math.round(kpi.avgHealth)}
          label="AVG HEALTH"
          sub={kpi.scored === 0 ? 'no scores yet' : `${kpi.degraded} graded D or F`}
          title={kpi.scored === kpi.total
            ? undefined
            : `Averaged over the ${kpi.scored} of ${kpi.total} devices that have a health score.`}
        />
      </div>

      {/* Result count + density + expand/collapse controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
          Showing {visible.length.toLocaleString()} {visible.length === 1 ? 'device' : 'devices'} across{' '}
          {siteCount.toLocaleString()} {siteCount === 1 ? 'site' : 'sites'}
        </span>
        <span style={{ flex: 1 }} />
        <DensityToggle density={density} onChange={changeDensity} />
        <button className="sv-btn ghost sm" onClick={expandAll}>Expand All</button>
        <button className="sv-btn ghost sm" onClick={collapseAll}>Collapse All</button>
      </div>

      {devices.error && <ErrorBox message={devices.error} />}

      <DeviceRowCtx.Provider value={rowCtxValue}>
      {devices.loading && !devices.data ? (
        <div className="sv-panel" style={{ padding: 0 }}><TableSkeleton rows={6} cols={6} /></div>
      ) : hasAgents ? (
        agentGroups.map((g) => (
          <AgentGroup
            key={g.key} group={g}
            open={!collapsedAgents.has(g.key)} onToggle={() => toggleAgent(g.key)}
            expandedSites={expandedSites} onToggleSite={toggleSite}
            forceOpen={forceOpen} showOs={showOs} sort={sort} onSort={onSort}
          />
        ))
      ) : pagedGroups.length ? (
        <>
          {/* One column header for the whole page — only while a group is
              actually open, so a fully collapsed list isn't headed by columns
              with nothing under them. */}
          {pagedGroups.some((g) => forceOpen || expandedSites.has(g.key)) && (
            <DeviceTableHeader showOs={showOs} sort={sort} onSort={onSort} />
          )}
          {pagedGroups.map((g) => (
            <SiteAccordion
              key={g.key} group={g}
              open={forceOpen || expandedSites.has(g.key)}
              onToggle={() => toggleSite(g.key)} showOs={showOs} sort={sort}
            />
          ))}
          {pageCount > 1 && (
            <SitePager
              page={safePage} pageCount={pageCount} total={siteCount}
              start={(safePage - 1) * SITES_PER_PAGE} shown={pagedGroups.length}
              onPage={setPage}
            />
          )}
        </>
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <EmptyState
            icon={<IconDevices width={26} height={26} />}
            title={all.length ? 'No devices match these filters' : 'No monitored devices'}
            message={all.length
              ? 'Try clearing the site, type, vendor or status filter.'
              : 'Add a device manually or import your inventory from NetVault to start monitoring.'}
            actionLabel={canEdit && !all.length ? '+ Add Device' : undefined}
            onAction={canEdit && !all.length ? () => setShowForm(true) : undefined}
          />
        </div>
      )}
      </DeviceRowCtx.Provider>

      {showForm && (
        <DeviceForm
          device={null}
          sites={sites.data || []}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); devices.reload(); }}
        />
      )}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); devices.reload(); }}
        />
      )}
    </div>
  );
}

// ── Site-group pagination ──────────────────────────────────────
function SitePager({
  page, pageCount, total, start, shown, onPage,
}: {
  page: number; pageCount: number; total: number; start: number; shown: number;
  onPage: (p: number) => void;
}) {
  const btn = (disabled: boolean) => ({
    padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: 'var(--bg-card)', color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
    cursor: disabled ? 'default' : 'pointer', fontSize: 'var(--text-base)', opacity: disabled ? 0.5 : 1,
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '10px 4px 2px', flexWrap: 'wrap' }}>
      <div className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
        Showing {(start + 1).toLocaleString()} to {(start + shown).toLocaleString()} of {total.toLocaleString()} sites
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button style={btn(page <= 1)} disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page">«</button>
        <button style={btn(page <= 1)} disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
        <span className="sv-muted" style={{ fontSize: 'var(--text-sm)', padding: '0 4px' }}>
          Page {page} of {pageCount}
        </span>
        <button style={btn(page >= pageCount)} disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</button>
        <button style={btn(page >= pageCount)} disabled={page >= pageCount} onClick={() => onPage(pageCount)} aria-label="Last page">»</button>
      </div>
    </div>
  );
}

// ── Agent group: collapsible wrapper holding per-site accordions ──
function AgentGroup({
  group, open, onToggle, expandedSites, onToggleSite, forceOpen, showOs, sort, onSort,
}: {
  group: AgentGroupT;
  open: boolean;
  onToggle: () => void;
  expandedSites: Set<string>;
  onToggleSite: (k: string) => void;
  forceOpen: boolean;
  showOs: boolean;
  sort: SortState;
  onSort: (col: string) => void;
}) {
  const isLocal = group.agentId == null;
  const offline = group.agentStatus === 'offline';
  const siteGroups = groupBySite(group.devices);
  const counts = countByStatus(group.devices);
  return (
    <div className="sv-agent-group" style={{ marginBottom: 12 }}>
      <div
        className={`sv-agent-group-head ${isLocal ? 'local' : ''} ${offline ? 'offline' : ''}`}
        onClick={onToggle}
        style={{ minHeight: 36, padding: '0 14px', gap: 10, background: 'var(--bg-primary)' }}
      >
        <svg className={`chev ${open ? 'open' : ''}`} width="13" height="13" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {isLocal ? (
          <span className="ag-nm" style={{ fontSize: 'var(--text-base)', fontWeight: 700 }}>● {group.agentName}</span>
        ) : (
          <Link href={`/agents/${group.agentId}`} className="ag-nm" style={{ color: 'inherit', fontSize: 'var(--text-base)', fontWeight: 700 }}
            onClick={(e) => e.stopPropagation()} title="View agent detail">
            ● Agent: {group.agentName}
          </Link>
        )}
        {!isLocal && (
          <span className="ag-status" style={{ fontSize: 'var(--text-sm)' }}>
            {group.agentStatus === 'online' ? '● Online' : group.agentStatus === 'offline' ? '○ Offline' : '○ Unknown'}
          </span>
        )}
        <span style={{ fontWeight: 400, fontSize: 'var(--text-sm)', opacity: 0.85 }}>
          {group.devices.length} {group.devices.length === 1 ? 'device' : 'devices'}
        </span>
        <span style={{ flex: 1 }} />
        {offline && <span className="sv-agent-offline-warn">⚠ Agent offline — devices may be stale</span>}
        {!offline && (
          <span className="sv-acc-summary" style={{ fontSize: 'var(--text-sm)' }}>
            {counts.up > 0 && <span className="sv-pill up">{counts.up} up</span>}
            {counts.down > 0 && <span className="sv-pill down">{counts.down} down</span>}
            {counts.warning > 0 && <span className="sv-pill warning">{counts.warning} warning</span>}
          </span>
        )}
      </div>
      {open && (
        <div className="sv-agent-group-body" style={{ padding: 8 }}>
          {/* The shared column header lives inside the agent body so it lines up
              with this group's tables (the body is inset from the page). Still
              one header for the whole group, never one per site. */}
          {siteGroups.some((g) => forceOpen || expandedSites.has(`${group.key}::${g.key}`)) && (
            <DeviceTableHeader showOs={showOs} sort={sort} onSort={onSort} />
          )}
          {siteGroups.map((g) => {
            const k = `${group.key}::${g.key}`;
            return (
              <SiteAccordion
                key={k} group={g}
                open={forceOpen || expandedSites.has(k)}
                onToggle={() => onToggleSite(k)} showOs={showOs} sort={sort}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Site accordion: header summary + the device table ──────────
function SiteAccordion({
  group, open, onToggle, showOs, sort,
}: {
  group: SiteGroup;
  open: boolean;
  onToggle: () => void;
  showOs: boolean;
  // The column header (and therefore the sort control) is shared by the whole
  // page — this group only applies the resulting sort to its own rows.
  sort: SortState;
}) {
  const counts = countByStatus(group.devices);
  const headStatus = worstStatus(group.devices);
  const gateway = group.devices.find((d) => d.is_gateway) || null;
  const gatewayDown = !!gateway && gateway.current_status === 'down';
  const suppressedCount = group.devices.filter((d) => d.alert_suppressed).length;
  const health = avgHealth(group.devices);
  // Unsorted by default, so the API's own ordering is what the table opens with.
  const rows = useMemo(() => sortRows(group.devices, sort, DEVICE_SORT), [group.devices, sort]);

  return (
    <div className="sv-acc" style={{ marginBottom: 12 }}>
      <div
        className={`sv-acc-head ${headStatus}`}
        onClick={onToggle}
        style={{ minHeight: 40, padding: '0 12px', gap: 10, fontSize: 'var(--text-base)' }}
      >
        <StatusDot status={headStatus} size={9} title={`Worst status in this site: ${statusLabel(headStatus)}`} />
        {group.siteId != null ? (
          <Link
            href={`/sites/${group.siteId}`}
            className="site-nm sv-acc-link"
            onClick={(e) => e.stopPropagation()}
            title="View site detail"
          >
            {group.name}
          </Link>
        ) : (
          <span className="site-nm">{group.name}</span>
        )}
        <span className="sv-muted" style={{ fontWeight: 400, fontSize: 'var(--text-sm)' }}>
          {group.devices.length} {group.devices.length === 1 ? 'device' : 'devices'}
        </span>
        {/* This spacer, not the site-name link, absorbs the free width — so the
            empty middle of the header toggles the section instead of navigating
            to the site page. See the .site-nm rule in globals.css. */}
        <span style={{ flex: 1 }} />
        <span className="sv-acc-summary" style={{ fontSize: 'var(--text-sm)' }}>
          {gatewayDown && (
            <span className="sv-acc-gw-down" title={`Site gateway ${gateway?.name} is down`}>
              ⚠ Gateway down — {suppressedCount} suppressed
            </span>
          )}
          <span className="sv-pill up">{counts.up} Up</span>
          <span className="sv-pill warning">{counts.warning} Warning</span>
          <span className="sv-pill down">{counts.down} Down</span>
          {counts.unknown > 0 && <span className="sv-pill unknown">{counts.unknown} Unknown</span>}
        </span>
        <HealthRing score={health.score} grade={health.grade} size={26} showWord={false} />
        <svg className={`chev ${open ? 'open' : ''}`} width="13" height="13" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          style={{ marginLeft: 4 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
      {open && (
        // No <thead> here: the column header is rendered ONCE for the page (see
        // DeviceTableHeader). The shared <colgroup> + table-layout:fixed are what
        // keep these rows aligned with it.
        <table className="sv-table sv-dev-table">
          <DeviceCols showOs={showOs} />
          <tbody>
            {rows.map((d) => <DeviceRow key={d.id} device={d} showOs={showOs} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Health score ring ──────────────────────────────────────────
// SVG donut: grey track + a coloured arc for the score, number in the middle.
// Renders an em-dash when the intelligence engine hasn't scored the device yet,
// never a misleading 0.
function HealthRing({
  score, grade, size = 32, showWord = true,
}: {
  score: number | string | null; grade: string | null; size?: number; showWord?: boolean;
}) {
  const s = intelNum(score);
  if (s == null) return <span className="sv-muted">—</span>;
  const pct = Math.max(0, Math.min(100, s));
  const c = gradeColor(grade);
  const r = size / 2 - 3;
  const circ = 2 * Math.PI * r;
  const word = gradeWord(grade);
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
      title={`Device health score ${Math.round(s)}/100${grade ? ` (grade ${grade.toUpperCase()})` : ''}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: 'none' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c} strokeWidth="3"
          strokeDasharray={`${(pct / 100) * circ} ${circ}`} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central"
          fontSize={size >= 30 ? 11 : 9} fontWeight="700" fill="var(--text-primary)"
        >
          {Math.round(s)}
        </text>
      </svg>
      {showWord && word && (
        <span style={{ fontSize: 'var(--text-xs)', color: c, fontWeight: 600 }}>{word}</span>
      )}
    </span>
  );
}

// ── Single device row ──────────────────────────────────────────
function DeviceRow({ device, showOs }: { device: Device; showOs: boolean }) {
  const rowCtx = useContext(DeviceRowCtx);
  const vendor = device.nv_vendor || vendorLabel(device.device_vendor);
  const os = [device.os_type, device.os_version].filter(Boolean).join(' ');
  return (
    <tr>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link href={`/devices/${device.id}`} className="sv-dev-name-link"
            style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {device.name}
          </Link>
          {device.is_gateway && <span className="sv-gw-star" title="Site gateway">⭐</span>}
          {device.alert_suppressed && (
            <span className="sv-badge suppressed" title="Alerts suppressed — site gateway is down">
              suppressed
            </span>
          )}
        </div>
      </td>
      <td>{device.device_type || <span className="sv-muted">—</span>}</td>
      <td>
        {vendor ? (
          <>
            <div>{vendor}</div>
            {device.nv_model && (
              <div className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>{device.nv_model}</div>
            )}
          </>
        ) : <span className="sv-muted">—</span>}
      </td>
      <td style={{ fontFamily: 'var(--font-mono)' }}>{device.ip_address}</td>
      {showOs && <td>{os || <span className="sv-muted">—</span>}</td>}
      <td>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <StatusDot status={device.current_status} size={8} title={statusTooltip(device)} />
          {statusLabel(device.current_status)}
        </span>
      </td>
      <td><HealthRing score={device.health_score} grade={device.health_grade} size={rowCtx.sizes.ring} /></td>
      <td>
        <LatencySpark
          series={rowCtx.sparks ? (rowCtx.sparks[String(device.id)]?.response_ms ?? null) : null}
          currentMs={intelNum(device.last_response_ms)}
          width={rowCtx.sizes.sparkW}
          height={rowCtx.sizes.sparkH}
          loading={rowCtx.sparksLoading && !rowCtx.sparks}
        />
      </td>
      <td>
        {device.last_alert_at ? (
          <>
            <div style={{ color: 'var(--tint-warn-fg)' }}>{alertLabel(device.last_alert_type)}</div>
            <div className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>{fmtRel(device.last_alert_at)}</div>
          </>
        ) : <span className="sv-muted">—</span>}
      </td>
      <td className="sv-muted">{fmtRel(device.last_seen_at)}</td>
      <td style={{ textAlign: 'right' }}><RowMenu device={device} /></td>
    </tr>
  );
}

// ── Row actions (kebab) ────────────────────────────────────────
// Editing and deleting a device now live on the device detail page, so this menu
// only carries navigation/clipboard actions.
function RowMenu({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="sv-btn ghost sm"
        aria-label={`Actions for ${device.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setCopied(null); setOpen((o) => !o); }}
        style={{ padding: '2px 8px', lineHeight: 1.1, fontSize: 'var(--text-md)' }}
      >
        ⋮
      </button>
      {open && (
        <div className="sv-dropdown" role="menu"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 50, minWidth: 168, textAlign: 'left' }}>
          <Link href={`/devices/${device.id}`} className="sv-dropdown-item" role="menuitem"
            style={{ display: 'block' }} onClick={() => setOpen(false)}>
            View details
          </Link>
          {device.site_id != null && (
            <Link href={`/sites/${device.site_id}`} className="sv-dropdown-item" role="menuitem"
              style={{ display: 'block' }} onClick={() => setOpen(false)}>
              View site
            </Link>
          )}
          <div className="sv-dropdown-divider" />
          <button className="sv-dropdown-item" role="menuitem" style={{ width: '100%', textAlign: 'left' }}
            onClick={() => {
              setCopied(copyText(device.ip_address));
              setTimeout(() => setOpen(false), 700);
            }}>
            {copied === null ? 'Copy IP address' : copied ? '✓ Copied' : 'Copy failed'}
          </button>
        </div>
      )}
    </div>
  );
}

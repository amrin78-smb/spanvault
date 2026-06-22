'use client';

import { useState, useEffect, createContext, useContext } from 'react';
import Link from 'next/link';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { ErrorBox, fmtRel, PageHeader, TableSkeleton, EmptyState, useRefreshKey } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import { Sparkline } from '@/components/Sparkline';
import SiteScopeBanner from '@/components/SiteScopeBanner';
import { IconDevices } from '@/components/icons';
import { DeviceForm, ImportModal } from '@/components/DeviceModals';
import { gradeColor, n as intelNum } from '@/components/intel';

// 24h hourly mini-sparkline series for the device list (see GET
// /api/devices/sparklines). cpu_pct / mem_pct are null when the device has no
// SNMP data. Provided to rows via context to avoid prop-drilling through the
// agent/site grouping layers.
type SparkSeries = {
  response_ms: (number | null)[];
  cpu_pct: (number | null)[] | null;
  mem_pct: (number | null)[] | null;
};
type SparkMap = Record<string, SparkSeries>;
const SparkContext = createContext<SparkMap>({});

type SparkDay = { day: string; uptime: number | null };
type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
  snmp_enabled: boolean; poll_interval_seconds: number; netvault_device_id: number | null;
  latest_cpu_pct: number | null; latest_mem_pct: number | null;
  is_gateway: boolean; alert_suppressed: boolean; suppressed_by_device_id: number | null;
  agent_id: number | null; agent_name: string | null; agent_status: string | null;
  last_alert_at: string | null; spark: SparkDay[] | null;
  health_score: number | string | null; health_grade: string | null; health_trend: string | null;
};

// Quick-filter chips above the search bar (client-side, single-select).
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
type AgentGroupT = {
  key: string; agentId: number | null; agentName: string; agentStatus: string | null; devices: Device[];
};

const UNASSIGNED = 'Unassigned';
const LOCAL = 'Local Polling';

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
  // Local first, then agents alphabetically.
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

function fmtMs(ms: number | null): string {
  return ms != null ? `${Number(ms).toFixed(0)} ms` : '—';
}

function fmtPct(p: number | null): string {
  return p != null ? `${Number(p).toFixed(0)}%` : '—';
}

// Compact per-device health badge for the devices list: grade letter + score,
// colored by grade using the shared intel gradeColor tokens. Surfaces the health
// score the intelligence engine already computes (previously only on the
// Intelligence page). Renders nothing when no score has been computed yet.
function HealthBadge({ score, grade }: { score: number | string | null; grade: string | null }) {
  const s = intelNum(score);
  if (s == null || !grade) return null;
  const c = gradeColor(grade);
  return (
    <span
      className="sv-badge"
      title={`Device health score ${Math.round(s)}/100 (grade ${grade})`}
      style={{
        color: c, borderColor: c, background: 'transparent',
        fontWeight: 700, fontSize: 'var(--text-xs)', padding: '1px 6px',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
    >
      {grade.toUpperCase()} · {Math.round(s)}
    </span>
  );
}

// Rich status-dot tooltip, e.g. "Up — last seen 2m ago, 15ms".
function statusTooltip(d: Device): string {
  const s = (d.current_status || 'unknown').toLowerCase();
  const seen = d.last_seen_at ? fmtRel(d.last_seen_at) : 'never';
  const ms = d.last_response_ms != null ? `${Number(d.last_response_ms).toFixed(0)}ms` : null;
  if (s === 'up') return `Up — last seen ${seen}${ms ? `, ${ms}` : ''}`;
  if (s === 'down') return `Down — last seen ${seen}`;
  if (s === 'warning') return `Warning${ms ? ` — ${ms}` : ''} — last seen ${seen}`;
  return `Unknown — last seen ${seen}`;
}

export default function DevicesPage() {
  const { canEdit } = useRbac();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [siteId, setSiteId] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [chip, setChip] = useState('all');

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

  useRefreshKey(() => { devices.reload(); sites.reload(); });

  function openAdd() { setEditing(null); setShowForm(true); }
  function openEdit(d: Device) { setEditing(d); setShowForm(true); }

  async function handleDelete(d: Device) {
    if (!confirm(`Stop monitoring "${d.name}"? Historical data will be removed.`)) return;
    await apiSend(`/api/devices/${d.id}`, 'DELETE');
    devices.reload();
  }

  const visible = (devices.data || []).filter((d) => chipMatch(d, chip));
  const agentGroups = groupByAgent(visible);
  // Only show the agent grouping layer when at least one agent owns devices;
  // otherwise render site accordions flat (the original layout).
  const hasAgents = agentGroups.some((g) => g.agentId !== null);
  const flatGroups = groupBySite(visible);

  // Fetch 24h mini-sparklines once for all visible devices (cached 5 min). The
  // sorted-id list keeps the URL stable so it isn't refetched on every render.
  const visibleIds = visible.map((d) => d.id).sort((a, b) => a - b);
  const sparklines = useApi<SparkMap>(
    `/api/devices/sparklines?device_ids=${visibleIds.join(',')}`,
    5 * 60 * 1000
  );

  return (
    <SparkContext.Provider value={sparklines.data || {}}>
    <div>
      <PageHeader title="Devices" subtitle="Devices currently monitored by SpanVault, grouped by site.">
        {canEdit && (
          <>
            <button className="sv-btn ghost" onClick={() => setShowImport(true)}>Import from NetVault</button>
            <button className="sv-btn" onClick={openAdd}>+ Add Device</button>
          </>
        )}
      </PageHeader>

      <SiteScopeBanner />

      {/* Single-row filter bar: search + status + site selects, then quick chips. */}
      <div
        className="sv-toolbar"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}
      >
        <input
          className="sv-input"
          placeholder="Search name or IP…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ height: 32, padding: '0 10px', fontSize: 'var(--text-base)', minWidth: 220 }}
        />
        <select
          className="sv-select"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}
        >
          <option value="">All statuses</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
          <option value="warning">Warning</option>
          <option value="unknown">Unknown</option>
        </select>
        <select
          className="sv-select"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}
        >
          <option value="">All sites</option>
          {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {DEVICE_CHIPS.map((c) => (
            <button
              key={c.key}
              className={`sv-chip ${chip === c.key ? 'active' : ''}`}
              onClick={() => setChip(c.key)}
              style={{ height: 32, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center' }}
            >
              {c.label}
            </button>
          ))}
        </span>
      </div>

      {devices.error && <ErrorBox message={devices.error} />}

      {devices.loading && !devices.data ? (
        <div className="sv-panel" style={{ padding: 0 }}><TableSkeleton rows={6} cols={4} /></div>
      ) : hasAgents ? (
        agentGroups.map((g) => (
          <AgentGroup key={g.key} group={g} onEdit={openEdit} onDelete={handleDelete} />
        ))
      ) : flatGroups.length ? (
        flatGroups.map((g) => (
          <SiteAccordion
            key={g.key}
            group={g}
            onEdit={openEdit}
            onDelete={handleDelete}
          />
        ))
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <EmptyState
            icon={<IconDevices width={26} height={26} />}
            title="No monitored devices"
            message="Add a device manually or import your inventory from NetVault to start monitoring."
            actionLabel={canEdit ? '+ Add Device' : undefined}
            onAction={canEdit ? openAdd : undefined}
          />
        </div>
      )}

      {showForm && (
        <DeviceForm
          device={editing}
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
    </SparkContext.Provider>
  );
}

// ── Agent group: collapsible wrapper holding per-site accordions ──
function AgentGroup({
  group, onEdit, onDelete,
}: {
  group: AgentGroupT;
  onEdit: (d: Device) => void;
  onDelete: (d: Device) => void;
}) {
  const [open, setOpen] = useState(true);
  const isLocal = group.agentId == null;
  const offline = group.agentStatus === 'offline';
  const siteGroups = groupBySite(group.devices);
  const counts = countByStatus(group.devices);

  return (
    <div className="sv-agent-group" style={{ marginBottom: 12 }}>
      <div
        className={`sv-agent-group-head ${isLocal ? 'local' : ''} ${offline ? 'offline' : ''}`}
        onClick={() => setOpen((o) => !o)}
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
          {siteGroups.map((g) => (
            <SiteAccordion key={g.key} group={g} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Site accordion group (top-level component) ─────────────────
function SiteAccordion({
  group, onEdit, onDelete,
}: {
  group: SiteGroup;
  onEdit: (d: Device) => void;
  onDelete: (d: Device) => void;
}) {
  const [open, setOpen] = useState(true);
  const counts = countByStatus(group.devices);
  const headStatus = worstStatus(group.devices);
  const gateway = group.devices.find((d) => d.is_gateway) || null;
  const gatewayDown = !!gateway && gateway.current_status === 'down';
  const suppressedCount = group.devices.filter((d) => d.alert_suppressed).length;

  return (
    <div className="sv-acc">
      <div
        className={`sv-acc-head ${headStatus}`}
        onClick={() => setOpen((o) => !o)}
        style={{ minHeight: 32, padding: '0 12px', gap: 10, fontSize: 'var(--text-base)' }}
      >
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
        <span className="sv-acc-summary" style={{ fontSize: 'var(--text-sm)' }}>
          {gatewayDown && (
            <span className="sv-acc-gw-down" title={`Site gateway ${gateway?.name} is down`}>
              ⚠ Gateway down — {suppressedCount} suppressed
            </span>
          )}
          {counts.up > 0 && <span className="sv-pill up">{counts.up} up</span>}
          {counts.down > 0 && <span className="sv-pill down">{counts.down} down</span>}
          {counts.warning > 0 && <span className="sv-pill warning">{counts.warning} warning</span>}
          {counts.unknown > 0 && <span className="sv-pill unknown">{counts.unknown} unknown</span>}
        </span>
        {/* Collapse arrow right-aligned */}
        <svg className={`chev ${open ? 'open' : ''}`} width="13" height="13" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          style={{ marginLeft: 4 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
      {open && group.devices.map((d) => (
        <DeviceRow key={d.id} device={d} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}

// ── Single device row (top-level component) ────────────────────
function DeviceRow({
  device, onEdit, onDelete,
}: {
  device: Device;
  onEdit: (d: Device) => void;
  onDelete: (d: Device) => void;
}) {
  const { canEdit } = useRbac();
  return (
    <div className="sv-dev-row" style={{ minHeight: 40, padding: '4px 14px', gap: 12 }}>
      {device.alert_suppressed
        ? <span className="sv-badge suppressed" title="Alerts suppressed — site gateway is down">suppressed</span>
        : <StatusDot status={device.current_status} size={8} title={statusTooltip(device)} />}
      <div className="sv-dev-id" style={{ minWidth: 200 }}>
        <div className="nm" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-base)', fontWeight: 500 }}>
          <Link href={`/devices/${device.id}`} style={{ color: 'var(--sv-crimson)' }}>
            {device.name}
          </Link>
          {device.is_gateway && <span className="sv-gw-star" title="Site gateway">⭐</span>}
          <HealthBadge score={device.health_score} grade={device.health_grade} />
          {device.last_alert_at && (
            <span className="sv-alert-recent" title={`Last alert ${fmtRel(device.last_alert_at)}`}>
              ⚠ {fmtRel(device.last_alert_at)}
            </span>
          )}
        </div>
        <div className="ip" style={{ fontSize: 'var(--text-xs)', marginTop: 1 }}>
          {device.ip_address}{device.device_type ? ` · ${device.device_type}` : ''}
        </div>
      </div>
      <div className="sv-dev-lat" style={{ minWidth: 60, fontSize: 'var(--text-sm)' }}>
        {fmtMs(device.last_response_ms)}
        <div className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>{fmtRel(device.last_seen_at)}</div>
      </div>
      <UptimeSparkline spark={device.spark} />
      <MonitorBadges device={device} />
      <DeviceTrends deviceId={device.id} snmpEnabled={device.snmp_enabled} />
      {canEdit && (
        <div className="sv-dev-actions">
          <button className="sv-btn ghost sm" onClick={() => onEdit(device)}>Edit</button>{' '}
          <button className="sv-btn ghost sm" onClick={() => onDelete(device)}>Delete</button>
        </div>
      )}
    </div>
  );
}

// ── 7-day uptime sparkline (top-level component) ───────────────
// The API returns ascending daily-uptime entries (only days with data). We take
// the most recent 7 and left-pad with "no data" — no client date math.
function UptimeSparkline({ spark }: { spark: SparkDay[] | null }) {
  const recent = (spark || []).slice(-7);
  const ups: (number | null)[] = recent.map((s) => (s.uptime == null ? null : Number(s.uptime)));
  while (ups.length < 7) ups.unshift(null);
  return (
    <div className="sv-spark" title="7-day uptime" style={{ height: 18, width: 40, flex: 'none' }}>
      {ups.map((up, i) => {
        const cls = up == null ? 'na' : up >= 99 ? 'ok' : up >= 90 ? 'warn' : 'bad';
        const h = up == null ? 35 : Math.max(20, Math.min(100, up));
        return <span key={i} className={`bar ${cls}`} style={{ height: `${h}%` }} />;
      })}
    </div>
  );
}

// ── 24h trend sparklines (top-level component) ─────────────────
// Pulls this device's 24h series from SparkContext. Response is always shown
// (green = up, red = down, grey = no data); CPU/Mem render only when the device
// reports SNMP data. Bars are pure SVG via the shared <Sparkline>.
const TREND_RESPONSE_UP = '#16a34a';
const TREND_RESPONSE_DOWN = '#dc2626';
const TREND_CPU = '#2563eb';
const TREND_MEM = '#7c3aed';

function DeviceTrends({ deviceId, snmpEnabled }: { deviceId: number; snmpEnabled: boolean }) {
  const map = useContext(SparkContext);
  const series = map[String(deviceId)];
  if (!series) return null;
  const cpu = series.cpu_pct;
  const mem = series.mem_pct;
  return (
    <div className="sv-trends" title="Last 24h" style={{ gap: 8 }}>
      <span className="sv-trends-lbl">TRENDS</span>
      <span className="sv-trend">
        <Sparkline
          data={series.response_ms}
          color={TREND_RESPONSE_UP}
          zeroColor={TREND_RESPONSE_DOWN}
          width={40}
          height={18}
          title="24h response time"
        />
      </span>
      {snmpEnabled && Array.isArray(cpu) && (
        <span className="sv-trend">
          <span className="t-lbl">CPU</span>
          <Sparkline data={cpu} color={TREND_CPU} width={40} height={18} max={100} title="24h CPU %" />
        </span>
      )}
      {snmpEnabled && Array.isArray(mem) && (
        <span className="sv-trend">
          <span className="t-lbl">Mem</span>
          <Sparkline data={mem} color={TREND_MEM} width={40} height={18} max={100} title="24h memory %" />
        </span>
      )}
    </div>
  );
}

// ── Inline monitoring badges (top-level component) ─────────────
function MonitorBadges({ device }: { device: Device }) {
  const status = (device.current_status || 'unknown').toLowerCase();
  const pingBad = status === 'down' || status === 'warning';
  return (
    <div className="sv-mon-badges" style={{ gap: 6 }}>
      <span
        className={`sv-mon ping ${pingBad ? 'bad' : ''}`}
        title="ICMP ping latency"
        style={{ maxHeight: 22, padding: '2px 8px', fontSize: 'var(--text-xs)', gap: 4 }}
      >
        <span className="k">Ping</span>
        <span className="m">{fmtMs(device.last_response_ms)}</span>
      </span>
      {device.snmp_enabled && (
        <span
          className="sv-mon snmp"
          title="SNMP CPU / memory utilization"
          style={{ maxHeight: 22, padding: '2px 8px', fontSize: 'var(--text-xs)', gap: 4 }}
        >
          <span className="k">SNMP</span>
          <span className="m">CPU {fmtPct(device.latest_cpu_pct)}</span>
          <span className="m">Mem {fmtPct(device.latest_mem_pct)}</span>
        </span>
      )}
    </div>
  );
}

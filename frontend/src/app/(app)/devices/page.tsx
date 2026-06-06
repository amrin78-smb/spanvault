'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { ErrorBox, fmtRel, PageHeader, TableSkeleton, EmptyState, useRefreshKey } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import SiteScopeBanner from '@/components/SiteScopeBanner';
import { IconDevices } from '@/components/icons';
import { DeviceForm, ImportModal } from '@/components/DeviceModals';

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

  return (
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

      <div className="sv-chips">
        {DEVICE_CHIPS.map((c) => (
          <button
            key={c.key}
            className={`sv-chip ${chip === c.key ? 'active' : ''}`}
            onClick={() => setChip(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="sv-toolbar">
        <input
          className="sv-input"
          placeholder="Search name or IP…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="sv-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
          <option value="warning">Warning</option>
          <option value="unknown">Unknown</option>
        </select>
        <select className="sv-select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          <option value="">All sites</option>
          {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
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
    <div className="sv-agent-group">
      <div
        className={`sv-agent-group-head ${isLocal ? 'local' : ''} ${offline ? 'offline' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg className={`chev ${open ? 'open' : ''}`} width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {isLocal ? (
          <span className="ag-nm">{group.agentName}</span>
        ) : (
          <Link href={`/agents/${group.agentId}`} className="ag-nm" style={{ color: 'inherit' }}
            onClick={(e) => e.stopPropagation()} title="View agent detail">
            Agent: {group.agentName}
          </Link>
        )}
        {!isLocal && (
          <span className="ag-status">
            {group.agentStatus === 'online' ? '● Online' : group.agentStatus === 'offline' ? '○ Offline' : '○ Unknown'}
          </span>
        )}
        <span style={{ fontWeight: 400, fontSize: 13, opacity: 0.85 }}>
          {group.devices.length} {group.devices.length === 1 ? 'device' : 'devices'}
        </span>
        <span style={{ flex: 1 }} />
        {offline && <span className="sv-agent-offline-warn">⚠ Agent offline — devices may be stale</span>}
        {!offline && (
          <span className="sv-acc-summary">
            {counts.up > 0 && <span className="sv-pill up">{counts.up} up</span>}
            {counts.down > 0 && <span className="sv-pill down">{counts.down} down</span>}
            {counts.warning > 0 && <span className="sv-pill warning">{counts.warning} warning</span>}
          </span>
        )}
      </div>
      {open && (
        <div className="sv-agent-group-body">
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
      <div className={`sv-acc-head ${headStatus}`} onClick={() => setOpen((o) => !o)}>
        <svg className={`chev ${open ? 'open' : ''}`} width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
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
        <span className="sv-muted" style={{ fontWeight: 400, fontSize: 13 }}>
          {group.devices.length} {group.devices.length === 1 ? 'device' : 'devices'}
        </span>
        <span className="sv-acc-summary">
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
    <div className="sv-dev-row">
      {device.alert_suppressed
        ? <span className="sv-badge suppressed" title="Alerts suppressed — site gateway is down">suppressed</span>
        : <StatusDot status={device.current_status} title={statusTooltip(device)} />}
      <div className="sv-dev-id">
        <div className="nm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link href={`/devices/${device.id}`} style={{ color: 'var(--sv-crimson)' }}>
            {device.name}
          </Link>
          {device.is_gateway && <span className="sv-gw-star" title="Site gateway">⭐</span>}
          {device.last_alert_at && (
            <span className="sv-alert-recent" title={`Last alert ${fmtRel(device.last_alert_at)}`}>
              ⚠ {fmtRel(device.last_alert_at)}
            </span>
          )}
        </div>
        <div className="ip">{device.ip_address}{device.device_type ? ` · ${device.device_type}` : ''}</div>
      </div>
      <div className="sv-dev-lat">
        {fmtMs(device.last_response_ms)}
        <div className="sv-muted">{fmtRel(device.last_seen_at)}</div>
      </div>
      <Sparkline spark={device.spark} />
      <MonitorBadges device={device} />
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
function Sparkline({ spark }: { spark: SparkDay[] | null }) {
  const by = new Map<string, number | null>();
  for (const s of spark || []) by.set(s.day, s.uptime == null ? null : Number(s.uptime));
  const cells: { key: string; up: number | null }[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    cells.push({ key, up: by.has(key) ? (by.get(key) ?? null) : null });
  }
  return (
    <div className="sv-spark" title="7-day uptime">
      {cells.map((c) => {
        const cls = c.up == null ? 'na' : c.up >= 99 ? 'ok' : c.up >= 90 ? 'warn' : 'bad';
        const h = c.up == null ? 35 : Math.max(20, Math.min(100, c.up));
        return <span key={c.key} className={`bar ${cls}`} style={{ height: `${h}%` }} />;
      })}
    </div>
  );
}

// ── Inline monitoring badges (top-level component) ─────────────
function MonitorBadges({ device }: { device: Device }) {
  const status = (device.current_status || 'unknown').toLowerCase();
  const pingBad = status === 'down' || status === 'warning';
  return (
    <div className="sv-mon-badges">
      <span className={`sv-mon ping ${pingBad ? 'bad' : ''}`} title="ICMP ping latency">
        <span className="k">Ping</span>
        <span className="m">{fmtMs(device.last_response_ms)}</span>
      </span>
      {device.snmp_enabled && (
        <span className="sv-mon snmp" title="SNMP CPU / memory utilization">
          <span className="k">SNMP</span>
          <span className="m">CPU {fmtPct(device.latest_cpu_pct)}</span>
          <span className="m">Mem {fmtPct(device.latest_mem_pct)}</span>
        </span>
      )}
      <span className="sv-mon soon" title="NetFlow monitoring — coming soon">
        <span className="k">NetFlow</span>
        <span>coming soon</span>
      </span>
    </div>
  );
}

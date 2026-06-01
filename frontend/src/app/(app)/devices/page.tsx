'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useApi, apiSend } from '@/lib/api';
import { Loading, ErrorBox, Empty, fmtRel } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import { DeviceForm, ImportModal } from '@/components/DeviceModals';

type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
  snmp_enabled: boolean; poll_interval_seconds: number; netvault_device_id: number | null;
  latest_cpu_pct: number | null; latest_mem_pct: number | null;
  suppressed_by_device_id: number | null;
  parent_device_id: number | null; parent_name: string | null;
};
type Site = { id: number; name: string };
type SiteGroup = { key: string; name: string; siteId: number | null; devices: Device[] };

const UNASSIGNED = 'Unassigned';

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

export default function DevicesPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [siteId, setSiteId] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [showImport, setShowImport] = useState(false);

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

  function openAdd() { setEditing(null); setShowForm(true); }
  function openEdit(d: Device) { setEditing(d); setShowForm(true); }

  async function handleDelete(d: Device) {
    if (!confirm(`Stop monitoring "${d.name}"? Historical data will be removed.`)) return;
    await apiSend(`/api/devices/${d.id}`, 'DELETE');
    devices.reload();
  }

  const groups = devices.data ? groupBySite(devices.data) : [];

  return (
    <div>
      <h1 className="sv-page-title">Devices</h1>
      <p className="sv-page-sub">Devices currently monitored by SpanVault, grouped by site.</p>

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
        <div className="spacer" />
        <button className="sv-btn ghost" onClick={() => setShowImport(true)}>Import from NetVault</button>
        <button className="sv-btn" onClick={openAdd}>+ Add Device</button>
      </div>

      {devices.error && <ErrorBox message={devices.error} />}

      {devices.loading && !devices.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : groups.length ? (
        groups.map((g) => (
          <SiteAccordion
            key={g.key}
            group={g}
            onEdit={openEdit}
            onDelete={handleDelete}
          />
        ))
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No monitored devices. Add one or import from NetVault." />
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
  return (
    <div className="sv-dev-row">
      <StatusDot status={device.current_status} />
      <div className="sv-dev-id">
        <div className="nm">
          <Link href={`/devices/${device.id}`} style={{ color: 'var(--sv-crimson)' }}>
            {device.name}
          </Link>
        </div>
        <div className="ip">{device.ip_address}{device.device_type ? ` · ${device.device_type}` : ''}</div>
        {device.parent_name && (
          <div className="sv-muted" style={{ fontSize: 11 }} title={`Depends on ${device.parent_name}`}>
            ↑ {device.parent_name}
          </div>
        )}
      </div>
      <div className="sv-dev-lat">
        {fmtMs(device.last_response_ms)}
        <div className="sv-muted">{fmtRel(device.last_seen_at)}</div>
      </div>
      <MonitorBadges device={device} />
      <div className="sv-dev-actions">
        <button className="sv-btn ghost sm" onClick={() => onEdit(device)}>Edit</button>{' '}
        <button className="sv-btn ghost sm" onClick={() => onDelete(device)}>Delete</button>
      </div>
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

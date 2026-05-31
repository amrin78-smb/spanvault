'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApi, apiSend } from '@/lib/api';
import { Loading, ErrorBox, Empty, fmtRel } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';

type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
  snmp_enabled: boolean; poll_interval_seconds: number; netvault_device_id: number | null;
  latest_cpu_pct: number | null; latest_mem_pct: number | null;
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

const EMPTY_FORM: any = {
  name: '', ip_address: '', device_type: '', site_id: '',
  snmp_enabled: false, snmp_version: '2c', snmp_community: 'public', snmp_port: 161,
  snmp_v3_user: '', snmp_v3_auth_pass: '', snmp_v3_priv_pass: '',
  poll_interval_seconds: 300, ping_threshold_ms: 500, ping_failures_before_down: 3,
};

export default function DevicesPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [siteId, setSiteId] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [showImport, setShowImport] = useState(false);

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

// ── Add / Edit device modal (top-level component) ──────────────
function DeviceForm({
  device, sites, onClose, onSaved,
}: {
  device: Device | null;
  sites: Site[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<any>(
    device
      ? {
          name: device.name, ip_address: device.ip_address, device_type: device.device_type || '',
          site_id: device.site_id ?? '', snmp_enabled: device.snmp_enabled,
          snmp_version: '2c', snmp_community: 'public', snmp_port: 161,
          snmp_v3_user: '', snmp_v3_auth_pass: '', snmp_v3_priv_pass: '',
          poll_interval_seconds: device.poll_interval_seconds || 300,
          ping_threshold_ms: 500, ping_failures_before_down: 3,
        }
      : { ...EMPTY_FORM }
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set(k: string, v: any) { setForm((f: any) => ({ ...f, [k]: v })); }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const site = sites.find((s) => String(s.id) === String(form.site_id));
      const payload = {
        ...form,
        site_id: form.site_id === '' ? null : parseInt(form.site_id, 10),
        site_name: site ? site.name : null,
      };
      if (device) await apiSend(`/api/devices/${device.id}`, 'PUT', payload);
      else await apiSend('/api/devices', 'POST', payload);
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{device ? 'Edit Device' : 'Add Device'}</h2>
        {err && <ErrorBox message={err} />}
        <div className="sv-form-grid">
          <label className="sv-field">Name
            <input className="sv-input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="sv-field">IP Address
            <input className="sv-input" value={form.ip_address} onChange={(e) => set('ip_address', e.target.value)} />
          </label>
          <label className="sv-field">Device Type
            <input className="sv-input" value={form.device_type} onChange={(e) => set('device_type', e.target.value)} />
          </label>
          <label className="sv-field">Site
            <select className="sv-select" value={form.site_id} onChange={(e) => set('site_id', e.target.value)}>
              <option value="">Unassigned</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="sv-field">Poll Interval (s)
            <input className="sv-input" type="number" value={form.poll_interval_seconds}
              onChange={(e) => set('poll_interval_seconds', parseInt(e.target.value, 10) || 300)} />
          </label>
          <label className="sv-field">Ping Threshold (ms)
            <input className="sv-input" type="number" value={form.ping_threshold_ms}
              onChange={(e) => set('ping_threshold_ms', parseInt(e.target.value, 10) || 500)} />
          </label>
          <label className="sv-field">Failures Before Down
            <input className="sv-input" type="number" value={form.ping_failures_before_down}
              onChange={(e) => set('ping_failures_before_down', parseInt(e.target.value, 10) || 3)} />
          </label>
          <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 24 }}>
            <input type="checkbox" checked={!!form.snmp_enabled} onChange={(e) => set('snmp_enabled', e.target.checked)} />
            Enable SNMP
          </label>
        </div>

        {form.snmp_enabled && (
          <div className="sv-form-grid" style={{ marginTop: 14 }}>
            <label className="sv-field">SNMP Version
              <select className="sv-select" value={form.snmp_version} onChange={(e) => set('snmp_version', e.target.value)}>
                <option value="1">v1</option>
                <option value="2c">v2c</option>
                <option value="3">v3</option>
              </select>
            </label>
            <label className="sv-field">SNMP Port
              <input className="sv-input" type="number" value={form.snmp_port}
                onChange={(e) => set('snmp_port', parseInt(e.target.value, 10) || 161)} />
            </label>
            {form.snmp_version !== '3' ? (
              <label className="sv-field">Community
                <input className="sv-input" value={form.snmp_community} onChange={(e) => set('snmp_community', e.target.value)} />
              </label>
            ) : (
              <>
                <label className="sv-field">v3 User
                  <input className="sv-input" value={form.snmp_v3_user} onChange={(e) => set('snmp_v3_user', e.target.value)} />
                </label>
                <label className="sv-field">v3 Auth Pass
                  <input className="sv-input" type="password" value={form.snmp_v3_auth_pass} onChange={(e) => set('snmp_v3_auth_pass', e.target.value)} />
                </label>
                <label className="sv-field">v3 Priv Pass
                  <input className="sv-input" type="password" value={form.snmp_v3_priv_pass} onChange={(e) => set('snmp_v3_priv_pass', e.target.value)} />
                </label>
              </>
            )}
          </div>
        )}

        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={save} disabled={saving || !form.name || !form.ip_address}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Import from NetVault modal (top-level component) ───────────
type NvDevice = {
  netvault_device_id: number; name: string; ip_address: string;
  device_type: string | null; site_name: string | null;
};

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const available = useApi<NvDevice[]>('/api/netvault/devices');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (!available.data) return;
    setSelected((prev) =>
      prev.size === available.data!.length ? new Set() : new Set(available.data!.map((d) => d.netvault_device_id))
    );
  }

  async function doImport() {
    setImporting(true);
    setErr(null);
    try {
      await apiSend('/api/netvault/import', 'POST', { device_ids: Array.from(selected) });
      onImported();
    } catch (e: any) {
      setErr(e?.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" style={{ maxWidth: 680 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Import Devices from NetVault</h2>
        {err && <ErrorBox message={err} />}
        {available.loading && !available.data ? (
          <Loading />
        ) : available.data && available.data.length ? (
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            <table className="sv-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox"
                      checked={selected.size > 0 && selected.size === available.data.length}
                      onChange={toggleAll} />
                  </th>
                  <th>Name</th><th>IP</th><th>Type</th><th>Site</th>
                </tr>
              </thead>
              <tbody>
                {available.data.map((d) => (
                  <tr key={d.netvault_device_id} onClick={() => toggle(d.netvault_device_id)} style={{ cursor: 'pointer' }}>
                    <td><input type="checkbox" checked={selected.has(d.netvault_device_id)} readOnly /></td>
                    <td>{d.name}</td>
                    <td>{d.ip_address}</td>
                    <td className="sv-muted">{d.device_type || '—'}</td>
                    <td className="sv-muted">{d.site_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty message="All NetVault devices are already monitored." />
        )}
        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={importing}>Cancel</button>
          <button className="sv-btn" onClick={doImport} disabled={importing || selected.size === 0}>
            {importing ? 'Importing…' : `Import ${selected.size || ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

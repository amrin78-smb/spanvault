'use client';

import { useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { Loading, ErrorBox, Empty } from '@/components/ui';

export type Site = { id: number; name: string };

/** Minimal shape DeviceForm needs to pre-fill when editing an existing device. */
export type EditableDevice = {
  id: number;
  name: string;
  ip_address: string;
  device_type: string | null;
  site_id: number | null;
  snmp_enabled: boolean;
  poll_interval_seconds: number;
};

export type NvDevice = {
  netvault_device_id: number; name: string; ip_address: string;
  device_type: string | null; site_id: number | null; site_name: string | null;
};

const DEVICE_TYPES = [
  'Access Point', 'Core Switch', 'Firewall', 'IP Camera', 'IP Phone',
  'Load Balancer', 'NAS / Storage', 'PDU', 'Printer', 'Router',
  'SD-WAN Appliance', 'Server', 'Switch', 'UPS', 'VPN Gateway',
  'WAN Optimizer', 'Wireless Controller', 'Other',
];

const EMPTY_FORM: any = {
  name: '', ip_address: '', device_type: '', site_id: '',
  snmp_enabled: false, snmp_version: '2c', snmp_community: 'public', snmp_port: 161,
  snmp_v3_user: '', snmp_v3_auth_pass: '', snmp_v3_priv_pass: '',
  poll_interval_seconds: 300, ping_threshold_ms: 500, ping_failures_before_down: 3,
};

// ── Add / Edit device modal ────────────────────────────────────
export function DeviceForm({
  device, sites, initialSiteId, onClose, onSaved,
}: {
  device: EditableDevice | null;
  sites: Site[];
  initialSiteId?: number | null;
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
      : { ...EMPTY_FORM, ...(initialSiteId != null ? { site_id: initialSiteId } : {}) }
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
            <select className="sv-select" value={form.device_type} onChange={(e) => set('device_type', e.target.value)}>
              <option value="" disabled>-- Select device type --</option>
              {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
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

// ── Import from NetVault modal ─────────────────────────────────
export function ImportModal({
  onClose, onImported, siteId,
}: {
  onClose: () => void;
  onImported: () => void;
  siteId?: number | null;
}) {
  const available = useApi<NvDevice[]>('/api/netvault/devices');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // When opened from a site page, only offer devices belonging to that site.
  const rows = (available.data || []).filter(
    (d) => siteId == null || d.site_id === siteId
  );

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) =>
      prev.size === rows.length ? new Set() : new Set(rows.map((d) => d.netvault_device_id))
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
        ) : rows.length ? (
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            <table className="sv-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox"
                      checked={selected.size > 0 && selected.size === rows.length}
                      onChange={toggleAll} />
                  </th>
                  <th>Name</th><th>IP</th><th>Type</th><th>Site</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
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
          <Empty message={siteId != null
            ? 'No unmonitored NetVault devices at this site.'
            : 'All NetVault devices are already monitored.'} />
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

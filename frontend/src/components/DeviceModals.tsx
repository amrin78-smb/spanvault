'use client';

import { useEffect, useState } from 'react';
import { useApi, apiGet, apiSend } from '@/lib/api';
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
  parent_device_id: '',
};

type PickerDevice = { id: number; name: string; ip_address: string; site_name: string | null };

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
  // Seed with the minimal known fields; the full record (incl. SNMP credentials)
  // is fetched below when editing so saved values pre-fill and round-trip.
  const [form, setForm] = useState<any>(
    device
      ? {
          ...EMPTY_FORM,
          name: device.name, ip_address: device.ip_address, device_type: device.device_type || '',
          site_id: device.site_id ?? '', snmp_enabled: device.snmp_enabled,
          poll_interval_seconds: device.poll_interval_seconds || 300,
        }
      : { ...EMPTY_FORM, ...(initialSiteId != null ? { site_id: initialSiteId } : {}) }
  );
  const [saving, setSaving] = useState(false);
  const [loadingDevice, setLoadingDevice] = useState(!!device);
  const [err, setErr] = useState<string | null>(null);

  function set(k: string, v: any) { setForm((f: any) => ({ ...f, [k]: v })); }

  // Load the device's full record (SELECT *) so SNMP fields — community,
  // version, port, and v3 credentials — pre-fill from what's stored rather
  // than from defaults, and are preserved when the edit is saved.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    (async () => {
      try {
        const [full, deps] = await Promise.all([
          apiGet<any>(`/api/devices/${device.id}`),
          apiGet<any>(`/api/devices/${device.id}/dependencies`).catch(() => null),
        ]);
        if (cancelled) return;
        setForm((f: any) => ({
          ...f,
          parent_device_id: deps && deps.parent ? deps.parent.id : '',
          name: full.name ?? f.name,
          ip_address: full.ip_address ?? f.ip_address,
          device_type: full.device_type || '',
          site_id: full.site_id ?? '',
          snmp_enabled: !!full.snmp_enabled,
          snmp_version: full.snmp_version || '2c',
          snmp_community: full.snmp_community ?? 'public',
          snmp_port: full.snmp_port || 161,
          snmp_v3_user: full.snmp_v3_user || '',
          snmp_v3_auth_pass: full.snmp_v3_auth_pass || '',
          snmp_v3_priv_pass: full.snmp_v3_priv_pass || '',
          poll_interval_seconds: full.poll_interval_seconds || 300,
          ping_threshold_ms: full.ping_threshold_ms || 500,
          ping_failures_before_down: full.ping_failures_before_down || 3,
        }));
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'Failed to load device settings');
      } finally {
        if (!cancelled) setLoadingDevice(false);
      }
    })();
    return () => { cancelled = true; };
  }, [device]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const site = sites.find((s) => String(s.id) === String(form.site_id));
      const { parent_device_id, ...rest } = form;
      const payload = {
        ...rest,
        site_id: form.site_id === '' ? null : parseInt(form.site_id, 10),
        site_name: site ? site.name : null,
      };
      let deviceId = device ? device.id : null;
      if (device) await apiSend(`/api/devices/${device.id}`, 'PUT', payload);
      else {
        const created = await apiSend<any>('/api/devices', 'POST', payload);
        deviceId = created?.id ?? null;
      }
      // Sync the parent dependency (selected id, or null to clear).
      if (deviceId != null) {
        await apiSend(`/api/devices/${deviceId}/dependencies`, 'POST', {
          parent_device_id: parent_device_id === '' ? null : parseInt(parent_device_id, 10),
        });
      }
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
        {loadingDevice && <p className="sv-muted" style={{ fontSize: 13, marginTop: 0 }}>Loading device settings…</p>}
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
          <ParentDevicePicker
            value={form.parent_device_id}
            excludeId={device ? device.id : null}
            onChange={(id) => set('parent_device_id', id)}
          />
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
          <>
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
            <SnmpTest form={form} />
          </>
        )}

        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={save} disabled={saving || loadingDevice || !form.name || !form.ip_address}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Inline SNMP connectivity test (top-level component) ────────
type SnmpTestResult = {
  success: boolean; vendor?: string; sysDescr?: string; sysName?: string; message: string;
};

function SnmpTest({ form }: { form: any }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SnmpTestResult | null>(null);

  async function run() {
    setTesting(true);
    setResult(null);
    try {
      // Always test the current in-form values — not the last-saved credentials —
      // so the result reflects exactly what the user has typed.
      const r = await apiSend<SnmpTestResult>('/api/snmp-test-adhoc', 'POST', {
        ip_address: form.ip_address,
        snmp_version: form.snmp_version,
        snmp_community: form.snmp_community,
        snmp_port: form.snmp_port,
        snmp_v3_user: form.snmp_v3_user,
        snmp_v3_auth_pass: form.snmp_v3_auth_pass,
        snmp_v3_priv_pass: form.snmp_v3_priv_pass,
      });
      setResult(r);
    } catch (e: any) {
      setResult({ success: false, message: e?.message || 'SNMP test failed' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="sv-snmp-test">
      <button className="sv-btn ghost sm" type="button" onClick={run} disabled={testing || !form.ip_address}>
        {testing ? <><span className="sv-spinner-sm" /> Testing…</> : 'Test SNMP'}
      </button>
      {result && (
        <span className={`sv-snmp-test-result ${result.success ? 'ok' : 'err'}`}>
          {result.success
            ? `✓ SNMP OK — ${result.sysDescr || result.sysName || 'connected'}`
            : `✗ ${result.message}`}
        </span>
      )}
    </div>
  );
}

// ── Searchable parent-device picker (top-level component) ──────
function ParentDevicePicker({
  value, excludeId, onChange,
}: {
  value: number | string;
  excludeId: number | null;
  onChange: (id: number | string) => void;
}) {
  const [devices, setDevices] = useState<PickerDevice[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await apiGet<PickerDevice[]>('/api/devices');
        if (!cancelled) setDevices(rows || []);
      } catch { /* leave empty — picker just shows no matches */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const selected = devices.find((d) => String(d.id) === String(value)) || null;
  const candidates = devices.filter((d) => String(d.id) !== String(excludeId));
  const q = query.trim().toLowerCase();
  const matches = (q
    ? candidates.filter((d) =>
        d.name.toLowerCase().includes(q) || d.ip_address.toLowerCase().includes(q))
    : candidates
  ).slice(0, 30);

  function pick(id: number | string) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  return (
    <label className="sv-field" style={{ position: 'relative' }}>
      Parent Device
      {selected && !open ? (
        <div className="sv-input" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected.name} <span className="sv-muted">· {selected.ip_address}</span>
          </span>
          <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button type="button" className="sv-btn ghost sm" onClick={() => setOpen(true)}>Change</button>
            <button type="button" className="sv-btn ghost sm" onClick={() => pick('')}>Clear</button>
          </span>
        </div>
      ) : (
        <input
          className="sv-input"
          placeholder="Search devices… (none = no parent)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      )}
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          maxHeight: 220, overflowY: 'auto', background: '#fff',
          border: '1px solid #d9dde5', borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.12)',
        }}>
          <div
            onMouseDown={(e) => { e.preventDefault(); pick(''); }}
            style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13 }}
            className="sv-muted"
          >
            — No parent —
          </div>
          {matches.map((d) => (
            <div
              key={d.id}
              onMouseDown={(e) => { e.preventDefault(); pick(d.id); }}
              style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13, borderTop: '1px solid #f0f1f4' }}
            >
              {d.name} <span className="sv-muted">· {d.ip_address}{d.site_name ? ` · ${d.site_name}` : ''}</span>
            </div>
          ))}
          {q && matches.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 13 }} className="sv-muted">No matches</div>
          )}
        </div>
      )}
    </label>
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

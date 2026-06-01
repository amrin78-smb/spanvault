'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiSend } from '@/lib/api';
import { Loading, ErrorBox } from '@/components/ui';

type DiscoverSensor = {
  key: string; name: string; category: string;
  metric_name: string; oid: string | null; current_value: string; unit: string;
  base_name?: string; meta?: string;
};
type SavedSensor = {
  id: number; sensor_key: string; sensor_name: string; category: string;
  metric_name: string; oid: string | null; enabled: boolean;
};
// Unified entry for an available/known sensor (merge of saved + discovered).
type Avail = {
  key: string; name: string; category: string;
  metric_name: string; oid: string | null; current_value?: string;
  // Interface enrichment from discovery: base_name (line 1) + meta (muted line 2).
  base_name?: string; meta?: string;
};

const CAT_ORDER = ['system', 'interface', 'vendor'];
const CAT_LABEL: Record<string, string> = {
  system: 'System', interface: 'Interfaces', vendor: 'Vendor-specific',
};

function groupByCat(list: Avail[]): Record<string, Avail[]> {
  const g: Record<string, Avail[]> = {};
  for (const it of list) (g[it.category] = g[it.category] || []).push(it);
  return g;
}

/**
 * Full-screen SNMP sensor manager. Left = available sensors (checklist),
 * right = currently enabled selection. "Run Discovery" walks the device and
 * populates the left panel with live current values.
 */
export default function SensorManager({
  deviceId, deviceName, onClose, onSaved,
}: {
  deviceId: number;
  deviceName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [avail, setAvail] = useState<Map<string, Avail>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [vendor, setVendor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load the already-saved sensor selection on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await apiGet<SavedSensor[]>(`/api/devices/${deviceId}/sensors`);
        if (cancelled) return;
        const m = new Map<string, Avail>();
        const sel = new Set<string>();
        for (const r of rows) {
          m.set(r.sensor_key, {
            key: r.sensor_key, name: r.sensor_name, category: r.category,
            metric_name: r.metric_name, oid: r.oid,
          });
          if (r.enabled) sel.add(r.sensor_key);
        }
        setAvail(m);
        setSelected(sel);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'Failed to load sensors');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);

  async function runDiscovery() {
    setDiscovering(true);
    setErr(null);
    try {
      const res = await apiSend<{ vendor: string; sysDescr: string; sensors: DiscoverSensor[] }>(
        `/api/devices/${deviceId}/snmp-discover`, 'POST', {}
      );
      setVendor(res.vendor);
      setAvail((prev) => {
        const m = new Map(prev);
        for (const s of res.sensors) {
          m.set(s.key, {
            key: s.key, name: s.name, category: s.category,
            metric_name: s.metric_name, oid: s.oid, current_value: s.current_value,
            base_name: s.base_name, meta: s.meta,
          });
        }
        return m;
      });
      // First-time convenience: pre-tick System sensors if nothing was selected.
      setSelected((prev) => {
        if (prev.size > 0) return prev;
        const sel = new Set<string>();
        for (const s of res.sensors) if (s.category === 'system') sel.add(s.key);
        return sel;
      });
    } catch (e: any) {
      setErr(e?.message || 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const sensors = Array.from(avail.values()).map((a) => ({
        sensor_key: a.key, sensor_name: a.name, category: a.category,
        metric_name: a.metric_name, oid: a.oid, enabled: selected.has(a.key),
      }));
      await apiSend(`/api/devices/${deviceId}/sensors`, 'PUT', { sensors });
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const items = Array.from(avail.values());
  const enabledItems = items.filter((i) => selected.has(i.key));
  const leftGroups = groupByCat(items);
  const rightGroups = groupByCat(enabledItems);

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal full" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sv-sensor-head">
          <h2 style={{ margin: 0 }}>SNMP Sensors — {deviceName}</h2>
          <div style={{ flex: 1 }} />
          {vendor && <span className="sv-muted" style={{ fontSize: 13 }}>Vendor: {vendor}</span>}
          <button className="sv-btn" onClick={runDiscovery} disabled={discovering}>
            {discovering ? <><span className="sv-spinner-sm" /> Discovering…</> : 'Run Discovery'}
          </button>
          <button className="sv-btn ghost" onClick={onClose}>Close</button>
        </div>

        {err && <ErrorBox message={err} />}

        {loading ? (
          <Loading />
        ) : (
          <div className="sv-sensor-cols">
            <div className="sv-sensor-panel">
              <h3>Available Sensors</h3>
              {items.length === 0 ? (
                <div className="sv-empty">No sensors configured. Click Run Discovery to find available sensors.</div>
              ) : (
                CAT_ORDER.filter((c) => leftGroups[c]?.length).map((cat) => (
                  <div key={cat} className="sv-sensor-group">
                    <div className="sv-sensor-group-title">{CAT_LABEL[cat]}</div>
                    {leftGroups[cat].map((it) => (
                      <label key={it.key} className="sv-sensor-item">
                        <input type="checkbox" checked={selected.has(it.key)} onChange={() => toggle(it.key)} />
                        <span className="sv-sensor-info">
                          <span className="nm">{it.base_name || it.name}</span>
                          {it.meta && <span className="meta">{it.meta}</span>}
                        </span>
                        {it.current_value !== undefined && <span className="val">{it.current_value}</span>}
                        <span className="oid">{it.oid || ''}</span>
                      </label>
                    ))}
                  </div>
                ))
              )}
            </div>

            <div className="sv-sensor-panel">
              <h3>Enabled Sensors ({enabledItems.length})</h3>
              {enabledItems.length === 0 ? (
                <div className="sv-empty">No sensors enabled yet. Tick sensors on the left.</div>
              ) : (
                CAT_ORDER.filter((c) => rightGroups[c]?.length).map((cat) => (
                  <div key={cat} className="sv-sensor-group">
                    <div className="sv-sensor-group-title">{CAT_LABEL[cat]}</div>
                    {rightGroups[cat].map((it) => (
                      <div key={it.key} className="sv-sensor-item enabled">
                        <span className="sv-sensor-info">
                          <span className="nm">{it.base_name || it.name}</span>
                          {it.meta && <span className="meta">{it.meta}</span>}
                        </span>
                        {it.current_value !== undefined && <span className="val">{it.current_value}</span>}
                        <button className="sv-btn ghost sm" onClick={() => toggle(it.key)}>Remove</button>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={save} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

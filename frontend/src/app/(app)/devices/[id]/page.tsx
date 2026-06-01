'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useApi, apiSend } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import SensorManager from '@/components/SensorManager';
import { StatusBadge, Loading, ErrorBox, Empty, fmtTime, fmtRel, fmtBps } from '@/components/ui';

type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_name: string | null; current_status: string; last_response_ms: number | null;
  last_seen_at: string | null; last_checked_at: string | null; snmp_enabled: boolean;
  poll_interval_seconds: number; ping_threshold_ms: number; device_vendor: string | null;
};
type PingPoint = { bucket: string; avg_ms: number | null; max_loss: number | null; down_samples: number };
type SnmpPoint = { bucket: string; if_name: string | null; avg_value: number | null };
type Alert = {
  id: number; alert_type: string; severity: string; message: string;
  triggered_at: string; resolved_at: string | null; status: string;
};
type Sensor = {
  id: number; sensor_key: string; sensor_name: string; category: string;
  metric_name: string; oid: string | null; enabled: boolean;
};
type TestResult = {
  success: boolean; vendor?: string; sysDescr?: string; sysName?: string; message: string;
};

// Map a detected vendor key (from the collector's SNMP parser) to a label.
const VENDOR_LABELS: Record<string, string> = {
  fortinet: 'Fortinet', cisco: 'Cisco', aruba: 'Aruba', paloalto: 'Palo Alto',
  sangfor: 'Sangfor', 'hpe-procurve': 'HPE ProCurve', 'hpe-comware': 'HPE Comware',
  juniper: 'Juniper', huawei: 'Huawei', mikrotik: 'MikroTik', ubiquiti: 'Ubiquiti',
  dell: 'Dell', extreme: 'Extreme', brocade: 'Brocade', meraki: 'Cisco Meraki',
  netgear: 'Netgear', tplink: 'TP-Link', generic: 'Generic (standard MIBs)',
};
function vendorLabel(v: string | null): string | null {
  if (!v) return null;
  return VENDOR_LABELS[v] || v;
}

const RANGES = [
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

const CAT_COLOR: Record<string, string> = {
  system: '#1a2744', interface: '#C8102E', vendor: '#2e9e5b',
};

// Combined interface-traffic line colours (In = blue, Out = orange).
const TRAFFIC_IN_COLOR = '#3b82f6';
const TRAFFIC_OUT_COLOR = '#f97316';

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState('24h');
  const [sensorsOpen, setSensorsOpen] = useState(false);
  const [toast, setToast] = useState<TestResult | null>(null);

  const device = useApi<Device>(`/api/devices/${id}`, 20000);
  const ping = useApi<PingPoint[]>(`/api/devices/${id}/ping-history?range=${range}`, 20000);
  const sensors = useApi<Sensor[]>(`/api/devices/${id}/sensors`, 0);
  const alerts = useApi<Alert[]>(`/api/devices/${id}/alerts`, 20000);

  // Auto-dismiss the SNMP-test toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  if (device.loading && !device.data) return <Loading />;
  if (device.error) return <ErrorBox message={device.error} />;
  if (!device.data) return <Empty message="Device not found." />;

  const d = device.data;
  const snmpOn = d.snmp_enabled;
  const enabledSensors = (sensors.data || []).filter((s) => s.enabled);
  const sensorsLoading = sensors.loading && !sensors.data;

  return (
    <div>
      {toast && (
        <div className={`sv-toast ${toast.success ? 'ok' : 'err'}`} onClick={() => setToast(null)}>
          {toast.success
            ? `✓ SNMP OK — ${toast.sysDescr || toast.sysName || 'connected'}`
            : `✗ ${toast.message}`}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <StatusDot status={d.current_status} size={14} />
        <h1 className="sv-page-title" style={{ margin: 0 }}>{d.name}</h1>
        <StatusBadge status={d.current_status} />
        <div style={{ flex: 1 }} />
        {snmpOn && (
          <button className="sv-btn ghost sm" onClick={() => setSensorsOpen(true)}>Manage Sensors</button>
        )}
        {snmpOn && <TestSnmpButton deviceId={d.id} onResult={setToast} />}
        <PingNow deviceId={d.id} />
      </div>
      <p className="sv-page-sub">
        {d.ip_address} · {d.device_type || 'Unknown type'} · {d.site_name || 'Unassigned'}
        {vendorLabel(d.device_vendor) && <> · {vendorLabel(d.device_vendor)}</>}
      </p>

      <div className="sv-cards">
        <div className="sv-card total">
          <div className="num">{d.last_response_ms != null ? `${Number(d.last_response_ms).toFixed(0)}` : '—'}</div>
          <div className="label">Last Latency (ms)</div>
        </div>
        <div className="sv-card">
          <div className="num" style={{ fontSize: 18 }}>{fmtRel(d.last_seen_at)}</div>
          <div className="label">Last Seen</div>
        </div>
        <div className="sv-card">
          <div className="num" style={{ fontSize: 18 }}>{fmtRel(d.last_checked_at)}</div>
          <div className="label">Last Checked</div>
        </div>
        <div className="sv-card">
          <div className="num">{d.poll_interval_seconds}s</div>
          <div className="label">Poll Interval</div>
        </div>
      </div>

      <div className="sv-toolbar">
        <div className="sv-tabs" style={{ marginBottom: 0, border: 'none' }}>
          {RANGES.map((r) => (
            <button key={r.key} className={`sv-tab ${range === r.key ? 'active' : ''}`} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sv-sensor-grid">
        <div className="sv-sensor-cell wide">
          <h2>Ping Latency (ms)</h2>
          <LatencyChart data={ping.data || []} loading={ping.loading} />
        </div>
        <div className="sv-sensor-cell wide">
          <h2>Packet Loss (%)</h2>
          <SingleChart
            data={(ping.data || []).map((p) => ({ bucket: p.bucket, value: p.max_loss }))}
            loading={ping.loading} color="#C8102E" unit="%"
          />
        </div>
        {snmpOn && !sensorsLoading && enabledSensors.length > 0 && (
          <SensorGraphs deviceId={d.id} sensors={enabledSensors} range={range} />
        )}
      </div>

      {snmpOn && sensorsLoading && <div className="sv-panel"><Loading /></div>}
      {snmpOn && !sensorsLoading && enabledSensors.length === 0 && (
        <div className="sv-panel" style={{ textAlign: 'center', padding: '32px 20px' }}>
          <p className="sv-muted" style={{ marginTop: 0 }}>
            No sensors configured. Run Discovery to choose what to monitor on this device.
          </p>
          <button className="sv-btn" onClick={() => setSensorsOpen(true)}>Manage Sensors</button>
        </div>
      )}

      <div className="sv-panel">
        <h2>Alert History</h2>
        {alerts.loading && !alerts.data ? (
          <Loading />
        ) : alerts.data && alerts.data.length ? (
          <table className="sv-table">
            <thead>
              <tr><th>Severity</th><th>Type</th><th>Message</th><th>Triggered</th><th>Resolved</th><th>Status</th></tr>
            </thead>
            <tbody>
              {alerts.data.map((a) => (
                <tr key={a.id}>
                  <td><StatusBadge status={a.severity} /></td>
                  <td>{a.alert_type}</td>
                  <td>{a.message}</td>
                  <td className="sv-muted">{fmtTime(a.triggered_at)}</td>
                  <td className="sv-muted">{a.resolved_at ? fmtTime(a.resolved_at) : '—'}</td>
                  <td><StatusBadge status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No alerts recorded for this device." />
        )}
      </div>

      {sensorsOpen && (
        <SensorManager
          deviceId={d.id}
          deviceName={d.name}
          onClose={() => setSensorsOpen(false)}
          onSaved={() => { setSensorsOpen(false); sensors.reload(); }}
        />
      )}
    </div>
  );
}

// ── SNMP test button (top-level component) ─────────────────────
function TestSnmpButton({ deviceId, onResult }: { deviceId: number; onResult: (r: TestResult) => void }) {
  const [testing, setTesting] = useState(false);
  async function run() {
    setTesting(true);
    try {
      const r = await apiSend<TestResult>(`/api/devices/${deviceId}/snmp-test`, 'POST', {});
      onResult(r);
    } catch (e: any) {
      onResult({ success: false, message: e?.message || 'SNMP test failed' });
    } finally {
      setTesting(false);
    }
  }
  return (
    <button className="sv-btn ghost sm" onClick={run} disabled={testing}>
      {testing ? <><span className="sv-spinner-sm" /> Testing…</> : 'Test SNMP'}
    </button>
  );
}

// ── On-demand ping (top-level component) ───────────────────────
function PingNow({ deviceId }: { deviceId: number }) {
  const [pinging, setPinging] = useState(false);
  const [result, setResult] = useState<{ ms: number | null; status: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setPinging(true);
    setErr(null);
    setResult(null);
    try {
      const r = await apiSend<{ ms: number | null; status: string }>(
        `/api/devices/${deviceId}/ping-now`, 'POST', {}
      );
      setResult(r);
    } catch (e: any) {
      setErr(e?.message || 'Ping failed');
    } finally {
      setPinging(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {err && <span style={{ color: 'var(--sv-down)', fontSize: 13 }}>{err}</span>}
      {!err && result && (
        result.status === 'down' || result.ms == null ? (
          <span className="sv-badge down">Timeout</span>
        ) : (
          <span className={`sv-badge ${result.status}`}>{Number(result.ms).toFixed(0)} ms</span>
        )
      )}
      <button className="sv-btn ghost sm" onClick={run} disabled={pinging}>
        {pinging ? (
          <>
            <span className="sv-spinner-sm" /> Pinging…
          </>
        ) : (
          'Ping Now'
        )}
      </button>
    </div>
  );
}

// ── Sensor graph layout: pair interface In/Out bps into one chart ──────
type GraphItem =
  | { kind: 'single'; sensor: Sensor }
  | { kind: 'pair'; ifIndex: number; ifLabel: string; inSensor: Sensor; outSensor: Sensor };

// Parse an interface-traffic metric_name like "if_3_in_bps" → { idx: 3, dir }.
function parseIfBps(metric: string): { idx: number; dir: 'in' | 'out' } | null {
  const m = /^if_(\d+)_(in|out)_bps$/.exec(metric);
  if (!m) return null;
  return { idx: Number(m[1]), dir: m[2] as 'in' | 'out' };
}

// Interface display name from a sensor name like "Fa0/0 — In [alias] · 1 Gbps".
function ifLabelFor(idx: number, ...sensors: Sensor[]): string {
  for (const s of sensors) {
    const base = (s.sensor_name || '').split(' — ')[0].trim();
    if (base) return `${base} Traffic`;
  }
  return `Interface ${idx} Traffic`;
}

// Group sensors: matching if_<idx>_in_bps + if_<idx>_out_bps become one combined
// chart; everything else stays a single-line chart. Original order is preserved.
function buildGraphItems(sensors: Sensor[]): GraphItem[] {
  const inByIdx = new Map<number, Sensor>();
  const outByIdx = new Map<number, Sensor>();
  for (const s of sensors) {
    const p = parseIfBps(s.metric_name);
    if (p?.dir === 'in') inByIdx.set(p.idx, s);
    else if (p?.dir === 'out') outByIdx.set(p.idx, s);
  }
  const consumed = new Set<number>();
  const items: GraphItem[] = [];
  for (const s of sensors) {
    if (consumed.has(s.id)) continue;
    const p = parseIfBps(s.metric_name);
    if (p) {
      const inS = inByIdx.get(p.idx);
      const outS = outByIdx.get(p.idx);
      if (inS && outS) {
        items.push({
          kind: 'pair', ifIndex: p.idx, ifLabel: ifLabelFor(p.idx, inS, outS),
          inSensor: inS, outSensor: outS,
        });
        consumed.add(inS.id); consumed.add(outS.id);
        continue;
      }
    }
    items.push({ kind: 'single', sensor: s });
  }
  return items;
}

// ── Sensor graphs in a compact responsive grid (top-level component) ─
function SensorGraphs({
  deviceId, sensors, range,
}: {
  deviceId: number; sensors: Sensor[]; range: string;
}) {
  const items = buildGraphItems(sensors);
  // Returns cells only (no grid wrapper) so they join the page-level
  // sv-sensor-grid alongside the Ping Latency / Packet Loss cells.
  return (
    <>
      {items.map((it) =>
        it.kind === 'pair' ? (
          <InterfaceTrafficChart
            key={`pair-${it.ifIndex}`}
            deviceId={deviceId} ifLabel={it.ifLabel}
            inSensor={it.inSensor} outSensor={it.outSensor} range={range}
          />
        ) : (
          <SensorChart key={it.sensor.id} deviceId={deviceId} sensor={it.sensor} range={range} />
        )
      )}
    </>
  );
}

type Unit = '%' | 'bps' | 'state' | 'bytes' | 'W' | '°C' | 'count';
function metricUnit(metric: string): Unit {
  if (metric.endsWith('_oper')) return 'state';
  if (metric.endsWith('pct')) return '%';
  if (metric.endsWith('_bps')) return 'bps';
  if (metric.includes('bytes')) return 'bytes';
  if (metric.endsWith('_w')) return 'W';
  if (metric.includes('temperature')) return '°C';
  return 'count';
}

// Combined In/Out traffic chart for one interface (two lines: blue In, orange Out).
function InterfaceTrafficChart({
  deviceId, ifLabel, inSensor, outSensor, range,
}: {
  deviceId: number; ifLabel: string; inSensor: Sensor; outSensor: Sensor; range: string;
}) {
  const inHist = useApi<SnmpPoint[]>(
    `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(inSensor.metric_name)}&range=${range}`, 0
  );
  const outHist = useApi<SnmpPoint[]>(
    `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(outSensor.metric_name)}&range=${range}`, 0
  );

  // Merge both series on the shared (date_bin-aligned) bucket timestamp.
  const byBucket = new Map<string, { bucket: string; in: number | null; out: number | null }>();
  for (const p of inHist.data || []) {
    const e = byBucket.get(p.bucket) || { bucket: p.bucket, in: null, out: null };
    e.in = p.avg_value != null ? Number(p.avg_value) : null;
    byBucket.set(p.bucket, e);
  }
  for (const p of outHist.data || []) {
    const e = byBucket.get(p.bucket) || { bucket: p.bucket, in: null, out: null };
    e.out = p.avg_value != null ? Number(p.avg_value) : null;
    byBucket.set(p.bucket, e);
  }
  const data = Array.from(byBucket.values()).sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  const loading = (inHist.loading && !inHist.data) || (outHist.loading && !outHist.data);

  return (
    <div className="sv-sensor-cell wide">
      <h2 title={ifLabel}>{ifLabel}</h2>
      {loading ? (
        <Loading />
      ) : !data.length ? (
        <Empty message="No data yet for this interface." />
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={data} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
            <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={10} minTickGap={40} />
            <YAxis fontSize={10} width={64} tickFormatter={(v) => fmtBps(Number(v))} />
            <Tooltip
              labelFormatter={tickLabel}
              formatter={(v: any, name: any) => [v == null ? '—' : fmtBps(Number(v)), name]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" name="In" dataKey="in" stroke={TRAFFIC_IN_COLOR} strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" name="Out" dataKey="out" stroke={TRAFFIC_OUT_COLOR} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function SensorChart({ deviceId, sensor, range }: { deviceId: number; sensor: Sensor; range: string }) {
  const hist = useApi<SnmpPoint[]>(
    `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(sensor.metric_name)}&range=${range}`,
    0
  );
  const unit = metricUnit(sensor.metric_name);
  const color = CAT_COLOR[sensor.category] || '#1a2744';
  const data = (hist.data || []).map((p) => ({ bucket: p.bucket, value: p.avg_value != null ? Number(p.avg_value) : null }));
  const suffix = unit === 'count' || unit === 'state' ? '' : ` (${unit})`;

  const fmtVal = (v: number) => {
    if (unit === 'bps') return fmtBps(v);
    if (unit === '%') return `${v}%`;
    if (unit === 'state') return v >= 0.5 ? 'Up' : 'Down';
    if (unit === '°C') return `${v} °C`;
    if (unit === 'W') return `${v} W`;
    return `${v}`;
  };

  return (
    <div className="sv-sensor-cell">
      <h2 title={`${sensor.sensor_name}${suffix}`}>{sensor.sensor_name}{suffix}</h2>
      {hist.loading && !hist.data ? (
        <Loading />
      ) : !data.length ? (
        <Empty message="No data yet for this sensor." />
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={data} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
            <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={10} minTickGap={40} />
            <YAxis
              fontSize={10}
              width={unit === 'bps' ? 64 : 44}
              domain={unit === 'state' ? [0, 1] : undefined}
              tickFormatter={unit === 'bps' ? (v) => fmtBps(Number(v)) : undefined}
            />
            <Tooltip labelFormatter={tickLabel} formatter={(v: any) => [fmtVal(Number(v)), sensor.sensor_name]} />
            <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Chart helpers (top-level components) ───────────────────────
function tickLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function LatencyChart({ data, loading }: { data: PingPoint[]; loading: boolean }) {
  if (loading && !data.length) return <Loading />;
  if (!data.length) return <Empty message="No ping data for this range." />;
  const chartData = data.map((p) => ({
    bucket: p.bucket,
    ms: p.avg_ms != null ? Number(p.avg_ms) : null,
  }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={10} minTickGap={40} />
        <YAxis fontSize={10} width={44} />
        <Tooltip labelFormatter={tickLabel} formatter={(v: any) => [`${v} ms`, 'Latency']} />
        <Line type="monotone" dataKey="ms" stroke="#C8102E" strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

function SingleChart({
  data, loading, color, unit,
}: {
  data: { bucket: string; value: number | null }[]; loading: boolean; color: string; unit: string;
}) {
  if (loading && !data.length) return <Loading />;
  if (!data.length) return <Empty message="No data for this range." />;
  const chartData = data.map((p) => ({ bucket: p.bucket, value: p.value != null ? Number(p.value) : null }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={10} minTickGap={40} />
        <YAxis fontSize={10} width={44} />
        <Tooltip labelFormatter={tickLabel} formatter={(v: any) => [`${v}${unit}`, '']} />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

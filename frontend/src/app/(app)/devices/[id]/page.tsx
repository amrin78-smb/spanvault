'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { StatusDot } from '@/components/StatusDot';
import SensorManager from '@/components/SensorManager';
import { StatusBadge, Loading, ErrorBox, Empty, fmtTime, fmtRel, fmtBps } from '@/components/ui';
import { GradeBadge, ScoreBar, TrendArrow, n as intelNum } from '@/components/intel';

type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null;
  last_seen_at: string | null; last_checked_at: string | null; snmp_enabled: boolean;
  poll_interval_seconds: number; ping_threshold_ms: number; device_vendor: string | null;
  is_gateway: boolean; alert_suppressed: boolean; suppressed_by_device_id: number | null;
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
  const { canEdit } = useRbac();
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
        {d.is_gateway && (
          <span className="sv-gw-badge" title={`Site gateway for ${d.site_name || 'this site'}`}>
            <span className="sv-gw-star">⭐</span> Site Gateway
          </span>
        )}
        <div style={{ flex: 1 }} />
        {snmpOn && canEdit && (
          <button className="sv-btn ghost sm" onClick={() => setSensorsOpen(true)}>Manage Sensors</button>
        )}
        {snmpOn && <TestSnmpButton deviceId={d.id} onResult={setToast} />}
        <PingNow deviceId={d.id} />
      </div>
      <p className="sv-page-sub">
        {d.ip_address} · {d.device_type || 'Unknown type'} · {d.site_name || 'Unassigned'}
        {vendorLabel(d.device_vendor) && <> · {vendorLabel(d.device_vendor)}</>}
      </p>

      <QuickStats deviceId={d.id} />
      <UptimeCalendar deviceId={d.id} />

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
          <LatencyChart
            data={ping.data || []}
            loading={ping.loading}
            alertTimes={(alerts.data || []).map((a) => a.triggered_at)}
          />
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
          {canEdit && <button className="sv-btn" onClick={() => setSensorsOpen(true)}>Manage Sensors</button>}
        </div>
      )}

      {snmpOn && <InterfacePanel deviceId={d.id} />}
      <ConnectedDevices deviceId={d.id} />

      <DeviceIntelligence deviceId={d.id} />

      <SiteGateway device={d} onChanged={() => device.reload()} />

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

// Snap an alert timestamp to the nearest chart bucket so a ReferenceLine lands
// on a real x value (the X axis is categorical over bucket strings).
function nearestBuckets(buckets: string[], alertTimes: string[]): string[] {
  if (!buckets.length || !alertTimes.length) return [];
  const bt = buckets.map((b) => ({ b, t: new Date(b).getTime() }));
  const first = bt[0].t, last = bt[bt.length - 1].t;
  const out = new Set<string>();
  for (const a of alertTimes) {
    const at = new Date(a).getTime();
    if (isNaN(at) || at < first || at > last) continue; // only annotate in-range
    let best = bt[0];
    for (const x of bt) if (Math.abs(x.t - at) < Math.abs(best.t - at)) best = x;
    out.add(best.b);
  }
  return Array.from(out);
}

function LatencyChart({ data, loading, alertTimes = [] }: { data: PingPoint[]; loading: boolean; alertTimes?: string[] }) {
  if (loading && !data.length) return <Loading />;
  if (!data.length) return <Empty message="No ping data for this range." />;
  const chartData = data.map((p) => ({
    bucket: p.bucket,
    ms: p.avg_ms != null ? Number(p.avg_ms) : null,
  }));
  const marks = nearestBuckets(chartData.map((p) => p.bucket), alertTimes);
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={10} minTickGap={40} />
        <YAxis fontSize={10} width={44} />
        <Tooltip labelFormatter={tickLabel} formatter={(v: any) => [`${v} ms`, 'Latency']} />
        {marks.map((b) => (
          <ReferenceLine key={b} x={b} stroke="#dc2626" strokeDasharray="3 2" strokeOpacity={0.6} />
        ))}
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

// ── Quick stats row (top-level component) ──────────────────────
type QuickStatsT = {
  uptime_30d_pct: number | null; avg_response_7d: number | null;
  baseline_response: number | null; alerts_30d: number;
  health_score: number | null; health_grade: string | null; health_trend: string | null;
};
function QuickStats({ deviceId }: { deviceId: number }) {
  const stats = useApi<QuickStatsT>(`/api/devices/${deviceId}/quick-stats`, 30000);
  const s = stats.data;
  const upPct = s && s.uptime_30d_pct != null ? Number(s.uptime_30d_pct) : null;
  const upVariant = upPct == null ? 'unknown' : upPct >= 99.5 ? 'up' : upPct >= 95 ? 'warning' : 'down';
  const avg = s && s.avg_response_7d != null ? Number(s.avg_response_7d) : null;
  const base = s && s.baseline_response != null ? Number(s.baseline_response) : null;
  return (
    <div className="sv-cards">
      <div className={`sv-card ${upVariant}`}>
        <div className="num">{upPct != null ? `${upPct}%` : '—'}</div>
        <div className="label">Uptime (30 days)</div>
      </div>
      <div className="sv-card">
        <div className="num">{avg != null ? `${avg}` : '—'}<span style={{ fontSize: 13 }}> ms</span></div>
        <div className="label">
          Avg Response (7d){base != null ? ` · baseline ${Math.round(base)}ms` : ''}
        </div>
      </div>
      <div className={`sv-card ${s && s.alerts_30d > 0 ? 'warning' : ''}`}>
        <div className="num">{s ? s.alerts_30d : '—'}</div>
        <div className="label">Alerts (30 days)</div>
      </div>
      <div className="sv-card">
        <div className="num" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s && s.health_score != null ? Math.round(s.health_score) : '—'}
          {s && s.health_grade && <GradeBadge grade={s.health_grade} />}
          {s && s.health_trend && <TrendArrow trend={s.health_trend} />}
        </div>
        <div className="label">Health Score</div>
      </div>
    </div>
  );
}

// ── 90-day availability calendar (top-level component) ─────────
type CalDay = { day: string; uptime_pct: number | null; total_checks: number; incidents: number };
function calColor(d: CalDay | undefined): string {
  if (!d || !d.total_checks) return 'var(--sv-unknown)';
  const pct = d.uptime_pct == null ? 100 : Number(d.uptime_pct);
  if (d.incidents > 0 || pct < 99) return 'var(--sv-down)';
  if (pct < 99.9) return 'var(--sv-warning)';
  return 'var(--sv-up)';
}
function UptimeCalendar({ deviceId }: { deviceId: number }) {
  const cal = useApi<CalDay[]>(`/api/devices/${deviceId}/uptime-calendar?days=90`, 0);
  const DAYS = 90;
  const byDay = new Map<string, CalDay>();
  for (const r of cal.data || []) byDay.set(r.day, r);
  // Build a contiguous 90-day window ending today; fill gaps as "no data".
  const cells: { key: string; label: string; d: CalDay | undefined }[] = [];
  const today = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const label = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    cells.push({ key, label, d: byDay.get(key) });
  }
  return (
    <div className="sv-panel" style={{ marginBottom: 18 }}>
      <h2 style={{ marginTop: 0 }}>90-day availability</h2>
      <div className="sv-uptime-cal">
        {cells.map((c) => {
          const tip = c.d && c.d.total_checks
            ? `${c.label} — ${c.d.uptime_pct ?? 100}% uptime, ${c.d.incidents} incident${c.d.incidents === 1 ? '' : 's'}`
            : `${c.label} — no data`;
          return <span key={c.key} className="sv-uptime-day" style={{ background: calColor(c.d) }} title={tip} />;
        })}
      </div>
    </div>
  );
}

// ── Interface status panel (top-level component) ───────────────
type IfRow = { if_index: number; if_name: string; status: string | null; in_bps: number | null; out_bps: number | null };
function InterfacePanel({ deviceId }: { deviceId: number }) {
  const ifs = useApi<IfRow[]>(`/api/devices/${deviceId}/interfaces`, 30000);
  if (ifs.loading && !ifs.data) return null;
  if (!ifs.data || !ifs.data.length) return null;
  return (
    <div className="sv-panel">
      <h2>Interface Status</h2>
      <div className="sv-if-list">
        {ifs.data.map((r) => (
          <div key={r.if_index} className="sv-if-row">
            <StatusDot status={r.status || 'unknown'} size={10} title={`Interface ${r.status || 'unknown'}`} />
            <span className="sv-if-name">{r.if_name}</span>
            <span className={`sv-if-state ${r.status || 'unknown'}`}>
              {r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : 'Unknown'}
            </span>
            <span className="sv-if-bps">
              {r.status === 'down' || (r.in_bps == null && r.out_bps == null)
                ? '—'
                : `${fmtBps(r.in_bps)} ↓ / ${fmtBps(r.out_bps)} ↑`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Connected devices from topology (top-level component) ──────
type ConnRow = { from_port: string | null; to_port: string | null; protocol: string | null; to_device_id: number | null; neighbor_name: string | null; neighbor_ip: string | null };
function ConnectedDevices({ deviceId }: { deviceId: number }) {
  const conn = useApi<ConnRow[]>(`/api/devices/${deviceId}/connected`, 0);
  if (conn.loading && !conn.data) return null;
  if (!conn.data || !conn.data.length) return null;
  return (
    <div className="sv-panel">
      <h2>Connected to</h2>
      <div className="sv-conn-list">
        {conn.data.map((c, i) => (
          <div key={i} className="sv-conn-row">
            <span className="sv-conn-port">{c.from_port || '—'}</span>
            <span className="sv-conn-arrow">→</span>
            <span className="sv-conn-nb">
              {c.to_device_id ? (
                <Link href={`/devices/${c.to_device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                  {c.neighbor_name || c.neighbor_ip || `#${c.to_device_id}`}
                </Link>
              ) : (
                <span style={{ fontWeight: 600 }}>{c.neighbor_name || c.neighbor_ip || 'Unknown neighbor'}</span>
              )}
              {c.to_port && <span className="sv-muted"> · {c.to_port}</span>}
              {c.protocol && <span className="sv-muted"> · {c.protocol.toUpperCase()}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Device intelligence card (top-level component) ─────────────
type DeviceIntel = {
  health: {
    score: number | string | null; grade: string | null; trend: string | null;
    uptime_score: number | string | null; response_score: number | string | null;
    anomaly_score: number | string | null; alert_score: number | string | null;
    uptime_pct: number | string | null; computed_at: string;
  } | null;
  baseline: {
    mean: number | string; stddev: number | string; p50: number | string;
    p95: number | string; p99: number | string; min_val: number | string;
    max_val: number | string; sample_count: number; computed_at: string;
  } | null;
  anomalies: {
    id: number; metric: string; value: number | string; baseline_mean: number | string | null;
    z_score: number | string; severity: string; detected_at: string;
  }[];
  patterns: {
    id: number; pattern_type: string; metric: string; description: string;
    confidence: number | string | null; occurrence_count: number; last_seen_at: string;
  }[];
  threshold: {
    metric: string; current_threshold: number | string | null;
    recommended_threshold: number | string; reasoning: string; confidence: number | string | null;
  } | null;
};

function DeviceIntelligence({ deviceId }: { deviceId: number }) {
  const intel = useApi<DeviceIntel>(`/api/intelligence/device/${deviceId}`, 30000);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  const d = intel.data;
  const health = d ? d.health : null;
  const baseline = d ? d.baseline : null;
  const anomalies = d ? d.anomalies : [];
  const patterns = d ? d.patterns : [];
  const threshold = d ? d.threshold : null;

  async function applyThreshold() {
    setApplying(true);
    try {
      const r = await apiSend<{ applied_threshold: number }>(
        `/api/intelligence/thresholds/${deviceId}/apply`, 'POST', {}
      );
      setApplied(r.applied_threshold);
      intel.reload();
    } catch {
      /* ignore — recommendation stays visible */
    } finally {
      setApplying(false);
    }
  }

  // Nothing computed yet → collecting state (don't render an empty card).
  const hasAnything = health || baseline || anomalies.length || patterns.length || threshold;

  return (
    <div className="sv-panel" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>⚡ Intelligence</h2>
        <div style={{ flex: 1 }} />
        <Link href={`/intelligence?device=${deviceId}#health`} className="sv-dash-link" style={{ fontSize: 13 }}>
          Full intelligence →
        </Link>
      </div>

      {intel.loading && !intel.data ? (
        <Loading label="Analyzing device data…" />
      ) : intel.error ? (
        <ErrorBox message={intel.error} />
      ) : !hasAnything ? (
        <p className="sv-muted" style={{ marginBottom: 0 }}>
          Collecting baseline data — intelligence appears once this device has a few hours of monitoring history.
          Baselines become reliable after ~7 days.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {/* Health */}
          {health && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span className="sv-muted" style={{ fontSize: 13, minWidth: 90 }}>Health score</span>
              <ScoreBar score={health.score} />
              <GradeBadge grade={health.grade} />
              <TrendArrow trend={health.trend} />
              {intelNum(health.uptime_pct) != null && (
                <span className="sv-muted" style={{ fontSize: 12.5 }}>
                  Uptime {Number(health.uptime_pct).toFixed(1)}%
                </span>
              )}
            </div>
          )}

          {/* Baseline */}
          {baseline && (
            <div style={{ fontSize: 13.5 }}>
              <span className="sv-muted" style={{ minWidth: 90, display: 'inline-block' }}>Latency baseline</span>
              Normal range: <strong>{Math.round(Number(baseline.min_val))}-{Math.round(Number(baseline.p95))}ms</strong>
              {' '}(p95: {Math.round(Number(baseline.p95))}ms · p99: {Math.round(Number(baseline.p99))}ms · mean {Math.round(Number(baseline.mean))}ms)
              <span className="sv-muted" style={{ fontSize: 12 }}> · {baseline.sample_count} samples</span>
            </div>
          )}

          {/* Active anomalies */}
          {anomalies.length > 0 && (
            <div>
              <div className="sv-muted" style={{ fontSize: 13, marginBottom: 4 }}>Active anomalies</div>
              {anomalies.map((a) => {
                const z = intelNum(a.z_score) ?? 0;
                const val = intelNum(a.value);
                const base = intelNum(a.baseline_mean);
                const dir = val != null && base != null ? (val >= base ? 'above' : 'below') : '';
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0' }}>
                    <span style={{ color: a.severity === 'critical' ? 'var(--sv-down)' : 'var(--sv-warning)' }}>●</span>
                    <span>{a.metric}</span>
                    <span className={`sv-badge ${a.severity === 'critical' ? 'down' : 'warning'}`}>{z.toFixed(1)}σ {dir} normal</span>
                    <span className="sv-muted" style={{ fontSize: 12 }}>{fmtRel(a.detected_at)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Recurring patterns */}
          {patterns.length > 0 && (
            <div>
              <div className="sv-muted" style={{ fontSize: 13, marginBottom: 4 }}>Recurring patterns</div>
              {patterns.map((p) => (
                <div key={p.id} style={{ fontSize: 13, padding: '2px 0' }}>
                  ⚠ Recurring: {p.description}
                  <span className="sv-muted" style={{ fontSize: 12 }}> · seen {p.occurrence_count}×</span>
                </div>
              ))}
            </div>
          )}

          {/* Threshold recommendation */}
          {threshold && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', background: 'var(--bg-primary)', borderRadius: 8 }}>
              <span style={{ fontSize: 13.5 }} title={threshold.reasoning}>
                Recommended threshold: <strong style={{ color: 'var(--primary)' }}>{Math.round(Number(threshold.recommended_threshold))}ms</strong>
                {' '}(current: {intelNum(threshold.current_threshold) ?? '—'}ms)
              </span>
              <div style={{ flex: 1 }} />
              <button className="sv-btn sm" onClick={applyThreshold} disabled={applying}>
                {applying ? <span className="sv-spinner-sm" /> : 'Apply'}
              </button>
            </div>
          )}

          {applied != null && !threshold && (
            <div style={{ fontSize: 13, color: 'var(--sv-up)' }}>✓ Threshold updated to {applied}ms</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Site gateway (top-level component) ─────────────────────────
type SiteDevice = {
  id: number; name: string; current_status: string;
  is_gateway: boolean; site_id: number | null;
};

function SiteGateway({ device, onChanged }: { device: Device; onChanged: () => void }) {
  const { canEdit } = useRbac();
  // Sibling devices at the same site — used to find the current gateway.
  const siteDevices = useApi<SiteDevice[]>(
    device.site_id != null ? `/api/devices?site_id=${device.site_id}` : '/api/devices', 0
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const siteLabel = device.site_name || 'this site';
  const gateway = (siteDevices.data || []).find((d) => d.is_gateway) || null;
  const otherGateway = gateway && gateway.id !== device.id ? gateway : null;

  async function act(action: 'set-gateway' | 'clear-gateway') {
    setBusy(true);
    setErr(null);
    try {
      await apiSend(`/api/devices/${device.id}/${action}`, 'POST', {});
      siteDevices.reload();
      onChanged();
    } catch (e: any) {
      setErr(e?.message || 'Failed to update gateway');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sv-panel sv-gw-panel" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Site Gateway</h2>
        <div style={{ flex: 1 }} />
        {canEdit && device.is_gateway ? (
          <button className="sv-btn ghost sm" onClick={() => act('clear-gateway')} disabled={busy}>
            Remove gateway status
          </button>
        ) : canEdit && device.site_id != null ? (
          <button className="sv-btn ghost sm" onClick={() => act('set-gateway')} disabled={busy}>
            Set as Site Gateway
          </button>
        ) : null}
      </div>

      {err && <div style={{ marginTop: 10 }}><ErrorBox message={err} /></div>}

      {device.is_gateway ? (
        <p className="sv-gw-note">
          This device is the gateway for <strong>{siteLabel}</strong>. If it goes down, alerts
          for all other devices in {siteLabel} will be suppressed.
        </p>
      ) : device.site_id == null ? (
        <p className="sv-gw-note">
          Assign this device to a site to make it a gateway.
        </p>
      ) : (
        <>
          {device.alert_suppressed && (
            <div className="sv-gw-warn" style={{ marginTop: 12 }}>
              ⚠ Alerts suppressed — site gateway {otherGateway ? otherGateway.name : ''} is down
            </div>
          )}
          <p className="sv-gw-note">
            Set this device as the gateway for <strong>{siteLabel}</strong> so its outage
            suppresses alerts for the rest of the site.
          </p>
          {otherGateway && (
            <p className="sv-gw-current">
              Current gateway:{' '}
              <Link href={`/devices/${otherGateway.id}`}>{otherGateway.name}</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}

'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ReferenceArea, ResponsiveContainer,
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
  is_custom?: boolean; custom_label?: string | null; custom_unit?: string | null;
};
type TestResult = {
  success: boolean; vendor?: string; sysDescr?: string; sysName?: string; message: string;
};

// Map a detected vendor key (from the collector's SNMP parser) to a label.
const VENDOR_LABELS: Record<string, string> = {
  fortinet: 'Fortinet', cisco: 'Cisco', aruba: 'Aruba', paloalto: 'Palo Alto',
  checkpoint: 'Check Point', sonicwall: 'SonicWall', forcepoint: 'Forcepoint',
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
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
];

const CAT_COLOR: Record<string, string> = {
  system: '#2563eb', interface: '#C8102E', vendor: '#2e9e5b',
};

// ── Shared layout style constants (inline — globals.css is not editable here) ──
const SECTION_CARD: CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '16px 20px', marginBottom: 16,
};
const SECTION_HEADING: CSSProperties = {
  fontSize: 'var(--text-sm)', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)',
  letterSpacing: '0.06em', margin: '0 0 8px',
};
const GRAPH_CARD: CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '12px 16px',
  height: 220, display: 'flex', flexDirection: 'column',
};
const GRAPH_HEADER: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 8, marginBottom: 6, minHeight: 22,
};
const GRAPH_TITLE: CSSProperties = {
  fontSize: 'var(--text-sm)', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)',
  letterSpacing: '0.06em', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const GRAPH_BODY: CSSProperties = { flex: 1, minHeight: 0 };
const GRAPH_GRID: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16,
};
const TAB_BTN_BASE: CSSProperties = {
  fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1.4,
};
const TAB_BTN_ACTIVE: CSSProperties = {
  ...TAB_BTN_BASE, background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff',
};

const GRAPH_HEIGHT = 160;

// Alert History is paginated client-side to keep the table readable.
const ALERTS_PER_PAGE = 50;
const ALERT_PAGER: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, marginTop: 12, flexWrap: 'wrap',
};
const PAGER_BTN: CSSProperties = {
  fontSize: 'var(--text-base)', padding: '4px 12px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', cursor: 'pointer', lineHeight: 1.4,
};
const PAGER_BTN_DISABLED: CSSProperties = {
  ...PAGER_BTN, color: 'var(--text-muted)', cursor: 'not-allowed', opacity: 0.5,
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
  const [alertPage, setAlertPage] = useState(0);

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
  // Custom OID sensors get their own graph section (custom_label / custom_unit).
  const customSensors = enabledSensors.filter((s) => s.is_custom);
  const standardSensors = enabledSensors.filter((s) => !s.is_custom);
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

      {/* Compact header: name + status + badges inline, actions right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2, flexWrap: 'wrap' }}>
        <StatusDot
          status={d.current_status}
          size={14}
          title={`${(d.current_status || 'unknown').replace(/^\w/, (c) => c.toUpperCase())} — last seen ${fmtRel(d.last_seen_at)}${d.last_response_ms != null ? `, ${Number(d.last_response_ms).toFixed(0)}ms` : ''}`}
        />
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 700, letterSpacing: '-0.3px' }}>{d.name}</h1>
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
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', margin: '0 0 14px' }}>
        {d.ip_address} · {d.device_type || 'Unknown type'} · {d.site_name || 'Unassigned'}
        {vendorLabel(d.device_vendor) && <> · {vendorLabel(d.device_vendor)}</>}
        {d.is_gateway && <> · ⭐ Gateway</>}
        <span style={{ marginLeft: 8 }}>
          · Last latency {d.last_response_ms != null ? `${Number(d.last_response_ms).toFixed(0)}ms` : '—'}
          {' '}· Seen {fmtRel(d.last_seen_at)} · Checked {fmtRel(d.last_checked_at)} · Poll {d.poll_interval_seconds}s
        </span>
      </p>

      {/* Quick stats: 4 compact cards */}
      <QuickStats deviceId={d.id} />

      {/* 90-day availability calendar */}
      <UptimeCalendar deviceId={d.id} />

      {/* Graphs — 2-column grid; Row 1: Ping Latency | Packet Loss */}
      <div style={GRAPH_GRID}>
        <GraphCard title="Ping Latency (ms)" range={range} setRange={setRange}>
          <LatencyChart
            data={ping.data || []}
            loading={ping.loading}
            alertTimes={(alerts.data || []).map((a) => a.triggered_at)}
          />
        </GraphCard>
        <GraphCard title="Packet Loss (%)" range={range} setRange={setRange}>
          <SingleChart
            data={(ping.data || []).map((p) => ({ bucket: p.bucket, value: p.max_loss }))}
            loading={ping.loading} color="#C8102E" unit="%"
          />
        </GraphCard>
        {/* Row 2+: CPU / Memory / interface graphs (2 per row) */}
        {snmpOn && !sensorsLoading && standardSensors.length > 0 && (
          <SensorGraphs deviceId={d.id} sensors={standardSensors} range={range} setRange={setRange} />
        )}
      </div>

      {snmpOn && !sensorsLoading && customSensors.length > 0 && (
        <>
          <div style={SECTION_HEADING}>Custom Sensors</div>
          <div style={GRAPH_GRID}>
            {customSensors.map((s) => (
              <CustomSensorChart key={s.id} deviceId={d.id} sensor={s} range={range} setRange={setRange} />
            ))}
          </div>
        </>
      )}

      {snmpOn && sensorsLoading && <div style={SECTION_CARD}><Loading /></div>}
      {snmpOn && !sensorsLoading && enabledSensors.length === 0 && (
        <div style={{ ...SECTION_CARD, textAlign: 'center', padding: '24px 20px' }}>
          <p className="sv-muted" style={{ marginTop: 0 }}>
            No sensors configured. Run Discovery to choose what to monitor on this device.
          </p>
          {canEdit && <button className="sv-btn" onClick={() => setSensorsOpen(true)}>Manage Sensors</button>}
        </div>
      )}

      {/* Compact 2×2 summary grid (collapses to 1 column on narrow screens). */}
      <div className="sv-device-summary-grid">
        {snmpOn && <InterfacePanel deviceId={d.id} />}
        <ConnectedDevices deviceId={d.id} />
        <DeviceIntelligence deviceId={d.id} />
        <SiteGateway device={d} onChanged={() => device.reload()} />
      </div>

      <div style={SECTION_CARD}>
        <div style={SECTION_HEADING}>Alert History</div>
        {alerts.loading && !alerts.data ? (
          <Loading />
        ) : alerts.data && alerts.data.length ? (
          (() => {
            const total = alerts.data.length;
            const pageCount = Math.ceil(total / ALERTS_PER_PAGE);
            const page = Math.min(alertPage, pageCount - 1);
            const start = page * ALERTS_PER_PAGE;
            const pageRows = alerts.data.slice(start, start + ALERTS_PER_PAGE);
            return (
              <>
                <table className="sv-table">
                  <thead>
                    <tr><th>Severity</th><th>Type</th><th>Message</th><th>Triggered</th><th>Resolved</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {pageRows.map((a) => (
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
                {pageCount > 1 && (
                  <div style={ALERT_PAGER}>
                    <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
                      {start + 1}–{Math.min(start + ALERTS_PER_PAGE, total)} of {total}
                    </span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        type="button"
                        style={page <= 0 ? PAGER_BTN_DISABLED : PAGER_BTN}
                        disabled={page <= 0}
                        onClick={() => setAlertPage((p) => Math.max(0, p - 1))}
                      >
                        ← Prev
                      </button>
                      <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
                        Page {page + 1} of {pageCount}
                      </span>
                      <button
                        type="button"
                        style={page >= pageCount - 1 ? PAGER_BTN_DISABLED : PAGER_BTN}
                        disabled={page >= pageCount - 1}
                        onClick={() => setAlertPage((p) => Math.min(pageCount - 1, p + 1))}
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                )}
              </>
            );
          })()
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
      {err && <span style={{ color: 'var(--sv-down)', fontSize: 'var(--text-base)' }}>{err}</span>}
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
  | { kind: 'pair'; ifIndex: number; ifLabel: string; inSensor: Sensor; outSensor: Sensor; operSensor?: Sensor };

// Parse an interface-traffic metric_name like "if_3_in_bps" → { idx: 3, dir }.
function parseIfBps(metric: string): { idx: number; dir: 'in' | 'out' } | null {
  const m = /^if_(\d+)_(in|out)_bps$/.exec(metric);
  if (!m) return null;
  return { idx: Number(m[1]), dir: m[2] as 'in' | 'out' };
}

// Parse an interface status metric_name like "if_3_oper" → 3.
function parseIfOper(metric: string): number | null {
  const m = /^if_(\d+)_oper$/.exec(metric);
  return m ? Number(m[1]) : null;
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
  const operByIdx = new Map<number, Sensor>();
  for (const s of sensors) {
    const p = parseIfBps(s.metric_name);
    if (p?.dir === 'in') inByIdx.set(p.idx, s);
    else if (p?.dir === 'out') outByIdx.set(p.idx, s);
    const op = parseIfOper(s.metric_name);
    if (op != null) operByIdx.set(op, s);
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
        // Fold the interface's status (_oper) sensor into the traffic chart as an
        // overlay rather than a separate chart. If status is monitored WITHOUT
        // traffic, it stays its own chart (not consumed here).
        const operS = operByIdx.get(p.idx);
        items.push({
          kind: 'pair', ifIndex: p.idx, ifLabel: ifLabelFor(p.idx, inS, outS),
          inSensor: inS, outSensor: outS, operSensor: operS,
        });
        consumed.add(inS.id); consumed.add(outS.id);
        if (operS) consumed.add(operS.id);
        continue;
      }
    }
    items.push({ kind: 'single', sensor: s });
  }
  return items;
}

// ── Sensor graphs in a compact responsive grid (top-level component) ─
function SensorGraphs({
  deviceId, sensors, range, setRange,
}: {
  deviceId: number; sensors: Sensor[]; range: string; setRange: (r: string) => void;
}) {
  const items = buildGraphItems(sensors);
  // Returns cells only (no grid wrapper) so they join the page-level
  // 2-column graph grid alongside the Ping Latency / Packet Loss cards.
  return (
    <>
      {items.map((it) =>
        it.kind === 'pair' ? (
          <InterfaceTrafficChart
            key={`pair-${it.ifIndex}`}
            deviceId={deviceId} ifLabel={it.ifLabel}
            inSensor={it.inSensor} outSensor={it.outSensor} operSensor={it.operSensor} range={range} setRange={setRange}
          />
        ) : (
          <SensorChart key={it.sensor.id} deviceId={deviceId} sensor={it.sensor} range={range} setRange={setRange} />
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

// Combined In/Out traffic chart for one interface (two lines: blue In, orange
// Out). When the interface's status sensor is enabled too, its down periods are
// shaded red over the traffic graph and an Up/Down badge is shown in the header —
// so one chart conveys both throughput and link state.
function InterfaceTrafficChart({
  deviceId, ifLabel, inSensor, outSensor, operSensor, range, setRange,
}: {
  deviceId: number; ifLabel: string; inSensor: Sensor; outSensor: Sensor; operSensor?: Sensor; range: string; setRange: (r: string) => void;
}) {
  const inHist = useApi<SnmpPoint[]>(
    `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(inSensor.metric_name)}&range=${range}`, 0
  );
  const outHist = useApi<SnmpPoint[]>(
    `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(outSensor.metric_name)}&range=${range}`, 0
  );
  const operHist = useApi<SnmpPoint[]>(
    operSensor ? `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(operSensor.metric_name)}&range=${range}` : null, 0
  );

  // Merge series on the shared (date_bin-aligned) bucket timestamp.
  const byBucket = new Map<string, { bucket: string; in: number | null; out: number | null; oper: number | null }>();
  const ensure = (b: string) => { let e = byBucket.get(b); if (!e) { e = { bucket: b, in: null, out: null, oper: null }; byBucket.set(b, e); } return e; };
  for (const p of inHist.data || []) ensure(p.bucket).in = p.avg_value != null ? Number(p.avg_value) : null;
  for (const p of outHist.data || []) ensure(p.bucket).out = p.avg_value != null ? Number(p.avg_value) : null;
  for (const p of operHist.data || []) ensure(p.bucket).oper = p.avg_value != null ? Number(p.avg_value) : null;
  const data = Array.from(byBucket.values()).sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  const loading = (inHist.loading && !inHist.data) || (outHist.loading && !outHist.data);

  // Contiguous runs where the link was down (bucket mostly down → oper < 0.5).
  const downRuns: { x1: string; x2: string }[] = [];
  if (operSensor) {
    for (let i = 0; i < data.length; i++) {
      if (data[i].oper != null && (data[i].oper as number) < 0.5) {
        const start = i;
        while (i + 1 < data.length && data[i + 1].oper != null && (data[i + 1].oper as number) < 0.5) i++;
        // Extend a single-bucket outage to the next bucket so it's visible.
        const endIdx = i > start ? i : Math.min(i + 1, data.length - 1);
        downRuns.push({ x1: data[start].bucket, x2: data[endIdx].bucket });
      }
    }
  }
  // Current/last known link state for the header badge.
  let lastOper: number | null = null;
  for (let i = data.length - 1; i >= 0; i--) { if (data[i].oper != null) { lastOper = data[i].oper as number; break; } }
  const badge = operSensor && lastOper != null ? (
    <span className={`sv-badge ${lastOper >= 0.5 ? 'up' : 'down'}`} style={{ fontSize: 'var(--text-xs)' }}>
      {lastOper >= 0.5 ? 'Up' : 'Down'}
    </span>
  ) : undefined;

  // Pick ONE unit for the whole axis from the data's peak, so ticks are short
  // numbers (0, 40, 80, 120, 160) with the unit shown once in the title — instead
  // of repeating/clipping "Mbps" on every tick. The tooltip still shows the exact
  // per-point value with its unit.
  const maxV = data.reduce((m, d) => Math.max(m, d.in ?? 0, d.out ?? 0), 0);
  let bpsDiv = 1; let bpsUnit = 'bps';
  if (maxV >= 1e9) { bpsDiv = 1e9; bpsUnit = 'Gbps'; }
  else if (maxV >= 1e6) { bpsDiv = 1e6; bpsUnit = 'Mbps'; }
  else if (maxV >= 1e3) { bpsDiv = 1e3; bpsUnit = 'Kbps'; }
  const axisTick = (v: any) => String(Math.round((Number(v) / bpsDiv) * 10) / 10);
  const chartTitle = `${ifLabel} · ${bpsUnit}`;

  return (
    <GraphCard title={chartTitle} titleAttr={chartTitle} range={range} setRange={setRange} badge={badge}>
      {loading ? (
        <Loading />
      ) : !data.length ? (
        <Empty message="No data yet for this interface." />
      ) : (
        <ResponsiveContainer width="100%" height={GRAPH_HEIGHT}>
          <LineChart data={data} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            {downRuns.map((r, i) => (
              <ReferenceArea key={i} x1={r.x1} x2={r.x2} fill="#ef4444" fillOpacity={0.12} ifOverflow="extendDomain" />
            ))}
            <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
            <YAxis fontSize={11} width={40} tickFormatter={axisTick} />
            <Tooltip
              labelFormatter={tickLabel}
              formatter={(v: any, name: any) => [v == null ? '—' : fmtBps(Number(v)), name]}
            />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
            <Line type="monotone" name="In" dataKey="in" stroke={TRAFFIC_IN_COLOR} strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" name="Out" dataKey="out" stroke={TRAFFIC_OUT_COLOR} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
    </GraphCard>
  );
}

function SensorChart({ deviceId, sensor, range, setRange }: { deviceId: number; sensor: Sensor; range: string; setRange: (r: string) => void }) {
  const hist = useApi<SnmpPoint[]>(
    `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(sensor.metric_name)}&range=${range}`,
    0
  );
  const unit = metricUnit(sensor.metric_name);
  const color = CAT_COLOR[sensor.category] || '#2563eb';
  const data = (hist.data || []).map((p) => ({ bucket: p.bucket, value: p.avg_value != null ? Number(p.avg_value) : null }));
  // For bps metrics, pick one axis unit from the peak → short numeric ticks + the
  // unit shown once in the title (rather than repeated/clipped on every tick).
  const maxV = unit === 'bps' ? data.reduce((m, d) => Math.max(m, d.value ?? 0), 0) : 0;
  let bpsDiv = 1; let bpsUnit = 'bps';
  if (unit === 'bps') {
    if (maxV >= 1e9) { bpsDiv = 1e9; bpsUnit = 'Gbps'; }
    else if (maxV >= 1e6) { bpsDiv = 1e6; bpsUnit = 'Mbps'; }
    else if (maxV >= 1e3) { bpsDiv = 1e3; bpsUnit = 'Kbps'; }
  }
  const suffix = unit === 'count' || unit === 'state' ? '' : unit === 'bps' ? ` · ${bpsUnit}` : ` (${unit})`;
  const title = `${sensor.sensor_name}${suffix}`;

  const fmtVal = (v: number) => {
    if (unit === 'bps') return fmtBps(v);
    if (unit === '%') return `${v}%`;
    if (unit === 'state') return v >= 0.5 ? 'Up' : 'Down';
    if (unit === '°C') return `${v} °C`;
    if (unit === 'W') return `${v} W`;
    return `${v}`;
  };

  return (
    <GraphCard title={title} titleAttr={title} range={range} setRange={setRange}>
      {hist.loading && !hist.data ? (
        <Loading />
      ) : !data.length ? (
        <Empty message="No data yet for this sensor." />
      ) : (
        <ResponsiveContainer width="100%" height={GRAPH_HEIGHT}>
          <LineChart data={data} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
            <YAxis
              fontSize={11}
              width={unit === 'bps' ? 40 : 44}
              domain={unit === 'state' ? [0, 1] : undefined}
              tickFormatter={unit === 'bps' ? (v) => String(Math.round((Number(v) / bpsDiv) * 10) / 10) : undefined}
            />
            <Tooltip labelFormatter={tickLabel} formatter={(v: any) => [fmtVal(Number(v)), sensor.sensor_name]} />
            <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
    </GraphCard>
  );
}

// Custom OID sensor chart: titled by custom_label with custom_unit on the
// Y-axis. Values are raw numbers (no metric_name-based unit inference).
function CustomSensorChart({ deviceId, sensor, range, setRange }: { deviceId: number; sensor: Sensor; range: string; setRange: (r: string) => void }) {
  const hist = useApi<SnmpPoint[]>(
    `/api/devices/${deviceId}/snmp-history?metric=${encodeURIComponent(sensor.metric_name)}&range=${range}`,
    0
  );
  const label = sensor.custom_label || sensor.sensor_name;
  const unit = (sensor.custom_unit || '').trim();
  const data = (hist.data || []).map((p) => ({ bucket: p.bucket, value: p.avg_value != null ? Number(p.avg_value) : null }));
  const suffix = unit ? ` (${unit})` : '';
  const title = `${label}${suffix}`;

  return (
    <GraphCard title={title} titleAttr={title} range={range} setRange={setRange}>
      {hist.loading && !hist.data ? (
        <Loading />
      ) : !data.length ? (
        <Empty message="No data yet for this sensor." />
      ) : (
        <ResponsiveContainer width="100%" height={GRAPH_HEIGHT}>
          <LineChart data={data} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
            <YAxis
              fontSize={11}
              width={48}
              label={unit ? { value: unit, angle: -90, position: 'insideLeft', fontSize: 'var(--text-xs)' } : undefined}
            />
            <Tooltip
              labelFormatter={tickLabel}
              formatter={(v: any) => [`${Number(v)}${unit ? ` ${unit}` : ''}`, label]}
            />
            <Line type="monotone" dataKey="value" stroke="#7c3aed" strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
    </GraphCard>
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
    <ResponsiveContainer width="100%" height={GRAPH_HEIGHT}>
      <LineChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
        <YAxis fontSize={11} width={44} />
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
    <ResponsiveContainer width="100%" height={GRAPH_HEIGHT}>
      <LineChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
        <YAxis fontSize={11} width={44} />
        <Tooltip labelFormatter={tickLabel} formatter={(v: any) => [`${v}${unit}`, '']} />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Compact time-range tabs (top-level component) ──────────────
function RangeTabs({ range, setRange }: { range: string; setRange: (r: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => setRange(r.key)}
          style={range === r.key ? TAB_BTN_ACTIVE : TAB_BTN_BASE}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ── Graph card shell: 220px card with header (title + optional tabs) ──
function GraphCard({
  title, range, setRange, children, titleAttr, badge,
}: {
  title: string; range?: string; setRange?: (r: string) => void;
  children: ReactNode; titleAttr?: string; badge?: ReactNode;
}) {
  return (
    <div style={GRAPH_CARD}>
      <div style={GRAPH_HEADER}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <h3 style={GRAPH_TITLE} title={titleAttr || title}>{title}</h3>
          {badge}
        </span>
        {range != null && setRange && <RangeTabs range={range} setRange={setRange} />}
      </div>
      <div style={GRAPH_BODY}>{children}</div>
    </div>
  );
}

// ── Quick stats row (top-level component) ──────────────────────
type QuickStatsT = {
  uptime_30d_pct: number | null; avg_response_7d: number | null;
  baseline_response: number | null; alerts_30d: number;
  health_score: number | null; health_grade: string | null; health_trend: string | null;
};
const STAT_COLORS: Record<string, string> = {
  up: 'var(--green)', warning: 'var(--yellow)', down: 'var(--red)', unknown: 'var(--text-muted)',
};
const STAT_GRID: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16,
};
function statCardStyle(variant?: string): CSSProperties {
  return {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderLeft: `3px solid ${variant ? STAT_COLORS[variant] || 'var(--border)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)', padding: '12px 16px', minHeight: 75,
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
  };
}
const STAT_VALUE: CSSProperties = { fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.5px' };
const STAT_LABEL: CSSProperties = {
  fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.04em', marginTop: 6,
};
function QuickStats({ deviceId }: { deviceId: number }) {
  const stats = useApi<QuickStatsT>(`/api/devices/${deviceId}/quick-stats`, 30000);
  const s = stats.data;
  const upPct = s && s.uptime_30d_pct != null ? Number(s.uptime_30d_pct) : null;
  const upVariant = upPct == null ? 'unknown' : upPct >= 99.5 ? 'up' : upPct >= 95 ? 'warning' : 'down';
  const avg = s && s.avg_response_7d != null ? Number(s.avg_response_7d) : null;
  const base = s && s.baseline_response != null ? Number(s.baseline_response) : null;
  return (
    <div style={STAT_GRID}>
      <div style={statCardStyle(upVariant)}>
        <div style={STAT_VALUE}>{upPct != null ? `${upPct}%` : '—'}</div>
        <div style={STAT_LABEL}>Uptime (30 days)</div>
      </div>
      <div style={statCardStyle()}>
        <div style={STAT_VALUE}>{avg != null ? `${avg}` : '—'}<span style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}> ms</span></div>
        <div style={STAT_LABEL}>
          Avg Response (7d){base != null ? ` · baseline ${Math.round(base)}ms` : ''}
        </div>
      </div>
      <div style={statCardStyle(s && s.alerts_30d > 0 ? 'warning' : undefined)}>
        <div style={STAT_VALUE}>{s ? s.alerts_30d : '—'}</div>
        <div style={STAT_LABEL}>Alerts (30 days)</div>
      </div>
      <div style={statCardStyle()}>
        <div style={{ ...STAT_VALUE, display: 'flex', alignItems: 'center', gap: 8 }}>
          {s && s.health_score != null ? Math.round(s.health_score) : '—'}
          {s && s.health_grade && <GradeBadge grade={s.health_grade} />}
          {s && s.health_trend && <TrendArrow trend={s.health_trend} />}
        </div>
        <div style={STAT_LABEL}>Health Score</div>
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
// Format a 'YYYY-MM-DD' day string for display (parsed as a plain calendar date).
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function UptimeCalendar({ deviceId }: { deviceId: number }) {
  const cal = useApi<CalDay[]>(`/api/devices/${deviceId}/uptime-calendar?days=90`, 0);
  // The API returns a complete, ordered day series (gaps already filled), so we
  // render it directly — no client-side date keying / timezone matching.
  const days = cal.data || [];
  if (!days.length) return null;
  return (
    <div style={{ ...SECTION_CARD, padding: '12px 16px' }}>
      <div style={SECTION_HEADING}>90-day availability</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, maxHeight: 56, overflow: 'hidden' }}>
        {days.map((c) => {
          const tip = c.total_checks
            ? `${dayLabel(c.day)} — ${c.uptime_pct ?? 100}% uptime, ${c.incidents} incident${c.incidents === 1 ? '' : 's'}`
            : `${dayLabel(c.day)} — no data`;
          return (
            <span
              key={c.day}
              title={tip}
              style={{ width: 10, height: 10, borderRadius: 2, background: calColor(c), flex: 'none', cursor: 'default' }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Interface status panel (top-level components) ──────────────
type IfRow = { if_index: number; if_name: string; status: string | null; in_bps: number | null; out_bps: number | null };

// Compact grid cell — used in the expanded "show all" view.
const COMPACT_TOGGLE: CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer',
  fontSize: 'var(--text-sm)', fontWeight: 600, padding: '4px 0',
};
function IfGridCell({ r }: { r: IfRow }) {
  const bps =
    r.status === 'down' || (r.in_bps == null && r.out_bps == null)
      ? '—'
      : `${fmtBps(r.in_bps)} / ${fmtBps(r.out_bps)}`;
  return (
    <div
      title={`${r.if_name} — ${r.status || 'unknown'}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 28, padding: '0 8px',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-primary)', fontSize: 'var(--text-sm)', minWidth: 0,
      }}
    >
      <StatusDot status={r.status || 'unknown'} size={9} title={`Interface ${r.status || 'unknown'}`} />
      <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.if_name}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--text-xs)' }}>{bps}</span>
    </div>
  );
}

function InterfacePanel({ deviceId }: { deviceId: number }) {
  const ifs = useApi<IfRow[]>(`/api/devices/${deviceId}/interfaces`, 30000);
  const storageKey = `sv-iface-expanded-${deviceId}`;
  const [expanded, setExpanded] = useState(false);

  // Sync from localStorage after mount to avoid hydration mismatch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(storageKey) === '1') setExpanded(true);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  function toggle(next: boolean) {
    setExpanded(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* ignore */
      }
    }
  }

  if (ifs.loading && !ifs.data) return null;
  if (!ifs.data || !ifs.data.length) return null;

  const rows = ifs.data;
  const total = rows.length;
  const upCount = rows.filter((r) => r.status === 'up').length;
  const downCount = rows.filter((r) => r.status === 'down').length;
  const unknownCount = total - upCount - downCount;

  return (
    <div style={SECTION_CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ ...SECTION_HEADING, margin: 0 }}>Interface Status</div>
        <button type="button" style={COMPACT_TOGGLE} onClick={() => toggle(!expanded)}>
          {expanded ? 'Show summary' : `Show all ${total} interfaces`}
        </button>
      </div>

      {expanded ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {rows.map((r) => (
            <IfGridCell key={r.if_index} r={r} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 'var(--text-base)' }}>
          {upCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              <StatusDot status="up" size={10} title="Up" /> {upCount} Up
            </span>
          )}
          {downCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              <StatusDot status="down" size={10} title="Down" /> {downCount} Down
            </span>
          )}
          {unknownCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
              <StatusDot status="unknown" size={10} title="Unknown" /> {unknownCount} Unknown
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Connected devices from topology (top-level component) ──────
type ConnRow = { from_port: string | null; to_port: string | null; protocol: string | null; to_device_id: number | null; neighbor_name: string | null; neighbor_ip: string | null };
function ConnectedDevices({ deviceId }: { deviceId: number }) {
  const conn = useApi<ConnRow[]>(`/api/devices/${deviceId}/connected`, 0);
  const storageKey = `sv-topology-expanded-${deviceId}`;
  const [expanded, setExpanded] = useState(false);

  // Sync from localStorage after mount to avoid hydration mismatch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(storageKey) === '1') setExpanded(true);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  function toggle(next: boolean) {
    setExpanded(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* ignore */
      }
    }
  }

  if (conn.loading && !conn.data) return null;
  if (!conn.data || !conn.data.length) return null;

  const rows = conn.data;
  const total = rows.length;

  return (
    <div style={SECTION_CARD}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ ...SECTION_HEADING, margin: 0 }}>Connected To</div>
        <button type="button" style={COMPACT_TOGGLE} onClick={() => toggle(!expanded)}>
          {expanded ? 'Show summary' : `Show all ${total} connections`}
        </button>
      </div>

      {expanded ? (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 320, overflowY: 'auto' }}>
          {rows.map((c, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, height: 32,
                borderBottom: '1px solid var(--border)', fontSize: 'var(--text-base)', padding: '0 2px',
              }}
            >
              <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{c.from_port || '—'}</span>
              <span style={{ color: 'var(--text-muted)' }}>→</span>
              <span>
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
      ) : (
        <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>
          Connected to {total} neighbor{total === 1 ? '' : 's'}
        </div>
      )}
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
    <div style={SECTION_CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ ...SECTION_HEADING, margin: 0 }}>⚡ Intelligence</div>
        <div style={{ flex: 1 }} />
        <Link href={`/intelligence?device=${deviceId}#health`} className="sv-dash-link" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
          View full intelligence →
        </Link>
      </div>

      {intel.loading && !intel.data ? (
        <Loading label="Analyzing device data…" />
      ) : intel.error ? (
        <ErrorBox message={intel.error} />
      ) : !hasAnything ? (
        <p className="sv-muted" style={{ margin: 0 }}>
          Collecting baseline data — intelligence appears once this device has a few hours of monitoring history.
          Baselines become reliable after ~7 days.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          {/* Left: health score + grade + trend, baseline line */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            {health ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="sv-muted" style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Health</span>
                <ScoreBar score={health.score} />
                <GradeBadge grade={health.grade} />
                <TrendArrow trend={health.trend} />
                {intelNum(health.uptime_pct) != null && (
                  <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>Uptime {Number(health.uptime_pct).toFixed(1)}%</span>
                )}
              </div>
            ) : (
              <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>Health score not computed yet.</span>
            )}
            {baseline && (
              <div style={{ fontSize: 'var(--text-sm)' }} title={`p99 ${Math.round(Number(baseline.p99))}ms · ${baseline.sample_count} samples`}>
                Normal: <strong>{Math.round(Number(baseline.mean))}ms</strong>
                {' '}(p95: {Math.round(Number(baseline.p95))}ms)
              </div>
            )}
          </div>

          {/* Right: anomaly count, pattern count, threshold recommendation (one line) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 16, fontSize: 'var(--text-sm)', flexWrap: 'wrap' }}>
              <span>
                <strong style={{ color: anomalies.length ? 'var(--sv-down)' : 'var(--text-primary)' }}>{anomalies.length}</strong>
                <span className="sv-muted"> active {anomalies.length === 1 ? 'anomaly' : 'anomalies'}</span>
              </span>
              <span>
                <strong style={{ color: patterns.length ? 'var(--sv-warning)' : 'var(--text-primary)' }}>{patterns.length}</strong>
                <span className="sv-muted"> active {patterns.length === 1 ? 'pattern' : 'patterns'}</span>
              </span>
            </div>
            {threshold ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
                <span title={threshold.reasoning}>
                  Recommend threshold <strong style={{ color: 'var(--primary)' }}>{Math.round(Number(threshold.recommended_threshold))}ms</strong>
                  <span className="sv-muted"> (now {intelNum(threshold.current_threshold) ?? '—'}ms)</span>
                </span>
                <button className="sv-btn sm" onClick={applyThreshold} disabled={applying}>
                  {applying ? <span className="sv-spinner-sm" /> : 'Apply'}
                </button>
              </div>
            ) : applied != null ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--sv-up)' }}>✓ Threshold updated to {applied}ms</div>
            ) : (
              <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>No threshold recommendation.</span>
            )}
          </div>
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
    <div className="sv-gw-panel" style={SECTION_CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ ...SECTION_HEADING, margin: 0 }}>Site Gateway</div>
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

'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { useApi, apiSend } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { StatusBadge, Loading, ErrorBox, Empty, fmtTime, fmtRel, fmtBps } from '@/components/ui';

type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_name: string | null; current_status: string; last_response_ms: number | null;
  last_seen_at: string | null; last_checked_at: string | null; snmp_enabled: boolean;
  poll_interval_seconds: number; ping_threshold_ms: number; device_vendor: string | null;
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
type PingPoint = { bucket: string; avg_ms: number | null; max_loss: number | null; down_samples: number };
type SnmpPoint = { bucket: string; if_name: string | null; avg_value: number | null };
type Alert = {
  id: number; alert_type: string; severity: string; message: string;
  triggered_at: string; resolved_at: string | null; status: string;
};

const RANGES = [
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState('24h');

  const device = useApi<Device>(`/api/devices/${id}`, 20000);
  const ping = useApi<PingPoint[]>(`/api/devices/${id}/ping-history?range=${range}`, 20000);
  const cpu = useApi<SnmpPoint[]>(`/api/devices/${id}/snmp-history?metric=cpu_pct&range=${range}`);
  const mem = useApi<SnmpPoint[]>(`/api/devices/${id}/snmp-history?metric=mem_pct&range=${range}`);
  const ifIn = useApi<SnmpPoint[]>(`/api/devices/${id}/snmp-history?metric=if_in_bps&range=${range}`);
  const alerts = useApi<Alert[]>(`/api/devices/${id}/alerts`, 20000);

  if (device.loading && !device.data) return <Loading />;
  if (device.error) return <ErrorBox message={device.error} />;
  if (!device.data) return <Empty message="Device not found." />;

  const d = device.data;
  const snmpOn = d.snmp_enabled;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4, flexWrap: 'wrap' }}>
        <StatusDot status={d.current_status} size={14} />
        <h1 className="sv-page-title" style={{ margin: 0 }}>{d.name}</h1>
        <StatusBadge status={d.current_status} />
        <div style={{ flex: 1 }} />
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

      <div className="sv-panel">
        <h2>Ping Latency (ms)</h2>
        <LatencyChart data={ping.data || []} loading={ping.loading} />
      </div>

      <div className="sv-panel">
        <h2>Packet Loss (%)</h2>
        <SingleChart
          data={(ping.data || []).map((p) => ({ bucket: p.bucket, value: p.max_loss }))}
          loading={ping.loading} color="#C8102E" unit="%"
        />
      </div>

      {snmpOn && (
        <>
          <div className="sv-panel">
            <h2>CPU Utilization (%)</h2>
            <SingleChart
              data={(cpu.data || []).map((p) => ({ bucket: p.bucket, value: p.avg_value }))}
              loading={cpu.loading} color="#1a2744" unit="%"
            />
          </div>
          <div className="sv-panel">
            <h2>Memory Utilization (%)</h2>
            <SingleChart
              data={(mem.data || []).map((p) => ({ bucket: p.bucket, value: p.avg_value }))}
              loading={mem.loading} color="#2e9e5b" unit="%"
            />
          </div>
          <div className="sv-panel">
            <h2>Interface Traffic — Inbound</h2>
            <InterfaceChart data={ifIn.data || []} loading={ifIn.loading} />
          </div>
        </>
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
    </div>
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
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
        <YAxis fontSize={11} />
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
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
        <YAxis fontSize={11} />
        <Tooltip labelFormatter={tickLabel} formatter={(v: any) => [`${v}${unit}`, '']} />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

const IF_COLORS = ['#C8102E', '#1a2744', '#2e9e5b', '#e6a700', '#7b4fc0', '#0a8ea0', '#d4663b'];

function InterfaceChart({ data, loading }: { data: SnmpPoint[]; loading: boolean }) {
  if (loading && !data.length) return <Loading />;
  if (!data.length) return <Empty message="No interface data for this range." />;

  // Pivot rows {bucket, if_name, avg_value} into {bucket, [ifName]: value}.
  const ifNames = Array.from(new Set(data.map((p) => p.if_name || 'unknown'))).slice(0, IF_COLORS.length);
  const byBucket: Record<string, any> = {};
  for (const p of data) {
    const key = p.bucket;
    if (!byBucket[key]) byBucket[key] = { bucket: key };
    byBucket[key][p.if_name || 'unknown'] = p.avg_value != null ? Number(p.avg_value) : null;
  }
  const chartData = Object.values(byBucket).sort(
    (a: any, b: any) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime()
  );

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
        <XAxis dataKey="bucket" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
        <YAxis fontSize={11} tickFormatter={(v) => fmtBps(v)} width={80} />
        <Tooltip labelFormatter={tickLabel} formatter={(v: any, n: any) => [fmtBps(v), n]} />
        <Legend />
        {ifNames.map((nm, i) => (
          <Line key={nm} type="monotone" dataKey={nm} stroke={IF_COLORS[i % IF_COLORS.length]}
            strokeWidth={2} dot={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

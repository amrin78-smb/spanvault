'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/lib/api';
import { Loading, ErrorBox, Empty, fmtBps } from '@/components/ui';

// ── Types ──────────────────────────────────────────────────────
type Site = { id: number; name: string };
type DeviceLite = { id: number; name: string; ip_address: string };
type Row = Record<string, any>;
type SlaResp = { sla_target: number; generated_at: string; devices: Row[] };
type SlaSummary = {
  sla_target: number; total_devices: number; devices_meeting_sla: number;
  overall_availability_pct: number | null; total_downtime_minutes: number;
  worst_device: { name: string; uptime_pct: number } | null;
  best_device: { name: string; uptime_pct: number } | null;
};
type Col = {
  key: string; label: string; align?: 'left' | 'right';
  fmt?: (v: any, row?: Row) => string; spark?: boolean; slaStatus?: boolean;
};
type Applied = {
  type: string; range: string; from: string; to: string;
  scope: string; siteId: string; deviceId: string; slaTarget: string;
  siteLabel: string; deviceLabel: string;
};

const REPORT_TYPES = [
  { key: 'sla', label: 'Availability & SLA' },
  { key: 'response', label: 'Response Time' },
  { key: 'alerts', label: 'Alert Summary' },
  { key: 'bandwidth', label: 'Bandwidth (SNMP)' },
];
const RANGES = [
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: 'custom', label: 'Custom' },
];
const RANGE_LABEL: Record<string, string> = Object.fromEntries(RANGES.map((r) => [r.key, r.label]));

// ── Column models per report type ──────────────────────────────
const COLUMNS: Record<string, Col[]> = {
  sla: [
    { key: 'device_name', label: 'Device' },
    { key: 'site_name', label: 'Site' },
    { key: 'uptime_pct', label: 'Uptime %', align: 'right', fmt: (v) => (v == null ? '—' : `${v}%`) },
    { key: 'downtime_minutes', label: 'Downtime (min)', align: 'right', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'avg_response_ms', label: 'Avg Response', align: 'right', fmt: (v) => (v == null ? '—' : `${v} ms`) },
    { key: 'total_alerts', label: 'Alerts', align: 'right' },
    { key: 'mttr_minutes', label: 'MTTR (min)', align: 'right', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'sla_met', label: 'SLA', align: 'right', slaStatus: true, fmt: (v) => (v ? 'MET' : 'FAILED') },
  ],
  response: [
    { key: 'device_name', label: 'Device' },
    { key: 'site_name', label: 'Site' },
    { key: 'avg_ms', label: 'Avg ms', align: 'right', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'min_ms', label: 'Min ms', align: 'right', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'max_ms', label: 'Max ms', align: 'right', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'p95_ms', label: 'P95 ms', align: 'right', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'spark', label: 'Trend', spark: true },
  ],
  alerts: [
    { key: 'device_name', label: 'Device' },
    { key: 'site_name', label: 'Site' },
    { key: 'total_alerts', label: 'Total Alerts', align: 'right' },
    { key: 'critical_count', label: 'Critical', align: 'right' },
    { key: 'warning_count', label: 'Warning', align: 'right' },
    { key: 'mttr_minutes', label: 'MTTR (min)', align: 'right', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'most_common_type', label: 'Most Common', fmt: (v) => v || '—' },
  ],
  bandwidth: [
    { key: 'device_name', label: 'Device' },
    { key: 'sensor_name', label: 'Interface' },
    { key: 'site_name', label: 'Site' },
    { key: 'avg_in_bps', label: 'Avg In', align: 'right', fmt: (v) => fmtBps(v) },
    { key: 'avg_out_bps', label: 'Avg Out', align: 'right', fmt: (v) => fmtBps(v) },
    { key: 'max_in_bps', label: 'Peak In', align: 'right', fmt: (v) => fmtBps(v) },
    { key: 'max_out_bps', label: 'Peak Out', align: 'right', fmt: (v) => fmtBps(v) },
    { key: 'p95_in_bps', label: 'P95 In', align: 'right', fmt: (v) => fmtBps(v) },
    { key: 'p95_out_bps', label: 'P95 Out', align: 'right', fmt: (v) => fmtBps(v) },
  ],
};

const ENDPOINT: Record<string, string> = {
  sla: '/api/reports/sla',
  response: '/api/reports/response-time',
  alerts: '/api/reports/alerts',
  bandwidth: '/api/reports/bandwidth',
};

// ── Helpers (top-level) ────────────────────────────────────────
function buildQuery(a: Applied): string {
  const p = new URLSearchParams();
  if (a.range === 'custom') {
    p.set('range', 'custom');
    if (a.from) p.set('from', a.from);
    if (a.to) p.set('to', a.to);
  } else {
    p.set('range', a.range);
  }
  if (a.scope === 'site' && a.siteId) p.set('site_id', a.siteId);
  if (a.scope === 'device' && a.deviceId) p.set('device_id', a.deviceId);
  if (a.type === 'sla') p.set('sla_target', a.slaTarget || '99.5');
  return p.toString();
}
function scopeLabel(a: Applied): string {
  if (a.scope === 'site') return `Site: ${a.siteLabel || a.siteId}`;
  if (a.scope === 'device') return `Device: ${a.deviceLabel || a.deviceId}`;
  return 'All Sites';
}
function rangeLabel(a: Applied): string {
  if (a.range === 'custom') return `${a.from || '…'} → ${a.to || '…'}`;
  return RANGE_LABEL[a.range] || a.range;
}
function escHtml(s: any): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
function cellText(c: Col, row: Row): string {
  if (c.spark) return '';
  const v = row[c.key];
  return c.fmt ? c.fmt(v, row) : (v == null ? '—' : String(v));
}

export default function ReportsPage() {
  const sites = useApi<Site[]>('/api/netvault/sites');
  const devices = useApi<DeviceLite[]>('/api/devices');

  const [type, setType] = useState('sla');
  const [range, setRange] = useState('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [scope, setScope] = useState('all');
  const [siteId, setSiteId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');
  const [slaTarget, setSlaTarget] = useState('99.5');
  const [applied, setApplied] = useState<Applied | null>(null);

  function runReport() {
    const siteLabel = sites.data?.find((s) => String(s.id) === siteId)?.name || '';
    const deviceLabel = devices.data?.find((d) => String(d.id) === deviceId)?.name || '';
    setApplied({ type, range, from, to, scope, siteId, deviceId, slaTarget, siteLabel, deviceLabel });
  }
  // Auto-run once on mount with defaults.
  useEffect(() => { runReport(); /* eslint-disable-next-line */ }, []);

  const q = applied ? buildQuery(applied) : '';
  const slaData = useApi<SlaResp>(applied?.type === 'sla' ? `/api/reports/sla?${q}` : null);
  const slaSummary = useApi<SlaSummary>(applied?.type === 'sla' ? `/api/reports/sla/summary?${q}` : null);
  const respData = useApi<Row[]>(applied?.type === 'response' ? `/api/reports/response-time?${q}` : null);
  const alertData = useApi<Row[]>(applied?.type === 'alerts' ? `/api/reports/alerts?${q}` : null);
  const bwData = useApi<Row[]>(applied?.type === 'bandwidth' ? `/api/reports/bandwidth?${q}` : null);

  const active = applied
    ? (applied.type === 'sla' ? slaData : applied.type === 'response' ? respData
      : applied.type === 'alerts' ? alertData : bwData)
    : null;
  const rows: Row[] = useMemo(() => {
    if (!applied) return [];
    if (applied.type === 'sla') return slaData.data?.devices || [];
    return (active?.data as Row[]) || [];
  }, [applied, slaData.data, active?.data]);

  const cols = applied ? COLUMNS[applied.type] : [];
  const filteredDevices = (devices.data || []).filter((d) =>
    !deviceSearch || d.name.toLowerCase().includes(deviceSearch.toLowerCase()) || (d.ip_address || '').includes(deviceSearch));

  function exportCsv() {
    if (!applied || !rows.length) return;
    const exportCols = cols.filter((c) => !c.spark);
    const head = exportCols.map((c) => c.label).join(',');
    const body = rows.map((r) => exportCols.map((c) => {
      const t = cellText(c, r);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }).join(',')).join('\n');
    const blob = new Blob([head + '\n' + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spanvault-${applied.type}-report.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function printView() {
    if (!applied) return;
    openPrintView(applied, cols, rows, applied.type === 'sla' ? slaSummary.data : null);
  }

  return (
    <div>
      <h1 className="sv-page-title">Reports</h1>
      <p className="sv-page-sub">Availability &amp; SLA, response time, alerts, and bandwidth — printable for management.</p>

      {/* Report type selector */}
      <div className="sv-tabs">
        {REPORT_TYPES.map((t) => (
          <button key={t.key} className={`sv-tab ${type === t.key ? 'active' : ''}`} onClick={() => setType(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="sv-panel">
        <div className="sv-toolbar" style={{ flexWrap: 'wrap' }}>
          <label className="sv-field">Date range
            <select className="sv-select" value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
          {range === 'custom' && (
            <>
              <label className="sv-field">From
                <input className="sv-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="sv-field">To
                <input className="sv-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </>
          )}
          <label className="sv-field">Scope
            <select className="sv-select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">All Sites</option>
              <option value="site">Specific Site</option>
              <option value="device">Specific Device</option>
            </select>
          </label>
          {scope === 'site' && (
            <label className="sv-field">Site
              <select className="sv-select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">Select…</option>
                {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          {scope === 'device' && (
            <>
              <input className="sv-input" placeholder="Search device…" value={deviceSearch}
                onChange={(e) => setDeviceSearch(e.target.value)} style={{ width: 180 }} />
              <select className="sv-select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">Select…</option>
                {filteredDevices.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>)}
              </select>
            </>
          )}
          {type === 'sla' && (
            <label className="sv-field">SLA Target %
              <input className="sv-input" type="number" step="0.1" value={slaTarget}
                onChange={(e) => setSlaTarget(e.target.value)} style={{ width: 90 }} />
            </label>
          )}
          <div className="spacer" />
          <button className="sv-btn" onClick={runReport}>Run Report</button>
        </div>
      </div>

      {/* Results */}
      {applied && (
        <>
          {applied.type === 'sla' && <SlaSummaryCards summary={slaSummary.data} />}

          <div className="sv-toolbar">
            <span className="sv-muted" style={{ fontSize: 13 }}>
              {REPORT_TYPES.find((t) => t.key === applied.type)?.label} · {rangeLabel(applied)} · {scopeLabel(applied)}
            </span>
            <div className="spacer" />
            <button className="sv-btn ghost" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
            <button className="sv-btn ghost" onClick={printView} disabled={!rows.length}>Print / Save HTML</button>
          </div>

          {active?.error && <ErrorBox message={active.error} />}
          <div className="sv-panel" style={{ padding: 0 }}>
            {active?.loading && !active?.data ? (
              <Loading />
            ) : rows.length ? (
              <ReportTable type={applied.type} cols={cols} rows={rows} slaTarget={Number(applied.slaTarget) || 99.5} />
            ) : (
              <Empty message="No data for the selected filters." />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── SLA summary cards (top-level) ──────────────────────────────
function SlaSummaryCards({ summary }: { summary: SlaSummary | null }) {
  if (!summary) return null;
  return (
    <div className="sv-cards">
      <div className="sv-card total">
        <div className="num">{summary.devices_meeting_sla}/{summary.total_devices}</div>
        <div className="label">Meeting SLA (≥{summary.sla_target}%)</div>
      </div>
      <div className="sv-card up">
        <div className="num">{summary.overall_availability_pct != null ? `${summary.overall_availability_pct}%` : '—'}</div>
        <div className="label">Overall Availability</div>
      </div>
      <div className="sv-card warning">
        <div className="num" style={{ fontSize: 24 }}>{summary.total_downtime_minutes}</div>
        <div className="label">Total Downtime (min)</div>
      </div>
      <div className="sv-card down">
        <div className="num" style={{ fontSize: 18 }}>
          {summary.worst_device ? `${summary.worst_device.name}` : '—'}
        </div>
        <div className="label">Worst {summary.worst_device ? `(${summary.worst_device.uptime_pct}%)` : ''}</div>
      </div>
    </div>
  );
}

// ── Report table (top-level) ───────────────────────────────────
function ReportTable({ type, cols, rows, slaTarget }: { type: string; cols: Col[]; rows: Row[]; slaTarget: number }) {
  return (
    <table className="sv-table">
      <thead>
        <tr>{cols.map((c) => <th key={c.key} style={{ textAlign: c.align || 'left' }}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const failing = type === 'sla' && !row.sla_met && row.uptime_pct != null;
          return (
            <tr key={i} style={failing ? { background: 'rgba(200,16,46,0.06)' } : undefined}>
              {cols.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left' }}
                  className={c.key === 'device_name' ? '' : 'sv-muted'}>
                  {c.spark ? (
                    <Sparkline data={row.spark} />
                  ) : c.slaStatus ? (
                    <span className={`sv-badge ${row.sla_met ? 'up' : 'down'}`}>
                      {row.sla_met ? '✓ MET' : '✗ FAILED'}
                    </span>
                  ) : (
                    cellText(c, row)
                  )}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Inline sparkline (top-level) ───────────────────────────────
function Sparkline({ data }: { data: number[] | undefined }) {
  if (!data || data.length < 2) return <span className="sv-muted">—</span>;
  const w = 84, h = 22, pad = 2;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke="#C8102E" strokeWidth={1.5} />
    </svg>
  );
}

// ── Printable HTML view (top-level) ────────────────────────────
function openPrintView(applied: Applied, cols: Col[], rows: Row[], summary: SlaSummary | null) {
  const win = window.open('', '_blank');
  if (!win) return;
  const exportCols = cols.filter((c) => !c.spark);
  const typeLabel = REPORT_TYPES.find((t) => t.key === applied.type)?.label || 'Report';
  const head = exportCols.map((c) => `<th style="text-align:${c.align || 'left'}">${escHtml(c.label)}</th>`).join('');
  const body = rows.map((r) => {
    const failing = applied.type === 'sla' && !r.sla_met && r.uptime_pct != null;
    const tds = exportCols.map((c) => {
      let text = cellText(c, r);
      if (c.slaStatus) text = r.sla_met ? '✓ MET' : '✗ FAILED';
      const color = c.slaStatus ? (r.sla_met ? '#2e9e5b' : '#C8102E') : 'inherit';
      return `<td style="text-align:${c.align || 'left'};color:${color}">${escHtml(text)}</td>`;
    }).join('');
    return `<tr style="${failing ? 'background:#fbecef' : ''}">${tds}</tr>`;
  }).join('');

  let summaryHtml = '';
  if (summary) {
    summaryHtml = `
      <div class="summary">
        <div class="card"><div class="n">${summary.devices_meeting_sla}/${summary.total_devices}</div><div class="l">Meeting SLA (≥${summary.sla_target}%)</div></div>
        <div class="card"><div class="n">${summary.overall_availability_pct ?? '—'}%</div><div class="l">Overall Availability</div></div>
        <div class="card"><div class="n">${summary.total_downtime_minutes}</div><div class="l">Total Downtime (min)</div></div>
        <div class="card"><div class="n">${summary.worst_device ? escHtml(summary.worst_device.name) + ' (' + summary.worst_device.uptime_pct + '%)' : '—'}</div><div class="l">Worst Device</div></div>
      </div>`;
  }

  const now = new Date().toLocaleString();
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>SpanVault — ${escHtml(typeLabel)}</title>
  <style>
    body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color:#1a2744; margin:32px; }
    .brand { color:#C8102E; font-weight:800; font-size:22px; letter-spacing:.5px; }
    h1 { font-size:20px; margin:6px 0 2px; }
    .meta { color:#6b7280; font-size:13px; margin-bottom:18px; }
    .meta strong { color:#1a2744; }
    .summary { display:flex; gap:14px; flex-wrap:wrap; margin:14px 0 20px; }
    .card { border:1px solid #e3e6eb; border-radius:8px; padding:12px 16px; min-width:150px; }
    .card .n { font-size:22px; font-weight:700; }
    .card .l { color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.4px; margin-top:4px; }
    table { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
    th { text-align:left; border-bottom:2px solid #1a2744; padding:8px 10px; font-size:11px; text-transform:uppercase; letter-spacing:.4px; color:#6b7280; }
    td { padding:7px 10px; border-bottom:1px solid #e3e6eb; }
    .foot { margin-top:18px; color:#9aa1ad; font-size:11px; }
    @media print { .noprint { display:none; } body { margin:12px; } }
  </style></head><body>
    <div class="brand">SpanVault</div>
    <h1>Network ${escHtml(typeLabel)} Report</h1>
    <div class="meta">
      <div>Date range: <strong>${escHtml(rangeLabel(applied))}</strong></div>
      <div>Scope: <strong>${escHtml(scopeLabel(applied))}</strong></div>
      ${applied.type === 'sla' ? `<div>SLA target: <strong>${escHtml(applied.slaTarget || '99.5')}%</strong></div>` : ''}
      <div>Generated: <strong>${escHtml(now)}</strong></div>
    </div>
    ${summaryHtml}
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="foot">SpanVault — NocVault Suite · ${rows.length} row(s)</div>
    <div class="noprint" style="margin-top:20px"><button onclick="window.print()">Print</button></div>
  </body></html>`);
  win.document.close();
}

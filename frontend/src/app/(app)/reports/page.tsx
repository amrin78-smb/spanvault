'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { ErrorBox, PageHeader, Loading } from '@/components/ui';
import NetworkSummaryReport from '@/components/reports/NetworkSummaryReport';
import SiteReport from '@/components/reports/SiteReport';
import DeviceDetailReport from '@/components/reports/DeviceDetailReport';
import SlaComplianceReport from '@/components/reports/SlaComplianceReport';
import TopWorstReport from '@/components/reports/TopWorstReport';
import AlertAnalysisReport from '@/components/reports/AlertAnalysisReport';
import CapacityReport from '@/components/reports/CapacityReport';
import ExecutiveSummaryReport from '@/components/reports/ExecutiveSummaryReport';

// ── Types ──────────────────────────────────────────────────────
type Site = { id: number; name: string };
type DeviceLite = { id: number; name: string; ip_address: string };
type SavedReport = {
  id: number; name: string; template: string; scope_type: string;
  scope_id: number | null; scope_name: string | null; date_range: string;
  sla_target: number | null;
};
// Scope modes a template supports.
type ScopeKind = 'all' | 'site' | 'device' | 'flexible' | 'flexibleNoDevice';
type Template = {
  key: string; icon: string; label: string; desc: string;
  scope: ScopeKind; sla?: boolean; metric?: boolean;
};
type Applied = {
  template: string; range: string; from: string; to: string;
  scopeMode: 'all' | 'site' | 'device';
  siteId: string; siteLabel: string; deviceId: string; deviceLabel: string;
  slaTarget: string; metric: string;
};

const TEMPLATES: Template[] = [
  { key: 'network-summary', icon: '📊', label: 'Network Summary', desc: 'Overall health across all sites and devices', scope: 'all' },
  { key: 'site-summary', icon: '🏢', label: 'Site Report', desc: 'All devices in a site with comparison table', scope: 'site' },
  { key: 'device-detail', icon: '🖥', label: 'Device Detail Report', desc: 'Full history, graphs and metrics for one device', scope: 'device' },
  { key: 'sla-compliance', icon: '✅', label: 'SLA Compliance', desc: 'Pass/fail per device vs SLA target', scope: 'flexible', sla: true },
  { key: 'top-worst', icon: '⚠', label: 'Top 10 Worst', desc: 'Lowest availability, highest latency or most alerts', scope: 'flexibleNoDevice', metric: true },
  { key: 'alert-analysis', icon: '🔔', label: 'Alert Analysis', desc: 'Most alerted devices, MTTR, and patterns', scope: 'flexibleNoDevice' },
  { key: 'capacity', icon: '📈', label: 'Capacity Planning', desc: 'Bandwidth trends and utilization projections', scope: 'flexibleNoDevice' },
  { key: 'executive', icon: '📋', label: 'Executive Summary', desc: 'Management-level overview with recommendations', scope: 'all' },
];
const TEMPLATE_BY_KEY: Record<string, Template> = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

const RANGES = [
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: '90d', label: 'Last 90 Days' },
];
const METRICS = [
  { key: 'uptime', label: 'Availability' },
  { key: 'response', label: 'Response Time' },
  { key: 'alerts', label: 'Alerts' },
];

// ── Helpers (top-level) ────────────────────────────────────────
function buildEndpoint(a: Applied): string {
  const p = new URLSearchParams();
  if (a.range === 'custom') { p.set('range', 'custom'); if (a.from) p.set('from', a.from); if (a.to) p.set('to', a.to); }
  else p.set('range', a.range);
  const useSite = (a.scopeMode === 'site') && a.siteId;
  const useDevice = (a.scopeMode === 'device') && a.deviceId;
  switch (a.template) {
    case 'network-summary': return `/api/reports/network-summary?${p}`;
    case 'executive':       return `/api/reports/executive?${p}`;
    case 'site-summary':    p.set('site_id', a.siteId); return `/api/reports/site-summary?${p}`;
    case 'device-detail':   p.set('device_id', a.deviceId); return `/api/reports/device-detail?${p}`;
    case 'sla-compliance':
      if (useSite) p.set('site_id', a.siteId);
      if (useDevice) p.set('device_id', a.deviceId);
      p.set('sla_target', a.slaTarget || '99.5');
      return `/api/reports/sla-compliance?${p}`;
    case 'top-worst':
      if (useSite) p.set('site_id', a.siteId);
      p.set('metric', a.metric || 'uptime'); p.set('limit', '10');
      return `/api/reports/top-worst?${p}`;
    case 'alert-analysis':
      if (useSite) p.set('site_id', a.siteId);
      return `/api/reports/alert-analysis?${p}`;
    case 'capacity':
      if (useSite) p.set('site_id', a.siteId);
      return `/api/reports/capacity?${p}`;
    default: return `/api/reports/network-summary?${p}`;
  }
}
// Whether a loaded report payload has no meaningful data to show.
function isEmptyReport(template: string, data: any): boolean {
  if (!data) return true;
  switch (template) {
    case 'network-summary': return !data.totals || data.totals.devices === 0;
    case 'site-summary':    return !data.devices || data.devices.length === 0;
    case 'sla-compliance':  return !data.devices || data.devices.length === 0;
    case 'top-worst':       return !data.devices || data.devices.length === 0;
    case 'alert-analysis':  return !data.total_alerts;
    case 'capacity':        return !Array.isArray(data) || data.length === 0;
    case 'device-detail':   return !data.device;
    case 'executive':       return false; // executive always renders a summary
    default: return false;
  }
}
function rangeLabel(a: Applied): string {
  if (a.range === 'custom') return `${a.from || '…'} → ${a.to || '…'}`;
  return RANGES.find((r) => r.key === a.range)?.label || a.range;
}
function scopeLabel(a: Applied): string {
  if (a.scopeMode === 'site') return `Site: ${a.siteLabel || a.siteId}`;
  if (a.scopeMode === 'device') return `Device: ${a.deviceLabel || a.deviceId}`;
  return 'All Sites';
}

export default function ReportsPage() {
  const { data: session } = useSession();
  const email = session?.user?.email || '';
  const sites = useApi<Site[]>('/api/netvault/sites');
  const devices = useApi<DeviceLite[]>('/api/devices');
  const saved = useApi<SavedReport[]>(email ? `/api/reports/saved?created_by=${encodeURIComponent(email)}` : '/api/reports/saved');

  const [template, setTemplate] = useState('network-summary');
  const [range, setRange] = useState('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [scopeMode, setScopeMode] = useState<'all' | 'site' | 'device'>('all');
  const [siteId, setSiteId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');
  const [slaTarget, setSlaTarget] = useState('99.5');
  const [metric, setMetric] = useState('uptime');
  const [applied, setApplied] = useState<Applied | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');

  const tpl = TEMPLATE_BY_KEY[template];

  // Reset scope mode when switching to a template with a fixed scope.
  useEffect(() => {
    if (tpl.scope === 'all') setScopeMode('all');
    else if (tpl.scope === 'site') setScopeMode('site');
    else if (tpl.scope === 'device') setScopeMode('device');
    // flexible / flexibleNoDevice keep whatever the user picked (but device
    // isn't allowed on flexibleNoDevice — normalise that).
    else if (tpl.scope === 'flexibleNoDevice' && scopeMode === 'device') setScopeMode('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  function canRun(): boolean {
    if (tpl.scope === 'site' && !siteId) return false;
    if (tpl.scope === 'device' && !deviceId) return false;
    if (scopeMode === 'site' && !siteId) return false;
    if (scopeMode === 'device' && !deviceId) return false;
    return true;
  }

  function runReport() {
    if (!canRun()) return;
    const siteLabel = sites.data?.find((s) => String(s.id) === siteId)?.name || '';
    const deviceLabel = devices.data?.find((d) => String(d.id) === deviceId)?.name || '';
    setApplied({ template, range, from, to, scopeMode, siteId, siteLabel, deviceId, deviceLabel, slaTarget, metric });
    setSaveName('');
  }

  const endpoint = applied ? buildEndpoint(applied) : null;
  const report = useApi<any>(endpoint, 0);

  const loading = !!applied && report.loading && !report.data;
  const empty = !!applied && !report.loading && !report.error && isEmptyReport(applied.template, report.data);

  const filteredDevices = (devices.data || []).filter((d) =>
    !deviceSearch || d.name.toLowerCase().includes(deviceSearch.toLowerCase()) || (d.ip_address || '').includes(deviceSearch));

  async function saveReport() {
    if (!applied || !saveName.trim()) return;
    setSaving(true);
    try {
      await apiSend('/api/reports/saved', 'POST', {
        name: saveName.trim(), template: applied.template,
        scope_type: applied.scopeMode,
        scope_id: applied.scopeMode === 'site' ? Number(applied.siteId) || null
          : applied.scopeMode === 'device' ? Number(applied.deviceId) || null : null,
        scope_name: applied.scopeMode === 'site' ? applied.siteLabel
          : applied.scopeMode === 'device' ? applied.deviceLabel : null,
        date_range: applied.range,
        sla_target: applied.template === 'sla-compliance' ? Number(applied.slaTarget) || 99.5 : null,
        created_by: email || null,
      });
      setSaveName('');
      saved.reload();
    } finally {
      setSaving(false);
    }
  }

  async function deleteSaved(id: number) {
    await apiSend(`/api/reports/saved/${id}`, 'DELETE');
    saved.reload();
  }

  function loadSaved(s: SavedReport) {
    setTemplate(s.template);
    setRange(s.date_range && s.date_range !== 'custom' ? s.date_range : '30d');
    const mode = (s.scope_type as 'all' | 'site' | 'device') || 'all';
    setScopeMode(mode === 'site' || mode === 'device' ? mode : 'all');
    setSiteId(mode === 'site' && s.scope_id ? String(s.scope_id) : '');
    setDeviceId(mode === 'device' && s.scope_id ? String(s.scope_id) : '');
    if (s.sla_target != null) setSlaTarget(String(s.sla_target));
    const siteLabel = s.scope_type === 'site' ? (s.scope_name || '') : '';
    const deviceLabel = s.scope_type === 'device' ? (s.scope_name || '') : '';
    setApplied({
      template: s.template, range: s.date_range && s.date_range !== 'custom' ? s.date_range : '30d',
      from: '', to: '', scopeMode: mode === 'site' || mode === 'device' ? mode : 'all',
      siteId: mode === 'site' && s.scope_id ? String(s.scope_id) : '',
      siteLabel, deviceId: mode === 'device' && s.scope_id ? String(s.scope_id) : '',
      deviceLabel, slaTarget: s.sla_target != null ? String(s.sla_target) : '99.5',
      metric: 'uptime',
    });
  }

  const showScopeSelector = tpl.scope === 'flexible' || tpl.scope === 'flexibleNoDevice';

  return (
    <div>
      <div className="sv-no-print">
        <PageHeader title="Reports" subtitle="Run reports across your network — printable for management.">
          {applied && !empty && !loading && (
            <button className="sv-btn" onClick={() => window.print()}>Export PDF</button>
          )}
        </PageHeader>

        {/* Template selector */}
        <div className="sv-report-templates">
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              className={`sv-report-tpl ${template === t.key ? 'active' : ''}`}
              onClick={() => setTemplate(t.key)}
            >
              <span className="ico">{t.icon}</span>
              <span className="body">
                <span className="nm">{t.label}</span>
                <span className="desc">{t.desc}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Controls */}
        <div className="sv-panel">
          <div className="sv-toolbar" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {/* Scope */}
            {showScopeSelector && (
              <label className="sv-field">Scope
                <select className="sv-select" value={scopeMode} onChange={(e) => setScopeMode(e.target.value as any)}>
                  <option value="all">All</option>
                  <option value="site">Site</option>
                  {tpl.scope === 'flexible' && <option value="device">Device</option>}
                </select>
              </label>
            )}
            {(tpl.scope === 'site' || (showScopeSelector && scopeMode === 'site')) && (
              <label className="sv-field">Site
                <select className="sv-select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  <option value="">Select…</option>
                  {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            {(tpl.scope === 'device' || (tpl.scope === 'flexible' && scopeMode === 'device')) && (
              <>
                <label className="sv-field">Search
                  <input className="sv-input" placeholder="Device name or IP…" value={deviceSearch}
                    onChange={(e) => setDeviceSearch(e.target.value)} style={{ width: 170 }} />
                </label>
                <label className="sv-field">Device
                  <select className="sv-select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                    <option value="">Select…</option>
                    {filteredDevices.slice(0, 100).map((d) => <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>)}
                  </select>
                </label>
              </>
            )}

            {/* Metric (top-worst only) */}
            {tpl.metric && (
              <label className="sv-field">Metric
                <select className="sv-select" value={metric} onChange={(e) => setMetric(e.target.value)}>
                  {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </label>
            )}

            {/* SLA target */}
            {tpl.sla && (
              <label className="sv-field">SLA Target %
                <input className="sv-input" type="number" step="0.1" value={slaTarget}
                  onChange={(e) => setSlaTarget(e.target.value)} style={{ width: 90 }} />
              </label>
            )}

            {/* Date range presets */}
            <label className="sv-field">Date range
              <div style={{ display: 'flex', gap: 6 }}>
                {RANGES.map((r) => (
                  <button key={r.key} type="button"
                    className={`sv-btn ghost sm ${range === r.key ? 'active' : ''}`}
                    onClick={() => setRange(r.key)}>{r.label}</button>
                ))}
                <button type="button" className={`sv-btn ghost sm ${range === 'custom' ? 'active' : ''}`}
                  onClick={() => setRange('custom')}>Custom</button>
              </div>
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

            <div className="spacer" style={{ flex: 1 }} />
            <button className="sv-btn" onClick={runReport} disabled={!canRun()}>Run Report →</button>
          </div>

          {/* Saved reports chips */}
          {(saved.data?.length || 0) > 0 && (
            <div className="sv-saved-chips">
              <span className="sv-muted" style={{ fontSize: 12.5, marginRight: 4 }}>Saved:</span>
              {saved.data!.map((s) => (
                <span key={s.id} className="sv-saved-chip">
                  <button className="nm" onClick={() => loadSaved(s)} title={`Load "${s.name}"`}>{s.name}</button>
                  <button className="del" onClick={() => deleteSaved(s.id)} title="Delete">×</button>
                </span>
              ))}
            </div>
          )}

          {/* Save current report */}
          {applied && !empty && !loading && (
            <div className="sv-toolbar" style={{ marginTop: 10 }}>
              <input className="sv-input" placeholder="Name this report…" value={saveName}
                onChange={(e) => setSaveName(e.target.value)} style={{ width: 220 }} />
              <button className="sv-btn ghost sm" onClick={saveReport} disabled={saving || !saveName.trim()}>
                {saving ? 'Saving…' : '+ Save this report'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Report output */}
      {applied && (
        <div className="sv-report-output" id="report-print">
          {/* Print-only header */}
          <div className="sv-print-only sv-print-head">
            <span className="brand">SpanVault</span>
            <span className="meta">
              {tpl.label} · {rangeLabel(applied)} · {scopeLabel(applied)} · Generated {new Date().toLocaleString()}
            </span>
          </div>

          <div className="sv-no-print" style={{ margin: '8px 0 14px', fontSize: 13, color: 'var(--text-muted)' }}>
            {tpl.label} · {rangeLabel(applied)} · {scopeLabel(applied)}
          </div>

          {report.error && <ErrorBox message={report.error} />}
          {loading ? (
            <div className="sv-panel" style={{ textAlign: 'center', padding: '40px 20px' }}>
              <Loading label="Generating report…" />
            </div>
          ) : empty ? (
            <div className="sv-panel" style={{ textAlign: 'center', padding: '40px 20px' }}>
              <p className="sv-muted" style={{ margin: 0 }}>
                No data for {scopeLabel(applied)} in {rangeLabel(applied)}. Try extending the date range.
              </p>
            </div>
          ) : report.data ? (
            <ReportBody template={applied.template} data={report.data} />
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Report body switch (top-level component) ───────────────────
function ReportBody({ template, data }: { template: string; data: any }) {
  switch (template) {
    case 'network-summary': return <NetworkSummaryReport data={data} />;
    case 'site-summary':    return <SiteReport data={data} />;
    case 'device-detail':   return <DeviceDetailReport data={data} />;
    case 'sla-compliance':  return <SlaComplianceReport data={data} />;
    case 'top-worst':       return <TopWorstReport data={data} />;
    case 'alert-analysis':  return <AlertAnalysisReport data={data} />;
    case 'capacity':        return <CapacityReport data={data} />;
    case 'executive':       return <ExecutiveSummaryReport data={data} />;
    default: return null;
  }
}

'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { ErrorBox, Loading } from '@/components/ui';
import NetworkSummaryReport from '@/components/reports/NetworkSummaryReport';
import SiteReport from '@/components/reports/SiteReport';
import DeviceDetailReport from '@/components/reports/DeviceDetailReport';
import ApDetailReport from '@/components/reports/ApDetailReport';
import SlaComplianceReport from '@/components/reports/SlaComplianceReport';
import TopWorstReport from '@/components/reports/TopWorstReport';
import AlertAnalysisReport from '@/components/reports/AlertAnalysisReport';
import CapacityReport from '@/components/reports/CapacityReport';
import ExecutiveSummaryReport from '@/components/reports/ExecutiveSummaryReport';
import WirelessOverviewReport from '@/components/reports/WirelessOverviewReport';
import WirelessAPHealthReport from '@/components/reports/WirelessAPHealthReport';
import WirelessClientReport from '@/components/reports/WirelessClientReport';
import WirelessRFReport from '@/components/reports/WirelessRFReport';
import WirelessCapacityReport from '@/components/reports/WirelessCapacityReport';
import ReportsCatalog, { CatalogReport } from '@/components/reports/ReportsCatalog';

// ── Types ──────────────────────────────────────────────────────
type Site = { id: number; name: string };
type DeviceLite = { id: number; name: string; ip_address: string };
type ApLite = { id: number; name: string; ip_address: string | null; site_name: string | null };
type Controller = { id: number; name: string };
// One selected entity (AP or device) rendered as its own report section.
type EntityRef = { id: string; label: string };
type SavedReport = {
  id: number; name: string; template: string; scope_type: string;
  scope_id: number | null; scope_name: string | null; date_range: string;
  sla_target: number | null;
};
// Scope modes a template supports.
// 'apMulti'/'deviceMulti' = Phase-1 granular detail reports: pick one or many
// entities, each rendered as its own charted section.
type ScopeKind = 'all' | 'site' | 'device' | 'flexible' | 'flexibleNoDevice' | 'apMulti' | 'deviceMulti';
type Template = {
  key: string; icon: string; label: string; desc: string;
  scope: ScopeKind; sla?: boolean; metric?: boolean; wireless?: boolean;
  // granular = uses the flexible time range / bucket / metric-checkbox controls.
  granular?: boolean;
  // category = left-rail catalog grouping (display metadata only; does not affect
  // report generation).
  category: string;
};
type Applied = {
  template: string; range: string; from: string; to: string; bucket: string;
  scopeMode: 'all' | 'site' | 'device';
  siteId: string; siteLabel: string; deviceId: string; deviceLabel: string;
  controllerId: string; controllerLabel: string;
  slaTarget: string; metric: string;
  // Multi-entity detail reports: the selected APs/devices + chosen metric keys.
  entities: EntityRef[]; selectedMetrics: string[];
};

// Left-rail catalog group order. Each template carries a `category` matching one of
// these; the catalog renders groups in this order and lists templates in array order
// within each group.
const GROUP_ORDER = ['Overview', 'Performance & SLA', 'Wireless', 'Detail'];

const TEMPLATES: Template[] = [
  { key: 'executive', icon: '📋', label: 'Executive', desc: 'Management-level overview with recommendations', scope: 'all', category: 'Overview' },
  { key: 'network-summary', icon: '📊', label: 'Network Summary', desc: 'Overall health across all sites and devices', scope: 'all', category: 'Overview' },
  { key: 'site-summary', icon: '🏢', label: 'Site Report', desc: 'All devices in a site with comparison table', scope: 'site', category: 'Overview' },
  { key: 'sla-compliance', icon: '✅', label: 'SLA Compliance', desc: 'Pass/fail per device vs SLA target', scope: 'flexible', sla: true, category: 'Performance & SLA' },
  { key: 'capacity', icon: '📈', label: 'Capacity', desc: 'Bandwidth trends and utilization projections', scope: 'flexibleNoDevice', category: 'Performance & SLA' },
  { key: 'top-worst', icon: '⚠', label: 'Top 10 Worst', desc: 'Lowest availability, highest latency or most alerts', scope: 'flexibleNoDevice', metric: true, category: 'Performance & SLA' },
  { key: 'alert-analysis', icon: '🔔', label: 'Alerts & Anomalies', desc: 'Most alerted devices, MTTR, and patterns', scope: 'flexibleNoDevice', category: 'Performance & SLA' },
  { key: 'wireless-overview', icon: '📶', label: 'Wireless Overview', desc: 'AP status, clients and utilization across all sites', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-ap-health', icon: '📡', label: 'Wireless AP Health', desc: 'Per-AP health scores, channels and utilization', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-clients', icon: '👥', label: 'Wireless Client', desc: 'Client distribution, problem clients and roaming', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-rf', icon: '📻', label: 'Wireless RF', desc: 'Co-channel interference, band steering and RF scores', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-capacity', icon: '📊', label: 'Wireless Capacity', desc: 'AP capacity usage and client growth trends', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'device-detail', icon: '🖥', label: 'Device Detail', desc: 'Time-series charts, history and metrics for one or more devices', scope: 'deviceMulti', granular: true, category: 'Detail' },
  { key: 'ap-detail', icon: '📡', label: 'AP Detail', desc: 'Time-series charts, clients, RF and throughput for one or more access points', scope: 'apMulti', granular: true, category: 'Detail' },
];
const TEMPLATE_BY_KEY: Record<string, Template> = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
// Catalog rows (display metadata) derived once from the templates.
const CATALOG_REPORTS: CatalogReport[] = TEMPLATES.map((t) => ({
  key: t.key, short: t.label, title: t.label, desc: t.desc, icon: t.icon, category: t.category,
}));

const RANGES = [
  { key: '24h', label: 'Last 24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
];
const METRICS = [
  { key: 'uptime', label: 'Availability' },
  { key: 'response', label: 'Response Time' },
  { key: 'alerts', label: 'Alerts' },
];

// Resolution (bucket) selector for granular detail reports → ?bucket=
const BUCKETS = [
  { key: 'auto', label: 'Auto' },
  { key: '5m', label: '5m' },
  { key: '15m', label: '15m' },
  { key: '1h', label: '1h' },
  { key: '1d', label: '1d' },
];

// Metric checkbox catalog per granular template. `def` = default-checked.
type MetricOpt = { key: string; label: string; def?: boolean };
const DETAIL_METRICS: Record<string, MetricOpt[]> = {
  'ap-detail': [
    { key: 'clients', label: 'Clients', def: true },
    { key: 'radio_util', label: 'Radio Util', def: true },
    { key: 'noise', label: 'Noise' },
    { key: 'throughput', label: 'Throughput' },
  ],
  'device-detail': [
    { key: 'latency', label: 'Latency', def: true },
    { key: 'cpu', label: 'CPU', def: true },
    { key: 'mem', label: 'Memory' },
    { key: 'interfaces', label: 'Interfaces', def: true },
    { key: 'sessions', label: 'Sessions' },
  ],
};
function defaultMetrics(template: string): string[] {
  return (DETAIL_METRICS[template] || []).filter((m) => m.def).map((m) => m.key);
}

// How long each preset spans, used to compute explicit ISO from/to for granular
// reports (the contract: both endpoints accept ISO from/to OR a range preset —
// we prefer sending explicit from/to). Returns [fromISO, toISO].
function presetToIso(range: string): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  switch (range) {
    case '24h': from.setHours(from.getHours() - 24); break;
    case '7d':  from.setDate(from.getDate() - 7); break;
    case '30d': from.setDate(from.getDate() - 30); break;
    case '90d': from.setDate(from.getDate() - 90); break;
    default:    from.setDate(from.getDate() - 30); break;
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

// ── Helpers (top-level) ────────────────────────────────────────
// Shared range/bucket params for the granular detail endpoints.
// Custom range → explicit from/to (ISO); preset → compute explicit from/to too
// (the contract accepts both; we prefer sending from/to). bucket always sent.
function granularRangeParams(a: Applied): URLSearchParams {
  const p = new URLSearchParams();
  if (a.range === 'custom') {
    if (a.from) p.set('from', new Date(a.from).toISOString());
    if (a.to) p.set('to', new Date(a.to).toISOString());
  } else {
    const { from, to } = presetToIso(a.range);
    p.set('from', from);
    p.set('to', to);
    // Also pass the preset name so the API can fall back to `range` if it prefers.
    p.set('range', a.range);
  }
  p.set('bucket', a.bucket || 'auto');
  return p;
}
// Per-entity endpoint for a multi-entity detail report.
//   ap-detail     → GET /api/reports/ap-detail/:id?from=&to=&bucket=
//   device-detail → GET /api/reports/device-detail?device_id=&from=&to=&bucket=
function buildEntityEndpoint(template: string, entityId: string, a: Applied): string {
  const p = granularRangeParams(a);
  if (template === 'ap-detail') {
    return `/api/reports/ap-detail/${encodeURIComponent(entityId)}?${p}`;
  }
  // device-detail
  p.set('device_id', entityId);
  return `/api/reports/device-detail?${p}`;
}

function buildEndpoint(a: Applied): string {
  const p = new URLSearchParams();
  if (a.range === 'custom') { p.set('range', 'custom'); if (a.from) p.set('from', a.from); if (a.to) p.set('to', a.to); }
  else p.set('range', a.range);
  const useSite = (a.scopeMode === 'site') && a.siteId;
  const useDevice = (a.scopeMode === 'device') && a.deviceId;
  // Wireless reports are scoped by an optional controller_id instead of site/device.
  if (a.template.startsWith('wireless-')) {
    if (a.controllerId) p.set('controller_id', a.controllerId);
    return `/api/reports/${a.template}?${p}`;
  }
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
    case 'wireless-overview':  return !data.summary || data.summary.total_aps === 0;
    case 'wireless-ap-health': return !data.aps || data.aps.length === 0;
    case 'wireless-clients':   return !data.summary || data.summary.total_clients === 0;
    case 'wireless-rf':        return false; // always renders score/recommendations
    case 'wireless-capacity':  return !data || (data.used_aps === 0 && (!data.client_trend || data.client_trend.length === 0));
    default: return false;
  }
}
function rangeLabel(a: Applied): string {
  if (a.range === 'custom') return `${a.from || '…'} → ${a.to || '…'}`;
  if (a.range === '24h') return 'Last 24 Hours';
  if (a.range === '7d') return 'Last 7 Days';
  if (a.range === '30d') return 'Last 30 Days';
  if (a.range === '90d') return 'Last 90 Days';
  return RANGES.find((r) => r.key === a.range)?.label || a.range;
}
function scopeLabel(a: Applied): string {
  if (a.template === 'ap-detail' || a.template === 'device-detail') {
    const noun = a.template === 'ap-detail' ? 'AP' : 'Device';
    if (a.entities.length === 0) return `No ${noun.toLowerCase()}s`;
    if (a.entities.length === 1) return `${noun}: ${a.entities[0].label}`;
    return `${a.entities.length} ${noun}s`;
  }
  if (a.template.startsWith('wireless-')) {
    return a.controllerId ? `Controller: ${a.controllerLabel || a.controllerId}` : 'All Controllers';
  }
  if (a.scopeMode === 'site') return `Site: ${a.siteLabel || a.siteId}`;
  if (a.scopeMode === 'device') return `Device: ${a.deviceLabel || a.deviceId}`;
  return 'All Sites';
}

// ── Shared inline-style constants ──────────────────────────────
const CTRL_H = 32;
const ctrlBase: React.CSSProperties = {
  height: CTRL_H, padding: '0 10px', fontSize: 'var(--text-sm)',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit',
  outline: 'none',
};
const fieldLabel: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const presetBtn = (active: boolean): React.CSSProperties => ({
  height: CTRL_H, padding: '0 11px', fontSize: 'var(--text-sm)', cursor: 'pointer',
  borderRadius: 'var(--radius-sm)', fontWeight: 600,
  border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
  background: active ? 'var(--primary)' : 'var(--bg-card)',
  color: active ? '#fff' : 'var(--text-primary)',
});

export default function ReportsPage() {
  const { data: session } = useSession();
  const email = session?.user?.email || '';
  const userName = session?.user?.name || email || 'Unknown user';
  const sites = useApi<Site[]>('/api/netvault/sites');
  const devices = useApi<DeviceLite[]>('/api/devices');
  const aps = useApi<ApLite[]>('/api/wireless/aps');
  const controllers = useApi<Controller[]>('/api/wireless/controllers');
  const saved = useApi<SavedReport[]>(email ? `/api/reports/saved?created_by=${encodeURIComponent(email)}` : '/api/reports/saved');

  const [template, setTemplate] = useState('network-summary');
  const [range, setRange] = useState('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [bucket, setBucket] = useState('auto');
  const [scopeMode, setScopeMode] = useState<'all' | 'site' | 'device'>('all');
  const [siteId, setSiteId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [controllerId, setControllerId] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');
  const [slaTarget, setSlaTarget] = useState('99.5');
  const [metric, setMetric] = useState('uptime');
  // Granular detail reports: multi-entity selection + metric checkboxes.
  const [entityIds, setEntityIds] = useState<string[]>([]);
  const [entitySearch, setEntitySearch] = useState('');
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(defaultMetrics('network-summary'));
  const [applied, setApplied] = useState<Applied | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  // Right-workspace active tab (View = configure + render; Saved = saved reports).
  const [tab, setTab] = useState<'view' | 'saved'>('view');

  const tpl = TEMPLATE_BY_KEY[template];

  // Reset scope mode when switching to a template with a fixed scope.
  useEffect(() => {
    if (tpl.scope === 'all') setScopeMode('all');
    else if (tpl.scope === 'site') setScopeMode('site');
    else if (tpl.scope === 'device') setScopeMode('device');
    // flexible / flexibleNoDevice keep whatever the user picked (but device
    // isn't allowed on flexibleNoDevice — normalise that).
    else if (tpl.scope === 'flexibleNoDevice' && scopeMode === 'device') setScopeMode('all');
    // Granular detail templates: reset the multi-entity selection, search, and
    // default-checked metrics for the newly-selected template.
    if (tpl.granular) {
      setEntityIds([]);
      setEntitySearch('');
      setSelectedMetrics(defaultMetrics(template));
      // Granular reports are multi-entity, not site/device-scoped. Clear any stale
      // scope left over from a previously-selected scoped template so saveReport
      // doesn't persist a bogus scope_type/scope_id for this report.
      setScopeMode('all');
      setSiteId('');
      setDeviceId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  // A custom range is only valid when both endpoints are set and from < to.
  const customRangeValid = range !== 'custom' || (!!from && !!to && new Date(from) < new Date(to));

  function canRun(): boolean {
    // Custom range must have both endpoints present and chronologically ordered.
    if (!customRangeValid) return false;
    // Granular detail reports need at least one selected entity.
    if (tpl.scope === 'apMulti' || tpl.scope === 'deviceMulti') return entityIds.length > 0;
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
    const controllerLabel = controllers.data?.find((c) => String(c.id) === controllerId)?.name || '';
    // Resolve selected entity ids → labelled refs for the multi-entity reports.
    let entities: EntityRef[] = [];
    if (tpl.scope === 'apMulti') {
      entities = entityIds.map((id) => {
        const ap = aps.data?.find((x) => String(x.id) === id);
        return { id, label: ap ? `${ap.name}${ap.ip_address ? ` (${ap.ip_address})` : ''}` : id };
      });
    } else if (tpl.scope === 'deviceMulti') {
      entities = entityIds.map((id) => {
        const d = devices.data?.find((x) => String(x.id) === id);
        return { id, label: d ? `${d.name}${d.ip_address ? ` (${d.ip_address})` : ''}` : id };
      });
    }
    setApplied({
      template, range, from, to, bucket, scopeMode, siteId, siteLabel, deviceId, deviceLabel,
      controllerId, controllerLabel, slaTarget, metric,
      entities, selectedMetrics: [...selectedMetrics],
    });
    setSaveName('');
    setShowSave(false);
  }

  // Active entity list (APs or devices) for the multi-select, filtered by search.
  const entityList: EntityRef[] = (() => {
    const q = entitySearch.toLowerCase();
    if (tpl.scope === 'apMulti') {
      return (aps.data || [])
        .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.ip_address || '').includes(entitySearch))
        .map((a) => ({ id: String(a.id), label: `${a.name}${a.ip_address ? ` (${a.ip_address})` : ''}${a.site_name ? ` · ${a.site_name}` : ''}` }));
    }
    if (tpl.scope === 'deviceMulti') {
      return (devices.data || [])
        .filter((d) => !q || d.name.toLowerCase().includes(q) || (d.ip_address || '').includes(entitySearch))
        .map((d) => ({ id: String(d.id), label: `${d.name}${d.ip_address ? ` (${d.ip_address})` : ''}` }));
    }
    return [];
  })();

  function toggleEntity(id: string) {
    setEntityIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function toggleMetric(key: string) {
    setSelectedMetrics((prev) => {
      if (!prev.includes(key)) return [...prev, key];
      // Keep at least one metric checked — block removing the last remaining one.
      if (prev.length === 1) return prev;
      return prev.filter((x) => x !== key);
    });
  }

  // Multi-entity detail reports fetch per entity (in EntityReportSection), so the
  // page-level single fetch is skipped for them.
  const isMulti = applied?.template === 'ap-detail' || applied?.template === 'device-detail';
  const endpoint = applied && !isMulti ? buildEndpoint(applied) : null;
  const report = useApi<any>(endpoint, 0);

  // loading = any in-flight fetch (incl. refetch on template switch) so we never
  // render a body with stale/mismatched data from the previous template.
  const loading = !!applied && !isMulti && report.loading;
  const empty = !!applied && !isMulti && !report.loading && !report.error && !!report.data
    && isEmptyReport(applied.template, report.data);

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
      setShowSave(false);
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
    setBucket('auto');
    setEntityIds([]);
    setSelectedMetrics(defaultMetrics(s.template));
    setApplied({
      template: s.template, range: s.date_range && s.date_range !== 'custom' ? s.date_range : '30d',
      from: '', to: '', bucket: 'auto', scopeMode: mode === 'site' || mode === 'device' ? mode : 'all',
      siteId: mode === 'site' && s.scope_id ? String(s.scope_id) : '',
      siteLabel, deviceId: mode === 'device' && s.scope_id ? String(s.scope_id) : '',
      deviceLabel, controllerId: '', controllerLabel: '',
      slaTarget: s.sla_target != null ? String(s.sla_target) : '99.5',
      metric: 'uptime',
      entities: [], selectedMetrics: defaultMetrics(s.template),
    });
    setShowSave(false);
    setTab('view'); // surface the loaded report in the workspace
  }

  // Select a template from the catalog rail: set the template and surface the View tab.
  function selectTemplate(key: string) {
    setTemplate(key);
    setTab('view');
  }

  const showScopeSelector = tpl.scope === 'flexible' || tpl.scope === 'flexibleNoDevice';

  return (
    <div>
      {/* Print-layout guard: collapse the two-pane wrappers in print so the report
          output (#report-print, absolutely positioned by globals.css) prints exactly
          as it did in the old single-scroll layout — no reserved-height blank pages,
          no overflow clipping, no card chrome. Scoped to this page's own classes. */}
      <style>{`
        @media print {
          .sv-rpt-2pane { display: block !important; height: auto !important; min-height: 0 !important; overflow: visible !important; }
          .sv-rpt-workspace { display: block !important; overflow: visible !important; border: none !important; background: transparent !important; border-radius: 0 !important; }
          .sv-rpt-tabcontent { display: block !important; overflow: visible !important; }
          #report-print.sv-report-output { padding: 0 !important; }
        }
      `}</style>

      {/* Page heading */}
      <div className="sv-no-print">
        <div className="page-title" style={{ marginBottom: 2 }}>Reports</div>
        <div className="page-subtitle" style={{ marginBottom: 14 }}>
          Run reports across your network — printable for management.
        </div>
      </div>

      {/* Two-pane layout: catalog rail (own scroll) + workspace (tab strip + content).
          NOT wrapped in .sv-no-print — the report output lives inside the View tab and
          must stay printable; chrome pieces are individually marked .sv-no-print. */}
      <div className="sv-rpt-2pane" style={{ display: 'flex', gap: 16, alignItems: 'stretch', height: 'calc(100vh - 200px)', minHeight: 480 }}>

        {/* ── LEFT RAIL — grouped report catalog ── */}
        <div className="sv-no-print" style={{
          width: 260, flexShrink: 0, background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: 12, display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <ReportsCatalog
            reports={CATALOG_REPORTS}
            groupOrder={GROUP_ORDER}
            activeKey={template}
            onSelect={selectTemplate}
          />
        </div>

        {/* ── RIGHT WORKSPACE ── */}
        <div className="sv-rpt-workspace" style={{
          flex: 1, minWidth: 0, background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
        }}>

          {/* Tab strip — View | Saved */}
          <div className="sv-no-print" style={{ display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
            {([
              { key: 'view' as const, label: 'View' },
              { key: 'saved' as const, label: `Saved (${saved.data?.length || 0})` },
            ]).map((t) => {
              const on = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  style={{
                    padding: '12px 14px', background: 'transparent', border: 'none',
                    borderBottom: on ? '2px solid var(--primary)' : '2px solid transparent',
                    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontSize: 'var(--text-base)', fontWeight: on ? 600 : 500, cursor: 'pointer',
                    marginBottom: -1, fontFamily: 'inherit',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Tab content (independently scrolls) */}
          <div className="sv-rpt-tabcontent" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

            {/* ── VIEW TAB ── */}
            {tab === 'view' && (
              <>
                {/* Selected-template header */}
                <div className="sv-no-print" style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span aria-hidden style={{ fontSize: 'var(--text-lg)', lineHeight: 1 }}>{tpl.icon}</span>
                    {tpl.label}
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4 }}>{tpl.desc}</div>
                </div>

                {/* Sticky config bar — opaque bg + z-index so scrolled report content
                    never bleeds through (suite sticky-header rule). */}
                <div className="sv-no-print" style={{
                  position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg-card)',
                  borderBottom: '1px solid var(--border-light)', boxShadow: '0 1px 0 var(--border)',
                  padding: '12px 18px',
                }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            {/* Wireless controller scope */}
            {tpl.wireless && (
              <label style={fieldLabel}>Controller
                <select style={ctrlBase} value={controllerId} onChange={(e) => setControllerId(e.target.value)}>
                  <option value="">All Controllers</option>
                  {controllers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            {/* Scope */}
            {showScopeSelector && (
              <label style={fieldLabel}>Scope
                <select style={ctrlBase} value={scopeMode} onChange={(e) => setScopeMode(e.target.value as any)}>
                  <option value="all">All</option>
                  <option value="site">Site</option>
                  {tpl.scope === 'flexible' && <option value="device">Device</option>}
                </select>
              </label>
            )}
            {(tpl.scope === 'site' || (showScopeSelector && scopeMode === 'site')) && (
              <label style={fieldLabel}>Site
                <select style={ctrlBase} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  <option value="">Select…</option>
                  {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            {(tpl.scope === 'device' || (tpl.scope === 'flexible' && scopeMode === 'device')) && (
              <>
                <label style={fieldLabel}>Search
                  <input style={{ ...ctrlBase, width: 150 }} placeholder="Name or IP…" value={deviceSearch}
                    onChange={(e) => setDeviceSearch(e.target.value)} />
                </label>
                <label style={fieldLabel}>Device
                  <select style={ctrlBase} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                    <option value="">Select…</option>
                    {filteredDevices.slice(0, 100).map((d) => <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>)}
                  </select>
                </label>
              </>
            )}

            {/* Granular detail: one-or-many entity multi-select (AP or device) */}
            {(tpl.scope === 'apMulti' || tpl.scope === 'deviceMulti') && (
              <EntityMultiSelect
                noun={tpl.scope === 'apMulti' ? 'AP' : 'Device'}
                search={entitySearch}
                onSearch={setEntitySearch}
                list={entityList}
                selected={entityIds}
                onToggle={toggleEntity}
                onClear={() => setEntityIds([])}
                loading={tpl.scope === 'apMulti' ? aps.loading : devices.loading}
              />
            )}

            {/* Granular detail: metric checkboxes (per active template) */}
            {tpl.granular && (DETAIL_METRICS[template] || []).length > 0 && (
              <label style={fieldLabel}>Metrics
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {DETAIL_METRICS[template].map((m) => {
                    const on = selectedMetrics.includes(m.key);
                    return (
                      <button key={m.key} type="button" style={presetBtn(on)} onClick={() => toggleMetric(m.key)}>
                        {on ? '✓ ' : ''}{m.label}
                      </button>
                    );
                  })}
                </div>
              </label>
            )}

            {/* Granular detail: resolution / bucket selector */}
            {tpl.granular && (
              <label style={fieldLabel}>Resolution
                <select style={ctrlBase} value={bucket} onChange={(e) => setBucket(e.target.value)}>
                  {BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                </select>
              </label>
            )}

            {/* Metric (top-worst only) */}
            {tpl.metric && (
              <label style={fieldLabel}>Metric
                <select style={ctrlBase} value={metric} onChange={(e) => setMetric(e.target.value)}>
                  {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </label>
            )}

            {/* SLA target */}
            {tpl.sla && (
              <label style={fieldLabel}>SLA %
                <input style={{ ...ctrlBase, width: 70 }} type="number" step="0.1" value={slaTarget}
                  onChange={(e) => setSlaTarget(e.target.value)} />
              </label>
            )}

            {/* Date range presets */}
            <label style={fieldLabel}>Range
              <div style={{ display: 'flex', gap: 4 }}>
                {RANGES.map((r) => (
                  <button key={r.key} type="button" style={presetBtn(range === r.key)}
                    onClick={() => setRange(r.key)}>{r.label}</button>
                ))}
                <button type="button" style={presetBtn(range === 'custom')}
                  onClick={() => setRange('custom')}>Custom</button>
              </div>
            </label>
            {range === 'custom' && (
              <>
                <label style={fieldLabel}>From
                  <input style={ctrlBase} type={tpl.granular ? 'datetime-local' : 'date'}
                    value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label style={fieldLabel}>To
                  <input style={ctrlBase} type={tpl.granular ? 'datetime-local' : 'date'}
                    value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
                {!customRangeValid && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--tint-danger-fg)', textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                    Pick a valid start and end
                  </span>
                )}
              </>
            )}

            <div style={{ flex: 1 }} />
            <button style={{ ...presetBtn(true), padding: '0 16px' }} onClick={runReport} disabled={!canRun()}
              {...(!canRun() ? { 'aria-disabled': true } : {})}>
              Run Report →
            </button>
                  </div>
                </div>

                {/* Report output — on screen this sits below the sticky config bar;
                    in print it is the ONLY visible subtree (globals.css). Not wrapped
                    in .sv-no-print so it stays printable. */}
                {applied ? (
                <div className="sv-report-output" id="report-print" style={{ padding: '16px 18px' }}>
          {/* Print-only repeating page footer (brand · confidential · generated). */}
          <div className="sv-print-footer">
            <span>SpanVault · NocVault Suite</span>
            <span>Confidential</span>
            <span>Generated {new Date().toLocaleDateString()} by {userName}</span>
          </div>
          {/* Print-only report cover / letterhead */}
          <div
            className="sv-print-only sv-print-head"
            style={{
              display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
              gap: 16, paddingBottom: 12, marginBottom: 16,
              borderBottom: '2px solid var(--primary)',
            }}
          >
            <div>
              <div className="brand" style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--primary)', lineHeight: 1.1 }}>
                SpanVault
              </div>
              <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginTop: 2 }}>
                NocVault Suite · Network Monitoring
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1 }}>
                {tpl.label}
              </div>
              <div className="meta" style={{ margin: '4px 0 0' }}>
                {rangeLabel(applied)} · {scopeLabel(applied)}
              </div>
              <div className="meta" style={{ margin: '2px 0 0' }}>
                Generated by {userName} on {new Date().toLocaleString()}
              </div>
            </div>
          </div>

          {/* On-screen output header: report title + meta, Export PDF (top-right) */}
          <div className="sv-no-print" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, margin: '0 0 16px', paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
            <div>
              <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0, lineHeight: 1.2 }}>
                {tpl.label}
              </h1>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 4 }}>
                {rangeLabel(applied)} · {scopeLabel(applied)} · Generated by {userName} on {new Date().toLocaleDateString()}
              </div>
            </div>
            {(isMulti || (!empty && !loading && !report.error)) && (
              <button onClick={() => window.print()}
                style={{ ...presetBtn(false), padding: '0 14px', flex: 'none' }}>
                Export PDF
              </button>
            )}
          </div>

          {isMulti ? (
            /* Multi-entity detail report: one charted section per AP/device, each
               fetching its own endpoint with a per-entity loading/error state. */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              {applied.entities.map((ent) => (
                <EntityReportSection
                  key={`${applied.template}-${ent.id}`}
                  template={applied.template}
                  entity={ent}
                  endpoint={buildEntityEndpoint(applied.template, ent.id, applied)}
                  selectedMetrics={applied.selectedMetrics}
                />
              ))}
            </div>
          ) : report.error ? (
            <ErrorBox message={report.error} />
          ) : loading ? (
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
                ) : (
                  <div className="sv-no-print" style={{ padding: 48, textAlign: 'center' }}>
                    <p className="sv-muted" style={{ margin: 0 }}>
                      Configure the options above and choose “Run Report →” to generate the {tpl.label} report.
                    </p>
                  </div>
                )}
              </>
            )}

            {/* ── SAVED TAB — the existing saved-reports UI ── */}
            {tab === 'saved' && (
              <div className="sv-no-print" style={{ padding: 18 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 2 }}>
                    Saved:
                  </span>
                  {(saved.data?.length || 0) === 0 && (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>none yet</span>
                  )}
                  {saved.data?.map((s) => (
                    <span key={s.id} style={{
                      display: 'inline-flex', alignItems: 'center', height: 24,
                      border: '1px solid var(--border)', borderRadius: 999, overflow: 'hidden',
                      background: 'var(--bg-card)',
                    }}>
                      <button onClick={() => loadSaved(s)} title={`Load "${s.name}"`}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)', padding: '0 8px', height: 24 }}>
                        {s.name}
                      </button>
                      <button onClick={() => deleteSaved(s.id)} title="Delete"
                        style={{ border: 'none', borderLeft: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: '0 7px', height: 24, fontSize: 'var(--text-sm)' }}>
                        ×
                      </button>
                    </span>
                  ))}
                  {applied && !empty && !loading && !showSave && (
                    <button onClick={() => setShowSave(true)}
                      style={{ display: 'inline-flex', alignItems: 'center', height: 24, border: '1px dashed var(--border)', borderRadius: 999, background: 'var(--bg-card)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--primary)', padding: '0 10px' }}>
                      + Save this report
                    </button>
                  )}
                  {applied && !empty && !loading && showSave && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <input style={{ ...ctrlBase, height: 24, fontSize: 'var(--text-xs)', width: 170 }} placeholder="Name this report…"
                        value={saveName} autoFocus onChange={(e) => setSaveName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveReport(); if (e.key === 'Escape') setShowSave(false); }} />
                      <button onClick={saveReport} disabled={saving || !saveName.trim()}
                        style={{ ...presetBtn(true), height: 24, padding: '0 10px', fontSize: 'var(--text-xs)', opacity: saving || !saveName.trim() ? 0.5 : 1 }}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => { setShowSave(false); setSaveName(''); }}
                        style={{ ...presetBtn(false), height: 24, padding: '0 9px', fontSize: 'var(--text-xs)' }}>
                        ×
                      </button>
                    </span>
                  )}
                </div>
                {applied && !empty && !loading && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 10 }}>
                    Saving stores the current report’s template, scope and date range so you can re-run it later.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
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
    case 'wireless-overview':  return <WirelessOverviewReport data={data} />;
    case 'wireless-ap-health': return <WirelessAPHealthReport data={data} />;
    case 'wireless-clients':   return <WirelessClientReport data={data} />;
    case 'wireless-rf':        return <WirelessRFReport data={data} />;
    case 'wireless-capacity':  return <WirelessCapacityReport data={data} />;
    default: return null;
  }
}

// ── Entity multi-select (top-level component) ──────────────────
// Search box + scrollable checkbox list for picking one OR many APs/devices.
// Reuses the existing device-picker search pattern (name/IP).
function EntityMultiSelect({
  noun, search, onSearch, list, selected, onToggle, onClear, loading,
}: {
  noun: string;
  search: string;
  onSearch: (v: string) => void;
  list: EntityRef[];
  selected: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  loading: boolean;
}) {
  return (
    // NOTE: must NOT be a <label> — a label forwards every click inside it to its
    // first control (the search input), so clicking a row never toggled the checkbox.
    <div style={{ ...fieldLabel, alignItems: 'flex-start', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {noun}s
        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: selected.length ? 'var(--primary)' : 'var(--text-muted)' }}>
          {selected.length ? `${selected.length} selected` : 'pick one or many'}
        </span>
        {selected.length > 0 && (
          <button type="button" onClick={onClear}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', textDecoration: 'underline', padding: 0 }}>
            clear
          </button>
        )}
      </span>
      <input style={{ ...ctrlBase, width: 340 }} placeholder={`Search ${noun} name or IP…`}
        value={search} onChange={(e) => onSearch(e.target.value)} />
      <div style={{
        width: 340, maxHeight: 200, overflowY: 'auto',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-card)', padding: 4,
      }}>
        {loading ? (
          <div style={{ padding: '6px 8px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: '6px 8px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No matches</div>
        ) : (
          list.slice(0, 200).map((e) => {
            const on = selected.includes(e.id);
            return (
              <div key={e.id} onClick={() => onToggle(e.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                  cursor: 'pointer', borderRadius: 'var(--radius-sm)',
                  background: on ? 'var(--surface-subtle)' : 'transparent',
                  fontSize: 'var(--text-sm)', fontWeight: 500, textTransform: 'none', letterSpacing: 0,
                  color: 'var(--text-primary)',
                }}>
                <input type="checkbox" checked={on} readOnly tabIndex={-1} style={{ pointerEvents: 'none', flexShrink: 0 }} />
                <span title={e.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Per-entity report section (top-level component) ────────────
// Fetches its own detail endpoint and renders the matching report component once
// per AP/device, with an independent loading / error / empty state.
function EntityReportSection({
  template, entity, endpoint, selectedMetrics,
}: {
  template: string;
  entity: EntityRef;
  endpoint: string;
  selectedMetrics: string[];
}) {
  const r = useApi<any>(endpoint, 0);
  return (
    <section className="sv-report-entity">
      <div style={{
        fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-secondary)',
        textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px',
      }}>
        {template === 'ap-detail' ? 'AP' : 'Device'}: {entity.label}
      </div>
      {r.error ? (
        <ErrorBox message={r.error} />
      ) : r.loading ? (
        <div className="sv-panel" style={{ textAlign: 'center', padding: '28px 20px' }}>
          <Loading label={`Loading ${entity.label}…`} />
        </div>
      ) : !r.data ? (
        <div className="sv-panel" style={{ textAlign: 'center', padding: '28px 20px' }}>
          <p className="sv-muted" style={{ margin: 0 }}>No data for {entity.label}.</p>
        </div>
      ) : template === 'ap-detail' ? (
        <ApDetailReport data={r.data} selectedMetrics={selectedMetrics} />
      ) : (
        <DeviceDetailReport data={r.data} selectedMetrics={selectedMetrics} />
      )}
    </section>
  );
}

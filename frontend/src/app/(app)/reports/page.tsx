'use client';

import { useEffect, useMemo, useState, type ComponentType, type SVGProps } from 'react';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { ErrorBox, Loading } from '@/components/ui';
import {
  IconClipboard, IconReports, IconBuilding, IconCheckCircle, IconTrendingUp,
  IconWarning, IconBell, IconWireless, IconAntenna, IconUsers, IconActivity,
  IconGauge, IconShield, IconTransfer, IconMonitor, IconPlug,
  IconCalendar, IconMail, IconDatabase, IconInfo, IconHistory, IconLayers,
  IconClock, IconCheck, IconClose,
} from '@/components/icons';
import NetworkSummaryReport from '@/components/reports/NetworkSummaryReport';
import SiteReport from '@/components/reports/SiteReport';
import DeviceDetailReport from '@/components/reports/DeviceDetailReport';
import ApDetailReport from '@/components/reports/ApDetailReport';
import ServiceDetailReport from '@/components/reports/ServiceDetailReport';
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
import WirelessSecurityReport from '@/components/reports/WirelessSecurityReport';
import WirelessBandwidthReport from '@/components/reports/WirelessBandwidthReport';
import ReportsCatalog, { CatalogReport } from '@/components/reports/ReportsCatalog';

// ── Types ──────────────────────────────────────────────────────
type Site = { id: number; name: string };
type DeviceLite = { id: number; name: string; ip_address: string };
type ApLite = { id: number; name: string; ip_address: string | null; site_name: string | null };
type ServiceLite = { id: number; name: string; type: string; target: string; site_name: string | null };
type Controller = { id: number; name: string };
// One selected entity (AP, device, or service) rendered as its own report section.
type EntityRef = { id: string; label: string };
type SavedReport = {
  id: number; name: string; template: string; scope_type: string;
  scope_id: number | null; scope_name: string | null; date_range: string;
  sla_target: number | null;
  // Multi-entity detail reports (AP/Device/Service Detail) persist their selected
  // entity ids here so the selection survives a save/reload (backend scope_ids column).
  scope_ids: number[] | null;
  // Schedule columns — GET /api/reports/saved is a `SELECT *`, so these have always
  // been on the wire; the page just never typed or used them.
  schedule?: string | null;
  schedule_day?: number | null;
  schedule_hour?: number | null;
  recipients?: string | null;
  next_run_at?: string | null;
  last_sent_at?: string | null;
  created_at?: string | null;
  created_by?: string | null;
};
// GET /api/reports/schedules — every saved report with an email cadence, plus the
// most recent delivery attempts across all of them.
type ScheduleRow = {
  id: number; name: string; template: string;
  scope_type: string; scope_id: number | null; scope_name: string | null;
  date_range: string; schedule: string; schedule_day: number | null; schedule_hour: number | null;
  recipients: string | null; next_run_at: string | null; last_sent_at: string | null;
  created_by: string | null; created_at: string | null;
  last_run_at: string | null; last_status: string | null; last_error: string | null;
};
type HistoryRow = {
  id: number; report_id: number; run_at: string; status: string;
  error: string | null; recipients: string | null;
  report_name: string | null; template: string | null;
};
type SchedulesPayload = { schedules: ScheduleRow[]; recent: HistoryRow[] };
// Scope modes a template supports.
// 'apMulti'/'deviceMulti'/'serviceMulti' = Phase-1 granular detail reports: pick
// one or many entities, each rendered as its own charted section.
type ScopeKind = 'all' | 'site' | 'device' | 'flexible' | 'flexibleNoDevice' | 'apMulti' | 'deviceMulti' | 'serviceMulti';
type IconComp = ComponentType<SVGProps<SVGSVGElement>>;
type Template = {
  // `Icon` is a component from components/icons.tsx — the rail used to render a
  // literal emoji here, which renders differently per-platform and ignores the
  // theme. Every other page in the app already uses this SVG set.
  key: string; Icon: IconComp; label: string; desc: string;
  scope: ScopeKind; sla?: boolean; metric?: boolean; wireless?: boolean;
  // granular = uses the flexible time range / bucket / metric-checkbox controls.
  granular?: boolean;
  // category = left-rail catalog grouping (display metadata only; does not affect
  // report generation).
  category: string;
};
type Applied = {
  template: string; range: string; from: string; to: string; bucket: string;
  // Resolved ISO from/to frozen at Run time so the granular per-entity endpoint
  // string is stable across unrelated re-renders (typing, tab switch). Without
  // this, granularRangeParams recomputes `to` via new Date() every render, which
  // changes the endpoint and refires EntityReportSection's fetch effect.
  resolvedFrom: string; resolvedTo: string;
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
  { key: 'executive', Icon: IconClipboard, label: 'Executive', desc: 'Management-level overview with recommendations', scope: 'all', category: 'Overview' },
  { key: 'network-summary', Icon: IconReports, label: 'Network Summary', desc: 'Overall health across all sites and devices', scope: 'all', category: 'Overview' },
  { key: 'site-summary', Icon: IconBuilding, label: 'Site Report', desc: 'All devices in a site with comparison table', scope: 'site', category: 'Overview' },
  { key: 'sla-compliance', Icon: IconCheckCircle, label: 'SLA Compliance', desc: 'Pass/fail per device vs SLA target', scope: 'flexible', sla: true, category: 'Performance & SLA' },
  { key: 'capacity', Icon: IconTrendingUp, label: 'Capacity', desc: 'Bandwidth trends and utilization projections', scope: 'flexibleNoDevice', category: 'Performance & SLA' },
  { key: 'top-worst', Icon: IconWarning, label: 'Top 10 Worst', desc: 'Lowest availability, highest latency or most alerts', scope: 'flexibleNoDevice', metric: true, category: 'Performance & SLA' },
  { key: 'alert-analysis', Icon: IconBell, label: 'Alerts & Anomalies', desc: 'Most alerted devices, MTTR, and patterns', scope: 'flexibleNoDevice', category: 'Performance & SLA' },
  { key: 'wireless-overview', Icon: IconWireless, label: 'Wireless Overview', desc: 'AP status, clients and utilization across all sites', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-ap-health', Icon: IconAntenna, label: 'Wireless AP Health', desc: 'Per-AP health scores, channels and utilization', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-clients', Icon: IconUsers, label: 'Wireless Client', desc: 'Client distribution, problem clients and roaming', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-rf', Icon: IconActivity, label: 'Wireless RF', desc: 'Co-channel interference, band steering and RF scores', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-capacity', Icon: IconGauge, label: 'Wireless Capacity', desc: 'AP capacity usage and client growth trends', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-security', Icon: IconShield, label: 'Wireless Security', desc: 'Rogue AP detections and SSID encryption posture', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'wireless-bandwidth', Icon: IconTransfer, label: 'Wireless Bandwidth', desc: 'Top bandwidth-consuming clients over time', scope: 'all', wireless: true, category: 'Wireless' },
  { key: 'device-detail', Icon: IconMonitor, label: 'Device Detail', desc: 'Time-series charts, history and metrics for one or more devices', scope: 'deviceMulti', granular: true, category: 'Detail' },
  { key: 'ap-detail', Icon: IconAntenna, label: 'AP Detail', desc: 'Time-series charts, clients, RF and throughput for one or more access points', scope: 'apMulti', granular: true, category: 'Detail' },
  { key: 'service-detail', Icon: IconPlug, label: 'Service Detail', desc: 'Status history, response time and alerts for one or more service checks', scope: 'serviceMulti', granular: true, category: 'Detail' },
];
const TEMPLATE_BY_KEY: Record<string, Template> = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

// ── Per-template briefing metadata ─────────────────────────────
// `includes` = the sections the on-screen report actually renders (taken from the
// matching component in components/reports/, using its own wording).
// `sources`  = the spanvault tables the matching /api/reports/<key> handler reads.
// This is documentation of what already exists, kept next to the templates so the
// two stay in step — it is NOT computed and does not affect report generation.
// `covers` picks which live estate count the header line quotes.
type TemplateMeta = { includes: string[]; sources: string[]; covers: 'devices' | 'wireless' | 'services' | 'none' };
const TEMPLATE_META: Record<string, TemplateMeta> = {
  executive: {
    includes: ['Headline & reporting period', 'Uptime / incidents / downtime / service uptime KPIs', 'Network performance vs previous period', 'Sites summary with health grade', 'Recommendations'],
    sources: ['ping_results', 'monitored_devices', 'alerts', 'incidents', 'service_check_results', 'snmp_results', 'device_health_scores'],
    covers: 'devices',
  },
  'network-summary': {
    includes: ['Devices / uptime / alerts / avg response / MTTR KPIs', 'Per-site breakdown table', 'Key findings', 'Top issues', 'Health grade distribution'],
    sources: ['monitored_devices', 'ping_results', 'alerts', 'snmp_results', 'device_health_scores'],
    covers: 'devices',
  },
  'site-summary': {
    includes: ['Devices / up / down / uptime KPIs for the site', 'Site analysis narrative', 'Per-device table with SLA + health grade'],
    sources: ['monitored_devices', 'ping_results', 'alerts', 'device_health_scores'],
    covers: 'devices',
  },
  'sla-compliance': {
    includes: ['SLA target, meeting / failing counts', 'Overall uptime, total downtime, service uptime', 'Per-device pass/fail table with downtime minutes', 'Risk assessment'],
    sources: ['monitored_devices', 'ping_results', 'alerts', 'service_checks', 'service_check_results'],
    covers: 'devices',
  },
  capacity: {
    includes: ['Per-interface average in/out throughput', 'Peak in/out and trend direction', '30 / 60 / 90-day utilization projections', 'At-risk interface flagging'],
    sources: ['snmp_results', 'monitored_devices'],
    covers: 'devices',
  },
  'top-worst': {
    includes: ['Ranked bottom-10 table for the chosen metric', 'Per-device site and scored bar', 'Metric is selectable: availability, response time or alerts'],
    sources: ['monitored_devices', 'ping_results', 'alerts', 'device_health_scores'],
    covers: 'devices',
  },
  'alert-analysis': {
    includes: ['Total alerts, average MTTR, busiest hour', 'Top alerted devices', 'Breakdown by type and by severity', 'Breakdown by site'],
    sources: ['alerts', 'monitored_devices', 'service_checks'],
    covers: 'devices',
  },
  'wireless-overview': {
    includes: ['Controllers / APs / online / offline / clients KPIs', 'Average utilization and overall health score', 'Site breakdown', 'Top APs by clients and top SSIDs', 'Offline AP list'],
    sources: ['wireless_aps', 'wireless_controllers', 'wireless_intelligence', 'wireless_ssids'],
    covers: 'wireless',
  },
  'wireless-ap-health': {
    includes: ['Total / online / offline AP counts', 'Average health score, overloaded and high-util counts', 'Per-AP table: status, clients, channels, util, noise, uptime, grade'],
    sources: ['wireless_aps', 'wireless_controllers', 'wireless_ap_intelligence'],
    covers: 'wireless',
  },
  'wireless-clients': {
    includes: ['Total, problem, low-signal and frequently-roaming clients', '24h roaming events and band split', 'Band distribution', 'Problem-client list and busiest APs'],
    sources: ['wireless_clients', 'wireless_client_events'],
    covers: 'wireless',
  },
  'wireless-rf': {
    includes: ['Overall, interference, band-steering and load-balance scores', 'Measured 2.4 / 5 GHz interference and reporting AP counts', 'Recommendations', 'Channel distribution and AP grade distribution'],
    sources: ['wireless_intelligence', 'wireless_aps', 'wireless_ap_intelligence'],
    covers: 'wireless',
  },
  'wireless-capacity': {
    includes: ['Licensed vs used APs and capacity %', 'Average clients per AP, peak clients, growth rate', '30-day client trend', 'Growth projection and high-utilization APs'],
    sources: ['wireless_controllers', 'wireless_aps', 'wireless_history'],
    covers: 'wireless',
  },
  'wireless-security': {
    includes: ['Rogue APs detected, needs-attention and informational counts', 'SSIDs configured and weak / no-encryption counts', 'Recommendations', 'Rogue & neighbouring AP detections', 'SSID encryption posture'],
    sources: ['wireless_rogue_aps', 'wireless_controllers', 'wireless_ssids'],
    covers: 'wireless',
  },
  'wireless-bandwidth': {
    includes: ['Clients with bandwidth data', 'Average bandwidth and top client average', 'Top clients by bandwidth over the window'],
    sources: ['wireless_client_history', 'wireless_controllers', 'wireless_clients'],
    covers: 'wireless',
  },
  'device-detail': {
    includes: ['Uptime, average response, alerts and downtime per device', '90-day availability strip and response-time history', 'Latency & packet loss, CPU, memory, sessions charts', 'Per-interface throughput and SNMP metrics', 'Alert history and connected devices'],
    sources: ['monitored_devices', 'ping_results', 'snmp_results', 'alerts', 'device_sensors', 'topology_links'],
    covers: 'devices',
  },
  'ap-detail': {
    includes: ['Uptime, samples, down events and disconnects per AP', 'Connected clients, radio utilization, noise floor and throughput charts', 'RF intelligence', 'Current clients and recent events'],
    sources: ['wireless_aps', 'wireless_history', 'wireless_ap_intelligence', 'wireless_clients', 'wireless_client_events'],
    covers: 'wireless',
  },
  'service-detail': {
    includes: ['Uptime, average response, alerts and downtime per check', '90-day status history strip', 'Response-time chart', 'Alert history'],
    sources: ['service_checks', 'service_check_results', 'alerts', 'agents'],
    covers: 'services',
  },
};

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
  'service-detail': [
    { key: 'response_time', label: 'Response Time', def: true },
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
  // Use the from/to resolved once at Run time (frozen in `applied`) — never
  // new Date() here, or the endpoint string changes on every render and refires
  // the per-entity fetch effect.
  if (a.resolvedFrom) p.set('from', a.resolvedFrom);
  if (a.resolvedTo) p.set('to', a.resolvedTo);
  // For preset ranges, also pass the preset name so the API can fall back to
  // `range` if it prefers. (Custom ranges carry only explicit from/to.)
  if (a.range !== 'custom') p.set('range', a.range);
  p.set('bucket', a.bucket || 'auto');
  return p;
}

// Resolve the effective ISO from/to for a report at Run time. Custom → the picked
// endpoints; preset → computed once from the preset window. Frozen into `applied`.
function resolveRange(range: string, from: string, to: string): { from: string; to: string } {
  if (range === 'custom') {
    return {
      from: from ? new Date(from).toISOString() : '',
      to: to ? new Date(to).toISOString() : '',
    };
  }
  return presetToIso(range);
}
// Per-entity endpoint for a multi-entity detail report.
//   ap-detail      → GET /api/reports/ap-detail/:id?from=&to=&bucket=
//   device-detail  → GET /api/reports/device-detail?device_id=&from=&to=&bucket=
//   service-detail → GET /api/reports/service-detail?service_check_id=&from=&to=&bucket=
function buildEntityEndpoint(template: string, entityId: string, a: Applied): string {
  const p = granularRangeParams(a);
  if (template === 'ap-detail') {
    return `/api/reports/ap-detail/${encodeURIComponent(entityId)}?${p}`;
  }
  if (template === 'service-detail') {
    p.set('service_check_id', entityId);
    return `/api/reports/service-detail?${p}`;
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

// Server-side PDF export URL for the applied report — routes the SAME params the
// on-screen report uses to the pdfkit endpoint (GET /api/reports/pdf/:template).
// Granular detail reports pass their selected entity ids + chosen metric keys.
function buildPdfUrl(a: Applied): string {
  const base = `/api/reports/pdf/${encodeURIComponent(a.template)}`;
  if (a.template === 'ap-detail' || a.template === 'device-detail' || a.template === 'service-detail') {
    const p = granularRangeParams(a);
    p.set('entity_ids', a.entities.map((e) => e.id).join(','));
    if (a.selectedMetrics.length) p.set('metrics', a.selectedMetrics.join(','));
    return `${base}?${p}`;
  }
  const q = buildEndpoint(a).split('?')[1] || '';
  return q ? `${base}?${q}` : base;
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
    case 'service-detail':  return !data.service;
    case 'executive':       return false; // executive always renders a summary
    case 'wireless-overview':  return !data.summary || data.summary.total_aps === 0;
    case 'wireless-ap-health': return !data.aps || data.aps.length === 0;
    case 'wireless-clients':   return !data.summary || data.summary.total_clients === 0;
    case 'wireless-rf':        return false; // always renders score/recommendations
    case 'wireless-capacity':  return !data || (data.used_aps === 0 && (!data.client_trend || data.client_trend.length === 0));
    case 'wireless-security':  return false; // always renders summary KPI tiles, even at zero
    case 'wireless-bandwidth': return !data.clients || data.clients.length === 0;
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
// Display noun for a multi-entity detail template's selected items.
function detailNoun(template: string): string {
  if (template === 'ap-detail') return 'AP';
  if (template === 'service-detail') return 'Service';
  return 'Device';
}
function scopeLabel(a: Applied): string {
  if (a.template === 'ap-detail' || a.template === 'device-detail' || a.template === 'service-detail') {
    const noun = detailNoun(a.template);
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

// ── Schedule formatting helpers (top-level) ────────────────────
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CADENCE_OPTIONS = [
  { key: 'none', label: 'Not scheduled' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];
// "Weekly · Monday 07:00" — the cadence exactly as api/reportScheduler.js's
// calculateNextRun() interprets it (hour defaults to 7, weekly day defaults to Monday).
function cadenceLabel(s: { schedule?: string | null; schedule_day?: number | null; schedule_hour?: number | null }): string {
  const hour = s.schedule_hour != null ? s.schedule_hour : 7;
  const at = `${String(hour).padStart(2, '0')}:00`;
  if (s.schedule === 'daily') return `Daily · ${at}`;
  if (s.schedule === 'weekly') return `Weekly · ${DAY_NAMES[s.schedule_day != null ? s.schedule_day : 1]} ${at}`;
  if (s.schedule === 'monthly') return `Monthly · 1st ${at}`;
  return 'Not scheduled';
}
function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
// "in 4h 20m" / "2d ago" — relative to now, for next_run_at / last_sent_at.
function fmtRelative(v: string | null | undefined): string {
  if (!v) return '';
  const t = new Date(v).getTime();
  if (isNaN(t)) return '';
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let out: string;
  if (mins < 1) out = 'less than a minute';
  else if (mins < 60) out = `${mins}m`;
  else if (mins < 60 * 24) out = `${Math.floor(mins / 60)}h ${mins % 60}m`;
  else out = `${Math.round(mins / (60 * 24))}d`;
  return diff >= 0 ? `in ${out}` : `${out} ago`;
}
function recipientList(v: string | null | undefined): string[] {
  return String(v || '').split(',').map((e) => e.trim()).filter(Boolean);
}
// Live estate scale for the briefing header — read off the lists the page already
// fetches, so this costs no extra request and is never a made-up number.
function coverageLine(
  tplKey: string,
  counts: { sites: number; devices: number; aps: number; services: number; controllers: number },
): string | null {
  const meta = TEMPLATE_META[tplKey];
  if (!meta) return null;
  const n = (v: number) => v.toLocaleString();
  if (meta.covers === 'wireless') {
    if (!counts.aps && !counts.controllers) return null;
    return `${n(counts.aps)} access point${counts.aps === 1 ? '' : 's'} on ${n(counts.controllers)} controller${counts.controllers === 1 ? '' : 's'} currently monitored`;
  }
  if (meta.covers === 'services') {
    if (!counts.services) return null;
    return `${n(counts.services)} service check${counts.services === 1 ? '' : 's'} currently monitored`;
  }
  if (meta.covers === 'devices') {
    if (!counts.devices) return null;
    return `${n(counts.devices)} device${counts.devices === 1 ? '' : 's'} across ${n(counts.sites)} site${counts.sites === 1 ? '' : 's'} currently monitored`;
  }
  return null;
}

// Summarise what the config bar is currently set to — i.e. exactly what
// "Run Report →" will use. Read off live state (nothing has been run yet), so a
// preset window is resolved the same way runReport() resolves it.
// `mounted` gates the resolved absolute window: a preset range resolves against
// `new Date()` and renders through `toLocaleString()`, so computing it during SSR
// and again on the client produces two different strings and React throws a
// hydration mismatch (caught live). Until mount we show the preset name only.
function pendingConfigRows(a: {
  tpl: Template; range: string; from: string; to: string; bucket: string;
  scopeMode: string; siteLabel: string; deviceLabel: string; controllerLabel: string;
  slaTarget: string; metric: string; entityCount: number; mounted: boolean;
}): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const fmt = (iso: string) => {
    if (!iso) return '…';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '…' : d.toLocaleString();
  };
  const presetName = a.range === 'custom'
    ? 'Custom'
    : (RANGES.find((x) => x.key === a.range)?.label || a.range);
  if (a.mounted) {
    const r = resolveRange(a.range, a.from, a.to);
    rows.push({ label: 'Window', value: `${presetName} · ${fmt(r.from)} → ${fmt(r.to)}` });
  } else {
    rows.push({ label: 'Window', value: presetName });
  }

  if (a.tpl.scope === 'apMulti' || a.tpl.scope === 'deviceMulti' || a.tpl.scope === 'serviceMulti') {
    const noun = detailNoun(a.tpl.key);
    rows.push({
      label: 'Selection',
      value: a.entityCount
        ? `${a.entityCount} ${noun.toLowerCase()}${a.entityCount === 1 ? '' : 's'} selected`
        : `No ${noun.toLowerCase()} selected yet — pick at least one to run`,
    });
  } else if (a.tpl.wireless) {
    rows.push({ label: 'Scope', value: a.controllerLabel || 'All controllers' });
  } else if (a.scopeMode === 'site') {
    rows.push({ label: 'Scope', value: a.siteLabel ? `Site: ${a.siteLabel}` : 'Site: not chosen yet' });
  } else if (a.scopeMode === 'device') {
    rows.push({ label: 'Scope', value: a.deviceLabel ? `Device: ${a.deviceLabel}` : 'Device: not chosen yet' });
  } else {
    rows.push({ label: 'Scope', value: 'All sites' });
  }

  if (a.tpl.granular) {
    rows.push({ label: 'Resolution', value: BUCKETS.find((b) => b.key === a.bucket)?.label || a.bucket });
  }
  if (a.tpl.sla) rows.push({ label: 'SLA target', value: `${a.slaTarget || '99.5'}%` });
  if (a.tpl.metric) rows.push({ label: 'Ranked by', value: METRICS.find((m) => m.key === a.metric)?.label || a.metric });
  rows.push({ label: 'Output', value: 'On screen, plus a server-rendered PDF via Export PDF' });
  return rows;
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
// Briefing/schedule panel chrome. Local to this page — globals.css is shared and
// deliberately not touched for a single page's layout.
const panelBox: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  background: 'var(--bg-card)', padding: 14, minWidth: 0,
};
const panelHead: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10,
  fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.05em',
  textTransform: 'uppercase', color: 'var(--text-muted)',
};
const chip = (tint: string, fg: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 8px',
  borderRadius: 'var(--radius-pill)', background: tint, color: fg,
  fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap',
});
const srcChip: React.CSSProperties = {
  display: 'inline-block', padding: '2px 7px', borderRadius: 'var(--radius-sm)',
  background: 'var(--surface-subtle)', color: 'var(--text-secondary)',
  fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)',
};

export default function ReportsPage() {
  const { data: session } = useSession();
  // Reports writes (save / schedule / send-now) are site_admin+ server-side
  // (ROLE_RANK in api/server.js) — only a viewer is read-only.
  const { role } = useRbac();
  const canWrite = role !== 'viewer';
  const email = session?.user?.email || '';
  const userName = session?.user?.name || email || 'Unknown user';
  const sites = useApi<Site[]>('/api/netvault/sites');
  const devices = useApi<DeviceLite[]>('/api/devices');
  const aps = useApi<ApLite[]>('/api/wireless/aps');
  const services = useApi<ServiceLite[]>('/api/service-checks');
  const controllers = useApi<Controller[]>('/api/wireless/controllers');
  const saved = useApi<SavedReport[]>(email ? `/api/reports/saved?created_by=${encodeURIComponent(email)}` : '/api/reports/saved');
  // Scheduled email deliveries + recent delivery attempts, estate-wide (not filtered
  // by created_by — a schedule is an operational fact of the system, not a personal
  // bookmark, and the route site-scopes it server-side).
  const schedules = useApi<SchedulesPayload>('/api/reports/schedules');

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
  // Server-side PDF export state (replaces window.print).
  const [exporting, setExporting] = useState(false);
  const [entitySearch, setEntitySearch] = useState('');
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(defaultMetrics('network-summary'));
  const [applied, setApplied] = useState<Applied | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  // Right-workspace active tab (View = configure + render; Schedule = email
  // deliveries; Saved = saved report configs).
  const [tab, setTab] = useState<'view' | 'schedule' | 'saved'>('view');
  // Which saved report's schedule is open for editing in the Schedule tab.
  const [editSchedId, setEditSchedId] = useState<number | null>(null);
  // Set after the first client render. Anything whose value depends on the
  // current clock or the viewer's locale must wait for this, or SSR and the
  // client produce different text and hydration fails.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [schedBusy, setSchedBusy] = useState<number | null>(null);
  const [schedMsg, setSchedMsg] = useState<{ id: number; kind: 'ok' | 'error'; text: string } | null>(null);

  const tpl = TEMPLATE_BY_KEY[template];

  const scheduleRows = schedules.data?.schedules || [];
  const recentRuns = schedules.data?.recent || [];
  // template key → its scheduled deliveries, for the rail badge and the briefing.
  const schedulesByTemplate = useMemo(() => {
    const m: Record<string, ScheduleRow[]> = {};
    for (const s of scheduleRows) (m[s.template] = m[s.template] || []).push(s);
    return m;
  }, [scheduleRows]);
  // Catalog rows: SVG icon + a "Scheduled" count badge when the template has one.
  const catalogReports: CatalogReport[] = useMemo(() => TEMPLATES.map((t) => {
    const n = (schedulesByTemplate[t.key] || []).length;
    return {
      key: t.key, short: t.label, title: t.label, desc: t.desc, category: t.category,
      icon: <t.Icon width={16} height={16} />,
      badge: n > 0
        ? {
            icon: <IconCalendar width={11} height={11} aria-hidden />,
            label: n > 1 ? String(n) : undefined,
            title: `${n} scheduled email deliver${n > 1 ? 'ies' : 'y'}`,
          }
        : undefined,
    };
  }), [schedulesByTemplate]);

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
    if (tpl.scope === 'apMulti' || tpl.scope === 'deviceMulti' || tpl.scope === 'serviceMulti') return entityIds.length > 0;
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
    } else if (tpl.scope === 'serviceMulti') {
      entities = entityIds.map((id) => {
        const s = services.data?.find((x) => String(x.id) === id);
        return { id, label: s ? `${s.name}${s.target ? ` (${s.target})` : ''}` : id };
      });
    }
    const resolved = resolveRange(range, from, to);
    setApplied({
      template, range, from, to, bucket, scopeMode, siteId, siteLabel, deviceId, deviceLabel,
      controllerId, controllerLabel, slaTarget, metric,
      resolvedFrom: resolved.from, resolvedTo: resolved.to,
      entities, selectedMetrics: [...selectedMetrics],
    });
    setSaveName('');
    setShowSave(false);
  }

  // Active entity list (APs, devices, or services) for the multi-select, filtered by search.
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
    if (tpl.scope === 'serviceMulti') {
      return (services.data || [])
        .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.target || '').toLowerCase().includes(q))
        .map((s) => ({ id: String(s.id), label: `${s.name} (${(s.type || '').toUpperCase()} · ${s.target})${s.site_name ? ` · ${s.site_name}` : ''}` }));
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
  const isMulti = applied?.template === 'ap-detail' || applied?.template === 'device-detail' || applied?.template === 'service-detail';
  const endpoint = applied && !isMulti ? buildEndpoint(applied) : null;
  const report = useApi<any>(endpoint, 0);

  // Export the applied report as a server-generated PDF (pdfkit). Same-origin fetch
  // carries the session cookie; middleware.ts injects the RBAC headers before the
  // Express route. Streams the PDF as an attachment; download via a temp anchor.
  async function exportPdf() {
    if (!applied || exporting) return;
    setExporting(true);
    try {
      const res = await fetch(buildPdfUrl(applied));
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON body */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      let filename = `${applied.template}-${new Date().toISOString().slice(0, 10)}.pdf`;
      const cd = res.headers.get('content-disposition');
      const m = cd && /filename\*?=(?:UTF-8'')?"?([^"';]+)"?/i.exec(cd);
      if (m) { try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; } }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(`PDF export failed: ${(e as Error).message || 'error'}`);
    } finally {
      setExporting(false);
    }
  }

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
        // Persist the selected entity ids for multi-entity detail reports so the
        // selection is restored on reload (otherwise the reloaded report renders
        // only the header and Export sends empty entity_ids).
        scope_ids: applied.entities.length ? applied.entities.map((e) => e.id) : null,
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
    schedules.reload();
  }

  // Persist a saved report's email cadence. PUT /api/reports/saved/:id is the
  // route api/reportScheduler.js's next_run_at is recomputed by — this is the
  // only place in the UI that has ever driven it.
  async function saveSchedule(id: number, fields: {
    schedule: string; schedule_day: number | null; schedule_hour: number; recipients: string;
  }) {
    setSchedBusy(id);
    setSchedMsg(null);
    try {
      await apiSend(`/api/reports/saved/${id}`, 'PUT', fields);
      setEditSchedId(null);
      schedules.reload();
      saved.reload();
    } catch (e) {
      setSchedMsg({ id, kind: 'error', text: (e as Error).message || 'Could not save the schedule' });
    } finally {
      setSchedBusy(null);
    }
  }

  // Email a scheduled report immediately (does not move next_run_at).
  async function sendScheduleNow(id: number) {
    setSchedBusy(id);
    setSchedMsg(null);
    try {
      const out: any = await apiSend(`/api/reports/saved/${id}/run-now`, 'POST', {});
      const to = Array.isArray(out?.recipients) ? out.recipients.join(', ') : '';
      setSchedMsg({ id, kind: 'ok', text: to ? `Sent to ${to}` : 'Sent' });
      schedules.reload();
    } catch (e) {
      setSchedMsg({ id, kind: 'error', text: (e as Error).message || 'Send failed' });
    } finally {
      setSchedBusy(null);
    }
  }

  function loadSaved(s: SavedReport) {
    // Same shared-state hazard as selectTemplate: a saved NON-granular report
    // loaded while from/to still hold datetime-local values leaves the date
    // pickers visually blank with Run still enabled, because customRangeValid
    // only checks that both endpoints are set and ordered.
    if (!TEMPLATE_BY_KEY[s.template]?.granular) {
      const dayOnly = (v: string) => (v && v.includes('T') ? v.split('T')[0] : v);
      setFrom(dayOnly);
      setTo(dayOnly);
    }
    setTemplate(s.template);
    setRange(s.date_range && s.date_range !== 'custom' ? s.date_range : '30d');
    const mode = (s.scope_type as 'all' | 'site' | 'device') || 'all';
    setScopeMode(mode === 'site' || mode === 'device' ? mode : 'all');
    setSiteId(mode === 'site' && s.scope_id ? String(s.scope_id) : '');
    setDeviceId(mode === 'device' && s.scope_id ? String(s.scope_id) : '');
    if (s.sla_target != null) setSlaTarget(String(s.sla_target));
    const siteLabel = s.scope_type === 'site' ? (s.scope_name || '') : '';
    const deviceLabel = s.scope_type === 'device' ? (s.scope_name || '') : '';
    // Rehydrate the multi-entity selection (AP/Device Detail) from scope_ids so
    // the reloaded report renders its per-entity sections and Export carries the
    // ids. Labels are resolved from the loaded AP/device lists (id fallback,
    // same as runReport, if a list hasn't loaded yet).
    const savedEntityIds = Array.isArray(s.scope_ids) ? s.scope_ids.map((n) => String(n)) : [];
    const savedEntities: EntityRef[] = savedEntityIds.map((id) => {
      if (s.template === 'ap-detail') {
        const ap = aps.data?.find((x) => String(x.id) === id);
        return { id, label: ap ? `${ap.name}${ap.ip_address ? ` (${ap.ip_address})` : ''}` : id };
      }
      if (s.template === 'device-detail') {
        const d = devices.data?.find((x) => String(x.id) === id);
        return { id, label: d ? `${d.name}${d.ip_address ? ` (${d.ip_address})` : ''}` : id };
      }
      if (s.template === 'service-detail') {
        const svc = services.data?.find((x) => String(x.id) === id);
        return { id, label: svc ? `${svc.name}${svc.target ? ` (${svc.target})` : ''}` : id };
      }
      return { id, label: id };
    });
    setBucket('auto');
    setEntityIds(savedEntityIds);
    setSelectedMetrics(defaultMetrics(s.template));
    setApplied({
      template: s.template, range: s.date_range && s.date_range !== 'custom' ? s.date_range : '30d',
      from: '', to: '', resolvedFrom: '', resolvedTo: '', bucket: 'auto', scopeMode: mode === 'site' || mode === 'device' ? mode : 'all',
      siteId: mode === 'site' && s.scope_id ? String(s.scope_id) : '',
      siteLabel, deviceId: mode === 'device' && s.scope_id ? String(s.scope_id) : '',
      deviceLabel, controllerId: '', controllerLabel: '',
      slaTarget: s.sla_target != null ? String(s.sla_target) : '99.5',
      metric: 'uptime',
      entities: savedEntities, selectedMetrics: defaultMetrics(s.template),
    });
    setShowSave(false);
    setTab('view'); // surface the loaded report in the workspace
  }

  // Select a template from the catalog rail: set the template and surface the View tab.
  function selectTemplate(key: string) {
    // Granular templates render datetime-local pickers, the rest render date
    // pickers, but the from/to state is shared between them. Handing a
    // "2026-08-18T08:00" value to a date input leaves the FIELD blank while the
    // state keeps the time, so the user sees an empty picker and still submits
    // a time - which the API cannot parse. Truncate on the way down so the
    // control and the state can never disagree. (The API also tolerates this
    // now; this stops the bad value being produced in the first place.)
    const nextGranular = !!TEMPLATE_BY_KEY[key]?.granular;
    if (!nextGranular) {
      const dayOnly = (v: string) => (v && v.includes('T') ? v.split('T')[0] : v);
      setFrom(dayOnly);
      setTo(dayOnly);
    }
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
            reports={catalogReports}
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
              { key: 'schedule' as const, label: `Schedule (${scheduleRows.length})` },
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
                <div className="sv-no-print" style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <tpl.Icon width={18} height={18} aria-hidden style={{ color: 'var(--primary)', flexShrink: 0 }} />
                      {tpl.label}
                    </div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4 }}>{tpl.desc}</div>
                  </div>
                  {/* Scheduled-delivery indicator for THIS template, mirroring the rail badge. */}
                  {(schedulesByTemplate[template] || []).length > 0 && (
                    <button type="button" onClick={() => setTab('schedule')}
                      style={{ ...chip('var(--tint-info)', 'var(--tint-info-fg)'), height: 24, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                      title="Show this template's scheduled email deliveries">
                      <IconCalendar width={12} height={12} aria-hidden />
                      {(schedulesByTemplate[template] || []).length} scheduled
                    </button>
                  )}
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

            {/* Granular detail: one-or-many entity multi-select (AP, device, or service) */}
            {(tpl.scope === 'apMulti' || tpl.scope === 'deviceMulti' || tpl.scope === 'serviceMulti') && (
              <EntityMultiSelect
                noun={tpl.scope === 'apMulti' ? 'AP' : tpl.scope === 'serviceMulti' ? 'Service' : 'Device'}
                search={entitySearch}
                onSearch={setEntitySearch}
                list={entityList}
                selected={entityIds}
                onToggle={toggleEntity}
                onClear={() => setEntityIds([])}
                loading={tpl.scope === 'apMulti' ? aps.loading : tpl.scope === 'serviceMulti' ? services.loading : devices.loading}
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
                    in .sv-no-print so it stays printable.
                    Gate on applied.template === template: the title/cover/h1 use the
                    LIVE tpl while the body uses the FROZEN applied, so if the user
                    picks a different report in the rail without clicking Run we'd show
                    report A's data under report B's title. Only render once the applied
                    (run) report matches the current selection. */}
                {applied && applied.template === template ? (
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
              <button onClick={exportPdf} disabled={exporting}
                style={{ ...presetBtn(false), padding: '0 14px', flex: 'none', opacity: exporting ? 0.6 : 1, cursor: exporting ? 'default' : 'pointer' }}>
                {exporting ? 'Generating…' : 'Export PDF'}
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
                  <ReportBriefing
                    tpl={tpl}
                    coverage={coverageLine(template, {
                      // Distinct sites that actually HAVE a monitored device —
                      // not sites.data, which is every Active NetVault site
                      // whether SpanVault watches anything there or not. The
                      // sentence ends "currently monitored", so it has to be
                      // the monitored set or it is simply false.
                      sites: new Set(
                        (devices.data || [])
                          .map((d: any) => d.site_id)
                          .filter((id: any) => id != null)
                      ).size,
                      devices: devices.data?.length || 0,
                      aps: aps.data?.length || 0,
                      services: services.data?.length || 0,
                      controllers: controllers.data?.length || 0,
                    })}
                    schedules={schedulesByTemplate[template] || []}
                    recent={recentRuns.filter((r) => r.template === template)}
                    savedForTemplate={(saved.data || []).filter((s) => s.template === template)}
                    schedulesLoading={schedules.loading}
                    schedulesError={schedules.error}
                    config={pendingConfigRows({
                      tpl, range, from, to, bucket, scopeMode,
                      siteLabel: sites.data?.find((s) => String(s.id) === siteId)?.name || '',
                      deviceLabel: devices.data?.find((d) => String(d.id) === deviceId)?.name || '',
                      controllerLabel: controllers.data?.find((c) => String(c.id) === controllerId)?.name || '',
                      slaTarget, metric, entityCount: entityIds.length, mounted,
                    })}
                    onLoadSaved={loadSaved}
                    onOpenSchedule={() => setTab('schedule')}
                  />
                )}
              </>
            )}

            {/* ── SCHEDULE TAB — every saved report with an email cadence ── */}
            {tab === 'schedule' && (
              <div className="sv-no-print" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>Scheduled delivery</div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 3 }}>
                      Saved reports the server runs on a cadence and emails as PDF. The scheduler
                      checks for due reports every 15 minutes, so a run can land a little after its
                      scheduled time.
                    </div>
                  </div>
                  <button type="button" onClick={() => { schedules.reload(); saved.reload(); }}
                    style={{ ...presetBtn(false), padding: '0 12px', flex: 'none' }}>
                    Refresh
                  </button>
                </div>

                {schedules.error ? (
                  <ErrorBox message={schedules.error} />
                ) : schedules.loading && !schedules.data ? (
                  <div style={panelBox}><Loading label="Loading schedules…" /></div>
                ) : (
                  <>
                    <div style={panelBox}>
                      <div style={panelHead}><IconCalendar width={13} height={13} aria-hidden /> Active schedules ({scheduleRows.length})</div>
                      {scheduleRows.length === 0 ? (
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                          Nothing is scheduled. Run a report on the <strong>View</strong> tab, save it from the
                          <strong> Saved</strong> tab, then give it a cadence below — the saved report&apos;s template,
                          scope and date range are what the scheduled run uses.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {scheduleRows.map((s) => (
                            <ScheduleCard
                              /* Key carries the schedule signature: ScheduleCard seeds its
                                 editor state from props, so it must remount when the stored
                                 schedule changes (after a save/reload) or a reopened editor
                                 would show the pre-save values. */
                              key={`${s.id}:${s.schedule}:${s.schedule_day}:${s.schedule_hour}:${s.recipients}`}
                              row={s}
                              templateLabel={TEMPLATE_BY_KEY[s.template]?.label || s.template}
                              TemplateIcon={TEMPLATE_BY_KEY[s.template]?.Icon}
                              editing={editSchedId === s.id}
                              busy={schedBusy === s.id}
                              msg={schedMsg && schedMsg.id === s.id ? schedMsg : null}
                              canWrite={canWrite}
                              onEdit={() => { setEditSchedId(editSchedId === s.id ? null : s.id); setSchedMsg(null); }}
                              onSave={(f) => saveSchedule(s.id, f)}
                              onSendNow={() => sendScheduleNow(s.id)}
                              onOpenTemplate={() => selectTemplate(s.template)}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Saved reports with no cadence yet — the only place a schedule can be created. */}
                    {(() => {
                      const unscheduled = (saved.data || []).filter((s) => !s.schedule || s.schedule === 'none');
                      if (unscheduled.length === 0) return null;
                      return (
                        <div style={panelBox}>
                          <div style={panelHead}><IconClock width={13} height={13} aria-hidden /> Saved reports without a schedule ({unscheduled.length})</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {unscheduled.map((s) => (
                              <ScheduleCard
                                key={`${s.id}:${s.schedule}:${s.schedule_day}:${s.schedule_hour}:${s.recipients}`}
                                row={{
                                  id: s.id, name: s.name, template: s.template,
                                  scope_type: s.scope_type, scope_id: s.scope_id, scope_name: s.scope_name,
                                  date_range: s.date_range, schedule: 'none',
                                  schedule_day: s.schedule_day ?? null, schedule_hour: s.schedule_hour ?? null,
                                  recipients: s.recipients ?? null, next_run_at: null,
                                  last_sent_at: s.last_sent_at ?? null, created_by: s.created_by ?? null,
                                  created_at: s.created_at ?? null,
                                  last_run_at: null, last_status: null, last_error: null,
                                }}
                                templateLabel={TEMPLATE_BY_KEY[s.template]?.label || s.template}
                                TemplateIcon={TEMPLATE_BY_KEY[s.template]?.Icon}
                                editing={editSchedId === s.id}
                                busy={schedBusy === s.id}
                                msg={schedMsg && schedMsg.id === s.id ? schedMsg : null}
                                canWrite={canWrite}
                                onEdit={() => { setEditSchedId(editSchedId === s.id ? null : s.id); setSchedMsg(null); }}
                                onSave={(f) => saveSchedule(s.id, f)}
                                onSendNow={() => sendScheduleNow(s.id)}
                                onOpenTemplate={() => selectTemplate(s.template)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    <div style={panelBox}>
                      <div style={panelHead}><IconHistory width={13} height={13} aria-hidden /> Recent deliveries</div>
                      <DeliveryList
                        rows={recentRuns}
                        emptyText="No scheduled report has been delivered yet. Every scheduled run and every “Send now” is logged here with its recipients and outcome."
                        showTemplate
                      />
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                        Only emailed runs are logged. An on-demand <strong>Export PDF</strong> from the View tab is
                        streamed straight to your browser and is not retained on the server.
                      </div>
                    </div>
                  </>
                )}
              </div>
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
                      border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)', overflow: 'hidden',
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
                      style={{ display: 'inline-flex', alignItems: 'center', height: 24, border: '1px dashed var(--border)', borderRadius: 'var(--radius-pill)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--primary)', padding: '0 10px' }}>
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

// ── Pre-run briefing (top-level component) ─────────────────────
// What the right-hand workspace shows BEFORE a report has been run. Replaces the
// single "Configure the options above…" sentence that used to leave ~500px blank:
// what the report contains, which tables feed it, how much of the estate it covers
// right now, whether it is scheduled to anyone, and what has already been delivered.
function ReportBriefing({
  tpl, coverage, schedules, recent, savedForTemplate, schedulesLoading, schedulesError,
  config, onLoadSaved, onOpenSchedule,
}: {
  tpl: Template;
  coverage: string | null;
  schedules: ScheduleRow[];
  recent: HistoryRow[];
  savedForTemplate: SavedReport[];
  schedulesLoading: boolean;
  schedulesError: string | null;
  config: { label: string; value: string }[];
  onLoadSaved: (s: SavedReport) => void;
  onOpenSchedule: () => void;
}) {
  const meta = TEMPLATE_META[tpl.key];
  return (
    <div className="sv-no-print" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>

        {/* ── About this report ── */}
        <div style={panelBox}>
          <div style={panelHead}><IconInfo width={13} height={13} aria-hidden /> What this report contains</div>
          {meta ? (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {meta.includes.map((line) => (
                <li key={line} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  <IconCheck width={13} height={13} aria-hidden style={{ color: 'var(--tint-success-fg)', flexShrink: 0, marginTop: 2 }} />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{tpl.desc}</div>
          )}
          {meta && (
            <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px solid var(--border-light)' }}>
              <div style={{ ...panelHead, marginBottom: 7 }}><IconDatabase width={13} height={13} aria-hidden /> Data sources</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {meta.sources.map((s) => <span key={s} style={srcChip}>{s}</span>)}
              </div>
            </div>
          )}
          {coverage && (
            <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              <IconLayers width={13} height={13} aria-hidden style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              {coverage}
            </div>
          )}
        </div>

        {/* ── What Run Report will actually use ── */}
        <div style={panelBox}>
          <div style={panelHead}><IconClock width={13} height={13} aria-hidden /> This run</div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 7, alignItems: 'baseline' }}>
            {config.map((c) => (
              <div key={c.label} style={{ display: 'contents' }}>
                <dt style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                  {c.label}
                </dt>
                <dd style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                  {c.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* ── Scheduled delivery for this template ── */}
        <div style={panelBox}>
          <div style={panelHead}><IconCalendar width={13} height={13} aria-hidden /> Scheduled delivery</div>
          {schedulesError ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--tint-danger-fg)' }}>{schedulesError}</div>
          ) : schedulesLoading ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Loading…</div>
          ) : schedules.length === 0 ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.55 }}>
              No email schedule for {tpl.label}. Run it, save it, then set a cadence on the{' '}
              <button type="button" onClick={onOpenSchedule}
                style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--primary)', fontWeight: 600, fontSize: 'var(--text-sm)', fontFamily: 'inherit', textDecoration: 'underline' }}>
                Schedule tab
              </button>.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {schedules.map((s) => {
                const to = recipientList(s.recipients);
                return (
                  <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</span>
                      <span style={chip('var(--tint-info)', 'var(--tint-info-fg)')}>{cadenceLabel(s)}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                      <IconClock width={12} height={12} aria-hidden style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      Next run {fmtDateTime(s.next_run_at)}
                      {s.next_run_at && <span style={{ color: 'var(--text-muted)' }}>({fmtRelative(s.next_run_at)})</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                      <IconMail width={12} height={12} aria-hidden style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: 3 }} />
                      <span style={{ wordBreak: 'break-word' }}>
                        {to.length ? to.join(', ') : <span style={{ color: 'var(--tint-warn-fg)' }}>No recipients — this schedule will never send</span>}
                      </span>
                    </div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                      Last sent {fmtDateTime(s.last_sent_at)}
                      {s.last_status && <> · last run <StatusPill status={s.last_status} /></>}
                    </div>
                  </div>
                );
              })}
              <button type="button" onClick={onOpenSchedule}
                style={{ ...presetBtn(false), alignSelf: 'flex-start', padding: '0 12px' }}>
                Manage schedules
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Saved configurations for this template ── */}
      {savedForTemplate.length > 0 && (
        <div style={panelBox}>
          <div style={panelHead}><IconClipboard width={13} height={13} aria-hidden /> Saved configurations for this report</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {savedForTemplate.map((s) => (
              <button key={s.id} type="button" onClick={() => onLoadSaved(s)}
                title={`Load "${s.name}" — ${s.scope_name || s.scope_type} · ${s.date_range}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)',
                  background: 'var(--bg-card)', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)',
                }}>
                {s.name}
                <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                  {s.scope_name || (s.scope_type === 'all' ? 'all sites' : s.scope_type)} · {s.date_range}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Recent deliveries of this template ── */}
      <div style={panelBox}>
        <div style={panelHead}><IconHistory width={13} height={13} aria-hidden /> Recent {tpl.label} deliveries</div>
        <DeliveryList
          rows={recent}
          emptyText={`No ${tpl.label} report has been emailed yet. Scheduled runs and “Send now” deliveries are logged here; an on-demand Export PDF is streamed to your browser and not retained on the server.`}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        <IconInfo width={13} height={13} aria-hidden style={{ flexShrink: 0 }} />
        Set the options in the bar above, then choose <strong style={{ color: 'var(--text-secondary)' }}>Run Report →</strong> to generate the {tpl.label} report.
      </div>
    </div>
  );
}

// ── Delivery-history list (top-level component) ────────────────
function DeliveryList({ rows, emptyText, showTemplate }: {
  rows: HistoryRow[]; emptyText: string; showTemplate?: boolean;
}) {
  if (rows.length === 0) {
    return <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 1.55 }}>{emptyText}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '7px 9px', borderRadius: 'var(--radius-sm)', background: 'var(--surface-subtle)',
        }}>
          <StatusPill status={r.status} />
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
            {r.report_name || `#${r.report_id}`}
          </span>
          {showTemplate && r.template && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {TEMPLATE_BY_KEY[r.template]?.label || r.template}
            </span>
          )}
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{fmtDateTime(r.run_at)}</span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{fmtRelative(r.run_at)}</span>
          {r.recipients && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', wordBreak: 'break-word' }}>→ {r.recipients}</span>
          )}
          {r.error && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--tint-danger-fg)', wordBreak: 'break-word' }}>{r.error}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const ok = status === 'success';
  return (
    <span style={chip(ok ? 'var(--tint-success)' : 'var(--tint-danger)', ok ? 'var(--tint-success-fg)' : 'var(--tint-danger-fg)')}>
      {ok ? <IconCheck width={11} height={11} aria-hidden /> : <IconClose width={11} height={11} aria-hidden />}
      {ok ? 'Sent' : 'Failed'}
    </span>
  );
}

// ── One schedule row + inline cadence editor (top-level component) ──
// Must stay top-level: defining it inside ReportsPage would remount the recipient
// input on every keystroke and drop focus (the repo-wide rule).
function ScheduleCard({
  row, templateLabel, TemplateIcon, editing, busy, msg, canWrite,
  onEdit, onSave, onSendNow, onOpenTemplate,
}: {
  row: ScheduleRow;
  templateLabel: string;
  TemplateIcon?: IconComp;
  editing: boolean;
  busy: boolean;
  msg: { kind: 'ok' | 'error'; text: string } | null;
  canWrite: boolean;
  onEdit: () => void;
  onSave: (f: { schedule: string; schedule_day: number | null; schedule_hour: number; recipients: string }) => void;
  onSendNow: () => void;
  onOpenTemplate: () => void;
}) {
  const [cadence, setCadence] = useState(row.schedule || 'none');
  const [day, setDay] = useState(row.schedule_day != null ? String(row.schedule_day) : '1');
  const [hour, setHour] = useState(row.schedule_hour != null ? String(row.schedule_hour) : '7');
  const [to, setTo] = useState(row.recipients || '');
  const active = row.schedule && row.schedule !== 'none';
  const recips = recipientList(row.recipients);

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
      background: 'var(--surface-subtle)', padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        {TemplateIcon && <TemplateIcon width={15} height={15} aria-hidden style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
        <span style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)' }}>{row.name}</span>
        <button type="button" onClick={onOpenTemplate} title="Open this template on the View tab"
          style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--primary)', fontSize: 'var(--text-xs)', fontWeight: 600, fontFamily: 'inherit' }}>
          {templateLabel}
        </button>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {row.scope_name || (row.scope_type === 'all' ? 'All sites' : row.scope_type)} · {row.date_range}
        </span>
        <span style={active
          ? chip('var(--tint-info)', 'var(--tint-info-fg)')
          : chip('var(--surface-subtle)', 'var(--text-muted)')}>
          {cadenceLabel(row)}
        </span>
        {row.last_status && <StatusPill status={row.last_status} />}
        <div style={{ flex: 1 }} />
        {canWrite && (
          <>
            <button type="button" onClick={onEdit} disabled={busy}
              style={{ ...presetBtn(false), height: 24, padding: '0 10px', fontSize: 'var(--text-xs)' }}>
              {editing ? 'Cancel' : active ? 'Edit schedule' : 'Add schedule'}
            </button>
            {active && recips.length > 0 && (
              <button type="button" onClick={onSendNow} disabled={busy}
                style={{ ...presetBtn(false), height: 24, padding: '0 10px', fontSize: 'var(--text-xs)', opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Working…' : 'Send now'}
              </button>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconClock width={12} height={12} aria-hidden style={{ color: 'var(--text-muted)' }} />
          Next run {fmtDateTime(row.next_run_at)}
          {row.next_run_at && <span style={{ color: 'var(--text-muted)' }}>({fmtRelative(row.next_run_at)})</span>}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconHistory width={12} height={12} aria-hidden style={{ color: 'var(--text-muted)' }} />
          Last sent {fmtDateTime(row.last_sent_at)}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, maxWidth: '100%' }}>
          <IconMail width={12} height={12} aria-hidden style={{ color: 'var(--text-muted)', marginTop: 3, flexShrink: 0 }} />
          <span style={{ wordBreak: 'break-word' }}>
            {recips.length ? recips.join(', ')
              : <span style={{ color: active ? 'var(--tint-warn-fg)' : 'var(--text-muted)' }}>
                  {active ? 'No recipients — this schedule will never send' : 'No recipients'}
                </span>}
          </span>
        </span>
      </div>

      {row.last_error && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--tint-danger-fg)', wordBreak: 'break-word' }}>
          Last failure: {row.last_error}
        </div>
      )}

      {editing && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10,
          paddingTop: 9, borderTop: '1px solid var(--border-light)',
        }}>
          <label style={fieldLabel}>Cadence
            <select style={ctrlBase} value={cadence} onChange={(e) => setCadence(e.target.value)}>
              {CADENCE_OPTIONS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          {cadence === 'weekly' && (
            <label style={fieldLabel}>Day
              <select style={ctrlBase} value={day} onChange={(e) => setDay(e.target.value)}>
                {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          {cadence !== 'none' && (
            <label style={fieldLabel}>Hour
              <select style={ctrlBase} value={hour} onChange={(e) => setHour(e.target.value)}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                ))}
              </select>
            </label>
          )}
          <label style={{ ...fieldLabel, flex: '1 1 260px', alignItems: 'stretch', flexDirection: 'column', gap: 4 }}>
            Recipients
            <input style={{ ...ctrlBase, width: '100%' }} value={to} onChange={(e) => setTo(e.target.value)}
              placeholder="ops@example.com, noc@example.com" />
          </label>
          <button type="button" disabled={busy}
            onClick={() => onSave({
              schedule: cadence,
              schedule_day: cadence === 'weekly' ? parseInt(day, 10) : null,
              schedule_hour: parseInt(hour, 10),
              recipients: to.trim(),
            })}
            style={{ ...presetBtn(true), padding: '0 14px', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : 'Save schedule'}
          </button>
        </div>
      )}

      {editing && cadence !== 'none' && !to.trim() && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--tint-warn-fg)' }}>
          A cadence with no recipients is stored but never sent — the scheduler only picks up
          reports that have at least one recipient.
        </div>
      )}

      {msg && (
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: msg.kind === 'ok' ? 'var(--tint-success-fg)' : 'var(--tint-danger-fg)' }}>
          {msg.text}
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
    case 'service-detail':  return <ServiceDetailReport data={data} />;
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
    case 'wireless-security':  return <WirelessSecurityReport data={data} />;
    case 'wireless-bandwidth': return <WirelessBandwidthReport data={data} />;
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
// per AP/device/service, with an independent loading / error / empty state.
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
        {detailNoun(template)}: {entity.label}
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
      ) : template === 'service-detail' ? (
        <ServiceDetailReport data={r.data} selectedMetrics={selectedMetrics} />
      ) : (
        <DeviceDetailReport data={r.data} selectedMetrics={selectedMetrics} />
      )}
    </section>
  );
}

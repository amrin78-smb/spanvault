'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  BarChart, Bar, ReferenceLine, Cell,
} from 'recharts';
import { useApi, apiSend, apiGet } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, fmtRel, fmtTime, UtilBar, pctColor, PageHeader, Pager, useClientPagination, CHART_TOOLTIP, useConfirm } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import { IconCheck, IconWarning, IconRepeat, IconClose, IconTool, IconPin } from '@/components/icons';

// ════════════════════════════════════════════════════════════
// Types (mirror the /api/wireless contracts)
// ════════════════════════════════════════════════════════════

interface SummarySite {
  site_id: number | null;
  site_name: string;
  aps: number;
  online: number;
  clients: number;
  avg_util: number | null;
}

interface SummaryController {
  id: number;
  name: string;
  vendor: string;
  aps: number;
  clients: number;
}

interface HighUtilAp {
  id: number;
  name: string;
  site_name: string | null;
  channel: number | null;
  util_pct: number;
  clients_total: number;
}

interface RfBySite {
  site_id: number;
  site_name: string;
  aps: number;
  avg_noise_floor: number | null;
  high_util_aps: number;
  avg_retry_rate: number | null;
  auth_failures: number;
}

interface HighNoiseAp {
  id: number;
  name: string;
  site_name: string | null;
  noise_floor: number | null;
}

interface WirelessSummary {
  total_aps: number;
  online_aps: number;
  offline_aps: number;
  total_clients: number;
  by_site: SummarySite[];
  by_controller: SummaryController[];
  high_utilization: HighUtilAp[];
  auth_failures_total: number;
  avg_noise_floor: number | null;
  high_noise_aps: HighNoiseAp[];
  rf_by_site: RfBySite[];
}

interface Ssid {
  id: number;
  controller_id: number;
  controller_name: string | null;
  vendor: string | null;
  ssid_name: string;
  site_id: number | null;
  site_name: string | null;
  status: string;
  clients_total: number;
  bytes_in: number | null;
  bytes_out: number | null;
  auth_successes: number;
  auth_failures: number;
  encryption_type: string | null;
  updated_at: string;
}

interface SsidSummary {
  total_ssids: number;
  active_ssids: number;
  top_ssids: Ssid[];
  most_failures: Ssid[];
}

interface AccessPoint {
  id: number;
  name: string;
  controller_id: number | null;
  controller_name: string | null;
  vendor: string | null;
  site_id: number | null;
  site_name: string | null;
  status: 'online' | 'offline' | 'unknown';
  clients_total: number;
  clients_2g: number;
  clients_5g: number;
  clients_6g: number;
  radio_2g_channel: number | null;
  radio_5g_channel: number | null;
  radio_2g_util_pct: number | null;
  radio_5g_util_pct: number | null;
  ip_address: string | null;
  mac_address: string | null;
  model: string | null;
  firmware_version: string | null;
  tx_power_2g: number | null;
  tx_power_5g: number | null;
  uptime_seconds: number | null;
  uptime_formatted: string | null;
  last_seen_at: string | null;
  noise_floor_2g: number | null;
  noise_floor_5g: number | null;
  retry_rate_2g: number | null;
  retry_rate_5g: number | null;
  interference_pct_2g: number | null;
  interference_pct_5g: number | null;
  rx_errors_2g: number | null;
  tx_errors_2g: number | null;
  rx_errors_5g: number | null;
  tx_errors_5g: number | null;
  // Per-poll error-packet delta (packets since the previous poll), derived by
  // the collector from the raw lifetime counters above via a wrap-aware
  // Counter32 delta — null on an AP's first poll or right after a collector
  // restart until the AP's next poll re-seeds the in-memory reading.
  rx_errors_delta_2g: number | null;
  tx_errors_delta_2g: number | null;
  rx_errors_delta_5g: number | null;
  tx_errors_delta_5g: number | null;
  throughput_in_bps: number | null;
  throughput_out_bps: number | null;
  serial_number: string | null;
  auth_failures: number | null;
  reboot_count: number | null;
  bootstrap_count: number | null;
}

interface ApHistoryRow {
  bucket: string;
  clients_total: number | null;
  clients_2g: number | null;
  clients_5g: number | null;
  radio_2g_util: number | null;
  radio_5g_util: number | null;
  noise_floor_2g: number | null;
  noise_floor_5g: number | null;
  retry_rate_2g: number | null;
  retry_rate_5g: number | null;
  interference_pct_2g: number | null;
  interference_pct_5g: number | null;
}

interface Controller {
  id: number;
  name: string;
  vendor: string;
  controller_url: string | null;
  api_username: string | null;
  // Aruba Central non-secret fields (present on GET responses, pre-fillable
  // on edit — same convention as api_username). api_client_secret and
  // api_refresh_token are write-only secrets and are never returned by the
  // API, so they are deliberately NOT part of this response contract.
  api_client_id?: string | null;
  api_customer_id?: string | null;
  api_group_filter?: string | null;
  snmp_device_id: number | null;
  site_id: number | null;
  site_name: string | null;
  active: boolean;
  last_polled_at: string | null;
  status: string | null;
  ap_count: number;
  client_count: number;
  model?: string | null;
  firmware_version?: string | null;
  licensed_aps?: number | null;
  ha_mode?: string | null;
  ha_peer_ip?: string | null;
  ha_sync_status?: string | null;
  ap_disconnects_24h?: number | null;
  ha_peer_controller_id?: number | null;
  ha_manual_role?: string | null;
  capabilities_probed_at?: string | null;
  has_capabilities?: boolean;
  // SNMP credentials of the linked monitored device (present on GET responses);
  // used to pre-fill the edit modal so polling creds can be tweaked in place.
  snmp_community?: string | null;
  snmp_version?: string | null;
  snmp_port?: number | null;
}

// ── Enhanced controllers overview/events contracts ────────────
interface OverviewController {
  id: number;
  name: string;
  vendor: string;
  site_name: string | null;
  model: string | null;
  firmware_version: string | null;
  status: string | null;
  ap_count: number;
  client_count: number;
  cpu_pct: number | null;
  mem_pct: number | null;
  uptime_seconds: number | null;
  licensed_aps: number | null;
  ap_capacity_pct: number | null;
  ha_mode: string | null;
  ha_peer_ip: string | null;
  ha_sync_status: string | null;
  ha_peer_controller_id: number | null;
  ha_manual_role: string | null;
  ha_peer_name: string | null;
  ap_disconnects_24h: number | null;
  last_polled_at: string | null;
  chassis_temp_c: number | null;
  chassis_temp_status: string | null;
  last_reboot_reason: string | null;
  reported_ap_count: number | null;
  reported_client_count: number | null;
  ha_active_aps: number | null;
  ha_standby_aps: number | null;
  ha_total_aps: number | null;
  ha_active_vap_tunnels: number | null;
  ha_standby_vap_tunnels: number | null;
  ha_total_vap_tunnels: number | null;
  ha_ap_hbt_tunnels: number | null;
  // Aruba cluster/peer roster (WLSX-SYSTEMEXT-MIB wlsxNSysExtSwitchListTable) —
  // populated only when queried from the cluster master (per the MIB); a non-master
  // member legitimately reports fewer/no peers. sw_version/name columns exist in the
  // MIB but were confirmed empty on live hardware, so they aren't captured.
  ha_peers: {
    ip: string;
    role: string | null;
    status: string | null;
    location: string | null;
    serial: string | null;
  }[] | null;
}

interface ControllerOverview {
  total_controllers: number;
  online_controllers: number;
  total_aps: number;
  total_clients: number;
  avg_cpu_pct: number | null;
  avg_mem_pct: number | null;
  ha_healthy_count: number;
  ha_total_count: number;
  ap_capacity_pct: number | null;
  controllers: OverviewController[];
}

interface ControllerEvent {
  ts: string;
  controller_name: string | null;
  site_name: string | null;
  event_type: 'join' | 'leave' | 'low_signal' | 'alert' | string;
  description: string;
  severity: string | null;
  ap_name: string | null;
}

interface DeviceRow {
  id: number;
  name: string;
  ip_address: string | null;
  site_id: number | null;
  site_name: string | null;
}

interface SiteRow {
  id: number;
  name: string;
}

interface ControllerForm {
  name: string;
  vendor: string;
  conn_type: 'snmp' | 'api';
  controller_url: string;
  api_username: string;
  api_password: string;
  api_key: string;
  // Aruba Central (vendor === 'aruba_central') API fields. Client ID,
  // Customer ID, and Group filter are plain text (pre-fillable on edit);
  // Client secret and Refresh token are write-only secrets (always start
  // blank, same convention as api_password).
  api_client_id: string;
  api_client_secret: string;
  api_customer_id: string;
  api_refresh_token: string;
  api_group_filter: string;
  snmp_device_id: number | null;
  site_id: number | null;
  site_name: string | null;
  // SNMP source: link an existing monitored device vs provision a new one inline.
  snmp_source: 'existing' | 'new';
  ip_address: string;
  snmp_version: '2c' | '3';
  snmp_community: string;
  snmp_port: string;          // kept as string for the input; coerced to int on submit
  snmp_v3_user: string;
  snmp_v3_auth_pass: string;
  snmp_v3_priv_pass: string;
}

type TabKey = 'overview' | 'aps' | 'ssids' | 'intelligence' | 'clients' | 'rogues' | 'controllers';

// ── Rogue AP contract (mirrors wireless_rogue_aps + controller join) ──
interface RogueAp {
  id: number;
  controller_id: number;
  bssid: string;
  ssid: string | null;
  rssi_dbm: number | null;
  channel: number | null;
  classification: 'rogue' | 'friendly' | 'malicious' | 'unclassified' | 'interfering' | string;
  detecting_ap: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  controller_name: string | null;
  site_name: string | null;
  vendor: string | null;
}

// Classification colour: malicious/rogue = red, interfering = yellow,
// friendly/known = green, anything else (unclassified) = muted.
function rogueClassColor(c: string): string {
  switch ((c || '').toLowerCase()) {
    case 'malicious':
    case 'rogue':
      return 'var(--red)';
    case 'interfering':
      return 'var(--yellow)';
    case 'friendly':
    case 'known':
      return 'var(--green)';
    default:
      return 'var(--text-muted)';
  }
}

// ── Wireless client contracts ─────────────────────────────────
interface WirelessClient {
  id: number;
  mac_address: string;
  ip_address: string | null;
  hostname: string | null;
  controller_id: number;
  ap_id: number | null;
  ap_name: string | null;
  ssid_name: string | null;
  band: string | null;
  channel: number | null;
  rssi_dbm: number | null;
  tx_rate_mbps: number | null;
  rx_rate_mbps: number | null;
  // Client-relative bandwidth (bits/sec): rx_bps = what the client downloaded,
  // tx_bps = what the client uploaded. Nullable — first poll after joining, or
  // an unsupported vendor/firmware, may not report either. BIGINT columns come
  // back from the API as strings (see fmtBps's comment) — always route through
  // fmtBps()/bwTotal(), never `+` these directly.
  rx_bps?: number | string | null;
  tx_bps?: number | string | null;
  connected_since: string | null;
  last_seen_at: string | null;
  auth_type: string | null;
  is_problem: boolean;
  is_sticky?: boolean;
  roaming_count: number;
  vendor: string;
  signal_quality: string;
  controller_name: string | null;
  site_name: string | null;
  phy_mode: string | null;
  vlan_id: number | null;
}

// ── Clients table sorting (top-level — not nested inside a component) ──────
type ClientSortKey =
  | 'mac_address' | 'ip_address' | 'ap_name' | 'ssid_name' | 'band'
  | 'vlan_id' | 'rssi_dbm' | 'tx_rate_mbps' | 'connected_since' | 'status' | 'bandwidth';

// Numeric status rank mirroring ClientStatusBadge's exact precedence (worst
// first): 0=Sticky, 1=Low Signal, 2=Frequent Roamer, 3=Normal. Ascending sort
// on 'status' therefore shows the worst clients first, matching the API's
// existing default problem-first ordering.
function clientStatusRank(c: WirelessClient): number {
  if (c.is_sticky) return 0;
  if (c.rssi_dbm != null && c.rssi_dbm < -75) return 1;
  if (Number(c.roaming_count) > 5) return 2;
  return 3;
}

// Returns the comparable value for a given column. Numeric columns return a
// number (or null when unknown); string columns return a lowercased string
// (or null when empty/missing). Returning null — rather than an empty string
// — for missing values lets the sort comparator pin those rows to the bottom
// of the list for EVERY column, in both sort directions (see the `sorted`
// useMemo in ClientsTab).
function clientSortValue(c: WirelessClient, key: ClientSortKey): number | string | null {
  switch (key) {
    case 'mac_address': return c.mac_address.toLowerCase();
    case 'ip_address': return c.ip_address ? c.ip_address.toLowerCase() : null;
    case 'ap_name': return c.ap_name ? c.ap_name.toLowerCase() : null;
    case 'ssid_name': return c.ssid_name ? c.ssid_name.toLowerCase() : null;
    case 'band': return c.band ? c.band.toLowerCase() : null;
    case 'vlan_id': return c.vlan_id;
    case 'rssi_dbm': return c.rssi_dbm;
    case 'tx_rate_mbps': return c.tx_rate_mbps;
    case 'connected_since': return c.connected_since;
    case 'status': return clientStatusRank(c);
    case 'bandwidth': return bwTotal(c);
    default: return null;
  }
}

interface ClientEvent {
  event_type: string;
  from_ap_name: string | null;
  to_ap_name: string | null;
  rssi_dbm: number | null;
  ssid_name: string | null;
  ts: string;
}

interface ClientDetail {
  client: WirelessClient;
  events: ClientEvent[];
  stats: {
    total_roams_24h: number;
    avg_rssi_24h: number | null;
    time_connected_today: string | null;
    ssids_used: string[];
  };
}

// One row per ~10-min poll from wireless_client_history (pruned at 7 days).
// rx_bps/tx_bps are nullable per-point (e.g. right after a collector restart
// the byte-counter delta can't be computed yet) — a gap, not a zero.
interface ClientHistoryPoint {
  ts: string;
  rx_bps: number | string | null;
  tx_bps: number | string | null;
  rssi_dbm: number | null;
}

interface ClientHistory {
  range: '24h' | '7d';
  points: ClientHistoryPoint[];
}

interface ClientSummary {
  total_clients: number;
  by_band: Record<string, number>;
  by_controller: { controller_id: number; controller_name: string; client_count: number; problem_count: number }[];
  problem_clients: number;
  sticky_clients: number;
  low_signal_clients: number;
  frequent_roamers: number;
  top_aps_by_clients: { ap_name: string; count: number }[];
  top_clients_by_bandwidth: ClientBandwidthRow[];
}

// Row shape of `top_clients_by_bandwidth` on GET /api/wireless/clients/summary —
// top 10 clients ordered by rx_bps+tx_bps, excluding clients with no bandwidth
// data at all. A trimmed subset of WirelessClient's fields (the backend query
// only projects what this card needs).
interface ClientBandwidthRow {
  mac_address: string;
  hostname: string | null;
  ip_address: string | null;
  ap_name: string | null;
  ssid_name: string | null;
  controller_id: number;
  // BIGINT columns come back from the API as strings — see fmtBps's comment.
  rx_bps: number | string | null;
  tx_bps: number | string | null;
}

// ── Wireless Intelligence contracts ───────────────────────────
interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  issue: string;
  action: string;
  affected_aps?: string[];
  affected_count?: number;
  metric?: string;
  controller_id?: number;
  controller_name?: string;
}

interface WorstAp {
  ap_id: number;
  ap_name: string;
  controller_id: number;
  site_name: string | null;
  health_score: number;
  health_grade: string;
  load_status: string;
  issues: string[];
}

interface IntelSummary {
  overall_score: number;
  overall_grade: string;
  total_recommendations: number;
  critical_count: number;
  high_count: number;
  top_issues: Recommendation[];
  worst_aps: WorstAp[];
  band_steering_avg: number;
  controllers: {
    id: number;
    name: string;
    overall_score: number;
    grade: string;
    overloaded_aps: number;
    co_channel_pairs: number;
  }[];
}

interface IntelRow {
  id: number;
  controller_id: number;
  controller_name: string;
  vendor: string;
  computed_at: string;
  co_channel_pairs: number;
  interference_score: number;
  load_balance_score: number;
  overloaded_aps: number;
  underloaded_aps: number;
  avg_clients_per_ap: number;
  max_clients_per_ap: number;
  band_2g_pct: number;
  band_5g_pct: number;
  band_steering_score: number;
  // null when the controller's vendor reports no channel utilization at all
  // (e.g. aruba_central) — see UTIL_UNAVAILABLE_VENDORS in wirelessIntelligence.js.
  high_util_ap_count: number | null;
  critical_util_count: number | null;
  capacity_score: number | null;
  overall_score: number;
  overall_grade: string;
  recommendations: Recommendation[];
}

// ── Formatting / RF helpers (top-level) ───────────────────────
// Postgres BIGINT columns (rx_bps/tx_bps) come back from the API as STRINGS,
// not numbers — the pg driver does this for every int8/bigint column to avoid
// silently losing precision above Number.MAX_SAFE_INTEGER. Number(...) here
// converts before any arithmetic; skipping this in bwTotal() below is exactly
// what caused two bigint strings to get `+`-concatenated ("1459311"+"254812"
// = "1459311254812") instead of added, producing wildly wrong bandwidth
// figures that were nonetheless internally consistent (not random garbage).
function fmtBps(n: number | string | null | undefined): string {
  if (n == null) return '—';
  const v = Number(n);
  if (isNaN(v)) return '—';
  if (Math.abs(v) < 1e6) return `${(v / 1e3).toFixed(1)} Kbps`;
  return `${(v / 1e6).toFixed(1)} Mbps`;
}

// Combined client bandwidth (rx_bps + tx_bps) for sorting/display. Only null
// when BOTH directions are unknown (first poll after joining, or an
// unsupported vendor/firmware) — a single known direction still yields a
// number, treating the missing side as 0 rather than propagating null.
// Number(...) on each operand is required, not cosmetic — see fmtBps's
// comment above: these arrive as strings, and `+` on two strings concatenates.
function bwTotal(c: { rx_bps?: number | string | null; tx_bps?: number | string | null }): number | null {
  if (c.rx_bps == null && c.tx_bps == null) return null;
  return (Number(c.rx_bps) || 0) + (Number(c.tx_bps) || 0);
}

// A real noise floor is always strongly negative dBm. Null/0/positive means the
// vendor did not report it — show "No data" rather than misclassifying it as Poor.
function noiseFloorValid(dbm: number | null): boolean {
  return dbm != null && !isNaN(dbm) && dbm < 0;
}

function noiseBadge(dbm: number | null): { label: string; color: string } {
  if (!noiseFloorValid(dbm)) return { label: 'No data', color: 'var(--text-muted)' };
  if (dbm! <= -85) return { label: 'Excellent', color: 'var(--green)' };
  if (dbm! <= -75) return { label: 'Fair', color: 'var(--yellow)' };
  return { label: 'Poor', color: 'var(--red)' };
}


// ── Wireless client signal helpers (top-level) ────────────────
function signalColor(rssi: number | null): string {
  if (rssi == null || isNaN(rssi)) return 'var(--text-muted)';
  if (rssi >= -70) return 'var(--green)';
  if (rssi >= -80) return 'var(--yellow)';
  return 'var(--red)';
}

function signalLabel(rssi: number | null): string {
  if (rssi == null || isNaN(rssi)) return 'Unknown';
  if (rssi >= -60) return 'Excellent';
  if (rssi >= -70) return 'Good';
  if (rssi >= -80) return 'Fair';
  return 'Poor';
}

function fmtRate(mbps: number | null): string {
  if (mbps == null || isNaN(Number(mbps))) return '—';
  return `${Math.round(Number(mbps))} Mbps`;
}

const VENDOR_OPTIONS = [
  'aruba', 'cisco', 'fortinet', 'ruckus', 'mikrotik',
  'hpe', 'grandstream', 'ubiquiti', 'omada', 'aruba_central',
];

// Only aruba_central needs a display label distinct from its raw value —
// every other option is already rendered as-is (lowercase vendor id).
function vendorLabel(v: string): string {
  return v === 'aruba_central' ? 'Aruba Central' : v;
}

// Aruba Central's API never returns a per-band (2.4/5/6GHz) client split —
// wireless_aps.clients_2g/5g/6g are NOT NULL DEFAULT 0 columns, so a genuine
// "we don't have this" comes back as 0, not null. Once clients_total is real
// for this vendor, rendering "8 clients, 0 on 2.4GHz, 0 on 5GHz" reads as
// "8 clients connected to neither band" — misleading. clients_total IS real
// for this vendor and must still render normally; only the per-band figures
// need to be suppressed.
function perBandUnavailable(vendor: string | null | undefined): boolean {
  return vendor === 'aruba_central';
}

// A separate per-AP RF-enrichment collector pass now populates real, current
// radio_2g/5g_util_pct on the wireless_aps row for aruba_central APs, so the
// CURRENT-AP-row util suppression this helper used to gate is gone — see the
// reverted apUtil()/AP table/detail-drawer call sites. The one place this is
// still genuinely true is the 24h HISTORICAL chart below: wireless_history is
// populated only by the main 5-min poll, which still writes null util for
// this vendor (the RF-enrichment pass runs on its own slower cycle and does
// not backfill history), so that chart alone still gates on this helper.
function utilUnavailable(vendor: string | null | undefined): boolean {
  return vendor === 'aruba_central';
}

const CHART_COLORS = {
  total: 'var(--primary)',
  g2: '#0ea5e9',
  g5: '#16a34a',
};

// Client bandwidth trend colours — mirrors devices/[id] page's interface
// traffic chart convention (download/rx = blue "In", upload/tx = orange "Out"),
// and the same "↓ rx · ↑ tx" pairing already used in the client table tooltip.
const CLIENT_BW_RX_COLOR = '#3b82f6';
const CLIENT_BW_TX_COLOR = '#f97316';

// ════════════════════════════════════════════════════════════
// Shared compact UI primitives (top-level — design-rule sized)
// ════════════════════════════════════════════════════════════

// Compact stat card: ~75px tall, 24px bold value, 11px uppercase label.
// When `onClick` is supplied the tile becomes clickable (cursor + hover lift).
function StatCard({ value, label, sub, color, valueColor, onClick, title }: {
  value: React.ReactNode;
  label: string;
  sub?: React.ReactNode;
  color?: string;          // left border accent
  valueColor?: string;     // value text color
  onClick?: () => void;    // optional drill-down
  title?: string;          // tooltip when clickable
}) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      title={clickable ? title : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
      className={clickable ? 'sv-statcard-clickable' : undefined}
      style={{
        flex: '1 1 0', minWidth: 120, minHeight: 75, boxSizing: 'border-box',
        padding: '12px 16px', background: 'var(--bg-card)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        borderLeft: `3px solid ${color || 'var(--border)'}`,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        cursor: clickable ? 'pointer' : undefined,
        transition: clickable ? 'box-shadow .12s, transform .12s' : undefined,
      }}
    >
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, lineHeight: 1.1, color: valueColor }}>
        {value}
      </div>
      {sub != null && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>
      )}
      <div style={{
        fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: 0.4, marginTop: 2,
      }}>{label}</div>
    </div>
  );
}

// A row of equal-width stat cards (responsive 6-up).
function StatRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
      {children}
    </div>
  );
}

// Section card: padding 16/20, 12px uppercase 600 muted heading.
function SectionCard({ title, action, maxHeight, scroll, children, flex, minWidth }: {
  title: string;
  action?: React.ReactNode;
  maxHeight?: number;
  scroll?: boolean;
  children: React.ReactNode;
  flex?: string;
  minWidth?: number;
}) {
  return (
    <div style={{
      flex: flex || '1 1 0', minWidth: minWidth ?? 0, boxSizing: 'border-box',
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '16px 20px',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          fontSize: 'var(--text-sm)', fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: 0.4, color: 'var(--text-muted)', flex: 1,
        }}>{title}</span>
        {action}
      </div>
      <div style={maxHeight != null ? { maxHeight, overflowY: scroll === false ? 'visible' : 'auto', flex: 1 } : { flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

// Equal-height responsive row (align-items: stretch).
function EqualRow({ children, marginTop }: { children: React.ReactNode; marginTop?: number }) {
  return (
    <div style={{
      display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch',
      marginTop: marginTop ?? 16,
    }}>{children}</div>
  );
}

// Subtle muted caption shown in a clickable container's header area, hinting
// that rows can be drilled into. Understated, matches existing muted styling.
function DrillHint({ label }: { label?: string }) {
  return (
    <span style={{
      fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 400,
      textTransform: 'none', letterSpacing: 0, whiteSpace: 'nowrap',
    }}>{label || 'Click a row to drill in'}</span>
  );
}

// Suite-standard opaque sticky header for `.sv-table` headers (CLAUDE.md rule):
// the `.sv-table th` class already provides font/padding/color; this only adds the
// sticky positioning + an OPAQUE background so scrolled rows never bleed through.
const STICKY_TH: React.CSSProperties = {
  position: 'sticky', top: 0, zIndex: 5,
  background: 'var(--bg-card)', boxShadow: '0 1px 0 var(--border)',
};

// CPU/Mem style 4px progress bar, green<60 yellow<80 red.
function ProgressBar({ pct, width }: { pct: number | null | undefined; width?: number }) {
  const v = Number(pct);
  const p = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  const c = p > 80 ? 'var(--red)' : p >= 60 ? 'var(--yellow)' : 'var(--green)';
  return (
    <div style={{
      width: width ?? 48, height: 4, borderRadius: 2, background: 'var(--border)',
      overflow: 'hidden', display: 'inline-block', verticalAlign: 'middle',
    }}>
      <div style={{ width: `${p}%`, height: '100%', background: c }} />
    </div>
  );
}

// Grade badge pill.
function GradeBadge({ grade }: { grade: string }) {
  const c = gradeColor(grade);
  return (
    <span style={{
      fontSize: 'var(--text-xs)', fontWeight: 700, color: c, border: `1px solid ${c}`,
      borderRadius: 4, padding: '0 6px', lineHeight: '16px', display: 'inline-block',
    }}>{grade}</span>
  );
}

// Compact score card with grade + (neutral) trend arrow.
function ScoreCard({ label, score, grade }: { label: string; score: number; grade?: string }) {
  const v = Math.round(score);
  return (
    <div style={{
      flex: '1 1 0', minWidth: 140, minHeight: 75, boxSizing: 'border-box',
      padding: '12px 16px', background: 'var(--bg-card)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
      borderLeft: `3px solid ${scoreColor(v)}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: scoreColor(v) }}>{v}</span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>/100</span>
        {grade && <GradeBadge grade={grade} />}
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginLeft: 'auto' }} title="No historical trend data">→</span>
      </div>
      <div style={{
        fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: 0.4, marginTop: 4,
      }}>{label}</div>
    </div>
  );
}

// A controller is in an HA relationship when it reports a role (Active/Standby),
// a peer, or has been manually paired — regardless of the sync code (some
// platforms report a non-"Synced" sync value even when HA is configured).
function controllerInHa(c: { ha_mode?: string | null; ha_peer_ip?: string | null; ha_peer_name?: string | null; ha_peer_controller_id?: number | null }): boolean {
  return c.ha_mode === 'Active' || c.ha_mode === 'Standby'
    || (c.ha_peer_ip != null && c.ha_peer_ip !== '')
    || c.ha_peer_controller_id != null;
}

// HA label derivation from a controller's ha fields. A present role wins over the
// sync code (a controller reporting Active with a peer is in HA even if its sync
// value maps to "Standalone").
function haCellLabel(ha_mode: string | null, ha_sync_status: string | null): { text: string; color: string; dot: boolean } {
  if (ha_mode === 'Active') return { text: 'Active', color: 'var(--green)', dot: true };
  if (ha_mode === 'Standby') return { text: 'Standby', color: 'var(--text-muted)', dot: true };
  if (ha_sync_status === 'Standalone') return { text: 'Standalone', color: 'var(--text-muted)', dot: false };
  if (ha_mode == null || ha_sync_status == null) return { text: 'N/A', color: 'var(--text-muted)', dot: false };
  if (ha_mode === 'Active') return { text: 'Active', color: 'var(--green)', dot: true };
  if (ha_mode === 'Standby') return { text: 'Standby', color: 'var(--text-muted)', dot: true };
  return { text: ha_mode, color: 'var(--text-muted)', dot: true };
}

// ════════════════════════════════════════════════════════════
// Page
// ════════════════════════════════════════════════════════════

export default function WirelessPage() {
  const [tab, setTab] = useState<TabKey>('overview');
  // Deep-link support: the dashboard's Wireless Health chips link here with ?tab=intelligence|clients
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    const valid: TabKey[] = ['overview', 'aps', 'ssids', 'intelligence', 'clients', 'rogues', 'controllers'];
    if (t && (valid as string[]).includes(t)) setTab(t as TabKey);
  }, []);
  const [siteFilter, setSiteFilter] = useState<number | null>(null);
  const [controllerFilter, setControllerFilter] = useState<number | null>(null);
  const [apStatusFilter, setApStatusFilter] = useState<string>('');
  const [clientApFilter, setClientApFilter] = useState<number | null>(null);
  const [clientProblemOnly, setClientProblemOnly] = useState(false);
  const [ssidControllerFilter, setSsidControllerFilter] = useState<number | null>(null);

  function gotoApsForSite(siteId: number | null) {
    setSiteFilter(siteId);
    setControllerFilter(null);
    setApStatusFilter('');
    setTab('aps');
  }

  function gotoApsForController(controllerId: number | null) {
    setControllerFilter(controllerId);
    setSiteFilter(null);
    setApStatusFilter('');
    setTab('aps');
  }

  function gotoAllAps() {
    setSiteFilter(null);
    setControllerFilter(null);
    setApStatusFilter('');
    setTab('aps');
  }

  function gotoApsOffline() {
    setApStatusFilter('offline');
    setSiteFilter(null);
    setControllerFilter(null);
    setTab('aps');
  }

  function gotoSsidsForController(controllerId: number | null) {
    setSsidControllerFilter(controllerId);
    setTab('ssids');
  }

  function gotoIntelligence() {
    setTab('intelligence');
  }

  function gotoClientsForAp(apId: number | null) {
    setClientApFilter(apId);
    setClientProblemOnly(false);
    setTab('clients');
  }

  function gotoProblemClients() {
    setClientProblemOnly(true);
    setClientApFilter(null);
    setTab('clients');
  }

  return (
    <div>
      <PageHeader title="Wireless" subtitle="Access points and wireless controllers" />

      <div className="sv-tabs sticky">
        <button
          className={`sv-tab ${tab === 'overview' ? 'active' : ''}`}
          onClick={() => setTab('overview')}
        >Wireless Insights</button>
        <button
          className={`sv-tab ${tab === 'aps' ? 'active' : ''}`}
          onClick={() => setTab('aps')}
        >Access Points</button>
        <button
          className={`sv-tab ${tab === 'ssids' ? 'active' : ''}`}
          onClick={() => setTab('ssids')}
        >SSIDs</button>
        <button
          className={`sv-tab ${tab === 'intelligence' ? 'active' : ''}`}
          onClick={() => setTab('intelligence')}
        >Intelligence</button>
        <button
          className={`sv-tab ${tab === 'clients' ? 'active' : ''}`}
          onClick={() => setTab('clients')}
        >Clients</button>
        <button
          className={`sv-tab ${tab === 'rogues' ? 'active' : ''}`}
          onClick={() => setTab('rogues')}
        >Rogue APs</button>
        <button
          className={`sv-tab ${tab === 'controllers' ? 'active' : ''}`}
          onClick={() => setTab('controllers')}
        >Controllers</button>
      </div>

      {tab === 'overview' && (
        <OverviewTab
          onSelectSite={gotoApsForSite}
          onViewIntelligence={gotoIntelligence}
          onViewProblemClients={gotoProblemClients}
          onViewApClients={gotoClientsForAp}
          onFilterController={gotoApsForController}
          onSsidsForController={gotoSsidsForController}
          onViewAllAps={gotoAllAps}
          onViewOfflineAps={gotoApsOffline}
          onViewClients={() => setTab('clients')}
          onViewControllers={() => setTab('controllers')}
        />
      )}
      {tab === 'aps' && (
        <AccessPointsTab
          siteFilter={siteFilter}
          setSiteFilter={setSiteFilter}
          controllerFilter={controllerFilter}
          setControllerFilter={setControllerFilter}
          statusFilter={apStatusFilter}
          setStatusFilter={setApStatusFilter}
          onFilterController={gotoApsForController}
          onViewAllClients={gotoClientsForAp}
        />
      )}
      {tab === 'ssids' && (
        <SsidsTab
          controllerFilter={ssidControllerFilter}
          setControllerFilter={setSsidControllerFilter}
        />
      )}
      {tab === 'intelligence' && <IntelligenceTab onViewApClients={gotoClientsForAp} />}
      {tab === 'clients' && (
        <ClientsTab
          apFilter={clientApFilter}
          setApFilter={setClientApFilter}
          problemOnly={clientProblemOnly}
          setProblemOnly={setClientProblemOnly}
        />
      )}
      {tab === 'rogues' && <RogueApsTab />}
      {tab === 'controllers' && <ControllersTab onViewEvents={() => setTab('clients')} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB — Rogue APs
// ════════════════════════════════════════════════════════════

function RogueApsTab() {
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState('');

  const roguesApi = useApi<RogueAp[]>('/api/wireless/rogues', 30000);
  const all = useMemo(() => roguesApi.data || [], [roguesApi.data]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (classFilter && (r.classification || '').toLowerCase() !== classFilter) return false;
      if (q && !(r.bssid || '').toLowerCase().includes(q) && !(r.ssid || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [all, search, classFilter]);

  const threatCount = useMemo(
    () => all.filter((r) => ['rogue', 'malicious'].includes((r.classification || '').toLowerCase())).length,
    [all],
  );

  return (
    <div>
      <div className="sv-cards">
        <div className="sv-card">
          <div className="num">{all.length}</div>
          <div className="label">Detected APs</div>
        </div>
        <div className="sv-card" style={{ borderLeftColor: 'var(--red)' }}>
          <div className="num" style={{ color: threatCount > 0 ? 'var(--red)' : undefined }}>{threatCount}</div>
          <div className="label">Rogue / Malicious</div>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '14px 0',
      }}>
        <input
          className="sv-input"
          style={{ maxWidth: 320, flex: 1 }}
          placeholder="Search by BSSID or SSID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="sv-select"
          style={{ maxWidth: 200 }}
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value)}
        >
          <option value="">All classifications</option>
          <option value="malicious">Malicious</option>
          <option value="rogue">Rogue</option>
          <option value="interfering">Interfering</option>
          <option value="friendly">Friendly</option>
          <option value="unclassified">Unclassified</option>
        </select>
      </div>

      {roguesApi.error && <ErrorBox message={roguesApi.error} />}

      {roguesApi.loading && !roguesApi.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : shown.length ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <table className="sv-table">
            <thead>
              <tr>
                <th style={STICKY_TH}>BSSID</th>
                <th style={STICKY_TH}>SSID</th>
                <th style={STICKY_TH}>Classification</th>
                <th style={STICKY_TH}>RSSI</th>
                <th style={STICKY_TH}>Channel</th>
                <th style={STICKY_TH}>Detecting AP</th>
                <th style={STICKY_TH}>Controller</th>
                <th style={STICKY_TH}>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const color = rogueClassColor(r.classification);
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{r.bssid}</td>
                    <td>{r.ssid || '—'}</td>
                    <td>
                      <span className="sv-badge" style={{ color, borderColor: color, textTransform: 'capitalize' }}>
                        {r.classification || 'unclassified'}
                      </span>
                    </td>
                    <td style={{ color: signalColor(r.rssi_dbm), fontWeight: 600 }}>
                      {r.rssi_dbm != null ? `${r.rssi_dbm} dBm` : '—'}
                    </td>
                    <td>{r.channel != null ? `Ch ${r.channel}` : '—'}</td>
                    <td>{r.detecting_ap || '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{r.controller_name || '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{fmtRel(r.last_seen_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty message={all.length ? 'No rogue APs match your filters.' : 'No rogue APs detected. ✓'} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB 1 — Overview
// ════════════════════════════════════════════════════════════

// Slim, single-line intelligence summary banner shown at the bottom of the
// Overview tab. Pulls from /intelligence/summary; degrades gracefully when data
// is missing. `coChannel` and `band5Pct` are derived client-side by OverviewTab.
function IntelBanner({ onView, coChannel, band5Pct }: {
  onView: () => void;
  coChannel: number | null;
  band5Pct: number | null;
}) {
  const summary = useApi<IntelSummary>('/api/wireless/intelligence/summary', 30000);
  const s = summary.data;
  if (!s || !s.controllers || s.controllers.length === 0) return null;

  const score = Math.round(Number(s.overall_score));
  const recs = Number(s.total_recommendations) || 0;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        marginTop: 16, padding: '10px 16px', borderRadius: 'var(--radius-sm)',
        border: '1px solid color-mix(in srgb, #2563eb 35%, var(--border))',
        background: 'color-mix(in srgb, #2563eb 8%, transparent)',
        fontSize: 'var(--text-base)', color: 'var(--text-secondary)',
      }}
    >
      <span>
        <strong>Wireless Health:</strong>{' '}
        <span style={{ color: scoreColor(score), fontWeight: 700 }}>
          {score}/100 {s.overall_grade}
        </span>
        {' · '}{recs} recommendation{recs === 1 ? '' : 's'}
        {s.critical_count > 0 && (
          <span style={{ color: 'var(--red)', fontWeight: 700 }}> ({s.critical_count} critical)</span>
        )}
        {coChannel != null && coChannel > 0 && <>{' · '}{coChannel} APs co-channel</>}
        {band5Pct != null && <>{' · '}{Math.round(band5Pct)}% on 5GHz</>}
      </span>
      <span style={{ flex: 1 }} />
      <button className="sv-btn ghost sm" onClick={onView}>View Intelligence →</button>
    </div>
  );
}

function apUtil(ap: AccessPoint): number {
  return Math.max(ap.radio_2g_util_pct || 0, ap.radio_5g_util_pct || 0);
}

// ── Controller status strip (Insights tab) (top-level) ────────
// Compact per-controller rows: status dot, name, AP count, client count, CPU%.
// Sourced from the already-fetched /api/wireless/controllers payload — no new fetch.
function ControllerStatusCard({ controllers, onSelect }: { controllers: Controller[]; onSelect?: (controllerId: number) => void }) {
  if (!controllers.length) return <Empty message="No controllers." />;
  return (
    <table className="sv-table">
      <thead><tr>
        <th style={STICKY_TH}>Controller</th><th style={STICKY_TH}>APs</th>
        <th style={STICKY_TH}>Clients</th><th style={STICKY_TH}>CPU</th>
      </tr></thead>
      <tbody>
        {controllers.map((c) => {
          const cpu = (c as { cpu_pct?: number | null }).cpu_pct;
          return (
            <tr key={c.id}
              style={onSelect ? { cursor: 'pointer' } : undefined}
              onClick={onSelect ? () => onSelect(c.id) : undefined}
              title={onSelect ? 'View access points for this controller' : undefined}>
              <td style={{ fontWeight: 600 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <StatusDot status={c.status === 'ok' ? 'up' : (c.status ? 'down' : 'unknown')} />
                  {c.name}
                </span>
              </td>
              <td>{fmtInt(c.ap_count)}</td>
              <td>{fmtInt(c.client_count)}</td>
              <td style={{ color: cpu != null ? pctColor(cpu) : 'var(--text-muted)', fontWeight: 600 }}>
                {cpu != null ? fmtPct(cpu) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OverviewTab({
  onSelectSite, onViewIntelligence, onViewProblemClients, onViewApClients,
  onFilterController, onSsidsForController, onViewAllAps, onViewOfflineAps,
  onViewClients, onViewControllers,
}: {
  onSelectSite: (siteId: number | null) => void;
  onViewIntelligence: () => void;
  onViewProblemClients: () => void;
  onViewApClients: (apId: number | null) => void;
  onFilterController: (controllerId: number | null) => void;
  onSsidsForController: (controllerId: number | null) => void;
  onViewAllAps: () => void;
  onViewOfflineAps: () => void;
  onViewClients: () => void;
  onViewControllers: () => void;
}) {
  const [selectedApId, setSelectedApId] = useState<number | null>(null);
  const [selectedClientMac, setSelectedClientMac] = useState<string | null>(null);
  const summary = useApi<WirelessSummary>('/api/wireless/summary', 30000);
  const apsApi = useApi<AccessPoint[]>('/api/wireless/aps', 30000);
  const ssidSummary = useApi<SsidSummary>('/api/wireless/ssids/summary', 30000);
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 30000);
  const clientSummary = useApi<ClientSummary>('/api/wireless/clients/summary', 30000);

  const aps = useMemo(() => apsApi.data || [], [apsApi.data]);

  const topApsByClients = useMemo(
    () => [...aps].sort((a, b) => (b.clients_total || 0) - (a.clients_total || 0)).slice(0, 5),
    [aps],
  );
  // Already ordered + capped (top 10) server-side by rx_bps+tx_bps; slice to 5
  // client-side to match the row density of the other Row 2 cards (maxHeight 200).
  const topClientsByBandwidth = useMemo(
    () => (clientSummary.data?.top_clients_by_bandwidth || []).slice(0, 5),
    [clientSummary.data],
  );
  const offlineAps = useMemo(() => aps.filter((a) => a.status === 'offline'), [aps]);
  const highUtilAps = useMemo(
    () => aps.filter((a) => apUtil(a) > 70).sort((a, b) => apUtil(b) - apUtil(a)),
    [aps],
  );

  // Co-channel count: APs sharing a 2.4GHz or 5GHz channel with another AP.
  const coChannelCount = useMemo(() => {
    const counts = new Map<string, number>();
    aps.forEach((a) => {
      if (a.radio_2g_channel != null) counts.set(`2-${a.radio_2g_channel}`, (counts.get(`2-${a.radio_2g_channel}`) || 0) + 1);
      if (a.radio_5g_channel != null) counts.set(`5-${a.radio_5g_channel}`, (counts.get(`5-${a.radio_5g_channel}`) || 0) + 1);
    });
    let n = 0;
    aps.forEach((a) => {
      const co2 = a.radio_2g_channel != null && (counts.get(`2-${a.radio_2g_channel}`) || 0) > 1;
      const co5 = a.radio_5g_channel != null && (counts.get(`5-${a.radio_5g_channel}`) || 0) > 1;
      if (co2 || co5) n += 1;
    });
    return n;
  }, [aps]);

  // % of clients on 5GHz (derived from AP clients_5g vs total). Vendors with
  // no per-band breakdown (see perBandUnavailable) are excluded entirely —
  // their clients_total is real but clients_5g is always 0 (not a confirmed
  // zero), so including them would silently drag this percentage down.
  const band5Pct = useMemo(() => {
    let total = 0, g5 = 0;
    aps.forEach((a) => {
      if (perBandUnavailable(a.vendor)) return;
      total += a.clients_total || 0; g5 += a.clients_5g || 0;
    });
    return total > 0 ? (g5 / total) * 100 : null;
  }, [aps]);

  if (summary.loading && !summary.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (summary.error) return <ErrorBox message={summary.error} />;
  if (!summary.data) return <Empty message="No wireless data available." />;

  const s = summary.data;
  // A site's avg_util is null when every AP there is a vendor with no util
  // data at all (see utilUnavailable) — the backend already excludes those
  // APs from its own AVG rather than coercing them to 0 (see /api/wireless/
  // summary's bySite query). Exclude such sites here too instead of letting
  // a null-as-0 site drag the fleet-wide figure down.
  const utilSites = s.by_site.filter((r) => r.avg_util != null);
  const avgUtil = utilSites.length
    ? utilSites.reduce((acc, r) => acc + (r.avg_util as number), 0) / utilSites.length
    : 0;
  const ctlCount = controllers.data ? controllers.data.length : (s.by_controller?.length ?? 0);

  return (
    <div>
      {/* Row 1 — 6 compact stat cards (clickable tiles drill into their tab) */}
      <StatRow>
        <StatCard value={fmtInt(s.total_aps)} label="Total APs" color="var(--primary)"
          onClick={onViewAllAps} title="View all access points" />
        <StatCard value={fmtInt(s.online_aps)} valueColor="var(--green)" label="Online" color="var(--green)" />
        <StatCard value={fmtInt(s.offline_aps)} valueColor={s.offline_aps > 0 ? 'var(--red)' : undefined} label="Offline" color="var(--red)"
          onClick={onViewOfflineAps} title="View offline access points" />
        <StatCard value={fmtInt(s.total_clients)} label="Clients"
          onClick={onViewClients} title="View wireless clients" />
        <StatCard value={fmtInt(ctlCount)} label="Controllers"
          onClick={onViewControllers} title="View wireless controllers" />
        <StatCard value={fmtPct(avgUtil)} valueColor={pctColor(avgUtil)} label="Avg Utilization" />
      </StatRow>

      {/* Row 2 — Site breakdown | Top APs | Top SSIDs */}
      <EqualRow>
        <SectionCard title="Site Breakdown" maxHeight={200} minWidth={240}>
          {s.by_site.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>Site</th><th style={STICKY_TH}>APs</th>
                <th style={STICKY_TH}>Online</th><th style={STICKY_TH}>Clients</th><th style={STICKY_TH}>Avg Util</th>
              </tr></thead>
              <tbody>
                {s.by_site.map((row: SummarySite) => (
                  <tr key={`${row.site_id ?? 'none'}-${row.site_name}`} style={{ cursor: 'pointer' }}
                    onClick={() => onSelectSite(row.site_id)} title="View access points for this site">
                    <td style={{ fontWeight: 600 }}>{row.site_name}</td>
                    <td>{row.aps}</td>
                    <td>{row.online}</td>
                    <td>{row.clients}</td>
                    <td style={{ color: row.avg_util == null ? 'var(--text-muted)' : pctColor(row.avg_util), fontWeight: 600 }}>{fmtPct(row.avg_util)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty message="No site data." />}
        </SectionCard>

        <SectionCard title="Top APs by Clients" action={<DrillHint />} maxHeight={200} minWidth={240}>
          {topApsByClients.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>AP Name</th><th style={STICKY_TH}>Clients</th><th style={STICKY_TH}>Util%</th>
              </tr></thead>
              <tbody>
                {topApsByClients.map((ap) => (
                  <tr key={ap.id} style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedApId(ap.id)} title="View access point details">
                    <td style={{ fontWeight: 600 }}>{ap.name}</td>
                    <td>{ap.clients_total}</td>
                    <td style={{ color: pctColor(apUtil(ap)), fontWeight: 600 }}>{fmtPct(apUtil(ap))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty message="No AP data." />}
        </SectionCard>

        <SectionCard title="Top SSIDs by Clients" action={<DrillHint />} maxHeight={200} minWidth={240}>
          {ssidSummary.data && ssidSummary.data.top_ssids.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>SSID</th><th style={STICKY_TH}>Controller</th><th style={STICKY_TH}>Clients</th>
              </tr></thead>
              <tbody>
                {ssidSummary.data.top_ssids.slice(0, 5).map((row: Ssid) => (
                  <tr key={row.id} style={{ cursor: 'pointer' }}
                    onClick={() => onSsidsForController(row.controller_id)}
                    title="View SSIDs for this controller">
                    <td style={{ fontWeight: 600 }}>{row.ssid_name}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{row.controller_name || '—'}</td>
                    <td>{row.clients_total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty message="No SSID data yet." />}
        </SectionCard>

      </EqualRow>

      {/* Row 3 — Top Clients by Bandwidth | Offline APs | High utilization APs */}
      <EqualRow>
        <SectionCard title="Top Clients by Bandwidth" action={<DrillHint />} maxHeight={160} minWidth={280}>
          {topClientsByBandwidth.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>Client</th><th style={STICKY_TH}>AP</th><th style={STICKY_TH}>Bandwidth</th>
              </tr></thead>
              <tbody>
                {topClientsByBandwidth.map((cl) => (
                  <tr key={cl.mac_address} style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedClientMac(cl.mac_address)} title="View client details">
                    <td style={{ fontWeight: 600 }}>{cl.hostname || cl.mac_address}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{cl.ap_name || '—'}</td>
                    <td title={`↓ ${fmtBps(cl.rx_bps)} · ↑ ${fmtBps(cl.tx_bps)}`}>{fmtBps(bwTotal(cl))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty message="No client bandwidth data yet." />}
        </SectionCard>

        <SectionCard
          title="Offline APs"
          action={(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              {offlineAps.length > 0 && <DrillHint />}
              <button className="sv-btn ghost sm" onClick={onViewProblemClients}
                title="View clients with connectivity / performance problems">
                View problem clients →
              </button>
            </span>
          )}
          maxHeight={160}
          minWidth={280}
        >
          {offlineAps.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>AP</th><th style={STICKY_TH}>Controller</th>
                <th style={STICKY_TH}>Site</th><th style={STICKY_TH}>Last Seen</th>
              </tr></thead>
              <tbody>
                {offlineAps.map((ap) => (
                  <tr key={ap.id} style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedApId(ap.id)} title="View access point details">
                    <td style={{ fontWeight: 600 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <StatusDot status="down" />{ap.name}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{ap.controller_name || '—'}</td>
                    <td>{ap.site_name || '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{fmtRel(ap.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--green)', fontWeight: 600, fontSize: 'var(--text-base)' }}><IconCheck width={14} height={14} /> All APs online</div>
          )}
        </SectionCard>

        <SectionCard title="High Utilization APs (>70%)"
          action={highUtilAps.length > 0 ? <DrillHint /> : undefined}
          maxHeight={160} minWidth={280}>
          {highUtilAps.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>AP</th><th style={STICKY_TH}>Util%</th><th style={STICKY_TH}>Clients</th>
              </tr></thead>
              <tbody>
                {highUtilAps.map((ap) => (
                  <tr key={ap.id} style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedApId(ap.id)} title="View access point details">
                    <td style={{ fontWeight: 600 }}>{ap.name}</td>
                    <td style={{ color: pctColor(apUtil(ap)), fontWeight: 600 }}>{fmtPct(apUtil(ap))}</td>
                    <td>{ap.clients_total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--green)', fontWeight: 600, fontSize: 'var(--text-base)' }}><IconCheck width={14} height={14} /> No congestion detected</div>
          )}
        </SectionCard>
      </EqualRow>

      {/* Row 4 — Controller status strip (from already-fetched controllers) */}
      {controllers.data && controllers.data.length > 0 && (
        <EqualRow>
          <SectionCard title="Controller Status" action={<DrillHint />} maxHeight={200} minWidth={280}>
            <ControllerStatusCard controllers={controllers.data} onSelect={onFilterController} />
          </SectionCard>
        </EqualRow>
      )}

      {/* Row 5 — Slim intelligence banner */}
      <IntelBanner onView={onViewIntelligence} coChannel={coChannelCount} band5Pct={band5Pct} />

      {/* AP detail drawer (opened from Top/Offline/High-Util AP rows) */}
      {selectedApId != null && (
        <IntelApDrawer
          apId={selectedApId}
          onClose={() => setSelectedApId(null)}
          onViewAllClients={(apId) => { setSelectedApId(null); onViewApClients(apId); }}
        />
      )}

      {/* Client detail panel (opened from Top Clients by Bandwidth rows) */}
      {selectedClientMac != null && (
        <ClientDetailPanel key={selectedClientMac} mac={selectedClientMac} onClose={() => setSelectedClientMac(null)} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB 2 — Access Points
// ════════════════════════════════════════════════════════════

// ── Per-controller collapse state, persisted in localStorage ──────────────────
// Key per the spec: sv-wireless-ctrl-{id}-collapsed. Shared across the APs and
// SSIDs tabs so a controller's collapse state is consistent.
function readCollapsed(id: number, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(`sv-wireless-ctrl-${id}-collapsed`);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* ignore */ }
  return fallback;
}
function writeCollapsed(id: number, collapsed: boolean) {
  try { window.localStorage.setItem(`sv-wireless-ctrl-${id}-collapsed`, collapsed ? '1' : '0'); } catch { /* ignore */ }
}

// A controller is treated as "online" when its last poll succeeded.
function controllerOnline(c: { status: string | null }): boolean {
  return c.status === 'ok';
}

// Build a minimal Controller object for APs/SSIDs whose controller isn't in the
// controllers list (orphans / unassigned).
function makeStubController(id: number, name: string, vendor: string | null): Controller {
  return {
    id, name, vendor: vendor || 'unknown', controller_url: null, api_username: null,
    snmp_device_id: null, site_id: null, site_name: null, active: true,
    last_polled_at: null, status: 'ok', ap_count: 0, client_count: 0,
  };
}

// ── Collapsible controller header (shared by AP + SSID groups) ────────────────
function ControllerGroupHeader({
  controller, online, summary, collapsed, onToggle,
}: {
  controller: Controller;
  online: boolean;
  summary: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
        padding: '10px 14px', background: 'var(--bg-primary)',
        border: '1px solid var(--border)', borderRadius: 8,
      }}
    >
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', width: 12, textAlign: 'center' }}>
        {collapsed ? '▶' : '▼'}
      </span>
      <StatusDot status={online ? 'up' : 'down'} />
      <span style={{ fontWeight: 700 }}>{controller.name}</span>
      <span className="sv-badge">{controller.vendor}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{summary}</span>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        {online ? `polled ${fmtRel(controller.last_polled_at)}` : `last seen ${fmtRel(controller.last_polled_at)}`}
      </span>
    </div>
  );
}

// ── Access-point table sorting ────────────────────────────────────────────────
type ApSort = { key: string; dir: 'asc' | 'desc' };

// Value extractor per sortable column. Strings sort case-insensitively; numeric
// columns push missing values to the bottom (ascending) so blanks don't lead.
// Missing values return null so the comparator can pin them LAST in BOTH sort
// directions (see sortAps) — instead of a low sentinel that a plain reverse()
// would flip to the top. clients/util keep 0 for "none" (a real value, not blank).
const AP_SORT_ACCESSORS: Record<string, (a: AccessPoint) => string | number | null> = {
  name: (a) => (a.name || '').toLowerCase() || null,
  site: (a) => (a.site_name || '').toLowerCase() || null,
  status: (a) => a.status || null,
  clients: (a) => a.clients_total || 0,
  ch2g: (a) => a.radio_2g_channel ?? null,
  ch5g: (a) => a.radio_5g_channel ?? null,
  util: (a) => Math.max(a.radio_2g_util_pct || 0, a.radio_5g_util_pct || 0),
  uptime: (a) => a.uptime_seconds ?? null,
  lastseen: (a) => (a.last_seen_at ? Date.parse(a.last_seen_at) : null),
};

function sortAps(aps: AccessPoint[], sort: ApSort | null): AccessPoint[] {
  if (!sort) return aps;
  const get = AP_SORT_ACCESSORS[sort.key];
  if (!get) return aps;
  const dir = sort.dir === 'asc' ? 1 : -1;
  // Real comparator with a direction multiplier — blank/missing (null) rows are
  // pinned last regardless of direction, mirroring the ClientsTab comparator.
  return [...aps].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const aNull = va == null;
    const bNull = vb == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

// Clickable, sort-aware table header cell (top-level per the no-nested-components rule).
function SortTh({ label, col, sort, onSort }: {
  label: string; col: string; sort: ApSort | null; onSort: (col: string) => void;
}) {
  const active = sort?.key === col;
  return (
    <th
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
      title="Click to sort"
    >
      {label}
      <span style={{ marginLeft: 4, color: active ? 'var(--sv-crimson)' : 'var(--text-muted)', fontSize: 'var(--text-xs)'}}>
        {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}

// ── One controller's collapsible AP group (own search + collapse state) ───────
function ApControllerGroup({
  controller, aps, onSelectAp,
}: {
  controller: Controller;
  aps: AccessPoint[];
  onSelectAp: (ap: AccessPoint) => void;
}) {
  const online = controllerOnline(controller);
  const [collapsed, setCollapsed] = useState<boolean>(!online);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ApSort | null>(null);

  useEffect(() => { setCollapsed(readCollapsed(controller.id, !online)); }, [controller.id, online]);

  function toggle() {
    setCollapsed((c) => { const n = !c; writeCollapsed(controller.id, n); return n; });
  }

  // Click a header: first click sorts ascending, click again toggles direction.
  function onSort(col: string) {
    setSort((s) => (s && s.key === col)
      ? { key: col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key: col, dir: 'asc' });
  }

  const clients = aps.reduce((s, a) => s + (a.clients_total || 0), 0);
  const summary = `${aps.length} AP${aps.length === 1 ? '' : 's'} · ${clients} client${clients === 1 ? '' : 's'}`;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = !q ? aps
      : aps.filter((a) => a.name.toLowerCase().includes(q) || (a.ip_address || '').toLowerCase().includes(q));
    return sortAps(filtered, sort);
  }, [aps, search, sort]);

  return (
    <div style={{ marginBottom: 12 }}>
      <ControllerGroupHeader
        controller={controller} online={online} summary={summary}
        collapsed={collapsed} onToggle={toggle}
      />
      {!collapsed && (
        <div className="sv-panel" style={{ padding: 0, marginTop: 8 }}>
          <div style={{ padding: '10px 12px' }}>
            <input
              className="sv-input"
              style={{ maxWidth: 240 }}
              placeholder="Search AP name or IP…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {shown.length ? (
            <table className="sv-table">
              <thead>
                <tr>
                  <SortTh label="AP Name" col="name" sort={sort} onSort={onSort} />
                  <SortTh label="Site" col="site" sort={sort} onSort={onSort} />
                  <SortTh label="Status" col="status" sort={sort} onSort={onSort} />
                  <SortTh label="Clients" col="clients" sort={sort} onSort={onSort} />
                  <SortTh label="2.4GHz" col="ch2g" sort={sort} onSort={onSort} />
                  <SortTh label="5GHz" col="ch5g" sort={sort} onSort={onSort} />
                  <SortTh label="Channel Util" col="util" sort={sort} onSort={onSort} />
                  <SortTh label="Uptime" col="uptime" sort={sort} onSort={onSort} />
                  <SortTh label="Last Seen" col="lastseen" sort={sort} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {shown.map((ap: AccessPoint) => (
                  <tr key={ap.id} style={{ cursor: 'pointer' }} onClick={() => onSelectAp(ap)}>
                    <td style={{ fontWeight: 600 }}>{ap.name}</td>
                    <td>{ap.site_name || '—'}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <StatusDot status={statusToDot(ap.status)} />
                        {ap.status}
                      </span>
                    </td>
                    <td title={perBandUnavailable(ap.vendor) ? 'Per-band breakdown not available for this vendor' : `${ap.clients_2g} on 2.4GHz, ${ap.clients_5g} on 5GHz`}>{ap.clients_total}</td>
                    <td>{ap.radio_2g_channel != null ? `Ch ${ap.radio_2g_channel}` : '—'}</td>
                    <td>{ap.radio_5g_channel != null ? `Ch ${ap.radio_5g_channel}` : '—'}</td>
                    <td style={{ minWidth: 140 }}>
                      <UtilBar pct={Math.max(ap.radio_2g_util_pct || 0, ap.radio_5g_util_pct || 0)} />
                    </td>
                    <td>{ap.uptime_formatted || '—'}</td>
                    <td>{fmtRel(ap.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty message="No access points match this search." />
          )}
        </div>
      )}
    </div>
  );
}

// Group APs/SSIDs by controller_id, attaching controller metadata. Rows whose
// controller is missing from the controllers list fall under a stub group.
function groupByController<T extends { controller_id: number | null; controller_name?: string | null; vendor?: string | null }>(
  rows: T[], controllers: Controller[],
): { controller: Controller; rows: T[] }[] {
  const ctrlMap = new Map<number, Controller>();
  controllers.forEach((c) => ctrlMap.set(c.id, c));
  const byCtrl = new Map<number, T[]>();
  for (const r of rows) {
    const cid = r.controller_id ?? 0;
    if (!byCtrl.has(cid)) byCtrl.set(cid, []);
    byCtrl.get(cid)!.push(r);
  }
  const out: { controller: Controller; rows: T[] }[] = [];
  for (const [cid, list] of byCtrl.entries()) {
    const controller = ctrlMap.get(cid)
      || makeStubController(cid, list[0]?.controller_name || 'Unassigned', list[0]?.vendor ?? null);
    out.push({ controller, rows: list });
  }
  out.sort((a, b) => a.controller.name.localeCompare(b.controller.name));
  return out;
}

function AccessPointsTab({
  siteFilter, setSiteFilter, controllerFilter, setControllerFilter,
  statusFilter, setStatusFilter, onFilterController, onViewAllClients,
}: {
  siteFilter: number | null;
  setSiteFilter: (v: number | null) => void;
  controllerFilter: number | null;
  setControllerFilter: (v: number | null) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  onFilterController: (controllerId: number | null) => void;
  onViewAllClients: (apId: number | null) => void;
}) {
  const status = statusFilter;
  const setStatus = setStatusFilter;
  const [vendor, setVendor] = useState('');
  const [selectedAp, setSelectedAp] = useState<AccessPoint | null>(null);

  const controllers = useApi<Controller[]>('/api/wireless/controllers', 30000);

  const qs = useMemo(() => {
    const params: string[] = [];
    if (controllerFilter != null) params.push(`controller_id=${controllerFilter}`);
    if (siteFilter != null) params.push(`site_id=${siteFilter}`);
    if (status) params.push(`status=${encodeURIComponent(status)}`);
    return params.length ? `?${params.join('&')}` : '';
  }, [controllerFilter, siteFilter, status]);

  const aps = useApi<AccessPoint[]>(`/api/wireless/aps${qs}`, 30000);
  const allAps = aps.data || [];

  const siteOptions = useMemo(() => {
    const map = new Map<number, string>();
    allAps.forEach((ap: AccessPoint) => {
      if (ap.site_id != null) map.set(ap.site_id, ap.site_name || `Site ${ap.site_id}`);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [allAps]);

  const vendorOptions = useMemo(() => {
    const set = new Set<string>();
    allAps.forEach((ap: AccessPoint) => { if (ap.vendor) set.add(ap.vendor); });
    return Array.from(set).sort();
  }, [allAps]);

  const groups = useMemo(() => {
    const vendorFiltered = vendor ? allAps.filter((ap) => ap.vendor === vendor) : allAps;
    return groupByController(vendorFiltered, controllers.data || []);
  }, [allAps, vendor, controllers.data]);

  const hasActiveLifted = siteFilter != null || controllerFilter != null || status !== '' || vendor !== '';

  return (
    <div>
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14,
      }}>
        <select
          className="sv-select"
          style={{ maxWidth: 200 }}
          value={siteFilter ?? ''}
          onChange={(e) => setSiteFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All sites</option>
          {siteOptions.map((s: { id: number; name: string }) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select
          className="sv-select"
          style={{ maxWidth: 160 }}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="unknown">Unknown</option>
        </select>
        <select
          className="sv-select"
          style={{ maxWidth: 160 }}
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
        >
          <option value="">All vendors</option>
          {vendorOptions.map((v: string) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        {hasActiveLifted && (
          <button
            className="sv-btn ghost sm"
            onClick={() => { setSiteFilter(null); setControllerFilter(null); setStatus(''); setVendor(''); }}
          >Clear filter</button>
        )}
      </div>

      {aps.error && <ErrorBox message={aps.error} />}

      {aps.loading && !aps.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : groups.length ? (
        groups.map(({ controller, rows }) => (
          <ApControllerGroup
            key={controller.id}
            controller={controller}
            aps={rows}
            onSelectAp={setSelectedAp}
          />
        ))
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No access points match the current filters." />
        </div>
      )}

      {selectedAp && (
        <ApDetailDrawer
          ap={selectedAp}
          onClose={() => setSelectedAp(null)}
          onFilterController={(cid) => { setSelectedAp(null); onFilterController(cid); }}
          onViewAllClients={(id) => { setSelectedAp(null); onViewAllClients(id); }}
        />
      )}
    </div>
  );
}

function statusToDot(status: string): string {
  if (status === 'online') return 'up';
  if (status === 'offline') return 'down';
  return 'unknown';
}

// Fixed-position overlays (drawers/modals) in this file are rendered inside
// .sv-content-col, which establishes its own stacking context (position:
// relative + z-index:0 in globals.css) specifically to keep page content from
// painting over .sv-topbar (z-index:50). That traps any inline
// position:'fixed' + high zIndex element painted below the topbar no matter
// how high its own zIndex is — visually hiding anything an overlay renders in
// roughly the top 72px (e.g. a drawer's name/status header). Portal the
// overlay straight into document.body so its stacking context is a sibling of
// .sv-topbar's ancestor instead of a descendant confined under it. document
// doesn't exist during SSR, so only portal once mounted client-side.
function useMountedPortal(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted;
}

// ── AP detail side drawer (top-level component) ───────────────
function ApDetailDrawer({
  ap, onClose, onFilterController, onViewAllClients,
}: {
  ap: AccessPoint;
  onClose: () => void;
  onFilterController: (controllerId: number | null) => void;
  onViewAllClients: (apId: number) => void;
}) {
  const mounted = useMountedPortal();
  const [history, setHistory] = useState<ApHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [apClients, setApClients] = useState<WirelessClient[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    apiGet<ApHistoryRow[]>(`/api/wireless/history/${ap.id}?range=24h`)
      .then((rows) => { if (!cancelled) setHistory(rows); })
      .catch((e: any) => { if (!cancelled) setErr(e?.message || 'Failed to load history'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ap.id]);

  useEffect(() => {
    let cancelled = false;
    setApClients([]);
    apiGet<WirelessClient[]>(`/api/wireless/aps/${ap.id}/clients`)
      .then((rows) => { if (!cancelled) setApClients(rows || []); })
      .catch(() => { if (!cancelled) setApClients([]); });
    return () => { cancelled = true; };
  }, [ap.id]);

  // Noise floor readings genuinely jitter several dB poll-to-poll (confirmed
  // against live production history) — and the 24h bucket size in
  // rangeToBucket() (api/server.js) is 5 minutes, matching the AP poll
  // interval almost 1:1, so the history endpoint's AVG() bucketing barely
  // smooths it at all. Padding the Y-axis domain (done separately) only stops
  // values hard-clipping at the chart edges; it can't turn ~288 genuinely
  // volatile raw points crammed into one chart width into a readable trend.
  // A trailing moving average does that instead, without touching the shared
  // history endpoint/bucket size the other 4 charts on this panel also use.
  const smoothedNoiseHistory = useMemo(
    () => movingAverage(history, ['noise_floor_2g', 'noise_floor_5g'], 6),
    [history]
  );

  if (!mounted) return null;
  return createPortal(
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 96vw)',
          background: 'var(--bg-card)', borderLeft: '1px solid var(--border)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.18)', overflowY: 'auto',
          padding: '20px 22px', zIndex: 60,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StatusDot status={statusToDot(ap.status)} />
          <h2 style={{ margin: 0, flex: 1 }}>{ap.name}</h2>
          <button className="sv-btn ghost sm" onClick={onClose}>Close</button>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', marginTop: 4 }}>
          {ap.site_name || '—'} · {ap.vendor || 'unknown vendor'} · {ap.status}
        </div>

        <h3 style={{ marginBottom: 6 }}>AP Info</h3>
        <table className="sv-table">
          <tbody>
            <tr><td style={{ color: 'var(--text-muted)' }}>Model</td><td>{ap.model || '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>MAC</td><td>{ap.mac_address || '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>IP</td><td>{ap.ip_address || '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>Firmware</td><td>{ap.firmware_version || '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>Serial Number</td><td>{ap.serial_number || '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>Uptime</td><td>{ap.uptime_formatted || '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>Reboots</td><td>{ap.reboot_count ?? '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>Bootstraps</td><td>{ap.bootstrap_count ?? '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>Auth Failures</td><td>{ap.auth_failures ?? '—'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)' }}>Last seen</td><td>{fmtTime(ap.last_seen_at)}</td></tr>
            <tr>
              <td style={{ color: 'var(--text-muted)' }}>Controller</td>
              <td>
                {ap.controller_name || '—'}
                {ap.controller_id != null && (
                  <button
                    className="sv-btn ghost sm"
                    style={{ marginLeft: 8 }}
                    onClick={() => onFilterController(ap.controller_id)}
                  >Filter by controller</button>
                )}
              </td>
            </tr>
          </tbody>
        </table>

        <h3 style={{ marginBottom: 6 }}>Current Stats</h3>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{ap.clients_total}</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Total Clients</div>
          </div>
          {perBandUnavailable(ap.vendor) ? (
            <div>
              <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--text-muted)' }}>—</div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Per-band breakdown not available</div>
            </div>
          ) : (
            <>
              <div>
                <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{ap.clients_2g}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>2.4GHz</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{ap.clients_5g}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>5GHz</div>
              </div>
              {ap.clients_6g > 0 && (
                <div>
                  <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{ap.clients_6g}</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>6GHz</div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 4 }}>
            2.4GHz {ap.radio_2g_channel != null ? `(Ch ${ap.radio_2g_channel}` : '(Ch —'}
            {ap.tx_power_2g != null ? `, ${ap.tx_power_2g} dBm)` : ')'}
          </div>
          <UtilBar pct={ap.radio_2g_util_pct || 0} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 4 }}>
            5GHz {ap.radio_5g_channel != null ? `(Ch ${ap.radio_5g_channel}` : '(Ch —'}
            {ap.tx_power_5g != null ? `, ${ap.tx_power_5g} dBm)` : ')'}
          </div>
          <UtilBar pct={ap.radio_5g_util_pct || 0} />
        </div>

        <h3 style={{ marginBottom: 6 }}>Radio Performance</h3>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
          <RadioBandStats
            band="2.4 GHz"
            noiseFloor={ap.noise_floor_2g}
            utilPct={ap.radio_2g_util_pct}
            retryRate={ap.retry_rate_2g}
            interference={ap.interference_pct_2g}
            rxErrors={ap.rx_errors_delta_2g}
            txErrors={ap.tx_errors_delta_2g}
          />
          <RadioBandStats
            band="5 GHz"
            noiseFloor={ap.noise_floor_5g}
            utilPct={ap.radio_5g_util_pct}
            retryRate={ap.retry_rate_5g}
            interference={ap.interference_pct_5g}
            rxErrors={ap.rx_errors_delta_5g}
            txErrors={ap.tx_errors_delta_5g}
          />
        </div>

        <h3 style={{ marginBottom: 6 }}>Throughput</h3>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800 }}>{fmtBps(ap.throughput_in_bps)}</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>In</div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800 }}>{fmtBps(ap.throughput_out_bps)}</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Out</div>
          </div>
        </div>

        <h3 style={{ marginBottom: 6 }}>Connected Clients ({apClients.length})</h3>
        {apClients.length ? (
          <div style={{ marginBottom: 12 }}>
            {apClients.slice(0, 10).map((c: WirelessClient) => (
              <div
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 0', borderBottom: '1px solid var(--border-light)', fontSize: 'var(--text-base)',
                }}
              >
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.mac_address || c.ip_address || '—'}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 90 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: signalColor(c.rssi_dbm), display: 'inline-block',
                  }} />
                  {c.rssi_dbm != null ? `${c.rssi_dbm} dBm` : '—'}
                </span>
                <span style={{ width: 80, color: 'var(--text-secondary)' }}>{fmtRate(c.tx_rate_mbps)}</span>
                <span style={{ color: 'var(--text-muted)' }}>{fmtRel(c.connected_since)}</span>
              </div>
            ))}
            {apClients.length > 10 && (
              <button
                type="button"
                className="sv-link-btn"
                onClick={() => onViewAllClients(ap.id)}
                style={{
                  marginTop: 8, background: 'none', border: 'none', padding: 0,
                  color: 'var(--primary)', fontSize: 'var(--text-base)', fontWeight: 600, cursor: 'pointer',
                }}
              >
                View all {apClients.length} clients →
              </button>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginBottom: 12 }}>
            No clients connected
          </div>
        )}

        {err && <ErrorBox message={err} />}
        {loading ? (
          <Loading />
        ) : (
          <>
            <h3 style={{ marginBottom: 6 }}>24h Client Count</h3>
            {perBandUnavailable(ap.vendor) && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 4 }}>
                Per-band (2.4/5GHz) breakdown not reported by this vendor — showing total only.
              </div>
            )}
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tickFormatter={fmtBucket} fontSize={11} />
                <YAxis fontSize={11} allowDecimals={false} />
                <Tooltip {...CHART_TOOLTIP} />
                <Legend />
                <Line type="monotone" dataKey="clients_total" name="Total" stroke={CHART_COLORS.total} dot={false} />
                {!perBandUnavailable(ap.vendor) && (
                  <>
                    <Line type="monotone" dataKey="clients_2g" name="2.4GHz" stroke={CHART_COLORS.g2} dot={false} />
                    <Line type="monotone" dataKey="clients_5g" name="5GHz" stroke={CHART_COLORS.g5} dot={false} />
                  </>
                )}
              </LineChart>
            </ResponsiveContainer>

            <h3 style={{ marginBottom: 6 }}>24h Channel Utilization</h3>
            {utilUnavailable(ap.vendor) ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 8 }}>
                Channel utilization not reported by this vendor.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="bucket" tickFormatter={fmtBucket} fontSize={11} />
                  <YAxis fontSize={11} domain={[0, 100]} />
                  <Tooltip {...CHART_TOOLTIP} />
                  <Legend />
                  <Line type="monotone" dataKey="radio_2g_util" name="2.4GHz %" stroke={CHART_COLORS.g2} dot={false} />
                  <Line type="monotone" dataKey="radio_5g_util" name="5GHz %" stroke={CHART_COLORS.g5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}

            <h3 style={{ marginBottom: 6 }}>24h Noise Floor (dBm)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={smoothedNoiseHistory}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tickFormatter={fmtBucket} fontSize={11} />
                {/* Noise floor dBm values normally cluster within a few dB — an
                    unpadded auto-domain ([dataMin, dataMax]) puts every point
                    right at the top/bottom edge, making a flat line look like
                    constant spikes. Pad 4dB above/below the actual range. */}
                <YAxis fontSize={11} domain={['dataMin - 4', 'dataMax + 4']} />
                <Tooltip {...CHART_TOOLTIP} />
                <Legend />
                <Line type="monotone" dataKey="noise_floor_2g" name="2.4GHz" stroke={CHART_COLORS.g2} dot={false} connectNulls />
                <Line type="monotone" dataKey="noise_floor_5g" name="5GHz" stroke={CHART_COLORS.g5} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>

            <h3 style={{ marginBottom: 6 }}>24h Retry Rate (%)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tickFormatter={fmtBucket} fontSize={11} />
                <YAxis fontSize={11} domain={[0, 100]} />
                <Tooltip {...CHART_TOOLTIP} />
                <Legend />
                <Line type="monotone" dataKey="retry_rate_2g" name="2.4GHz %" stroke={CHART_COLORS.g2} dot={false} connectNulls />
                <Line type="monotone" dataKey="retry_rate_5g" name="5GHz %" stroke={CHART_COLORS.g5} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>

            <h3 style={{ marginBottom: 6 }}>24h Interference (%)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tickFormatter={fmtBucket} fontSize={11} />
                <YAxis fontSize={11} domain={[0, 100]} />
                <Tooltip {...CHART_TOOLTIP} />
                <Legend />
                <Line type="monotone" dataKey="interference_pct_2g" name="2.4GHz %" stroke={CHART_COLORS.g2} dot={false} connectNulls />
                <Line type="monotone" dataKey="interference_pct_5g" name="5GHz %" stroke={CHART_COLORS.g5} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// Compact packet-count formatter (39104189 -> "39.1M") — error counts shown
// here are the per-poll delta (packets since the previous poll, computed by
// the collector from the raw cumulative SNMP counters), not a lifetime total,
// but a busy/erroring radio can still rack up a large count between polls, so
// a wall of unformatted digits still reads as meaningless without this.
function fmtPktCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1e3).toFixed(1)}K`;
  return `${(v / 1e6).toFixed(1)}M`;
}

// ── Radio band stats block (top-level component) ──────────────
function RadioBandStats({
  band, noiseFloor, utilPct, retryRate, interference, rxErrors, txErrors,
}: {
  band: string;
  noiseFloor: number | null;
  utilPct: number | null;
  retryRate: number | null;
  interference: number | null;
  rxErrors: number | null;
  txErrors: number | null;
}) {
  const nb = noiseBadge(noiseFloor);
  return (
    <div style={{
      flex: '1 1 200px', minWidth: 180,
      border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{band}</div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '3px 0', fontSize: 'var(--text-base)',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Noise Floor</span>
        <span>
          {noiseFloorValid(noiseFloor) ? `${noiseFloor} dBm ` : '— '}
          <span className="sv-badge" style={{ color: nb.color, borderColor: nb.color }}>
            {nb.label}
          </span>
        </span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '3px 0', fontSize: 'var(--text-base)',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Channel Utilization</span>
        <span>{utilPct != null ? `${utilPct}%` : '—'}</span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '3px 0', fontSize: 'var(--text-base)',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Retry Rate</span>
        <span>{retryRate != null ? `${retryRate}%` : '—'}</span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '3px 0', fontSize: 'var(--text-base)',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Interference</span>
        <span style={{ color: Number(interference) >= 25 ? 'var(--tint-danger-fg)' : undefined }}>
          {interference != null ? `${interference}%` : '—'}
        </span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '3px 0', fontSize: 'var(--text-base)',
      }}>
        <span
          style={{ color: 'var(--text-muted)', cursor: 'help' }}
          title="Error packets recorded since the previous poll of this radio — a current/instantaneous count, not the lifetime total since the radio's last reboot."
        >Errors (since last poll)</span>
        <span title={rxErrors != null || txErrors != null ? `${rxErrors ?? 0} RX / ${txErrors ?? 0} TX packets since last poll` : 'No reading yet (first poll after this AP was added, or the collector recently restarted)'}>
          {fmtPktCount(rxErrors)} RX / {fmtPktCount(txErrors)} TX
        </span>
      </div>
    </div>
  );
}

function fmtBucket(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Trailing moving average over the given numeric keys, computed independently
// per key (each ignores the OTHER key's nulls, so one radio missing data
// doesn't widen or shift the other's window). Used to smooth naturally-jittery
// per-poll telemetry (see the Noise Floor chart) without changing the
// underlying bucket size the history endpoint returns.
function movingAverage<T extends Record<string, any>>(
  rows: T[], keys: string[], window: number
): T[] {
  return rows.map((row, i) => {
    const slice = rows.slice(Math.max(0, i - window + 1), i + 1);
    const out: Record<string, any> = { ...row };
    for (const k of keys) {
      // The history endpoint's noise_floor_2g/5g columns are Postgres NUMERIC
      // (ROUND(AVG(...)::numeric, 0) in api/server.js), which the pg driver
      // returns as JS strings, not numbers — the same pitfall documented for
      // BIGINT columns elsewhere in this file. Without Number(...) here,
      // `+` on two such values does string concatenation ("−96" + "−97" ->
      // "−96−97"), producing NaN once divided — Recharts then silently drops
      // every point, rendering an empty chart with no error.
      const vals = slice
        .map((r) => r[k])
        .filter((v) => v != null)
        .map((v) => Number(v))
        .filter((v) => !Number.isNaN(v));
      out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return out as T;
  });
}

// ════════════════════════════════════════════════════════════
// TAB 3 — SSIDs
// ════════════════════════════════════════════════════════════

// Pick a tint-token pair for an SSID's encryption_type label. WEP and Open
// (no encryption at all) are flagged amber as weak security; everything else
// recognised (WPA/WPA2/WPA3/xSec/bSec/MPSK) reads as reasonably strong and is
// green. A comma-joined mixed-mode label (e.g. "Open, WPA2-PSK (AES)") is
// still flagged amber if any weak method appears — the badge should never
// hide that a weaker option is still being offered alongside a stronger one.
function encryptionBadgeColor(type: string | null): { bg: string; fg: string } | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes('open') || t.includes('wep')) {
    return { bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' };
  }
  return { bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' };
}

function EncryptionBadge({ type }: { type: string | null }) {
  if (!type) {
    return <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>—</span>;
  }
  const colors = encryptionBadgeColor(type);
  return (
    <span
      className="sv-badge"
      style={{ color: colors?.fg, background: colors?.bg, borderColor: colors?.bg }}
      title={type}
    >
      {type}
    </span>
  );
}

// ── One controller's collapsible SSID group (own search + collapse state) ─────
function SsidControllerGroup({
  controller, ssids,
}: {
  controller: Controller;
  ssids: Ssid[];
}) {
  const online = controllerOnline(controller);
  const [collapsed, setCollapsed] = useState<boolean>(!online);
  const [search, setSearch] = useState('');

  useEffect(() => { setCollapsed(readCollapsed(controller.id, !online)); }, [controller.id, online]);

  function toggle() {
    setCollapsed((c) => { const n = !c; writeCollapsed(controller.id, n); return n; });
  }

  const clients = ssids.reduce((s, r) => s + (r.clients_total || 0), 0);
  const summary = `${ssids.length} SSID${ssids.length === 1 ? '' : 's'} · ${clients} client${clients === 1 ? '' : 's'}`;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? ssids.filter((r) => r.ssid_name.toLowerCase().includes(q)) : ssids;
    // Sort by client count DESC (busiest SSIDs first).
    return [...list].sort((a, b) => (b.clients_total || 0) - (a.clients_total || 0));
  }, [ssids, search]);

  return (
    <div style={{ marginBottom: 12 }}>
      <ControllerGroupHeader
        controller={controller} online={online} summary={summary}
        collapsed={collapsed} onToggle={toggle}
      />
      {!collapsed && (
        <div className="sv-panel" style={{ padding: 0, marginTop: 8 }}>
          <div style={{ padding: '10px 12px' }}>
            <input
              className="sv-input"
              style={{ maxWidth: 240 }}
              placeholder="Search SSID name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {shown.length ? (
            <table className="sv-table">
              <thead>
                <tr>
                  <th>SSID Name</th><th>Site</th><th>Status</th><th>Security</th><th>Clients</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r: Ssid) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.ssid_name}</td>
                    <td>{r.site_name || '—'}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <StatusDot status={r.status === 'up' ? 'up' : 'down'} />
                        {r.status}
                      </span>
                    </td>
                    <td><EncryptionBadge type={r.encryption_type} /></td>
                    <td>{r.clients_total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty message="No SSIDs match this search." />
          )}
        </div>
      )}
    </div>
  );
}

function SsidsTab({ controllerFilter, setControllerFilter }: {
  controllerFilter: number | null;
  setControllerFilter: (v: number | null) => void;
}) {
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 30000);
  const [siteFilter, setSiteFilter] = useState<number | null>(null);

  const qs = useMemo(() => {
    const params: string[] = [];
    if (controllerFilter != null) params.push(`controller_id=${controllerFilter}`);
    if (siteFilter != null) params.push(`site_id=${siteFilter}`);
    return params.length ? `?${params.join('&')}` : '';
  }, [controllerFilter, siteFilter]);

  const ssids = useApi<Ssid[]>(`/api/wireless/ssids${qs}`, 30000);
  const allRows = ssids.data || [];

  const siteOptions = useMemo(() => {
    const map = new Map<number, string>();
    allRows.forEach((r: Ssid) => {
      if (r.site_id != null) map.set(r.site_id, r.site_name || `Site ${r.site_id}`);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [allRows]);

  const groups = useMemo(
    () => groupByController(allRows, controllers.data || []),
    [allRows, controllers.data],
  );

  return (
    <div>
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14,
      }}>
        <select
          className="sv-select"
          style={{ maxWidth: 220 }}
          value={controllerFilter ?? ''}
          onChange={(e) => setControllerFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All controllers</option>
          {controllers.data?.map((c: Controller) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select
          className="sv-select"
          style={{ maxWidth: 200 }}
          value={siteFilter ?? ''}
          onChange={(e) => setSiteFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All sites</option>
          {siteOptions.map((s: { id: number; name: string }) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {ssids.error && <ErrorBox message={ssids.error} />}

      {ssids.loading && !ssids.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : groups.length ? (
        groups.map(({ controller, rows }) => (
          <SsidControllerGroup key={controller.id} controller={controller} ssids={rows} />
        ))
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No SSID data yet — run wireless polling first" />
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB 4 — Wireless Intelligence
// ════════════════════════════════════════════════════════════

// ── Intelligence helpers (top-level) ──────────────────────────
function scoreColor(s: number): string {
  if (s >= 80) return 'var(--green)';
  if (s >= 60) return 'var(--yellow)';
  return 'var(--red)';
}

function gradeColor(g: string): string {
  const c = (g || '').trim().toUpperCase().charAt(0);
  if (c === 'A' || c === 'B') return 'var(--green)';
  if (c === 'C' || c === 'D') return 'var(--yellow)';
  return 'var(--red)';
}

function prioMeta(p: string): { color: string; status: 'down' | 'warning' | 'up' | 'unknown'; label: string } {
  switch (p) {
    case 'critical': return { color: 'var(--red)', status: 'down', label: 'Critical' };
    case 'high': return { color: 'var(--yellow)', status: 'warning', label: 'High' };
    case 'medium': return { color: 'var(--yellow)', status: 'warning', label: 'Medium' };
    case 'low': return { color: 'var(--green)', status: 'up', label: 'Low' };
    default: return { color: 'var(--text-muted)', status: 'unknown', label: p || '—' };
  }
}

const PRIO_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function recKey(rec: Recommendation): string {
  return `${rec.controller_id ?? 0}:${rec.category}:${rec.issue}`;
}

const DISMISS_LS_KEY = 'sv-wifi-rec-dismissed';

function readDismissed(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DISMISS_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function dismissRec(rec: Recommendation): void {
  if (typeof window === 'undefined') return;
  try {
    const map = readDismissed();
    map[recKey(rec)] = Date.now() + 24 * 60 * 60 * 1000;
    window.localStorage.setItem(DISMISS_LS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function isDismissed(rec: Recommendation, dismissed: Record<string, number>): boolean {
  const exp = dismissed[recKey(rec)];
  return exp != null && Date.now() < exp;
}

// ── Score bar (top-level component) ───────────────────────────
function ScoreBar({ label, value }: { label: string; value: number | null }) {
  if (value == null) {
    // e.g. Capacity for a controller whose vendor reports no util at all
    // (aruba_central) — an empty/zero bar here would read as "0% capacity
    // score", the opposite of the truth ("we don't know").
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)', marginBottom: 3,
        }}>
          <span>{label}</span>
          <span style={{ fontWeight: 600 }}>N/A</span>
        </div>
        <div style={{
          height: 8, borderRadius: 4, background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
        }} title="Not available for this vendor" />
      </div>
    );
  }
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)',
        color: 'var(--text-muted)', marginBottom: 3,
      }}>
        <span>{label}</span>
        <span style={{ color: scoreColor(v), fontWeight: 600 }}>{v}/100</span>
      </div>
      <div style={{
        height: 8, borderRadius: 4, background: 'var(--bg-primary)',
        border: '1px solid var(--border)', overflow: 'hidden',
      }}>
        <div style={{ width: `${v}%`, height: '100%', background: scoreColor(v) }} />
      </div>
    </div>
  );
}

// ── Worst-AP drawer loader (top-level component) ──────────────
function IntelApDrawer({ apId, onClose, onViewAllClients }: { apId: number; onClose: () => void; onViewAllClients: (apId: number) => void }) {
  const mounted = useMountedPortal();
  const [ap, setAp] = useState<AccessPoint | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAp(null);
    setErr(null);
    apiGet<AccessPoint>(`/api/wireless/aps/${apId}`)
      .then((a) => { if (!cancelled) setAp(a); })
      .catch((e: any) => { if (!cancelled) setErr(e?.message || 'Failed to load AP'); })
      .finally(() => { /* noop */ });
    return () => { cancelled = true; };
  }, [apId]);

  if (err) {
    if (!mounted) return null;
    return createPortal(
      <div className="sv-modal-backdrop" onMouseDown={onClose}>
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 96vw)',
            background: 'var(--bg-card)', borderLeft: '1px solid var(--border)',
            padding: '20px 22px', zIndex: 60, overflowY: 'auto',
          }}
        >
          <button className="sv-btn ghost sm" onClick={onClose}>Close</button>
          <ErrorBox message={err} />
        </div>
      </div>,
      document.body
    );
  }
  if (!ap) return null;
  return (
    <ApDetailDrawer ap={ap} onClose={onClose} onFilterController={() => {}} onViewAllClients={onViewAllClients} />
  );
}

// ── Compact recommendations table (collapsible) (top-level) ───
function RecommendationsTable({
  recs, criticalCount, highCount, onDismiss,
}: {
  recs: Recommendation[];
  criticalCount: number;
  highCount: number;
  onDismiss: (rec: Recommendation) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  if (!recs.length) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--green)', fontWeight: 600, fontSize: 'var(--text-base)' }}>
        <IconCheck width={14} height={14} /> No issues detected — wireless looks healthy.
      </div>
    );
  }

  if (!open) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-base)' }}>
        <span>{recs.length} recommendation{recs.length === 1 ? '' : 's'}</span>
        {(criticalCount > 0 || highCount > 0) && (
          <span style={{ color: 'var(--text-muted)' }}>
            — {criticalCount} critical, {highCount} high
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="sv-btn ghost sm" onClick={() => setOpen(true)}>Show →</button>
      </div>
    );
  }

  const shown = showAll ? recs : recs.slice(0, 5);
  return (
    <div>
      <table className="sv-table">
        <thead><tr>
          <th style={STICKY_TH}>Priority</th><th style={STICKY_TH}>Category</th>
          <th style={STICKY_TH}>Issue</th><th style={STICKY_TH}>Action</th>
          <th style={STICKY_TH}>Affected</th><th style={{ ...STICKY_TH, textAlign: 'right' }}></th>
        </tr></thead>
        <tbody>
          {shown.map((rec, i) => {
            const meta = prioMeta(rec.priority);
            const aps = rec.affected_aps || [];
            const affected = rec.affected_count ?? aps.length;
            return (
              <tr key={`${recKey(rec)}-${i}`}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: meta.color, fontWeight: 700 }}>
                    <StatusDot status={meta.status} size={9} />{meta.label}
                  </span>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{rec.category}</td>
                <td style={{ fontWeight: 600 }}>
                  {rec.issue}
                  {rec.controller_name && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {rec.controller_name}</span>
                  )}
                </td>
                <td style={{ color: 'var(--text-secondary)' }}>{rec.action}</td>
                <td>{affected > 0 ? affected : '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="sv-btn ghost sm" onClick={() => onDismiss(rec)}>Dismiss</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        {recs.length > 5 && (
          <button className="sv-btn ghost sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show less' : `Show all ${recs.length}`}
          </button>
        )}
        <button className="sv-btn ghost sm" onClick={() => setOpen(false)}>Collapse</button>
      </div>
    </div>
  );
}

// ── Controller detail mini score card (top-level) ─────────────
function ControllerMiniScoreCard({ row }: { row: IntelRow }) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
      padding: '10px 12px', marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 'var(--text-base)', flex: 1 }}>{row.controller_name}</span>
        <span style={{ color: scoreColor(Number(row.overall_score)), fontWeight: 700, fontSize: 'var(--text-base)' }}>
          {Math.round(Number(row.overall_score))}
        </span>
        <GradeBadge grade={row.overall_grade} />
      </div>
      <ScoreBar label="Load Balance" value={Number(row.load_balance_score)} />
      <ScoreBar label="Capacity" value={row.capacity_score == null ? null : Number(row.capacity_score)} />
      <ScoreBar label="Band Steering" value={Number(row.band_steering_score)} />
    </div>
  );
}

function IntelligenceTab({ onViewApClients }: { onViewApClients?: (apId: number) => void }) {
  const summaryApi = useApi<IntelSummary>('/api/wireless/intelligence/summary', 30000);
  const rowsApi = useApi<IntelRow[]>('/api/wireless/intelligence', 30000);
  const apsApi = useApi<AccessPoint[]>('/api/wireless/aps', 30000);
  const [dismissTick, setDismissTick] = useState(0);
  const [drawerApId, setDrawerApId] = useState<number | null>(null);

  const summary = summaryApi.data;
  const rows = useMemo(() => rowsApi.data || [], [rowsApi.data]);
  const aps = useMemo(() => apsApi.data || [], [apsApi.data]);

  function handleDismiss(rec: Recommendation) {
    dismissRec(rec);
    setDismissTick((t) => t + 1);
  }

  // Flattened, sorted, undismissed recommendations.
  const recommendations = useMemo(() => {
    const dismissed = readDismissed();
    const all: Recommendation[] = [];
    rows.forEach((r) => {
      (r.recommendations || []).forEach((rec) => {
        all.push({
          ...rec,
          controller_id: rec.controller_id ?? r.controller_id,
          controller_name: rec.controller_name ?? r.controller_name,
        });
      });
    });
    return all
      .filter((rec) => !isDismissed(rec, dismissed))
      .sort((a, b) => (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dismissTick]);

  // Section 6 — channel maps from the AP list.
  const channelMaps = useMemo(() => {
    const c2 = new Map<number, number>();
    const c5 = new Map<number, number>();
    aps.forEach((ap) => {
      if (ap.radio_2g_channel != null) c2.set(ap.radio_2g_channel, (c2.get(ap.radio_2g_channel) || 0) + 1);
      if (ap.radio_5g_channel != null) c5.set(ap.radio_5g_channel, (c5.get(ap.radio_5g_channel) || 0) + 1);
    });
    const toSorted = (m: Map<number, number>) =>
      Array.from(m.entries())
        .map(([ch, count]) => ({ ch, count }))
        .sort((a, b) => a.ch - b.ch);
    return { g2: toSorted(c2), g5: toSorted(c5) };
  }, [aps]);

  // Combined channel histogram for the vertical bar chart. 2.4GHz channels
  // (ch ≤ 14) outside the standard {1,6,11} are flagged non-standard so they
  // render in orange; everything else (incl. all 5GHz channels) is "standard".
  const channelChartData = useMemo(() => {
    return [...channelMaps.g2, ...channelMaps.g5]
      .sort((a, b) => a.ch - b.ch)
      .map((c) => {
        const is24 = c.ch <= 14;
        const standard = !is24 || c.ch === 1 || c.ch === 6 || c.ch === 11;
        return { ...c, name: `Ch ${c.ch}`, standard };
      });
  }, [channelMaps]);

  const bandChartData = useMemo(() => rows.map((r) => ({
    name: r.controller_name,
    g2: Number(r.band_2g_pct),
    g5: Number(r.band_5g_pct),
  })), [rows]);

  if (summaryApi.loading && !summary) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (summaryApi.error) return <ErrorBox message={summaryApi.error} />;
  if (!summary || !summary.controllers || summary.controllers.length === 0) {
    return <Empty message="No intelligence yet — run a wireless poll cycle first." />;
  }

  const overall = Number(summary.overall_score);
  const bandSteer = Number(summary.band_steering_avg);
  const loadAvg = rows.length
    ? rows.reduce((s, r) => s + Number(r.load_balance_score), 0) / rows.length
    : 0;
  // Exclude controllers with no capacity data (capacity_score null — a vendor
  // with no util_pct at all) instead of letting them count as a fake 0 and
  // drag the fleet-wide average down.
  const capacityRows = rows.filter((r) => r.capacity_score != null);
  const capacityAvg = capacityRows.length
    ? capacityRows.reduce((s, r) => s + Number(r.capacity_score), 0) / capacityRows.length
    : 0;
  const criticalCount = recommendations.filter((r) => r.priority === 'critical').length;
  const highCount = recommendations.filter((r) => r.priority === 'high').length;

  return (
    <div>
      {/* Row 1 — 4 compact score cards */}
      <StatRow>
        <ScoreCard label="Overall Health" score={overall} grade={summary.overall_grade} />
        <ScoreCard label="Load Balance" score={loadAvg} />
        <ScoreCard label="Band Steering" score={bandSteer} />
        <ScoreCard label="Capacity" score={capacityAvg} />
      </StatRow>

      {/* Row 2 — Recommendations (single card, compact table) */}
      <SectionCard title="Recommendations">
        <RecommendationsTable
          recs={recommendations}
          criticalCount={criticalCount}
          highCount={highCount}
          onDismiss={handleDismiss}
        />
      </SectionCard>

      {/* Row 3 — Score bars | Band distribution | Channel map */}
      <EqualRow>
        <SectionCard title="Per-Controller Scores" minWidth={260}>
          {rows.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>Controller</th><th style={STICKY_TH}>Score</th>
                <th style={STICKY_TH}>Bar</th><th style={STICKY_TH}>Grade</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const sc = Math.round(Number(r.overall_score));
                  return (
                    <tr key={r.controller_id}>
                      <td style={{ fontWeight: 600 }}>{r.controller_name}</td>
                      <td style={{ color: scoreColor(sc), fontWeight: 700 }}>{sc}</td>
                      <td><ProgressBar pct={sc} width={70} /></td>
                      <td><GradeBadge grade={r.overall_grade} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <Empty message="No controller data." />}
        </SectionCard>

        <SectionCard title="Band Distribution (2.4 vs 5GHz)" minWidth={260}>
          {bandChartData.length ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={bandChartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis domain={[0, 100]} fontSize={11} />
                <Tooltip {...CHART_TOOLTIP} />
                <ReferenceLine y={60} stroke="var(--red)" strokeDasharray="4 4" />
                <Bar dataKey="g2" name="2.4GHz %" fill="#94a3b8" />
                <Bar dataKey="g5" name="5GHz %" fill="#0ea5e9" />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty message="No band distribution data." />}
        </SectionCard>

        <SectionCard title="Channel Map" minWidth={260}>
          {channelChartData.length ? (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={channelChartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip {...CHART_TOOLTIP} />
                  <Bar dataKey="count" name="APs">
                    {channelChartData.map((c) => (
                      <Cell key={c.ch} fill={c.standard ? 'var(--green)' : '#f97316'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                <span style={{ color: 'var(--green)' }}>■</span> Standard ·{' '}
                <span style={{ color: '#f97316' }}>■</span> Non-standard
              </div>
            </>
          ) : <Empty message="No channel data." />}
        </SectionCard>
      </EqualRow>

      {/* Row 4 — AP Health Leaderboard | Controller detail */}
      <EqualRow>
        <SectionCard title="AP Health Leaderboard (Worst 8)" flex="1 1 55%" minWidth={320}>
          {summary.worst_aps && summary.worst_aps.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>AP</th><th style={STICKY_TH}>Score</th>
                <th style={STICKY_TH}>Grade</th><th style={STICKY_TH}>Load</th><th style={STICKY_TH}>Issues</th>
              </tr></thead>
              <tbody>
                {summary.worst_aps.slice(0, 8).map((ap: WorstAp) => {
                  const sc = Number(ap.health_score);
                  const issues = ap.issues || [];
                  return (
                    <tr key={ap.ap_id} style={{ cursor: 'pointer' }} onClick={() => setDrawerApId(ap.ap_id)}>
                      <td style={{ fontWeight: 600 }}>{ap.ap_name}</td>
                      <td style={{ color: scoreColor(sc), fontWeight: 700 }}>{Math.round(sc)}</td>
                      <td><GradeBadge grade={ap.health_grade} /></td>
                      <td>{ap.load_status}</td>
                      <td style={{ color: 'var(--text-muted)' }}>
                        {issues.slice(0, 2).join(', ')}{issues.length > 2 ? ` +${issues.length - 2}` : ''}
                        {onViewApClients && (
                          <button
                            className="sv-btn ghost sm"
                            style={{ marginLeft: 8 }}
                            onClick={(e) => { e.stopPropagation(); onViewApClients(ap.ap_id); }}
                          >Clients</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <Empty message="No AP health data yet." />}
        </SectionCard>

        <SectionCard title="Controller Detail" flex="1 1 40%" minWidth={280} maxHeight={360}>
          {rows.length ? (
            rows.map((r) => <ControllerMiniScoreCard key={r.controller_id} row={r} />)
          ) : <Empty message="No controller data." />}
        </SectionCard>
      </EqualRow>

      {drawerApId != null && (
        <IntelApDrawer
          apId={drawerApId}
          onClose={() => setDrawerApId(null)}
          onViewAllClients={(id) => { setDrawerApId(null); if (onViewApClients) onViewApClients(id); }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB — Clients (wireless client troubleshooting)
// ════════════════════════════════════════════════════════════

// ── Client status badge (top-level component) ─────────────────
function ClientStatusBadge({ client }: { client: WirelessClient }) {
  const rssi = client.rssi_dbm;
  if (client.is_sticky) {
    return (
      <span className="sv-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--red)', borderColor: 'var(--red)' }}
        title="Poor signal but not roaming — clinging to a distant AP">
        <IconPin width={12} height={12} /> Sticky
      </span>
    );
  }
  if (rssi != null && rssi < -75) {
    return (
      <span className="sv-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--red)', borderColor: 'var(--red)' }}>
        <StatusDot status="down" size={8} /> Low Signal
      </span>
    );
  }
  if (Number(client.roaming_count) > 5) {
    return (
      <span className="sv-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--yellow)', borderColor: 'var(--yellow)' }}>
        <IconRepeat width={12} height={12} /> Frequent Roamer
      </span>
    );
  }
  return (
    <span className="sv-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--green)', borderColor: 'var(--green)' }}>
      <IconCheck width={12} height={12} /> Normal
    </span>
  );
}

// ── Signal cell (dot + dBm + label) (top-level component) ─────
function SignalCell({ rssi }: { rssi: number | null }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 9, height: 9, borderRadius: '50%',
        background: signalColor(rssi), display: 'inline-block',
      }} />
      <span>{rssi != null ? `${rssi} dBm` : '—'}</span>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{signalLabel(rssi)}</span>
    </span>
  );
}

// ── One controller's collapsible client group (collapse state shared with ──────
// the APs/SSIDs tabs via the sv-wireless-ctrl-{id}-collapsed localStorage key) ─
const CLIENTS_PER_PAGE = 50;
function ClientControllerGroup({
  controller, clients, totalClients, problemClients, onSelectMac,
  sortKey, sortDir, onSort,
}: {
  controller: Controller;
  clients: WirelessClient[];
  totalClients: number | null;
  problemClients: number | null;
  onSelectMac: (mac: string) => void;
  sortKey: ClientSortKey | null;
  sortDir: 'asc' | 'desc';
  onSort: (key: ClientSortKey) => void;
}) {
  const online = controllerOnline(controller);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  // resetKey: jump back to page 1 when the sort changes, so a user parked on
  // a deep page can't land on an out-of-range/empty page after re-sorting.
  const pg = useClientPagination(clients, CLIENTS_PER_PAGE, `${sortKey}:${sortDir}`);

  useEffect(() => { setCollapsed(readCollapsed(controller.id, false)); }, [controller.id]);

  function toggle() {
    setCollapsed((c) => { const n = !c; writeCollapsed(controller.id, n); return n; });
  }

  // Prefer the authoritative wireless_clients count from the summary (grouped by
  // controller_id) so the header matches the Total Clients card; fall back to the
  // shown rows (which may be capped/filtered) only when the summary count is absent.
  const total = totalClients != null ? totalClients : clients.length;
  const problems = problemClients != null
    ? problemClients
    : clients.reduce((s, c) => s + (c.is_problem ? 1 : 0), 0);
  const summary = `${total} client${total === 1 ? '' : 's'}`
    + (problems > 0 ? ` · ${problems} problem${problems === 1 ? '' : 's'}` : '');

  return (
    <div style={{ marginBottom: 12 }}>
      <ControllerGroupHeader
        controller={controller} online={online} summary={summary}
        collapsed={collapsed} onToggle={toggle}
      />
      {!collapsed && (
        <div className="sv-panel" style={{ padding: 0, marginTop: 8 }}>
          <table className="sv-table">
            <thead>
              <tr>
                <th onClick={() => onSort('mac_address')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  MAC{sortKey === 'mac_address' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('ip_address')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  IP{sortKey === 'ip_address' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('ap_name')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  AP{sortKey === 'ap_name' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('ssid_name')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  SSID{sortKey === 'ssid_name' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('band')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  Band{sortKey === 'band' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('vlan_id')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  VLAN{sortKey === 'vlan_id' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('rssi_dbm')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  Signal{sortKey === 'rssi_dbm' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('tx_rate_mbps')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  Rate{sortKey === 'tx_rate_mbps' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('bandwidth')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  Bandwidth{sortKey === 'bandwidth' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('connected_since')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  Connected{sortKey === 'connected_since' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th onClick={() => onSort('status')} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">
                  Status{sortKey === 'status' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              </tr>
            </thead>
            <tbody>
              {pg.pageRows.map((c: WirelessClient) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onSelectMac(c.mac_address)}>
                  <td style={{ fontWeight: 600 }}>{c.mac_address}</td>
                  <td>{c.ip_address || '—'}</td>
                  <td>{c.ap_name || '—'}</td>
                  <td>{c.ssid_name || '—'}</td>
                  <td>
                    {c.band || '—'}
                    {c.phy_mode ? <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}> · {c.phy_mode}</span> : null}
                  </td>
                  <td>{c.vlan_id ?? '—'}</td>
                  <td><SignalCell rssi={c.rssi_dbm} /></td>
                  <td title={c.rx_rate_mbps != null ? `↓ ${fmtRate(c.rx_rate_mbps)}` : undefined}>
                    {fmtRate(c.tx_rate_mbps)}
                  </td>
                  <td title={(c.rx_bps != null || c.tx_bps != null) ? `↓ ${fmtBps(c.rx_bps)} · ↑ ${fmtBps(c.tx_bps)}` : undefined}>
                    {fmtBps(bwTotal(c))}
                  </td>
                  <td>{fmtRel(c.connected_since)}</td>
                  <td><ClientStatusBadge client={c} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '0 12px 12px' }}>
            <Pager
              page={pg.page}
              pageCount={pg.pageCount}
              start={pg.start}
              perPage={CLIENTS_PER_PAGE}
              total={pg.total}
              onPrev={pg.prev}
              onNext={pg.next}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ClientsTab({
  apFilter, setApFilter, problemOnly, setProblemOnly,
}: {
  apFilter: number | null;
  setApFilter: (v: number | null) => void;
  problemOnly: boolean;
  setProblemOnly: (v: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  // Debounced copy of `search` — only this feeds the fetch querystring, so the
  // Clients table doesn't refetch on every keystroke (the input stays controlled
  // on `search` for responsiveness). Mirrors the GlobalSearch debounce pattern.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [controllerFilter, setControllerFilter] = useState('');
  const [ssidFilter, setSsidFilter] = useState('');
  const [bandFilter, setBandFilter] = useState('');
  const [stickyOnly, setStickyOnly] = useState(false);
  const [selectedMac, setSelectedMac] = useState<string | null>(null);
  // null = no explicit sort — preserves the API's default problem-first /
  // weakest-signal ordering exactly as before, until a user clicks a header.
  const [sortKey, setSortKey] = useState<ClientSortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleSort(key: ClientSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const summary = useApi<ClientSummary>('/api/wireless/clients/summary', 30000);
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 30000);
  const apsApi = useApi<AccessPoint[]>('/api/wireless/aps', 30000);

  const qs = useMemo(() => {
    const params: string[] = [];
    if (debouncedSearch.trim()) params.push(`search=${encodeURIComponent(debouncedSearch.trim())}`);
    if (apFilter != null) params.push(`ap_id=${apFilter}`);
    if (problemOnly) params.push('problem=true');
    if (stickyOnly) params.push('sticky=true');
    // Fetch up to the server cap (500) so we don't silently drop clients below
    // the allowance; per-controller tables paginate client-side. Beyond the
    // cap, the summary total + note steer users to search/filters.
    params.push('limit=500');
    return `?${params.join('&')}`;
  }, [debouncedSearch, apFilter, problemOnly, stickyOnly]);

  const clientsApi = useApi<WirelessClient[]>(`/api/wireless/clients${qs}`, 30000);
  const allClients = useMemo(() => clientsApi.data || [], [clientsApi.data]);

  const ssidOptions = useMemo(() => {
    const set = new Set<string>();
    allClients.forEach((c) => { if (c.ssid_name) set.add(c.ssid_name); });
    return Array.from(set).sort();
  }, [allClients]);

  const controllerOptions = useMemo(() => {
    const set = new Set<string>();
    (controllers.data || []).forEach((c) => set.add(c.name));
    allClients.forEach((c) => { if (c.controller_name) set.add(c.controller_name); });
    return Array.from(set).sort();
  }, [controllers.data, allClients]);

  // Built from the independently-fetched full AP list (not allClients) so the
  // full set of APs stays selectable even after apFilter narrows allClients
  // down to a single AP's clients. Disambiguate same-named APs across
  // controllers by appending the controller name.
  const apOptions = useMemo(() => {
    const aps = apsApi.data || [];
    const scoped = controllerFilter ? aps.filter((a) => a.controller_name === controllerFilter) : aps;
    const nameCounts = new Map<string, number>();
    scoped.forEach((a) => nameCounts.set(a.name, (nameCounts.get(a.name) || 0) + 1));
    return scoped
      .map((a) => ({
        id: a.id,
        label: (nameCounts.get(a.name) || 0) > 1 && a.controller_name
          ? `${a.name} (${a.controller_name})`
          : a.name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [apsApi.data, controllerFilter]);

  const shown = useMemo(() => {
    return allClients.filter((c) => {
      if (controllerFilter && c.controller_name !== controllerFilter) return false;
      if (ssidFilter && c.ssid_name !== ssidFilter) return false;
      if (bandFilter && c.band !== bandFilter) return false;
      return true;
    });
  }, [allClients, controllerFilter, ssidFilter, bandFilter]);

  // Apply the (optional) column sort before grouping. When no column has
  // been clicked (sortKey === null), this is a no-op that preserves the
  // API's default problem-first / weakest-signal ordering exactly as before.
  const sorted = useMemo(() => {
    if (!sortKey) return shown;
    const dir = sortDir === 'asc' ? 1 : -1;
    const copy = [...shown];
    copy.sort((a, b) => {
      const av = clientSortValue(a, sortKey);
      const bv = clientSortValue(b, sortKey);
      const aNull = av == null;
      const bNull = bv == null;
      // Nulls always sort last, regardless of sort direction — only the
      // ordering among non-null values flips with `dir`.
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return copy;
  }, [shown, sortKey, sortDir]);

  // Group the (sorted, filtered) clients into collapsible per-controller
  // sections, preserving the row order established above within each group.
  const clientGroups = useMemo(
    () => groupByController(sorted, controllers.data || []),
    [sorted, controllers.data],
  );

  // Authoritative per-controller client/problem counts from wireless_clients
  // (summary.by_controller, keyed by controller_id) — used for the accordion
  // headers so they stay consistent with the Total Clients card.
  const ctrlCounts = useMemo(() => {
    const m = new Map<number, { client_count: number; problem_count: number }>();
    (summary.data?.by_controller || []).forEach((c) =>
      m.set(c.controller_id, { client_count: c.client_count, problem_count: c.problem_count }));
    return m;
  }, [summary.data]);

  // When ANY filter narrows the shown rows (server-side search/ap/problem/sticky
  // OR client-side controller/ssid/band), the unfiltered summary counts no longer
  // match the table — so we fall back to counting the filtered rows per group
  // (pass null → ClientControllerGroup counts its own rows). With no filter active
  // we keep the authoritative summary counts (they match the Total Clients card).
  const filterActive = !!(
    debouncedSearch.trim() || controllerFilter || ssidFilter || bandFilter
    || apFilter != null || problemOnly || stickyOnly
  );

  return (
    <div>
      <input
        className="sv-input"
        style={{ width: '100%', marginBottom: 16 }}
        placeholder="Search by MAC address or IP… e.g. 00:11:22:33:44:55 or 192.168.1.50"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="sv-cards">
        <div className="sv-card">
          <div className="num">{summary.data ? Number(summary.data.total_clients) : '—'}</div>
          <div className="label">Total Clients</div>
        </div>
        <div className="sv-card" style={{ borderLeftColor: 'var(--red)' }}>
          <div className="num" style={{ color: 'var(--red)' }}>
            {summary.data ? Number(summary.data.problem_clients) : '—'}
          </div>
          <div className="label">Problem Clients</div>
        </div>
        <div className="sv-card" style={{ borderLeftColor: 'var(--yellow)' }}>
          <div className="num" style={{ color: 'var(--yellow)' }}>
            {summary.data ? Number(summary.data.low_signal_clients) : '—'}
          </div>
          <div className="label">Low Signal</div>
        </div>
        <div className="sv-card">
          <div className="num">{summary.data ? Number(summary.data.frequent_roamers) : '—'}</div>
          <div className="label">Frequent Roamers</div>
        </div>
        <div
          className="sv-card"
          style={{ borderLeftColor: 'var(--red)', cursor: 'pointer' }}
          onClick={() => setStickyOnly(true)}
          title="Poor signal but not roaming — clinging to a distant AP"
        >
          <div className="num" style={{ color: 'var(--red)' }}>
            {summary.data ? Number(summary.data.sticky_clients) : '—'}
          </div>
          <div className="label">Sticky Clients</div>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '14px 0',
      }}>
        <select
          className="sv-select"
          style={{ maxWidth: 200 }}
          value={controllerFilter}
          onChange={(e) => setControllerFilter(e.target.value)}
        >
          <option value="">All controllers</option>
          {controllerOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          className="sv-select"
          style={{ maxWidth: 200 }}
          value={ssidFilter}
          onChange={(e) => setSsidFilter(e.target.value)}
        >
          <option value="">All SSIDs</option>
          {ssidOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          className="sv-select"
          style={{ maxWidth: 200 }}
          value={apFilter != null ? String(apFilter) : ''}
          onChange={(e) => setApFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All APs</option>
          {apOptions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <select
          className="sv-select"
          style={{ maxWidth: 140 }}
          value={bandFilter}
          onChange={(e) => setBandFilter(e.target.value)}
        >
          <option value="">All bands</option>
          <option value="2.4GHz">2.4GHz</option>
          <option value="5GHz">5GHz</option>
          <option value="6GHz">6GHz</option>
        </select>
        <button
          className="sv-btn ghost sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...(problemOnly ? { color: 'var(--red)', borderColor: 'var(--red)' } : {}) }}
          onClick={() => setProblemOnly(!problemOnly)}
        ><IconWarning width={12} height={12} /> Problem clients only</button>
        <button
          className="sv-btn ghost sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...(stickyOnly ? { color: 'var(--red)', borderColor: 'var(--red)' } : {}) }}
          onClick={() => setStickyOnly(!stickyOnly)}
        ><IconPin width={12} height={12} /> Sticky only</button>
      </div>

      {clientsApi.error && <ErrorBox message={clientsApi.error} />}

      {allClients.length >= 500 && summary.data && Number(summary.data.total_clients) > allClients.length && (
        <div className="sv-muted" style={{ fontSize: 'var(--text-sm)', margin: '4px 0 12px' }}>
          Showing the first {allClients.length.toLocaleString()} of {Number(summary.data.total_clients).toLocaleString()} clients.
          Use the search box or the controller / SSID / AP / band filters to narrow to specific clients.
        </div>
      )}

      {clientsApi.loading && !clientsApi.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : clientGroups.length ? (
        clientGroups.map(({ controller, rows }) => {
          const counts = ctrlCounts.get(controller.id);
          return (
            <ClientControllerGroup
              key={controller.id}
              controller={controller}
              clients={rows}
              totalClients={filterActive ? null : (counts ? counts.client_count : null)}
              problemClients={filterActive ? null : (counts ? counts.problem_count : null)}
              onSelectMac={setSelectedMac}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
          );
        })
      ) : (
        <Empty message="No clients found." />
      )}

      {selectedMac && (
        <ClientDetailPanel key={selectedMac} mac={selectedMac} onClose={() => setSelectedMac(null)} />
      )}
    </div>
  );
}

// ── Signal quality visual bar (top-level component) ───────────
function SignalQualityBar({ rssi }: { rssi: number | null }) {
  // Map [-80, -50] → [0%, 100%], clamped.
  const pct = rssi == null
    ? 0
    : Math.max(0, Math.min(100, ((rssi - -80) / (-50 - -80)) * 100));
  return (
    <div>
      <div style={{
        position: 'relative', height: 12, borderRadius: 6,
        background: 'linear-gradient(to right, var(--red), var(--yellow), var(--green))',
        border: '1px solid var(--border)',
      }}>
        {rssi != null && (
          <div style={{
            position: 'absolute', top: -3, left: `calc(${pct}% - 4px)`,
            width: 10, height: 16, borderRadius: 3,
            background: signalColor(rssi), border: '2px solid var(--bg-card)',
            boxShadow: '0 0 0 1px var(--border)',
          }} />
        )}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)',
        color: 'var(--text-muted)', marginTop: 3,
      }}>
        <span>Poor</span><span>Excellent</span>
      </div>
    </div>
  );
}

// ── Client event row icon/label (top-level helper) ────────────
function clientEventMeta(ev: ClientEvent): { color: string; text: string | JSX.Element } {
  switch (ev.event_type) {
    case 'join':
      return { color: 'var(--green)', text: `→ joined ${ev.to_ap_name || '—'}` };
    case 'roam':
      return { color: '#0ea5e9', text: `↔ roamed to ${ev.to_ap_name || '—'}` };
    case 'leave':
      return { color: 'var(--text-muted)', text: `← left ${ev.from_ap_name || '—'}` };
    case 'low_signal':
      return { color: 'var(--yellow)', text: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconWarning width={12} height={12} /> low signal</span> };
    default:
      return { color: 'var(--text-secondary)', text: ev.event_type || '—' };
  }
}

// ── Client bandwidth-history helpers (top-level) ───────────────
// Small pill-style range tabs — mirrors devices/[id] page's RangeTabs
// (TAB_BTN_BASE/TAB_BTN_ACTIVE) sizing/styling for a compact slide-over.
const CLIENT_RANGE_BTN_BASE: React.CSSProperties = {
  fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1.4,
};
const CLIENT_RANGE_BTN_ACTIVE: React.CSSProperties = {
  ...CLIENT_RANGE_BTN_BASE, background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff',
};

// 7d history spans multiple days, so ticks need a date — 24h only needs time.
function fmtClientHistTick(ts: string, range: '24h' | '7d'): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return range === '7d'
    ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Client detail slide-in panel (top-level component) ────────
function ClientDetailPanel({ mac, onClose }: { mac: string; onClose: () => void }) {
  const mounted = useMountedPortal();
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [bwRange, setBwRange] = useState<'24h' | '7d'>('24h');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setDetail(null);
    apiGet<ClientDetail>(`/api/wireless/clients/${encodeURIComponent(mac)}`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e: any) => { if (!cancelled) setErr(e?.message || 'Failed to load client'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mac]);

  // Path includes both mac and bwRange, so useApi's own effect refetches on
  // either changing (switching clients or flipping the 24h/7d toggle).
  const historyApi = useApi<ClientHistory>(
    `/api/wireless/clients/${encodeURIComponent(mac)}/history?range=${bwRange}`, 0
  );

  // useApi never clears `data` when its key (mac/bwRange) changes — it only
  // flips `loading` back to true and leaves the previous response in place
  // until the new one lands. Track which key the currently-held `data` is
  // actually FOR, and only trust `historyApi.data` when it matches the key
  // we're rendering for right now; otherwise show the loading state instead
  // of the stale previous client/range's chart. (`key={mac}` on the two
  // <ClientDetailPanel> call sites already forces a remount — and a fresh
  // renderedHistoryKey — when the selected client changes, so in practice
  // this mainly guards the 24h/7d toggle, which flips bwRange without a
  // remount.)
  const historyReqKey = `${mac}/${bwRange}`;
  const [renderedHistoryKey, setRenderedHistoryKey] = useState<string | null>(null);
  useEffect(() => {
    if (!historyApi.loading && historyApi.data) setRenderedHistoryKey(historyReqKey);
  }, [historyApi.loading, historyApi.data, historyReqKey]);
  const historyReady = renderedHistoryKey === historyReqKey;

  const bwChartData = useMemo(
    () => (historyReady ? (historyApi.data?.points || []) : []).map((p) => ({
      ts: p.ts,
      rx: p.rx_bps != null ? Number(p.rx_bps) : null,
      tx: p.tx_bps != null ? Number(p.tx_bps) : null,
    })),
    [historyApi.data, historyReady]
  );

  const c = detail?.client;
  const events = detail?.events || [];
  const stats = detail?.stats;

  if (!mounted) return null;
  return createPortal(
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 96vw)',
          background: 'var(--bg-card)', borderLeft: '1px solid var(--border)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.18)', overflowY: 'auto',
          padding: '20px 22px', zIndex: 60,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, wordBreak: 'break-all' }}>{mac}</h2>
            {c && (
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', marginTop: 4 }}>
                {c.ip_address || '—'}{c.hostname ? ` · ${c.hostname}` : ''}
              </div>
            )}
          </div>
          <button className="sv-btn ghost sm" onClick={onClose}>Close</button>
        </div>

        {err && <ErrorBox message={err} />}
        {loading && !detail ? (
          <Loading />
        ) : c ? (
          <>
            <h3 style={{ marginBottom: 6 }}>Current Connection</h3>
            <table className="sv-table">
              <tbody>
                <tr><td style={{ color: 'var(--text-muted)' }}>AP</td><td>{c.ap_name || '—'}</td></tr>
                <tr><td style={{ color: 'var(--text-muted)' }}>SSID</td><td>{c.ssid_name || '—'}</td></tr>
                <tr>
                  <td style={{ color: 'var(--text-muted)' }}>Band</td>
                  <td>{c.band || '—'}{c.channel != null ? ` (Ch ${c.channel})` : ''}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-muted)' }}>Signal</td>
                  <td><SignalCell rssi={c.rssi_dbm} /></td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-muted)' }}>Rate</td>
                  <td>Tx {fmtRate(c.tx_rate_mbps)} · Rx {fmtRate(c.rx_rate_mbps)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-muted)' }}>Bandwidth</td>
                  <td>
                    {(c.rx_bps != null || c.tx_bps != null)
                      ? `↓ ${fmtBps(c.rx_bps)} · ↑ ${fmtBps(c.tx_bps)}`
                      : '—'}
                  </td>
                </tr>
                <tr><td style={{ color: 'var(--text-muted)' }}>Auth</td><td>{c.auth_type || '—'}</td></tr>
                <tr>
                  <td style={{ color: 'var(--text-muted)' }}>Connected</td>
                  <td>{fmtRel(c.connected_since)}</td>
                </tr>
              </tbody>
            </table>

            <h3 style={{ marginBottom: 6 }}>Signal Quality</h3>
            <div style={{ marginBottom: 12 }}>
              <SignalQualityBar rssi={c.rssi_dbm} />
            </div>

            <h3 style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span>Bandwidth</span>
              <span style={{ display: 'flex', gap: 4 }}>
                {(['24h', '7d'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setBwRange(r)}
                    style={bwRange === r ? CLIENT_RANGE_BTN_ACTIVE : CLIENT_RANGE_BTN_BASE}
                  >
                    {r}
                  </button>
                ))}
              </span>
            </h3>
            <div style={{ marginBottom: 12 }}>
              {historyApi.error ? (
                <ErrorBox message={historyApi.error} />
              ) : !historyReady ? (
                <Loading />
              ) : bwChartData.length ? (
                <ResponsiveContainer width="100%" height={170}>
                  <LineChart data={bwChartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="ts" tickFormatter={(v) => fmtClientHistTick(v, bwRange)} fontSize={11} minTickGap={30} />
                    <YAxis fontSize={11} width={54} tickFormatter={(v) => fmtBps(v)} />
                    <Tooltip
                      {...CHART_TOOLTIP}
                      labelFormatter={(v: any) => fmtClientHistTick(String(v), bwRange)}
                      formatter={(v: any, name: any) => [fmtBps(v), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
                    {/* connectNulls intentionally omitted (default false): a null
                        rx_bps/tx_bps point (delta couldn't be computed, e.g. right
                        after a collector restart) should show as a gap, not be
                        bridged into a fake continuous line or a fake zero. */}
                    <Line type="monotone" name="↓ Download" dataKey="rx" stroke={CLIENT_BW_RX_COLOR} strokeWidth={2} dot={false} />
                    <Line type="monotone" name="↑ Upload" dataKey="tx" stroke={CLIENT_BW_TX_COLOR} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                  No bandwidth history yet
                </div>
              )}
            </div>

            <h3 style={{ marginBottom: 6 }}>Roaming History (24h)</h3>
            {events.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 12 }}>
                {events.map((ev: ClientEvent, i: number) => {
                  const meta = clientEventMeta(ev);
                  return (
                    <div
                      key={`${ev.ts}-${i}`}
                      style={{
                        display: 'flex', alignItems: 'baseline', gap: 10,
                        padding: '6px 0', borderBottom: '1px solid var(--border-light)', fontSize: 'var(--text-base)',
                      }}
                    >
                      <span style={{ color: 'var(--text-muted)', width: 64, flexShrink: 0 }}>
                        {fmtTime(ev.ts)}
                      </span>
                      <span style={{ color: meta.color, flex: 1 }}>
                        {meta.text}
                        {ev.rssi_dbm != null ? (
                          <span style={{ color: 'var(--text-muted)' }}> ({ev.rssi_dbm} dBm)</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginBottom: 12 }}>
                No events in last 24h
              </div>
            )}

            {stats && (
              <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-secondary)', marginTop: 4 }}>
                Roams (24h): {Number(stats.total_roams_24h)} |{' '}
                Avg Signal: {stats.avg_rssi_24h != null ? Number(stats.avg_rssi_24h) : '—'} dBm |{' '}
                SSIDs used: {(stats.ssids_used || []).length}
              </div>
            )}
          </>
        ) : !err ? (
          <Empty message="No client data." />
        ) : null}
      </div>
    </div>,
    document.body
  );
}

// ════════════════════════════════════════════════════════════
// TAB 5 — Controllers
// ════════════════════════════════════════════════════════════

// ── Controllers helpers (top-level) ───────────────────────────
function fmtUptimeShort(s: number | null | undefined): string {
  const n = Number(s);
  if (s == null || !Number.isFinite(n) || n <= 0) return '—';
  const days = Math.floor(n / 86400);
  const hours = Math.floor((n % 86400) / 3600);
  const mins = Math.floor((n % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function fmtInt(n: number | null | undefined): string {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return '0';
  return v.toLocaleString();
}

function fmtPct(n: number | null | undefined): string {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return 'N/A';
  return `${Math.round(v)}%`;
}

const EVENT_META: Record<string, { icon: string | JSX.Element; color: string }> = {
  join: { icon: '↑', color: 'var(--green)' },
  leave: { icon: '↓', color: 'var(--text-muted)' },
  low_signal: { icon: <IconWarning width={12} height={12} />, color: 'var(--orange)' },
  alert: { icon: '●', color: 'var(--red)' },
};

// Flags a controller-reported AP/client count that disagrees with SpanVault's
// own polled count by more than ~10% — a sign the local AP inventory is stale
// or incomplete (some APs aren't being polled/parsed).
function reportedCountMismatch(reported: number | null, local: number): boolean {
  if (reported == null) return false;
  if (local <= 0) return reported > 0;
  return Math.abs(reported - local) / local > 0.1;
}

// ── Controller inventory table (top-level) ────────────────────
function ControllerInventoryTable({ controllers, capsById, onShowPeers }: {
  controllers: OverviewController[];
  capsById: Map<number, { probed: boolean; isSnmp: boolean }>;
  onShowPeers: (c: OverviewController) => void;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="sv-table">
        <thead><tr>
          <th style={STICKY_TH}>Name</th><th style={STICKY_TH}>Site</th><th style={STICKY_TH}>Model</th>
          <th style={STICKY_TH}>APs</th><th style={STICKY_TH}>Cap%</th><th style={STICKY_TH}>Clients</th>
          <th style={STICKY_TH}>CPU</th><th style={STICKY_TH}>Mem</th><th style={STICKY_TH}>HA</th><th style={STICKY_TH}>Uptime</th>
        </tr></thead>
        <tbody>
          {controllers.map((c) => {
            const hasLic = c.licensed_aps != null && Number(c.licensed_aps) > 0;
            const cap = c.ap_capacity_pct;
            const ha = haCellLabel(c.ha_mode, c.ha_sync_status);
            const capsEntry = capsById.get(c.id);
            const isSnmp = capsEntry?.isSnmp === true;
            const probed = capsEntry?.probed === true;
            return (
              <tr key={c.id}>
                <td style={{ fontWeight: 600 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <StatusDot status={c.status === 'ok' ? 'up' : c.status === 'error' ? 'down' : 'unknown'} />
                    {c.name}
                    {/* SNMP-only concept (OID capability probing) — API-based
                        vendors like aruba_central have nothing to probe, so
                        showing this at all (let alone as an orange warning)
                        reads as a broken integration when it isn't. */}
                    {isSnmp && (
                      <span
                        title={probed ? 'Capabilities probed' : 'Capabilities not probed'}
                        style={{ display: 'inline-flex', alignItems: 'center', color: probed ? 'var(--text-muted)' : 'var(--orange)', fontWeight: 700 }}
                      >{probed ? <IconCheck width={12} height={12} /> : <IconWarning width={12} height={12} />}</span>
                    )}
                  </span>
                </td>
                <td>{c.site_name || '—'}</td>
                <td>
                  {c.model || c.vendor}
                  {c.firmware_version && (
                    <span style={{ color: 'var(--text-muted)' }}> · {c.firmware_version}</span>
                  )}
                </td>
                <td>{fmtInt(c.ap_count)}</td>
                <td>
                  {hasLic ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span>{fmtInt(c.ap_count)}/{fmtInt(c.licensed_aps)}{cap != null && ` ${Math.round(Number(cap))}%`}</span>
                      <ProgressBar pct={cap} width={36} />
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>{fmtInt(c.ap_count)} APs</span>
                  )}
                </td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {fmtInt(c.client_count)}
                    {reportedCountMismatch(c.reported_client_count, c.client_count) && (
                      <span
                        title={`Controller reports ${fmtInt(c.reported_client_count)} clients, SpanVault has polled ${fmtInt(c.client_count)}`}
                        style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--orange)' }}
                      ><IconWarning width={12} height={12} /></span>
                    )}
                  </span>
                </td>
                <td>{c.cpu_pct != null ? `${Math.round(Number(c.cpu_pct))}%` : '—'}</td>
                <td>{c.mem_pct != null ? `${Math.round(Number(c.mem_pct))}%` : '—'}</td>
                <td style={{ color: ha.color, fontWeight: 600 }}>
                  {ha.dot && <span style={{ marginRight: 4 }}>●</span>}
                  {ha.text === 'N/A' || ha.text === 'Standalone' ? (ha.text === 'N/A' ? 'N/A' : '—') : ha.text}
                  {Array.isArray(c.ha_peers) && c.ha_peers.length > 0 && (
                    <button
                      type="button"
                      className="sv-btn ghost sm"
                      title={`View ${c.ha_peers.length} cluster peer(s)`}
                      onClick={() => onShowPeers(c)}
                      style={{ marginLeft: 6, padding: '1px 6px', fontSize: 'var(--text-xs)', fontWeight: 600 }}
                    >
                      Peers ({c.ha_peers.length})
                    </button>
                  )}
                </td>
                <td>{fmtUptimeShort(c.uptime_seconds)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── AP capacity chart (per-controller clustered bars if licensed, else bar) ─
function ApCapacityChart({ controllers }: { controllers: OverviewController[] }) {
  const withLic = controllers.filter((c) => c.licensed_aps != null && Number(c.licensed_aps) > 0);
  if (withLic.length) {
    // Per-controller clustered bars: Licensed vs Used (ap_count).
    const capData = withLic.map((c) => ({
      name: c.name,
      licensed: Number(c.licensed_aps || 0),
      used: Number(c.ap_count || 0),
    }));
    // Several controllers read more cleanly on a vertical (horizontal-bar) layout.
    const vertical = capData.length > 3;
    return (
      <ResponsiveContainer width="100%" height={Math.max(180, vertical ? capData.length * 44 : 180)}>
        {vertical ? (
          <BarChart data={capData} layout="vertical" margin={{ left: 8, right: 8, top: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" fontSize={11} allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={100} fontSize={11} />
            <Tooltip {...CHART_TOOLTIP} />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
            <Bar dataKey="licensed" name="Licensed" fill="var(--border)" />
            <Bar dataKey="used" name="Used" fill="var(--green)" />
          </BarChart>
        ) : (
          <BarChart data={capData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="name" fontSize={11} />
            <YAxis fontSize={11} allowDecimals={false} />
            <Tooltip {...CHART_TOOLTIP} />
            <Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />
            <Bar dataKey="licensed" name="Licensed" fill="var(--border)" />
            <Bar dataKey="used" name="Used" fill="var(--green)" />
          </BarChart>
        )}
      </ResponsiveContainer>
    );
  }
  const barData = controllers.map((c) => ({ name: c.name, aps: Number(c.ap_count || 0) }));
  return barData.length ? (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={barData} layout="vertical" margin={{ left: 8, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis type="number" fontSize={11} allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={100} fontSize={11} />
        <Tooltip {...CHART_TOOLTIP} />
        <Bar dataKey="aps" fill="var(--green)" name="APs" />
      </BarChart>
    </ResponsiveContainer>
  ) : <Empty message="No AP data." />;
}

// ── Controller health table (top-level) ───────────────────────
function ControllerHealthTable({ controllers }: { controllers: OverviewController[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="sv-table">
        <thead><tr>
          <th style={STICKY_TH}>Name</th><th style={STICKY_TH}>Uptime</th><th style={STICKY_TH}>CPU</th>
          <th style={STICKY_TH}>Mem</th><th style={STICKY_TH}>Temp</th><th style={STICKY_TH}>Disc (24h)</th><th style={STICKY_TH}>Polled</th>
        </tr></thead>
        <tbody>
          {controllers.map((c) => {
            const disc = Number(c.ap_disconnects_24h || 0);
            const tempAbnormal = c.chassis_temp_status != null && c.chassis_temp_status.toUpperCase() !== 'NORMAL';
            return (
              <tr key={c.id}>
                <td style={{ fontWeight: 600 }}>
                  <span
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    title={c.last_reboot_reason || undefined}
                  >
                    <StatusDot status={c.status === 'ok' ? 'up' : c.status === 'error' ? 'down' : 'unknown'} />
                    {c.name}
                  </span>
                </td>
                <td>{fmtUptimeShort(c.uptime_seconds)}</td>
                <td>
                  {c.cpu_pct != null ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <ProgressBar pct={c.cpu_pct} /> {Math.round(Number(c.cpu_pct))}%
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {c.mem_pct != null ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <ProgressBar pct={c.mem_pct} /> {Math.round(Number(c.mem_pct))}%
                    </span>
                  ) : '—'}
                </td>
                <td
                  style={{ color: tempAbnormal ? 'var(--red)' : undefined, fontWeight: tempAbnormal ? 700 : 400 }}
                  title={c.chassis_temp_status || undefined}
                >
                  {c.chassis_temp_c != null ? `${Math.round(Number(c.chassis_temp_c))}°C` : '—'}
                </td>
                <td style={{ color: disc > 10 ? 'var(--red)' : undefined, fontWeight: disc > 10 ? 700 : 400 }}>
                  {c.ap_disconnects_24h != null ? disc : '—'}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{fmtRel(c.last_polled_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── HA / redundancy status table (top-level) ──────────────────
// A controller has HA configured when ha_sync_status is set and not 'Standalone'.
function HaStatusTable({ controllers }: { controllers: OverviewController[] }) {
  const haCtls = controllers.filter(controllerInHa);
  if (!haCtls.length) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>No HA configured</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="sv-table">
        <thead><tr>
          <th style={STICKY_TH}>Controller</th><th style={STICKY_TH}>Peer</th>
          <th style={STICKY_TH}>Role</th><th style={STICKY_TH}>Sync</th><th style={STICKY_TH}>HA APs</th>
        </tr></thead>
        <tbody>
          {haCtls.map((c) => {
            const manual = c.ha_peer_controller_id != null;
            const synced = c.ha_sync_status === 'Synced';
            const role = manual
              ? { text: c.ha_manual_role || 'Paired', color: c.ha_manual_role === 'Active' ? 'var(--green)' : 'var(--text-muted)', dot: true }
              : haCellLabel(c.ha_mode, c.ha_sync_status);
            // WLSX-HA-MIB AP/tunnel counts (Aruba only, live-verified) — the active
            // member of a real pair reports nonzero counts, the standby reports 0.
            const haApsTitle = c.ha_total_vap_tunnels != null
              ? `VAP tunnels: ${c.ha_active_vap_tunnels ?? 0} active / ${c.ha_standby_vap_tunnels ?? 0} standby (${c.ha_total_vap_tunnels ?? 0} total) · AP heartbeat tunnels: ${c.ha_ap_hbt_tunnels ?? '—'}`
              : undefined;
            return (
              <tr key={c.id}>
                <td style={{ fontWeight: 600 }}>{c.name}</td>
                <td>{manual ? (c.ha_peer_name || '—') : (c.ha_peer_ip || '—')}</td>
                <td style={{ color: role.color, fontWeight: 600 }}>
                  {role.dot && <span style={{ marginRight: 4 }}>●</span>}{role.text}
                </td>
                <td style={{ color: manual ? 'var(--text-muted)' : (synced ? 'var(--green)' : 'var(--orange)') }}>
                  {manual ? 'Manual' : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {synced ? <IconCheck width={12} height={12} /> : <IconWarning width={12} height={12} />}
                      {synced ? 'Synced' : (c.ha_sync_status || 'Not Synced')}
                    </span>
                  )}
                </td>
                <td title={haApsTitle}>
                  {c.ha_total_aps != null ? (
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {c.ha_active_aps ?? 0} active
                      {(c.ha_standby_aps ?? 0) > 0 && (
                        <span style={{ color: 'var(--text-muted)' }}> / {c.ha_standby_aps} standby</span>
                      )}
                    </span>
                  ) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Recent controller events timeline (slim) (top-level) ──────
function ControllerEventsTimeline({ events }: { events: ControllerEvent[] }) {
  if (!events.length) return <Empty message="No recent controller events." />;
  return (
    <div>
      {events.map((e, i) => {
        const meta = EVENT_META[e.event_type] || { icon: '•', color: 'var(--text-muted)' };
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '5px 0', borderBottom: '1px solid var(--border-light)', fontSize: 'var(--text-sm)',
          }}>
            <span style={{ width: 96, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtTime(e.ts)}</span>
            <span style={{ color: meta.color, fontWeight: 700, width: 14, textAlign: 'center', flexShrink: 0 }}>
              {meta.icon}
            </span>
            <span style={{ flex: 1 }}>
              {e.description}
              {e.ap_name && <span style={{ color: 'var(--text-muted)' }}> · {e.ap_name}</span>}
            </span>
            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{e.site_name || ''}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Capability probe result + diagnostics (top-level) ─────────
type CapabilityDetail = { capability: string; found: boolean; oid: string | null; value: any; tried: number };

const CAP_LABELS: Record<string, string> = {
  model: 'Model', firmware: 'Firmware', licensed_aps: 'Licensed APs',
  ha_role: 'HA Role', ha_peer_name: 'HA Peer', ha_sync: 'HA Sync',
};
function capLabel(k: string): string { return CAP_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

// SNMP values arrive as a string/number, or { hex, ascii } for binary (decodeSnmpVal).
function fmtSnmpVal(v: any): string {
  if (v == null) return '—';
  if (typeof v === 'object') {
    const printable = (v.ascii || '').replace(/\./g, '').trim();
    return printable ? v.ascii : (v.hex ? `0x${v.hex}` : '—');
  }
  return String(v);
}

// Shows what the Detect probe actually found: each capability → resolved OID + value, or "not found".
function CapabilityResultModal({ result, onClose }: {
  result: { name: string; details: CapabilityDetail[]; message: string | null };
  onClose: () => void;
}) {
  const found = result.details.filter((d) => d.found).length;
  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" style={{ maxWidth: 680 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Capabilities — {result.name}</h2>
        <p className="sv-muted" style={{ fontSize: 'var(--text-base)', marginTop: -4 }}>
          What SpanVault probed on this controller. Found {found} of {result.details.length}.
          {' '}A capability shows “not found” when this hardware/firmware doesn’t expose that OID.
        </p>
        {result.message && <div className="sv-err-inline">{result.message}</div>}
        {result.details.length > 0 && (
          <table className="sv-table">
            <thead><tr><th>Capability</th><th>Status</th><th>OID</th><th>Value</th></tr></thead>
            <tbody>
              {result.details.map((d) => (
                <tr key={d.capability}>
                  <td style={{ fontWeight: 600 }}>{capLabel(d.capability)}</td>
                  <td style={{ color: d.found ? 'var(--green)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {d.found ? <IconCheck width={12} height={12} /> : <IconClose width={12} height={12} />}
                      {d.found ? 'Found' : 'Not found'}
                    </span>
                  </td>
                  <td><code style={{ fontSize: 'var(--text-xs)' }}>{d.oid || '—'}</code></td>
                  <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.found ? fmtSnmpVal(d.value) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="sv-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// Aruba cluster/peer roster (WLSX-SYSTEMEXT-MIB) — simple read-only listing,
// reusing the same sv-modal-backdrop/sv-modal pattern as CapabilityResultModal.
function HaPeersModal({ controller, onClose }: { controller: OverviewController; onClose: () => void }) {
  const peers = controller.ha_peers || [];
  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" style={{ maxWidth: 640 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Cluster Peers — {controller.name}</h2>
        <p className="sv-muted" style={{ fontSize: 'var(--text-base)', marginTop: -4 }}>
          Aruba cluster/peer roster reported by this controller. Only the cluster master returns a
          populated roster — a non-master member may report only itself or nothing this cycle.
        </p>
        {peers.length === 0 ? (
          <Empty message="No peer data reported." />
        ) : (
          <table className="sv-table">
            <thead><tr>
              <th>IP</th><th>Role</th><th>Status</th><th>Location</th><th>Serial</th>
            </tr></thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.ip}>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{p.ip}</td>
                  <td style={{ textTransform: 'capitalize' }}>{p.role || '—'}</td>
                  <td style={{ color: p.status === 'active' ? 'var(--green)' : 'var(--text-muted)' }}>
                    {p.status || '—'}
                  </td>
                  <td>{p.location || '—'}</td>
                  <td>{p.serial || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="sv-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Raw SNMP diagnostics — walks the controller live and shows what its OID tables
// actually return (metadata scalars + subtree row counts + samples). Read-only.
function ControllerDiagnosticsModal({ controller, onClose }: { controller: Controller; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    apiGet<any>(`/api/wireless/debug/walk?controller_id=${controller.id}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: any) => { if (!cancelled) setErr(e?.message || 'Diagnostics failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [controller.id]);

  const meta = data && data.metadata_probe ? Object.entries<any>(data.metadata_probe) : [];
  const subtrees = data && data.subtrees ? Object.entries<any>(data.subtrees) : [];
  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" style={{ maxWidth: 760, maxHeight: '88vh', overflowY: 'auto' }} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>SNMP Diagnostics — {controller.name}</h2>
        <p className="sv-muted" style={{ fontSize: 'var(--text-base)', marginTop: -4 }}>
          Live walk of what this controller exposes over SNMP — use it to find the right OID when something
          (e.g. HA state) isn’t auto-detected.
        </p>
        {loading ? <Loading /> : err ? <ErrorBox message={err} /> : data && data.ok === false ? (
          <ErrorBox message={data.message || data.error || 'Diagnostics failed'} />
        ) : data ? (
          <>
            {data.timed_out && (
              <div style={{
                background: 'var(--tint-warn)', color: 'var(--tint-warn-fg)',
                fontSize: 'var(--text-sm)', borderRadius: 8, padding: '8px 10px', marginBottom: 12,
              }}>
                The walk hit its time limit — results are partial.
                {Array.isArray(data.skipped) && data.skipped.length > 0 && (
                  <> Skipped: <span style={{ fontFamily: 'var(--font-mono)' }}>{data.skipped.join(', ')}</span></>
                )}
              </div>
            )}
            {meta.length > 0 && (
              <>
                <h3 style={{ marginBottom: 6 }}>Metadata probes</h3>
                <table className="sv-table" style={{ marginBottom: 14 }}>
                  <thead><tr><th>Field</th><th>OID</th><th>Value</th></tr></thead>
                  <tbody>
                    {meta.map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ fontWeight: 600 }}>{k}</td>
                        <td><code style={{ fontSize: 'var(--text-xs)' }}>{v.oid}</code></td>
                        <td style={{ color: v.value == null ? 'var(--text-muted)' : undefined }}>
                          {v.value == null ? 'no value' : fmtSnmpVal(v.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {subtrees.length > 0 && (
              <>
                <h3 style={{ marginBottom: 6 }}>SNMP tables (row counts)</h3>
                <table className="sv-table" style={{ marginBottom: 14 }}>
                  <thead><tr><th>Table</th><th>Base OID</th><th>Rows</th></tr></thead>
                  <tbody>
                    {subtrees.map(([k, v]) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td><code style={{ fontSize: 'var(--text-xs)' }}>{v.base}</code></td>
                        <td>
                          {v.count}{v.truncated ? '+' : ''}
                          {v.truncated && (
                            <span className="sv-muted" style={{ fontSize: 'var(--text-xs)', marginLeft: 4 }}>(truncated)</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>Raw JSON</summary>
              <pre style={{ maxHeight: 280, overflow: 'auto', fontSize: 'var(--text-xs)', background: 'var(--bg-code, #0b1020)', color: 'var(--text-code, #cbd5e1)', padding: 10, borderRadius: 6 }}>
                {JSON.stringify(data, null, 2)}
              </pre>
            </details>
          </>
        ) : null}
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="sv-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── Capabilities detection accordion (collapsed) (top-level) ──
function CapabilitiesAccordion({
  controllers, canProbe, canEdit, probingId, onProbe, onEdit, onTest, onDelete, onDiagnostics,
}: {
  controllers: Controller[];
  canProbe: boolean;
  canEdit: boolean;
  probingId: number | null;
  onProbe: (c: Controller) => void;
  onEdit: (c: Controller) => void;
  onTest: (c: Controller) => void;
  onDelete: (c: Controller) => void;
  onDiagnostics: (c: Controller) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{
      marginTop: 16, background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          padding: '12px 20px', fontSize: 'var(--text-sm)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--orange)' }}><IconTool width={14} height={14} /></span>
        Controller Capabilities
        <span style={{ flex: 1 }} />
        <span>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 20px 16px', overflowX: 'auto' }}>
          {controllers.length ? (
            <table className="sv-table">
              <thead><tr>
                <th style={STICKY_TH}>Controller</th><th style={STICKY_TH}>Vendor</th>
                <th style={STICKY_TH}>Probe Status</th><th style={{ ...STICKY_TH, textAlign: 'right' }}></th>
              </tr></thead>
              <tbody>
                {controllers.map((c) => {
                  const probed = c.has_capabilities === true;
                  const isSnmp = c.snmp_device_id != null;
                  const busy = probingId === c.id;
                  return (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td>{c.vendor}</td>
                      <td>
                        {!isSnmp ? (
                          // OID capability probing is an SNMP-only concept — API
                          // vendors (aruba_central) have nothing to probe, so this
                          // must read as neutral, not as a warning that something's
                          // broken (the controller can be polling fine regardless).
                          <span style={{ color: 'var(--text-muted)' }} title="Capability probing applies to SNMP controllers only">N/A</span>
                        ) : probed ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
                            <IconCheck width={12} height={12} /> Probed{c.capabilities_probed_at ? ` ${fmtRel(c.capabilities_probed_at)}` : ''}
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--orange)', fontWeight: 600 }}><IconWarning width={12} height={12} /> Not probed</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                          {isSnmp && canProbe && (
                            <button className="sv-btn ghost sm" disabled={busy} onClick={() => onProbe(c)}>
                              {busy ? 'Detecting…' : 'Detect'}
                            </button>
                          )}
                          {isSnmp && canEdit && (
                            <button className="sv-btn ghost sm" onClick={() => onDiagnostics(c)} title="Show what OIDs this controller exposes">Diagnostics</button>
                          )}
                          {canEdit && (
                            <>
                              <button className="sv-btn ghost sm" onClick={() => onEdit(c)}>Edit</button>
                              <button className="sv-btn ghost sm" onClick={() => onTest(c)}>Test</button>
                              <button className="sv-btn danger sm" onClick={() => onDelete(c)}>Delete</button>
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <Empty message="No controllers." />}
        </div>
      )}
    </div>
  );
}

// ── Controllers tab (top-level) ───────────────────────────────
function ControllersTab({ onViewEvents }: { onViewEvents?: () => void }) {
  const { canEdit, role } = useRbac();
  const { confirm, ConfirmUI } = useConfirm();
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 0);
  const overview = useApi<ControllerOverview>('/api/wireless/controllers/overview', 30000);
  const events = useApi<ControllerEvent[]>('/api/wireless/controllers/events', 30000);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Controller | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  async function handleTest(c: Controller) {
    try {
      const r = await apiSend<{ ok: boolean; message: string; ap_count?: number }>(
        `/api/wireless/controllers/${c.id}/test`, 'POST', {});
      const extra = r.ap_count != null ? ` (${r.ap_count} APs)` : '';
      setToast(`${r.ok ? '✓' : '✗'} ${c.name}: ${r.message}${extra}`);
    } catch (e: any) {
      setToast(`✗ ${c.name}: ${e?.message || 'Test failed'}`);
    }
    setTimeout(() => setToast(null), 6000);
  }

  async function handleDelete(c: Controller) {
    const ok = await confirm({
      title: 'Delete controller?',
      message: `Delete controller "${c.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await apiSend(`/api/wireless/controllers/${c.id}`, 'DELETE');
    controllers.reload();
    overview.reload();
  }

  const [probingId, setProbingId] = useState<number | null>(null);
  const [probeResult, setProbeResult] = useState<{ name: string; details: CapabilityDetail[]; message: string | null } | null>(null);
  const [diagController, setDiagController] = useState<Controller | null>(null);
  const [peersController, setPeersController] = useState<OverviewController | null>(null);
  async function handleProbe(c: Controller) {
    setProbingId(c.id);
    try {
      const r = await apiSend<{ details: CapabilityDetail[]; message: string | null }>(
        `/api/wireless/controllers/${c.id}/probe`, 'POST', {});
      setProbeResult({ name: c.name, details: r.details || [], message: r.message || null });
    } catch (e: any) {
      setToast(`✗ ${c.name}: ${e?.message || 'Probe failed'}`);
      setTimeout(() => setToast(null), 6000);
    }
    await controllers.reload();
    overview.reload();
    setProbingId(null);
  }

  async function handleRescan() {
    setRescanning(true);
    try {
      const r = await apiSend<{ created: number; controllers: any[] }>(
        '/api/wireless/controllers/rescan', 'POST', {});
      const n = r.created ?? 0;
      setToast(n > 0 ? `✓ Found ${n} new controller${n === 1 ? '' : 's'}` : 'No new controllers found');
    } catch (e: any) {
      setToast(`✗ Scan failed: ${e?.message || 'unknown error'}`);
    }
    setTimeout(() => setToast(null), 6000);
    await controllers.reload();
    overview.reload();
    setRescanning(false);
  }

  const canProbe = role === 'admin' || role === 'super_admin';

  const ov = overview.data;
  const ovCtls: OverviewController[] = ov?.controllers || [];
  const ctlList: Controller[] = controllers.data || [];
  const evList: ControllerEvent[] = events.data || [];

  // has_capabilities map (overview rows don't carry it — join by controller id).
  const capsById = useMemo(() => {
    const m = new Map<number, { probed: boolean; isSnmp: boolean }>();
    ctlList.forEach((c) => m.set(c.id, { probed: c.has_capabilities === true, isSnmp: c.snmp_device_id != null }));
    return m;
  }, [ctlList]);

  return (
    <div>
      {/* Add controller bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1 }} />
        {canEdit && (
          <button className="sv-btn ghost" onClick={handleRescan} disabled={rescanning}>
            {rescanning ? 'Scanning…' : 'Scan for controllers'}
          </button>
        )}
        {canEdit && (
          <button className="sv-btn" onClick={() => { setEditing(null); setShowModal(true); }}>
            + Add Controller
          </button>
        )}
      </div>

      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}
      {controllers.error && <ErrorBox message={controllers.error} />}
      {overview.error && <ErrorBox message={overview.error} />}

      {controllers.loading && !controllers.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : ctlList.length === 0 ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No wireless controllers yet — add a wireless controller to get started →" />
        </div>
      ) : (
        <>
          {/* Controller Capabilities — shown above the overview rows so the
              edit/test controls stay visible while the overview API loads. */}
          <CapabilitiesAccordion
            controllers={ctlList}
            canProbe={canProbe}
            canEdit={canEdit}
            probingId={probingId}
            onProbe={handleProbe}
            onEdit={(c) => { setEditing(c); setShowModal(true); }}
            onTest={handleTest}
            onDelete={handleDelete}
            onDiagnostics={(c) => setDiagController(c)}
          />

          {probeResult && (
            <CapabilityResultModal result={probeResult} onClose={() => setProbeResult(null)} />
          )}
          {diagController && (
            <ControllerDiagnosticsModal controller={diagController} onClose={() => setDiagController(null)} />
          )}
          {peersController && (
            <HaPeersModal controller={peersController} onClose={() => setPeersController(null)} />
          )}

          {overview.loading && !ov ? (
            <div className="sv-panel"><Loading /></div>
          ) : ov && ovCtls.length ? (
            <>
              {/* Row 2 — Inventory (60%) | AP Capacity (40%) */}
              <EqualRow>
                <SectionCard title="Controller Inventory" flex="1 1 60%" minWidth={360}>
                  <ControllerInventoryTable controllers={ovCtls} capsById={capsById} onShowPeers={(c) => setPeersController(c)} />
                </SectionCard>
                <SectionCard title="AP Capacity" flex="1 1 36%" minWidth={260}>
                  <ApCapacityChart controllers={ovCtls} />
                </SectionCard>
              </EqualRow>

              {/* Row 3 — Health (60%) | HA / Redundancy (40%) */}
              <EqualRow>
                <SectionCard title="Controller Health" flex="1 1 60%" minWidth={360}>
                  <ControllerHealthTable controllers={ovCtls} />
                </SectionCard>
                <SectionCard title="HA / Redundancy" flex="1 1 36%" minWidth={260}>
                  <HaStatusTable controllers={ovCtls} />
                </SectionCard>
              </EqualRow>
            </>
          ) : null}

          {/* Row 4 — Recent events */}
          <div style={{ marginTop: 16 }}>
            <SectionCard
              title="Recent Events"
              maxHeight={160}
              action={onViewEvents && <button className="sv-btn ghost sm" onClick={onViewEvents}>View all →</button>}
            >
              {events.loading && !events.data ? <Loading /> : <ControllerEventsTimeline events={evList} />}
            </SectionCard>
          </div>
        </>
      )}

      {showModal && (
        <ControllerModal
          existing={editing}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); controllers.reload(); overview.reload(); }}
        />
      )}
      {ConfirmUI}
    </div>
  );
}

// ── Add/Edit controller modal (top-level component) ───────────
function ControllerModal({
  existing, onClose, onSaved,
}: {
  existing: Controller | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const sites = useApi<SiteRow[]>('/api/netvault/sites', 0);
  const [form, setForm] = useState<ControllerForm>(() => ({
    name: existing?.name || '',
    vendor: existing?.vendor || VENDOR_OPTIONS[0],
    conn_type: existing && existing.snmp_device_id == null && existing.controller_url ? 'api' : 'snmp',
    controller_url: existing?.controller_url || '',
    api_username: existing?.api_username || '',
    api_password: '',
    api_key: '',
    api_client_id: existing?.api_client_id || '',
    api_client_secret: '',
    api_customer_id: existing?.api_customer_id || '',
    api_refresh_token: '',
    api_group_filter: existing?.api_group_filter || '',
    snmp_device_id: existing?.snmp_device_id ?? null,
    site_id: existing?.site_id ?? null,
    site_name: existing?.site_name ?? null,
    // Editing an existing controller always defaults to link-existing (its device
    // is already provisioned). Provision-new is only offered for fresh adds.
    snmp_source: 'existing',
    ip_address: '',
    snmp_version: (existing?.snmp_version === '3' ? '3' : '2c'),
    snmp_community: existing?.snmp_community ?? 'public',
    snmp_port: existing?.snmp_port != null ? String(existing.snmp_port) : '161',
    snmp_v3_user: '',
    snmp_v3_auth_pass: '',
    snmp_v3_priv_pass: '',
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Manual HA pairing (edit mode only).
  const allCtls = useApi<Controller[]>('/api/wireless/controllers', 0);
  const [haPeerId, setHaPeerId] = useState(existing?.ha_peer_controller_id != null ? String(existing.ha_peer_controller_id) : '');
  const [haRole, setHaRole] = useState(existing?.ha_manual_role || '');

  function patch(p: Partial<ControllerForm>) {
    setForm((f) => ({ ...f, ...p }));
  }

  async function save() {
    if (!form.name.trim()) { setErr('Name is required'); return; }
    if (form.conn_type === 'snmp' && form.snmp_source === 'existing' && form.snmp_device_id == null) {
      setErr('Select a monitored device for SNMP'); return;
    }
    if (form.conn_type === 'snmp' && form.snmp_source === 'new' && !form.ip_address.trim()) {
      setErr('IP address is required to create a new SNMP device'); return;
    }
    if (form.conn_type === 'api' && !form.controller_url.trim()) {
      setErr('Controller URL is required for API'); return;
    }
    setSaving(true);
    setErr(null);
    const body: Record<string, any> = {
      name: form.name.trim(),
      vendor: form.vendor,
      site_id: form.site_id,
      site_name: form.site_name,
    };
    if (form.conn_type === 'snmp') {
      body.controller_url = null;
      if (form.snmp_source === 'existing') {
        // (a) link existing monitored device
        body.snmp_device_id = form.snmp_device_id;
        // When editing an existing SNMP controller, allow adjusting the linked
        // device's polling credentials inline (sent through to the backend).
        if (existing && existing.snmp_device_id != null) {
          body.snmp_version = form.snmp_version;
          body.snmp_port = parseInt(form.snmp_port, 10) || 161;
          if (form.snmp_version === '3') {
            if (form.snmp_v3_user.trim()) body.snmp_v3_user = form.snmp_v3_user.trim();
            if (form.snmp_v3_auth_pass) body.snmp_v3_auth_pass = form.snmp_v3_auth_pass;
            if (form.snmp_v3_priv_pass) body.snmp_v3_priv_pass = form.snmp_v3_priv_pass;
          } else {
            body.snmp_community = form.snmp_community.trim() || 'public';
          }
        }
      } else {
        // (b) provision new — backend creates/reuses the device from these fields
        body.snmp_device_id = null;
        body.ip_address = form.ip_address.trim();
        body.snmp_version = form.snmp_version;
        body.snmp_port = parseInt(form.snmp_port, 10) || 161;
        body.device_name = form.name.trim();
        body.device_type = 'Wireless Controller';
        if (form.snmp_version === '3') {
          body.snmp_v3_user = form.snmp_v3_user.trim() || null;
          if (form.snmp_v3_auth_pass) body.snmp_v3_auth_pass = form.snmp_v3_auth_pass;
          if (form.snmp_v3_priv_pass) body.snmp_v3_priv_pass = form.snmp_v3_priv_pass;
        } else {
          body.snmp_community = form.snmp_community.trim() || 'public';
        }
      }
    } else {
      body.snmp_device_id = null;
      body.controller_url = form.controller_url.trim();
      body.api_username = form.api_username.trim() || null;
      if (form.api_password) body.api_password = form.api_password;
      if (form.api_key) body.api_key = form.api_key;
      if (form.vendor === 'aruba_central') {
        body.api_client_id = form.api_client_id.trim() || null;
        if (form.api_client_secret) body.api_client_secret = form.api_client_secret;
        body.api_customer_id = form.api_customer_id.trim() || null;
        if (form.api_refresh_token) body.api_refresh_token = form.api_refresh_token;
        body.api_group_filter = form.api_group_filter.trim() || null;
      }
    }
    try {
      if (existing) {
        await apiSend(`/api/wireless/controllers/${existing.id}`, 'PUT', body);
        // Apply manual HA pairing (separate endpoint; sets both sides).
        try {
          await apiSend(`/api/wireless/controllers/${existing.id}/ha-peer`, 'POST', {
            peer_id: haPeerId ? Number(haPeerId) : null,
            role: haRole || null,
          });
        } catch (_e) { /* HA pairing is optional — don't fail the save */ }
      } else {
        await apiSend('/api/wireless/controllers', 'POST', body);
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save controller');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{existing ? 'Edit Controller' : 'Add Controller'}</h2>
        {err && <ErrorBox message={err} />}
        <div className="sv-form-grid">
          <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Name
            <input className="sv-input" value={form.name} autoFocus
              onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Main WLC" />
          </label>
          <label className="sv-field">Vendor
            <select className="sv-select" value={form.vendor}
              onChange={(e) => patch({ vendor: e.target.value })}>
              {VENDOR_OPTIONS.map((v: string) => <option key={v} value={v}>{vendorLabel(v)}</option>)}
            </select>
          </label>
          <label className="sv-field">Connection type
            <select className="sv-select" value={form.conn_type}
              onChange={(e) => patch({ conn_type: e.target.value as 'snmp' | 'api' })}>
              <option value="snmp">SNMP (link to monitored device)</option>
              <option value="api">API (URL + credentials)</option>
            </select>
          </label>

          <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Site
            <select className="sv-select" value={form.site_id ?? ''}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                const name = sites.data?.find((s: SiteRow) => s.id === id)?.name ?? null;
                patch({ site_id: id, site_name: name });
              }}>
              <option value="">— No site —</option>
              {sites.data?.map((s: SiteRow) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>

          {existing && (
            <>
              <label className="sv-field">HA peer (manual)
                <select className="sv-select" value={haPeerId} onChange={(e) => setHaPeerId(e.target.value)}>
                  <option value="">— None —</option>
                  {(allCtls.data || []).filter((c) => c.id !== existing.id)
                    .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="sv-field">HA role
                <select className="sv-select" value={haRole} onChange={(e) => setHaRole(e.target.value)} disabled={!haPeerId}>
                  <option value="">—</option>
                  <option value="Active">Active</option>
                  <option value="Standby">Standby</option>
                </select>
              </label>
              <span className="sv-muted" style={{ gridColumn: '1 / -1', fontSize: 'var(--text-xs)', marginTop: -6 }}>
                For controllers that don’t expose HA over SNMP (e.g. AOS-8 gateways). Pairing is applied to both controllers.
              </span>
            </>
          )}

          {form.conn_type === 'snmp' ? (
            <>
              <label className="sv-field" style={{ gridColumn: '1 / -1' }}>SNMP device source
                <select className="sv-select" value={form.snmp_source}
                  onChange={(e) => patch({ snmp_source: e.target.value as 'existing' | 'new' })}>
                  <option value="existing">Link existing monitored device</option>
                  <option value="new">Create new device</option>
                </select>
              </label>

              {form.snmp_source === 'existing' ? (
                <>
                  <div className="sv-field" style={{ gridColumn: '1 / -1' }}>
                    <span>Monitored device (SNMP)</span>
                    <DeviceSelector
                      selectedId={form.snmp_device_id}
                      onSelect={(id) => patch({ snmp_device_id: id })}
                    />
                  </div>
                  {/* When editing an existing SNMP controller, expose the linked
                      device's polling credentials so they can be adjusted inline. */}
                  {existing && existing.snmp_device_id != null && (
                    <>
                      <label className="sv-field">SNMP version
                        <select className="sv-select" value={form.snmp_version}
                          onChange={(e) => patch({ snmp_version: e.target.value as '2c' | '3' })}>
                          <option value="2c">v2c</option>
                          <option value="3">v3</option>
                        </select>
                      </label>
                      <label className="sv-field">SNMP port
                        <input className="sv-input" value={form.snmp_port}
                          onChange={(e) => patch({ snmp_port: e.target.value })}
                          placeholder="161" />
                      </label>
                      {form.snmp_version === '2c' ? (
                        <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Community
                          <input className="sv-input" value={form.snmp_community}
                            onChange={(e) => patch({ snmp_community: e.target.value })}
                            placeholder="public" />
                        </label>
                      ) : (
                        <>
                          <label className="sv-field" style={{ gridColumn: '1 / -1' }}>v3 username
                            <input className="sv-input" value={form.snmp_v3_user}
                              onChange={(e) => patch({ snmp_v3_user: e.target.value })} />
                          </label>
                          <label className="sv-field">v3 auth password
                            <input className="sv-input" type="password" value={form.snmp_v3_auth_pass}
                              onChange={(e) => patch({ snmp_v3_auth_pass: e.target.value })}
                              placeholder="(unchanged)" />
                          </label>
                          <label className="sv-field">v3 priv password
                            <input className="sv-input" type="password" value={form.snmp_v3_priv_pass}
                              onChange={(e) => patch({ snmp_v3_priv_pass: e.target.value })}
                              placeholder="(unchanged)" />
                          </label>
                        </>
                      )}
                      <div style={{
                        gridColumn: '1 / -1', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: -4,
                      }}>
                        Editing SNMP credentials changes polling for the linked monitored device.
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <label className="sv-field" style={{ gridColumn: '1 / -1' }}>IP address
                    <input className="sv-input" value={form.ip_address}
                      onChange={(e) => patch({ ip_address: e.target.value })}
                      placeholder="e.g. 10.0.0.5" />
                  </label>
                  <label className="sv-field">SNMP version
                    <select className="sv-select" value={form.snmp_version}
                      onChange={(e) => patch({ snmp_version: e.target.value as '2c' | '3' })}>
                      <option value="2c">v2c</option>
                      <option value="3">v3</option>
                    </select>
                  </label>
                  <label className="sv-field">SNMP port
                    <input className="sv-input" value={form.snmp_port}
                      onChange={(e) => patch({ snmp_port: e.target.value })}
                      placeholder="161" />
                  </label>
                  {form.snmp_version === '2c' ? (
                    <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Community
                      <input className="sv-input" value={form.snmp_community}
                        onChange={(e) => patch({ snmp_community: e.target.value })}
                        placeholder="public" />
                    </label>
                  ) : (
                    <>
                      <label className="sv-field" style={{ gridColumn: '1 / -1' }}>v3 username
                        <input className="sv-input" value={form.snmp_v3_user}
                          onChange={(e) => patch({ snmp_v3_user: e.target.value })} />
                      </label>
                      <label className="sv-field">v3 auth password
                        <input className="sv-input" type="password" value={form.snmp_v3_auth_pass}
                          onChange={(e) => patch({ snmp_v3_auth_pass: e.target.value })} />
                      </label>
                      <label className="sv-field">v3 priv password
                        <input className="sv-input" type="password" value={form.snmp_v3_priv_pass}
                          onChange={(e) => patch({ snmp_v3_priv_pass: e.target.value })} />
                      </label>
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <label className="sv-field" style={{ gridColumn: '1 / -1' }}>
                {form.vendor === 'aruba_central' ? 'Base URL' : 'Controller URL'}
                <input className="sv-input" value={form.controller_url}
                  onChange={(e) => patch({ controller_url: e.target.value })}
                  placeholder={form.vendor === 'aruba_central'
                    ? 'https://apigw-prod2.central.arubanetworks.com'
                    : 'https://wlc.example.local'} />
              </label>
              {form.vendor === 'aruba_central' && (
                <span className="sv-muted" style={{ gridColumn: '1 / -1', fontSize: 'var(--text-xs)', marginTop: -6 }}>
                  Use the regional API gateway URL from your Central account (Account Home → Global
                  Settings → API Gateway) — not the Central login/UI URL.
                </span>
              )}
              <label className="sv-field">API username
                <input className="sv-input" value={form.api_username}
                  onChange={(e) => patch({ api_username: e.target.value })} />
              </label>
              <label className="sv-field">API password
                <input className="sv-input" type="password" value={form.api_password}
                  onChange={(e) => patch({ api_password: e.target.value })}
                  placeholder={existing ? '(unchanged)' : ''} />
              </label>
              <label className="sv-field" style={{ gridColumn: '1 / -1' }}>API key (optional)
                <input className="sv-input" value={form.api_key}
                  onChange={(e) => patch({ api_key: e.target.value })} />
              </label>
              {form.vendor === 'aruba_central' && (
                <>
                  <label className="sv-field">Client ID
                    <input className="sv-input" value={form.api_client_id}
                      onChange={(e) => patch({ api_client_id: e.target.value })} />
                  </label>
                  <label className="sv-field">Client Secret
                    <input className="sv-input" type="password" value={form.api_client_secret}
                      onChange={(e) => patch({ api_client_secret: e.target.value })}
                      placeholder={existing ? '(unchanged)' : ''} />
                  </label>
                  <label className="sv-field">Customer ID
                    <input className="sv-input" value={form.api_customer_id}
                      onChange={(e) => patch({ api_customer_id: e.target.value })} />
                  </label>
                  <span className="sv-muted" style={{ gridColumn: '1 / -1', fontSize: 'var(--text-xs)', marginTop: -6 }}>
                    Sent as the TenantID header.
                  </span>
                  <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Refresh Token
                    <input className="sv-input" type="password" value={form.api_refresh_token}
                      onChange={(e) => patch({ api_refresh_token: e.target.value })}
                      placeholder={existing ? '(unchanged)' : ''} />
                  </label>
                  <span className="sv-muted" style={{ gridColumn: '1 / -1', fontSize: 'var(--text-xs)', marginTop: -6 }}>
                    One-time bootstrap value downloaded from the Central UI when the API application
                    was created. After the first successful poll, SpanVault manages token rotation
                    automatically — you won&apos;t need this again unless the integration must be
                    re-authorized from scratch.
                  </span>
                  <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Group filter (optional)
                    <input className="sv-input" value={form.api_group_filter}
                      onChange={(e) => patch({ api_group_filter: e.target.value })}
                      placeholder="e.g. TU-HQ" />
                  </label>
                  <span className="sv-muted" style={{ gridColumn: '1 / -1', fontSize: 'var(--text-xs)', marginTop: -6 }}>
                    Optional AP group name to scope polling to. Leave blank to poll all groups.
                  </span>
                </>
              )}
            </>
          )}
        </div>

        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="sv-btn ghost"
            disabled
            title="Save the controller first, then Test it from its card."
          >Test Connection</button>
          <button className="sv-btn" onClick={save} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : existing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Device selector for SNMP controllers (top-level component) ─
function DeviceSelector({
  selectedId, onSelect,
}: {
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiGet<DeviceRow[]>('/api/devices')
      .then((rows) => { if (!cancelled) setDevices(rows); })
      .catch(() => { if (!cancelled) setDevices([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selected = devices.find((d: DeviceRow) => d.id === selectedId) || null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return devices.slice(0, 8);
    return devices.filter((d: DeviceRow) =>
      d.name.toLowerCase().includes(q) ||
      (d.ip_address || '').toLowerCase().includes(q)
    ).slice(0, 8);
  }, [devices, query]);

  if (selected) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 6,
        border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px',
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{selected.name}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {selected.ip_address || '—'}{selected.site_name ? ` · ${selected.site_name}` : ''}
          </div>
        </div>
        <button className="sv-btn ghost sm" onClick={() => onSelect(null)}>Change</button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      <input
        className="sv-input"
        placeholder={loading ? 'Loading devices…' : 'Search device by name or IP…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={loading}
      />
      <div style={{
        marginTop: 6, border: '1px solid var(--border)', borderRadius: 8,
        maxHeight: 220, overflowY: 'auto',
      }}>
        {matches.length ? matches.map((d: DeviceRow) => (
          <div
            key={d.id}
            onClick={() => onSelect(d.id)}
            style={{
              padding: '8px 12px', cursor: 'pointer',
              borderBottom: '1px solid var(--border-light)',
            }}
          >
            <div style={{ fontWeight: 600 }}>{d.name}</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {d.ip_address || '—'}{d.site_name ? ` · ${d.site_name}` : ''}
            </div>
          </div>
        )) : (
          <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>
            No matching devices.
          </div>
        )}
      </div>
    </div>
  );
}

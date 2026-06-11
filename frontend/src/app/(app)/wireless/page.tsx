'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  BarChart, Bar, ReferenceLine, Cell, PieChart, Pie,
} from 'recharts';
import { useApi, apiSend, apiGet } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, fmtRel, fmtTime, UtilBar, pctColor } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';

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
  rx_errors_2g: number | null;
  tx_errors_2g: number | null;
  rx_errors_5g: number | null;
  tx_errors_5g: number | null;
  throughput_in_bps: number | null;
  throughput_out_bps: number | null;
  serial_number: string | null;
  auth_failures: number | null;
}

interface ApHistoryRow {
  bucket: string;
  clients_total: number | null;
  clients_2g: number | null;
  clients_5g: number | null;
  radio_2g_util: number | null;
  radio_5g_util: number | null;
}

interface Controller {
  id: number;
  name: string;
  vendor: string;
  controller_url: string | null;
  api_username: string | null;
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
  capabilities_probed_at?: string | null;
  has_capabilities?: boolean;
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
  ap_disconnects_24h: number | null;
  last_polled_at: string | null;
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
  snmp_device_id: number | null;
  site_id: number | null;
  site_name: string | null;
}

type TabKey = 'overview' | 'aps' | 'ssids' | 'intelligence' | 'clients' | 'controllers';

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
  connected_since: string | null;
  last_seen_at: string | null;
  auth_type: string | null;
  is_problem: boolean;
  roaming_count: number;
  vendor: string;
  signal_quality: string;
  controller_name: string | null;
  site_name: string | null;
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

interface ClientSummary {
  total_clients: number;
  by_band: Record<string, number>;
  by_controller: { name: string; count: number }[];
  problem_clients: number;
  low_signal_clients: number;
  frequent_roamers: number;
  top_aps_by_clients: { ap_name: string; count: number }[];
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
  high_util_ap_count: number;
  critical_util_count: number;
  capacity_score: number;
  overall_score: number;
  overall_grade: string;
  recommendations: Recommendation[];
}

// ── Formatting / RF helpers (top-level) ───────────────────────
function fmtBytes(n: number | null): string {
  if (n == null || isNaN(n)) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const neg = n < 0;
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${neg ? '-' : ''}${v.toFixed(1)} ${units[i]}`;
}

function fmtBps(n: number | null): string {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) < 1e6) return `${(n / 1e3).toFixed(1)} Kbps`;
  return `${(n / 1e6).toFixed(1)} Mbps`;
}

function noiseBadge(dbm: number | null): { label: string; color: string } {
  if (dbm == null || isNaN(dbm)) return { label: '—', color: 'var(--text-muted)' };
  if (dbm <= -85) return { label: 'Excellent', color: 'var(--green)' };
  if (dbm <= -75) return { label: 'Fair', color: 'var(--yellow)' };
  return { label: 'Poor', color: 'var(--red)' };
}

function failureRate(ok: number, fail: number): number {
  const denom = ok + fail;
  if (denom <= 0) return 0;
  return (fail / denom) * 100;
}

function failureRateColor(pct: number): string {
  if (pct < 1) return 'var(--green)';
  if (pct <= 5) return 'var(--yellow)';
  return 'var(--red)';
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
  'hpe', 'grandstream', 'ubiquiti', 'omada',
];

const CHART_COLORS = {
  total: 'var(--primary)',
  g2: '#0ea5e9',
  g5: '#16a34a',
};

// ════════════════════════════════════════════════════════════
// Page
// ════════════════════════════════════════════════════════════

export default function WirelessPage() {
  const [tab, setTab] = useState<TabKey>('overview');
  const [siteFilter, setSiteFilter] = useState<number | null>(null);
  const [controllerFilter, setControllerFilter] = useState<number | null>(null);
  const [clientApFilter, setClientApFilter] = useState<number | null>(null);
  const [clientProblemOnly, setClientProblemOnly] = useState(false);

  function gotoApsForSite(siteId: number | null) {
    setSiteFilter(siteId);
    setControllerFilter(null);
    setTab('aps');
  }

  function gotoApsForController(controllerId: number | null) {
    setControllerFilter(controllerId);
    setSiteFilter(null);
    setTab('aps');
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
      <h1 className="sv-page-title" style={{ margin: 0 }}>Wireless</h1>
      <p className="sv-page-sub">Access points and wireless controllers.</p>

      <div className="sv-tabs">
        <button
          className={`sv-tab ${tab === 'overview' ? 'active' : ''}`}
          onClick={() => setTab('overview')}
        >Overview</button>
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
          className={`sv-tab ${tab === 'controllers' ? 'active' : ''}`}
          onClick={() => setTab('controllers')}
        >Controllers</button>
      </div>

      {tab === 'overview' && <OverviewTab onSelectSite={gotoApsForSite} onViewIntelligence={gotoIntelligence} onViewProblemClients={gotoProblemClients} />}
      {tab === 'aps' && (
        <AccessPointsTab
          siteFilter={siteFilter}
          setSiteFilter={setSiteFilter}
          controllerFilter={controllerFilter}
          setControllerFilter={setControllerFilter}
          onFilterController={gotoApsForController}
        />
      )}
      {tab === 'ssids' && <SsidsTab />}
      {tab === 'intelligence' && <IntelligenceTab onViewApClients={gotoClientsForAp} />}
      {tab === 'clients' && (
        <ClientsTab
          apFilter={clientApFilter}
          setApFilter={setClientApFilter}
          problemOnly={clientProblemOnly}
          setProblemOnly={setClientProblemOnly}
        />
      )}
      {tab === 'controllers' && <ControllersTab onViewEvents={() => setTab('clients')} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB 1 — Overview
// ════════════════════════════════════════════════════════════

// Compact Wireless Intelligence summary card, shown at the top of the Overview
// tab. Hidden until intelligence has been computed for at least one controller.
function WirelessIntelCard({ onView }: { onView: () => void }) {
  const summary = useApi<IntelSummary>('/api/wireless/intelligence/summary', 30000);
  const list = useApi<IntelRow[]>('/api/wireless/intelligence', 30000);
  const s = summary.data;
  if (!s || !s.controllers || s.controllers.length === 0) return null;

  const score = Number(s.overall_score);
  const lastAnalyzed = (list.data || []).reduce<string | null>((max, r) => {
    if (!r.computed_at) return max;
    return !max || r.computed_at > max ? r.computed_at : max;
  }, null);

  return (
    <div
      className="sv-card"
      style={{
        borderLeftColor: scoreColor(score), marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
      }}
    >
      <div>
        <div style={{
          fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase',
          letterSpacing: 0.4, fontWeight: 700,
        }}>Wireless Intelligence</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: scoreColor(score) }}>
          {score}/100 <span style={{ fontSize: 18 }}>{s.overall_grade}</span>
        </div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        {s.total_recommendations} recommendation{s.total_recommendations === 1 ? '' : 's'} pending
        {s.critical_count > 0 && (
          <span style={{ color: 'var(--red)', fontWeight: 700 }}> · {s.critical_count} critical</span>
        )}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
          Last analyzed {fmtRel(lastAnalyzed)}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <button className="sv-btn ghost sm" onClick={onView}>View Intelligence →</button>
    </div>
  );
}

function OverviewTab({
  onSelectSite, onViewIntelligence, onViewProblemClients,
}: {
  onSelectSite: (siteId: number | null) => void;
  onViewIntelligence: () => void;
  onViewProblemClients: () => void;
}) {
  const summary = useApi<WirelessSummary>('/api/wireless/summary', 30000);
  const offline = useApi<AccessPoint[]>('/api/wireless/aps?status=offline', 30000);
  const ssidSummary = useApi<SsidSummary>('/api/wireless/ssids/summary', 30000);
  const clientSummary = useApi<ClientSummary>('/api/wireless/clients/summary', 30000);

  if (summary.loading && !summary.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (summary.error) return <ErrorBox message={summary.error} />;
  if (!summary.data) return <Empty message="No wireless data available." />;

  const s = summary.data;
  const problemClients = clientSummary.data ? Number(clientSummary.data.problem_clients) : 0;

  return (
    <div>
      {problemClients > 0 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            marginBottom: 16, padding: '12px 16px', borderRadius: 8,
            border: '1px solid var(--red)',
            background: 'color-mix(in srgb, var(--red) 10%, transparent)',
            color: 'var(--red)', fontWeight: 600,
          }}
        >
          <span>⚠ {problemClients} client{problemClients === 1 ? '' : 's'} with poor signal or frequent roaming</span>
          <span style={{ flex: 1 }} />
          <button className="sv-btn ghost sm" onClick={onViewProblemClients}>View problem clients →</button>
        </div>
      )}
      <WirelessIntelCard onView={onViewIntelligence} />
      <div className="sv-cards">
        <div className="sv-card total">
          <div className="num">{s.total_aps}</div>
          <div className="label">Total APs</div>
        </div>
        <div className="sv-card up">
          <div className="num" style={{ color: 'var(--green)' }}>{s.online_aps}</div>
          <div className="label">Online</div>
        </div>
        <div className="sv-card down">
          <div className="num" style={{ color: 'var(--red)' }}>{s.offline_aps}</div>
          <div className="label">Offline</div>
        </div>
        <div className="sv-card">
          <div className="num">{s.total_clients}</div>
          <div className="label">Clients</div>
        </div>
        <div className="sv-card">
          <div
            className="num"
            style={{ color: s.auth_failures_total > 0 ? 'var(--red)' : undefined }}
          >{s.auth_failures_total}</div>
          <div className="label">Auth Failures</div>
        </div>
        <div className="sv-card">
          <div className="num" style={{ color: noiseBadge(s.avg_noise_floor).color }}>
            {s.avg_noise_floor ?? '—'} dBm
          </div>
          <div className="label">Avg Noise Floor</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="sv-panel" style={{ flex: '2 1 420px', minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>Site Wireless Health</h3>
          {s.by_site.length ? (
            <table className="sv-table">
              <thead>
                <tr>
                  <th>Site</th><th>APs</th><th>Online</th><th>Clients</th><th>Avg Utilization</th>
                </tr>
              </thead>
              <tbody>
                {s.by_site.map((row: SummarySite) => (
                  <tr
                    key={`${row.site_id ?? 'none'}-${row.site_name}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onSelectSite(row.site_id)}
                    title="View access points for this site"
                  >
                    <td>{row.site_name}</td>
                    <td>{row.aps}</td>
                    <td>{row.online}</td>
                    <td>{row.clients}</td>
                    <td style={{ minWidth: 150 }}><UtilBar pct={row.avg_util ?? 0} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty message="No site data." />}
        </div>

        <div className="sv-panel" style={{ flex: '1 1 280px', minWidth: 240 }}>
          <h3 style={{ marginTop: 0 }}>Offline APs</h3>
          {offline.loading && !offline.data ? (
            <Loading />
          ) : offline.data && offline.data.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {offline.data.map((ap: AccessPoint) => (
                <div key={ap.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 4px', borderBottom: '1px solid var(--border-light)',
                }}>
                  <StatusDot status="down" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{ap.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {ap.site_name || '—'} · last seen {fmtRel(ap.last_seen_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--green)', fontWeight: 600, padding: '8px 0' }}>
              All APs online ✓
            </div>
          )}
        </div>
      </div>

      {s.high_utilization.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 12 }}>High Channel Utilization (&gt;80%)</h3>
          <div className="sv-cards">
            {s.high_utilization.map((ap: HighUtilAp) => (
              <div
                key={ap.id}
                className="sv-card warning"
                style={{ borderLeftColor: pctColor(ap.util_pct) }}
              >
                <div style={{ fontWeight: 700, fontSize: 15 }}>{ap.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {ap.site_name || '—'}
                  {ap.channel != null ? ` · Ch ${ap.channel}` : ''}
                </div>
                <div style={{ marginTop: 8 }}>
                  <UtilBar pct={ap.util_pct} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                  {ap.clients_total} client{ap.clients_total === 1 ? '' : 's'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 4 }}>
                  Consider changing channel or adding an AP.
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sv-panel" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>RF Health by Site</h3>
        {s.rf_by_site && s.rf_by_site.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>Site</th><th>APs</th><th>Avg Noise Floor</th>
                <th>High Util APs</th><th>Avg Retry Rate</th><th>Auth Failures</th>
              </tr>
            </thead>
            <tbody>
              {s.rf_by_site.map((row: RfBySite) => (
                <tr key={row.site_id}>
                  <td>{row.site_name}</td>
                  <td>{row.aps}</td>
                  <td style={{ color: noiseBadge(row.avg_noise_floor).color, fontWeight: 600 }}>
                    {row.avg_noise_floor ?? '—'} dBm
                  </td>
                  <td>{row.high_util_aps}</td>
                  <td>{row.avg_retry_rate ?? '—'}%</td>
                  <td style={{ color: row.auth_failures > 0 ? 'var(--red)' : undefined }}>
                    {row.auth_failures}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty message="No RF site data yet." />}
      </div>

      <div className="sv-panel" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>Top SSIDs by Clients</h3>
        {ssidSummary.loading && !ssidSummary.data ? (
          <Loading />
        ) : ssidSummary.data && ssidSummary.data.top_ssids.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>SSID</th><th>Clients</th><th>Traffic</th><th>Auth Failure Rate</th>
              </tr>
            </thead>
            <tbody>
              {ssidSummary.data.top_ssids.slice(0, 5).map((row: Ssid) => {
                const rate = failureRate(row.auth_successes, row.auth_failures);
                const traffic = (row.bytes_in ?? 0) + (row.bytes_out ?? 0);
                return (
                  <tr key={row.id}>
                    <td style={{ fontWeight: 600 }}>{row.ssid_name}</td>
                    <td>{row.clients_total}</td>
                    <td>{fmtBytes(traffic)}</td>
                    <td style={{ color: failureRateColor(rate), fontWeight: 600 }}>
                      {rate.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <Empty message="No SSID data yet." />}
      </div>
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
      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 12, textAlign: 'center' }}>
        {collapsed ? '▶' : '▼'}
      </span>
      <StatusDot status={online ? 'up' : 'down'} />
      <span style={{ fontWeight: 700 }}>{controller.name}</span>
      <span className="sv-badge">{controller.vendor}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{summary}</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {online ? `polled ${fmtRel(controller.last_polled_at)}` : `last seen ${fmtRel(controller.last_polled_at)}`}
      </span>
    </div>
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

  useEffect(() => { setCollapsed(readCollapsed(controller.id, !online)); }, [controller.id, online]);

  function toggle() {
    setCollapsed((c) => { const n = !c; writeCollapsed(controller.id, n); return n; });
  }

  const clients = aps.reduce((s, a) => s + (a.clients_total || 0), 0);
  const summary = `${aps.length} AP${aps.length === 1 ? '' : 's'} · ${clients} client${clients === 1 ? '' : 's'}`;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return aps;
    return aps.filter((a) => a.name.toLowerCase().includes(q) || (a.ip_address || '').toLowerCase().includes(q));
  }, [aps, search]);

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
                  <th>AP Name</th><th>Site</th><th>Status</th><th>Clients</th>
                  <th>2.4GHz</th><th>5GHz</th><th>Channel Util</th><th>Uptime</th><th>Last Seen</th>
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
                    <td title={`${ap.clients_2g} on 2.4GHz, ${ap.clients_5g} on 5GHz`}>{ap.clients_total}</td>
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
  siteFilter, setSiteFilter, controllerFilter, setControllerFilter, onFilterController,
}: {
  siteFilter: number | null;
  setSiteFilter: (v: number | null) => void;
  controllerFilter: number | null;
  setControllerFilter: (v: number | null) => void;
  onFilterController: (controllerId: number | null) => void;
}) {
  const [status, setStatus] = useState('');
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

  const hasActiveLifted = siteFilter != null || controllerFilter != null;

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
            onClick={() => { setSiteFilter(null); setControllerFilter(null); }}
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

// ── AP detail side drawer (top-level component) ───────────────
function ApDetailDrawer({
  ap, onClose, onFilterController,
}: {
  ap: AccessPoint;
  onClose: () => void;
  onFilterController: (controllerId: number | null) => void;
}) {
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

  return (
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
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
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
            <div style={{ fontSize: 22, fontWeight: 800 }}>{ap.clients_total}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total Clients</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{ap.clients_2g}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>2.4GHz</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{ap.clients_5g}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>5GHz</div>
          </div>
          {ap.clients_6g > 0 && (
            <div>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{ap.clients_6g}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>6GHz</div>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            2.4GHz {ap.radio_2g_channel != null ? `(Ch ${ap.radio_2g_channel}` : '(Ch —'}
            {ap.tx_power_2g != null ? `, ${ap.tx_power_2g} dBm)` : ')'}
          </div>
          <UtilBar pct={ap.radio_2g_util_pct || 0} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
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
            rxErrors={ap.rx_errors_2g}
            txErrors={ap.tx_errors_2g}
          />
          <RadioBandStats
            band="5 GHz"
            noiseFloor={ap.noise_floor_5g}
            utilPct={ap.radio_5g_util_pct}
            retryRate={ap.retry_rate_5g}
            rxErrors={ap.rx_errors_5g}
            txErrors={ap.tx_errors_5g}
          />
        </div>

        <h3 style={{ marginBottom: 6 }}>Throughput</h3>
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{fmtBps(ap.throughput_in_bps)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>In</div>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{fmtBps(ap.throughput_out_bps)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Out</div>
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
                  padding: '6px 0', borderBottom: '1px solid var(--border-light)', fontSize: 13,
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
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                View all {apClients.length} clients
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
            No clients connected
          </div>
        )}

        {err && <ErrorBox message={err} />}
        {loading ? (
          <Loading />
        ) : (
          <>
            <h3 style={{ marginBottom: 6 }}>24h Client Count</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tickFormatter={fmtBucket} fontSize={11} />
                <YAxis fontSize={11} allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="clients_total" name="Total" stroke={CHART_COLORS.total} dot={false} />
                <Line type="monotone" dataKey="clients_2g" name="2.4GHz" stroke={CHART_COLORS.g2} dot={false} />
                <Line type="monotone" dataKey="clients_5g" name="5GHz" stroke={CHART_COLORS.g5} dot={false} />
              </LineChart>
            </ResponsiveContainer>

            <h3 style={{ marginBottom: 6 }}>24h Channel Utilization</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tickFormatter={fmtBucket} fontSize={11} />
                <YAxis fontSize={11} domain={[0, 100]} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="radio_2g_util" name="2.4GHz %" stroke={CHART_COLORS.g2} dot={false} />
                <Line type="monotone" dataKey="radio_5g_util" name="5GHz %" stroke={CHART_COLORS.g5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  );
}

// ── Radio band stats block (top-level component) ──────────────
function RadioBandStats({
  band, noiseFloor, utilPct, retryRate, rxErrors, txErrors,
}: {
  band: string;
  noiseFloor: number | null;
  utilPct: number | null;
  retryRate: number | null;
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
        padding: '3px 0', fontSize: 13,
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Noise Floor</span>
        <span>
          {noiseFloor ?? '—'} dBm{' '}
          <span className="sv-badge" style={{ color: nb.color, borderColor: nb.color }}>
            {nb.label}
          </span>
        </span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '3px 0', fontSize: 13,
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Channel Utilization</span>
        <span>{utilPct ?? '—'}%</span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '3px 0', fontSize: 13,
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Retry Rate</span>
        <span>{retryRate ?? '—'}%</span>
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '3px 0', fontSize: 13,
      }}>
        <span style={{ color: 'var(--text-muted)' }}>Errors</span>
        <span>{rxErrors ?? '—'} RX / {txErrors ?? '—'} TX</span>
      </div>
    </div>
  );
}

function fmtBucket(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ════════════════════════════════════════════════════════════
// TAB 3 — SSIDs
// ════════════════════════════════════════════════════════════

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
                  <th>SSID Name</th><th>Site</th><th>Status</th><th>Clients</th>
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

function SsidsTab() {
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 30000);
  const [controllerFilter, setControllerFilter] = useState<number | null>(null);
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

function prioMeta(p: string): { color: string; dot: string; label: string } {
  switch (p) {
    case 'critical': return { color: 'var(--red)', dot: '🔴', label: 'Critical' };
    case 'high': return { color: 'var(--yellow)', dot: '🟡', label: 'High' };
    case 'medium': return { color: 'var(--yellow)', dot: '🟡', label: 'Medium' };
    case 'low': return { color: 'var(--green)', dot: '🟢', label: 'Low' };
    default: return { color: 'var(--text-muted)', dot: '⚪', label: p || '—' };
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
function ScoreBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', fontSize: 12,
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

// ── Recommendation card (top-level component) ─────────────────
function RecommendationCard({
  rec, onDismiss,
}: {
  rec: Recommendation;
  onDismiss: (rec: Recommendation) => void;
}) {
  const meta = prioMeta(rec.priority);
  const aps = rec.affected_aps || [];
  return (
    <div
      className="sv-panel"
      style={{ borderLeft: `4px solid ${meta.color}`, marginBottom: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          className="sv-badge"
          style={{ color: meta.color, borderColor: meta.color, fontWeight: 700 }}
        >{meta.dot} {meta.label}</span>
        <span className="sv-badge">{rec.category}</span>
        {rec.controller_name && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{rec.controller_name}</span>
        )}
        <span style={{ flex: 1 }} />
        <button className="sv-btn ghost sm" onClick={() => onDismiss(rec)}>Dismiss</button>
      </div>
      <div style={{ fontWeight: 700, marginTop: 8 }}>{rec.issue}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{rec.action}</div>
      {aps.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
          Affected: {aps.slice(0, 3).join(', ')}
          {aps.length > 3 ? ` +${aps.length - 3} more` : ''}
        </div>
      )}
    </div>
  );
}

// ── Per-controller intelligence card (top-level component) ────
function ControllerIntelCard({ row, aps }: { row: IntelRow; aps: AccessPoint[] }) {
  const score = Number(row.overall_score);
  const band5 = Number(row.band_5g_pct);
  const band2 = Number(row.band_2g_pct);
  const ctrlAps = aps.filter((a) => a.controller_id === row.controller_id);
  const apCount = ctrlAps.length;
  const clients = ctrlAps.reduce((s, a) => s + (a.clients_total || 0), 0);

  return (
    <div className="sv-panel" style={{ flex: '1 1 320px', minWidth: 300 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{row.controller_name}</div>
        <span style={{ color: scoreColor(score), fontWeight: 700 }}>
          Overall: {Math.round(score)}/100
        </span>
        <span className="sv-badge" style={{ color: gradeColor(row.overall_grade), borderColor: gradeColor(row.overall_grade) }}>
          {row.overall_grade}
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        <ScoreBar label="Load Balance" value={Number(row.load_balance_score)} />
        <ScoreBar label="Band Steering" value={Number(row.band_steering_score)} />
        <ScoreBar label="Capacity" value={Number(row.capacity_score)} />
        <ScoreBar label="RF Planning" value={100 - Number(row.interference_score)} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.7 }}>
        <div>
          {apCount} APs · {clients} clients · Avg {Number(row.avg_clients_per_ap).toFixed(1)} clients/AP
        </div>
        <div>
          Overloaded: {row.overloaded_aps} | Idle: {row.underloaded_aps}
        </div>
        <div>
          2.4GHz: {Math.round(band2)}% | 5GHz: {Math.round(band5)}%
          {band5 < 60 && (
            <span style={{ color: 'var(--red)' }}> ← below target</span>
          )}
        </div>
        <div>Co-channel affected APs: {row.co_channel_pairs}</div>
      </div>
    </div>
  );
}

// ── Worst-AP drawer loader (top-level component) ──────────────
function IntelApDrawer({ apId, onClose }: { apId: number; onClose: () => void }) {
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
    return (
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
      </div>
    );
  }
  if (!ap) return null;
  return (
    <ApDetailDrawer ap={ap} onClose={onClose} onFilterController={() => {}} />
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
  const capacityAvg = rows.length
    ? rows.reduce((s, r) => s + Number(r.capacity_score), 0) / rows.length
    : 0;
  const rfAvg = rows.length
    ? rows.reduce((s, r) => s + (100 - Number(r.interference_score)), 0) / rows.length
    : 0;

  return (
    <div>
      {/* SECTION 1 — Health overview */}
      <div className="sv-cards">
        <div className="sv-card" style={{ borderLeftColor: scoreColor(overall) }}>
          <div className="num" style={{ color: scoreColor(overall) }}>
            {Math.round(overall)}<span style={{ fontSize: 16, color: 'var(--text-muted)' }}>/100</span>
            {' '}<span style={{ color: gradeColor(summary.overall_grade) }}>{summary.overall_grade}</span>
          </div>
          <div className="label">Wireless Health</div>
        </div>
        <div className="sv-card">
          <div className="num" style={{ color: scoreColor(bandSteer) }}>
            {Math.round(bandSteer)}<span style={{ fontSize: 16, color: 'var(--text-muted)' }}>/100</span>
          </div>
          <div className="label">Band Steering</div>
        </div>
        <div className="sv-card">
          <div className="num" style={{ color: scoreColor(capacityAvg) }}>
            {Math.round(capacityAvg)}<span style={{ fontSize: 16, color: 'var(--text-muted)' }}>/100</span>
          </div>
          <div className="label">Capacity Score</div>
        </div>
        <div className="sv-card">
          <div className="num" style={{ color: scoreColor(rfAvg) }}>
            {Math.round(rfAvg)}<span style={{ fontSize: 16, color: 'var(--text-muted)' }}>/100</span>
          </div>
          <div className="label">RF Planning</div>
        </div>
      </div>

      {/* SECTION 2 — Recommendations */}
      <div style={{ marginTop: 20 }}>
        <h3 style={{ marginBottom: 12 }}>Recommendations</h3>
        {recommendations.length ? (
          recommendations.map((rec, i) => (
            <RecommendationCard key={`${recKey(rec)}-${i}`} rec={rec} onDismiss={handleDismiss} />
          ))
        ) : (
          <div style={{ color: 'var(--green)', fontWeight: 600 }}>
            ✓ No issues detected — wireless looks healthy.
          </div>
        )}
      </div>

      {/* SECTION 3 — Per-controller breakdown */}
      <div style={{ marginTop: 20 }}>
        <h3 style={{ marginBottom: 12 }}>Per-Controller Breakdown</h3>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {rows.map((r) => (
            <ControllerIntelCard key={r.controller_id} row={r} aps={aps} />
          ))}
        </div>
      </div>

      {/* SECTION 4 — APs Needing Attention */}
      <div className="sv-panel" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>APs Needing Attention</h3>
        {summary.worst_aps && summary.worst_aps.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>AP Name</th><th>Score</th><th>Grade</th><th>Load</th><th>Clients</th><th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {summary.worst_aps.map((ap: WorstAp) => {
                const sc = Number(ap.health_score);
                const issues = ap.issues || [];
                const apRow = aps.find((a) => a.id === ap.ap_id);
                return (
                  <tr
                    key={ap.ap_id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setDrawerApId(ap.ap_id)}
                  >
                    <td style={{ fontWeight: 600 }}>{ap.ap_name}</td>
                    <td style={{ color: scoreColor(sc), fontWeight: 600 }}>{Math.round(sc)}</td>
                    <td style={{ color: gradeColor(ap.health_grade), fontWeight: 600 }}>{ap.health_grade}</td>
                    <td>{ap.load_status}</td>
                    <td>
                      {apRow ? apRow.clients_total : '—'}
                      {onViewApClients && (
                        <button
                          className="sv-btn ghost sm"
                          style={{ marginLeft: 8 }}
                          onClick={(e) => { e.stopPropagation(); onViewApClients(ap.ap_id); }}
                        >View clients</button>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {issues.slice(0, 2).join(', ')}
                      {issues.length > 2 ? ` +${issues.length - 2}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <Empty message="No AP health data yet." />}
      </div>

      {/* SECTIONS 5 & 6 — Band distribution + Channel map, side by side */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 20 }}>
        <div className="sv-panel" style={{ flex: 1, minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>2.4GHz vs 5GHz Client Distribution</h3>
          {bandChartData.length ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={bandChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis domain={[0, 100]} fontSize={11} />
                <Tooltip />
                <Legend />
                <ReferenceLine y={60} stroke="var(--red)" strokeDasharray="4 4" label="5GHz target" />
                <Bar dataKey="g2" name="2.4GHz %" fill="#94a3b8" />
                <Bar dataKey="g5" name="5GHz %" fill="#0ea5e9" />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty message="No band distribution data." />}
        </div>

        <div className="sv-panel" style={{ flex: 1, minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>Channel Map</h3>
          {channelChartData.length ? (
            <>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={channelChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" name="APs">
                    {channelChartData.map((c) => (
                      <Cell key={c.ch} fill={c.standard ? 'var(--green)' : '#f97316'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                <span style={{ color: 'var(--green)' }}>■</span> Standard channel ·{' '}
                <span style={{ color: '#f97316' }}>■</span> Non-standard 2.4GHz (not 1/6/11)
              </div>
            </>
          ) : <Empty message="No channel data." />}
        </div>
      </div>

      {drawerApId != null && (
        <IntelApDrawer apId={drawerApId} onClose={() => setDrawerApId(null)} />
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
  if (rssi != null && rssi < -75) {
    return (
      <span className="sv-badge" style={{ color: 'var(--red)', borderColor: 'var(--red)' }}>
        🔴 Low Signal
      </span>
    );
  }
  if (Number(client.roaming_count) > 5) {
    return (
      <span className="sv-badge" style={{ color: 'var(--yellow)', borderColor: 'var(--yellow)' }}>
        🔄 Frequent Roamer
      </span>
    );
  }
  return (
    <span className="sv-badge" style={{ color: 'var(--green)', borderColor: 'var(--green)' }}>
      ✓ Normal
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
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{signalLabel(rssi)}</span>
    </span>
  );
}

// ── One controller's collapsible client group (collapse state shared with ──────
// the APs/SSIDs tabs via the sv-wireless-ctrl-{id}-collapsed localStorage key) ─
function ClientControllerGroup({
  controller, clients, onSelectMac,
}: {
  controller: Controller;
  clients: WirelessClient[];
  onSelectMac: (mac: string) => void;
}) {
  const online = controllerOnline(controller);
  const [collapsed, setCollapsed] = useState<boolean>(false);

  useEffect(() => { setCollapsed(readCollapsed(controller.id, false)); }, [controller.id]);

  function toggle() {
    setCollapsed((c) => { const n = !c; writeCollapsed(controller.id, n); return n; });
  }

  const problems = clients.reduce((s, c) => s + (c.is_problem ? 1 : 0), 0);
  const summary = `${clients.length} client${clients.length === 1 ? '' : 's'}`
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
                <th>MAC</th><th>IP</th><th>AP</th><th>SSID</th><th>Band</th>
                <th>Signal</th><th>Rate</th><th>Connected</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c: WirelessClient) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onSelectMac(c.mac_address)}>
                  <td style={{ fontWeight: 600 }}>{c.mac_address}</td>
                  <td>{c.ip_address || '—'}</td>
                  <td>{c.ap_name || '—'}</td>
                  <td>{c.ssid_name || '—'}</td>
                  <td>{c.band || '—'}</td>
                  <td><SignalCell rssi={c.rssi_dbm} /></td>
                  <td title={c.rx_rate_mbps != null ? `↓ ${fmtRate(c.rx_rate_mbps)}` : undefined}>
                    {fmtRate(c.tx_rate_mbps)}
                  </td>
                  <td>{fmtRel(c.connected_since)}</td>
                  <td><ClientStatusBadge client={c} /></td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const [controllerFilter, setControllerFilter] = useState('');
  const [ssidFilter, setSsidFilter] = useState('');
  const [bandFilter, setBandFilter] = useState('');
  const [selectedMac, setSelectedMac] = useState<string | null>(null);

  const summary = useApi<ClientSummary>('/api/wireless/clients/summary', 30000);
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 30000);

  const qs = useMemo(() => {
    const params: string[] = [];
    if (search.trim()) params.push(`search=${encodeURIComponent(search.trim())}`);
    if (apFilter != null) params.push(`ap_id=${apFilter}`);
    if (problemOnly) params.push('problem=true');
    params.push('limit=200');
    return `?${params.join('&')}`;
  }, [search, apFilter, problemOnly]);

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

  const shown = useMemo(() => {
    return allClients.filter((c) => {
      if (controllerFilter && c.controller_name !== controllerFilter) return false;
      if (ssidFilter && c.ssid_name !== ssidFilter) return false;
      if (bandFilter && c.band !== bandFilter) return false;
      return true;
    });
  }, [allClients, controllerFilter, ssidFilter, bandFilter]);

  // Group the (filtered) clients into collapsible per-controller sections,
  // preserving the API's problem-first / weakest-signal ordering within each.
  const clientGroups = useMemo(
    () => groupByController(shown, controllers.data || []),
    [shown, controllers.data],
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
          style={problemOnly ? { color: 'var(--red)', borderColor: 'var(--red)' } : undefined}
          onClick={() => setProblemOnly(!problemOnly)}
        >⚠ Problem clients only</button>
        {apFilter != null && (
          <span
            className="sv-badge"
            style={{ cursor: 'pointer', color: 'var(--primary)', borderColor: 'var(--primary)' }}
            onClick={() => setApFilter(null)}
          >AP filter active ✕</span>
        )}
      </div>

      {clientsApi.error && <ErrorBox message={clientsApi.error} />}

      {clientsApi.loading && !clientsApi.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : clientGroups.length ? (
        clientGroups.map(({ controller, rows }) => (
          <ClientControllerGroup
            key={controller.id}
            controller={controller}
            clients={rows}
            onSelectMac={setSelectedMac}
          />
        ))
      ) : (
        <Empty message="No clients found." />
      )}

      {selectedMac && (
        <ClientDetailPanel mac={selectedMac} onClose={() => setSelectedMac(null)} />
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
        display: 'flex', justifyContent: 'space-between', fontSize: 11,
        color: 'var(--text-muted)', marginTop: 3,
      }}>
        <span>Poor</span><span>Excellent</span>
      </div>
    </div>
  );
}

// ── Client event row icon/label (top-level helper) ────────────
function clientEventMeta(ev: ClientEvent): { color: string; text: string } {
  switch (ev.event_type) {
    case 'join':
      return { color: 'var(--green)', text: `→ joined ${ev.to_ap_name || '—'}` };
    case 'roam':
      return { color: '#0ea5e9', text: `↔ roamed to ${ev.to_ap_name || '—'}` };
    case 'leave':
      return { color: 'var(--text-muted)', text: `← left ${ev.from_ap_name || '—'}` };
    case 'low_signal':
      return { color: 'var(--yellow)', text: '⚠ low signal' };
    default:
      return { color: 'var(--text-secondary)', text: ev.event_type || '—' };
  }
}

// ── Client detail slide-in panel (top-level component) ────────
function ClientDetailPanel({ mac, onClose }: { mac: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

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

  const c = detail?.client;
  const events = detail?.events || [];
  const stats = detail?.stats;

  return (
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
              <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
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
                        padding: '6px 0', borderBottom: '1px solid var(--border-light)', fontSize: 13,
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
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                No events in last 24h
              </div>
            )}

            {stats && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
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
    </div>
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

function ctlStatusColor(status: string | null | undefined): string {
  if (status === 'ok') return 'var(--green)';
  if (status === 'error') return 'var(--red)';
  return 'var(--text-muted)';
}

const EVENT_META: Record<string, { icon: string; color: string }> = {
  join: { icon: '↑', color: 'var(--green)' },
  leave: { icon: '↓', color: 'var(--text-muted)' },
  low_signal: { icon: '⚠', color: 'var(--orange)' },
  alert: { icon: '●', color: 'var(--red)' },
};

// ── Mini inline progress bar (top-level) ──────────────────────
function MiniBar({ pct, color }: { pct: number | null | undefined; color?: string }) {
  const v = Number(pct);
  const p = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  const c = color || pctColor(p);
  return (
    <div style={{
      width: 56, height: 6, borderRadius: 4, background: 'var(--border)',
      overflow: 'hidden', display: 'inline-block', verticalAlign: 'middle',
    }}>
      <div style={{ width: `${p}%`, height: '100%', background: c }} />
    </div>
  );
}

// ── Aggregate stat card (top-level) ───────────────────────────
function CtlStatCard({ num, sub, label, color }: {
  num: React.ReactNode;
  sub?: React.ReactNode;
  label: string;
  color?: string;
}) {
  return (
    <div className="sv-card" style={color ? { borderLeftColor: color } : undefined}>
      <div className="num" style={color ? { color } : undefined}>{num}</div>
      {sub != null && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      <div className="label">{label}</div>
    </div>
  );
}

// ── Compact controller card (top-level) ───────────────────────
function ControllerCard({
  controller, canEdit, canProbe, onEdit, onTest, onDelete, onProbe,
}: {
  controller: Controller;
  canEdit: boolean;
  canProbe: boolean;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  onProbe: () => Promise<void>;
}) {
  const statusColor = ctlStatusColor(controller.status);
  const [probing, setProbing] = useState(false);
  const isSnmp = controller.snmp_device_id != null;

  async function handleProbe() {
    if (probing) return;
    setProbing(true);
    try { await onProbe(); }
    finally { setProbing(false); }
  }

  return (
    <div className="sv-card" style={{ borderLeftColor: statusColor, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusDot status={controller.status === 'ok' ? 'up' : controller.status === 'error' ? 'down' : 'unknown'} />
        <div style={{ fontWeight: 700, fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {controller.name}
        </div>
        <span className="sv-badge">{controller.vendor}</span>
      </div>
      {controller.model && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{controller.model}</div>
      )}
      <div style={{ display: 'flex', gap: 18, marginTop: 8 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{fmtInt(controller.ap_count)}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>APs</div>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{fmtInt(controller.client_count)}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Clients</div>
        </div>
      </div>
      {isSnmp && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11 }}>
          {probing ? (
            <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="sv-spinner-sm" />Detecting…
            </span>
          ) : controller.has_capabilities ? (
            <>
              <span style={{ color: 'var(--text-muted)' }}>Capabilities detected</span>
              {canProbe && (
                <button
                  className="sv-btn ghost sm"
                  title="Re-detect capabilities"
                  style={{ padding: '0 6px', lineHeight: '18px' }}
                  onClick={handleProbe}
                >↻</button>
              )}
            </>
          ) : (
            <>
              <span style={{ color: 'var(--orange)', fontWeight: 600 }}>⚡ Capabilities not detected</span>
              {canProbe && (
                <button className="sv-btn ghost sm" onClick={handleProbe}>Detect Capabilities</button>
              )}
            </>
          )}
        </div>
      )}
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="sv-btn ghost sm" onClick={onEdit}>Edit</button>
          <button className="sv-btn ghost sm" onClick={onTest}>Test</button>
          <div style={{ flex: 1 }} />
          <button className="sv-btn ghost sm" onClick={onDelete}>Delete</button>
        </div>
      )}
    </div>
  );
}

// ── Controller inventory table (top-level) ────────────────────
function ControllerInventoryTable({ controllers }: { controllers: OverviewController[] }) {
  return (
    <div className="sv-panel" style={{ overflowX: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>Controller Inventory</h3>
      <table className="sv-table">
        <thead>
          <tr>
            <th>Controller</th><th>Site</th><th>Vendor</th><th>Model</th>
            <th>APs</th><th>Cap%</th><th>Clients</th><th>CPU</th><th>Mem</th><th>HA</th><th>Uptime</th>
          </tr>
        </thead>
        <tbody>
          {controllers.map((c) => {
            const hasLic = c.licensed_aps != null && Number(c.licensed_aps) > 0;
            const cap = c.ap_capacity_pct;
            const haMode = c.ha_mode && c.ha_mode !== 'disabled' ? c.ha_mode : null;
            const synced = c.ha_sync_status ? /sync/i.test(c.ha_sync_status) && !/not/i.test(c.ha_sync_status) : null;
            return (
              <tr key={c.id}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <StatusDot status={c.status === 'ok' ? 'up' : c.status === 'error' ? 'down' : 'unknown'} />
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                  </span>
                </td>
                <td>{c.site_name || '—'}</td>
                <td>{c.vendor}</td>
                <td>
                  {c.model ? (
                    <>
                      <div style={{ fontWeight: 600 }}>{c.model}</div>
                      {c.firmware_version && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.firmware_version}</div>
                      )}
                    </>
                  ) : c.vendor}
                </td>
                <td>{fmtInt(c.ap_count)}</td>
                <td>
                  {hasLic ? (
                    <div>
                      <div style={{ fontSize: 12 }}>
                        {fmtInt(c.ap_count)}/{fmtInt(c.licensed_aps)}
                        {cap != null && <span style={{ color: 'var(--text-muted)' }}> ({Math.round(Number(cap))}%)</span>}
                      </div>
                      <MiniBar pct={cap} />
                    </div>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmtInt(c.ap_count)} APs</span>
                  )}
                </td>
                <td>{fmtInt(c.client_count)}</td>
                <td>{c.cpu_pct != null ? `${Math.round(Number(c.cpu_pct))}%` : '—'}</td>
                <td>{c.mem_pct != null ? `${Math.round(Number(c.mem_pct))}%` : '—'}</td>
                <td>
                  {haMode ? (
                    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ color: haMode === 'active' ? 'var(--green)' : 'var(--text-muted)' }}>●</span>
                        {haMode === 'active' ? 'Active' : haMode === 'standby' ? 'Standby' : haMode}
                      </span>
                      {synced != null && (
                        <span style={{ fontSize: 11, color: synced ? 'var(--green)' : 'var(--orange)' }}>
                          {synced ? '✓ Synced' : '⚠ Not synced'}
                        </span>
                      )}
                    </span>
                  ) : <span style={{ color: 'var(--text-muted)' }}>N/A</span>}
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

// ── AP capacity overview chart (top-level) ────────────────────
const CAP_COLORS = ['var(--green)', 'var(--border)'];
function ApCapacityOverview({ controllers }: { controllers: OverviewController[] }) {
  const withLic = controllers.filter((c) => c.licensed_aps != null && Number(c.licensed_aps) > 0);
  if (withLic.length) {
    const usedTotal = withLic.reduce((s, c) => s + Number(c.ap_count || 0), 0);
    const licTotal = withLic.reduce((s, c) => s + Number(c.licensed_aps || 0), 0);
    const available = Math.max(0, licTotal - usedTotal);
    const data = [
      { name: 'Used APs', value: usedTotal },
      { name: 'Available', value: available },
    ];
    return (
      <div className="sv-panel">
        <h3 style={{ marginTop: 0 }}>AP Capacity Overview</h3>
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
              {data.map((_, i) => <Cell key={i} fill={CAP_COLORS[i % CAP_COLORS.length]} />)}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
        <div style={{ textAlign: 'center', fontSize: 14, fontWeight: 700, marginTop: -8 }}>
          {fmtInt(usedTotal)} / {fmtInt(licTotal)} licensed
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>
          Licensed count available for Aruba/Cisco only
        </div>
      </div>
    );
  }
  const barData = controllers.map((c) => ({ name: c.name, aps: Number(c.ap_count || 0) }));
  return (
    <div className="sv-panel">
      <h3 style={{ marginTop: 0 }}>AP Count by Controller</h3>
      {barData.length ? (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={barData} layout="vertical" margin={{ left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" fontSize={11} />
            <YAxis type="category" dataKey="name" width={110} fontSize={11} />
            <Tooltip />
            <Bar dataKey="aps" fill="var(--green)" name="APs" />
          </BarChart>
        </ResponsiveContainer>
      ) : <Empty message="No AP data." />}
    </div>
  );
}

// ── Controller health table (top-level) ───────────────────────
function ControllerHealthTable({ controllers }: { controllers: OverviewController[] }) {
  return (
    <div className="sv-panel" style={{ overflowX: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>Controller Health</h3>
      <table className="sv-table">
        <thead>
          <tr>
            <th>Controller</th><th>Uptime</th><th>CPU</th><th>Mem</th><th>AP Disc (24h)</th><th>Last Polled</th>
          </tr>
        </thead>
        <tbody>
          {controllers.map((c) => {
            const disc = Number(c.ap_disconnects_24h || 0);
            return (
              <tr key={c.id}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <StatusDot status={c.status === 'ok' ? 'up' : c.status === 'error' ? 'down' : 'unknown'} />
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                  </span>
                </td>
                <td>{fmtUptimeShort(c.uptime_seconds)}</td>
                <td>
                  {c.cpu_pct != null ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <MiniBar pct={c.cpu_pct} /> {Math.round(Number(c.cpu_pct))}%
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {c.mem_pct != null ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <MiniBar pct={c.mem_pct} /> {Math.round(Number(c.mem_pct))}%
                    </span>
                  ) : '—'}
                </td>
                <td>
                  {disc > 10 ? (
                    <span className="sv-badge" style={{ background: 'var(--red)', color: '#fff' }}>{disc}</span>
                  ) : (c.ap_disconnects_24h != null ? disc : '—')}
                </td>
                <td>{fmtRel(c.last_polled_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── HA / redundancy status table (top-level) ──────────────────
function HaStatusTable({ controllers }: { controllers: OverviewController[] }) {
  const haCtls = controllers.filter((c) => c.ha_mode && c.ha_mode !== 'disabled');
  return (
    <div className="sv-panel" style={{ overflowX: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>HA / Redundancy Status</h3>
      {haCtls.length ? (
        <table className="sv-table">
          <thead>
            <tr><th>Controller</th><th>Peer</th><th>Mode</th><th>Sync</th><th>Status</th></tr>
          </thead>
          <tbody>
            {haCtls.map((c) => {
              const synced = c.ha_sync_status ? /sync/i.test(c.ha_sync_status) && !/not/i.test(c.ha_sync_status) : null;
              const ready = c.status === 'ok';
              return (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td>{c.ha_peer_ip || '—'}</td>
                  <td>
                    <span style={{ color: c.ha_mode === 'active' ? 'var(--green)' : 'var(--text-muted)' }}>● </span>
                    {c.ha_mode === 'active' ? 'Active' : c.ha_mode === 'standby' ? 'Standby' : c.ha_mode}
                  </td>
                  <td>
                    {synced == null ? '—' : (
                      <span style={{ color: synced ? 'var(--green)' : 'var(--orange)' }}>
                        {synced ? '✓ Synced' : '⚠ Not synced'}
                      </span>
                    )}
                  </td>
                  <td>
                    <span style={{ color: ready ? 'var(--green)' : 'var(--red)' }}>● {ready ? 'Ready' : 'Down'}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <Empty message="No HA configured" />}
    </div>
  );
}

// ── Recent controller events timeline (top-level) ─────────────
function ControllerEventsTimeline({ events, onViewEvents }: {
  events: ControllerEvent[];
  onViewEvents?: () => void;
}) {
  return (
    <div className="sv-panel">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h3 style={{ marginTop: 0, marginBottom: 0, flex: 1 }}>Recent Controller Events</h3>
        {onViewEvents && (
          <button className="sv-btn ghost sm" onClick={onViewEvents}>View all events →</button>
        )}
      </div>
      {events.length ? (
        <div style={{ marginTop: 12 }}>
          {events.map((e, i) => {
            const meta = EVENT_META[e.event_type] || { icon: '•', color: 'var(--text-muted)' };
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0', borderBottom: '1px solid var(--border-light)',
              }}>
                <span style={{ width: 110, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {fmtTime(e.ts)}
                </span>
                <span style={{ color: meta.color, fontWeight: 700, width: 16, textAlign: 'center', flexShrink: 0 }}>
                  {meta.icon}
                </span>
                <span style={{ flex: 1, fontSize: 13 }}>
                  {e.description}
                  {e.ap_name && <span style={{ color: 'var(--text-muted)' }}> · {e.ap_name}</span>}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
                  {e.site_name || ''}
                </span>
              </div>
            );
          })}
        </div>
      ) : <Empty message="No recent controller events." />}
    </div>
  );
}

// ── Controllers tab (top-level) ───────────────────────────────
function ControllersTab({ onViewEvents }: { onViewEvents?: () => void }) {
  const { canEdit, role } = useRbac();
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 0);
  const overview = useApi<ControllerOverview>('/api/wireless/controllers/overview', 30000);
  const events = useApi<ControllerEvent[]>('/api/wireless/controllers/events', 30000);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Controller | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
    if (!confirm(`Delete controller "${c.name}"? This cannot be undone.`)) return;
    await apiSend(`/api/wireless/controllers/${c.id}`, 'DELETE');
    controllers.reload();
    overview.reload();
  }

  async function handleProbe(c: Controller) {
    try {
      await apiSend(`/api/wireless/controllers/${c.id}/probe`, 'POST', {});
      setToast(`✓ ${c.name}: capability probe complete`);
    } catch (e: any) {
      setToast(`✗ ${c.name}: ${e?.message || 'Probe failed'}`);
    }
    setTimeout(() => setToast(null), 6000);
    await controllers.reload();
    overview.reload();
  }

  const canProbe = role === 'admin' || role === 'super_admin';

  const ov = overview.data;
  const ovCtls: OverviewController[] = ov?.controllers || [];
  const siteCount = new Set(ovCtls.map((c) => c.site_name).filter(Boolean)).size;
  const haTotal = ov?.ha_total_count ?? 0;
  const haHealthy = ov?.ha_healthy_count ?? 0;
  const evList: ControllerEvent[] = events.data || [];

  return (
    <div>
      {/* Add controller bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1 }} />
        {canEdit && (
          <button className="sv-btn" onClick={() => { setEditing(null); setShowModal(true); }}>
            + Add Controller
          </button>
        )}
      </div>

      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}
      {controllers.error && <ErrorBox message={controllers.error} />}

      {/* SECTION 0 — Compact controller cards */}
      {controllers.loading && !controllers.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : controllers.data && controllers.data.length ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 12,
        }}>
          {controllers.data.map((c: Controller) => (
            <ControllerCard
              key={c.id}
              controller={c}
              canEdit={canEdit}
              canProbe={canProbe}
              onEdit={() => { setEditing(c); setShowModal(true); }}
              onTest={() => handleTest(c)}
              onDelete={() => handleDelete(c)}
              onProbe={() => handleProbe(c)}
            />
          ))}
        </div>
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No wireless controllers yet — add a wireless controller to get started →" />
        </div>
      )}

      {/* SECTION 1 — Aggregate stat cards */}
      {overview.error && <ErrorBox message={overview.error} />}
      {ov && (
        <div className="sv-cards" style={{ marginTop: 20 }}>
          <CtlStatCard
            num={fmtInt(ov.total_controllers)}
            sub={ov.online_controllers === ov.total_controllers ? 'All Online' : `${fmtInt(ov.online_controllers)} online`}
            label="Controllers"
            color={ov.online_controllers === ov.total_controllers ? 'var(--green)' : 'var(--yellow)'}
          />
          <CtlStatCard num={fmtInt(ov.total_aps)} sub={`${siteCount} Sites`} label="APs Total" />
          <CtlStatCard num={fmtInt(ov.total_clients)} label="Clients" />
          <CtlStatCard num={fmtPct(ov.avg_cpu_pct)} label="Avg CPU" />
          <CtlStatCard num={fmtPct(ov.ap_capacity_pct)} label="AP Capacity" />
          <CtlStatCard
            num={haTotal === 0 ? 'N/A' : (haHealthy === haTotal ? 'Healthy' : `${haHealthy}/${haTotal} Ready`)}
            label="HA Status"
            color={haTotal === 0 ? undefined : (haHealthy === haTotal ? 'var(--green)' : 'var(--yellow)')}
          />
        </div>
      )}

      {overview.loading && !ov ? (
        <div className="sv-panel" style={{ marginTop: 20 }}><Loading /></div>
      ) : ov && ovCtls.length ? (
        <>
          {/* SECTION 2 — Inventory + capacity */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 20, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 60%', minWidth: 360 }}>
              <ControllerInventoryTable controllers={ovCtls} />
            </div>
            <div style={{ flex: '1 1 32%', minWidth: 280 }}>
              <ApCapacityOverview controllers={ovCtls} />
            </div>
          </div>

          {/* SECTION 3 — Health + HA */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 20, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 60%', minWidth: 360 }}>
              <ControllerHealthTable controllers={ovCtls} />
            </div>
            <div style={{ flex: '1 1 32%', minWidth: 280 }}>
              <HaStatusTable controllers={ovCtls} />
            </div>
          </div>
        </>
      ) : null}

      {/* SECTION 4 — Recent controller events */}
      <div style={{ marginTop: 20 }}>
        {events.error && <ErrorBox message={events.error} />}
        {events.loading && !events.data ? (
          <div className="sv-panel"><Loading /></div>
        ) : (
          <ControllerEventsTimeline events={evList} onViewEvents={onViewEvents} />
        )}
      </div>

      {showModal && (
        <ControllerModal
          existing={editing}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); controllers.reload(); overview.reload(); }}
        />
      )}
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
    snmp_device_id: existing?.snmp_device_id ?? null,
    site_id: existing?.site_id ?? null,
    site_name: existing?.site_name ?? null,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function patch(p: Partial<ControllerForm>) {
    setForm((f) => ({ ...f, ...p }));
  }

  async function save() {
    if (!form.name.trim()) { setErr('Name is required'); return; }
    if (form.conn_type === 'snmp' && form.snmp_device_id == null) {
      setErr('Select a monitored device for SNMP'); return;
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
      body.snmp_device_id = form.snmp_device_id;
      body.controller_url = null;
    } else {
      body.snmp_device_id = null;
      body.controller_url = form.controller_url.trim();
      body.api_username = form.api_username.trim() || null;
      if (form.api_password) body.api_password = form.api_password;
      if (form.api_key) body.api_key = form.api_key;
    }
    try {
      if (existing) {
        await apiSend(`/api/wireless/controllers/${existing.id}`, 'PUT', body);
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
              {VENDOR_OPTIONS.map((v: string) => <option key={v} value={v}>{v}</option>)}
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

          {form.conn_type === 'snmp' ? (
            <div className="sv-field" style={{ gridColumn: '1 / -1' }}>
              <span>Monitored device (SNMP)</span>
              <DeviceSelector
                selectedId={form.snmp_device_id}
                onSelect={(id) => patch({ snmp_device_id: id })}
              />
            </div>
          ) : (
            <>
              <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Controller URL
                <input className="sv-input" value={form.controller_url}
                  onChange={(e) => patch({ controller_url: e.target.value })}
                  placeholder="https://wlc.example.local" />
              </label>
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
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
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
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {d.ip_address || '—'}{d.site_name ? ` · ${d.site_name}` : ''}
            </div>
          </div>
        )) : (
          <div style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 13 }}>
            No matching devices.
          </div>
        )}
      </div>
    </div>
  );
}

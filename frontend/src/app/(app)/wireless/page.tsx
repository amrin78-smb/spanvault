'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
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

interface WirelessSummary {
  total_aps: number;
  online_aps: number;
  offline_aps: number;
  total_clients: number;
  by_site: SummarySite[];
  by_controller: SummaryController[];
  high_utilization: HighUtilAp[];
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

type TabKey = 'overview' | 'aps' | 'controllers';

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
          className={`sv-tab ${tab === 'controllers' ? 'active' : ''}`}
          onClick={() => setTab('controllers')}
        >Controllers</button>
      </div>

      {tab === 'overview' && <OverviewTab onSelectSite={gotoApsForSite} />}
      {tab === 'aps' && (
        <AccessPointsTab
          siteFilter={siteFilter}
          setSiteFilter={setSiteFilter}
          controllerFilter={controllerFilter}
          setControllerFilter={setControllerFilter}
          onFilterController={gotoApsForController}
        />
      )}
      {tab === 'controllers' && <ControllersTab />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB 1 — Overview
// ════════════════════════════════════════════════════════════

function OverviewTab({ onSelectSite }: { onSelectSite: (siteId: number | null) => void }) {
  const summary = useApi<WirelessSummary>('/api/wireless/summary', 30000);
  const offline = useApi<AccessPoint[]>('/api/wireless/aps?status=offline', 30000);

  if (summary.loading && !summary.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (summary.error) return <ErrorBox message={summary.error} />;
  if (!summary.data) return <Empty message="No wireless data available." />;

  const s = summary.data;

  return (
    <div>
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
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB 2 — Access Points
// ════════════════════════════════════════════════════════════

function AccessPointsTab({
  siteFilter, setSiteFilter, controllerFilter, setControllerFilter, onFilterController,
}: {
  siteFilter: number | null;
  setSiteFilter: (v: number | null) => void;
  controllerFilter: number | null;
  setControllerFilter: (v: number | null) => void;
  onFilterController: (controllerId: number | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [vendor, setVendor] = useState('');
  const [selectedAp, setSelectedAp] = useState<AccessPoint | null>(null);

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allAps.filter((ap: AccessPoint) => {
      if (vendor && ap.vendor !== vendor) return false;
      if (!q) return true;
      return (
        ap.name.toLowerCase().includes(q) ||
        (ap.ip_address || '').toLowerCase().includes(q)
      );
    });
  }, [allAps, search, vendor]);

  const hasActiveLifted = siteFilter != null || controllerFilter != null;

  return (
    <div>
      <div style={{
        display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14,
      }}>
        <input
          className="sv-input"
          style={{ maxWidth: 240 }}
          placeholder="Search name or IP…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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

      <div className="sv-panel" style={{ padding: 0 }}>
        {aps.loading && !aps.data ? (
          <Loading />
        ) : filtered.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>AP Name</th><th>Controller</th><th>Site</th><th>Status</th>
                <th>Clients</th><th>2.4GHz</th><th>5GHz</th><th>Channel Util</th>
                <th>Uptime</th><th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ap: AccessPoint) => (
                <tr
                  key={ap.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedAp(ap)}
                >
                  <td style={{ fontWeight: 600 }}>{ap.name}</td>
                  <td>{ap.controller_name || '—'}</td>
                  <td>{ap.site_name || '—'}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <StatusDot status={statusToDot(ap.status)} />
                      {ap.status}
                    </span>
                  </td>
                  <td title={`${ap.clients_2g} on 2.4GHz, ${ap.clients_5g} on 5GHz`}>
                    {ap.clients_total}
                  </td>
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
          <Empty message="No access points match the current filters." />
        )}
      </div>

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
            <tr><td style={{ color: 'var(--text-muted)' }}>Uptime</td><td>{ap.uptime_formatted || '—'}</td></tr>
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

function fmtBucket(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ════════════════════════════════════════════════════════════
// TAB 3 — Controllers
// ════════════════════════════════════════════════════════════

function ControllersTab() {
  const { canEdit } = useRbac();
  const controllers = useApi<Controller[]>('/api/wireless/controllers', 0);
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
  }

  return (
    <div>
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

      {controllers.loading && !controllers.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : controllers.data && controllers.data.length ? (
        <div className="sv-cards">
          {controllers.data.map((c: Controller) => (
            <ControllerCard
              key={c.id}
              controller={c}
              canEdit={canEdit}
              onEdit={() => { setEditing(c); setShowModal(true); }}
              onTest={() => handleTest(c)}
              onDelete={() => handleDelete(c)}
            />
          ))}
        </div>
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No wireless controllers configured yet." />
        </div>
      )}

      {showModal && (
        <ControllerModal
          existing={editing}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); controllers.reload(); }}
        />
      )}
    </div>
  );
}

// ── Controller card (top-level component) ─────────────────────
function ControllerCard({
  controller, canEdit, onEdit, onTest, onDelete,
}: {
  controller: Controller;
  canEdit: boolean;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const connType = controller.snmp_device_id != null ? 'SNMP' : 'API';
  const statusColor = controller.status === 'ok'
    ? 'var(--green)'
    : controller.status === 'error'
      ? 'var(--red)'
      : 'var(--text-muted)';
  const statusLabel = controller.status === 'ok'
    ? 'Polling OK'
    : controller.status === 'error'
      ? 'Error'
      : '—';

  return (
    <div className="sv-card" style={{ borderLeftColor: statusColor }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{controller.name}</div>
        <span className="sv-badge">{controller.vendor}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
        {connType} · <span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{controller.ap_count}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>APs</div>
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{controller.client_count}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Clients</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
        {controller.site_name ? `${controller.site_name} · ` : ''}polled {fmtRel(controller.last_polled_at)}
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="sv-btn ghost sm" onClick={onEdit}>Edit</button>
          <button className="sv-btn ghost sm" onClick={onTest}>Test</button>
          <div style={{ flex: 1 }} />
          <button className="sv-btn ghost sm" onClick={onDelete}>Delete</button>
        </div>
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

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { DeviceForm, ImportModal } from '@/components/DeviceModals';
import { StatusBadge, Loading, ErrorBox, Empty, fmtTime, fmtRel } from '@/components/ui';

type Site = { id: number; name: string; code: string | null; city: string | null };
type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
  last_checked_at: string | null; uptime_24h_pct: number | null;
};
type Alert = {
  id: number; device_id: number; device_name: string; ip_address: string;
  alert_type: string; severity: string; message: string; triggered_at: string; status: string;
};

function countByStatus(devices: Device[]) {
  const c = { up: 0, down: 0, warning: 0, unknown: 0 };
  for (const d of devices) {
    const s = (d.current_status || 'unknown').toLowerCase();
    if (s === 'up') c.up++;
    else if (s === 'down') c.down++;
    else if (s === 'warning') c.warning++;
    else c.unknown++;
  }
  return c;
}

function fmtMs(ms: number | null): string {
  return ms != null ? `${Number(ms).toFixed(0)} ms` : '—';
}

function fmtAvail(pct: number | null): string {
  return pct != null ? `${Number(pct).toFixed(1)}%` : '—';
}

// Colour a 24h availability figure: green ≥99%, warning ≥95%, red below.
function availColor(pct: number | null): string {
  if (pct == null) return 'var(--sv-muted)';
  if (pct >= 99) return 'var(--sv-up)';
  if (pct >= 95) return 'var(--sv-warning)';
  return 'var(--sv-down)';
}

// "8 up (80%) · 2 down (20%) · …" — only non-zero categories, percent of total.
function statusSummary(counts: { up: number; down: number; warning: number; unknown: number }, total: number): string {
  if (!total) return 'No devices';
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  const parts: string[] = [];
  if (counts.up) parts.push(`${counts.up} up (${pct(counts.up)})`);
  if (counts.down) parts.push(`${counts.down} down (${pct(counts.down)})`);
  if (counts.warning) parts.push(`${counts.warning} warning (${pct(counts.warning)})`);
  if (counts.unknown) parts.push(`${counts.unknown} unknown (${pct(counts.unknown)})`);
  return parts.join(' · ');
}

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const siteIdNum = parseInt(id, 10);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const sites = useApi<Site[]>('/api/netvault/sites');
  const devices = useApi<Device[]>(`/api/devices?site_id=${id}`, 20000);
  const alerts = useApi<Alert[]>('/api/alerts?status=active&limit=1000', 20000);

  const site = sites.data?.find((s) => String(s.id) === String(id)) || null;
  const deviceList = devices.data || [];
  const deviceIds = new Set(deviceList.map((d) => d.id));
  const siteAlerts = (alerts.data || []).filter((a) => deviceIds.has(a.device_id));
  const counts = countByStatus(deviceList);

  // Fall back to the site name carried on the devices if the site isn't in the active list.
  const siteName = site?.name || deviceList[0]?.site_name || `Site #${id}`;
  const siteCity = site?.city || null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <Link href="/devices" className="sv-btn ghost sm">← Back to Devices</Link>
        <div style={{ flex: 1 }} />
        <button className="sv-btn ghost" onClick={() => setShowImport(true)}>Import from NetVault</button>
        <button className="sv-btn" onClick={() => setShowForm(true)}>+ Add Device</button>
      </div>
      <h1 className="sv-page-title" style={{ marginTop: 12 }}>{siteName}</h1>
      <p className="sv-page-sub">
        {siteCity ? `${siteCity} · ` : ''}{site?.code ? `${site.code} · ` : ''}
        {deviceList.length} {deviceList.length === 1 ? 'device' : 'devices'}
      </p>
      {deviceList.length > 0 && (
        <p className="sv-status-summary">{statusSummary(counts, deviceList.length)}</p>
      )}

      {(sites.error || devices.error) && <ErrorBox message={sites.error || devices.error || ''} />}

      <div className="sv-cards">
        <div className="sv-card total">
          <div className="num">{deviceList.length}</div>
          <div className="label">Total Devices</div>
        </div>
        <div className="sv-card up">
          <div className="num">{counts.up}</div>
          <div className="label">Up</div>
        </div>
        <div className="sv-card down">
          <div className="num">{counts.down}</div>
          <div className="label">Down</div>
        </div>
        <div className="sv-card warning">
          <div className="num">{counts.warning}</div>
          <div className="label">Warning</div>
        </div>
        <div className="sv-card unknown">
          <div className="num">{counts.unknown}</div>
          <div className="label">Unknown</div>
        </div>
      </div>

      <div className="sv-panel" style={{ padding: 0, marginBottom: 22 }}>
        <h2 style={{ padding: '14px 16px 0' }}>Devices</h2>
        {devices.loading && !devices.data ? (
          <Loading />
        ) : deviceList.length ? (
          <>
            <div className="sv-dev-row sv-dev-head">
              <span style={{ width: 11, flex: 'none' }} />
              <span className="sv-dev-id">Device</span>
              <span className="sv-dev-lat">Latency</span>
              <span className="sv-dev-col">Last Poll</span>
              <span className="sv-dev-col">24h Avail.</span>
            </div>
            {deviceList.map((d) => <SiteDeviceRow key={d.id} device={d} />)}
          </>
        ) : (
          <Empty message="No devices monitored at this site." />
        )}
      </div>

      <div className="sv-panel">
        <h2>Active Alerts</h2>
        {alerts.loading && !alerts.data ? (
          <Loading />
        ) : siteAlerts.length ? (
          <table className="sv-table">
            <thead>
              <tr><th>Severity</th><th>Device</th><th>Message</th><th>Triggered</th></tr>
            </thead>
            <tbody>
              {siteAlerts.map((a) => (
                <tr key={a.id}>
                  <td><StatusBadge status={a.severity} /></td>
                  <td>
                    <Link href={`/devices/${a.device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                      {a.device_name || a.ip_address}
                    </Link>
                  </td>
                  <td>{a.message}</td>
                  <td className="sv-muted">{fmtTime(a.triggered_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No active alerts for this site." />
        )}
      </div>

      {showForm && (
        <DeviceForm
          device={null}
          sites={sites.data || []}
          initialSiteId={siteIdNum}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); devices.reload(); }}
        />
      )}
      {showImport && (
        <ImportModal
          siteId={siteIdNum}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); devices.reload(); }}
        />
      )}
    </div>
  );
}

// ── Device row (top-level component, mirrors the devices page style) ──
function SiteDeviceRow({ device }: { device: Device }) {
  return (
    <div className="sv-dev-row">
      <StatusDot status={device.current_status} />
      <div className="sv-dev-id">
        <div className="nm">
          <Link href={`/devices/${device.id}`} style={{ color: 'var(--sv-crimson)' }}>
            {device.name}
          </Link>
        </div>
        <div className="ip">{device.ip_address}{device.device_type ? ` · ${device.device_type}` : ''}</div>
      </div>
      <div className="sv-dev-lat">
        {fmtMs(device.last_response_ms)}
        <div className="sv-muted">{fmtRel(device.last_seen_at)}</div>
      </div>
      <div className="sv-dev-col" title={device.last_checked_at ? fmtTime(device.last_checked_at) : 'Never polled'}>
        {fmtRel(device.last_checked_at)}
      </div>
      <div className="sv-dev-col" style={{ color: availColor(device.uptime_24h_pct), fontWeight: 600 }}>
        {fmtAvail(device.uptime_24h_pct)}
      </div>
    </div>
  );
}

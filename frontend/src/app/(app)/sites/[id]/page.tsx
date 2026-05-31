'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import { StatusBadge, Loading, ErrorBox, Empty, fmtTime, fmtRel } from '@/components/ui';

type Site = { id: number; name: string; code: string | null; city: string | null };
type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
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

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();

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
      <div style={{ marginBottom: 4 }}>
        <Link href="/devices" className="sv-btn ghost sm">← Back to Devices</Link>
      </div>
      <h1 className="sv-page-title" style={{ marginTop: 12 }}>{siteName}</h1>
      <p className="sv-page-sub">
        {siteCity ? `${siteCity} · ` : ''}{site?.code ? `${site.code} · ` : ''}
        {deviceList.length} {deviceList.length === 1 ? 'device' : 'devices'}
      </p>

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
          deviceList.map((d) => <SiteDeviceRow key={d.id} device={d} />)
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
    </div>
  );
}

// ── Device row (top-level component, mirrors the devices page style) ──
function SiteDeviceRow({ device }: { device: Device }) {
  const status = (device.current_status || 'unknown').toLowerCase();
  return (
    <div className="sv-dev-row">
      <span className={`sv-dot ${status}`} title={status} />
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
    </div>
  );
}

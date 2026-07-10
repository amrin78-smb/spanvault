'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { DeviceForm, ImportModal } from '@/components/DeviceModals';
import { StatusBadge, ErrorBox, Empty, fmtTime, fmtRel, PageHeader, TableSkeleton } from '@/components/ui';

type Site = { id: number; name: string; code: string | null; city: string | null };
type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
  last_checked_at: string | null; uptime_24h_pct: number | null;
  is_gateway: boolean; alert_suppressed: boolean;
};
type Alert = {
  id: number; device_id: number; device_name: string; ip_address: string;
  alert_type: string; severity: string; message: string; triggered_at: string; status: string;
  service_check_id?: number | null; service_name?: string | null;
};
type ServiceLite = {
  id: number; name: string; type: string; target: string; site_id: number | null;
  current_status: string; last_response_ms: number | null; last_checked_at: string | null;
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
  if (pct == null) return 'var(--text-muted)';
  if (pct >= 99) return 'var(--green)';
  if (pct >= 95) return 'var(--yellow)';
  return 'var(--red)';
}

// Map a service's current_status to a StatusDot-recognised token.
function svcDotStatus(s: string): string {
  const v = (s || 'unknown').toLowerCase();
  if (v === 'up' || v === 'down' || v === 'warning') return v;
  return 'unknown';
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
  const services = useApi<ServiceLite[]>(`/api/service-checks?site_id=${id}`, 20000);
  const alerts = useApi<Alert[]>('/api/alerts?status=active&limit=1000', 20000);

  const site = sites.data?.find((s) => String(s.id) === String(id)) || null;
  const deviceList = devices.data || [];
  const serviceList = services.data || [];
  const deviceIds = new Set(deviceList.map((d) => d.id));
  const serviceIds = new Set(serviceList.map((s) => s.id));
  // Service-check alerts carry device_id = null and use service_check_id instead —
  // match on either so active service alerts aren't silently dropped from this page.
  const siteAlerts = (alerts.data || []).filter(
    (a) => deviceIds.has(a.device_id) || (a.service_check_id != null && serviceIds.has(a.service_check_id))
  );
  const counts = countByStatus(deviceList);

  // Fall back to the site name carried on the devices if the site isn't in the active list.
  const siteName = site?.name || deviceList[0]?.site_name || `Site #${id}`;
  const siteCity = site?.city || null;
  const deviceCountLabel = `${deviceList.length} ${deviceList.length === 1 ? 'device' : 'devices'}`;
  const serviceCountLabel = serviceList.length
    ? `${serviceList.length} ${serviceList.length === 1 ? 'service' : 'services'}`
    : null;
  const siteSubtitle = [
    siteCity,
    site?.code,
    deviceCountLabel,
    serviceCountLabel,
  ].filter(Boolean).join(' · ');

  const gateway = deviceList.find((d) => d.is_gateway) || null;
  const gatewayDown = !!gateway && gateway.current_status === 'down';
  const suppressedCount = deviceList.filter((d) => d.alert_suppressed).length;

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Link href="/devices" className="sv-btn ghost sm">← Back to Devices</Link>
      </div>
      <PageHeader title={siteName} subtitle={siteSubtitle}>
        <button className="sv-btn ghost" onClick={() => setShowImport(true)}>Import from NetVault</button>
        <button className="sv-btn" onClick={() => setShowForm(true)}>+ Add Device</button>
      </PageHeader>
      {deviceList.length > 0 && (
        <p className="sv-status-summary">{statusSummary(counts, deviceList.length)}</p>
      )}

      {gateway && (
        <p className="sv-gw-current" style={{ marginTop: 4 }}>
          <span className="sv-gw-star">⭐</span> Site gateway:{' '}
          <Link href={`/devices/${gateway.id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
            {gateway.name}
          </Link>
        </p>
      )}

      {gatewayDown && (
        <div className="sv-gw-warn">
          ⚠ Site gateway is DOWN — {suppressedCount} device{suppressedCount === 1 ? '' : 's'} suppressed
        </div>
      )}

      {(sites.error || devices.error || services.error) && (
        <ErrorBox message={sites.error || devices.error || services.error || ''} />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 16 }}>
        <SiteStatCard num={deviceList.length} label="Total Devices" color="var(--text-primary)" />
        <SiteStatCard num={counts.up} label="Up" color="var(--green)" />
        <SiteStatCard num={counts.down} label="Down" color="var(--red)" />
        {counts.warning > 0 && <SiteStatCard num={counts.warning} label="Warning" color="var(--yellow)" />}
        {counts.unknown > 0 && <SiteStatCard num={counts.unknown} label="Unknown" color="var(--text-muted)" />}
      </div>

      <div className="sv-panel" style={{ padding: 0, marginBottom: 22 }}>
        <h2 style={{ padding: '14px 16px 0' }}>Devices</h2>
        {devices.loading && !devices.data ? (
          <TableSkeleton rows={5} cols={5} />
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

      <div className="sv-panel" style={{ padding: 0, marginBottom: 22 }}>
        <h2 style={{ padding: '14px 16px 0' }}>Services</h2>
        {services.loading && !services.data ? (
          <TableSkeleton rows={3} cols={5} />
        ) : serviceList.length ? (
          <>
            <div className="sv-dev-row sv-dev-head">
              <span style={{ width: 11, flex: 'none' }} />
              <span className="sv-dev-id">Service</span>
              <span className="sv-dev-col">Type</span>
              <span className="sv-dev-col">Target</span>
              <span className="sv-dev-lat">Response</span>
              <span className="sv-dev-col">Checked</span>
            </div>
            {serviceList.map((s) => <SiteServiceRow key={s.id} service={s} />)}
          </>
        ) : (
          <Empty message="No service checks configured at this site." />
        )}
      </div>

      <div className="sv-panel">
        <h2>Active Alerts</h2>
        {alerts.loading && !alerts.data ? (
          <TableSkeleton rows={4} cols={4} />
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
                    {a.device_id == null && a.service_name ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Link href={`/services/${a.service_check_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                          {a.service_name}
                        </Link>
                        <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>Service</span>
                      </span>
                    ) : (
                      <Link href={`/devices/${a.device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                        {a.device_name || a.ip_address}
                      </Link>
                    )}
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

// ── Compact KPI stat tile (top-level component, mirrors the dashboard/alerts style) ──
// 3px coloured left border, no shadow, ~74px min-height. The value always uses
// --text-primary; the colour tints only the left border.
function SiteStatCard({ num, label, color }: { num: number; label: string; color: string }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: `3px solid ${color}`,
      borderRadius: 'var(--radius-sm)', padding: '12px 16px', minHeight: 74,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
    }}>
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1 }}>{num}</div>
      <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.04em', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// ── Device row (top-level component, mirrors the devices page style) ──
function SiteDeviceRow({ device }: { device: Device }) {
  return (
    <div className="sv-dev-row">
      {device.alert_suppressed
        ? <span className="sv-badge suppressed" title="Alerts suppressed — site gateway is down">suppressed</span>
        : <StatusDot status={device.current_status} />}
      <div className="sv-dev-id">
        <div className="nm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link href={`/devices/${device.id}`} className="sv-dev-name-link" style={{ color: 'var(--text-primary)' }}>
            {device.name}
          </Link>
          {device.is_gateway && <span className="sv-gw-star" title="Site gateway">⭐</span>}
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

// ── Service row (top-level component, mirrors SiteDeviceRow / the /services page style) ──
// No /services/:id detail route exists yet, so rows link to the /services list page.
function SiteServiceRow({ service }: { service: ServiceLite }) {
  return (
    <div className="sv-dev-row">
      <StatusDot status={svcDotStatus(service.current_status)} title={service.current_status} />
      <div className="sv-dev-id">
        <div className="nm">
          <Link href={`/services/${service.id}`} className="sv-dev-name-link" style={{ color: 'var(--text-primary)' }}>
            {service.name}
          </Link>
        </div>
      </div>
      <div className="sv-dev-col">
        <span className="sv-type-badge">{(service.type || '').toUpperCase()}</span>
      </div>
      <div
        className="sv-dev-col"
        style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={service.target}
      >
        {service.target}
      </div>
      <div className="sv-dev-lat">{fmtMs(service.last_response_ms)}</div>
      <div className="sv-dev-col" title={service.last_checked_at ? fmtTime(service.last_checked_at) : 'Never checked'}>
        {fmtRel(service.last_checked_at)}
      </div>
    </div>
  );
}

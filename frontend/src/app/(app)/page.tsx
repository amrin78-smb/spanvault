'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { StatCard, StatusBadge, Loading, ErrorBox, Empty, fmtRel } from '@/components/ui';

type Summary = {
  total: number; up: number; down: number; warning: number; unknown: number; active_alerts: number;
};
type Alert = {
  id: number; device_id: number; device_name: string; ip_address: string;
  severity: string; alert_type: string; message: string; triggered_at: string; status: string;
};
type MapNode = { id: number; name: string; ip_address: string; device_type: string | null; status: string };
type MapSite = { site_id: number; site_name: string; devices: MapNode[] };

const REFRESH_MS = 30000;

export default function DashboardPage() {
  const summary = useApi<Summary>('/api/dashboard/summary', REFRESH_MS);
  const recent = useApi<Alert[]>('/api/alerts?limit=5', REFRESH_MS);
  const map = useApi<MapSite[]>('/api/map', REFRESH_MS);

  const updatedAt = useUpdatedAt(summary.data);
  const ago = useSecondsAgo(updatedAt);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="sv-page-title">Dashboard</h1>
        <span className="sv-muted" style={{ fontSize: 13 }}>
          {updatedAt ? `Updated ${ago === 0 ? 'just now' : `${ago} second${ago === 1 ? '' : 's'} ago`}` : 'Loading…'}
        </span>
      </div>
      <p className="sv-page-sub">Live network health across all monitored devices.</p>

      {summary.error && <ErrorBox message={summary.error} />}
      {summary.loading && !summary.data ? (
        <Loading />
      ) : summary.data ? (
        <div className="sv-cards">
          <StatCard variant="total" num={summary.data.total} label="Total Devices" />
          <StatCard variant="up" num={summary.data.up} label="Up" />
          <StatCard variant="down" num={summary.data.down} label="Down" />
          <StatCard variant="warning" num={summary.data.warning} label="Warning" />
          <StatCard variant="unknown" num={summary.data.unknown} label="Unknown" />
          <StatCard variant="down" num={summary.data.active_alerts} label="Active Alerts" />
        </div>
      ) : null}

      <div className="sv-panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2>Recent Alerts</h2>
          <Link href="/alerts" className="sv-btn ghost sm">View all</Link>
        </div>
        {recent.loading && !recent.data ? (
          <Loading />
        ) : recent.error ? (
          <ErrorBox message={recent.error} />
        ) : recent.data && recent.data.length ? (
          <div className="sv-feed">
            {recent.data.map((a) => (
              <Link key={a.id} href={`/devices/${a.device_id}`} className="sv-feed-item">
                <StatusBadge status={a.severity} />
                <span className="dev">{a.device_name || a.ip_address || `#${a.device_id}`}</span>
                <span className="msg">{a.message}</span>
                <span className="when sv-muted">{fmtRel(a.triggered_at)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <Empty message="No alerts recorded. All systems nominal." />
        )}
      </div>

      <div className="sv-panel">
        <h2>Site Status Breakdown</h2>
        {map.loading && !map.data ? (
          <Loading />
        ) : map.error ? (
          <ErrorBox message={map.error} />
        ) : map.data && map.data.length ? (
          <table className="sv-table">
            <thead>
              <tr><th>Site</th><th>Devices</th><th>Up</th><th>Down</th><th>Warning</th></tr>
            </thead>
            <tbody>
              {map.data.map((site) => {
                const up = site.devices.filter((d) => d.status === 'up').length;
                const down = site.devices.filter((d) => d.status === 'down').length;
                const warn = site.devices.filter((d) => d.status === 'warning').length;
                return (
                  <tr key={site.site_id}>
                    <td>
                      {site.site_id ? (
                        <Link href={`/sites/${site.site_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                          {site.site_name}
                        </Link>
                      ) : (
                        <span style={{ fontWeight: 600 }}>{site.site_name}</span>
                      )}
                    </td>
                    <td className="sv-muted">{site.devices.length}</td>
                    <td style={{ color: 'var(--sv-up)', fontWeight: 600 }}>{up}</td>
                    <td style={{ color: down ? 'var(--sv-down)' : 'var(--sv-muted)', fontWeight: 600 }}>{down}</td>
                    <td style={{ color: warn ? 'var(--sv-warning)' : 'var(--sv-muted)', fontWeight: 600 }}>{warn}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty message="No monitored devices yet." />
        )}
      </div>
    </div>
  );
}

// ── Hooks (top-level) ──────────────────────────────────────────
function useUpdatedAt(data: unknown): number | null {
  const [ts, setTs] = useState<number | null>(null);
  useEffect(() => {
    if (data) setTs(Date.now());
  }, [data]);
  return ts;
}

function useSecondsAgo(since: number | null): number {
  const [, setTick] = useState(0);
  const sinceRef = useRef(since);
  sinceRef.current = since;
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (since == null) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}

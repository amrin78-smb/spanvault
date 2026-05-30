'use client';

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

export default function DashboardPage() {
  const summary = useApi<Summary>('/api/dashboard/summary', 15000);
  const alerts = useApi<Alert[]>('/api/alerts?status=active&limit=10', 15000);

  return (
    <div>
      <h1 className="sv-page-title">Dashboard</h1>
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
        <h2>Active Alerts</h2>
        {alerts.loading && !alerts.data ? (
          <Loading />
        ) : alerts.error ? (
          <ErrorBox message={alerts.error} />
        ) : alerts.data && alerts.data.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>Severity</th><th>Device</th><th>Message</th><th>Triggered</th><th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.data.map((a) => (
                <tr key={a.id}>
                  <td><StatusBadge status={a.severity} /></td>
                  <td>
                    <Link href={`/devices/${a.device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                      {a.device_name || a.ip_address}
                    </Link>
                  </td>
                  <td>{a.message}</td>
                  <td className="sv-muted">{fmtRel(a.triggered_at)}</td>
                  <td><Link href="/alerts" className="sv-btn ghost sm">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No active alerts. All systems nominal." />
        )}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { StatusBadge, Loading, ErrorBox, Empty, fmtTime } from '@/components/ui';

type Alert = {
  id: number; device_id: number; device_name: string; ip_address: string;
  alert_type: string; severity: string; message: string; metric_value: number | null;
  triggered_at: string; acknowledged_at: string | null; acknowledged_by: string | null;
  resolved_at: string | null; status: string;
};

export default function AlertsPage() {
  const { data: session } = useSession();
  const [status, setStatus] = useState('active');
  const [severity, setSeverity] = useState('');

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (severity) params.set('severity', severity);
  const alerts = useApi<Alert[]>(`/api/alerts?${params.toString()}`, 15000);

  async function ack(a: Alert) {
    await apiSend(`/api/alerts/${a.id}/acknowledge`, 'POST', {
      acknowledged_by: session?.user?.name || session?.user?.email || 'unknown',
    });
    alerts.reload();
  }
  async function resolve(a: Alert) {
    await apiSend(`/api/alerts/${a.id}/resolve`, 'POST', {});
    alerts.reload();
  }

  return (
    <div>
      <h1 className="sv-page-title">Alerts</h1>
      <p className="sv-page-sub">Network alerts raised by the collector.</p>

      <div className="sv-toolbar">
        <select className="sv-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
        <select className="sv-select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
        </select>
      </div>

      {alerts.error && <ErrorBox message={alerts.error} />}
      <div className="sv-panel" style={{ padding: 0 }}>
        {alerts.loading && !alerts.data ? (
          <Loading />
        ) : alerts.data && alerts.data.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>Severity</th><th>Device</th><th>Type</th><th>Message</th>
                <th>Triggered</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.data.map((a) => (
                <tr key={a.id}>
                  <td><StatusBadge status={a.severity} /></td>
                  <td>
                    <Link href={`/devices/${a.device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                      {a.device_name || a.ip_address || `#${a.device_id}`}
                    </Link>
                  </td>
                  <td className="sv-muted">{a.alert_type}</td>
                  <td>{a.message}</td>
                  <td className="sv-muted">{fmtTime(a.triggered_at)}</td>
                  <td><StatusBadge status={a.status} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {a.status === 'active' && (
                      <button className="sv-btn ghost sm" onClick={() => ack(a)}>Acknowledge</button>
                    )}{' '}
                    {a.status !== 'resolved' && (
                      <button className="sv-btn ghost sm" onClick={() => resolve(a)}>Resolve</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No alerts match the current filters." />
        )}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { StatusBadge, ErrorBox, fmtTime, PageHeader, TableSkeleton, EmptyState, useRefreshKey } from '@/components/ui';
import SiteScopeBanner from '@/components/SiteScopeBanner';
import { IconAlerts } from '@/components/icons';

type Alert = {
  id: number; device_id: number; device_name: string; ip_address: string;
  alert_type: string; severity: string; message: string; metric_value: number | null;
  triggered_at: string; acknowledged_at: string | null; acknowledged_by: string | null;
  resolved_at: string | null; status: string;
  suppressed_by: number | null; suppression_reason: string | null; suppressed_by_name: string | null;
};

export default function AlertsPage() {
  const { data: session } = useSession();
  const { canAcknowledgeAlerts } = useRbac();
  const [status, setStatus] = useState('active');
  const [severity, setSeverity] = useState('');

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (severity) params.set('severity', severity);
  const alerts = useApi<Alert[]>(`/api/alerts?${params.toString()}`, 15000);

  useRefreshKey(() => alerts.reload());

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
      <PageHeader title="Alerts" subtitle="Network alerts raised by the collector." />

      <SiteScopeBanner />

      <div className="sv-toolbar">
        <select className="sv-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="suppressed">Suppressed</option>
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
          <TableSkeleton rows={6} cols={7} />
        ) : alerts.data && alerts.data.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>Severity</th><th>Device</th><th>Type</th><th>Message</th>
                <th>Triggered</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.data.map((a) => {
                const suppressed = a.status === 'suppressed';
                return (
                  <tr key={a.id} style={suppressed ? { opacity: 0.6 } : undefined}>
                    <td><StatusBadge status={a.severity} /></td>
                    <td>
                      <Link href={`/devices/${a.device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
                        {a.device_name || a.ip_address || `#${a.device_id}`}
                      </Link>
                    </td>
                    <td className="sv-muted">{a.alert_type}</td>
                    <td>
                      {a.message}
                      {suppressed && (
                        <div className="sv-muted" style={{ fontSize: 12, marginTop: 2 }}>
                          Suppressed{a.suppressed_by_name ? ` — ${a.suppressed_by_name} is down` : (a.suppression_reason ? ` — ${a.suppression_reason}` : '')}
                        </div>
                      )}
                    </td>
                    <td className="sv-muted">{fmtTime(a.triggered_at)}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canAcknowledgeAlerts && a.status === 'active' && (
                        <button className="sv-btn ghost sm" onClick={() => ack(a)}>Acknowledge</button>
                      )}{' '}
                      {canAcknowledgeAlerts && a.status !== 'resolved' && a.status !== 'suppressed' && (
                        <button className="sv-btn ghost sm" onClick={() => resolve(a)}>Resolve</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState
            icon={<IconAlerts width={26} height={26} />}
            title="No alerts"
            message="No alerts match the current filters. Everything looks healthy."
          />
        )}
      </div>
    </div>
  );
}

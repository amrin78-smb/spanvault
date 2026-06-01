'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { StatCard, StatusBadge, Loading, ErrorBox, Empty, fmtRel } from '@/components/ui';
import { IconCheck } from '@/components/icons';

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
  const { data: session } = useSession();
  const ackBy = session?.user?.name || session?.user?.email || 'unknown';

  const summary = useApi<Summary>('/api/dashboard/summary', REFRESH_MS);
  const recent = useApi<Alert[]>('/api/alerts?limit=5', REFRESH_MS);
  const map = useApi<MapSite[]>('/api/map', REFRESH_MS);

  const updatedAt = useUpdatedAt(summary.data);
  const ago = useSecondsAgo(updatedAt);

  // Track alerts acknowledged this session so the row updates immediately,
  // before the next poll refreshes the feed.
  const [acked, setAcked] = useState<Set<number>>(new Set());
  async function ackAlert(id: number) {
    await apiSend(`/api/alerts/${id}/acknowledge`, 'POST', { acknowledged_by: ackBy });
    setAcked((prev) => new Set(prev).add(id));
    summary.reload();
    recent.reload();
  }

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
              <RecentAlertRow
                key={a.id}
                alert={a}
                acked={acked.has(a.id)}
                onAck={ackAlert}
              />
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

// ── Recent-alerts feed row (top-level component) ───────────────
function RecentAlertRow({
  alert, acked, onAck,
}: {
  alert: Alert;
  acked: boolean;
  onAck: (id: number) => Promise<void>;
}) {
  const [acking, setAcking] = useState(false);
  // Treat both server-side and just-acked-this-session as acknowledged.
  const isAcked = acked || alert.status === 'acknowledged';
  const canAck = alert.status === 'active' && !isAcked;

  async function handleAck(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (acking) return;
    setAcking(true);
    try {
      await onAck(alert.id);
    } finally {
      setAcking(false);
    }
  }

  return (
    <div className="sv-feed-item">
      <Link href={`/devices/${alert.device_id}`} className="sv-feed-main">
        <StatusBadge status={alert.severity} />
        <span className="dev">{alert.device_name || alert.ip_address || `#${alert.device_id}`}</span>
        <span className="msg">{alert.message}</span>
        <span className="when sv-muted">{fmtRel(alert.triggered_at)}</span>
      </Link>
      {canAck ? (
        <button className="sv-btn ghost sm" onClick={handleAck} disabled={acking} title="Acknowledge alert">
          {acking ? 'Acking…' : 'Ack'}
        </button>
      ) : isAcked ? (
        <span className="sv-ack-done" title="Acknowledged"><IconCheck width={14} height={14} /> Acked</span>
      ) : null}
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

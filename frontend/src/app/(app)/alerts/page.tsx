'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { StatusBadge, ErrorBox, fmtTime, PageHeader, TableSkeleton, EmptyState, useRefreshKey } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import SiteScopeBanner from '@/components/SiteScopeBanner';
import { IconAlerts } from '@/components/icons';

type Alert = {
  id: number; device_id: number; device_name: string; ip_address: string;
  alert_type: string; severity: string; message: string; metric_value: number | null;
  triggered_at: string; acknowledged_at: string | null; acknowledged_by: string | null;
  resolved_at: string | null; status: string; note: string | null;
  incident_id: number | null; incident_title: string | null;
  suppressed_by: number | null; suppression_reason: string | null; suppressed_by_name: string | null;
};

// Pretty label for an alert_type token (e.g. "high_cpu" → "High Cpu",
// "rule_12" → "Custom Rule"). Shown as a small secondary badge.
function prettyType(t: string): string {
  if (!t) return 'Alert';
  if (/^rule_/.test(t)) return 'Custom Rule';
  if (/^recovery/.test(t)) return 'Recovery';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Quick-filter chips applied client-side over the fetched alert list.
const CHIPS = [
  { key: 'last24h', label: 'Last 24h' },
  { key: 'lastnight', label: 'Last night (8pm–8am)' },
  { key: 'thisweek', label: 'This week' },
  { key: 'critical', label: 'Critical only' },
  { key: 'unack', label: 'Unacknowledged' },
];
function passesChips(a: Alert, active: Set<string>): boolean {
  if (!active.size) return true;
  const t = new Date(a.triggered_at).getTime();
  const now = Date.now();
  if (active.has('last24h') && t < now - 24 * 3600e3) return false;
  if (active.has('thisweek') && t < now - 7 * 24 * 3600e3) return false;
  if (active.has('lastnight')) {
    const h = new Date(a.triggered_at).getHours();
    if (!(h >= 20 || h < 8)) return false;
  }
  if (active.has('critical') && a.severity !== 'critical') return false;
  if (active.has('unack') && a.status !== 'active') return false;
  return true;
}

type Group = { incidentId: number | null; title: string | null; alerts: Alert[] };
function buildGroups(list: Alert[]): Group[] {
  const byInc = new Map<number, Alert[]>();
  const groups: Group[] = [];
  for (const a of list) {
    if (a.incident_id != null) {
      const arr = byInc.get(a.incident_id);
      if (arr) { arr.push(a); }
      else { const fresh: Alert[] = [a]; byInc.set(a.incident_id, fresh); }
    } else {
      groups.push({ incidentId: null, title: null, alerts: [a] });
    }
  }
  for (const [incidentId, alerts] of byInc) {
    groups.push({ incidentId, title: alerts[0].incident_title || `Incident #${incidentId}`, alerts });
  }
  const newest = (g: Group) => Math.max(...g.alerts.map((x) => new Date(x.triggered_at).getTime()));
  groups.sort((a, b) => newest(b) - newest(a));
  return groups;
}
function worstSeverity(alerts: Alert[]): string {
  return alerts.some((a) => a.severity === 'critical') ? 'critical' : 'warning';
}

export default function AlertsPage() {
  const { data: session } = useSession();
  const { canAcknowledgeAlerts } = useRbac();
  const [status, setStatus] = useState('active');
  const [severity, setSeverity] = useState('');
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [ackingId, setAckingId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (severity) params.set('severity', severity);
  const alerts = useApi<Alert[]>(`/api/alerts?${params.toString()}`, 15000);

  useRefreshKey(() => alerts.reload());

  async function ack(a: Alert, note?: string) {
    await apiSend(`/api/alerts/${a.id}/acknowledge`, 'POST', {
      acknowledged_by: session?.user?.name || session?.user?.email || 'unknown',
      note: note || undefined,
    });
    setAckingId(null);
    setNoteText('');
    alerts.reload();
  }
  async function resolve(a: Alert) {
    await apiSend(`/api/alerts/${a.id}/resolve`, 'POST', {});
    alerts.reload();
  }

  function toggleChip(key: string) {
    setChips((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  function toggleIncident(id: number) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const filtered = (alerts.data || []).filter((a) => passesChips(a, chips));
  const groups = buildGroups(filtered);

  // Render the action cell: inline note form while acknowledging, else buttons.
  function actionsCell(a: Alert) {
    if (!canAcknowledgeAlerts) return null;
    if (ackingId === a.id) {
      return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="sv-input sm"
            placeholder="Optional note…"
            autoFocus
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ack(a, noteText); if (e.key === 'Escape') { setAckingId(null); setNoteText(''); } }}
            style={{ width: 160 }}
          />
          <button className="sv-btn sm" onClick={() => ack(a, noteText)}>Confirm</button>
          <button className="sv-btn ghost sm" onClick={() => { setAckingId(null); setNoteText(''); }}>Cancel</button>
        </div>
      );
    }
    return (
      <>
        {a.status === 'active' && (
          <button className="sv-btn ghost sm" onClick={() => { setAckingId(a.id); setNoteText(''); }}>Acknowledge</button>
        )}{' '}
        {a.status !== 'resolved' && a.status !== 'suppressed' && (
          <button className="sv-btn ghost sm" onClick={() => resolve(a)}>Resolve</button>
        )}
      </>
    );
  }

  // Render a single alert as a table row (optionally indented under an incident).
  function alertRow(a: Alert, indent: boolean) {
    const suppressed = a.status === 'suppressed';
    return (
      <tr key={a.id} style={suppressed ? { opacity: 0.6 } : undefined}>
        <td>{indent ? <span style={{ paddingLeft: 18 }}><StatusBadge status={a.severity} /></span> : <StatusBadge status={a.severity} />}</td>
        <td>
          <Link href={`/devices/${a.device_id}`} style={{ color: 'var(--sv-crimson)', fontWeight: 600 }}>
            {a.device_name || a.ip_address || `#${a.device_id}`}
          </Link>
        </td>
        <td>
          <div className="sv-alert-msg">{a.message}</div>
          <span className="sv-type-badge">{prettyType(a.alert_type)}</span>
          {a.note && <div className="sv-alert-note">📝 {a.note}</div>}
          {suppressed && (
            <div className="sv-muted" style={{ fontSize: 12, marginTop: 2 }}>
              Suppressed{a.suppressed_by_name ? ` — ${a.suppressed_by_name} is down` : (a.suppression_reason ? ` — ${a.suppression_reason}` : '')}
            </div>
          )}
        </td>
        <td className="sv-muted">{fmtTime(a.triggered_at)}</td>
        <td><StatusBadge status={a.status} /></td>
        <td style={{ whiteSpace: 'nowrap' }}>{actionsCell(a)}</td>
      </tr>
    );
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

      <div className="sv-chips">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            className={`sv-chip ${chips.has(c.key) ? 'active' : ''}`}
            onClick={() => toggleChip(c.key)}
          >
            {c.label}
          </button>
        ))}
        {chips.size > 0 && (
          <button className="sv-chip clear" onClick={() => setChips(new Set())}>Clear</button>
        )}
      </div>

      {alerts.error && <ErrorBox message={alerts.error} />}
      <div className="sv-panel" style={{ padding: 0 }}>
        {alerts.loading && !alerts.data ? (
          <TableSkeleton rows={6} cols={6} />
        ) : groups.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>Severity</th><th>Device</th><th>Alert</th>
                <th>Triggered</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                // Single-alert groups (incident or standalone) render as one row.
                if (g.incidentId == null || g.alerts.length === 1) {
                  return alertRow(g.alerts[0], false);
                }
                const open = expanded.has(g.incidentId);
                const sev = worstSeverity(g.alerts);
                return (
                  <Fragment key={`incgrp-${g.incidentId}`}>
                    <tr className="sv-incident-head" onClick={() => toggleIncident(g.incidentId!)}>
                      <td colSpan={6}>
                        <span className="sv-incident-toggle">
                          <StatusDot status={sev === 'critical' ? 'down' : 'warning'} size={11} />
                          <span className="sv-incident-title">{g.title}</span>
                          <span className="sv-muted">— {g.alerts.length} alerts</span>
                          <span className="sv-incident-exp">{open ? 'Collapse ▲' : 'Expand ▼'}</span>
                        </span>
                      </td>
                    </tr>
                    {open && g.alerts.map((a) => alertRow(a, true))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState
            icon={<IconAlerts width={26} height={26} />}
            title="All clear ✓"
            message="No alerts in this period. Everything looks healthy."
          />
        )}
      </div>
    </div>
  );
}

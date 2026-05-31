'use client';

import Link from 'next/link';
import { useApi } from '@/lib/api';

type Summary = {
  total: number; up: number; down: number; warning: number; unknown: number; active_alerts: number;
};

/**
 * Persistent network-health banner shown on every app page.
 * Polls the dashboard summary and only renders when something needs attention.
 */
export default function AlertBanner() {
  const summary = useApi<Summary>('/api/dashboard/summary', 30000);
  const s = summary.data;
  if (!s || (s.down === 0 && s.warning === 0)) return null;

  const tone = s.down > 0 ? 'down' : 'warning';
  const parts: string[] = [];
  if (s.down > 0) parts.push(`${s.down} down`);
  if (s.warning > 0) parts.push(`${s.warning} warning`);

  return (
    <Link href="/alerts?status=active" className={`sv-alert-banner ${tone}`}>
      <span className="dot" />
      <strong>{parts.join(' · ')}</strong>
      <span className="msg">— {s.down > 0 ? 'devices unreachable' : 'devices degraded'}. View active alerts →</span>
    </Link>
  );
}

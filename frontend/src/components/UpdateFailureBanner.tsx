'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRbac } from '@/lib/rbac';

interface UpdateStatus {
  exists?: boolean;
  success?: boolean;
  stage?: string | null;
  errorCode?: number;
  errorMessage?: string | null;
  rolledBack?: boolean;
  healthCheckPassed?: boolean;
  timestamp?: string;
}

const DISMISS_KEY_PREFIX = 'sv-update-failure-dismissed-';

const STAGE_LABELS: Record<string, string> = {
  init: 'startup',
  'pre-flight': 'pre-flight snapshot',
  'git-pull': 'pulling code from GitHub',
  'schema-apply': 'applying database schema',
  'npm-install-root': 'installing root dependencies',
  'npm-install-frontend': 'installing frontend dependencies',
  'npm-build': 'building the frontend',
  'service-start': 'starting services',
  'health-check': 'health check after starting',
};

// Surfaces a failed Update-SpanVault.ps1 run (read from
// /api/system/last-update-status, written by the script's Write-StatusJson) as a
// dismissible banner. Admin-only — unlike UpdateNotifier (update-available, shown
// to everyone), this exposes internal operational detail (stage/error code/error
// message) that only an admin/super_admin needs to act on. Role check reuses the
// same useRbac()/canManageSettings check the Settings page itself gates on.
export default function UpdateFailureBanner() {
  const { canManageSettings } = useRbac();
  const [info, setInfo] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!canManageSettings) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/system/last-update-status');
        const data: UpdateStatus = await res.json();
        if (cancelled) return;
        setInfo(data);
        if (data.exists && data.success === false && data.timestamp) {
          try {
            setDismissed(!!sessionStorage.getItem(DISMISS_KEY_PREFIX + data.timestamp));
          } catch {
            setDismissed(false);
          }
        }
      } catch {
        if (!cancelled) setInfo(null);
      }
    };
    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [canManageSettings]);

  const handleDismiss = () => {
    if (info?.timestamp) {
      try { sessionStorage.setItem(DISMISS_KEY_PREFIX + info.timestamp, '1'); } catch {}
    }
    setDismissed(true);
  };

  if (!canManageSettings || !info || !info.exists || info.success !== false || dismissed) return null;

  const stageLabel = info.stage ? (STAGE_LABELS[info.stage] || info.stage) : 'the update';

  return (
    <div style={{
      background: '#b91c1c', color: '#fff', padding: '10px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      width: '100%', fontSize: 'var(--text-base)', flexShrink: 0, zIndex: 91, gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>⚠</span>
        {info.rolledBack ? (
          <span>
            <strong>An update failed</strong> at {stageLabel} and was automatically rolled back — SpanVault is
            running normally on the previous version, but this needs to be fixed
            {info.errorCode ? ` (error code ${info.errorCode})` : ''}.
          </span>
        ) : (
          <span>
            <strong>An update failed</strong> at {stageLabel} and the automatic rollback also failed — SpanVault may be
            DOWN or unstable. Manual intervention required{info.errorCode ? ` (error code ${info.errorCode})` : ''}.
          </span>
        )}
        {info.errorMessage && (
          <span style={{ opacity: 0.85, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>— {info.errorMessage}</span>
        )}
        <span style={{ opacity: 0.7 }}>→</span>
        <Link href="/settings?tab=updates" style={{ color: '#fff', textDecoration: 'underline', whiteSpace: 'nowrap' }}>
          View details
        </Link>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        style={{ background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 'var(--text-lg)', lineHeight: 1, padding: 0, flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  );
}

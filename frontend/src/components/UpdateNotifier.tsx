'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';

interface UpdateInfo {
  available: boolean;
  current?: string;
  latest?: string;
}

const DISMISS_KEY_PREFIX = 'sv-update-dismissed-';
// Kept in sync with settings/page.tsx — fired after a manual "Re-check" so the
// banner refreshes its status without a page reload.
const UPDATE_STATUS_REFRESHED_EVENT = 'sv:update-status-refreshed';

export default function UpdateNotifier() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const mounted = useRef(true);

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/system/update-available');
      const data: UpdateInfo = await res.json();
      if (!mounted.current) return;
      setInfo(data);
      if (data.available && data.latest) {
        try {
          const wasDismissed = sessionStorage.getItem(DISMISS_KEY_PREFIX + data.latest);
          setDismissed(!!wasDismissed);
        } catch {
          setDismissed(false);
        }
      }
    } catch {
      if (mounted.current) setInfo(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    check();
    const interval = setInterval(check, 6 * 60 * 60 * 1000);
    // Refresh immediately when a re-check completes elsewhere in the app.
    window.addEventListener(UPDATE_STATUS_REFRESHED_EVENT, check);

    return () => {
      mounted.current = false;
      clearInterval(interval);
      window.removeEventListener(UPDATE_STATUS_REFRESHED_EVENT, check);
    };
  }, [check]);

  const handleDismiss = () => {
    if (info?.latest) {
      try {
        sessionStorage.setItem(DISMISS_KEY_PREFIX + info.latest, '1');
      } catch {
        /* sessionStorage may be unavailable; dismiss for this session anyway */
      }
    }
    setDismissed(true);
  };

  if (!info || !info.available || dismissed) return null;

  return (
    <div style={{
      background: '#1d4ed8', color: '#fff', padding: '8px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      width: '100%', fontSize: 'var(--text-base)', flexShrink: 0, zIndex: 90,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🔄</span>
        <span>SpanVault v{info.latest} is available</span>
        <span style={{ opacity: 0.7 }}>→</span>
        <Link href="/settings?tab=updates"
          style={{ color: '#fff', textDecoration: 'underline', whiteSpace: 'nowrap' }}>
          Go to Settings
        </Link>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        style={{
          background: 'transparent', color: '#fff', border: 'none',
          cursor: 'pointer', fontSize: 'var(--text-lg)', lineHeight: 1, padding: 0, marginLeft: 16,
        }}
      >
        ×
      </button>
    </div>
  );
}

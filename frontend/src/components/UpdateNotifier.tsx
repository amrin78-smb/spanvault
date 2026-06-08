'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface UpdateInfo {
  available: boolean;
  current?: string;
  latest?: string;
}

const DISMISS_KEY_PREFIX = 'sv-update-dismissed-';

export default function UpdateNotifier() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/api/system/update-available');
        const data: UpdateInfo = await res.json();
        if (cancelled) return;
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
        if (!cancelled) setInfo(null);
      }
    };

    check();
    const interval = setInterval(check, 6 * 60 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
      width: '100%', fontSize: 13, flexShrink: 0, zIndex: 90,
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
          cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0, marginLeft: 16,
        }}
      >
        ×
      </button>
    </div>
  );
}

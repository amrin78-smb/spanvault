'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useApi } from '@/lib/api';
import { IconHome, IconLogout, IconBell } from './icons';
import TopBarSearch from './TopBarSearch';
import ThemeToggle from './ThemeToggle';

// Hub URL — derived from the current page's own hostname (so it keeps working
// if the suite is later accessed via a local-DNS hostname instead of the
// install-time server IP), falling back to the baked-in env var during SSR
// (window is unavailable server-side; this component's hub links only ever
// render after the user opens the menu, i.e. client-side, so there is no
// hydration mismatch in practice).
function getHubUrl(): string {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  return process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
}

type Summary = {
  total: number; up: number; down: number; warning: number; unknown: number; active_alerts: number;
};

export default function TopBar() {
  const HUB = getHubUrl();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const collector = useApi<{ status: string }>('/api/collector/status', 30000);
  const collectorRunning = collector.data?.status === 'running';

  // Unacknowledged alert count drives the notifications bell badge.
  const summary = useApi<Summary>('/api/dashboard/summary', 30000);
  const alertCount = summary.data?.active_alerts ?? 0;

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const user = session?.user as any;
  const role = user?.role || '';
  // Avatar initials: up to two from the name's words, else the email's first
  // letter, else "U".
  const initials = user?.name
    ? user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : (user?.email?.[0] || 'U').toUpperCase();
  // Label shown next to the avatar: name, else the email local-part.
  const displayName = user?.name || user?.email?.split('@')[0] || '';

  // Suite-standard sign-out: clear the next-auth session via the CSRF-protected
  // signout endpoint, then hard-redirect to the hub launcher. Avoids next-auth's
  // signOut() which appends a callbackUrl back to SpanVault.
  const handleSignOut = async () => {
    try {
      const res = await fetch('/api/auth/csrf');
      const { csrfToken } = await res.json();
      await fetch('/api/auth/signout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrfToken, json: 'true' }),
      });
    } catch {
      /* ignore — still redirect to the hub */
    }
    window.location.replace(`${HUB}/launcher`);
  };

  return (
    <header className="sv-topbar">
      <button
        type="button"
        className="sv-icon-btn sv-hamburger"
        aria-label="Open navigation menu"
        title="Menu"
        onClick={() => window.dispatchEvent(new Event('spanvault:toggle-sidebar'))}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <div className="sv-topbar-brand">
        <img className="sv-logo" src="/spanvault-logo.svg" alt="SpanVault" />
        <span className="sv-topbar-divider" />
        <span className="sv-topbar-subtitle">Network Monitoring</span>
      </div>

      <div className="sv-topbar-left">
        <TopBarSearch />
      </div>

      <div className="sv-topbar-right">
        <Link
          className="sv-icon-btn"
          href="/alerts?status=active"
          title={alertCount > 0 ? `${alertCount} active alert${alertCount === 1 ? '' : 's'}` : 'No active alerts'}
          aria-label="Notifications"
        >
          <IconBell width={18} height={18} />
          {alertCount > 0 && (
            <span className="sv-icon-badge">{alertCount > 99 ? '99+' : alertCount}</span>
          )}
        </Link>

        <ThemeToggle />

        <span
          className={`sv-collector-pill ${collectorRunning ? 'running' : 'stopped'}`}
          title={collectorRunning ? 'Collector is running' : 'Collector is not running'}
        >
          <span className="dot" />
          COLLECTOR
        </span>

        <div className="sv-user" ref={ref}>
          <button className="sv-user-btn" onClick={() => setOpen((o) => !o)} title={displayName}>
            <div className="sv-avatar">{initials}</div>
            <div className="sv-user-meta">
              <span className="sv-user-name">{displayName}</span>
              {role && <span className="sv-user-role">{role}</span>}
            </div>
          </button>
          {open && (
            <div className="sv-dropdown">
              <div className="who">
                <strong>{displayName}</strong>
                {user?.email && <span>{user.email}</span>}
                {role && <span style={{ textTransform: 'capitalize' }}>{role}</span>}
              </div>
              <a className="sv-dropdown-item" href={`${HUB}/launcher`}>
                <IconHome width={16} height={16} />
                NocVault Hub
              </a>
              <ThemeToggle variant="item" />
              <div className="sv-dropdown-divider" />
              <button className="sv-dropdown-item danger" onClick={handleSignOut}>
                <IconLogout width={16} height={16} />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

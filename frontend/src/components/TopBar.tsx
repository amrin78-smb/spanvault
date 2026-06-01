'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useApi } from '@/lib/api';
import { IconHome, IconLogout } from './icons';

const HUB = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

export default function TopBar() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const collector = useApi<{ status: string }>('/api/collector/status', 30000);
  const collectorRunning = collector.data?.status === 'running';

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const name = session?.user?.name || session?.user?.email || 'User';
  const role = (session?.user as any)?.role || '';
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  function handleSignOut() {
    signOut({ redirect: false }).then(() => {
      window.location.href = `${HUB}/launcher`;
    });
  }

  return (
    <header className="sv-topbar">
      <div className="sv-topbar-left" />
      <div className="sv-topbar-right">
        <span className={`sv-collector-pill ${collectorRunning ? 'running' : 'stopped'}`}>
          ● COLLECTOR
        </span>
        <div className="sv-user" ref={ref}>
        <button className="sv-user-btn" onClick={() => setOpen((o) => !o)} title={name}>
          <div className="sv-avatar">{initials || 'U'}</div>
          <div className="sv-user-meta">
            <span className="sv-user-name">{name}</span>
            {role && <span className="sv-user-role">{role}</span>}
          </div>
        </button>
        {open && (
          <div className="sv-dropdown">
            <div className="who">
              <strong>{name}</strong>
              {role && <span>{role}</span>}
            </div>
            <a className="sv-dropdown-item" href={`${HUB}/launcher`}>
              <IconHome width={16} height={16} />
              NocVault Hub
            </a>
            <button className="sv-dropdown-item" onClick={handleSignOut}>
              <IconLogout width={16} height={16} />
              Sign out
            </button>
          </div>
        )}
        </div>
      </div>
    </header>
  );
}

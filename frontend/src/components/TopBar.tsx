'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useApi } from '@/lib/api';
import { IconHome, IconLogout } from './icons';
import TopBarSearch from './TopBarSearch';

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

  const userName = session?.user?.name;
  const userEmail = session?.user?.email;
  const role = (session?.user as any)?.role || '';
  // Label shown next to the avatar: name, else the email local-part.
  // Never fall back to the generic "User" placeholder.
  const displayName = userName || (userEmail ? userEmail.split('@')[0] : '');
  // Avatar initial priority: name → email local-part (before @) → "U".
  const initialSource = userName || (userEmail ? userEmail.split('@')[0] : '');
  const avatarInitial = initialSource ? initialSource.trim().charAt(0).toUpperCase() : 'U';

  function handleSignOut() {
    signOut({ redirect: false }).then(() => {
      window.location.href = `${HUB}/launcher`;
    });
  }

  return (
    <header className="sv-topbar">
      <div className="sv-topbar-left">
        <TopBarSearch />
      </div>
      <div className="sv-topbar-right">
        <span className={`sv-collector-pill ${collectorRunning ? 'running' : 'stopped'}`}>
          ● COLLECTOR
        </span>
        <div className="sv-user" ref={ref}>
        <button className="sv-user-btn" onClick={() => setOpen((o) => !o)} title={displayName}>
          <div className="sv-avatar">{avatarInitial}</div>
          <div className="sv-user-meta">
            <span className="sv-user-name">{displayName}</span>
            {role && <span className="sv-user-role">{role}</span>}
          </div>
        </button>
        {open && (
          <div className="sv-dropdown">
            <div className="who">
              <strong>{displayName}</strong>
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

'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { IconHome } from './icons';

const HUB = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

export default function TopBar() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const name = session?.user?.name || session?.user?.email || 'User';
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
      <a className="home-btn" href={`${HUB}/launcher`} title="NocVault launcher">
        <IconHome />
      </a>
      <div className="sv-user" ref={ref}>
        <div className="sv-avatar" onClick={() => setOpen((o) => !o)} title={name}>
          {initials || 'U'}
        </div>
        {open && (
          <div className="sv-dropdown">
            <div className="who">
              <strong>{name}</strong>
              {session?.user?.email}
              {(session?.user as any)?.role ? ` · ${(session?.user as any).role}` : ''}
            </div>
            <button onClick={handleSignOut}>Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

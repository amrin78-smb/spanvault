'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useRbac } from '@/lib/rbac';
import {
  IconDashboard, IconDevices, IconAlerts, IconReports, IconMap, IconAgents,
  IconIntelligence, IconSettings, IconTopology, IconWireless,
} from './icons';

const NAV = [
  { href: '/', label: 'Dashboard', Icon: IconDashboard, exact: true },
  { href: '/devices', label: 'Devices', Icon: IconDevices },
  { href: '/alerts', label: 'Alerts', Icon: IconAlerts },
  { href: '/reports', label: 'Reports', Icon: IconReports },
  { href: '/maps', label: 'Maps', Icon: IconMap },
  { href: '/wireless', label: 'Wireless', Icon: IconWireless },
  { href: '/topology', label: 'Topology', Icon: IconTopology },
  // Agents + Settings are admin-only — gated below via useRbac.
  { href: '/agents', label: 'Agents', Icon: IconAgents, requires: 'agents' as const },
  { href: '/intelligence', label: 'Intelligence', Icon: IconIntelligence },
  { href: '/settings', label: 'Settings', Icon: IconSettings, requires: 'settings' as const },
];

const COLLAPSE_KEY = 'sv-sidebar-collapsed';

export default function Sidebar() {
  const pathname = usePathname();
  const { canManageAgents, canManageSettings } = useRbac();
  // Manual collapse toggle, persisted to localStorage so it survives refresh.
  const [collapsed, setCollapsed] = useState(false);
  // App version fetched from the API health endpoint on mount.
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'true'); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/health');
        const j = await res.json();
        if (!cancelled) setVersion(j.version);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <aside className={`sv-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sv-nav-label">Navigation</div>
      <nav className="sv-nav">
        {NAV.map(({ href, label, Icon, exact, requires }) => {
          if (requires === 'agents' && !canManageAgents) return null;
          if (requires === 'settings' && !canManageSettings) return null;
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={active ? 'active' : ''} title={collapsed ? label : undefined}>
              <Icon />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <button
        className="sv-collapse-btn"
        onClick={toggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>Collapse</span>
      </button>

      <div className="sv-version">SpanVault{version ? ` v${version}` : ''}</div>
    </aside>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type CSSProperties } from 'react';
import { useRbac } from '@/lib/rbac';
import {
  IconDashboard, IconDevices, IconAlerts, IconReports, IconMap, IconAgents,
  IconIntelligence, IconSettings, IconTopology, IconWireless, IconServices,
} from './icons';

const NAV = [
  { href: '/', label: 'Dashboard', Icon: IconDashboard, exact: true, color: '#f87171', bg: 'rgba(248,113,113,0.22)' },
  { href: '/devices', label: 'Devices', Icon: IconDevices, color: '#60a5fa', bg: 'rgba(96,165,250,0.20)' },
  { href: '/alerts', label: 'Alerts', Icon: IconAlerts, color: '#fbbf24', bg: 'rgba(251,191,36,0.20)' },
  { href: '/services', label: 'Services', Icon: IconServices, color: '#34d399', bg: 'rgba(52,211,153,0.20)' },
  { href: '/reports', label: 'Reports', Icon: IconReports, color: '#f472b6', bg: 'rgba(244,114,182,0.20)' },
  { href: '/maps', label: 'Maps', Icon: IconMap, color: '#2dd4bf', bg: 'rgba(45,212,191,0.20)' },
  { href: '/wireless', label: 'Wireless', Icon: IconWireless, color: '#22d3ee', bg: 'rgba(34,211,238,0.20)' },
  { href: '/topology', label: 'Topology', Icon: IconTopology, color: '#a78bfa', bg: 'rgba(167,139,250,0.20)' },
  // Agents + Settings are admin-only — gated below via useRbac.
  { href: '/agents', label: 'Agents', Icon: IconAgents, requires: 'agents' as const, color: '#fb923c', bg: 'rgba(251,146,60,0.20)' },
  { href: '/intelligence', label: 'Intelligence', Icon: IconIntelligence, color: '#38bdf8', bg: 'rgba(56,189,248,0.20)' },
  { href: '/settings', label: 'Settings', Icon: IconSettings, requires: 'settings' as const, color: '#9ca3af', bg: 'rgba(156,163,175,0.20)' },
];

const COLLAPSE_KEY = 'sv-sidebar-collapsed';

export default function Sidebar() {
  const pathname = usePathname();
  const { canManageAgents, canManageSettings } = useRbac();
  // Manual collapse toggle, persisted to localStorage so it survives refresh.
  const [collapsed, setCollapsed] = useState(false);
  // Off-canvas drawer state for narrow (mobile/tablet) viewports.
  const [mobileOpen, setMobileOpen] = useState(false);
  // App version fetched from the API health endpoint on mount.
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === 'true'); } catch { /* ignore */ }
  }, []);

  // Open/close the mobile drawer from the TopBar hamburger; close on Escape.
  useEffect(() => {
    const toggle = () => setMobileOpen((o) => !o);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false); };
    window.addEventListener('spanvault:toggle-sidebar', toggle);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('spanvault:toggle-sidebar', toggle);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Close the drawer whenever the route changes (a nav item was tapped).
  useEffect(() => { setMobileOpen(false); }, [pathname]);

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
    <>
    <div
      className={`sv-sidebar-backdrop ${mobileOpen ? 'mobile-open' : ''}`}
      onClick={() => setMobileOpen(false)}
      aria-hidden="true"
    />
    <aside className={`sv-sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="sv-nav-label">Navigation</div>
      <nav className="sv-nav">
        {NAV.map(({ href, label, Icon, exact, requires, color, bg }) => {
          if (requires === 'agents' && !canManageAgents) return null;
          if (requires === 'settings' && !canManageSettings) return null;
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={active ? 'active' : ''} title={collapsed ? label : undefined}>
              <span className="sv-nav-chip" style={{ '--chip-color': color, '--chip-bg': bg } as CSSProperties}>
                <Icon />
              </span>
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
    </>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type CSSProperties } from 'react';
import { useRbac } from '@/lib/rbac';
import {
  IconDashboard, IconDevices, IconAlerts, IconReports, IconMap, IconAgents,
  IconIntelligence, IconSettings, IconTopology, IconWireless, IconServices,
} from './icons';

/**
 * Grouped navigation (1.115.0).
 *
 * The flat eleven-item list gave no clue which pages answer "what is wrong now"
 * and which are inventory or administration, so every destination competed
 * equally for attention. The four groups below are the app's actual job stages:
 *
 *   Operate   — what needs attention right now
 *   Inventory — what exists and how it is connected
 *   Analyze   — why, and what is coming
 *   System    — how the product itself is run
 *
 * Every existing route and its order within a group are preserved; nothing was
 * added, removed or renamed, so bookmarks and deep links are unaffected.
 */
type NavItem = {
  href: string;
  label: string;
  Icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element;
  exact?: boolean;
  requires?: 'agents' | 'settings';
  color: string;
  bg: string;
};

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Operate',
    items: [
      { href: '/', label: 'Dashboard', Icon: IconDashboard, exact: true, color: '#f87171', bg: 'rgba(248,113,113,0.22)' },
      { href: '/alerts', label: 'Alerts', Icon: IconAlerts, color: '#fbbf24', bg: 'rgba(251,191,36,0.20)' },
    ],
  },
  {
    title: 'Inventory',
    items: [
      { href: '/devices', label: 'Devices', Icon: IconDevices, color: '#60a5fa', bg: 'rgba(96,165,250,0.20)' },
      { href: '/services', label: 'Services', Icon: IconServices, color: '#34d399', bg: 'rgba(52,211,153,0.20)' },
      { href: '/wireless', label: 'Wireless', Icon: IconWireless, color: '#22d3ee', bg: 'rgba(34,211,238,0.20)' },
      { href: '/maps', label: 'Maps', Icon: IconMap, color: '#2dd4bf', bg: 'rgba(45,212,191,0.20)' },
      { href: '/topology', label: 'Topology', Icon: IconTopology, color: '#a78bfa', bg: 'rgba(167,139,250,0.20)' },
    ],
  },
  {
    title: 'Analyze',
    items: [
      { href: '/intelligence', label: 'Intelligence', Icon: IconIntelligence, color: '#38bdf8', bg: 'rgba(56,189,248,0.20)' },
      { href: '/reports', label: 'Reports', Icon: IconReports, color: '#f472b6', bg: 'rgba(244,114,182,0.20)' },
    ],
  },
  {
    title: 'System',
    items: [
      // Agents + Settings are admin-only — gated below via useRbac.
      { href: '/agents', label: 'Agents', Icon: IconAgents, requires: 'agents', color: '#fb923c', bg: 'rgba(251,146,60,0.20)' },
      { href: '/settings', label: 'Settings', Icon: IconSettings, requires: 'settings', color: '#9ca3af', bg: 'rgba(156,163,175,0.20)' },
    ],
  },
];

// Routes that live under a group member but have no nav row of their own; the
// parent row stays highlighted so the user never loses their place.
const ALIASES: Record<string, string> = { '/sites': '/devices' };

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

  const effective = ALIASES[`/${(pathname || '/').split('/')[1]}`] || pathname;

  return (
    <>
    <div
      className={`sv-sidebar-backdrop ${mobileOpen ? 'mobile-open' : ''}`}
      onClick={() => setMobileOpen(false)}
      aria-hidden="true"
    />
    <aside
      className={`sv-sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}
      aria-label="Main navigation"
    >
      <nav className="sv-nav">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((it) => {
            if (it.requires === 'agents' && !canManageAgents) return false;
            if (it.requires === 'settings' && !canManageSettings) return false;
            return true;
          });
          if (!items.length) return null;
          return (
            <div className="sv-nav-group" key={group.title}>
              {/* Collapsed mode hides the text heading, so the group still has to
                  be legible: a rule separates the groups and the heading stays in
                  the accessibility tree via aria-label on the list. */}
              <div className="sv-nav-label" aria-hidden="true">{group.title}</div>
              <ul className="sv-nav-list" aria-label={group.title}>
                {items.map(({ href, label, Icon, exact, color, bg }) => {
                  const active = exact ? effective === href : (effective || '').startsWith(href);
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        className={active ? 'active' : ''}
                        aria-current={active ? 'page' : undefined}
                        // Always present, not just when collapsed: in icon-only
                        // mode the visible text is display:none, so the link
                        // would otherwise have no accessible name at all.
                        aria-label={label}
                        title={label}
                      >
                        <span className="sv-nav-chip" style={{ '--chip-color': color, '--chip-bg': bg } as CSSProperties}>
                          <Icon />
                        </span>
                        <span>{label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <button
        className="sv-collapse-btn"
        onClick={toggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>Collapse</span>
      </button>

      <div className="sv-version">SpanVault{version ? ` v${version}` : ''}</div>
    </aside>
    </>
  );
}

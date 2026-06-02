'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  IconDashboard, IconDevices, IconAlerts, IconReports, IconMap, IconSettings,
} from './icons';

const NAV = [
  { href: '/', label: 'Dashboard', Icon: IconDashboard, exact: true },
  { href: '/devices', label: 'Devices', Icon: IconDevices },
  { href: '/alerts', label: 'Alerts', Icon: IconAlerts },
  { href: '/reports', label: 'Reports', Icon: IconReports },
  { href: '/maps', label: 'Maps', Icon: IconMap },
  { href: '/settings', label: 'Settings', Icon: IconSettings },
];

const APP_VERSION = 'v1.0';

export default function Sidebar() {
  const pathname = usePathname();
  // Collapse to icon-only on narrow viewports.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1024px)');
    const apply = () => setCollapsed(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return (
    <aside className={`sv-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sv-nav-label">Navigation</div>
      <nav className="sv-nav">
        {NAV.map(({ href, label, Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={active ? 'active' : ''} title={label}>
              <Icon />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sv-version">SpanVault {APP_VERSION}</div>
    </aside>
  );
}

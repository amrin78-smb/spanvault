'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IconDashboard, IconDevices, IconAlerts, IconReports, IconMap, IconSettings,
} from './icons';

const NAV = [
  { href: '/', label: 'Dashboard', Icon: IconDashboard, exact: true },
  { href: '/devices', label: 'Devices', Icon: IconDevices },
  { href: '/alerts', label: 'Alerts', Icon: IconAlerts },
  { href: '/reports', label: 'Reports', Icon: IconReports },
  { href: '/map', label: 'Network Map', Icon: IconMap },
  { href: '/settings', label: 'Settings', Icon: IconSettings },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sv-sidebar">
      <div className="brand">
        <img className="sv-logo" src="/spanvault-logo-white.png" alt="SpanVault" />
        <span className="brand-subtitle">NETWORK MONITORING</span>
      </div>
      <nav className="sv-nav">
        {NAV.map(({ href, label, Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={active ? 'active' : ''}>
              <Icon />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

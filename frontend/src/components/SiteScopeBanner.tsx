'use client';

import { useApi } from '@/lib/api';
import { useRbac } from '@/lib/rbac';

type Site = { id: number; name: string };

/**
 * Subtle info banner shown to site-scoped users (site_admin) at the top of the
 * devices / alerts / reports pages, making it explicit that they are only
 * seeing data for their assigned sites. Renders nothing for unscoped roles.
 */
export default function SiteScopeBanner() {
  const { isSiteScoped, user } = useRbac();
  // Only fetch site names when actually scoped.
  const sites = useApi<Site[]>(isSiteScoped ? '/api/netvault/sites' : null, 0);

  if (!isSiteScoped) return null;

  const names = (sites.data || [])
    .filter((s) => user.sites.includes(s.id))
    .map((s) => s.name);
  const label = names.length
    ? names.join(', ')
    : `${user.sites.length} site${user.sites.length === 1 ? '' : 's'}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        marginBottom: 14,
        borderRadius: 8,
        background: '#eff6ff',
        border: '1px solid #bfdbfe',
        color: '#1e3a5f',
        fontSize: 'var(--text-base)',
      }}
    >
      <span aria-hidden>ℹ</span>
      <span>Showing data for your assigned sites only ({label})</span>
    </div>
  );
}

'use client';

import { useSession } from 'next-auth/react';

/**
 * Shared RBAC utilities for SpanVault.
 *
 * Roles & their permissions:
 *   super_admin / admin — full CRUD on everything, all sites visible.
 *   site_admin          — VIEW ONLY, scoped to their assigned sites.
 *   viewer              — VIEW ONLY, all sites visible (not scoped).
 *
 * super_admin and admin behave identically for every permission check.
 */

export type UserRole = 'super_admin' | 'admin' | 'site_admin' | 'viewer';

export interface RbacUser {
  role: UserRole;
  sites: number[]; // empty = all sites (for admin/viewer)
}

export function canEdit(user: RbacUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin';
}

export function canManageSettings(user: RbacUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin';
}

export function canManageAgents(user: RbacUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin';
}

export function canAcknowledgeAlerts(user: RbacUser): boolean {
  return user.role === 'super_admin' || user.role === 'admin';
}

export function isSiteScoped(user: RbacUser): boolean {
  return user.role === 'site_admin' && user.sites.length > 0;
}

export function canAccessSite(user: RbacUser, siteId: number | null): boolean {
  if (!isSiteScoped(user)) return true; // admin/viewer see all
  if (!siteId) return false;
  return user.sites.includes(siteId);
}

export function getSiteFilter(user: RbacUser): number[] | null {
  // Returns array of allowed site IDs, or null if all sites allowed.
  if (isSiteScoped(user)) return user.sites;
  return null;
}

/**
 * useRbac — resolves the current session into RBAC flags for UI gating.
 * Defaults to the most restrictive role ('viewer') until the session loads.
 */
export function useRbac() {
  const { data: session } = useSession();
  const user: RbacUser = {
    role: ((session?.user as any)?.role as UserRole) || 'viewer',
    sites: ((session?.user as any)?.sites as number[]) || [],
  };
  return {
    user,
    canEdit: canEdit(user),
    canManageSettings: canManageSettings(user),
    canManageAgents: canManageAgents(user),
    canAcknowledgeAlerts: canAcknowledgeAlerts(user),
    isSiteScoped: isSiteScoped(user),
    role: user.role,
  };
}

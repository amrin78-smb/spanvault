/**
 * Canonical destination for every searchable entity.
 *
 * Both searches (the top-bar field and the Ctrl+K palette) used to send an AP,
 * a controller or a client to the bare parent tab — `/wireless?tab=aps` — which
 * drops the user into an unfiltered list of hundreds of rows with no sign of
 * the thing they picked. That reads as a broken result even though the click
 * "worked". Every kind below now resolves to the exact entity's supported
 * detail view, or to its row filtered and highlighted where no detail route
 * exists.
 *
 * The wireless deep-link parameters are the ones `(app)/wireless/page.tsx`
 * actually reads (`tab`, `apId`, `mac`, `controllerId`) — keep the two in step.
 */

export type EntityKind = 'device' | 'ap' | 'controller' | 'service' | 'client' | 'site';

/** Where a given entity opens. `mac` is used for clients, `id` for everything else. */
export function entityHref(kind: EntityKind, id: number | string): string {
  switch (kind) {
    case 'device':     return `/devices/${id}`;
    case 'service':    return `/services/${id}`;
    case 'site':       return `/sites/${id}`;
    case 'ap':         return `/wireless?tab=aps&apId=${id}`;
    case 'controller': return `/wireless?tab=controllers&controllerId=${id}`;
    case 'client':     return `/wireless?tab=clients&mac=${encodeURIComponent(String(id))}`;
    default:           return '/';
  }
}

/**
 * What the destination actually is, in the user's words — shown on the result
 * row so the click is predictable before it happens.
 */
export const ENTITY_DESTINATION: Record<EntityKind, string> = {
  device:     'Device detail',
  service:    'Service check detail',
  site:       'Site detail',
  ap:         'Access point detail',
  controller: 'Controller row',
  client:     'Client detail',
};

/**
 * Pushing `/wireless?tab=…` while ALREADY on /wireless only changes the query
 * string: App Router re-renders without remounting, so the page's mount-time
 * deep-link effect never re-runs and the click looks dead. The page also
 * listens for this event; callers fire it alongside the navigation and the
 * page applies whichever arrives.
 */
export function announceWirelessTarget(href: string): void {
  const m = /^\/wireless\?(.*)$/.exec(href);
  if (!m) return;
  const sp = new URLSearchParams(m[1]);
  const detail: { tab?: string; apId?: number; mac?: string; controllerId?: number } = {};
  const tab = sp.get('tab');
  if (tab) detail.tab = tab;
  const apId = sp.get('apId');
  if (apId && !Number.isNaN(parseInt(apId, 10))) detail.apId = parseInt(apId, 10);
  const ctl = sp.get('controllerId');
  if (ctl && !Number.isNaN(parseInt(ctl, 10))) detail.controllerId = parseInt(ctl, 10);
  const mac = sp.get('mac');
  if (mac) detail.mac = mac;
  window.dispatchEvent(new CustomEvent('spanvault:wireless-tab', { detail }));
}

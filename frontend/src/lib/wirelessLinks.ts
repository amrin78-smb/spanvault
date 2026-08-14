/**
 * Canonical "where does a wireless entity link to" rule.
 *
 * A wireless alert/event carries no `device_id` — it hangs off an AP or a
 * controller instead — so anything rendering its subject as a link has to
 * resolve the target itself. This lived only in `alerts/page.tsx`, and the
 * dashboard's Recent Events widget hardcoded a bare `/wireless`, so clicking an
 * AP name there dropped you on Wireless Insights and left you to find the AP by
 * hand. Same rule, two implementations, one of them wrong — exactly the
 * "fixed the reported instance, missed the sibling" shape this codebase has hit
 * repeatedly. It is defined once here so a third caller cannot diverge again.
 *
 * Takes the two ids rather than a row type because the callers' row shapes
 * differ (`Alert` vs `EventRow`) while the rule does not.
 */
export function wirelessHref(
  wirelessApId?: number | null,
  wirelessControllerId?: number | null,
): string {
  // AP-scoped → deep-link straight into that AP's drawer on the Access Points
  // tab (the page reads ?tab= and ?apId= on mount).
  if (wirelessApId != null) return `/wireless?tab=aps&apId=${wirelessApId}`;
  // Controller-scoped → the Controllers tab. There is no per-controller drawer
  // deep-link today, so the tab is as specific as this can get.
  if (wirelessControllerId != null) return '/wireless?tab=controllers';
  return '/wireless';
}

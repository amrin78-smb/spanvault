/**
 * apiGate.ts — the two pure decisions `middleware.ts` makes about an `/api/*`
 * request before it is proxied to Express.
 *
 * They live here rather than inline in `middleware.ts` so a test can exercise
 * them: `middleware.ts` imports `next/server` and `next-auth/jwt` and runs in
 * the edge runtime, so it cannot be required from a plain Node test script.
 * Regression suite: `node tests/test-rbac-scoping.js`.
 *
 * NOTE: this module must stay dependency-free (no `next/*`, no `next-auth`) or
 * it stops being testable, which is the whole point of it existing.
 */

/**
 * Headers the Express API trusts VERBATIM (`userRank()` / `getSiteFilter()` in
 * api/server.js read them with no further validation), so a client-supplied copy
 * must never survive the proxy.
 *
 * ⛔ The session branch of `middleware.ts` always OVERWRITES all three from the
 * verified token, so it was safe. The PUBLIC branch returned a bare
 * `NextResponse.rewrite(target)` with no `headers` object at all — so on a
 * public path the caller's own `x-user-role` / `x-user-sites` / `x-user-email`
 * reached Express unchanged. It was not exploitable only by accident
 * (`app.param('id')` rejects a non-numeric id, a guard added for NaN 500s), and
 * `api/server.js` already wrote the caller's chosen `x-user-email`/`x-user-role`
 * into the audit_log row for a public-path request. Both siblings delete theirs
 * BEFORE their public branch (logvault/frontend/src/proxy.ts,
 * ddivault/frontend/src/middleware.ts).
 */
export const CLIENT_SPOOFABLE_HEADERS = ['x-user-role', 'x-user-sites', 'x-user-email'];

/** Minimal shape so this is testable without a DOM/edge `Headers`. */
type Deletable = { delete: (name: string) => void };

/** Removes every client-spoofable identity header, in place. Returns `h`. */
export function stripClientIdentity<T extends Deletable>(h: T): T {
  for (const name of CLIENT_SPOOFABLE_HEADERS) h.delete(name);
  return h;
}

/**
 * Routes that must work with NO session, matched EXACTLY and anchored:
 *  - `health`          — suite health/version probe
 *  - `stats`           — three aggregate counts for the NocVault launcher tile
 *  - `sso`             — the SSO-verify proxy; this is the means by which a
 *                        session gets created, so requiring one is impossible.
 *                        Its boundary is the signed one-time token in the body.
 *  - `license-status`  — ⛔ LOAD-BEARING for every unauthenticated page:
 *                        `LicenseProvider` sits in the ROOT layout, so `/sso`
 *                        and `/maps/public/*` fetch it with no session. While
 *                        it was session-gated, the 401 crashed both pages
 *                        outright (measured on production 2026-11-06).
 *
 * ⛔ Do NOT add `/api/system/update-available` or `/api/system/last-update-status`
 * "for consistency with the other suite apps" — their only consumers live in
 * `(app)/layout.tsx` and always have a session, and last-update-status returns
 * commit hashes and raw updater error text. Their absence is deliberate.
 */
const PUBLIC_API_EXACT = /^\/api\/(health|stats|sso|license-status)$/;

/**
 * The one public route with a variable tail: the unauthenticated map share view.
 *
 * ⛔ It cannot be `$`-anchored like the others, which is exactly why it carries a
 * METHOD restriction instead. The old pattern was the bare PREFIX
 * `maps\/public\/` with no method check, so any future route under it — or one
 * keyed on `:uuid` instead of `:id` — would have become an unauthenticated
 * WRITE. The single segment also stops `/api/maps/public/x/y` from matching.
 */
const PUBLIC_API_MAP_SHARE = /^\/api\/maps\/public\/[^/]+$/;
const PUBLIC_API_SAFE_METHODS = ['GET', 'HEAD'];

/** True when this request may be proxied to Express with no session at all. */
export function isPublicApiPath(pathname: string, method: string): boolean {
  if (PUBLIC_API_EXACT.test(pathname)) return true;
  return (
    PUBLIC_API_MAP_SHARE.test(pathname) &&
    PUBLIC_API_SAFE_METHODS.indexOf(String(method || '').toUpperCase()) !== -1
  );
}

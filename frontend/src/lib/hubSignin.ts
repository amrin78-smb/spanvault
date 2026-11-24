import type { NextRequest } from 'next/server'
import { resolveOrigin } from './publicUrl'

// ─────────────────────────────────────────────────────────────────────────────
// Where NextAuth's sign-in redirect actually gets built.
//
// ⛔ `authOptions.pages.signIn` CANNOT BE REQUEST-AWARE. NextAuth v4 evaluates
// the `pages` object ONCE, at module load (core/index.js: `redirect:
// `${pages.signIn}?callbackUrl=…``), so a template string built from
// `process.env.NOCVAULT_HUB_URL` is frozen to whatever that env var held when
// the process started. On a TLS install that value is DELIBERATELY the hub's
// loopback/IP origin (netvault 1.60.1) because server-to-server hub calls must
// NOT go through the public TLS front door — the certificate names the site,
// not the IP, so a fetch through it dies with ERR_TLS_CERT_ALTNAME_INVALID.
// Correct for a `fetch()`, wrong for a browser redirect: measured on
// production, `GET /api/auth/signin` answered
// `302 → http://<server-ip>:3000/login?callbackUrl=https://<server-ip>:3008`,
// sending a browser to a bare IP over plain http, which also trips a cert
// warning. Meanwhile `middleware.ts`'s page gate got the SAME redirect right,
// because middleware runs per request and can call `resolveOrigin()`.
//
// So `pages.signIn` now points at a LOCAL RELATIVE path (`/auth/signin`,
// handled by `app/auth/signin/route.ts`). NextAuth resolves a relative value
// against its own origin, which keeps the browser on SpanVault; that route then
// does the cross-origin hop to the hub per request, via `resolveOrigin`, exactly
// like the page gate. The logic lives here so it is testable without
// `next/server` (tests/test-signin-redirect.js) — the route handler itself is
// three lines.
//
// ⛔ Do NOT "simplify" this back into `pages.signIn`, and do NOT change what
// `NOCVAULT_HUB_URL` means to keep it working: the env var is right for every
// server-side use of it and wrong only here.
//
// ⛔ THE `callbackUrl` IS A CONSTANT, AND MUST STAY ONE. Three separate reasons,
// each sufficient on its own:
//   1. **The hub throws a derived one away.** `net-vault/app/(auth)/login/
//      page.tsx` honours only a same-origin RELATIVE path (`startsWith('/')`,
//      not `//`, not `/sso`, not `/login`) and falls back to `/launcher`
//      otherwise — so an absolute URL re-based on our own origin is work for
//      nothing, and the open-redirect guard it then needs exists only to protect
//      a value that never had to enter the flow.
//   2. **A constant cannot carry a foreign host.** No client input reaches the
//      output, so there is nothing to sanitise and no sanitiser to get wrong.
//      That is a property of the construction, not of a filter.
//   3. **Deriving our OWN origin means deriving our own port, and that is a
//      live trap.** Next.js fills in `x-forwarded-port` with the port it is
//      listening on when the header is absent, so a port-derived own-origin is
//      wrong exactly where it matters (measured in the suite: three repos, three
//      shapes, one of them wrong). A constant path needs no port at all.
//
// `/api/sso/spanvault` is the hub's OWN SSO issuer for this app, and this is
// byte-for-byte the value the hub itself redirects with when that route is hit
// without a session (`net-vault/app/api/sso/spanvault/route.ts`:
// `${ownOrigin}/login?callbackUrl=%2Fapi%2Fsso%2Fspanvault`). So after login the
// hub mints a fresh SSO token and lands the user back on `/sso?token=…` here —
// an actual round trip home.
//
// ⛔ `HUB_CALLBACK_PATH` IS SHARED WITH `middleware.ts` ON PURPOSE — BOTH
// SENDERS, ONE CONSTANT. There are two places that redirect a browser to the
// hub login: this module (NextAuth's `pages.signIn`) and the page gate in
// `middleware.ts`. The gate used to send `callbackUrl=%2Fsso` — a SpanVault
// path, not a hub one — which the hub's filter refuses, silently substituting
// `/launcher`; both were fixed in 1.121.2 and the gate now imports this same
// constant. Keep it that way: two independently-spelled callbackUrls is how one
// of them drifts back to a value the hub quietly throws away, with no error
// anywhere to notice it by. Pinned in `tests/test-signin-redirect.js` section 6.
// ─────────────────────────────────────────────────────────────────────────────

/** Hub (NetVault) port. Same literal every satellite `resolveOrigin` call site
 *  passes — an explicit port wins over the one carried on the request's Host. */
export const HUB_PORT = 3000

/** Where the hub should send the browser once it has a session: its own SSO
 *  issuer for this app. A CONSTANT — never request-derived, never client
 *  input. Relative and same-origin TO THE HUB, which is the only form the hub's
 *  login page honours. */
export const HUB_CALLBACK_PATH = '/api/sso/spanvault'

/** Last-resort hub origin, for a request that carries no usable Host at all —
 *  identical to `middleware.ts`'s `HUB_FALLBACK`. */
export function hubFallback(): string {
  return process.env.NOCVAULT_HUB_URL || 'http://localhost:3000'
}

/**
 * next-auth v4's DEFAULT session-cookie name.
 *
 * SpanVault's `authOptions` (lib/auth.ts) overrides NO `cookies` block, so the
 * library defaults apply: `${cookiePrefix}next-auth.session-token`, with
 * `cookiePrefix = '__Secure-'` when `useSecureCookies`
 * (next-auth/core/lib/cookie.js `defaultCookies()`).
 *
 * ⛔ THE PREFIX IS ONLY IN PLAY BECAUSE THERE IS NO OVERRIDE. next-auth
 * prefixes its DEFAULTS only — `core/init.js` spreads `authOptions.cookies`
 * OVER `defaultCookies(...)`, so a literal `cookies.sessionToken.name` is used
 * verbatim by the writer and read verbatim by `getToken`, and `secure: true`
 * then changes the cookie's FLAGS, never its name. (LogVault does exactly that
 * with `nexvault.session-token`, so the `__Secure-` form is dead there and live
 * here.) `tests/test-signin-redirect.js` asserts lib/auth.ts still has no
 * `cookies:` block, because adding one silently changes which name this reads.
 */
export const SESSION_COOKIE = 'next-auth.session-token'

/**
 * Is there a session cookie on this request AT ALL — readable or not?
 *
 * ⛔ THIS IS NOT `cookies.has(SESSION_COOKIE)`, AND THE DIFFERENCE IS LOAD-
 * BEARING. next-auth SPLITS a session cookie whose VALUE exceeds
 * `CHUNK_SIZE = ALLOWED_COOKIE_SIZE(4096) - ESTIMATED_EMPTY_COOKIE_SIZE(163)`
 * = 3933 bytes into `<name>.0`, `<name>.1`, … and does NOT write the
 * un-suffixed name at all (`SessionStore`'s `#chunk()` in
 * next-auth/core/lib/cookie.js, measured against the installed 4.24.14);
 * `getToken()` transparently reassembles them, collecting every cookie whose
 * name `startsWith` the base. So a CHUNKED session is one `getToken()` can read
 * and a bare `has(name)` cannot see — and a chunked-AND-unreadable session
 * would fall straight back into the redirect loop the caller uses this to
 * prevent. A large `apps` claim or a long group membership is exactly what
 * pushes a JWT past 3933 bytes, so this is reachable rather than theoretical.
 *
 * Matching on `name` or the `name.` prefix mirrors next-auth's own reader
 * (rather than enumerating `.0`/`.1`/… literals, which would need editing if
 * the chunk scheme ever changed, and can be half-"tidied" away one name at a
 * time) while staying tighter than its raw `startsWith`: a cookie merely
 * BEGINNING with the base name — say `next-auth.session-tokenfoo` — is not a
 * chunk of ours and must not count.
 *
 * Either way the failure direction is safe: a false POSITIVE only suppresses
 * the callbackUrl, costing a click, while a false negative is the redirect
 * loop. When in doubt this returns true.
 *
 * Takes the NAMES only, so it is a pure function with no `next/server` import
 * and is unit-testable — the same reason `lib/apiGate.ts` exists. The caller
 * passes `req.cookies.getAll().map(c => c.name)`.
 */
export function hasSessionCookie(cookieNames: Iterable<string>): boolean {
  const bases = [SESSION_COOKIE, `__Secure-${SESSION_COOKIE}`]
  for (const name of cookieNames) {
    for (const base of bases) {
      if (name === base || name.startsWith(`${base}.`)) return true
    }
  }
  return false
}

/**
 * The absolute hub `/login` URL to send THIS request's browser to.
 *
 * The hub origin is derived from the current request (`resolveOrigin`), so the
 * redirect follows the hostname and scheme the user is actually browsing rather
 * than the install-time env var. The `callbackUrl` is a constant, so no part of
 * the result can be chosen by the caller beyond that hostname.
 */
export function hubSigninUrl(req: NextRequest): string {
  const hub = resolveOrigin(req, HUB_PORT, hubFallback()).replace(/\/+$/, '')
  return `${hub}/login?callbackUrl=${encodeURIComponent(HUB_CALLBACK_PATH)}`
}

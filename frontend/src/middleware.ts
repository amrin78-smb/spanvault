import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { resolveOrigin } from '@/lib/publicUrl';
// The two pure decisions about an /api/* request — which paths are public, and
// which client-supplied headers must never survive the proxy — live in
// lib/apiGate.ts so they can be tested (this file imports next/server and runs
// on the edge runtime, so it cannot be required from a Node test script).
// Regression suite: tests/test-rbac-scoping.js.
import { isPublicApiPath, stripClientIdentity } from '@/lib/apiGate';
// The post-login return path, shared with app/auth/signin/route.ts so the gate
// and NextAuth's sign-in redirect cannot drift apart.
import { HUB_CALLBACK_PATH, hasSessionCookie } from '@/lib/hubSignin';

// Legacy fallback only — the real target origin is derived per-request from
// the Host/X-Forwarded-Host headers (see resolveOrigin) so hub-redirects keep
// working when the suite is accessed via a customer's own local-DNS hostname
// instead of the install-time server IP.
const HUB_FALLBACK = process.env.NOCVAULT_HUB_URL || 'http://localhost:3000';
// ⛔ MUST BE A PATH THE HUB WILL ACTUALLY HONOUR, AND MUST STAY THE SHARED
// CONSTANT. This was '/sso' — a SpanVault path, not a hub one — and the hub's
// login page refuses it outright (net-vault app/(auth)/login/page.tsx rejects
// anything startsWith('/sso')), silently substituting /launcher: nothing errors
// and nothing logs, so every gated visitor just landed on the launcher and had
// to click back in. HUB_CALLBACK_PATH is the hub's own SSO re-entry route, which
// that filter accepts, so signing in now returns the user straight to SpanVault.
//
// It is imported rather than spelled out here because this gate and NextAuth's
// `pages.signIn` (lib/hubSignin.ts) are the only two senders of this value, and
// two independent spellings is how one of them drifts back to something the hub
// discards. Both were fixed together in 1.121.2. Pinned by
// tests/test-signin-redirect.js section 6 — which fails if this line stops using
// HUB_CALLBACK_PATH, because the runtime symptom never surfaces as an error.
const CALLBACK = encodeURIComponent(HUB_CALLBACK_PATH);

// Whether a session cookie is present at all, readable or not — the loop guard
// below needs that, and it is NOT `cookies.has(name)`: next-auth chunks a
// >4096-byte session into `<name>.0`, `<name>.1`, … and writes no un-suffixed
// name, and the `__Secure-` prefix depends on config. Both subtleties, and why
// each matters, live with the function in @/lib/hubSignin (pure, unit-tested —
// same reason @/lib/apiGate exists).

// Per-user app-access gate (Phase 2). NetVault always allowed; a missing/empty
// claim means default-all (FAIL OPEN — older tokens without `apps` are never
// locked out); otherwise the app slug must be in the user's allowed set.
function appAllowed(apps: unknown, slug: string): boolean {
  if (slug === 'netvault') return true;
  if (!Array.isArray(apps) || apps.length === 0) return true;
  return apps.includes(slug);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Proxy non-auth API calls directly to Express — never touches NextAuth.
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) {
    // /api/internal/* is loopback-only, service-to-service (collector → API,
    // e.g. the push-config notification after a NetVault site-reassignment
    // sync). Never proxied through here — the collector calls Express directly
    // on 127.0.0.1:3009, bypassing this frontend entirely. Blocking it here
    // matters because Express's own loopback check can't tell "the collector
    // called me directly" apart from "this frontend proxy called me on behalf
    // of a logged-in browser user" — both arrive at Express from 127.0.0.1.
    if (pathname.startsWith('/api/internal/')) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const target = new URL(`http://127.0.0.1:3009${pathname}${search}`);

    // ⛔ STRIP CLIENT-SUPPLIED IDENTITY BEFORE ANY BRANCH BELOW CAN FORWARD IT.
    // The session branch further down builds a fresh `Headers` and OVERWRITES
    // x-user-role/-sites/-email from the verified token, so it was safe. The
    // PUBLIC branch returned a bare `NextResponse.rewrite(target)` with no
    // `headers` object at all — so on a public path the caller's OWN
    // x-user-role / x-user-sites / x-user-email reached Express verbatim, and
    // `userRank()` / `getSiteFilter()` in api/server.js trust those headers
    // completely.
    //
    // Not exploitable as it stood, by accident: `PUBLIC_API` matches the PREFIX
    // `maps\/public\/` with no method check, and the only thing that stopped an
    // anonymous `POST /api/maps/public/toggle-...`-shaped call from arriving as
    // super_admin was `app.param('id', …)` rejecting a non-numeric `:id` — a
    // guard added for NaN 500s, not for this. Any new route under that prefix,
    // or one keyed on `:uuid`, converts it into an unauthenticated admin write.
    // It is ALSO already a real (if small) integrity problem: api/server.js
    // writes `x-user-email`/`x-user-role` into the audit_log row, so an
    // anonymous caller on a public path already chose the actor string recorded
    // against it.
    //
    // Both siblings delete theirs before their public branch
    // (logvault/frontend/src/proxy.ts, ddivault/frontend/src/middleware.ts).
    // Stripping here, once, ahead of every branch, is the only shape that
    // cannot be bypassed by a branch added later.
    const stripped = stripClientIdentity(new Headers(req.headers));

    // Explicit, narrow allow-list of API routes that must work with no session:
    // public map viewers (/maps/public/:uuid page fetches its own data), the
    // health check, the SSO verify proxy (POST /api/sso — this is the
    // means by which a session gets created in the first place, so requiring an
    // existing token here would make sign-in impossible; its own security
    // boundary is the signed one-time token in the request body, verified
    // server-side against the hub, not a session cookie), and /api/stats (three
    // aggregate counts — monitored_devices/availability/active_alerts, no
    // per-record data — probed unauthenticated by NetVault's launcher
    // suite-stats aggregator, exactly like DDIVault's and LogVault's equivalent
    // endpoints already are; this app's own version was the only one still
    // requiring a session, which is why the launcher tile silently showed "—"
    // instead of real numbers). Everything else requires a valid token; the
    // RBAC middleware in api/server.js only gates writes (POST/PUT/PATCH/DELETE),
    // so without this check every GET was reachable with zero authentication.
    // ⛔ /api/license-status IS LOAD-BEARING FOR EVERY UNAUTHENTICATED PAGE.
    // `LicenseProvider` sits in the ROOT layout (app/layout.tsx) — deliberately,
    // so a disabled licence hard-blocks EVERY route — which means it also runs
    // on /sso and /maps/public/*, routes that render with no session BY DESIGN.
    // This route being [auth] was a defensible choice on its own, and moving the
    // provider to the root was a defensible choice on its own; TOGETHER they
    // broke both pages. The 401 body is valid JSON, so LicenseProvider's
    // try/catch never fired — it stored `undefined` as the state and
    // LicenseGate threw `Cannot read properties of undefined (reading
    // 'disabled')`. MEASURED on production 2026-11-06: every public map share
    // link and the SSO landing page rendered React's "Application error:
    // a client-side exception has occurred" instead of the page.
    //
    // ⛔ DO NOT also add /api/system/update-available or
    // /api/system/last-update-status here "for consistency with the other
    // suite apps". Their only consumers (UpdateNotifier, UpdateFailureBanner)
    // live in (app)/layout.tsx and always have a session, and
    // last-update-status returns commit hashes and raw updater error text —
    // real disclosure, bought for nothing. Their absence here is deliberate;
    // routes.md's `[public]` label on update-available was simply wrong.
    // ⛔ The allow-list itself (and the METHOD restriction the `maps/public/:uuid`
    // prefix needs, because it is the one entry that cannot be `$`-anchored)
    // lives in lib/apiGate.ts — see isPublicApiPath there for the per-route
    // reasoning, including why license-status MUST stay public.
    if (isPublicApiPath(pathname, req.method)) {
      return NextResponse.rewrite(target, { request: { headers: stripped } });
    }

    // Forward the authenticated user's role + assigned sites so the API can
    // enforce server-side RBAC scoping. We always overwrite these headers from
    // the verified token, so a client cannot spoof them.
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
      // This `!token` has the same ambiguity as the page gate's below (no cookie
      // vs. an unreadable one) but needs NO loop guard, and that was checked
      // rather than assumed: a JSON 401 is terminal. It is not a redirect, and
      // nothing on the client turns it into one — `lib/api.ts` throws on
      // `!res.ok` and the components surface the error, so no code path
      // navigates to the hub login on a 401 (the only login navigations in the
      // app are IdleTimeout's idle logout and the /sso page's manual link).
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Per-user app-access enforcement (same claim/rule as the page-route branch
    // below) — a session that exists but isn't granted SpanVault must not reach
    // the API either. Without this, a denied user was correctly bounced from
    // every page but could still call the API directly with the same valid
    // session and get full data.
    if (!appAllowed((token as any).apps, 'spanvault')) {
      return NextResponse.json({ error: 'forbidden', reason: 'app_access_denied' }, { status: 403 });
    }
    const headers = stripped;
    headers.set('x-user-role', (token.role as string) || 'viewer');
    headers.set('x-user-sites', ((token.sites as number[]) || []).join(','));
    headers.set('x-user-email', (token.email as string) || (token.name as string) || 'unknown');
    return NextResponse.rewrite(target, { request: { headers } });
  }

  // Public map view pages render without authentication.
  if (pathname.startsWith('/maps/public/')) {
    return NextResponse.next();
  }

  // Auth guard for all page routes
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    const hub = resolveOrigin(req, 3000, HUB_FALLBACK);

    // ⛔ LOOP GUARD — A callbackUrl THE HUB WILL HONOUR IS ONLY SAFE WHEN THE
    // ABSENCE OF A SESSION IS CERTAIN, AND `getToken()` CANNOT TELL US THAT.
    // It returns null for BOTH "no session cookie" and "there is a cookie and I
    // cannot read it" — an unreadable cookie being what a rotated
    // NEXTAUTH_SECRET or a writer/reader cookie-NAME divergence produces.
    //
    // ⛔ THAT DIVERGENCE IS NOT PURELY AN OPERATOR ERROR — THE LIBRARY HAS TWO
    // INDEPENDENT PATHS TO IT. The two `secureCookie` decisions read DIFFERENT
    // INPUTS (measured against the installed next-auth 4.24.14):
    //   write  core/init.js:60   authOptions.useSecureCookies ?? url.base.startsWith('https://')
    //                            — and `url.base` comes from detectOrigin(), which
    //                              uses the REQUEST's proto when AUTH_TRUST_HOST/
    //                              VERCEL is set and NEXTAUTH_URL otherwise
    //   read   jwt/index.js:65   process.env.NEXTAUTH_URL?.startsWith('https://')
    //                              ?? !!process.env.VERCEL
    //                            — never the request, never AUTH_TRUST_HOST,
    //                              never authOptions.useSecureCookies
    // So the cookie can be written under one assumption and read under another
    // with nothing obviously misconfigured: setting `useSecureCookies` alone
    // does it, and so does AUTH_TRUST_HOST with an http:// NEXTAUTH_URL behind
    // an HTTPS terminator (writes `__Secure-…`, then looks for the bare name).
    //
    // In any of those cases a honoured callbackUrl is an infinite redirect with
    // no hop counter anywhere: gate -> hub -> hub mints a token -> /sso sets a
    // cookie -> the gate still cannot read it -> hub -> ERR_TOO_MANY_REDIRECTS.
    //
    // This was LATENT until the callbackUrl became one the hub accepts. The old
    // value was `/sso`, which the hub's login page refuses and replaces with
    // `/launcher` — so the cycle always terminated, by accident rather than by
    // design. Fixing the UX removed the accident, hence this guard.
    //
    // So: a cookie we cannot read means we have ALREADY been round the loop at
    // least once. Send the browser to the hub login with NO return address; it
    // lands on the launcher, which is a dead end in the good sense — the user
    // gets a working page instead of a browser error, and the misconfiguration
    // is still visible (they can never get in) rather than hidden behind a
    // spinning redirect.
    //
    // The cost is near-zero on the normal path: SpanVault sets no session
    // `maxAge`, so the cookie's own expiry and the JWT's are the same 30-day
    // default — an ordinarily-expired session has no cookie left to find, and
    // so still gets the full return address.
    // ⛔ NAMES, via hasSessionCookie — NOT `req.cookies.has(name)`. A session
    // over 4096 bytes is written as `<name>.0`/`<name>.1`/… with no un-suffixed
    // name, which `has()` cannot see and `getToken()` reassembles happily; a
    // chunked-and-unreadable session would therefore slip straight back into the
    // loop. See @/lib/hubSignin.
    if (hasSessionCookie(req.cookies.getAll().map((c) => c.name))) {
      return NextResponse.redirect(`${hub}/login`);
    }

    return NextResponse.redirect(`${hub}/login?callbackUrl=${CALLBACK}`);
  }

  // Per-user app-access enforcement: a signed-in user who isn't granted the
  // SpanVault app is redirected to the hub launcher with a denied banner. The
  // launcher lives on the hub (a different origin), so this can't loop here.
  if (!appAllowed((token as any).apps, 'spanvault')) {
    return NextResponse.redirect(`${resolveOrigin(req, 3000, HUB_FALLBACK)}/launcher?denied=spanvault`);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Non-auth API calls → proxy to Express
    '/api/((?!auth(?:/|$)).+)',
    // All page routes → auth guard, except the public map view pages and
    // /auth/signin.
    // ⛔ `auth/signin` MUST stay excluded. It is NextAuth's configured
    // `pages.signIn` (a route handler, app/auth/signin/route.ts) whose whole job
    // is to redirect an UNAUTHENTICATED browser on to the hub login. Gating it
    // would have the gate redirect to the hub, the hub bounce back here, and
    // this route redirect again — a loop, not a login.
    '/((?!api|sso|auth/signin|maps/public|_next/static|_next/image|favicon.ico).*)',
  ],
};

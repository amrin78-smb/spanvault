import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { resolveOrigin } from '@/lib/publicUrl';

// Legacy fallback only — the real target origin is derived per-request from
// the Host/X-Forwarded-Host headers (see resolveOrigin) so hub-redirects keep
// working when the suite is accessed via a customer's own local-DNS hostname
// instead of the install-time server IP.
const HUB_FALLBACK = process.env.NOCVAULT_HUB_URL || 'http://localhost:3000';
const CALLBACK = encodeURIComponent('/sso');

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

    // Explicit, narrow allow-list of API routes that must work with no session:
    // public map viewers (/maps/public/:uuid page fetches its own data), the
    // health check, the agent-binary distribution endpoints (a not-yet-
    // installed agent has no session — it's a script running via `irm`, not a
    // logged-in browser), the SSO verify proxy (POST /api/sso — this is the
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
    const PUBLIC_API = /^\/api\/(maps\/public\/|health$|stats$|sso$|agent\/(install\.ps1|agent\.js(\.sha256)?|package\.json|nssm\.exe(\.sha256)?)$)/;
    if (PUBLIC_API.test(pathname)) {
      return NextResponse.rewrite(target);
    }

    // Forward the authenticated user's role + assigned sites so the API can
    // enforce server-side RBAC scoping. We always overwrite these headers from
    // the verified token, so a client cannot spoof them.
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
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
    const headers = new Headers(req.headers);
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
    return NextResponse.redirect(`${resolveOrigin(req, 3000, HUB_FALLBACK)}/login?callbackUrl=${CALLBACK}`);
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
    // All page routes → auth guard, except the public map view pages
    '/((?!api|sso|maps/public|_next/static|_next/image|favicon.ico).*)',
  ],
};

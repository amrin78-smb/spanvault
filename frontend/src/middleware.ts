import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

const HUB = process.env.NOCVAULT_HUB_URL || 'http://localhost:3000';
const CALLBACK = encodeURIComponent('/sso');

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
    // health check, and the agent-binary distribution endpoints (a not-yet-
    // installed agent has no session — it's a script running via `irm`, not a
    // logged-in browser). Everything else requires a valid token; the RBAC
    // middleware in api/server.js only gates writes (POST/PUT/PATCH/DELETE), so
    // without this check every GET was reachable with zero authentication.
    const PUBLIC_API = /^\/api\/(maps\/public\/|health$|agent\/(install\.ps1|agent\.js(\.sha256)?|package\.json|nssm\.exe(\.sha256)?)$)/;
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
    return NextResponse.redirect(`${HUB}/login?callbackUrl=${CALLBACK}`);
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

import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

const HUB = process.env.NOCVAULT_HUB_URL || 'http://localhost:3000';
const CALLBACK = encodeURIComponent('/sso');

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Proxy non-auth API calls directly to Express — never touches NextAuth.
  // Public map data (/api/maps/public/:uuid) is proxied like any other API call,
  // so it stays reachable without a session.
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) {
    return NextResponse.rewrite(
      new URL(`http://127.0.0.1:3009${pathname}${search}`)
    );
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

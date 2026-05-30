import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

const HUB = process.env.NOCVAULT_HUB_URL || 'http://localhost:3000';
const CALLBACK = encodeURIComponent('/sso');

export default withAuth(
  function middleware(_req) {
    return NextResponse.next();
  },
  {
    callbacks: { authorized: ({ token }) => !!token },
    pages: { signIn: `${HUB}/login?callbackUrl=${CALLBACK}` },
  }
);

export const config = {
  // Everything except API routes, the SSO landing page, and Next internals.
  matcher: ['/((?!api|sso|_next/static|_next/image|favicon.ico).*)'],
};

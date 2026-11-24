import { NextRequest, NextResponse } from 'next/server'
import { hubSigninUrl } from '@/lib/hubSignin'

// SpanVault's local, REQUEST-AWARE stand-in for a sign-in page. It has no UI:
// SpanVault has no login screen (auth is the hub's job), so this only exists to
// turn NextAuth's one-shot, module-load-time `pages.signIn` into a per-request
// redirect to the hub. See frontend/src/lib/hubSignin.ts for the full reasoning.
//
// ⛔ THIS MUST NOT LIVE UNDER `/api/`. `middleware.ts` rewrites EVERY `/api/*`
// request except `/api/auth/*` to Express on 127.0.0.1:3009, so a Next.js route
// handler under `app/api/**` is dead code in this repo — it type-checks, builds
// and then 404s at runtime from Express (that is exactly how 1.71.3's
// `app/api/sso/route.ts` shipped broken). `/auth/signin` is outside the proxy
// branch entirely.
//
// ⛔ IT MUST ALSO BE EXEMPT FROM THE PAGE GATE. The page matcher in
// `middleware.ts` excludes `auth/signin`; without that, an unauthenticated hit
// here would be redirected to the hub login by the gate, which sends the
// browser back here, forever.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // 307, not 302/301: preserve the method and keep it explicitly temporary so
  // nothing caches a hub origin derived from one request's Host header.
  return NextResponse.redirect(hubSigninUrl(req), 307)
}

export async function HEAD(req: NextRequest) {
  return NextResponse.redirect(hubSigninUrl(req), 307)
}

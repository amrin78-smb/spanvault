import { NextRequest, NextResponse } from 'next/server';
import { resolveOrigin } from '@/lib/publicUrl';

// Legacy fallback — used only when the incoming request doesn't carry a
// usable Host. The hub origin is otherwise derived per-request below.
const HUB_URL_FALLBACK = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

/**
 * SSO proxy — avoids CORS by making the sso-verify call server-side.
 * Browser calls /api/sso (same origin), this calls NetVault server-to-server.
 */
export async function POST(req: NextRequest) {
  try {
    // NetVault (the hub) always runs on port 3000.
    const hubUrl = resolveOrigin(req, 3000, HUB_URL_FALLBACK);
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: 'No token provided' }, { status: 400 });
    }

    const res = await fetch(`${hubUrl}/api/auth/sso-verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `sso-verify failed: ${res.status} ${text}` },
        { status: 401 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);

  } catch (err: any) {
    console.error('[SSO Proxy] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';

const EXPRESS_API = 'http://127.0.0.1:3009';

async function handler(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const search = req.nextUrl.search;
  const url = `${EXPRESS_API}${path}${search}`;
  try {
    const body = req.method !== 'GET' && req.method !== 'HEAD'
      ? await req.text() : undefined;
    const res = await fetch(url, {
      method: req.method,
      headers: { 'content-type': req.headers.get('content-type') || 'application/json' },
      body,
    });
    const data = await res.text();
    return new NextResponse(data, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
    });
  } catch (e) {
    return NextResponse.json({ error: 'API unreachable' }, { status: 502 });
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as DELETE, handler as PATCH };

import { NextRequest } from 'next/server'

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

// Derive the hub/app origin from the CURRENT REQUEST (Host / X-Forwarded-Host)
// instead of a static install-time env var, so hub-redirects keep working when
// the suite is later accessed via a customer's own local-DNS hostname (e.g.
// nocvault.thaiunion.com) instead of the install-time server IP. The env var
// is kept ONLY as a fallback for the rare request that carries no usable Host.
export function resolveOrigin(req: NextRequest, port: number | null, legacyFallback: string): string {
  const rawHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const hostname = rawHost.split(':')[0].trim()
  const proto = (req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '') || 'http')
    .split(',')[0]
    .trim()

  if (hostname && hostname.length <= 253 && HOSTNAME_RE.test(hostname) && (proto === 'http' || proto === 'https')) {
    return `${proto}://${hostname}${port ? ':' + port : ''}`
  }
  return legacyFallback
}

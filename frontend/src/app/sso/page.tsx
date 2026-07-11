'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

// Hub URL — derived from the current page's own hostname so the SSO-verify
// call and the "Return to login" link keep working if the suite is later
// accessed via a local-DNS hostname instead of the install-time server IP.
// Both call sites below only run/render client-side (inside a useEffect, or
// gated behind an error state that starts null), so there is no SSR/hydration
// mismatch in practice; the env-var fallback only matters for the vanishingly
// rare SSR edge case.
function getHubUrl(): string {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  return process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
}

function SsoInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setError('No SSO token provided.');
      return;
    }
    (async () => {
      try {
        // Verify the token with the NocVault hub before trusting it.
        const res = await fetch(`${getHubUrl()}/api/auth/sso-verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) throw new Error('Token verification failed');

        // The hub's verify response is the authoritative profile
        // ({ email, role, name, userId }) — pass it into signIn so the session
        // has a real name/email even when the raw SSO JWT omits those claims.
        const profile = await res.json().catch(() => ({} as any));

        const result = await signIn('credentials', {
          ssoToken: token,
          email: profile?.email ?? '',
          name: profile?.name ?? '',
          role: profile?.role ?? '',
          userId: String(profile?.userId ?? ''),
          redirect: false,
        });
        if (result?.error) throw new Error('Sign-in failed');
        router.replace('/');
      } catch (e: any) {
        setError(e?.message || 'Single sign-on failed.');
      }
    })();
  }, [params, router]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
        color: '#1a2744',
      }}
    >
      {error ? (
        <>
          <h2 style={{ color: 'var(--primary)' }}>Sign-in error</h2>
          <p>{error}</p>
          <a href={`${getHubUrl()}/login`} style={{ color: 'var(--primary)', marginTop: 12 }}>
            Return to login
          </a>
        </>
      ) : (
        <>
          <div className="sv-spinner" />
          <p style={{ marginTop: 16 }}>Signing you in…</p>
        </>
      )}
    </div>
  );
}

export default function SsoPage() {
  return (
    <Suspense fallback={null}>
      <SsoInner />
    </Suspense>
  );
}

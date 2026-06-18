'use client';

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

const HUB = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

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
        const res = await fetch(`${HUB}/api/auth/sso-verify`, {
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
          <a href={`${HUB}/login`} style={{ color: 'var(--primary)', marginTop: 12 }}>
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

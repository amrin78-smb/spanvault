'use client';

// Root App Router error boundary. Next.js requires error boundaries to be client
// components. Catches runtime render errors from the route tree and shows a
// branded recovery card (outside the (app) shell, so it draws its own centered
// full-viewport layout using the suite design tokens). `reset()` re-renders the
// segment to retry; the link falls back to the dashboard.
import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error in the console for diagnostics; the digest correlates
    // with the server-side log entry when this is a server error.
    console.error(error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg-primary)',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-sm)',
          padding: '40px 36px',
          maxWidth: 460,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 42,
            lineHeight: 1,
            marginBottom: 8,
          }}
          aria-hidden="true"
        >
          &#9888;
        </div>
        <h1
          style={{
            fontSize: 'var(--text-xl)',
            fontWeight: 700,
            color: 'var(--text-primary)',
            margin: '10px 0 8px',
          }}
        >
          Something went wrong
        </h1>
        <p
          style={{
            fontSize: 'var(--text-md)',
            color: 'var(--text-secondary)',
            margin: '0 0 24px',
            lineHeight: 1.5,
          }}
        >
          An unexpected error occurred while loading this page. You can try again,
          or head back to the dashboard.
        </p>
        {error?.digest && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-muted)',
              marginBottom: 20,
              wordBreak: 'break-all',
            }}
          >
            Ref: {error.digest}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: 10,
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button type="button" className="sv-btn" onClick={() => reset()}>
            Try again
          </button>
          <a href="/" className="sv-btn ghost" style={{ textDecoration: 'none' }}>
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}

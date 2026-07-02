// Root App Router 404 page. Renders for any unmatched route. This sits OUTSIDE
// the (app) route group, so there is no sidebar shell here — it draws its own
// full-viewport centered, branded card using the suite design tokens. Server
// component (no client state needed); links back to the dashboard at `/`.
export default function NotFound() {
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
          maxWidth: 440,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: '-2px',
            color: 'var(--primary)',
          }}
        >
          404
        </div>
        <h1
          style={{
            fontSize: 'var(--text-xl)',
            fontWeight: 700,
            color: 'var(--text-primary)',
            margin: '18px 0 8px',
          }}
        >
          Page not found
        </h1>
        <p
          style={{
            fontSize: 'var(--text-md)',
            color: 'var(--text-secondary)',
            margin: '0 0 24px',
            lineHeight: 1.5,
          }}
        >
          The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved.
        </p>
        <a href="/" className="sv-btn" style={{ textDecoration: 'none' }}>
          Back to dashboard
        </a>
      </div>
    </div>
  );
}

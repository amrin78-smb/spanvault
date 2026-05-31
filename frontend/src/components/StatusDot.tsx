'use client';

/**
 * Reusable status indicator dot.
 * - down    → red, pulsing
 * - warning → yellow, pulsing
 * - up      → solid green
 * - unknown → solid grey
 */
export function StatusDot({
  status,
  size = 11,
  title,
}: {
  status: string;
  size?: number;
  title?: string;
}) {
  const s = (status || 'unknown').toLowerCase();
  return (
    <span
      className={`sv-status-dot ${s}`}
      style={{ width: size, height: size }}
      title={title ?? s}
      aria-label={`status: ${s}`}
    />
  );
}

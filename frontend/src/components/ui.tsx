'use client';

/** Small shared presentational helpers — all defined at top level (never nested). */

export function StatusBadge({ status }: { status: string }) {
  const s = (status || 'unknown').toLowerCase();
  const label = s.charAt(0).toUpperCase() + s.slice(1);
  return <span className={`sv-badge ${s}`}>{label}</span>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="sv-loading">
      <div className="sv-spinner" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="sv-panel" style={{ borderLeft: '4px solid var(--sv-crimson)' }}>
      <strong style={{ color: 'var(--sv-crimson)' }}>Error:</strong> {message}
    </div>
  );
}

export function Empty({ message }: { message: string }) {
  return <div className="sv-empty">{message}</div>;
}

export function StatCard({
  num,
  label,
  variant = 'unknown',
}: {
  num: number | string;
  label: string;
  variant?: 'up' | 'down' | 'warning' | 'unknown' | 'total';
}) {
  return (
    <div className={`sv-card ${variant}`}>
      <div className="num">{num}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function fmtRel(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const d = new Date(ts).getTime();
  if (isNaN(d)) return 'never';
  const sec = Math.round((Date.now() - d) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export function fmtBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || isNaN(Number(bps))) return '—';
  const n = Number(bps);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} Kbps`;
  return `${n.toFixed(0)} bps`;
}

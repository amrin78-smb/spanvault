'use client';

import { useEffect, useRef } from 'react';

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

// ════════════════════════════════════════════════════════════
// Shared NocVault suite UI primitives (mirrors DDIVault's ui.tsx).
// All components defined at module scope (never nested).
// ════════════════════════════════════════════════════════════

// ── Utilization colour helper ─────────────────────────────────
export function pctColor(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 80) return 'var(--yellow)';
  return 'var(--green)';
}

// ── Skeleton block ────────────────────────────────────────────
export function Skeleton({ width = '100%', height = 14, radius = 6, style }: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius, ...style }} />;
}

// ── Table skeleton ────────────────────────────────────────────
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: '4px 0' }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 16, padding: '11px 14px', alignItems: 'center' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={12} width={c === 0 ? 120 : `${Math.max(40, 100 / cols)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Card skeleton (KPI tiles etc.) ────────────────────────────
export function CardSkeleton({ count = 5, height = 88 }: { count?: number; height?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: 18, minHeight: height,
        }}>
          <Skeleton height={28} width="50%" />
          <div style={{ height: 8 }} />
          <Skeleton height={12} width="70%" />
        </div>
      ))}
    </>
  );
}

// ── Empty state ───────────────────────────────────────────────
export function EmptyState({ icon, title, message, actionLabel, onAction }: {
  icon?: React.ReactNode;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '52px 24px', textAlign: 'center', color: 'var(--text-muted)',
    }}>
      {icon && (
        <div style={{
          width: 56, height: 56, borderRadius: 14, marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-muted)',
        }}>
          {icon}
        </div>
      )}
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      {message && <div style={{ fontSize: 'var(--text-base)', marginTop: 6, maxWidth: 420 }}>{message}</div>}
      {actionLabel && onAction && (
        <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// ── Page header (title + subtitle + right-aligned actions) ─────
export function PageHeader({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
      <div className="page-head-row">
        <div className="page-title">{title}</div>
        {subtitle && <span className="page-head-sep">·</span>}
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────
export interface Crumb { label: string; onClick?: () => void }
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumb">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {last || !c.onClick
              ? <span className="crumb-current">{c.label}</span>
              : <button onClick={c.onClick}>{c.label}</button>}
          </span>
        );
      })}
    </nav>
  );
}

// ── Inline utilization bar ────────────────────────────────────
export function UtilBar({ pct, showLabel = true, width }: { pct: number; showLabel?: boolean; width?: number }) {
  // Coerce defensively: pg NUMERIC columns arrive as strings, and a string here
  // would throw on .toFixed(). Number() handles both number and string inputs.
  const n = Number(pct);
  const p = Number.isFinite(n) ? n : 0;
  const color = pctColor(p);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width }}>
      <div className="util-track">
        <div className="util-fill" style={{ width: `${Math.min(100, p)}%`, background: color }} />
      </div>
      {showLabel && <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color, minWidth: 40, textAlign: 'right' }}>{p.toFixed(1)}%</span>}
    </div>
  );
}

// ── Trend indicator (↑ ↓ →) ───────────────────────────────────
export function Trend({ delta, invert = false }: { delta: number; invert?: boolean }) {
  // invert=false: rising is "bad" (red) — e.g. utilization. invert=true: rising is "good".
  const up = delta > 0.05, down = delta < -0.05;
  const arrow = up ? '↑' : down ? '↓' : '→';
  const good = invert ? up : down;
  const bad  = invert ? down : up;
  const color = good ? 'var(--green)' : bad ? 'var(--red)' : 'var(--text-muted)';
  return (
    <span style={{ color, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
      {arrow} {Math.abs(delta).toFixed(1)}
    </span>
  );
}

// ── Spinner ───────────────────────────────────────────────────
export function Spinner({ size = 14, color = 'var(--primary)' }: { size?: number; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size,
      border: `2px solid var(--border)`, borderTopColor: color,
      borderRadius: '50%', animation: 'spin 0.8s linear infinite',
    }} />
  );
}

// ── Hook: refresh on global "R" key (dispatched by app shell) ──
export function useRefreshKey(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener('spanvault:refresh', h);
    return () => window.removeEventListener('spanvault:refresh', h);
  }, []);
}

// ── Hook: call cb on Escape keypress (for modals) ─────────────
export function useEscape(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}

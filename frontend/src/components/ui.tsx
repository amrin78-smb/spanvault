'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

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

// ── Shared Recharts tooltip theme ─────────────────────────────
// Recharts' default <Tooltip> renders an opaque white box with black text,
// which is unreadable in dark mode. Spread this onto every chart tooltip
// (`<Tooltip {...CHART_TOOLTIP} .../>`) so it uses the theme tokens and flips
// with the theme. Mirrors the reports' TOOLTIP_STYLE so all charts match.
export const CHART_TOOLTIP = {
  contentStyle: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-sm)',
    color: 'var(--text-primary)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  } as React.CSSProperties,
  labelStyle: { color: 'var(--text-muted)', fontWeight: 600, marginBottom: 2 } as React.CSSProperties,
  itemStyle: { color: 'var(--text-primary)' } as React.CSSProperties,
};

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
        <button className="sv-btn" style={{ marginTop: 18 }} onClick={onAction}>
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

// ── Client-side pagination ────────────────────────────────────
// Slices an already-fetched array into fixed-size pages. The page index is
// clamped whenever the row count shrinks (e.g. a live poll returns fewer rows),
// so callers never render an out-of-range empty page.
export function useClientPagination<T>(rows: T[], perPage: number, resetKey?: unknown) {
  const [page, setPage] = useState(0);
  // Jump back to the first page whenever the caller's filter identity changes
  // (e.g. a status/search filter), so we never strand the user on a page that
  // no longer exists for the new result set.
  useEffect(() => { setPage(0); }, [resetKey]);
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
  const clamped = Math.min(page, pageCount - 1);
  const start = clamped * perPage;
  return {
    page: clamped,
    setPage,
    pageCount,
    perPage,
    start,
    total: rows.length,
    pageRows: rows.slice(start, start + perPage),
    // Clamp the (possibly stale) page state to the current page count before
    // stepping, so Prev/Next stay responsive right after a live poll shrinks
    // the row set while the user is on a now-out-of-range page.
    prev: () => setPage((p) => Math.max(0, Math.min(p, pageCount - 1) - 1)),
    next: () => setPage((p) => Math.min(pageCount - 1, Math.min(p, pageCount - 1) + 1)),
  };
}

const PAGER_ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, marginTop: 12, flexWrap: 'wrap',
};
const PAGER_BTN: React.CSSProperties = {
  fontSize: 'var(--text-base)', padding: '4px 12px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-card)',
  color: 'var(--text-primary)', cursor: 'pointer', lineHeight: 1.4,
};
const PAGER_BTN_DISABLED: React.CSSProperties = {
  ...PAGER_BTN, color: 'var(--text-muted)', cursor: 'not-allowed', opacity: 0.5,
};

// Prev/Next pager with an "X–Y of N" range indicator. Optionally exposes a
// server-side "Load older" button (for tables that grow their fetch limit on
// demand) and a note when the fetch cap sits below the true total. Renders
// nothing when there is only one page and no load-older affordance.
export function Pager({
  page, pageCount, start, perPage, total,
  onPrev, onNext,
  grandTotal, onLoadOlder, loadingOlder = false, canLoadOlder = false, cappedNote,
}: {
  page: number;
  pageCount: number;
  start: number;
  perPage: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  grandTotal?: number;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  canLoadOlder?: boolean;
  cappedNote?: string;
}) {
  const showOlder = !!onLoadOlder && (canLoadOlder || loadingOlder);
  const showNav = pageCount > 1;
  if (!showNav && !showOlder && !cappedNote) return null;
  const end = Math.min(start + perPage, total);
  return (
    <>
      <div style={PAGER_ROW}>
        <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
          {total === 0 ? '0' : `${start + 1}–${end}`} of {total.toLocaleString()}
          {grandTotal !== undefined && grandTotal > total && <> loaded · {grandTotal.toLocaleString()} total</>}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {showOlder && (
            <button
              type="button"
              style={loadingOlder ? PAGER_BTN_DISABLED : PAGER_BTN}
              disabled={loadingOlder}
              onClick={onLoadOlder}
            >
              {loadingOlder ? 'Loading…' : 'Load older'}
            </button>
          )}
          {showNav && (
            <>
              <button
                type="button"
                style={page <= 0 ? PAGER_BTN_DISABLED : PAGER_BTN}
                disabled={page <= 0}
                onClick={onPrev}
              >
                ← Prev
              </button>
              <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
                Page {page + 1} of {pageCount}
              </span>
              <button
                type="button"
                style={page >= pageCount - 1 ? PAGER_BTN_DISABLED : PAGER_BTN}
                disabled={page >= pageCount - 1}
                onClick={onNext}
              >
                Next →
              </button>
            </>
          )}
        </div>
      </div>
      {cappedNote && (
        <div className="sv-muted" style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}>{cappedNote}</div>
      )}
    </>
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

// ── Themed confirm dialog (replaces native confirm()) ─────────
// Suite-standard modal built on the existing .sv-modal classes. Prefer the
// useConfirm() hook below over rendering this directly.
export type ConfirmOpts = {
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean; // destructive action → crimson/danger confirm button
};
export function ConfirmModal({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmOpts & { onConfirm: () => void; onCancel: () => void }) {
  useEscape(onCancel);
  return (
    <div
      className="sv-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="sv-modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {message}
        </div>
        <div className="sv-modal-actions">
          <button type="button" className="sv-btn ghost" onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className={danger ? 'sv-btn danger' : 'sv-btn'}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Hook: promise-based themed confirmation. Usage:
//   const { confirm, ConfirmUI } = useConfirm();
//   ...render {ConfirmUI} once in the component...
//   if (await confirm({ title, message, danger: true })) doDestructiveThing();
export function useConfirm() {
  const [state, setState] = useState<{ opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ opts, resolve })),
    [],
  );
  const settle = useCallback((v: boolean) => {
    setState((s) => { s?.resolve(v); return null; });
  }, []);
  const ConfirmUI = state ? (
    <ConfirmModal {...state.opts} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
  ) : null;
  return { confirm, ConfirmUI };
}

// ── Themed text-input prompt (replaces native window.prompt) ──
export type PromptOpts = {
  title?: string;
  message?: React.ReactNode;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};
export function PromptModal({
  title = 'Enter a value',
  message,
  label,
  defaultValue = '',
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: PromptOpts & { onSubmit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(defaultValue);
  useEscape(onCancel);
  return (
    <div
      className="sv-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="sv-modal" style={{ maxWidth: 440 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {message && (
          <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
            {message}
          </div>
        )}
        {label && (
          <label style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 6 }}>
            {label}
          </label>
        )}
        <input
          className="sv-input"
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) onSubmit(value.trim());
          }}
          style={{ width: '100%', height: 34, padding: '4px 10px' }}
        />
        <div className="sv-modal-actions">
          <button type="button" className="sv-btn ghost" onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className="sv-btn"
            disabled={!value.trim()}
            onClick={() => value.trim() && onSubmit(value.trim())}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
// Hook: promise-based themed prompt. Resolves to the entered string, or null if cancelled.
//   const { prompt, PromptUI } = usePrompt();
//   const name = await prompt({ title: 'Rename agent', defaultValue: a.name });
//   if (name) rename(name);
export function usePrompt() {
  const [state, setState] = useState<{ opts: PromptOpts; resolve: (v: string | null) => void } | null>(null);
  const prompt = useCallback(
    (opts: PromptOpts) => new Promise<string | null>((resolve) => setState({ opts, resolve })),
    [],
  );
  const settle = useCallback((v: string | null) => {
    setState((s) => { s?.resolve(v); return null; });
  }, []);
  const PromptUI = state ? (
    <PromptModal {...state.opts} onSubmit={(v) => settle(v)} onCancel={() => settle(null)} />
  ) : null;
  return { prompt, PromptUI };
}

// ── Themed toast (replaces native alert() for transient messages) ──
// Reuses the .sv-toast class. Usage:
//   const { toast, ToastUI } = useToast();
//   ...render {ToastUI} once...
//   toast('Saved', 'ok') / toast('Restart failed', 'err')
export function useToast(autoDismissMs = 5000) {
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const seq = useRef(0);
  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    seq.current += 1;
    setMsg({ text, kind });
  }, []);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), autoDismissMs);
    return () => clearTimeout(id);
  }, [msg, autoDismissMs]);
  const ToastUI = msg ? (
    <div className={`sv-toast ${msg.kind}`} role="status" aria-live="polite" onClick={() => setMsg(null)}>
      {msg.text}
    </div>
  ) : null;
  return { toast, ToastUI };
}

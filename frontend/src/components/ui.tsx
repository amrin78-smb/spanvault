'use client';

import { useEffect, useRef, useState, useCallback, useId } from 'react';

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
          width: 56, height: 56, borderRadius: 'var(--radius)', marginBottom: 16,
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

// ── Page header ────────────────────────────────────────────────
//
// Title + description + contextual actions, plus two slots the pages kept
// hand-rolling: `context` (breadcrumb / parent entity, so a drill-down never
// loses where it came from) and `freshness` (when this page's data was last
// collected, next to the data rather than buried in a corner).
//
// The title is a real <h1>. It was a styled <div>, which left most pages with
// no top-level heading at all — a screen-reader user had no landmark to jump
// to and the heading order started at <h2> or <h3>.
export function PageHeader({ title, subtitle, context, freshness, children }: {
  title: string;
  subtitle?: string;
  context?: React.ReactNode;
  freshness?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      {context}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div className="page-head-row">
          <h1 className="page-title">{title}</h1>
          {subtitle && <span className="page-head-sep" aria-hidden="true">·</span>}
          {subtitle && <div className="page-subtitle">{subtitle}</div>}
        </div>
        {(children || freshness) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {freshness}
            {children}
          </div>
        )}
      </div>
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
      // intentional: spinner ring — stays round in square-corner mode.
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
  fontSize: 'var(--text-base)', padding: '4px 12px', borderRadius: 'var(--radius-sm)',
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

// ── Hook: focus trap for modals/drawers (a11y) ────────────────
// Returns a ref to put on the dialog container. While `active`, Tab/Shift+Tab
// cycle within the container, initial focus moves inside (unless something —
// e.g. an autoFocus button — already holds focus there), and focus is restored
// to the previously-focused element on close. Pair with role="dialog" + useEscape.
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(SEL)).filter((x) => x.offsetParent !== null);
    if (!el.contains(document.activeElement)) focusables()[0]?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [active]);
  return ref;
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
  const trap = useFocusTrap<HTMLDivElement>(true);
  return (
    <div
      className="sv-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div ref={trap} className="sv-modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
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
  const [state, setState] = useState<{ opts: ConfirmOpts } | null>(null);
  // Pending resolver held in a ref so it can be settled without setState —
  // safe to call from unmount cleanup (a setState there is a no-op in React 18
  // and may never run the updater, so it can't be relied on to resolve).
  const pending = useRef<((v: boolean) => void) | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => {
      pending.current?.(false); // supersede any open dialog → its promise resolves (cancelled)
      pending.current = resolve;
      setState({ opts });
    }),
    [],
  );
  const settle = useCallback((v: boolean) => {
    const r = pending.current;
    pending.current = null;
    setState(null);
    r?.(v);
  }, []);
  // Resolve a still-pending promise as cancelled if the host unmounts.
  useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);
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
  const trap = useFocusTrap<HTMLDivElement>(true);
  return (
    <div
      className="sv-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div ref={trap} className="sv-modal" style={{ maxWidth: 440 }} onMouseDown={(e) => e.stopPropagation()}>
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
  const [state, setState] = useState<{ opts: PromptOpts } | null>(null);
  const pending = useRef<((v: string | null) => void) | null>(null);
  const prompt = useCallback(
    (opts: PromptOpts) => new Promise<string | null>((resolve) => {
      pending.current?.(null); // supersede any open prompt → its promise resolves (cancelled)
      pending.current = resolve;
      setState({ opts });
    }),
    [],
  );
  const settle = useCallback((v: string | null) => {
    const r = pending.current;
    pending.current = null;
    setState(null);
    r?.(v);
  }, []);
  useEffect(() => () => { pending.current?.(null); pending.current = null; }, []);
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
  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
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

// ── Table sorting (shared) ───────────────────────────────────────────────────
//
// One implementation for every sortable table in the app. Before this, sorting
// existed only inside wireless/page.tsx as a private SortTh plus a hand-written
// comparator per table, which is how you end up with tables that sort nulls
// differently or compare numbers as strings.
//
// Usage:
//   const { sort, onSort } = useTableSort({ key: 'name', dir: 'asc' });
//   const rows = useMemo(() => sortRows(filtered, sort, {
//     name:     (r) => r.name,
//     clients:  (r) => r.clients_total,
//     lastseen: (r) => r.last_seen_at,
//   }), [filtered, sort]);
//   <SortTh label="AP Name" col="name" sort={sort} onSort={onSort} />
export type SortDir = 'asc' | 'desc';
export type SortState = { key: string; dir: SortDir } | null;

export function useTableSort(initial: SortState = null) {
  const [sort, setSort] = useState<SortState>(initial);
  // First click on a column sorts ascending; clicking the same column flips it.
  const onSort = useCallback((key: string) => {
    setSort((s) => (s && s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }));
  }, []);
  return { sort, onSort, setSort };
}

// Compare two extracted values. Rules that matter in practice:
//  * null/undefined/'' always sort LAST regardless of direction — a device with
//    no reading should not top the list just because the column is descending.
//  * numbers compare numerically (so 9 < 10, not "10" < "9"), including numeric
//    strings coming back from Postgres as text.
//  * date-ish strings compare chronologically via Date.parse.
//  * everything else compares case-insensitively, numeric-aware, so names like
//    "AP-2" and "AP-10" order the way a human expects.
function cmpValues(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;   // deliberately not negated by `dir` — see above
  if (bEmpty) return -1;

  const an = typeof a === 'number' ? a : Number(a);
  const bn = typeof b === 'number' ? b : Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== '') {
    return an - bn;
  }
  const as = String(a);
  const bs = String(b);
  const ad = Date.parse(as);
  const bd = Date.parse(bs);
  if (!Number.isNaN(ad) && !Number.isNaN(bd) && /\d{4}-\d{2}-\d{2}/.test(as) && /\d{4}-\d{2}-\d{2}/.test(bs)) {
    return ad - bd;
  }
  return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' });
}

/** Returns a NEW sorted array; never mutates the input. Unknown key = unchanged. */
export function sortRows<T>(
  rows: T[],
  sort: SortState,
  accessors: Record<string, (row: T) => unknown>,
): T[] {
  if (!sort) return rows;
  const get = accessors[sort.key];
  if (!get) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = get(x);
    const b = get(y);
    const aEmpty = a === null || a === undefined || a === '';
    const bEmpty = b === null || b === undefined || b === '';
    // Empties stay last in BOTH directions, so don't let `dir` flip them.
    if (aEmpty || bEmpty) return cmpValues(a, b);
    return cmpValues(a, b) * dir;
  });
}

/** Clickable sortable header cell. Matches the arrows used elsewhere: ▲ ▼ ↕ */
export function SortTh({ label, col, sort, onSort, align = 'left', style }: {
  label: string;
  col: string;
  sort: SortState;
  onSort: (col: string) => void;
  align?: 'left' | 'right' | 'center';
  style?: React.CSSProperties;
}) {
  const active = sort?.key === col;
  return (
    <th
      onClick={() => onSort(col)}
      role="columnheader"
      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title={`Sort by ${label}`}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', textAlign: align, ...style }}
    >
      {label}
      <span style={{ marginLeft: 4, fontSize: 'var(--text-xs)',
        color: active ? 'var(--primary)' : 'var(--text-muted)', opacity: active ? 1 : 0.55 }}>
        {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </th>
  );
}

// ════════════════════════════════════════════════════════════
// Operational-clarity primitives (1.115.0)
//
// These exist because the app had to answer four questions on every page —
// what needs attention, how fresh/certain is it, what is affected, where do I
// go next — and the pieces that answer them (a definition next to a count, a
// freshness stamp, a severity that is readable without colour, an empty state
// that says WHY it is empty) were being hand-rolled per page or omitted.
// Everything below is defined at module scope; never nest a component.
// ════════════════════════════════════════════════════════════

// ── URL-backed tab state ──────────────────────────────────────
//
// Reads `?<key>=` on mount and on Back/Forward, writes it with
// history.pushState. Deliberately NOT useSearchParams(): that opts a
// statically-prerendered client page out of static rendering (the reason
// wireless/page.tsx hand-rolled this), and the whole app is client pages.
// pushState (not replaceState) is what makes Back return to the previous tab.
export function useUrlTab<T extends string>(key: string, valid: readonly T[], fallback: T) {
  const [tab, setTabState] = useState<T>(fallback);
  // Mount + Back/Forward: adopt whatever the URL says.
  useEffect(() => {
    const read = () => {
      const v = new URLSearchParams(window.location.search).get(key);
      if (v && (valid as readonly string[]).includes(v)) setTabState(v as T);
      else setTabState(fallback);
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
    // `valid` is a literal array at every call site; re-running on identity
    // changes would reset the tab on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fallback]);
  const setTab = useCallback((v: T, extra?: Record<string, string | number | null>) => {
    setTabState(v);
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (v === fallback) sp.delete(key); else sp.set(key, v);
    if (extra) {
      for (const [k, val] of Object.entries(extra)) {
        if (val === null || val === '') sp.delete(k); else sp.set(k, String(val));
      }
    }
    const qs = sp.toString();
    window.history.pushState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [key, fallback]);
  return { tab, setTab, setTabState };
}

/** Read one query-string param on mount and on Back/Forward (no useSearchParams). */
export function useUrlParam(key: string): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setV(new URLSearchParams(window.location.search).get(key));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [key]);
  return v;
}

/** Merge params into the current URL without a navigation (used for filters). */
export function setUrlParams(patch: Record<string, string | number | boolean | null | undefined>, push = false) {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams(window.location.search);
  for (const [k, val] of Object.entries(patch)) {
    if (val === null || val === undefined || val === '' || val === false) sp.delete(k);
    else sp.set(k, String(val));
  }
  const qs = sp.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

// ── Semantic tabs (role=tablist, arrow-key roving focus) ──────
export interface TabDef<T extends string> { key: T; label: string; count?: number | null; title?: string }
export function Tabs<T extends string>({ tabs, active, onChange, sticky = false, ariaLabel }: {
  tabs: ReadonlyArray<TabDef<T>>;
  active: T;
  onChange: (k: T) => void;
  sticky?: boolean;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function onKeyDown(e: React.KeyboardEvent) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.key === active);
    let n = i;
    if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = tabs.length - 1;
    onChange(tabs[n].key);
    // Move focus with the selection so the roving tabindex stays truthful.
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>(`[data-tabkey="${tabs[n].key}"]`)?.focus();
    });
  }
  return (
    <div
      ref={ref}
      className={`sv-tabs${sticky ? ' sticky' : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`tab-${t.key}`}
            data-tabkey={t.key}
            aria-selected={on}
            aria-controls={`tabpanel-${t.key}`}
            tabIndex={on ? 0 : -1}
            title={t.title}
            className={`sv-tab${on ? ' active' : ''}`}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            {t.count !== undefined && t.count !== null && (
              <span className="sv-tab-count">{t.count.toLocaleString()}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel half of <Tabs>. One per tab key; render only the active one. */
export function TabPanel({ tabKey, children }: { tabKey: string; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`tabpanel-${tabKey}`} aria-labelledby={`tab-${tabKey}`} tabIndex={-1}>
      {children}
    </div>
  );
}

// ── Severity / status, readable without colour ────────────────
//
// A bare coloured dot fails both colour-blind users and a greyscale print, and
// it reads identically whether it means "critical" or "acknowledged". Every
// severity now carries a glyph AND a word.
export type SevKind = 'critical' | 'warning' | 'info' | 'ok' | 'unknown' | 'stale';
const SEV_META: Record<SevKind, { glyph: string; label: string; tint: string; fg: string }> = {
  critical: { glyph: '▲', label: 'Critical', tint: 'var(--tint-danger)',  fg: 'var(--tint-danger-fg)' },
  warning:  { glyph: '◆', label: 'Warning',  tint: 'var(--tint-warn)',    fg: 'var(--tint-warn-fg)' },
  info:     { glyph: '●', label: 'Info',     tint: 'var(--tint-info)',    fg: 'var(--tint-info-fg)' },
  ok:       { glyph: '✓', label: 'OK',       tint: 'var(--tint-success)', fg: 'var(--tint-success-fg)' },
  unknown:  { glyph: '?', label: 'Unknown',  tint: 'var(--surface-subtle)', fg: 'var(--text-muted)' },
  stale:    { glyph: '◴', label: 'Stale',    tint: 'var(--surface-subtle)', fg: 'var(--text-muted)' },
};
export function sevKind(s: string | null | undefined): SevKind {
  const v = (s || '').toLowerCase();
  if (v === 'critical' || v === 'down' || v === 'offline' || v === 'error') return 'critical';
  if (v === 'warning' || v === 'warn' || v === 'degraded') return 'warning';
  if (v === 'up' || v === 'online' || v === 'ok' || v === 'resolved' || v === 'healthy') return 'ok';
  if (v === 'info') return 'info';
  if (v === 'stale') return 'stale';
  return 'unknown';
}
/** Severity/status as glyph + word + colour. `label` overrides the default word. */
export function SevTag({ sev, label, title }: { sev: SevKind | string; label?: string; title?: string }) {
  const k = (SEV_META as any)[sev] ? (sev as SevKind) : sevKind(String(sev));
  const m = SEV_META[k];
  return (
    <span className="sv-sevtag" style={{ background: m.tint, color: m.fg }} title={title || label || m.label}>
      <span aria-hidden="true" className="sv-sevtag-glyph">{m.glyph}</span>
      {label || m.label}
    </span>
  );
}

// ── Accessible info disclosure ────────────────────────────────
//
// A real button + popover, not a title=. Keyboard reachable, Escape closes,
// and the text is in the accessibility tree rather than only on hover.
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <span className="sv-infotip" ref={ref}>
      <button
        type="button"
        className="sv-infotip-btn"
        aria-label={`What does “${label}” mean?`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        i
      </button>
      {open && <span className="sv-infotip-pop" id={id} role="note">{children}</span>}
    </span>
  );
}

// ── Freshness ─────────────────────────────────────────────────
//
// "Updated 2s ago" is only useful next to what it describes and only honest if
// it goes visibly stale. `staleAfterMs` marks the point past which the value
// stops being presented as current.
export function Freshness({ at, staleAfterMs = 15 * 60 * 1000, label = 'Updated', prefixWhenStale = 'Last updated' }: {
  at: string | number | Date | null | undefined;
  staleAfterMs?: number;
  label?: string;
  prefixWhenStale?: string;
}) {
  const [, force] = useState(0);
  // Everything this renders is relative to the CURRENT time, and several
  // callers pass a client-generated `Date.now()`. Rendering that during SSR
  // produces a value one tick different from the client's, which React reports
  // as a hydration mismatch (observed on /services: title "…5:46:52 PM" vs
  // "…5:46:53 PM"). Nothing is shown until mounted, after which it is purely a
  // client-side concern.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // Re-render on a slow tick so "2m ago" does not freeze at "2s ago".
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  if (!mounted) return <span className="sv-fresh" />;
  if (!at) return <span className="sv-fresh unknown">Never updated</span>;
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return <span className="sv-fresh unknown">Never updated</span>;
  const stale = Date.now() - ms > staleAfterMs;
  return (
    <span className={`sv-fresh${stale ? ' stale' : ''}`} title={new Date(ms).toLocaleString()}>
      {stale && <span aria-hidden="true" className="sv-fresh-glyph">◴</span>}
      {stale ? prefixWhenStale : label} {fmtRel(new Date(ms).toISOString())}
    </span>
  );
}

// ── Metric card ───────────────────────────────────────────────
//
// A number on an operations console is meaningless without its denominator,
// its window and its scope. `definition` is the disclosure; `window` and
// `scope` render inline so they are visible without interaction.
export function MetricCard({ value, label, definition, window: win, scope, tone = 'neutral', sub, onClick, href }: {
  value: React.ReactNode;
  label: string;
  definition?: React.ReactNode;
  window?: string;
  scope?: string;
  tone?: 'neutral' | 'critical' | 'warning' | 'ok' | 'info';
  sub?: React.ReactNode;
  onClick?: () => void;
  href?: string;
}) {
  // The card is ALWAYS a <div>, and only the value is the control.
  //
  // Making the whole card a <button>/<a> put the definition's own button
  // inside it — invalid HTML ("<button> cannot be a descendant of <button>"),
  // a hydration error, and one of the two controls unreachable. A stretched
  // overlay link is not the answer either: that is the 1.88.1 bug in this
  // codebase, where a stretched link swallowed two thirds of a header's
  // clicks. So the number is the link and the disclosure sits beside it,
  // each independently clickable and independently focusable.
  const interactive = !!(href || onClick);
  const valueEl = href
    ? <a className="sv-metric-action" href={href}>{value}</a>
    : onClick
      ? <button type="button" className="sv-metric-action" onClick={onClick}>{value}</button>
      : value;
  return (
    <div className={`sv-metric tone-${tone}${interactive ? ' interactive' : ''}`}>
      <div className="sv-metric-value">{valueEl}</div>
      <div className="sv-metric-label">
        {label}
        {definition && <InfoTip label={label}>{definition}</InfoTip>}
      </div>
      {(win || scope) && (
        <div className="sv-metric-meta">{[win, scope].filter(Boolean).join(' · ')}</div>
      )}
      {sub && <div className="sv-metric-sub">{sub}</div>}
    </div>
  );
}

// ── Filter bar + active-filter summary ────────────────────────
export function FilterBar({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="sv-filterbar">
      <div className="sv-filterbar-controls">{children}</div>
      {right && <div className="sv-filterbar-right">{right}</div>}
    </div>
  );
}
export interface ActiveFilter { key: string; label: string; onClear: () => void }
export function ActiveFilters({ filters, onClearAll, resultLabel }: {
  filters: ActiveFilter[];
  onClearAll: () => void;
  resultLabel?: React.ReactNode;
}) {
  if (!filters.length) return resultLabel ? <div className="sv-activefilters"><span className="sv-muted">{resultLabel}</span></div> : null;
  return (
    <div className="sv-activefilters">
      <span className="sv-activefilters-lbl">Filtered by</span>
      {filters.map((f) => (
        <button key={f.key} type="button" className="sv-filterchip" onClick={f.onClear}
          aria-label={`Remove filter ${f.label}`}>
          {f.label}<span aria-hidden="true">×</span>
        </button>
      ))}
      <button type="button" className="sv-link-btn" onClick={onClearAll}>Clear all</button>
      {resultLabel && <span className="sv-muted" style={{ marginLeft: 'auto' }}>{resultLabel}</span>}
    </div>
  );
}

// ── State boxes ───────────────────────────────────────────────
//
// Four distinct reasons a panel can be empty. Collapsing them into one
// "No data" is how a failed request reads as a clean network.
export function NoResults({ message = 'No records match the current filters.', onClear }: { message?: string; onClear?: () => void }) {
  return (
    <div className="sv-state sv-state-empty" role="status">
      <div className="sv-state-title">No matching results</div>
      <div className="sv-state-msg">{message}</div>
      {onClear && <button type="button" className="sv-btn ghost" style={{ marginTop: 12 }} onClick={onClear}>Clear filters</button>}
    </div>
  );
}
export function FirstUse({ title, message, actionLabel, onAction, href }: {
  title: string; message: string; actionLabel?: string; onAction?: () => void; href?: string;
}) {
  return (
    <div className="sv-state sv-state-firstuse">
      <div className="sv-state-title">{title}</div>
      <div className="sv-state-msg">{message}</div>
      {actionLabel && href && <a className="sv-btn" style={{ marginTop: 14 }} href={href}>{actionLabel}</a>}
      {actionLabel && !href && onAction && <button type="button" className="sv-btn" style={{ marginTop: 14 }} onClick={onAction}>{actionLabel}</button>}
    </div>
  );
}
export function LoadError({ message, onRetry, what = 'this data' }: { message?: string; onRetry?: () => void; what?: string }) {
  return (
    <div className="sv-state sv-state-error" role="alert">
      <div className="sv-state-title">Could not load {what}</div>
      <div className="sv-state-msg">
        {message || 'The request failed.'} This is a failure to read the data, not a report that there is none.
      </div>
      {onRetry && <button type="button" className="sv-btn ghost" style={{ marginTop: 12 }} onClick={onRetry}>Try again</button>}
    </div>
  );
}
export function NoAccess({ what = 'this section' }: { what?: string }) {
  return (
    <div className="sv-state sv-state-noaccess" role="status">
      <div className="sv-state-title">You do not have access to {what}</div>
      <div className="sv-state-msg">Your role does not include this view. Access is managed in NetVault.</div>
    </div>
  );
}

/** Inline, non-blocking notice that the values shown are not current. */
export function StaleNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="sv-notice warn" role="status">
      <span aria-hidden="true">◴</span>
      <span>{children}</span>
    </div>
  );
}
/** Inline notice, neutral/info tone. */
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: React.ReactNode }) {
  return <div className={`sv-notice ${tone}`} role="status">{children}</div>;
}

// ── Scrollable table wrapper that keeps its identity ──────────
//
// `.sv-table-scroll` on its own is an unlabelled scroll region: a keyboard user
// lands in it with no idea what it is, and at narrow widths the entity column
// scrolls out of sight. This adds the accessible name and keyboard focus the
// bare class never had.
export function TableScroll({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`sv-table-scroll ${className}`} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

// ── Row action menu (kebab) ───────────────────────────────────
//
// Promoted out of services/page.tsx (where it was `ServiceRowMenu`) so the
// wireless controller rows stop repeating four small buttons per row. Anchored
// with position:fixed measured from the trigger because `.sv-table-scroll`
// computes overflow-y to auto and would otherwise clip an absolute popup.
// Destructive items stay visually separated and still go through their own
// confirmation at the call site.
export interface RowMenuItem { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string }
export function RowMenu({ items, label = 'More actions' }: { items: RowMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const usable = items.filter((i) => !i.disabled);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    // Capture phase: the wrapper / page scrollers don't bubble their scroll events.
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[cursor]?.focus();
  }, [open, cursor]);
  function toggle() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setCursor(0);
    setOpen((o) => !o);
  }
  function onMenuKey(e: React.KeyboardEvent) {
    if (!usable.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % usable.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + usable.length) % usable.length); }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
    else if (e.key === 'End') { e.preventDefault(); setCursor(usable.length - 1); }
  }
  if (!items.length) return null;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btnRef}
        type="button"
        className="sv-btn ghost sm"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        style={{ height: 26, padding: '0 8px' }}
      >
        ⋮
      </button>
      {open && pos && (
        <span
          ref={menuRef}
          className="sv-dropdown"
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 50, minWidth: 170 }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              title={it.title}
              disabled={it.disabled}
              className={`sv-dropdown-item${it.danger ? ' danger' : ''}`}
              onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}
            >
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

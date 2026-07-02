import type { CSSProperties } from 'react';

/**
 * Shared report-output style constants for every report template in
 * components/reports/*.
 *
 * These used to be re-declared (and had drifted) in each report file. They are
 * canonicalised here once so all print/PDF deliverables share identical
 * letterhead-quality styling. Prefer these over local copies.
 *
 * Canonical values (the majority variant): stat value = --text-2xl,
 * stat grid = minmax(180px), stat card padding = 12px 16px.
 *
 * All values use design tokens (var(--text-*) / color tokens) so they flip
 * correctly in dark mode — no hardcoded hex that duplicates a token.
 */

// Small uppercase muted section heading above each panel.
export const SECTION_TITLE: CSSProperties = {
  fontSize: 'var(--text-sm)',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  letterSpacing: '0.06em',
  margin: '0 0 8px',
};

// Standard panel inner padding (used with the .sv-panel class).
export const PANEL: CSSProperties = { padding: 16 };

// Responsive grid of headline stat cards.
export const STAT_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
  alignItems: 'stretch',
};

// A single headline stat card. Cards typically override borderLeftColor per
// metric (green/red/yellow/primary); the neutral default is a muted grey.
export const STAT_CARD: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderLeftWidth: 3,
  borderLeftColor: 'var(--text-muted)',
  borderRadius: 'var(--radius-sm)',
  padding: '12px 16px',
  minHeight: 75,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
};

// The large number inside a stat card.
export const STAT_VALUE: CSSProperties = { fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.1 };

// The small uppercase caption beneath a stat value.
export const STAT_LABEL: CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  letterSpacing: '0.04em',
  marginTop: 4,
};

// Table header cell.
export const TH: CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  padding: '8px 12px',
  textAlign: 'left',
};

// Table body cell.
export const TD: CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--text-primary)',
  padding: '8px 12px',
  height: 36,
};

// Right-aligned numeric header / cell helpers.
export const numTh: CSSProperties = { ...TH, textAlign: 'right' };
export const numCell: CSSProperties = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

// Chart card (fixed padding, avoids breaking across print pages) and its title/note.
export const CHART_CARD: CSSProperties = { padding: 16, breakInside: 'avoid' };
export const CHART_TITLE: CSSProperties = { ...SECTION_TITLE, margin: '0 0 4px' };
export const CHART_NOTE: CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontStyle: 'italic' };

// Shared recharts tooltip styling — recharts' built-in tooltip background is a
// hardcoded white box that doesn't flip in dark mode, so theme it with tokens.
export const TOOLTIP_STYLE = {
  contentStyle: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)' },
  labelStyle: { color: 'var(--text-muted)' },
  itemStyle: { color: 'var(--text-primary)' },
};

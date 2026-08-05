'use client';

import { useEffect, useState } from 'react';
import { getCorners, applyCorners, type Corners } from '@/lib/corners';

/**
 * Rounded / Square corner-style switch, rendered as a row INSIDE the avatar
 * dropdown (see <TopBar />) — label on the left, a compact two-segment
 * control on the right. It follows the same "dropdown row" presentation
 * <ThemeToggle variant="item" /> uses, so the two read as siblings in the menu.
 *
 * Colour note: this now sits on the dropdown panel (`.sv-dropdown`), which is a
 * CARD surface (`--bg-card` + `--border`) — NOT the navy top bar. So it is
 * styled with the ordinary card/text tokens. The old translucent-white-over-
 * navy treatment was only correct while it lived in `.sv-topbar`; on a card it
 * would be invisible. No hex is hardcoded and nothing here breaks dark mode;
 * sizing and radius still come from the design tokens (`--text-xs`,
 * `--radius`, `--radius-sm`) so the control itself visibly reflects the
 * setting it controls.
 *
 * Styles are inline because globals.css is not this component's to edit.
 */

const SEG_BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 8px',
  border: '1px solid transparent',
  borderRadius: 'var(--radius-sm)',
  background: 'transparent',
  font: 'inherit',
  fontSize: 'var(--text-xs)',
  fontWeight: 700,
  letterSpacing: '0.02em',
  lineHeight: 1,
  cursor: 'pointer',
  transition: 'background 0.12s, color 0.12s, border-color 0.12s',
};

/**
 * Module-level on purpose. A component defined inside another component is
 * remounted on every parent render (focus loss, lost state) — see the
 * "No sub-components inside React components" rule in spanvault/CLAUDE.md.
 */
function CornerSeg({
  value,
  label,
  active,
  onSelect,
}: {
  value: Corners;
  label: string;
  active: boolean;
  onSelect: (v: Corners) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={`${label} corners`}
      onClick={() => onSelect(value)}
      style={{
        ...SEG_BASE,
        background: active ? 'var(--bg-card)' : 'transparent',
        borderColor: active ? 'var(--border)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
      }}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx={value === 'rounded' ? 6 : 0} />
      </svg>
      {label}
    </button>
  );
}

export default function CornersToggle() {
  // MUST start at 'rounded': the real value lives on the <html> element and is
  // stamped there by the no-flash inline script, which does not run during
  // server rendering. Reading it at render time would make SSR and the first
  // client render disagree -> hydration mismatch. Read it in an effect instead.
  const [corners, setCorners] = useState<Corners>('rounded');

  useEffect(() => {
    setCorners(getCorners());
    const onCorners = (e: Event) => setCorners((e as CustomEvent).detail as Corners);
    window.addEventListener('sv:corners', onCorners);
    return () => window.removeEventListener('sv:corners', onCorners);
  }, []);

  const select = (v: Corners) => {
    if (v === corners) return;
    applyCorners(v);
    setCorners(v);
  };

  return (
    // `.sv-dropdown-item` so padding / font-size / radius / hover match the
    // neighbouring menu entries exactly. The row itself isn't clickable (the
    // two segments are), hence the default cursor override.
    <div className="sv-dropdown-item" style={{ cursor: 'default' }}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
      </svg>
      <span>Corners</span>
      <span className="spacer" />
      <span
        role="radiogroup"
        aria-label="Corner style"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          padding: 2,
          borderRadius: 'var(--radius)',
          background: 'var(--surface-subtle)',
          border: '1px solid var(--border)',
        }}
      >
        <CornerSeg value="rounded" label="Rounded" active={corners === 'rounded'} onSelect={select} />
        <CornerSeg value="square" label="Square" active={corners === 'square'} onSelect={select} />
      </span>
    </div>
  );
}

'use client';

/**
 * Corner-style (rounded vs square) handling for the NocVault suite.
 * The choice is stored in localStorage and applied as a `data-corners`
 * attribute on <html>; the square overrides live in globals.css under
 * :root[data-corners="square"] (which zeroes --radius/--radius-sm/--radius-pill).
 *
 * ROUNDED IS THE ABSENCE OF THE ATTRIBUTE — the default token values in
 * :root already are the rounded ones, so 'rounded' REMOVES the attribute
 * rather than setting it to "rounded". That keeps the CSS to a single
 * override block and means a browser with nothing stored renders rounded.
 *
 * A no-flash inline script in the root layout applies the saved value
 * before paint, so this module only needs to read/toggle at runtime.
 *
 * Storage key/event use the `sv-` / `sv:` prefix to match theme.ts — two
 * suite apps served from the same origin would otherwise collide on a
 * generic key.
 */
export type Corners = 'rounded' | 'square';

export const CORNERS_KEY = 'sv-corners';

export function getCorners(): Corners {
  if (typeof document === 'undefined') return 'rounded';
  return document.documentElement.getAttribute('data-corners') === 'square' ? 'square' : 'rounded';
}

export function applyCorners(corners: Corners) {
  if (typeof document === 'undefined') return;
  if (corners === 'square') {
    document.documentElement.setAttribute('data-corners', 'square');
  } else {
    document.documentElement.removeAttribute('data-corners');
  }
  try { localStorage.setItem(CORNERS_KEY, corners); } catch { /* ignore */ }
  // Let any open component (header switch, dropdown) re-sync its state.
  window.dispatchEvent(new CustomEvent('sv:corners', { detail: corners }));
}

export function toggleCorners(): Corners {
  const next: Corners = getCorners() === 'square' ? 'rounded' : 'square';
  applyCorners(next);
  return next;
}

/** Inline <script> body that sets data-corners before first paint. */
export const CORNERS_INIT_SCRIPT =
  `(function(){try{var c=localStorage.getItem('${CORNERS_KEY}');if(c==='square'){document.documentElement.setAttribute('data-corners','square');}}catch(e){}})();`;

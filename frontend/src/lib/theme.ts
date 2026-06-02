'use client';

/**
 * Dark-mode theme handling for the NocVault suite.
 * The theme is stored in localStorage and applied as a `data-theme`
 * attribute on <html>; dark tokens live in globals.css under
 * [data-theme="dark"]. A no-flash inline script in the root layout
 * applies the saved theme before paint, so this module only needs to
 * read/toggle at runtime.
 */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'sv-theme';

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  // Let any open component (header toggle, dropdown) re-sync its icon.
  window.dispatchEvent(new CustomEvent('spanvault:theme', { detail: theme }));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** Inline <script> body that sets data-theme before first paint. */
export const THEME_INIT_SCRIPT =
  `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

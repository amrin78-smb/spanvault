'use client';

import { useEffect } from 'react';

/**
 * Suite-standard global keyboard shortcuts:
 *   /  → focus the global search bar
 *   R  → refresh the current view (components subscribe via useRefreshKey)
 *   Escape → close modals (handled per-component via useEscape / GlobalSearch)
 *   Ctrl/Cmd+K → command palette (handled in GlobalSearch)
 *
 * Shortcuts are ignored while typing in an input, textarea, select, or any
 * contentEditable element so they never hijack normal typing.
 */
function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    node.isContentEditable === true
  );
}

export default function KeyboardShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;

      if (e.key === '/') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('spanvault:focus-search'));
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('spanvault:refresh'));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return null;
}

'use client';

import { useEffect, useState } from 'react';
import { getTheme, toggleTheme, type Theme } from '@/lib/theme';
import { IconSun, IconMoon } from './icons';

/**
 * Dark-mode toggle. Two render modes:
 *  - variant="icon"  → header icon button (default)
 *  - variant="item"  → full-width row used inside the avatar dropdown
 */
export default function ThemeToggle({ variant = 'icon' }: { variant?: 'icon' | 'item' }) {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(getTheme());
    const onTheme = (e: Event) => setTheme((e as CustomEvent).detail as Theme);
    window.addEventListener('spanvault:theme', onTheme);
    return () => window.removeEventListener('spanvault:theme', onTheme);
  }, []);

  const isDark = theme === 'dark';
  const handle = () => setTheme(toggleTheme());

  if (variant === 'item') {
    return (
      <button className="sv-dropdown-item" onClick={handle}>
        {isDark ? <IconSun width={16} height={16} /> : <IconMoon width={16} height={16} />}
        {isDark ? 'Light mode' : 'Dark mode'}
      </button>
    );
  }

  return (
    <button
      className="sv-icon-btn"
      onClick={handle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle dark mode"
    >
      {isDark ? <IconSun width={18} height={18} /> : <IconMoon width={18} height={18} />}
    </button>
  );
}

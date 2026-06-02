'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { IconSearch } from '@/components/icons';

type Device = {
  id: number; name: string; ip_address: string;
  site_name: string | null; current_status: string;
};

/**
 * Always-visible device search in the top bar. Queries /api/devices?q=X with a
 * debounce and shows a results dropdown; clicking a result navigates to the
 * device detail page. On narrow screens the field collapses to a magnifier
 * icon that expands on click. The Ctrl/Cmd+K command palette (GlobalSearch)
 * remains available independently.
 */
export default function TopBarSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);   // results dropdown
  const [expanded, setExpanded] = useState(false);   // mobile field reveal
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  // Close the dropdown (and collapse on mobile) when clicking outside.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpenMenu(false);
        setExpanded(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Suite-standard "/" shortcut focuses the search (dispatched by KeyboardShortcuts).
  useEffect(() => {
    function onFocusSearch() {
      setExpanded(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    window.addEventListener('spanvault:focus-search', onFocusSearch);
    return () => window.removeEventListener('spanvault:focus-search', onFocusSearch);
  }, []);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); setLoading(false); setOpenMenu(false); return; }
    setLoading(true);
    setOpenMenu(true);
    const myId = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const data = await apiGet<Device[]>(`/api/devices?q=${encodeURIComponent(term)}`);
        if (myId === reqId.current) setResults(data);
      } catch {
        if (myId === reqId.current) setResults([]);
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  function go(id: number) {
    setQ('');
    setResults([]);
    setOpenMenu(false);
    setExpanded(false);
    router.push(`/devices/${id}`);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setQ('');
      setOpenMenu(false);
      setExpanded(false);
      inputRef.current?.blur();
    }
  }

  function toggleMobile() {
    setExpanded((v) => {
      const next = !v;
      if (next) setTimeout(() => inputRef.current?.focus(), 0);
      return next;
    });
  }

  return (
    <div className={`sv-tbsearch ${expanded ? 'open' : ''}`} ref={ref}>
      <button className="sv-tbsearch-toggle" onClick={toggleMobile} title="Search devices" aria-label="Search devices">
        <IconSearch width={18} height={18} />
      </button>
      <div className="sv-tbsearch-field">
        <IconSearch width={15} height={15} className="sv-tbsearch-glass" />
        <input
          ref={inputRef}
          className="sv-tbsearch-input"
          placeholder="Search devices…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => { if (results.length) setOpenMenu(true); }}
          onKeyDown={onKey}
        />
        <span className="sv-tbsearch-kbd">/</span>
      </div>
      {openMenu && (
        <div className="sv-tbsearch-menu">
          {loading && <div className="sv-search-hint">Searching…</div>}
          {!loading && q.trim() && results.length === 0 && (
            <div className="sv-search-hint">No devices match “{q.trim()}”.</div>
          )}
          {results.map((d) => (
            <button key={d.id} className="sv-search-item" onClick={() => go(d.id)}>
              <StatusDot status={d.current_status} size={9} />
              <span className="nm">{d.name}</span>
              <span className="ip">{d.ip_address}</span>
              <span className="site">{d.site_name || 'Unassigned'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

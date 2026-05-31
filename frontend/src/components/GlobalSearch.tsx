'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';

type Device = {
  id: number; name: string; ip_address: string;
  site_name: string | null; current_status: string;
};

/** Ctrl/Cmd+K command palette to jump to any device by name or IP. */
export default function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  // Global keyboard shortcuts: Ctrl/Cmd+K toggles, Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset and focus when opened.
  useEffect(() => {
    if (open) {
      setQ('');
      setResults([]);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) { setResults([]); setLoading(false); return; }
    setLoading(true);
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
  }, [q, open]);

  function go(id: number) {
    setOpen(false);
    router.push(`/devices/${id}`);
  }

  if (!open) return null;

  return (
    <div className="sv-search-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="sv-search-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="sv-search-input"
          placeholder="Search devices by name or IP…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="sv-search-results">
          {loading && <div className="sv-search-hint">Searching…</div>}
          {!loading && q.trim() && results.length === 0 && (
            <div className="sv-search-hint">No devices match “{q.trim()}”.</div>
          )}
          {!loading && !q.trim() && (
            <div className="sv-search-hint">Type to search. Press Esc to close.</div>
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
      </div>
    </div>
  );
}

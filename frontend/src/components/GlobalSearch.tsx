'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';

type DeviceHit = { id: number; name: string; ip_address: string | null; site_name: string | null };
type ApHit = { id: number; name: string; ip_address: string | null; site_name: string | null };
type ControllerHit = { id: number; name: string; site_name: string | null };

type GlobalSearchResults = {
  devices: DeviceHit[];
  aps: ApHit[];
  controllers: ControllerHit[];
};

const EMPTY_RESULTS: GlobalSearchResults = { devices: [], aps: [], controllers: [] };

// Type accent dots (raw signal colors — tokens flip with the theme).
const TYPE_DOT: Record<'device' | 'ap' | 'controller', string> = {
  device: 'var(--primary)',
  ap: 'var(--green)',
  controller: 'var(--purple)',
};

// A single result row. Top-level (suite rule: never define a component inside a
// component — it remounts every keystroke and drops input focus).
function SearchRow({ dot, name, ip, site, onClick }: {
  dot: string;
  name: string;
  ip?: string | null;
  site: string | null;
  onClick: () => void;
}) {
  return (
    <button className="sv-search-item" onClick={onClick}>
      <span
        className="sv-status-dot"
        style={{ width: 9, height: 9, background: dot }}
        aria-hidden
      />
      <span className="nm">{name}</span>
      {ip ? <span className="ip">{ip}</span> : null}
      <span className="site">{site || 'Unassigned'}</span>
    </button>
  );
}

// A labelled result group. Hidden entirely when it has no rows. Top-level for the
// same focus-stability reason as SearchRow.
function SearchGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          fontSize: 'var(--text-xs)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: 600,
          color: 'var(--text-muted)',
          padding: '8px 12px 4px',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/** Ctrl/Cmd+K command palette to jump to any device, access point, or controller. */
export default function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GlobalSearchResults>(EMPTY_RESULTS);
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
      setResults(EMPTY_RESULTS);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced search across devices, access points, and controllers.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) { setResults(EMPTY_RESULTS); setLoading(false); return; }
    setLoading(true);
    const myId = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const data = await apiGet<GlobalSearchResults>(`/api/global-search?q=${encodeURIComponent(term)}`);
        if (myId === reqId.current) {
          setResults({
            devices: data?.devices ?? [],
            aps: data?.aps ?? [],
            controllers: data?.controllers ?? [],
          });
        }
      } catch {
        if (myId === reqId.current) setResults(EMPTY_RESULTS);
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  function goDevice(id: number) {
    setOpen(false);
    router.push(`/devices/${id}`);
  }

  // The Wireless page is tab-based and only deep-links by ?tab=; it has no
  // per-AP / per-controller route yet, so land on the matching tab. (A future
  // ?ap=/?controller= deep-link could focus the specific row.)
  function goAp(_id: number) {
    setOpen(false);
    router.push('/wireless?tab=aps');
  }

  function goController(_id: number) {
    setOpen(false);
    router.push('/wireless?tab=controllers');
  }

  if (!open) return null;

  const term = q.trim();
  const total = results.devices.length + results.aps.length + results.controllers.length;

  return (
    <div className="sv-search-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="sv-search-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="sv-search-input"
          placeholder="Search devices, access points, controllers…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="sv-search-results">
          {loading && <div className="sv-search-hint">Searching…</div>}
          {!loading && term && total === 0 && (
            <div className="sv-search-hint">No results match “{term}”.</div>
          )}
          {!loading && !term && (
            <div className="sv-search-hint">Type to search. Press Esc to close.</div>
          )}

          {!loading && results.devices.length > 0 && (
            <SearchGroup label="Devices">
              {results.devices.map((d) => (
                <SearchRow
                  key={`device-${d.id}`}
                  dot={TYPE_DOT.device}
                  name={d.name}
                  ip={d.ip_address}
                  site={d.site_name}
                  onClick={() => goDevice(d.id)}
                />
              ))}
            </SearchGroup>
          )}

          {!loading && results.aps.length > 0 && (
            <SearchGroup label="Access Points">
              {results.aps.map((a) => (
                <SearchRow
                  key={`ap-${a.id}`}
                  dot={TYPE_DOT.ap}
                  name={a.name}
                  ip={a.ip_address}
                  site={a.site_name}
                  onClick={() => goAp(a.id)}
                />
              ))}
            </SearchGroup>
          )}

          {!loading && results.controllers.length > 0 && (
            <SearchGroup label="Controllers">
              {results.controllers.map((c) => (
                <SearchRow
                  key={`controller-${c.id}`}
                  dot={TYPE_DOT.controller}
                  name={c.name}
                  site={c.site_name}
                  onClick={() => goController(c.id)}
                />
              ))}
            </SearchGroup>
          )}
        </div>
      </div>
    </div>
  );
}

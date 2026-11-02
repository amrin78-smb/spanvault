'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { useFocusTrap } from '@/components/ui';
import { entityHref, announceWirelessTarget, ENTITY_DESTINATION, type EntityKind } from '@/lib/entityLinks';

type DeviceHit = { id: number; name: string; ip_address: string | null; site_name: string | null };
type ApHit = { id: number; name: string; ip_address: string | null; site_name: string | null };
type ControllerHit = { id: number; name: string; site_name: string | null };
type ServiceHit = { id: number; name: string; type: string; target: string; site_name: string | null };
type ClientHit = { id: number; mac_address: string; ip_address: string | null; hostname: string | null; ap_name: string | null; site_name: string | null };

type GlobalSearchResults = {
  devices: DeviceHit[];
  aps: ApHit[];
  controllers: ControllerHit[];
  services: ServiceHit[];
  clients: ClientHit[];
};

const EMPTY_RESULTS: GlobalSearchResults = { devices: [], aps: [], controllers: [], services: [], clients: [] };

// Type accent dots (raw signal colors — tokens flip with the theme).
const TYPE_DOT: Record<EntityKind, string> = {
  device: 'var(--primary)',
  ap: 'var(--green)',
  controller: 'var(--purple)',
  service: 'var(--yellow)',
  client: 'var(--teal)',
  site: 'var(--blue)',
};

/** One flattened, keyboard-navigable result. */
type Row = {
  key: string;
  kind: EntityKind;
  group: string;
  name: string;
  detail: string | null;
  site: string | null;
  href: string;
};

// One ordered list drives both the rendered groups and the keyboard cursor, so
// the highlight can never disagree with what is on screen.
function flatten(r: GlobalSearchResults): Row[] {
  const out: Row[] = [];
  for (const d of r.devices) out.push({ key: `device-${d.id}`, kind: 'device', group: 'Devices', name: d.name, detail: d.ip_address, site: d.site_name, href: entityHref('device', d.id) });
  for (const a of r.aps) out.push({ key: `ap-${a.id}`, kind: 'ap', group: 'Access Points', name: a.name, detail: a.ip_address, site: a.site_name, href: entityHref('ap', a.id) });
  for (const c of r.controllers) out.push({ key: `controller-${c.id}`, kind: 'controller', group: 'Controllers', name: c.name, detail: null, site: c.site_name, href: entityHref('controller', c.id) });
  for (const s of r.services) out.push({ key: `service-${s.id}`, kind: 'service', group: 'Service checks', name: s.name, detail: s.target, site: s.site_name, href: entityHref('service', s.id) });
  for (const c of r.clients) out.push({ key: `client-${c.id}`, kind: 'client', group: 'Wireless clients', name: c.hostname || c.mac_address, detail: [c.ip_address, c.ap_name].filter(Boolean).join(' · ') || c.mac_address, site: c.site_name, href: entityHref('client', c.mac_address) });
  return out;
}

// A single result row. Top-level (suite rule: never define a component inside a
// component — it remounts every keystroke and drops input focus).
function SearchRow({ dot, row, active, optionId, onHover, onClick }: {
  dot: string;
  row: Row;
  active: boolean;
  optionId: string;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <button
      className={`sv-search-item${active ? ' active' : ''}`}
      id={optionId}
      role="option"
      aria-selected={active}
      data-active={active ? 'true' : undefined}
      onMouseEnter={onHover}
      onClick={onClick}
      title={`Open ${ENTITY_DESTINATION[row.kind].toLowerCase()} for ${row.name}`}
    >
      <span className="sv-status-dot" style={{ width: 9, height: 9, background: dot }} aria-hidden />
      <span className="nm">{row.name}</span>
      {row.detail ? <span className="ip">{row.detail}</span> : null}
      <span className="site">{row.site || 'Unassigned'}</span>
    </button>
  );
}

// A labelled result group. Hidden entirely when it has no rows. Top-level for the
// same focus-stability reason as SearchRow.
function SearchGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }} role="group" aria-label={label}>
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

/**
 * Ctrl/Cmd+K command palette to jump to any device, access point, controller,
 * service check or wireless client.
 *
 * Destinations come from lib/entityLinks so this and the top-bar search can
 * never diverge: each result opens the exact entity (an AP opens that AP's
 * drawer via ?tab=aps&apId=, a client its detail panel via ?mac=), not the
 * parent tab. Arrow keys move the selection, Enter opens it, Escape closes.
 */
export default function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GlobalSearchResults>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);
  const listId = useId();
  const trap = useFocusTrap<HTMLDivElement>(open);

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
      setFailed(false);
      setCursor(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced search across devices, APs, controllers, service checks, clients.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) { setResults(EMPTY_RESULTS); setLoading(false); setFailed(false); return; }
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
            services: data?.services ?? [],
            clients: data?.clients ?? [],
          });
          setFailed(false);
          setCursor(0);
        }
      } catch {
        // Distinguish "we could not ask" from "nothing matched".
        if (myId === reqId.current) { setResults(EMPTY_RESULTS); setFailed(true); }
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const rows = useMemo(() => flatten(results), [results]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
    announceWirelessTarget(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!rows.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + rows.length) % rows.length); }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
    else if (e.key === 'End') { e.preventDefault(); setCursor(rows.length - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[Math.min(cursor, rows.length - 1)];
      if (r) go(r.href);
    }
  }

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  if (!open) return null;

  const term = q.trim();
  const groups = ['Devices', 'Access Points', 'Controllers', 'Service checks', 'Wireless clients'];
  const activeId = rows.length ? `${listId}-opt-${Math.min(cursor, rows.length - 1)}` : undefined;
  const statusText = loading ? 'Searching…'
    : failed ? 'Search failed'
    : term && !rows.length ? 'No results'
    : rows.length ? `${rows.length} result${rows.length === 1 ? '' : 's'}` : '';

  return (
    <div className="sv-search-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="sv-search-box"
        ref={trap}
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="sv-search-input"
          placeholder="Search devices, access points, controllers, service checks, clients…"
          aria-label="Search devices, access points, controllers, service checks and wireless clients"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="sv-sr-only" role="status" aria-live="polite">{statusText}</span>
        <div className="sv-search-results" ref={listRef} id={listId} role="listbox" aria-label="Search results">
          {loading && <div className="sv-search-hint">Searching…</div>}
          {!loading && failed && (
            <div className="sv-search-hint" role="alert">
              Search is unavailable right now. This is a failed request, not an empty result.
            </div>
          )}
          {!loading && !failed && term && rows.length === 0 && (
            <div className="sv-search-hint">No results match “{term}”.</div>
          )}
          {!loading && !term && (
            <div className="sv-search-hint">Type to search. ↑ ↓ to move, Enter to open, Esc to close.</div>
          )}

          {!loading && groups.map((g) => {
            const inGroup = rows.filter((r) => r.group === g);
            if (!inGroup.length) return null;
            return (
              <SearchGroup key={g} label={g}>
                {inGroup.map((r) => {
                  const i = rows.indexOf(r);
                  return (
                    <SearchRow
                      key={r.key}
                      row={r}
                      dot={TYPE_DOT[r.kind]}
                      active={i === cursor}
                      optionId={`${listId}-opt-${i}`}
                      onHover={() => setCursor(i)}
                      onClick={() => go(r.href)}
                    />
                  );
                })}
              </SearchGroup>
            );
          })}
        </div>
      </div>
    </div>
  );
}

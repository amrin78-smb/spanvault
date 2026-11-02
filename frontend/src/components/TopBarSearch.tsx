'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { IconSearch } from '@/components/icons';
import { entityHref, announceWirelessTarget, ENTITY_DESTINATION, type EntityKind } from '@/lib/entityLinks';

type Hit = {
  key: string;
  kind: EntityKind;
  name: string;
  detail: string | null;   // IP / target / MAC — whatever identifies the thing
  site: string | null;
  status?: string;         // devices only; nothing else here has a ping status
  href: string;
};

// Short label so each result is self-describing. Without it an AP and a device
// with similar names are indistinguishable in one flat list.
const KIND_LABEL: Record<EntityKind, string> = {
  device: 'Device', ap: 'AP', controller: 'Controller', service: 'Service', client: 'Client', site: 'Site',
};

type GlobalResults = {
  devices?: { id: number; name: string; ip_address: string | null; site_name: string | null; current_status?: string }[];
  aps?: { id: number; name: string; ip_address: string | null; site_name: string | null }[];
  controllers?: { id: number; name: string; site_name: string | null }[];
  services?: { id: number; name: string; type: string; target: string; site_name: string | null }[];
  clients?: { id: number; mac_address: string; ip_address: string | null; hostname: string | null; ap_name: string | null; site_name: string | null }[];
};

// Flatten the grouped API response into one ranked list. Devices first because
// they are what most searches are actually for; clients last because they are
// the most numerous and would otherwise crowd out everything else.
//
// Every href comes from entityHref() — one definition shared with the Ctrl+K
// palette, so the two can no longer send the same entity to different places.
function flatten(d: GlobalResults): Hit[] {
  const out: Hit[] = [];
  for (const x of d.devices || []) out.push({ key: `device-${x.id}`, kind: 'device', name: x.name, detail: x.ip_address, site: x.site_name, status: x.current_status, href: entityHref('device', x.id) });
  for (const x of d.aps || []) out.push({ key: `ap-${x.id}`, kind: 'ap', name: x.name, detail: x.ip_address, site: x.site_name, href: entityHref('ap', x.id) });
  for (const x of d.controllers || []) out.push({ key: `ctl-${x.id}`, kind: 'controller', name: x.name, detail: null, site: x.site_name, href: entityHref('controller', x.id) });
  for (const x of d.services || []) out.push({ key: `svc-${x.id}`, kind: 'service', name: x.name, detail: x.target, site: x.site_name, href: entityHref('service', x.id) });
  for (const x of d.clients || []) {
    // A client's most recognisable identifier is its hostname, but plenty have
    // none — fall back to the MAC rather than rendering a blank row. The link
    // always keys off the MAC, which is what the detail panel resolves by.
    out.push({
      key: `cli-${x.id}`, kind: 'client',
      name: x.hostname || x.mac_address,
      detail: [x.ip_address, x.ap_name].filter(Boolean).join(' · ') || null,
      site: x.site_name, href: entityHref('client', x.mac_address),
    });
  }
  return out;
}

/**
 * Always-visible search in the top bar. Queries /api/global-search — the SAME
 * endpoint as the Ctrl/Cmd+K palette — so the two searches cover the same ground.
 *
 * It previously queried /api/devices?q=X, i.e. monitored devices ONLY, while the
 * palette searched devices + APs + controllers + services. Two visible searches
 * with different scopes is how an IP plainly listed on Wireless > Clients came
 * back as "No devices match": the row existed, but nothing the top bar looked at
 * contained it. Wireless clients are now covered by the endpoint as well.
 *
 * Combobox semantics (1.115.0): the field is a real `combobox` owning a
 * `listbox`, Up/Down move an `aria-activedescendant` highlight, Enter opens the
 * highlighted result and Escape closes. Before this the list was mouse-only —
 * a keyboard user could type a query and then had no way to reach a result.
 *
 * On narrow screens the field collapses to a magnifier icon that expands on click.
 */
export default function TopBarSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);   // results dropdown
  const [expanded, setExpanded] = useState(false);   // mobile field reveal
  const [cursor, setCursor] = useState(0);           // keyboard highlight
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);
  const listId = useId();

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
    if (!term) { setResults([]); setLoading(false); setFailed(false); setOpenMenu(false); return; }
    setLoading(true);
    setOpenMenu(true);
    const myId = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const data = await apiGet<GlobalResults>(`/api/global-search?q=${encodeURIComponent(term)}`);
        if (myId === reqId.current) { setResults(flatten(data || {})); setFailed(false); setCursor(0); }
      } catch {
        // A failed search must not look like "nothing matched" — that is the
        // difference between "this device is not monitored" and "we could not
        // ask". See the error row in the menu below.
        if (myId === reqId.current) { setResults([]); setFailed(true); }
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  // Each hit carries its own destination — a device goes to its detail page,
  // an AP/controller/client to its own wireless deep link.
  function go(href: string) {
    setQ('');
    setResults([]);
    setOpenMenu(false);
    setExpanded(false);
    router.push(href);
    announceWirelessTarget(href);
  }

  const activeId = results.length ? `${listId}-opt-${Math.min(cursor, results.length - 1)}` : undefined;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setQ('');
      setOpenMenu(false);
      setExpanded(false);
      inputRef.current?.blur();
      return;
    }
    if (!openMenu || !results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + results.length) % results.length);
    } else if (e.key === 'Home') {
      e.preventDefault(); setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault(); setCursor(results.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[Math.min(cursor, results.length - 1)];
      if (hit) go(hit.href);
    }
  }

  // Keep the highlighted row inside the scrolling menu.
  useEffect(() => {
    if (!openMenu) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, openMenu]);

  const status = useMemo(() => {
    if (loading) return 'Searching…';
    if (failed) return 'Search failed';
    if (q.trim() && !results.length) return 'No results';
    if (results.length) return `${results.length} result${results.length === 1 ? '' : 's'}`;
    return '';
  }, [loading, failed, q, results.length]);

  function toggleMobile() {
    setExpanded((v) => {
      const next = !v;
      if (next) setTimeout(() => inputRef.current?.focus(), 0);
      return next;
    });
  }

  return (
    <div className={`sv-tbsearch ${expanded ? 'open' : ''}`} ref={ref}>
      <button className="sv-tbsearch-toggle" onClick={toggleMobile} title="Search" aria-label="Search">
        <IconSearch width={18} height={18} />
      </button>
      <div className="sv-tbsearch-field">
        <IconSearch width={15} height={15} className="sv-tbsearch-glass" aria-hidden="true" />
        <input
          ref={inputRef}
          className="sv-tbsearch-input"
          placeholder="Search devices, APs, clients…"
          aria-label="Search devices, access points, controllers, service checks and wireless clients"
          role="combobox"
          aria-expanded={openMenu}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={openMenu ? activeId : undefined}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => { if (results.length) setOpenMenu(true); }}
          onKeyDown={onKey}
        />
        <span className="sv-tbsearch-kbd" aria-hidden="true">/</span>
      </div>
      {/* Announced separately so a screen-reader user hears the result count
          without having to arrow through the list to discover it. */}
      <span className="sv-sr-only" role="status" aria-live="polite">{status}</span>
      {openMenu && (
        <div className="sv-tbsearch-menu" ref={listRef} id={listId} role="listbox" aria-label="Search results">
          {loading && <div className="sv-search-hint">Searching…</div>}
          {!loading && failed && (
            <div className="sv-search-hint" role="alert">
              Search is unavailable right now. This is a failed request, not an empty result.
            </div>
          )}
          {!loading && !failed && q.trim() && results.length === 0 && (
            <div className="sv-search-hint">No results match “{q.trim()}”.</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.key}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === cursor}
              data-active={i === cursor ? 'true' : undefined}
              className={`sv-search-item${i === cursor ? ' active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(r.href)}
              title={`Open ${ENTITY_DESTINATION[r.kind].toLowerCase()} for ${r.name}`}
            >
              {/* Only devices have a ping status; a neutral dot for everything
                  else beats showing 'unknown', which reads as a fault. */}
              <StatusDot status={r.kind === 'device' ? (r.status || 'unknown') : 'up'} size={9} />
              <span className="nm">{r.name}</span>
              <span className="ip">{r.detail || ''}</span>
              <span className="site">{KIND_LABEL[r.kind]}{r.site ? ` · ${r.site}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, EmptyState, fmtRel, fmtTime, useTableSort, sortRows, SortTh } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import TopologyMapView from '@/components/TopologyMapView';
import type { TopoLayout } from '@/components/TopologyMapView';

// ── API response types ─────────────────────────────────────────
interface TopologyStatus {
  // Live flag from the API process: true from the moment POST
  // /api/topology/discover accepts a run until the walk over every SNMP device
  // finishes. This is what the page watches to know when to reload the map.
  running: boolean;
  last_run_at: string | null;
  links_found: number;
  devices_discovered: number;
}

interface TopologyMapNode {
  // Positive = a real monitored_devices.id. Negative = a synthetic id for an
  // UNMANAGED neighbour (see GET /api/topology/map) — never link it to
  // /devices/[id].
  device_id: number;
  name: string;
  ip: string;
  site_name: string | null;
  status: string;
  is_gateway: boolean;
  managed: boolean;
  // Added client-side by the map tab's filter, never by the API: how many of
  // this node's links point at a node the current filter removed.
  hidden_links?: number;
}

interface TopologyMapEdge {
  from_device_id: number;
  to_device_id: number;
  from_port: string | null;
  to_port: string | null;
  protocol: 'lldp' | 'cdp';
}

interface TopologyMap {
  nodes: TopologyMapNode[];
  edges: TopologyMapEdge[];
}

interface TopologyLink {
  id: number;
  from_device_id: number;
  from_device_name: string;
  from_ip: string;
  from_site_id: number | null;
  from_site: string | null;
  from_port: string | null;
  to_device_id: number | null;
  to_device_name: string | null;
  to_ip: string | null;
  to_site_id: number | null;
  to_site: string | null;
  to_name: string | null;
  to_port: string | null;
  protocol: string;
  last_seen_at: string;
}

interface MapOption {
  id: number;
  name: string;
}

interface DependencySuggestion {
  device_id: number;
  name: string;
  reason: string;
  confidence: number;
}

// A monitored (from-) device with all the neighbor links it discovered.
interface FromDeviceGroup {
  key: string;
  from_device_id: number;
  from_device_name: string;
  from_ip: string;
  last_seen_at: string;
  links: TopologyLink[];
}

// ── CSV export helpers ─────────────────────────────────────────
function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportLinksCsv(rows: TopologyLink[]): void {
  const header = ['From Device', 'From IP', 'From Port', 'To Device', 'To IP', 'To Port', 'Protocol', 'Last Seen'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      csvCell(r.from_device_name),
      csvCell(r.from_ip),
      csvCell(r.from_port),
      csvCell(r.to_device_id ? r.to_device_name : (r.to_name || r.to_ip || 'Unknown')),
      csvCell(r.to_ip),
      csvCell(r.to_port),
      csvCell(r.protocol),
      csvCell(r.last_seen_at),
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'topology-links.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Shown on the two actions that need a link between two MONITORED devices.
const MANAGED_ONLY_HINT =
  'Needs at least one discovered link between two monitored devices. Every neighbour discovered here is unmanaged, so there is nothing to place or analyse.';

// ── View state ↔ URL query string ──────────────────────────────
// The whole canvas scope (tab, site selection, layout, monitored-only, search)
// lives in the query string so an operator can bookmark or paste "the SMT
// access tier" instead of describing it. Written with history.replaceState —
// NOT useSearchParams(), which would force this statically-prerendered page
// dynamic (the same reason the wireless page reads window.location directly).
const LAYOUTS: { key: TopoLayout; label: string; hint: string }[] = [
  { key: 'sites', label: 'Sites', hint: 'Group nodes into a boundary box per site' },
  {
    key: 'tiered',
    label: 'Tiered',
    hint: 'Hierarchical core → distribution → access, inferred from link fan-out',
  },
  { key: 'force', label: 'Force', hint: 'Force-directed spring layout (deterministic)' },
];

const UNASSIGNED_SITE = 'Unassigned';

// While a discovery run is in flight the header re-reads /api/topology/status
// on this interval; DISCOVERY_MAX_WAIT_MS is how long it keeps watching before
// it stops claiming the map will update by itself.
const DISCOVERY_POLL_MS = 2000;
const DISCOVERY_MAX_WAIT_MS = 5 * 60 * 1000;

function siteLabel(n: TopologyMapNode): string {
  return n.site_name && n.site_name.trim() ? n.site_name : UNASSIGNED_SITE;
}

function sortSiteNames(a: string, b: string): number {
  if (a === UNASSIGNED_SITE) return 1;
  if (b === UNASSIGNED_SITE) return -1;
  return a.localeCompare(b);
}

// Merge a set of params into the current URL without touching the others (the
// map tab and the link table both write here) and without a history entry.
function patchQuery(patch: Record<string, string | null>): void {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams(window.location.search);
  Object.keys(patch).forEach((k: string) => {
    const v = patch[k];
    if (v === null || v === '') sp.delete(k);
    else sp.set(k, v);
  });
  const qs = sp.toString();
  window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
}

// ════════════════════════════════════════════════════════════
// Page
// ════════════════════════════════════════════════════════════
export default function TopologyPage() {
  const { canEdit } = useRbac();
  const [tab, setTab] = useState<'map' | 'links'>('map');
  // Bumped once a discovery run finishes; MapTab re-fetches /api/topology/map
  // when it changes. The map hook lives inside MapTab (it must survive tab
  // switches without the page owning the payload), so this counter is the
  // whole refresh channel between the header's button and the canvas.
  const [mapReloadToken, setMapReloadToken] = useState(0);
  // Deep-link/bookmark support: ?tab=links lands on the Link Table. Read on
  // mount only (see the patchQuery comment above for why not useSearchParams).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'links' || t === 'map') setTab(t);
  }, []);

  function selectTab(next: 'map' | 'links') {
    setTab(next);
    patchQuery({ tab: next === 'map' ? null : next });
  }

  // `watching` = a run is in flight and we are waiting it out. It is what makes
  // the status route poll at all: outside a run the header is fetched once on
  // mount, exactly as before.
  const [watching, setWatching] = useState(false);
  const [starting, setStarting] = useState(false);
  const status = useApi<TopologyStatus>('/api/topology/status', watching ? DISCOVERY_POLL_MS : 0);
  const [toast, setToast] = useState<React.ReactNode | null>(null);
  const watchDeadline = useRef(0);
  // The status payload as it stood BEFORE the run was kicked off. useApi hands
  // back a new object on every successful fetch, so identity is enough to stop
  // the pre-run reading (running: false, from page load) being mistaken for
  // "the run has already finished" on the very first render after the POST.
  const preRunStatus = useRef<TopologyStatus | null>(null);
  // Set when we stop waiting on a run that outlived DISCOVERY_MAX_WAIT_MS.
  // Without it the "a run is happening, start watching" effect below would see
  // the still-true `running` flag from the last poll and immediately re-arm the
  // watch (with a fresh deadline) — a loop that never ends.
  const abandoned = useRef(false);

  const flash = useCallback((node: React.ReactNode) => {
    setToast(node);
    setTimeout(() => setToast(null), 6000);
  }, []);

  async function runDiscovery() {
    setStarting(true);
    try {
      const r = await apiSend<{ started: boolean; running?: boolean }>('/api/topology/discover', 'POST', {});
      watchDeadline.current = Date.now() + DISCOVERY_MAX_WAIT_MS;
      preRunStatus.current = status.data;
      abandoned.current = false;
      setWatching(true);
      flash(
        r && r.started === false
          ? 'Discovery is already running — the map will refresh when it finishes.'
          : 'Discovery started — the map and the counts above refresh automatically when it finishes.',
      );
    } catch (e: any) {
      flash(e?.message || 'Failed to start discovery');
    } finally {
      setStarting(false);
    }
  }

  // A run started elsewhere (another tab, another operator) still deserves the
  // same treatment — `running` is process-wide, not per-session.
  const serverRunning = !!status.data && status.data.running;
  useEffect(() => {
    if (!serverRunning) {
      abandoned.current = false;
      return;
    }
    if (watching || abandoned.current) return;
    watchDeadline.current = Date.now() + DISCOVERY_MAX_WAIT_MS;
    setWatching(true);
  }, [serverRunning, watching]);

  // Completion. status.data is a brand-new object on every successful poll, so
  // identity alone distinguishes a fresh reading from the pre-run one; the
  // timeout is kept on an absolute deadline so repeated poll FAILURES (which
  // leave status.data unchanged and therefore never re-run this effect) cannot
  // strand the page in "Discovering…" forever.
  const polled = status.data;
  useEffect(() => {
    if (!watching) return;
    if (polled && polled !== preRunStatus.current && !polled.running) {
      setWatching(false);
      preRunStatus.current = null;
      setMapReloadToken((t: number) => t + 1);
      flash(
        `Discovery finished — ${polled.links_found} link${polled.links_found === 1 ? '' : 's'} across ` +
        `${polled.devices_discovered} device${polled.devices_discovered === 1 ? '' : 's'}. Map updated.`,
      );
      return;
    }
    const t = setTimeout(() => {
      abandoned.current = true;
      setWatching(false);
      setMapReloadToken((tk: number) => tk + 1);
      flash('Discovery is still running after 5 minutes — reload the page to pick up the rest.');
    }, Math.max(1000, watchDeadline.current - Date.now()));
    return () => clearTimeout(t);
  }, [watching, polled, flash]);

  const last = status.data;
  const running = starting || watching;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Slim discovery header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          minHeight: 44,
          padding: '0 16px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <span style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)' }}>
          Network Topology
        </span>
        <span style={{ color: 'var(--border)' }}>·</span>
        {last ? (
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Last run: {fmtRel(last.last_run_at)} · {last.links_found} link{last.links_found === 1 ? '' : 's'} · {last.devices_discovered} device{last.devices_discovered === 1 ? '' : 's'}
          </span>
        ) : (
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Auto-discovered device connections via LLDP and CDP.
          </span>
        )}
        <div style={{ flex: 1 }} />
        {canEdit && (
          <button className="sv-btn sm" onClick={runDiscovery} disabled={running} style={{ height: 32 }}>
            {running ? 'Running…' : 'Run Discovery'}
          </button>
        )}
      </div>

      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}
      {status.error && <ErrorBox message={status.error} />}

      <div className="sv-tabs sticky" style={{ marginBottom: 0 }}>
        <button className={`sv-tab ${tab === 'map' ? 'active' : ''}`} onClick={() => selectTab('map')}>
          Visual Map
        </button>
        <button className={`sv-tab ${tab === 'links' ? 'active' : ''}`} onClick={() => selectTab('links')}>
          Link Table
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'map'
          ? <MapTab canEdit={canEdit} flash={flash} status={last || null} reloadToken={mapReloadToken} />
          : <LinkTable canEdit={canEdit} flash={flash} />}
      </div>
    </div>
  );
}

// ── Tab 1: Visual Map (top-level component) ────────────────────
function MapTab({
  canEdit,
  flash,
  status,
  reloadToken,
}: {
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
  // The same /api/topology/status payload the header bar renders. The map must
  // not contradict it: an empty canvas that says "run topology discovery" while
  // the header right above it reports "69 links · 8 devices" is the bug this
  // tab shipped with for its whole life.
  status: TopologyStatus | null;
  // Changes when the page has watched a discovery run to completion. Until
  // this existed the map had NO reload path at all — the toast promised
  // "results will update shortly" and nothing updated short of a full page
  // reload or a Map→Links→Map round trip.
  reloadToken: number;
}) {
  const tmap = useApi<TopologyMap>('/api/topology/map', 0);
  const reloadMap = tmap.reload;
  // Seeded with the current token so a plain remount (tab switch) does not
  // fire a second fetch on top of useApi's own mount fetch.
  const handledToken = useRef(reloadToken);
  useEffect(() => {
    if (handledToken.current === reloadToken) return;
    handledToken.current = reloadToken;
    reloadMap();
  }, [reloadToken, reloadMap]);
  const maps = useApi<MapOption[]>('/api/maps', 0);
  const [showApply, setShowApply] = useState(false);
  const [suggestions, setSuggestions] = useState<DependencySuggestion[] | null>(null);
  const [applyingDeps, setApplyingDeps] = useState(false);

  // ── Canvas scope (all four mirrored into the query string) ────────────
  const [layout, setLayout] = useState<TopoLayout>('sites');
  const [siteSel, setSiteSel] = useState<string[]>([]); // [] = every site
  const [monitoredOnly, setMonitoredOnly] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const l = sp.get('layout');
    if (l === 'sites' || l === 'tiered' || l === 'force') setLayout(l);
    const s = sp.get('sites');
    if (s) setSiteSel(s.split(',').map((x: string) => x.trim()).filter(Boolean));
    if (sp.get('managed') === '1') setMonitoredOnly(true);
    const qq = sp.get('q');
    if (qq) setQ(qq);
  }, []);

  function chooseLayout(next: TopoLayout) {
    setLayout(next);
    patchQuery({ layout: next === 'sites' ? null : next });
  }
  function toggleSite(name: string) {
    const next = siteSel.includes(name)
      ? siteSel.filter((x: string) => x !== name)
      : siteSel.concat(name);
    setSiteSel(next);
    patchQuery({ sites: next.length ? next.join(',') : null });
  }
  function selectAllSites() {
    setSiteSel([]);
    patchQuery({ sites: null });
  }
  function toggleMonitoredOnly() {
    const next = !monitoredOnly;
    setMonitoredOnly(next);
    patchQuery({ managed: next ? '1' : null });
  }
  function changeQ(v: string) {
    setQ(v);
    patchQuery({ q: v || null });
  }
  function clearFilters() {
    setSiteSel([]);
    setMonitoredOnly(false);
    setQ('');
    patchQuery({ sites: null, managed: null, q: null });
  }

  async function applyDependencies() {
    setApplyingDeps(true);
    try {
      const r = await apiSend<{ suggestions: DependencySuggestion[] }>('/api/topology/apply-dependencies', 'POST', {});
      setSuggestions(r.suggestions || []);
    } catch (e: any) {
      flash(e?.message || 'Failed to compute dependencies');
    } finally {
      setApplyingDeps(false);
    }
  }

  // ── Derived view. Every filter is CLIENT-SIDE on purpose: the whole graph is
  //    52 nodes / 47 edges, so a round trip per chip click would be slower and
  //    would need three new query params on a route three other things read.
  const allNodes: TopologyMapNode[] = tmap.data ? tmap.data.nodes : [];
  const allEdges: TopologyMapEdge[] = tmap.data ? tmap.data.edges : [];

  const siteRows = useMemo(() => {
    const total = new Map<string, number>();
    const mon = new Map<string, number>();
    allNodes.forEach((n: TopologyMapNode) => {
      const s = siteLabel(n);
      total.set(s, (total.get(s) || 0) + 1);
      if (n.managed !== false) mon.set(s, (mon.get(s) || 0) + 1);
    });
    return Array.from(total.keys())
      .sort(sortSiteNames)
      .map((name: string) => ({
        name,
        count: total.get(name) || 0,
        monitored: mon.get(name) || 0,
      }));
  }, [allNodes]);

  const view = useMemo(() => {
    const sel = new Set(siteSel);
    const kept = allNodes.filter(
      (n: TopologyMapNode) =>
        (!monitoredOnly || n.managed !== false) && (sel.size === 0 || sel.has(siteLabel(n))),
    );
    const keptIds = new Set(kept.map((n: TopologyMapNode) => n.device_id));
    const edges = allEdges.filter(
      (e: TopologyMapEdge) => keptIds.has(e.from_device_id) && keptIds.has(e.to_device_id),
    );
    // How many of each surviving node's links point at a node the filter
    // removed — drawn as a "+N" badge so a scoped canvas never reads as though
    // a switch genuinely has fewer neighbours than it does.
    const hidden = new Map<number, number>();
    allEdges.forEach((e: TopologyMapEdge) => {
      const a = keptIds.has(e.from_device_id);
      const b = keptIds.has(e.to_device_id);
      if (a && !b) hidden.set(e.from_device_id, (hidden.get(e.from_device_id) || 0) + 1);
      else if (b && !a) hidden.set(e.to_device_id, (hidden.get(e.to_device_id) || 0) + 1);
    });
    const nodes = kept.map((n: TopologyMapNode) => {
      const h = hidden.get(n.device_id);
      return h ? { ...n, hidden_links: h } : n;
    });
    const monitoredShown = nodes.filter((n: TopologyMapNode) => n.managed !== false).length;
    const sitesShown = new Set(nodes.map((n: TopologyMapNode) => siteLabel(n))).size;
    return { nodes, edges, monitoredShown, sitesShown };
    // `q` is deliberately NOT a dependency: the highlight only rings nodes, it
    // never adds or removes one. Including it rebuilt view.nodes on every
    // keystroke, and TopologyMapView keys its (O(iterations x n^2)) layout off
    // the node array it is handed — so typing in the highlight box re-ran the
    // whole force embedding per character. The match COUNT below is its own
    // memo for the same reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes, allEdges, siteSel, monitoredOnly]);

  const matched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return 0;
    return view.nodes.filter((n: TopologyMapNode) =>
      [n.name, n.ip, n.site_name].filter(Boolean).join(' ').toLowerCase().includes(needle),
    ).length;
  }, [view, q]);

  if (tmap.loading && !tmap.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (tmap.error) {
    return <ErrorBox message={tmap.error} />;
  }

  const hasGraph = !!tmap.data && tmap.data.edges.length > 0 && tmap.data.nodes.length > 0;
  // "Apply to Map" and "Apply Dependencies" both work off links whose BOTH ends
  // are monitored devices (map_devices.device_id is a real FK; the dependency
  // heuristic reasons about site_id). A map made entirely of unmanaged
  // neighbours is a perfectly good picture but gives those two nothing to do —
  // and Apply to Map would clear the target map's connections and add none
  // back — so they are disabled rather than silently destructive.
  const hasManagedEdges =
    !!tmap.data && tmap.data.edges.some((e) => e.from_device_id > 0 && e.to_device_id > 0);
  const linksFound = status ? status.links_found : 0;
  const emptyMessage =
    linksFound > 0
      ? `Discovery found ${linksFound} link${linksFound === 1 ? '' : 's'}, but none of them could be placed on the map. See the Link Table tab for the raw results.`
      : status && status.last_run_at
        ? 'Topology discovery has run but found no LLDP/CDP neighbours. Check that SNMP is reachable on your devices and that LLDP or CDP is enabled on them.'
        : 'No topology discovered yet — run topology discovery to see device connections →';

  const filtersActive = siteSel.length > 0 || monitoredOnly || q.trim() !== '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      {hasGraph && (
        <MapControls
          layout={layout}
          onLayout={chooseLayout}
          sites={siteRows}
          siteSel={siteSel}
          onToggleSite={toggleSite}
          onAllSites={selectAllSites}
          monitoredOnly={monitoredOnly}
          onToggleMonitoredOnly={toggleMonitoredOnly}
          q={q}
          onQ={changeQ}
          filtersActive={filtersActive}
          onClear={clearFilters}
          shownNodes={view.nodes.length}
          totalNodes={allNodes.length}
          shownEdges={view.edges.length}
          totalEdges={allEdges.length}
          monitoredShown={view.monitoredShown}
          sitesShown={view.sitesShown}
          totalSites={siteRows.length}
          matched={matched}
        />
      )}

      <div
        className="sv-panel"
        style={{ padding: 4, flex: 1, minHeight: 360, display: 'flex', flexDirection: 'column' }}
      >
        {hasGraph && tmap.data ? (
          view.nodes.length > 0 ? (
            <div style={{ flex: 1, minHeight: 0, width: '100%', background: '#f8fafc', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              <TopologyMapView
                nodes={view.nodes}
                edges={view.edges}
                interactive
                layout={layout}
                highlight={q}
                // The page has already reduced the graph to exactly what should
                // be drawn, so the view must not silently drop anything else.
                // This matters for "Monitored only": managed-to-managed links
                // number ZERO on a real estate, so every monitored device is
                // isolated in that view and the default drop-unconnected rule
                // would blank the canvas.
                showIsolated
              />
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <EmptyState
                title="No nodes match the current filter"
                message={`All ${allNodes.length} discovered node${allNodes.length === 1 ? '' : 's'} are hidden by the site / monitored-only filter.`}
                actionLabel="Clear filters"
                onAction={clearFilters}
              />
            </div>
          )
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty message={emptyMessage} />
          </div>
        )}
      </div>

      {(hasGraph || (canEdit && hasGraph)) && (
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-muted)',
          }}
        >
          {hasGraph && (
            <>
              {/* Link protocol colors */}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {/* intentional: 22x3 decorative sliver standing in for a map link line. */}
                <span style={{ display: 'inline-block', width: 22, height: 3, background: '#2563eb', borderRadius: 2 }} />
                LLDP
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {/* intentional: 22x3 decorative sliver standing in for a map link line. */}
                <span style={{ display: 'inline-block', width: 22, height: 3, background: '#f97316', borderRadius: 2 }} />
                CDP
              </span>
              <span style={{ color: 'var(--border)' }}>·</span>
              {/* Node status colors */}
              {([
                ['#22c55e', 'Up'],
                ['#ef4444', 'Down'],
                ['#eab308', 'Warning'],
                ['#94a3b8', 'Unknown'],
              ] as const).map(([color, label]) => (
                <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {/* intentional: 3px on a 10x10 legend swatch — --radius-sm would render it as a circle. */}
                  <span style={{ display: 'inline-block', width: 10, height: 10, background: color, borderRadius: 3 }} />
                  {label}
                </span>
              ))}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {/* Mirrors the dashed outlined "ghost" box TopologyMapView draws for a
                    neighbour that is not a monitored device. Raw hex for the same reason
                    as the swatches above — it matches a fixed-palette SVG canvas. */}
                <span style={{ display: 'inline-block', width: 10, height: 10, background: '#ffffff', border: '1.5px dashed #94a3b8', borderRadius: 3 }} />
                Not monitored
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: '#f59e0b' }}>★</span>
                Gateway
              </span>
              {layout !== 'sites' && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {/* Mirrors the site-coloured bar TopologyMapView draws along the top
                      edge of every node in the layouts that have no site boxes. */}
                  <span style={{ display: 'inline-block', width: 14, height: 3, background: '#7c3aed', borderRadius: 2 }} />
                  Site colour
                </span>
              )}
              <span style={{ color: 'var(--border)' }}>·</span>
              {/* The canvas only zooms on Ctrl/Cmd + wheel so a plain wheel (and a
                  trackpad two-finger scroll) still scrolls THIS page — see the
                  wheel handler in TopologyMapView. Stated here as well as in the
                  in-canvas flash, so the gesture is discoverable before it is
                  attempted. */}
              <span>Drag to pan · Ctrl (⌘) + scroll to zoom</span>
            </>
          )}
          <div style={{ flex: 1 }} />
          {canEdit && hasGraph && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                className="sv-btn ghost sm"
                style={{ height: 32 }}
                disabled={!hasManagedEdges}
                title={hasManagedEdges ? undefined : MANAGED_ONLY_HINT}
                onClick={() => { setShowApply(true); maps.reload(); }}
              >
                Apply to Map
              </button>
              <button
                className="sv-btn ghost sm"
                style={{ height: 32 }}
                onClick={applyDependencies}
                disabled={applyingDeps || !hasManagedEdges}
                title={hasManagedEdges ? undefined : MANAGED_ONLY_HINT}
              >
                {applyingDeps ? 'Analyzing…' : 'Apply Dependencies'}
              </button>
            </div>
          )}
        </div>
      )}

      {suggestions && <DependencyPanel suggestions={suggestions} onClose={() => setSuggestions(null)} />}

      {showApply && (
        <ApplyToMapModal
          maps={maps.data || []}
          onClose={() => setShowApply(false)}
          flash={flash}
        />
      )}
    </div>
  );
}

// ── Canvas control bar (top-level component) ───────────────────
// Local styles only — nothing added to globals.css (several agents are editing
// it concurrently). CTL_LABEL and the divider below are the two candidates to
// promote to shared classes later (e.g. .sv-ctl-label / .sv-ctl-divider);
// everything else reuses the existing .sv-chip / .sv-btn / .sv-input system.
const CTL_LABEL: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-muted)',
  flex: 'none',
};

const CTL_DIVIDER: React.CSSProperties = {
  width: 1,
  height: 20,
  background: 'var(--border)',
  flex: 'none',
};

function MapControls({
  layout,
  onLayout,
  sites,
  siteSel,
  onToggleSite,
  onAllSites,
  monitoredOnly,
  onToggleMonitoredOnly,
  q,
  onQ,
  filtersActive,
  onClear,
  shownNodes,
  totalNodes,
  shownEdges,
  totalEdges,
  monitoredShown,
  sitesShown,
  totalSites,
  matched,
}: {
  layout: TopoLayout;
  onLayout: (l: TopoLayout) => void;
  sites: { name: string; count: number; monitored: number }[];
  siteSel: string[];
  onToggleSite: (name: string) => void;
  onAllSites: () => void;
  monitoredOnly: boolean;
  onToggleMonitoredOnly: () => void;
  q: string;
  onQ: (v: string) => void;
  filtersActive: boolean;
  onClear: () => void;
  shownNodes: number;
  totalNodes: number;
  shownEdges: number;
  totalEdges: number;
  monitoredShown: number;
  sitesShown: number;
  totalSites: number;
  matched: number;
}) {
  const hiddenNodes = totalNodes - shownNodes;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {/* Row 1 — layout mode, monitored-only, search/highlight */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={CTL_LABEL}>Layout</span>
        <div className="sv-chips" style={{ margin: 0 }}>
          {LAYOUTS.map((l) => (
            <button
              key={l.key}
              type="button"
              title={l.hint}
              className={`sv-chip ${layout === l.key ? 'active' : ''}`}
              onClick={() => onLayout(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <span style={CTL_DIVIDER} />
        <button
          type="button"
          className={`sv-chip ${monitoredOnly ? 'active' : ''}`}
          title="Hide every LLDP/CDP neighbour that is not in SpanVault monitoring, leaving just the monitored core"
          onClick={onToggleMonitoredOnly}
        >
          Monitored only
        </button>
        <div style={{ flex: 1 }} />
        <input
          className="sv-input"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="Highlight name, IP or site…"
          style={{ maxWidth: 260, height: 32 }}
        />
      </div>

      {/* Row 2 — site scope + what is currently on the canvas */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={CTL_LABEL}>Sites</span>
        <div className="sv-chips" style={{ margin: 0 }}>
          <button
            type="button"
            className={`sv-chip ${siteSel.length === 0 ? 'active' : ''}`}
            onClick={onAllSites}
            title="Show every site"
          >
            All sites
          </button>
          {sites.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`sv-chip ${siteSel.includes(s.name) ? 'active' : ''}`}
              onClick={() => onToggleSite(s.name)}
              title={`${s.name} — ${s.count} node${s.count === 1 ? '' : 's'}, ${s.monitored} monitored`}
            >
              {s.name} <span style={{ opacity: 0.7 }}>{monitoredOnly ? s.monitored : s.count}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{shownNodes}</strong> of {totalNodes} node
          {totalNodes === 1 ? '' : 's'}
          {' '}({monitoredShown} monitored · {shownNodes - monitoredShown} unmanaged) ·{' '}
          <strong style={{ color: 'var(--text-primary)' }}>{shownEdges}</strong> of {totalEdges} link
          {totalEdges === 1 ? '' : 's'} · {sitesShown} of {totalSites} site{totalSites === 1 ? '' : 's'}
          {hiddenNodes > 0 ? ` · ${hiddenNodes} hidden` : ''}
          {q.trim() ? ` · ${matched} match${matched === 1 ? '' : 'es'}` : ''}
        </span>
        {filtersActive && (
          <button className="sv-btn ghost sm" style={{ height: 28 }} onClick={onClear}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// ── Dependency suggestions panel (top-level component) ─────────
function DependencyPanel({
  suggestions,
  onClose,
}: {
  suggestions: DependencySuggestion[];
  onClose: () => void;
}) {
  const { sort, onSort } = useTableSort();
  const sorted = useMemo(() => sortRows(suggestions, sort, {
    device: (s) => s.name,
    reason: (s) => s.reason,
    confidence: (s) => s.confidence,
  }), [suggestions, sort]);

  return (
    <div className="sv-panel" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>Dependency suggestions</strong>
        <div style={{ flex: 1 }} />
        <button className="sv-btn ghost sm" onClick={onClose}>Dismiss</button>
      </div>
      {suggestions.length === 0 ? (
        <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>
          No dependency suggestions found.
        </div>
      ) : (
        <table className="sv-table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <SortTh label="Device" col="device" sort={sort} onSort={onSort} />
              <SortTh label="Reason" col="reason" sort={sort} onSort={onSort} />
              <SortTh label="Confidence" col="confidence" sort={sort} onSort={onSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((s: DependencySuggestion) => (
              <tr key={s.device_id}>
                <td>{s.name}</td>
                <td style={{ color: 'var(--text-muted)' }}>{s.reason}</td>
                <td style={{ textAlign: 'right' }}>{Math.round((s.confidence || 0) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Apply-to-map modal (top-level component) ───────────────────
function ApplyToMapModal({
  maps,
  onClose,
  flash,
}: {
  maps: MapOption[];
  onClose: () => void;
  flash: (node: React.ReactNode) => void;
}) {
  const [target, setTarget] = useState<number | ''>(maps.length ? maps[0].id : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply() {
    if (target === '') { setErr('Select a map'); return; }
    setSaving(true);
    setErr(null);
    try {
      await apiSend(`/api/topology/apply-to-map/${target}`, 'POST', {});
      onClose();
      flash(
        <span>
          Topology applied to map.{' '}
          <a href={`/maps/${target}`} style={{ textDecoration: 'underline' }}>View map →</a>
        </span>
      );
    } catch (e: any) {
      setErr(e?.message || 'Failed to apply to map');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Apply to Map</h2>
        {err && <ErrorBox message={err} />}
        {maps.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No maps available. Create a map first.</p>
        ) : (
          <label className="sv-field" style={{ display: 'block' }}>
            Target map
            <select
              className="sv-select"
              value={target}
              onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : '')}
              style={{ width: '100%', marginTop: 6 }}
            >
              {maps.map((m: MapOption) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        )}
        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={apply} disabled={saving || maps.length === 0 || target === ''}>
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Resolve the display name for a neighbor (to-) device on a link.
function neighborName(r: TopologyLink): string {
  return r.to_device_id != null
    ? (r.to_device_name || r.to_ip || 'Device')
    : (r.to_name || r.to_ip || 'Unknown');
}

// Group raw links by the monitored (from-) device that discovered them.
function buildFromDeviceGroups(rows: TopologyLink[]): FromDeviceGroup[] {
  const map = new Map<string, FromDeviceGroup>();
  for (const r of rows) {
    const key = String(r.from_device_id);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        from_device_id: r.from_device_id,
        from_device_name: r.from_device_name,
        from_ip: r.from_ip,
        last_seen_at: r.last_seen_at,
        links: [],
      };
      map.set(key, g);
    }
    g.links.push(r);
    if (r.last_seen_at > g.last_seen_at) g.last_seen_at = r.last_seen_at;
  }
  const groups = Array.from(map.values());
  for (const g of groups) {
    g.links.sort((a, b) => neighborName(a).localeCompare(neighborName(b)));
  }
  groups.sort((a, b) => (a.from_device_name || '').localeCompare(b.from_device_name || ''));
  return groups;
}

// ── Tab 2: Link table — collapsed by from- (monitored) device (top-level) ──
function LinkTable({
  canEdit,
  flash,
}: {
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const links = useApi<TopologyLink[]>('/api/topology/links', 0);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  const filtered = useMemo<TopologyLink[]>(() => {
    const all = links.data || [];
    const needle = q.trim().toLowerCase();
    return needle
      ? all.filter((r: TopologyLink) => {
          const hay = [
            r.from_device_name, r.from_ip,
            r.to_device_name, r.to_name, r.to_ip,
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(needle);
        })
      : all;
  }, [links.data, q]);

  // Sort runs AFTER the search filter + grouping, so the default (name-ordered)
  // grouping still applies until a header is clicked.
  const { sort, onSort } = useTableSort();
  const groups = useMemo<FromDeviceGroup[]>(() => sortRows(buildFromDeviceGroups(filtered), sort, {
    device: (g) => g.from_device_name,
    lastseen: (g) => g.last_seen_at,
  }), [filtered, sort]);

  if (links.loading && !links.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (links.error) {
    return <ErrorBox message={links.error} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Compact single-row filter + export */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input
          className="sv-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search device name or IP…"
          style={{ maxWidth: 320, height: 32 }}
        />
        <div style={{ flex: 1 }} />
        <button
          className="sv-btn ghost sm"
          onClick={() => exportLinksCsv(filtered)}
          disabled={filtered.length === 0}
          style={{ height: 32 }}
        >
          Export CSV
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No links to show. Run discovery to detect device connections." />
        </div>
      ) : (
        <div className="sv-panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="sv-table">
            <thead>
              <tr>
                <SortTh label="Device" col="device" sort={sort} onSort={onSort} />
                <SortTh label="Last Seen" col="lastseen" sort={sort} onSort={onSort} />
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {groups.map((g: FromDeviceGroup) => (
                <FromDeviceRow
                  key={g.key}
                  group={g}
                  expanded={expanded.has(g.key)}
                  onToggle={() => toggle(g.key)}
                  canEdit={canEdit}
                  flash={flash}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── From-device group row + expandable neighbor detail (top-level) ──
function FromDeviceRow({
  group,
  expanded,
  onToggle,
  canEdit,
  flash,
}: {
  group: FromDeviceGroup;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const count = group.links.length;
  // Each expanded group keeps its own neighbour-table sort; default (null) keeps
  // buildFromDeviceGroups' neighbour-name ordering.
  const { sort, onSort } = useTableSort();
  const links = useMemo(() => sortRows(group.links, sort, {
    neighbor: (l) => neighborName(l),
    monitored: (l) => (l.to_device_id != null ? 'Monitored' : 'Not monitored'),
    protocol: (l) => l.protocol,
    toport: (l) => l.to_port,
    lastseen: (l) => l.last_seen_at,
  }), [group.links, sort]);

  return (
    <Fragment>
      <tr className="sv-neighbor-head" style={{ cursor: 'pointer', height: 40 }} onClick={onToggle}>
        <td style={{ height: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusDot status="up" />
            <a
              href={`/devices/${group.from_device_id}`}
              style={{ fontSize: 'var(--text-base)', fontWeight: 600, textDecoration: 'underline' }}
              onClick={(e) => e.stopPropagation()}
            >
              {group.from_device_name}
            </a>
            {group.from_ip && (
              <>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{group.from_ip}</span>
              </>
            )}
            <span style={{ color: 'var(--border)' }}>·</span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {count} neighbor{count === 1 ? '' : 's'}
            </span>
          </div>
        </td>
        <td title={fmtTime(group.last_seen_at)} style={{ whiteSpace: 'nowrap', height: 40, color: 'var(--text-muted)' }}>
          {fmtRel(group.last_seen_at)}
        </td>
        <td style={{ textAlign: 'center', width: 32, color: 'var(--text-muted)', height: 40 }}>
          {expanded ? '▾' : '▸'}
        </td>
      </tr>
      {expanded && (
        <tr className="sv-neighbor-detail">
          <td colSpan={3} style={{ padding: 0 }}>
            <table className="sv-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <SortTh label="Neighbor" col="neighbor" sort={sort} onSort={onSort} />
                  <SortTh label="Monitored" col="monitored" sort={sort} onSort={onSort} />
                  <SortTh label="Protocol" col="protocol" sort={sort} onSort={onSort} />
                  <SortTh label="To Port" col="toport" sort={sort} onSort={onSort} />
                  <SortTh label="Last Seen" col="lastseen" sort={sort} onSort={onSort} />
                  <th style={{ textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {links.map((l: TopologyLink) => (
                  <NeighborDetailRow key={l.id} link={l} canEdit={canEdit} flash={flash} />
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Per-neighbor detail row with its own "add to monitoring" state (top-level) ──
function NeighborDetailRow({
  link,
  canEdit,
  flash,
}: {
  link: TopologyLink;
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const [adding, setAdding] = useState(false);
  const monitored = link.to_device_id != null;
  const name = neighborName(link);
  const proto = (link.protocol || '').toLowerCase();

  async function addToMonitoring() {
    if (!link.to_ip) {
      flash('No IP address was discovered for this neighbor — add it manually from the Devices page.');
      return;
    }
    setAdding(true);
    try {
      // Inherit the site from the device that discovered this neighbor.
      await apiSend('/api/devices', 'POST', {
        name: link.to_name || link.to_ip,
        ip_address: link.to_ip,
        site_id: link.from_site_id ?? null,
        site_name: link.from_site ?? null,
      });
      const where = link.from_site ? ` (site: ${link.from_site})` : '';
      flash(`Added ${link.to_name || link.to_ip} to monitoring${where}.`);
    } catch (e: any) {
      flash(e?.message || 'Failed to add device');
    } finally {
      setAdding(false);
    }
  }

  return (
    <tr style={{ height: 36 }}>
      <td style={{ height: 36 }}>
        <div>
          {monitored && link.to_device_id ? (
            <a href={`/devices/${link.to_device_id}`} style={{ textDecoration: 'underline' }}>{name}</a>
          ) : (
            <span>{name}</span>
          )}
          {link.to_ip && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{link.to_ip}</div>}
        </div>
      </td>
      <td style={{ height: 36 }}>
        <span className="sv-badge">{monitored ? 'Monitored' : 'Not monitored'}</span>
      </td>
      <td style={{ height: 36 }}>
        {proto && (
          <span
            className="sv-badge"
            style={{ color: proto === 'cdp' ? '#f97316' : '#2563eb', textTransform: 'uppercase' }}
          >
            {proto}
          </span>
        )}
      </td>
      <td style={{ height: 36 }}>{link.to_port || '—'}</td>
      <td title={fmtTime(link.last_seen_at)} style={{ whiteSpace: 'nowrap', height: 36, color: 'var(--text-muted)' }}>
        {fmtRel(link.last_seen_at)}
      </td>
      <td style={{ textAlign: 'right', height: 36 }}>
        {canEdit && link.to_device_id == null && (
          <button
            className="sv-btn ghost sm"
            onClick={(e) => { e.stopPropagation(); addToMonitoring(); }}
            disabled={adding}
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        )}
      </td>
    </tr>
  );
}

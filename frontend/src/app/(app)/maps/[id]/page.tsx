'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import SVGMapView from '@/components/SVGMapView';
import {
  Loading, ErrorBox, Empty, useToast, Breadcrumb, SevTag, Freshness, InfoTip, Notice,
  fmtTime, fmtRel,
} from '@/components/ui';
import { normalizeMap, type FullMap, type MapDevice } from '@/lib/mapTypes';
import { downloadMapSvg, downloadMapPng } from '@/lib/mapExport';

/** A node's effective status — a service-check node carries its own. */
function nodeStatus(d: MapDevice): string {
  if (d.service_check_id != null) return (d.service_status || 'unknown').toLowerCase();
  if (d.alert_suppressed) return 'suppressed';
  return (d.current_status || 'unknown').toLowerCase();
}
function nodeKind(d: MapDevice): string {
  if (d.drill_map_id) return 'Linked map';
  if (d.service_check_id != null) return 'Service check';
  if (d.device_id) return 'Device';
  return 'Unlinked node';
}
function nodeHref(d: MapDevice): string | null {
  if (d.drill_map_id) return `/maps/${d.drill_map_id}`;
  if (d.service_check_id != null) return `/services/${d.service_check_id}`;
  if (d.device_id) return `/devices/${d.device_id}`;
  return null;
}
function nodeLabel(d: MapDevice): string {
  // The author's own label wins; otherwise the joined entity name. A node
  // linked to nothing falls back to its id rather than rendering blank.
  return d.label || d.device_name || d.service_name
    || (d.device_id ? `Device #${d.device_id}` : `Node #${d.id}`);
}
const STATUS_SEV: Record<string, 'critical' | 'warning' | 'ok' | 'unknown'> = {
  down: 'critical', warning: 'warning', up: 'ok', suppressed: 'unknown', unknown: 'unknown',
};

export default function MapViewPage() {
  const { id } = useParams<{ id: string }>();
  const { canEdit } = useRbac();
  const map = useApi<FullMap>(`/api/maps/${id}`, 0); // loaded once; SVGMapView polls status
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { toast, ToastUI } = useToast();
  // The canvas is the primary view, but it is also a picture: a keyboard or
  // screen-reader user had no way to enumerate what was on it, and at any
  // real node count finding one by eye is slow. This list is the semantic
  // equivalent — searchable, focusable, and it carries the same facts.
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // When the live-status poll last succeeded. Deliberately separate from the
  // map's own updated_at, which is when the LAYOUT was last edited — showing
  // one and calling it the other is how a six-month-old layout reads as a
  // six-month-old status.
  const [statusAt, setStatusAt] = useState<number | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  // The initial statuses arrive with the map itself, so the first "refreshed"
  // time is when the page loaded — not 30 seconds later when the first poll
  // lands. Without this the stamp read "waiting for the first poll" over data
  // that was in fact current.
  useEffect(() => {
    if (map.data && statusAt == null) setStatusAt(Date.now());
  }, [map.data, statusAt]);

  const full = useMemo(() => (map.data ? normalizeMap(map.data) : null), [map.data]);
  const nodes = useMemo(() => {
    const list = full?.devices || [];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? list.filter((d) => `${nodeLabel(d)} ${d.ip_address || ''} ${d.site_name || ''}`.toLowerCase().includes(needle))
      : list;
    // Worst first: on an operations map the broken node is the one being looked for.
    const rank: Record<string, number> = { down: 0, warning: 1, unknown: 2, suppressed: 3, up: 4 };
    return [...filtered].sort((a, b) =>
      (rank[nodeStatus(a)] ?? 5) - (rank[nodeStatus(b)] ?? 5) || nodeLabel(a).localeCompare(nodeLabel(b)));
  }, [full, q]);

  if (map.loading && !map.data) return <Loading />;
  if (map.error) return <ErrorBox message={map.error} />;
  if (!map.data || !full) return <Empty message="Map not found." />;

  const fileBase = (full.name || 'map').replace(/[^\w.-]+/g, '_');
  function mapSvg(): SVGSVGElement | null {
    return frameRef.current?.querySelector('svg.sv-mapview') ?? null;
  }
  const selected = nodes.find((d) => d.id === selectedId) || null;

  return (
    <div>
      {ToastUI}
      <Breadcrumb items={[
        { label: 'Maps', onClick: () => { window.location.href = '/maps'; } },
        { label: full.name },
      ]} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <h1 className="sv-page-title" style={{ margin: 0 }}>{full.name}</h1>
        {/* "Public" in green read as a reassuring status. It is an access
            decision with real consequences, so it says what it means. */}
        {full.is_public && (
          <span className="sv-badge warning" title="Anyone who has the share link can open this map without signing in.">
            Public — anyone with the link can view
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="sv-btn ghost sm tint-teal" onClick={() => { const s = mapSvg(); if (s) downloadMapSvg(s, `${fileBase}.svg`); }}>Export SVG</button>
        <button className="sv-btn ghost sm tint-teal" onClick={() => { const s = mapSvg(); if (s) downloadMapPng(s, `${fileBase}.png`).catch((e) => toast(`PNG export failed: ${e?.message || e}. Try Export SVG instead.`, 'err')); }}>Export PNG</button>
        {/* Editing a map is a write; the server gates map writes by role and
            this matches the UI policy used for every other write in the app
            (admin and above). A viewer no longer sees a button that 403s. */}
        {canEdit && <Link href={`/maps/${id}/edit`} className="sv-btn">Edit</Link>}
      </div>
      {full.description && <p className="sv-page-sub" style={{ marginTop: -2 }}>{full.description}</p>}

      {/* Two different "last" times, named. */}
      <div className="sv-defs" style={{ marginBottom: 10 }}>
        <span>
          <b>Layout last edited</b>{' '}
          {full.updated_at ? <span title={fmtTime(full.updated_at)}>{fmtRel(full.updated_at)}</span> : 'unknown'}
          <InfoTip label="Layout last edited">
            When someone last moved, added or removed something on this map. It says nothing
            about how current the statuses are.
          </InfoTip>
        </span>
        <span>
          <b>Status last refreshed</b>{' '}
          {statusAt ? <Freshness at={statusAt} staleAfterMs={2 * 60 * 1000} label="" prefixWhenStale="" /> : 'waiting for the first poll'}
          <InfoTip label="Status last refreshed">
            Node colours are re-fetched every 30 seconds. This is when that last succeeded.
          </InfoTip>
        </span>
      </div>
      {statusFailed && (
        <Notice tone="warn">
          The last live-status refresh failed, so the node colours below may be out of date.
        </Notice>
      )}

      <div className="sv-map-layout">
        <div ref={frameRef} className="sv-mapview-frame" style={{ aspectRatio: `${full.canvas_w} / ${full.canvas_h}` }}>
          <SVGMapView
            map={full}
            refreshUrl={`/api/maps/${id}`}
            interactive
            onRefresh={(ok) => { setStatusFailed(!ok); if (ok) setStatusAt(Date.now()); }}
          />
        </div>

        {/* Semantic node list — the non-canvas way to find and open anything
            on this map. */}
        <aside className="sv-map-nodes" aria-label="Nodes on this map">
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-light)' }}>
            <label className="sv-sr-only" htmlFor="map-node-search">Search nodes on this map</label>
            <input
              id="map-node-search"
              className="sv-input"
              style={{ width: '100%' }}
              placeholder="Search nodes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="sv-muted" style={{ fontSize: 'var(--text-sm)', marginTop: 6 }}>
              {nodes.length} of {full.devices.length} node{full.devices.length === 1 ? '' : 's'}
            </div>
          </div>
          <ul className="sv-map-nodelist">
            {nodes.map((d) => {
              const st = nodeStatus(d);
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    className={`sv-map-nodebtn${selectedId === d.id ? ' selected' : ''}`}
                    aria-pressed={selectedId === d.id}
                    onClick={() => setSelectedId(selectedId === d.id ? null : d.id)}
                  >
                    <SevTag sev={STATUS_SEV[st] ?? 'unknown'} label={st === 'suppressed' ? 'Suppressed' : undefined} />
                    <span className="nm">{nodeLabel(d)}</span>
                  </button>
                </li>
              );
            })}
            {!nodes.length && (
              <li style={{ padding: 14 }}><Empty message={q ? 'No node matches that search.' : 'This map has no nodes yet.'} /></li>
            )}
          </ul>
          {selected && (
            <div className="sv-map-nodedetail">
              <div style={{ fontWeight: 700 }}>{nodeLabel(selected)}</div>
              <dl className="sv-map-nodedl">
                <dt>Type</dt><dd>{nodeKind(selected)}</dd>
                <dt>Status</dt>
                <dd><SevTag sev={STATUS_SEV[nodeStatus(selected)] ?? 'unknown'} label={nodeStatus(selected) === 'suppressed' ? 'Suppressed' : undefined} /></dd>
                <dt>Site</dt><dd>{selected.site_name || 'Unassigned'}</dd>
                {selected.ip_address && <><dt>Address</dt><dd>{selected.ip_address}</dd></>}
                <dt>Last seen</dt>
                <dd>
                  {selected.service_check_id != null
                    ? <Freshness at={selected.service_last_checked_at} staleAfterMs={10 * 60 * 1000} label="" prefixWhenStale="" />
                    : <Freshness at={selected.last_seen_at} staleAfterMs={10 * 60 * 1000} label="" prefixWhenStale="" />}
                </dd>
              </dl>
              {nodeHref(selected)
                ? <Link className="sv-btn ghost sm" href={nodeHref(selected) as string}>Open {nodeKind(selected).toLowerCase()} →</Link>
                : <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
                    This node is not linked to a monitored device or service check, so it has no detail page.
                  </span>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

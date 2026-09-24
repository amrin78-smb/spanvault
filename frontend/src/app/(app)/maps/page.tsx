'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, EmptyState, fmtRel, fmtTime, useConfirm, TableSkeleton } from '@/components/ui';
import {
  IconLink, IconMap, IconDevices, IconArrowUp, IconArrowDown, IconWarning, IconTopology,
} from '@/components/icons';
import { statusFill } from '@/lib/mapTypes';
import type { MapSummary } from '@/lib/mapTypes';

const CANVAS_PRESETS = [
  { key: 'hd', label: 'HD — 1600 × 900', w: 1600, h: 900 },
  { key: 'fhd', label: 'FHD — 1920 × 1080', w: 1920, h: 1080 },
  { key: 'square', label: 'Square — 1200 × 1200', w: 1200, h: 1200 },
];

// How many discovered links the topology panel lists inline before deferring to
// the full /topology page.
const LINKS_PREVIEW_ROWS = 8;

// Persistent, manually-copyable public-link bar. Stays until dismissed; the
// clipboard API only works over HTTPS, so we fall back to selecting the text.
function ShareLinkBar({ url, onClose }: { url: string; onClose: () => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else if (ref.current) {
        ref.current.select();
        document.execCommand('copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      ref.current?.select();
    }
  }
  return (
    <div className="sv-share-bar">
      <span className="lbl"><IconLink width={13} height={13} style={{ verticalAlign: -2 }} /> Public link</span>
      <input ref={ref} className="sv-input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      <button className="sv-btn sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <button className="sv-btn ghost sm" onClick={onClose}>Close</button>
    </div>
  );
}

export default function MapsPage() {
  const { canEdit } = useRbac();
  const { confirm, ConfirmUI } = useConfirm();
  // Live status is part of this response now (up/down per map), so poll it the
  // way every other status surface in the app does rather than loading once.
  const maps = useApi<MapSummary[]>('/api/maps', 30000);
  const [showCreate, setShowCreate] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  async function handleDelete(m: MapSummary) {
    if (!(await confirm({ title: 'Delete map', message: `Delete map "${m.name}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    await apiSend(`/api/maps/${m.id}`, 'DELETE');
    maps.reload();
  }

  async function handleShare(m: MapSummary) {
    let isPublic = m.is_public;
    let uuid = m.uuid;
    if (!isPublic) {
      if (!(await confirm({ title: 'Make map public', message: `"${m.name}" is private. Make it public so anyone with the link can view it?`, confirmLabel: 'Make public' }))) return;
      const r = await apiSend<{ is_public: boolean; uuid: string }>(`/api/maps/${m.id}/toggle-public`, 'POST', {});
      isPublic = r.is_public;
      uuid = r.uuid;
      maps.reload();
    }
    // Show a persistent, copyable bar — auto-copy via the clipboard API only works
    // in a secure (HTTPS) context, so over plain HTTP the user copies manually.
    const url = `${window.location.origin}/maps/public/${uuid}`;
    setShareUrl(url);
  }

  const list = maps.data || [];
  // Estate rollup — every number below is summed from the /api/maps rows, not
  // derived or estimated.
  const publicCount = list.filter((m) => m.is_public).length;
  const nodesPlaced = list.reduce((n, m) => n + (m.device_count || 0), 0);
  const linkedNodes = list.reduce((n, m) => n + (m.linked_count || 0), 0);
  const upNodes = list.reduce((n, m) => n + (m.up_count || 0), 0);
  const downNodes = list.reduce((n, m) => n + (m.down_count || 0), 0);
  const attentionNodes = list.reduce((n, m) => n + (m.warning_count || 0) + (m.unknown_count || 0), 0);
  const mapsWithDown = list.filter((m) => (m.down_count || 0) > 0).length;
  // Only claim a status rollup when the API actually returned one — an older
  // API (no linked_count) would otherwise render an authoritative-looking
  // "0 up / 0 down" for a perfectly healthy estate.
  const hasRollup = list.some((m) => m.linked_count != null);
  const upPct = linkedNodes ? Math.round((upNodes / linkedNodes) * 100) : 0;

  return (
    <div>
      {ConfirmUI}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 className="sv-page-title" style={{ margin: 0 }}>Maps</h1>
        <div style={{ flex: 1 }} />
        <a className="sv-btn ghost sm tint-violet" href="/maps/wall" target="_blank" rel="noopener noreferrer" title="Full-screen rotating wallboard">Wallboard ↗</a>
        {canEdit && <button className="sv-btn" onClick={() => setShowCreate(true)}>+ New Map</button>}
      </div>
      <p className="sv-page-sub">Design interactive network maps with live device status.</p>

      {maps.error && <ErrorBox message={maps.error} />}

      {!!list.length && (
        <div className="sv-cards" style={{ marginBottom: 18 }}>
          <MapStatTile
            icon={<IconMap width={19} height={19} />} variant="total"
            value={list.length} label={list.length === 1 ? 'Map' : 'Maps'}
            sub={`${publicCount} public · ${list.length - publicCount} private`}
            tint={{ bg: 'var(--surface-subtle)', fg: 'var(--text-secondary)' }}
          />
          <MapStatTile
            icon={<IconDevices width={19} height={19} />} variant="unknown"
            value={nodesPlaced} label="Nodes Placed"
            sub={hasRollup ? `${linkedNodes} linked to a device or service` : 'Across all maps'}
            tint={{ bg: 'var(--surface-subtle)', fg: 'var(--text-secondary)' }}
          />
          {hasRollup && (
            <>
              <MapStatTile
                icon={<IconArrowUp width={19} height={19} />} variant="up"
                value={upNodes} label="Up"
                sub={linkedNodes ? `${upPct}% of linked nodes` : 'No linked nodes yet'}
                tint={{ bg: 'var(--tint-success)', fg: 'var(--tint-success-fg)' }}
              />
              <MapStatTile
                icon={<IconArrowDown width={19} height={19} />} variant="down"
                value={downNodes} label="Down"
                sub={downNodes ? `${mapsWithDown} map${mapsWithDown === 1 ? '' : 's'} affected` : 'All mapped nodes reachable'}
                tint={{ bg: 'var(--tint-danger)', fg: 'var(--tint-danger-fg)' }}
              />
              <MapStatTile
                icon={<IconWarning width={19} height={19} />} variant="warning"
                value={attentionNodes} label="Needs Attention"
                sub="Warning or not reporting"
                tint={{ bg: 'var(--tint-warn)', fg: 'var(--tint-warn-fg)' }}
              />
            </>
          )}
        </div>
      )}

      {shareUrl && <ShareLinkBar url={shareUrl} onClose={() => setShareUrl(null)} />}

      {maps.loading && !maps.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : list.length ? (
        <div className="sv-map-cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', marginBottom: 20 }}>
          {list.map((m) => (
            <MapCard key={m.id} map={m} onDelete={handleDelete} onShare={handleShare} />
          ))}
          {canEdit && <NewMapTile onClick={() => setShowCreate(true)} />}
        </div>
      ) : (
        <div className="sv-panel" style={{ padding: 0, marginBottom: 20 }}>
          <EmptyState
            icon={<IconMap width={26} height={26} />}
            title="No maps yet"
            message="A map is a drawn view of your network — drop monitored devices and service checks onto a canvas, link them, and every node shows its live status. Maps can be shared read-only via a public link or rotated on the wallboard."
            actionLabel={canEdit ? '+ New Map' : undefined}
            onAction={canEdit ? () => setShowCreate(true) : undefined}
          />
        </div>
      )}

      <TopologyPanel />

      {showCreate && (
        <CreateMapModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); maps.reload(); }}
        />
      )}
    </div>
  );
}

// ── KPI tile (top-level component) ─────────────────────────────
// Same shape as the Services page's StatTile: the suite's bordered card with a
// status-keyed LEFT border (CLAUDE.md) plus a tinted icon disc. Kept local
// because it isn't shared yet — see the report note about promoting it.
function MapStatTile({ icon, value, label, sub, variant, tint }: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  sub?: string;
  variant: 'total' | 'up' | 'down' | 'warning' | 'unknown';
  tint: { bg: string; fg: string };
}) {
  return (
    <div className={`sv-card ${variant}`} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <span
        aria-hidden
        style={{
          width: 42, height: 42, flex: '0 0 auto',
          borderRadius: '50%', /* intentional: true circle (stat tile icon) */
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: tint.bg, color: tint.fg,
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="num" style={{ display: 'block', lineHeight: 1.1 }}>{value}</span>
        <span className="label" style={{ display: 'block' }}>{label}</span>
        {sub && (
          <span className="sv-muted" style={{ display: 'block', fontSize: 'var(--text-sm)', marginTop: 2 }}>
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

// ── Map thumbnail (top-level component) ────────────────────────
// A true miniature of the map, drawn from the geometry GET /api/maps returns in
// `preview` (canvas-space coordinates). A viewBox of the map's own canvas size
// does all the scaling, so this is the SAME geometry the full SVGMapView
// renders — just smaller, without labels, and with no extra request per card.
//
// The raw hexes here are deliberate and match SVGMapView's canvas: a map draws
// on its own stored `bg_color`, which is user data and does not flip with the
// theme, so the ink on top of it must not flip either. Node fills come from the
// shared statusFill() helper rather than being spelled out.
//
// The no-bg_color fallback is `var(--canvas-light)` — the same token the card's
// .thumb container falls back to, so a map without a stored colour gets ONE
// background, not two different ones in dark mode. --canvas-light has no dark
// override on purpose. Because that makes the thumbnail a LIGHT island inside a
// possibly-dark page, the container also carries `.sv-canvas-light`, which pins
// the --tint-*/--text-* tokens to their light values for everything layered on
// top (the Public and "N down" badges, the empty-map glyph) — without it those
// badges resolve dark-mode tints over near-white and read at 1.2:1.
function thumbFill(s: string): string {
  // An unlinked (label-only) node has real geometry but no live status — draw
  // it in the same muted grey statusFill uses for a suppressed node.
  if (s === 'unlinked') return statusFill(null, true);
  return statusFill(s);
}

function MapThumb({ map }: { map: MapSummary }) {
  const w = Number(map.canvas_w) || 1600;
  const h = Number(map.canvas_h) || 900;
  const nodes = map.preview?.nodes || [];
  const links = map.preview?.links || [];
  const shapes = map.preview?.shapes || [];

  if (!nodes.length && !shapes.length) {
    return (
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none"
        stroke="var(--text-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        role="img" aria-label="Empty map">
        <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
        <line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" />
      </svg>
    );
  }

  // Stroke/corner sizes are expressed in canvas units so they shrink with the
  // viewBox — derived from the canvas size so a 1920-wide and a 600-wide map
  // end up with comparable line weights at the same thumbnail height.
  const u = Math.max(w, h) / 200;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', width: '100%', height: '100%' }}
      role="img"
      aria-label={`${map.name} preview — ${nodes.length} node${nodes.length === 1 ? '' : 's'}`}
    >
      <rect x={0} y={0} width={w} height={h} style={{ fill: map.bg_color || 'var(--canvas-light)' }} />
      {shapes.map((s, i) => (
        <rect key={`s${i}`} x={s.x} y={s.y} width={s.w} height={s.h} rx={u * 2}
          fill="none" stroke="#94a3b8" strokeOpacity={0.55} strokeWidth={u}
          strokeDasharray={`${u * 3} ${u * 3}`} />
      ))}
      {links.map((l, i) => (
        <line key={`l${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="#64748b" strokeOpacity={0.75} strokeWidth={u * 1.1} strokeLinecap="round" />
      ))}
      {nodes.map((n, i) => (n.i ? (
        <circle key={`n${i}`} cx={n.x + n.w / 2} cy={n.y + n.h / 2}
          r={Math.max(u * 1.6, Math.min(n.w, n.h) / 2)}
          fill={thumbFill(n.s)} stroke="#ffffff" strokeOpacity={0.6} strokeWidth={u * 0.5} />
      ) : (
        <rect key={`n${i}`} x={n.x} y={n.y} width={n.w} height={n.h} rx={u * 2}
          fill={thumbFill(n.s)} stroke="#ffffff" strokeOpacity={0.6} strokeWidth={u * 0.5} />
      )))}
    </svg>
  );
}

// ── Live status rollup line (top-level component) ──────────────
function MapStatusLine({ map }: { map: MapSummary }) {
  const total = map.device_count || 0;
  if (map.linked_count == null) {
    return <>{total} node{total === 1 ? '' : 's'}</>;
  }
  const parts: { n: number; label: string; color: string }[] = [
    { n: map.up_count || 0, label: 'up', color: 'var(--sv-up)' },
    { n: map.down_count || 0, label: 'down', color: 'var(--sv-down)' },
    { n: map.warning_count || 0, label: 'warning', color: 'var(--sv-warning)' },
    { n: map.unknown_count || 0, label: 'unknown', color: 'var(--sv-unknown)' },
  ].filter((p) => p.n > 0);
  return (
    <>
      {total} node{total === 1 ? '' : 's'}
      {parts.map((p) => (
        <span key={p.label}>
          {' · '}
          <span style={{ color: p.color, fontWeight: 700 }}>{p.n}</span>{` ${p.label}`}
        </span>
      ))}
    </>
  );
}

// ── Map card (top-level component) ─────────────────────────────
function MapCard({
  map, onDelete, onShare,
}: {
  map: MapSummary;
  onDelete: (m: MapSummary) => void;
  onShare: (m: MapSummary) => void;
}) {
  const { canEdit } = useRbac();
  const down = map.down_count || 0;
  return (
    <div className="sv-map-card">
      <a
        href={`/maps/${map.id}`}
        className="thumb sv-canvas-light"
        style={{ background: map.bg_color || 'var(--canvas-light)', height: 150, padding: 6, textDecoration: 'none' }}
        title={`Open ${map.name}`}
      >
        <MapThumb map={map} />
        {map.is_public && <span className="sv-map-public">Public</span>}
        {down > 0 && (
          <span
            style={{
              position: 'absolute', top: 8, left: 8, fontSize: 'var(--text-xs)', fontWeight: 700,
              color: 'var(--tint-danger-fg)', background: 'var(--tint-danger)',
              border: '1px solid var(--tint-danger)', borderRadius: 'var(--radius-pill)', padding: '2px 9px',
            }}
          >
            {down} down
          </span>
        )}
      </a>
      <div className="body">
        <div className="nm" title={map.name}>{map.name}</div>
        {map.description && <div className="desc" title={map.description}>{map.description}</div>}
        <div className="meta"><MapStatusLine map={map} /></div>
        <div className="meta">
          {map.canvas_w}×{map.canvas_h} · updated {fmtRel(map.updated_at)}
        </div>
        <div className="actions">
          {canEdit && <a className="sv-btn ghost sm" href={`/maps/${map.id}/edit`}>Edit</a>}
          <a className="sv-btn ghost sm" href={`/maps/${map.id}`}>View</a>
          {canEdit && <button className="sv-btn ghost sm" onClick={() => onShare(map)}>Share</button>}
          <div style={{ flex: 1 }} />
          {canEdit && <button className="sv-btn danger sm" onClick={() => onDelete(map)} title="Delete map">Delete</button>}
        </div>
      </div>
    </div>
  );
}

// ── "New map" ghost tile (top-level component) ─────────────────
// Sits as the last item in the card grid so a short list still reads as a
// deliberate row rather than one card marooned in white space.
function NewMapTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: '1px dashed var(--border)', borderRadius: 'var(--radius)',
        background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
        minHeight: 200, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 8, font: 'inherit',
      }}
      title="Create a new map"
    >
      <IconMap width={26} height={26} />
      <span style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-secondary)' }}>New map</span>
      <span style={{ fontSize: 'var(--text-sm)' }}>Blank canvas, then drag devices on</span>
    </button>
  );
}

// ── Topology discovery panel (top-level component) ─────────────
type TopologyStatus = {
  running: boolean;
  last_run_at: string | null;
  links_found: number;
  devices_discovered: number;
};

type TopologyLink = {
  id: number;
  from_device_id: number;
  from_device_name: string | null;
  from_site: string | null;
  from_port: string | null;
  to_device_id: number | null;
  to_device_name: string | null;
  to_name: string | null;
  to_ip: string | null;
  to_port: string | null;
  protocol: string | null;
  last_seen_at: string | null;
};

function TopologyPanel() {
  const { canEdit } = useRbac();
  const status = useApi<TopologyStatus>('/api/topology/status', 0);
  const links = useApi<TopologyLink[]>('/api/topology/links', 0);
  const [running, setRunning] = useState(false);

  async function runDiscovery() {
    setRunning(true);
    try {
      await apiSend('/api/topology/discover', 'POST', {});
      // Discovery runs in the background; give it a moment, then refresh.
      setTimeout(() => { status.reload(); links.reload(); setRunning(false); }, 2500);
    } catch {
      setRunning(false);
    }
  }

  const s = status.data;
  const busy = running || !!s?.running;
  const all = links.data || [];
  // Newest neighbours first — the interesting ones after a run are the ones it
  // just touched. `last_seen_at` can be null on an old row; those sort last.
  const rows = [...all]
    .sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''))
    .slice(0, LINKS_PREVIEW_ROWS);

  return (
    <div className="sv-panel">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 'var(--radius)', flex: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface-subtle)', border: '1px solid var(--border)', color: 'var(--primary)',
        }}>
          <IconTopology width={20} height={20} />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 700, fontSize: 'var(--text-md)' }}>Network Topology Discovery</div>
          <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
            Auto-discover device connections via LLDP and CDP, then draw them on a map.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {canEdit && (
            <button className="sv-btn" onClick={runDiscovery} disabled={busy}>
              {busy ? 'Running…' : 'Run Discovery'}
            </button>
          )}
          <a className="sv-btn ghost" href="/topology">View Topology</a>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 14 }}>
        <TopologyStat value={busy ? '…' : (s ? String(s.links_found) : '—')} label="Links found" />
        <TopologyStat value={busy ? '…' : (s ? String(s.devices_discovered) : '—')} label="Devices with neighbours" />
        <TopologyStat
          value={busy ? 'Running…' : (s?.last_run_at ? fmtRel(s.last_run_at) : 'Never')}
          label="Last discovery run"
          title={s?.last_run_at ? fmtTime(s.last_run_at) : undefined}
        />
      </div>

      {links.loading && !links.data ? (
        <TableSkeleton rows={4} cols={4} />
      ) : rows.length ? (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="sv-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Local port</th>
                  <th>Neighbour</th>
                  <th>Remote port</th>
                  <th>Protocol</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <a href={`/devices/${l.from_device_id}`} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                        {l.from_device_name || `#${l.from_device_id}`}
                      </a>
                      {l.from_site && (
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{l.from_site}</div>
                      )}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{l.from_port || '—'}</td>
                    <td>
                      {l.to_device_id ? (
                        <a href={`/devices/${l.to_device_id}`} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                          {l.to_device_name || l.to_name || `#${l.to_device_id}`}
                        </a>
                      ) : (
                        <span>{l.to_name || l.to_ip || 'Unknown neighbour'}</span>
                      )}
                      {l.to_ip && (
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{l.to_ip}</div>
                      )}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{l.to_port || '—'}</td>
                    <td>
                      <span style={{
                        fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase',
                        color: 'var(--tint-info-fg)', background: 'var(--tint-info)',
                        borderRadius: 'var(--radius-pill)', padding: '2px 8px',
                      }}>
                        {l.protocol || 'link'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }} title={l.last_seen_at ? fmtTime(l.last_seen_at) : undefined}>
                      {fmtRel(l.last_seen_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Showing {rows.length} of {all.length} discovered link{all.length === 1 ? '' : 's'} ·{' '}
            <a href="/topology">See the full topology map →</a>
          </div>
        </>
      ) : (
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', margin: 0 }}>
          No neighbour links discovered yet. Run discovery to walk LLDP/CDP on your SNMP-enabled devices.
        </p>
      )}
    </div>
  );
}

function TopologyStat({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div title={title}>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
      <div style={{
        fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em',
        color: 'var(--text-muted)', marginTop: 4,
      }}>
        {label}
      </div>
    </div>
  );
}

// ── Create map modal (top-level component) ─────────────────────
function CreateMapModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [preset, setPreset] = useState('hd');
  const [bgColor, setBgColor] = useState('#f8fafc');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) { setErr('Name is required'); return; }
    const p = CANVAS_PRESETS.find((x) => x.key === preset) || CANVAS_PRESETS[0];
    setSaving(true);
    setErr(null);
    try {
      const m = await apiSend<{ id: number }>('/api/maps', 'POST', {
        name: name.trim(),
        description: description.trim() || null,
        bg_color: bgColor,
        canvas_w: p.w,
        canvas_h: p.h,
      });
      onCreated(m.id);
      router.push(`/maps/${m.id}/edit`);
    } catch (e: any) {
      setErr(e?.message || 'Failed to create map');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>New Map</h2>
        {err && <ErrorBox message={err} />}
        <div className="sv-form-grid">
          <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Name
            <input className="sv-input" value={name} autoFocus
              onChange={(e) => setName(e.target.value)} placeholder="e.g. Core Network" />
          </label>
          <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Description
            <input className="sv-input" value={description}
              onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </label>
          <label className="sv-field">Canvas size
            <select className="sv-select" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {CANVAS_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          <label className="sv-field">Background color
            <input type="color" className="sv-input" value={bgColor}
              onChange={(e) => setBgColor(e.target.value)} style={{ height: 40, padding: 4 }} />
          </label>
        </div>
        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={create} disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create & Edit'}
          </button>
        </div>
      </div>
    </div>
  );
}

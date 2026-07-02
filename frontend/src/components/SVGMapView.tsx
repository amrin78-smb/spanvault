'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import {
  type FullMap, type MapDevice, type MapConnection, type MapLabel, type MapShape, type MapNodeLike,
  statusFill, deviceCenter, connLive, utilColor, fmtBps, elbowPoints, nodeAnchorBox, edgePoint,
} from '@/lib/mapTypes';
import { MapGlyph, deviceGlyphFor, isGlyphKind } from '@/lib/mapIcons';

const DEFAULT_LINE = '#94a3b8';

// Live-status poll cadence. Exported so consumers (e.g. the NOC wallboard) can
// derive staleness thresholds from the same number the poll actually uses.
export const LIVE_REFRESH_MS = 30000;

/**
 * Read-only renderer for a designed map. Layout (positions/connections/labels)
 * comes from `map` and never changes here. When `refreshUrl` is set, only live
 * device status is re-fetched every 30s and merged in — positions never jump.
 */
export default function SVGMapView({
  map, refreshUrl, interactive = false, onRefresh,
}: {
  map: FullMap;
  refreshUrl?: string;
  interactive?: boolean;
  // Reports each live-status poll result so a host (e.g. the wallboard) can
  // detect stale data. `true` = a poll succeeded, `false` = it failed.
  onRefresh?: (ok: boolean) => void;
}) {
  const router = useRouter();
  // Ref so the poll effect never re-subscribes when the callback identity changes.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const [live, setLive] = useState<Record<number, Partial<MapDevice>>>({});
  const [liveConns, setLiveConns] = useState<Record<number, Partial<MapConnection>>>({});

  // ── Zoom / pan (screen-space CSS transform on a wrapper) ──
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panning = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const justPanned = useRef(false);
  const ZMIN = 0.3, ZMAX = 4;
  const clampZ = (z: number) => Math.max(ZMIN, Math.min(ZMAX, z));

  // Wheel zoom toward the cursor (non-passive so we can preventDefault scroll).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      setZoom((z) => {
        const nz = clampZ(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        const k = nz / z;
        setPan((p) => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
        return nz;
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Drag to pan (window listeners so the drag survives leaving the element).
  useEffect(() => {
    function move(e: MouseEvent) {
      const p = panning.current;
      if (!p) return;
      const dx = e.clientX - p.sx, dy = e.clientY - p.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
      setPan({ x: p.ox + dx, y: p.oy + dy });
    }
    function up() {
      const p = panning.current;
      if (p && p.moved) { justPanned.current = true; setTimeout(() => { justPanned.current = false; }, 0); }
      panning.current = null;
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  function onWrapMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    panning.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y, moved: false };
  }
  function zoomByCenter(factor: number) {
    const el = wrapRef.current;
    const cx = el ? el.clientWidth / 2 : 0;
    const cy = el ? el.clientHeight / 2 : 0;
    setZoom((z) => {
      const nz = clampZ(z * factor);
      const k = nz / z;
      setPan((p) => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
      return nz;
    });
  }
  function resetView() { setZoom(1); setPan({ x: 0, y: 0 }); }

  useEffect(() => {
    if (!refreshUrl) return;
    let stopped = false;
    async function poll() {
      try {
        const fresh = await apiGet<FullMap>(refreshUrl as string);
        if (stopped) return;
        const next: Record<number, Partial<MapDevice>> = {};
        for (const d of fresh.devices || []) {
          next[d.id] = {
            current_status: d.current_status,
            last_response_ms: d.last_response_ms,
            last_seen_at: d.last_seen_at,
            alert_suppressed: d.alert_suppressed,
            is_gateway: d.is_gateway,
            latest_cpu_pct: d.latest_cpu_pct,
            latest_mem_pct: d.latest_mem_pct,
            uptime_24h_pct: d.uptime_24h_pct,
            alert_count: d.alert_count,
          };
        }
        setLive(next);
        // Refresh weathermap link stats too, so bound connections re-colour live.
        const nextC: Record<number, Partial<MapConnection>> = {};
        for (const c of fresh.connections || []) {
          nextC[c.id] = {
            from_in_bps: c.from_in_bps, from_out_bps: c.from_out_bps, from_oper: c.from_oper,
            to_in_bps: c.to_in_bps, to_out_bps: c.to_out_bps, to_oper: c.to_oper,
          };
        }
        setLiveConns(nextC);
        onRefreshRef.current?.(true);
      } catch {
        /* keep last-known status on transient failure, but flag it as stale */
        if (!stopped) onRefreshRef.current?.(false);
      }
    }
    const id = setInterval(poll, LIVE_REFRESH_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [refreshUrl]);

  // Merge live status over the static layout devices.
  const devices: MapDevice[] = (map.devices || []).map((d) => ({ ...d, ...(live[d.id] || {}) }));
  const byId = new Map<number, MapDevice>();
  for (const d of devices) byId.set(d.id, d);
  const shapeById = new Map<number, MapShape>();
  for (const s of map.shapes || []) shapeById.set(s.id, s);
  // Merge fresh interface stats over the static connections (weathermap).
  const connections: MapConnection[] = (map.connections || []).map((c) => ({ ...c, ...(liveConns[c.id] || {}) }));

  function onNodeClick(d: MapDevice) {
    if (justPanned.current) return; // ignore the click that ends a pan-drag
    if (!interactive) return;
    if (d.drill_map_id) { router.push(`/maps/${d.drill_map_id}`); return; } // drill into child map
    if (d.device_id) router.push(`/devices/${d.device_id}`);
  }

  // Status tally for the legend (only statuses actually present are shown).
  const counts: Record<string, number> = { up: 0, down: 0, warning: 0, unknown: 0 };
  for (const d of devices) {
    if (d.alert_suppressed) { counts.unknown++; continue; }
    const s = (d.current_status || 'unknown').toLowerCase();
    counts[s in counts ? s : 'unknown']++;
  }
  const legendItems = ([
    ['up', '#22c55e', 'Up'], ['down', '#ef4444', 'Down'],
    ['warning', '#eab308', 'Warning'], ['unknown', '#94a3b8', 'Unknown'],
  ] as const).filter(([k]) => counts[k] > 0);

  return (
    <div className="sv-mapview-wrap" ref={wrapRef} onMouseDown={onWrapMouseDown}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', cursor: panning.current ? 'grabbing' : 'grab' }}>
    <div className="sv-mapview-zoom" style={{
      width: '100%', height: '100%', transformOrigin: '0 0',
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    }}>
    <svg
      className="sv-mapview"
      viewBox={`0 0 ${map.canvas_w} ${map.canvas_h}`}
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
    >
      <defs>
        <pattern id="sv-suppressed-stripe" patternUnits="userSpaceOnUse" width="8" height="8"
          patternTransform="rotate(45)">
          <rect width="8" height="8" fill="#cbd5e1" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="#94a3b8" strokeWidth="3" />
        </pattern>
      </defs>

      {/* Background */}
      {map.bg_image_b64 ? (
        <image href={map.bg_image_b64} x="0" y="0" width={map.canvas_w} height={map.canvas_h}
          preserveAspectRatio="xMidYMid slice" />
      ) : (
        <rect x="0" y="0" width={map.canvas_w} height={map.canvas_h} fill={map.bg_color || '#f8fafc'} />
      )}

      {/* Decorative shapes (z-sorted, beneath the nodes) */}
      {[...(map.shapes || [])].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0) || a.id - b.id).map((s) => (
        <ShapeEl key={`s-${s.id}`} shape={s} />
      ))}

      {/* Connections (under the nodes) — endpoints may be devices or shapes */}
      {connections.map((c) => (
        <ConnectionLine key={c.id} conn={c}
          from={c.from_kind === 'shape' ? shapeById.get(c.from_item_id) : byId.get(c.from_item_id)}
          to={c.to_kind === 'shape' ? shapeById.get(c.to_item_id) : byId.get(c.to_item_id)} />
      ))}

      {/* Device nodes (z-sorted) */}
      {[...devices].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0) || a.id - b.id).map((d) => (
        <DeviceNode key={d.id} device={d} interactive={interactive} onClick={onNodeClick} />
      ))}

      {/* Free-floating labels */}
      {(map.labels || []).map((l) => (
        <MapLabelText key={l.id} label={l} />
      ))}
    </svg>
    </div>

      {/* Zoom controls */}
      <div className="sv-map-zoomctl" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" title="Zoom in" onClick={() => zoomByCenter(1.2)}>+</button>
        <button type="button" title="Zoom out" onClick={() => zoomByCenter(1 / 1.2)}>−</button>
        <button type="button" title="Fit / reset" onClick={resetView}>⤢</button>
        <span className="lvl">{Math.round(zoom * 100)}%</span>
      </div>

      {/* Status legend */}
      {legendItems.length > 0 && (
        <div className="sv-map-legend" onMouseDown={(e) => e.stopPropagation()}>
          {legendItems.map(([k, color, label]) => (
            <span key={k} className="item">
              <span className="dot" style={{ background: color }} />
              {label} <b>{counts[k]}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Connection line (top-level component) ──────────────────────
export function ConnectionLine({
  conn, from, to,
}: {
  conn: MapConnection;
  from?: MapNodeLike;
  to?: MapNodeLike;
}) {
  if (!from || !to) return null;
  // Anchor each end to the node's edge (glyph box for icon nodes) so the line
  // touches the perimeter instead of running into the middle of the icon.
  const ca = deviceCenter(from);
  const cb = deviceCenter(to);
  const a = edgePoint(nodeAnchorBox(from), cb.cx, cb.cy);
  const b = edgePoint(nodeAnchorBox(to), ca.cx, ca.cy);
  const geo = conn.routing === 'elbow' ? elbowPoints(a, b, conn.waypoints) : null;

  // A connection bound to interface(s) becomes a live weathermap link: colour by
  // utilization (green→red), dashed red when the link is down, with an animated
  // flow and a util%/throughput label. Bound links ignore the custom colour.
  const live = connLive(conn);
  let stroke = conn.color || DEFAULT_LINE;
  let dash: string | undefined = conn.line_style === 'dashed' ? '8 6' : undefined;
  let liveLabel: string | null = null;
  let flow = false;
  if (live.bound) {
    if (live.down) {
      stroke = '#ef4444'; dash = '7 5'; liveLabel = 'DOWN';
    } else {
      stroke = live.pct != null ? utilColor(live.pct) : '#22c55e';
      flow = live.bps != null && live.bps > 0;
      liveLabel = live.pct != null ? `${live.pct.toFixed(0)}%`
        : live.bps != null ? fmtBps(live.bps) : null;
    }
  } else {
    // Unbound: keep the legacy status-based colouring for default-coloured lines.
    const custom = (conn.color || '').toLowerCase() !== DEFAULT_LINE;
    if (!custom) {
      // Status colouring only applies to device endpoints; shapes have no status.
      const fs = (from as MapDevice).current_status;
      const ts = (to as MapDevice).current_status;
      if (fs === 'down' || ts === 'down') stroke = '#ef4444';
      else if (fs === 'up' && ts === 'up') stroke = '#22c55e';
      else stroke = DEFAULT_LINE;
    }
  }

  const mx = geo ? geo.mx : (a.cx + b.cx) / 2;
  const my = geo ? geo.my : (a.cy + b.cy) / 2;
  const width = Number(conn.width) || 2;
  const textLabel = [conn.label, liveLabel].filter(Boolean).join(' · ') || null;

  // Directional arrowhead at the 'to' end, oriented along the final segment.
  let arrowPath: string | null = null;
  if (conn.arrow) {
    let ux: number, uy: number;
    if (geo) { ux = geo.ux; uy = geo.uy; }
    else { const dx = b.cx - a.cx, dy = b.cy - a.cy; const len = Math.hypot(dx, dy) || 1; ux = dx / len; uy = dy / len; }
    const px = -uy, py = ux;
    const head = 12, half = 6;
    const baseX = b.cx - ux * head, baseY = b.cy - uy * head;
    arrowPath = `M${b.cx} ${b.cy} L${baseX + px * half} ${baseY + py * half} L${baseX - px * half} ${baseY - py * half} Z`;
  }

  return (
    <g>
      {geo ? (
        <path d={geo.d} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={dash} />
      ) : (
        <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke={stroke} strokeWidth={width} strokeDasharray={dash} />
      )}
      {flow && (geo ? (
        <path d={geo.d} fill="none" stroke="#ffffff" strokeWidth={Math.max(1.5, width - 0.5)} strokeLinecap="round"
          strokeDasharray="1 14" opacity={0.85} className="sv-link-flow" pointerEvents="none" />
      ) : (
        <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy}
          stroke="#ffffff" strokeWidth={Math.max(1.5, width - 0.5)} strokeLinecap="round"
          strokeDasharray="1 14" opacity={0.85} className="sv-link-flow" pointerEvents="none" />
      ))}
      {arrowPath && <path d={arrowPath} fill={stroke} />}
      {textLabel && (
        <text x={mx} y={my - 4} textAnchor="middle" fontSize={12} fill="#475569"
          style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 3 }}>
          {textLabel}
        </text>
      )}
    </g>
  );
}

// ── Device node (top-level component) ──────────────────────────
export function DeviceNode({
  device, interactive, onClick,
}: {
  device: MapDevice;
  interactive: boolean;
  onClick: (d: MapDevice) => void;
}) {
  const status = (device.current_status || 'unknown').toLowerCase();
  const suppressed = !!device.alert_suppressed;
  const name = device.label || device.device_name || 'Device';
  const ip = device.ip_address || '';
  const x = Number(device.x);
  const y = Number(device.y);
  const w = Number(device.width);
  const h = Number(device.height);
  const cx = x + w / 2;
  const color = suppressed ? '#94a3b8' : statusFill(status, false);
  const pulse = !suppressed && (status === 'down' || status === 'warning');
  const drill = device.drill_map_id != null;
  const cursor = interactive && (device.device_id || drill) ? 'pointer' : 'default';
  const alertCount = Number(device.alert_count) || 0;

  const tipLines = [
    `${name}${ip ? `  ${ip}` : ''}${device.site_name ? ` · ${device.site_name}` : ''}`,
    `Status: ${suppressed ? 'suppressed' : status}` +
      (device.last_response_ms != null ? ` · ${Number(device.last_response_ms).toFixed(0)} ms` : ''),
  ];
  const metricBits: string[] = [];
  if (device.latest_cpu_pct != null) metricBits.push(`CPU ${Number(device.latest_cpu_pct).toFixed(0)}%`);
  if (device.latest_mem_pct != null) metricBits.push(`Mem ${Number(device.latest_mem_pct).toFixed(0)}%`);
  if (device.uptime_24h_pct != null) metricBits.push(`Uptime ${Number(device.uptime_24h_pct).toFixed(1)}% (24h)`);
  if (metricBits.length) tipLines.push(metricBits.join(' · '));
  if (alertCount > 0) tipLines.push(`${alertCount} active alert${alertCount > 1 ? 's' : ''}`);
  if (drill) tipLines.push('↳ Opens sub-map');
  const tip = tipLines.join('\n');

  // Navy "sub-map" badge at the bottom-right when this node drills into a child map.
  const drillMark = drill ? (
    <g pointerEvents="none">
      <circle cx={x + w} cy={y + h} r={8} fill="#1a2744" stroke="#fff" strokeWidth={1.5} />
      <text x={x + w} y={y + h + 3.4} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">⊞</text>
    </g>
  ) : null;

  // Red alert-count badge pinned to the node's top-right corner.
  const badge = alertCount > 0 && !suppressed ? (
    <g pointerEvents="none">
      <circle cx={x + w} cy={y} r={9} fill="#dc2626" stroke="#fff" strokeWidth={1.5} />
      <text x={x + w} y={y + 3.6} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">
        {alertCount > 9 ? '9+' : alertCount}
      </text>
    </g>
  ) : null;

  // ── Icon style: device glyph + label beneath (never overflows) ──
  if (device.node_style === 'icon') {
    const glyphKind = device.icon_type && device.icon_type !== 'auto'
      ? device.icon_type : deviceGlyphFor(device.device_name);
    const gs = Math.max(24, Math.min(w, h));
    const gx = cx - gs / 2;
    const gy = y + Math.max(0, (h - gs) / 2);
    const halo = { paintOrder: 'stroke' as const, stroke: '#fff', strokeWidth: 3 };
    return (
      <g onClick={() => onClick(device)} style={{ cursor }} className={pulse ? 'sv-mapnode-pulse' : undefined}>
        <title>{tip}</title>
        <MapGlyph kind={glyphKind} x={gx} y={gy} size={gs} color={color} />
        {device.is_gateway && <text x={x + 2} y={y + 14} fontSize={14}>⭐</text>}
        <text x={cx} y={y + h + 14} textAnchor="middle" fontSize={13} fontWeight={700} fill="#1a2744" style={halo}>{name}</text>
        {ip && <text x={cx} y={y + h + 28} textAnchor="middle" fontSize={10} fill="#475569" style={halo}>{ip}</text>}
        {badge}
        {drillMark}
      </g>
    );
  }

  // ── Box style: filled status box, label wraps inside ──
  const fill = suppressed ? 'url(#sv-suppressed-stripe)' : color;
  return (
    <g onClick={() => onClick(device)} style={{ cursor }}>
      <title>{tip}</title>
      <rect
        x={x} y={y} width={w} height={h} rx={8} ry={8}
        fill={fill} stroke="#0f172a" strokeOpacity={0.15} strokeWidth={1}
        className={pulse ? 'sv-mapnode-pulse' : undefined}
      />
      <foreignObject x={x} y={y} width={w} height={h} style={{ pointerEvents: 'none' }}>
        <div style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', padding: '4px 6px',
          boxSizing: 'border-box', textAlign: 'center', overflow: 'hidden', lineHeight: 1.15,
        }}>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: 13, wordBreak: 'break-word' }}>{name}</div>
          {ip && <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 10, wordBreak: 'break-word' }}>{ip}</div>}
        </div>
      </foreignObject>
      {device.is_gateway && <text x={x + 5} y={y + 16} fontSize={14}>⭐</text>}
      {badge}
      {drillMark}
    </g>
  );
}

// ── Decorative shape / glyph (top-level component) ─────────────
export function ShapeEl({ shape }: { shape: MapShape }) {
  const x = Number(shape.x), y = Number(shape.y), w = Number(shape.width), h = Number(shape.height);
  const fill = shape.fill || 'none';
  const stroke = shape.stroke || '#334155';
  const sw = Number(shape.stroke_width) || 2;
  const rot = Number(shape.rotation) || 0;
  const transform = rot ? `rotate(${rot} ${x + w / 2} ${y + h / 2})` : undefined;

  if (isGlyphKind(shape.kind)) {
    const gs = Math.min(w, h);
    return <g transform={transform}><MapGlyph kind={shape.kind} x={x + (w - gs) / 2} y={y + (h - gs) / 2} size={gs} color={stroke} strokeWidth={sw} /></g>;
  }
  switch (shape.kind) {
    case 'ellipse':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={sw} transform={transform} />;
    case 'line':
      return <line x1={x} y1={y} x2={x + w} y2={y + h} stroke={stroke} strokeWidth={sw} transform={transform} />;
    case 'arrow':
      return (
        <g transform={transform}>
          <line x1={x} y1={y + h / 2} x2={x + w - 8} y2={y + h / 2} stroke={stroke} strokeWidth={sw} />
          <path d={`M${x + w} ${y + h / 2} L${x + w - 12} ${y + h / 2 - 7} L${x + w - 12} ${y + h / 2 + 7} Z`} fill={stroke} />
        </g>
      );
    case 'text':
      return (
        <text x={x} y={y + (Number(shape.font_size) || 14)} fontSize={Number(shape.font_size) || 14}
          fill={shape.text_color || '#1a2744'} transform={transform}>{shape.text || ''}</text>
      );
    case 'zone':
      return (
        <g transform={transform}>
          <rect x={x} y={y} width={w} height={h} rx={6} fill={shape.fill || 'rgba(59,130,246,0.06)'}
            stroke={stroke} strokeWidth={sw} strokeDasharray="6 4" />
          {shape.text && <text x={x + 8} y={y + (Number(shape.font_size) || 13) + 4} fontSize={Number(shape.font_size) || 13}
            fill={shape.text_color || '#475569'} fontWeight={600}>{shape.text}</text>}
        </g>
      );
    case 'rect':
    default:
      return <rect x={x} y={y} width={w} height={h} rx={4} fill={fill} stroke={stroke} strokeWidth={sw} transform={transform} />;
  }
}

// ── Free-floating text label (top-level component) ─────────────
export function MapLabelText({ label }: { label: MapLabel }) {
  return (
    <text
      x={label.x} y={label.y}
      fontSize={Number(label.font_size) || 14}
      fontWeight={label.bold ? 700 : 400}
      fill={label.color || '#1a2744'}
    >
      {label.text}
    </text>
  );
}

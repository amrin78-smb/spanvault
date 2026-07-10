/** Shared types + helpers for the interactive map designer. */

export type MapDevice = {
  id: number;            // map_devices.id (may be a temp/client id while editing)
  device_id: number | null;
  // A node references at most one entity: device_id OR service_check_id (never
  // both — enforced by the map_devices_one_entity CHECK constraint). Both null
  // is also legal: a label-only/empty node.
  service_check_id?: number | null;
  x: number;
  y: number;
  label: string | null;
  icon_type: string;     // device glyph key (see mapIcons): 'auto' | 'router' | 'switch' | ...
  node_style: string;    // 'box' (filled status box) | 'icon' (glyph + label beneath)
  z_index: number;
  width: number;
  height: number;
  locked?: boolean;      // editor: can't be moved/resized while locked
  group_id?: number | null; // editor: elements sharing a group_id move/select together
  drill_map_id?: number | null; // clicking this node opens the referenced child map
  // Joined live device fields (present on GET, absent for unlinked nodes):
  device_name?: string | null;
  ip_address?: string | null;
  site_name?: string | null;
  current_status?: string | null;
  last_response_ms?: number | null;
  last_seen_at?: string | null;
  is_gateway?: boolean | null;
  alert_suppressed?: boolean | null;
  // Live metrics for tooltips + alert badge (present on GET /api/maps/:id):
  latest_cpu_pct?: number | null;
  latest_mem_pct?: number | null;
  uptime_24h_pct?: number | null;
  alert_count?: number | null;
  // Joined live service_checks fields (present on GET when service_check_id is
  // set; absent for device/empty nodes):
  service_name?: string | null;
  service_type?: string | null;      // 'http' | 'tcp' | 'ssl' | 'dns'
  service_target?: string | null;
  service_status?: string | null;    // up | down | warning | unknown
  service_response_ms?: number | null;
  service_last_checked_at?: string | null;
};

export type MapConnection = {
  id: number;
  from_item_id: number;
  to_item_id: number;
  from_kind: string;  // 'device' | 'shape' | 'service' — which table from_item_id refers to
                       // ('device' and 'service' both resolve against map_devices)
  to_kind: string;    // 'device' | 'shape' | 'service'
  color: string;
  line_style: string; // 'solid' | 'dashed'
  label: string | null;
  arrow: boolean;     // draw a directional arrowhead at the 'to' end
  width: number;      // stroke thickness in user units (default 2)
  routing: string;    // 'straight' | 'elbow' (orthogonal)
  // Optional user-defined bend points (canvas/user coords) for elbow routing. The
  // orthogonal line passes through these in order; null/empty = auto-route.
  waypoints?: { x: number; y: number }[] | null;
  // Weathermap binding (static): SNMP ifIndex on each endpoint device + the link
  // capacity used to compute utilization. null = unbound (plain styled line).
  from_if_index: number | null;
  to_if_index: number | null;
  capacity_bps: number | null;
  // Live interface stats for the bound interfaces (present on GET /api/maps/:id,
  // absent on temp/editor connections). bps = bits/sec, oper = 'up'|'down'|null.
  from_in_bps?: number | null;
  from_out_bps?: number | null;
  from_oper?: string | null;
  to_in_bps?: number | null;
  to_out_bps?: number | null;
  to_oper?: string | null;
};

export type MapLabel = {
  id: number;
  x: number;
  y: number;
  text: string;
  font_size: number;
  color: string;
  bold: boolean;
  z_index: number;
  locked?: boolean;
  group_id?: number | null;
};

// Decorative, non-device element: a basic shape (rect/ellipse/line/arrow/text/
// zone) or a built-in network glyph (cloud/internet/router/switch/...).
export type MapShape = {
  id: number;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
  stroke: string | null;
  stroke_width: number;
  text: string | null;
  font_size: number;
  text_color: string;
  rotation: number;
  z_index: number;
  locked?: boolean;
  group_id?: number | null;
};

export type FullMap = {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  bg_color: string;
  bg_image_b64: string | null;
  canvas_w: number;
  canvas_h: number;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  devices: MapDevice[];
  connections: MapConnection[];
  labels: MapLabel[];
  shapes: MapShape[];
};

export type MapSummary = {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  is_public: boolean;
  bg_color: string;
  canvas_w: number;
  canvas_h: number;
  updated_at: string;
  device_count: number;
};

// Status → node fill colour.
export const STATUS_FILL: Record<string, string> = {
  up: '#22c55e',
  down: '#ef4444',
  warning: '#eab308',
  unknown: '#94a3b8',
};

export function statusFill(status: string | null | undefined, suppressed?: boolean | null): string {
  if (suppressed) return '#cbd5e1';
  return STATUS_FILL[status || 'unknown'] || STATUS_FILL.unknown;
}

// Coerce a connection's waypoints from a DB row — a parsed JSON array, a JSON
// string (jsonb sometimes arrives unparsed), or null — into a clean array of
// {x,y} numbers, or null for auto-route. Defensive against malformed entries.
function normalizeWaypoints(raw: unknown): { x: number; y: number }[] | null {
  let w: unknown = raw;
  if (typeof w === 'string') {
    try { w = JSON.parse(w); } catch { return null; }
  }
  if (!Array.isArray(w)) return null;
  const pts = w
    .filter((p): p is { x: unknown; y: unknown } => p != null && typeof p === 'object')
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => isFinite(p.x) && isFinite(p.y));
  return pts.length ? pts : null;
}

// pg returns NUMERIC columns (x, y) as strings — coerce a fetched map to numbers
// so geometry math is reliable everywhere downstream.
export function normalizeMap(m: FullMap): FullMap {
  return {
    ...m,
    canvas_w: Number(m.canvas_w),
    canvas_h: Number(m.canvas_h),
    devices: (m.devices || []).map((d) => ({
      ...d,
      x: Number(d.x),
      y: Number(d.y),
      width: Number(d.width),
      height: Number(d.height),
      z_index: Number(d.z_index ?? 0),
      node_style: d.node_style || 'box',
      icon_type: d.icon_type || 'auto',
      locked: !!d.locked,
      group_id: d.group_id == null ? null : Number(d.group_id),
      drill_map_id: d.drill_map_id == null ? null : Number(d.drill_map_id),
      latest_cpu_pct: d.latest_cpu_pct == null ? null : Number(d.latest_cpu_pct),
      latest_mem_pct: d.latest_mem_pct == null ? null : Number(d.latest_mem_pct),
      uptime_24h_pct: d.uptime_24h_pct == null ? null : Number(d.uptime_24h_pct),
      alert_count: d.alert_count == null ? null : Number(d.alert_count),
      service_check_id: d.service_check_id == null ? null : Number(d.service_check_id),
      service_response_ms: d.service_response_ms == null ? null : Number(d.service_response_ms),
    })),
    connections: (m.connections || []).map((c) => ({
      ...c,
      from_kind: c.from_kind === 'shape' ? 'shape' : c.from_kind === 'service' ? 'service' : 'device',
      to_kind: c.to_kind === 'shape' ? 'shape' : c.to_kind === 'service' ? 'service' : 'device',
      width: Number(c.width ?? 2),
      arrow: !!c.arrow,
      routing: c.routing === 'elbow' ? 'elbow' : 'straight',
      waypoints: normalizeWaypoints(c.waypoints),
      from_if_index: c.from_if_index == null ? null : Number(c.from_if_index),
      to_if_index: c.to_if_index == null ? null : Number(c.to_if_index),
      capacity_bps: c.capacity_bps == null ? null : Number(c.capacity_bps),
      from_in_bps: c.from_in_bps == null ? null : Number(c.from_in_bps),
      from_out_bps: c.from_out_bps == null ? null : Number(c.from_out_bps),
      to_in_bps: c.to_in_bps == null ? null : Number(c.to_in_bps),
      to_out_bps: c.to_out_bps == null ? null : Number(c.to_out_bps),
    })),
    labels: (m.labels || []).map((l) => ({
      ...l,
      x: Number(l.x),
      y: Number(l.y),
      font_size: Number(l.font_size),
      z_index: Number(l.z_index ?? 0),
      locked: !!l.locked,
      group_id: l.group_id == null ? null : Number(l.group_id),
    })),
    shapes: (m.shapes || []).map((s) => ({
      ...s,
      x: Number(s.x),
      y: Number(s.y),
      width: Number(s.width),
      height: Number(s.height),
      stroke_width: Number(s.stroke_width ?? 2),
      font_size: Number(s.font_size ?? 14),
      rotation: Number(s.rotation ?? 0),
      z_index: Number(s.z_index ?? 0),
      locked: !!s.locked,
      group_id: s.group_id == null ? null : Number(s.group_id),
    })),
  };
}

// Centre point of a device node (connections attach here).
// A connectable node — either a device node or a decorative shape. Only the
// geometry (and optional node_style for icon glyph-box anchoring) is needed.
export type MapNodeLike = { x: number; y: number; width: number; height: number; node_style?: string; kind?: string };

// Basic (box-filling) shape kinds; anything else with a `kind` is a glyph icon
// whose artwork is a centred square smaller than the shape's bounding box.
const BASIC_SHAPE_KINDS = new Set(['rect', 'ellipse', 'line', 'arrow', 'text', 'zone']);

export function deviceCenter(d: MapNodeLike): { cx: number; cy: number } {
  return { cx: Number(d.x) + Number(d.width) / 2, cy: Number(d.y) + Number(d.height) / 2 };
}

// The box a connector should attach to. For box-style nodes that's the whole
// node rect; for icon-style nodes it's the (square, centred) glyph box, so a
// connector touches the icon's edge rather than passing into its middle.
export function nodeAnchorBox(d: MapNodeLike): { x: number; y: number; w: number; h: number } {
  const x = Number(d.x), y = Number(d.y), w = Number(d.width), h = Number(d.height);
  // Icon-style device nodes AND decorative glyph shapes (cloud/building/router/…)
  // draw their artwork in a centred square smaller than the bounding box, so the
  // connector must attach to that square — not the far-out box edge.
  const isGlyphShape = d.kind != null && !BASIC_SHAPE_KINDS.has(d.kind);
  if (d.node_style === 'icon' || isGlyphShape) {
    const gs = Math.max(24, Math.min(w, h));
    return { x: x + (w - gs) / 2, y: y + Math.max(0, (h - gs) / 2), w: gs, h: gs };
  }
  return { x, y, w, h };
}

// Point where the ray from a box's centre toward (tx,ty) exits the box — i.e.
// the perimeter attach point for a connector heading toward the other node.
export function edgePoint(
  box: { x: number; y: number; w: number; h: number }, tx: number, ty: number,
): { cx: number; cy: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { cx, cy };
  const sx = dx !== 0 ? (box.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (box.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy); // first edge the ray crosses
  return { cx: cx + dx * t, cy: cy + dy * t };
}

// Orthogonal (Manhattan) connector between two centres: a 3-segment path that
// bends along the dominant axis. Returns the SVG path `d`, a label anchor, and
// the unit vector of the final segment (for orienting an arrowhead).
export function elbowPoints(
  a: { cx: number; cy: number }, b: { cx: number; cy: number },
  waypoints?: { x: number; y: number }[] | null,
): { d: string; mx: number; my: number; ux: number; uy: number } {
  // With user-defined waypoints, route A → each waypoint (in order) → B as an
  // orthogonal polyline, inserting a right-angle corner between any two
  // consecutive points that aren't already aligned so every segment stays
  // horizontal or vertical. The corner bends along the dominant axis first,
  // mirroring the auto-route's single-bend behaviour.
  if (Array.isArray(waypoints) && waypoints.length > 0) {
    const stops = [
      { x: a.cx, y: a.cy },
      ...waypoints.map((w) => ({ x: Number(w.x), y: Number(w.y) })),
      { x: b.cx, y: b.cy },
    ];
    const pts: { x: number; y: number }[] = [stops[0]];
    for (let i = 1; i < stops.length; i++) {
      const p = pts[pts.length - 1];
      const q = stops[i];
      if (p.x !== q.x && p.y !== q.y) {
        if (Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)) pts.push({ x: q.x, y: p.y });
        else pts.push({ x: p.x, y: q.y });
      }
      pts.push(q);
    }
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    // Label anchor: midpoint of the middle segment of the polyline.
    const si = Math.max(0, Math.floor((pts.length - 1) / 2));
    const p0 = pts[si], p1 = pts[si + 1] || pts[si];
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    // Final-segment unit vector (for orienting the arrowhead at the 'to' end).
    const last = pts[pts.length - 1], prev = pts[pts.length - 2] || last;
    const fdx = last.x - prev.x, fdy = last.y - prev.y;
    const ux = Math.abs(fdx) >= Math.abs(fdy) ? (Math.sign(fdx) || 1) : 0;
    const uy = Math.abs(fdx) >= Math.abs(fdy) ? 0 : (Math.sign(fdy) || 1);
    return { d, mx, my, ux, uy };
  }
  const dx = Math.abs(b.cx - a.cx);
  const dy = Math.abs(b.cy - a.cy);
  if (dx >= dy) {
    const mid = (a.cx + b.cx) / 2;
    return { d: `M${a.cx} ${a.cy} L${mid} ${a.cy} L${mid} ${b.cy} L${b.cx} ${b.cy}`,
      mx: mid, my: (a.cy + b.cy) / 2, ux: Math.sign(b.cx - mid) || 1, uy: 0 };
  }
  const mid = (a.cy + b.cy) / 2;
  return { d: `M${a.cx} ${a.cy} L${a.cx} ${mid} L${b.cx} ${mid} L${b.cx} ${b.cy}`,
    mx: (a.cx + b.cx) / 2, my: mid, ux: 0, uy: Math.sign(b.cy - mid) || 1 };
}

// ── Weathermap helpers (shared by the view renderer and the editor panel) ──
// Human-readable bits/sec.
export function fmtBps(bps: number | null | undefined): string {
  if (bps == null || !isFinite(Number(bps))) return '—';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let v = Number(bps); let i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

// Utilization % → weathermap colour (green → yellow → amber → red).
export function utilColor(pct: number | null | undefined): string {
  if (pct == null) return '#22c55e';
  if (pct >= 90) return '#dc2626';
  if (pct >= 75) return '#f97316';
  if (pct >= 50) return '#f59e0b';
  if (pct >= 25) return '#eab308';
  return '#22c55e';
}

// Derive a bound connection's live link state from its interface stats. `bps` is
// the peak of the available in/out samples on either bound side; `pct` is that
// against capacity (null when capacity unknown).
export function connLive(c: MapConnection): {
  bound: boolean; down: boolean; bps: number | null; pct: number | null;
} {
  const bound = c.from_if_index != null || c.to_if_index != null;
  if (!bound) return { bound: false, down: false, bps: null, pct: null };
  const vals = [c.from_in_bps, c.from_out_bps, c.to_in_bps, c.to_out_bps]
    .map((v) => (v == null ? null : Number(v)))
    .filter((v): v is number => v != null && isFinite(v));
  const bps = vals.length ? Math.max(...vals) : null;
  const cap = c.capacity_bps != null && Number(c.capacity_bps) > 0 ? Number(c.capacity_bps) : null;
  const pct = bps != null && cap ? Math.min(100, (bps / cap) * 100) : null;
  const down = (c.from_if_index != null && c.from_oper === 'down')
    || (c.to_if_index != null && c.to_oper === 'down');
  return { bound, down, bps, pct };
}

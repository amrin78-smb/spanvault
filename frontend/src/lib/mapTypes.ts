/** Shared types + helpers for the interactive map designer. */

export type MapDevice = {
  id: number;            // map_devices.id (may be a temp/client id while editing)
  device_id: number | null;
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
};

export type MapConnection = {
  id: number;
  from_item_id: number;
  to_item_id: number;
  color: string;
  line_style: string; // 'solid' | 'dashed'
  label: string | null;
  arrow: boolean;     // draw a directional arrowhead at the 'to' end
  width: number;      // stroke thickness in user units (default 2)
  routing: string;    // 'straight' | 'elbow' (orthogonal)
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
    })),
    connections: (m.connections || []).map((c) => ({
      ...c,
      width: Number(c.width ?? 2),
      arrow: !!c.arrow,
      routing: c.routing === 'elbow' ? 'elbow' : 'straight',
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
export function deviceCenter(d: MapDevice): { cx: number; cy: number } {
  return { cx: Number(d.x) + Number(d.width) / 2, cy: Number(d.y) + Number(d.height) / 2 };
}

// The box a connector should attach to. For box-style nodes that's the whole
// node rect; for icon-style nodes it's the (square, centred) glyph box, so a
// connector touches the icon's edge rather than passing into its middle.
export function nodeAnchorBox(d: MapDevice): { x: number; y: number; w: number; h: number } {
  const x = Number(d.x), y = Number(d.y), w = Number(d.width), h = Number(d.height);
  if (d.node_style === 'icon') {
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
): { d: string; mx: number; my: number; ux: number; uy: number } {
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

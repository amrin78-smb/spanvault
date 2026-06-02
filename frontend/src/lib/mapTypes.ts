/** Shared types + helpers for the interactive map designer. */

export type MapDevice = {
  id: number;            // map_devices.id (may be a temp/client id while editing)
  device_id: number | null;
  x: number;
  y: number;
  label: string | null;
  icon_type: string;
  width: number;
  height: number;
  // Joined live device fields (present on GET, absent for unlinked nodes):
  device_name?: string | null;
  ip_address?: string | null;
  site_name?: string | null;
  current_status?: string | null;
  last_response_ms?: number | null;
  last_seen_at?: string | null;
  is_gateway?: boolean | null;
  alert_suppressed?: boolean | null;
};

export type MapConnection = {
  id: number;
  from_item_id: number;
  to_item_id: number;
  color: string;
  line_style: string; // 'solid' | 'dashed'
  label: string | null;
};

export type MapLabel = {
  id: number;
  x: number;
  y: number;
  text: string;
  font_size: number;
  color: string;
  bold: boolean;
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
    })),
    connections: m.connections || [],
    labels: (m.labels || []).map((l) => ({
      ...l,
      x: Number(l.x),
      y: Number(l.y),
      font_size: Number(l.font_size),
    })),
  };
}

// Centre point of a device node (connections attach here).
export function deviceCenter(d: MapDevice): { cx: number; cy: number } {
  return { cx: Number(d.x) + Number(d.width) / 2, cy: Number(d.y) + Number(d.height) / 2 };
}

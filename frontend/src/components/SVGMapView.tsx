'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import {
  type FullMap, type MapDevice, type MapConnection, type MapLabel,
  statusFill, deviceCenter,
} from '@/lib/mapTypes';

const DEFAULT_LINE = '#94a3b8';

/**
 * Read-only renderer for a designed map. Layout (positions/connections/labels)
 * comes from `map` and never changes here. When `refreshUrl` is set, only live
 * device status is re-fetched every 30s and merged in — positions never jump.
 */
export default function SVGMapView({
  map, refreshUrl, interactive = false,
}: {
  map: FullMap;
  refreshUrl?: string;
  interactive?: boolean;
}) {
  const router = useRouter();
  const [live, setLive] = useState<Record<number, Partial<MapDevice>>>({});

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
          };
        }
        setLive(next);
      } catch {
        /* keep last-known status on transient failure */
      }
    }
    const id = setInterval(poll, 30000);
    return () => { stopped = true; clearInterval(id); };
  }, [refreshUrl]);

  // Merge live status over the static layout devices.
  const devices: MapDevice[] = (map.devices || []).map((d) => ({ ...d, ...(live[d.id] || {}) }));
  const byId = new Map<number, MapDevice>();
  for (const d of devices) byId.set(d.id, d);

  function onNodeClick(d: MapDevice) {
    if (interactive && d.device_id) router.push(`/devices/${d.device_id}`);
  }

  return (
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

      {/* Connections (under the nodes) */}
      {(map.connections || []).map((c) => (
        <ConnectionLine key={c.id} conn={c} from={byId.get(c.from_item_id)} to={byId.get(c.to_item_id)} />
      ))}

      {/* Device nodes */}
      {devices.map((d) => (
        <DeviceNode key={d.id} device={d} interactive={interactive} onClick={onNodeClick} />
      ))}

      {/* Free-floating labels */}
      {(map.labels || []).map((l) => (
        <MapLabelText key={l.id} label={l} />
      ))}
    </svg>
  );
}

// ── Connection line (top-level component) ──────────────────────
export function ConnectionLine({
  conn, from, to,
}: {
  conn: MapConnection;
  from?: MapDevice;
  to?: MapDevice;
}) {
  if (!from || !to) return null;
  const a = deviceCenter(from);
  const b = deviceCenter(to);

  // Live colouring applies only when the connection kept the default colour.
  const custom = (conn.color || '').toLowerCase() !== DEFAULT_LINE;
  let stroke = conn.color || DEFAULT_LINE;
  if (!custom) {
    const fs = from.current_status;
    const ts = to.current_status;
    if (fs === 'down' || ts === 'down') stroke = '#ef4444';
    else if (fs === 'up' && ts === 'up') stroke = '#22c55e';
    else stroke = DEFAULT_LINE;
  }

  const mx = (a.cx + b.cx) / 2;
  const my = (a.cy + b.cy) / 2;
  return (
    <g>
      <line
        x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy}
        stroke={stroke} strokeWidth={2}
        strokeDasharray={conn.line_style === 'dashed' ? '8 6' : undefined}
      />
      {conn.label && (
        <text x={mx} y={my - 4} textAnchor="middle" fontSize={12} fill="#475569"
          style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 3 }}>
          {conn.label}
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
  const { cx, cy } = deviceCenter(device);
  const w = Number(device.width);
  const h = Number(device.height);
  const fill = suppressed ? 'url(#sv-suppressed-stripe)' : statusFill(status, false);
  const pulse = !suppressed && (status === 'down' || status === 'warning');

  const tip =
    `${name}\n${ip}${device.site_name ? ` · ${device.site_name}` : ''}\n` +
    `Status: ${suppressed ? 'suppressed' : status}` +
    (device.last_response_ms != null ? ` · ${Number(device.last_response_ms).toFixed(0)} ms` : '');

  return (
    <g
      onClick={() => onClick(device)}
      style={{ cursor: interactive && device.device_id ? 'pointer' : 'default' }}
    >
      <title>{tip}</title>
      <rect
        x={device.x} y={device.y} width={w} height={h} rx={8} ry={8}
        fill={fill} stroke="#0f172a" strokeOpacity={0.15} strokeWidth={1}
        className={pulse ? 'sv-mapnode-pulse' : undefined}
      />
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize={13} fontWeight={700} fill="#ffffff">
        {name.length > 18 ? name.slice(0, 17) + '…' : name}
      </text>
      {ip && (
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize={10} fill="#ffffff" fillOpacity={0.85}>
          {ip}
        </text>
      )}
      {device.is_gateway && (
        <text x={device.x + 5} y={device.y + 16} fontSize={14}>⭐</text>
      )}
    </g>
  );
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

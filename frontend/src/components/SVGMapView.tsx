'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '@/lib/api';
import {
  type FullMap, type MapDevice, type MapConnection, type MapLabel, type MapShape,
  statusFill, deviceCenter,
} from '@/lib/mapTypes';
import { MapGlyph, deviceGlyphFor, isGlyphKind } from '@/lib/mapIcons';

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

      {/* Decorative shapes (z-sorted, beneath the nodes) */}
      {[...(map.shapes || [])].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0) || a.id - b.id).map((s) => (
        <ShapeEl key={`s-${s.id}`} shape={s} />
      ))}

      {/* Connections (under the nodes) */}
      {(map.connections || []).map((c) => (
        <ConnectionLine key={c.id} conn={c} from={byId.get(c.from_item_id)} to={byId.get(c.to_item_id)} />
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
  const x = Number(device.x);
  const y = Number(device.y);
  const w = Number(device.width);
  const h = Number(device.height);
  const cx = x + w / 2;
  const color = suppressed ? '#94a3b8' : statusFill(status, false);
  const pulse = !suppressed && (status === 'down' || status === 'warning');
  const cursor = interactive && device.device_id ? 'pointer' : 'default';

  const tip =
    `${name}\n${ip}${device.site_name ? ` · ${device.site_name}` : ''}\n` +
    `Status: ${suppressed ? 'suppressed' : status}` +
    (device.last_response_ms != null ? ` · ${Number(device.last_response_ms).toFixed(0)} ms` : '');

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
    return <g transform={transform}><MapGlyph kind={shape.kind} x={x + (w - gs) / 2} y={y + (h - gs) / 2} size={gs} color={stroke} /></g>;
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

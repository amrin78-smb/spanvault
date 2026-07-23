'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { edgePoint, STATUS_FILL } from '@/lib/mapTypes';

export interface TopoNode {
  device_id: number;
  name: string;
  ip: string;
  site_name: string | null;
  status: string; // 'up' | 'down' | 'warning' | 'unknown'
  is_gateway: boolean;
}

export interface TopoEdge {
  from_device_id: number;
  to_device_id: number;
  from_port: string | null;
  to_port: string | null;
  protocol: string; // 'lldp' | 'cdp'
}

// ---- Layout constants -------------------------------------------------------
const NODE_W = 130;
const NODE_H = 56;
const GAP_X = 26;
const GAP_Y = 26;
const BOX_PAD = 24;
const HEADER_H = 34;
const CLUSTER_GAP = 60;

// Unit 5-pointed star (outer radius 1, inner radius 0.4, centered at 0,0,
// pointing up). Scaled/positioned via transform where it is drawn so it stays
// crisp at the map's normal scale. Used for the gateway indicator.
const STAR_POINTS =
  '0,-1 0.2351,-0.3236 0.9511,-0.309 0.3804,0.1236 0.5878,0.809 0,0.4 ' +
  '-0.5878,0.809 -0.3804,0.1236 -0.9511,-0.309 -0.2351,-0.3236';
const OUTER_MARGIN = 40;

const UNASSIGNED = 'Unassigned';

// ---- Color helpers ----------------------------------------------------------
const SITE_PALETTE: string[] = [
  '#2563eb', '#0891b2', '#7c3aed', '#db2777', '#ea580c',
  '#16a34a', '#ca8a04', '#4f46e5', '#0d9488', '#be123c',
];

const NEUTRAL_GREY = '#94a3b8';

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function siteColor(siteName: string): string {
  if (siteName === UNASSIGNED) return NEUTRAL_GREY;
  return SITE_PALETTE[hashString(siteName) % SITE_PALETTE.length];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

// ---- Zoom / pan helpers -----------------------------------------------------
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;

function clampZoom(z: number): number {
  if (!isFinite(z)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

// Convert a client-space point (mouse coords) into the SVG's user coordinate
// system — the space the pan/zoom <g> transform operates in. Accounts for the
// viewBox scaling so wheel-zoom can lock onto the point under the cursor.
function clientToUser(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const inv = ctm.inverse();
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(inv);
  if (!isFinite(p.x) || !isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

// ---- Internal layout types --------------------------------------------------
interface NodePos {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

interface DeviceLayout {
  node: TopoNode;
  x: number;
  y: number;
}

interface ClusterLayout {
  siteName: string;
  color: string;
  count: number;
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
  devices: DeviceLayout[];
}

// ---- Sub-components (top level only) ----------------------------------------
function SiteBox({ cluster }: { cluster: ClusterLayout }) {
  return (
    <g>
      <rect
        x={cluster.boxX}
        y={cluster.boxY}
        width={cluster.boxW}
        height={cluster.boxH}
        rx={14}
        fill={cluster.color}
        fillOpacity={0.13}
        stroke={cluster.color}
        strokeWidth={2}
      />
      <text
        x={cluster.boxX + 16}
        y={cluster.boxY + 22}
        fontSize={15}
        fontWeight={700}
        fill={cluster.color}
      >
        {cluster.siteName + ' · ' + cluster.count}
      </text>
    </g>
  );
}

function Connection({
  x1,
  y1,
  x2,
  y2,
  stroke,
  label,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  label: string;
}) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2} />
      {label ? (
        <text
          x={mx}
          y={my}
          fontSize={10}
          fill="#475569"
          textAnchor="middle"
          style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

function DeviceNode({
  layout,
  interactive,
  onClick,
}: {
  layout: DeviceLayout;
  interactive: boolean;
  onClick: (deviceId: number) => void;
}) {
  const { node, x, y } = layout;
  const fill = STATUS_FILL[node.status] || STATUS_FILL.unknown;
  const site = node.site_name && node.site_name.trim() ? node.site_name : '';
  const tooltip =
    node.name +
    '\n' +
    node.ip +
    (site ? ' · ' + site : '') +
    '\nStatus: ' +
    node.status;
  return (
    <g
      onClick={interactive ? () => onClick(node.device_id) : undefined}
      style={{ cursor: interactive ? 'pointer' : 'default' }}
    >
      <title>{tooltip}</title>
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={8}
        fill={fill}
        stroke={node.status === 'down' || node.status === 'warning' ? '#00000022' : 'none'}
        strokeWidth={1}
      />
      {node.is_gateway ? (
        <polygon
          points={STAR_POINTS}
          transform={`translate(${x + 12}, ${y + 11}) scale(7)`}
          fill="#f59e0b"
          stroke="#ffffff"
          strokeWidth={0.75}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <text
        x={x + NODE_W / 2}
        y={y + 24}
        fontSize={12}
        fontWeight={600}
        fill="#ffffff"
        textAnchor="middle"
      >
        {truncate(node.name, 16)}
      </text>
      <text
        x={x + NODE_W / 2}
        y={y + 40}
        fontSize={10}
        fill="#ffffff"
        fillOpacity={0.85}
        textAnchor="middle"
      >
        {node.ip}
      </text>
    </g>
  );
}

// ---- Main component ---------------------------------------------------------
export default function TopologyMapView({
  nodes,
  edges,
  interactive,
}: {
  nodes: TopoNode[];
  edges: TopoEdge[];
  interactive?: boolean;
}) {
  const router = useRouter();
  const isInteractive = !!interactive;

  // ── Zoom / pan (SVG-space transform on a wrapping <g>) ──────────────────
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panning = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const justPanned = useRef(false);
  const [grabbing, setGrabbing] = useState(false);

  // Wheel zoom toward the cursor (non-passive so we can preventDefault scroll).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const u = clientToUser(el!, e.clientX, e.clientY);
      setZoom((z: number) => {
        const nz = clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        const k = nz / z;
        if (u) setPan((p) => ({ x: u.x - (u.x - p.x) * k, y: u.y - (u.y - p.y) * k }));
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
      const el = svgRef.current;
      const ctm = el ? el.getScreenCTM() : null;
      const s = ctm && ctm.a ? ctm.a : 1; // screen→user scale (uniform w/ meet)
      const rawDx = e.clientX - p.sx;
      const rawDy = e.clientY - p.sy;
      if (Math.abs(rawDx) + Math.abs(rawDy) > 3) p.moved = true;
      setPan({ x: p.ox + rawDx / s, y: p.oy + rawDy / s });
    }
    function up() {
      const p = panning.current;
      if (p && p.moved) {
        justPanned.current = true;
        setTimeout(() => { justPanned.current = false; }, 0);
      }
      panning.current = null;
      setGrabbing(false);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  const onSvgMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return;
    panning.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y, moved: false };
    setGrabbing(true);
  };

  const zoomByCenter = (factor: number): void => {
    const el = svgRef.current;
    const u = el
      ? clientToUser(
          el,
          el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2,
          el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2,
        )
      : null;
    setZoom((z: number) => {
      const nz = clampZoom(z * factor);
      const k = nz / z;
      if (u) setPan((p) => ({ x: u.x - (u.x - p.x) * k, y: u.y - (u.y - p.y) * k }));
      return nz;
    });
  };

  const resetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // 1. Filtering: only nodes that appear in at least one edge.
  const connectedIds = new Set<number>();
  edges.forEach((e: TopoEdge) => {
    connectedIds.add(e.from_device_id);
    connectedIds.add(e.to_device_id);
  });

  const included = nodes.filter((n: TopoNode) => connectedIds.has(n.device_id));

  if (included.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 'var(--text-md)' }}>
        No topology to display.
      </div>
    );
  }

  const byId = new Map<number, TopoNode>();
  included.forEach((n: TopoNode) => byId.set(n.device_id, n));

  // Group by site_name (null/empty → "Unassigned").
  const groups = new Map<string, TopoNode[]>();
  included.forEach((n: TopoNode) => {
    const key = n.site_name && n.site_name.trim() ? n.site_name : UNASSIGNED;
    const arr = groups.get(key);
    if (arr) arr.push(n);
    else groups.set(key, [n]);
  });

  // Sort site groups by name, "Unassigned" last.
  const siteNames = Array.from(groups.keys()).sort((a: string, b: string) => {
    if (a === UNASSIGNED) return 1;
    if (b === UNASSIGNED) return -1;
    return a.localeCompare(b);
  });

  // 2. Layout: arrange clusters in a grid.
  const numSites = siteNames.length;
  const clusterCols = Math.ceil(Math.sqrt(numSites));

  const clusters: ClusterLayout[] = [];
  const posMap = new Map<number, NodePos>();

  let rowStartY = OUTER_MARGIN;
  let maxTotalWidth = 0;

  for (let row = 0; row * clusterCols < numSites; row++) {
    const rowSites = siteNames.slice(row * clusterCols, row * clusterCols + clusterCols);
    let cursorX = OUTER_MARGIN;
    let tallestInRow = 0;

    rowSites.forEach((siteName: string) => {
      const devices = groups.get(siteName) || [];
      const count = devices.length;
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);

      const innerW = cols * NODE_W + (cols - 1) * GAP_X;
      const innerH = rows * NODE_H + (rows - 1) * GAP_Y;
      const boxW = innerW + 2 * BOX_PAD;
      const boxH = HEADER_H + innerH + 2 * BOX_PAD;

      const boxX = cursorX;
      const boxY = rowStartY;

      const deviceLayouts: DeviceLayout[] = devices.map(
        (node: TopoNode, idx: number) => {
          const c = idx % cols;
          const r = Math.floor(idx / cols);
          const x = boxX + BOX_PAD + c * (NODE_W + GAP_X);
          const y = boxY + BOX_PAD + HEADER_H + r * (NODE_H + GAP_Y);
          posMap.set(node.device_id, {
            x,
            y,
            cx: x + NODE_W / 2,
            cy: y + NODE_H / 2,
          });
          return { node, x, y };
        }
      );

      clusters.push({
        siteName,
        color: siteColor(siteName),
        count,
        boxX,
        boxY,
        boxW,
        boxH,
        devices: deviceLayouts,
      });

      cursorX += boxW + CLUSTER_GAP;
      if (boxH > tallestInRow) tallestInRow = boxH;
    });

    const rowWidth = cursorX - CLUSTER_GAP; // remove trailing gap
    if (rowWidth > maxTotalWidth) maxTotalWidth = rowWidth;

    rowStartY += tallestInRow + CLUSTER_GAP;
  }

  const totalWidth = maxTotalWidth + OUTER_MARGIN;
  const totalHeight = rowStartY - CLUSTER_GAP + OUTER_MARGIN;

  const handleNodeClick = (deviceId: number): void => {
    if (justPanned.current) return; // ignore the click that ends a pan-drag
    if (isInteractive && deviceId) {
      router.push('/devices/' + deviceId);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={onSvgMouseDown}
        style={{ display: 'block', cursor: grabbing ? 'grabbing' : 'grab', touchAction: 'none' }}
      >
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* 1. Site boundary boxes + 2. labels */}
          {clusters.map((c: ClusterLayout) => (
            <SiteBox key={'box-' + c.siteName} cluster={c} />
          ))}

          {/* 3. Connections (on top of boxes) — anchored to node edges */}
          {edges.map((e: TopoEdge, i: number) => {
            const a = posMap.get(e.from_device_id);
            const b = posMap.get(e.to_device_id);
            if (!a || !b) return null;
            const stroke = e.protocol === 'cdp' ? '#f97316' : '#2563eb';
            const label = [e.from_port, e.to_port].filter(Boolean).join(' → ');
            // Attach each end to the perimeter of its node rect (intersection of
            // the centre-to-centre line with the box) so links no longer run
            // through/under the node boxes.
            const boxA = { x: a.x, y: a.y, w: NODE_W, h: NODE_H };
            const boxB = { x: b.x, y: b.y, w: NODE_W, h: NODE_H };
            const pa = edgePoint(boxA, b.cx, b.cy);
            const pb = edgePoint(boxB, a.cx, a.cy);
            return (
              <Connection
                key={'edge-' + i}
                x1={pa.cx}
                y1={pa.cy}
                x2={pb.cx}
                y2={pb.cy}
                stroke={stroke}
                label={label}
              />
            );
          })}

          {/* 4. Device nodes (on top) */}
          {clusters.map((c: ClusterLayout) =>
            c.devices.map((d: DeviceLayout) => (
              <DeviceNode
                key={'node-' + d.node.device_id}
                layout={d}
                interactive={isInteractive}
                onClick={handleNodeClick}
              />
            ))
          )}
        </g>
      </svg>

      {/* Zoom controls (screen-fixed overlay) */}
      <div className="sv-map-zoomctl" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" title="Zoom in" onClick={() => zoomByCenter(1.2)}>+</button>
        <button type="button" title="Zoom out" onClick={() => zoomByCenter(1 / 1.2)}>−</button>
        <button type="button" title="Reset to 100%" onClick={resetView}>⤢</button>
        <span className="lvl">{Math.round(zoom * 100)}%</span>
      </div>
    </div>
  );
}

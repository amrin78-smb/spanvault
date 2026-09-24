'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { edgePoint, STATUS_FILL } from '@/lib/mapTypes';

// Which arrangement the canvas draws. All three are computed here from the
// same {nodes, edges} payload — nothing extra is fetched for a layout switch.
//   sites  — the original: nodes grouped into per-site boundary boxes.
//   tiered — hierarchical core → distribution → access, inferred from link
//            fan-out (see layoutTiered).
//   force  — deterministic Fruchterman-Reingold spring embedding.
export type TopoLayout = 'sites' | 'tiered' | 'force';

export interface TopoNode {
  // For a monitored device this is its monitored_devices.id. For an UNMANAGED
  // neighbour (`managed: false`) it is a SYNTHETIC NEGATIVE id minted by
  // GET /api/topology/map, valid only inside that one response — it must never
  // be used to build a /devices/[id] link.
  device_id: number;
  name: string;
  ip: string;
  site_name: string | null;
  status: string; // 'up' | 'down' | 'warning' | 'unknown'
  is_gateway: boolean;
  // false = a neighbour discovered over LLDP/CDP that is NOT in
  // monitored_devices. Omitted/undefined is treated as managed.
  managed?: boolean;
  // Set by the PAGE (not the API) when a filter hides some of this node's
  // neighbours: how many of its links point at a node the current filter
  // removed. Drawn as a "+N" badge so a filtered canvas never silently
  // implies a device has fewer neighbours than it really has.
  hidden_links?: number;
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

// Tiered layout
const TIER_GAP = 96;        // vertical gap between two tier bands
const BLOCK_GAP = 54;       // horizontal gap between two core-rooted blocks
const BAND_LABEL_W = 108;   // left gutter holding the Core/Distribution/Access labels
const TIER_NAMES = ['Core', 'Distribution', 'Access'];
// A row of core-rooted blocks wraps to the next line once it is this much
// wider than it is tall; TIER_ROW_GAP separates two such rows (it must clear
// the 18px TierBand backdrop overhang at both ends).
const TIER_ROW_ASPECT = 2.8;
const TIER_ROW_GAP = 120;

const UNASSIGNED = 'Unassigned';

// ---- Color helpers ----------------------------------------------------------
const SITE_PALETTE: string[] = [
  '#2563eb', '#0891b2', '#7c3aed', '#db2777', '#ea580c',
  '#16a34a', '#ca8a04', '#4f46e5', '#0d9488', '#be123c',
];

const NEUTRAL_GREY = '#94a3b8';

// Unmanaged (discovered-but-not-monitored) node palette. Raw hex on purpose,
// exactly like STATUS_FILL / SITE_PALETTE: this is an SVG chart drawn on a
// fixed light canvas, not themed page chrome, so a --token would not flip
// correctly against it.
const UNMANAGED_FILL = '#ffffff';
const UNMANAGED_STROKE = '#94a3b8';
const UNMANAGED_TEXT = '#475569';
// Search highlight ring + the wash applied to everything that does NOT match.
const MATCH_RING = '#C8102E';
const DIM_OPACITY = 0.18;

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

function siteKey(n: TopoNode): string {
  return n.site_name && n.site_name.trim() ? n.site_name : UNASSIGNED;
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

// How far past the "content exactly fills the viewport" position a drag may
// push the canvas, as a fraction of the viewBox extent. Without a clamp a
// single drag could park the whole graph off-screen (measured: translate(2931,
// 2198) with 0 of 52 nodes visible, while the highlight box still counted "34
// matches" against a blank canvas).
const PAN_SLACK = 0.15;

// Clamp one axis of the pan translate. The transform is
// translate(pan) scale(zoom), so content spans [pan, pan + extent*zoom] inside
// a viewBox of [0, extent]: keeping pan between 0 and extent - extent*zoom
// (whichever way round those fall) is exactly "no blank gutter", and PAN_SLACK
// then allows a little overshoot so the edges are still comfortable to reach.
function clampPanAxis(v: number, zoom: number, extent: number): number {
  if (!isFinite(v)) return 0;
  const flush = extent - extent * zoom;
  const slack = extent * PAN_SLACK;
  const lo = Math.min(0, flush) - slack;
  const hi = Math.max(0, flush) + slack;
  return v < lo ? lo : v > hi ? hi : v;
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

interface BandLayout {
  label: string;
  count: number;
  y: number;
  h: number;
}

interface LayoutResult {
  placed: DeviceLayout[];
  posMap: Map<number, NodePos>;
  clusters: ClusterLayout[]; // 'sites' only
  bands: BandLayout[];       // 'tiered' only
  width: number;
  height: number;
}

// ---- Shared graph helpers ---------------------------------------------------
function buildAdjacency(nodes: TopoNode[], edges: TopoEdge[]): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  nodes.forEach((n: TopoNode) => adj.set(n.device_id, new Set<number>()));
  edges.forEach((e: TopoEdge) => {
    const a = adj.get(e.from_device_id);
    const b = adj.get(e.to_device_id);
    if (a && b && e.from_device_id !== e.to_device_id) {
      a.add(e.to_device_id);
      b.add(e.from_device_id);
    }
  });
  return adj;
}

function gridCols(count: number, max: number): number {
  return Math.max(1, Math.min(max, Math.ceil(Math.sqrt(Math.max(1, count)))));
}

function gridW(cols: number): number {
  return cols * NODE_W + (cols - 1) * GAP_X;
}

function gridH(rows: number): number {
  return rows <= 0 ? 0 : rows * NODE_H + (rows - 1) * GAP_Y;
}

// ---- Layout 1: per-site boundary boxes (the original) -----------------------
function layoutSites(nodes: TopoNode[]): LayoutResult {
  const groups = new Map<string, TopoNode[]>();
  nodes.forEach((n: TopoNode) => {
    const key = siteKey(n);
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

  const numSites = siteNames.length;
  const clusterCols = Math.max(1, Math.ceil(Math.sqrt(numSites)));

  const clusters: ClusterLayout[] = [];
  const posMap = new Map<number, NodePos>();
  const placed: DeviceLayout[] = [];

  let rowStartY = OUTER_MARGIN;
  let maxTotalWidth = 0;

  for (let row = 0; row * clusterCols < numSites; row++) {
    const rowSites = siteNames.slice(row * clusterCols, row * clusterCols + clusterCols);
    let cursorX = OUTER_MARGIN;
    let tallestInRow = 0;

    rowSites.forEach((siteName: string) => {
      const devices = groups.get(siteName) || [];
      const count = devices.length;
      const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
      const rows = Math.ceil(count / cols);

      const innerW = gridW(cols);
      const innerH = gridH(rows);
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
          posMap.set(node.device_id, { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
          const dl = { node, x, y };
          placed.push(dl);
          return dl;
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

  return {
    placed,
    posMap,
    clusters,
    bands: [],
    width: maxTotalWidth + OUTER_MARGIN,
    height: rowStartY - CLUSTER_GAP + OUTER_MARGIN,
  };
}

// ---- Layout 2: hierarchical core → distribution → access --------------------
//
// The tier of a node is inferred purely from LINK FAN-OUT, not from whether it
// happens to be monitored — the same rule therefore still works on an estate
// where the neighbours eventually DO get added to monitoring:
//   • Core        — the highest-degree node of each connected component (ties
//                   broken towards a monitored device, then a gateway, then by
//                   name). On the current production graph this picks exactly
//                   the monitored switches that ran the discovery, because they
//                   are the only nodes with fan-out.
//   • Access      — every degree-1 leaf. These are the edge switches/APs at the
//                   end of a single LLDP/CDP adjacency.
//   • Distribution— everything left over (degree >= 2 but not a component's
//                   maximum), e.g. a neighbour seen by two different cores.
//
// Nodes are then grouped into one BLOCK per core: that core's distribution and
// access descendants are laid out in wrapped grids directly beneath it, so a
// 34-node site reads as one column of related kit rather than one 4,000px row.
function layoutTiered(nodes: TopoNode[], edges: TopoEdge[]): LayoutResult {
  const adj = buildAdjacency(nodes, edges);
  const byId = new Map<number, TopoNode>();
  nodes.forEach((n: TopoNode) => byId.set(n.device_id, n));
  const deg = (id: number): number => (adj.get(id) ? (adj.get(id) as Set<number>).size : 0);

  // Seed (core) per connected component + a component → seed lookup.
  const compSeed = new Map<number, number>();
  const seeds: TopoNode[] = [];
  const visited = new Set<number>();
  nodes.forEach((start: TopoNode) => {
    if (visited.has(start.device_id)) return;
    const comp: TopoNode[] = [];
    const queue: number[] = [start.device_id];
    visited.add(start.device_id);
    while (queue.length) {
      const id = queue.shift() as number;
      const nd = byId.get(id);
      if (nd) comp.push(nd);
      const nb = adj.get(id);
      if (nb) nb.forEach((m: number) => {
        if (!visited.has(m)) { visited.add(m); queue.push(m); }
      });
    }
    let best = comp[0];
    comp.forEach((c: TopoNode) => {
      const dc = deg(c.device_id);
      const db = deg(best.device_id);
      if (dc !== db) { if (dc > db) best = c; return; }
      const mc = c.managed !== false;
      const mb = best.managed !== false;
      if (mc !== mb) { if (mc) best = c; return; }
      if (!!c.is_gateway !== !!best.is_gateway) { if (c.is_gateway) best = c; return; }
      if ((c.name || '').localeCompare(best.name || '') < 0) best = c;
    });
    seeds.push(best);
    comp.forEach((c: TopoNode) => compSeed.set(c.device_id, best.device_id));
  });

  const seedIds = new Set<number>(seeds.map((s: TopoNode) => s.device_id));
  const tierOf = (id: number): number => {
    if (seedIds.has(id)) return 0;
    return deg(id) <= 1 ? 2 : 1;
  };

  // Parent = the adjacent node in a strictly higher tier with the biggest
  // fan-out. Anything with no such neighbour is docked to its component's core
  // so it still lands in a sensible column (its real edges are drawn anyway).
  const parentOf = new Map<number, number>();
  nodes.forEach((n: TopoNode) => {
    const t = tierOf(n.device_id);
    if (t === 0) return;
    const nb = adj.get(n.device_id);
    const cands: number[] = nb ? Array.from(nb) : [];
    let best = -0.5; // sentinel: no candidate yet (never a real device_id)
    let bestTier = 99;
    let bestDeg = -1;
    for (let i = 0; i < cands.length; i++) {
      const m = cands[i];
      const mt = tierOf(m);
      if (mt >= t) continue;
      const md = deg(m);
      if (mt < bestTier || (mt === bestTier && md > bestDeg)) {
        best = m;
        bestTier = mt;
        bestDeg = md;
      }
    }
    const fallback = compSeed.get(n.device_id);
    const chosen = bestTier < 99 ? best : (fallback !== undefined ? fallback : null);
    if (chosen !== null && chosen !== n.device_id) parentOf.set(n.device_id, chosen);
  });

  // One block per core: its tier-1 children, then every tier-2 node hanging off
  // the core or off one of those tier-1 children.
  interface Block { core: TopoNode; t1: TopoNode[]; t2: TopoNode[]; }
  const blocks: Block[] = seeds
    .slice()
    .sort((a: TopoNode, b: TopoNode) => {
      const s = siteKey(a).localeCompare(siteKey(b));
      return s !== 0 ? s : (a.name || '').localeCompare(b.name || '');
    })
    .map((core: TopoNode) => ({ core, t1: [], t2: [] }));
  const blockByCore = new Map<number, Block>();
  blocks.forEach((b: Block) => blockByCore.set(b.core.device_id, b));

  nodes.forEach((n: TopoNode) => {
    const t = tierOf(n.device_id);
    if (t === 0) return;
    let p = parentOf.get(n.device_id);
    // Walk up at most two hops to reach a core.
    if (p !== undefined && !blockByCore.has(p)) p = parentOf.get(p);
    if (p === undefined || !blockByCore.has(p)) p = compSeed.get(n.device_id);
    const blk = p !== undefined ? blockByCore.get(p) : undefined;
    if (!blk) return;
    if (t === 1) blk.t1.push(n);
    else blk.t2.push(n);
  });
  blocks.forEach((b: Block) => {
    b.t1.sort((x: TopoNode, y: TopoNode) => (x.name || '').localeCompare(y.name || ''));
    b.t2.sort((x: TopoNode, y: TopoNode) => (x.name || '').localeCompare(y.name || ''));
  });

  // Per-block geometry, then WRAP the blocks into rows.
  //
  // `cursorX += g.w + BLOCK_GAP` with no row break made the tiered width grow
  // linearly and the height stay at three bands: a 500-node graph drew a
  // 12666x780 strip whose nodes were 13.3x5.7px. layoutSites has always wrapped
  // (clusterCols = ceil(sqrt(numSites))); this gives the tiered layout the
  // equivalent, with the row budget derived from the blocks' own widths so the
  // finished canvas lands near TIER_ROW_ASPECT instead of a fixed column count.
  const geom = blocks.map((b: Block) => {
    const c1 = gridCols(b.t1.length, 4);
    const c2 = gridCols(b.t2.length, 6);
    const r1 = b.t1.length ? Math.ceil(b.t1.length / c1) : 0;
    const r2 = b.t2.length ? Math.ceil(b.t2.length / c2) : 0;
    const w = Math.max(NODE_W, b.t1.length ? gridW(c1) : 0, b.t2.length ? gridW(c2) : 0);
    return { c1, c2, r1, r2, w };
  });

  let maxR1 = 0;
  let maxR2 = 0;
  let totalW = 0;
  geom.forEach((g, i: number) => {
    if (g.r1 > maxR1) maxR1 = g.r1;
    if (g.r2 > maxR2) maxR2 = g.r2;
    totalW += g.w + (i > 0 ? BLOCK_GAP : 0);
  });
  // Tallest a row can be, used only to choose the row count.
  const rowHGuess =
    NODE_H + TIER_GAP + gridH(maxR1) + (maxR1 > 0 ? TIER_GAP : 0) + gridH(maxR2) + TIER_ROW_GAP;
  const rowCount = Math.max(
    1,
    Math.min(
      blocks.length || 1,
      Math.round(Math.sqrt(Math.max(1, totalW) / Math.max(1, rowHGuess * TIER_ROW_ASPECT))),
    ),
  );
  const budget = Math.max(NODE_W, totalW / rowCount);

  const rows: number[][] = [];
  let current: number[] = [];
  let currentW = 0;
  geom.forEach((g, i: number) => {
    const add = g.w + (current.length ? BLOCK_GAP : 0);
    if (current.length && currentW + add > budget) {
      rows.push(current);
      current = [i];
      currentW = g.w;
      return;
    }
    current.push(i);
    currentW += add;
  });
  if (current.length) rows.push(current);

  const posMap = new Map<number, NodePos>();
  const placed: DeviceLayout[] = [];
  const put = (node: TopoNode, x: number, y: number): void => {
    posMap.set(node.device_id, { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
    placed.push({ node, x, y });
  };

  // Every row carries its own Core/Distribution/Access bands, sized from the
  // blocks in THAT row — a tall block in row 1 must not pad out row 2.
  const bands: BandLayout[] = [];
  let rowTop = OUTER_MARGIN;
  let lastBottom = OUTER_MARGIN + NODE_H;
  let widest = 0;

  rows.forEach((row: number[]) => {
    let r1 = 0;
    let r2 = 0;
    row.forEach((bi: number) => {
      if (geom[bi].r1 > r1) r1 = geom[bi].r1;
      if (geom[bi].r2 > r2) r2 = geom[bi].r2;
    });
    const band1H = gridH(r1);
    const band2H = gridH(r2);
    const y0 = rowTop;
    const y1 = y0 + NODE_H + TIER_GAP;
    const y2 = band1H > 0 ? y1 + band1H + TIER_GAP : y1;

    const counts = [0, 0, 0];
    let cursorX = OUTER_MARGIN + BAND_LABEL_W;
    row.forEach((bi: number) => {
      const b = blocks[bi];
      const g = geom[bi];
      const centre = cursorX + g.w / 2;
      put(b.core, centre - NODE_W / 2, y0);
      counts[0] += 1;

      if (b.t1.length) {
        const rowW = gridW(g.c1);
        const left = centre - rowW / 2;
        b.t1.forEach((nd: TopoNode, i: number) => {
          const c = i % g.c1;
          const r = Math.floor(i / g.c1);
          put(nd, left + c * (NODE_W + GAP_X), y1 + r * (NODE_H + GAP_Y));
        });
        counts[1] += b.t1.length;
      }
      if (b.t2.length) {
        const rowW = gridW(g.c2);
        const left = centre - rowW / 2;
        b.t2.forEach((nd: TopoNode, i: number) => {
          const c = i % g.c2;
          const r = Math.floor(i / g.c2);
          put(nd, left + c * (NODE_W + GAP_X), y2 + r * (NODE_H + GAP_Y));
        });
        counts[2] += b.t2.length;
      }
      cursorX += g.w + BLOCK_GAP;
    });

    const right = cursorX - BLOCK_GAP;
    if (right > widest) widest = right;

    [
      { label: TIER_NAMES[0], count: counts[0], y: y0, h: NODE_H },
      { label: TIER_NAMES[1], count: counts[1], y: y1, h: band1H },
      { label: TIER_NAMES[2], count: counts[2], y: y2, h: band2H },
    ].forEach((b: BandLayout) => {
      if (b.count > 0 && b.h > 0) bands.push(b);
    });

    lastBottom = band2H > 0 ? y2 + band2H : band1H > 0 ? y1 + band1H : y0 + NODE_H;
    rowTop = lastBottom + TIER_ROW_GAP;
  });

  const width = Math.max(widest, OUTER_MARGIN + BAND_LABEL_W + NODE_W) + OUTER_MARGIN;
  const height = lastBottom + OUTER_MARGIN;

  return { placed, posMap, clusters: [], bands, width, height };
}

// ---- Layout 3: deterministic force-directed ---------------------------------
//
// Fruchterman-Reingold, seeded from a golden-angle spiral rather than random
// positions so the same graph always draws the same picture (a layout that
// reshuffles on every re-render is unusable as a reference diagram), followed
// by a rectangle-separation pass because FR treats nodes as points while we
// draw 130x56 boxes.
//
// Three properties below are load-bearing and easy to lose again:
//
//  1. THE FRAME CLAMP on the integration step. Textbook FR bounds every node
//     into the WxH frame on every iteration; the first version of this function
//     did not. With `temp` starting at W/10 and decaying 0.965 over 320
//     iterations a node can travel ~5300 units, and unconnected pairs only ever
//     repel, so the drawing inflated without limit: measured on production, a
//     52-node graph produced a 10025x9587 canvas that fit at 0.058 — 7.6x3.3px
//     nodes under a 0.70px label, which ZOOM_MAX = 3 cannot rescue. The clamp
//     is what makes the canvas a function of the node count instead of a
//     function of how long the simulation ran.
//  2. THE FRAME SIZE. W/H are derived from n so the result stays comparable to
//     layoutSites/layoutTiered as the graph grows: room for n padded boxes at
//     FRAME_DENSITY times their own area, in a FRAME_ASPECT-wide rectangle
//     (the map panel is much wider than it is tall, so a square frame would
//     throw away fit scale). k then lands near the separation padding, which
//     is what keeps the post-pass cheap.
//  3. CENTRE GRAVITY. Unconnected pairs only repel, so nothing pulls a
//     disconnected component — or a fully isolated node — back toward the rest;
//     with the clamp alone they end up smeared along the frame border. That is
//     a normal case here, not a theoretical one: under the page's "Monitored
//     only" filter EVERY node is isolated (managed-to-managed links number zero
//     on a real estate). A weak spring to the centre, weighted up for
//     low-degree nodes, packs each component instead.
//
// The repulsion loop is O(n^2) per iteration and runs synchronously on the main
// thread, so the iteration count is a BUDGET (FORCE_PAIR_BUDGET total pair
// visits) rather than a constant: 320 iterations at the sizes that can afford
// them, fewer as n^2 grows, never below FORCE_ITER_MIN. Cooling is derived from
// whatever count that yields so the schedule always lands on TEMP_FLOOR at the
// last iteration — the old fixed 0.965 spent its final ~150 iterations moving
// nodes by less than a pixel at n = 52, and cooled far too slowly to settle at
// all once the count was reduced.
const FRAME_DENSITY = 2.2;   // frame area per node, in padded-box areas
const FRAME_ASPECT = 2.3;    // frame width / height
const SEP_PAD = 18;          // extra space around a node box in the separation pass
const FORCE_ITER_MAX = 320;
const FORCE_ITER_MIN = 60;
const FORCE_PAIR_BUDGET = 12e6;
const TEMP_FLOOR = 0.5;      // the step cap at the final iteration, in user units
const GRAVITY = 0.04;
// Separation passes are budgeted the same way (each pass is O(n)).
const SEP_PASS_MAX = 600;
const SEP_PASS_MIN = 120;
const SEP_PASS_BUDGET = 250e3;

// Rectangle separation: FR packs point-masses, we draw 130x56 boxes. Two nodes
// can only overlap when they sit within one PADX x PADY cell of each other, so
// each pass buckets the positions into that grid and compares a node only
// against the nine cells around it — O(n) per pass instead of O(n^2), which is
// what lets the pass count (SEP_PASS_BUDGET / n) be high enough to CONVERGE.
// (At the previous 70 O(n^2) passes a 150-node graph still finished with 82
// overlapping pairs once the frame clamp gave it a realistic density.) The
// buckets are rebuilt every pass, so a stale bucket entry can at worst defer an
// overlap to the next pass. Deliberately NOT clamped to the force frame: a node
// pinned against the frame edge could never resolve its overlap.
function separateBoxes(px: Float64Array, py: Float64Array, n: number): void {
  const PADX = NODE_W + SEP_PAD;
  const PADY = NODE_H + SEP_PAD;
  // Cell key: offset so negative cells still map to a distinct positive
  // integer, and spaced so the two axes can never collide.
  const cellKey = (gx: number, gy: number): number => (gy + 1e6) * 4e6 + (gx + 1e6);
  const buckets = new Map<number, number[]>();
  const passes = Math.max(
    SEP_PASS_MIN,
    Math.min(SEP_PASS_MAX, Math.round(SEP_PASS_BUDGET / Math.max(1, n))),
  );
  for (let pass = 0; pass < passes; pass++) {
    buckets.clear();
    for (let i = 0; i < n; i++) {
      const k = cellKey(Math.floor(px[i] / PADX), Math.floor(py[i] / PADY));
      const b = buckets.get(k);
      if (b) b.push(i);
      else buckets.set(k, [i]);
    }
    let moved = false;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(px[i] / PADX);
      const gy = Math.floor(py[i] / PADY);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const cell = buckets.get(cellKey(gx + a, gy + b));
          if (!cell) continue;
          for (let ci = 0; ci < cell.length; ci++) {
            const j = cell[ci];
            if (j <= i) continue;
            const ox = PADX - Math.abs(px[i] - px[j]);
            const oy = PADY - Math.abs(py[i] - py[j]);
            if (ox <= 0 || oy <= 0) continue;
            moved = true;
            if (ox / PADX < oy / PADY) {
              const s = (px[i] >= px[j] ? 1 : -1) * (ox / 2 + 0.5);
              px[i] += s; px[j] -= s;
            } else {
              const s = (py[i] >= py[j] ? 1 : -1) * (oy / 2 + 0.5);
              py[i] += s; py[j] -= s;
            }
          }
        }
      }
    }
    if (!moved) break;
  }
}

function layoutForce(nodes: TopoNode[], edges: TopoEdge[]): LayoutResult {
  const n = nodes.length;
  const idx = new Map<number, number>();
  nodes.forEach((nd: TopoNode, i: number) => idx.set(nd.device_id, i));

  const cellArea = (NODE_W + SEP_PAD) * (NODE_H + SEP_PAD) * FRAME_DENSITY;
  const W = Math.max(900, Math.round(Math.sqrt(cellArea * Math.max(1, n) * FRAME_ASPECT)));
  const H = Math.max(390, Math.round(W / FRAME_ASPECT));
  const k = Math.sqrt((W * H) / Math.max(1, n));
  const cx = W / 2;
  const cy = H / 2;

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const GOLDEN = 2.399963229728653;
  for (let i = 0; i < n; i++) {
    const a = i * GOLDEN;
    const r = (Math.sqrt(i + 0.5) / Math.sqrt(n)) * Math.min(W, H) * 0.45;
    px[i] = cx + r * Math.cos(a);
    py[i] = cy + r * Math.sin(a);
  }

  const links: number[][] = [];
  const degree = new Float64Array(n);
  edges.forEach((e: TopoEdge) => {
    const a = idx.get(e.from_device_id);
    const b = idx.get(e.to_device_id);
    if (a !== undefined && b !== undefined && a !== b) {
      links.push([a, b]);
      degree[a] += 1;
      degree[b] += 1;
    }
  });

  const pairs = Math.max(1, (n * (n - 1)) / 2);
  const iterations = Math.max(
    FORCE_ITER_MIN,
    Math.min(FORCE_ITER_MAX, Math.round(FORCE_PAIR_BUDGET / pairs)),
  );
  let temp = W * 0.1;
  const cool = Math.pow(TEMP_FLOOR / temp, 1 / iterations);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = px[i] - px[j];
        let vy = py[i] - py[j];
        let d2 = vx * vx + vy * vy;
        if (d2 < 0.01) {
          // Deterministic nudge for exactly-coincident nodes (never Math.random).
          vx = ((i * 37) % 11) - 5 + 0.5;
          vy = ((j * 29) % 13) - 6 + 0.5;
          d2 = vx * vx + vy * vy;
        }
        const d = Math.sqrt(d2);
        const f = (k * k) / d;
        const ux = (vx / d) * f;
        const uy = (vy / d) * f;
        dx[i] += ux; dy[i] += uy;
        dx[j] -= ux; dy[j] -= uy;
      }
    }
    for (let li = 0; li < links.length; li++) {
      const a = links[li][0];
      const b = links[li][1];
      const vx = px[a] - px[b];
      const vy = py[a] - py[b];
      const d = Math.max(0.01, Math.sqrt(vx * vx + vy * vy));
      const f = (d * d) / k;
      const ux = (vx / d) * f;
      const uy = (vy / d) * f;
      dx[a] -= ux; dy[a] -= uy;
      dx[b] += ux; dy[b] += uy;
    }
    // Gravity — see note 3 above. Same shape as the attractive term, anchored
    // at the frame centre, scaled up to 3x for a node with no links at all.
    for (let i = 0; i < n; i++) {
      const gx = px[i] - cx;
      const gy = py[i] - cy;
      const gd = Math.sqrt(gx * gx + gy * gy);
      if (gd < 1) continue;
      const gw = GRAVITY * (1 + 2 / (1 + degree[i]));
      const gf = (gw * gd * gd) / k;
      dx[i] -= (gx / gd) * gf;
      dy[i] -= (gy / gd) * gf;
    }
    // Integration, clamped into the frame — see note 1 above.
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const m = Math.min(d, temp);
      let nx = px[i] + (dx[i] / d) * m;
      let ny = py[i] + (dy[i] / d) * m;
      if (!isFinite(nx)) nx = cx;
      if (!isFinite(ny)) ny = cy;
      px[i] = nx < 0 ? 0 : nx > W ? W : nx;
      py[i] = ny < 0 ? 0 : ny > H ? H : ny;
      if (m > maxStep) maxStep = m;
    }
    temp *= cool;
    if (maxStep < 0.5) break;
  }

  separateBoxes(px, py, n);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    // Belt and braces: a non-finite coordinate here would poison the viewBox
    // for the whole canvas, not just its own node.
    if (!isFinite(px[i])) px[i] = cx;
    if (!isFinite(py[i])) py[i] = cy;
    if (px[i] < minX) minX = px[i];
    if (py[i] < minY) minY = py[i];
    if (px[i] > maxX) maxX = px[i];
    if (py[i] > maxY) maxY = py[i];
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

  const posMap = new Map<number, NodePos>();
  const placed: DeviceLayout[] = [];
  nodes.forEach((nd: TopoNode, i: number) => {
    const x = Math.round(px[i] - minX + OUTER_MARGIN);
    const y = Math.round(py[i] - minY + OUTER_MARGIN);
    posMap.set(nd.device_id, { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
    placed.push({ node: nd, x, y });
  });

  return {
    placed,
    posMap,
    clusters: [],
    bands: [],
    width: Math.round(maxX - minX) + NODE_W + 2 * OUTER_MARGIN,
    height: Math.round(maxY - minY) + NODE_H + 2 * OUTER_MARGIN,
  };
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

function TierBand({ band, width }: { band: BandLayout; width: number }) {
  return (
    <g>
      <rect
        x={OUTER_MARGIN / 2}
        y={band.y - 18}
        width={Math.max(0, width - OUTER_MARGIN)}
        height={band.h + 36}
        rx={12}
        fill="#0f172a"
        fillOpacity={0.035}
      />
      <text
        x={OUTER_MARGIN / 2 + 12}
        y={band.y - 18 + 20}
        fontSize={13}
        fontWeight={700}
        fill="#64748b"
        style={{ letterSpacing: '0.06em' }}
      >
        {band.label.toUpperCase()}
      </text>
      <text x={OUTER_MARGIN / 2 + 12} y={band.y - 18 + 38} fontSize={11} fill="#94a3b8">
        {band.count + (band.count === 1 ? ' node' : ' nodes')}
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
  dim,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  label: string;
  dim: boolean;
}) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g opacity={dim ? DIM_OPACITY : 1}>
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
  dim,
  matched,
  stripe,
}: {
  layout: DeviceLayout;
  interactive: boolean;
  onClick: (deviceId: number) => void;
  // Search is active and this node does not match — washed out, not removed,
  // so the operator keeps the surrounding context.
  dim: boolean;
  matched: boolean;
  // Site colour bar drawn along the top edge. Only used by the layouts that
  // have no site boxes to carry that information (tiered / force).
  stripe: string | null;
}) {
  const { node, x, y } = layout;
  // An unmanaged neighbour has no monitored status to colour by and no device
  // page to open, so it is drawn as an outlined "ghost" box rather than a solid
  // status-coloured one — otherwise it would read as a monitored device that is
  // permanently stuck on 'unknown'.
  const managed = node.managed !== false;
  const fill = managed ? (STATUS_FILL[node.status] || STATUS_FILL.unknown) : UNMANAGED_FILL;
  const textFill = managed ? '#ffffff' : UNMANAGED_TEXT;
  const site = node.site_name && node.site_name.trim() ? node.site_name : '';
  const hidden = node.hidden_links || 0;
  const tooltip = (managed
    ? node.name + '\n' + node.ip + (site ? ' · ' + site : '') + '\nStatus: ' + node.status
    : node.name +
      (node.ip ? '\n' + node.ip : '') +
      (site ? '\nSeen at: ' + site : '') +
      '\nNot monitored — discovered via LLDP/CDP')
    + (hidden ? `\n${hidden} neighbour${hidden === 1 ? '' : 's'} hidden by the current filter` : '');
  return (
    <g
      onClick={interactive ? () => onClick(node.device_id) : undefined}
      style={{ cursor: interactive ? 'pointer' : 'default' }}
      opacity={dim ? DIM_OPACITY : 1}
    >
      <title>{tooltip}</title>
      {matched ? (
        <rect
          x={x - 5}
          y={y - 5}
          width={NODE_W + 10}
          height={NODE_H + 10}
          rx={12}
          fill="none"
          stroke={MATCH_RING}
          strokeWidth={2.5}
        />
      ) : null}
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={8}
        fill={fill}
        stroke={
          !managed
            ? UNMANAGED_STROKE
            : node.status === 'down' || node.status === 'warning'
              ? '#00000022'
              : 'none'
        }
        strokeWidth={managed ? 1 : 1.5}
        strokeDasharray={managed ? undefined : '5 3'}
      />
      {stripe ? (
        <rect x={x + 8} y={y + 3} width={NODE_W - 16} height={3} rx={1.5} fill={stripe} />
      ) : null}
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
        fill={textFill}
        textAnchor="middle"
      >
        {truncate(node.name, 16)}
      </text>
      <text
        x={x + NODE_W / 2}
        y={y + 40}
        fontSize={10}
        fill={textFill}
        fillOpacity={managed ? 0.85 : 0.75}
        textAnchor="middle"
      >
        {node.ip}
      </text>
      {hidden > 0 ? (
        <g>
          <rect
            x={x + NODE_W - 34}
            y={y - 8}
            width={40}
            height={17}
            rx={8}
            fill="#ffffff"
            stroke="#94a3b8"
            strokeWidth={1}
          />
          <text
            x={x + NODE_W - 14}
            y={y + 4}
            fontSize={10}
            fontWeight={700}
            fill="#475569"
            textAnchor="middle"
          >
            {'+' + hidden}
          </text>
        </g>
      ) : null}
    </g>
  );
}

// ---- Main component ---------------------------------------------------------
export default function TopologyMapView({
  nodes,
  edges,
  interactive,
  layout = 'sites',
  highlight = '',
  showIsolated = false,
}: {
  nodes: TopoNode[];
  edges: TopoEdge[];
  interactive?: boolean;
  layout?: TopoLayout;
  // Case-insensitive substring matched against name / IP / site. Matching nodes
  // get a ring, everything else is washed out.
  highlight?: string;
  // Draw nodes that have no surviving edge. Needed by the page's "Monitored
  // only" filter: managed-to-managed links currently number ZERO on a real
  // estate, so every monitored device is isolated in that view and dropping
  // unconnected nodes would blank the canvas.
  showIsolated?: boolean;
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
  // Flashed when someone wheels over the canvas WITHOUT the modifier, so the
  // gesture that no longer zooms says why instead of doing nothing visible.
  const [wheelHint, setWheelHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live geometry for the event handlers, which are bound once ([] deps) and
  // would otherwise close over the first render's values.
  const geomRef = useRef({ w: 100, h: 100 });
  const zoomRef = useRef(1);

  const clampPan = (p: { x: number; y: number }, z: number): { x: number; y: number } => ({
    x: clampPanAxis(p.x, z, geomRef.current.w),
    y: clampPanAxis(p.y, z, geomRef.current.h),
  });

  // Wheel zoom toward the cursor.
  //
  // The modifier is required ON PURPOSE. This handler used to preventDefault()
  // every wheel event, which swallowed page scroll: at 1366x700 the page really
  // does scroll (657 content px into a 589px viewport) and the map occupies 350
  // of those 589, so wheeling over it zoomed instead of scrolling and the Apply
  // buttons and legend below the fold could not be reached by the natural
  // gesture. A trackpad two-finger scroll emits the same deltaY, so trackpad
  // users got zoom with no way to opt out. Ctrl/Cmd + wheel is the conventional
  // map-zoom gesture and is also what a trackpad PINCH sends, so pinch-to-zoom
  // keeps working and no longer zooms the whole browser page.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) {
        // Not ours — let the page scroll, and say so.
        setWheelHint(true);
        if (hintTimer.current) clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setWheelHint(false), 1900);
        return;
      }
      e.preventDefault();
      const u = clientToUser(el!, e.clientX, e.clientY);
      setZoom((z: number) => {
        const nz = clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        const k = nz / z;
        if (u) setPan((p) => clampPan({ x: u.x - (u.x - p.x) * k, y: u.y - (u.y - p.y) * k }, nz));
        return nz;
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setPan(clampPan({ x: p.ox + rawDx / s, y: p.oy + rawDy / s }, zoomRef.current));
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
      if (u) setPan((p) => clampPan({ x: u.x - (u.x - p.x) * k, y: u.y - (u.y - p.y) * k }, nz));
      return nz;
    });
  };

  // zoom 1 / pan 0 IS fit-to-view: the viewBox is the graph's own bounding box
  // and preserveAspectRatio="xMidYMid meet" scales it into the viewport.
  const fitView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // 1. Filtering: only nodes that appear in at least one edge — unless the
  //    caller explicitly asked for isolated nodes (see showIsolated).
  const included = useMemo(() => {
    if (showIsolated) return nodes;
    const connected = new Set<number>();
    edges.forEach((e: TopoEdge) => {
      connected.add(e.from_device_id);
      connected.add(e.to_device_id);
    });
    return nodes.filter((n: TopoNode) => connected.has(n.device_id));
  }, [nodes, edges, showIsolated]);

  // 2. Layout, keyed on the graph's SHAPE rather than on array identity.
  //
  //    A plain useMemo([included, edges, layout]) re-paid the whole embedding
  //    whenever the page handed down a new array — and the page rebuilds
  //    `view.nodes` on every filter change and (before this was split out) on
  //    every keystroke in the highlight box, so the force layout was being
  //    recomputed for renders that could not move a single node. The signature
  //    below covers everything the three layouts actually read: which nodes are
  //    present, the fields they sort/group by, and the edge list.
  const layoutKey = useMemo(() => {
    const ns = included.map((n: TopoNode) =>
      n.device_id + ':' + (n.name || '') + ':' + (n.site_name || '') +
      ':' + (n.managed === false ? '0' : '1') + (n.is_gateway ? '1' : '0'),
    ).join('|');
    const es = edges.map((e: TopoEdge) => e.from_device_id + '>' + e.to_device_id).join('|');
    return layout + '#' + ns + '#' + es;
  }, [included, edges, layout]);

  const layoutCache = useRef<{ key: string; value: LayoutResult } | null>(null);
  const lay = useMemo<LayoutResult>(() => {
    const cached = layoutCache.current;
    if (cached && cached.key === layoutKey) return cached.value;
    const value: LayoutResult = included.length === 0
      ? { placed: [], posMap: new Map(), clusters: [], bands: [], width: 100, height: 100 }
      : layout === 'tiered'
        ? layoutTiered(included, edges)
        : layout === 'force'
          ? layoutForce(included, edges)
          : layoutSites(included);
    layoutCache.current = { key: layoutKey, value };
    return value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Geometry the once-bound wheel/drag handlers read (see geomRef above).
  geomRef.current = { w: lay.width, h: lay.height };
  zoomRef.current = zoom;

  // Re-fit whenever the drawn graph changes shape (layout switch, filter
  // change) — otherwise a pan left over from the previous picture leaves the
  // new one scrolled off-screen.
  const fitKey = `${layout}|${included.length}|${edges.length}|${Math.round(lay.width)}x${Math.round(lay.height)}`;
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [fitKey]);

  const needle = highlight.trim().toLowerCase();
  const matches = useMemo(() => {
    const s = new Set<number>();
    if (!needle) return s;
    included.forEach((n: TopoNode) => {
      const hay = [n.name, n.ip, n.site_name].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(needle)) s.add(n.device_id);
    });
    return s;
  }, [included, needle]);

  // Bring the first search match into view if the canvas is panned/zoomed away
  // from it. Without this a highlight could report "34 matches" while the
  // viewport showed empty canvas. Deliberately a no-op when the match is
  // already on screen, so typing in the highlight box does not jitter the map.
  const firstMatchKey = (() => {
    if (!needle) return '';
    for (let i = 0; i < lay.placed.length; i++) {
      if (matches.has(lay.placed[i].node.device_id)) return String(lay.placed[i].node.device_id);
    }
    return '';
  })();
  useEffect(() => {
    if (!firstMatchKey) return;
    const hit = lay.posMap.get(Number(firstMatchKey));
    if (!hit) return;
    setPan((p) => {
      const sx = p.x + hit.cx * zoom;
      const sy = p.y + hit.cy * zoom;
      if (sx >= 0 && sx <= lay.width && sy >= 0 && sy <= lay.height) return p; // already visible
      return clampPan({ x: lay.width / 2 - hit.cx * zoom, y: lay.height / 2 - hit.cy * zoom }, zoom);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMatchKey, lay, zoom]);

  const handleNodeClick = (deviceId: number): void => {
    if (justPanned.current) return; // ignore the click that ends a pan-drag
    // deviceId <= 0 is a synthetic unmanaged-neighbour id — there is no
    // /devices/[id] page behind it. DeviceNode already refuses to fire for
    // those; this is the belt-and-braces half.
    if (isInteractive && deviceId > 0) {
      router.push('/devices/' + deviceId);
    }
  };

  if (included.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 'var(--text-md)' }}>
        No topology to display.
      </div>
    );
  }

  const showStripe = layout !== 'sites';
  const drawnEdges = edges.filter(
    (e: TopoEdge) => lay.posMap.has(e.from_device_id) && lay.posMap.has(e.to_device_id),
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${lay.width} ${lay.height}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={onSvgMouseDown}
        style={{
          display: 'block',
          cursor: grabbing ? 'grabbing' : 'grab',
          // pan-y, not none: the map must not be a dead zone that swallows a
          // touch scroll of the PAGE (same reasoning as the wheel modifier
          // above). Dragging to pan is a mouse gesture and is unaffected.
          touchAction: 'pan-y',
        }}
      >
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* 1. Backdrops: site boundary boxes ('sites') or tier bands ('tiered') */}
          {lay.clusters.map((c: ClusterLayout) => (
            <SiteBox key={'box-' + c.siteName} cluster={c} />
          ))}
          {/* Keyed by index, not by label: the tiered layout emits one
              Core/Distribution/Access set PER WRAPPED ROW, so labels repeat. */}
          {lay.bands.map((b: BandLayout, i: number) => (
            <TierBand key={'band-' + i} band={b} width={lay.width} />
          ))}

          {/* 2. Connections (on top of the backdrop) — anchored to node edges */}
          {drawnEdges.map((e: TopoEdge, i: number) => {
            const a = lay.posMap.get(e.from_device_id);
            const b = lay.posMap.get(e.to_device_id);
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
                dim={
                  !!needle &&
                  !matches.has(e.from_device_id) &&
                  !matches.has(e.to_device_id)
                }
              />
            );
          })}

          {/* 3. Device nodes (on top) */}
          {lay.placed.map((d: DeviceLayout) => (
            <DeviceNode
              key={'node-' + d.node.device_id}
              layout={d}
              interactive={isInteractive && d.node.managed !== false}
              onClick={handleNodeClick}
              dim={!!needle && !matches.has(d.node.device_id)}
              matched={!!needle && matches.has(d.node.device_id)}
              stripe={showStripe ? siteColor(siteKey(d.node)) : null}
            />
          ))}
        </g>
      </svg>

      {/* Zoom controls (screen-fixed overlay) */}
      <div className="sv-map-zoomctl" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" title="Zoom in" onClick={() => zoomByCenter(1.2)}>+</button>
        <button type="button" title="Zoom out" onClick={() => zoomByCenter(1 / 1.2)}>−</button>
        <button type="button" title="Fit to view" onClick={fitView}>⤢</button>
        <span className="lvl">{Math.round(zoom * 100)}%</span>
      </div>

      {/* Just-in-time affordance: shown only for the gesture that no longer
          zooms, so a plain wheel scroll explains itself instead of appearing
          to do nothing. Reuses the existing .sv-map-legend chip styling — no
          new global CSS (several agents are editing globals.css). */}
      {wheelHint && (
        <div
          className="sv-map-legend"
          style={{ left: '50%', bottom: 12, transform: 'translateX(-50%)', pointerEvents: 'none', fontWeight: 600 }}
        >
          Hold Ctrl (⌘ on Mac) and scroll to zoom · drag to pan
        </div>
      )}
    </div>
  );
}

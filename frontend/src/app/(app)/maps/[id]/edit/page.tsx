'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useApi, apiGet, apiSend } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { Loading, ErrorBox } from '@/components/ui';
import { IconTrash, IconLock, IconUnlock, IconUndo, IconRedo } from '@/components/icons';
import {
  type FullMap, type MapDevice, type MapConnection, type MapLabel, type MapShape, type MapSummary, type MapNodeLike,
  statusFill, deviceCenter, normalizeMap, connLive, fmtBps, utilColor, elbowPoints, nodeAnchorBox, edgePoint,
} from '@/lib/mapTypes';
import {
  MapGlyph, GlyphSwatch, DEVICE_GLYPHS, deviceGlyphFor, BASIC_SHAPES, SHAPE_GLYPHS,
} from '@/lib/mapIcons';
import { ShapeEl } from '@/components/SVGMapView';

const DEFAULT_LINE = '#94a3b8';
const CANVAS_PRESETS = [
  { key: '1600x900', label: 'HD — 1600 × 900', w: 1600, h: 900 },
  { key: '1920x1080', label: 'FHD — 1920 × 1080', w: 1920, h: 1080 },
  { key: '1200x1200', label: 'Square — 1200 × 1200', w: 1200, h: 1200 },
];

type Tool = 'select' | 'line' | 'label';
// A connection endpoint: a device node or a decorative shape.
type EndRef = { kind: 'device' | 'shape'; id: number };
type PaletteDevice = {
  id: number; name: string; ip_address: string;
  current_status: string; site_name: string | null;
};
type Selection =
  | { kind: 'device'; id: number }
  | { kind: 'connection'; id: number }
  | { kind: 'label'; id: number }
  | { kind: 'shape'; id: number }
  | null;
type Ctx = { x: number; y: number; kind: 'device' | 'connection' | 'label' | 'shape'; id: number } | null;
type Drag =
  | { kind: 'device' | 'label' | 'shape'; id: number; dx: number; dy: number; moved?: boolean }
  | { kind: 'resize'; id: number; target: 'device' | 'shape'; handle: string; ox: number; oy: number; ow: number; oh: number; sx: number; sy: number; moved?: boolean }
  | { kind: 'multi'; id: number; sx: number; sy: number; origins: Record<string, { x: number; y: number }>; moved?: boolean }
  | { kind: 'waypoint'; connId: number; index: number; moved?: boolean }
  | null;
type Marquee = { sx: number; sy: number; cx: number; cy: number } | null;
type Guide = { x: number | null; y: number | null };
type Snapshot = {
  devices: MapDevice[]; connections: MapConnection[]; labels: MapLabel[]; shapes: MapShape[];
};
type Clipboard = { shapes: MapShape[]; labels: MapLabel[] };

const MIN_W = 60;
const MIN_H = 40;
const GRID = 10;
const GUIDE_TOL = 5;

// <input type="color"> needs a 6-digit hex; non-hex (rgba/null) → '' so the
// caller can fall back to a default.
function normalizeColor(c: string | null | undefined): string {
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : '';
}

export default function MapEditorPage() {
  const { id } = useParams<{ id: string }>();
  const loaded = useApi<FullMap>(`/api/maps/${id}`, 0);
  const palette = useApi<PaletteDevice[]>('/api/devices', 20000);

  // ── Editable map state ───────────────────────────────────────
  const [name, setName] = useState('');
  const [canvasW, setCanvasW] = useState(1600);
  const [canvasH, setCanvasH] = useState(900);
  const [bgColor, setBgColor] = useState('#f8fafc');
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [uuid, setUuid] = useState('');

  const [devices, setDevices] = useState<MapDevice[]>([]);
  const [connections, setConnections] = useState<MapConnection[]>([]);
  const [labels, setLabels] = useState<MapLabel[]>([]);
  const [shapes, setShapes] = useState<MapShape[]>([]);

  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ctx, setCtx] = useState<Ctx>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [lineStart, setLineStart] = useState<EndRef | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [editingLabel, setEditingLabel] = useState<number | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [marquee, setMarquee] = useState<Marquee>(null);
  const [guide, setGuide] = useState<Guide>({ x: null, y: null });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const tempId = useRef(-1);
  const nextTemp = () => { tempId.current -= 1; return tempId.current; };

  const clipboard = useRef<Clipboard | null>(null);
  const nudgedRef = useRef(false); // true while an arrow-nudge burst is in progress

  // Snap a coordinate to the grid when snapping is enabled.
  function snap(n: number): number {
    return snapEnabled ? Math.round(n / GRID) * GRID : n;
  }

  // ── Undo / redo history (snapshots of the four layout arrays) ──
  const history = useRef<Snapshot[]>([]);
  const histIndex = useRef(-1);
  // Live refs so pushSnapshot can read current arrays without stale closures.
  const arraysRef = useRef<Snapshot>({ devices: [], connections: [], labels: [], shapes: [] });
  arraysRef.current = { devices, connections, labels, shapes };

  function cloneSnap(s: Snapshot): Snapshot {
    return {
      devices: s.devices.map((d) => ({ ...d })),
      connections: s.connections.map((c) => ({ ...c })),
      labels: s.labels.map((l) => ({ ...l })),
      shapes: s.shapes.map((sh) => ({ ...sh })),
    };
  }
  function seedHistory(s: Snapshot) {
    history.current = [cloneSnap(s)];
    histIndex.current = 0;
    setCanUndo(false);
    setCanRedo(false);
    setDirty(false);
  }
  function pushSnapshot() {
    const snap = cloneSnap(arraysRef.current);
    // Drop any redo tail, then append.
    history.current = history.current.slice(0, histIndex.current + 1);
    history.current.push(snap);
    if (history.current.length > 100) history.current.shift();
    histIndex.current = history.current.length - 1;
    setCanUndo(histIndex.current > 0);
    setCanRedo(false);
    setDirty(true);
  }
  function restoreSnapshot(s: Snapshot) {
    const c = cloneSnap(s);
    setDevices(c.devices);
    setConnections(c.connections);
    setLabels(c.labels);
    setShapes(c.shapes);
    setSelection(null);
    setSelectedIds(new Set());
    setEditingLabel(null);
  }
  function undo() {
    if (histIndex.current <= 0) return;
    histIndex.current -= 1;
    restoreSnapshot(history.current[histIndex.current]);
    setCanUndo(histIndex.current > 0);
    setCanRedo(histIndex.current < history.current.length - 1);
  }
  function redo() {
    if (histIndex.current >= history.current.length - 1) return;
    histIndex.current += 1;
    restoreSnapshot(history.current[histIndex.current]);
    setCanUndo(histIndex.current > 0);
    setCanRedo(histIndex.current < history.current.length - 1);
  }

  // Hydrate editable state from the loaded map (once it arrives).
  useEffect(() => {
    if (!loaded.data) return;
    const m = normalizeMap(loaded.data);
    setName(m.name);
    setCanvasW(m.canvas_w);
    setCanvasH(m.canvas_h);
    setBgColor(m.bg_color || '#f8fafc');
    setBgImage(m.bg_image_b64 || null);
    setIsPublic(m.is_public);
    setUuid(m.uuid);
    setDevices(m.devices);
    setConnections(m.connections);
    setLabels(m.labels);
    setShapes(m.shapes || []);
    seedHistory({ devices: m.devices, connections: m.connections, labels: m.labels, shapes: m.shapes || [] });
  }, [loaded.data]);

  // ESC cancels an in-progress connection / context menu / label edit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setLineStart(null); setCtx(null); setEditingLabel(null); setMarquee(null); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Warn before leaving/reloading with unsaved layout changes.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = ''; }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Editing keyboard: undo/redo, delete, copy/paste. Skip while typing in a field.
  useEffect(() => {
    function inField(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
      if (meta && (e.key === 'c' || e.key === 'C')) { if (!inField(e.target)) { e.preventDefault(); copySelection(); } return; }
      if (meta && (e.key === 'v' || e.key === 'V')) { if (!inField(e.target)) { e.preventDefault(); pasteClipboard(); } return; }
      if (meta && (e.key === 'd' || e.key === 'D')) { if (!inField(e.target)) { e.preventDefault(); duplicateSelection(); } return; }
      if (meta && (e.key === 'g' || e.key === 'G')) { if (!inField(e.target)) { e.preventDefault(); if (e.shiftKey) ungroupSelected(); else groupSelected(); } return; }
      if (inField(e.target) || editingLabel != null) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) { e.preventDefault(); deleteSelected(); return; }
      // Arrow-key nudge (1 unit, 10 with Shift) when something is selected.
      if (selectedIds.size > 0 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowUp') nudgeSelected(0, -step);
        else if (e.key === 'ArrowDown') nudgeSelected(0, step);
        else if (e.key === 'ArrowLeft') nudgeSelected(-step, 0);
        else nudgeSelected(step, 0);
        return;
      }
      // Tool hotkeys (no modifier): V=select, L=line, T=label.
      if (!meta && !e.altKey) {
        if (e.key === 'v' || e.key === 'V') { setTool('select'); }
        else if (e.key === 'l' || e.key === 'L') { setTool('line'); }
        else if (e.key === 't' || e.key === 'T') { setTool('label'); }
      }
    }
    // Commit one undo snapshot when an arrow-nudge burst ends (key released).
    function onKeyUp(e: KeyboardEvent) {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && nudgedRef.current) {
        nudgedRef.current = false;
        pushSnapshot();
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  });

  // Convert a browser point to SVG user space (handles viewBox scaling).
  function toSvg(clientX: number, clientY: number) {
    const svg = svgRef.current;
    if (!svg) return { x: clientX, y: clientY };
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  const usedDeviceIds = new Set(devices.map((d) => d.device_id).filter((v): v is number => v != null));

  // Nudge every selected element by (dx,dy) user units (arrow keys).
  function nudgeSelected(dx: number, dy: number) {
    if (selectedIds.size === 0) return;
    const has = (k: string) => selectedIds.has(k);
    setDevices((prev) => prev.map((d) => (has(`device:${d.id}`) && !d.locked ? { ...d, x: Number(d.x) + dx, y: Number(d.y) + dy } : d)));
    setShapes((prev) => prev.map((s) => (has(`shape:${s.id}`) && !s.locked ? { ...s, x: Number(s.x) + dx, y: Number(s.y) + dy } : s)));
    setLabels((prev) => prev.map((l) => (has(`label:${l.id}`) && !l.locked ? { ...l, x: Number(l.x) + dx, y: Number(l.y) + dy } : l)));
    // Coalesce a burst of arrow-nudges into ONE undo entry — the snapshot is taken
    // on arrow keyup (see the keyboard effect), not on every keystroke.
    nudgedRef.current = true;
  }

  // Duplicate the selection (shapes + labels) with a small offset — independent of
  // the copy/paste clipboard, so Ctrl+D doesn't clobber what the user copied.
  function duplicateSelection() {
    const cs: MapShape[] = [];
    const cl: MapLabel[] = [];
    selectedIds.forEach((k) => {
      const [kind, idStr] = k.split(':');
      const id = Number(idStr);
      if (kind === 'shape') { const s = shapes.find((v) => v.id === id); if (s) cs.push({ ...s }); }
      else if (kind === 'label') { const l = labels.find((v) => v.id === id); if (l) cl.push({ ...l }); }
    });
    insertClones(cs, cl);
  }

  // Right-click context-menu action dispatch.
  function handleCtxAction(action: string, c: NonNullable<Ctx>) {
    const { kind, id } = c;
    if (action === 'delete') {
      if (kind === 'device') removeDevice(id);
      else if (kind === 'connection') deleteConnection(id);
      else if (kind === 'shape') deleteShape(id);
      else deleteLabel(id);
    } else if (action === 'front') {
      if (kind === 'device') deviceToFront(id); else if (kind === 'shape') shapeToFront(id);
    } else if (action === 'back') {
      if (kind === 'device') deviceToBack(id); else if (kind === 'shape') shapeToBack(id);
    } else if (action === 'duplicate') {
      if (kind === 'shape') { const s = shapes.find((v) => v.id === id); if (s) insertClones([{ ...s }], []); }
      else if (kind === 'label') { const l = labels.find((v) => v.id === id); if (l) insertClones([], [{ ...l }]); }
    } else if (action === 'lock') {
      if (kind === 'device') { const d = devices.find((v) => v.id === id); if (d) updateDevice(id, { locked: !d.locked }); }
      else if (kind === 'shape') { const s = shapes.find((v) => v.id === id); if (s) updateShape(id, { locked: !s.locked }); }
      else if (kind === 'label') { const l = labels.find((v) => v.id === id); if (l) updateLabel(id, { locked: !l.locked }); }
    }
  }

  // ── Delete all currently selected elements ───────────────────
  function deleteSelected() {
    if (selectedIds.size === 0) return;
    const devIds = new Set<number>();
    const shapeIds = new Set<number>();
    const labelIds = new Set<number>();
    selectedIds.forEach((k) => {
      const [kind, idStr] = k.split(':');
      const id = Number(idStr);
      if (kind === 'device') devIds.add(id);
      else if (kind === 'shape') shapeIds.add(id);
      else if (kind === 'label') labelIds.add(id);
    });
    setDevices((prev) => prev.filter((d) => !devIds.has(d.id)));
    setConnections((prev) => prev.filter((c) =>
      !(c.from_kind === 'device' && devIds.has(c.from_item_id)) &&
      !(c.to_kind === 'device' && devIds.has(c.to_item_id)) &&
      !(c.from_kind === 'shape' && shapeIds.has(c.from_item_id)) &&
      !(c.to_kind === 'shape' && shapeIds.has(c.to_item_id))));
    setShapes((prev) => prev.filter((s) => !shapeIds.has(s.id)));
    setLabels((prev) => prev.filter((l) => !labelIds.has(l.id)));
    setSelection(null);
    setSelectedIds(new Set());
    setEditingLabel(null);
    pushSnapshot();
  }

  // ── Align / distribute the multi-selection ───────────────────
  function isElemLocked(kind: string, id: number): boolean {
    if (kind === 'device') return !!devices.find((d) => d.id === id)?.locked;
    if (kind === 'shape') return !!shapes.find((s) => s.id === id)?.locked;
    if (kind === 'label') return !!labels.find((l) => l.id === id)?.locked;
    return false;
  }
  function selectedBoxes(): { key: string; kind: string; id: number; x: number; y: number; w: number; h: number }[] {
    const out: { key: string; kind: string; id: number; x: number; y: number; w: number; h: number }[] = [];
    selectedIds.forEach((k) => {
      const [kind, idStr] = k.split(':');
      const id = Number(idStr);
      // Locked elements don't move, so they must not skew the align/distribute extents.
      if (isElemLocked(kind, id)) return;
      const b = elemBox(kind as 'device' | 'shape' | 'label', id);
      if (b) out.push({ key: k, kind, id, x: b.x, y: b.y, w: b.w, h: b.h });
    });
    return out;
  }
  function moveElemTo(kind: string, id: number, x: number, y: number) {
    if (kind === 'device') setDevices((prev) => prev.map((d) => (d.id === id && !d.locked ? { ...d, x, y } : d)));
    else if (kind === 'shape') setShapes((prev) => prev.map((s) => (s.id === id && !s.locked ? { ...s, x, y } : s)));
    else if (kind === 'label') setLabels((prev) => prev.map((l) => (l.id === id && !l.locked ? { ...l, x, y: y + 12 } : l)));
  }
  function alignSelected(edge: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') {
    const boxes = selectedBoxes();
    if (boxes.length < 2) return;
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    for (const b of boxes) {
      let nx = b.x; let ny = b.y;
      if (edge === 'left') nx = minX;
      else if (edge === 'right') nx = maxX - b.w;
      else if (edge === 'center') nx = midX - b.w / 2;
      else if (edge === 'top') ny = minY;
      else if (edge === 'bottom') ny = maxY - b.h;
      else if (edge === 'middle') ny = midY - b.h / 2;
      moveElemTo(b.kind, b.id, nx, ny);
    }
    pushSnapshot();
  }
  function distributeSelected(axis: 'h' | 'v') {
    const boxes = selectedBoxes();
    if (boxes.length < 3) return;
    if (axis === 'h') {
      const sorted = [...boxes].sort((a, b) => (a.x + a.w / 2) - (b.x + b.w / 2));
      const first = sorted[0].x + sorted[0].w / 2;
      const last = sorted[sorted.length - 1].x + sorted[sorted.length - 1].w / 2;
      const step = (last - first) / (sorted.length - 1);
      sorted.forEach((b, i) => { const cx = first + step * i; moveElemTo(b.kind, b.id, cx - b.w / 2, b.y); });
    } else {
      const sorted = [...boxes].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
      const first = sorted[0].y + sorted[0].h / 2;
      const last = sorted[sorted.length - 1].y + sorted[sorted.length - 1].h / 2;
      const step = (last - first) / (sorted.length - 1);
      sorted.forEach((b, i) => { const cy = first + step * i; moveElemTo(b.kind, b.id, b.x, cy - b.h / 2); });
    }
    pushSnapshot();
  }

  // ── Copy / paste (shapes + labels only) ──────────────────────
  function copySelection() {
    const cs: MapShape[] = [];
    const cl: MapLabel[] = [];
    selectedIds.forEach((k) => {
      const [kind, idStr] = k.split(':');
      const id = Number(idStr);
      if (kind === 'shape') { const s = shapes.find((v) => v.id === id); if (s) cs.push({ ...s }); }
      else if (kind === 'label') { const l = labels.find((v) => v.id === id); if (l) cl.push({ ...l }); }
    });
    if (cs.length === 0 && cl.length === 0) { clipboard.current = null; return; }
    clipboard.current = { shapes: cs, labels: cl };
  }
  // Insert offset copies of the given shapes/labels as new elements + select them.
  // Shared by paste (from clipboard) and duplicate (from current selection).
  function insertClones(srcShapes: MapShape[], srcLabels: MapLabel[]) {
    if (srcShapes.length === 0 && srcLabels.length === 0) return;
    const newKeys: string[] = [];
    const newShapes = srcShapes.map((s) => { const id = nextTemp(); newKeys.push(`shape:${id}`); return { ...s, id, x: Number(s.x) + 20, y: Number(s.y) + 20 }; });
    const newLabels = srcLabels.map((l) => { const id = nextTemp(); newKeys.push(`label:${id}`); return { ...l, id, x: Number(l.x) + 20, y: Number(l.y) + 20 }; });
    setShapes((prev) => [...prev, ...newShapes]);
    setLabels((prev) => [...prev, ...newLabels]);
    setSelectedIds(new Set(newKeys));
    setSelection(newKeys.length === 1 ? (() => { const [k, idStr] = newKeys[0].split(':'); return { kind: k as any, id: Number(idStr) }; })() : null);
    pushSnapshot();
  }
  function pasteClipboard() {
    const cb = clipboard.current;
    if (!cb) return;
    insertClones(cb.shapes, cb.labels);
  }

  // ── Multi-select helpers ─────────────────────────────────────
  // Bounding box of a selectable element (labels treated as a small box).
  function elemBox(kind: 'device' | 'shape' | 'label', id: number):
    { x: number; y: number; w: number; h: number } | null {
    if (kind === 'device') {
      const d = devices.find((v) => v.id === id);
      return d ? { x: Number(d.x), y: Number(d.y), w: Number(d.width), h: Number(d.height) } : null;
    }
    if (kind === 'shape') {
      const s = shapes.find((v) => v.id === id);
      return s ? { x: Number(s.x), y: Number(s.y), w: Number(s.width), h: Number(s.height) } : null;
    }
    const l = labels.find((v) => v.id === id);
    return l ? { x: Number(l.x), y: Number(l.y) - 12, w: Math.max(20, (l.text || '').length * 7), h: 16 } : null;
  }

  // Click selection: plain = just this element; shift = toggle in the set.
  function selectElement(kind: 'device' | 'shape' | 'label', id: number, shift: boolean) {
    const key = `${kind}:${id}`;
    if (shift) {
      setSelectedIds((prev) => {
        const n = new Set(prev);
        if (n.has(key)) n.delete(key); else n.add(key);
        return n;
      });
      setSelection({ kind, id } as Selection);
    } else {
      setSelectedIds(new Set([key]));
      setSelection({ kind, id } as Selection);
    }
  }

  // Build a multi-move drag capturing every selected element's origin.
  function buildMultiDrag(startId: number, p: { x: number; y: number }, keys: Set<string> = selectedIds): Drag {
    const origins: Record<string, { x: number; y: number }> = {};
    keys.forEach((k) => {
      const [kind, idStr] = k.split(':');
      const id = Number(idStr);
      if (kind === 'device') { const d = devices.find((v) => v.id === id); if (d && !d.locked) origins[k] = { x: Number(d.x), y: Number(d.y) }; }
      else if (kind === 'shape') { const s = shapes.find((v) => v.id === id); if (s && !s.locked) origins[k] = { x: Number(s.x), y: Number(s.y) }; }
      else if (kind === 'label') { const l = labels.find((v) => v.id === id); if (l && !l.locked) origins[k] = { x: Number(l.x), y: Number(l.y) }; }
    });
    return { kind: 'multi', id: startId, sx: p.x, sy: p.y, origins, moved: false };
  }

  // ── Grouping ──────────────────────────────────────────────────
  // All selection keys belonging to the same group as (kind,id), or null if the
  // element isn't grouped.
  function groupKeysFor(kind: 'device' | 'shape' | 'label', id: number): Set<string> | null {
    let gid: number | null | undefined;
    if (kind === 'device') gid = devices.find((d) => d.id === id)?.group_id;
    else if (kind === 'shape') gid = shapes.find((s) => s.id === id)?.group_id;
    else gid = labels.find((l) => l.id === id)?.group_id;
    if (gid == null) return null;
    const keys = new Set<string>();
    devices.forEach((d) => { if (d.group_id === gid) keys.add(`device:${d.id}`); });
    shapes.forEach((s) => { if (s.group_id === gid) keys.add(`shape:${s.id}`); });
    labels.forEach((l) => { if (l.group_id === gid) keys.add(`label:${l.id}`); });
    return keys;
  }
  function toggleGroupSelection(grp: Set<string>) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      const allIn = Array.from(grp).every((k) => n.has(k));
      grp.forEach((k) => { if (allIn) n.delete(k); else n.add(k); });
      return n;
    });
  }
  // Grouped mousedown: select the whole group (toggle on shift) and, on a plain
  // click, start a group move. Returns true when the element was grouped.
  function handleGroupedMouseDown(kind: 'device' | 'shape' | 'label', id: number, p: { x: number; y: number }, shift: boolean): boolean {
    const grp = groupKeysFor(kind, id);
    if (!grp) return false;
    setSelection({ kind, id } as Selection);
    if (shift) { toggleGroupSelection(grp); }
    else { setSelectedIds(grp); setDrag(buildMultiDrag(id, p, grp)); }
    return true;
  }
  function groupSelected() {
    if (selectedIds.size < 2) return;
    const gid = nextTemp(); // unique negative tag; persists as an integer
    setDevices((prev) => prev.map((d) => (selectedIds.has(`device:${d.id}`) ? { ...d, group_id: gid } : d)));
    setShapes((prev) => prev.map((s) => (selectedIds.has(`shape:${s.id}`) ? { ...s, group_id: gid } : s)));
    setLabels((prev) => prev.map((l) => (selectedIds.has(`label:${l.id}`) ? { ...l, group_id: gid } : l)));
    pushSnapshot();
  }
  function ungroupSelected() {
    setDevices((prev) => prev.map((d) => (selectedIds.has(`device:${d.id}`) ? { ...d, group_id: null } : d)));
    setShapes((prev) => prev.map((s) => (selectedIds.has(`shape:${s.id}`) ? { ...s, group_id: null } : s)));
    setLabels((prev) => prev.map((l) => (selectedIds.has(`label:${l.id}`) ? { ...l, group_id: null } : l)));
    pushSnapshot();
  }

  // ── Device interactions ──────────────────────────────────────
  function onDeviceMouseDown(e: React.MouseEvent, d: MapDevice) {
    e.stopPropagation();
    setCtx(null);
    if (tool === 'select') {
      const key = `device:${d.id}`;
      const p = toSvg(e.clientX, e.clientY);
      if (d.locked) { selectElement('device', d.id, e.shiftKey); return; }
      if (handleGroupedMouseDown('device', d.id, p, e.shiftKey)) return;
      if (e.shiftKey) { selectElement('device', d.id, true); return; }
      // If clicking an already-multi-selected element, start a group move.
      if (selectedIds.size > 1 && selectedIds.has(key)) {
        setSelection({ kind: 'device', id: d.id });
        setDrag(buildMultiDrag(d.id, p));
        return;
      }
      selectElement('device', d.id, false);
      setDrag({ kind: 'device', id: d.id, dx: p.x - Number(d.x), dy: p.y - Number(d.y), moved: false });
    } else if (tool === 'line') {
      startOrFinishLine({ kind: 'device', id: d.id });
    }
  }

  // Line tool: first click sets the start endpoint, second click on a DIFFERENT
  // element creates the connection. Works for devices and shapes alike.
  function startOrFinishLine(end: EndRef) {
    if (lineStart == null) { setLineStart(end); return; }
    if (lineStart.kind === end.kind && lineStart.id === end.id) return; // same element
    addConnection(lineStart, end);
    setLineStart(null);
  }

  function addConnection(a: EndRef, b: EndRef) {
    const dup = connections.some((c) =>
      (c.from_kind === a.kind && c.from_item_id === a.id && c.to_kind === b.kind && c.to_item_id === b.id) ||
      (c.from_kind === b.kind && c.from_item_id === b.id && c.to_kind === a.kind && c.to_item_id === a.id));
    if (dup) return;
    const c: MapConnection = {
      id: nextTemp(), from_item_id: a.id, to_item_id: b.id, from_kind: a.kind, to_kind: b.kind,
      color: DEFAULT_LINE, line_style: 'solid', label: null,
      arrow: false, width: 2, routing: 'straight',
      from_if_index: null, to_if_index: null, capacity_bps: null,
    };
    setConnections((prev) => [...prev, c]);
    pushSnapshot();
  }

  function addDeviceAt(pd: PaletteDevice, x: number, y: number) {
    if (usedDeviceIds.has(pd.id)) return;
    const w = 120, h = 60;
    const d: MapDevice = {
      id: nextTemp(), device_id: pd.id, x: x - w / 2, y: y - h / 2,
      label: null, icon_type: 'auto', node_style: 'box', z_index: 0, width: w, height: h,
      device_name: pd.name, ip_address: pd.ip_address, site_name: pd.site_name,
      current_status: pd.current_status, is_gateway: false, alert_suppressed: false,
    };
    setDevices((prev) => [...prev, d]);
    pushSnapshot();
  }

  function removeDevice(deviceId: number) {
    setDevices((prev) => prev.filter((d) => d.id !== deviceId));
    setConnections((prev) => prev.filter((c) =>
      !(c.from_kind === 'device' && c.from_item_id === deviceId) &&
      !(c.to_kind === 'device' && c.to_item_id === deviceId)));
    setSelection(null);
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(`device:${deviceId}`); return n; });
    pushSnapshot();
  }
  function updateDevice(deviceId: number, patch: Partial<MapDevice>) {
    setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, ...patch } : d)));
    pushSnapshot();
  }
  function deviceToFront(deviceId: number) {
    const max = devices.reduce((m, d) => Math.max(m, Number(d.z_index) || 0), 0);
    updateDevice(deviceId, { z_index: max + 1 });
  }
  function deviceToBack(deviceId: number) {
    const min = devices.reduce((m, d) => Math.min(m, Number(d.z_index) || 0), 0);
    updateDevice(deviceId, { z_index: min - 1 });
  }
  // Start a resize drag from one of an element's 8 handles (device or shape).
  function onResizeStart(
    e: React.MouseEvent,
    item: { id: number; x: number; y: number; width: number; height: number },
    target: 'device' | 'shape', handle: string,
  ) {
    e.stopPropagation();
    setSelection({ kind: target, id: item.id });
    setSelectedIds(new Set([`${target}:${item.id}`]));
    const p = toSvg(e.clientX, e.clientY);
    setDrag({ kind: 'resize', id: item.id, target, handle,
      ox: Number(item.x), oy: Number(item.y), ow: Number(item.width), oh: Number(item.height), sx: p.x, sy: p.y, moved: false });
  }

  // ── Shape interactions ───────────────────────────────────────
  function addShape(kind: string) {
    const isGlyph = SHAPE_GLYPHS.some((g) => g.key === kind);
    const w = kind === 'line' || kind === 'arrow' ? 140 : (isGlyph ? 80 : 140);
    const h = kind === 'line' ? 2 : kind === 'arrow' ? 40 : (isGlyph ? 80 : 90);
    const cx = canvasW / 2, cy = canvasH / 2;
    const s: MapShape = {
      id: nextTemp(), kind, x: cx - w / 2, y: cy - h / 2, width: w, height: h,
      fill: isGlyph || kind === 'line' || kind === 'arrow' || kind === 'text' ? null
        : kind === 'zone' ? 'rgba(59,130,246,0.06)' : '#dbeafe',
      stroke: '#334155', stroke_width: 2,
      text: kind === 'text' ? 'Text' : kind === 'zone' ? 'Zone' : null,
      font_size: 14, text_color: '#1a2744', rotation: 0, z_index: 0,
    };
    setShapes((prev) => [...prev, s]);
    setSelection({ kind: 'shape', id: s.id });
    setSelectedIds(new Set([`shape:${s.id}`]));
    setTool('select');
    pushSnapshot();
  }
  function onShapeMouseDown(e: React.MouseEvent, s: MapShape) {
    e.stopPropagation();
    setCtx(null);
    // Shapes (cloud/building/icons) can be connection endpoints too.
    if (tool === 'line') { startOrFinishLine({ kind: 'shape', id: s.id }); return; }
    if (tool !== 'select') return;
    const key = `shape:${s.id}`;
    const p = toSvg(e.clientX, e.clientY);
    if (s.locked) { selectElement('shape', s.id, e.shiftKey); return; }
    if (handleGroupedMouseDown('shape', s.id, p, e.shiftKey)) return;
    if (e.shiftKey) { selectElement('shape', s.id, true); return; }
    if (selectedIds.size > 1 && selectedIds.has(key)) {
      setSelection({ kind: 'shape', id: s.id });
      setDrag(buildMultiDrag(s.id, p));
      return;
    }
    selectElement('shape', s.id, false);
    setDrag({ kind: 'shape', id: s.id, dx: p.x - Number(s.x), dy: p.y - Number(s.y), moved: false });
  }
  function updateShape(shapeId: number, patch: Partial<MapShape>) {
    setShapes((prev) => prev.map((s) => (s.id === shapeId ? { ...s, ...patch } : s)));
    pushSnapshot();
  }
  function deleteShape(shapeId: number) {
    setShapes((prev) => prev.filter((s) => s.id !== shapeId));
    setConnections((prev) => prev.filter((c) =>
      !(c.from_kind === 'shape' && c.from_item_id === shapeId) &&
      !(c.to_kind === 'shape' && c.to_item_id === shapeId)));
    setSelection(null);
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(`shape:${shapeId}`); return n; });
    pushSnapshot();
  }
  function shapeToFront(shapeId: number) {
    const max = shapes.reduce((m, s) => Math.max(m, Number(s.z_index) || 0), 0);
    updateShape(shapeId, { z_index: max + 1 });
  }
  function shapeToBack(shapeId: number) {
    const min = shapes.reduce((m, s) => Math.min(m, Number(s.z_index) || 0), 0);
    updateShape(shapeId, { z_index: min - 1 });
  }

  // ── Label interactions ───────────────────────────────────────
  function onLabelMouseDown(e: React.MouseEvent, l: MapLabel) {
    e.stopPropagation();
    setCtx(null);
    if (tool === 'select') {
      const key = `label:${l.id}`;
      const p = toSvg(e.clientX, e.clientY);
      if (l.locked) { selectElement('label', l.id, e.shiftKey); return; }
      if (handleGroupedMouseDown('label', l.id, p, e.shiftKey)) return;
      if (e.shiftKey) { selectElement('label', l.id, true); return; }
      if (selectedIds.size > 1 && selectedIds.has(key)) {
        setSelection({ kind: 'label', id: l.id });
        setDrag(buildMultiDrag(l.id, p));
        return;
      }
      selectElement('label', l.id, false);
      setDrag({ kind: 'label', id: l.id, dx: p.x - Number(l.x), dy: p.y - Number(l.y), moved: false });
    }
  }
  function addLabelAt(x: number, y: number) {
    const l: MapLabel = { id: nextTemp(), x, y, text: 'New label', font_size: 16, color: '#1a2744', bold: false, z_index: 0 };
    setLabels((prev) => [...prev, l]);
    setSelection({ kind: 'label', id: l.id });
    setSelectedIds(new Set([`label:${l.id}`]));
    setEditingLabel(l.id);
    pushSnapshot();
  }
  function updateLabel(labelId: number, patch: Partial<MapLabel>) {
    setLabels((prev) => prev.map((l) => (l.id === labelId ? { ...l, ...patch } : l)));
    pushSnapshot();
  }
  function deleteLabel(labelId: number) {
    setLabels((prev) => prev.filter((l) => l.id !== labelId));
    setSelection(null);
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(`label:${labelId}`); return n; });
    setEditingLabel(null);
    pushSnapshot();
  }

  function updateConnection(connId: number, patch: Partial<MapConnection>) {
    setConnections((prev) => prev.map((c) => (c.id === connId ? { ...c, ...patch } : c)));
    pushSnapshot();
  }
  function deleteConnection(connId: number) {
    setConnections((prev) => prev.filter((c) => c.id !== connId));
    setSelection(null);
    pushSnapshot();
  }
  // Begin dragging an elbow connection's bend handle (waypoint).
  function onWaypointMouseDown(e: React.MouseEvent, connId: number, index: number) {
    e.stopPropagation();
    setCtx(null);
    setDrag({ kind: 'waypoint', connId, index, moved: false });
  }
  // Remove a single bend point (double-click); drop the array entirely when empty.
  function removeWaypoint(connId: number, index: number) {
    setConnections((prev) => prev.map((c) => {
      if (c.id !== connId || !c.waypoints) return c;
      const wps = c.waypoints.filter((_, i) => i !== index);
      return { ...c, waypoints: wps.length ? wps : null };
    }));
    pushSnapshot();
  }

  // ── Canvas-level mouse handlers ──────────────────────────────
  function onCanvasMouseDown(e: React.MouseEvent) {
    setCtx(null);
    const p = toSvg(e.clientX, e.clientY);
    if (tool === 'label') { addLabelAt(p.x, p.y); return; }
    if (tool === 'line') { setLineStart(null); return; }
    // select tool: empty mousedown starts a marquee selection.
    setMarquee({ sx: p.x, sy: p.y, cx: p.x, cy: p.y });
  }

  // Snap a single dragged device/shape to nearby element anchors; record guides.
  function applyGuides(kind: 'device' | 'shape', id: number, x: number, y: number, w: number, h: number) {
    let gx: number | null = null;
    let gy: number | null = null;
    let outX = x;
    let outY = y;
    const myXs = [x, x + w / 2, x + w];
    const myYs = [y, y + h / 2, y + h];
    const others: { x: number; y: number; w: number; h: number }[] = [];
    for (const d of devices) if (!(kind === 'device' && d.id === id)) others.push({ x: Number(d.x), y: Number(d.y), w: Number(d.width), h: Number(d.height) });
    for (const s of shapes) if (!(kind === 'shape' && s.id === id)) others.push({ x: Number(s.x), y: Number(s.y), w: Number(s.width), h: Number(s.height) });
    for (const o of others) {
      const oXs = [o.x, o.x + o.w / 2, o.x + o.w];
      const oYs = [o.y, o.y + o.h / 2, o.y + o.h];
      for (let i = 0; i < 3 && gx === null; i++) {
        for (const ox of oXs) {
          if (Math.abs(myXs[i] - ox) <= GUIDE_TOL) { outX = x + (ox - myXs[i]); gx = ox; break; }
        }
      }
      for (let i = 0; i < 3 && gy === null; i++) {
        for (const oy of oYs) {
          if (Math.abs(myYs[i] - oy) <= GUIDE_TOL) { outY = y + (oy - myYs[i]); gy = oy; break; }
        }
      }
    }
    setGuide({ x: gx, y: gy });
    return { x: outX, y: outY };
  }

  function onCanvasMouseMove(e: React.MouseEvent) {
    const p = toSvg(e.clientX, e.clientY);
    if (lineStart != null) setMouse(p);
    if (marquee) { setMarquee({ ...marquee, cx: p.x, cy: p.y }); return; }
    if (!drag) return;

    if (drag.kind === 'waypoint') {
      const nx = snap(p.x);
      const ny = snap(p.y);
      setConnections((prev) => prev.map((c) => {
        if (c.id !== drag.connId) return c;
        // Seed the array from the auto-bend when this is the first bend point.
        const wps = c.waypoints && c.waypoints.length > 0 ? [...c.waypoints] : [];
        wps[drag.index] = { x: nx, y: ny };
        return { ...c, waypoints: wps };
      }));
      if (!drag.moved) setDrag({ ...drag, moved: true });
      return;
    }

    if (drag.kind === 'multi') {
      let ddx = p.x - drag.sx;
      let ddy = p.y - drag.sy;
      if (snapEnabled) { ddx = Math.round(ddx / GRID) * GRID; ddy = Math.round(ddy / GRID) * GRID; }
      const orig = drag.origins;
      setDevices((prev) => prev.map((d) => orig[`device:${d.id}`] ? { ...d, x: orig[`device:${d.id}`].x + ddx, y: orig[`device:${d.id}`].y + ddy } : d));
      setShapes((prev) => prev.map((s) => orig[`shape:${s.id}`] ? { ...s, x: orig[`shape:${s.id}`].x + ddx, y: orig[`shape:${s.id}`].y + ddy } : s));
      setLabels((prev) => prev.map((l) => orig[`label:${l.id}`] ? { ...l, x: orig[`label:${l.id}`].x + ddx, y: orig[`label:${l.id}`].y + ddy } : l));
      if (!drag.moved && (ddx !== 0 || ddy !== 0)) setDrag({ ...drag, moved: true });
      return;
    }

    if (drag.kind === 'resize') {
      const dx = p.x - drag.sx;
      const dy = p.y - drag.sy;
      const h = drag.handle;
      let { ox: nx, oy: ny, ow: nw, oh: nh } = drag;
      if (h.includes('e')) nw = drag.ow + dx;
      if (h.includes('s')) nh = drag.oh + dy;
      if (h.includes('w')) { nw = drag.ow - dx; nx = drag.ox + dx; }
      if (h.includes('n')) { nh = drag.oh - dy; ny = drag.oy + dy; }
      // Clamp to a minimum, keeping the anchored (opposite) edge fixed.
      if (nw < MIN_W) { if (h.includes('w')) nx = drag.ox + (drag.ow - MIN_W); nw = MIN_W; }
      if (nh < MIN_H) { if (h.includes('n')) ny = drag.oy + (drag.oh - MIN_H); nh = MIN_H; }
      const geo = { x: snap(nx), y: snap(ny), width: Math.round(snapEnabled ? snap(nw) : nw), height: Math.round(snapEnabled ? snap(nh) : nh) };
      if (drag.target === 'shape') {
        setShapes((prev) => prev.map((s) => (s.id === drag.id ? { ...s, ...geo } : s)));
      } else {
        setDevices((prev) => prev.map((d) => (d.id === drag.id ? { ...d, ...geo } : d)));
      }
      if (!drag.moved) setDrag({ ...drag, moved: true });
      return;
    }

    if (drag.kind === 'device') {
      let nx = snap(p.x - drag.dx);
      let ny = snap(p.y - drag.dy);
      const d0 = devices.find((d) => d.id === drag.id);
      if (d0) { const g = applyGuides('device', drag.id, nx, ny, Number(d0.width), Number(d0.height)); nx = g.x; ny = g.y; }
      setDevices((prev) => prev.map((d) => (d.id === drag.id ? { ...d, x: nx, y: ny } : d)));
      if (!drag.moved) setDrag({ ...drag, moved: true });
    } else if (drag.kind === 'shape') {
      let nx = snap(p.x - drag.dx);
      let ny = snap(p.y - drag.dy);
      const s0 = shapes.find((s) => s.id === drag.id);
      if (s0) { const g = applyGuides('shape', drag.id, nx, ny, Number(s0.width), Number(s0.height)); nx = g.x; ny = g.y; }
      setShapes((prev) => prev.map((s) => (s.id === drag.id ? { ...s, x: nx, y: ny } : s)));
      if (!drag.moved) setDrag({ ...drag, moved: true });
    } else {
      const nx = snap(p.x - drag.dx);
      const ny = snap(p.y - drag.dy);
      setLabels((prev) => prev.map((l) => (l.id === drag.id ? { ...l, x: nx, y: ny } : l)));
      if (!drag.moved) setDrag({ ...drag, moved: true });
    }
  }

  function onCanvasMouseUp() {
    if (marquee) { commitMarquee(marquee); setMarquee(null); }
    if (drag) {
      if (drag.moved) pushSnapshot();
      setDrag(null);
    }
    setGuide({ x: null, y: null });
  }

  // Select all devices/shapes/labels whose box intersects the marquee rect.
  function commitMarquee(m: NonNullable<Marquee>) {
    const minX = Math.min(m.sx, m.cx);
    const maxX = Math.max(m.sx, m.cx);
    const minY = Math.min(m.sy, m.cy);
    const maxY = Math.max(m.sy, m.cy);
    // Treat a tiny marquee (a click) as a deselect.
    if (maxX - minX < 3 && maxY - minY < 3) { setSelection(null); setSelectedIds(new Set()); return; }
    const hits = new Set<string>();
    const intersects = (b: { x: number; y: number; w: number; h: number }) =>
      b.x <= maxX && b.x + b.w >= minX && b.y <= maxY && b.y + b.h >= minY;
    for (const d of devices) if (!d.locked && intersects({ x: Number(d.x), y: Number(d.y), w: Number(d.width), h: Number(d.height) })) hits.add(`device:${d.id}`);
    for (const s of shapes) if (!s.locked && intersects({ x: Number(s.x), y: Number(s.y), w: Number(s.width), h: Number(s.height) })) hits.add(`shape:${s.id}`);
    for (const l of labels) if (!l.locked && intersects({ x: Number(l.x), y: Number(l.y) - 12, w: Math.max(20, (l.text || '').length * 7), h: 16 })) hits.add(`label:${l.id}`);
    setSelectedIds(hits);
    if (hits.size === 1) {
      const [k, idStr] = Array.from(hits)[0].split(':');
      setSelection({ kind: k as any, id: Number(idStr) });
    } else {
      setSelection(null);
    }
  }

  // ── Background image upload ──────────────────────────────────
  async function onUploadBg(file: File) {
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    try {
      await apiSend(`/api/maps/${id}/background`, 'POST', { bg_image_b64: b64 });
      setBgImage(b64);
    } catch (e: any) {
      setErr(e?.message || 'Background upload failed');
    }
  }
  async function onRemoveBg() {
    try {
      await apiSend(`/api/maps/${id}/background`, 'POST', { bg_image_b64: null });
      setBgImage(null);
    } catch (e: any) {
      setErr(e?.message || 'Failed to remove background');
    }
  }

  // ── Save ─────────────────────────────────────────────────────
  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await apiSend(`/api/maps/${id}`, 'PUT', {
        name, bg_color: bgColor, canvas_w: canvasW, canvas_h: canvasH,
      });
      const full = await apiSend<FullMap>(`/api/maps/${id}/layout`, 'PUT', {
        devices: devices.map((d) => ({
          id: d.id, device_id: d.device_id, x: d.x, y: d.y,
          label: d.label, icon_type: d.icon_type, node_style: d.node_style,
          z_index: d.z_index, width: d.width, height: d.height, locked: d.locked, group_id: d.group_id,
          drill_map_id: d.drill_map_id,
        })),
        connections: connections.map((c) => ({
          from_item_id: c.from_item_id, to_item_id: c.to_item_id,
          from_kind: c.from_kind, to_kind: c.to_kind,
          color: c.color, line_style: c.line_style, label: c.label,
          arrow: c.arrow, width: c.width, routing: c.routing,
          waypoints: c.waypoints ?? null,
          from_if_index: c.from_if_index, to_if_index: c.to_if_index, capacity_bps: c.capacity_bps,
        })),
        labels: labels.map((l) => ({
          x: l.x, y: l.y, text: l.text, font_size: l.font_size, color: l.color, bold: l.bold,
          z_index: l.z_index, locked: l.locked, group_id: l.group_id,
        })),
        shapes: shapes.map((s) => ({
          id: s.id, kind: s.kind, x: s.x, y: s.y, width: s.width, height: s.height,
          fill: s.fill, stroke: s.stroke, stroke_width: s.stroke_width,
          text: s.text, font_size: s.font_size, text_color: s.text_color,
          rotation: s.rotation, z_index: s.z_index, locked: s.locked, group_id: s.group_id,
        })),
      });
      // Re-hydrate from saved state so temp ids become real ids.
      const m = normalizeMap(full);
      setDevices(m.devices);
      setConnections(m.connections);
      setLabels(m.labels);
      setShapes(m.shapes || []);
      setSelection(null);
      setSelectedIds(new Set());
      seedHistory({ devices: m.devices, connections: m.connections, labels: m.labels, shapes: m.shapes || [] });
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2500);
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function toggleShare() {
    try {
      const r = await apiSend<{ is_public: boolean; uuid: string }>(`/api/maps/${id}/toggle-public`, 'POST', {});
      setIsPublic(r.is_public);
      const url = `${window.location.origin}/maps/public/${r.uuid}`;
      if (r.is_public) {
        try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
        setShareUrl(url);
      } else {
        setShareUrl(null);
      }
    } catch (e: any) {
      setErr(e?.message || 'Failed to toggle sharing');
    }
  }

  if (loaded.loading && !loaded.data) return <Loading />;
  if (loaded.error) return <ErrorBox message={loaded.error} />;

  const byId = new Map<number, MapDevice>();
  for (const d of devices) byId.set(d.id, d);
  const shapeById = new Map<number, MapShape>();
  for (const s of shapes) shapeById.set(s.id, s);
  // Resolve a connection endpoint (device or shape) to its node geometry.
  const endpointNode = (kind: string, itemId: number): MapNodeLike | undefined =>
    kind === 'shape' ? shapeById.get(itemId) : byId.get(itemId);
  const startDev = lineStart ? endpointNode(lineStart.kind, lineStart.id) : undefined;
  const selConn = selection?.kind === 'connection' ? connections.find((c) => c.id === selection.id) || null : null;

  const filteredPalette = (palette.data || []).filter((d) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return d.name.toLowerCase().includes(s) || (d.ip_address || '').toLowerCase().includes(s);
  });

  return (
    <div className="sv-editor">
      <EditorToolbar
        name={name} setName={setName}
        tool={tool} setTool={setTool}
        onAddShape={addShape}
        snapEnabled={snapEnabled} onToggleSnap={() => setSnapEnabled((v) => !v)}
        onUndo={undo} onRedo={redo} canUndo={canUndo} canRedo={canRedo}
        canvasW={canvasW} canvasH={canvasH}
        onCanvasSize={(w, h) => { setCanvasW(w); setCanvasH(h); }}
        onUploadBg={onUploadBg} onRemoveBg={onRemoveBg} hasBg={!!bgImage}
        onSave={save} saving={saving} savedAt={savedAt} dirty={dirty}
        onView={() => window.open(`/maps/${id}`, '_blank')}
        onShare={toggleShare} isPublic={isPublic} shareUrl={shareUrl}
      />

      {err && <ErrorBox message={err} />}

      <div className="sv-editor-body">
        <DevicePalette
          devices={filteredPalette} loading={palette.loading && !palette.data}
          search={search} setSearch={setSearch} usedDeviceIds={usedDeviceIds}
        />

        <div
          className="sv-editor-canvas"
          style={{ aspectRatio: `${canvasW} / ${canvasH}` }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const raw = e.dataTransfer.getData('application/sv-device');
            if (!raw) return;
            try {
              const pd: PaletteDevice = JSON.parse(raw);
              const p = toSvg(e.clientX, e.clientY);
              addDeviceAt(pd, p.x, p.y);
            } catch { /* ignore */ }
          }}
        >
          <svg
            ref={svgRef}
            className="sv-mapview"
            viewBox={`0 0 ${canvasW} ${canvasH}`}
            preserveAspectRatio="xMidYMid meet"
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onMouseLeave={onCanvasMouseUp}
          >
            <defs>
              <pattern id="sv-suppressed-stripe" patternUnits="userSpaceOnUse" width="8" height="8"
                patternTransform="rotate(45)">
                <rect width="8" height="8" fill="#cbd5e1" />
                <line x1="0" y1="0" x2="0" y2="8" stroke="#94a3b8" strokeWidth="3" />
              </pattern>
            </defs>

            {/* Background (covers the canvas, also the empty-click target) */}
            {bgImage ? (
              <image href={bgImage} x="0" y="0" width={canvasW} height={canvasH} preserveAspectRatio="xMidYMid slice" />
            ) : (
              <rect x="0" y="0" width={canvasW} height={canvasH} fill={bgColor} />
            )}

            {/* Snap grid (faint, behind everything else) */}
            {snapEnabled && <GridLayer w={canvasW} h={canvasH} />}

            {/* Decorative shapes (z-sorted, beneath connections/nodes) */}
            {[...shapes].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0) || a.id - b.id).map((s) => (
              <EditorShape
                key={s.id} shape={s}
                selected={selectedIds.has(`shape:${s.id}`) || (selection?.kind === 'shape' && selection.id === s.id)}
                onMouseDown={(e) => onShapeMouseDown(e, s)}
                onContext={(x, y) => setCtx({ x, y, kind: 'shape', id: s.id })}
              />
            ))}

            {connections.map((c) => (
              <EditorConnection
                key={c.id} conn={c}
                from={endpointNode(c.from_kind, c.from_item_id)} to={endpointNode(c.to_kind, c.to_item_id)}
                selected={selection?.kind === 'connection' && selection.id === c.id}
                onSelect={() => { if (tool === 'select') setSelection({ kind: 'connection', id: c.id }); }}
                onContext={(x, y) => setCtx({ x, y, kind: 'connection', id: c.id })}
              />
            ))}

            {/* Rubber-band line while drawing a connection */}
            {startDev && mouse && (
              <line
                x1={deviceCenter(startDev).cx} y1={deviceCenter(startDev).cy}
                x2={mouse.x} y2={mouse.y} stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 5"
              />
            )}

            {[...devices].sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0) || a.id - b.id).map((d) => (
              <EditorDeviceNode
                key={d.id} device={d}
                selected={selectedIds.has(`device:${d.id}`) || (selection?.kind === 'device' && selection.id === d.id)}
                isLineStart={lineStart?.kind === 'device' && lineStart.id === d.id}
                onMouseDown={(e) => onDeviceMouseDown(e, d)}
                onContext={(x, y) => setCtx({ x, y, kind: 'device', id: d.id })}
              />
            ))}

            {labels.map((l) => (
              <EditorLabel
                key={l.id} label={l}
                selected={selectedIds.has(`label:${l.id}`) || (selection?.kind === 'label' && selection.id === l.id)}
                editing={editingLabel === l.id}
                onMouseDown={(e) => onLabelMouseDown(e, l)}
                onStartEdit={() => { setSelection({ kind: 'label', id: l.id }); setEditingLabel(l.id); }}
                onChangeText={(text) => updateLabel(l.id, { text })}
                onCommit={() => {
                  setEditingLabel(null);
                  setLabels((prev) => prev.filter((x) => x.id !== l.id || x.text.trim() !== ''));
                }}
                onContext={(x, y) => setCtx({ x, y, kind: 'label', id: l.id })}
              />
            ))}

            {/* Resize handles — only for exactly one selected device/shape */}
            {tool === 'select' && selectedIds.size <= 1 && selection?.kind === 'device' && (() => {
              const d = byId.get(selection.id);
              if (!d || d.locked) return null;
              return <ResizeHandles item={d} target="device" onResizeStart={onResizeStart} />;
            })()}
            {tool === 'select' && selectedIds.size <= 1 && selection?.kind === 'shape' && (() => {
              const s = shapes.find((x) => x.id === selection.id);
              if (!s || s.locked) return null;
              return <ResizeHandles item={s} target="shape" onResizeStart={onResizeStart} />;
            })()}

            {/* Draggable bend handles for the selected elbow connection */}
            {tool === 'select' && selConn && selConn.routing === 'elbow' && (
              <WaypointHandles
                conn={selConn}
                from={endpointNode(selConn.from_kind, selConn.from_item_id)}
                to={endpointNode(selConn.to_kind, selConn.to_item_id)}
                onHandleDown={(e, i) => onWaypointMouseDown(e, selConn.id, i)}
                onHandleDblClick={(i) => removeWaypoint(selConn.id, i)}
              />
            )}

            {/* Alignment guides (single-element drag) */}
            {guide.x !== null && (
              <line x1={guide.x} y1={0} x2={guide.x} y2={canvasH} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />
            )}
            {guide.y !== null && (
              <line x1={0} y1={guide.y} x2={canvasW} y2={guide.y} stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />
            )}

            {/* Marquee selection rectangle */}
            {marquee && (
              <rect
                x={Math.min(marquee.sx, marquee.cx)} y={Math.min(marquee.sy, marquee.cy)}
                width={Math.abs(marquee.cx - marquee.sx)} height={Math.abs(marquee.cy - marquee.sy)}
                fill="rgba(59,130,246,0.08)" stroke="#3b82f6" strokeWidth={1} strokeDasharray="5 4" pointerEvents="none"
              />
            )}
          </svg>

          {ctx && (
            <ContextMenu
              ctx={ctx}
              locked={ctx.kind === 'device' ? !!devices.find((d) => d.id === ctx.id)?.locked
                : ctx.kind === 'shape' ? !!shapes.find((s) => s.id === ctx.id)?.locked
                : ctx.kind === 'label' ? !!labels.find((l) => l.id === ctx.id)?.locked : false}
              onClose={() => setCtx(null)}
              onAction={(action) => { handleCtxAction(action, ctx); setCtx(null); }}
            />
          )}

          {selectedIds.size >= 2 && (
            <FloatingAlignBar onAlign={alignSelected} onDistribute={distributeSelected} />
          )}
        </div>

        {selectedIds.size > 1 ? (
          <MultiSelectPanel
            count={selectedIds.size}
            onAlign={alignSelected}
            onDistribute={distributeSelected}
            onGroup={groupSelected}
            onUngroup={ungroupSelected}
            onDelete={deleteSelected}
          />
        ) : (
        <SelectionPanel
          selection={selection}
          device={selection?.kind === 'device' ? devices.find((d) => d.id === selection.id) || null : null}
          shape={selection?.kind === 'shape' ? shapes.find((s) => s.id === selection.id) || null : null}
          connection={selection?.kind === 'connection' ? connections.find((c) => c.id === selection.id) || null : null}
          connFromDevice={selConn && selConn.from_kind !== 'shape' ? devices.find((d) => d.id === selConn.from_item_id) || null : null}
          connToDevice={selConn && selConn.to_kind !== 'shape' ? devices.find((d) => d.id === selConn.to_item_id) || null : null}
          currentMapId={Number(id)}
          label={selection?.kind === 'label' ? labels.find((l) => l.id === selection.id) || null : null}
          onDeviceChange={updateDevice}
          onDeviceFront={deviceToFront}
          onDeviceBack={deviceToBack}
          onDeviceRemove={removeDevice}
          onShapeChange={updateShape}
          onShapeFront={shapeToFront}
          onShapeBack={shapeToBack}
          onShapeDelete={deleteShape}
          onConnChange={updateConnection}
          onConnDelete={deleteConnection}
          onLabelChange={updateLabel}
          onLabelDelete={deleteLabel}
        />
        )}
      </div>
    </div>
  );
}

// ── Snap grid backdrop (top-level component) ───────────────────
function GridLayer({ w, h }: { w: number; h: number }) {
  const step = 50; // draw lines every 50 units so the grid stays faint
  const lines: React.ReactNode[] = [];
  for (let x = step; x < w; x += step) {
    lines.push(<line key={`gx${x}`} x1={x} y1={0} x2={x} y2={h} stroke="#e2e8f0" strokeWidth={1} />);
  }
  for (let y = step; y < h; y += step) {
    lines.push(<line key={`gy${y}`} x1={0} y1={y} x2={w} y2={y} stroke="#e2e8f0" strokeWidth={1} />);
  }
  return <g pointerEvents="none">{lines}</g>;
}

// ── Multi-selection panel (align / distribute / delete) ────────
function MultiSelectPanel({
  count, onAlign, onDistribute, onGroup, onUngroup, onDelete,
}: {
  count: number;
  onAlign: (edge: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  onDistribute: (axis: 'h' | 'v') => void;
  onGroup: () => void;
  onUngroup: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="sv-editor-props">
      <h3>{count} selected</h3>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 4 }}>Align</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onAlign('left')}>Left</button>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onAlign('center')}>Center</button>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onAlign('right')}>Right</button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onAlign('top')}>Top</button>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onAlign('middle')}>Middle</button>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onAlign('bottom')}>Bottom</button>
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '8px 0 4px' }}>Distribute</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onDistribute('h')}>Horizontally</button>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onDistribute('v')}>Vertically</button>
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '8px 0 4px' }}>Group</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={onGroup} title="Ctrl+G">Group</button>
        <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={onUngroup} title="Ctrl+Shift+G">Ungroup</button>
      </div>
      <button className="sv-btn danger sm" style={{ marginTop: 8 }} onClick={onDelete}>Delete selected</button>
    </div>
  );
}

// ── Floating align/distribute toolbar (top-level component) ────
function FloatingAlignBar({ onAlign, onDistribute }: {
  onAlign: (edge: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  onDistribute: (axis: 'h' | 'v') => void;
}) {
  return (
    <div className="sv-align-bar" onMouseDown={(e) => e.stopPropagation()}>
      <button title="Align left" onClick={() => onAlign('left')}>⇤</button>
      <button title="Align centre (horizontal)" onClick={() => onAlign('center')}>⇔</button>
      <button title="Align right" onClick={() => onAlign('right')}>⇥</button>
      <span className="sep" />
      <button title="Align top" onClick={() => onAlign('top')}>⤒</button>
      <button title="Align middle (vertical)" onClick={() => onAlign('middle')}>⇳</button>
      <button title="Align bottom" onClick={() => onAlign('bottom')}>⤓</button>
      <span className="sep" />
      <button title="Distribute horizontally (3+)" onClick={() => onDistribute('h')}>⇆</button>
      <button title="Distribute vertically (3+)" onClick={() => onDistribute('v')}>⇅</button>
    </div>
  );
}

// ── Editor toolbar (top-level component) ───────────────────────
function EditorToolbar({
  name, setName, tool, setTool, onAddShape,
  snapEnabled, onToggleSnap, onUndo, onRedo, canUndo, canRedo,
  canvasW, canvasH, onCanvasSize,
  onUploadBg, onRemoveBg, hasBg, onSave, saving, savedAt, dirty, onView, onShare, isPublic, shareUrl,
}: {
  name: string; setName: (v: string) => void;
  tool: Tool; setTool: (t: Tool) => void;
  onAddShape: (kind: string) => void;
  snapEnabled: boolean; onToggleSnap: () => void;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
  canvasW: number; canvasH: number; onCanvasSize: (w: number, h: number) => void;
  onUploadBg: (f: File) => void; onRemoveBg: () => void; hasBg: boolean;
  onSave: () => void; saving: boolean; savedAt: number | null; dirty: boolean;
  onView: () => void; onShare: () => void; isPublic: boolean; shareUrl: string | null;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const presetKey = `${canvasW}x${canvasH}`;
  return (
    <div className="sv-editor-toolbar">
      <input className="sv-input sv-editor-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Map name" />

      <div className="sv-editor-tools">
        {(['select', 'line', 'label'] as Tool[]).map((t) => (
          <button key={t} className={`sv-btn ghost sm tint-slate ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)}>
            {t === 'select' ? 'Select' : t === 'line' ? 'Line' : 'Label'}
          </button>
        ))}
        <select className="sv-select sm tint-violet" value="" title="Add a shape or icon"
          onChange={(e) => { if (e.target.value) { onAddShape(e.target.value); e.target.value = ''; } }}>
          <option value="">+ Shape / Icon…</option>
          <optgroup label="Shapes">
            {BASIC_SHAPES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </optgroup>
          <optgroup label="Network icons">
            {SHAPE_GLYPHS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </optgroup>
        </select>
        <button className={`sv-btn ghost sm tint-amber ${snapEnabled ? 'on' : ''}`} onClick={onToggleSnap}
          title="Snap to grid">Snap</button>
        <button className="sv-btn ghost sm tint-blue" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)"><IconUndo width={14} height={14} style={{ verticalAlign: '-2px' }} /> Undo</button>
        <button className="sv-btn ghost sm tint-blue" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"><IconRedo width={14} height={14} style={{ verticalAlign: '-2px' }} /> Redo</button>
      </div>

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadBg(f); e.target.value = ''; }} />
      <button className="sv-btn ghost sm tint-teal" onClick={() => fileRef.current?.click()}>Upload BG</button>
      {hasBg && <button className="sv-btn ghost sm tint-red" onClick={onRemoveBg} title="Remove background"><IconTrash width={14} height={14} style={{ verticalAlign: '-2px' }} /> BG</button>}

      <select className="sv-select sm" value={presetKey}
        onChange={(e) => { const p = CANVAS_PRESETS.find((x) => x.key === e.target.value); if (p) onCanvasSize(p.w, p.h); }}>
        {CANVAS_PRESETS.every((p) => p.key !== presetKey) && <option value={presetKey}>{canvasW} × {canvasH}</option>}
        {CANVAS_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>

      <div style={{ flex: 1 }} />

      {shareUrl && <span className="sv-editor-shareurl" title={shareUrl}>{shareUrl}</span>}
      <span className={`sv-editor-dirty ${dirty ? '' : 'saved'}`}>{dirty ? '● Unsaved' : '✓ Saved'}</span>
      <button className={`sv-btn ghost sm ${isPublic ? 'tint-green on' : 'tint-blue'}`} onClick={onShare}>{isPublic ? <><IconUnlock width={14} height={14} style={{ verticalAlign: '-2px' }} /> Public</> : <><IconLock width={14} height={14} style={{ verticalAlign: '-2px' }} /> Share</>}</button>
      <button className="sv-btn ghost sm tint-violet" onClick={onView}>View Map ↗</button>
      <button className="sv-btn" onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : savedAt ? '✓ Saved' : 'Save'}
      </button>
    </div>
  );
}

// ── Device palette (top-level component) ───────────────────────
// Devices are grouped into collapsible per-site trees so the list stays
// manageable as the inventory grows. While searching, every matching group is
// forced open so results are never hidden behind a collapsed header.
function DevicePalette({
  devices, loading, search, setSearch, usedDeviceIds,
}: {
  devices: PaletteDevice[]; loading: boolean;
  search: string; setSearch: (v: string) => void; usedDeviceIds: Set<number>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Group the (already search-filtered) devices by site name, alphabetically;
  // devices with no site fall into an "Unassigned" group sorted last.
  const groupMap = new Map<string, PaletteDevice[]>();
  for (const d of devices) {
    const key = d.site_name || 'Unassigned';
    const arr = groupMap.get(key);
    if (arr) arr.push(d); else groupMap.set(key, [d]);
  }
  const groups = Array.from(groupMap.entries())
    .map(([site, items]) => ({ site, items: [...items].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => {
      if (a.site === 'Unassigned') return 1;
      if (b.site === 'Unassigned') return -1;
      return a.site.localeCompare(b.site);
    });

  const searching = search.trim().length > 0;

  function toggle(site: string) {
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(site)) n.delete(site); else n.add(site);
      return n;
    });
  }

  return (
    <div className="sv-editor-palette">
      <input className="sv-input sm" placeholder="Search devices…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="list">
        {loading ? (
          <Loading />
        ) : groups.length === 0 ? (
          <p className="sv-muted" style={{ fontSize: 'var(--text-base)', padding: '8px 4px' }}>No devices.</p>
        ) : (
          groups.map((g) => {
            const open = searching || !collapsed.has(g.site);
            const usedCount = g.items.filter((d) => usedDeviceIds.has(d.id)).length;
            return (
              <div className="pal-group" key={g.site}>
                <button
                  type="button"
                  className={`pal-group-head ${open ? 'open' : ''}`}
                  onClick={() => toggle(g.site)}
                  title={open ? 'Collapse' : 'Expand'}
                >
                  <span className="chev" aria-hidden>▸</span>
                  <span className="site">{g.site}</span>
                  <span className="count">{usedCount > 0 ? `${usedCount}/${g.items.length}` : g.items.length}</span>
                </button>
                {open && (
                  <div className="pal-group-body">
                    {g.items.map((d) => {
                      const used = usedDeviceIds.has(d.id);
                      return (
                        <div
                          key={d.id}
                          className={`pal-item ${used ? 'used' : ''}`}
                          draggable={!used}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/sv-device', JSON.stringify(d));
                            e.dataTransfer.effectAllowed = 'copy';
                          }}
                          title={used ? 'Already on this map' : 'Drag onto the canvas to add'}
                        >
                          <StatusDot status={d.current_status} size={9} />
                          <span className="nm">{d.name}</span>
                          <span className="ip">{d.ip_address}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Editor connection line (top-level component) ───────────────
function EditorConnection({
  conn, from, to, selected, onSelect, onContext,
}: {
  conn: MapConnection; from?: MapNodeLike; to?: MapNodeLike;
  selected: boolean; onSelect: () => void; onContext: (x: number, y: number) => void;
}) {
  if (!from || !to) return null;
  // Anchor to node edges (glyph box for icon nodes) so lines touch the perimeter.
  const ca = deviceCenter(from);
  const cb = deviceCenter(to);
  const a = edgePoint(nodeAnchorBox(from), cb.cx, cb.cy);
  const b = edgePoint(nodeAnchorBox(to), ca.cx, ca.cy);
  const elbow = conn.routing === 'elbow';
  const geo = elbow ? elbowPoints(a, b, conn.waypoints) : null;
  const mx = geo ? geo.mx : (a.cx + b.cx) / 2;
  const my = geo ? geo.my : (a.cy + b.cy) / 2;
  const stroke = selected ? '#3b82f6' : conn.color || DEFAULT_LINE;
  const width = Number(conn.width) || 2;
  const dash = conn.line_style === 'dashed' ? '8 6' : undefined;

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
    <g
      onMouseDown={(e) => { e.stopPropagation(); onSelect(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{ cursor: 'pointer' }}
    >
      {geo ? (
        <>
          <path d={geo.d} fill="none" stroke="transparent" strokeWidth={14} />
          <path d={geo.d} fill="none" stroke={stroke} strokeWidth={selected ? width + 1 : width} strokeDasharray={dash} />
        </>
      ) : (
        <>
          <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke="transparent" strokeWidth={14} />
          <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke={stroke}
            strokeWidth={selected ? width + 1 : width} strokeDasharray={dash} />
        </>
      )}
      {arrowPath && <path d={arrowPath} fill={stroke} />}
      {conn.label && (
        <text x={mx} y={my - 4} textAnchor="middle" fontSize={12} fill="#475569"
          style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>{conn.label}</text>
      )}
    </g>
  );
}

// ── Draggable bend handles for an elbow connection (top-level component) ──
// Shows one dot per waypoint; when there are none, shows a single grabbable dot
// at the auto-bend corner so the user can introduce the first bend by dragging.
function WaypointHandles({
  conn, from, to, onHandleDown, onHandleDblClick,
}: {
  conn: MapConnection; from?: MapNodeLike; to?: MapNodeLike;
  onHandleDown: (e: React.MouseEvent, index: number) => void;
  onHandleDblClick: (index: number) => void;
}) {
  if (!from || !to) return null;
  const ca = deviceCenter(from);
  const cb = deviceCenter(to);
  const a = edgePoint(nodeAnchorBox(from), cb.cx, cb.cy);
  const b = edgePoint(nodeAnchorBox(to), ca.cx, ca.cy);
  const pts = conn.waypoints && conn.waypoints.length > 0
    ? conn.waypoints
    : (() => { const g = elbowPoints(a, b); return [{ x: g.mx, y: g.my }]; })();
  return (
    <g>
      {pts.map((p, i) => (
        <circle
          key={i} cx={Number(p.x)} cy={Number(p.y)} r={6}
          fill="var(--primary)" stroke="#fff" strokeWidth={1.5}
          style={{ cursor: 'move' }}
          onMouseDown={(e) => onHandleDown(e, i)}
          onDoubleClick={(e) => { e.stopPropagation(); onHandleDblClick(i); }}
        />
      ))}
    </g>
  );
}

// ── Canvas marker glyphs (top-level; drawn inside SVG, so plain shapes not icon components) ──
// Gold 5-point star = gateway. Colors are literal (canvas/PNG export can't use CSS tokens).
function GatewayStar({ cx, cy, r = 7 }: { cx: number; cy: number; r?: number }) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`);
  }
  return <polygon points={pts.join(' ')} fill="#f59e0b" stroke="#fff" strokeWidth={0.75} pointerEvents="none" />;
}

// Small padlock = locked element.
function LockGlyph({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g pointerEvents="none">
      <path d={`M ${cx - 2.5} ${cy - 0.5} v -2 a 2.5 2.5 0 0 1 5 0 v 2`} fill="none" stroke="#475569" strokeWidth={1.2} />
      <rect x={cx - 4} y={cy - 0.5} width={8} height={6.5} rx={1.5} fill="#475569" stroke="#fff" strokeWidth={0.75} />
    </g>
  );
}

// ── Editor device node (top-level component) ───────────────────
function EditorDeviceNode({
  device, selected, isLineStart, onMouseDown, onContext,
}: {
  device: MapDevice; selected: boolean; isLineStart: boolean;
  onMouseDown: (e: React.MouseEvent) => void; onContext: (x: number, y: number) => void;
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
  const sel = selected || isLineStart;

  // ── Icon style: a device glyph with the label beneath it (never overflows) ──
  if (device.node_style === 'icon') {
    const glyphKind = device.icon_type && device.icon_type !== 'auto'
      ? device.icon_type : deviceGlyphFor(device.device_name);
    const gs = Math.max(24, Math.min(w, h));
    const gx = cx - gs / 2;
    const gy = y + Math.max(0, (h - gs) / 2);
    const halo = { paintOrder: 'stroke' as const, stroke: '#fff', strokeWidth: 3 };
    return (
      <g
        onMouseDown={onMouseDown}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
        style={{ cursor: 'move' }}
      >
        {sel && <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={6} fill="none"
          stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="5 4" />}
        <MapGlyph kind={glyphKind} x={gx} y={gy} size={gs} color={color} />
        {device.is_gateway && <GatewayStar cx={x + 8} cy={y + 8} />}
        <text x={cx} y={y + h + 14} textAnchor="middle" fontSize={13} fontWeight={700} fill="#1a2744" style={halo}>{name}</text>
        {ip && <text x={cx} y={y + h + 28} textAnchor="middle" fontSize={10} fill="#475569" style={halo}>{ip}</text>}
        {device.locked && <LockGlyph cx={x + w - 8} cy={y + 6} />}
      </g>
    );
  }

  // ── Box style: filled status box, label wraps inside (no edge overflow) ──
  const fill = suppressed ? 'url(#sv-suppressed-stripe)' : color;
  return (
    <g
      onMouseDown={onMouseDown}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{ cursor: 'move' }}
    >
      <rect
        x={x} y={y} width={w} height={h} rx={8} ry={8} fill={fill}
        stroke={sel ? '#3b82f6' : '#0f172a'}
        strokeOpacity={sel ? 1 : 0.15}
        strokeWidth={sel ? 2.5 : 1}
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
      {device.is_gateway && <GatewayStar cx={x + 11} cy={y + 11} />}
      {device.locked && <LockGlyph cx={x + w - 8} cy={y + 6} />}
    </g>
  );
}

// ── Resize handles for the selected element (top-level component) ───
function ResizeHandles({ item, target, onResizeStart }: {
  item: { id: number; x: number; y: number; width: number; height: number };
  target: 'device' | 'shape';
  onResizeStart: (e: React.MouseEvent, item: { id: number; x: number; y: number; width: number; height: number }, target: 'device' | 'shape', handle: string) => void;
}) {
  const x = Number(item.x), y = Number(item.y), w = Number(item.width), h = Number(item.height);
  const hs = 8;
  const pts: [string, number, number][] = [
    ['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y],
    ['e', x + w, y + h / 2], ['se', x + w, y + h], ['s', x + w / 2, y + h],
    ['sw', x, y + h], ['w', x, y + h / 2],
  ];
  const cursors: Record<string, string> = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  };
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="none" stroke="#3b82f6" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />
      {pts.map(([k, hx, hy]) => (
        <rect key={k} x={hx - hs / 2} y={hy - hs / 2} width={hs} height={hs} fill="#fff" stroke="#3b82f6" strokeWidth={1.5}
          style={{ cursor: cursors[k] }} onMouseDown={(e) => onResizeStart(e, item, target, k)} />
      ))}
    </g>
  );
}

// ── Editor decorative shape (top-level component) ──────────────
function EditorShape({
  shape, selected, onMouseDown, onContext,
}: {
  shape: MapShape; selected: boolean;
  onMouseDown: (e: React.MouseEvent) => void; onContext: (x: number, y: number) => void;
}) {
  const x = Number(shape.x), y = Number(shape.y), w = Number(shape.width), h = Number(shape.height);
  return (
    <g
      onMouseDown={onMouseDown}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{ cursor: 'move' }}
    >
      {/* Transparent hit area so thin/empty shapes (line, glyph outline) are grabbable */}
      <rect x={x} y={y} width={Math.max(w, 10)} height={Math.max(h, 10)} fill="transparent" />
      <ShapeEl shape={shape} />
      {selected && (
        <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} fill="none"
          stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="5 4" pointerEvents="none" />
      )}
      {shape.locked && <LockGlyph cx={x + w - 8} cy={y + 6} />}
    </g>
  );
}

// ── Editor label (top-level component) ─────────────────────────
function EditorLabel({
  label, selected, editing, onMouseDown, onStartEdit, onChangeText, onCommit, onContext,
}: {
  label: MapLabel; selected: boolean; editing: boolean;
  onMouseDown: (e: React.MouseEvent) => void; onStartEdit: () => void;
  onChangeText: (v: string) => void; onCommit: () => void; onContext: (x: number, y: number) => void;
}) {
  const fs = Number(label.font_size) || 14;
  if (editing) {
    return (
      <foreignObject x={Number(label.x)} y={Number(label.y) - fs} width={240} height={fs + 16}>
        <input
          autoFocus
          value={label.text}
          onChange={(e) => onChangeText(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => { if (e.key === 'Enter') onCommit(); }}
          onMouseDown={(e) => e.stopPropagation()}
          style={{ font: `${label.bold ? '700 ' : ''}${fs}px sans-serif`, color: label.color, width: '100%', border: '1px solid #3b82f6', borderRadius: 4, padding: '0 4px' }}
        />
      </foreignObject>
    );
  }
  return (
    <text
      x={Number(label.x)} y={Number(label.y)}
      fontSize={fs} fontWeight={label.bold ? 700 : 400} fill={label.color || '#1a2744'}
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{ cursor: 'move', userSelect: 'none', textDecoration: selected ? 'underline' : undefined }}
    >
      {label.text || '(empty)'}
    </text>
  );
}

// ── Right-click context menu (top-level component) ─────────────
function ContextMenu({
  ctx, locked, onClose, onAction,
}: {
  ctx: NonNullable<Ctx>; locked?: boolean; onClose: () => void; onAction: (action: string) => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  const deleteText = ctx.kind === 'device' ? 'Remove from map'
    : ctx.kind === 'connection' ? 'Delete connection'
    : ctx.kind === 'shape' ? 'Delete shape' : 'Delete label';
  const items: [string, string][] = [];
  if (ctx.kind === 'shape' || ctx.kind === 'label') items.push(['duplicate', 'Duplicate']);
  if (ctx.kind === 'device' || ctx.kind === 'shape') { items.push(['front', 'Bring to front']); items.push(['back', 'Send to back']); }
  if (ctx.kind !== 'connection') items.push(['lock', locked ? 'Unlock' : 'Lock']);
  items.push(['delete', deleteText]);
  return (
    <div className="sv-ctxmenu" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}>
      {items.map(([action, label]) => (
        <button key={action} className={action === 'delete' ? 'danger' : undefined}
          onClick={() => onAction(action)}>{label}</button>
      ))}
    </div>
  );
}

// ── Interface picker for weathermap link binding (top-level component) ──
type IfRow = { if_index: number; if_name: string; status: string | null; in_bps: number | null; out_bps: number | null };
function InterfaceSelect({ title, deviceId, value, onChange }: {
  title: string; deviceId: number | null | undefined; value: number | null; onChange: (v: number | null) => void;
}) {
  const ifs = useApi<IfRow[]>(deviceId ? `/api/devices/${deviceId}/interfaces` : null, 0);
  if (!deviceId) {
    return (
      <label className="sv-field">{title}
        <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>Unlinked node — no interfaces</span>
      </label>
    );
  }
  const rows = ifs.data || [];
  return (
    <label className="sv-field">{title}
      <select className="sv-select" value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : parseInt(e.target.value, 10))}>
        <option value="">{ifs.loading && !ifs.data ? 'Loading…' : rows.length ? '— none —' : 'No interface data'}</option>
        {rows.map((r) => (
          <option key={r.if_index} value={r.if_index}>{r.if_name}{r.status ? ` (${r.status})` : ''}</option>
        ))}
      </select>
    </label>
  );
}

// ── Live readout for a bound connection (top-level component) ──
function ConnLiveReadout({ connection }: { connection: MapConnection }) {
  const live = connLive(connection);
  if (!live.bound) {
    return <p className="sv-muted" style={{ fontSize: 'var(--text-sm)', margin: '2px 0 0' }}>Bind an interface to colour this link by live traffic.</p>;
  }
  if (live.down) {
    return <p style={{ fontSize: 'var(--text-sm)', margin: '2px 0 0', color: '#ef4444', fontWeight: 600 }}>● Link down</p>;
  }
  const color = live.pct != null ? utilColor(live.pct) : '#22c55e';
  return (
    <p style={{ fontSize: 'var(--text-sm)', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span>Live: {live.pct != null ? `${live.pct.toFixed(0)}% · ` : ''}{fmtBps(live.bps)}</span>
    </p>
  );
}

// ── Drill-down target picker (top-level component) ─────────────
// Numeric field that allows free typing (clear, partial values) and only clamps
// to [min,max] on blur / Enter — so you can actually type a multi-digit value.
function NumberField({ label, value, min, max, onCommit, style }: {
  label: string; value: number; min: number; max: number;
  onCommit: (n: number) => void; style?: React.CSSProperties;
}) {
  const [text, setText] = useState(String(Math.round(Number(value))));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(String(Math.round(Number(value)))); }, [value, editing]);
  function commit() {
    setEditing(false);
    const n = parseInt(text, 10);
    if (isNaN(n)) { setText(String(Math.round(Number(value)))); return; }
    const clamped = Math.max(min, Math.min(max, n));
    setText(String(clamped));
    onCommit(clamped);
  }
  return (
    <label className="sv-field" style={style}>{label}
      <input type="number" className="sv-input" value={text} min={min} max={max}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

function DrillMapSelect({ currentMapId, value, onChange }: {
  currentMapId: number; value: number | null; onChange: (v: number | null) => void;
}) {
  const maps = useApi<MapSummary[]>('/api/maps', 0);
  const rows = (maps.data || []).filter((m) => m.id !== currentMapId);
  return (
    <label className="sv-field">Drill-down to map
      <select className="sv-select" value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : parseInt(e.target.value, 10))}>
        <option value="">— none (opens device page) —</option>
        {rows.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
  );
}

// ── Selection properties panel (top-level component) ───────────
function SelectionPanel({
  selection, device, shape, connection, connFromDevice, connToDevice, label, currentMapId,
  onDeviceChange, onDeviceFront, onDeviceBack, onDeviceRemove,
  onShapeChange, onShapeFront, onShapeBack, onShapeDelete,
  onConnChange, onConnDelete, onLabelChange, onLabelDelete,
}: {
  selection: Selection;
  device: MapDevice | null;
  shape: MapShape | null;
  connection: MapConnection | null;
  connFromDevice: MapDevice | null;
  connToDevice: MapDevice | null;
  label: MapLabel | null;
  currentMapId: number;
  onDeviceChange: (id: number, patch: Partial<MapDevice>) => void;
  onDeviceFront: (id: number) => void;
  onDeviceBack: (id: number) => void;
  onDeviceRemove: (id: number) => void;
  onShapeChange: (id: number, patch: Partial<MapShape>) => void;
  onShapeFront: (id: number) => void;
  onShapeBack: (id: number) => void;
  onShapeDelete: (id: number) => void;
  onConnChange: (id: number, patch: Partial<MapConnection>) => void;
  onConnDelete: (id: number) => void;
  onLabelChange: (id: number, patch: Partial<MapLabel>) => void;
  onLabelDelete: (id: number) => void;
}) {
  if (selection?.kind === 'shape' && shape) {
    const hasFill = !['line', 'arrow'].includes(shape.kind);
    const hasText = ['text', 'zone'].includes(shape.kind);
    return (
      <div className="sv-editor-props">
        <h3>{(SHAPE_GLYPHS.find((g) => g.key === shape.kind) || BASIC_SHAPES.find((b) => b.key === shape.kind))?.label || 'Shape'}</h3>
        {hasFill && (
          <label className="sv-field">Fill
            <input type="color" className="sv-input" value={normalizeColor(shape.fill) || '#dbeafe'}
              onChange={(e) => onShapeChange(shape.id, { fill: e.target.value })} style={{ height: 36, padding: 3 }} />
          </label>
        )}
        <label className="sv-field">Line color
          <input type="color" className="sv-input" value={normalizeColor(shape.stroke) || '#334155'}
            onChange={(e) => onShapeChange(shape.id, { stroke: e.target.value })} style={{ height: 36, padding: 3 }} />
        </label>
        <NumberField label="Line width" value={Number(shape.stroke_width) || 2} min={1} max={12}
          onCommit={(n) => onShapeChange(shape.id, { stroke_width: n })} />
        {hasFill && !hasText && (
          <button className="sv-btn ghost sm" onClick={() => onShapeChange(shape.id, { fill: null })}>Clear fill</button>
        )}
        {hasText && (
          <>
            <label className="sv-field">Text
              <input className="sv-input" value={shape.text || ''}
                onChange={(e) => onShapeChange(shape.id, { text: e.target.value })} />
            </label>
            <NumberField label="Text size" value={Number(shape.font_size) || 14} min={8} max={72}
              onCommit={(n) => onShapeChange(shape.id, { font_size: n })} />
            <label className="sv-field">Text color
              <input type="color" className="sv-input" value={normalizeColor(shape.text_color) || '#1a2744'}
                onChange={(e) => onShapeChange(shape.id, { text_color: e.target.value })} style={{ height: 36, padding: 3 }} />
            </label>
          </>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onShapeFront(shape.id)}>Bring to front</button>
          <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onShapeBack(shape.id)}>Send to back</button>
        </div>
        <button className="sv-btn ghost sm" onClick={() => onShapeDelete(shape.id)}>Delete shape</button>
      </div>
    );
  }
  if (selection?.kind === 'device' && device) {
    const effectiveGlyph = device.icon_type && device.icon_type !== 'auto'
      ? device.icon_type : deviceGlyphFor(device.device_name);
    return (
      <div className="sv-editor-props">
        <h3>{device.device_name || 'Device'}</h3>
        <label className="sv-field">Style
          <select className="sv-select" value={device.node_style || 'box'}
            onChange={(e) => onDeviceChange(device.id, { node_style: e.target.value })}>
            <option value="box">Box (status fill)</option>
            <option value="icon">Icon (glyph + label)</option>
          </select>
        </label>
        <label className="sv-field">Icon
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select className="sv-select" style={{ flex: 1 }} value={device.icon_type || 'auto'}
              onChange={(e) => onDeviceChange(device.id, { icon_type: e.target.value })}>
              {DEVICE_GLYPHS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
            </select>
            <GlyphSwatch kind={effectiveGlyph} size={24} />
          </span>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <NumberField label="Width" value={Number(device.width)} min={MIN_W} max={600} style={{ flex: 1 }}
            onCommit={(n) => onDeviceChange(device.id, { width: n })} />
          <NumberField label="Height" value={Number(device.height)} min={MIN_H} max={600} style={{ flex: 1 }}
            onCommit={(n) => onDeviceChange(device.id, { height: n })} />
        </div>
        <DrillMapSelect currentMapId={currentMapId} value={device.drill_map_id ?? null}
          onChange={(v) => onDeviceChange(device.id, { drill_map_id: v })} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onDeviceFront(device.id)}>Bring to front</button>
          <button className="sv-btn ghost sm" style={{ flex: 1 }} onClick={() => onDeviceBack(device.id)}>Send to back</button>
        </div>
        <button className="sv-btn ghost sm" onClick={() => onDeviceRemove(device.id)}>Remove from map</button>
      </div>
    );
  }
  if (selection?.kind === 'connection' && connection) {
    return (
      <div className="sv-editor-props">
        <h3>Connection</h3>
        <label className="sv-field">Color
          <input type="color" className="sv-input" value={connection.color || DEFAULT_LINE}
            onChange={(e) => onConnChange(connection.id, { color: e.target.value })} style={{ height: 36, padding: 3 }} />
        </label>
        <label className="sv-field">Style
          <select className="sv-select" value={connection.line_style}
            onChange={(e) => onConnChange(connection.id, { line_style: e.target.value })}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
          </select>
        </label>
        <label className="sv-field">Routing
          <select className="sv-select" value={connection.routing || 'straight'}
            onChange={(e) => onConnChange(connection.id, { routing: e.target.value })}>
            <option value="straight">Straight</option>
            <option value="elbow">Elbow (orthogonal)</option>
          </select>
        </label>
        {connection.routing === 'elbow' && (
          <button className="sv-btn ghost sm" onClick={() => onConnChange(connection.id, { waypoints: null })}>
            Reset bends
          </button>
        )}
        <NumberField label="Width" value={Number(connection.width) || 2} min={1} max={12}
          onCommit={(n) => onConnChange(connection.id, { width: n })} />
        <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={!!connection.arrow}
            onChange={(e) => onConnChange(connection.id, { arrow: e.target.checked })} />
          Arrow
        </label>
        <label className="sv-field">Label
          <input className="sv-input" value={connection.label || ''}
            onChange={(e) => onConnChange(connection.id, { label: e.target.value })} placeholder="Optional" />
        </label>

        <div className="sv-field-group">
          <div className="sv-field-group-title">Live link (weathermap)</div>
          <InterfaceSelect title={`${connFromDevice?.device_name || 'From'} interface`}
            deviceId={connFromDevice?.device_id}
            value={connection.from_if_index}
            onChange={(v) => onConnChange(connection.id, { from_if_index: v })} />
          <InterfaceSelect title={`${connToDevice?.device_name || 'To'} interface`}
            deviceId={connToDevice?.device_id}
            value={connection.to_if_index}
            onChange={(v) => onConnChange(connection.id, { to_if_index: v })} />
          <label className="sv-field">Capacity (Mbps)
            <input type="number" className="sv-input" min={0} step={1}
              value={connection.capacity_bps == null ? '' : Math.round(Number(connection.capacity_bps) / 1_000_000)}
              placeholder="e.g. 1000"
              onChange={(e) => {
                const mbps = parseFloat(e.target.value);
                onConnChange(connection.id, { capacity_bps: isFinite(mbps) && mbps > 0 ? Math.round(mbps * 1_000_000) : null });
              }} />
          </label>
          <ConnLiveReadout connection={connection} />
        </div>

        <button className="sv-btn ghost sm" onClick={() => onConnDelete(connection.id)}>Delete connection</button>
      </div>
    );
  }
  if (selection?.kind === 'label' && label) {
    return (
      <div className="sv-editor-props">
        <h3>Label</h3>
        <label className="sv-field">Text
          <input className="sv-input" value={label.text}
            onChange={(e) => onLabelChange(label.id, { text: e.target.value })} />
        </label>
        <NumberField label="Font size" value={Number(label.font_size) || 14} min={8} max={72}
          onCommit={(n) => onLabelChange(label.id, { font_size: n })} />
        <label className="sv-field">Color
          <input type="color" className="sv-input" value={label.color || '#1a2744'}
            onChange={(e) => onLabelChange(label.id, { color: e.target.value })} style={{ height: 36, padding: 3 }} />
        </label>
        <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={label.bold} onChange={(e) => onLabelChange(label.id, { bold: e.target.checked })} />
          Bold
        </label>
        <button className="sv-btn ghost sm" onClick={() => onLabelDelete(label.id)}>Delete label</button>
      </div>
    );
  }
  return (
    <div className="sv-editor-props muted">
      <p className="sv-muted" style={{ fontSize: 'var(--text-base)' }}>
        Select a connection or label to edit its properties. Drag devices from the palette onto the canvas.
      </p>
    </div>
  );
}

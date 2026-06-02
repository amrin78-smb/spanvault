'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useApi, apiGet, apiSend } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { Loading, ErrorBox } from '@/components/ui';
import {
  type FullMap, type MapDevice, type MapConnection, type MapLabel,
  statusFill, deviceCenter, normalizeMap,
} from '@/lib/mapTypes';

const DEFAULT_LINE = '#94a3b8';
const CANVAS_PRESETS = [
  { key: '1600x900', label: 'HD — 1600 × 900', w: 1600, h: 900 },
  { key: '1920x1080', label: 'FHD — 1920 × 1080', w: 1920, h: 1080 },
  { key: '1200x1200', label: 'Square — 1200 × 1200', w: 1200, h: 1200 },
];

type Tool = 'select' | 'line' | 'label';
type PaletteDevice = {
  id: number; name: string; ip_address: string;
  current_status: string; site_name: string | null;
};
type Selection =
  | { kind: 'device'; id: number }
  | { kind: 'connection'; id: number }
  | { kind: 'label'; id: number }
  | null;
type Ctx = { x: number; y: number; kind: 'device' | 'connection' | 'label'; id: number } | null;
type Drag = { kind: 'device' | 'label'; id: number; dx: number; dy: number } | null;

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

  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [ctx, setCtx] = useState<Ctx>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [lineStart, setLineStart] = useState<number | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const [editingLabel, setEditingLabel] = useState<number | null>(null);

  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const tempId = useRef(-1);
  const nextTemp = () => { tempId.current -= 1; return tempId.current; };

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
  }, [loaded.data]);

  // ESC cancels an in-progress connection / context menu / label edit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setLineStart(null); setCtx(null); setEditingLabel(null); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // ── Device interactions ──────────────────────────────────────
  function onDeviceMouseDown(e: React.MouseEvent, d: MapDevice) {
    e.stopPropagation();
    setCtx(null);
    if (tool === 'select') {
      setSelection({ kind: 'device', id: d.id });
      const p = toSvg(e.clientX, e.clientY);
      setDrag({ kind: 'device', id: d.id, dx: p.x - Number(d.x), dy: p.y - Number(d.y) });
    } else if (tool === 'line') {
      if (lineStart == null) {
        setLineStart(d.id);
      } else if (lineStart !== d.id) {
        addConnection(lineStart, d.id);
        setLineStart(null);
      }
    }
  }

  function addConnection(from: number, to: number) {
    if (connections.some((c) =>
      (c.from_item_id === from && c.to_item_id === to) ||
      (c.from_item_id === to && c.to_item_id === from))) return;
    const c: MapConnection = {
      id: nextTemp(), from_item_id: from, to_item_id: to,
      color: DEFAULT_LINE, line_style: 'solid', label: null,
    };
    setConnections((prev) => [...prev, c]);
  }

  function addDeviceAt(pd: PaletteDevice, x: number, y: number) {
    if (usedDeviceIds.has(pd.id)) return;
    const w = 120, h = 60;
    const d: MapDevice = {
      id: nextTemp(), device_id: pd.id, x: x - w / 2, y: y - h / 2,
      label: null, icon_type: 'circle', width: w, height: h,
      device_name: pd.name, ip_address: pd.ip_address, site_name: pd.site_name,
      current_status: pd.current_status, is_gateway: false, alert_suppressed: false,
    };
    setDevices((prev) => [...prev, d]);
  }

  function removeDevice(deviceId: number) {
    setDevices((prev) => prev.filter((d) => d.id !== deviceId));
    setConnections((prev) => prev.filter((c) => c.from_item_id !== deviceId && c.to_item_id !== deviceId));
    setSelection(null);
  }

  // ── Label interactions ───────────────────────────────────────
  function onLabelMouseDown(e: React.MouseEvent, l: MapLabel) {
    e.stopPropagation();
    setCtx(null);
    if (tool === 'select') {
      setSelection({ kind: 'label', id: l.id });
      const p = toSvg(e.clientX, e.clientY);
      setDrag({ kind: 'label', id: l.id, dx: p.x - Number(l.x), dy: p.y - Number(l.y) });
    }
  }
  function addLabelAt(x: number, y: number) {
    const l: MapLabel = { id: nextTemp(), x, y, text: 'New label', font_size: 16, color: '#1a2744', bold: false };
    setLabels((prev) => [...prev, l]);
    setSelection({ kind: 'label', id: l.id });
    setEditingLabel(l.id);
  }
  function updateLabel(labelId: number, patch: Partial<MapLabel>) {
    setLabels((prev) => prev.map((l) => (l.id === labelId ? { ...l, ...patch } : l)));
  }
  function deleteLabel(labelId: number) {
    setLabels((prev) => prev.filter((l) => l.id !== labelId));
    setSelection(null);
    setEditingLabel(null);
  }

  function updateConnection(connId: number, patch: Partial<MapConnection>) {
    setConnections((prev) => prev.map((c) => (c.id === connId ? { ...c, ...patch } : c)));
  }
  function deleteConnection(connId: number) {
    setConnections((prev) => prev.filter((c) => c.id !== connId));
    setSelection(null);
  }

  // ── Canvas-level mouse handlers ──────────────────────────────
  function onCanvasMouseDown(e: React.MouseEvent) {
    setCtx(null);
    const p = toSvg(e.clientX, e.clientY);
    if (tool === 'label') { addLabelAt(p.x, p.y); return; }
    if (tool === 'line') { setLineStart(null); return; }
    setSelection(null); // select tool: click empty → deselect
  }
  function onCanvasMouseMove(e: React.MouseEvent) {
    const p = toSvg(e.clientX, e.clientY);
    if (lineStart != null) setMouse(p);
    if (!drag) return;
    if (drag.kind === 'device') {
      setDevices((prev) => prev.map((d) => (d.id === drag.id ? { ...d, x: p.x - drag.dx, y: p.y - drag.dy } : d)));
    } else {
      setLabels((prev) => prev.map((l) => (l.id === drag.id ? { ...l, x: p.x - drag.dx, y: p.y - drag.dy } : l)));
    }
  }
  function onCanvasMouseUp() { setDrag(null); }

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
          label: d.label, icon_type: d.icon_type, width: d.width, height: d.height,
        })),
        connections: connections.map((c) => ({
          from_item_id: c.from_item_id, to_item_id: c.to_item_id,
          color: c.color, line_style: c.line_style, label: c.label,
        })),
        labels: labels.map((l) => ({
          x: l.x, y: l.y, text: l.text, font_size: l.font_size, color: l.color, bold: l.bold,
        })),
      });
      // Re-hydrate from saved state so temp ids become real ids.
      const m = normalizeMap(full);
      setDevices(m.devices);
      setConnections(m.connections);
      setLabels(m.labels);
      setSelection(null);
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
  const startDev = lineStart != null ? byId.get(lineStart) : undefined;

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
        canvasW={canvasW} canvasH={canvasH}
        onCanvasSize={(w, h) => { setCanvasW(w); setCanvasH(h); }}
        onUploadBg={onUploadBg} onRemoveBg={onRemoveBg} hasBg={!!bgImage}
        onSave={save} saving={saving} savedAt={savedAt}
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

            {connections.map((c) => (
              <EditorConnection
                key={c.id} conn={c} from={byId.get(c.from_item_id)} to={byId.get(c.to_item_id)}
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

            {devices.map((d) => (
              <EditorDeviceNode
                key={d.id} device={d}
                selected={selection?.kind === 'device' && selection.id === d.id}
                isLineStart={lineStart === d.id}
                onMouseDown={(e) => onDeviceMouseDown(e, d)}
                onContext={(x, y) => setCtx({ x, y, kind: 'device', id: d.id })}
              />
            ))}

            {labels.map((l) => (
              <EditorLabel
                key={l.id} label={l}
                selected={selection?.kind === 'label' && selection.id === l.id}
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
          </svg>

          {ctx && (
            <ContextMenu
              ctx={ctx}
              onClose={() => setCtx(null)}
              onAction={() => {
                if (ctx.kind === 'device') removeDevice(ctx.id);
                else if (ctx.kind === 'connection') deleteConnection(ctx.id);
                else deleteLabel(ctx.id);
                setCtx(null);
              }}
            />
          )}
        </div>

        <SelectionPanel
          selection={selection}
          connection={selection?.kind === 'connection' ? connections.find((c) => c.id === selection.id) || null : null}
          label={selection?.kind === 'label' ? labels.find((l) => l.id === selection.id) || null : null}
          onConnChange={updateConnection}
          onConnDelete={deleteConnection}
          onLabelChange={updateLabel}
          onLabelDelete={deleteLabel}
        />
      </div>
    </div>
  );
}

// ── Editor toolbar (top-level component) ───────────────────────
function EditorToolbar({
  name, setName, tool, setTool, canvasW, canvasH, onCanvasSize,
  onUploadBg, onRemoveBg, hasBg, onSave, saving, savedAt, onView, onShare, isPublic, shareUrl,
}: {
  name: string; setName: (v: string) => void;
  tool: Tool; setTool: (t: Tool) => void;
  canvasW: number; canvasH: number; onCanvasSize: (w: number, h: number) => void;
  onUploadBg: (f: File) => void; onRemoveBg: () => void; hasBg: boolean;
  onSave: () => void; saving: boolean; savedAt: number | null;
  onView: () => void; onShare: () => void; isPublic: boolean; shareUrl: string | null;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const presetKey = `${canvasW}x${canvasH}`;
  return (
    <div className="sv-editor-toolbar">
      <input className="sv-input sv-editor-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Map name" />

      <div className="sv-editor-tools">
        {(['select', 'line', 'label'] as Tool[]).map((t) => (
          <button key={t} className={`sv-btn ghost sm ${tool === t ? 'active' : ''}`} onClick={() => setTool(t)}>
            {t === 'select' ? 'Select' : t === 'line' ? 'Line' : 'Label'}
          </button>
        ))}
      </div>

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadBg(f); e.target.value = ''; }} />
      <button className="sv-btn ghost sm" onClick={() => fileRef.current?.click()}>Upload BG</button>
      {hasBg && <button className="sv-btn ghost sm" onClick={onRemoveBg} title="Remove background">🗑 BG</button>}

      <select className="sv-select sm" value={presetKey}
        onChange={(e) => { const p = CANVAS_PRESETS.find((x) => x.key === e.target.value); if (p) onCanvasSize(p.w, p.h); }}>
        {CANVAS_PRESETS.every((p) => p.key !== presetKey) && <option value={presetKey}>{canvasW} × {canvasH}</option>}
        {CANVAS_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>

      <div style={{ flex: 1 }} />

      {shareUrl && <span className="sv-editor-shareurl" title={shareUrl}>{shareUrl}</span>}
      <button className="sv-btn ghost sm" onClick={onShare}>{isPublic ? '🔓 Public' : '🔒 Share'}</button>
      <button className="sv-btn ghost sm" onClick={onView}>View Map ↗</button>
      <button className="sv-btn" onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : savedAt ? '✓ Saved' : 'Save'}
      </button>
    </div>
  );
}

// ── Device palette (top-level component) ───────────────────────
function DevicePalette({
  devices, loading, search, setSearch, usedDeviceIds,
}: {
  devices: PaletteDevice[]; loading: boolean;
  search: string; setSearch: (v: string) => void; usedDeviceIds: Set<number>;
}) {
  return (
    <div className="sv-editor-palette">
      <input className="sv-input sm" placeholder="Search devices…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="list">
        {loading ? (
          <Loading />
        ) : devices.length === 0 ? (
          <p className="sv-muted" style={{ fontSize: 13, padding: '8px 4px' }}>No devices.</p>
        ) : (
          devices.map((d) => {
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
  conn: MapConnection; from?: MapDevice; to?: MapDevice;
  selected: boolean; onSelect: () => void; onContext: (x: number, y: number) => void;
}) {
  if (!from || !to) return null;
  const a = deviceCenter(from);
  const b = deviceCenter(to);
  const mx = (a.cx + b.cx) / 2;
  const my = (a.cy + b.cy) / 2;
  return (
    <g
      onMouseDown={(e) => { e.stopPropagation(); onSelect(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{ cursor: 'pointer' }}
    >
      {/* Wide invisible hit area */}
      <line x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} stroke="transparent" strokeWidth={14} />
      <line
        x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy}
        stroke={selected ? '#3b82f6' : conn.color || DEFAULT_LINE}
        strokeWidth={selected ? 3 : 2}
        strokeDasharray={conn.line_style === 'dashed' ? '8 6' : undefined}
      />
      {conn.label && (
        <text x={mx} y={my - 4} textAnchor="middle" fontSize={12} fill="#475569"
          style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>{conn.label}</text>
      )}
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
  const { cx, cy } = deviceCenter(device);
  const w = Number(device.width);
  const h = Number(device.height);
  const fill = suppressed ? 'url(#sv-suppressed-stripe)' : statusFill(status, false);
  return (
    <g
      onMouseDown={onMouseDown}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{ cursor: 'move' }}
    >
      <rect
        x={device.x} y={device.y} width={w} height={h} rx={8} ry={8} fill={fill}
        stroke={selected || isLineStart ? '#3b82f6' : '#0f172a'}
        strokeOpacity={selected || isLineStart ? 1 : 0.15}
        strokeWidth={selected || isLineStart ? 2.5 : 1}
      />
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize={13} fontWeight={700} fill="#fff">
        {name.length > 18 ? name.slice(0, 17) + '…' : name}
      </text>
      {ip && <text x={cx} y={cy + 14} textAnchor="middle" fontSize={10} fill="#fff" fillOpacity={0.85}>{ip}</text>}
      {device.is_gateway && <text x={device.x + 5} y={device.y + 16} fontSize={14}>⭐</text>}
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
  ctx, onClose, onAction,
}: {
  ctx: NonNullable<Ctx>; onClose: () => void; onAction: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [onClose]);
  const labelText = ctx.kind === 'device' ? 'Remove from map'
    : ctx.kind === 'connection' ? 'Delete connection' : 'Delete label';
  return (
    <div className="sv-ctxmenu" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}>
      <button onClick={onAction}>{labelText}</button>
    </div>
  );
}

// ── Selection properties panel (top-level component) ───────────
function SelectionPanel({
  selection, connection, label, onConnChange, onConnDelete, onLabelChange, onLabelDelete,
}: {
  selection: Selection;
  connection: MapConnection | null; label: MapLabel | null;
  onConnChange: (id: number, patch: Partial<MapConnection>) => void;
  onConnDelete: (id: number) => void;
  onLabelChange: (id: number, patch: Partial<MapLabel>) => void;
  onLabelDelete: (id: number) => void;
}) {
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
        <label className="sv-field">Label
          <input className="sv-input" value={connection.label || ''}
            onChange={(e) => onConnChange(connection.id, { label: e.target.value })} placeholder="Optional" />
        </label>
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
        <label className="sv-field">Font size
          <input type="number" className="sv-input" value={label.font_size} min={8} max={72}
            onChange={(e) => onLabelChange(label.id, { font_size: parseInt(e.target.value, 10) || 14 })} />
        </label>
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
      <p className="sv-muted" style={{ fontSize: 13 }}>
        Select a connection or label to edit its properties. Drag devices from the palette onto the canvas.
      </p>
    </div>
  );
}

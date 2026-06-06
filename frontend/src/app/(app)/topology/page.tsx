'use client';

import { useMemo, useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, fmtRel, fmtTime } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import SVGMapView from '@/components/SVGMapView';
import { type FullMap, type MapDevice, type MapConnection } from '@/lib/mapTypes';

// ── API response types ─────────────────────────────────────────
interface TopologyStatus {
  last_run_at: string | null;
  links_found: number;
  devices_discovered: number;
}

interface TopologyMapNode {
  device_id: number;
  name: string;
  ip: string;
  site_name: string | null;
  status: string;
  is_gateway: boolean;
}

interface TopologyMapEdge {
  from_device_id: number;
  to_device_id: number;
  from_port: string | null;
  to_port: string | null;
  protocol: 'lldp' | 'cdp';
}

interface TopologyMap {
  nodes: TopologyMapNode[];
  edges: TopologyMapEdge[];
}

interface TopologyLink {
  id: number;
  from_device_id: number;
  from_device_name: string;
  from_ip: string;
  from_site: string | null;
  from_port: string | null;
  to_device_id: number | null;
  to_device_name: string | null;
  to_ip: string | null;
  to_site: string | null;
  to_name: string | null;
  to_port: string | null;
  protocol: string;
  last_seen_at: string;
}

interface MapOption {
  id: number;
  name: string;
}

interface DependencySuggestion {
  device_id: number;
  name: string;
  reason: string;
  confidence: number;
}

type SortKey = 'from' | 'from_port' | 'to' | 'to_port' | 'protocol' | 'last_seen';
type SortDir = 'asc' | 'desc';

// ── Layout: synthetic force-directed-ish ring placement ────────
const NODE_W = 120;
const NODE_H = 60;
const CANVAS_W = 1600;
const CANVAS_H = 900;
const CENTER_X = 800;
const CENTER_Y = 450;
const RING_RADII = [220, 360, 500, 640, 780];
const PER_RING = 10;

function buildFullMap(tmap: TopologyMap): FullMap {
  // Only nodes that appear in at least one edge.
  const connectedIds = new Set<number>();
  for (const e of tmap.edges) {
    connectedIds.add(e.from_device_id);
    connectedIds.add(e.to_device_id);
  }
  const nodes = tmap.nodes.filter((n: TopologyMapNode) => connectedIds.has(n.device_id));

  // Degree per node.
  const degree = new Map<number, number>();
  for (const n of nodes) degree.set(n.device_id, 0);
  for (const e of tmap.edges) {
    if (degree.has(e.from_device_id)) degree.set(e.from_device_id, (degree.get(e.from_device_id) || 0) + 1);
    if (degree.has(e.to_device_id)) degree.set(e.to_device_id, (degree.get(e.to_device_id) || 0) + 1);
  }

  // Highest degree first.
  const ordered = [...nodes].sort(
    (a: TopologyMapNode, b: TopologyMapNode) =>
      (degree.get(b.device_id) || 0) - (degree.get(a.device_id) || 0)
  );

  const pos = new Map<number, { x: number; y: number }>();
  if (ordered.length > 0) {
    // Center node = most connected.
    const center = ordered[0];
    pos.set(center.device_id, { x: CENTER_X - NODE_W / 2, y: CENTER_Y - NODE_H / 2 });

    const rest = ordered.slice(1);
    for (let idx = 0; idx < rest.length; idx++) {
      const ring = Math.floor(idx / PER_RING);
      const radius =
        ring < RING_RADII.length
          ? RING_RADII[ring]
          : RING_RADII[RING_RADII.length - 1] + (ring - RING_RADII.length + 1) * 140;
      const onThisRing = Math.min(PER_RING, rest.length - ring * PER_RING);
      const within = idx - ring * PER_RING;
      const angle = (within / Math.max(1, onThisRing)) * Math.PI * 2 - Math.PI / 2;
      const cx = CENTER_X + radius * Math.cos(angle);
      const cy = CENTER_Y + radius * Math.sin(angle);
      pos.set(rest[idx].device_id, { x: cx - NODE_W / 2, y: cy - NODE_H / 2 });
    }
  }

  const devices: MapDevice[] = nodes.map((n: TopologyMapNode) => {
    const p = pos.get(n.device_id) || { x: CENTER_X - NODE_W / 2, y: CENTER_Y - NODE_H / 2 };
    return {
      id: n.device_id,
      device_id: n.device_id,
      x: p.x,
      y: p.y,
      label: n.name,
      icon_type: 'circle',
      width: NODE_W,
      height: NODE_H,
      device_name: n.name,
      ip_address: n.ip,
      site_name: n.site_name,
      current_status: n.status,
      is_gateway: n.is_gateway,
    };
  });

  let cid = 1;
  const connections: MapConnection[] = tmap.edges.map((e: TopologyMapEdge) => ({
    id: cid++,
    from_item_id: e.from_device_id,
    to_item_id: e.to_device_id,
    color: e.protocol === 'cdp' ? '#f97316' : '#2563eb',
    line_style: 'solid',
    label: [e.from_port, e.to_port].filter(Boolean).join(' → '),
  }));

  return {
    id: 0,
    uuid: 'topology',
    name: 'Network Topology',
    description: null,
    bg_color: '#f8fafc',
    bg_image_b64: null,
    canvas_w: CANVAS_W,
    canvas_h: CANVAS_H,
    is_public: false,
    created_at: '',
    updated_at: '',
    devices,
    connections,
    labels: [],
  };
}

// ── CSV export helpers ─────────────────────────────────────────
function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportLinksCsv(rows: TopologyLink[]): void {
  const header = ['From Device', 'From IP', 'From Port', 'To Device', 'To IP', 'To Port', 'Protocol', 'Last Seen'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      csvCell(r.from_device_name),
      csvCell(r.from_ip),
      csvCell(r.from_port),
      csvCell(r.to_device_id ? r.to_device_name : (r.to_name || r.to_ip || 'Unknown')),
      csvCell(r.to_ip),
      csvCell(r.to_port),
      csvCell(r.protocol),
      csvCell(r.last_seen_at),
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'topology-links.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════════════════
// Page
// ════════════════════════════════════════════════════════════
export default function TopologyPage() {
  const { canEdit } = useRbac();
  const [tab, setTab] = useState<'map' | 'links'>('map');
  const status = useApi<TopologyStatus>('/api/topology/status', 0);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<React.ReactNode | null>(null);

  function flash(node: React.ReactNode) {
    setToast(node);
    setTimeout(() => setToast(null), 6000);
  }

  async function runDiscovery() {
    setRunning(true);
    try {
      await apiSend('/api/topology/discover', 'POST', {});
      await new Promise((r) => setTimeout(r, 1500));
      await status.reload();
      flash('Discovery started — results will update shortly.');
    } catch (e: any) {
      flash(e?.message || 'Failed to start discovery');
    } finally {
      setRunning(false);
    }
  }

  const last = status.data;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="sv-page-title" style={{ margin: 0 }}>Network Topology</h1>
        <div style={{ flex: 1 }} />
        {canEdit && (
          <button className="sv-btn" onClick={runDiscovery} disabled={running}>
            {running ? 'Running…' : 'Run Discovery'}
          </button>
        )}
      </div>
      <p className="sv-page-sub">Auto-discovered device connections via LLDP and CDP.</p>

      {last && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          Last run: {fmtRel(last.last_run_at)} · {last.links_found} link{last.links_found === 1 ? '' : 's'} · {last.devices_discovered} device{last.devices_discovered === 1 ? '' : 's'}
        </div>
      )}

      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}
      {status.error && <ErrorBox message={status.error} />}

      <div className="sv-tabs">
        <button className={`sv-tab ${tab === 'map' ? 'active' : ''}`} onClick={() => setTab('map')}>
          Visual Map
        </button>
        <button className={`sv-tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>
          Link Table
        </button>
      </div>

      {tab === 'map' ? <MapTab canEdit={canEdit} flash={flash} /> : <LinkTable canEdit={canEdit} flash={flash} />}
    </div>
  );
}

// ── Tab 1: Visual Map (top-level component) ────────────────────
function MapTab({
  canEdit,
  flash,
}: {
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const tmap = useApi<TopologyMap>('/api/topology/map', 0);
  const maps = useApi<MapOption[]>('/api/maps', 0);
  const [showApply, setShowApply] = useState(false);
  const [suggestions, setSuggestions] = useState<DependencySuggestion[] | null>(null);
  const [applyingDeps, setApplyingDeps] = useState(false);

  const fullMap = useMemo<FullMap | null>(() => {
    if (!tmap.data) return null;
    return buildFullMap(tmap.data);
  }, [tmap.data]);

  async function applyDependencies() {
    setApplyingDeps(true);
    try {
      const r = await apiSend<{ suggestions: DependencySuggestion[] }>('/api/topology/apply-dependencies', 'POST', {});
      setSuggestions(r.suggestions || []);
    } catch (e: any) {
      flash(e?.message || 'Failed to compute dependencies');
    } finally {
      setApplyingDeps(false);
    }
  }

  if (tmap.loading && !tmap.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (tmap.error) {
    return <ErrorBox message={tmap.error} />;
  }

  const hasGraph = !!fullMap && fullMap.devices.length > 0 && fullMap.connections.length > 0;

  return (
    <div>
      <div className="sv-panel" style={{ padding: 12 }}>
        {hasGraph ? (
          <div style={{ width: '100%', height: 620, background: '#f8fafc', borderRadius: 8, overflow: 'hidden' }}>
            <SVGMapView map={fullMap as FullMap} interactive />
          </div>
        ) : (
          <Empty message="No topology discovered yet. Run discovery to map device connections." />
        )}
      </div>

      {hasGraph && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 10, fontSize: 13, color: 'var(--text-muted)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 22, height: 3, background: '#2563eb', borderRadius: 2 }} />
            LLDP
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 22, height: 3, background: '#f97316', borderRadius: 2 }} />
            CDP
          </span>
        </div>
      )}

      {canEdit && hasGraph && (
        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="sv-btn ghost" onClick={() => { setShowApply(true); maps.reload(); }}>
            Apply to Map
          </button>
          <button className="sv-btn ghost" onClick={applyDependencies} disabled={applyingDeps}>
            {applyingDeps ? 'Analyzing…' : 'Apply Dependencies'}
          </button>
        </div>
      )}

      {suggestions && <DependencyPanel suggestions={suggestions} onClose={() => setSuggestions(null)} />}

      {showApply && (
        <ApplyToMapModal
          maps={maps.data || []}
          onClose={() => setShowApply(false)}
          flash={flash}
        />
      )}
    </div>
  );
}

// ── Dependency suggestions panel (top-level component) ─────────
function DependencyPanel({
  suggestions,
  onClose,
}: {
  suggestions: DependencySuggestion[];
  onClose: () => void;
}) {
  return (
    <div className="sv-panel" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>Dependency suggestions</strong>
        <div style={{ flex: 1 }} />
        <button className="sv-btn ghost sm" onClick={onClose}>Dismiss</button>
      </div>
      {suggestions.length === 0 ? (
        <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          No dependency suggestions found.
        </div>
      ) : (
        <table className="sv-table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Device</th>
              <th>Reason</th>
              <th style={{ textAlign: 'right' }}>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s: DependencySuggestion) => (
              <tr key={s.device_id}>
                <td>{s.name}</td>
                <td style={{ color: 'var(--text-muted)' }}>{s.reason}</td>
                <td style={{ textAlign: 'right' }}>{Math.round((s.confidence || 0) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Apply-to-map modal (top-level component) ───────────────────
function ApplyToMapModal({
  maps,
  onClose,
  flash,
}: {
  maps: MapOption[];
  onClose: () => void;
  flash: (node: React.ReactNode) => void;
}) {
  const [target, setTarget] = useState<number | ''>(maps.length ? maps[0].id : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply() {
    if (target === '') { setErr('Select a map'); return; }
    setSaving(true);
    setErr(null);
    try {
      await apiSend(`/api/topology/apply-to-map/${target}`, 'POST', {});
      onClose();
      flash(
        <span>
          Topology applied to map.{' '}
          <a href={`/maps/${target}`} style={{ textDecoration: 'underline' }}>View map →</a>
        </span>
      );
    } catch (e: any) {
      setErr(e?.message || 'Failed to apply to map');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Apply to Map</h2>
        {err && <ErrorBox message={err} />}
        {maps.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No maps available. Create a map first.</p>
        ) : (
          <label className="sv-field" style={{ display: 'block' }}>
            Target map
            <select
              className="sv-select"
              value={target}
              onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : '')}
              style={{ width: '100%', marginTop: 6 }}
            >
              {maps.map((m: MapOption) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        )}
        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={apply} disabled={saving || maps.length === 0 || target === ''}>
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tab 2: Link table (top-level component) ────────────────────
function LinkTable({
  canEdit,
  flash,
}: {
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const links = useApi<TopologyLink[]>('/api/topology/links', 0);
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('from');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const rows = useMemo<TopologyLink[]>(() => {
    const all = links.data || [];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? all.filter((r: TopologyLink) => {
          const hay = [
            r.from_device_name, r.from_ip,
            r.to_device_name, r.to_name, r.to_ip,
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(needle);
        })
      : all;

    function val(r: TopologyLink): string {
      switch (sortKey) {
        case 'from': return (r.from_device_name || '').toLowerCase();
        case 'from_port': return (r.from_port || '').toLowerCase();
        case 'to': return ((r.to_device_id ? r.to_device_name : (r.to_name || r.to_ip)) || '').toLowerCase();
        case 'to_port': return (r.to_port || '').toLowerCase();
        case 'protocol': return (r.protocol || '').toLowerCase();
        case 'last_seen': return r.last_seen_at || '';
        default: return '';
      }
    }

    const sorted = [...filtered].sort((a: TopologyLink, b: TopologyLink) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [links.data, q, sortKey, sortDir]);

  if (links.loading && !links.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (links.error) {
    return <ErrorBox message={links.error} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0', flexWrap: 'wrap' }}>
        <input
          className="sv-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search device name or IP…"
          style={{ maxWidth: 320 }}
        />
        <div style={{ flex: 1 }} />
        <button className="sv-btn ghost sm" onClick={() => exportLinksCsv(rows)} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No links to show. Run discovery to detect device connections." />
        </div>
      ) : (
        <div className="sv-panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="sv-table">
            <thead>
              <tr>
                <SortableTh label="From Device" col="from" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh label="From Port" col="from_port" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh label="To Device" col="to" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh label="To Port" col="to_port" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh label="Protocol" col="protocol" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableTh label="Last Seen" col="last_seen" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r: TopologyLink) => (
                <LinkRow key={r.id} row={r} canEdit={canEdit} flash={flash} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Sortable table header cell (top-level component) ───────────
function SortableTh({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (col: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}
      {active && <span style={{ marginLeft: 6, color: 'var(--primary)' }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

// ── Link table row (top-level component) ───────────────────────
function LinkRow({
  row,
  canEdit,
  flash,
}: {
  row: TopologyLink;
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const [adding, setAdding] = useState(false);
  const proto = (row.protocol || '').toLowerCase();
  const protoColor = proto === 'cdp' ? '#f97316' : '#2563eb';

  async function addToMonitoring() {
    if (!row.to_ip) return;
    setAdding(true);
    try {
      await apiSend('/api/devices', 'POST', {
        name: row.to_name || row.to_ip,
        ip_address: row.to_ip,
      });
      flash(`Added ${row.to_name || row.to_ip} to monitoring.`);
    } catch (e: any) {
      flash(e?.message || 'Failed to add device');
    } finally {
      setAdding(false);
    }
  }

  return (
    <tr>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot status="up" />
          <div>
            <div>{row.from_device_name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.from_ip}</div>
          </div>
        </div>
      </td>
      <td>{row.from_port || '—'}</td>
      <td>
        {row.to_device_id ? (
          <div>
            <a href={`/devices/${row.to_device_id}`} style={{ textDecoration: 'underline' }}>
              {row.to_device_name || row.to_ip || 'Device'}
            </a>
            {row.to_ip && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.to_ip}</div>}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-muted)' }}>{row.to_name || row.to_ip || 'Unknown'}</span>
            <span className="sv-badge">Not monitored</span>
            {canEdit && row.to_ip && (
              <button className="sv-btn ghost sm" onClick={addToMonitoring} disabled={adding}>
                {adding ? 'Adding…' : 'Add to monitoring'}
              </button>
            )}
          </div>
        )}
      </td>
      <td>{row.to_port || '—'}</td>
      <td>
        <span className="sv-badge" style={{ color: protoColor, textTransform: 'uppercase' }}>
          {proto || '—'}
        </span>
      </td>
      <td title={fmtTime(row.last_seen_at)}>{fmtRel(row.last_seen_at)}</td>
    </tr>
  );
}

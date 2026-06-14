'use client';

import { Fragment, useMemo, useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, fmtRel, fmtTime } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import TopologyMapView from '@/components/TopologyMapView';

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
  from_site_id: number | null;
  from_site: string | null;
  from_port: string | null;
  to_device_id: number | null;
  to_device_name: string | null;
  to_ip: string | null;
  to_site_id: number | null;
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

// A monitored (from-) device with all the neighbor links it discovered.
interface FromDeviceGroup {
  key: string;
  from_device_id: number;
  from_device_name: string;
  from_ip: string;
  last_seen_at: string;
  links: TopologyLink[];
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Slim discovery header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          minHeight: 44,
          padding: '0 16px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          Network Topology
        </span>
        <span style={{ color: 'var(--border)' }}>·</span>
        {last ? (
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            Last run: {fmtRel(last.last_run_at)} · {last.links_found} link{last.links_found === 1 ? '' : 's'} · {last.devices_discovered} device{last.devices_discovered === 1 ? '' : 's'}
          </span>
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            Auto-discovered device connections via LLDP and CDP.
          </span>
        )}
        <div style={{ flex: 1 }} />
        {canEdit && (
          <button className="sv-btn sm" onClick={runDiscovery} disabled={running} style={{ height: 32 }}>
            {running ? 'Running…' : 'Run Discovery'}
          </button>
        )}
      </div>

      {toast && <div className="sv-toast ok" onClick={() => setToast(null)}>{toast}</div>}
      {status.error && <ErrorBox message={status.error} />}

      <div className="sv-tabs sticky" style={{ marginBottom: 0 }}>
        <button className={`sv-tab ${tab === 'map' ? 'active' : ''}`} onClick={() => setTab('map')}>
          Visual Map
        </button>
        <button className={`sv-tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>
          Link Table
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'map' ? <MapTab canEdit={canEdit} flash={flash} /> : <LinkTable canEdit={canEdit} flash={flash} />}
      </div>
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

  const hasGraph = !!tmap.data && tmap.data.edges.length > 0 && tmap.data.nodes.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div
        className="sv-panel"
        style={{ padding: 4, flex: 1, minHeight: 360, display: 'flex', flexDirection: 'column' }}
      >
        {hasGraph && tmap.data ? (
          <div style={{ flex: 1, minHeight: 0, width: '100%', background: '#f8fafc', borderRadius: 6, overflow: 'hidden' }}>
            <TopologyMapView nodes={tmap.data.nodes} edges={tmap.data.edges} interactive />
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty message="No topology discovered yet — run topology discovery to see device connections →" />
          </div>
        )}
      </div>

      {(hasGraph || (canEdit && hasGraph)) && (
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: 12.5,
            color: 'var(--text-muted)',
          }}
        >
          {hasGraph && (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ display: 'inline-block', width: 22, height: 3, background: '#2563eb', borderRadius: 2 }} />
                LLDP
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ display: 'inline-block', width: 22, height: 3, background: '#f97316', borderRadius: 2 }} />
                CDP
              </span>
            </>
          )}
          <div style={{ flex: 1 }} />
          {canEdit && hasGraph && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="sv-btn ghost sm" style={{ height: 32 }} onClick={() => { setShowApply(true); maps.reload(); }}>
                Apply to Map
              </button>
              <button className="sv-btn ghost sm" style={{ height: 32 }} onClick={applyDependencies} disabled={applyingDeps}>
                {applyingDeps ? 'Analyzing…' : 'Apply Dependencies'}
              </button>
            </div>
          )}
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

// Resolve the display name for a neighbor (to-) device on a link.
function neighborName(r: TopologyLink): string {
  return r.to_device_id != null
    ? (r.to_device_name || r.to_ip || 'Device')
    : (r.to_name || r.to_ip || 'Unknown');
}

// Group raw links by the monitored (from-) device that discovered them.
function buildFromDeviceGroups(rows: TopologyLink[]): FromDeviceGroup[] {
  const map = new Map<string, FromDeviceGroup>();
  for (const r of rows) {
    const key = String(r.from_device_id);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        from_device_id: r.from_device_id,
        from_device_name: r.from_device_name,
        from_ip: r.from_ip,
        last_seen_at: r.last_seen_at,
        links: [],
      };
      map.set(key, g);
    }
    g.links.push(r);
    if (r.last_seen_at > g.last_seen_at) g.last_seen_at = r.last_seen_at;
  }
  const groups = Array.from(map.values());
  for (const g of groups) {
    g.links.sort((a, b) => neighborName(a).localeCompare(neighborName(b)));
  }
  groups.sort((a, b) => (a.from_device_name || '').localeCompare(b.from_device_name || ''));
  return groups;
}

// ── Tab 2: Link table — collapsed by from- (monitored) device (top-level) ──
function LinkTable({
  canEdit,
  flash,
}: {
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const links = useApi<TopologyLink[]>('/api/topology/links', 0);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  const filtered = useMemo<TopologyLink[]>(() => {
    const all = links.data || [];
    const needle = q.trim().toLowerCase();
    return needle
      ? all.filter((r: TopologyLink) => {
          const hay = [
            r.from_device_name, r.from_ip,
            r.to_device_name, r.to_name, r.to_ip,
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(needle);
        })
      : all;
  }, [links.data, q]);

  const groups = useMemo<FromDeviceGroup[]>(() => buildFromDeviceGroups(filtered), [filtered]);

  if (links.loading && !links.data) {
    return <div className="sv-panel"><Loading /></div>;
  }
  if (links.error) {
    return <ErrorBox message={links.error} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Compact single-row filter + export */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input
          className="sv-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search device name or IP…"
          style={{ maxWidth: 320, height: 32 }}
        />
        <div style={{ flex: 1 }} />
        <button
          className="sv-btn ghost sm"
          onClick={() => exportLinksCsv(filtered)}
          disabled={filtered.length === 0}
          style={{ height: 32 }}
        >
          Export CSV
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No links to show. Run discovery to detect device connections." />
        </div>
      ) : (
        <div className="sv-panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="sv-table">
            <thead>
              <tr>
                <th>Device</th>
                <th style={{ whiteSpace: 'nowrap' }}>Last Seen</th>
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {groups.map((g: FromDeviceGroup) => (
                <FromDeviceRow
                  key={g.key}
                  group={g}
                  expanded={expanded.has(g.key)}
                  onToggle={() => toggle(g.key)}
                  canEdit={canEdit}
                  flash={flash}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── From-device group row + expandable neighbor detail (top-level) ──
function FromDeviceRow({
  group,
  expanded,
  onToggle,
  canEdit,
  flash,
}: {
  group: FromDeviceGroup;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const count = group.links.length;

  return (
    <Fragment>
      <tr className="sv-neighbor-head" style={{ cursor: 'pointer', height: 40 }} onClick={onToggle}>
        <td style={{ height: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StatusDot status="up" />
            <a
              href={`/devices/${group.from_device_id}`}
              style={{ fontSize: 13, fontWeight: 600, textDecoration: 'underline' }}
              onClick={(e) => e.stopPropagation()}
            >
              {group.from_device_name}
            </a>
            {group.from_ip && (
              <>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{group.from_ip}</span>
              </>
            )}
            <span style={{ color: 'var(--border)' }}>·</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {count} neighbor{count === 1 ? '' : 's'}
            </span>
          </div>
        </td>
        <td title={fmtTime(group.last_seen_at)} style={{ whiteSpace: 'nowrap', height: 40, color: 'var(--text-muted)' }}>
          {fmtRel(group.last_seen_at)}
        </td>
        <td style={{ textAlign: 'center', width: 32, color: 'var(--text-muted)', height: 40 }}>
          {expanded ? '▾' : '▸'}
        </td>
      </tr>
      {expanded && (
        <tr className="sv-neighbor-detail">
          <td colSpan={3} style={{ padding: 0 }}>
            <table className="sv-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Neighbor</th>
                  <th>Monitored</th>
                  <th>Protocol</th>
                  <th>To Port</th>
                  <th style={{ whiteSpace: 'nowrap' }}>Last Seen</th>
                  <th style={{ textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {group.links.map((l: TopologyLink) => (
                  <NeighborDetailRow key={l.id} link={l} canEdit={canEdit} flash={flash} />
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Per-neighbor detail row with its own "add to monitoring" state (top-level) ──
function NeighborDetailRow({
  link,
  canEdit,
  flash,
}: {
  link: TopologyLink;
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const [adding, setAdding] = useState(false);
  const monitored = link.to_device_id != null;
  const name = neighborName(link);
  const proto = (link.protocol || '').toLowerCase();

  async function addToMonitoring() {
    if (!link.to_ip) {
      flash('No IP address was discovered for this neighbor — add it manually from the Devices page.');
      return;
    }
    setAdding(true);
    try {
      // Inherit the site from the device that discovered this neighbor.
      await apiSend('/api/devices', 'POST', {
        name: link.to_name || link.to_ip,
        ip_address: link.to_ip,
        site_id: link.from_site_id ?? null,
        site_name: link.from_site ?? null,
      });
      const where = link.from_site ? ` (site: ${link.from_site})` : '';
      flash(`Added ${link.to_name || link.to_ip} to monitoring${where}.`);
    } catch (e: any) {
      flash(e?.message || 'Failed to add device');
    } finally {
      setAdding(false);
    }
  }

  return (
    <tr style={{ height: 36 }}>
      <td style={{ height: 36 }}>
        <div>
          {monitored && link.to_device_id ? (
            <a href={`/devices/${link.to_device_id}`} style={{ textDecoration: 'underline' }}>{name}</a>
          ) : (
            <span>{name}</span>
          )}
          {link.to_ip && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{link.to_ip}</div>}
        </div>
      </td>
      <td style={{ height: 36 }}>
        <span className="sv-badge">{monitored ? 'Monitored' : 'Not monitored'}</span>
      </td>
      <td style={{ height: 36 }}>
        {proto && (
          <span
            className="sv-badge"
            style={{ color: proto === 'cdp' ? '#f97316' : '#2563eb', textTransform: 'uppercase' }}
          >
            {proto}
          </span>
        )}
      </td>
      <td style={{ height: 36 }}>{link.to_port || '—'}</td>
      <td title={fmtTime(link.last_seen_at)} style={{ whiteSpace: 'nowrap', height: 36, color: 'var(--text-muted)' }}>
        {fmtRel(link.last_seen_at)}
      </td>
      <td style={{ textAlign: 'right', height: 36 }}>
        {canEdit && link.to_device_id == null && (
          <button
            className="sv-btn ghost sm"
            onClick={(e) => { e.stopPropagation(); addToMonitoring(); }}
            disabled={adding}
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        )}
      </td>
    </tr>
  );
}

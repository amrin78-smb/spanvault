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

// A neighbor device with all the individual port-level links that reach it.
interface NeighborGroup {
  key: string;
  monitored: boolean;
  to_device_id: number | null;
  name: string;
  ip: string | null;
  protocols: string[];
  from_site_id: number | null;
  from_site: string | null;
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
    <div>
      <div className="sv-panel" style={{ padding: 12 }}>
        {hasGraph && tmap.data ? (
          <div style={{ width: '100%', height: 620, background: '#f8fafc', borderRadius: 8, overflow: 'hidden' }}>
            <TopologyMapView nodes={tmap.data.nodes} edges={tmap.data.edges} interactive />
          </div>
        ) : (
          <Empty message="No topology discovered yet — run topology discovery to see device connections →" />
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

// Group raw links by the neighbor (to-) device they reach. Monitored neighbors
// key on to_device_id; unmonitored ones on their IP/name.
function neighborKey(r: TopologyLink): string {
  if (r.to_device_id != null) return `dev:${r.to_device_id}`;
  return `nb:${(r.to_ip || r.to_name || 'unknown').toLowerCase()}`;
}

function buildNeighborGroups(rows: TopologyLink[]): NeighborGroup[] {
  const map = new Map<string, NeighborGroup>();
  for (const r of rows) {
    const key = neighborKey(r);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        monitored: r.to_device_id != null,
        to_device_id: r.to_device_id ?? null,
        name: r.to_device_id != null
          ? (r.to_device_name || r.to_ip || 'Device')
          : (r.to_name || r.to_ip || 'Unknown'),
        ip: r.to_ip ?? null,
        protocols: [],
        from_site_id: r.from_site_id ?? null,
        from_site: r.from_site ?? null,
        last_seen_at: r.last_seen_at,
        links: [],
      };
      map.set(key, g);
    }
    g.links.push(r);
    const proto = (r.protocol || '').toLowerCase();
    if (proto && !g.protocols.includes(proto)) g.protocols.push(proto);
    if (!g.ip && r.to_ip) g.ip = r.to_ip;
    if (g.from_site_id == null && r.from_site_id != null) { g.from_site_id = r.from_site_id; g.from_site = r.from_site ?? null; }
    if (r.last_seen_at > g.last_seen_at) g.last_seen_at = r.last_seen_at;
  }
  const groups = Array.from(map.values());
  for (const g of groups) {
    g.protocols.sort();
    g.links.sort((a, b) =>
      (a.from_device_name || '').localeCompare(b.from_device_name || '') ||
      (a.from_port || '').localeCompare(b.from_port || ''));
  }
  // Unmonitored neighbors first (actionable), then by name.
  groups.sort((a, b) =>
    Number(a.monitored) - Number(b.monitored) || a.name.localeCompare(b.name));
  return groups;
}

// ── Tab 2: Link table — collapsed by neighbor device (top-level) ──
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

  const groups = useMemo<NeighborGroup[]>(() => buildNeighborGroups(filtered), [filtered]);

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
        <button className="sv-btn ghost sm" onClick={() => exportLinksCsv(filtered)} disabled={filtered.length === 0}>
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
                <th style={{ width: 32 }} />
                <th>Neighbor</th>
                <th>Protocol</th>
                <th>Connections</th>
                <th style={{ whiteSpace: 'nowrap' }}>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: NeighborGroup) => (
                <NeighborRow
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

// ── Neighbor group row + expandable port-level detail (top-level) ──
function NeighborRow({
  group,
  expanded,
  onToggle,
  canEdit,
  flash,
}: {
  group: NeighborGroup;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  flash: (node: React.ReactNode) => void;
}) {
  const [adding, setAdding] = useState(false);

  async function addToMonitoring() {
    if (!group.ip) {
      flash('No IP address was discovered for this neighbor — add it manually from the Devices page.');
      return;
    }
    setAdding(true);
    try {
      // Inherit the site from the device that discovered this neighbor.
      await apiSend('/api/devices', 'POST', {
        name: group.name || group.ip,
        ip_address: group.ip,
        site_id: group.from_site_id ?? null,
        site_name: group.from_site ?? null,
      });
      const where = group.from_site ? ` (site: ${group.from_site})` : '';
      flash(`Added ${group.name || group.ip} to monitoring${where}.`);
    } catch (e: any) {
      flash(e?.message || 'Failed to add device');
    } finally {
      setAdding(false);
    }
  }

  const count = group.links.length;

  return (
    <Fragment>
      <tr className="sv-neighbor-head" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{expanded ? '▾' : '▸'}</td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusDot status={group.monitored ? 'up' : 'unknown'} />
            <div>
              {group.monitored && group.to_device_id ? (
                <a href={`/devices/${group.to_device_id}`} style={{ textDecoration: 'underline' }} onClick={(e) => e.stopPropagation()}>
                  {group.name}
                </a>
              ) : (
                <span>{group.name}</span>
              )}
              {group.ip && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{group.ip}</div>}
            </div>
            <span className="sv-badge">{group.monitored ? 'Monitored' : 'Not monitored'}</span>
            {canEdit && !group.monitored && (
              <button
                className="sv-btn ghost sm"
                onClick={(e) => { e.stopPropagation(); addToMonitoring(); }}
                disabled={adding}
              >
                {adding ? 'Adding…' : 'Add to monitoring'}
              </button>
            )}
          </div>
        </td>
        <td>
          {group.protocols.map((p) => (
            <span
              key={p}
              className="sv-badge"
              style={{ color: p === 'cdp' ? '#f97316' : '#2563eb', textTransform: 'uppercase', marginRight: 4 }}
            >
              {p}
            </span>
          ))}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>{count} connection{count === 1 ? '' : 's'}</td>
        <td title={fmtTime(group.last_seen_at)} style={{ whiteSpace: 'nowrap' }}>{fmtRel(group.last_seen_at)}</td>
      </tr>
      {expanded && (
        <tr className="sv-neighbor-detail">
          <td />
          <td colSpan={4} style={{ padding: 0 }}>
            <table className="sv-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>From Device</th>
                  <th>From Port</th>
                  <th>To Port</th>
                  <th style={{ whiteSpace: 'nowrap' }}>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {group.links.map((l: TopologyLink) => (
                  <tr key={l.id}>
                    <td>
                      <div>{l.from_device_name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{l.from_ip}</div>
                    </td>
                    <td>{l.from_port || '—'}</td>
                    <td>{l.to_port || '—'}</td>
                    <td title={fmtTime(l.last_seen_at)} style={{ whiteSpace: 'nowrap' }}>{fmtRel(l.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

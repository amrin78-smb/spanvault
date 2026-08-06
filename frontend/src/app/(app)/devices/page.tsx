'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { vendorLabel } from '@/lib/vendor';
import { ErrorBox, fmtRel, PageHeader, TableSkeleton, EmptyState, useRefreshKey } from '@/components/ui';
import { StatusDot } from '@/components/StatusDot';
import SiteScopeBanner from '@/components/SiteScopeBanner';
import { IconDevices } from '@/components/icons';
import { DeviceForm, ImportModal } from '@/components/DeviceModals';
import { gradeColor, n as intelNum } from '@/components/intel';

type Device = {
  id: number; name: string; ip_address: string; device_type: string | null;
  site_id: number | null; site_name: string | null; current_status: string;
  last_response_ms: number | null; last_seen_at: string | null;
  snmp_enabled: boolean; poll_interval_seconds: number; netvault_device_id: string | null;
  latest_cpu_pct: number | null; latest_mem_pct: number | null;
  is_gateway: boolean; alert_suppressed: boolean; suppressed_by_device_id: number | null;
  agent_id: number | null; agent_name: string | null; agent_status: string | null;
  last_alert_at: string | null; last_alert_type: string | null; last_alert_severity: string | null;
  health_score: number | string | null; health_grade: string | null; health_trend: string | null;
  // Detected by the collector's SNMP parser.
  device_vendor: string | null;
  // Resolved from NetVault's inventory by the API (netvault_device_id, else IP
  // match). Null when the device isn't in NetVault or NetVault is unreachable.
  nv_vendor: string | null; nv_model: string | null;
  os_type: string | null; os_version: string | null;
};

// Quick-filter chips, revealed by the "More Filters" toggle (client-side, single-select).
const DEVICE_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'down', label: 'Down' },
  { key: 'warning', label: 'Warning' },
  { key: 'nosnmp', label: 'No SNMP' },
  { key: 'alertstoday', label: 'Has Alerts Today' },
];
function chipMatch(d: Device, chip: string): boolean {
  const s = (d.current_status || 'unknown').toLowerCase();
  switch (chip) {
    case 'down': return s === 'down';
    case 'warning': return s === 'warning';
    case 'nosnmp': return !d.snmp_enabled;
    case 'alertstoday': return d.last_alert_at != null;
    default: return true;
  }
}

type Site = { id: number; name: string };
type SiteGroup = { key: string; name: string; siteId: number | null; devices: Device[] };
type AgentGroupT = {
  key: string; agentId: number | null; agentName: string; agentStatus: string | null; devices: Device[];
};

const UNASSIGNED = 'Unassigned';
const LOCAL = 'Local Polling';
const SITES_PER_PAGE = 25;

// Top-level grouping by polling agent (agent_id null = local collector).
function groupByAgent(devices: Device[]): AgentGroupT[] {
  const map = new Map<string, AgentGroupT>();
  for (const d of devices) {
    const key = d.agent_id == null ? 'local' : `agent-${d.agent_id}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        agentId: d.agent_id ?? null,
        agentName: d.agent_id == null ? LOCAL : (d.agent_name || `Agent ${d.agent_id}`),
        agentStatus: d.agent_id == null ? null : (d.agent_status || 'offline'),
        devices: [],
      };
      map.set(key, g);
    }
    g.devices.push(d);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.agentId == null) return -1;
    if (b.agentId == null) return 1;
    return a.agentName.localeCompare(b.agentName);
  });
}

function groupBySite(devices: Device[]): SiteGroup[] {
  const map = new Map<string, SiteGroup>();
  for (const d of devices) {
    const name = d.site_name || UNASSIGNED;
    let g = map.get(name);
    if (!g) { g = { key: name, name, siteId: d.site_id, devices: [] }; map.set(name, g); }
    g.devices.push(d);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.name === UNASSIGNED) return 1;
    if (b.name === UNASSIGNED) return -1;
    return a.name.localeCompare(b.name);
  });
}

function countByStatus(devices: Device[]) {
  const c = { up: 0, down: 0, warning: 0, unknown: 0 };
  for (const d of devices) {
    const s = (d.current_status || 'unknown').toLowerCase();
    if (s === 'up') c.up++;
    else if (s === 'down') c.down++;
    else if (s === 'warning') c.warning++;
    else c.unknown++;
  }
  return c;
}

function worstStatus(devices: Device[]): string {
  const c = countByStatus(devices);
  if (c.down) return 'down';
  if (c.warning) return 'warning';
  if (c.up) return 'up';
  return 'unknown';
}

// Average health across a group, for the site-header ring. Devices with no
// computed score are skipped rather than counted as zero.
function avgHealth(devices: Device[]): { score: number | null; grade: string | null } {
  const vals: number[] = [];
  let best: string | null = null;
  for (const d of devices) {
    const s = intelNum(d.health_score);
    if (s != null) { vals.push(s); if (d.health_grade) best = best ?? d.health_grade; }
  }
  if (!vals.length) return { score: null, grade: null };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { score: avg, grade: gradeFromScore(avg) || best };
}

// The intelligence engine grades A–F; the list shows a word. Derived from the
// letter (not a second set of score thresholds) so this page can never disagree
// with the Intelligence page about the same device.
const GRADE_WORD: Record<string, string> = {
  A: 'Excellent', B: 'Good', C: 'Fair', D: 'Poor', F: 'Critical',
};
function gradeWord(grade: string | null): string {
  return GRADE_WORD[(grade || '').toUpperCase()] || '';
}
// Only used for the site-header average, where there is no stored letter grade.
function gradeFromScore(s: number): string | null {
  if (s >= 90) return 'A';
  if (s >= 80) return 'B';
  if (s >= 70) return 'C';
  if (s >= 60) return 'D';
  return 'F';
}

function statusLabel(s: string): string {
  const v = (s || 'unknown').toLowerCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// "high_latency" → "High latency"
function alertLabel(t: string | null): string {
  if (!t) return 'Alert';
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusTooltip(d: Device): string {
  const s = (d.current_status || 'unknown').toLowerCase();
  const seen = d.last_seen_at ? fmtRel(d.last_seen_at) : 'never';
  const ms = d.last_response_ms != null ? `${Number(d.last_response_ms).toFixed(0)}ms` : null;
  if (s === 'up') return `Up — last seen ${seen}${ms ? `, ${ms}` : ''}`;
  if (s === 'down') return `Down — last seen ${seen}`;
  if (s === 'warning') return `Warning${ms ? ` — ${ms}` : ''} — last seen ${seen}`;
  return `Unknown — last seen ${seen}`;
}

export default function DevicesPage() {
  const { canEdit } = useRbac();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [siteId, setSiteId] = useState('');
  const [type, setType] = useState('');
  const [vendor, setVendor] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [chip, setChip] = useState('all');
  const [moreOpen, setMoreOpen] = useState(false);
  // Sites start COLLAPSED, so the page opens on a per-site overview instead of
  // every device row at once. Tracking the OPENED keys (rather than the closed
  // ones) is what makes that the default: the set is empty before any device
  // data has loaded, and "empty" has to mean closed.
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set());
  // Agent groups keep the opposite default — collapsing those too would hide the
  // site summaries this page is meant to land on, leaving only agent names.
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);

  // Pre-select the status filter from the URL (?status=up|down|warning|unknown)
  // so dashboard stat-card links land on a filtered device list.
  useEffect(() => {
    const st = new URLSearchParams(window.location.search).get('status');
    if (st && ['up', 'down', 'warning', 'unknown'].includes(st)) setStatus(st);
  }, []);

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (siteId) params.set('site_id', siteId);
  const devices = useApi<Device[]>(`/api/devices?${params.toString()}`, 20000);
  const sites = useApi<Site[]>('/api/netvault/sites');

  useRefreshKey(() => { devices.reload(); sites.reload(); });

  const all = useMemo(() => devices.data || [], [devices.data]);

  // Type / vendor option lists come from the loaded devices, so they only ever
  // offer values that actually match something.
  const typeOptions = useMemo(
    () => Array.from(new Set(all.map((d) => d.device_type).filter(Boolean) as string[])).sort(),
    [all]
  );
  const vendorOptions = useMemo(() => {
    const s = new Set<string>();
    for (const d of all) {
      const v = d.nv_vendor || vendorLabel(d.device_vendor);
      if (v) s.add(v);
    }
    return Array.from(s).sort();
  }, [all]);

  const visible = useMemo(() => all.filter((d) => {
    if (!chipMatch(d, chip)) return false;
    if (type && d.device_type !== type) return false;
    if (vendor && (d.nv_vendor || vendorLabel(d.device_vendor)) !== vendor) return false;
    return true;
  }), [all, chip, type, vendor]);

  // NetVault's os_type/os_version are unpopulated on this install (0 of 2,482
  // inventory rows), which would make "Version / OS" a column of nothing but
  // em-dashes. Show it only once at least one device actually reports an OS, so
  // it appears by itself the moment that data starts arriving.
  const showOs = useMemo(() => visible.some((d) => d.os_version || d.os_type), [visible]);

  const agentGroups = useMemo(() => groupByAgent(visible), [visible]);
  // Only show the agent grouping layer when at least one agent owns devices;
  // otherwise render site accordions flat.
  const hasAgents = agentGroups.some((g) => g.agentId !== null);
  const flatGroups = useMemo(() => groupBySite(visible), [visible]);

  const siteCount = flatGroups.length;
  const pageCount = Math.max(1, Math.ceil(siteCount / SITES_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pagedGroups = flatGroups.slice((safePage - 1) * SITES_PER_PAGE, safePage * SITES_PER_PAGE);

  // Reset to page 1 when the result COUNT changes (search/filter), not on every
  // data refresh — the array identity is new each poll, which would otherwise
  // yank the user back to page 1 every 20 seconds.
  useEffect(() => { setPage(1); }, [siteCount]);

  const siteKeys = hasAgents
    ? agentGroups.flatMap((g) => groupBySite(g.devices).map((s) => `${g.key}::${s.key}`))
    : flatGroups.map((g) => g.key);
  const agentKeys = agentGroups.map((g) => g.key);

  const expandAll = () => { setExpandedSites(new Set(siteKeys)); setCollapsedAgents(new Set()); };
  const collapseAll = () => { setExpandedSites(new Set()); setCollapsedAgents(new Set(agentKeys)); };
  const toggleSite = (k: string) => setExpandedSites((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const toggleAgent = (k: string) => setCollapsedAgents((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // A search that returns matches into collapsed sections reads as "no results",
  // so an active query force-opens every site. This overrides rather than
  // rewrites the manual state, so clearing the search restores whatever the user
  // had open themselves.
  const forceOpen = q.trim().length > 0;

  return (
    <div>
      <PageHeader title="Devices" subtitle="All monitored devices and network inventory">
        {canEdit && (
          <>
            <button className="sv-btn ghost" onClick={() => setShowImport(true)}>Import from NetVault</button>
            <button className="sv-btn" onClick={() => setShowForm(true)}>+ Add Device</button>
          </>
        )}
      </PageHeader>

      <SiteScopeBanner />

      {/* Filter bar: search + site/type/vendor/status, then the More Filters chips. */}
      <div
        className="sv-toolbar"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}
      >
        <input
          className="sv-input"
          placeholder="Search by name, IP…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ height: 32, padding: '0 10px', fontSize: 'var(--text-base)', minWidth: 220 }}
        />
        <select className="sv-select" value={siteId} onChange={(e) => setSiteId(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Sites</option>
          {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="sv-select" value={type} onChange={(e) => setType(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Types</option>
          {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="sv-select" value={vendor} onChange={(e) => setVendor(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Vendors</option>
          {vendorOptions.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="sv-select" value={status} onChange={(e) => setStatus(e.target.value)}
          style={{ height: 32, padding: '0 8px', fontSize: 'var(--text-base)' }}>
          <option value="">All Statuses</option>
          <option value="up">Up</option>
          <option value="down">Down</option>
          <option value="warning">Warning</option>
          <option value="unknown">Unknown</option>
        </select>
        <button
          className={`sv-chip ${moreOpen || chip !== 'all' ? 'active' : ''}`}
          onClick={() => setMoreOpen((o) => !o)}
          style={{ height: 32, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          More Filters {chip !== 'all' && <span aria-hidden>•</span>}
        </button>
      </div>

      {moreOpen && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 }}>
          {DEVICE_CHIPS.map((c) => (
            <button
              key={c.key}
              className={`sv-chip ${chip === c.key ? 'active' : ''}`}
              onClick={() => setChip(c.key)}
              style={{ height: 30, padding: '0 12px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center' }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      {/* Result count + expand/collapse controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
          Showing {visible.length.toLocaleString()} {visible.length === 1 ? 'device' : 'devices'} across{' '}
          {siteCount.toLocaleString()} {siteCount === 1 ? 'site' : 'sites'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="sv-btn ghost sm" onClick={expandAll}>Expand All</button>
        <button className="sv-btn ghost sm" onClick={collapseAll}>Collapse All</button>
      </div>

      {devices.error && <ErrorBox message={devices.error} />}

      {devices.loading && !devices.data ? (
        <div className="sv-panel" style={{ padding: 0 }}><TableSkeleton rows={6} cols={6} /></div>
      ) : hasAgents ? (
        agentGroups.map((g) => (
          <AgentGroup
            key={g.key} group={g}
            open={!collapsedAgents.has(g.key)} onToggle={() => toggleAgent(g.key)}
            expandedSites={expandedSites} onToggleSite={toggleSite}
            forceOpen={forceOpen} showOs={showOs}
          />
        ))
      ) : pagedGroups.length ? (
        <>
          {pagedGroups.map((g) => (
            <SiteAccordion
              key={g.key} group={g}
              open={forceOpen || expandedSites.has(g.key)}
              onToggle={() => toggleSite(g.key)} showOs={showOs}
            />
          ))}
          {pageCount > 1 && (
            <SitePager
              page={safePage} pageCount={pageCount} total={siteCount}
              start={(safePage - 1) * SITES_PER_PAGE} shown={pagedGroups.length}
              onPage={setPage}
            />
          )}
        </>
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <EmptyState
            icon={<IconDevices width={26} height={26} />}
            title={all.length ? 'No devices match these filters' : 'No monitored devices'}
            message={all.length
              ? 'Try clearing the site, type, vendor or status filter.'
              : 'Add a device manually or import your inventory from NetVault to start monitoring.'}
            actionLabel={canEdit && !all.length ? '+ Add Device' : undefined}
            onAction={canEdit && !all.length ? () => setShowForm(true) : undefined}
          />
        </div>
      )}

      {showForm && (
        <DeviceForm
          device={null}
          sites={sites.data || []}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); devices.reload(); }}
        />
      )}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); devices.reload(); }}
        />
      )}
    </div>
  );
}

// ── Site-group pagination ──────────────────────────────────────
function SitePager({
  page, pageCount, total, start, shown, onPage,
}: {
  page: number; pageCount: number; total: number; start: number; shown: number;
  onPage: (p: number) => void;
}) {
  const btn = (disabled: boolean) => ({
    padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: 'var(--bg-card)', color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
    cursor: disabled ? 'default' : 'pointer', fontSize: 'var(--text-base)', opacity: disabled ? 0.5 : 1,
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '10px 4px 2px', flexWrap: 'wrap' }}>
      <div className="sv-muted" style={{ fontSize: 'var(--text-sm)' }}>
        Showing {(start + 1).toLocaleString()} to {(start + shown).toLocaleString()} of {total.toLocaleString()} sites
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button style={btn(page <= 1)} disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page">«</button>
        <button style={btn(page <= 1)} disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
        <span className="sv-muted" style={{ fontSize: 'var(--text-sm)', padding: '0 4px' }}>
          Page {page} of {pageCount}
        </span>
        <button style={btn(page >= pageCount)} disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</button>
        <button style={btn(page >= pageCount)} disabled={page >= pageCount} onClick={() => onPage(pageCount)} aria-label="Last page">»</button>
      </div>
    </div>
  );
}

// ── Agent group: collapsible wrapper holding per-site accordions ──
function AgentGroup({
  group, open, onToggle, expandedSites, onToggleSite, forceOpen, showOs,
}: {
  group: AgentGroupT;
  open: boolean;
  onToggle: () => void;
  expandedSites: Set<string>;
  onToggleSite: (k: string) => void;
  forceOpen: boolean;
  showOs: boolean;
}) {
  const isLocal = group.agentId == null;
  const offline = group.agentStatus === 'offline';
  const siteGroups = groupBySite(group.devices);
  const counts = countByStatus(group.devices);
  return (
    <div className="sv-agent-group" style={{ marginBottom: 12 }}>
      <div
        className={`sv-agent-group-head ${isLocal ? 'local' : ''} ${offline ? 'offline' : ''}`}
        onClick={onToggle}
        style={{ minHeight: 36, padding: '0 14px', gap: 10, background: 'var(--bg-primary)' }}
      >
        <svg className={`chev ${open ? 'open' : ''}`} width="13" height="13" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {isLocal ? (
          <span className="ag-nm" style={{ fontSize: 'var(--text-base)', fontWeight: 700 }}>● {group.agentName}</span>
        ) : (
          <Link href={`/agents/${group.agentId}`} className="ag-nm" style={{ color: 'inherit', fontSize: 'var(--text-base)', fontWeight: 700 }}
            onClick={(e) => e.stopPropagation()} title="View agent detail">
            ● Agent: {group.agentName}
          </Link>
        )}
        {!isLocal && (
          <span className="ag-status" style={{ fontSize: 'var(--text-sm)' }}>
            {group.agentStatus === 'online' ? '● Online' : group.agentStatus === 'offline' ? '○ Offline' : '○ Unknown'}
          </span>
        )}
        <span style={{ fontWeight: 400, fontSize: 'var(--text-sm)', opacity: 0.85 }}>
          {group.devices.length} {group.devices.length === 1 ? 'device' : 'devices'}
        </span>
        <span style={{ flex: 1 }} />
        {offline && <span className="sv-agent-offline-warn">⚠ Agent offline — devices may be stale</span>}
        {!offline && (
          <span className="sv-acc-summary" style={{ fontSize: 'var(--text-sm)' }}>
            {counts.up > 0 && <span className="sv-pill up">{counts.up} up</span>}
            {counts.down > 0 && <span className="sv-pill down">{counts.down} down</span>}
            {counts.warning > 0 && <span className="sv-pill warning">{counts.warning} warning</span>}
          </span>
        )}
      </div>
      {open && (
        <div className="sv-agent-group-body" style={{ padding: 8 }}>
          {siteGroups.map((g) => {
            const k = `${group.key}::${g.key}`;
            return (
              <SiteAccordion
                key={k} group={g}
                open={forceOpen || expandedSites.has(k)}
                onToggle={() => onToggleSite(k)} showOs={showOs}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Site accordion: header summary + the device table ──────────
function SiteAccordion({
  group, open, onToggle, showOs,
}: {
  group: SiteGroup;
  open: boolean;
  onToggle: () => void;
  showOs: boolean;
}) {
  const counts = countByStatus(group.devices);
  const headStatus = worstStatus(group.devices);
  const gateway = group.devices.find((d) => d.is_gateway) || null;
  const gatewayDown = !!gateway && gateway.current_status === 'down';
  const suppressedCount = group.devices.filter((d) => d.alert_suppressed).length;
  const health = avgHealth(group.devices);

  return (
    <div className="sv-acc" style={{ marginBottom: 12 }}>
      <div
        className={`sv-acc-head ${headStatus}`}
        onClick={onToggle}
        style={{ minHeight: 40, padding: '0 12px', gap: 10, fontSize: 'var(--text-base)' }}
      >
        <StatusDot status={headStatus} size={9} title={`Worst status in this site: ${statusLabel(headStatus)}`} />
        {group.siteId != null ? (
          <Link
            href={`/sites/${group.siteId}`}
            className="site-nm sv-acc-link"
            onClick={(e) => e.stopPropagation()}
            title="View site detail"
          >
            {group.name}
          </Link>
        ) : (
          <span className="site-nm">{group.name}</span>
        )}
        {/* No flex spacer here: .sv-acc-head .site-nm already carries flex:1, so
            adding one would split the free space and strand the count mid-row. */}
        <span className="sv-muted" style={{ fontWeight: 400, fontSize: 'var(--text-sm)' }}>
          {group.devices.length} {group.devices.length === 1 ? 'device' : 'devices'}
        </span>
        <span className="sv-acc-summary" style={{ fontSize: 'var(--text-sm)' }}>
          {gatewayDown && (
            <span className="sv-acc-gw-down" title={`Site gateway ${gateway?.name} is down`}>
              ⚠ Gateway down — {suppressedCount} suppressed
            </span>
          )}
          <span className="sv-pill up">{counts.up} Up</span>
          <span className="sv-pill warning">{counts.warning} Warning</span>
          <span className="sv-pill down">{counts.down} Down</span>
          {counts.unknown > 0 && <span className="sv-pill unknown">{counts.unknown} Unknown</span>}
        </span>
        <HealthRing score={health.score} grade={health.grade} size={26} showWord={false} />
        <svg className={`chev ${open ? 'open' : ''}`} width="13" height="13" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          style={{ marginLeft: 4 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </div>
      {open && (
        <div style={{ overflowX: 'auto' }}>
          <table className="sv-table sv-dev-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Type</th>
                <th>Vendor / Model</th>
                <th>IP Address</th>
                {showOs && <th>Version / OS</th>}
                <th>Status</th>
                <th>Health Score</th>
                <th>Last Alert</th>
                <th>Last Seen</th>
                <th style={{ width: 44, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {group.devices.map((d) => <DeviceRow key={d.id} device={d} showOs={showOs} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Health score ring ──────────────────────────────────────────
// SVG donut: grey track + a coloured arc for the score, number in the middle.
// Renders an em-dash when the intelligence engine hasn't scored the device yet,
// never a misleading 0.
function HealthRing({
  score, grade, size = 32, showWord = true,
}: {
  score: number | string | null; grade: string | null; size?: number; showWord?: boolean;
}) {
  const s = intelNum(score);
  if (s == null) return <span className="sv-muted">—</span>;
  const pct = Math.max(0, Math.min(100, s));
  const c = gradeColor(grade);
  const r = size / 2 - 3;
  const circ = 2 * Math.PI * r;
  const word = gradeWord(grade);
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
      title={`Device health score ${Math.round(s)}/100${grade ? ` (grade ${grade.toUpperCase()})` : ''}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: 'none' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c} strokeWidth="3"
          strokeDasharray={`${(pct / 100) * circ} ${circ}`} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central"
          fontSize={size >= 30 ? 11 : 9} fontWeight="700" fill="var(--text-primary)"
        >
          {Math.round(s)}
        </text>
      </svg>
      {showWord && word && (
        <span style={{ fontSize: 'var(--text-xs)', color: c, fontWeight: 600 }}>{word}</span>
      )}
    </span>
  );
}

// ── Single device row ──────────────────────────────────────────
function DeviceRow({ device, showOs }: { device: Device; showOs: boolean }) {
  const vendor = device.nv_vendor || vendorLabel(device.device_vendor);
  const os = [device.os_type, device.os_version].filter(Boolean).join(' ');
  return (
    <tr>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link href={`/devices/${device.id}`} className="sv-dev-name-link"
            style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {device.name}
          </Link>
          {device.is_gateway && <span className="sv-gw-star" title="Site gateway">⭐</span>}
          {device.alert_suppressed && (
            <span className="sv-badge suppressed" title="Alerts suppressed — site gateway is down">
              suppressed
            </span>
          )}
        </div>
      </td>
      <td>{device.device_type || <span className="sv-muted">—</span>}</td>
      <td>
        {vendor ? (
          <>
            <div>{vendor}</div>
            {device.nv_model && (
              <div className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>{device.nv_model}</div>
            )}
          </>
        ) : <span className="sv-muted">—</span>}
      </td>
      <td style={{ fontFamily: 'var(--font-mono)' }}>{device.ip_address}</td>
      {showOs && <td>{os || <span className="sv-muted">—</span>}</td>}
      <td>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <StatusDot status={device.current_status} size={8} title={statusTooltip(device)} />
          {statusLabel(device.current_status)}
        </span>
      </td>
      <td><HealthRing score={device.health_score} grade={device.health_grade} /></td>
      <td>
        {device.last_alert_at ? (
          <>
            <div style={{ color: 'var(--tint-warn-fg)' }}>{alertLabel(device.last_alert_type)}</div>
            <div className="sv-muted" style={{ fontSize: 'var(--text-xs)' }}>{fmtRel(device.last_alert_at)}</div>
          </>
        ) : <span className="sv-muted">—</span>}
      </td>
      <td className="sv-muted">{fmtRel(device.last_seen_at)}</td>
      <td style={{ textAlign: 'right' }}><RowMenu device={device} /></td>
    </tr>
  );
}

// ── Row actions (kebab) ────────────────────────────────────────
// Editing and deleting a device now live on the device detail page, so this menu
// only carries navigation/clipboard actions.
function RowMenu({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="sv-btn ghost sm"
        aria-label={`Actions for ${device.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ padding: '2px 8px', lineHeight: 1.1, fontSize: 'var(--text-md)' }}
      >
        ⋮
      </button>
      {open && (
        <div className="sv-dropdown" role="menu"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 50, minWidth: 168, textAlign: 'left' }}>
          <Link href={`/devices/${device.id}`} className="sv-dropdown-item" role="menuitem"
            style={{ display: 'block' }} onClick={() => setOpen(false)}>
            View details
          </Link>
          {device.site_id != null && (
            <Link href={`/sites/${device.site_id}`} className="sv-dropdown-item" role="menuitem"
              style={{ display: 'block' }} onClick={() => setOpen(false)}>
              View site
            </Link>
          )}
          <div className="sv-dropdown-divider" />
          <button className="sv-dropdown-item" role="menuitem" style={{ width: '100%', textAlign: 'left' }}
            onClick={() => {
              navigator.clipboard?.writeText(device.ip_address);
              setOpen(false);
            }}>
            Copy IP address
          </button>
        </div>
      )}
    </div>
  );
}

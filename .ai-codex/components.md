# SpanVault components (frontend/src/components/)

`(c)` = client component (`'use client'` in the file, or renders hooks so is
effectively client-only even where not marked — noted). All files here are
`.tsx`; none found with an explicit `'use client'` omission that breaks — pages
importing them are already client components.

## Top-level (frontend/src/components/)
- (c) `AgentStatusPill`  status (AgentBits.tsx)
- (c) `AgentLogs`  agentId, online, hubEnrolled? — log tail viewer + refresh; when hubEnrolled (Phase 3, `hub_agent_id` set) renders a "managed by NocVault Hub" note + link instead of the local fetch button (AgentBits.tsx)
- (fn) `getHubUrl`  window.location-derived hub base URL, same per-file-copy pattern as TopBar.tsx/LicenseGuard.tsx (AgentBits.tsx)
- (c) `AgentHealth`  health, online — self-reported host health panel (AgentBits.tsx)
- (c) `AlertBanner`  (no props) — global top-of-shell "X down · X warning" banner, polls /api/dashboard/summary every 30s
- (c) `DeviceForm`  device, sites, initialSiteId?, onClose, onSaved — add/edit device modal
- `SnmpTest`  form — internal to DeviceModals.tsx, not exported (module-private helper for DeviceForm)
- (c) `ImportModal`  onClose, onImported, siteId? — import NetVault devices into monitoring
- `SearchRow`  dot, name, ip, site, onClick — internal to GlobalSearch.tsx, not exported
- `SearchGroup`  label, children — internal to GlobalSearch.tsx, not exported
- (c) `GlobalSearch`  (no props) — Ctrl+K command palette, default export
- (c) `IdleTimeout`  (no props) — session idle-timeout watcher, renders IdleWarningModal
- `IdleWarningModal`  (internal, not exported) — countdown modal shown before auto-signout
- (c) `KeyboardShortcuts`  (no props) — global keybinding handler (default export)
- (c) `LicenseProvider`  children — license state context provider (LicenseGuard.tsx)
- (c) `useLicense`  () — hook reading LicenseProvider's context
- (c) `LicenseBanner`  (no props) — grace-period warning banner
- (c) `LicenseDisabledScreen`  (no props) — full-page block when license fully expired
- (c) `LicenseGate`  children — wraps children, renders LicenseDisabledScreen instead when disabled
- (c) `SVGMapView`  map, refreshUrl?, interactive?, onRefresh? — default export, renders a FullMap live (used by /maps/[id] and the public/wall views)
- (c) `ConnectionLine`  conn, from?, to? — one map connection line (SVGMapView.tsx)
- (c) `DeviceNode`  device, interactive, onClick — one map node, device OR service-check flavored via `service_check_id != null` (SVGMapView.tsx)
- (c) `ShapeEl`  shape — one decorative map shape/glyph (SVGMapView.tsx)
- (c) `MapLabelText`  label — one map text label (SVGMapView.tsx)
- `IndeterminateCheckbox`  checked, indeterminate, onChange — internal to SensorManager.tsx, not exported
- `SensorAlertCell`  rules, busy, onEdit, onClear — internal to SensorManager.tsx, not exported. Just the button on an enabled sensor row ("+ Alert", or "Clear alert"/"Clear N alerts"). Deliberately narrow: the row is a flex whose `.sv-sensor-info` is `flex:1; min-width:0`, so anything wider steals the sensor's own name (a badge here cut it 192px → 69px in 1.107.0, fixed 1.107.3).
- `SensorAlertLine`  rules, unit — internal, not exported. Renders the limit(s) on the row's SECOND line. Takes an ARRAY: nothing prevents two rules on one sensor (no unique index), and showing only one meant "Clear" appeared to remove the alert while a duplicate kept firing.
- `SensorAlertEditor`  deviceId, sensor{key,name,metric_name,unit}, onSaved, onCancel — internal, not exported. The per-sensor alert limit editor (the PRTG model), rendered as its own line BELOW the row. Creates a device-scoped `alert_rules` row carrying that sensor's `sensor_key`. A `unit==='state'` sensor offers "when Down"/"when Up"; anything else takes operator+threshold, with Save disabled on a non-numeric threshold. For an interface GROUP the limit targets the group's Status member, since "this link went down" is the alert that makes sense on a bundle of In/Out/Status.
- (c) `SensorManager`  deviceId, deviceName, onClose, onSaved — default export, sensor discovery + selection modal; also loads the device's sensor rules (`GET /api/alert-rules?scope=device&device_id=`) to render each row's alert state, and warns on save when a still-configured rule now points at a sensor that has been unticked (such a rule can never fire)
- (c) `Sidebar`  (no props) — default export, nav chips, admin-gated items (Agents/Settings)
- (c) `SiteScopeBanner`  (no props) — shown to a site_admin to indicate their scoped view
- `Sparkline`  (props not captured — small SVG trend line component). **Currently imported by nothing**: its only consumer was the devices list's 24h trend column, removed in the 1.88.0 redesign. Kept as a general-purpose primitive rather than deleted; if you need a mini trend chart, this already exists.
- `StatusDot`  (props not captured — animated up/down/warning/unknown dot; down/warning pulse via CSS keyframes)
- (c) `ThemeToggle`  variant='icon'|'item' — default export, light/dark toggle
- (c) `TopBar`  (no props) — default export, user avatar dropdown incl. "NocVault Hub" link (client-derived getHubUrl())
- (c) `TopBarSearch`  (no props) — default export, top-bar search trigger. Queries `/api/global-search` (the SAME endpoint as `GlobalSearch`/Ctrl+K) and renders a per-kind badge; keep the two on one endpoint or their scopes silently diverge again
- `SiteBox`  cluster — internal to TopologyMapView.tsx, not exported
- `Connection`  (topology link line) — internal to TopologyMapView.tsx, not exported
- `DeviceNode` (topology variant) — internal to TopologyMapView.tsx, not exported — NOTE: same name as SVGMapView's exported `DeviceNode`, different module, not a collision (both are module-scoped)
- (c) `TopologyMapView`  nodes, edges, interactive? — default export, LLDP/CDP link map grouped by site. `TopoNode` carries `managed?: boolean` (default true): `managed:false` renders a dashed outlined "ghost" box instead of a status-coloured one and is NOT clickable, because its `device_id` is a synthetic negative id from `/api/topology/map` with no device page behind it
- (c) `UpdateFailureBanner`  (no props) — default export, admin-only (`useRbac().canManageSettings`) red banner surfacing a failed `Update-SpanVault.ps1` run, polls `/api/system/last-update-status` every 5min, dismissible per-timestamp
- (c) `UpdateNotifier`  (no props) — default export, cross-app "update available" banner
- `icons.tsx` — 30+ small `IconX = (p: SVGProps<SVGSVGElement>) => (...)` const exports (IconDashboard, IconDevices, IconAlerts, IconReports, IconMap, IconSettings, IconAgents, IconIntelligence, IconTopology, IconWireless, IconServices, IconHome, IconLogout, IconCheck, IconSearch, IconBell, IconSun, IconMoon, IconWarning, IconEdit, IconTrash, IconRefresh, IconRepeat, IconStar, IconMonitor, IconTool, IconLock, IconUnlock, IconUndo, IconRedo, ...) — no `(c)` marker needed, pure SVG, no hooks
- `n(v)` / `gradeColor(grade)` / `scoreColor(score)` — pure helpers (intel.tsx)
- `GradeBadge`  grade — A-F badge (intel.tsx)
- `ScoreBar`  score, width=120 — 0-100 bar (intel.tsx)
- `StatusBadge`  status (ui.tsx)
- `Loading`  label='Loading…' (ui.tsx)
- `ErrorBox`  message (ui.tsx)
- `Empty`  message (ui.tsx)
- `StatCard`  (props not fully captured — dashboard/list KPI tile, colored border-left) (ui.tsx)

## Report renderers (frontend/src/components/reports/) — one per PDF/print template, all `{ data }`-shaped
- (c) `AlertAnalysisReport`  data: AlertAnalysis
- (c) `ApDetailReport`  data (+ likely selectedMetrics, mirrors DeviceDetailReport's shape)
- (c) `CapacityReport`  data: CapacityRow[]
- (c) `DeviceDetailReport`  data?: DeviceDetail|null, selectedMetrics?: string[]
- (c) `ExecutiveSummaryReport`  data: Executive
- (c) `NetworkSummaryReport`  data: NetworkSummary
- (c) `ReportsCatalog`  reports: CatalogReport[], groupOrder: string[], activeKey: string|null, onSelect: (key)=>void — the reports-page picker/search list, not a print template itself
- (c) `ServiceDetailReport`  data?: ServiceDetail|null, selectedMetrics?: string[]
- (c) `SiteReport`  data: SiteSummary
- (c) `SlaComplianceReport`  data: SlaCompliance
- (c) `TopWorstReport`  data: TopWorst
- (c) `WirelessAPHealthReport`  data: WirelessAPHealth
- (c) `WirelessBandwidthReport`  data: WirelessBandwidth
- (c) `WirelessCapacityReport`  data: WirelessCapacity
- (c) `WirelessClientReport`  data: WirelessClients
- (c) `WirelessOverviewReport`  data: WirelessOverview
- (c) `WirelessRFReport`  data: WirelessRF
- (c) `WirelessSecurityReport`  data: WirelessSecurity
- `reportStyles.ts` — shared style constants/objects for the report renderers above, not a component. Also exports `utilColor(util)` and `dayColor({uptime_pct,total_checks})` helper functions (canonicalised 2026-07 from byte-identical duplicates previously local to WirelessAPHealthReport/WirelessCapacityReport and DeviceDetailReport/ServiceDetailReport respectively)

## Violations
None found. Grepped for nested component-style declarations
(`function ComponentName(...)` / `const ComponentName = (...)` defined inside
another component's function body) across `frontend/src/components/**` and
`frontend/src/app/**` — every sub-component (`SnmpTest`, `SearchRow`,
`SearchGroup`, `IdleWarningModal`, `IndeterminateCheckbox`, `SiteBox`,
`Connection`, the topology `DeviceNode`) is declared at module top level in its
file, just not exported. This matches CLAUDE.md's explicit rule ("NEVER define
a component inside another component — causes remount/focus-loss on every
keystroke") — the codebase currently follows it.

(c) CornersToggle — Rounded/Square segmented row rendered INSIDE the avatar dropdown in TopBar.tsx (uses the sv-dropdown-item class, sits below ThemeToggle variant="item"). Not in Settings: that page is admin-only and this is a per-browser preference every role must reach. Not in the top bar either — it looked wrong there. Reads its value in useEffect, never at render (the <html> attribute does not exist during SSR — reading at render is a hydration mismatch).

## Table sorting (shared, ui.tsx) — added 1.89.0
ONE implementation for every sortable table. Do not hand-roll a comparator or a
header cell: wireless/page.tsx and intelligence/page.tsx each carried a private
copy (SortTh / IntelTH) and both were deleted in favour of this.
```
useTableSort(initial?)      -> { sort, onSort, setSort }; 1st click asc, click again flips
sortRows(rows, sort, accs)  -> NEW array; null/empty LAST in both directions; numbers
                               numeric, ISO dates chronological, strings numeric-aware
SortTh({label,col,sort,onSort,align?,style?}) -> clickable <th> with the shared arrows
```
Rules when adding one: sort AFTER filtering, never instead of it; include the sort in
any useClientPagination resetKey so changing sort returns to page 1; leave
action/checkbox columns as plain <th>; and do NOT make configuration lists sortable
(escalation steps, on-call shifts, notification routes, maintenance windows) — their
existing order carries meaning. 132 sortable columns across 13 files as of 1.89.0.

## Wide-table layout (shared CSS, globals.css) — `.sv-table-scroll` + `.sv-table-pin-actions`
Not components — two GENERIC classes for any `.sv-table` wider than its card.
Currently used by `(app)/services/page.tsx` (9 cols) and `(app)/alerts/page.tsx`
(7 cols); adopt them anywhere else a table outgrows the ~1216px content area.
```
<div className="sv-table-scroll">              <- wrapper DIV, table is its only child
  <table className="sv-table sv-table-pin-actions">
```
- `.sv-table-scroll` — `overflow-x: auto`. Without it a too-wide table either spills
  out of an `overflow: visible` card and off the viewport (the /services bug) or is
  silently cut off by an `overflow: hidden` card (the /alerts bug).
  ⚠ `overflow-x: auto` computes `overflow-y` to `auto` too, so an `absolute`-positioned
  popup inside the table gets clipped by the wrapper. Anchor such menus with
  `position: fixed` measured from the trigger — see `ServiceRowMenu` (services/page.tsx),
  which was converted for exactly this.
- `.sv-table-pin-actions` — pins the LAST column (the actions cell) with
  `position: sticky; right: 0` so it stays reachable while the rest scrolls under it.
  Opaque backgrounds per the suite sticky rule; `:not([colspan])` keeps full-width
  expansion/detail rows out of it, and `> thead >` / `> tbody >` keep NESTED tables out.
  A row that paints its own tint (alerts' `.sv-incident-head`) must also set
  `--sv-row-tint` to the same token, so the pinned cell keeps the tint over its
  opaque base — the `--tint-*` tokens are translucent in dark mode.
- New token `--table-tint-solid` (globals.css `:root` + `[data-theme="dark"]`) — the
  OPAQUE equivalent of `.sv-table`'s th / row-hover surface (`rgba(255,255,255,0.03)`
  over `--bg-card` in dark). Use it for any sticky cell that would otherwise inherit
  that translucent tint.

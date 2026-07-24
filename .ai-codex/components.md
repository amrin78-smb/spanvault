# SpanVault components (frontend/src/components/)

`(c)` = client component (`'use client'` in the file, or renders hooks so is
effectively client-only even where not marked — noted). All files here are
`.tsx`; none found with an explicit `'use client'` omission that breaks — pages
importing them are already client components.

## Top-level (frontend/src/components/)
- (c) `AgentConnectWaiter`  agentId — live "waiting for agent to connect" -> "Connected!" poller (AgentBits.tsx)
- (c) `AgentStatusPill`  status (AgentBits.tsx)
- (c) `AgentInstall`  command — shows the one-line install command with copy button (AgentBits.tsx)
- (c) `AgentLogs`  agentId, online — log tail viewer + refresh (AgentBits.tsx)
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
- (c) `SensorManager`  deviceId, deviceName, onClose, onSaved — default export, sensor discovery + selection modal
- (c) `Sidebar`  (no props) — default export, nav chips, admin-gated items (Agents/Settings)
- (c) `SiteScopeBanner`  (no props) — shown to a site_admin to indicate their scoped view
- `Sparkline`  (props not captured — small SVG trend line component, used across device list/detail)
- `StatusDot`  (props not captured — animated up/down/warning/unknown dot; down/warning pulse via CSS keyframes)
- (c) `ThemeToggle`  variant='icon'|'item' — default export, light/dark toggle
- (c) `TopBar`  (no props) — default export, user avatar dropdown incl. "NocVault Hub" link (client-derived getHubUrl())
- (c) `TopBarSearch`  (no props) — default export, top-bar search trigger
- `SiteBox`  cluster — internal to TopologyMapView.tsx, not exported
- `Connection`  (topology link line) — internal to TopologyMapView.tsx, not exported
- `DeviceNode` (topology variant) — internal to TopologyMapView.tsx, not exported — NOTE: same name as SVGMapView's exported `DeviceNode`, different module, not a collision (both are module-scoped)
- (c) `TopologyMapView`  nodes, edges, interactive? — default export, LLDP/CDP link map grouped by site
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

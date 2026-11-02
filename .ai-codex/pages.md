# SpanVault page tree (frontend/src/app/)

`[client|server] /route — ComponentName — purpose`. All pages except the two
layouts + not-found are `'use client'`. SpanVault has NO local login page — see
gotchas.md — auth happens via `/sso`.

## Route group (app) — main shell, behind SSO auth via middleware.ts
- `[server]` `/` (layout) — `AppLayout` — sidebar + top bar shell, AlertBanner, IdleTimeout, LicenseGate, per-user app-access gate render
- `[client]` `/` — `DashboardPage` — enterprise dashboard: KPI strip, MTTR/MTTA, SLA, capacity, patterns, top-talkers, maintenance, wireless health, recent events (30s auto-refresh). **Sections are URL-backed (`?tab=overview|performance|availability|predictive|activity`)** via `useUrlTab`; the remembered localStorage section is only honoured when the URL names none. Overview opens with `OverviewStateCard`, which states what is outstanding clause by clause and renders an all-clear ONLY when every clause is clear (it replaced AllClearCard/ActiveAlertsCard, whose "no devices down, so nothing above needs attention" showed over 30 live criticals)
- `[client]` `/devices` — `DevicesPage` — inventory table (1.88.0 redesign): per-site collapsible accordions each wrapping a real `<table class="sv-table">` with Device / Type / Vendor+Model / IP / [Version+OS] / Status / Health ring / Last Alert / Last Seen / kebab. Site headers carry status pills + an average health ring. Filters: search, site, type, vendor, status, "More Filters" chips, Expand/Collapse All, 25-sites-per-page pager. NO edit/delete here (moved to the detail page) and no sparklines/trend charts. **Sites are COLLAPSED by default** (1.88.1): state tracks `expandedSites` (opened keys) rather than collapsed ones, because the set is empty before device data loads and empty must mean closed; agent groups use the opposite `collapsedAgents` set so they stay open. A non-empty search sets `forceOpen`, overriding both without overwriting the user's manual toggles
- `[client]` `/devices/[id]` — `DeviceDetailPage` — device detail, organised into URL-backed tabs (`?tab=overview|performance|interfaces|alerts|intelligence|configuration`; Configuration only for `canEdit`). Overview = quick stats + 60-day calendar + neighbours/intelligence/gateway; Performance = latency/loss/sensor charts; Alerts = the full history, paged, always reachable regardless of availability. **Edit + Delete** live in the header and in Configuration
- `[client]` `/sites/[id]` — `SiteDetailPage` — site summary cards, device list, active alerts scoped to the site
- `[client]` `/alerts` — `AlertsPage` — alert list, acknowledge/resolve, filters
- `[client]` `/services` — `ServicesPage` — agentless HTTP/TCP/SSL/DNS checks, multi-type collapsible groups, search + status filter
- `[client]` `/services/[id]` — `ServiceDetailPage` — one service check's detail, alert-rule tab
- `[client]` `/reports` — `ReportsPage` — reports catalog, run/save/schedule, CSV/PDF export
- `[client]` `/maps` — `MapsPage` — network map cards list
- `[client]` `/maps/[id]` — `MapViewPage` — live view of one interactive map (SVGMapView) plus a searchable, selectable **node list** (the semantic alternative to the canvas: status, site, address, freshness and a real detail link per node). Separates "layout last edited" from "status last refreshed"; Edit is `canEdit`-gated; the Public badge reads "anyone with the link can view"
- `[client]` `/maps/[id]/edit` — `MapEditorPage` — drag/resize/align map designer (multi-select, undo/redo, shapes/icons, weathermap link binding)
- `[client]` `/wireless` — `WirelessPage` — **Overview** (renamed from "Wireless Insights"; Intelligence keeps the analytics)/Access Points/SSIDs/Intelligence/Clients/Rogue APs/Controllers. URL-backed via `useUrlTab`, plus exact-entity deep links `?tab=aps&apId=`, `?tab=clients&mac=`, `?tab=controllers&controllerId=` (all three also honoured via the `spanvault:wireless-tab` event, for a push that lands while the page is already open)
- `[client]` `/topology` — `TopologyPage` — LLDP/CDP-discovered link map grouped by site (TopologyMapView)
- `[client]` `/agents` — `AgentsPage` — remote polling agent fleet list, bulk restart/enable/disable/delete (admin-only via canManageAgents). Enrollment moved to the NetVault hub (Phase 4a); page shows a hub note instead of a New Agent button. Cards show a "Hub-managed" badge for `hub_agent_id`-set agents; bulk restart skips hub-managed agents (restart runs via the hub's own command queue) and reports the skip count in the result toast
- `[client]` `/agents/[id]` — `AgentDetailPage` — one agent: rename, restart, log tail, assign sites, discover/adopt devices, host health (no install-command / rotate-key panel — hub owns enrollment, Phase 4a); for a hub-enrolled agent (`hub_agent_id` set) restart/log-fetch are disabled with a note pointing at the hub's Agents page, plus a "Link to existing agent" manual-merge picker (Phase 3 duplicate-row fallback)
- `[client]` `/intelligence` — `IntelligencePage` — anomalies, health scores, capacity forecasts, patterns, incidents, threshold recommendations. URL-backed (`?tab=`); the historical `#anchor` deep link (used by the dashboard's anomaly banner) is still honoured on mount when no `?tab=` is present
- `[client]` `/settings` — `SettingsPage` — **7** tabs: General/Notifications/Escalation & On-Call/Alert Rules/Maintenance/Audit Log/**About & Updates** (admin-only via canManageSettings). Wireless RF alert thresholds live inside General (WIRELESS_ALERT_FIELDS), not their own tab. Updates was folded into About in 1.110.0; **`?tab=updates` is aliased to `about`** in the deep-link effect and must stay — it is live in `UpdateNotifier.tsx` and `UpdateFailureBanner.tsx` and in bookmarks. Every tab renders through the same two-column shell (capped content column + 300px help rail); the four that had no rail of their own go through `TabShell`, which is what keeps the content from resizing between tabs.

## Standalone routes (outside the (app) shell — no sidebar/topbar)
- `[client]` `/sso` — `SsoPage` — posts the hub-issued token to this app's own `/api/sso`, then `signIn('credentials', {ssoToken})`
- `[client]` `/maps/public/[uuid]` — `PublicMapPage` — unauthenticated live view of a map marked `is_public` (GET /api/maps/public/:uuid)
- `[client]` `/maps/wall` — `MapWallPage` — NOC-wall cycling display of maps

## Root-level
- `[server]` `/` (root layout) — `RootLayout` — html/body shell, theme init script, font loading
- `[client]` — `Providers` — SessionProvider wrapper (frontend/src/app/providers.tsx)
- `[client]` — `Error` — App Router error boundary (frontend/src/app/error.tsx)
- `[server]` — `NotFound` — 404 page (frontend/src/app/not-found.tsx)

## URL-backed view state (1.115.0)
Every multi-section page keeps its section in the query string through
`useUrlTab` (`components/ui.tsx`), and `/devices` keeps its filters there via
`setUrlParams`. None of them use `useSearchParams()` — see gotchas.md: it opts
a prerendered client page out of static rendering, and every page here is a
client page. Read on mount AND on `popstate`; write with `pushState` (tabs) or
`replaceState` (filters, so typing does not fill the history).

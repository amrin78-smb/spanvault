# SpanVault page tree (frontend/src/app/)

`[client|server] /route — ComponentName — purpose`. All pages except the two
layouts + not-found are `'use client'`. SpanVault has NO local login page — see
gotchas.md — auth happens via `/sso`.

## Route group (app) — main shell, behind SSO auth via middleware.ts
- `[server]` `/` (layout) — `AppLayout` — sidebar + top bar shell, AlertBanner, IdleTimeout, LicenseGate, per-user app-access gate render
- `[client]` `/` — `DashboardPage` — enterprise dashboard: KPI strip, MTTR/MTTA, SLA, capacity, patterns, top-talkers, maintenance, wireless health, recent events (30s auto-refresh)
- `[client]` `/devices` — `DevicesPage` — inventory table (1.88.0 redesign): per-site collapsible accordions each wrapping a real `<table class="sv-table">` with Device / Type / Vendor+Model / IP / [Version+OS] / Status / Health ring / Last Alert / Last Seen / kebab. Site headers carry status pills + an average health ring. Filters: search, site, type, vendor, status, "More Filters" chips, Expand/Collapse All, 25-sites-per-page pager. NO edit/delete here (moved to the detail page) and no sparklines/trend charts. **Sites are COLLAPSED by default** (1.88.1): state tracks `expandedSites` (opened keys) rather than collapsed ones, because the set is empty before device data loads and empty must mean closed; agent groups use the opposite `collapsedAgents` set so they stay open. A non-empty search sets `forceOpen`, overriding both without overwriting the user's manual toggles
- `[client]` `/devices/[id]` — `DeviceDetailPage` — device detail: graphs, sensors, interfaces, dependencies, uptime calendar, quick stats, "Ping Now", **Edit + Delete** (moved here from the list in 1.88.0; delete routes back to `/devices`)
- `[client]` `/sites/[id]` — `SiteDetailPage` — site summary cards, device list, active alerts scoped to the site
- `[client]` `/alerts` — `AlertsPage` — alert list, acknowledge/resolve, filters
- `[client]` `/services` — `ServicesPage` — agentless HTTP/TCP/SSL/DNS checks, multi-type collapsible groups, search + status filter
- `[client]` `/services/[id]` — `ServiceDetailPage` — one service check's detail, alert-rule tab
- `[client]` `/reports` — `ReportsPage` — reports catalog, run/save/schedule, CSV/PDF export
- `[client]` `/maps` — `MapsPage` — network map cards list
- `[client]` `/maps/[id]` — `MapViewPage` — live view of one interactive map (SVGMapView)
- `[client]` `/maps/[id]/edit` — `MapEditorPage` — drag/resize/align map designer (multi-select, undo/redo, shapes/icons, weathermap link binding)
- `[client]` `/wireless` — `WirelessPage` — Overview/Intelligence/Controllers/Clients/SSIDs/Rogue-APs tabs, 897-line entry point
- `[client]` `/topology` — `TopologyPage` — LLDP/CDP-discovered link map grouped by site (TopologyMapView)
- `[client]` `/agents` — `AgentsPage` — remote polling agent fleet list, bulk restart/enable/disable/delete (admin-only via canManageAgents). Enrollment moved to the NetVault hub (Phase 4a); page shows a hub note instead of a New Agent button. Cards show a "Hub-managed" badge for `hub_agent_id`-set agents; bulk restart skips hub-managed agents (restart runs via the hub's own command queue) and reports the skip count in the result toast
- `[client]` `/agents/[id]` — `AgentDetailPage` — one agent: rename, restart, log tail, assign sites, discover/adopt devices, host health (no install-command / rotate-key panel — hub owns enrollment, Phase 4a); for a hub-enrolled agent (`hub_agent_id` set) restart/log-fetch are disabled with a note pointing at the hub's Agents page, plus a "Link to existing agent" manual-merge picker (Phase 3 duplicate-row fallback)
- `[client]` `/intelligence` — `IntelligencePage` — anomalies, health scores, capacity forecasts, patterns, incidents, threshold recommendations (multi-tab)
- `[client]` `/settings` — `SettingsPage` — 8 tabs: General/Notifications/Escalation & On-Call/Alert Rules/Maintenance/Audit Log/Updates/About (admin-only via canManageSettings). Wireless RF alert thresholds live inside General (WIRELESS_ALERT_FIELDS), not their own tab.

## Standalone routes (outside the (app) shell — no sidebar/topbar)
- `[client]` `/sso` — `SsoPage` — posts the hub-issued token to this app's own `/api/sso`, then `signIn('credentials', {ssoToken})`
- `[client]` `/maps/public/[uuid]` — `PublicMapPage` — unauthenticated live view of a map marked `is_public` (GET /api/maps/public/:uuid)
- `[client]` `/maps/wall` — `MapWallPage` — NOC-wall cycling display of maps

## Root-level
- `[server]` `/` (root layout) — `RootLayout` — html/body shell, theme init script, font loading
- `[client]` — `Providers` — SessionProvider wrapper (frontend/src/app/providers.tsx)
- `[client]` — `Error` — App Router error boundary (frontend/src/app/error.tsx)
- `[server]` — `NotFound` — 404 page (frontend/src/app/not-found.tsx)

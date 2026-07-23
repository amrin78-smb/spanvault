# SpanVault page tree (frontend/src/app/)

`[client|server] /route — ComponentName — purpose`. All pages except the two
layouts + not-found are `'use client'`. SpanVault has NO local login page — see
gotchas.md — auth happens via `/sso`.

## Route group (app) — main shell, behind SSO auth via middleware.ts
- `[server]` `/` (layout) — `AppLayout` — sidebar + top bar shell, AlertBanner, IdleTimeout, LicenseGate, per-user app-access gate render
- `[client]` `/` — `DashboardPage` — enterprise dashboard: KPI strip, MTTR/MTTA, SLA, capacity, patterns, top-talkers, maintenance, wireless health, recent events (30s auto-refresh)
- `[client]` `/devices` — `DevicesPage` — PRTG-style devices list, per-site collapsible accordions, status pills, inline CPU/mem/ping badges
- `[client]` `/devices/[id]` — `DeviceDetailPage` — device detail: graphs, sensors, interfaces, dependencies, uptime calendar, quick stats, "Ping Now"
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
- `[client]` `/agents` — `AgentsPage` — remote polling agent fleet list, bulk enable/disable/delete (admin-only via canManageAgents)
- `[client]` `/agents/[id]` — `AgentDetailPage` — one agent: rename, restart, log tail, rotate key, discover/adopt devices, host health
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

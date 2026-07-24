# SpanVault API routes

Real API surface = Express app in `api/server.js` (195 routes, port 3009, loopback-only,
proxied by `frontend/src/middleware.ts`) + 1 Next.js route (NextAuth catch-all). A
Next.js route anywhere else under `frontend/src/app/api/**` is DEAD CODE — see
`.ai-codex/gotchas.md`.

**Express routes: no `force-dynamic` concept applies** (that's a Next.js App Router
export; Express has no static/dynamic rendering split).

Auth legend: `public` = no session needed (in middleware's `PUBLIC_API` regex or
served pre-auth like the agent installer files); `auth` = valid NextAuth session
required (proxy blocks otherwise); `auth+write:site_admin+` = mutating verb needs
role rank >= site_admin (viewer blocked); `auth+write:admin+` = mutating verb needs
role rank >= admin (`ADMIN_ONLY_WRITE` regex list in server.js); `loopback` =
`requireLoopback` guard, 127.0.0.1/::1 only, unreachable via the frontend proxy at all
(collector-to-API service call). GET routes are never role-gated beyond "has a
session" — only POST/PUT/PATCH/DELETE hit the RBAC rank check.
`db` = spanvault Postgres (`sv` pool) and/or netvault Postgres (`nv` pool, read-only).
`external` = SNMP/ICMP/HTTP to a device, wireless controller, or the NocVault hub.

Site-scoping: most list/detail GETs call `getSiteFilter(req)` to restrict a
`site_admin` to their assigned sites (via `x-user-sites` header set by the proxy).
Noted per-route only where notable (recently fixed gaps, or routes that
deliberately skip it).

## Internal (loopback only, bypasses frontend proxy entirely)
- `POST /api/internal/agents/push-config` [loopback] [db] — collector notifies API to re-push agent config after a site reassignment; registered before enforceLicense/RBAC so it works during license grace/disabled

## Agent bootstrap files (unauthenticated — no session possible pre-install)
- `GET /api/agent/install.ps1` [public] — serves the agent installer script
- `GET /api/agent/agent.js` [public] — serves the agent runtime
- `GET /api/agent/package.json` [public] — serves the agent's package.json
- `GET /api/agent/agent.js.sha256` [public] — sha256 + version of the bundled agent.js, for install-time integrity check
- `GET /api/agent/nssm.exe` [public] — serves NSSM binary (own bundle, or NetVault's, or SV_NSSM_PATH) so a remote host doesn't need internet access to nssm.cc
- `GET /api/agent/nssm.exe.sha256` [public] — sha256 of the served nssm.exe

## Health / stats / system
- `GET /api/health` [public] [db] — liveness + version, used by suite health checks
- `GET /api/stats` [public] [db] — 3 aggregate counts (monitored_devices/availability/active_alerts) for the NocVault launcher tile; never 500s, degrades to zeros
- `GET /api/system/update-status` [auth] [external] — compares local vs origin/main git commit hash over git transport (not GitHub REST — avoids per-IP rate limiting)
- `GET /api/system/update-available` [public] [external] — cached (24h refresh) update-available flag for the cross-app notifier banner
- `GET /api/system/last-update-status` [public] — reads logs/last-update-status.json written by Update-SpanVault.ps1 (stage/error code/rollback outcome of the last update run); {exists:false} if none yet. Same access level as update-available (exempted from enforceLicense's disabled block, but NOT in middleware.ts's PUBLIC_API allowlist since it's only ever fetched from the already-authenticated app shell). Feeds UpdateFailureBanner.tsx.
- `POST /api/system/update` [auth+write:admin+] [external] — schedules a one-time Windows Scheduled Task (SYSTEM account) running `installer/Update-SpanVault.ps1`; blocked during license grace/disabled
- `GET /api/license-status` [auth] [external] — cached (24h) license status from the NocVault licensing service
- `GET /api/collector/status` [auth] [db] — 'running' if collector heartbeat in app_settings is <2min old
- `GET /api/hub/settings` [auth] [external] — server-to-server proxy of the hub's `/api/settings` (avoids CORS)
- `POST /api/sso` [public] [external] — server-to-server proxy of hub's `/api/auth/sso-verify`; the ONE deliberately-unauthenticated write (it's how a session is created); exempt from RBAC write-gate and license write-block

## Dashboard
- `GET /api/dashboard/summary` [auth] [db] — up/down/warning/unknown counts + agent-offline + active alerts + agent online count
- `GET /api/dashboard/agent-offline` [auth] [db] — devices unreachable because their polling agent is offline, grouped by agent
- `GET /api/dashboard/problems` [auth] [db] — every device currently down/warning, worst first; suppressed devices hidden (covered by their gateway's entry)
- `GET /api/dashboard/top-worst` [auth] [db] — top 10 by avg response time, last 1h
- `GET /api/dashboard/network-trend` [auth] [db] — 24h availability trend in 30-min buckets
- `GET /api/dashboard/site-health` [auth] [db] — per-site device counts + 24h uptime
- `GET /api/dashboard/events` [auth] [db] — last 20 alerts triggered/resolved in 24h; LEFT JOINs device/service/wireless since alert rows can have device_id=NULL
- `GET /api/dashboard/ops-summary` [auth] [db] — MTTR/MTTA (30d avg) + unacknowledged count + open incidents
- `GET /api/dashboard/incidents` [auth] [db] — latest 10 open incidents with root-cause device
- `GET /api/dashboard/sla` [auth] [db] — 30-day rolling SLA % + per-device breaches vs configurable target (default 99.5%)
- `GET /api/dashboard/capacity` [auth] [db] — devices with CPU/mem p95 >= 80% (approaching capacity)
- `GET /api/dashboard/patterns` [auth] [db] — top recurring alert patterns by confidence/frequency
- `GET /api/dashboard/least-reliable` [auth] [db] — worst alert offenders, last 30 days
- `GET /api/dashboard/top-talkers` [auth] [db] — busiest interfaces by recent throughput (~15min window)
- `GET /api/dashboard/maintenance` [auth] [db] — maintenance windows active now + upcoming 7 days (device or service-check scoped)
- `GET /api/dashboard/wireless-intel` [auth] [db] — network-wide wireless intelligence rollup for the dashboard card

## Devices
- `GET /api/devices` [auth] [db] — list with live status/latency/CPU/mem/uptime lateral joins; filters status/site_id/q
- `GET /api/global-search` [auth] [db] — Ctrl+K search across devices/APs/controllers/service checks, all site-scoped
- `GET /api/devices/sparklines` [auth] [db] — 24 hourly buckets of response_ms/cpu/mem per device id; registered BEFORE `/:id` so Express doesn't treat "sparklines" as an id
- `GET /api/devices/:id` [auth] [db]
- `POST /api/devices` [auth+write:site_admin+] [db] — auto-assigns a polling agent by site if one owns it
- `PUT /api/devices/:id` [auth+write:site_admin+] [db] — pushes updated SNMP creds to the owning agent immediately if agent-polled
- `DELETE /api/devices/:id` [auth+write:site_admin+] [db]
- `GET /api/devices/:id/ping-history` [auth] [db] — bucketed
- `GET /api/devices/:id/snmp-history` [auth] [db] — bucketed, per metric, optionally per interface
- `GET /api/devices/:id/alerts` [auth] [db]
- `GET /api/devices/:id/uptime-calendar` [auth] [db] — day-by-day; device_down alerts = incidents that day
- `GET /api/devices/:id/quick-stats` [auth] [db] — 30d uptime, 7d avg response vs baseline, 30d alert count, health score
- `GET /api/devices/:id/interfaces` [auth] [db] — latest per-interface status + traffic
- `GET /api/devices/:id/connected` [auth] [db] — topology neighbors
- `GET /api/devices/:id/dependencies` [auth] [db]
- `POST /api/devices/:id/dependencies` [auth+write:site_admin+] [db] — set/clear parent for alert suppression
- `GET /api/dependencies/tree` [auth] [db] — full flat tree with depth
- `POST /api/devices/:id/ping-now` [auth+write:site_admin+] [external] — on-demand single ICMP probe, no history write
- `POST /api/devices/:id/set-gateway` [auth+write:site_admin+] [db] — marks device as its site's gateway (clears any existing one first)
- `POST /api/devices/:id/clear-gateway` [auth+write:site_admin+] [db]
- `POST /api/devices/:id/snmp-discover` [auth+write:site_admin+] [external] — walks device, returns grouped available sensors
- `GET /api/devices/:id/sensors` [auth] [db]
- `PUT /api/devices/:id/sensors` [auth+write:site_admin+] [db] — upserts sensor selection
- `POST /api/devices/:id/sensors/custom` [auth+write:site_admin+] [db] — create custom OID sensor
- `DELETE /api/devices/:id/sensors/custom/:sensor_id` [auth+write:site_admin+] [db] — custom sensors only
- `POST /api/devices/:id/snmp-test` [auth+write:site_admin+] [external] — test reachability with stored credentials
- `POST /api/snmp-test-adhoc` [auth+write:site_admin+] [external] — test with ad-hoc credentials before a device is saved

## NetVault integration (read-only source)
- `GET /api/netvault/devices` [auth] [db] — NetVault devices not yet monitored (netvault.devices.ip_address is `character varying`, NOT inet — never add a host() cast)
- `POST /api/netvault/import` [auth+write:site_admin+] [db] — import selected NetVault devices into monitoring
- `GET /api/netvault/sites` [auth] [db] — for map + filters

## Distributed polling agents
- `GET /api/agents` [auth] [db] — all agents with device counts + assigned sites
- `POST /api/agents` [auth+write:admin+] [db] — generates api_key, assigns sites, auto-assigns devices
- `GET /api/agents/:id` [auth] [db] — secret fields redacted rather than 403ing the whole route
- `PUT /api/agents/:id` [auth+write:admin+] [db] — rename
- `POST /api/agents/:id/rotate-key` [auth+write:admin+] [db] — old key invalid immediately; connected agent dropped
- `POST /api/agents/:id/disabled` [auth+write:admin+] [db] — disable/enable without deleting; drops live socket, refuses handshakes
- `DELETE /api/agents/:id` [auth+write:admin+] [db] — devices fall back to local polling (agent_id -> NULL)
- `POST /api/agents/:id/sites` [auth+write:admin+] [db] — replace site assignments + re-derive device ownership
- `POST /api/agents/:id/restart` [auth+write:admin+] [external] — WS message; agent exits, NSSM restarts it
- `POST /api/agents/:id/logs/refresh` [auth+write:admin+] [external] — WS request for fresh log tail
- `GET /api/agents/:id/logs` [auth] [db] — most recent pushed log tail (may be empty until refreshed)
- `POST /api/agents/:id/discover` [auth+write:admin+] [external] — trigger subnet sweep on agent (must be online)
- `GET /api/agents/:id/discovered` [auth] [db] — discovered candidates, flags already-monitored
- `POST /api/agents/:id/discovered/adopt` [auth+write:admin+] [db] — adopt into monitoring, keeps discovered SNMP community/version

## Alerts / alert rules
- `GET /api/alerts` [auth] [db] — site-scoped via device OR service-check site (device_id can be NULL)
- `POST /api/alerts/:id/acknowledge` [auth+write:site_admin+] [db] — attributed to verified session user, not client-supplied
- `POST /api/alerts/:id/resolve` [auth+write:site_admin+] [db]
- `GET /api/alert-rules` [auth] [db]
- `GET /api/alert-rules/effective/:device_id` [auth] [db] — effective ruleset after global->site->device inheritance
- `GET /api/alert-rules/effective-service/:service_check_id` [auth] [db] — same, namespaced to SERVICE_METRICS
- `POST /api/alert-rules` [auth+write:admin+] [db]
- `PUT /api/alert-rules/:id` [auth+write:admin+] [db]
- `DELETE /api/alert-rules/:id` [auth+write:admin+] [db]

## Network map (devices grouped by site) + interactive map designer
- `GET /api/map` [auth] [db] — legacy simple map, devices grouped by site
- `GET /api/maps` [auth] [db] — list with device count
- `POST /api/maps` [auth+write:site_admin+] [db]
- `GET /api/maps/:id` [auth] [db] — full map: properties + content + live device status
- `PUT /api/maps/:id` [auth+write:site_admin+] [db] — properties only
- `DELETE /api/maps/:id` [auth+write:site_admin+] [db] — cascades devices/connections/labels
- `PUT /api/maps/:id/layout` [auth+write:site_admin+] [db] — full replace of devices/shapes/connections/labels; remaps client-temp ids to real ids
- `POST /api/maps/:id/background` [auth+write:site_admin+] [db] — bg_image_b64=null/'' clears it
- `POST /api/maps/:id/toggle-public` [auth+write:site_admin+] [db]
- `GET /api/maps/public/:uuid` [public] [db] — only resolves when is_public=TRUE; unauthenticated share view

## Topology discovery (LLDP/CDP)
- `POST /api/topology/discover` [auth+write:admin+] [external] — triggers async job, poll /status for completion
- `GET /api/topology/status` [auth] [db] — live run flag + derived last-run/link counts
- `GET /api/topology/links` [auth] [db] — all discovered links, both ends joined; `?device_id=` scopes
- `GET /api/topology/map` [auth] [db] — map-friendly nodes (only devices with >=1 link) + edges
- `POST /api/topology/apply-to-map/:map_id` [auth+write:admin+] [db] — grid-places new devices, preserves positioned ones, recreates connections
- `POST /api/topology/apply-dependencies` [auth+write:admin+] [db] — suggests site gateways from topology fan-out

## Wireless — controllers
- `GET /api/wireless/controllers` [auth] [db]
- `GET /api/wireless/controllers/overview` [auth] [db]
- `GET /api/wireless/controllers/events` [auth] [db] — recent events across all controllers (client events + alerts)
- `POST /api/wireless/controllers` [auth+write:admin+] [db] — SNMP path can create the monitored device inline
- `PUT /api/wireless/controllers/:id` [auth+write:admin+] [db]
- `DELETE /api/wireless/controllers/:id` [auth+write:admin+] [db]
- `POST /api/wireless/controllers/:id/ha-peer` [auth+write:admin+] [db] — manual HA pairing (platforms without SNMP HA exposure); sets both sides
- `POST /api/wireless/controllers/rescan` [auth+write:admin+] [external] — on-demand autoDetectControllers() run
- `POST /api/wireless/controllers/:id/test` [auth+write:admin+] [external] — "dry run" — see gotchas.md, NOT write-free for aruba_central (rotating token persistence)
- `POST /api/wireless/controllers/:id/probe` [auth+write:admin+] [external] — one-time OID capability probe, stores capability->OID map
- `GET /api/wireless/debug` [auth] [db] — admin-oriented diagnostic dump of wireless tables
- `GET /api/wireless/debug/walk` [auth] [external] — live SNMP walk of metadata OIDs for a controller (finds real OIDs)
- `GET /api/wireless/debug/walk-oid` [auth] [external] — walk one arbitrary OID subtree

## Wireless — access points / summary / SSIDs
- `GET /api/wireless/aps` [auth] [db] — includes live congestion_score/congestion_level (see gotchas.md, display-only 15-min window)
- `GET /api/wireless/aps/:id` [auth] [db] — RBAC site-scoping fixed 2026-07-22 bug sweep (was missing; sibling list + `/clients` already had it) — see gotchas.md
- `GET /api/wireless/history/:ap_id` [auth] [db] — client/utilization history, bucketed by range
- `GET /api/wireless/summary` [auth] [db] — overview tab + dashboard card
- `GET /api/wireless/ssids` [auth] [db]
- `GET /api/wireless/ssids/summary` [auth] [db]
- `GET /api/wireless/aps/:id/clients` [auth] [db] — site-scoped (fixed alongside the mac/history routes below)

## Wireless — intelligence
- `GET /api/wireless/intelligence` [auth] [db] — registered BEFORE `/summary` and `/:controller_id`... actually see next 2 (order matters so Express doesn't match "summary" as an id)
- `GET /api/wireless/intelligence/summary` [auth] [db]
- `GET /api/wireless/intelligence/:controller_id` [auth] [db]

## Wireless — clients / rogues
- `GET /api/wireless/clients` [auth] [db]
- `GET /api/wireless/clients/summary` [auth] [db]
- `GET /api/wireless/rogues` [auth] [db] — returns [] gracefully if table not yet migrated
- `GET /api/wireless/clients/:mac` [auth] [db] — site-scoped (2026-07 security fix: previously readable cross-site by MAC)
- `GET /api/wireless/clients/:mac/history` [auth] [db] — site-scoped (same fix)

## Reports (many support `?format=csv`)
- `GET /api/reports/availability` [auth] [db]
- `GET /api/reports/response-time` [auth] [db]
- `GET /api/reports/alerts` [auth] [db]
- `GET /api/reports/sla` [auth] [db]
- `GET /api/reports/sla/summary` [auth] [db]
- `GET /api/reports/bandwidth` [auth] [db]
- `GET /api/reports/saved` [auth] [db] — per-user via created_by
- `POST /api/reports/saved` [auth+write:site_admin+] [db]
- `PUT /api/reports/saved/:id` [auth+write:site_admin+] [db] — recomputes next_run_at
- `POST /api/reports/saved/:id/run-now` [auth+write:site_admin+] [db+external] — runs + emails immediately, doesn't change next_run_at
- `GET /api/reports/saved/:id/history` [auth] [db]
- `DELETE /api/reports/saved/:id` [auth+write:site_admin+] [db]
- `GET /api/reports/network-summary` [auth] [db] — always all devices
- `GET /api/reports/site-summary` [auth] [db]
- `GET /api/reports/device-detail` [auth] [db]
- `GET /api/reports/sla-compliance` [auth] [db] — rows + summary in one response
- `GET /api/reports/top-worst` [auth] [db]
- `GET /api/reports/alert-analysis` [auth] [db] — site scoping applies to device OR service-check branch
- `GET /api/reports/capacity` [auth] [db]
- `GET /api/reports/executive` [auth] [db]
- `GET /api/reports/pdf/:template` [auth] [db] — pdfkit render via `api/reportsPdf.js`; only templates with a renderer accepted, else 404; DB/stack errors never leaked
- `GET /api/reports/wireless-overview` [auth] [db] — `?controller_id=` optionally scopes
- `GET /api/reports/wireless-ap-health` [auth] [db]
- `GET /api/reports/wireless-clients` [auth] [db]
- `GET /api/reports/wireless-rf` [auth] [db]
- `GET /api/reports/wireless-capacity` [auth] [db]
- `GET /api/reports/wireless-security` [auth] [db]
- `GET /api/reports/wireless-bandwidth` [auth] [db]
- `GET /api/reports/ap-detail/:id` [auth] [db] — RBAC: site_admin restricted to AP in an assigned site
- `GET /api/reports/service-detail` [auth] [db] — RBAC: site_admin restricted to a service check in an assigned site (this + `/api/service-checks/:id[/results]` were the isolated site-scoping-gap batch — see gotchas.md)

## Settings / audit / notification routing
- `GET /api/settings` [auth] [db]
- `GET /api/audit` [auth] [db] — admin-only in practice (UI-gated); recent successful mutations
- `PUT /api/settings` [auth+write:admin+] [db]
- `GET /api/notification-routes` [auth] [db]
- `POST /api/notification-routes` [auth+write:admin+] [db]
- `PUT /api/notification-routes/:id` [auth+write:admin+] [db]
- `DELETE /api/notification-routes/:id` [auth+write:admin+] [db]

## Service checks (HTTP/TCP/SSL/DNS, agentless)
- `GET /api/service-checks` [auth] [db]
- `POST /api/service-checks` [auth+write:admin+] [db] — can create one check per selected type in one call
- `PUT /api/service-checks/:id` [auth+write:admin+] [db]
- `DELETE /api/service-checks/:id` [auth+write:admin+] [db]
- `DELETE /api/service-checks/group/:groupId` [auth+write:admin+] [db] — deletes every check in a multi-type group
- `PUT /api/service-checks/group/:groupId` [auth+write:admin+] [db] — edits group as a unit, reconciles which types are monitored
- `GET /api/service-checks/:id` [auth] [db] — RBAC site-scoping fixed (was the gap alongside `/results`, see gotchas.md)
- `GET /api/service-checks/:id/results` [auth] [db] — RBAC site-scoping fixed (same batch)

## Escalation / on-call / maintenance windows
- `GET /api/escalation-steps` [auth] [db]
- `POST /api/escalation-steps` [auth+write:admin+] [db]
- `DELETE /api/escalation-steps/:id` [auth+write:admin+] [db]
- `GET /api/oncall-shifts` [auth] [db]
- `POST /api/oncall-shifts` [auth+write:admin+] [db]
- `DELETE /api/oncall-shifts/:id` [auth+write:admin+] [db]
- `GET /api/maintenance` [auth] [db]
- `POST /api/maintenance` [auth+write:admin+] [db]
- `DELETE /api/maintenance/:id` [auth+write:admin+] [db]

## Intelligence layer (api/intelligence.js analytics)
- `GET /api/intelligence/overview` [auth] [db] — network-wide summary for Overview tab + dashboard card
- `GET /api/intelligence/health` [auth] [db] — health scores; service checks have no anomaly component (always anomalies_7d=0)
- `GET /api/intelligence/anomalies` [auth] [db] — filter by status/device
- `PATCH /api/intelligence/anomalies/:id` [auth+write:admin+] [db] — sets review status (active/resolved/reviewed/suppressed/escalated); engine leaves human-reviewed rows alone
- `POST /api/intelligence/anomalies/:id/create-rule` [auth+write:admin+] [db] — creates an alert rule that fires on a comparable deviation
- `GET /api/intelligence/capacity` [auth] [db] — on-demand capacity forecast for one device
- `GET /api/intelligence/patterns` [auth] [db] — all or by device
- `GET /api/intelligence/incidents` [auth] [db] — correlated incidents with root cause + affected devices
- `GET /api/intelligence/thresholds` [auth] [db] — smart threshold recommendations, highest confidence first
- `POST /api/intelligence/thresholds/:device_id/apply` [auth+write:admin+] [db]
- `GET /api/intelligence/device/:id` [auth] [db] — consolidated summary for device detail card
- `POST /api/intelligence/baselines/recompute` [auth+write:admin+] [db] — manual full recompute (testing/refresh)

## WebSocket server (api/ws-server.js, port 3010, all interfaces — not HTTP routes)
Not Express routes; a `ws` `WebSocketServer` remote agents connect to. Handshake auth
via `Authorization` header (API key) or legacy URL param. Handles `message`/`close`/
`error` per-socket. Exports `startWsServer`, `connectedAgents`, `agentLogs`,
`pushConfigToAgentId`, `sendToAgentId`, `disconnectAgent`, `agentMeta` — consumed by
`api/server.js` for the `/api/agents/*` routes above.

## Next.js routes (frontend/src/app/api/)
- `GET|POST /api/auth/[...nextauth]` [public bootstrap / auth thereafter] — NextAuth catch-all (`frontend/src/lib/auth.ts` authOptions); the ONLY real Next.js API route in this app — middleware explicitly never touches `/api/auth/*`

## Needs force-dynamic
None. Only one Next.js route handler exists (`api/auth/[...nextauth]/route.ts`), and
NextAuth's own handler manages its own caching/dynamic behavior — a
`force-dynamic` export is not applicable/needed here. No other `frontend/src/app/api/**`
route exists to check (see the dead-code corollary in gotchas.md for why one
was attempted and removed).

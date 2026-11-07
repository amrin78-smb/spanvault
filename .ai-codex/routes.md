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
role rank >= admin (`ADMIN_ONLY_WRITE` regex list in server.js);
`auth+read:admin+` = **the READ needs admin rank too** (added 1.115.9 — see below);
`loopback` = `requireLoopback` guard, 127.0.0.1/::1 only, unreachable via the frontend
proxy at all (collector-to-API service call).

⛔ **"GET routes are never role-gated beyond having a session" USED to be true here
and is no longer.** `ADMIN_ONLY_WRITE` only covers POST/PUT/PATCH/DELETE, which left
several families whose PAGE is admin-only in the UI answering every GET to any
authenticated session — the "page guarded, API wide open" failure mode CLAUDE.md
names as recurring. Since 1.115.9 four families carry a `requireAdminRead` **MOUNT**
guard (all methods): `/api/agents`, `/api/netvault/devices`, `/api/netvault/import`,
`/api/notification-routes`, `/api/escalation-steps`, `/api/oncall-shifts`; plus a
per-route gate on `GET /api/system/update-status`. They are mount guards, not
per-route checks, for the same reason GUARD 1 on `/api/devices` is one: a route added
to the family later inherits it rather than being the one that got missed.
`db` = spanvault Postgres (`sv` pool) and/or netvault Postgres (`nv` pool, read-only).
`external` = SNMP/ICMP/HTTP to a device, wireless controller, or the NocVault hub.

Site-scoping: most list/detail GETs call `getSiteFilter(req)` to restrict a
`site_admin` to their assigned sites (via `x-user-sites` header set by the proxy).
Noted per-route only where notable (recently fixed gaps, or routes that
deliberately skip it). `[site-scoped 1.115.9]` marks a route the 2026-11 sweep fixed.

⛔ **The predicates themselves now live in `api/rbacScope.js`, not inline here** —
`getSiteFilter`, `siteFilterClause`, `rowInScope` (the ONE per-row check; don't
hand-roll an eleventh), `siteWritable` (payload-supplied site on a write),
`mapOutOfScopeSql`, `makeDeviceScopeGuard` (GUARD 1's body), `NOT_FOUND` (the shared
404 bodies), `pickHubFetchOrigin` and `mailErrorSummary`. They were extracted because
`api/server.js` cannot be required by a test (two pools + a bound WS port), so the
rules deciding what a `site_admin` sees had zero coverage in a codebase whose own
gotchas.md records this bug class five times. Suite: `npm run test:rbac`.

⛔ **404, NOT 403, for an out-of-scope row.** Every id-keyed scope check now answers
with a body BYTE-IDENTICAL to its own not-found branch, because the old 403/404 split was an enumeration oracle: walking
`/api/devices/1..5000` mapped the exact device-id population of the estate, and the
same walk on `/api/wireless/clients/:mac` revealed whether a MAC is present anywhere.
DDIVault (`/api/scopes/:scopeId/history`) and LogVault already did this. The one
deliberate exception is `POST /api/reports/saved`, `PUT /api/maps/:id/layout` and
the `site_id` checks on `POST`/`PUT /api/devices`, which stay **403**: those validate
values the caller SUPPLIED, they are not probes for a resource's existence.
For the `/api/devices/:id…` family — the one the enumeration walk actually targets —
the two branches share the frozen `NOT_FOUND.device` OBJECT (GUARD 1's body and the
route's own 404), so they cannot drift apart at all. The other families still hold
byte-identical literals; if you touch one, change both branches.

## Internal (loopback only, bypasses frontend proxy entirely)
- `POST /api/internal/agents/push-config` [loopback] [db] — collector notifies API to re-push agent config after a site reassignment; registered before enforceLicense/RBAC so it works during license grace/disabled
- `POST /api/internal/agents/disconnect` [loopback] [db] — hub calls this on agent revoke to actively kick a live WS session; body {hub_agent_id} → resolves local agents.id → disconnectAgent; no-op 200 if not connected/linked; registered before enforceLicense/RBAC (Phase 3)
- `POST /api/internal/agents/forget` [loopback] [db] — hub-driven removal of a hub-enrolled agent's local row after the hub deletes it; shares `deleteAgentRow()` with the admin DELETE (devices released to central polling, live socket dropped); registered before enforceLicense/RBAC like its siblings (1.86.3)

## Health / stats / system
- `GET /api/health` [public] [db] — liveness + version, used by suite health checks
- `GET /api/stats` [public] [db] — 3 aggregate counts (monitored_devices/availability/active_alerts) for the NocVault launcher tile; never 500s, degrades to zeros
- `GET /api/system/update-status` [auth+read:admin+] [external] — compares local vs origin/main git commit hash over git transport (not GitHub REST — avoids per-IP rate limiting). **Admin READ gate added 1.115.9**: `POST /api/system/update` was already rank >= 2 via `ADMIN_ONLY_WRITE`'s `/^\/api\/system\//` while this GET had no role gate at all, so any viewer could read the deployed and upstream commit hashes plus the release notes. Its only consumer is the Settings page, already `canManageSettings`. The POST was deliberately NOT raised to super_admin to match LogVault/DDIVault — see gotchas.md
- `GET /api/system/update-available` [auth] [external] — cached (24h refresh) update-available flag for the cross-app notifier banner. **NOT in middleware's `PUBLIC_API`** (the `[public]` label here was wrong until 1.115.5); its only consumer, `UpdateNotifier.tsx`, lives in `(app)/layout.tsx` and always has a session.
- `GET /api/system/last-update-status` [public] — reads logs/last-update-status.json written by Update-SpanVault.ps1 (stage/error code/rollback outcome of the last update run); {exists:false} if none yet. Same access level as update-available (exempted from enforceLicense's disabled block, but NOT in middleware.ts's PUBLIC_API allowlist since it's only ever fetched from the already-authenticated app shell). Feeds UpdateFailureBanner.tsx.
- `POST /api/system/update` [auth+write:admin+] [external] — schedules a one-time Windows Scheduled Task (SYSTEM account) running `installer/Update-SpanVault.ps1`; blocked during license grace/disabled; also returns `409` if the script's own `logs\update.lock` shows a run already in progress (1.83.18 concurrency guard — see gotchas.md)
- `GET /api/license-status` [public] [external] — cached (24h) license status from the NocVault licensing service. **Public since 1.115.5, and it must stay that way:** `LicenseProvider` is mounted in the ROOT layout, so this is fetched by `/sso` and `/maps/public/*`, which render with no session. While it was `[auth]` the 401 crashed those pages outright (see gotchas.md).
- `GET /api/collector/status` [auth] [db] — 'running' if collector heartbeat in app_settings is <2min old
- `GET /api/hub/settings` [auth] [external] — server-to-server proxy of the hub's `/api/settings` (avoids CORS)
- `POST /api/sso` [public] [external] — server-to-server proxy of hub's `/api/auth/sso-verify`; the ONE deliberately-unauthenticated write (it's how a session is created); exempt from RBAC write-gate and license write-block

## Dashboard
- `GET /api/dashboard/summary` [auth] [db] — up/down/warning/unknown counts + agent-offline + active alerts (`active_alerts` total plus the `active_alerts_critical`/`active_alerts_warning` severity split the dashboard Overview uses) + agent online count. The alert counts are site-scoped by **alert ownership** (`alertSiteScope`, the one shared predicate — see gotchas.md), not by device: they were an INNER JOIN `monitored_devices` and read 0 for a site_admin whose alerts are all wireless
- `GET /api/dashboard/kpi-trends` [auth] [db] — prior-period series + delta per KPI tile (sparklines); reads `availability_summary` joined to `monitored_devices`, site-scoped
- `GET /api/dashboard/alert-histogram` [auth] [db] — alert counts bucketed by hour, severity-split (`total`/`critical`/`warning`/`other`); `?window=24h|7d`, site-scoped by alert ownership. The window is **bucket-aligned**: rows are filtered from the first generated bucket's start (`bnd.lo`), not `NOW() - hours`, so the charted total always equals the window total (24 buckets / 24h, 42 buckets / 168h). Same bounds pattern as `/api/alerts/volume`
- `GET /api/dashboard/noisiest` [auth] [db] — top-N entities (device/AP/service/controller/agent, `kind` + `entity_id`) by alert count; `?window=24h|7d`, `?limit=` (capped 20), site-scoped by alert ownership
- `GET /api/dashboard/agent-offline` [auth] [db] [site-scoped 1.115.9] — devices unreachable because their polling agent is offline, grouped by agent; the per-agent device COUNT is now scoped too, so an agent polling only other sites' devices no longer appears
- `GET /api/dashboard/problems` [auth] [db] — every device currently down/warning, worst first; suppressed devices hidden (covered by their gateway's entry)
- `GET /api/dashboard/top-worst` [auth] [db] — top 10 by avg response time, last 1h
- `GET /api/dashboard/network-trend` [auth] [db] — 24h availability trend in 30-min buckets
- `GET /api/dashboard/site-health` [auth] [db] — per-site device counts + 24h uptime
- `GET /api/dashboard/events` [auth] [db] — alerts triggered/resolved in a window. `?hours=` (1-168, default 24) and `?limit=` (1-500, default 20) added 1.115.0 so the dashboard's Activity feed can be an actual feed; both clamp and both default to the previous behaviour. Last 20 alerts triggered/resolved in 24h by default; LEFT JOINs device/service/wireless since alert rows can have device_id=NULL. Site-scoped by alert ownership (was device-OR-service, which showed a site_admin 1 of their 674 events)
- `GET /api/dashboard/ops-summary` [auth] [db] — MTTR/MTTA (30d avg) + unacknowledged count + open incidents; site-scoped by alert ownership (was `d.site_id`, device-only, so a site_admin's tiles read 0/near-0)
- `GET /api/dashboard/incidents` [auth] [db] [site-scoped 1.115.9] — latest 10 open incidents with root-cause device. Was the ONLY unscoped route of the 18 `/api/dashboard/*`; now uses the same EXISTS-over-the-incident's-alerts predicate as `/api/intelligence/incidents`
- `GET /api/dashboard/sla` [auth] [db] — 30-day rolling SLA % + per-device breaches vs configurable target (default 99.5%)
- `GET /api/dashboard/capacity` [auth] [db] — devices with CPU/mem p95 >= 80% (approaching capacity)
- `GET /api/dashboard/patterns` [auth] [db] — top recurring alert patterns by confidence/frequency
- `GET /api/dashboard/least-reliable` [auth] [db] — worst alert offenders, last 30 days
- `GET /api/dashboard/top-talkers` [auth] [db] — busiest interfaces by recent throughput (~15min window)
- `GET /api/dashboard/maintenance` [auth] [db] — maintenance windows active now + upcoming 7 days (device or service-check scoped)
- `GET /api/dashboard/wireless-intel` [auth] [db] — network-wide wireless intelligence rollup for the dashboard card

## Devices
- `GET /api/devices` [auth] [db] — list with live status/latency/CPU/mem/uptime lateral joins; filters status/site_id/q. Also returns `device_vendor`, `last_alert_type`/`last_alert_severity` (the alert LATERAL is ORDER BY+LIMIT 1, not MAX, so the type comes with the timestamp), and NetVault-enriched `nv_vendor`/`nv_model`/`os_type`/`os_version` (see `netvaultInventory()` — cross-DB, merged in JS, 5-min cache, best-effort). No longer returns `spark` (the 7-day per-device uptime LATERAL was dropped in 1.88.0 with the list sparklines)
- `GET /api/global-search` [auth] [db] — search across devices/APs/controllers/service checks **and wireless clients** (by IP/MAC/hostname), all site-scoped. Backs BOTH the Ctrl+K palette and the top-bar search; the top bar used to hit `/api/devices?q=` instead, so an on-screen client IP returned "no match" (fixed 1.92.0 — don't repoint either search at a narrower endpoint). Clients are site-scoped via the owning controller (`cc.site_id`), because `wireless_clients` has no `site_id` and its `ap_id` is nullable
- `GET /api/devices/sparklines` [auth] [db] — 24 hourly buckets of response_ms/cpu/mem per device id; registered BEFORE `/:id` so Express doesn't treat "sparklines" as an id. **No frontend caller since 1.88.0** (the devices list's trend column was removed); left in place as a working endpoint rather than removed — check here first if you're looking for per-device 24h series
- `GET /api/devices/:id` [auth] [db]
- `POST /api/devices` [auth+write:site_admin+] [db] — auto-assigns a polling agent by site if one owns it. **1.115.9: 403s a `site_id` outside the caller's scope** (`siteWritable`) — a site_admin could previously create a device in any site, which the read-side GUARD 1 cannot see because it resolves the site from the STORED row
- `PUT /api/devices/:id` [auth+write:site_admin+] [db] — pushes updated SNMP creds to the owning agent immediately if agent-polled. **1.115.9: 403s a `site_id` outside the caller's scope** — moving a device between sites is a write that names a site
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
- `GET /api/dependencies/tree` [auth] [db] [site-scoped 1.115.9] — full flat tree with depth. A device route under the `/api/dependencies` prefix, so GUARD 1 never saw it while its per-device sibling `/api/devices/:id/dependencies` was covered. BOTH branches of the recursive CTE are filtered — scoping only the anchor lets a child in another site ride in through the recursion
- `POST /api/devices/:id/ping-now` [auth+write:site_admin+] [external] — on-demand single ICMP probe, no history write
- `POST /api/devices/:id/set-gateway` [auth+write:site_admin+] [db] — marks device as its site's gateway (clears any existing one first)
- `POST /api/devices/:id/clear-gateway` [auth+write:site_admin+] [db]
- `POST /api/devices/:id/snmp-discover` [auth+write:site_admin+] [external] — walks device, returns grouped available sensors
- `GET /api/devices/:id/sensors` [auth] [db] — saved sensor selection for the device. Each row carries a DERIVED `unit` (custom_unit || unitFor(metric_name)); it is not stored. Both alert-limit editors key off `unit === 'state'` to offer "when Down"/"when Up" rather than a threshold box.
- `PUT /api/devices/:id/sensors` [auth+write:site_admin+] [db] — upserts sensor selection
- `POST /api/devices/:id/sensors/custom` [auth+write:site_admin+] [db] — create custom OID sensor
- `DELETE /api/devices/:id/sensors/custom/:sensor_id` [auth+write:site_admin+] [db] — custom sensors only
- `POST /api/devices/:id/snmp-test` [auth+write:site_admin+] [external] — test reachability with stored credentials
- `POST /api/snmp-test-adhoc` [auth+write:site_admin+] [external] — test with ad-hoc credentials before a device is saved

## NetVault integration (read-only source)
- `GET /api/netvault/devices` [auth+read:admin+] [db] [site-scoped 1.115.9] — NetVault devices not yet monitored (netvault.devices.ip_address is `character varying`, NOT inet — never add a host() cast). **Admin mount guard + site scoping added 1.115.9**: it answers straight off NetVault's own `nv` pool, so an unscoped read here bypasses NetVault's RBAC entirely (SpanVault's session is not NetVault's). Its only UI path is the "Import from NetVault" dialog, already `canEdit`
- `POST /api/netvault/import` [auth+write:admin+] [db] — import selected NetVault devices into monitoring. **Raised from site_admin to admin in 1.115.9** (`app.use('/api/netvault/import', requireAdminRead)`): it reads the `nv` pool and creates `monitored_devices` rows in whatever site NetVault says, and its only UI is the `canEdit` import dialog
- `GET /api/netvault/sites` [auth] [db] [site-scoped 1.115.9] — for map + filters. ⛔ DELIBERATELY NOT admin-gated, unlike its two `/api/netvault/*` siblings: it is fetched by the devices, sites, services, reports and wireless pages and by `SiteScopeBanner` (which only renders FOR a site_admin), so a role gate would break the site pickers for every non-admin. Site-scoped instead — a site_admin gets only their own sites, and `SiteScopeBanner` already filters client-side to the same set

## Distributed polling agents

⛔ **The WHOLE `/api/agents` family is behind one mount guard at admin rank since
1.115.9** — `app.use('/api/agents', requireAdminRead)`, registered above every
route below. Every WRITE was already rank-2 via `ADMIN_ONLY_WRITE` and the nav
item is `canManageAgents`, but the READS carried no role gate and no site filter:
`GET /api/agents/4` returned the agent row plus every device it polls (name,
ip_address, site_id, site_name, current_status) and every service check,
estate-wide — stepping around the `siteFilterClause` that `GET /api/devices`
applies. This is the "page guarded, API wide open" failure mode CLAUDE.md names
as recurring. It is a MOUNT guard, not per-route, so a route added to this family
later inherits it. All three frontend consumers already fetch behind
`canManageAgents`/`canEdit`, so nothing reachable today changed.
- `GET /api/agents` [auth+read:admin+] [db] — all agents with device counts + assigned sites; includes `hub_agent_id` (Phase 3, added so the list view — not just detail — can tell a hub-enrolled agent apart from a legacy one)
- `GET /api/agents/:id` [auth+read:admin+] [db] — never returns api_key/install_command (legacy secret; hub owns enrollment, Phase 4)
- `PUT /api/agents/:id` [auth+write:admin+] [db] — rename
- `POST /api/agents/:id/disabled` [auth+write:admin+] [db] — disable/enable without deleting; drops live socket, refuses handshakes
- NOTE: `POST /api/agents` (create) + `POST /api/agents/:id/rotate-key` REMOVED in Phase 4a — agent enrollment/api_key are now owned by the NetVault hub; SpanVault only binds sites (`/:id/sites`) + discovers devices for already-provisioned agents
- `POST /api/agents/:id/link-legacy` [auth+write:admin+] [db] — Phase 3 "duplicate row" manual-link fallback: merges `:id` (a hub-JWT-provisioned duplicate row) into `body.legacy_agent_id` (an existing legacy api_key row), for cases the automatic hostname link in ws-server.js can't confidently resolve on its own (ambiguous/duplicate hostname, or no hostname reported yet); the legacy row keeps its id/history, the duplicate is deleted — see gotchas.md
- `DELETE /api/agents/:id` [auth+write:admin+] [db] — devices fall back to local polling (agent_id -> NULL); **409 for a hub-enrolled row** (hub_agent_id set) — those are deleted from the NetVault hub, which fans the removal back via /api/internal/agents/forget (1.86.3)
- `POST /api/agents/:id/sites` [auth+write:admin+] [db] — replace site assignments + re-derive device ownership
- `POST /api/agents/:id/restart` [auth+write:admin+] [external] — WS message; agent exits, NSSM restarts it; refuses with 409 for a hub-enrolled agent (`hub_agent_id` set) — restart for those runs through the hub's own command queue, see gotchas.md
- `POST /api/agents/:id/logs/refresh` [auth+write:admin+] [external] — WS request for fresh log tail; same hub-enrolled 409 refusal as restart above
- `GET /api/agents/:id/logs` [auth+read:admin+] [db] — most recent pushed log tail (may be empty until refreshed)
- `POST /api/agents/:id/discover` [auth+write:admin+] [external] — trigger subnet sweep on agent (must be online)
- `GET /api/agents/:id/discovered` [auth+read:admin+] [db] — discovered candidates, flags already-monitored (`snmp_community` is correctly never selected)
- `POST /api/agents/:id/discovered/adopt` [auth+write:admin+] [db] — adopt into monitoring, keeps discovered SNMP community/version

## Alerts / alert rules
- `GET /api/alerts` [auth] [db] — site-scoped by alert ownership: `COALESCE(device, AP, service-check, controller).site_id` (`alertSiteWhere`, rendered against this route's own joins). An alert owned by none of those four resolves to NULL and is invisible to a site-scoped caller, admin-only
- `POST /api/alerts/:id/acknowledge` [auth+write:site_admin+] [db] — attributed to verified session user, not client-supplied. Write scope == read scope exactly (`alertWriteSiteClause` now renders the same ownership predicate with correlated sub-selects): a site_admin can ack the wireless alerts at their own sites, which the old device-OR-service clause matched 0 of
- `POST /api/alerts/:id/resolve` [auth+write:site_admin+] [db]
- `POST /api/alerts/bulk-acknowledge` [auth+write:site_admin+] [db] — batch ack by id list; each id re-checked against the caller's sites via `alertWriteSiteClause`, out-of-scope ids are skipped not failed
- `POST /api/alerts/bulk-resolve` [auth+write:site_admin+] [db] — batch resolve, same scoping rule as bulk-acknowledge
- `GET /api/alerts/volume` [auth] [db] — hourly alert volume for the alerts-page strip; `?hours=` (default 24, max 168), gap-filled with `generate_series`, site-scoped by alert ownership. Buckets are `{hour, critical, warning, other, total}` — `warning` was `severity <> 'critical'` (every `info` row drawn as a warning, disagreeing with the histogram's `other` bucket); `other`/`total` added so a caller never re-derives a total as `critical + warning`
- `GET /api/alerts/summary` [auth] [db] — **authoritative** totals for the Alerts page's tiles: `{matched, open_total, critical, warning, unacknowledged, acknowledged, suppressed, resolved, oldest_open_at}`. Takes the SAME filters (`status`/`severity`/`device_id`/`service_check_id`) and the SAME `alertSiteWhere` RBAC predicate as `GET /api/alerts` immediately above, so the tiles and the table can never describe different populations. Added 1.115.0 because the tiles counted the FETCHED rows (LIMIT 200 by default), i.e. "30 critical" meant "30 among the newest 200". Registered before any `/api/alerts/:id` route
- `GET /api/alert-rules` [auth] [db]
- `GET /api/alert-rules/effective/:device_id` [auth] [db] [site-scoped 1.115.9] — effective ruleset after global->site->device inheritance. A DEVICE route under the `/api/alert-rules` prefix; walking `:device_id` 1..N used to enumerate every monitored device's name/site. Out-of-scope answers the same 404 as absent
- `GET /api/alert-rules/effective-service/:service_check_id` [auth] [db] [site-scoped 1.115.9] — same, namespaced to SERVICE_METRICS. **The 4th instance of the documented `service_checks` scoping gap**; walking the id enumerated every monitored service's `target` (hostname/URL/IP) estate-wide
- `POST /api/alert-rules` [auth+write:admin+] [db] — 400s if `sensor_key` is sent without a device-scoped rule + `device_id`.
- `PUT /api/alert-rules/:id` [auth+write:admin+] [db] — 400s if the update would leave a `sensor_key` rule non-device-scoped (it could otherwise be promoted to global and raise one alert_type estate-wide). `enabled:false` also resolves the alerts that rule had raised.
- `DELETE /api/alert-rules/:id` [auth+write:admin+] [db] — resolves any ACTIVE `rule_<id>` alerts first; only evaluateEffectiveRules resolves them, so deleting the rule used to strand them permanently.

## Network map (devices grouped by site) + interactive map designer
- `GET /api/map` [auth] [db] — legacy simple map, devices grouped by site
⛔ **The maps family is site-scoped since 1.115.9, and `sv_maps` HAS NO `site_id`** —
a map's scope is DERIVED from its nodes: a map is in scope for a site-scoped
caller when EVERY entity-linked node on it resolves to one of their assigned
sites (`mapOutOfScopeSql`/`mapVisible` in `api/rbacScope.js`). A node linked to
neither a device nor a service check is decorative and ignored; an empty map is
visible to everyone; a node whose device/service has a NULL `site_id` fails
CLOSED via a `COALESCE(..., -1) <> ALL(...)` sentinel. Consequence, stated
deliberately: **an estate-wide map built by an admin is invisible to a
site_admin** — that is the site-scoping model, and the alternative (showing the
map with the forbidden nodes blanked) publishes the other site's node count and
geometry anyway. Before this, the whole family was a standing scope bypass.

- `GET /api/maps` [auth] [db] — list with device count, a live status rollup (`linked_count` + `up_count`/`down_count`/`warning_count`/`unknown_count`) and a coarse `preview` ({nodes:[{x,y,w,h,s,i}], links:[{x1,y1,x2,y2}], shapes:[{x,y,w,h}]}, canvas coords) the /maps cards draw as a real thumbnail. Three extra grouped queries total, NOT one per map; capped at 400 nodes / 400 links / 80 shapes per map; `map_shapes` read is try/caught for un-migrated DBs. Link endpoints resolve via `from_kind`/`to_kind` — map_devices and map_shapes ids come from independent sequences and collide
- `POST /api/maps` [auth+write:site_admin+] [db]
- `GET /api/maps/:id` [auth] [db] [site-scoped 1.115.9] — full map: properties + content + live device status. 404 (not 403) when out of scope
- `PUT /api/maps/:id` [auth+write:site_admin+] [db] [site-scoped 1.115.9] — properties only
- `DELETE /api/maps/:id` [auth+write:site_admin+] [db] [site-scoped 1.115.9] — cascades devices/connections/labels
- `PUT /api/maps/:id/layout` [auth+write:site_admin+] [db] [site-scoped 1.115.9] — full replace of devices/shapes/connections/labels; remaps client-temp ids to real ids. ⛔ The map being in scope is NOT enough: it also validates EVERY `device_id`/`service_check_id` in the payload against the caller's sites (`layoutIdsInScope`, 403), because it previously accepted any id — a way to pull another site's devices into a map you own and read their name/ip/live status back out of `GET /api/maps/:id`
- `POST /api/maps/:id/background` [auth+write:site_admin+] [db] [site-scoped 1.115.9] — bg_image_b64=null/'' clears it
- `POST /api/maps/:id/toggle-public` [auth+write:**admin**+] [db] [site-scoped 1.115.9] — ⛔ **raised from site_admin to admin in 1.115.9** (`ADMIN_ONLY_WRITE` now carries `/^\/api\/maps\/\d+\/toggle-public$/`). Publishing to the unauthenticated share view is an estate-wide disclosure decision, not an operational edit: because `sv_maps` has no `site_id`, a site_admin scoped to one site could list every map, flip one built for another site public, read the returned `uuid` and then fetch every node's name, ip_address and live status **with no cookie at all**
- `GET /api/maps/public/:uuid` [public] [db] — only resolves when is_public=TRUE; the **only no-auth DATA route in the app**. Left unscoped deliberately: an anonymous caller has no sites, so narrowing a deliberately-shared map by the viewer's (non-existent) scope would return an empty canvas to every share link. What made it a finding was the PUBLISHING side, which is now admin-rank. ⛔ Since 1.115.9 `middleware.ts` admits this prefix for **GET/HEAD only** and matches exactly one path segment (it was a bare prefix with no method check, so a future write under it — or one keyed on `:uuid` — would have been reachable with no session)

## Topology discovery (LLDP/CDP)
- `POST /api/topology/discover` [auth+write:admin+] [external] — triggers async job, poll /status for completion
- `GET /api/topology/status` [auth] [db] [site-scoped: fd.site_id] — live run flag + derived last-run/link counts
- `GET /api/topology/links` [auth] [db] [site-scoped: fd.site_id] — all discovered links, both ends joined; `?device_id=` scopes
- `GET /api/topology/map` [auth] [db] [site-scoped: fd.site_id] — `{nodes, edges}` for the Visual Map tab. Nodes = every endpoint with >=1 link: the monitored devices that discovered links AND the discovered NEIGHBOURS. A neighbour that is not in `monitored_devices` is emitted with `managed:false` and a **synthetic negative `device_id`** valid only inside that response (never link it to /devices/[id]); it inherits the discovering device's `site_name` and `status:'unknown'`. Monitored nodes are `managed:true` with their real id/status/is_gateway. Edges are `dedupeEdges`d (one line per undirected pair+protocol)
- `POST /api/topology/apply-to-map/:map_id` [auth+write:admin+] [db] — grid-places new devices, preserves positioned ones, recreates connections
- `POST /api/topology/apply-dependencies` [auth+write:admin+] [db] — suggests site gateways from topology fan-out

## Wireless — controllers
- `GET /api/wireless/controllers` [auth] [db] [site-scoped 1.115.9] — `wireless_controllers.site_id` exists and nine routes already used it; these five did not. Credentials were already masked by `publicSnmpFields`, so the leak was inventory: controller names, models, firmware levels, HA peer addresses
- `GET /api/wireless/controllers/overview` [auth] [db] [site-scoped 1.115.9]
- `GET /api/wireless/controllers/events` [auth] [db] [site-scoped 1.115.9] — recent events across all controllers (client events + alerts); each of the two queries carries its OWN params array (Postgres rejects a bind with more params than placeholders)
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
- `GET /api/wireless/aps/:id` [auth] [db] — RBAC site-scoping fixed 2026-07-22 bug sweep (was missing; sibling list + `/clients` already had it) — see gotchas.md Also returns `congestion_factors` = `{window_minutes:15, factors[]}` — the per-factor breakdown behind `congestion_score` (input, weighted points, max, and a `saturated` flag). Detail-route ONLY; the list omits it deliberately (227 APs x 5 factors for a column that renders just the level).
- `GET /api/wireless/history/:ap_id` [auth] [db] [site-scoped 1.115.9] — client/utilization history, bucketed by range. Its param is `:ap_id`, NOT `:id`, so it also escapes the `app.param('id')` numeric guard — it now validates the id itself. 404 for absent AND out-of-scope
- `GET /api/wireless/summary` [auth] [db] — overview tab + dashboard card
- `GET /api/wireless/channel-changes/top` [auth] [db] [site-scoped] — fleet channel-change leaderboard for the Insights tab. `?days=` (1-30, default 7), `?limit=` (1-50, default 10), `?controller_id=`. Returns `{days, controller_id, rows[], total_changes, total_aps_moving, total_radar_suspected, tracking_since}`. All three internal queries share one `buildScope()` predicate builder so the table, the totals and `tracking_since` can never describe different AP sets. `tracking_since` is the earliest record in the table, so the UI can distinguish "nothing moved" from "we only started watching on the 11th". Degrades to empty ONLY on 42P01 (missing table); every other error re-throws
- `GET /api/wireless/ssids` [auth] [db]
- `GET /api/wireless/ssids/summary` [auth] [db]
- `GET /api/wireless/aps/:id/clients` [auth] [db] — site-scoped (fixed alongside the mac/history routes below)

## Wireless — intelligence
- `GET /api/wireless/intelligence` [auth] [db] — registered BEFORE `/summary` and `/:controller_id`... actually see next 2 (order matters so Express doesn't match "summary" as an id)
- `GET /api/wireless/intelligence/summary` [auth] [db]
- `GET /api/wireless/intelligence/:controller_id` [auth] [db] [site-scoped 1.115.9] — both sibling routes (`/intelligence`, `/intelligence/summary`) already scoped on `c.site_id`; this by-id one did not

## Wireless — clients / rogues
- `GET /api/wireless/clients` [auth] [db]
- `GET /api/wireless/clients/summary` [auth] [db]
- `GET /api/wireless/rogues` [auth] [db] — returns [] gracefully if table not yet migrated
  **BREAKING (1.89.0): returns an OBJECT, not an array** — {data, matched, returned,
  truncated, summary}. summary holds SQL COUNTs over the whole site-scoped set
  (total/threats/malicious/interfering/friendly/active_1h). The page used to derive its
  headline cards from the returned rows against a hard LIMIT 500, so it read
  "500 detected / 4 malicious" where the truth was 12,515 / 191 — under-reporting
  threats ~48x on a security page. Filters are now server-side for the same reason
  (filtering a truncated sample answers a different question): classification, search
  (bssid/ssid/detecting_ap), controller_id, channel, band (2.4|5 only — 6GHz channel
  numbers overlap 5GHz in these vendor tables, so it cannot be answered honestly),
  min_rssi, since_hours, named, limit (default 1000, max 5000), offset.
  `sort=threat` (1.115.0) is the page's DEFAULT order: malicious → rogue → interfering →
  unclassified → unreported → friendly, then most-recent within each. It always sorts ascending
  by rank regardless of `dir` (a "descending" threat sort putting friendly APs first is useless).
  Newest-first buried every confirmed malicious BSSID under unclassified noise.
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
- `GET /api/reports/schedules` [auth] [db] — scheduled-report list for the Reports page: `saved_reports` + LATERAL last `report_history` run (run_at/status/error), site-scoped
- `POST /api/reports/saved` [auth+write:site_admin+] [db]
- `PUT /api/reports/saved/:id` [auth+write:site_admin+] [db] — recomputes next_run_at
- `POST /api/reports/saved/:id/run-now` [auth+write:site_admin+] [db+external] — runs + emails immediately, doesn't change next_run_at. ⛔ On failure it used to return nodemailer's `err.message` to the caller AND persist it to `report_history.error` (which `GET /api/reports/saved/:id/history` hands back) — that message routinely embeds the SMTP host, port, configured username and the server's verbatim auth rejection. Since 1.115.9 only `mailErrorSummary(e)` (the `code`/`responseCode`) leaves the process; the rest goes to the API log. Out-of-scope now answers 404, matching absent
- `GET /api/reports/saved/:id/history` [auth] [db]
- `DELETE /api/reports/saved/:id` [auth+write:site_admin+] [db]
- `GET /api/reports/network-summary` [auth] [db] — always all devices
- `GET /api/reports/site-summary` [auth] [db]
- `GET /api/reports/device-detail` [auth] [db]
- `GET /api/reports/sla-compliance` [auth] [db] — rows + summary in one response
- `GET /api/reports/top-worst` [auth] [db]
- `GET /api/reports/alert-analysis` [auth] [db] — site scoping applies to device OR service-check branch
- `GET /api/reports/capacity` [auth] [db]
- `GET /api/reports/executive` [auth] [db] — ⛔ has its OWN try/catch, so it bypasses the central PROD-gated error handler. It used to return `err.message` to any authenticated viewer; now PROD-gated like everything else (1.115.9)
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
- `GET /api/settings` [auth:admin+] [db] — ADMIN ONLY (403 below rank 2). **Secrets are masked**: any key in `SECRET_SETTING_KEYS` (currently `smtp_pass`) is returned as the literal `__unchanged__` when set, `''` when not. Admin-only is not the same as safe-to-transmit — the page only needs to know a password EXISTS. Added 1.115.0
- `PUT /api/settings` [auth+write:admin+] [db] — a secret sent back as `__unchanged__` is SKIPPED (so saving any other field cannot wipe a password the operator was never shown); the literal `__clear__` stores `''` (the explicit "remove it" path, since an empty field is indistinguishable from an untouched one once the value is masked)
- `GET /api/audit` [auth] [db] — admin-only in practice (UI-gated); recent successful mutations
- `GET /api/notification-routes` [auth+read:admin+] [db] — admin READ gate added 1.115.9 (`app.use('/api/notification-routes', requireAdminRead)`). Every write was already admin-only and the only UI is the admin Settings page, but the GET had no role gate — any viewer could read the alert-email recipient lists (`notification_routes.email_to`)
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
- `GET /api/escalation-steps` [auth+read:admin+] [db] — admin READ gate added 1.115.9 (escalation contact emails)
- `POST /api/escalation-steps` [auth+write:admin+] [db]
- `DELETE /api/escalation-steps/:id` [auth+write:admin+] [db]
- `GET /api/oncall-shifts` [auth+read:admin+] [db] — admin READ gate added 1.115.9 (on-call roster + contact emails)
- `POST /api/oncall-shifts` [auth+write:admin+] [db]
- `DELETE /api/oncall-shifts/:id` [auth+write:admin+] [db]
- `GET /api/maintenance` [auth] [db] [site-scoped 1.115.9] — found by the by-table sweep, not reported: it listed every maintenance window in the estate with its device/service name while its sibling `/api/dashboard/maintenance` (same two tables) was scoped. A window attached to neither a device nor a service check has no site and fails CLOSED
- `POST /api/maintenance` [auth+write:admin+] [db]
- `DELETE /api/maintenance/:id` [auth+write:admin+] [db]

## Intelligence layer (api/intelligence.js analytics)
- `GET /api/intelligence/overview` [auth] [db] — network-wide summary for Overview tab + dashboard card
- `GET /api/intelligence/health` [auth] [db] — health scores; service checks have no anomaly component (always anomalies_7d=0)
- `GET /api/intelligence/anomalies` [auth] [db] — filter by status/device; `?limit=` (default 200, max 2000). Body stays a bare ARRAY; `X-Total-Count` / `X-Returned-Count` headers report the true total so a capped page is distinguishable from a complete set
- `PATCH /api/intelligence/anomalies/:id` [auth+write:admin+] [db] — sets review status (active/resolved/reviewed/suppressed/escalated); engine leaves human-reviewed rows alone
- `POST /api/intelligence/anomalies/:id/create-rule` [auth+write:admin+] [db] — creates an alert rule that fires on a comparable deviation
- `GET /api/intelligence/capacity` [auth] [db] [site-scoped 1.115.9] — on-demand capacity forecast for one device; the device id arrives as a QUERY param so GUARD 1 never saw it (`deviceVisible`, 404)
- `GET /api/intelligence/patterns` [auth] [db] — all or by device
- `GET /api/intelligence/incidents` [auth] [db] — correlated incidents with root cause + affected devices
- `GET /api/intelligence/thresholds` [auth] [db] [site-scoped 1.115.9] — smart threshold recommendations, highest confidence first. Widest-breadth gap of the three: one row per ACTIVE device in the whole estate with `device_name`/`site_id`/`site_name`
- `POST /api/intelligence/thresholds/:device_id/apply` [auth+write:admin+] [db] — device-scope check added 1.115.9 for consistency only: `/api/intelligence/` is in `ADMIN_ONLY_WRITE`, so only a rank-2 admin (already unscoped) can reach it. Not a bypass
- `GET /api/intelligence/device/:id` [auth] [db] [site-scoped 1.115.9] — consolidated summary for device detail card. A DEVICE route under the `/api/intelligence` prefix, outside GUARD 1 (`deviceVisible`, 404)
- `POST /api/intelligence/baselines/recompute` [auth+write:admin+] [db] — manual full recompute (testing/refresh)

## WebSocket server (api/ws-server.js, port 3010, all interfaces — not HTTP routes)
Not Express routes; a `ws` `WebSocketServer` remote agents connect to. Handshake auth is
accept-both (Phase 3): a hub-signed JWT (`Authorization: Bearer <jwt>`, verified locally via
`agent-identity.js`) tried first, falling back to the legacy `api_key` (`Authorization` header
or legacy URL param) unchanged. Handles `message`/`close`/`error` per-socket; the `message`
handler also runs the auto-link-by-hostname check (see gotchas.md) on each agent's first
`heartbeat`. Exports `startWsServer`, `connectedAgents`, `agentLogs`, `pushConfigToAgentId`,
`sendToAgentId`, `disconnectAgent`, `mergeAgentRows` (Phase 3 — shared merge
routine behind both the automatic hostname link and the admin `/api/agents/:id/link-legacy`
manual fallback) — consumed by `api/server.js` for the `/api/agents/*` routes above.

## Next.js routes (frontend/src/app/api/)
- `GET|POST /api/auth/[...nextauth]` [public bootstrap / auth thereafter] — NextAuth catch-all (`frontend/src/lib/auth.ts` authOptions); the ONLY real Next.js API route in this app — middleware explicitly never touches `/api/auth/*`

## Needs force-dynamic
None. Only one Next.js route handler exists (`api/auth/[...nextauth]/route.ts`), and
NextAuth's own handler manages its own caching/dynamic behavior — a
`force-dynamic` export is not applicable/needed here. No other `frontend/src/app/api/**`
route exists to check (see the dead-code corollary in gotchas.md for why one
was attempted and removed).

- `GET /api/wireless/history/:ap_id?range=` — AP chart history, bucketed. Ranges (1.94.0): `1h|2h|6h|12h|24h|2d|7d|30d|90d`, default 24h. Bucket sizes are chosen against the ~5-minute AP poll interval, NOT for tidy round numbers: a bucket smaller than the poll interval cannot average anything and renders as a gap-toothed line that looks like data loss, so 5 minutes is the floor and short ranges show FEWER points rather than finer ones. An unknown `range` value silently falls back to 24h — so the frontend's `ApRange` union must stay in step with `rangeToInterval`/`rangeToBucket` or the chart quietly disagrees with the button the user pressed.

### Dashboard/wireless visualisation aggregates (1.98.0)
- `GET /api/wireless/trend` [auth] [db] [site-scoped] — fleet client count + per-band airtime over time. `?hours=` (1-720, default 24). **The per-AP-then-sum subquery is load-bearing**: `wireless_history` holds ~1 row per AP per 5-min poll, so a flat `SUM(clients_total) GROUP BY hour` returns ~13x the real count (15,334 vs 1,172). 60s TTL cache.
- `GET /api/wireless/distribution` [auth] [db] [site-scoped] — `{channels_2g, channels_5g, signal, band, total_aps}`. Channel buckets are online APs only; `signal` buckets clients by `rssi_dbm` on the conventional RSSI bands; `band` EXCLUDES `aruba_central` APs (no per-band breakdown — their `clients_2g/5g` are 0, not a confirmed zero) and reports `covered_aps`. 60s TTL cache.
- `GET /api/dashboard/alert-trend` [auth] [db] [site-scoped] — daily alert counts by severity. `?days=` (1-90, default 14). Counts by `triggered_at`, not current status. Site-scoped by alert ownership; it previously used `d.site_id = ANY(...) OR a.device_id IS NULL`, which leaked every other site's device-less (wireless/service/agent) alerts into a site_admin's chart.

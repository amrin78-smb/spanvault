# SpanVault library exports

Listing `module.exports` (backend, plain JS) / `export` (frontend, TypeScript) —
the real public interface each file offers to callers, not every internal helper.
`[SENSITIVE]` = touches credentials, encryption, or an external device/vendor/API.

## Backend (api/)

### intelligence.js — statistical analytics engine (649 lines), self-schedules via setInterval
```
module.exports = {
  startIntelligenceEngine() — wires setInterval jobs: baselines hourly, health scores per poll cycle,
                               anomaly detection, capacity forecasts, pattern detection, threshold
                               recommendations, incident correlation every 5 min
  runAll() — runs every job once (used by POST /api/intelligence/baselines/recompute)
  computeBaselines() — mean/stddev/percentiles per device+metric over rolling window -> device_baselines
  computeHealthScores() — per-device 0-100 score from uptime/response/anomaly/alert components
  computeServiceHealthScores() — same shape for service_checks, no anomaly component (binary up/down signal)
  detectAnomalies(metric, recentSql, params) — z-score deviation vs baseline -> device_anomalies
  computeCapacityForecasts(deviceId) — CPU/mem p95/p99 trend forecast
  detectPatterns() — recurring hour-of-day/day-of-week issue detection -> device_patterns
  computeThresholdRecommendations() — suggests alert-rule thresholds from observed baselines
  correlateIncidents() — groups related alerts into incidents -> incidents table
}
```

### licenseCheck.js — NocVault license/feature-gate checks (54 lines)
```
module.exports = {
  getLicense(forceRefresh=false) — cached (24h) license fetch  [SENSITIVE: external licensing service call]
  getLicenseState(license) — derives {canWrite, disabled, mode, daysRemaining} from a license object
  fetchLicense() — uncached raw fetch  [SENSITIVE: external]
}
```
Consumed by `enforceLicense` middleware in api/server.js (gates writes during grace, all access when disabled).

### pdfCharts.js — chart rendering helpers for PDF reports (230 lines, pdfkit canvas drawing)
```
module.exports = { renderTrendChart(doc, opts) — draws a line/area trend chart onto a pdfkit doc }
```

### rbacScope.js — the PURE half of RBAC site scoping (added 1.115.9)
⛔ **Extracted from `api/server.js` so it can actually be TESTED.** `api/server.js`
cannot be required by a test — it opens two Postgres pools, starts the agent
WebSocket listener and binds a port — so every predicate deciding what a
`site_admin` may see had zero coverage, in a codebase whose own gotchas.md records
that bug class recurring five times. Everything here is pure: no DB, no network.
The DB-touching wrappers (`deviceVisible`, `mapVisible`, `layoutIdsInScope`,
`savedReport*`) stay in server.js and call into these.
Suite: `tests/test-rbac-scoping.js` (`npm run test:rbac`).
```
module.exports = {
  ROLE_RANK                                  — { viewer:0, site_admin:1, admin:2, super_admin:3 }
  userRank(req)                              — x-user-role → rank; unknown/missing floors at viewer (0)
  getSiteFilter(req)                         — site_admin → int[] of their sites; admin/viewer/missing → null (unscoped)
  siteFilterClause(siteFilter, params, col)  — pushes onto params, returns `col = ANY($n::int[])` or null.
                                               NEVER add `OR col IS NULL` — that inverts fail-closed into fail-open
  rowInScope(siteFilter, siteId)             — ⛔ THE ONE per-row check. ~10 routes resolve a row's site_id then
                                               call this; do not hand-roll an eleventh. NULL site_id → false
  siteWritable(req, siteId)                  — for a WRITE whose PAYLOAD names a site (device create / move
                                               between sites). Accepts numeric strings; null/non-numeric → false
  mapOutOfScopeSql(mapIdExpr, paramIdx)      — `sv_maps` has NO site_id, so a map's scope is DERIVED from its
                                               nodes. TRUE when the map has a node outside the caller's sites.
                                               Site-less node fails CLOSED via a COALESCE(...,-1) <> ALL sentinel
  makeDeviceScopeGuard(query)                — GUARD 1's body for the whole /api/devices/:id… family, as a
                                               factory with an injected `query` purely so a test can drive it
  NOT_FOUND                                  — frozen shared 404 bodies (device/ap/client/serviceCheck/map/
                                               savedReport). Used by BOTH the absent and the out-of-scope branch
                                               of every id-keyed route, so the two answers cannot drift apart
  collectLayoutEntityIds(devices)            — { deviceIds, checkIds } a maps-layout payload wants to place;
                                               drops 0/negative/non-numeric (a 0 would pass a count check)
  mailErrorSummary(e)                        — code-only description of a report-delivery failure; nodemailer's
                                               err.message carries the SMTP host/port/username/auth rejection
  trustedFetchHostnames(env)                 — Set of hostnames a SERVER-SIDE fetch may target
  pickHubFetchOrigin(env, candidate)         — ⛔ a fetch target is NOT a browser link. Returns the
                                               request-derived `candidate` only when its hostname is configured
                                               (NOCVAULT_HUB_URL / NEXT_PUBLIC_… / SV_PUBLIC_URL / NEXTAUTH_URL /
                                               TLS_PUBLIC_HOST / NOCVAULT_TRUSTED_HOSTS / loopback); else the
                                               configured hub. Closes the SSRF on /api/hub/settings + POST /api/sso
}
```

### reportScheduler.js — scheduled report email delivery (460 lines)
```
module.exports = {
  startReportScheduler(pool, getSmtpSettings) — setInterval poller for saved_reports.next_run_at
  runDueReports(pool, getSmtpSettings) — finds + runs reports whose next_run_at has passed  [SENSITIVE: SMTP send]
  runAndEmailReport(pool, report, getSmtpSettings) — renders HTML report + emails it  [SENSITIVE: SMTP send, nodemailer]
  calculateNextRun(report) — computes next_run_at from schedule/schedule_day/schedule_hour
  fetchReportData(report) — pulls the same data a saved report's template needs
}
```
Internal-only (not exported): buildReportUrl, buildReportParams, renderReportHtml, renderDataSection, esc, isoDate.

### reportsPdf.js — pdfkit report renderers, one gather+render pair per template (3376 lines, largest api/ file)
```
module.exports = {
  generateReportPdf(db, { template, params, meta }) — dispatches to the matching gather+render pair, returns a PDF buffer
  hasPdfRenderer(template) — whether a pdfkit renderer exists for a template name (used by GET /api/reports/pdf/:template to 404 unknown templates)
}
```
Internal-only: ~18 `gather*`/`render*` pairs, one per report template (executive, network-summary, site,
sla, capacity, wireless-overview/ap-health/clients/rf/capacity/security/bandwidth, top-worst,
alert-analysis, device-detail, ap-detail, service-detail) plus shared drawing helpers (drawCover,
drawKpiTiles, drawTable, stampHeadersFooters, sectionTitle, renderChartBlock, bulletList). None are
exported — only reachable through `generateReportPdf`'s internal dispatch table.

## Backend (collector/) — reusable across api/ and collector/, not part of the HTTP API surface
```
snmp-session.js
  createSession(device) — builds a net-snmp session from stored/ad-hoc credentials  [SENSITIVE: SNMP community/v3 creds]
  walk(session, oid) / get(session, oids) — promisified SNMP walk/get
  OID, HR_STORAGE_RAM — shared OID constant maps
  (required by BOTH collector/*.js and api/ws-server.js — the one genuinely shared low-level module)

discovery.js
  snmpTest(device, timeoutMs) — reachability + credential test, used by POST /api/devices/:id/snmp-test
    and /api/snmp-test-adhoc  [SENSITIVE: SNMP creds]
  discoverDevice(...) — walks a device, returns grouped available sensors (backs POST /api/devices/:id/snmp-discover)
  buildFetchPlan(...) — builds the per-vendor OID fetch plan pushed to remote agents
  candidatesToSamples, collectCandidates, fmtValue, PrefetchedSession — discovery/formatting helpers
  unitFor(metric) — derives a sensor's unit from its metric name. Returns 'state' for Up/Down
    sensors (vpn_peer_up / node_online / node_test_ok, WITH or without a per-sensor `_<idx>`
    suffix, plus if_<n>_oper and if_oper_status), else '%'/'bps'/'bytes'/'count'/''. Also
    imported by api/server.js — GET /api/devices/:id/sensors returns it as a derived field,
    and the alert-limit editors key off 'state' to offer "when Down"/"when Up" instead of a
    number. The suffix tolerance is load-bearing: without it every per-sensor state sensor
    fell through to the numeric editor (the 1.107.1 bug).
  fetchVendorRaw(session, parser) — exported for tests only (tests/test-vendor-fetch.js);
    batches scalar GETs, walks tables concurrently, matches replies back by OID

parsers/_util.js  (shared helpers for collector/parsers/*)
  num / str / rowsNum / first / avg / sum / countWhere / lastIndex / sample
  num64(v) — decodes a 64-bit SNMP value. net-snmp has no 64-bit integer type, so
    Counter64/CounterBasedGauge64 arrive as big-endian Buffers and num() returns null for
    them. Use num64 for any OID whose MIB SYNTAX is 64-bit. Leaves a numeric DisplayString
    alone (byte-decoding '42' would read as 13362) and strips BER's leading zero pad.

topology.js
  discoverDevice/matchNeighborDevice/storeNeighbors/discoverAndStore — LLDP/CDP walk + link persistence,
    backs POST /api/topology/discover and the topology_links table

wirelessCollector.js
  testController(pool, controller) — "dry run" but NOT write-free for aruba_central — see gotchas.md  [SENSITIVE: SNMP/API creds, rotating OAuth tokens]
  pollController/pollAll/upsertAp/upsertSsid/upsertRogueAp/pollClients/... — full wireless polling engine,
    consumed by api/server.js for the manual "rescan"/"test"/"probe" routes  [SENSITIVE: wireless controller creds]

wirelessScore.js
  computeCongestionScore({util, retry, interference, imbalancePct, weakClientRatioPct}) — pure function,
    0-100 blend -> {score, level}; consumed live (not persisted) by GET /api/wireless/aps and /aps/:id
```

## Frontend (frontend/src/lib/)

### apiGate.ts — the two pure decisions `middleware.ts` makes per `/api/*` request (added 1.115.9)
⛔ Extracted from `middleware.ts` because that file imports `next/server` +
`next-auth/jwt` and runs on the edge runtime, so it cannot be required from a Node
test script. **Keep this module dependency-free** (no `next/*`, no `next-auth`) or it
stops being testable, which is the only reason it exists.
Suite: `tests/test-rbac-scoping.js`.
```
CLIENT_SPOOFABLE_HEADERS            — ['x-user-role','x-user-sites','x-user-email'] — the headers api/server.js
                                      trusts VERBATIM (userRank/getSiteFilter read them with no validation)
stripClientIdentity(headers)        — deletes all of the above, in place; returns the same object.
                                      ⛔ middleware.ts calls this ONCE, ahead of EVERY branch. The session branch
                                      always overwrote them from the verified token, but the PUBLIC branch used
                                      to return a bare `NextResponse.rewrite(target)` with no headers object, so
                                      on a public path the caller's own x-user-role reached Express unchanged
                                      (and already chose the actor string written into the audit_log row)
isPublicApiPath(pathname, method)   — true when the request may be proxied with NO session. Exact+anchored for
                                      health|stats|sso|license-status; `maps/public/:uuid` is the one variable
                                      tail, so it is restricted to GET/HEAD and to a SINGLE path segment — it
                                      used to be a bare PREFIX with no method check, which would have made any
                                      future write under it an unauthenticated admin write
```

### api.ts — fetch wrappers for the Express API via the same-origin `/api/*` proxy
```
apiGet<T>(path, signal?, onMeta?) — GET + JSON parse; onMeta(headers) fires before the body is parsed (read X-Total-Count on result-capped routes)
apiSend<T>(path, method, body?) — POST/PUT/PATCH/DELETE + JSON parse
useApi<T>(path, pollMs=0) — React hook: fetch + optional interval polling. Returns { data, error, loading, reload, headers } — `headers` is the last successful response's
```

### auth.ts — NextAuth config
```
authOptions: NextAuthOptions — CredentialsProvider(ssoToken only, no local login; declares only
  email/password/ssoToken — NEVER name/role/userId), delegates to authorizeSsoToken  [SENSITIVE]
authorizeSsoToken(credentials, deps?: { query?: NetvaultQuery; secret?: string }) => Promise<SsoUser|null>
  — the whole SSO trust decision. Verifies the hub JWT (HS256 PINNED), REJECTS anything that is not
  a hub SpanVault SSO token (requires payload.userId + payload.app==='spanvault', rejects typ==='agent'),
  then derives role/name/email/sites from the netvault users + user_sites rows and app-access from
  resolveUserApps (fail-open read of netvault.user_apps). Reads NOTHING from `credentials` but
  `ssoToken`. `deps` exists only so tests/test-sso-authorize.js can stub the DB.
  [SENSITIVE: verifies JWT against NEXTAUTH_SECRET, reads netvault DB, decides the session role]
NetvaultQuery = (sql, params) => Promise<{ rows: any[] }>  — injectable query surface (type export)
SsoUser { id, email, name, role, sites: number[], apps: string[] }  — the session subject (type export)
```

### mapExport.ts — client-side map export
```
downloadMapSvg(svg, filename) — serializes an SVG element to a downloadable file
downloadMapPng(...) — rasterizes the map SVG to PNG for download
```

### mapTypes.ts — map designer types + pure geometry/formatting helpers
```
types: MapDevice, MapConnection, MapLabel, MapShape, FullMap, MapSummary, MapNodeLike
STATUS_FILL — status -> color map
statusFill(status, suppressed?) — resolves a node's fill color
normalizeMap(m) — fills in defaults/back-compat shape on a loaded map
deviceCenter(d) / nodeAnchorBox(d) / edgePoint(...) / elbowPoints(...) — connection routing geometry
fmtBps(bps) — human-readable bandwidth string
utilColor(pct) — green->amber->red color for weathermap link utilization
connLive(c) — resolves a connection's live color/label from bound interface + capacity
```

### publicUrl.ts
```
resolveOrigin(req, port, legacyFallback) — derives origin from x-forwarded-host/host per CURRENT
  request instead of a static env var (see gotchas.md — deliberate opposite priority to getServerUrl
  in api/server.js)
```

### rbac.ts — client-side role helpers (mirrors server-side enforcement, NOT the security boundary)
```
type UserRole = 'super_admin'|'admin'|'site_admin'|'viewer'
canEdit / canManageSettings / canManageAgents / canAcknowledgeAlerts / isSiteScoped(user) — role checks
canAccessSite(user, siteId) — site-scope check
getSiteFilter(user) — site id list for a site_admin, null for unscoped roles
useRbac() — hook, pulls role/sites off the session
```

### theme.ts — light/dark theme
```
getTheme() / applyTheme(theme) / toggleTheme() — reads/writes THEME_KEY in localStorage, sets data-theme
THEME_INIT_SCRIPT — inline script string injected in root layout to avoid a flash of wrong theme
```

### vendor.ts — SNMP vendor-key → display-label map
```
VENDOR_LABELS — Record<vendorKey, label> ('paloalto' → 'Palo Alto', 'hpe-procurve' → 'HPE ProCurve', …)
vendorLabel(v) — label lookup, passthrough for unknown keys, null for null/empty
```
Shared by the devices list and device detail page — they each carried a private
byte-identical copy until 1.88.0. Import from here rather than re-declaring.

### mapIcons.tsx — map editor glyph/shape catalog + renderers
```
DEVICE_GLYPHS / SHAPE_GLYPHS / BASIC_SHAPES — catalog arrays for the "+Shape/Icon" palette
isGlyphKind(kind) / deviceGlyphFor(typeOrName) / serviceGlyphFor(type) — glyph key resolution
glyphArt(kind, color, strokeWidth) — inline SVG art for a glyph kind
MapGlyph({kind,x,y,size,color,strokeWidth}) / GlyphSwatch({kind,size,color}) — React glyph components
```

(lib) frontend/src/lib/corners.ts — rounded/square corner switch. getCorners/applyCorners/toggleCorners/CORNERS_INIT_SCRIPT. Key sv-corners (matches theme.ts sv- prefix, NOT spanvault-), event sv:corners, attribute data-corners="square" on <html>; rounded = ABSENCE of the attribute (there is deliberately no [data-corners="rounded"] rule). Overrides --radius/--radius-sm/--radius-pill ONLY, so any hardcoded numeric borderRadius opts that component out SILENTLY — always use the token.

### entityLinks.ts — where every searchable entity opens (added 1.115.0)
```
type EntityKind = 'device'|'ap'|'controller'|'service'|'client'|'site'
entityHref(kind, id)        -> the route that opens THAT entity:
                               device /devices/:id · service /services/:id · site /sites/:id
                               ap /wireless?tab=aps&apId= · controller /wireless?tab=controllers&controllerId=
                               client /wireless?tab=clients&mac=
ENTITY_DESTINATION          -> what the destination is, in the user's words (result row titles)
announceWirelessTarget(href)-> fires `spanvault:wireless-tab` so a /wireless?tab=… push that lands
                               while /wireless is ALREADY open still applies (App Router does not
                               remount on a query-string change — see gotchas.md)
```
Both searches (TopBarSearch, GlobalSearch) and `wirelessLinks.wirelessHref` resolve through this
one module. Before it, an AP/controller/client result dropped the user on the bare parent tab.

### `lib/wirelessLinks.ts`
wirelessHref(wirelessApId?, wirelessControllerId?) — canonical target for a wireless alert/event subject link. Now a thin wrapper over `entityLinks.entityHref`. AP-scoped → `/wireless?tab=aps&apId=<id>` (deep-links into that AP's drawer); controller-scoped → `/wireless?tab=controllers&controllerId=<id>` (scrolls to and highlights that row — there is still no per-controller detail route); neither → `/wireless`. Takes the two ids rather than a row type because callers' shapes differ (`Alert` vs `EventRow`). Used by `alerts/page.tsx` and the dashboard's Recent Events widget — added 1.98.4 after the two had diverged (the dashboard hardcoded a bare `/wireless`).

## lib/certDays.ts
- `certDaysLeft(validTo: string | null | undefined, storedDaysLeft?: number | null): number | null`
  — whole days until a certificate expires, floored, computed from the stored expiry at render
  time (`cert_days_left` is only correct on the day it was written; the date stays correct) and
  falling back to the stored count when there is no date. The single implementation: the Services
  list and the service detail page previously had their own and disagreed by a day. See gotchas.

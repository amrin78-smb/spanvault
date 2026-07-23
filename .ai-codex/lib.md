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
  candidatesToSamples, collectCandidates, fmtValue, unitFor, PrefetchedSession — discovery/formatting helpers

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

### api.ts — fetch wrappers for the Express API via the same-origin `/api/*` proxy
```
apiGet<T>(path, signal?) — GET + JSON parse
apiSend<T>(path, method, body?) — POST/PUT/PATCH/DELETE + JSON parse
useApi<T>(path, pollMs=0) — React hook: fetch + optional interval polling
```

### auth.ts — NextAuth config
```
authOptions: NextAuthOptions — CredentialsProvider(ssoToken only, no local login), resolves per-user
  app-access (resolveUserApps, fail-open read of netvault.user_apps) and site/name lookups from
  netvault users/user_sites when the SSO JWT omits them  [SENSITIVE: verifies JWT against NEXTAUTH_SECRET, reads netvault DB]
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

### mapIcons.tsx — map editor glyph/shape catalog + renderers
```
DEVICE_GLYPHS / SHAPE_GLYPHS / BASIC_SHAPES — catalog arrays for the "+Shape/Icon" palette
isGlyphKind(kind) / deviceGlyphFor(typeOrName) / serviceGlyphFor(type) — glyph key resolution
glyphArt(kind, color, strokeWidth) — inline SVG art for a glyph kind
MapGlyph({kind,x,y,size,color,strokeWidth}) / GlyphSwatch({kind,size,color}) — React glyph components
```

'use strict';

/**
 * server.js — SpanVault REST API
 * Port: SV_API_PORT (default 3009), bound to 127.0.0.1 only.
 * The Next.js frontend proxies /api/* here; /api/auth/* stays in Next.
 * Plain JavaScript only — no TypeScript syntax.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const express  = require('express');
const path     = require('path');
const { execSync } = require('child_process');
const cors     = require('cors');
const ping     = require('ping');
const { Pool } = require('pg');
const { discoverDevice, snmpTest } = require('../collector/discovery');
const topology = require('../collector/topology');
const wireless = require('../collector/wirelessCollector');
const { startWsServer, connectedAgents, agentLogs, pushConfigToAgent, pushConfigToAgentId, disconnectAgent, sendToAgentId } = require('./ws-server');
const intelligence = require('./intelligence');
const { getLicense, getLicenseState } = require('./licenseCheck');
const reportScheduler = require('./reportScheduler');

// App version — single source of truth is the root package.json.
const { version } = require('../package.json');
// Raw GitHub base for remote version checks (no auth, public repo).
const GH_RAW = 'https://raw.githubusercontent.com/amrin78-smb/spanvault/main';

// Structured release notes keyed by version. When bumping the version, add an
// entry here describing what changed (3-5 bullets). No CHANGELOG.md — these
// notes are the single source surfaced by the update-status API.
const releaseNotes = {
  '1.43.1': [
    'Map editor: aligning/distributing a multi-selection no longer skews positions when a locked element is selected — locked elements are excluded from the alignment math (they were counted but never moved)',
    'Map editor: Duplicate (Ctrl+D / right-click) no longer overwrites your copy/paste clipboard, and a burst of arrow-key nudges now collapses into a single undo step instead of one per keystroke',
    'NOC wallboard: fixed the rotation timer rebuilding itself on every slide change (smoother, drift-free rotation)',
    'Map PNG export now reports an error instead of failing silently, and saving a map no longer drops connectors attached to shapes when the editor preserves existing shapes',
  ],
  '1.43.0': [
    'Map connectors can now attach to decorative shapes/icons (cloud, building, internet, router glyphs, etc.), not just monitored devices — draw a line and click any node OR shape on either end. Connections to a device still work exactly as before, including the live weathermap binding (which only applies when both ends are devices)',
    'Connection endpoints are now typed per-end (device or shape); deleting a shape removes any connectors attached to it, and the line/anchor/elbow rendering works for shape endpoints in the editor, map view, and public share',
  ],
  '1.42.2': [
    'Fixed map save failing with a foreign-key error ("map_devices_drill_map_id_fkey") when a node had no drill-down target — "none" was being stored as drill_map_id 0 instead of NULL. Saving works again (this also blocked saving after switching a node to Icon style)',
    'Fixed the node Width/Height (and shape/connection line-width, font-size) fields in the map editor: you can now clear them and type a multi-digit value — they no longer snap back to the minimum on every keystroke. Values clamp to range only when you leave the field',
  ],
  '1.42.1': [
    'Connector lines now attach to the edge of a node instead of its centre — for icon-style devices the line stops at the icon\'s glyph box rather than running into the middle of the icon, so connections look clean (applies to straight and elbow routing, editor and live view)',
    'Clarified that connections only link monitored devices: clicking a decorative shape (cloud, building, etc.) while drawing a line now cancels the pending connection (shapes were never valid endpoints; this removes the ambiguity)',
  ],
  '1.42.0': [
    'Drill-down sub-maps (Phase 4): a map node can now open a child map (campus → building → rack). Set a node\'s "Drill-down to map" target in the editor; on the live view that node shows a ⊞ badge and clicking it opens the linked map instead of the device page. Cleared automatically if the target map is deleted',
    'NOC Wallboard (Phase 3): a new full-screen rotating display at /maps/wall (linked from the Maps page) cycles through all maps with live status, with play/pause, prev/next, an interval selector (10/15/30/60s) and a fullscreen toggle — ideal for an operations wall display',
    'Map export (Phase 3): export the current map from the view page as SVG (lossless) or PNG. SVG preserves everything including HTML node labels; PNG rasterizes for easy sharing (HTML labels may not appear in PNG in some browsers — use SVG for full fidelity)',
  ],
  '1.41.0': [
    'Map elements can now be grouped: select 2+ devices/shapes/labels and press Ctrl+G (or use the Group button) to bind them — clicking any member then selects and moves the whole group as one. Ctrl+Shift+G (or Ungroup) releases them',
    'Grouping is saved with the layout (a group_id tag on map devices/shapes/labels) and survives reload; locked members inside a group still stay put while the rest of the group moves',
    'This completes the Tier-2 editor pass (elbow routing, lock, align toolbar, grouping)',
  ],
  '1.40.0': [
    'Map elements can now be locked: right-click a device, shape or label and choose Lock to pin it in place (a 🔒 marker shows on locked items). Locked elements can\'t be dragged, resized, marquee-selected, nudged or aligned — ideal for background zones/images you want to stay put while you arrange devices on top. Right-click again to Unlock',
    'Lock state is saved with the map layout (new locked flag on map devices/shapes/labels)',
  ],
  '1.39.0': [
    'Connections can now use orthogonal "elbow" routing (right-angle Manhattan paths) in addition to straight lines — set per connection in the properties panel. Cleaner-looking network diagrams; arrowheads, dashed style, labels and the live weathermap colouring all follow the elbow path',
    'Added a floating align/distribute toolbar that appears above the canvas whenever 2+ elements are selected, so you can align left/centre/right/top/middle/bottom or distribute horizontally/vertically without reaching for the side panel',
  ],
  '1.38.0': [
    'Map editor now guards against losing work: an "● Unsaved / ✓ Saved" indicator in the toolbar tracks pending changes, and the browser warns before you reload or navigate away with unsaved edits',
    'Keyboard ergonomics: arrow keys nudge the selection (1px, or 10px with Shift), Ctrl/Cmd+D duplicates selected shapes/labels, and V / L / T switch between the Select, Line and Label tools',
    'Right-click menu is now contextual with multiple actions — Duplicate (shapes/labels), Bring to front / Send to back (devices/shapes), and Delete — instead of delete-only',
  ],
  '1.37.0': [
    'Network map view now supports zoom and pan: scroll-wheel to zoom toward the cursor, drag the canvas to pan, and on-screen +/−/fit controls with a live zoom-level readout. Large diagrams are finally navigable without everything shrinking to fit',
    'Added a status legend overlay (bottom-left) showing live up/down/warning/unknown device counts for the map; only statuses actually present are listed',
    'Pan-drag is distinguished from a click, so panning the canvas no longer accidentally drills into a device. Applies to both the in-app view and the public share page',
  ],
  '1.36.0': [
    'Map nodes now show a red alert-count badge (top-right corner) when a device has active alerts, so problem devices stand out on the live view and public share; the badge clears when alerts resolve and refreshes on the 30s poll',
    'Richer node tooltips: hovering a device now shows CPU %, memory %, and 24h uptime alongside name/IP/site/status/latency (pulled live from SNMP + ping history)',
    'The map payload (GET /api/maps/:id) now includes per-node latest CPU/memory, 24h uptime, and active alert count via lightweight lateral joins',
  ],
  '1.35.0': [
    'Network maps are now a live NOC weathermap: a connection can be bound to a specific interface on each end device (picked in the connection properties panel) and is then coloured by live link utilization — green under 25%, through yellow/amber, to red at 90%+ — with an animated traffic-flow overlay and a util% / throughput label',
    'Set a link Capacity (Mbps) to drive the utilization %; without it the link still colours by interface up/down status. A bound interface reporting "down" draws the link dashed-red with a DOWN tag',
    'Link stats refresh on the same 30s cadence as device status (on the live view and public share), so the map reflects real traffic without reloading. Utilization comes from existing SNMP interface counters — no new collection',
    'The connection editor shows a live readout (current %/throughput and a colour swatch) while you wire up the binding; unbound connections keep their plain styled-line behaviour exactly as before',
  ],
  '1.34.0': [
    'Map editor device palette is now organised as a collapsible tree grouped by site — each site is a header showing the device count (and how many are already placed, e.g. 2/5); click to expand/collapse so the list stays tidy as the inventory grows',
    'Searching the palette auto-expands every matching site group so results are never hidden behind a collapsed header; devices with no site fall under an "Unassigned" group listed last',
    'Refreshed the map editor toolbar with colored buttons for a cleaner, enterprise look: Undo/Redo and Share in blue, Snap in amber (filled when on), Upload BG in teal, Remove BG in red, Shape/Icon and View Map in violet, and Public maps shown in green',
  ],
  '1.33.0': [
    'Map editor power tools: multi-select (shift-click or drag a marquee), then move, delete, align (left/center/right/top/middle/bottom) or distribute the whole selection at once',
    'Undo / redo (Ctrl+Z / Ctrl+Shift+Z, or the toolbar buttons) across all edits, plus copy/paste (Ctrl+C / Ctrl+V) of shapes and text',
    'Snap-to-grid toggle and live alignment guides — drag a node and it snaps to line up with its neighbours, with blue guide lines showing the match',
    'Connections can now show a directional arrowhead and an adjustable line thickness (set per connection in the properties panel)',
  ],
  '1.32.0': [
    'Map editor can now add decorative, non-device elements: pick from the new "+ Shape / Icon" menu to drop network glyphs (cloud, internet, WAN, router, switch, firewall, server, load balancer, access point, database, building) or basic shapes (rectangle, ellipse, zone box, line, arrow, text). Each is draggable, resizable (8 handles), colorable (fill / line color / width), and supports bring-to-front / send-to-back',
    'Zone boxes and text annotations let you label regions of the diagram (e.g. DMZ, WAN edge, a site); shapes render on the map view and public share too',
    'Decorative icons are built-in inline SVG (no added dependency) and store as tiny rows, so this adds negligible app size and database footprint',
  ],
  '1.31.0': [
    'Network map nodes are now resizable — select a node and drag any of its 8 handles, or set an exact width/height in the properties panel. Long device names no longer touch/overflow the box edge: in Box style the label wraps inside the node, and the new Icon style puts the label beneath the glyph (unbounded)',
    'Each node can be switched between Box style (filled status box) and Icon style (a device glyph — router/switch/firewall/server/AP/etc., colored by status — with the name beneath). Icons are picked automatically from the device type or chosen manually',
    'Added stacking order (Bring to front / Send to back) so overlapping nodes layer the way you want',
    'Map storage now supports decorative, non-device elements (a new map_shapes table) and renders them on the map view/public share; the editor palette to add them (cloud, internet, network glyphs, shapes) lands next',
  ],
  '1.30.0': [
    'Services page is far more compact: multi-type groups now collapse to a single row showing a per-type status chip for each check (HTTP/TCP/SSL/DNS, each with its own up/down/warning dot), so you see every check\'s state at a glance — click to expand the per-type detail rows. Edit and Delete now live only at the group level (the per-type rows are read-only), removing the button clutter',
    'Added a search box and an All/Down/Warning/Up status filter to the Services page so you can jump straight to problem checks instead of scrolling',
    'You can now edit a whole service group at once (change shared settings or which types are monitored) — adds/removes the underlying checks to match (PUT /api/service-checks/group/:id)',
    'Dashboard now surfaces services: a Services KPI tile (up / total, with down/warning counts, links to Services) and a Service Problems card listing any down/warning checks. Both self-hide when there are no services / no problems',
  ],
  '1.29.0': [
    'Service checks can now monitor multiple types for one target in a single action — tick any of HTTP / TCP / SSL / DNS in the New Service Check dialog and SpanVault creates one check per type, deriving each one\'s target and ports automatically (HTTP keeps the URL, TCP/SSL/DNS use the host, TCP/SSL get a port, SSL gets a cert-expiry warning). No more adding the same server four times',
    'The checks created together are shown as a single collapsible group on the Services page (one row per target with per-type sub-rows and an aggregate status), with a one-click "Delete group" to remove them all',
    'Editing an individual check still works per-type as before',
  ],
  '1.28.1': [
    'Fixed the Intelligence tables (Anomalies, Health Scores, etc.) hiding their first data row behind the column headers — the sticky header had a 44px top offset while sitting inside a horizontal-scroll wrapper, which shifted the header down over the first row at the top of the table (e.g. "2 active" anomalies but only one visible). Headers now stick flush at the top, so every row shows',
  ],
  '1.28.0': [
    'Agent-polled devices now get the SAME SNMP coverage as locally-polled ones — full interface stats (status/throughput/utilization), vendor CPU/memory across all 16 supported vendor families, and any custom-OID sensors. Previously a remote agent could only ever report CPU/memory/uptime and ignored sensor selection entirely',
    'Unified the SNMP brain: the server now pushes each agent device a fetch plan (the exact OIDs its detected vendor needs), the agent fetches them raw, and the server interprets them through the same parser registry the central collector uses. Adding a new device vendor is now a single collector parser file that instantly benefits both local and agent-polled devices — no more hardcoded OIDs living separately in the agent',
    'Agents auto-detect device vendor (via sysDescr) and the server records it, so the right vendor OIDs are pushed on the next poll',
    'Bundled agent bumped to v1.4.0 (auto-applied to connected agents via self-update); older agents keep working via the legacy CPU/mem/uptime path until they update',
  ],
  '1.27.9': [
    'Agents now collect CPU and memory from HP/Aruba ProCurve switches (e.g. 5406Rzl2), which publish those in their own MIB rather than the standard HOST-RESOURCES MIB — previously such switches returned only uptime over SNMP. The agent reads sysObjectID to identify the vendor and falls back to the vendor CPU/memory OIDs when the standard ones are empty',
    'Agent SNMP log line now shows the metrics collected (cpu=…% mem=…%) and the detected vendor, making it obvious when a device is only returning uptime',
    'Bumped bundled agent to v1.3.2 (auto-applied to connected agents via self-update)',
  ],
  '1.27.8': [
    'Fixed agent-monitored devices collecting only ICMP and never SNMP (e.g. CPU on a discovered switch) — when an agent discovered a device with a non-default SNMP community, adoption silently replaced it with "public", so every SNMP poll failed. The agent now reports the working community/version it found during discovery, that is stored on the discovered device, and adoption keeps it instead of guessing public/2c',
    'Editing a device\'s SNMP settings now pushes the new config to its agent immediately (was only applied on the agent\'s next reconnect), so correcting the community on an already-adopted device takes effect at once',
    'Agent CPU collection now falls back to walking and averaging the hrProcessorLoad table when the single-instance OID is absent — picks up CPU on multi-core devices and tables that do not start at index .1',
    'Agent now logs why an SNMP poll returned no metrics (timeout vs wrong community vs unsupported OID) instead of failing silently, so SNMP issues are visible in the agent logs',
  ],
  '1.27.7': [
    'Wireless Clients tab "Total Clients" (and per-controller header counts) now use the same live per-AP associated-client gauge as the Wireless Insights "Clients" figure, so the two pages always agree — the controller\'s station table re-reports clients it has already aged out, so it could not be reconciled by polling more often',
    'Reverted the client poll back to every 15 minutes (1.27.6 had moved it to 5) now that the count no longer depends on the station table being fresh — avoids the extra SNMP load for no benefit; the batched roam-count query is kept',
  ],
  '1.27.6': [
    'Fixed the Wireless Clients tab "Total Clients" running far higher than the live client count on Wireless Insights — the collector now polls clients every 5 minutes (was 15) and prunes clients not seen in 7 minutes (was 15), so the station table tracks currently-associated clients instead of holding ones the controller had already aged out',
    'Batched the per-client roam-count lookup into a single grouped query per controller (was one query per client), so the faster client polling does not increase database load',
  ],
  '1.27.5': [
    'Removed the redundant KPI summary cards (Controllers, Avg CPU, AP Capacity, HA Status) from the Wireless → Controllers tab — every value was already shown per-controller in the Inventory, AP Capacity, Health, and HA/Redundancy panels directly below, and the aggregated "HA Status" was misleading since HA is per-pair',
  ],
  '1.27.4': [
    'Fixed the section title touching the card edge on the Intelligence tables (Anomaly Detection, Device Health Scores) — the card removes its padding so the table can span edge-to-edge, but the header now keeps its own padding instead of sitting flush against the left edge',
  ],
  '1.27.3': [
    'Fixed the polling-agent group header on the Devices page rendering white text on a light background (agent name, status, and device count were invisible) — the header now uses the theme foreground colour with a crimson accent stripe',
  ],
  '1.27.2': [
    'Fixed HA detection hiding real HA pairs: a controller reporting an Active/Standby role and a peer is now shown as in-HA even when its SNMP "sync" code maps to Standalone (some platforms, e.g. AOS-8 gateways, report a non-Synced sync value while HA is configured)',
  ],
  '1.27.1': [
    'Fixed a 500 from controller SNMP Diagnostics (and the OID-walk tool) when a controller uses SNMP v3 with incomplete credentials — session creation is now inside the guarded block, so the diagnostics modal shows the real SNMP error instead of failing',
  ],
  '1.27.0': [
    'Manual HA pairing for controllers — link two controllers as an HA pair (with Active/Standby roles) when the platform doesn\'t expose HA over SNMP (e.g. AOS-8 gateways); set on a controller\'s Edit dialog and shown in the HA/Redundancy panel',
  ],
  '1.26.0': [
    'Controller "Detect" now shows its results — a panel listing each capability (model, firmware, licensed APs, HA role/peer/sync) with the OID that resolved and its live value, or "not found", so you can see exactly what a controller exposes (and why e.g. HA isn\'t detected on a given model)',
    'New per-controller "Diagnostics" button — a live read-only SNMP walk showing metadata probes, table row counts, and raw OID samples, to find the correct OID when something isn\'t auto-detected',
  ],
  '1.25.3': [
    'API now has a central error handler — 500s return a clear JSON message (and log the route + stack) instead of an opaque page, so failures like the controller Test are diagnosable',
  ],
  '1.25.2': [
    'The API now auto-applies scripts/schema.sql on startup (idempotent, via the DB pool with an advisory lock) — so deployed code and DB schema always stay in sync without depending on psql or the installer step. This prevents the "new feature 500s because a column wasn\'t migrated" class of issue',
  ],
  '1.25.1': [
    'Fixed a 500 on the Wireless Clients tab (blank KPI cards + sticky filter error) when the is_sticky / retry_rate columns had not been migrated yet — these queries now degrade gracefully like the rest of the app',
  ],
  '1.25.0': [
    'Agent discovery now lets you specify the subnets to scan (CIDR like 10.0.0.0/24, or comma-separated) and the SNMP communities to try — instead of only the agent\'s local /24 with "public"',
    'Subnet sweeps are bounded (max /20, ~4096 hosts) to prevent accidental huge scans. Agent runtime -> v1.3.0',
  ],
  '1.24.1': [
    'Wireless Clients tab now has a Sticky-clients count card and a "Sticky only" filter (alongside the existing problem-client filter)',
  ],
  '1.24.0': [
    'Rogue AP detection — SpanVault now collects unmanaged/rogue APs that your wireless controllers detect (Cisco/Aruba/Ruckus via SNMP) and lists them on a new Wireless → Rogue APs tab with classification, signal, channel, and detecting AP',
    'Optional alert on rogue/malicious detections (enable wireless_rogue_alerts_enabled)',
  ],
  '1.23.0': [
    'Sticky-client detection — clients with poor signal that won\'t roam off a distant AP are now flagged distinctly from frequent roamers (a "Sticky" badge in the Clients view)',
  ],
  '1.22.0': [
    'AP detail drawer now charts RF history: noise floor and retry rate over time, alongside the existing client-count and channel-utilization trends',
    'Retry rate is now historized so its trend accumulates going forward',
  ],
  '1.21.0': [
    'Wireless alerting — SpanVault now raises alerts for AP down, controller offline, high channel utilization, and AP reboots/flaps (previously wireless data was collected but never alerted on)',
    'Wireless alerts flow through the normal engine (routing/escalation/email) and appear in the Alerts page linked to the AP/controller',
    'Channel-utilization alert threshold configurable via wireless_util_threshold_pct (default 90%)',
  ],
  '1.20.0': [
    'Data retention & rollups — raw ping/SNMP samples are now rolled up to daily availability summaries and purged beyond a configurable window (default 14 days), so the database no longer grows unbounded',
    'Configurable retention for raw samples, daily rollups, and the audit log (Settings → General → Data Retention)',
    'Fixes the long-range SLA/uptime tiles that depended on the previously-unpopulated daily availability table',
  ],
  '1.19.0': [
    'Audit logging — every successful change (devices, settings, alert rules, agents, acknowledgements, etc.) is recorded with the verified user, timestamp, action, and source IP (secrets redacted)',
    'New admin-only Audit Log tab under Settings',
  ],
  '1.18.1': [
    'Security: write-side RBAC enforced server-side — read-only (viewer) roles can no longer create/delete devices or change settings, and configuration changes (settings, alert rules, agents, controllers, service checks) now require an admin role',
    'Alert acknowledgements are attributed to the verified signed-in user instead of a client-supplied value (no longer forgeable)',
  ],
  '1.18.0': [
    'Baseline anomaly alerting — SpanVault can now alert when latency, CPU, or memory deviates sharply from a device\'s learned normal (z-score), not just on fixed thresholds (opt-in: Settings → Email Alerts)',
    'Anomaly detection expanded beyond latency to CPU and memory; anomaly alerts auto-resolve when the metric returns to normal',
  ],
  '1.17.0': [
    'New Services page — agentless uptime checks for HTTP/HTTPS, TCP ports, SSL certificate expiry, and DNS, like PRTG sensors',
    'Checks run from the central collector or from a remote agent (for services only reachable inside a site)',
    'Service checks alert through the normal engine: "Service Down" (critical) and "SSL Expiring" (warning, configurable days), shown in the Alerts page and emailed/routed/escalated like any alert',
  ],
  '1.16.0': [
    'Interface bandwidth utilization % is now computed from in/out throughput and link speed (ifHighSpeed) and stored per interface',
    'The "bandwidth_pct" alert rule now works (previously a no-op) — alert when an interface crosses a utilization threshold',
  ],
  '1.15.0': [
    'Alert escalation — if an alert stays active and unacknowledged past a step\'s delay, SpanVault emails that step\'s recipients (or the current on-call); multiple ordered steps supported',
    'On-call rotation — define shifts (contact + time window); escalation steps can target "current on-call"',
    'Configurable in Settings → Email Alerts (enable, escalate critical-only or warning+critical)',
  ],
  '1.14.0': [
    'Notification routing — send alerts matching a severity, site, and/or type to specific email recipients (Settings → Email Alerts); unmatched alerts fall back to the global recipient list',
    'Recovery ("all-clear") emails are now sent when an alert resolves (toggle in settings)',
    'Re-notification throttle suppresses repeat emails for a flapping alert within a configurable cooldown (default 15 min)',
  ],
  '1.13.0': [
    'Access Points table (Wireless tab) now has sortable column headers — click any header to sort ascending/descending (alphabetical for AP Name/Site/Status, numeric for Clients/channels/utilization/uptime, by time for Last Seen)',
    'A sort indicator shows the active column and direction; clicking the same header again flips the direction',
  ],
  '1.12.0': [
    'Devices polled by a remote agent are now alerted on (down / high-latency / your alert rules) — previously distributed polling collected data but never raised alerts',
    'Agent-down dependency: when an agent goes offline, you get ONE "Agent Down" alert and its devices\' alerts are suppressed instead of a flood of false device-down alerts (the devices aren\'t down — they\'re just unreachable while the agent is offline)',
    'When the agent reconnects, normal per-device alerting resumes automatically',
    'Agent-down alerts appear in the Alerts page (linked to the agent) and send email like any other critical alert',
  ],
  '1.11.5': [
    'Agent detail page now explains how monitoring works: an agent polls every device in the sites assigned to it — added inline guidance on the Assigned Sites, Devices, and Discover panels so the workflow is self-explanatory',
  ],
  '1.11.4': [
    'Fixed the agent crashing on startup with a JSON BOM error: the installer wrote config.json with a UTF-8 BOM (Windows PowerShell Out-File) that Node\'s JSON.parse rejects. Installer now writes config without a BOM, and the agent strips one defensively',
  ],
  '1.11.3': [
    'Agent installer checks for Administrator rights up front and exits with clear guidance, instead of downloading files and NSSM before failing at service registration',
  ],
  '1.11.2': [
    'Agent installer no longer aborts on a fresh host: the idempotent service cleanup only runs when the SpanVault-Agent service already exists, fixing the "nssm.exe: Can\'t open service!" error on first install',
  ],
  '1.11.1': [
    'Agent installer now fetches NSSM from the SpanVault server itself instead of the public nssm.cc, which was returning 503 and blocking installs on hosts without internet access to it',
    'Server serves nssm.exe (from NetVault\'s bundled copy or SV_NSSM_PATH); nssm.cc is now only a last-resort fallback',
  ],
  '1.11.0': [
    'Remote agent management: rename, restart, and pull a live log tail straight from the agent detail page — no RDP into the remote server',
    'Bulk actions on the Agents list: multi-select to disable, enable, or delete several agents at once',
    'A site can now belong to only one agent — assigning a site already owned by another agent reassigns it cleanly (and refreshes the other agent)',
    'Agents reconnect with exponential backoff + jitter so a fleet doesn\'t reconnect in lockstep after an outage. Agent runtime -> v1.2.0',
  ],
  '1.10.0': [
    'Agents now self-report host health on every heartbeat (CPU, memory, disk, uptimes, buffered-result depth, device count) — shown in a new "Agent Host Health" panel',
    'Agent auto-update: the server fingerprints the canonical agent.js and agents that differ pull the new build, verify it, and restart themselves — no manual redeploy across the fleet',
    'Agent detail page flags when an agent is running an older build (it self-heals on the next config sync)',
    'Agent runtime bumped to v1.1.0 (health reporting + self-update)',
  ],
  '1.9.0': [
    'Zero-touch discovery: an agent can sweep its own local network (ICMP + SNMP) and report every device it finds — drop an agent at a site and it discovers everything, no manual entry',
    'New "Discover Devices" panel on the agent detail page: click Scan, then one-click adopt found devices straight into monitoring (assigned to that agent)',
    'Discovered devices already being monitored are flagged so you never create duplicates',
    'Adopted devices are placed in one of the agent\'s assigned sites so they stay owned by the agent',
  ],
  '1.8.0': [
    'Agents now authenticate with the API key in an Authorization header instead of the URL, so the secret no longer lands in proxy/access logs (server still accepts the old form during upgrade)',
    'Optional TLS (wss://) for the agent WebSocket via SV_WS_TLS_CERT / SV_WS_TLS_KEY',
    'Rotate an agent\'s API key from its detail page — the old key is invalidated immediately and the agent is dropped until re-installed',
    'Disable/enable an agent without deleting it: a disabled agent is disconnected and its handshake refused until re-enabled (shown with a Disabled badge)',
  ],
  '1.7.0': [
    'Agent installer now auto-downloads NSSM when it is missing, so the service registers on a clean server without NetVault present (previously failed with "nssm is not recognized")',
    'Installer adds a preflight connectivity check, verifies the service actually reached Running state, and prints clear success/log-path output',
    'New-agent dialog now shows live "Waiting for the agent to connect..." that flips to "Connected!" with hostname/version the moment the remote agent comes online',
    'Re-running the installer is now idempotent (cleans any prior service), and an offline/air-gapped path is supported by skipping npm install when a bundled node_modules is present',
  ],
  '1.6.1': [
    'Fixed the agent install command — it now runs correctly in PowerShell (the previous "irm | iex -ServerUrl ..." form failed with a parameter-binding error)',
    'Remote agents now poll SNMPv3 devices correctly (auth/priv credentials were previously ignored, so v3 devices reported no metrics)',
    'A reconnecting agent is no longer wrongly knocked offline when its stale socket closes after the new one connects',
    'Agent installer aborts if dependency install fails instead of registering a broken service; poll errors are caught and logged',
    'Stale heartbeats are no longer buffered/replayed, keeping each agent\'s "last seen" time accurate',
  ],
  '1.6.0': [
    'Wireless Insights tab is now interactive — KPI tiles (Total APs, Offline, Clients, Controllers) deep-link straight into their tab',
    'Click any Top AP, Offline AP, or High-Utilization AP row to open that access point\'s detail drawer',
    'Top SSID rows jump to the SSIDs tab scoped to that controller; Controller Status rows open that controller\'s access points',
    'The Offline tile now deep-links to access points filtered to offline (status filter lifted to the page), and a "View problem clients" shortcut was added',
    'Subtle "click a row to drill in" hints and pointer/hover affordances added to the now-clickable containers',
  ],
  '1.5.8': [
    'Standardized Updates and About tabs to NocVault suite spec',
  ],
  '1.5.7': [
    'Standardized Settings menu (split Email Alerts and About into own tabs)',
  ],
  '1.5.6': [
    'Standardized Settings page styling to match NocVault suite',
  ],
  '1.5.5': [
    'Fixed sticky tab bars not covering content while scrolling — the scroll container\'s top padding left a gap above the pinned bar where rows showed through (Wireless, Topology, Settings, Intelligence)',
    'Intelligence table column headers now stick just below the tab bar instead of behind it, so they stay visible while scrolling',
  ],
  '1.5.4': [
    'Fixed clipped third line on the dashboard KPI cards (Wireless APs "X clients · Y SSIDs" and SLA "Target") — increased the KPI strip tile height so 3-line tiles fit',
  ],
  '1.5.3': [
    'Fixed Radio Performance always showing "Poor" — unreported noise floor was being stored as 0 (Number(null)===0) and misclassified; absent metrics now stay NULL',
    'Retry rate and RX/TX errors no longer show a misleading 0 when the vendor does not report them',
    'AP detail drawer shows "No data" / "—" for noise floor when there is no real (negative dBm) reading',
  ],
  '1.5.2': [
    'Fixed the "View all clients" link in the access-point detail drawer — it now opens the Clients tab filtered to that AP',
  ],
  '1.5.1': [
    'Tab pages now keep their tab bar pinned to the top while you scroll (Wireless, Intelligence, Settings, Topology)',
    'Compact single-line page headers (title · subtitle) free up vertical space for data',
    'Consistent header styling across all tabbed pages',
  ],
  '1.5.0': [
    'Renamed the wireless Overview tab to "Wireless Insights" with a consolidated controller-status strip',
    'AP capacity now breaks down per controller as a clustered licensed-vs-used bar chart instead of one aggregate donut',
    'Edit a controller\'s SNMP community/version/port inline — no need to open the Devices page',
    'Controller Capabilities (edit/test/probe) panel moved to the top of the Controllers tab and expanded by default',
    'Removed duplicated AP/Client KPI tiles from the Controllers tab (Wireless Insights owns the headline totals)',
  ],
  '1.4.1': [
    'Decimal-MAC access points are now blocked at the shared write path for every vendor (not just Aruba)',
  ],
  '1.4.0': [
    'Add a wireless controller in one step — the SNMP path can now create its monitored device inline, no more adding it under Devices first',
    '"Scan for controllers" button auto-detects SNMP controllers from already-monitored wireless devices on demand',
    'Provisioning reuses an existing device when the IP already matches (no duplicates)',
  ],
  '1.3.2': [
    'Wireless APs KPI now sits inline in the top metrics row (no more orphaned tile)',
    'Top row trimmed to the most beneficial KPIs in a single responsive strip',
    'Unknown, MTTA and wireless/agents tiles now appear only when they carry signal',
  ],
  '1.3.1': [
    'Denser dashboard: status and operational KPIs consolidated into a single top row',
    'SLA breaches now sit alongside site health and the availability trend',
    'Lower panels regrouped into 3-up rows to cut scrolling',
    'Fixed the wireless health card overflowing its container',
  ],
  '1.3.0': [
    'Enterprise dashboard: operational band with MTTR, MTTA and unacknowledged-alert KPIs',
    'Open Incidents panel plus a 30-day SLA tile and SLA-breach watchlist',
    'Capacity planning (CPU/memory p95), recurring-pattern prediction and least-reliable device ranking',
    'Bandwidth top-talkers, planned-maintenance awareness, and a network-wide wireless health panel',
  ],
  '1.2.0': [
    'Enterprise dashboard with health score and charts',
    'Animated login page redesign',
    'Server status monitoring',
    'Automatic versioning across suite',
  ],
  '1.2.3': [
    'More reliable auto-reload after applying an update',
    'Update deploys now advance cleanly (hard-reset deploy, WinRM-safe install)',
    'Cleaner update screen with structured release notes',
    'Removed the legacy CHANGELOG file',
  ],
  '1.2.4': [
    'Removed duplicate access points that showed a decimal MAC address instead of a name',
    'Aruba AP parser now rejects MAC-shaped names so stale records are not recreated',
    'One-time wireless collector startup cleanup of legacy decimal-MAC AP records',
  ],
  'default': [
    'Bug fixes and performance improvements',
  ],
};

const IS_WIN = process.platform === 'win32';

// ── Crash resilience ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const app  = express();
const PORT = parseInt(process.env.SV_API_PORT || '3009', 10);
const PROD = process.env.NODE_ENV === 'production';

// ── Databases ─────────────────────────────────────────────────
// SpanVault's own DB (read/write)
const sv = new Pool({
  host:     process.env.SV_DB_HOST || 'localhost',
  port:     parseInt(process.env.SV_DB_PORT || '5432', 10),
  database: process.env.SV_DB_NAME || 'spanvault',
  user:     process.env.SV_DB_USER || 'spanvault_user',
  password: process.env.SV_DB_PASS || '',
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30000,
});
sv.on('error', (err) => console.error('[DB sv] Pool error:', err.message));

// NetVault DB (read-only — devices & sites source)
const nv = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  ssl: false,
  max: 5,
  idleTimeoutMillis: 30000,
});
nv.on('error', (err) => console.error('[DB nv] Pool error:', err.message));

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '12mb' })); // generous — map background images arrive base64-encoded
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── License enforcement ───────────────────────────────────────
// Checks the NocVault license (cached 24h) and gates writes during grace and
// all access once disabled. Never blocks on network failure.
async function enforceLicense(req, res, next) {
  const license = await getLicense();
  const state   = getLicenseState(license);
  req.licenseState = state;
  req.license      = license;

  // Block writes during grace/disabled
  if (!state.canWrite && ['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    const isAck = req.path.includes('acknowledge') && req.method === 'POST';
    if (!isAck) {
      return res.status(402).json({
        error: 'License expired — write operations disabled',
        license_status: license?.status,
        days_remaining: license?.daysRemaining,
      });
    }
  }

  // Block all access if disabled
  const exemptPaths = ['/api/health', '/api/stats', '/api/license-status', '/api/system/update-available'];
  if (state.disabled && !exemptPaths.some(p => req.path.startsWith(p))) {
    return res.status(402).json({
      error: 'License has expired. Please renew your NocVault license.',
      license_status: license?.status,
    });
  }

  next();
}

app.use(enforceLicense);

// ── Write-side RBAC ───────────────────────────────────────────
// Roles arrive via the proxy-set x-user-role header (verified token, not
// spoofable). viewer = read-only (blocked from all mutations); site_admin can do
// operational writes (devices, acks, maps, reports); admin/super_admin can also
// change configuration/infrastructure (settings, rules, agents, controllers, …).
const ROLE_RANK = { viewer: 0, site_admin: 1, admin: 2, super_admin: 3 };
const ADMIN_ONLY_WRITE = [
  /^\/api\/settings$/, /^\/api\/system\//,
  /^\/api\/agents(\/|$)/, /^\/api\/alert-rules(\/|$)/,
  /^\/api\/notification-routes(\/|$)/, /^\/api\/escalation-steps(\/|$)/,
  /^\/api\/oncall-shifts(\/|$)/, /^\/api\/maintenance(\/|$)/,
  /^\/api\/service-checks(\/|$)/, /^\/api\/wireless\/controllers(\/|$)/,
  /^\/api\/topology\//, /^\/api\/intelligence\//,
];
function userRank(req) {
  const role = req.headers['x-user-role'] || 'viewer';
  return ROLE_RANK[role] != null ? ROLE_RANK[role] : 0;
}
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const rank = userRank(req);
  if (rank < 1) return res.status(403).json({ error: 'Your role is read-only.' });
  if (rank < 2 && ADMIN_ONLY_WRITE.some((re) => re.test(req.path))) {
    return res.status(403).json({ error: 'This action requires an admin role.' });
  }
  next();
});

// ── Audit logging ─────────────────────────────────────────────
// One row per successful mutation (who/what/when/where). Secrets are redacted.
function sanitizeAuditBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Array.isArray(body) ? { _count: body.length } : null;
  }
  const out = {};
  for (const k of Object.keys(body)) {
    if (/pass|secret|api_?key|token|community|priv/i.test(k)) out[k] = '***';
    else if (typeof body[k] === 'string' && body[k].length > 300) out[k] = body[k].slice(0, 300) + '…';
    else if (typeof body[k] === 'object' && body[k] !== null) out[k] = '[object]';
    else out[k] = body[k];
  }
  return out;
}
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return; // only audit successful mutations
    const detail = sanitizeAuditBody(req.body);
    sv.query(
      `INSERT INTO audit_log (user_email, user_role, method, path, status, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.headers['x-user-email'] || null, req.headers['x-user-role'] || null,
       req.method, req.path, res.statusCode, detail ? JSON.stringify(detail) : null,
       (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0] || null]
    ).catch(() => { /* audit_log may be un-migrated — ignore */ });
  });
  next();
});

// ── Helpers ───────────────────────────────────────────────────
function safeInt(val, def, max) {
  const n = parseInt(val, 10);
  if (isNaN(n) || n <= 0) return def;
  return (max && n > max) ? max : n;
}
function scoreGrade(s) {
  return s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F';
}
function signalQuality(rssi) {
  if (rssi === null || rssi === undefined) return 'Unknown';
  if (rssi >= -60) return 'Excellent';
  if (rssi >= -70) return 'Good';
  if (rssi >= -80) return 'Fair';
  return 'Poor';
}
function rangeToInterval(range) {
  switch (range) {
    case '7d':  return '7 days';
    case '30d': return '30 days';
    case '90d': return '90 days';
    case '24h':
    default:    return '24 hours';
  }
}
function rangeToBucket(range) {
  switch (range) {
    case '7d':  return '1 hour';
    case '30d': return '6 hours';
    case '90d': return '1 day';
    case '24h':
    default:    return '5 minutes';
  }
}
function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = cols.join(',');
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
  return head + '\n' + body;
}
function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(rows));
}
// async route wrapper
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── RBAC site scoping ─────────────────────────────────────────
// The frontend middleware sets x-user-role / x-user-sites headers from the
// session when proxying /api/* calls. A site_admin is scoped to their assigned
// sites; admin/viewer (and missing headers) get null = no filter. Filtering is
// enforced here, server-side, so a site_admin cannot bypass it by calling the
// API directly.
function getSiteFilter(req) {
  const sites = req.headers['x-user-sites'];
  const role = req.headers['x-user-role'];
  if (role === 'site_admin' && sites) {
    const siteIds = String(sites).split(',').map(Number).filter(Boolean);
    return siteIds.length > 0 ? siteIds : null;
  }
  return null; // no filter for admin/viewer
}

// Push a site filter onto `params` and return the SQL clause (or null when the
// user is unscoped). `col` is the site_id column reference, e.g. 'd.site_id'.
function siteFilterClause(siteFilter, params, col) {
  if (!siteFilter || !siteFilter.length) return null;
  params.push(siteFilter);
  return `${col} = ANY($${params.length}::int[])`;
}

// Device-scope filter for report queries (monitored_devices aliased as d).
// Pushes any site_id/device_id/site-scope values onto `params` and returns
// clause strings.
function reportFilters(q, params, siteFilter) {
  const f = ['d.active = TRUE'];
  if (q.site_id)   { params.push(parseInt(q.site_id, 10));   f.push(`d.site_id = $${params.length}`); }
  if (q.device_id) { params.push(parseInt(q.device_id, 10)); f.push(`d.id = $${params.length}`); }
  const sc = siteFilterClause(siteFilter, params, 'd.site_id');
  if (sc) f.push(sc);
  return f;
}

// Public base URL agents use (frontend, which proxies /api/*). Prefer the
// configured SV_PUBLIC_URL; otherwise derive from the incoming request.
function getServerUrl(req) {
  if (process.env.SV_PUBLIC_URL) return process.env.SV_PUBLIC_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

// ══════════════════════════════════════════════════════════════
// Agent files (served unauthenticated for the bootstrap installer)
// ══════════════════════════════════════════════════════════════
app.get('/api/agent/install.ps1', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, '..', 'agent', 'install.ps1'));
});
app.get('/api/agent/agent.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'agent', 'agent.js'));
});
app.get('/api/agent/package.json', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'agent', 'package.json'));
});
// Serve NSSM to the installer from the SpanVault server itself, so a remote agent
// host never needs to reach the public nssm.cc (which can be down/blocked). The
// binary is taken from a bundled copy or a configured path (NetVault ships one on
// the same server). 404 if unavailable — the installer then falls back to nssm.cc.
app.get('/api/agent/nssm.exe', (req, res) => {
  const fs = require('fs');
  const candidates = [
    process.env.SV_NSSM_PATH,
    path.join(__dirname, '..', 'agent', 'nssm.exe'),
    'C:\\Apps\\NetVault\\nssm\\nssm-2.24\\win64\\nssm.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => { try { return fs.existsSync(p); } catch (_e) { return false; } });
  if (!found) return res.status(404).send('nssm not available on server');
  res.sendFile(found);
});

// ══════════════════════════════════════════════════════════════
// Health
// ══════════════════════════════════════════════════════════════
app.get('/api/health', wrap(async (_req, res) => {
  await sv.query('SELECT 1');
  res.json({ status: 'ok', service: 'spanvault-api', version, time: new Date().toISOString() });
}));

// ══════════════════════════════════════════════════════════════
// Public stats (read-only, NO-AUTH — same access level as /api/health)
// ══════════════════════════════════════════════════════════════
// Permissive CORS is already applied globally via app.use(cors()) above, so
// this responds with Access-Control-Allow-Origin: * like /api/health. On any
// error we return zeros with HTTP 200 — this endpoint never 500s.
//   monitored_devices = count of active monitored devices
//   availability      = avg uptime % over last 24h (status='up' ping samples),
//                       rounded to 1 decimal; 0.0 when no samples
//   active_alerts     = count of alerts with status='active'
app.get('/api/stats', async (_req, res) => {
  try {
    const [devices, avail, alerts] = await Promise.all([
      sv.query(`SELECT COUNT(*)::int AS c FROM monitored_devices WHERE active = TRUE`),
      sv.query(`
        SELECT ROUND(100.0 * SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END)
                          / NULLIF(COUNT(*), 0), 1) AS pct
        FROM ping_results WHERE ts >= NOW() - INTERVAL '24 hours'`),
      sv.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE status = 'active'`),
    ]);
    const pct = avail.rows[0] && avail.rows[0].pct != null ? Number(avail.rows[0].pct) : 0.0;
    res.json({
      monitored_devices: devices.rows[0] ? devices.rows[0].c : 0,
      availability: pct,
      active_alerts: alerts.rows[0] ? alerts.rows[0].c : 0,
    });
  } catch (e) {
    console.error('[stats] query failed:', e.message);
    res.json({ monitored_devices: 0, availability: 0.0, active_alerts: 0 });
  }
});

// ══════════════════════════════════════════════════════════════
// System updates (Check for Updates)
// ══════════════════════════════════════════════════════════════
// Semver compare: is `remote` newer than `local` ("1.2.0" style strings)?
function isNewer(remote, local) {
  const [rM, rm, rp] = String(remote).split('.').map(Number);
  const [lM, lm, lp] = String(local).split('.').map(Number);
  if (rM !== lM) return rM > lM;
  if (rm !== lm) return rm > lm;
  return rp > lp;
}

// App's own repo root (one level up from api/). Used for git hash lookup.
const APP_ROOT = path.join(__dirname, '..');

// Local short git commit hash for the deployed checkout, or null if git is
// unavailable (e.g. a non-git deploy). Update detection degrades gracefully.
function localCommitHash() {
  try {
    return execSync('git rev-parse HEAD', { cwd: APP_ROOT })
      .toString().trim().slice(0, 7);
  } catch {
    return null;
  }
}

// Compares the local git commit hash against the latest commit on GitHub's main
// branch. ANY differing commit counts as an update available — package.json
// version is for display only. Never 500s the Settings page — a fetch failure
// degrades to "up to date" with an error string.
app.get('/api/system/update-status', wrap(async (_req, res) => {
  const localVersion = version;
  const localHash = localCommitHash();
  try {
    // Cache-bust so GitHub's raw CDN can't return a stale copy — the Settings
    // "Re-check" button must reflect a freshly pushed commit immediately.
    const bust = Date.now();
    const [commitRes, pkgRes] = await Promise.all([
      fetch('https://api.github.com/repos/amrin78-smb/spanvault/commits/main', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store',
      }),
      fetch(`${GH_RAW}/package.json?cb=${bust}`, { cache: 'no-store' }),
    ]);
    const commit = await commitRes.json();
    const remoteHash = commit && commit.sha ? String(commit.sha).slice(0, 7) : null;
    const remotePkg = await pkgRes.json();
    const remoteVersion = remotePkg.version;

    // Release notes for the latest version, falling back to a generic message.
    const release_notes = releaseNotes[remoteVersion] || releaseNotes['default'];

    // Any differing commit = update available. If either hash is missing
    // (e.g. git unavailable or API error), treat as up to date to avoid
    // false alarms.
    const updateAvail = !!remoteHash && !!localHash && remoteHash !== localHash;
    res.json({
      current_version: localVersion,
      latest_version: remoteVersion,
      current_commit: localHash,
      latest_commit: remoteHash,
      current_hash: localHash,
      latest_hash: remoteHash,
      up_to_date: !updateAvail,
      update_available: updateAvail,
      release_notes,
      release_date: new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    console.error('[update-status] version check failed:', e.message);
    res.json({ up_to_date: true, error: 'Could not check for updates' });
  }
}));

// Background update check: cached so the cross-app notifier banner can poll
// cheaply without each page hitting GitHub. Refreshed on startup + every 24h.
let updateAvailable = null; // { current, latest } when an update exists, else null

async function checkForUpdates() {
  try {
    const localHash = localCommitHash();
    const [commitRes, pkgRes] = await Promise.all([
      fetch('https://api.github.com/repos/amrin78-smb/spanvault/commits/main', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store',
      }),
      fetch(`${GH_RAW}/package.json?cb=${Date.now()}`, { cache: 'no-store' }),
    ]);
    const commit = await commitRes.json();
    const remoteHash = commit && commit.sha ? String(commit.sha).slice(0, 7) : null;
    const remotePkg = await pkgRes.json();
    const remoteVersion = remotePkg.version;

    updateAvailable = (localHash && remoteHash && remoteHash !== localHash)
      ? { current: version, latest: remoteVersion }
      : null;
  } catch {
    // never block on network failure — keep the last known state
  }
}

// Cached update availability for the notifier banner (no auth required).
app.get('/api/system/update-available', (_req, res) => {
  if (updateAvailable) {
    res.json({ available: true, current: updateAvailable.current, latest: updateAvailable.latest });
  } else {
    res.json({ available: false });
  }
});

// Launches the update via a one-time Windows Scheduled Task running as SYSTEM.
// Why a scheduled task and not a spawned child: this API runs as a limited
// service account (e.g. THAIUNION\service.prtg). When it spawns the updater as a
// child, stopping the API service tears that child down before it can restart the
// services — and the service account may also lack rights to start services. A
// scheduled task launched by the Task Scheduler under SYSTEM is fully detached
// from this service's process tree and has the permissions + lifetime to finish.
app.post('/api/system/update', wrap(async (_req, res) => {
  // SERVER_IP is loaded from .env.local via dotenv at startup. No hardcoded IP
  // and no fallback (CLAUDE.md) — if it isn't configured we cannot update.
  const serverIp = process.env.SERVER_IP || '';
  if (!serverIp) {
    return res.status(400).json({
      error: 'SERVER_IP not configured in .env.local — add SERVER_IP=your_server_ip to .env.local',
    });
  }

  // License enforcement — only active and trial licenses may pull updates.
  const license = await getLicense();
  const state   = getLicenseState(license);

  if (state.disabled) {
    return res.status(402).json({
      error: 'License expired — renew your NocVault license to receive updates.',
      license_status: license ? license.status : undefined,
    });
  }

  if (state.mode === 'grace') {
    return res.status(402).json({
      error: 'License expired — you are in the grace period. Renew to get updates.',
      license_status: license ? license.status : undefined,
      days_remaining: license ? license.daysRemaining : undefined,
    });
  }
  const scriptPath = path.join(__dirname, '..', 'installer', 'Update-SpanVault.ps1').replace(/\//g, '\\');
  try {
    // Remove any leftover task from a previous run (ignore "not found").
    try { execSync('schtasks /delete /tn "SpanVaultUpdate" /f', { stdio: 'ignore' }); } catch (_e) { /* none */ }

    // Create a one-time task under the SYSTEM account (full permissions).
    execSync(
      `schtasks /create /tn "SpanVaultUpdate" ` +
      `/tr "powershell.exe -NonInteractive -ExecutionPolicy Bypass ` +
      `-File \\"${scriptPath}\\" -ServerIp \\"${serverIp}\\"" ` +
      `/sc once /st 00:00 /f /ru SYSTEM`,
      { stdio: 'pipe' }
    );

    // Run it immediately.
    execSync('schtasks /run /tn "SpanVaultUpdate"', { stdio: 'pipe' });

    console.log('[Update] Task scheduled under SYSTEM, ServerIp:', serverIp);
    res.json({ started: true });
  } catch (err) {
    console.error('[Update] schtasks error:', err.message);
    res.status(500).json({ error: 'Failed to schedule update: ' + err.message });
  }
}));

// ══════════════════════════════════════════════════════════════
// License status
// ══════════════════════════════════════════════════════════════
app.get('/api/license-status', wrap(async (req, res) => {
  const license = await getLicense();
  const state   = getLicenseState(license);
  res.json({ license, state });
}));

// Collector liveness: 'running' if the collector has stamped its heartbeat in
// app_settings within the last 2 min. The heartbeat is written on a fixed
// cadence independent of device polling, so a fresh install with 0 devices
// still reports 'running' as long as the collector process is alive.
app.get('/api/collector/status', wrap(async (_req, res) => {
  const r = await sv.query(`SELECT value FROM app_settings WHERE key = 'collector_heartbeat'`);
  const lastTs = r.rows[0] && r.rows[0].value ? new Date(r.rows[0].value) : null;
  const fresh = lastTs && (Date.now() - lastTs.getTime()) <= 120 * 1000;
  res.json({ status: fresh ? 'running' : 'stopped', last_ts: lastTs ? lastTs.toISOString() : null });
}));

// Proxy the NocVault hub's settings server-side so the browser doesn't make a
// cross-origin (CORS-blocked) request to the hub. Used by the idle-timeout UI.
app.get('/api/hub/settings', wrap(async (_req, res) => {
  const hub = (process.env.NOCVAULT_HUB_URL || 'http://localhost:3000').replace(/\/+$/, '');
  try {
    const r = await fetch(`${hub}/api/settings`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return res.status(502).json({ error: `Hub returned ${r.status}` });
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e && e.message ? e.message : 'Hub unreachable' });
  }
}));

// ══════════════════════════════════════════════════════════════
// Dashboard
// ══════════════════════════════════════════════════════════════
app.get('/api/dashboard/summary', wrap(async (req, res) => {
  const siteFilter = getSiteFilter(req);
  const p1 = [];
  const sc1 = siteFilterClause(siteFilter, p1, 'site_id');
  const q = await sv.query(`
    SELECT current_status AS status, COUNT(*)::int AS count
    FROM monitored_devices WHERE active = TRUE${sc1 ? ` AND ${sc1}` : ''}
    GROUP BY current_status
  `, p1);
  const counts = { up: 0, down: 0, warning: 0, unknown: 0 };
  for (const row of q.rows) {
    if (counts[row.status] !== undefined) counts[row.status] = row.count;
  }
  // Devices whose agent is offline are surfaced separately (not counted as down).
  const p2 = [];
  const sc2 = siteFilterClause(siteFilter, p2, 'site_id');
  const offline = await sv.query(
    `SELECT COUNT(*)::int AS c FROM monitored_devices WHERE active = TRUE AND current_status = 'agent_offline'${sc2 ? ` AND ${sc2}` : ''}`, p2);
  const total = counts.up + counts.down + counts.warning + counts.unknown;
  // Admin/viewer: count every active alert (original behavior). Site-scoped:
  // only alerts on devices in the user's sites.
  let active;
  if (siteFilter) {
    const p3 = [siteFilter];
    active = await sv.query(
      `SELECT COUNT(*)::int AS c FROM alerts a
         JOIN monitored_devices d ON d.id = a.device_id
        WHERE a.status = 'active' AND d.site_id = ANY($1::int[])`, p3);
  } else {
    active = await sv.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE status = 'active'`);
  }
  const agents = await sv.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'online')::int AS online
    FROM agents`);
  res.json({
    total, ...counts,
    agent_offline: offline.rows[0].c,
    active_alerts: active.rows[0].c,
    agents_total: agents.rows[0].total,
    agents_online: agents.rows[0].online,
  });
}));

// Devices unreachable because their polling agent is offline, grouped by agent.
app.get('/api/dashboard/agent-offline', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT a.id AS agent_id, a.name AS agent_name, a.hostname, a.last_seen_at,
           COUNT(d.*)::int AS device_count
    FROM agents a
    JOIN monitored_devices d ON d.agent_id = a.id AND d.active = TRUE
    WHERE a.status = 'offline'
    GROUP BY a.id, a.name, a.hostname, a.last_seen_at
    HAVING COUNT(d.*) > 0
    ORDER BY a.name
  `);
  res.json(r.rows);
}));

// Active problems — every device currently down or warning, worst first.
app.get('/api/dashboard/problems', wrap(async (req, res) => {
  // Suppressed devices are hidden — when a site gateway is down they're covered
  // by the gateway's entry. A down gateway reports how many devices its outage
  // is suppressing at the same site.
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.site_id, d.site_name, d.current_status,
           d.last_response_ms, d.last_checked_at, d.last_seen_at, d.consecutive_failures,
           d.is_gateway,
           CASE WHEN d.is_gateway THEN (
             SELECT COUNT(*)::int FROM monitored_devices c
              WHERE c.site_id IS NOT DISTINCT FROM d.site_id AND c.id <> d.id
                AND c.active = TRUE AND c.alert_suppressed = TRUE
           ) ELSE 0 END AS suppressed_in_site
    FROM monitored_devices d
    WHERE d.active = TRUE AND d.current_status IN ('down', 'warning')
      AND d.alert_suppressed = FALSE${sc ? ` AND ${sc}` : ''}
    ORDER BY CASE d.current_status WHEN 'down' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
             d.name
  `, params);
  res.json(r.rows);
}));

// Top 10 worst devices by average response time over the last hour.
app.get('/api/dashboard/top-worst', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT d.id, d.name, d.site_id, d.site_name, d.current_status,
           ROUND(AVG(p.response_ms)::numeric, 1)      AS avg_ms,
           ROUND(MAX(p.response_ms)::numeric, 1)      AS max_ms,
           ROUND(AVG(p.packet_loss_pct)::numeric, 1)  AS packet_loss_pct
    FROM ping_results p
    JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts >= NOW() - INTERVAL '1 hour' AND d.active = TRUE${sc ? ` AND ${sc}` : ''}
    GROUP BY d.id, d.name, d.site_id, d.site_name, d.current_status
    HAVING AVG(p.response_ms) IS NOT NULL
    ORDER BY AVG(p.response_ms) DESC
    LIMIT 10
  `, params);
  res.json(r.rows);
}));

// 24h network availability trend in 30-minute buckets (sparkline/area chart).
app.get('/api/dashboard/network-trend', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT date_bin('30 minutes', p.ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           COUNT(*)::int AS total_checks,
           SUM(CASE WHEN p.status = 'up' THEN 1 ELSE 0 END)::int AS up_checks
    FROM ping_results p
    ${sc ? 'JOIN monitored_devices d ON d.id = p.device_id' : ''}
    WHERE p.ts >= NOW() - INTERVAL '24 hours'${sc ? ` AND ${sc}` : ''}
    GROUP BY bucket
    ORDER BY bucket
  `, params);
  const rows = r.rows.map((row) => ({
    bucket: row.bucket,
    total_checks: row.total_checks,
    up_checks: row.up_checks,
    pct_up: row.total_checks
      ? Math.round((row.up_checks / row.total_checks) * 1000) / 10
      : null,
  }));
  res.json(rows);
}));

// Per-site health: device counts + 24h uptime (reachable = not down).
app.get('/api/dashboard/site-health', wrap(async (req, res) => {
  const params = [];
  const scDev = siteFilterClause(getSiteFilter(req), params, 'site_id');
  const scUpt = scDev ? scDev.replace('site_id', 'd.site_id') : null;
  const r = await sv.query(`
    WITH dev AS (
      SELECT COALESCE(site_id, 0)            AS site_id,
             COALESCE(site_name, 'Unassigned') AS site_name,
             COUNT(*)::int                                                  AS total_devices,
             SUM(CASE WHEN current_status = 'up'      THEN 1 ELSE 0 END)::int AS up_count,
             SUM(CASE WHEN current_status = 'down'    THEN 1 ELSE 0 END)::int AS down_count,
             SUM(CASE WHEN current_status = 'warning' THEN 1 ELSE 0 END)::int AS warning_count,
             SUM(CASE WHEN current_status = 'unknown' THEN 1 ELSE 0 END)::int AS unknown_count
      FROM monitored_devices WHERE active = TRUE${scDev ? ` AND ${scDev}` : ''}
      GROUP BY 1, 2
    ),
    upt AS (
      SELECT COALESCE(d.site_id, 0) AS site_id,
             ROUND(100.0 * SUM(CASE WHEN p.status <> 'down' THEN 1 ELSE 0 END)
                         / NULLIF(COUNT(*), 0), 1) AS avg_uptime_pct
      FROM ping_results p
      JOIN monitored_devices d ON d.id = p.device_id
      WHERE p.ts >= NOW() - INTERVAL '24 hours' AND d.active = TRUE${scUpt ? ` AND ${scUpt}` : ''}
      GROUP BY 1
    )
    SELECT dev.site_id, dev.site_name, dev.total_devices, dev.up_count,
           dev.down_count, dev.warning_count, dev.unknown_count,
           upt.avg_uptime_pct
    FROM dev LEFT JOIN upt ON upt.site_id = dev.site_id
    ORDER BY dev.down_count DESC, dev.warning_count DESC, dev.site_name
  `);
  res.json(r.rows);
}));

// Last 20 notable events — alerts triggered or resolved in the last 24h.
app.get('/api/dashboard/events', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT a.id, a.device_id, d.name AS device_name, d.site_id, d.site_name,
           a.alert_type, a.severity, a.status, a.message,
           a.triggered_at, a.resolved_at,
           GREATEST(a.triggered_at, COALESCE(a.resolved_at, a.triggered_at)) AS event_at
    FROM alerts a
    LEFT JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.triggered_at >= NOW() - INTERVAL '24 hours'
       OR a.resolved_at  >= NOW() - INTERVAL '24 hours'
    ORDER BY event_at DESC
    LIMIT 20
  `);
  res.json(r.rows);
}));

// ══════════════════════════════════════════════════════════════
// Dashboard — enterprise panels (ops metrics, SLA, capacity,
// patterns, reliability, top-talkers, maintenance, wireless)
// ══════════════════════════════════════════════════════════════

// ── Operational metrics: MTTR / MTTA / unacknowledged + open incident count ──
// MTTR/MTTA are averaged over the last 30 days. unacked_count = active alerts
// never acknowledged. open_incidents guarded for DBs predating the incidents table.
app.get('/api/dashboard/ops-summary', wrap(async (req, res) => {
  const siteFilter = getSiteFilter(req);

  const p1 = [];
  const sc1 = siteFilterClause(siteFilter, p1, 'd.site_id');
  const agg = await sv.query(`
    SELECT
      ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)
            FILTER (WHERE a.resolved_at IS NOT NULL
                      AND a.resolved_at >= NOW() - INTERVAL '30 days')::numeric, 1) AS mttr_minutes,
      ROUND(AVG(EXTRACT(EPOCH FROM (a.acknowledged_at - a.triggered_at)) / 60.0)
            FILTER (WHERE a.acknowledged_at IS NOT NULL
                      AND a.acknowledged_at >= NOW() - INTERVAL '30 days')::numeric, 1) AS mtta_minutes
    FROM alerts a
    JOIN monitored_devices d ON d.id = a.device_id
    ${sc1 ? `WHERE ${sc1}` : ''}
  `, p1);

  const p2 = [];
  const sc2 = siteFilterClause(siteFilter, p2, 'd.site_id');
  const unack = await sv.query(`
    SELECT COUNT(*)::int AS c
    FROM alerts a
    JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.status = 'active' AND a.acknowledged_at IS NULL${sc2 ? ` AND ${sc2}` : ''}
  `, p2);

  let openIncidents = 0;
  const caps = await getAlertCaps();
  if (caps.has_incidents) {
    try {
      const inc = await sv.query(`SELECT COUNT(*)::int AS c FROM incidents WHERE status = 'active'`);
      openIncidents = inc.rows[0] ? inc.rows[0].c : 0;
    } catch (_e) { openIncidents = 0; }
  }

  res.json({
    mttr_minutes: agg.rows[0] ? agg.rows[0].mttr_minutes : null,
    mtta_minutes: agg.rows[0] ? agg.rows[0].mtta_minutes : null,
    unacked_count: unack.rows[0] ? unack.rows[0].c : 0,
    open_incidents: openIncidents,
  });
}));

// ── Open incidents (latest 10) with root-cause device name ──
app.get('/api/dashboard/incidents', wrap(async (_req, res) => {
  const caps = await getAlertCaps();
  if (!caps.has_incidents) return res.json([]);
  try {
    const r = await sv.query(`
      SELECT i.id, i.title, i.affected_count, i.severity, i.started_at,
             i.root_cause_device_id, d.name AS root_cause_device_name
      FROM incidents i
      LEFT JOIN monitored_devices d ON d.id = i.root_cause_device_id
      WHERE i.status = 'active'
      ORDER BY i.started_at DESC
      LIMIT 10
    `);
    res.json(r.rows);
  } catch (_e) {
    res.json([]);
  }
}));

// ── 30-day SLA compliance: rolling availability + per-device breaches ──
app.get('/api/dashboard/sla', wrap(async (req, res) => {
  const siteFilter = getSiteFilter(req);

  // No dedicated app_settings key today; default 99.5%, but honour an optional
  // 'sla_target_pct' key if one is ever added.
  let slaTarget = 99.5;
  try {
    const st = await sv.query(`SELECT value FROM app_settings WHERE key = 'sla_target_pct'`);
    if (st.rows[0] && st.rows[0].value != null && st.rows[0].value !== '') {
      const v = parseFloat(st.rows[0].value);
      if (!isNaN(v)) slaTarget = v;
    }
  } catch (_e) { /* key absent — keep default */ }

  const pOv = [];
  const scOv = siteFilterClause(siteFilter, pOv, 'd.site_id');
  const ov = await sv.query(`
    SELECT 100.0 * SUM(a.total_checks - a.failed_checks)
                 / NULLIF(SUM(a.total_checks), 0) AS overall_pct
    FROM availability_summary a
    JOIN monitored_devices d ON d.id = a.device_id
    WHERE d.active = TRUE
      AND a.date >= (CURRENT_DATE - INTERVAL '30 days')${scOv ? ` AND ${scOv}` : ''}
  `, pOv);
  const overallPct = ov.rows[0] && ov.rows[0].overall_pct != null
    ? Math.round(Number(ov.rows[0].overall_pct) * 10) / 10
    : null;

  const pBr = [slaTarget];
  const scBr = siteFilterClause(siteFilter, pBr, 'd.site_id');
  const br = await sv.query(`
    SELECT d.id, d.name, d.site_id, d.site_name,
           ROUND(100.0 * SUM(a.total_checks - a.failed_checks)
                      / NULLIF(SUM(a.total_checks), 0), 2) AS uptime_pct
    FROM availability_summary a
    JOIN monitored_devices d ON d.id = a.device_id
    WHERE d.active = TRUE
      AND a.date >= (CURRENT_DATE - INTERVAL '30 days')${scBr ? ` AND ${scBr}` : ''}
    GROUP BY d.id, d.name, d.site_id, d.site_name
    HAVING SUM(a.total_checks) > 0
       AND (100.0 * SUM(a.total_checks - a.failed_checks)
                  / NULLIF(SUM(a.total_checks), 0)) < $1
    ORDER BY uptime_pct ASC
    LIMIT 10
  `, pBr);

  res.json({ overall_pct: overallPct, sla_target: slaTarget, breaching: br.rows });
}));

// ── Approaching capacity — CPU/memory baselines (p95 >= 80%) ──
app.get('/api/dashboard/capacity', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT DISTINCT ON (b.device_id, b.metric)
           d.id, d.name, d.site_id, d.site_name, b.metric,
           ROUND(b.p95::numeric, 1) AS p95,
           ROUND(b.p99::numeric, 1) AS p99
    FROM device_baselines b
    JOIN monitored_devices d ON d.id = b.device_id
    WHERE d.active = TRUE
      AND b.metric IN ('cpu_pct', 'mem_pct')
      AND b.p95 IS NOT NULL${sc ? ` AND ${sc}` : ''}
    ORDER BY b.device_id, b.metric, b.period_days DESC
  `, params);
  // p95 >= 80 flag + p95 DESC + limit 10 applied after picking the largest-period
  // row per device/metric (can't ORDER BY p95 alongside DISTINCT ON).
  const rows = r.rows
    .filter((row) => row.p95 != null && Number(row.p95) >= 80)
    .sort((a, b) => Number(b.p95) - Number(a.p95))
    .slice(0, 10);
  res.json(rows);
}));

// ── Recurring patterns (predictive) — top by confidence/frequency ──
app.get('/api/dashboard/patterns', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT p.id, p.device_id, d.name AS device_name,
           p.pattern_type, p.metric, p.description,
           p.confidence, p.occurrence_count, p.hour_of_day, p.day_of_week
    FROM device_patterns p
    JOIN monitored_devices d ON d.id = p.device_id
    WHERE d.active = TRUE${sc ? ` AND ${sc}` : ''}
    ORDER BY p.confidence DESC, p.occurrence_count DESC
    LIMIT 6
  `, params);
  res.json(r.rows);
}));

// ── Least reliable devices — worst alert offenders over the last 30 days ──
app.get('/api/dashboard/least-reliable', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT d.id, d.name, d.site_id, d.site_name, d.current_status,
           COUNT(*)::int AS alert_count,
           COUNT(*) FILTER (WHERE a.alert_type = 'device_down')::int AS outage_count,
           MAX(a.triggered_at) AS last_alert_at
    FROM alerts a
    JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.triggered_at >= NOW() - INTERVAL '30 days'
      AND d.active = TRUE${sc ? ` AND ${sc}` : ''}
    GROUP BY d.id, d.name, d.site_id, d.site_name, d.current_status
    HAVING COUNT(*) > 0
    ORDER BY COUNT(*) DESC, MAX(a.triggered_at) DESC
    LIMIT 10
  `, params);
  res.json(r.rows);
}));

// ── Bandwidth top talkers — busiest interfaces by recent throughput ──
// Matches BOTH backward-compat shared metric names (if_in_bps / if_out_bps) and
// selective per-interface names (if_<idx>_in_bps / if_<idx>_out_bps); both carry
// if_index, so the latest sample is grouped per (device_id, if_index). Last ~15m.
app.get('/api/dashboard/top-talkers', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    WITH latest AS (
      SELECT DISTINCT ON (s.device_id, s.if_index, kind)
             s.device_id, s.if_index, s.if_name,
             CASE WHEN s.metric_name = 'if_in_bps'  OR s.metric_name ~ '^if_[0-9]+_in_bps$'  THEN 'in'
                  ELSE 'out' END AS kind,
             s.value
      FROM snmp_results s
      WHERE s.if_index IS NOT NULL
        AND s.value IS NOT NULL
        AND s.ts >= NOW() - INTERVAL '15 minutes'
        AND (s.metric_name IN ('if_in_bps', 'if_out_bps')
             OR s.metric_name ~ '^if_[0-9]+_(in|out)_bps$')
      ORDER BY s.device_id, s.if_index, kind, s.ts DESC
    ),
    paired AS (
      SELECT device_id, if_index,
             MAX(if_name)                                            AS if_name,
             COALESCE(MAX(value) FILTER (WHERE kind = 'in'),  0)     AS in_bps,
             COALESCE(MAX(value) FILTER (WHERE kind = 'out'), 0)     AS out_bps
      FROM latest
      GROUP BY device_id, if_index
    )
    SELECT d.id AS device_id, d.name AS device_name, p.if_index, p.if_name,
           p.in_bps, p.out_bps
    FROM paired p
    JOIN monitored_devices d ON d.id = p.device_id
    WHERE d.active = TRUE${sc ? ` AND ${sc}` : ''}
    ORDER BY (p.in_bps + p.out_bps) DESC
    LIMIT 8
  `, params);
  res.json(r.rows.map((row) => ({
    device_id: row.device_id,
    device_name: row.device_name,
    if_index: Number(row.if_index),
    if_name: row.if_name || `if${row.if_index}`,
    in_bps: row.in_bps == null ? 0 : Number(row.in_bps),
    out_bps: row.out_bps == null ? 0 : Number(row.out_bps),
  })));
}));

// ── Maintenance windows — active now + upcoming within 7 days ──
app.get('/api/dashboard/maintenance', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT m.id, m.device_id, d.name AS device_name, d.site_name,
           m.starts_at, m.ends_at, m.reason,
           CASE WHEN NOW() BETWEEN m.starts_at AND m.ends_at THEN 'active'
                ELSE 'upcoming' END AS state
    FROM maintenance_windows m
    JOIN monitored_devices d ON d.id = m.device_id AND d.active = TRUE
    WHERE (
            (NOW() BETWEEN m.starts_at AND m.ends_at)
            OR (m.starts_at > NOW() AND m.starts_at <= NOW() + INTERVAL '7 days')
          )${sc ? ` AND ${sc}` : ''}
    ORDER BY m.starts_at
  `, params);
  const active = [];
  const upcoming = [];
  for (const row of r.rows) {
    if (row.state === 'active') active.push(row);
    else upcoming.push(row);
  }
  res.json({ active, upcoming });
}));

// ── Network-level wireless intelligence rollup for the dashboard ──
// Complements the small "APs online" tile. Returns has_data:false (zeros) when no
// wireless intelligence has been computed yet so the panel can render nothing.
app.get('/api/dashboard/wireless-intel', wrap(async (req, res) => {
  const filter = getSiteFilter(req);

  const p1 = [];
  const sc1 = siteFilterClause(filter, p1, 'c.site_id');
  const agg = await sv.query(`
    SELECT
      COUNT(*)::int                                        AS controllers_with_intel,
      COALESCE(SUM(wi.co_channel_pairs), 0)::int           AS co_channel_pairs,
      COALESCE(SUM(wi.overloaded_aps), 0)::int             AS overloaded_aps,
      COALESCE(SUM(wi.critical_util_count), 0)::int        AS critical_util_count,
      COALESCE(AVG(wi.interference_score), 0)::numeric     AS interference_score,
      COALESCE(AVG(wi.capacity_score), 0)::numeric         AS capacity_score,
      COALESCE(AVG(wi.band_steering_score), 0)::numeric    AS band_steering_score,
      COALESCE(SUM(wi.overall_score * ap.cnt), 0)::numeric AS weighted_score_sum,
      COALESCE(SUM(ap.cnt), 0)::int                        AS weighted_ap_total,
      COALESCE(AVG(wi.overall_score), 0)::numeric          AS mean_score
    FROM wireless_intelligence wi
    JOIN wireless_controllers c ON c.id = wi.controller_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM wireless_aps a WHERE a.controller_id = wi.controller_id
    ) ap ON TRUE
    ${sc1 ? `WHERE ${sc1}` : ''}
  `, p1);
  const a = agg.rows[0];

  const p2 = [];
  const sc2 = siteFilterClause(filter, p2, 'c.site_id');
  const ctl = await sv.query(
    `SELECT COUNT(*)::int AS c FROM wireless_controllers c ${sc2 ? `WHERE ${sc2}` : ''}`, p2);
  const total_controllers = ctl.rows[0].c;

  const p3 = [];
  const sc3 = siteFilterClause(filter, p3, 'c.site_id');
  const prob = await sv.query(`
    SELECT COUNT(*)::int AS c
    FROM wireless_clients cl
    JOIN wireless_controllers c ON c.id = cl.controller_id
    WHERE cl.is_problem = TRUE${sc3 ? ` AND ${sc3}` : ''}
  `, p3);

  const hasIntel = (a.controllers_with_intel || 0) > 0;
  const overall_score = Math.round(
    a.weighted_ap_total > 0
      ? Number(a.weighted_score_sum) / Number(a.weighted_ap_total)
      : Number(a.mean_score)
  );

  res.json({
    has_data: hasIntel,
    total_controllers,
    controllers_with_intel: a.controllers_with_intel,
    overall_score: hasIntel ? overall_score : 0,
    overall_grade: hasIntel ? scoreGrade(overall_score) : 'A',
    interference_score: Math.round(Number(a.interference_score)),
    capacity_score: Math.round(Number(a.capacity_score)),
    band_steering_score: Math.round(Number(a.band_steering_score)),
    co_channel_pairs: a.co_channel_pairs,
    overloaded_aps: a.overloaded_aps,
    critical_util_count: a.critical_util_count,
    problem_clients: prob.rows[0].c,
  });
}));

// ══════════════════════════════════════════════════════════════
// Monitored devices
// ══════════════════════════════════════════════════════════════
app.get('/api/devices', wrap(async (req, res) => {
  const { status, site_id, q } = req.query;
  const where = ['d.active = TRUE'];
  const params = [];
  if (status)  { params.push(status);  where.push(`d.current_status = $${params.length}`); }
  if (site_id) { params.push(parseInt(site_id, 10)); where.push(`d.site_id = $${params.length}`); }
  if (q)       { params.push(`%${q}%`); where.push(`(d.name ILIKE $${params.length} OR d.ip_address ILIKE $${params.length})`); }
  const devSc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  if (devSc) where.push(devSc);
  const rows = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.device_type, d.site_id, d.site_name,
           d.current_status, d.last_response_ms, d.last_seen_at, d.last_checked_at,
           d.snmp_enabled, d.poll_interval_seconds, d.netvault_device_id,
           d.is_gateway, d.alert_suppressed, d.suppressed_by_device_id,
           d.agent_id, ag.name AS agent_name, ag.status AS agent_status,
           cpu.value AS latest_cpu_pct, mem.value AS latest_mem_pct,
           avail.uptime_24h_pct, la.last_alert_at, spark.days AS spark
    FROM monitored_devices d
    LEFT JOIN agents ag ON ag.id = d.agent_id
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = d.id AND metric_name = 'cpu_pct'
      ORDER BY ts DESC LIMIT 1
    ) cpu ON TRUE
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = d.id AND metric_name = 'mem_pct'
      ORDER BY ts DESC LIMIT 1
    ) mem ON TRUE
    LEFT JOIN LATERAL (
      SELECT ROUND((1 - (SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::numeric
                    / NULLIF(COUNT(*), 0))) * 100, 1) AS uptime_24h_pct
      FROM ping_results
      WHERE device_id = d.id AND ts >= NOW() - INTERVAL '24 hours'
    ) avail ON TRUE
    LEFT JOIN LATERAL (
      SELECT MAX(triggered_at) AS last_alert_at
      FROM alerts WHERE device_id = d.id AND alert_type <> 'recovery'
        AND triggered_at >= NOW() - INTERVAL '24 hours'
    ) la ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('day', to_char(day, 'YYYY-MM-DD'), 'uptime', uptime) ORDER BY day) AS days
      FROM (
        SELECT date_trunc('day', ts) AS day,
               ROUND((1 - (SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::numeric
                      / NULLIF(COUNT(*), 0))) * 100, 0) AS uptime
        FROM ping_results
        WHERE device_id = d.id AND ts >= date_trunc('day', NOW()) - INTERVAL '6 days'
        GROUP BY 1
      ) s
    ) spark ON TRUE
    WHERE ${where.join(' AND ')}
    ORDER BY d.site_name NULLS LAST, d.name
  `, params);
  res.json(rows.rows);
}));

// Mini sensor sparklines for the device list — last 24h aggregated into 24
// hourly buckets per device. Registered BEFORE /api/devices/:id so Express does
// not treat "sparklines" as an :id. response_ms: 0 = down, null = no data.
// GET /api/devices/sparklines?device_ids=1,2,3
app.get('/api/devices/sparklines', wrap(async (req, res) => {
  const ids = String(req.query.device_ids || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return res.json({});

  // 24 aligned hourly buckets × the requested devices.
  const buckets = `
    hours AS (
      SELECT generate_series(
        date_trunc('hour', NOW()) - INTERVAL '23 hours',
        date_trunc('hour', NOW()),
        INTERVAL '1 hour'
      ) AS h
    ),
    dev AS (SELECT unnest($1::int[]) AS device_id)
  `;

  const pingRows = await sv.query(`
    WITH ${buckets}
    SELECT d.device_id, h.h AS bucket,
      CASE
        WHEN COUNT(p.id) = 0 THEN NULL
        WHEN SUM(CASE WHEN p.status = 'up' THEN 1 ELSE 0 END) = 0 THEN 0
        ELSE ROUND(AVG(p.response_ms) FILTER (WHERE p.status = 'up')::numeric, 1)
      END AS response_ms
    FROM dev d
    CROSS JOIN hours h
    LEFT JOIN ping_results p
      ON p.device_id = d.device_id AND date_trunc('hour', p.ts) = h.h
    GROUP BY d.device_id, h.h
    ORDER BY d.device_id, h.h
  `, [ids]);

  const snmpRows = await sv.query(`
    WITH ${buckets}
    SELECT d.device_id, h.h AS bucket,
      ROUND(AVG(s.value) FILTER (WHERE s.metric_name = 'cpu_pct')::numeric, 1) AS cpu_pct,
      ROUND(AVG(s.value) FILTER (WHERE s.metric_name = 'mem_pct')::numeric, 1) AS mem_pct
    FROM dev d
    CROSS JOIN hours h
    LEFT JOIN snmp_results s
      ON s.device_id = d.device_id AND date_trunc('hour', s.ts) = h.h
     AND s.metric_name IN ('cpu_pct', 'mem_pct')
    GROUP BY d.device_id, h.h
    ORDER BY d.device_id, h.h
  `, [ids]);

  const out = {};
  for (const id of ids) out[id] = { response_ms: [], cpu_pct: [], mem_pct: [] };
  for (const r of pingRows.rows) {
    out[r.device_id].response_ms.push(r.response_ms === null ? null : Number(r.response_ms));
  }
  for (const r of snmpRows.rows) {
    out[r.device_id].cpu_pct.push(r.cpu_pct === null ? null : Number(r.cpu_pct));
    out[r.device_id].mem_pct.push(r.mem_pct === null ? null : Number(r.mem_pct));
  }
  // Collapse CPU/Mem to null when the device produced no SNMP data at all.
  for (const id of ids) {
    const e = out[id];
    if (e.cpu_pct.every((v) => v === null)) e.cpu_pct = null;
    if (e.mem_pct.every((v) => v === null)) e.mem_pct = null;
  }
  res.json(out);
}));

app.get('/api/devices/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE id = $1`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(r.rows[0]);
}));

app.post('/api/devices', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.ip_address) return res.status(400).json({ error: 'name and ip_address are required' });
  const r = await sv.query(`
    INSERT INTO monitored_devices
      (name, ip_address, device_type, site_id, site_name,
       snmp_enabled, snmp_version, snmp_community, snmp_port,
       snmp_v3_user, snmp_v3_auth_pass, snmp_v3_priv_pass,
       poll_interval_seconds, ping_threshold_ms, ping_failures_before_down)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (ip_address) DO NOTHING
    RETURNING *
  `, [
    b.name, b.ip_address, b.device_type || null, b.site_id || null, b.site_name || null,
    b.snmp_enabled || false, b.snmp_version || '2c', b.snmp_community || 'public',
    safeInt(b.snmp_port, 161), b.snmp_v3_user || null, b.snmp_v3_auth_pass || null,
    b.snmp_v3_priv_pass || null, safeInt(b.poll_interval_seconds, 300),
    safeInt(b.ping_threshold_ms, 500), safeInt(b.ping_failures_before_down, 3),
  ]);
  if (!r.rows[0]) return res.status(409).json({ error: 'A device with this IP is already monitored' });
  // Auto-assign to a polling agent if one owns this device's site.
  const agentId = await assignDeviceAgent(r.rows[0].id, r.rows[0].site_id);
  if (agentId) {
    try { await pushConfigToAgentId(agentId); } catch (e) { console.error('[devices] push config failed:', e.message); }
  }
  const fresh = await sv.query(`SELECT * FROM monitored_devices WHERE id = $1`, [r.rows[0].id]);
  res.status(201).json(fresh.rows[0]);
}));

app.put('/api/devices/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = [
    'name','ip_address','device_type','site_id','site_name','snmp_enabled','snmp_version',
    'snmp_community','snmp_port','snmp_v3_user','snmp_v3_auth_pass','snmp_v3_priv_pass',
    'poll_interval_seconds','ping_threshold_ms','ping_failures_before_down','active',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  params.push(id);
  const r = await sv.query(
    `UPDATE monitored_devices SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Device not found' });
  // If this device is polled by a remote agent, push the new config so edited
  // SNMP credentials (e.g. correcting the community) take effect immediately
  // instead of waiting for the agent to reconnect.
  if (r.rows[0].agent_id) {
    try { await pushConfigToAgentId(r.rows[0].agent_id); }
    catch (e) { console.error('[device update] push config failed:', e.message); }
  }
  res.json(r.rows[0]);
}));

app.delete('/api/devices/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await sv.query(`DELETE FROM monitored_devices WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

// Ping history (bucketed)
app.get('/api/devices/:id/ping-history', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const interval = rangeToInterval(req.query.range);
  const bucket = rangeToBucket(req.query.range);
  const r = await sv.query(`
    SELECT date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           ROUND(AVG(response_ms)::numeric, 1) AS avg_ms,
           ROUND(MAX(packet_loss_pct)::numeric, 1) AS max_loss,
           SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS down_samples
    FROM ping_results
    WHERE device_id = $2 AND ts >= NOW() - $3::interval
    GROUP BY bucket ORDER BY bucket
  `, [bucket, id, interval]);
  res.json(r.rows);
}));

// SNMP history (bucketed, per metric, optionally per interface)
app.get('/api/devices/:id/snmp-history', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const metric = String(req.query.metric || 'cpu_pct');
  const interval = rangeToInterval(req.query.range);
  const bucket = rangeToBucket(req.query.range);
  const r = await sv.query(`
    SELECT date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           if_name,
           ROUND(AVG(value)::numeric, 2) AS avg_value
    FROM snmp_results
    WHERE device_id = $2 AND metric_name = $3 AND ts >= NOW() - $4::interval
    GROUP BY bucket, if_name ORDER BY bucket
  `, [bucket, id, metric, interval]);
  res.json(r.rows);
}));

app.get('/api/devices/:id/alerts', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`
    SELECT id, alert_type, severity, message, metric_value,
           triggered_at, acknowledged_at, acknowledged_by, resolved_at, status
    FROM alerts WHERE device_id = $1 ORDER BY triggered_at DESC LIMIT 200
  `, [id]);
  res.json(r.rows);
}));

// Per-day availability for the 90-day calendar (only days with data are
// returned; the UI fills the rest as "no data"). incidents = device_down
// alerts that started that day.
app.get('/api/devices/:id/uptime-calendar', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const days = safeInt(req.query.days, 90, 366);
  // Return a complete, ordered day series (gaps filled with nulls) so the client
  // renders it directly with no date-key matching — avoids client/DB timezone skew.
  const r = await sv.query(`
    WITH series AS (
      SELECT generate_series(date_trunc('day', NOW()) - (($2 - 1) || ' days')::interval,
                             date_trunc('day', NOW()), INTERVAL '1 day') AS d
    ),
    pings AS (
      SELECT date_trunc('day', ts) AS d,
             COUNT(*) AS total_checks,
             SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END) AS bad
      FROM ping_results
      WHERE device_id = $1 AND ts >= date_trunc('day', NOW()) - (($2 - 1) || ' days')::interval
      GROUP BY 1
    ),
    inc AS (
      SELECT date_trunc('day', triggered_at) AS d, COUNT(*) AS incidents
      FROM alerts
      WHERE device_id = $1 AND alert_type = 'device_down'
        AND triggered_at >= date_trunc('day', NOW()) - (($2 - 1) || ' days')::interval
      GROUP BY 1
    )
    SELECT to_char(series.d, 'YYYY-MM-DD') AS day,
           CASE WHEN p.total_checks > 0
                THEN ROUND((1 - (p.bad::numeric / p.total_checks)) * 100, 1) ELSE NULL END AS uptime_pct,
           COALESCE(p.total_checks, 0)::int AS total_checks,
           COALESCE(i.incidents, 0)::int AS incidents
    FROM series
    LEFT JOIN pings p ON p.d = series.d
    LEFT JOIN inc i   ON i.d = series.d
    ORDER BY series.d
  `, [id, days]);
  res.json(r.rows);
}));

// Quick-stat cards: 30-day uptime, 7-day avg response (vs baseline),
// 30-day alert count, and the latest health score.
app.get('/api/devices/:id/quick-stats', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [uptime, avg, baseline, alerts, health] = await Promise.all([
    sv.query(`SELECT ROUND((1 - (SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::numeric
                   / NULLIF(COUNT(*), 0))) * 100, 2) AS pct
                FROM ping_results WHERE device_id = $1 AND ts >= NOW() - INTERVAL '30 days'`, [id]),
    sv.query(`SELECT ROUND(AVG(response_ms)::numeric, 1) AS ms
                FROM ping_results WHERE device_id = $1 AND ts >= NOW() - INTERVAL '7 days'
                  AND response_ms IS NOT NULL`, [id]),
    sv.query(`SELECT mean FROM device_baselines WHERE device_id = $1 AND metric = 'response_ms'
                ORDER BY period_days ASC LIMIT 1`, [id]),
    sv.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE device_id = $1
                AND triggered_at >= NOW() - INTERVAL '30 days' AND alert_type <> 'recovery'`, [id]),
    sv.query(`SELECT score, grade, trend FROM device_health_scores WHERE device_id = $1`, [id]),
  ]);
  res.json({
    uptime_30d_pct: uptime.rows[0] ? uptime.rows[0].pct : null,
    avg_response_7d: avg.rows[0] ? avg.rows[0].ms : null,
    baseline_response: baseline.rows[0] ? Number(baseline.rows[0].mean) : null,
    alerts_30d: alerts.rows[0] ? alerts.rows[0].c : 0,
    health_score: health.rows[0] ? Number(health.rows[0].score) : null,
    health_grade: health.rows[0] ? health.rows[0].grade : null,
    health_trend: health.rows[0] ? health.rows[0].trend : null,
  });
}));

// Latest per-interface status + traffic (for the interface status panel).
app.get('/api/devices/:id/interfaces', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Handles both selective metric names (if_<idx>_oper/in_bps/out_bps) and the
  // backward-compat shared names (if_oper_status/if_in_bps/if_out_bps); both
  // carry if_index, so group on that column. DISTINCT keeps the latest sample
  // per (metric_name, if_index).
  const r = await sv.query(`
    SELECT DISTINCT ON (metric_name, if_index) metric_name, if_index, if_name, value
    FROM snmp_results
    WHERE device_id = $1
      AND (metric_name ~ '^if_[0-9]+_(oper|in_bps|out_bps)$'
           OR metric_name IN ('if_oper_status', 'if_in_bps', 'if_out_bps'))
      AND if_index IS NOT NULL
      AND ts >= NOW() - INTERVAL '1 day'
    ORDER BY metric_name, if_index, ts DESC
  `, [id]);
  const byIdx = new Map();
  for (const row of r.rows) {
    const idx = Number(row.if_index);
    if (!isFinite(idx)) continue;
    const mn = row.metric_name;
    const kind = (mn === 'if_oper_status' || /_oper$/.test(mn)) ? 'oper'
      : /_in_bps$/.test(mn) ? 'in'
      : /_out_bps$/.test(mn) ? 'out' : null;
    if (!kind) continue;
    let g = byIdx.get(idx);
    if (!g) { g = { if_index: idx, if_name: row.if_name || `if${idx}`, status: null, in_bps: null, out_bps: null }; byIdx.set(idx, g); }
    if (row.if_name && (!g.if_name || /^if\d+$/.test(g.if_name))) g.if_name = row.if_name;
    const v = row.value == null ? null : Number(row.value);
    if (kind === 'oper') g.status = v == null ? 'unknown' : (v >= 0.5 ? 'up' : 'down');
    else if (kind === 'in') g.in_bps = v;
    else if (kind === 'out') g.out_bps = v;
  }
  const order = { up: 0, down: 1, unknown: 2 };
  const list = Array.from(byIdx.values()).sort((a, b) =>
    (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.if_name.localeCompare(b.if_name));
  res.json(list);
}));

// Topology neighbors of this device (for the "Connected to" section).
app.get('/api/devices/:id/connected', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`
    SELECT t.from_port, t.to_port, t.protocol, t.to_device_id,
           COALESCE(nd.name, t.to_name) AS neighbor_name,
           COALESCE(nd.ip_address, t.to_ip) AS neighbor_ip
    FROM topology_links t
    LEFT JOIN monitored_devices nd ON nd.id = t.to_device_id
    WHERE t.from_device_id = $1
    ORDER BY t.from_port NULLS LAST
  `, [id]);
  res.json(r.rows);
}));

// ══════════════════════════════════════════════════════════════
// Device dependencies (parent-child) for alert suppression
// ══════════════════════════════════════════════════════════════
async function depInfo(deviceId) {
  const parent = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.site_id, d.site_name, d.current_status
    FROM device_dependencies dd JOIN monitored_devices d ON d.id = dd.parent_device_id
    WHERE dd.child_device_id = $1 LIMIT 1
  `, [deviceId]);
  const children = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.site_id, d.site_name, d.current_status, d.alert_suppressed
    FROM device_dependencies dd JOIN monitored_devices d ON d.id = dd.child_device_id
    WHERE dd.parent_device_id = $1 ORDER BY d.name
  `, [deviceId]);
  return { parent: parent.rows[0] || null, children: children.rows };
}

app.get('/api/devices/:id/dependencies', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(await depInfo(id));
}));

// Set or clear this device's parent. parent_device_id null removes the parent.
app.post('/api/devices/:id/dependencies', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const raw = req.body ? req.body.parent_device_id : null;
  const parentId = raw === null || raw === undefined || raw === '' ? null : parseInt(raw, 10);

  if (parentId === null) {
    await sv.query(`DELETE FROM device_dependencies WHERE child_device_id = $1`, [id]);
    return res.json(await depInfo(id));
  }
  if (parentId === id) return res.status(400).json({ error: 'A device cannot depend on itself' });
  const exists = await sv.query(`SELECT 1 FROM monitored_devices WHERE id = $1`, [parentId]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Parent device not found' });

  // Circular-dependency guard: the chosen parent must not be a descendant of
  // this device (otherwise a cycle would form).
  const cycle = await sv.query(`
    WITH RECURSIVE descendants AS (
      SELECT child_device_id FROM device_dependencies WHERE parent_device_id = $1
      UNION
      SELECT dd.child_device_id
      FROM device_dependencies dd JOIN descendants ds ON ds.child_device_id = dd.parent_device_id
    )
    SELECT 1 FROM descendants WHERE child_device_id = $2 LIMIT 1
  `, [id, parentId]);
  if (cycle.rows[0]) {
    return res.status(400).json({ error: 'Circular dependency: that device already depends on this one' });
  }

  // Single parent per device — replace any existing parent link.
  await sv.query(`DELETE FROM device_dependencies WHERE child_device_id = $1`, [id]);
  await sv.query(`
    INSERT INTO device_dependencies (child_device_id, parent_device_id) VALUES ($1, $2)
    ON CONFLICT (child_device_id, parent_device_id) DO NOTHING
  `, [id, parentId]);
  res.json(await depInfo(id));
}));

// Full dependency tree (flat array with depth + parent_device_id).
app.get('/api/dependencies/tree', wrap(async (_req, res) => {
  const r = await sv.query(`
    WITH RECURSIVE dep_tree AS (
      SELECT id, name, ip_address, site_name, current_status, alert_suppressed,
             NULL::integer AS parent_device_id, 0 AS depth
      FROM monitored_devices
      WHERE id NOT IN (SELECT child_device_id FROM device_dependencies) AND active = TRUE
      UNION ALL
      SELECT d.id, d.name, d.ip_address, d.site_name, d.current_status, d.alert_suppressed,
             dd.parent_device_id, dt.depth + 1
      FROM monitored_devices d
      JOIN device_dependencies dd ON dd.child_device_id = d.id
      JOIN dep_tree dt ON dt.id = dd.parent_device_id
    )
    SELECT * FROM dep_tree ORDER BY depth, parent_device_id, name
  `);
  res.json(r.rows);
}));

// On-demand single ping (does not write history — just an instant probe)
app.post('/api/devices/:id/ping-now', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT id, ip_address, ping_threshold_ms FROM monitored_devices WHERE id = $1`, [id]);
  const dev = r.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  const countFlag = IS_WIN ? '-n' : '-c';
  let alive = false;
  let ms = null;
  try {
    const result = await ping.promise.probe(dev.ip_address, { timeout: 2, extra: [countFlag, '1'] });
    alive = !!result.alive;
    if (result.time !== undefined && result.time !== 'unknown' && result.time !== null) {
      const t = parseFloat(result.time);
      if (!isNaN(t)) ms = t;
    }
  } catch (err) {
    alive = false;
  }

  const threshold = dev.ping_threshold_ms || 500;
  let status;
  if (!alive) status = 'down';
  else if (ms !== null && ms > threshold) status = 'warning';
  else status = 'up';

  res.json({ ms, status });
}));

// ══════════════════════════════════════════════════════════════
// Site gateway (one per site; gateway-down suppresses the site)
// ══════════════════════════════════════════════════════════════
// Mark this device as its site's gateway. Any existing gateway at the same site
// is cleared first so the one-gateway-per-site partial unique index holds.
app.post('/api/devices/:id/set-gateway', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dq = await sv.query(`SELECT id, site_id FROM monitored_devices WHERE id = $1`, [id]);
  const dev = dq.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  const client = await sv.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE monitored_devices SET is_gateway = FALSE, updated_at = NOW()
        WHERE site_id IS NOT DISTINCT FROM $1 AND id <> $2 AND is_gateway = TRUE`,
      [dev.site_id, id]
    );
    const r = await client.query(
      `UPDATE monitored_devices SET is_gateway = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Clear this device's gateway status.
app.post('/api/devices/:id/clear-gateway', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(
    `UPDATE monitored_devices SET is_gateway = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(r.rows[0]);
}));

// ══════════════════════════════════════════════════════════════
// SNMP discovery & sensor selection
// ══════════════════════════════════════════════════════════════
// Walk the device and return grouped, available sensors with current values.
app.post('/api/devices/:id/snmp-discover', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE id = $1`, [id]);
  const dev = r.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  if (!dev.snmp_enabled) return res.status(400).json({ error: 'SNMP is not enabled for this device' });

  const result = await discoverDevice(dev, 15000);
  if (result.error) return res.status(502).json({ error: result.error });
  res.json(result);
}));

// All saved sensors for a device.
app.get('/api/devices/:id/sensors', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(
    `SELECT id, sensor_key, sensor_name, category, metric_name, oid, enabled,
            is_custom, custom_label, custom_unit, created_at
       FROM device_sensors WHERE device_id = $1
       ORDER BY category, sensor_name`,
    [id]
  );
  res.json(r.rows);
}));

// Upsert the device's sensor selection.
app.put('/api/devices/:id/sensors', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const list = Array.isArray(req.body && req.body.sensors) ? req.body.sensors : null;
  if (!list) return res.status(400).json({ error: 'sensors array required' });

  const dev = await sv.query(`SELECT id FROM monitored_devices WHERE id = $1`, [id]);
  if (!dev.rows[0]) return res.status(404).json({ error: 'Device not found' });

  for (const s of list) {
    if (!s || !s.sensor_key || !s.metric_name) continue;
    await sv.query(`
      INSERT INTO device_sensors (device_id, sensor_key, sensor_name, category, metric_name, oid, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (device_id, sensor_key) DO UPDATE
        SET sensor_name = EXCLUDED.sensor_name,
            category    = EXCLUDED.category,
            metric_name = EXCLUDED.metric_name,
            oid         = EXCLUDED.oid,
            enabled     = EXCLUDED.enabled
    `, [
      id, s.sensor_key, s.sensor_name || s.sensor_key, s.category || 'system',
      s.metric_name, s.oid || null, s.enabled !== false,
    ]);
  }

  const saved = await sv.query(
    `SELECT id, sensor_key, sensor_name, category, metric_name, oid, enabled, created_at
       FROM device_sensors WHERE device_id = $1
       ORDER BY category, sensor_name`,
    [id]
  );
  res.json(saved.rows);
}));

// Create a custom user-defined OID sensor for a device. The OID is polled with
// a single SNMP GET by the collector and graphed under custom_label.
app.post('/api/devices/:id/sensors/custom', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const oid = String(b.oid || '').trim();
  const label = String(b.label || '').trim();
  const unit = b.unit != null ? String(b.unit).trim() : '';
  if (!/^1(\.\d+)+$/.test(oid)) {
    return res.status(400).json({ error: 'A valid OID is required (must start with "1.")' });
  }
  if (!label) return res.status(400).json({ error: 'label is required' });

  const dev = await sv.query(`SELECT id FROM monitored_devices WHERE id = $1`, [id]);
  if (!dev.rows[0]) return res.status(404).json({ error: 'Device not found' });

  // metric_name == sensor_name == label so collector writes and graph reads line up.
  const sensorKey = `custom_${oid.replace(/\./g, '_')}`;
  const r = await sv.query(`
    INSERT INTO device_sensors
      (device_id, sensor_key, sensor_name, category, metric_name, oid, enabled,
       is_custom, custom_label, custom_unit)
    VALUES ($1,$2,$3,'custom',$4,$5,TRUE,TRUE,$6,$7)
    ON CONFLICT (device_id, sensor_key) DO UPDATE
      SET sensor_name  = EXCLUDED.sensor_name,
          metric_name  = EXCLUDED.metric_name,
          oid          = EXCLUDED.oid,
          enabled      = TRUE,
          is_custom    = TRUE,
          custom_label = EXCLUDED.custom_label,
          custom_unit  = EXCLUDED.custom_unit
    RETURNING id, sensor_key, sensor_name, category, metric_name, oid, enabled,
              is_custom, custom_label, custom_unit, created_at
  `, [id, sensorKey, label, label, oid, label, unit || null]);
  res.status(201).json(r.rows[0]);
}));

// Delete a custom sensor (only custom sensors can be removed this way).
app.delete('/api/devices/:id/sensors/custom/:sensor_id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sensorId = parseInt(req.params.sensor_id, 10);
  const r = await sv.query(
    `DELETE FROM device_sensors
       WHERE id = $1 AND device_id = $2 AND is_custom = TRUE
       RETURNING id`,
    [sensorId, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Custom sensor not found' });
  res.json({ ok: true });
}));

// Test SNMP reachability for a saved device using its stored credentials.
app.post('/api/devices/:id/snmp-test', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE id = $1`, [id]);
  const dev = r.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  res.json(await snmpTest(dev, 10000));
}));

// Test SNMP with ad-hoc credentials (before a device is saved).
app.post('/api/snmp-test-adhoc', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.ip_address) return res.status(400).json({ error: 'ip_address required' });
  const dev = {
    ip_address: b.ip_address,
    snmp_version: b.snmp_version || '2c',
    snmp_community: b.snmp_community || 'public',
    snmp_port: safeInt(b.snmp_port, 161),
    snmp_v3_user: b.snmp_v3_user || null,
    snmp_v3_auth_pass: b.snmp_v3_auth_pass || null,
    snmp_v3_priv_pass: b.snmp_v3_priv_pass || null,
  };
  res.json(await snmpTest(dev, 10000));
}));

// ══════════════════════════════════════════════════════════════
// NetVault integration (read-only source)
// ══════════════════════════════════════════════════════════════
// Devices in NetVault that are NOT yet monitored
app.get('/api/netvault/devices', wrap(async (_req, res) => {
  const monitored = await sv.query(`SELECT netvault_device_id FROM monitored_devices WHERE netvault_device_id IS NOT NULL`);
  const existing = new Set(monitored.rows.map((r) => r.netvault_device_id));
  const r = await nv.query(`
    SELECT d.id AS netvault_device_id,
           d.name,
           host(d.ip_address) AS ip_address,
           dt.name AS device_type,
           d.site_id,
           s.name AS site_name
    FROM devices d
    LEFT JOIN device_types dt ON dt.id = d.device_type_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.ip_address IS NOT NULL
      AND COALESCE(d.device_status, 'Active') <> 'Decommed'
    ORDER BY s.name NULLS LAST, d.name
  `);
  res.json(r.rows.filter((row) => !existing.has(row.netvault_device_id)));
}));

// Import selected NetVault devices into monitoring
app.post('/api/netvault/import', wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.device_ids) ? req.body.device_ids : [];
  if (ids.length === 0) return res.status(400).json({ error: 'device_ids array required' });
  const src = await nv.query(`
    SELECT d.id AS netvault_device_id, d.name, host(d.ip_address) AS ip_address,
           dt.name AS device_type, d.site_id, s.name AS site_name
    FROM devices d
    LEFT JOIN device_types dt ON dt.id = d.device_type_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.id = ANY($1::int[]) AND d.ip_address IS NOT NULL
  `, [ids]);
  let imported = 0;
  const touchedAgents = new Set();
  for (const row of src.rows) {
    const r = await sv.query(`
      INSERT INTO monitored_devices (name, ip_address, device_type, site_id, site_name, netvault_device_id)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (ip_address) DO NOTHING
      RETURNING id
    `, [row.name, row.ip_address, row.device_type, row.site_id, row.site_name, row.netvault_device_id]);
    if (r.rows[0]) {
      imported++;
      // Auto-assign to a polling agent if one owns this device's site.
      const agentId = await assignDeviceAgent(r.rows[0].id, row.site_id);
      if (agentId) touchedAgents.add(agentId);
    }
  }
  // Push refreshed config to each affected connected agent.
  for (const agentId of touchedAgents) {
    try { await pushConfigToAgentId(agentId); } catch (e) { console.error('[import] push config failed:', e.message); }
  }
  res.json({ imported, requested: ids.length });
}));

// Sites from NetVault (for map + filters)
app.get('/api/netvault/sites', wrap(async (_req, res) => {
  const r = await nv.query(`
    SELECT id, name, code, city
    FROM sites
    WHERE COALESCE(site_status, 'Active') = 'Active'
    ORDER BY name
  `);
  res.json(r.rows);
}));

// ══════════════════════════════════════════════════════════════
// Distributed polling agents
// ══════════════════════════════════════════════════════════════
// Build the one-line install command shown to the user after creating an agent.
function installCommand(serverUrl, apiKey) {
  return `& ([scriptblock]::Create((irm ${serverUrl}/api/agent/install.ps1))) -ServerUrl "${serverUrl}" -ApiKey "${apiKey}"`;
}

// The agents.disabled / agents.health columns are later migrations — probe once
// so the list/detail endpoints work before and after schema.sql is re-applied.
async function agentColExists(col) {
  agentColExists._cache = agentColExists._cache || {};
  if (agentColExists._cache[col] !== undefined) return agentColExists._cache[col];
  let exists = false;
  try {
    const r = await sv.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='agents' AND column_name=$1) AS x`, [col]);
    exists = !!r.rows[0].x;
  } catch (_e) { exists = false; }
  agentColExists._cache[col] = exists;
  return exists;
}
const agentDisabledCol = () => agentColExists('disabled');

// Latest canonical agent.js version (parsed from the file the server serves), so
// the UI can flag agents running an older build (they self-update on next config).
let _latestAgentVersion;
function latestAgentVersion() {
  if (_latestAgentVersion !== undefined) return _latestAgentVersion;
  try {
    const txt = require('fs').readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
    const m = txt.match(/const VERSION = '([^']+)'/);
    _latestAgentVersion = m ? m[1] : null;
  } catch (_e) { _latestAgentVersion = null; }
  return _latestAgentVersion;
}

// Auto-assign a device to whichever agent owns its site (NULL = local polling).
// Returns the resolved agent_id (or null). Updates the device row in place.
async function assignDeviceAgent(deviceId, siteId) {
  let agentId = null;
  if (siteId != null) {
    const r = await sv.query(`SELECT agent_id FROM agent_sites WHERE site_id = $1 LIMIT 1`, [siteId]);
    if (r.rows[0]) agentId = r.rows[0].agent_id;
  }
  await sv.query(`UPDATE monitored_devices SET agent_id = $2, updated_at = NOW() WHERE id = $1`,
    [deviceId, agentId]);
  return agentId;
}

// All agents with device counts + assigned sites.
app.get('/api/agents', wrap(async (_req, res) => {
  const disCol = (await agentDisabledCol()) ? 'a.disabled' : 'FALSE AS disabled';
  const healthCol = (await agentColExists('health')) ? 'a.health' : 'NULL::jsonb AS health';
  const r = await sv.query(`
    SELECT a.id, a.name, a.status, a.version, a.ip_address, a.hostname,
           a.last_seen_at, a.connected_at, a.created_at, ${disCol}, ${healthCol},
           (SELECT COUNT(*)::int FROM monitored_devices d WHERE d.agent_id = a.id) AS device_count,
           COALESCE((
             SELECT json_agg(json_build_object('site_id', s.site_id, 'site_name', s.site_name) ORDER BY s.site_name)
             FROM agent_sites s WHERE s.agent_id = a.id
           ), '[]'::json) AS sites
    FROM agents a
    ORDER BY a.name
  `);
  const latest = latestAgentVersion();
  res.json(r.rows.map((a) => ({ ...a, latest_agent_version: latest })));
}));

// Create an agent: generate api_key, assign sites, auto-assign existing devices.
app.post('/api/agents', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const siteIds = Array.isArray(b.site_ids) ? b.site_ids.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)) : [];

  const client = await sv.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(`INSERT INTO agents (name) VALUES ($1) RETURNING *`, [b.name]);
    const agent = ins.rows[0];
    const displaced = new Set();

    if (siteIds.length) {
      // A site belongs to exactly one agent — detach these from any other agent
      // (and remember them so we can refresh their config after commit).
      const prev = await client.query(
        `SELECT DISTINCT agent_id FROM agent_sites WHERE site_id = ANY($1::int[])`, [siteIds]);
      for (const row of prev.rows) displaced.add(row.agent_id);
      await client.query(`DELETE FROM agent_sites WHERE site_id = ANY($1::int[])`, [siteIds]);

      // Resolve site names from NetVault for display (best-effort).
      let names = {};
      try {
        const nr = await nv.query(`SELECT id, name FROM sites WHERE id = ANY($1::int[])`, [siteIds]);
        for (const row of nr.rows) names[row.id] = row.name;
      } catch (_e) { /* NetVault optional */ }

      for (const sid of siteIds) {
        await client.query(
          `INSERT INTO agent_sites (agent_id, site_id, site_name) VALUES ($1,$2,$3)
           ON CONFLICT (agent_id, site_id) DO UPDATE SET site_name = EXCLUDED.site_name`,
          [agent.id, sid, names[sid] || null]
        );
      }
      // Auto-assign every monitored device in those sites to this agent.
      await client.query(
        `UPDATE monitored_devices SET agent_id = $1, updated_at = NOW() WHERE site_id = ANY($2::int[])`,
        [agent.id, siteIds]
      );
    }
    await client.query('COMMIT');

    // Refresh config for any agent that lost sites to this new one.
    for (const aid of displaced) {
      if (aid && aid !== agent.id) {
        try { await pushConfigToAgentId(aid); } catch (e) { console.error('[agents] displaced push failed:', e.message); }
      }
    }

    const serverUrl = getServerUrl(req);
    res.status(201).json({
      ...agent,
      install_command: installCommand(serverUrl, agent.api_key),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Agent detail: agent + assigned sites + device list.
app.get('/api/agents/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = await sv.query(`SELECT * FROM agents WHERE id = $1`, [id]);
  if (!a.rows[0]) return res.status(404).json({ error: 'Agent not found' });
  const sites = await sv.query(
    `SELECT site_id, site_name FROM agent_sites WHERE agent_id = $1 ORDER BY site_name`, [id]);
  const devices = await sv.query(`
    SELECT id, name, ip_address, device_type, site_id, site_name,
           current_status, last_response_ms, last_seen_at, last_checked_at, snmp_enabled
    FROM monitored_devices WHERE agent_id = $1 AND active = TRUE
    ORDER BY site_name NULLS LAST, name
  `, [id]);
  const serverUrl = getServerUrl(req);
  res.json({
    ...a.rows[0],
    sites: sites.rows,
    devices: devices.rows,
    install_command: installCommand(serverUrl, a.rows[0].api_key),
    latest_agent_version: latestAgentVersion(),
  });
}));

// Rename an agent.
app.put('/api/agents/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const r = await sv.query(
    `UPDATE agents SET name = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, b.name]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Agent not found' });
  res.json(r.rows[0]);
}));

// Rotate an agent's API key. The old key is immediately invalid; if the agent is
// connected it is dropped and must be re-installed with the new command.
app.post('/api/agents/:id/rotate-key', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = await sv.query(`SELECT api_key FROM agents WHERE id = $1`, [id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'Agent not found' });
  const oldKey = cur.rows[0].api_key;
  const r = await sv.query(
    `UPDATE agents SET api_key = gen_random_uuid()::text, status = 'never_connected',
       updated_at = NOW() WHERE id = $1 RETURNING *`, [id]);
  try { disconnectAgent(oldKey, 'Key rotated'); } catch (_e) { /* ignore */ }
  const serverUrl = getServerUrl(req);
  res.json({ ...r.rows[0], install_command: installCommand(serverUrl, r.rows[0].api_key) });
}));

// Enable/disable an agent without deleting it. Disabling drops any live socket and
// refuses future handshakes until re-enabled.
app.post('/api/agents/:id/disabled', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await agentDisabledCol())) {
    return res.status(400).json({ error: 'Agent disable requires a schema update (re-apply scripts/schema.sql).' });
  }
  const disabled = !!(req.body && req.body.disabled);
  const r = await sv.query(
    `UPDATE agents SET disabled = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, disabled]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Agent not found' });
  if (disabled) {
    try { disconnectAgent(r.rows[0].api_key, 'Agent disabled'); } catch (_e) { /* ignore */ }
    await sv.query(`UPDATE agents SET status = 'offline' WHERE id = $1`, [id]);
    await sv.query(`UPDATE monitored_devices SET current_status = 'agent_offline' WHERE agent_id = $1`, [id]);
  }
  res.json(r.rows[0]);
}));

// Delete an agent. Its devices fall back to local polling (agent_id → NULL via
// FK), and any lingering 'agent_offline' status is reset so the collector repolls.
app.delete('/api/agents/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await sv.query(
    `UPDATE monitored_devices SET current_status = 'unknown', updated_at = NOW()
      WHERE agent_id = $1 AND current_status = 'agent_offline'`, [id]);
  await sv.query(`DELETE FROM agents WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

// Replace an agent's site assignments + re-derive device ownership.
app.post('/api/agents/:id/sites', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const siteIds = Array.isArray(b.site_ids) ? b.site_ids.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)) : [];

  const exists = await sv.query(`SELECT id FROM agents WHERE id = $1`, [id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Agent not found' });

  const displaced = new Set();
  const client = await sv.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM agent_sites WHERE agent_id = $1`, [id]);

    if (siteIds.length) {
      // Enforce one-agent-per-site: take these sites from any other agent.
      const prev = await client.query(
        `SELECT DISTINCT agent_id FROM agent_sites WHERE site_id = ANY($1::int[]) AND agent_id <> $2`,
        [siteIds, id]);
      for (const row of prev.rows) displaced.add(row.agent_id);
      await client.query(
        `DELETE FROM agent_sites WHERE site_id = ANY($1::int[]) AND agent_id <> $2`, [siteIds, id]);

      let names = {};
      try {
        const nr = await nv.query(`SELECT id, name FROM sites WHERE id = ANY($1::int[])`, [siteIds]);
        for (const row of nr.rows) names[row.id] = row.name;
      } catch (_e) { /* NetVault optional */ }
      for (const sid of siteIds) {
        await client.query(
          `INSERT INTO agent_sites (agent_id, site_id, site_name) VALUES ($1,$2,$3)`,
          [id, sid, names[sid] || null]
        );
      }
    }

    // Devices in sites no longer assigned to this agent fall back to local.
    await client.query(
      `UPDATE monitored_devices
          SET agent_id = NULL,
              current_status = CASE WHEN current_status = 'agent_offline' THEN 'unknown' ELSE current_status END,
              updated_at = NOW()
        WHERE agent_id = $1 AND NOT (site_id = ANY($2::int[]))`,
      [id, siteIds.length ? siteIds : [-1]]
    );
    // Devices in the assigned sites are owned by this agent.
    if (siteIds.length) {
      await client.query(
        `UPDATE monitored_devices SET agent_id = $1, updated_at = NOW() WHERE site_id = ANY($2::int[])`,
        [id, siteIds]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Push the refreshed config to this agent + any agent that lost sites to it.
  try { await pushConfigToAgentId(id); } catch (e) { console.error('[agents] push config failed:', e.message); }
  for (const aid of displaced) {
    if (aid && aid !== id) {
      try { await pushConfigToAgentId(aid); } catch (e) { console.error('[agents] displaced push failed:', e.message); }
    }
  }

  const sites = await sv.query(
    `SELECT site_id, site_name FROM agent_sites WHERE agent_id = $1 ORDER BY site_name`, [id]);
  res.json({ ok: true, sites: sites.rows });
}));

// Remotely restart a connected agent (it exits; NSSM restarts the service).
app.post('/api/agents/:id/restart', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const exists = await sv.query(`SELECT id FROM agents WHERE id = $1`, [id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Agent not found' });
  const sent = await sendToAgentId(id, { type: 'restart' });
  if (!sent) return res.status(409).json({ error: 'Agent is offline.' });
  res.json({ ok: true });
}));

// Request a fresh log tail from the agent (it pushes a 'logs' message back).
app.post('/api/agents/:id/logs/refresh', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sent = await sendToAgentId(id, { type: 'get_logs' });
  if (!sent) return res.status(409).json({ error: 'Agent is offline.' });
  res.json({ ok: true });
}));

// Return the most recent log tail the agent pushed (may be empty until refreshed).
app.get('/api/agents/:id/logs', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const snap = agentLogs.get(id);
  res.json({ lines: (snap && snap.lines) || [], ts: (snap && snap.ts) || null });
}));

// ── Zero-touch discovery ──────────────────────────────────────
// Trigger a subnet sweep on the agent. Requires the agent to be online.
app.post('/api/agents/:id/discover', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const exists = await sv.query(`SELECT id FROM agents WHERE id = $1`, [id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Agent not found' });
  const b = req.body || {};
  const communities = Array.isArray(b.communities) ? b.communities.map((s) => String(s).trim()).filter(Boolean) : undefined;
  const subnets = Array.isArray(b.subnets) ? b.subnets.map((s) => String(s).trim()).filter(Boolean) : undefined;
  const sent = await sendToAgentId(id, { type: 'discover', communities, subnets });
  if (!sent) return res.status(409).json({ error: 'Agent is offline — it must be connected to run a discovery sweep.' });
  res.json({ ok: true, scanning: true });
}));

// List what the agent discovered, flagging anything already monitored.
app.get('/api/agents/:id/discovered', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await sv.query(`
      SELECT dd.id, dd.ip_address, dd.sys_name, dd.sys_descr, dd.snmp_ok,
             dd.adopted, dd.first_seen_at, dd.last_seen_at,
             EXISTS (SELECT 1 FROM monitored_devices m WHERE m.ip_address = dd.ip_address) AS already_monitored
        FROM agent_discovered_devices dd
       WHERE dd.agent_id = $1
       ORDER BY dd.snmp_ok DESC, dd.ip_address`, [id]);
    res.json(r.rows);
  } catch (e) {
    // Table is a later migration — degrade to empty rather than 500.
    if (/agent_discovered_devices/.test(e.message)) return res.json([]);
    throw e;
  }
}));

// Adopt discovered candidates into monitored_devices, owned by this agent. The
// devices are placed in one of the agent's assigned sites so the collector's
// site-based reassignment keeps them on the agent.
app.post('/api/agents/:id/discovered/adopt', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const ips = Array.isArray(b.ips) ? b.ips.filter((x) => typeof x === 'string' && x) : [];
  if (!ips.length) return res.status(400).json({ error: 'No devices selected.' });

  const agentSites = await sv.query(
    `SELECT site_id, site_name FROM agent_sites WHERE agent_id = $1 ORDER BY site_id`, [id]);
  if (!agentSites.rows.length) {
    return res.status(400).json({ error: 'Assign a site to this agent before adopting devices (Edit sites).' });
  }
  // Default to the first owned site; honour an explicit owned site_id if given.
  let target = agentSites.rows[0];
  if (b.site_id != null) {
    const m = agentSites.rows.find((s) => s.site_id === parseInt(b.site_id, 10));
    if (m) target = m;
  }

  const disc = await sv.query(
    `SELECT ip_address, sys_name, snmp_ok, snmp_community, snmp_version FROM agent_discovered_devices
      WHERE agent_id = $1 AND ip_address = ANY($2::text[])`, [id, ips]);

  let adopted = 0;
  for (const d of disc.rows) {
    const name = (d.sys_name && d.sys_name.trim()) ? d.sys_name.trim() : d.ip_address;
    // Preserve the credentials discovery actually used; only fall back to
    // public/2c when the discovery record predates community capture.
    const ins = await sv.query(`
      INSERT INTO monitored_devices
        (name, ip_address, site_id, site_name, agent_id,
         snmp_enabled, snmp_version, snmp_community)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (ip_address) DO NOTHING
      RETURNING id`,
      [name, d.ip_address, target.site_id, target.site_name, id, !!d.snmp_ok,
       d.snmp_version || '2c', d.snmp_community || 'public']);
    if (ins.rows[0]) adopted++;
    await sv.query(
      `UPDATE agent_discovered_devices SET adopted = TRUE WHERE agent_id = $1 AND ip_address = $2`,
      [id, d.ip_address]);
  }
  try { await pushConfigToAgentId(id); } catch (e) { console.error('[adopt] push config failed:', e.message); }
  res.json({ ok: true, adopted });
}));

// ══════════════════════════════════════════════════════════════
// Alerts
// ══════════════════════════════════════════════════════════════
// Some alert columns/tables are added by later migrations (alerts.note,
// alerts.incident_id, the incidents table). On a DB where schema.sql hasn't been
// re-applied yet, referencing them 500s. Probe once and build the SELECT to suit
// whatever exists, so the endpoint works before and after the migration.
let alertCaps = null;
async function getAlertCaps() {
  if (alertCaps) return alertCaps;
  try {
    const r = await sv.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alerts' AND column_name = 'note') AS has_note,
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alerts' AND column_name = 'incident_id') AS has_incident_id,
        EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'incidents') AS has_incidents,
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alerts' AND column_name = 'agent_id') AS has_agent_id,
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alerts' AND column_name = 'service_check_id') AS has_service_check_id,
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alerts' AND column_name = 'wireless_ap_id') AS has_wireless
    `);
    const def = { has_note: false, has_incident_id: false, has_incidents: false, has_agent_id: false, has_service_check_id: false, has_wireless: false };
    alertCaps = r.rows[0] || def;
  } catch (_e) {
    // If the probe itself fails, assume the optional pieces are absent.
    alertCaps = { has_note: false, has_incident_id: false, has_incidents: false, has_agent_id: false, has_service_check_id: false, has_wireless: false };
  }
  return alertCaps;
}

app.get('/api/alerts', wrap(async (req, res) => {
  const { status, severity, device_id } = req.query;
  const where = [];
  const params = [];
  if (status)    { params.push(status);    where.push(`a.status = $${params.length}`); }
  if (severity)  { params.push(severity);  where.push(`a.severity = $${params.length}`); }
  if (device_id) { params.push(parseInt(device_id, 10)); where.push(`a.device_id = $${params.length}`); }
  const alSc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  if (alSc) where.push(alSc);
  const limit = safeInt(req.query.limit, 200, 1000);

  const caps = await getAlertCaps();
  const noteSel = caps.has_note ? `COALESCE(a.note, '') AS note` : `'' AS note`;
  const incIdSel = caps.has_incident_id ? `a.incident_id` : `NULL::int AS incident_id`;
  const incJoin = caps.has_incidents && caps.has_incident_id;
  const incTitleSel = incJoin ? `inc.title AS incident_title` : `NULL::text AS incident_title`;
  const agentIdSel = caps.has_agent_id ? 'a.agent_id' : 'NULL::int AS agent_id';
  const agentNameSel = caps.has_agent_id ? 'ag.name AS agent_name' : 'NULL::text AS agent_name';
  const agentJoin = caps.has_agent_id ? 'LEFT JOIN agents ag ON ag.id = a.agent_id' : '';
  const svcIdSel = caps.has_service_check_id ? 'a.service_check_id' : 'NULL::int AS service_check_id';
  const svcNameSel = caps.has_service_check_id ? 'sc2.name AS service_name' : 'NULL::text AS service_name';
  const svcJoin = caps.has_service_check_id ? 'LEFT JOIN service_checks sc2 ON sc2.id = a.service_check_id' : '';
  const wlSel = caps.has_wireless
    ? 'a.wireless_ap_id, a.wireless_controller_id, COALESCE(wap.name, wctl.name) AS wireless_name'
    : 'NULL::int AS wireless_ap_id, NULL::int AS wireless_controller_id, NULL::text AS wireless_name';
  const wlJoin = caps.has_wireless
    ? 'LEFT JOIN wireless_aps wap ON wap.id = a.wireless_ap_id LEFT JOIN wireless_controllers wctl ON wctl.id = a.wireless_controller_id'
    : '';

  const rows = await sv.query(`
    SELECT a.id, a.device_id, d.name AS device_name, d.ip_address,
           a.alert_type, a.severity, a.message, a.metric_value,
           a.triggered_at, a.acknowledged_at, a.acknowledged_by, a.resolved_at, a.status,
           ${noteSel}, ${incIdSel}, ${incTitleSel},
           ${agentIdSel}, ${agentNameSel},
           ${svcIdSel}, ${svcNameSel},
           ${wlSel},
           a.suppressed_by, a.suppression_reason, sb.name AS suppressed_by_name
    FROM alerts a
    LEFT JOIN monitored_devices d  ON d.id = a.device_id
    LEFT JOIN monitored_devices sb ON sb.id = a.suppressed_by
    ${incJoin ? 'LEFT JOIN incidents inc ON inc.id = a.incident_id' : ''}
    ${agentJoin}
    ${svcJoin}
    ${wlJoin}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.triggered_at DESC
    LIMIT ${limit}
  `, params);
  res.json(rows.rows);
}));

app.post('/api/alerts/:id/acknowledge', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Attribute to the verified session user (proxy-set header), not a client-
  // supplied field, so acknowledgements can't be forged.
  const by = req.headers['x-user-email'] || (req.body && req.body.acknowledged_by) || 'unknown';
  const note = req.body && typeof req.body.note === 'string' && req.body.note.trim()
    ? req.body.note.trim() : null;
  // Only write the note column if it exists yet (it's a later migration).
  const caps = await getAlertCaps();
  const setNote = caps.has_note ? ', note = COALESCE($3, note)' : '';
  const r = await sv.query(`
    UPDATE alerts SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2${setNote}
    WHERE id = $1 AND status = 'active' RETURNING *
  `, caps.has_note ? [id, by, note] : [id, by]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Active alert not found' });
  res.json(r.rows[0]);
}));

app.post('/api/alerts/:id/resolve', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`
    UPDATE alerts SET status = 'resolved', resolved_at = NOW()
    WHERE id = $1 AND status <> 'resolved' RETURNING *
  `, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Alert not found or already resolved' });
  res.json(r.rows[0]);
}));

// ══════════════════════════════════════════════════════════════
// Alert rules
// ══════════════════════════════════════════════════════════════
// Conditions that carry no operator/threshold.
const NO_THRESHOLD_METRICS = ['device_down', 'interface_down'];

// Merge global → site → device rules by metric (later scope wins).
function mergeEffectiveRules(rows) {
  const prec = { global: 0, site: 1, device: 2 };
  const byMetric = new Map();
  for (const rule of rows) {
    const cur = byMetric.get(rule.metric);
    if (!cur || (prec[rule.scope] ?? 0) >= (prec[cur.scope] ?? 0)) byMetric.set(rule.metric, rule);
  }
  return Array.from(byMetric.values());
}

app.get('/api/alert-rules', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.scope)     { params.push(String(req.query.scope));        where.push(`r.scope = $${params.length}`); }
  if (req.query.site_id)   { params.push(parseInt(req.query.site_id, 10)); where.push(`r.site_id = $${params.length}`); }
  if (req.query.device_id) { params.push(parseInt(req.query.device_id, 10)); where.push(`r.device_id = $${params.length}`); }
  const r = await sv.query(`
    SELECT r.*, d.name AS device_name
    FROM alert_rules r LEFT JOIN monitored_devices d ON d.id = r.device_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.scope, r.site_name NULLS FIRST, r.device_id NULLS FIRST, r.metric
  `, params);
  res.json(r.rows);
}));

// Effective ruleset for a device after global → site → device inheritance.
app.get('/api/alert-rules/effective/:device_id', wrap(async (req, res) => {
  const id = parseInt(req.params.device_id, 10);
  const dq = await sv.query(`SELECT id, name, site_id, site_name FROM monitored_devices WHERE id = $1`, [id]);
  const device = dq.rows[0];
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const r = await sv.query(`
    SELECT r.*, d.name AS device_name
    FROM alert_rules r LEFT JOIN monitored_devices d ON d.id = r.device_id
    WHERE r.enabled = TRUE AND (
      r.scope = 'global'
      OR (r.scope = 'site'   AND r.site_id IS NOT DISTINCT FROM $2)
      OR (r.scope = 'device' AND r.device_id = $1)
    )
    ORDER BY r.metric
  `, [id, device.site_id == null ? null : device.site_id]);
  res.json({ device, rules: mergeEffectiveRules(r.rows) });
}));

app.post('/api/alert-rules', wrap(async (req, res) => {
  const b = req.body || {};
  const noThreshold = NO_THRESHOLD_METRICS.includes(b.metric);
  if (!b.metric || (!noThreshold && (b.threshold === undefined || b.threshold === null || b.threshold === ''))) {
    return res.status(400).json({ error: 'metric and threshold required' });
  }
  const scope = b.scope || (b.device_id ? 'device' : b.site_id ? 'site' : 'global');
  const r = await sv.query(`
    INSERT INTO alert_rules
      (device_id, site_id, site_name, scope, metric, operator, threshold, severity, enabled, notify_recovery, description)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [
    b.device_id || null, b.site_id || null, b.site_name || null, scope, b.metric,
    b.operator || '>', noThreshold ? null : b.threshold, b.severity || 'warning',
    b.enabled === undefined ? true : !!b.enabled, !!b.notify_recovery, b.description || null,
  ]);
  res.status(201).json(r.rows[0]);
}));

app.put('/api/alert-rules/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['metric', 'operator', 'threshold', 'severity', 'enabled', 'device_id',
                   'scope', 'site_id', 'site_name', 'notify_recovery', 'description'];
  const sets = [];
  const params = [];
  for (const k of allowed) if (b[k] !== undefined) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(id);
  const r = await sv.query(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'Rule not found' });
  res.json(r.rows[0]);
}));

app.delete('/api/alert-rules/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM alert_rules WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// Network map — devices grouped by site
// ══════════════════════════════════════════════════════════════
app.get('/api/map', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT COALESCE(d.site_id, 0) AS site_id,
           COALESCE(d.site_name, 'Unassigned') AS site_name,
           d.id, d.name, d.ip_address, d.device_type, d.current_status,
           d.alert_suppressed, d.suppressed_by_device_id,
           dd.parent_device_id, p.name AS parent_name
    FROM monitored_devices d
    LEFT JOIN device_dependencies dd ON dd.child_device_id = d.id
    LEFT JOIN monitored_devices p ON p.id = dd.parent_device_id
    WHERE d.active = TRUE${sc ? ` AND ${sc}` : ''}
    ORDER BY d.site_name NULLS LAST, d.name
  `, params);
  const sites = {};
  for (const row of r.rows) {
    const key = row.site_id;
    if (!sites[key]) sites[key] = { site_id: row.site_id, site_name: row.site_name, devices: [] };
    sites[key].devices.push({
      id: row.id, name: row.name, ip_address: row.ip_address,
      device_type: row.device_type, status: row.current_status,
      alert_suppressed: row.alert_suppressed,
      suppressed_by_device_id: row.suppressed_by_device_id,
      parent_device_id: row.parent_device_id, parent_name: row.parent_name,
    });
  }
  res.json(Object.values(sites));
}));

// ══════════════════════════════════════════════════════════════
// Interactive map designer (sv_maps + map_devices/connections/labels)
// ══════════════════════════════════════════════════════════════
// Assemble a full map: properties + positioned devices (with live status),
// connections, and labels. Returns null when the map row is absent.
async function fetchFullMap(mapId) {
  const m = await sv.query(`SELECT * FROM sv_maps WHERE id = $1`, [mapId]);
  const map = m.rows[0];
  if (!map) return null;
  const devices = await sv.query(`
    SELECT md.id, md.device_id, md.x, md.y, md.label, md.icon_type, md.width, md.height,
           md.z_index, md.node_style, md.locked, md.group_id, md.drill_map_id,
           d.name AS device_name, d.ip_address, d.site_name,
           d.current_status, d.last_response_ms, d.last_seen_at,
           d.is_gateway, d.alert_suppressed,
           cpu.value AS latest_cpu_pct, mem.value AS latest_mem_pct,
           avail.uptime_24h_pct,
           (SELECT COUNT(*)::int FROM alerts al WHERE al.device_id = d.id AND al.status = 'active') AS alert_count
    FROM map_devices md
    LEFT JOIN monitored_devices d ON d.id = md.device_id
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = d.id AND metric_name = 'cpu_pct' ORDER BY ts DESC LIMIT 1
    ) cpu ON TRUE
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = d.id AND metric_name = 'mem_pct' ORDER BY ts DESC LIMIT 1
    ) mem ON TRUE
    LEFT JOIN LATERAL (
      SELECT ROUND((1 - (SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::numeric
                    / NULLIF(COUNT(*), 0))) * 100, 1) AS uptime_24h_pct
      FROM ping_results
      WHERE device_id = d.id AND ts >= NOW() - INTERVAL '24 hours'
    ) avail ON TRUE
    WHERE md.map_id = $1
    ORDER BY md.id
  `, [mapId]);
  const connections = await sv.query(
    `SELECT * FROM map_connections WHERE map_id = $1 ORDER BY id`, [mapId]
  );
  // Weathermap: enrich each connection bound to an interface with that
  // interface's latest oper status + in/out bps, so the view can colour the
  // link by live utilization. Handles both selective (if_<idx>_*) and shared
  // (if_oper_status/if_in_bps/if_out_bps) metric names; both carry if_index.
  const mdToDevice = new Map(devices.rows.map((r) => [Number(r.id), r.device_id == null ? null : Number(r.device_id)]));
  const ifStats = new Map(); // `${device_id}:${if_index}` → { oper, in_bps, out_bps }
  const devIds = new Set();
  const ifIdxs = new Set();
  for (const c of connections.rows) {
    const fd = mdToDevice.get(Number(c.from_item_id));
    const td = mdToDevice.get(Number(c.to_item_id));
    if (fd != null && c.from_if_index != null) { devIds.add(fd); ifIdxs.add(Number(c.from_if_index)); }
    if (td != null && c.to_if_index != null) { devIds.add(td); ifIdxs.add(Number(c.to_if_index)); }
  }
  if (devIds.size) {
    const sr = await sv.query(`
      SELECT DISTINCT ON (device_id, metric_name, if_index) device_id, metric_name, if_index, value
      FROM snmp_results
      WHERE device_id = ANY($1::int[])
        AND if_index = ANY($2::int[])
        AND (metric_name ~ '^if_[0-9]+_(oper|in_bps|out_bps)$'
             OR metric_name IN ('if_oper_status', 'if_in_bps', 'if_out_bps'))
        AND ts >= NOW() - INTERVAL '1 day'
      ORDER BY device_id, metric_name, if_index, ts DESC
    `, [[...devIds], [...ifIdxs]]);
    for (const row of sr.rows) {
      const key = `${Number(row.device_id)}:${Number(row.if_index)}`;
      let g = ifStats.get(key);
      if (!g) { g = { oper: null, in_bps: null, out_bps: null }; ifStats.set(key, g); }
      const mn = row.metric_name;
      const v = row.value == null ? null : Number(row.value);
      if (mn === 'if_oper_status' || /_oper$/.test(mn)) g.oper = v == null ? null : (v >= 0.5 ? 'up' : 'down');
      else if (mn === 'if_in_bps' || /_in_bps$/.test(mn)) g.in_bps = v;
      else if (mn === 'if_out_bps' || /_out_bps$/.test(mn)) g.out_bps = v;
    }
  }
  const connRows = connections.rows.map((c) => {
    const fd = mdToDevice.get(Number(c.from_item_id));
    const td = mdToDevice.get(Number(c.to_item_id));
    const fg = (fd != null && c.from_if_index != null) ? ifStats.get(`${fd}:${Number(c.from_if_index)}`) : null;
    const tg = (td != null && c.to_if_index != null) ? ifStats.get(`${td}:${Number(c.to_if_index)}`) : null;
    return {
      ...c,
      from_in_bps: fg ? fg.in_bps : null, from_out_bps: fg ? fg.out_bps : null, from_oper: fg ? fg.oper : null,
      to_in_bps: tg ? tg.in_bps : null, to_out_bps: tg ? tg.out_bps : null, to_oper: tg ? tg.oper : null,
    };
  });
  const labels = await sv.query(
    `SELECT * FROM map_labels WHERE map_id = $1 ORDER BY id`, [mapId]
  );
  // Decorative shapes/icons (map_shapes is a later migration; degrade gracefully
  // on an un-migrated DB rather than 500-ing the whole map).
  let shapes = [];
  try {
    const sh = await sv.query(`SELECT * FROM map_shapes WHERE map_id = $1 ORDER BY z_index, id`, [mapId]);
    shapes = sh.rows;
  } catch (_e) { shapes = []; }
  return { ...map, devices: devices.rows, connections: connRows, labels: labels.rows, shapes };
}

// List all maps (with a device count for the cards).
app.get('/api/maps', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT m.id, m.uuid, m.name, m.description, m.is_public,
           m.bg_color, m.canvas_w, m.canvas_h, m.updated_at,
           (SELECT COUNT(*)::int FROM map_devices md WHERE md.map_id = m.id) AS device_count
    FROM sv_maps m
    ORDER BY m.updated_at DESC
  `);
  res.json(r.rows);
}));

// Create a map.
app.post('/api/maps', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const r = await sv.query(`
    INSERT INTO sv_maps (name, description, bg_color, canvas_w, canvas_h)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [b.name, b.description || null, b.bg_color || '#f8fafc',
      safeInt(b.canvas_w, 1600), safeInt(b.canvas_h, 900)]);
  res.status(201).json(r.rows[0]);
}));

// Full map (properties + content + live device status).
app.get('/api/maps/:id', wrap(async (req, res) => {
  const map = await fetchFullMap(parseInt(req.params.id, 10));
  if (!map) return res.status(404).json({ error: 'Map not found' });
  res.json(map);
}));

// Update map properties.
app.put('/api/maps/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['name', 'description', 'bg_color', 'canvas_w', 'canvas_h'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (b[k] !== undefined) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });
  params.push(id);
  const r = await sv.query(
    `UPDATE sv_maps SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Map not found' });
  res.json(r.rows[0]);
}));

// Delete a map (cascades to devices/connections/labels).
app.delete('/api/maps/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM sv_maps WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// Replace all devices/connections/labels for a map in one transaction.
// Connections reference the client-side map_device ids (real or temporary); we
// remap them to the freshly inserted ids via idMap.
app.put('/api/maps/:id/layout', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const devices = Array.isArray(b.devices) ? b.devices : [];
  const connections = Array.isArray(b.connections) ? b.connections : [];
  const labels = Array.isArray(b.labels) ? b.labels : [];
  // Only touch shapes when the client actually sends a `shapes` array, so older
  // clients that don't know about shapes don't wipe them.
  const shapes = Array.isArray(b.shapes) ? b.shapes : null;

  const exists = await sv.query(`SELECT id FROM sv_maps WHERE id = $1`, [id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Map not found' });

  const client = await sv.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM map_connections WHERE map_id = $1`, [id]);
    await client.query(`DELETE FROM map_labels WHERE map_id = $1`, [id]);
    await client.query(`DELETE FROM map_devices WHERE map_id = $1`, [id]);

    const idMap = new Map(); // `${kind}:${client id}` → new db id (devices + shapes)
    for (const d of devices) {
      const r = await client.query(`
        INSERT INTO map_devices (map_id, device_id, x, y, label, icon_type, width, height, z_index, node_style, locked, group_id, drill_map_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id
      `, [id, d.device_id || null, Number(d.x) || 0, Number(d.y) || 0,
          d.label || null, d.icon_type || 'circle', safeInt(d.width, 120), safeInt(d.height, 60),
          safeInt(d.z_index, 0), d.node_style === 'icon' ? 'icon' : 'box', !!d.locked,
          Number(d.group_id) > 0 ? Number(d.group_id) : null,
          Number(d.drill_map_id) > 0 ? Number(d.drill_map_id) : null]);
      if (d.id !== undefined && d.id !== null) idMap.set(`device:${d.id}`, r.rows[0].id);
    }

    // Decorative shapes — replace-all, but only when the client sent them. Insert
    // BEFORE connections so a connection can attach to a shape (its new db id is
    // captured in idMap under `shape:<client id>`).
    if (shapes) {
      await client.query(`DELETE FROM map_shapes WHERE map_id = $1`, [id]);
      for (const s of shapes) {
        if (!s || !s.kind) continue;
        const r = await client.query(`
          INSERT INTO map_shapes
            (map_id, kind, x, y, width, height, fill, stroke, stroke_width, text, font_size, text_color, rotation, z_index, locked, group_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id
        `, [id, String(s.kind), Number(s.x) || 0, Number(s.y) || 0,
            safeInt(s.width, 120), safeInt(s.height, 80),
            s.fill || null, s.stroke || null, safeInt(s.stroke_width, 2),
            s.text != null ? String(s.text) : null, safeInt(s.font_size, 14),
            s.text_color || '#1a2744', Number(s.rotation) || 0, safeInt(s.z_index, 0), !!s.locked,
            Number.isFinite(Number(s.group_id)) ? Number(s.group_id) : null]);
        if (s.id !== undefined && s.id !== null) idMap.set(`shape:${s.id}`, r.rows[0].id);
      }
    } else {
      // Client didn't resend shapes (existing shapes are preserved) — seed the id
      // map from the existing shape rows so connections attached to them still
      // remap (a saved shape's client id equals its db id on load) instead of
      // being silently dropped as dangling.
      const ex = await client.query(`SELECT id FROM map_shapes WHERE map_id = $1`, [id]);
      for (const r of ex.rows) idMap.set(`shape:${r.id}`, r.id);
    }

    for (const c of connections) {
      const fKind = c.from_kind === 'shape' ? 'shape' : 'device';
      const tKind = c.to_kind === 'shape' ? 'shape' : 'device';
      const from = idMap.get(`${fKind}:${c.from_item_id}`);
      const to = idMap.get(`${tKind}:${c.to_item_id}`);
      if (!from || !to) continue; // skip dangling connections (endpoint not saved)
      const fIf = Number.isFinite(Number(c.from_if_index)) ? Number(c.from_if_index) : null;
      const tIf = Number.isFinite(Number(c.to_if_index)) ? Number(c.to_if_index) : null;
      const cap = Number.isFinite(Number(c.capacity_bps)) && Number(c.capacity_bps) > 0 ? Number(c.capacity_bps) : null;
      await client.query(`
        INSERT INTO map_connections (map_id, from_item_id, to_item_id, from_kind, to_kind, color, line_style, label, arrow, width, from_if_index, to_if_index, capacity_bps, routing)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [id, from, to, fKind, tKind, c.color || '#94a3b8', c.line_style || 'solid', c.label || null,
          !!c.arrow, safeInt(c.width, 2), fIf, tIf, cap, c.routing === 'elbow' ? 'elbow' : 'straight']);
    }

    for (const l of labels) {
      if (!l || l.text === undefined || l.text === null) continue;
      await client.query(`
        INSERT INTO map_labels (map_id, x, y, text, font_size, color, bold, z_index, locked, group_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [id, Number(l.x) || 0, Number(l.y) || 0, String(l.text),
          safeInt(l.font_size, 14), l.color || '#1a2744', !!l.bold, safeInt(l.z_index, 0), !!l.locked,
          Number.isFinite(Number(l.group_id)) ? Number(l.group_id) : null]);
    }

    await client.query(`UPDATE sv_maps SET updated_at = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json(await fetchFullMap(id));
}));

// Save (or clear) the background image. Pass bg_image_b64 = null/'' to clear.
app.post('/api/maps/:id/background', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b64 = req.body && req.body.bg_image_b64 ? String(req.body.bg_image_b64) : null;
  const r = await sv.query(
    `UPDATE sv_maps SET bg_image_b64 = $2, updated_at = NOW() WHERE id = $1 RETURNING id`,
    [id, b64]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Map not found' });
  res.json({ ok: true });
}));

// Toggle public sharing.
app.post('/api/maps/:id/toggle-public', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(
    `UPDATE sv_maps SET is_public = NOT is_public, updated_at = NOW() WHERE id = $1 RETURNING is_public, uuid`,
    [id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Map not found' });
  res.json(r.rows[0]);
}));

// Public map view (NO AUTH). Only resolves when is_public = TRUE.
app.get('/api/maps/public/:uuid', wrap(async (req, res) => {
  const m = await sv.query(
    `SELECT * FROM sv_maps WHERE uuid = $1 AND is_public = TRUE`, [String(req.params.uuid)]
  );
  const map = m.rows[0];
  if (!map) return res.status(404).json({ error: 'Map not found or not public' });
  const full = await fetchFullMap(map.id);
  res.json(full);
}));

// ══════════════════════════════════════════════════════════════
// Topology discovery (LLDP / CDP)
// ══════════════════════════════════════════════════════════════
// In-memory job tracker for the async discovery run. Persisted state (last run
// time, link counts) is derived from topology_links itself in /status.
let topoRun = { running: false, started_at: null, finished_at: null, devices: 0, links: 0, duration_ms: 0 };

// Walk every active SNMP-enabled device and persist its neighbors. Long-running;
// kicked off in the background by POST /discover (never awaited by the request).
async function runTopologyDiscoveryAll() {
  if (topoRun.running) return;
  topoRun.running = true;
  topoRun.started_at = new Date();
  const t0 = Date.now();
  let devices = 0, links = 0;
  try {
    const r = await sv.query(
      `SELECT * FROM monitored_devices WHERE active = TRUE AND snmp_enabled = TRUE`);
    for (const d of r.rows) {
      try {
        links += await topology.discoverAndStore(sv, d);
        devices++;
      } catch (e) {
        console.error(`[topology] ${d.name} discovery failed:`, e.message);
      }
    }
  } catch (e) {
    console.error('[topology] discovery run failed:', e.message);
  } finally {
    topoRun = { running: false, started_at: topoRun.started_at, finished_at: new Date(),
                devices, links, duration_ms: Date.now() - t0 };
  }
}

// Trigger discovery (returns immediately; poll /status for completion).
app.post('/api/topology/discover', wrap(async (_req, res) => {
  if (topoRun.running) return res.json({ started: false, running: true });
  runTopologyDiscoveryAll().catch((e) => console.error('[topology] async run:', e.message));
  res.json({ started: true });
}));

// Discovery status: live run flag + derived last-run/link counts.
app.get('/api/topology/status', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT MAX(last_seen_at) AS last_run_at,
           COUNT(*)::int AS links_found,
           COUNT(DISTINCT from_device_id)::int AS devices_discovered
    FROM topology_links`);
  const row = r.rows[0] || {};
  res.json({
    running: topoRun.running,
    last_run_at: row.last_run_at || null,
    links_found: row.links_found || 0,
    devices_discovered: row.devices_discovered || 0,
    duration_ms: topoRun.duration_ms || 0,
  });
}));

// All discovered links with both ends joined (?device_id=X scopes to one device).
app.get('/api/topology/links', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.device_id) {
    params.push(parseInt(req.query.device_id, 10));
    where.push(`(l.from_device_id = $${params.length} OR l.to_device_id = $${params.length})`);
  }
  const sc = siteFilterClause(getSiteFilter(req), params, 'fd.site_id');
  if (sc) where.push(sc);
  const r = await sv.query(`
    SELECT l.id, l.from_device_id, fd.name AS from_device_name,
           fd.ip_address AS from_ip, fd.site_id AS from_site_id, fd.site_name AS from_site, l.from_port,
           l.to_device_id, td.name AS to_device_name, td.site_id AS to_site_id, td.site_name AS to_site,
           COALESCE(td.ip_address, l.to_ip) AS to_ip, l.to_name, l.to_port,
           l.protocol, l.last_seen_at
    FROM topology_links l
    JOIN monitored_devices fd ON fd.id = l.from_device_id
    LEFT JOIN monitored_devices td ON td.id = l.to_device_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY fd.name, l.from_port
  `, params);
  res.json(r.rows);
}));

// Deduplicate undirected (A↔B) links of the same protocol into one edge.
function dedupeEdges(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const a = Math.min(row.from_device_id, row.to_device_id);
    const b = Math.max(row.from_device_id, row.to_device_id);
    const key = `${a}-${b}-${row.protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// Map-friendly topology: nodes (only devices with ≥1 link) + edges.
app.get('/api/topology/map', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'fd.site_id');
  const e = await sv.query(`
    SELECT l.from_device_id, l.to_device_id, l.from_port, l.to_port, l.protocol
    FROM topology_links l
    JOIN monitored_devices fd ON fd.id = l.from_device_id
    JOIN monitored_devices td ON td.id = l.to_device_id
    WHERE l.to_device_id IS NOT NULL${sc ? ` AND ${sc}` : ''}
  `, params);
  const edges = dedupeEdges(e.rows);
  const ids = new Set();
  for (const row of edges) { ids.add(row.from_device_id); ids.add(row.to_device_id); }
  let nodes = [];
  if (ids.size) {
    const nr = await sv.query(`
      SELECT id AS device_id, name, ip_address AS ip, site_name,
             current_status AS status, is_gateway
      FROM monitored_devices WHERE id = ANY($1::int[])
    `, [Array.from(ids)]);
    nodes = nr.rows;
  }
  res.json({ nodes, edges });
}));

// Apply the discovered topology to an existing map: place new devices in a grid
// (preserving any already-positioned ones) and recreate connections from links.
app.post('/api/topology/apply-to-map/:map_id', wrap(async (req, res) => {
  const mapId = parseInt(req.params.map_id, 10);
  const exists = await sv.query(`SELECT id FROM sv_maps WHERE id = $1`, [mapId]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Map not found' });

  const e = await sv.query(`
    SELECT from_device_id, to_device_id, from_port, to_port, protocol
    FROM topology_links WHERE to_device_id IS NOT NULL`);
  const edges = dedupeEdges(e.rows);
  const deviceIds = new Set();
  for (const row of edges) { deviceIds.add(row.from_device_id); deviceIds.add(row.to_device_id); }

  const client = await sv.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, device_id FROM map_devices WHERE map_id = $1 AND device_id IS NOT NULL`, [mapId]);
    const mapDeviceId = new Map(); // device_id → map_devices.id
    for (const row of existing.rows) mapDeviceId.set(row.device_id, row.id);

    const toPlace = Array.from(deviceIds).filter((id) => !mapDeviceId.has(id));
    const cols = Math.max(1, Math.ceil(Math.sqrt(toPlace.length || 1)));
    const cellW = 200, cellH = 120, ox = 80, oy = 80;
    let i = 0;
    for (const devId of toPlace) {
      const x = ox + (i % cols) * cellW;
      const y = oy + Math.floor(i / cols) * cellH;
      const ins = await client.query(
        `INSERT INTO map_devices (map_id, device_id, x, y, icon_type, width, height)
         VALUES ($1,$2,$3,$4,'rect',120,60) RETURNING id`,
        [mapId, devId, x, y]);
      mapDeviceId.set(devId, ins.rows[0].id);
      i++;
    }

    await client.query(`DELETE FROM map_connections WHERE map_id = $1`, [mapId]);
    for (const row of edges) {
      const from = mapDeviceId.get(row.from_device_id);
      const to = mapDeviceId.get(row.to_device_id);
      if (!from || !to) continue;
      const color = row.protocol === 'cdp' ? '#f97316' : '#2563eb';
      const label = [row.from_port, row.to_port].filter(Boolean).join(' → ');
      await client.query(
        `INSERT INTO map_connections (map_id, from_item_id, to_item_id, color, line_style, label)
         VALUES ($1,$2,$3,$4,'solid',$5)`,
        [mapId, from, to, color, label || null]);
    }
    await client.query(`UPDATE sv_maps SET updated_at = NOW() WHERE id = $1`, [mapId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json(await fetchFullMap(mapId));
}));

// Suggest site gateways from topology: devices spanning multiple sites, or the
// most-connected device within a site, are likely gateways. Suggest-only.
app.post('/api/topology/apply-dependencies', wrap(async (_req, res) => {
  const e = await sv.query(`
    SELECT l.from_device_id, l.to_device_id,
           fd.site_id AS from_site, fd.name AS from_name, td.site_id AS to_site
    FROM topology_links l
    JOIN monitored_devices fd ON fd.id = l.from_device_id
    JOIN monitored_devices td ON td.id = l.to_device_id
    WHERE l.to_device_id IS NOT NULL`);

  const info = new Map(); // id → { name, site, neighbors:Set, sites:Set }
  const ensure = (id, name, site) => {
    if (!info.has(id)) info.set(id, { name, site, neighbors: new Set(), sites: new Set() });
    return info.get(id);
  };
  for (const row of e.rows) {
    const a = ensure(row.from_device_id, row.from_name, row.from_site);
    a.neighbors.add(row.to_device_id);
    if (row.to_site != null) a.sites.add(row.to_site);
  }

  const bestPerSite = new Map(); // site → { id, degree }
  for (const [id, d] of info) {
    const cur = bestPerSite.get(d.site);
    if (!cur || d.neighbors.size > cur.degree) bestPerSite.set(d.site, { id, degree: d.neighbors.size });
  }

  const suggestions = [];
  for (const [id, d] of info) {
    const reasons = [];
    let confidence = 0;
    if (d.sites.size > 1) {
      reasons.push(`Connects to devices in ${d.sites.size} sites`);
      confidence += 0.5;
    }
    const best = bestPerSite.get(d.site);
    if (best && best.id === id && d.neighbors.size > 1) {
      reasons.push(`Most-connected device in its site (${d.neighbors.size} links)`);
      confidence += 0.4;
    }
    if (reasons.length) {
      suggestions.push({
        device_id: id, name: d.name,
        reason: reasons.join('; '),
        confidence: Math.min(1, confidence + 0.1),
      });
    }
  }
  suggestions.sort((a, b) => b.confidence - a.confidence);
  res.json({ suggestions });
}));

// ══════════════════════════════════════════════════════════════
// Wireless visibility (controllers + access points)
// ══════════════════════════════════════════════════════════════
// Human-readable uptime ("3d 4h", "5h 12m", "8m").
function fmtUptime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Controllers CRUD ──────────────────────────────────────────
app.get('/api/wireless/controllers', wrap(async (_req, res) => {
  const hp = (await wctlHasHaPeer())
    ? 'c.ha_peer_controller_id, c.ha_manual_role'
    : 'NULL::int AS ha_peer_controller_id, NULL::text AS ha_manual_role';
  const r = await sv.query(`
    SELECT c.id, c.name, c.vendor, c.controller_url, c.api_username, c.snmp_device_id,
           c.site_id, c.site_name, c.active, c.last_polled_at, c.status,
           c.model, c.firmware_version, c.licensed_aps, c.ha_mode, c.ha_peer_ip,
           c.ha_sync_status, c.ap_disconnects_24h, c.capabilities_probed_at, ${hp},
           (c.capabilities IS NOT NULL AND c.capabilities <> '{}') AS has_capabilities,
           d.snmp_community AS snmp_community,
           d.snmp_version AS snmp_version,
           d.snmp_port AS snmp_port,
           (SELECT COUNT(*)::int FROM wireless_aps a WHERE a.controller_id = c.id) AS ap_count,
           (SELECT COALESCE(SUM(a.clients_total), 0)::int FROM wireless_aps a WHERE a.controller_id = c.id) AS client_count
    FROM wireless_controllers c
    LEFT JOIN monitored_devices d ON d.id = c.snmp_device_id
    ORDER BY c.name
  `);
  res.json(r.rows);
}));

// ── Aggregate overview across all controllers ─────────────────
// Registered before any /:id route so "overview" is never treated as an :id.
// Manual HA columns are a later migration — probe once so the overview/list
// endpoints don't 500 before scripts/schema.sql is applied.
let _wctlHaPeerCol = null;
async function wctlHasHaPeer() {
  if (_wctlHaPeerCol !== null) return _wctlHaPeerCol;
  try {
    const r = await sv.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='wireless_controllers' AND column_name='ha_peer_controller_id') AS x`);
    _wctlHaPeerCol = !!r.rows[0].x;
  } catch (_e) { _wctlHaPeerCol = false; }
  return _wctlHaPeerCol;
}

app.get('/api/wireless/controllers/overview', wrap(async (_req, res) => {
  const hp = (await wctlHasHaPeer())
    ? `c.ha_peer_controller_id, c.ha_manual_role,
       (SELECT name FROM wireless_controllers p WHERE p.id = c.ha_peer_controller_id) AS ha_peer_name`
    : `NULL::int AS ha_peer_controller_id, NULL::text AS ha_manual_role, NULL::text AS ha_peer_name`;
  const r = await sv.query(`
    SELECT c.id, c.name, c.vendor, c.site_name, c.model, c.firmware_version,
           c.status, c.licensed_aps, c.ha_mode, c.ha_peer_ip, c.ha_sync_status,
           c.ap_disconnects_24h, c.last_polled_at, ${hp},
           (SELECT COUNT(*)::int FROM wireless_aps a WHERE a.controller_id = c.id) AS ap_count,
           (SELECT COALESCE(SUM(a.clients_total), 0)::int FROM wireless_aps a WHERE a.controller_id = c.id) AS client_count,
           cpu.value AS cpu_pct, mem.value AS mem_pct, up.value AS uptime_seconds
    FROM wireless_controllers c
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = c.snmp_device_id AND metric_name = 'cpu_pct'
      ORDER BY ts DESC LIMIT 1
    ) cpu ON TRUE
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = c.snmp_device_id AND metric_name = 'mem_pct'
      ORDER BY ts DESC LIMIT 1
    ) mem ON TRUE
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = c.snmp_device_id AND metric_name = 'uptime_seconds'
      ORDER BY ts DESC LIMIT 1
    ) up ON TRUE
    ORDER BY c.name
  `);

  let totalAps = 0;
  let totalClients = 0;
  let onlineControllers = 0;
  let cpuSum = 0;
  let cpuCount = 0;
  let memSum = 0;
  let memCount = 0;
  let haHealthy = 0;
  let haTotal = 0;
  let licensedTotal = 0;
  let hasLicensed = false;

  const controllers = r.rows.map((row) => {
    const apCount = Number(row.ap_count) || 0;
    const clientCount = Number(row.client_count) || 0;
    totalAps += apCount;
    totalClients += clientCount;
    if (row.status === 'ok') onlineControllers += 1;

    const cpu = row.cpu_pct == null ? null : Number(row.cpu_pct);
    const mem = row.mem_pct == null ? null : Number(row.mem_pct);
    if (cpu != null && Number.isFinite(cpu)) { cpuSum += cpu; cpuCount += 1; }
    if (mem != null && Number.isFinite(mem)) { memSum += mem; memCount += 1; }

    // A controller is in HA if it reports a role/peer or was manually paired —
    // not gated on the sync code (some platforms report a non-Synced sync value
    // while HA is configured).
    const inHa = row.ha_mode === 'Active' || row.ha_mode === 'Standby'
      || (row.ha_peer_ip != null && row.ha_peer_ip !== '')
      || row.ha_peer_controller_id != null;
    if (inHa) haTotal += 1;
    if (row.ha_sync_status === 'Synced' || row.ha_peer_controller_id != null) haHealthy += 1;

    const licensed = row.licensed_aps == null ? null : Number(row.licensed_aps);
    let perCap = null;
    if (licensed != null && Number.isFinite(licensed) && licensed > 0) {
      // AP capacity % = (active APs / licensed AP limit) * 100.
      perCap = Math.round((apCount / licensed) * 100);
      licensedTotal += licensed;
      hasLicensed = true;
    }

    return {
      id: row.id,
      name: row.name,
      vendor: row.vendor,
      site_name: row.site_name,
      model: row.model,
      firmware_version: row.firmware_version,
      status: row.status,
      ap_count: apCount,
      client_count: clientCount,
      cpu_pct: cpu,
      mem_pct: mem,
      uptime_seconds: row.uptime_seconds == null ? null : Number(row.uptime_seconds),
      licensed_aps: licensed,
      ap_capacity_pct: perCap,
      ha_mode: row.ha_mode,
      ha_peer_ip: row.ha_peer_ip,
      ha_sync_status: row.ha_sync_status,
      ha_peer_controller_id: row.ha_peer_controller_id ?? null,
      ha_manual_role: row.ha_manual_role ?? null,
      ha_peer_name: row.ha_peer_name ?? null,
      ap_disconnects_24h: row.ap_disconnects_24h == null ? null : Number(row.ap_disconnects_24h),
      last_polled_at: row.last_polled_at,
    };
  });

  res.json({
    total_controllers: controllers.length,
    online_controllers: onlineControllers,
    total_aps: totalAps,
    total_clients: totalClients,
    avg_cpu_pct: cpuCount ? Math.round((cpuSum / cpuCount) * 10) / 10 : null,
    avg_mem_pct: memCount ? Math.round((memSum / memCount) * 10) / 10 : null,
    ha_healthy_count: haHealthy,
    ha_total_count: haTotal,
    ap_capacity_pct: hasLicensed && licensedTotal > 0
      ? Math.round((totalAps / licensedTotal) * 100)
      : null,
    controllers,
  });
}));

// ── Recent events across all controllers (client events + alerts) ──
app.get('/api/wireless/controllers/events', wrap(async (_req, res) => {
  const clientEvents = await sv.query(`
    SELECT e.ts,
           c.name AS controller_name,
           c.site_name AS site_name,
           e.event_type,
           COALESCE(e.to_ap_name, e.from_ap_name) AS ap_name
    FROM wireless_client_events e
    JOIN wireless_controllers c ON c.id = e.controller_id
    WHERE e.event_type IN ('join', 'leave', 'low_signal', 'roam')
    ORDER BY e.ts DESC
    LIMIT 20
  `);

  const alertEvents = await sv.query(`
    SELECT al.triggered_at AS ts,
           c.name AS controller_name,
           c.site_name AS site_name,
           al.severity,
           al.message
    FROM alerts al
    JOIN wireless_controllers c ON c.snmp_device_id = al.device_id
    ORDER BY al.triggered_at DESC
    LIMIT 20
  `);

  const events = [];

  for (const e of clientEvents.rows) {
    const ap = e.ap_name || 'unknown AP';
    let description;
    let severity = null;
    if (e.event_type === 'join') description = `AP ${ap} client joined`;
    else if (e.event_type === 'leave') description = `AP ${ap} client disconnected`;
    else if (e.event_type === 'low_signal') { description = `Low signal alert on ${ap}`; severity = 'warning'; }
    else if (e.event_type === 'roam') description = `AP ${ap} client roamed`;
    else description = `AP ${ap} ${e.event_type}`;
    events.push({
      ts: e.ts,
      controller_name: e.controller_name,
      site_name: e.site_name,
      event_type: e.event_type,
      description,
      severity,
      ap_name: e.ap_name || null,
    });
  }

  for (const a of alertEvents.rows) {
    events.push({
      ts: a.ts,
      controller_name: a.controller_name,
      site_name: a.site_name,
      event_type: 'alert',
      description: a.message || 'Alert',
      severity: a.severity || null,
      ap_name: null,
    });
  }

  events.sort((x, y) => new Date(y.ts).getTime() - new Date(x.ts).getTime());
  res.json(events.slice(0, 20));
}));

app.post('/api/wireless/controllers', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.vendor) return res.status(400).json({ error: 'name and vendor are required' });

  // Three provisioning modes:
  //  (1) API mode          — controller_url given → poll via vendor HTTP API.
  //  (2) SNMP link-existing — snmp_device_id given → reuse a monitored device.
  //  (3) SNMP provision-new — ip_address given (no snmp_device_id) → create/reuse
  //      a SpanVault-local monitored_devices row, then link the controller to it.
  if (!b.controller_url && !b.snmp_device_id && !b.ip_address) {
    return res.status(400).json({
      error: 'Provide controller_url (API mode), snmp_device_id (link existing), or ip_address (provision new SNMP device)',
    });
  }

  // Modes (1) and (2): no device provisioning — single insert, unchanged behavior.
  if (b.controller_url || b.snmp_device_id) {
    const r = await sv.query(`
      INSERT INTO wireless_controllers
        (name, vendor, controller_url, api_key, api_username, api_password,
         snmp_device_id, site_id, site_name, poll_interval_seconds, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, name, vendor, controller_url, api_username, snmp_device_id,
                site_id, site_name, active, last_polled_at, status
    `, [
      b.name, b.vendor, b.controller_url || null, b.api_key || null, b.api_username || null,
      b.api_password || null, b.snmp_device_id || null, b.site_id || null, b.site_name || null,
      safeInt(b.poll_interval_seconds, 300), b.active === undefined ? true : !!b.active,
    ]);
    return res.status(201).json(r.rows[0]);
  }

  // Mode (3): SNMP provision-new. Create/reuse a monitored device + link controller
  // atomically so a half-created pair can't be left behind on error.
  const client = await sv.connect();
  let provisionedDeviceId = null;
  let controllerRow = null;
  try {
    await client.query('BEGIN');

    // 1. Create the monitored device (mirrors POST /api/devices field defaults).
    const dev = await client.query(`
      INSERT INTO monitored_devices
        (name, ip_address, device_type, site_id, site_name,
         snmp_enabled, snmp_version, snmp_community, snmp_port,
         snmp_v3_user, snmp_v3_auth_pass, snmp_v3_priv_pass,
         poll_interval_seconds, ping_threshold_ms, ping_failures_before_down)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (ip_address) DO NOTHING
      RETURNING id
    `, [
      b.device_name || b.name, b.ip_address, b.device_type || 'Wireless Controller',
      b.site_id || null, b.site_name || null,
      true, b.snmp_version || '2c', b.snmp_community || 'public', safeInt(b.snmp_port, 161),
      b.snmp_v3_user || null, b.snmp_v3_auth_pass || null, b.snmp_v3_priv_pass || null,
      safeInt(b.poll_interval_seconds, 300), safeInt(b.ping_threshold_ms, 500),
      safeInt(b.ping_failures_before_down, 3),
    ]);

    if (dev.rows[0]) {
      provisionedDeviceId = dev.rows[0].id;
    } else {
      // 2. IP already monitored — reuse the existing device.
      const ex = await client.query(`SELECT id FROM monitored_devices WHERE ip_address = $1`, [b.ip_address]);
      if (!ex.rows[0]) throw new Error('Failed to provision or locate device for the given IP');
      provisionedDeviceId = ex.rows[0].id;
    }

    // 3. Link the controller to that device (one controller per device — guarded
    //    by the partial unique index idx_wctl_snmp_device).
    const ins = await client.query(`
      INSERT INTO wireless_controllers
        (name, vendor, controller_url, api_key, api_username, api_password,
         snmp_device_id, site_id, site_name, poll_interval_seconds, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (snmp_device_id) WHERE snmp_device_id IS NOT NULL DO NOTHING
      RETURNING id, name, vendor, controller_url, api_username, snmp_device_id,
                site_id, site_name, active, last_polled_at, status
    `, [
      b.name, b.vendor, null, null, null, null,
      provisionedDeviceId, b.site_id || null, b.site_name || null,
      safeInt(b.poll_interval_seconds, 300), b.active === undefined ? true : !!b.active,
    ]);

    if (ins.rows[0]) {
      controllerRow = ins.rows[0];
    } else {
      // Device already has a controller — return the existing one.
      const ex = await client.query(`
        SELECT id, name, vendor, controller_url, api_username, snmp_device_id,
               site_id, site_name, active, last_polled_at, status
        FROM wireless_controllers WHERE snmp_device_id = $1
      `, [provisionedDeviceId]);
      controllerRow = ex.rows[0];
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Best-effort: assign the new device to a polling agent and push config so it
  // starts polling (mirrors POST /api/devices).
  if (provisionedDeviceId) {
    try {
      const agentId = await assignDeviceAgent(provisionedDeviceId, b.site_id || null);
      if (agentId) await pushConfigToAgentId(agentId);
    } catch (e) {
      console.error('[wireless] device agent assign/push failed:', e.message);
    }
  }

  res.status(201).json({ ...controllerRow, provisioned_device_id: provisionedDeviceId });
}));

app.put('/api/wireless/controllers/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['name', 'vendor', 'controller_url', 'api_key', 'api_username', 'api_password',
                   'snmp_device_id', 'site_id', 'site_name', 'poll_interval_seconds', 'active'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (b[k] !== undefined) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
  }

  // SNMP credentials live on the linked monitored_devices row, not on the
  // controller. Collect any SNMP fields present in the body so we can push them
  // through to that device inside the same transaction.
  const snmpFields = ['snmp_community', 'snmp_version', 'snmp_port',
                      'snmp_v3_user', 'snmp_v3_auth_pass', 'snmp_v3_priv_pass'];
  const snmpSets = {};
  for (const k of snmpFields) {
    if (b[k] !== undefined) snmpSets[k] = b[k];
  }
  const hasSnmp = Object.keys(snmpSets).length > 0;

  if (!sets.length && !hasSnmp) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const client = await sv.connect();
  let controllerRow = null;
  try {
    await client.query('BEGIN');

    // Always look up snmp_device_id so we can route SNMP updates to the device.
    const cur = await client.query(`SELECT snmp_device_id FROM wireless_controllers WHERE id = $1`, [id]);
    if (!cur.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Controller not found' });
    }
    const snmpDeviceId = cur.rows[0].snmp_device_id;

    if (sets.length) {
      const p = params.slice();
      p.push(id);
      const r = await client.query(
        `UPDATE wireless_controllers SET ${sets.join(', ')} WHERE id = $${p.length}
         RETURNING id, name, vendor, controller_url, api_username, snmp_device_id,
                   site_id, site_name, active, last_polled_at, status`,
        p
      );
      controllerRow = r.rows[0];
    } else {
      const r = await client.query(
        `SELECT id, name, vendor, controller_url, api_username, snmp_device_id,
                site_id, site_name, active, last_polled_at, status
         FROM wireless_controllers WHERE id = $1`,
        [id]
      );
      controllerRow = r.rows[0];
    }

    // Only update monitored_devices when SNMP fields were sent and the
    // controller is actually linked to a device.
    if (hasSnmp && snmpDeviceId != null) {
      const dSets = [];
      const dParams = [];
      for (const k of snmpFields) {
        if (snmpSets[k] !== undefined) {
          dParams.push(snmpSets[k]);
          dSets.push(`${k} = $${dParams.length}`);
        }
      }
      dParams.push(snmpDeviceId);
      await client.query(
        `UPDATE monitored_devices SET ${dSets.join(', ')} WHERE id = $${dParams.length}`,
        dParams
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (!controllerRow) return res.status(404).json({ error: 'Controller not found' });
  res.json(controllerRow);
}));

app.delete('/api/wireless/controllers/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM wireless_controllers WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// Manual HA pairing: link two controllers as an HA pair (for platforms that don't
// expose HA over SNMP). Sets the link on BOTH sides; peer_id null clears it.
app.post('/api/wireless/controllers/:id/ha-peer', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const peerId = b.peer_id != null && b.peer_id !== '' ? parseInt(b.peer_id, 10) : null;
  const role = b.role === 'Active' || b.role === 'Standby' ? b.role : null;
  if (peerId === id) return res.status(400).json({ error: 'A controller cannot be its own HA peer.' });
  try {
    if (peerId == null) {
      // Clear this controller's link and any controller that pointed back at it.
      await sv.query(`UPDATE wireless_controllers SET ha_peer_controller_id = NULL, ha_manual_role = NULL WHERE id = $1`, [id]);
      await sv.query(`UPDATE wireless_controllers SET ha_peer_controller_id = NULL, ha_manual_role = NULL WHERE ha_peer_controller_id = $1`, [id]);
    } else {
      const peer = await sv.query(`SELECT id FROM wireless_controllers WHERE id = $1`, [peerId]);
      if (!peer.rows[0]) return res.status(404).json({ error: 'Peer controller not found' });
      const opposite = role === 'Active' ? 'Standby' : role === 'Standby' ? 'Active' : null;
      await sv.query(`UPDATE wireless_controllers SET ha_peer_controller_id = $2, ha_manual_role = $3 WHERE id = $1`, [id, peerId, role]);
      await sv.query(`UPDATE wireless_controllers SET ha_peer_controller_id = $2, ha_manual_role = COALESCE($3, ha_manual_role) WHERE id = $1`, [peerId, id, opposite]);
    }
    res.json({ ok: true });
  } catch (e) {
    if (/ha_peer_controller_id|ha_manual_role/.test(e.message)) {
      return res.status(400).json({ error: 'HA pairing needs a schema update (restart the API to auto-apply).' });
    }
    throw e;
  }
}));

// On-demand auto-detection of SNMP wireless controllers. Replicates the
// collector's autoDetectControllers() (collector/wirelessCollector.js) so the UI
// can trigger a rescan without waiting for the next collector cycle.
//
// NOTE: the vendor map below mirrors wirelessVendorFor() in
// collector/wireless/index.js — keep the two in sync.
app.post('/api/wireless/controllers/rescan', wrap(async (_req, res) => {
  const wirelessVendorFor = (deviceVendor) => {
    if (!deviceVendor) return null;
    const v = String(deviceVendor).toLowerCase().trim();
    const map = {
      aruba: 'aruba',
      cisco: 'cisco',
      meraki: 'cisco',        // Meraki is Cisco; closest SNMP fit
      fortinet: 'fortinet',
      ruckus: 'ruckus',
      mikrotik: 'mikrotik',
      grandstream: 'grandstream',
      'hpe-procurve': 'hpe',
      'hpe-comware': 'hpe',
      hpe: 'hpe',
    };
    if (map[v]) return map[v];
    if (v.startsWith('hpe')) return 'hpe';   // prefix fallback
    return null;
  };

  // device_type predicate identifying genuine wireless gear (mirror of
  // wirelessTypeClause() in collector/wirelessCollector.js). Vendor alone is not
  // sufficient — a Cisco/Aruba router/switch is not a wireless controller.
  const wirelessTypeClause = `(
       device_type ILIKE '%wireless%'
    OR device_type ILIKE '%wifi%'
    OR device_type ILIKE '%access point%'
    OR device_type ILIKE '%wlc%'
  )`;

  const candidates = await sv.query(`
    SELECT id, name, device_vendor, site_id, site_name
    FROM monitored_devices
    WHERE active = TRUE AND snmp_enabled = TRUE AND device_vendor IS NOT NULL
      AND device_type IS NOT NULL AND ${wirelessTypeClause}
      AND id NOT IN (SELECT snmp_device_id FROM wireless_controllers WHERE snmp_device_id IS NOT NULL)
  `);

  const controllers = [];
  for (const d of candidates.rows) {
    const wkey = wirelessVendorFor(d.device_vendor);
    if (!wkey) continue;
    const ins = await sv.query(`
      INSERT INTO wireless_controllers (name, vendor, snmp_device_id, site_id, site_name)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (snmp_device_id) WHERE snmp_device_id IS NOT NULL DO NOTHING
      RETURNING id, name, vendor, snmp_device_id
    `, [`${d.name} (wireless)`, wkey, d.id, d.site_id || null, d.site_name || null]);
    if (ins.rows[0]) controllers.push(ins.rows[0]);
  }

  res.json({ created: controllers.length, controllers });
}));

// Test a controller's reachability (dry run — no DB writes).
app.post('/api/wireless/controllers/:id/test', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT * FROM wireless_controllers WHERE id = $1`, [id]);
  const controller = r.rows[0];
  if (!controller) return res.status(404).json({ error: 'Controller not found' });
  res.json(await wireless.testController(sv, controller));
}));

// ── Access points ─────────────────────────────────────────────
app.get('/api/wireless/aps', wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.controller_id) { params.push(parseInt(req.query.controller_id, 10)); where.push(`a.controller_id = $${params.length}`); }
  if (req.query.site_id)       { params.push(parseInt(req.query.site_id, 10));       where.push(`a.site_id = $${params.length}`); }
  if (req.query.status)        { params.push(String(req.query.status));              where.push(`a.status = $${params.length}`); }
  const sc = siteFilterClause(getSiteFilter(req), params, 'a.site_id');
  if (sc) where.push(sc);
  const r = await sv.query(`
    SELECT a.id, a.name, a.controller_id, c.name AS controller_name, c.vendor,
           a.monitored_device_id, a.site_id, a.site_name, a.status,
           a.clients_total, a.clients_2g, a.clients_5g, a.clients_6g,
           a.radio_2g_channel, a.radio_5g_channel, a.radio_6g_channel,
           a.radio_2g_util_pct, a.radio_5g_util_pct,
           a.ip_address, a.mac_address, a.model, a.firmware_version,
           a.tx_power_2g, a.tx_power_5g, a.uptime_seconds, a.last_seen_at,
           a.noise_floor_2g, a.noise_floor_5g, a.retry_rate_2g, a.retry_rate_5g,
           a.rx_errors_2g, a.tx_errors_2g, a.rx_errors_5g, a.tx_errors_5g,
           a.throughput_in_bps, a.throughput_out_bps, a.serial_number, a.auth_failures
    FROM wireless_aps a
    LEFT JOIN wireless_controllers c ON c.id = a.controller_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.site_name NULLS LAST, a.name
  `, params);
  res.json(r.rows.map((row) => ({ ...row, uptime_formatted: fmtUptime(row.uptime_seconds) })));
}));

app.get('/api/wireless/aps/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`
    SELECT a.*, c.name AS controller_name, c.vendor
    FROM wireless_aps a LEFT JOIN wireless_controllers c ON c.id = a.controller_id
    WHERE a.id = $1
  `, [id]);
  const ap = r.rows[0];
  if (!ap) return res.status(404).json({ error: 'AP not found' });
  const hist = await sv.query(`
    SELECT date_bin('5 minutes', ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           ROUND(AVG(clients_total))::int AS clients_total,
           ROUND(AVG(clients_2g))::int AS clients_2g,
           ROUND(AVG(clients_5g))::int AS clients_5g,
           ROUND(AVG(radio_2g_util)::numeric, 1) AS radio_2g_util,
           ROUND(AVG(radio_5g_util)::numeric, 1) AS radio_5g_util
    FROM wireless_history
    WHERE ap_id = $1 AND ts >= NOW() - INTERVAL '24 hours'
    GROUP BY bucket ORDER BY bucket
  `, [id]);
  res.json({ ...ap, uptime_formatted: fmtUptime(ap.uptime_seconds), history: hist.rows });
}));

// AP client/utilization history (bucketed by range).
app.get('/api/wireless/history/:ap_id', wrap(async (req, res) => {
  const id = parseInt(req.params.ap_id, 10);
  const interval = rangeToInterval(req.query.range);
  const bucket = rangeToBucket(req.query.range);
  // retry_rate columns are a later migration — degrade to NULL if absent.
  let retrySel = `NULL::numeric AS retry_rate_2g, NULL::numeric AS retry_rate_5g`;
  try {
    const rc = await sv.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='wireless_history' AND column_name='retry_rate_2g') AS x`);
    if (rc.rows[0] && rc.rows[0].x) {
      retrySel = `ROUND(AVG(retry_rate_2g)::numeric, 1) AS retry_rate_2g,
                  ROUND(AVG(retry_rate_5g)::numeric, 1) AS retry_rate_5g`;
    }
  } catch (_e) { /* keep NULL fallback */ }
  const r = await sv.query(`
    SELECT date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           ROUND(AVG(clients_total))::int AS clients_total,
           ROUND(AVG(clients_2g))::int AS clients_2g,
           ROUND(AVG(clients_5g))::int AS clients_5g,
           ROUND(AVG(radio_2g_util)::numeric, 1) AS radio_2g_util,
           ROUND(AVG(radio_5g_util)::numeric, 1) AS radio_5g_util,
           ROUND(AVG(noise_floor_2g)::numeric, 0) AS noise_floor_2g,
           ROUND(AVG(noise_floor_5g)::numeric, 0) AS noise_floor_5g,
           ${retrySel}
    FROM wireless_history
    WHERE ap_id = $2 AND ts >= NOW() - $3::interval
    GROUP BY bucket ORDER BY bucket
  `, [bucket, id, interval]);
  res.json(r.rows);
}));

// Wireless summary for the overview tab + dashboard card.
app.get('/api/wireless/summary', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'a.site_id');
  const scWhere = sc ? ` WHERE ${sc}` : '';

  const totals = await sv.query(`
    SELECT COUNT(*)::int AS total_aps,
           COUNT(*) FILTER (WHERE status = 'online')::int  AS online_aps,
           COUNT(*) FILTER (WHERE status = 'offline')::int AS offline_aps,
           COALESCE(SUM(clients_total), 0)::int AS total_clients
    FROM wireless_aps a${scWhere}
  `, params);

  const bySite = await sv.query(`
    SELECT COALESCE(a.site_id, 0) AS site_id,
           COALESCE(a.site_name, 'Unassigned') AS site_name,
           COUNT(*)::int AS aps,
           COUNT(*) FILTER (WHERE a.status = 'online')::int AS online,
           COALESCE(SUM(a.clients_total), 0)::int AS clients,
           ROUND(AVG(GREATEST(COALESCE(a.radio_2g_util_pct,0), COALESCE(a.radio_5g_util_pct,0)))::numeric, 1) AS avg_util
    FROM wireless_aps a${scWhere}
    GROUP BY 1, 2 ORDER BY site_name
  `, params);

  const cParams = [];
  const cSc = siteFilterClause(getSiteFilter(req), cParams, 'c.site_id');
  const byController = await sv.query(`
    SELECT c.id, c.name, c.vendor,
           (SELECT COUNT(*)::int FROM wireless_aps a WHERE a.controller_id = c.id) AS aps,
           (SELECT COALESCE(SUM(a.clients_total),0)::int FROM wireless_aps a WHERE a.controller_id = c.id) AS clients
    FROM wireless_controllers c
    ${cSc ? `WHERE ${cSc}` : ''}
    ORDER BY c.name
  `, cParams);

  const highUtil = await sv.query(`
    SELECT a.id, a.name, a.site_name,
           COALESCE(a.radio_5g_channel, a.radio_2g_channel) AS channel,
           GREATEST(COALESCE(a.radio_2g_util_pct,0), COALESCE(a.radio_5g_util_pct,0)) AS util_pct,
           a.clients_total
    FROM wireless_aps a
    WHERE GREATEST(COALESCE(a.radio_2g_util_pct,0), COALESCE(a.radio_5g_util_pct,0)) > 80${sc ? ` AND ${sc}` : ''}
    ORDER BY util_pct DESC LIMIT 20
  `, params);

  // RF totals: auth failures across all APs + average noise floor across every
  // radio (a radio contributes its 2.4 and 5 GHz noise floors independently).
  const rf = await sv.query(`
    SELECT COALESCE(SUM(a.auth_failures), 0)::int AS auth_failures_total,
           ROUND(((COALESCE(SUM(a.noise_floor_2g),0) + COALESCE(SUM(a.noise_floor_5g),0))::numeric
                  / NULLIF(COUNT(a.noise_floor_2g) + COUNT(a.noise_floor_5g), 0)), 1) AS avg_noise_floor
    FROM wireless_aps a${scWhere}
  `, params);

  // APs whose noise floor is worse than -75 dBm on either radio (poor RF).
  const highNoise = await sv.query(`
    SELECT a.id, a.name, a.site_name,
           GREATEST(COALESCE(a.noise_floor_2g, -999), COALESCE(a.noise_floor_5g, -999)) AS noise_floor
    FROM wireless_aps a
    WHERE (a.noise_floor_2g > -75 OR a.noise_floor_5g > -75)${sc ? ` AND ${sc}` : ''}
    ORDER BY noise_floor DESC LIMIT 20
  `, params);

  // RF health rolled up per site (for the overview RF Health table).
  const rfBySite = await sv.query(`
    SELECT COALESCE(a.site_id, 0) AS site_id,
           COALESCE(a.site_name, 'Unassigned') AS site_name,
           COUNT(*)::int AS aps,
           ROUND(((COALESCE(SUM(a.noise_floor_2g),0) + COALESCE(SUM(a.noise_floor_5g),0))::numeric
                  / NULLIF(COUNT(a.noise_floor_2g) + COUNT(a.noise_floor_5g), 0)), 1) AS avg_noise_floor,
           COUNT(*) FILTER (WHERE GREATEST(COALESCE(a.radio_2g_util_pct,0), COALESCE(a.radio_5g_util_pct,0)) > 80)::int AS high_util_aps,
           ROUND(((COALESCE(SUM(a.retry_rate_2g),0) + COALESCE(SUM(a.retry_rate_5g),0))::numeric
                  / NULLIF(COUNT(a.retry_rate_2g) + COUNT(a.retry_rate_5g), 0)), 1) AS avg_retry_rate,
           COALESCE(SUM(a.auth_failures), 0)::int AS auth_failures
    FROM wireless_aps a${scWhere}
    GROUP BY 1, 2 ORDER BY site_name
  `, params);

  const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
  const t = totals.rows[0] || {};
  const rfRow = rf.rows[0] || {};
  res.json({
    total_aps: t.total_aps || 0,
    online_aps: t.online_aps || 0,
    offline_aps: t.offline_aps || 0,
    total_clients: t.total_clients || 0,
    auth_failures_total: rfRow.auth_failures_total || 0,
    avg_noise_floor: numOrNull(rfRow.avg_noise_floor),
    by_site: bySite.rows.map((s) => ({ ...s, avg_util: s.avg_util === null ? null : Number(s.avg_util) })),
    by_controller: byController.rows,
    high_utilization: highUtil.rows.map((h) => ({ ...h, util_pct: Number(h.util_pct), channel: h.channel === null ? null : Number(h.channel) })),
    high_noise_aps: highNoise.rows.map((h) => ({ ...h, noise_floor: numOrNull(h.noise_floor) })),
    rf_by_site: rfBySite.rows.map((s) => ({
      ...s,
      avg_noise_floor: numOrNull(s.avg_noise_floor),
      avg_retry_rate: numOrNull(s.avg_retry_rate),
    })),
  });
}));

// ── Per-SSID statistics ───────────────────────────────────────
app.get('/api/wireless/ssids', wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.controller_id) { params.push(parseInt(req.query.controller_id, 10)); where.push(`s.controller_id = $${params.length}`); }
  if (req.query.site_id)       { params.push(parseInt(req.query.site_id, 10));       where.push(`s.site_id = $${params.length}`); }
  const sc = siteFilterClause(getSiteFilter(req), params, 's.site_id');
  if (sc) where.push(sc);
  const r = await sv.query(`
    SELECT s.id, s.controller_id, c.name AS controller_name, c.vendor,
           s.ssid_name, s.site_id, s.site_name, s.status,
           s.clients_total, s.bytes_in, s.bytes_out,
           s.auth_successes, s.auth_failures, s.updated_at
    FROM wireless_ssids s
    LEFT JOIN wireless_controllers c ON c.id = s.controller_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.clients_total DESC, s.ssid_name
  `, params);
  res.json(r.rows);
}));

app.get('/api/wireless/ssids/summary', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 's.site_id');
  const scWhere = sc ? ` WHERE ${sc}` : '';

  const totals = await sv.query(`
    SELECT COUNT(*)::int AS total_ssids,
           COUNT(*) FILTER (WHERE status = 'up')::int AS active_ssids
    FROM wireless_ssids s${scWhere}
  `, params);

  const topSsids = await sv.query(`
    SELECT s.id, s.ssid_name, c.name AS controller_name, s.site_name,
           s.clients_total, s.bytes_in, s.bytes_out, s.auth_successes, s.auth_failures
    FROM wireless_ssids s
    LEFT JOIN wireless_controllers c ON c.id = s.controller_id
    ${scWhere}
    ORDER BY s.clients_total DESC LIMIT 5
  `, params);

  const mostFailures = await sv.query(`
    SELECT s.id, s.ssid_name, c.name AS controller_name, s.site_name,
           s.auth_successes, s.auth_failures
    FROM wireless_ssids s
    LEFT JOIN wireless_controllers c ON c.id = s.controller_id
    ${sc ? ` WHERE ${sc} AND` : ' WHERE'} s.auth_failures > 0
    ORDER BY s.auth_failures DESC LIMIT 3
  `, params);

  const t = totals.rows[0] || {};
  res.json({
    total_ssids: t.total_ssids || 0,
    active_ssids: t.active_ssids || 0,
    top_ssids: topSsids.rows,
    most_failures: mostFailures.rows,
  });
}));

// Admin-only diagnostic dump of the wireless tables (controllers, APs, SSIDs, history).
app.get('/api/wireless/debug', wrap(async (req, res) => {
  const role = req.headers['x-user-role'];
  if (role !== 'admin' && role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const controllers = await sv.query('SELECT * FROM wireless_controllers ORDER BY id');
  const apCount = await sv.query('SELECT COUNT(*)::int AS n FROM wireless_aps');
  const apSample = await sv.query('SELECT * FROM wireless_aps ORDER BY id LIMIT 3');
  const ssidCount = await sv.query('SELECT COUNT(*)::int AS n FROM wireless_ssids');
  const ssidSample = await sv.query('SELECT * FROM wireless_ssids ORDER BY id LIMIT 3');
  const histCount = await sv.query('SELECT COUNT(*)::int AS n FROM wireless_history');
  const lastPoll = await sv.query('SELECT MAX(updated_at) AS last_poll FROM wireless_aps');
  // Redact controller credentials before returning (never expose secrets, even to admins).
  const controllerRows = controllers.rows.map((c) => ({
    ...c, api_key: c.api_key ? '***' : null, api_password: c.api_password ? '***' : null,
  }));
  res.json({
    controllers: controllerRows,
    ap_count: apCount.rows[0].n,
    ap_sample: apSample.rows,
    ssid_count: ssidCount.rows[0].n,
    ssid_sample: ssidSample.rows,
    history_count: histCount.rows[0].n,
    last_poll: lastPoll.rows[0].last_poll,
  });
}));

// Admin-only LIVE raw SNMP walk of a controller — returns what the parser's
// declared OIDs currently return plus broad Aruba parent-subtree dumps, so OIDs
// can be validated against the real device instead of guessed.
// Usage: GET /api/wireless/debug/walk?controller_id=N
app.get('/api/wireless/debug/walk', wrap(async (req, res) => {
  const role = req.headers['x-user-role'];
  if (role !== 'admin' && role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const id = parseInt(req.query.controller_id, 10);
  if (!id) return res.status(400).json({ error: 'controller_id is required' });
  const r = await sv.query('SELECT * FROM wireless_controllers WHERE id = $1', [id]);
  const controller = r.rows[0];
  if (!controller) return res.status(404).json({ error: 'Controller not found' });
  res.json(await wireless.debugWalk(sv, controller));
}));

// Usage: GET /api/wireless/debug/walk-oid?controller_id=N&oid=1.3.6.1.2.1.1
app.get('/api/wireless/debug/walk-oid', wrap(async (req, res) => {
  const role = req.headers['x-user-role'];
  if (role !== 'admin' && role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const id = parseInt(req.query.controller_id, 10);
  const oid = String(req.query.oid || '').trim();
  if (!id) return res.status(400).json({ error: 'controller_id is required' });
  if (!oid) return res.status(400).json({ error: 'oid is required' });
  if (!/^\.?\d+(\.\d+)+$/.test(oid)) {
    return res.status(400).json({ error: 'Invalid OID (expected numeric dotted form)' });
  }
  const r = await sv.query('SELECT * FROM wireless_controllers WHERE id = $1', [id]);
  const controller = r.rows[0];
  if (!controller) return res.status(404).json({ error: 'Controller not found' });
  res.json(await wireless.walkOid(sv, controller, oid));
}));

// Admin-only: (re)run the one-time OID capability probe for a controller. Stores
// the discovered capability→OID map in wireless_controllers.capabilities.
app.post('/api/wireless/controllers/:id/probe', wrap(async (req, res) => {
  const role = req.headers['x-user-role'];
  if (role !== 'admin' && role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'controller id is required' });
  const r = await sv.query('SELECT * FROM wireless_controllers WHERE id = $1', [id]);
  const controller = r.rows[0];
  if (!controller) return res.status(404).json({ error: 'Controller not found' });
  const result = await wireless.probeControllerCapabilitiesDetailed(sv, controller);
  const pr = await sv.query('SELECT capabilities_probed_at FROM wireless_controllers WHERE id = $1', [id]);
  res.json({
    capabilities: result.capabilities,
    details: result.details || [],
    message: result.message || null,
    probed_at: pr.rows[0] ? pr.rows[0].capabilities_probed_at : null,
  });
}));

// ── Wireless intelligence ─────────────────────────────────────
// Route order matters: register the static /summary route BEFORE the
// /:controller_id param route so Express doesn't match "summary" as an id.
app.get('/api/wireless/intelligence', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'c.site_id');
  const r = await sv.query(`
    SELECT wi.*, c.name AS controller_name, c.vendor
    FROM wireless_intelligence wi
    JOIN wireless_controllers c ON c.id = wi.controller_id
    ${sc ? `WHERE ${sc}` : ''}
    ORDER BY c.name
  `, params);
  res.json(r.rows);
}));

app.get('/api/wireless/intelligence/summary', wrap(async (req, res) => {
  const filter = getSiteFilter(req);
  const p1 = [];
  const sc1 = siteFilterClause(filter, p1, 'c.site_id');
  const rows = await sv.query(`
    SELECT wi.*, c.name AS controller_name,
           (SELECT COUNT(*)::int FROM wireless_aps a WHERE a.controller_id = wi.controller_id) AS ap_count
    FROM wireless_intelligence wi
    JOIN wireless_controllers c ON c.id = wi.controller_id
    ${sc1 ? `WHERE ${sc1}` : ''}
  `, p1);

  let totW = 0, wScore = 0, bandSum = 0, totalRecs = 0, critical = 0, high = 0;
  const allRecs = [];
  const controllers = [];
  for (const r of rows.rows) {
    const w = r.ap_count || 0;
    totW += w; wScore += Number(r.overall_score) * w;
    bandSum += Number(r.band_steering_score);
    const recs = Array.isArray(r.recommendations) ? r.recommendations : [];
    totalRecs += recs.length;
    for (const rec of recs) {
      if (rec.priority === 'critical') critical++;
      else if (rec.priority === 'high') high++;
      allRecs.push({ ...rec, controller_id: r.controller_id, controller_name: r.controller_name });
    }
    controllers.push({
      id: r.controller_id, name: r.controller_name,
      overall_score: Number(r.overall_score), grade: r.overall_grade,
      overloaded_aps: r.overloaded_aps, co_channel_pairs: r.co_channel_pairs,
    });
  }
  // AP-count-weighted average; fall back to an unweighted mean if every
  // controller reports 0 APs (e.g. APs deleted but intelligence row lingered),
  // so the score doesn't collapse to 0/F when real per-controller scores exist.
  const overall_score = totW
    ? Math.round(wScore / totW)
    : (rows.rows.length
      ? Math.round(rows.rows.reduce((s, r) => s + Number(r.overall_score), 0) / rows.rows.length)
      : 0);
  const prio = { critical: 0, high: 1, medium: 2, low: 3 };
  allRecs.sort((a, b) => (prio[a.priority] ?? 9) - (prio[b.priority] ?? 9));

  const p2 = [];
  const sc2 = siteFilterClause(filter, p2, 'a.site_id');
  const worst = await sv.query(`
    SELECT ai.ap_id, a.name AS ap_name, a.controller_id, a.site_name,
           ai.health_score, ai.health_grade, ai.load_status, ai.issues
    FROM wireless_ap_intelligence ai
    JOIN wireless_aps a ON a.id = ai.ap_id
    ${sc2 ? `WHERE ${sc2}` : ''}
    ORDER BY ai.health_score ASC LIMIT 5
  `, p2);

  res.json({
    overall_score,
    overall_grade: scoreGrade(overall_score),
    total_recommendations: totalRecs,
    critical_count: critical,
    high_count: high,
    top_issues: allRecs.slice(0, 5),
    worst_aps: worst.rows,
    band_steering_avg: rows.rows.length ? Math.round(bandSum / rows.rows.length) : 0,
    controllers,
  });
}));

app.get('/api/wireless/intelligence/:controller_id', wrap(async (req, res) => {
  const id = parseInt(req.params.controller_id, 10);
  const ctrl = await sv.query(`
    SELECT wi.*, c.name AS controller_name, c.vendor
    FROM wireless_intelligence wi
    JOIN wireless_controllers c ON c.id = wi.controller_id
    WHERE wi.controller_id = $1
  `, [id]);
  if (!ctrl.rows[0]) return res.status(404).json({ error: 'No intelligence for this controller yet' });
  const aps = await sv.query(`
    SELECT ai.*, a.name AS ap_name, a.site_name, a.clients_total,
           a.clients_2g, a.clients_5g, a.radio_2g_channel, a.radio_5g_channel,
           a.radio_2g_util_pct, a.radio_5g_util_pct
    FROM wireless_ap_intelligence ai
    JOIN wireless_aps a ON a.id = ai.ap_id
    WHERE a.controller_id = $1
    ORDER BY ai.health_score ASC
  `, [id]);
  res.json({ ...ctrl.rows[0], aps: aps.rows });
}));

// ── Wireless clients ──────────────────────────────────────────
// Route order matters: register the literal /clients and /clients/summary
// (and /aps/:id/clients) routes BEFORE the /clients/:mac param route so
// Express doesn't match "summary" as a mac address.
// is_sticky on wireless_clients is a later migration — probe once so the clients
// list + summary don't 500 before scripts/schema.sql is re-applied.
let _wcStickyCol = null;
async function wcHasSticky() {
  if (_wcStickyCol !== null) return _wcStickyCol;
  try {
    const r = await sv.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='wireless_clients' AND column_name='is_sticky') AS x`);
    _wcStickyCol = !!r.rows[0].x;
  } catch (_e) { _wcStickyCol = false; }
  return _wcStickyCol;
}

app.get('/api/wireless/clients', wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.search) { params.push(`%${String(req.query.search)}%`); where.push(`(cl.mac_address ILIKE $${params.length} OR cl.ip_address ILIKE $${params.length})`); }
  if (req.query.ap_id) { params.push(parseInt(req.query.ap_id, 10)); where.push(`cl.ap_id = $${params.length}`); }
  if (req.query.controller_id) { params.push(parseInt(req.query.controller_id, 10)); where.push(`cl.controller_id = $${params.length}`); }
  if (String(req.query.problem) === 'true') where.push('cl.is_problem = TRUE');
  if (String(req.query.sticky) === 'true') {
    if (await wcHasSticky()) where.push('cl.is_sticky = TRUE');
    else return res.json([]); // column not migrated yet — no sticky data to filter
  }
  const sc = siteFilterClause(getSiteFilter(req), params, 'c.site_id');
  if (sc) where.push(sc);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const r = await sv.query(`
    SELECT cl.*, c.name AS controller_name, c.site_name
    FROM wireless_clients cl
    JOIN wireless_controllers c ON c.id = cl.controller_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY cl.is_problem DESC, cl.rssi_dbm ASC NULLS LAST
    LIMIT ${limit}
  `, params);
  res.json(r.rows.map((row) => ({ ...row, signal_quality: signalQuality(row.rssi_dbm) })));
}));

app.get('/api/wireless/clients/summary', wrap(async (req, res) => {
  const params = [];
  const sc = siteFilterClause(getSiteFilter(req), params, 'c.site_id');
  const stickySel = (await wcHasSticky()) ? 'cl.is_sticky' : 'FALSE AS is_sticky';
  const rows = await sv.query(`
    SELECT cl.band, cl.rssi_dbm, cl.is_problem, ${stickySel}, cl.roaming_count, cl.ap_name,
           cl.controller_id, c.name AS controller_name
    FROM wireless_clients cl JOIN wireless_controllers c ON c.id = cl.controller_id
    ${sc ? 'WHERE ' + sc : ''}
  `, params);

  const byBand = { '2.4GHz': 0, '5GHz': 0, '6GHz': 0 };
  // Per-controller problem counts (and band/signal/roam stats) come from the station
  // table — they're per-client attributes only it carries. The client_count is
  // overridden below with the live per-AP associated gauge so the accordion headers
  // and the Total Clients card agree with the Wireless Insights "Clients" figure.
  const byController = new Map();
  const byAp = {};
  let problemClients = 0, lowSignalClients = 0, frequentRoamers = 0, stickyClients = 0;
  for (const row of rows.rows) {
    if (Object.prototype.hasOwnProperty.call(byBand, row.band)) byBand[row.band]++;
    if (row.controller_id != null) {
      let entry = byController.get(row.controller_id);
      if (!entry) {
        entry = { controller_id: row.controller_id, controller_name: row.controller_name, client_count: 0, problem_count: 0 };
        byController.set(row.controller_id, entry);
      }
      entry.client_count++;
      if (row.is_problem) entry.problem_count++;
    }
    if (row.ap_name) byAp[row.ap_name] = (byAp[row.ap_name] || 0) + 1;
    if (row.is_problem) problemClients++;
    if (row.is_sticky) stickyClients++;
    if (row.rssi_dbm !== null && row.rssi_dbm !== undefined && row.rssi_dbm < -75) lowSignalClients++;
    if ((row.roaming_count || 0) > 5) frequentRoamers++;
  }
  // Live currently-associated client count per controller, from the per-AP gauge
  // (wireless_aps.clients_total) — the SAME source as Wireless Insights. The Aruba
  // station table keeps re-reporting clients the controller has aged out, so it (and
  // the per-client rows) can sit well above what's actually associated right now;
  // sourcing the counts from the gauge keeps the two pages in sync.
  const liveParams = [];
  const liveSc = siteFilterClause(getSiteFilter(req), liveParams, 'c.site_id');
  const liveRes = await sv.query(`
    SELECT a.controller_id, COALESCE(SUM(a.clients_total), 0)::int AS live
    FROM wireless_aps a JOIN wireless_controllers c ON c.id = a.controller_id
    ${liveSc ? 'WHERE ' + liveSc : ''}
    GROUP BY a.controller_id
  `, liveParams);
  const liveByCtl = new Map(liveRes.rows.map((r) => [Number(r.controller_id), Number(r.live)]));
  const liveTotal = liveRes.rows.reduce((s, r) => s + Number(r.live), 0);

  for (const e of byController.values()) {
    if (liveByCtl.has(e.controller_id)) e.client_count = liveByCtl.get(e.controller_id);
  }
  const byControllerArr = Array.from(byController.values())
    .sort((a, b) => b.client_count - a.client_count);
  const topApsByClients = Object.entries(byAp)
    .map(([ap_name, count]) => ({ ap_name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  res.json({
    total_clients: liveTotal,
    by_band: byBand,
    by_controller: byControllerArr,
    problem_clients: problemClients,
    sticky_clients: stickyClients,
    low_signal_clients: lowSignalClients,
    frequent_roamers: frequentRoamers,
    top_aps_by_clients: topApsByClients,
  });
}));

// ── Rogue AP detection ────────────────────────────────────────
// Rogue/unauthorized APs detected by controllers' SNMP rogue tables, populated
// by the wireless collector into wireless_rogue_aps. Returns [] when the table
// has not been migrated yet so the UI degrades gracefully.
app.get('/api/wireless/rogues', wrap(async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.controller_id) { params.push(parseInt(req.query.controller_id, 10)); where.push(`r.controller_id = $${params.length}`); }
    if (req.query.classification) { params.push(String(req.query.classification)); where.push(`r.classification = $${params.length}`); }
    if (req.query.search) { params.push(`%${String(req.query.search)}%`); where.push(`(r.bssid ILIKE $${params.length} OR r.ssid ILIKE $${params.length})`); }
    const sc = siteFilterClause(getSiteFilter(req), params, 'c.site_id');
    if (sc) where.push(sc);
    const r = await sv.query(`
      SELECT r.*, c.name AS controller_name, c.site_name, c.vendor
      FROM wireless_rogue_aps r
      JOIN wireless_controllers c ON c.id = r.controller_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.last_seen_at DESC
      LIMIT 500
    `, params);
    res.json(r.rows);
  } catch (e) {
    if (/wireless_rogue_aps/.test(e.message)) return res.json([]);
    throw e;
  }
}));

app.get('/api/wireless/aps/:id/clients', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`
    SELECT cl.*, c.name AS controller_name
    FROM wireless_clients cl JOIN wireless_controllers c ON c.id = cl.controller_id
    WHERE cl.ap_id = $1
    ORDER BY cl.rssi_dbm ASC NULLS LAST
  `, [id]);
  res.json(r.rows.map((row) => ({ ...row, signal_quality: signalQuality(row.rssi_dbm) })));
}));

app.get('/api/wireless/clients/:mac', wrap(async (req, res) => {
  const mac = decodeURIComponent(req.params.mac);
  const cr = await sv.query(`
    SELECT cl.*, c.name AS controller_name, c.site_name
    FROM wireless_clients cl JOIN wireless_controllers c ON c.id = cl.controller_id
    WHERE cl.mac_address = $1
    ORDER BY cl.last_seen_at DESC LIMIT 1
  `, [mac]);
  if (!cr.rows[0]) return res.status(404).json({ error: 'Client not found' });
  const client = { ...cr.rows[0], signal_quality: signalQuality(cr.rows[0].rssi_dbm) };
  const ev = await sv.query(`
    SELECT event_type, from_ap_name, to_ap_name, rssi_dbm, ssid_name, ts
    FROM wireless_client_events WHERE mac_address = $1
    ORDER BY ts DESC LIMIT 50
  `, [mac]);
  const stats = await sv.query(`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'roam')::int AS total_roams_24h,
      ROUND(AVG(rssi_dbm) FILTER (WHERE rssi_dbm IS NOT NULL))::int AS avg_rssi_24h,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT ssid_name), NULL) AS ssids_used
    FROM wireless_client_events
    WHERE mac_address = $1 AND ts >= NOW() - INTERVAL '24 hours'
  `, [mac]);
  res.json({
    client,
    events: ev.rows,
    stats: {
      total_roams_24h: stats.rows[0]?.total_roams_24h || 0,
      avg_rssi_24h: stats.rows[0]?.avg_rssi_24h ?? null,
      time_connected_today: client.connected_since,
      ssids_used: stats.rows[0]?.ssids_used || [],
    },
  });
}));

// ══════════════════════════════════════════════════════════════
// Reports (?format=csv supported)
// ══════════════════════════════════════════════════════════════
app.get('/api/reports/availability', wrap(async (req, res) => {
  const interval = rangeToInterval(req.query.range);
  const params = [interval];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           ROUND((1 - (SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::numeric
                  / NULLIF(COUNT(*), 0))) * 100, 2) AS uptime_pct,
           COUNT(*)::int AS total_checks,
           SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks
    FROM monitored_devices d
    LEFT JOIN ping_results p ON p.device_id = d.id AND p.ts >= NOW() - $1::interval
    WHERE d.active = TRUE${sc ? ` AND ${sc}` : ''}
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    ORDER BY uptime_pct ASC NULLS LAST
  `, params);
  if (req.query.format === 'csv') return sendCsv(res, 'availability.csv', r.rows);
  res.json(r.rows);
}));

app.get('/api/reports/response-time', wrap(async (req, res) => {
  const interval = rangeToInterval(req.query.range);
  const bucket = rangeToBucket(req.query.range);
  const siteFilter = getSiteFilter(req);

  const p1 = [interval];
  const f1 = reportFilters(req.query, p1, siteFilter);
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           ROUND(AVG(p.response_ms)::numeric, 1) AS avg_ms,
           ROUND(MIN(p.response_ms)::numeric, 1) AS min_ms,
           ROUND(MAX(p.response_ms)::numeric, 1) AS max_ms,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY p.response_ms)::numeric, 1) AS p95_ms
    FROM monitored_devices d
    LEFT JOIN ping_results p ON p.device_id = d.id AND p.ts >= NOW() - $1::interval AND p.status = 'up'
    WHERE ${f1.join(' AND ')}
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    ORDER BY avg_ms DESC NULLS LAST
  `, p1);

  // Per-device sparkline series (bucketed average) for the trend column.
  const p2 = [bucket, interval];
  const f2 = reportFilters(req.query, p2, siteFilter);
  const sp = await sv.query(`
    SELECT p.device_id,
           date_bin($1::interval, p.ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           ROUND(AVG(p.response_ms)::numeric, 1) AS avg_ms
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts >= NOW() - $2::interval AND p.status = 'up' AND ${f2.join(' AND ')}
    GROUP BY p.device_id, bucket ORDER BY p.device_id, bucket
  `, p2);
  const sparkByDev = new Map();
  for (const row of sp.rows) {
    if (!sparkByDev.has(row.device_id)) sparkByDev.set(row.device_id, []);
    sparkByDev.get(row.device_id).push(Number(row.avg_ms));
  }

  const rows = r.rows.map((row) => ({ ...row, spark: sparkByDev.get(row.device_id) || [] }));
  if (req.query.format === 'csv') return sendCsv(res, 'response-time.csv', r.rows);
  res.json(rows);
}));

app.get('/api/reports/alerts', wrap(async (req, res) => {
  const interval = rangeToInterval(req.query.range);
  const params = [interval];
  const f = reportFilters(req.query, params, getSiteFilter(req));
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           COUNT(a.*)::int AS total_alerts,
           COUNT(*) FILTER (WHERE a.severity = 'critical')::int AS critical_count,
           COUNT(*) FILTER (WHERE a.severity = 'warning')::int  AS warning_count,
           ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)
                 FILTER (WHERE a.resolved_at IS NOT NULL)::numeric, 1) AS mttr_minutes,
           MODE() WITHIN GROUP (ORDER BY a.alert_type) AS most_common_type
    FROM monitored_devices d
    LEFT JOIN alerts a ON a.device_id = d.id AND a.triggered_at >= NOW() - $1::interval
    WHERE ${f.join(' AND ')}
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    HAVING COUNT(a.*) > 0
    ORDER BY total_alerts DESC
  `, params);
  if (req.query.format === 'csv') return sendCsv(res, 'alert-summary.csv', r.rows);
  res.json(r.rows);
}));

// ── SLA / bandwidth report helpers ────────────────────────────
// Returns the leading window params + a clause builder for a timestamp column.
function windowParams(q) {
  if (q.range === 'custom' && q.from && q.to) return { custom: true, params: [q.from, q.to] };
  const map = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
  return { custom: false, params: [map[q.range] || '30 days'] };
}
function windowClause(col, w, start) {
  return w.custom
    ? `${col} >= $${start} AND ${col} <= $${start + 1}`
    : `${col} >= NOW() - $${start}::interval`;
}

// Resolve a report's reporting window to explicit start/end timestamps so every
// report endpoint can support an arbitrary custom date range (not just the
// relative NOW()-interval windows). Accepts either date_from/date_to (the saved-
// report column names) or from/to (what the reports UI sends) for the custom
// range. Returns ISO timestamps + a human label; with $1=start, $2=end the
// report queries filter with `ts BETWEEN $1 AND $2`.
function getDateRange(query) {
  const range = query.range || '30d';
  const dateFrom = query.date_from || query.from;
  const dateTo = query.date_to || query.to;
  if (range === 'custom' && dateFrom && dateTo) {
    return {
      start: new Date(dateFrom).toISOString(),
      end: new Date(dateTo + 'T23:59:59').toISOString(),
      label: `${dateFrom} to ${dateTo}`,
    };
  }
  const days = range === '7d' ? 7 : range === '90d' ? 90 : range === '24h' ? 1 : 30;
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: `Last ${days === 1 ? '24 hours' : days + ' days'}`,
  };
}

// Per-device SLA rows for the requested window/scope. Shared by both SLA routes.
async function slaRows(q, siteFilter) {
  const win = getDateRange(q);
  const params = [win.start, win.end];
  const pingTs = 'ts BETWEEN $1 AND $2';
  const alertTs = 'triggered_at BETWEEN $1 AND $2';
  const filters = ['d.active = TRUE'];
  if (q.site_id)   { params.push(parseInt(q.site_id, 10));   filters.push(`d.site_id = $${params.length}`); }
  if (q.device_id) { params.push(parseInt(q.device_id, 10)); filters.push(`d.id = $${params.length}`); }
  const sc = siteFilterClause(siteFilter, params, 'd.site_id');
  if (sc) filters.push(sc);
  const t = parseFloat(q.sla_target);
  const slaTarget = isNaN(t) ? 99.5 : t;

  const r = await sv.query(`
    WITH pings AS (
      SELECT device_id, COUNT(*)::int AS total_checks,
             SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks,
             AVG(response_ms) FILTER (WHERE status = 'up') AS avg_ms,
             MAX(response_ms) AS max_ms,
             MIN(response_ms) FILTER (WHERE status = 'up') AS min_ms
      FROM ping_results WHERE ${pingTs} GROUP BY device_id
    ),
    als AS (
      SELECT device_id, COUNT(*)::int AS total_alerts,
             AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at)) / 60.0)
               FILTER (WHERE resolved_at IS NOT NULL) AS mttr
      FROM alerts WHERE ${alertTs} GROUP BY device_id
    )
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           COALESCE(pg.total_checks, 0)  AS total_checks,
           COALESCE(pg.failed_checks, 0) AS failed_checks,
           CASE WHEN pg.total_checks > 0
                THEN ROUND((1 - pg.failed_checks::numeric / pg.total_checks) * 100, 3)
                ELSE NULL END AS uptime_pct,
           ROUND(pg.avg_ms::numeric, 1) AS avg_response_ms,
           ROUND(pg.max_ms::numeric, 1) AS max_response_ms,
           ROUND(pg.min_ms::numeric, 1) AS min_response_ms,
           COALESCE(al.total_alerts, 0) AS total_alerts,
           ROUND(al.mttr::numeric, 1)   AS mttr_minutes,
           ROUND(COALESCE(pg.failed_checks, 0) * d.poll_interval_seconds / 60.0, 1) AS downtime_minutes
    FROM monitored_devices d
    LEFT JOIN pings pg ON pg.device_id = d.id
    LEFT JOIN als   al ON al.device_id = d.id
    WHERE ${filters.join(' AND ')}
    ORDER BY uptime_pct ASC NULLS LAST, d.name
  `, params);

  const rows = r.rows.map((row) => ({
    ...row,
    sla_met: row.uptime_pct != null && Number(row.uptime_pct) >= slaTarget,
  }));
  return { rows, slaTarget };
}

app.get('/api/reports/sla', wrap(async (req, res) => {
  const { rows, slaTarget } = await slaRows(req.query, getSiteFilter(req));
  res.json({ sla_target: slaTarget, generated_at: new Date().toISOString(), devices: rows });
}));

app.get('/api/reports/sla/summary', wrap(async (req, res) => {
  const { rows, slaTarget } = await slaRows(req.query, getSiteFilter(req));
  const withData = rows.filter((r) => r.total_checks > 0);
  const totalChecks = withData.reduce((a, r) => a + r.total_checks, 0);
  const totalFailed = withData.reduce((a, r) => a + r.failed_checks, 0);
  const overall = totalChecks ? Math.round((1 - totalFailed / totalChecks) * 100 * 1000) / 1000 : null;
  const totalDowntime = Math.round(rows.reduce((a, r) => a + (Number(r.downtime_minutes) || 0), 0) * 10) / 10;
  let worst = null, best = null;
  for (const r of withData) {
    const u = Number(r.uptime_pct);
    if (worst === null || u < worst.uptime_pct) worst = { name: r.device_name, uptime_pct: u };
    if (best === null || u > best.uptime_pct)  best  = { name: r.device_name, uptime_pct: u };
  }
  res.json({
    sla_target: slaTarget,
    total_devices: rows.length,
    devices_meeting_sla: rows.filter((r) => r.sla_met).length,
    overall_availability_pct: overall,
    total_downtime_minutes: totalDowntime,
    worst_device: worst,
    best_device: best,
  });
}));

app.get('/api/reports/bandwidth', wrap(async (req, res) => {
  const q = req.query;
  const w = windowParams(q);
  const params = [...w.params];
  const filters = [
    `s.metric_name ~ '^if_[0-9]+_(in|out)_bps$'`,
    windowClause('s.ts', w, 1),
  ];
  if (q.site_id)   { params.push(parseInt(q.site_id, 10));   filters.push(`d.site_id = $${params.length}`); }
  if (q.device_id) { params.push(parseInt(q.device_id, 10)); filters.push(`d.id = $${params.length}`); }
  const bwSc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  if (bwSc) filters.push(bwSc);
  const r = await sv.query(`
    SELECT s.device_id, d.name AS device_name, d.site_name, s.if_name, s.metric_name,
           ROUND(AVG(s.value)::numeric, 0) AS avg_bps,
           ROUND(MAX(s.value)::numeric, 0) AS max_bps,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.value)::numeric, 0) AS p95_bps
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE ${filters.join(' AND ')}
    GROUP BY s.device_id, d.name, d.site_name, s.if_name, s.metric_name
  `, params);

  // Pair in/out per interface index into one row.
  const map = new Map();
  for (const row of r.rows) {
    const m = /^if_(\d+)_(in|out)_bps$/.exec(row.metric_name);
    if (!m) continue;
    const idx = m[1], dir = m[2];
    const key = `${row.device_id}|${idx}`;
    let e = map.get(key);
    if (!e) {
      e = { device_id: row.device_id, device_name: row.device_name, site_name: row.site_name,
            sensor_name: row.if_name || `Interface ${idx}`,
            avg_in_bps: null, avg_out_bps: null, max_in_bps: null, max_out_bps: null,
            p95_in_bps: null, p95_out_bps: null };
      map.set(key, e);
    }
    if (row.if_name) e.sensor_name = row.if_name;
    if (dir === 'in')  { e.avg_in_bps = row.avg_bps;  e.max_in_bps = row.max_bps;  e.p95_in_bps = row.p95_bps; }
    else               { e.avg_out_bps = row.avg_bps; e.max_out_bps = row.max_bps; e.p95_out_bps = row.p95_bps; }
  }
  const out = Array.from(map.values()).sort((a, b) =>
    (a.device_name || '').localeCompare(b.device_name || '') ||
    (a.sensor_name || '').localeCompare(b.sensor_name || ''));
  res.json(out);
}));

// ══════════════════════════════════════════════════════════════
// Reporting suite (Phase 1)
// ══════════════════════════════════════════════════════════════
function gradeFromScore(s) {
  if (s == null) return null;
  const n = Number(s);
  return n >= 90 ? 'A' : n >= 80 ? 'B' : n >= 70 ? 'C' : n >= 60 ? 'D' : 'F';
}
function gradeFromUptime(u) {
  if (u == null) return null;
  const n = Number(u);
  return n >= 99.9 ? 'A' : n >= 99.5 ? 'B' : n >= 99 ? 'C' : n >= 95 ? 'D' : 'F';
}
function round1(v) { return v == null ? null : Math.round(Number(v) * 10) / 10; }
function pct2(failed, total) { return total > 0 ? Math.round((1 - failed / total) * 10000) / 100 : null; }

// Intelligence/topology tables are created by later migrations. Probe once and
// cache so report queries can skip joins to tables that don't exist yet rather
// than 500ing the whole report.
let reportCaps = null;
async function getReportCaps() {
  if (reportCaps) return reportCaps;
  try {
    const r = await sv.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'device_health_scores') AS health,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'device_baselines')     AS baselines,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'incidents')            AS incidents
    `);
    reportCaps = r.rows[0] || { health: false, baselines: false, incidents: false };
  } catch (_e) {
    reportCaps = { health: false, baselines: false, incidents: false };
  }
  return reportCaps;
}

// ── Saved report configs (per-user via created_by) ────────────
app.get('/api/reports/saved', wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.created_by) { params.push(String(req.query.created_by)); where = 'WHERE created_by = $1'; }
  const r = await sv.query(`SELECT * FROM saved_reports ${where} ORDER BY created_at DESC`, params);
  res.json(r.rows);
}));

// Normalise schedule inputs from a request body into stored column values plus
// the computed next_run_at (null when not scheduled / no recipients).
function scheduleFields(b) {
  const allowed = ['none', 'daily', 'weekly', 'monthly'];
  const schedule = allowed.includes(b.schedule) ? b.schedule : 'none';
  const hr = parseInt(b.schedule_hour, 10);
  const schedule_hour = !isNaN(hr) && hr >= 0 && hr <= 23 ? hr : 7;
  const dy = parseInt(b.schedule_day, 10);
  const schedule_day = !isNaN(dy) && dy >= 0 && dy <= 6 ? dy : null;
  const recipients = b.recipients && String(b.recipients).trim()
    ? String(b.recipients).trim() : null;
  const next_run_at = schedule !== 'none' && recipients
    ? reportScheduler.calculateNextRun({ schedule, schedule_day, schedule_hour })
    : null;
  return { schedule, schedule_hour, schedule_day, recipients, next_run_at };
}

app.post('/api/reports/saved', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.template) return res.status(400).json({ error: 'name and template are required' });
  const scopeIds = Array.isArray(b.scope_ids)
    ? b.scope_ids.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)) : null;
  const s = scheduleFields(b);
  const r = await sv.query(`
    INSERT INTO saved_reports
      (name, template, scope_type, scope_id, scope_ids, scope_name,
       date_range, date_from, date_to, sla_target, created_by,
       schedule, schedule_day, schedule_hour, recipients, next_run_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
  `, [
    b.name, b.template, b.scope_type || 'all', b.scope_id || null,
    scopeIds && scopeIds.length ? scopeIds : null, b.scope_name || null,
    b.date_range || '30d', b.date_from || null, b.date_to || null,
    b.sla_target != null && b.sla_target !== '' ? b.sla_target : 99.5, b.created_by || null,
    s.schedule, s.schedule_day, s.schedule_hour, s.recipients, s.next_run_at,
  ]);
  res.status(201).json(r.rows[0]);
}));

// Update a saved report's schedule/recipients (recomputes next_run_at).
app.put('/api/reports/saved/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const s = scheduleFields(req.body || {});
  const r = await sv.query(`
    UPDATE saved_reports
       SET schedule = $2, schedule_day = $3, schedule_hour = $4,
           recipients = $5, next_run_at = $6
     WHERE id = $1 RETURNING *
  `, [id, s.schedule, s.schedule_day, s.schedule_hour, s.recipients, s.next_run_at]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
}));

// Run a saved report immediately and email it now (does not change next_run_at).
app.post('/api/reports/saved/:id/run-now', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const r = await sv.query(`SELECT * FROM saved_reports WHERE id = $1`, [id]);
  const report = r.rows[0];
  if (!report) return res.status(404).json({ error: 'not found' });
  if (!report.recipients) return res.status(400).json({ error: 'no recipients configured' });
  try {
    const out = await reportScheduler.runAndEmailReport(sv, report, getSmtpSettings);
    await sv.query(`UPDATE saved_reports SET last_sent_at = NOW() WHERE id = $1`, [id]);
    res.json({ ok: true, recipients: out.recipients });
  } catch (e) {
    await sv.query(`
      INSERT INTO report_history (report_id, status, error, recipients)
      VALUES ($1, 'failed', $2, $3)
    `, [id, e.message, report.recipients]).catch(() => {});
    res.status(500).json({ error: e.message });
  }
}));

// Run history for a saved report (most recent first).
app.get('/api/reports/saved/:id/history', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
  const r = await sv.query(`
    SELECT id, report_id, run_at, status, error, recipients
    FROM report_history WHERE report_id = $1 ORDER BY run_at DESC LIMIT 50
  `, [id]);
  res.json(r.rows);
}));

app.delete('/api/reports/saved/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM saved_reports WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// Per-device aggregation shared by several report templates. interval is $1;
// any RBAC site clause is appended by the caller. Returns one row per device.
// `caps` (from getReportCaps) decides whether to join device_health_scores.
function perDeviceAggSql(extraWhere, caps) {
  const hasHealth = caps && caps.health;
  const healthSel = hasHealth
    ? 'h.score AS health_score, h.grade AS health_grade'
    : 'NULL::numeric AS health_score, NULL::text AS health_grade';
  const healthJoin = hasHealth ? 'LEFT JOIN device_health_scores h ON h.device_id = d.id' : '';
  return `
    SELECT d.id, d.name AS device_name, d.ip_address, d.device_type,
           COALESCE(d.site_name, 'Unassigned') AS site_name, d.site_id,
           d.current_status, d.poll_interval_seconds,
           COALESCE(pa.total_checks, 0)::int  AS total_checks,
           COALESCE(pa.failed_checks, 0)::int AS failed_checks,
           CASE WHEN pa.total_checks > 0
                THEN ROUND((1 - pa.failed_checks::numeric / pa.total_checks) * 100, 2)
                ELSE NULL END AS uptime_pct,
           ROUND(pa.avg_ms::numeric, 1) AS avg_response_ms,
           COALESCE(al.cnt, 0)::int AS alerts_count,
           ${healthSel}
    FROM monitored_devices d
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS total_checks,
             SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks,
             AVG(response_ms) FILTER (WHERE status = 'up') AS avg_ms
      FROM ping_results WHERE device_id = d.id AND ts BETWEEN $1 AND $2
    ) pa ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM alerts
       WHERE device_id = d.id AND alert_type <> 'recovery' AND triggered_at BETWEEN $1 AND $2
    ) al ON TRUE
    ${healthJoin}
    WHERE d.active = TRUE${extraWhere || ''}`;
}
function downtimeMin(d) {
  return Math.round((d.failed_checks * (d.poll_interval_seconds || 300) / 60) * 10) / 10;
}

// ── Network summary (always all devices) ──────────────────────
app.get('/api/reports/network-summary', wrap(async (req, res) => {
  const win = getDateRange(req.query);
  const params = [win.start, win.end];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const caps = await getReportCaps();
  const dr = await sv.query(perDeviceAggSql(sc ? ` AND ${sc}` : '', caps), params);
  const mr = await sv.query(`
    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)::numeric, 1) AS mttr
    FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.resolved_at IS NOT NULL AND a.triggered_at BETWEEN $1 AND $2${sc ? ` AND ${sc}` : ''}
  `, params);

  const devices = dr.rows;
  const siteMap = new Map();
  let tChecks = 0, tFailed = 0, tAlerts = 0, respSum = 0, respN = 0, upN = 0, downN = 0;
  for (const d of devices) {
    const s = siteMap.get(d.site_name) || { site_name: d.site_name, devices: 0, up: 0, down: 0, warning: 0, checks: 0, failed: 0, alerts: 0, respSum: 0, respN: 0 };
    s.devices++;
    const st = (d.current_status || 'unknown').toLowerCase();
    if (st === 'up') { s.up++; upN++; } else if (st === 'down') { s.down++; downN++; } else if (st === 'warning') s.warning++;
    s.checks += d.total_checks; s.failed += d.failed_checks; s.alerts += d.alerts_count;
    if (d.avg_response_ms != null) { s.respSum += Number(d.avg_response_ms); s.respN++; respSum += Number(d.avg_response_ms); respN++; }
    siteMap.set(d.site_name, s);
    tChecks += d.total_checks; tFailed += d.failed_checks; tAlerts += d.alerts_count;
  }
  const sites = Array.from(siteMap.values()).map((s) => ({
    site_name: s.site_name, devices: s.devices, up: s.up, down: s.down, warning: s.warning,
    uptime_pct: pct2(s.failed, s.checks),
    avg_response_ms: s.respN ? round1(s.respSum / s.respN) : null,
    alerts_count: s.alerts,
    grade: gradeFromUptime(pct2(s.failed, s.checks)),
  })).sort((a, b) => a.site_name.localeCompare(b.site_name));

  const withDt = devices.map((d) => ({ ...d, downtime_minutes: downtimeMin(d) }));
  const top_issues = withDt.filter((d) => d.failed_checks > 0)
    .sort((a, b) => b.downtime_minutes - a.downtime_minutes).slice(0, 5)
    .map((d) => ({ device_id: d.id, device_name: d.device_name, site_name: d.site_name, uptime_pct: d.uptime_pct, downtime_minutes: d.downtime_minutes }));
  const top_alerts = withDt.filter((d) => d.alerts_count > 0)
    .sort((a, b) => b.alerts_count - a.alerts_count).slice(0, 5)
    .map((d) => ({ device_id: d.id, device_name: d.device_name, site_name: d.site_name, alerts_count: d.alerts_count }));

  const scores = devices.map((d) => d.health_score).filter((v) => v != null).map(Number);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  // ── Auto-generated "Key Findings" (compares current vs the previous period) ──
  const periodLabel = ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days' })[req.query.range] || 'this period';
  const durationMs = Date.parse(win.end) - Date.parse(win.start);
  const prevStart = new Date(Date.parse(win.start) - durationMs).toISOString();
  // prevResp spans ONLY the previous window [prevStart, start): $1=prevStart,
  // $2=start, optional site filter at $3. A dedicated 2-bound array avoids a
  // supplied-but-unreferenced $2 that Postgres can't type-infer
  // ("could not determine data type of parameter $2"), which was silently
  // suppressing the "most-improved device" key finding via the .catch below.
  const prevParams = [prevStart, win.start];
  const prevSc = siteFilterClause(getSiteFilter(req), prevParams, 'd.site_id');
  const prevAnd = prevSc ? ` AND ${prevSc}` : '';
  const prevResp = await sv.query(`
    SELECT p.device_id, AVG(p.response_ms) AS avg_ms
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.status = 'up' AND p.ts >= $1::timestamptz AND p.ts < $2::timestamptz${prevAnd}
    GROUP BY p.device_id`, prevParams).catch(() => ({ rows: [] }));
  // cpuRisk only spans the current window ($1/$2) — it must NOT receive the
  // prevStart ($3) element that iParams carries, or an unscoped request binds 3
  // params to a 2-placeholder statement. Use a dedicated window-only array.
  const cpuParams = [win.start, win.end];
  const cpuSc = siteFilterClause(getSiteFilter(req), cpuParams, 'd.site_id');
  const cpuAnd = cpuSc ? ` AND ${cpuSc}` : '';
  const cpuRisk = await sv.query(`
    SELECT d.name AS device_name, ROUND(AVG(s.value)::numeric, 0) AS cpu
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE s.metric_name ILIKE '%cpu%' AND s.ts BETWEEN $1 AND $2${cpuAnd}
    GROUP BY d.name HAVING AVG(s.value) >= 75 ORDER BY cpu DESC LIMIT 1`, cpuParams).catch(() => ({ rows: [] }));

  const key_findings = [];
  const bestSite = [...sites].filter((s) => s.uptime_pct != null).sort((a, b) => b.uptime_pct - a.uptime_pct)[0];
  if (bestSite) key_findings.push(`${bestSite.site_name} was the most available site at ${bestSite.uptime_pct}% over ${periodLabel}.`);
  const prevMap = new Map(prevResp.rows.map((r) => [r.device_id, r.avg_ms != null ? Number(r.avg_ms) : null]));
  let improved = null;
  for (const d of devices) {
    const cur = d.avg_response_ms != null ? Number(d.avg_response_ms) : null;
    const prev = prevMap.get(d.id);
    if (cur != null && prev != null && prev > 0) {
      const ch = ((prev - cur) / prev) * 100;
      if (ch > 20 && (!improved || ch > improved.ch)) improved = { name: d.device_name, ch: Math.round(ch) };
    }
  }
  if (improved) key_findings.push(`${improved.name} response time improved ${improved.ch}% versus the previous period.`);
  if (top_alerts[0] && top_alerts[0].alerts_count > 0) {
    key_findings.push(`${top_alerts[0].device_name} triggered ${top_alerts[0].alerts_count} alerts — the most in the network.`);
  }
  if (cpuRisk.rows[0]) key_findings.push(`${cpuRisk.rows[0].device_name} CPU is averaging ${cpuRisk.rows[0].cpu}% — approaching its threshold.`);

  res.json({
    generated_at: new Date().toISOString(),
    period: req.query.range || '30d',
    overall_health: { score: avgScore, grade: gradeFromScore(avgScore), trend: null },
    key_findings,
    sites,
    totals: {
      devices: devices.length, up: upN, down: downN,
      uptime_pct: pct2(tFailed, tChecks), total_alerts: tAlerts,
      avg_response_ms: respN ? round1(respSum / respN) : null,
      mttr_minutes: mr.rows[0] ? mr.rows[0].mttr : null,
    },
    top_issues, top_alerts,
  });
}));

// ── Site summary ──────────────────────────────────────────────
app.get('/api/reports/site-summary', wrap(async (req, res) => {
  const win = getDateRange(req.query);
  const siteId = parseInt(req.query.site_id, 10);
  if (isNaN(siteId)) return res.status(400).json({ error: 'site_id is required' });
  const t = parseFloat(req.query.sla_target);
  const slaTarget = isNaN(t) ? 99.5 : t;
  const params = [win.start, win.end, siteId];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const caps = await getReportCaps();
  const r = await sv.query(
    perDeviceAggSql(` AND d.site_id = $3${sc ? ` AND ${sc}` : ''}`, caps) + ` ORDER BY uptime_pct ASC NULLS LAST, d.name`,
    params
  );
  const devices = r.rows.map((d) => ({
    name: d.device_name, ip: d.ip_address, device_type: d.device_type,
    uptime_pct: d.uptime_pct, avg_response_ms: d.avg_response_ms, alerts_count: d.alerts_count,
    sla_met: d.uptime_pct != null && Number(d.uptime_pct) >= slaTarget,
    health_score: d.health_score, health_grade: d.health_grade,
    downtime_minutes: downtimeMin(d),
  }));
  const site_name = r.rows[0] ? r.rows[0].site_name : (req.query.site_name || `Site ${siteId}`);
  const withData = r.rows.filter((d) => d.total_checks > 0);
  const checks = withData.reduce((a, d) => a + d.total_checks, 0);
  const failed = withData.reduce((a, d) => a + d.failed_checks, 0);
  const up = r.rows.filter((d) => (d.current_status || '').toLowerCase() === 'up').length;
  const down = r.rows.filter((d) => (d.current_status || '').toLowerCase() === 'down').length;
  const worst = devices.filter((d) => d.uptime_pct != null).sort((a, b) => Number(a.uptime_pct) - Number(b.uptime_pct))[0] || null;
  const avgUptime = pct2(failed, checks);

  // ── Auto-generated "Site Analysis" paragraph ──
  const periodLabel = ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days' })[req.query.range] || 'this period';
  const netAvg = await sv.query(
    `SELECT ROUND(AVG(response_ms)::numeric, 1) AS avg FROM ping_results WHERE status = 'up' AND ts BETWEEN $1 AND $2`,
    [win.start, win.end]).catch(() => ({ rows: [] }));
  const best = devices.filter((d) => d.uptime_pct != null).sort((a, b) => Number(b.uptime_pct) - Number(a.uptime_pct))[0];
  const mostAlerts = [...devices].sort((a, b) => b.alerts_count - a.alerts_count)[0];
  const respVals = devices.map((d) => d.avg_response_ms).filter((v) => v != null).map(Number);
  const siteAvg = respVals.length ? Math.round((respVals.reduce((a, b) => a + b, 0) / respVals.length) * 10) / 10 : null;
  const netAvgMs = netAvg.rows[0] && netAvg.rows[0].avg != null ? Number(netAvg.rows[0].avg) : null;
  let analysis = `${site_name} maintained ${avgUptime != null ? avgUptime : '—'}% availability over ${periodLabel}.`;
  if (best) analysis += ` ${best.name} was the most reliable device (${best.uptime_pct != null ? best.uptime_pct : '—'}% uptime).`;
  if (mostAlerts && mostAlerts.alerts_count > 0) analysis += ` ${mostAlerts.name} had the most issues with ${mostAlerts.alerts_count} alert${mostAlerts.alerts_count > 1 ? 's' : ''}.`;
  if (siteAvg != null) {
    const cmp = netAvgMs == null ? null : siteAvg < netAvgMs ? 'better than' : siteAvg > netAvgMs ? 'worse than' : 'in line with';
    analysis += ` Average response time was ${siteAvg}ms${cmp ? `, ${cmp} the network average of ${netAvgMs}ms` : ''}.`;
  }

  res.json({
    site_name, period: req.query.range || '30d', sla_target: slaTarget,
    devices,
    summary: {
      total: devices.length, up, down,
      avg_uptime: avgUptime,
      total_alerts: devices.reduce((a, d) => a + d.alerts_count, 0),
    },
    top_issue: worst,
    analysis,
  });
}));

// ── Device detail ─────────────────────────────────────────────
app.get('/api/reports/device-detail', wrap(async (req, res) => {
  const id = parseInt(req.query.device_id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'device_id is required' });
  const win = getDateRange(req.query);
  const dev = await sv.query(
    `SELECT id, name, ip_address, site_name, device_type, device_vendor, snmp_enabled, poll_interval_seconds
       FROM monitored_devices WHERE id = $1`, [id]);
  if (!dev.rows[0]) return res.status(404).json({ error: 'Device not found' });
  const d = dev.rows[0];

  // Each sub-query is isolated: a failure (e.g. an optional intelligence/topology
  // table missing on an un-migrated DB) degrades that section to empty rather
  // than failing the whole report.
  const safeQ = (sql, p) => sv.query(sql, p).catch((e) => {
    console.error('[reports/device-detail] subquery failed:', e.message);
    return { rows: [] };
  });
  const [avail, resp, health, baseline, alerts, byDay, snmpSummary, topo, longest] = await Promise.all([
    safeQ(`SELECT COUNT(*)::int AS total_checks,
                     SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks
              FROM ping_results WHERE device_id = $1 AND ts BETWEEN $2 AND $3`, [id, win.start, win.end]),
    safeQ(`SELECT ROUND(AVG(response_ms)::numeric,1) AS avg_ms, ROUND(MIN(response_ms)::numeric,1) AS min_ms,
                     ROUND(MAX(response_ms)::numeric,1) AS max_ms,
                     ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms)::numeric,1) AS p95_ms
              FROM ping_results WHERE device_id = $1 AND status = 'up' AND ts BETWEEN $2 AND $3`, [id, win.start, win.end]),
    safeQ(`SELECT score, grade, trend FROM device_health_scores WHERE device_id = $1`, [id]),
    safeQ(`SELECT mean, p95 FROM device_baselines WHERE device_id = $1 AND metric = 'response_ms'
                ORDER BY period_days ASC LIMIT 1`, [id]),
    safeQ(`SELECT id, alert_type, severity, message, triggered_at, resolved_at, acknowledged_by, status,
                     ROUND(EXTRACT(EPOCH FROM (COALESCE(resolved_at, NOW()) - triggered_at)) / 60.0)::int AS duration_minutes
              FROM alerts WHERE device_id = $1 ORDER BY triggered_at DESC LIMIT 20`, [id]),
    safeQ(`WITH series AS (
                SELECT generate_series(date_trunc('day', NOW()) - INTERVAL '89 days', date_trunc('day', NOW()), INTERVAL '1 day') AS dd
              ), pings AS (
                SELECT date_trunc('day', ts) AS dd, COUNT(*) AS tc,
                       SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END) AS bad
                FROM ping_results WHERE device_id = $1 AND ts >= date_trunc('day', NOW()) - INTERVAL '89 days'
                GROUP BY 1
              )
              SELECT to_char(series.dd, 'YYYY-MM-DD') AS day,
                     CASE WHEN p.tc > 0 THEN ROUND((1 - (p.bad::numeric / p.tc)) * 100, 1) ELSE NULL END AS uptime_pct,
                     COALESCE(p.tc, 0)::int AS total_checks
              FROM series LEFT JOIN pings p ON p.dd = series.dd ORDER BY series.dd`, [id]),
    safeQ(`SELECT s.sensor_name, s.metric_name, s.category, lv.value AS current_value, b.mean AS baseline_mean
              FROM device_sensors s
              LEFT JOIN LATERAL (
                SELECT value FROM snmp_results WHERE device_id = $1 AND metric_name = s.metric_name
                ORDER BY ts DESC LIMIT 1
              ) lv ON TRUE
              LEFT JOIN LATERAL (
                SELECT mean FROM device_baselines WHERE device_id = $1 AND metric = s.metric_name
                ORDER BY period_days ASC LIMIT 1
              ) b ON TRUE
              WHERE s.device_id = $1 AND s.enabled = TRUE ORDER BY s.category, s.sensor_name`, [id]),
    safeQ(`SELECT t.from_port, t.to_port, t.protocol, t.to_device_id,
                     COALESCE(nd.name, t.to_name) AS neighbor_name,
                     COALESCE(nd.ip_address, t.to_ip) AS neighbor_ip
              FROM topology_links t LEFT JOIN monitored_devices nd ON nd.id = t.to_device_id
              WHERE t.from_device_id = $1 ORDER BY t.from_port NULLS LAST`, [id]),
    safeQ(`WITH s AS (
                SELECT status, SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS grp
                FROM ping_results WHERE device_id = $1 AND ts BETWEEN $2 AND $3
              )
              SELECT COUNT(*)::int AS run FROM s WHERE status <> 'up' GROUP BY grp ORDER BY run DESC LIMIT 1`, [id, win.start, win.end]),
  ]);

  const a0 = avail.rows[0] || { total_checks: 0, failed_checks: 0 };
  const poll = d.poll_interval_seconds || 300;

  // ── Auto-generated "Device Analysis" paragraph ──
  const periodLabel = ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days' })[req.query.range] || 'this period';
  const trend = health.rows[0] && health.rows[0].trend ? health.rows[0].trend : 'stable';
  const avgMs = resp.rows[0] && resp.rows[0].avg_ms != null ? Number(resp.rows[0].avg_ms) : null;
  const baseMs = baseline.rows[0] && baseline.rows[0].mean != null ? Number(baseline.rows[0].mean) : null;
  const typeCounts = {};
  for (const al of alerts.rows) {
    if (al.alert_type && al.alert_type !== 'recovery') typeCounts[al.alert_type] = (typeCounts[al.alert_type] || 0) + 1;
  }
  const alertEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const totalAlerts = alertEntries.reduce((s, [, n]) => s + n, 0);
  let analysis = `${d.name} has been ${trend} over ${periodLabel}.`;
  if (avgMs != null) {
    if (baseMs != null) {
      const rel = avgMs > baseMs * 1.1 ? 'above' : avgMs < baseMs * 0.9 ? 'below' : 'in line with';
      analysis += ` Average response of ${avgMs}ms is ${rel} its ${baseMs}ms baseline.`;
    } else {
      analysis += ` Average response was ${avgMs}ms.`;
    }
  }
  if (totalAlerts > 0) {
    analysis += ` ${totalAlerts} alert${totalAlerts > 1 ? 's were' : ' was'} raised${alertEntries[0] ? `, mostly ${alertEntries[0][0].replace(/_/g, ' ')}` : ''}.`;
  }

  res.json({
    device: { name: d.name, ip: d.ip_address, site: d.site_name, type: d.device_type, vendor: d.device_vendor, snmp_enabled: d.snmp_enabled },
    period: req.query.range || '30d',
    analysis,
    availability: {
      uptime_pct: pct2(a0.failed_checks, a0.total_checks),
      total_checks: a0.total_checks, failed_checks: a0.failed_checks,
      downtime_minutes: round1(a0.failed_checks * poll / 60),
      longest_outage_minutes: longest.rows[0] ? round1(Number(longest.rows[0].run) * poll / 60) : 0,
    },
    response: resp.rows[0] || { avg_ms: null, min_ms: null, max_ms: null, p95_ms: null },
    health: health.rows[0]
      ? { score: Number(health.rows[0].score), grade: health.rows[0].grade, trend: health.rows[0].trend }
      : { score: null, grade: null, trend: null },
    baseline: {
      mean_ms: baseline.rows[0] && baseline.rows[0].mean != null ? Number(baseline.rows[0].mean) : null,
      p95_ms: baseline.rows[0] && baseline.rows[0].p95 != null ? Number(baseline.rows[0].p95) : null,
    },
    alerts: alerts.rows,
    uptime_by_day: byDay.rows,
    snmp_summary: snmpSummary.rows,
    topology: topo.rows,
  });
}));

// ── SLA compliance (rows + summary in one response) ───────────
app.get('/api/reports/sla-compliance', wrap(async (req, res) => {
  const { rows, slaTarget } = await slaRows(req.query, getSiteFilter(req));
  const withData = rows.filter((r) => r.total_checks > 0);
  const tChecks = withData.reduce((a, r) => a + r.total_checks, 0);
  const tFailed = withData.reduce((a, r) => a + r.failed_checks, 0);

  // ── Risk Assessment: devices hovering near the SLA target + downtime trend ──
  const at_risk = [];
  for (const r of rows) {
    const u = r.uptime_pct != null ? Number(r.uptime_pct) : null;
    if (u == null || u >= 100) continue;
    if (u >= 99 && u <= slaTarget + 0.4 && u >= slaTarget - 0.6) {
      const minsPerCheck = r.failed_checks > 0 ? Number(r.downtime_minutes) / r.failed_checks : null;
      const periodMins = minsPerCheck != null ? r.total_checks * minsPerCheck : null;
      const toBreach = periodMins != null ? Math.max(0, Math.round(periodMins * (u - slaTarget) / 100)) : null;
      at_risk.push({ device_name: r.device_name, site_name: r.site_name, uptime_pct: u, minutes_to_breach: toBreach });
    }
  }
  at_risk.sort((a, b) => a.uptime_pct - b.uptime_pct);

  // Downtime trend vs the previous same-length period.
  const trends = [];
  try {
    const win = getDateRange(req.query);
    const durationMs = Date.parse(win.end) - Date.parse(win.start);
    const fmtD = (ms) => new Date(ms).toISOString().slice(0, 10);
    const prevQ = {
      range: 'custom', from: fmtD(Date.parse(win.start) - durationMs), to: fmtD(Date.parse(win.start)),
      sla_target: req.query.sla_target, site_id: req.query.site_id, device_id: req.query.device_id,
    };
    const prev = await slaRows(prevQ, getSiteFilter(req));
    const prevMap = new Map(prev.rows.map((r) => [r.device_id, Number(r.downtime_minutes) || 0]));
    const incr = [];
    for (const r of rows) {
      const cur = Number(r.downtime_minutes) || 0;
      const pv = prevMap.get(r.device_id);
      if (pv != null && pv > 0 && cur > pv) {
        const pct = Math.round(((cur - pv) / pv) * 100);
        if (pct >= 40) incr.push({ name: r.device_name, pct });
      }
    }
    incr.sort((a, b) => b.pct - a.pct);
    for (const i of incr.slice(0, 2)) trends.push(`${i.name} downtime increased ${i.pct}% versus the previous period.`);
  } catch (e) { console.error('[reports/sla-compliance] trend failed:', e.message); }

  res.json({
    sla_target: slaTarget, generated_at: new Date().toISOString(),
    summary: {
      total: rows.length,
      meeting: rows.filter((r) => r.sla_met).length,
      failing: rows.filter((r) => !r.sla_met && r.uptime_pct != null).length,
      overall_uptime_pct: tChecks ? Math.round((1 - tFailed / tChecks) * 100000) / 1000 : null,
      total_downtime_minutes: Math.round(rows.reduce((a, r) => a + (Number(r.downtime_minutes) || 0), 0) * 10) / 10,
    },
    devices: rows,
    risk_assessment: { at_risk, trends },
  });
}));

// ── Top N worst ───────────────────────────────────────────────
app.get('/api/reports/top-worst', wrap(async (req, res) => {
  const win = getDateRange(req.query);
  const metric = ['uptime', 'response', 'alerts'].includes(req.query.metric) ? req.query.metric : 'uptime';
  const limit = safeInt(req.query.limit, 10, 100);
  const params = [win.start, win.end];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const caps = await getReportCaps();
  const r = await sv.query(perDeviceAggSql(sc ? ` AND ${sc}` : '', caps), params);
  let rows = r.rows.map((d) => ({
    device_id: d.id, device_name: d.device_name, site_name: d.site_name,
    uptime_pct: d.uptime_pct, avg_response_ms: d.avg_response_ms, alerts_count: d.alerts_count,
    downtime_minutes: downtimeMin(d),
  }));
  if (metric === 'uptime') rows = rows.filter((d) => d.uptime_pct != null).sort((a, b) => Number(a.uptime_pct) - Number(b.uptime_pct));
  else if (metric === 'response') rows = rows.filter((d) => d.avg_response_ms != null).sort((a, b) => Number(b.avg_response_ms) - Number(a.avg_response_ms));
  else rows = rows.filter((d) => d.alerts_count > 0).sort((a, b) => b.alerts_count - a.alerts_count);
  res.json({ metric, generated_at: new Date().toISOString(), devices: rows.slice(0, limit) });
}));

// ── Alert analysis ────────────────────────────────────────────
app.get('/api/reports/alert-analysis', wrap(async (req, res) => {
  const win = getDateRange(req.query);
  const params = [win.start, win.end];
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  const base = `FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.alert_type <> 'recovery' AND a.triggered_at BETWEEN $1 AND $2${sc ? ` AND ${sc}` : ''}`;
  const [tot, byType, bySev, bySite, byDevice, mttr, hour, day] = await Promise.all([
    sv.query(`SELECT COUNT(*)::int AS c ${base}`, params),
    sv.query(`SELECT a.alert_type AS key, COUNT(*)::int AS count ${base} GROUP BY a.alert_type ORDER BY count DESC`, params),
    sv.query(`SELECT a.severity AS key, COUNT(*)::int AS count ${base} GROUP BY a.severity ORDER BY count DESC`, params),
    sv.query(`SELECT COALESCE(d.site_name, 'Unassigned') AS key, COUNT(*)::int AS count ${base} GROUP BY 1 ORDER BY count DESC`, params),
    sv.query(`SELECT d.id AS device_id, d.name AS device_name, COALESCE(d.site_name, 'Unassigned') AS site_name,
                     COUNT(*)::int AS count,
                     ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)
                       FILTER (WHERE a.resolved_at IS NOT NULL)::numeric, 1) AS mttr_minutes
              ${base} GROUP BY d.id, d.name, site_name ORDER BY count DESC LIMIT 10`, params),
    sv.query(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)::numeric, 1) AS mttr
              ${base} AND a.resolved_at IS NOT NULL`, params),
    sv.query(`SELECT EXTRACT(HOUR FROM a.triggered_at)::int AS key, COUNT(*)::int AS count ${base} GROUP BY 1 ORDER BY count DESC LIMIT 1`, params),
    sv.query(`SELECT EXTRACT(DOW FROM a.triggered_at)::int AS key, COUNT(*)::int AS count ${base} GROUP BY 1 ORDER BY count DESC LIMIT 1`, params),
  ]);
  res.json({
    total_alerts: tot.rows[0] ? tot.rows[0].c : 0,
    by_type: byType.rows, by_severity: bySev.rows, by_site: bySite.rows, by_device: byDevice.rows,
    top_alerted: byDevice.rows,
    avg_mttr_minutes: mttr.rows[0] ? mttr.rows[0].mttr : null,
    busiest_hour: hour.rows[0] ? hour.rows[0].key : null,
    busiest_day: day.rows[0] ? day.rows[0].key : null,
  });
}));

// ── Capacity planning ─────────────────────────────────────────
app.get('/api/reports/capacity', wrap(async (req, res) => {
  const q = req.query;
  const win = getDateRange({ ...q, range: q.range || '90d' });
  // Midpoint splits the window into halves for the increasing/decreasing trend.
  const midpoint = new Date((Date.parse(win.start) + Date.parse(win.end)) / 2).toISOString();
  const params = [win.start, win.end, midpoint];
  const filters = [`s.metric_name ~ '^if_[0-9]+_(in|out)_bps$'`, `s.ts BETWEEN $1 AND $2`];
  if (q.site_id) { params.push(parseInt(q.site_id, 10)); filters.push(`d.site_id = $${params.length}`); }
  const sc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  if (sc) filters.push(sc);
  const r = await sv.query(`
    SELECT s.device_id, d.name AS device_name, COALESCE(d.site_name, 'Unassigned') AS site_name,
           s.if_name, s.metric_name,
           AVG(s.value) AS avg_bps, MAX(s.value) AS peak_bps,
           AVG(s.value) FILTER (WHERE s.ts <  $3) AS first_half,
           AVG(s.value) FILTER (WHERE s.ts >= $3) AS second_half
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE ${filters.join(' AND ')}
    GROUP BY s.device_id, d.name, site_name, s.if_name, s.metric_name
  `, params);

  const toMbps = (v) => (v == null ? null : Math.round(Number(v) / 1e6 * 100) / 100);
  const map = new Map();
  for (const row of r.rows) {
    const m = /^if_(\d+)_(in|out)_bps$/.exec(row.metric_name);
    if (!m) continue;
    const idx = m[1], dir = m[2];
    const key = `${row.device_id}|${idx}`;
    let e = map.get(key) || {
      device_name: row.device_name, site_name: row.site_name, interface: row.if_name || `Interface ${idx}`,
      avg_in_mbps: null, avg_out_mbps: null, peak_in_mbps: null, peak_out_mbps: null, _f: null, _s: null,
    };
    if (row.if_name) e.interface = row.if_name;
    if (dir === 'in') { e.avg_in_mbps = toMbps(row.avg_bps); e.peak_in_mbps = toMbps(row.peak_bps); e._f = row.first_half; e._s = row.second_half; }
    else { e.avg_out_mbps = toMbps(row.avg_bps); e.peak_out_mbps = toMbps(row.peak_bps); }
    map.set(key, e);
  }
  const out = Array.from(map.values()).map((e) => {
    const f = Number(e._f) || 0, s = Number(e._s) || 0;
    let trend_in = 'stable';
    if (f > 0) { const r2 = (s - f) / f; trend_in = r2 > 0.1 ? 'increasing' : r2 < -0.1 ? 'decreasing' : 'stable'; }
    else if (s > 0) trend_in = 'increasing';
    const cur = e.avg_in_mbps || 0;
    const growthPerMonth = Math.max(0, (s - f) / 1e6); // mbps gained over the window's second half
    const proj = (months) => Math.round((cur + growthPerMonth * months) * 100) / 100;
    delete e._f; delete e._s;
    return { ...e, trend_in, proj_30d_in: proj(1), proj_60d_in: proj(2), proj_90d_in: proj(3), utilization_pct: null };
  }).sort((a, b) => (a.device_name || '').localeCompare(b.device_name || '') || (a.interface || '').localeCompare(b.interface || ''));
  res.json(out);
}));

// ── Executive summary ─────────────────────────────────────────
app.get('/api/reports/executive', wrap(async (req, res) => {
  try {
  const win = getDateRange({ ...req.query, range: req.query.range || '30d' });
  // Previous comparison window: the same-length span immediately before the
  // reporting window ([prevStart, start)).
  const durationMs = Date.parse(win.end) - Date.parse(win.start);
  const prevStart = new Date(Date.parse(win.start) - durationMs).toISOString();
  const siteFilter = getSiteFilter(req);
  // Each query gets a params array whose length exactly matches the highest $N
  // it references — Postgres rejects a bind that supplies more (or fewer)
  // parameters than the prepared statement requires.
  //
  // Window-only queries: $1=start, $2=end, optional site filter at $3.
  const pWin = [win.start, win.end];
  const scWin = siteFilterClause(siteFilter, pWin, 'd.site_id');
  const scWinAnd = scWin ? ` AND ${scWin}` : '';
  // Queries that also compare the previous window:
  // $1=start, $2=end, $3=prevStart, optional site filter at $4.
  const pPrev = [win.start, win.end, prevStart];
  const scPrev = siteFilterClause(siteFilter, pPrev, 'd.site_id');
  const scPrevAnd = scPrev ? ` AND ${scPrev}` : '';
  // Previous-window-ONLY queries (the span [prevStart, start)): $1=prevStart,
  // $2=start, optional site filter at $3. A dedicated 2-bound array avoids a
  // supplied-but-unreferenced parameter that Postgres can't type-infer
  // ("could not determine data type of parameter $2").
  const pPrevWin = [prevStart, win.start];
  const scPrevWin = siteFilterClause(siteFilter, pPrevWin, 'd.site_id');
  const scPrevWinAnd = scPrevWin ? ` AND ${scPrevWin}` : '';
  // Site-only filter (no time bounds): optional site filter at $1.
  const pSite = [];
  const scSite = siteFilterClause(siteFilter, pSite, 'd.site_id');
  const scSiteAnd = scSite ? ` AND ${scSite}` : '';
  const caps = await getReportCaps();

  // Each core query degrades to a safe fallback row instead of 500ing the whole
  // report, and logs WHICH query failed (visible in SpanVault-API.err.log) so a
  // schema/data problem on the live DB is pinpointed without taking the page
  // down. The outer try/catch below is the backstop for anything non-query.
  const runQ = async (label, sql, params, fallbackRows) => {
    try { return await sv.query(sql, params); }
    catch (e) { console.error(`[reports/executive] query '${label}' failed: ${e.message}`); return { rows: fallbackRows }; }
  };

  const ov = await runQ('overview', `
    SELECT COUNT(*)::int AS tc, SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts BETWEEN $1::timestamptz AND $2::timestamptz${scWinAnd}`, pWin, [{ tc: 0, bad: 0 }]);
  const prev = await runQ('prev-overview', `
    SELECT COUNT(*)::int AS tc, SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts >= $1::timestamptz AND p.ts < $2::timestamptz${scPrevWinAnd}`, pPrevWin, [{ tc: 0, bad: 0 }]);
  const dt = await runQ('downtime', `
    SELECT COALESCE(SUM(sub.failed * d.poll_interval_seconds / 60.0), 0) AS dt
    FROM monitored_devices d
    JOIN LATERAL (
      SELECT SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END) AS failed
      FROM ping_results WHERE device_id = d.id AND ts BETWEEN $1::timestamptz AND $2::timestamptz
    ) sub ON TRUE
    WHERE d.active = TRUE${scWinAnd}`, pWin, [{ dt: 0 }]);
  const alertCounts = await runQ('alert-counts', `
    SELECT
      COUNT(*) FILTER (WHERE a.triggered_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS cur,
      COUNT(*) FILTER (WHERE a.triggered_at >= $3::timestamptz AND a.triggered_at < $1::timestamptz)::int AS prev
    FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.alert_type <> 'recovery' AND a.triggered_at >= $3::timestamptz${scPrevAnd}`, pPrev, [{ cur: 0, prev: 0 }]);
  // Per-site availability + a per-site "incidents" count (device_down alerts).
  // The incident count is pre-aggregated into a CTE keyed by the resolved site
  // name and LEFT JOINed — this avoids referencing the grouped column inside a
  // correlated sub-select (a GROUP-BY error on stricter Postgres configs).
  const siteRows = await runQ('site-rows', `
    WITH site_alerts AS (
      SELECT COALESCE(d.site_name, 'Unassigned') AS site_name, COUNT(*)::int AS incidents
      FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
      WHERE a.alert_type = 'device_down' AND a.triggered_at BETWEEN $1::timestamptz AND $2::timestamptz${scWinAnd}
      GROUP BY 1
    )
    SELECT COALESCE(d.site_name, 'Unassigned') AS site_name,
           COUNT(p.*)::int AS tc, SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad,
           COALESCE(MAX(sa.incidents), 0)::int AS incidents
    FROM monitored_devices d
    LEFT JOIN ping_results p ON p.device_id = d.id AND p.ts BETWEEN $1::timestamptz AND $2::timestamptz
    LEFT JOIN site_alerts sa ON sa.site_name = COALESCE(d.site_name, 'Unassigned')
    WHERE d.active = TRUE${scWinAnd}
    GROUP BY COALESCE(d.site_name, 'Unassigned') ORDER BY 1`, pWin, []);

  // Incidents are global (no site column) and the table is created by a later
  // intelligence migration — gate on capability detection (like alerts) and
  // wrap in try/catch so an un-migrated DB degrades to zero rather than 500ing.
  let totalIncidents = 0, biggest = null;
  if (caps.incidents) {
    try {
      const ic = await sv.query(`SELECT COUNT(*)::int AS c FROM incidents WHERE started_at BETWEEN $1::timestamptz AND $2::timestamptz`, [win.start, win.end]);
      totalIncidents = ic.rows[0] ? ic.rows[0].c : 0;
      const bg = await sv.query(`
        SELECT title, duration_seconds, affected_count FROM incidents
        WHERE started_at BETWEEN $1::timestamptz AND $2::timestamptz
        ORDER BY COALESCE(duration_seconds, 0) DESC, affected_count DESC LIMIT 1`, [win.start, win.end]);
      if (bg.rows[0]) biggest = {
        title: bg.rows[0].title,
        duration_minutes: bg.rows[0].duration_seconds != null ? Math.round(bg.rows[0].duration_seconds / 60) : null,
        affected: bg.rows[0].affected_count,
      };
    } catch (e) { console.error('[reports/executive] incidents query failed:', e.message); }
  }

  const curUptime = pct2(ov.rows[0].bad, ov.rows[0].tc);
  const prevUptime = pct2(prev.rows[0].bad, prev.rows[0].tc);
  const downtimeMinutes = Math.round(Number(dt.rows[0].dt) * 10) / 10;
  const period = req.query.range || '30d';
  const periodLabel = { '24h': 'the last 24 hours', '7d': 'this week', '30d': 'this month', '90d': 'this quarter' }[period] || 'this period';

  const sites_summary = siteRows.rows.map((s) => ({
    site: s.site_name, uptime_pct: pct2(s.bad, s.tc),
    health_grade: gradeFromUptime(pct2(s.bad, s.tc)), incidents: s.incidents,
  }));

  const alertDelta = (alertCounts.rows[0].cur || 0) - (alertCounts.rows[0].prev || 0);

  // Previous-period incident count + data-driven inputs for recommendations.
  let prevIncidents = 0;
  if (caps.incidents) {
    try {
      const pic = await sv.query(`SELECT COUNT(*)::int AS c FROM incidents WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz`, [prevStart, win.start]);
      prevIncidents = pic.rows[0] ? pic.rows[0].c : 0;
    } catch (e) { console.error('[reports/executive] prev incidents failed:', e.message); }
  }
  const cpuRow = await sv.query(`
    SELECT d.name AS device_name, ROUND(AVG(s.value)::numeric, 0) AS cpu
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE s.metric_name ILIKE '%cpu%' AND s.ts BETWEEN $1::timestamptz AND $2::timestamptz${scWinAnd}
    GROUP BY d.name HAVING AVG(s.value) >= 75 ORDER BY cpu DESC LIMIT 1`, pWin).catch(() => ({ rows: [] }));
  let degradingCount = 0;
  if (caps.health) {
    try {
      const dg = await sv.query(`
        SELECT COUNT(*)::int AS c FROM device_health_scores h
        JOIN monitored_devices d ON d.id = h.device_id
        WHERE h.trend = 'degrading' AND d.active = TRUE${scSiteAnd}`, pSite);
      degradingCount = dg.rows[0] ? dg.rows[0].c : 0;
    } catch (e) { console.error('[reports/executive] degrading health failed:', e.message); }
  }

  // Up to 3 auto-generated recommendations, in priority order.
  const recommendations = [];
  if (cpuRow.rows[0]) {
    recommendations.push(`Consider upgrading ${cpuRow.rows[0].device_name} — its CPU is averaging ${cpuRow.rows[0].cpu}%, approaching capacity.`);
  }
  const worstSite = [...sites_summary].filter((s) => s.uptime_pct != null).sort((a, b) => a.uptime_pct - b.uptime_pct)[0];
  if (worstSite && worstSite.uptime_pct < 99.5) {
    recommendations.push(`${worstSite.site} availability (${worstSite.uptime_pct}%) is below SLA — investigate recurring outages.`);
  }
  if (degradingCount > 0) {
    recommendations.push(`${degradingCount} device${degradingCount > 1 ? 's are' : ' is'} showing degrading health trends — proactive maintenance recommended.`);
  }
  if (alertDelta > 0) {
    recommendations.push(`Alert volume rose by ${alertDelta} versus the previous period — review recurring offenders for remediation.`);
  }
  if (biggest && biggest.duration_minutes && biggest.duration_minutes > 30) {
    recommendations.push(`The longest incident ("${biggest.title}") lasted ${biggest.duration_minutes} minutes — consider redundancy for the affected path.`);
  }
  if (!recommendations.length) {
    recommendations.push('Network is healthy — no critical actions required this period. Maintain current monitoring coverage.');
  }

  res.json({
    period, generated_at: new Date().toISOString(),
    headline: `Network was ${curUptime != null ? curUptime : '—'}% available ${periodLabel}`,
    overall_uptime_pct: curUptime,
    total_incidents: totalIncidents,
    total_downtime_minutes: downtimeMinutes,
    sites_summary,
    biggest_incident: biggest,
    improvement_vs_prev: {
      uptime_delta: curUptime != null && prevUptime != null ? Math.round((curUptime - prevUptime) * 100) / 100 : null,
      alert_delta: alertDelta,
    },
    vs_previous: {
      uptime: {
        current: curUptime, previous: prevUptime,
        delta: curUptime != null && prevUptime != null ? Math.round((curUptime - prevUptime) * 100) / 100 : null,
      },
      alerts: { current: alertCounts.rows[0].cur || 0, previous: alertCounts.rows[0].prev || 0, delta: alertDelta },
      incidents: { current: totalIncidents, previous: prevIncidents, delta: totalIncidents - prevIncidents },
    },
    recommendations: recommendations.slice(0, 3),
  });
  } catch (err) {
    console.error('[reports/executive] FULL ERROR:', err);
    console.error('[reports/executive] STACK:', err.stack);
    res.status(500).json({ error: err.message });
  }
}));

// ══════════════════════════════════════════════════════════════
// Wireless reports
// ══════════════════════════════════════════════════════════════
// Optional ?controller_id=N scopes a wireless report to one controller.
function wlCtrl(req) {
  const id = parseInt(req.query.controller_id, 10);
  return isNaN(id) ? { has: false, id: null } : { has: true, id };
}
// SQL expression for an AP's effective utilisation (higher of the two bands).
const WL_UTIL = 'GREATEST(COALESCE(a.radio_2g_util_pct,0), COALESCE(a.radio_5g_util_pct,0))';
// Coerce a JSONB issues/recommendations element to a display string.
function wlText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.message || v.text || v.title || v.recommendation || JSON.stringify(v);
  return String(v);
}
function wlGradeFromUtil(util) {
  if (util == null) return null;
  return gradeFromScore(Math.max(0, 100 - Number(util)));
}
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

// ── Wireless overview ─────────────────────────────────────────
app.get('/api/reports/wireless-overview', wrap(async (req, res) => {
  const c = wlCtrl(req);
  const p = c.has ? [c.id] : [];
  const apW = c.has ? 'WHERE a.controller_id = $1' : '';
  const ctrlW = c.has ? 'WHERE id = $1' : '';

  const sum = await sv.query(`
    SELECT
      (SELECT COUNT(*)::int FROM wireless_controllers ${ctrlW}) AS total_controllers,
      COUNT(*)::int AS total_aps,
      COUNT(*) FILTER (WHERE a.status = 'online')::int  AS online_aps,
      COUNT(*) FILTER (WHERE a.status = 'offline')::int AS offline_aps,
      COALESCE(SUM(a.clients_total), 0)::int AS total_clients,
      ROUND(AVG(${WL_UTIL})::numeric, 1) AS avg_utilization
    FROM wireless_aps a ${apW}`, p);
  const intel = await sv.query(`
    SELECT ROUND(AVG(overall_score)::numeric, 0) AS score
    FROM wireless_intelligence ${c.has ? 'WHERE controller_id = $1' : ''}`, p).catch(() => ({ rows: [] }));

  const bySite = await sv.query(`
    SELECT COALESCE(a.site_name, 'Unassigned') AS site_name,
           COUNT(DISTINCT a.controller_id)::int AS controllers,
           COUNT(*)::int AS aps,
           COUNT(*) FILTER (WHERE a.status = 'online')::int AS online_aps,
           COALESCE(SUM(a.clients_total), 0)::int AS clients,
           ROUND(AVG(${WL_UTIL})::numeric, 1) AS avg_utilization
    FROM wireless_aps a ${apW}
    GROUP BY 1 ORDER BY 1`, p);
  const topAps = await sv.query(`
    SELECT a.name, COALESCE(a.site_name, 'Unassigned') AS site_name,
           COALESCE(a.clients_total, 0)::int AS clients,
           ROUND(${WL_UTIL}::numeric, 1) AS util
    FROM wireless_aps a ${apW}
    ORDER BY a.clients_total DESC NULLS LAST LIMIT 5`, p);
  const topSsids = await sv.query(`
    SELECT ssid_name, COALESCE(clients_total, 0)::int AS client_count
    FROM wireless_ssids ${c.has ? 'WHERE controller_id = $1' : ''}
    ORDER BY clients_total DESC NULLS LAST LIMIT 5`, p);
  const offline = await sv.query(`
    SELECT a.name, COALESCE(a.site_name, 'Unassigned') AS site_name, a.last_seen_at AS last_seen
    FROM wireless_aps a WHERE a.status = 'offline'${c.has ? ' AND a.controller_id = $1' : ''}
    ORDER BY a.last_seen_at ASC NULLS LAST LIMIT 50`, p);
  const highUtil = await sv.query(`
    SELECT a.name, COALESCE(a.site_name, 'Unassigned') AS site_name, ROUND(${WL_UTIL}::numeric, 1) AS util
    FROM wireless_aps a WHERE ${WL_UTIL} > 70${c.has ? ' AND a.controller_id = $1' : ''}
    ORDER BY util DESC LIMIT 50`, p);

  const s = sum.rows[0] || {};
  const score = intel.rows[0] && intel.rows[0].score != null ? Number(intel.rows[0].score) : null;
  res.json({
    period: req.query.range || '30d',
    summary: {
      total_controllers: s.total_controllers || 0,
      total_aps: s.total_aps || 0,
      online_aps: s.online_aps || 0,
      offline_aps: s.offline_aps || 0,
      total_clients: s.total_clients || 0,
      avg_utilization: s.avg_utilization != null ? Number(s.avg_utilization) : null,
      overall_health_score: score,
      overall_grade: gradeFromScore(score),
    },
    by_site: bySite.rows.map((r) => ({
      ...r, health_grade: wlGradeFromUtil(r.avg_utilization),
    })),
    top_aps_by_clients: topAps.rows,
    top_ssids: topSsids.rows,
    offline_aps: offline.rows,
    high_util_aps: highUtil.rows,
  });
}));

// ── Wireless AP health ────────────────────────────────────────
app.get('/api/reports/wireless-ap-health', wrap(async (req, res) => {
  const c = wlCtrl(req);
  const p = c.has ? [c.id] : [];
  const where = c.has ? 'WHERE a.controller_id = $1' : '';
  const baseCols = `
    a.name, c.name AS controller_name, COALESCE(a.site_name, 'Unassigned') AS site_name,
    a.status, COALESCE(a.clients_total, 0)::int AS clients,
    a.radio_2g_channel, a.radio_5g_channel, a.radio_2g_util_pct, a.radio_5g_util_pct,
    a.noise_floor_2g, a.noise_floor_5g, a.uptime_seconds`;
  // Intelligence columns are optional — fall back to a query without them.
  let rows;
  try {
    const r = await sv.query(`
      SELECT ${baseCols},
             ai.health_score, ai.health_grade, ai.load_status,
             ROUND(ai.load_pct::numeric, 1) AS load_pct,
             COALESCE(ai.issues, '[]'::jsonb) AS issues
      FROM wireless_aps a
      LEFT JOIN wireless_controllers c ON c.id = a.controller_id
      LEFT JOIN wireless_ap_intelligence ai ON ai.ap_id = a.id
      ${where}
      ORDER BY ai.health_score ASC NULLS LAST, a.name`, p);
    rows = r.rows;
  } catch (e) {
    console.error('[reports/wireless-ap-health] intelligence join failed:', e.message);
    const r = await sv.query(`
      SELECT ${baseCols}, NULL::numeric AS health_score, NULL::text AS health_grade,
             NULL::text AS load_status, NULL::numeric AS load_pct, '[]'::jsonb AS issues
      FROM wireless_aps a LEFT JOIN wireless_controllers c ON c.id = a.controller_id
      ${where} ORDER BY a.name`, p);
    rows = r.rows;
  }

  const aps = rows.map((r) => {
    const util = Math.max(Number(r.radio_2g_util_pct || 0), Number(r.radio_5g_util_pct || 0));
    return {
      name: r.name, controller_name: r.controller_name, site_name: r.site_name,
      status: r.status, clients: r.clients,
      radio_2g_channel: r.radio_2g_channel, radio_5g_channel: r.radio_5g_channel,
      radio_2g_util_pct: r.radio_2g_util_pct != null ? Number(r.radio_2g_util_pct) : null,
      radio_5g_util_pct: r.radio_5g_util_pct != null ? Number(r.radio_5g_util_pct) : null,
      noise_floor_2g: r.noise_floor_2g, noise_floor_5g: r.noise_floor_5g,
      uptime_seconds: r.uptime_seconds != null ? Number(r.uptime_seconds) : null,
      health_score: r.health_score != null ? Number(r.health_score) : null,
      health_grade: r.health_grade || null,
      _util: util, _load_status: r.load_status,
      issues: Array.isArray(r.issues) ? r.issues.map(wlText).filter(Boolean) : [],
    };
  });
  const scores = aps.map((a) => a.health_score).filter((v) => v != null);
  const summary = {
    total: aps.length,
    online: aps.filter((a) => a.status === 'online').length,
    offline: aps.filter((a) => a.status === 'offline').length,
    avg_health_score: scores.length ? Math.round(mean(scores)) : null,
    overloaded_count: aps.filter((a) => a._load_status === 'overloaded' || a._util > 85).length,
    high_util_count: aps.filter((a) => a._util > 70).length,
  };
  for (const a of aps) { delete a._util; delete a._load_status; }
  res.json({ period: req.query.range || '30d', aps, summary });
}));

// ── Wireless client analysis ──────────────────────────────────
app.get('/api/reports/wireless-clients', wrap(async (req, res) => {
  const c = wlCtrl(req);
  const p = c.has ? [c.id] : [];
  const w = c.has ? 'WHERE controller_id = $1' : '';
  const and = c.has ? 'AND controller_id = $1' : '';

  const sum = await sv.query(`
    SELECT COUNT(*)::int AS total_clients,
           COUNT(*) FILTER (WHERE is_problem)::int AS problem_clients,
           COUNT(*) FILTER (WHERE rssi_dbm < -75)::int AS low_signal_count,
           COUNT(*) FILTER (WHERE roaming_count > 5)::int AS frequent_roamers,
           COUNT(*) FILTER (WHERE band = '2.4GHz')::int AS b2,
           COUNT(*) FILTER (WHERE band = '5GHz')::int  AS b5
    FROM wireless_clients ${w}`, p);
  const problem = await sv.query(`
    SELECT mac_address, hostname, ap_name, ssid_name, band, rssi_dbm, COALESCE(roaming_count, 0)::int AS roaming_count
    FROM wireless_clients WHERE is_problem = TRUE ${and}
    ORDER BY rssi_dbm ASC NULLS LAST LIMIT 100`, p);
  const bySsid = await sv.query(`
    SELECT ssid_name, COUNT(*)::int AS client_count
    FROM wireless_clients WHERE ssid_name IS NOT NULL ${and}
    GROUP BY ssid_name ORDER BY client_count DESC LIMIT 20`, p);
  const byBand = await sv.query(`
    SELECT COALESCE(band, 'Unknown') AS band, COUNT(*)::int AS n
    FROM wireless_clients ${w} GROUP BY 1`, p);
  const roam = await sv.query(`
    SELECT COUNT(*)::int AS n FROM wireless_client_events
    WHERE event_type = 'roam' AND ts >= NOW() - INTERVAL '24 hours' ${and}`, p);
  const busiest = await sv.query(`
    SELECT ap_name AS name, COUNT(*)::int AS clients
    FROM wireless_clients WHERE ap_name IS NOT NULL ${and}
    GROUP BY ap_name ORDER BY clients DESC LIMIT 5`, p);

  const s = sum.rows[0] || {};
  const bandTotal = (s.b2 || 0) + (s.b5 || 0);
  const by_band = {};
  for (const r of byBand.rows) by_band[r.band] = r.n;
  res.json({
    period: req.query.range || '30d',
    summary: {
      total_clients: s.total_clients || 0,
      problem_clients: s.problem_clients || 0,
      low_signal_count: s.low_signal_count || 0,
      frequent_roamers: s.frequent_roamers || 0,
      band_2g_pct: bandTotal ? Math.round((s.b2 / bandTotal) * 1000) / 10 : null,
      band_5g_pct: bandTotal ? Math.round((s.b5 / bandTotal) * 1000) / 10 : null,
    },
    problem_clients: problem.rows.map((r) => {
      const reasons = [];
      if (r.rssi_dbm != null && r.rssi_dbm < -75) reasons.push('Low signal');
      if (r.roaming_count > 5) reasons.push('Frequent roaming');
      return { ...r, reason: reasons.join(', ') || 'Flagged' };
    }),
    by_ssid: bySsid.rows,
    by_band,
    roaming_events_24h: roam.rows[0] ? roam.rows[0].n : 0,
    busiest_aps: busiest.rows,
  });
}));

// ── Wireless RF health ────────────────────────────────────────
app.get('/api/reports/wireless-rf', wrap(async (req, res) => {
  const c = wlCtrl(req);
  const p = c.has ? [c.id] : [];
  const intelW = c.has ? 'WHERE controller_id = $1' : '';
  const apW = c.has ? 'WHERE a.controller_id = $1' : '';

  const agg = await sv.query(`
    SELECT ROUND(AVG(overall_score)::numeric, 0)      AS overall_score,
           COALESCE(SUM(co_channel_pairs), 0)::int     AS co_channel_affected,
           ROUND(AVG(interference_score)::numeric, 1)  AS interference_score,
           ROUND(AVG(band_steering_score)::numeric, 1) AS band_steering_score,
           ROUND(AVG(band_2g_pct)::numeric, 1)         AS band_2g_pct,
           ROUND(AVG(band_5g_pct)::numeric, 1)         AS band_5g_pct,
           ROUND(AVG(load_balance_score)::numeric, 1)  AS load_balance_score,
           COALESCE(SUM(overloaded_aps), 0)::int       AS overloaded_aps
    FROM wireless_intelligence ${intelW}`, p).catch(() => ({ rows: [] }));
  const recRows = await sv.query(`
    SELECT recommendations FROM wireless_intelligence ${intelW}`, p).catch(() => ({ rows: [] }));
  const chans = await sv.query(`
    SELECT a.radio_2g_channel AS ch2, a.radio_5g_channel AS ch5
    FROM wireless_aps a ${apW}`, p);
  const grades = await sv.query(`
    SELECT ai.health_grade AS g, COUNT(*)::int AS n
    FROM wireless_ap_intelligence ai JOIN wireless_aps a ON a.id = ai.ap_id ${apW}
    GROUP BY 1`, p).catch(() => ({ rows: [] }));

  const recommendations = [];
  const seen = new Set();
  for (const row of recRows.rows) {
    const arr = Array.isArray(row.recommendations) ? row.recommendations : [];
    for (const item of arr) {
      const t = wlText(item);
      if (t && !seen.has(t)) { seen.add(t); recommendations.push(t); }
    }
  }
  const dist24 = { '1': 0, '6': 0, '11': 0, other: 0 };
  const dist5 = {};
  for (const r of chans.rows) {
    if (r.ch2 != null) {
      const k = [1, 6, 11].includes(r.ch2) ? String(r.ch2) : 'other';
      dist24[k] = (dist24[k] || 0) + 1;
    }
    if (r.ch5 != null) { const k = String(r.ch5); dist5[k] = (dist5[k] || 0) + 1; }
  }
  const ap_health_distribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of grades.rows) {
    if (r.g && Object.prototype.hasOwnProperty.call(ap_health_distribution, r.g)) ap_health_distribution[r.g] = r.n;
  }
  const a = agg.rows[0] || {};
  const score = a.overall_score != null ? Number(a.overall_score) : null;
  res.json({
    period: req.query.range || '30d',
    overall_score: score, overall_grade: gradeFromScore(score),
    co_channel_affected: a.co_channel_affected || 0,
    interference_score: a.interference_score != null ? Number(a.interference_score) : null,
    band_steering_score: a.band_steering_score != null ? Number(a.band_steering_score) : null,
    band_2g_pct: a.band_2g_pct != null ? Number(a.band_2g_pct) : null,
    band_5g_pct: a.band_5g_pct != null ? Number(a.band_5g_pct) : null,
    load_balance_score: a.load_balance_score != null ? Number(a.load_balance_score) : null,
    overloaded_aps: a.overloaded_aps || 0,
    recommendations: recommendations.slice(0, 10),
    channel_distribution: { '2.4GHz': dist24, '5GHz': dist5 },
    ap_health_distribution,
  });
}));

// ── Wireless capacity ─────────────────────────────────────────
app.get('/api/reports/wireless-capacity', wrap(async (req, res) => {
  const c = wlCtrl(req);
  const p = c.has ? [c.id] : [];
  const apW = c.has ? 'WHERE a.controller_id = $1' : '';

  const lic = await sv.query(`
    SELECT COALESCE(SUM(licensed_aps), 0)::int AS licensed
    FROM wireless_controllers ${c.has ? 'WHERE id = $1' : ''}`, p);
  const used = await sv.query(`
    SELECT COUNT(*)::int AS used, COALESCE(SUM(a.clients_total), 0)::int AS total_clients
    FROM wireless_aps a ${apW}`, p);
  const trendR = await sv.query(`
    WITH per_poll AS (
      SELECT date_trunc('hour', h.ts) AS bucket, SUM(h.clients_total) AS total
      FROM wireless_history h JOIN wireless_aps a ON a.id = h.ap_id
      WHERE h.ts >= NOW() - INTERVAL '30 days'${c.has ? ' AND a.controller_id = $1' : ''}
      GROUP BY 1
    )
    SELECT to_char(date_trunc('day', bucket), 'YYYY-MM-DD') AS day, ROUND(AVG(total))::int AS clients
    FROM per_poll GROUP BY 1 ORDER BY 1`, p).catch(() => ({ rows: [] }));
  const highUtil = await sv.query(`
    SELECT a.name, COALESCE(a.site_name, 'Unassigned') AS site_name, ROUND(${WL_UTIL}::numeric, 1) AS util
    FROM wireless_aps a WHERE ${WL_UTIL} > 70${c.has ? ' AND a.controller_id = $1' : ''}
    ORDER BY util DESC LIMIT 50`, p);

  const licensed = lic.rows[0] ? lic.rows[0].licensed : 0;
  const usedAps = used.rows[0] ? used.rows[0].used : 0;
  const totalClients = used.rows[0] ? used.rows[0].total_clients : 0;
  const trend = trendR.rows;
  const capacity_pct = licensed > 0 ? Math.round((usedAps / licensed) * 1000) / 10 : null;
  let peak = null;
  for (const t of trend) if (!peak || t.clients > peak.count) peak = { date: t.day, count: t.clients };

  // Growth + projection from the daily client trend.
  let growth_rate = 'n/a', days_to_80pct = null, days_to_full = null;
  if (trend.length >= 8) {
    const half = Math.floor(trend.length / 2);
    const firstAvg = mean(trend.slice(0, half).map((t) => t.clients));
    const lastAvg = mean(trend.slice(-half).map((t) => t.clients));
    const gap = Math.max(1, trend.length - half);
    const perDay = (lastAvg - firstAvg) / gap;
    if (firstAvg > 0 && perDay > 0) {
      growth_rate = `${Math.round((perDay * 7 / firstAvg) * 1000) / 10}% per week`;
      const ceiling = licensed > 0 ? licensed * 50 : null; // ~50 clients/AP soft ceiling
      if (ceiling) {
        const d80 = (0.8 * ceiling - lastAvg) / perDay;
        const dFull = (ceiling - lastAvg) / perDay;
        if (d80 > 0 && isFinite(d80)) days_to_80pct = Math.round(d80);
        if (dFull > 0 && isFinite(dFull)) days_to_full = Math.round(dFull);
      }
    } else {
      growth_rate = 'flat/declining';
    }
  }
  res.json({
    period: req.query.range || '90d',
    licensed_aps: licensed || null, used_aps: usedAps,
    capacity_pct,
    client_trend: trend,
    peak_clients: peak,
    avg_clients_per_ap: usedAps > 0 ? Math.round((totalClients / usedAps) * 10) / 10 : null,
    high_util_aps: highUtil.rows,
    growth_rate,
    projected_capacity: { days_to_80pct, days_to_full },
  });
}));

// ══════════════════════════════════════════════════════════════
// Settings
// ══════════════════════════════════════════════════════════════
app.get('/api/settings', wrap(async (_req, res) => {
  const r = await sv.query(`SELECT key, value FROM app_settings`);
  const out = {};
  for (const row of r.rows) out[row.key] = row.value;
  res.json(out);
}));

// Audit log (admin only) — recent successful mutations.
app.get('/api/audit', wrap(async (req, res) => {
  if (userRank(req) < 2) return res.status(403).json({ error: 'Admin only' });
  try {
    const limit = safeInt(req.query.limit, 200, 1000);
    const r = await sv.query(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ${limit}`);
    res.json(r.rows);
  } catch (e) {
    if (/audit_log/.test(e.message)) return res.json([]);
    throw e;
  }
}));

app.put('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const keys = Object.keys(b);
  for (const k of keys) {
    await sv.query(`
      INSERT INTO app_settings (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [k, b[k] === null ? null : String(b[k])]);
  }
  res.json({ ok: true, updated: keys.length });
}));

// ── Notification routing ──────────────────────────────────────
// Route matching alerts to specific email recipients (NULL match = any).
app.get('/api/notification-routes', wrap(async (_req, res) => {
  try {
    const r = await sv.query(`SELECT * FROM notification_routes ORDER BY name`);
    res.json(r.rows);
  } catch (e) {
    if (/notification_routes/.test(e.message)) return res.json([]); // un-migrated DB
    throw e;
  }
}));

app.post('/api/notification-routes', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email_to) return res.status(400).json({ error: 'name and email_to are required' });
  const r = await sv.query(
    `INSERT INTO notification_routes (name, match_severity, match_site_id, match_alert_type, email_to, enabled)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.name, b.match_severity || null,
     b.match_site_id != null && b.match_site_id !== '' ? parseInt(b.match_site_id, 10) : null,
     b.match_alert_type || null, b.email_to, b.enabled !== false]);
  res.status(201).json(r.rows[0]);
}));

app.put('/api/notification-routes/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const r = await sv.query(
    `UPDATE notification_routes SET
       name = COALESCE($2, name),
       match_severity = $3, match_site_id = $4, match_alert_type = $5,
       email_to = COALESCE($6, email_to),
       enabled = COALESCE($7, enabled)
     WHERE id = $1 RETURNING *`,
    [id, b.name || null, b.match_severity || null,
     b.match_site_id != null && b.match_site_id !== '' ? parseInt(b.match_site_id, 10) : null,
     b.match_alert_type || null, b.email_to || null,
     typeof b.enabled === 'boolean' ? b.enabled : null]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Route not found' });
  res.json(r.rows[0]);
}));

app.delete('/api/notification-routes/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM notification_routes WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// ── Service checks (HTTP/TCP/SSL/DNS) ─────────────────────────
// Synthetic checks run either by the central collector (agent_id NULL) or by a
// remote agent. The service_checks/service_check_results tables are a later
// migration — every read degrades to [] on an un-migrated DB.
const SERVICE_TYPES = ['http', 'tcp', 'ssl', 'dns'];

// Derive a per-type { target, params } from one shared base target + flat shared
// params, so a single bulk action can fan out into http/tcp/ssl/dns checks.
function deriveServiceCheck(baseTarget, type, shared) {
  shared = shared || {};
  const hasScheme    = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseTarget);
  const scheme       = hasScheme ? baseTarget.split('://')[0].toLowerCase() : 'http';
  const afterScheme  = hasScheme ? baseTarget.slice(baseTarget.indexOf('://') + 3) : baseTarget;
  const hostport     = afterScheme.split('/')[0];   // strip path
  const host         = hostport.split(':')[0];      // strip :port
  let embeddedPort   = parseInt((hostport.split(':')[1] || ''), 10);
  if (isNaN(embeddedPort)) embeddedPort = null;
  const sharedPort   = (shared.port != null && shared.port !== '') ? parseInt(shared.port, 10) : null;
  const sharedWarn   = (shared.ssl_warn_days != null && shared.ssl_warn_days !== '') ? parseInt(shared.ssl_warn_days, 10) : null;
  const timeoutRaw   = shared.timeout_ms;
  const timeout      = (timeoutRaw != null && timeoutRaw !== '' && Number.isFinite(Number(timeoutRaw))) ? Number(timeoutRaw) : null;

  if (type === 'http') {
    const params = {};
    if (shared.expect_status != null && shared.expect_status !== '') params.expect_status = shared.expect_status;
    if (shared.keyword != null && shared.keyword !== '') params.keyword = shared.keyword;
    if (timeout != null) params.timeout_ms = timeout;
    return { target: hasScheme ? baseTarget : ('http://' + baseTarget), params };
  }
  if (type === 'tcp') {
    const port = embeddedPort != null ? embeddedPort
               : (sharedPort != null && !isNaN(sharedPort)) ? sharedPort
               : (scheme === 'https' ? 443 : 80);
    const params = { port };
    if (timeout != null) params.timeout_ms = timeout;
    return { target: host, params };
  }
  if (type === 'ssl') {
    const port = embeddedPort != null ? embeddedPort
               : (sharedPort != null && !isNaN(sharedPort)) ? sharedPort
               : 443;
    const params = { port, ssl_warn_days: (sharedWarn != null && !isNaN(sharedWarn)) ? sharedWarn : 14 };
    if (timeout != null) params.timeout_ms = timeout;
    return { target: host, params };
  }
  // dns
  const params = {};
  if (timeout != null) params.timeout_ms = timeout;
  return { target: host, params };
}

app.get('/api/service-checks', wrap(async (_req, res) => {
  try {
    const r = await sv.query(`
      SELECT sc.id, sc.name, sc.type, sc.target, sc.site_id, sc.site_name,
             sc.group_id,
             sc.agent_id, ag.name AS agent_name,
             sc.interval_seconds, sc.params,
             sc.current_status, sc.last_response_ms, sc.last_detail, sc.last_checked_at, sc.active,
             (SELECT COUNT(*)::int FROM service_check_results r WHERE r.check_id = sc.id) AS result_count
        FROM service_checks sc
        LEFT JOIN agents ag ON ag.id = sc.agent_id
        ORDER BY sc.name
    `);
    res.json(r.rows);
  } catch (e) {
    if (/service_checks/.test(e.message)) return res.json([]); // un-migrated DB
    throw e;
  }
}));

app.post('/api/service-checks', wrap(async (req, res) => {
  const b = req.body || {};
  const isBulk = Array.isArray(b.types) && b.types.length > 0;

  if (isBulk) {
    // BULK: one target, multiple check types created together (optionally grouped).
    const name   = (b.name || '').trim();
    const target = (b.target || '').trim();
    if (!name)   return res.status(400).json({ error: 'name is required' });
    if (!target) return res.status(400).json({ error: 'target is required' });

    // Dedupe + validate types.
    const types = Array.from(new Set(b.types.map((t) => String(t || '').trim().toLowerCase())));
    if (!types.length || !types.every((t) => SERVICE_TYPES.includes(t))) {
      return res.status(400).json({ error: 'types must be a non-empty array of http, tcp, ssl, dns' });
    }

    const siteId   = b.site_id != null && b.site_id !== '' ? parseInt(b.site_id, 10) : null;
    const agentId  = b.agent_id != null && b.agent_id !== '' ? parseInt(b.agent_id, 10) : null;
    const interval = safeInt(b.interval_seconds, 60);
    const shared   = b.params && typeof b.params === 'object' ? b.params : {};
    const groupId  = types.length > 1 ? require('crypto').randomUUID() : null;

    const client = await sv.connect();
    const created = [];
    try {
      await client.query('BEGIN');
      for (const type of types) {
        const d = deriveServiceCheck(target, type, shared);
        const r = await client.query(
          `INSERT INTO service_checks
             (name, type, target, site_id, site_name, agent_id, interval_seconds, params, group_id, current_status, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown',TRUE) RETURNING *`,
          [name, type, d.target, siteId, b.site_name || null, agentId, interval, JSON.stringify(d.params), groupId]
        );
        created.push(r.rows[0]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }

    // Refresh the owning agent's config once so it picks up all new checks.
    if (agentId) { try { await pushConfigToAgentId(agentId); } catch (e) { console.error('[service-checks] push config failed:', e.message); } }
    return res.status(201).json(created);
  }

  // SINGLE (existing behavior, group_id stays NULL).
  const name = (b.name || '').trim();
  const type = (b.type || '').trim().toLowerCase();
  const target = (b.target || '').trim();
  if (!name)   return res.status(400).json({ error: 'name is required' });
  if (!SERVICE_TYPES.includes(type)) return res.status(400).json({ error: 'type must be one of http, tcp, ssl, dns' });
  if (!target) return res.status(400).json({ error: 'target is required' });

  const siteId   = b.site_id != null && b.site_id !== '' ? parseInt(b.site_id, 10) : null;
  const agentId  = b.agent_id != null && b.agent_id !== '' ? parseInt(b.agent_id, 10) : null;
  const interval = safeInt(b.interval_seconds, 60);
  const params   = b.params && typeof b.params === 'object' ? b.params : {};

  const r = await sv.query(
    `INSERT INTO service_checks
       (name, type, target, site_id, site_name, agent_id, interval_seconds, params, current_status, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unknown',TRUE) RETURNING *`,
    [name, type, target, siteId, b.site_name || null, agentId, interval, JSON.stringify(params)]
  );
  // Refresh the owning agent's config so it picks up the new check immediately.
  if (agentId) { try { await pushConfigToAgentId(agentId); } catch (e) { console.error('[service-checks] push config failed:', e.message); } }
  res.status(201).json(r.rows[0]);
}));

app.put('/api/service-checks/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const type = b.type != null ? String(b.type).trim().toLowerCase() : null;
  if (type && !SERVICE_TYPES.includes(type)) {
    return res.status(400).json({ error: 'type must be one of http, tcp, ssl, dns' });
  }
  const siteId  = b.site_id  != null && b.site_id  !== '' ? parseInt(b.site_id, 10) : null;
  const agentId = b.agent_id != null && b.agent_id !== '' ? parseInt(b.agent_id, 10) : null;
  const params  = b.params && typeof b.params === 'object' ? JSON.stringify(b.params) : null;

  const r = await sv.query(
    `UPDATE service_checks SET
       name = COALESCE($2, name),
       type = COALESCE($3, type),
       target = COALESCE($4, target),
       site_id = $5,
       site_name = COALESCE($6, site_name),
       agent_id = $7,
       interval_seconds = COALESCE($8, interval_seconds),
       params = COALESCE($9::jsonb, params),
       active = COALESCE($10, active)
     WHERE id = $1 RETURNING *`,
    [id, b.name != null ? String(b.name).trim() : null, type,
     b.target != null ? String(b.target).trim() : null,
     siteId, b.site_name || null, agentId,
     b.interval_seconds != null ? safeInt(b.interval_seconds, 60) : null,
     params, typeof b.active === 'boolean' ? b.active : null]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Service check not found' });
  if (agentId) { try { await pushConfigToAgentId(agentId); } catch (e) { console.error('[service-checks] push config failed:', e.message); } }
  res.json(r.rows[0]);
}));

app.delete('/api/service-checks/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = await sv.query(`SELECT agent_id FROM service_checks WHERE id = $1`, [id]);
  const oldAgentId = cur.rows[0] ? cur.rows[0].agent_id : null;
  await sv.query(`DELETE FROM service_checks WHERE id = $1`, [id]);
  if (oldAgentId) { try { await pushConfigToAgentId(oldAgentId); } catch (e) { console.error('[service-checks] push config failed:', e.message); } }
  res.json({ ok: true });
}));

// Delete every check created together as one group (bulk multi-type action).
app.delete('/api/service-checks/group/:groupId', wrap(async (req, res) => {
  const groupId = req.params.groupId;
  const r = await sv.query(`DELETE FROM service_checks WHERE group_id = $1 RETURNING agent_id`, [groupId]);
  const agentIds = Array.from(new Set(r.rows.map((x) => x.agent_id).filter((a) => a != null)));
  for (const aid of agentIds) {
    try { await pushConfigToAgentId(aid); } catch (e) { console.error('[service-checks] push config failed:', e.message); }
  }
  res.json({ ok: true, deleted: r.rowCount });
}));

// Edit a multi-type group as a unit, reconciling which types it monitors.
// Body (bulk shape): { name, target, types:[...], site_id, site_name, agent_id, interval_seconds, params }
app.put('/api/service-checks/group/:groupId', wrap(async (req, res) => {
  const groupId = req.params.groupId;
  const b = req.body || {};

  // Load existing rows in the group.
  const existing = await sv.query(`SELECT * FROM service_checks WHERE group_id = $1`, [groupId]);
  if (!existing.rows.length) return res.status(404).json({ error: 'Service group not found' });

  const name   = (b.name || '').trim();
  const target = (b.target || '').trim();
  if (!name)   return res.status(400).json({ error: 'name is required' });
  if (!target) return res.status(400).json({ error: 'target is required' });

  // Dedupe + validate types (non-empty subset of SERVICE_TYPES).
  const types = Array.isArray(b.types)
    ? Array.from(new Set(b.types.map((t) => String(t || '').trim().toLowerCase())))
    : [];
  if (!types.length || !types.every((t) => SERVICE_TYPES.includes(t))) {
    return res.status(400).json({ error: 'types must be a non-empty array of http, tcp, ssl, dns' });
  }

  const siteId   = b.site_id  != null && b.site_id  !== '' ? parseInt(b.site_id, 10) : null;
  const agentId  = b.agent_id != null && b.agent_id !== '' ? parseInt(b.agent_id, 10) : null;
  const interval = safeInt(b.interval_seconds, 60);
  const shared   = b.params && typeof b.params === 'object' ? b.params : {};
  const typeSet  = new Set(types);

  const client = await sv.connect();
  try {
    await client.query('BEGIN');

    // Track which existing-row ids we keep (one per kept type); the rest are removable.
    const keepIds = new Set();
    const byType = new Map();
    for (const row of existing.rows) {
      if (!byType.has(row.type)) byType.set(row.type, []);
      byType.get(row.type).push(row);
    }

    for (const type of types) {
      const d = deriveServiceCheck(target, type, shared);
      const matches = byType.get(type) || [];
      if (matches.length) {
        // Update the first existing row of this type (keep id, group_id, status, history).
        const found = matches[0];
        keepIds.add(found.id);
        await client.query(
          `UPDATE service_checks SET
             name = $2, target = $3, site_id = $4, site_name = $5, agent_id = $6,
             interval_seconds = $7, params = $8, updated_at = NOW()
           WHERE id = $1`,
          [found.id, name, d.target, siteId, b.site_name || null, agentId, interval, JSON.stringify(d.params)]
        );
      } else {
        // No existing row of this type — insert a new one in the same group.
        await client.query(
          `INSERT INTO service_checks
             (name, type, target, site_id, site_name, agent_id, interval_seconds, params, group_id, current_status, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown',TRUE)`,
          [name, type, d.target, siteId, b.site_name || null, agentId, interval, JSON.stringify(d.params), groupId]
        );
      }
    }

    // Delete every existing row not in the new type set, plus duplicate-type extras.
    const removeIds = existing.rows
      .filter((row) => !typeSet.has(row.type) || !keepIds.has(row.id))
      .map((row) => row.id);
    if (removeIds.length) {
      await client.query(`DELETE FROM service_checks WHERE id = ANY($1::int[])`, [removeIds]);
    }

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  // Refresh both the old agents (moved/removed) and the new agent so all configs update.
  const agentIds = Array.from(new Set(
    existing.rows.map((r) => r.agent_id).concat([agentId]).filter((a) => a != null)
  ));
  for (const aid of agentIds) {
    try { await pushConfigToAgentId(aid); } catch (e) { console.error('[service-checks] push config failed:', e.message); }
  }

  const result = await sv.query(`SELECT * FROM service_checks WHERE group_id = $1 ORDER BY type`, [groupId]);
  res.json(result.rows);
}));

app.get('/api/service-checks/:id/results', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const limit = safeInt(req.query.limit, 100, 1000);
  try {
    const r = await sv.query(
      `SELECT ts, status, response_ms, detail FROM service_check_results
        WHERE check_id = $1 ORDER BY ts DESC LIMIT ${limit}`, [id]);
    res.json(r.rows);
  } catch (e) {
    if (/service_check_results/.test(e.message)) return res.json([]); // un-migrated DB
    throw e;
  }
}));

// ── Escalation steps + on-call shifts ─────────────────────────
app.get('/api/escalation-steps', wrap(async (_req, res) => {
  try {
    const r = await sv.query(`SELECT * FROM escalation_steps ORDER BY step_order, after_minutes`);
    res.json(r.rows);
  } catch (e) { if (/escalation_steps/.test(e.message)) return res.json([]); throw e; }
}));
app.post('/api/escalation-steps', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.use_oncall && !b.email_to) return res.status(400).json({ error: 'email_to or use_oncall required' });
  const r = await sv.query(
    `INSERT INTO escalation_steps (step_order, after_minutes, email_to, use_oncall, enabled)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [safeInt(b.step_order, 1), safeInt(b.after_minutes, 15), b.email_to || null,
     !!b.use_oncall, b.enabled !== false]);
  res.status(201).json(r.rows[0]);
}));
app.delete('/api/escalation-steps/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM escalation_steps WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

app.get('/api/oncall-shifts', wrap(async (_req, res) => {
  try {
    const r = await sv.query(`SELECT * FROM oncall_shifts ORDER BY starts_at DESC`);
    res.json(r.rows);
  } catch (e) { if (/oncall_shifts/.test(e.message)) return res.json([]); throw e; }
}));
app.post('/api/oncall-shifts', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.contact_email || !b.starts_at || !b.ends_at) {
    return res.status(400).json({ error: 'contact_email, starts_at, ends_at required' });
  }
  const r = await sv.query(
    `INSERT INTO oncall_shifts (contact_email, starts_at, ends_at) VALUES ($1,$2,$3) RETURNING *`,
    [b.contact_email, b.starts_at, b.ends_at]);
  res.status(201).json(r.rows[0]);
}));
app.delete('/api/oncall-shifts/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM oncall_shifts WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// Maintenance windows
// ══════════════════════════════════════════════════════════════
app.get('/api/maintenance', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT m.*, d.name AS device_name FROM maintenance_windows m
    LEFT JOIN monitored_devices d ON d.id = m.device_id
    ORDER BY m.starts_at DESC
  `);
  res.json(r.rows);
}));

app.post('/api/maintenance', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.starts_at || !b.ends_at) return res.status(400).json({ error: 'starts_at and ends_at required' });
  const r = await sv.query(`
    INSERT INTO maintenance_windows (device_id, starts_at, ends_at, reason)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [b.device_id || null, b.starts_at, b.ends_at, b.reason || null]);
  res.status(201).json(r.rows[0]);
}));

app.delete('/api/maintenance/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM maintenance_windows WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// Intelligence Layer
// ══════════════════════════════════════════════════════════════
function intelGrade(score) {
  const s = Number(score);
  if (isNaN(s)) return null;
  return s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F';
}
// Dominant trend from per-device counts.
function dominantTrend(degrading, improving) {
  if (degrading > improving) return 'degrading';
  if (improving > degrading) return 'improving';
  return 'stable';
}

// Network-wide intelligence summary for the Overview tab + dashboard card.
app.get('/api/intelligence/overview', wrap(async (req, res) => {
  const siteFilter = getSiteFilter(req);
  const pOverall = [];
  const scOverall = siteFilterClause(siteFilter, pOverall, 'd.site_id');
  const overall = await sv.query(`
    SELECT ROUND(AVG(h.score), 0) AS score, COUNT(*)::int AS device_count,
           COUNT(*) FILTER (WHERE h.trend='degrading')::int AS degrading,
           COUNT(*) FILTER (WHERE h.trend='improving')::int AS improving
    FROM device_health_scores h
    JOIN monitored_devices d ON d.id = h.device_id
    WHERE d.active = TRUE${scOverall ? ` AND ${scOverall}` : ''}
  `, pOverall);
  const o = overall.rows[0] || {};
  const overallScore = o.score != null ? Number(o.score) : null;

  const pSites = [];
  const scSites = siteFilterClause(siteFilter, pSites, 'd.site_id');
  const sites = await sv.query(`
    SELECT d.site_id,
           COALESCE(d.site_name, 'Unassigned') AS site_name,
           COUNT(h.*)::int AS device_count,
           ROUND(AVG(h.score), 0) AS score,
           COUNT(*) FILTER (WHERE h.trend='degrading')::int AS degrading,
           COUNT(*) FILTER (WHERE h.trend='improving')::int AS improving,
           (SELECT COUNT(*)::int FROM device_anomalies an
              JOIN monitored_devices d2 ON d2.id = an.device_id
             WHERE an.status='active' AND d2.site_id IS NOT DISTINCT FROM d.site_id) AS anomaly_count
    FROM monitored_devices d
    JOIN device_health_scores h ON h.device_id = d.id
    WHERE d.active = TRUE${scSites ? ` AND ${scSites}` : ''}
    GROUP BY d.site_id, COALESCE(d.site_name, 'Unassigned')
    ORDER BY AVG(h.score) ASC
  `, pSites);

  const pAtRisk = [];
  const scAtRisk = siteFilterClause(siteFilter, pAtRisk, 'd.site_id');
  const atRisk = await sv.query(`
    SELECT d.id, d.name, d.site_id, d.site_name, d.current_status,
           h.score, h.grade, h.trend
    FROM device_health_scores h
    JOIN monitored_devices d ON d.id = h.device_id
    WHERE d.active = TRUE${scAtRisk ? ` AND ${scAtRisk}` : ''}
    ORDER BY h.score ASC
    LIMIT 5
  `, pAtRisk);

  const pAnom = [];
  const scAnom = siteFilterClause(siteFilter, pAnom, 'd.site_id');
  const recentAnomalies = await sv.query(`
    SELECT an.id, an.device_id, d.name AS device_name, an.metric, an.value,
           an.baseline_mean, an.z_score, an.severity, an.detected_at
    FROM device_anomalies an
    JOIN monitored_devices d ON d.id = an.device_id
    WHERE an.status = 'active'${scAnom ? ` AND ${scAnom}` : ''}
    ORDER BY an.detected_at DESC
    LIMIT 3
  `, pAnom);

  // Incidents are network-wide correlations; scope to those touching a device
  // in the user's sites when site-scoped.
  const pInc = [];
  const scInc = siteFilterClause(siteFilter, pInc, 'd3.site_id');
  const recentIncidents = await sv.query(`
    SELECT id, title, affected_count, severity, status, started_at,
           resolved_at, duration_seconds
    FROM incidents i
    WHERE status = 'active'${scInc ? ` AND EXISTS (
      SELECT 1 FROM alerts a3 JOIN monitored_devices d3 ON d3.id = a3.device_id
       WHERE a3.incident_id = i.id AND ${scInc})` : ''}
    ORDER BY started_at DESC
    LIMIT 3
  `, pInc);

  let c;
  if (siteFilter) {
    const counts = await sv.query(`
      SELECT
        (SELECT COUNT(*)::int FROM device_anomalies an
           JOIN monitored_devices d ON d.id = an.device_id
          WHERE an.status='active' AND d.site_id = ANY($1::int[])) AS active_anomalies,
        (SELECT COUNT(*)::int FROM incidents i
          WHERE i.status='active' AND EXISTS (
            SELECT 1 FROM alerts a3 JOIN monitored_devices d3 ON d3.id = a3.device_id
             WHERE a3.incident_id = i.id AND d3.site_id = ANY($1::int[]))) AS active_incidents,
        (SELECT GREATEST(0, EXTRACT(DAY FROM (NOW() - MIN(ts))))::int FROM ping_results) AS data_coverage_days
    `, [siteFilter]);
    c = counts.rows[0] || {};
  } else {
    const counts = await sv.query(`
      SELECT
        (SELECT COUNT(*)::int FROM device_anomalies WHERE status='active') AS active_anomalies,
        (SELECT COUNT(*)::int FROM incidents WHERE status='active')        AS active_incidents,
        (SELECT GREATEST(0, EXTRACT(DAY FROM (NOW() - MIN(ts))))::int FROM ping_results) AS data_coverage_days
    `);
    c = counts.rows[0] || {};
  }

  res.json({
    overall_score: overallScore,
    overall_grade: intelGrade(overallScore),
    trend: dominantTrend(Number(o.degrading || 0), Number(o.improving || 0)),
    device_count: Number(o.device_count || 0),
    sites: sites.rows.map((s) => ({
      site_id: s.site_id,
      site_name: s.site_name,
      score: s.score != null ? Number(s.score) : null,
      grade: intelGrade(s.score),
      trend: dominantTrend(Number(s.degrading || 0), Number(s.improving || 0)),
      device_count: s.device_count,
      anomaly_count: s.anomaly_count,
    })),
    at_risk_devices: atRisk.rows,
    recent_anomalies: recentAnomalies.rows,
    recent_incidents: recentIncidents.rows,
    active_anomalies: c.active_anomalies || 0,
    active_incidents: c.active_incidents || 0,
    data_coverage_days: c.data_coverage_days || 0,
  });
}));

// Device health scores (all, by device, or by site).
app.get('/api/intelligence/health', wrap(async (req, res) => {
  const params = [];
  let filter = '';
  if (req.query.device_id) {
    params.push(safeInt(req.query.device_id, 0));
    filter = `AND d.id = $${params.length}`;
  } else if (req.query.site_id) {
    params.push(safeInt(req.query.site_id, 0));
    filter = `AND d.site_id = $${params.length}`;
  }
  const hSc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  if (hSc) filter += ` AND ${hSc}`;
  const r = await sv.query(`
    SELECT d.id, d.name, d.site_id, d.site_name, d.current_status,
           h.score, h.grade, h.trend, h.uptime_score, h.response_score,
           h.anomaly_score, h.alert_score, h.computed_at,
           ROUND(h.uptime_score / 40.0 * 100, 1) AS uptime_pct,
           (SELECT COUNT(*)::int FROM device_anomalies an
             WHERE an.device_id = d.id AND an.detected_at >= NOW() - INTERVAL '7 days') AS anomalies_7d,
           (SELECT COUNT(*)::int FROM alerts al
             WHERE al.device_id = d.id AND al.triggered_at >= NOW() - INTERVAL '7 days'
               AND al.alert_type NOT LIKE 'recovery%') AS alerts_7d
    FROM device_health_scores h
    JOIN monitored_devices d ON d.id = h.device_id
    WHERE d.active = TRUE ${filter}
    ORDER BY h.score ASC
  `, params);
  res.json(r.rows);
}));

// Detected anomalies (filter by status / device).
app.get('/api/intelligence/anomalies', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) {
    params.push(String(req.query.status));
    where.push(`an.status = $${params.length}`);
  }
  if (req.query.device_id) {
    params.push(safeInt(req.query.device_id, 0));
    where.push(`an.device_id = $${params.length}`);
  }
  const anSc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  if (anSc) where.push(anSc);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await sv.query(`
    SELECT an.id, an.device_id, d.name AS device_name, d.site_id, d.site_name,
           an.metric, an.value, an.baseline_mean, an.baseline_stddev,
           an.z_score, an.severity, an.detected_at, an.resolved_at, an.status
    FROM device_anomalies an
    JOIN monitored_devices d ON d.id = an.device_id
    ${whereSql}
    ORDER BY an.detected_at DESC
    LIMIT 200
  `, params);
  res.json(r.rows);
}));

// Capacity forecast for one device (computed on demand).
app.get('/api/intelligence/capacity', wrap(async (req, res) => {
  const deviceId = safeInt(req.query.device_id, 0);
  if (!deviceId) return res.status(400).json({ error: 'device_id required' });
  const forecast = await intelligence.computeCapacityForecasts(deviceId);
  res.json(forecast);
}));

// Detected recurring patterns (all or by device).
app.get('/api/intelligence/patterns', wrap(async (req, res) => {
  const params = [];
  const conds = [];
  if (req.query.device_id) {
    params.push(safeInt(req.query.device_id, 0));
    conds.push(`p.device_id = $${params.length}`);
  }
  const pSc = siteFilterClause(getSiteFilter(req), params, 'd.site_id');
  if (pSc) conds.push(pSc);
  const filter = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await sv.query(`
    SELECT p.id, p.device_id, d.name AS device_name, d.site_id, d.site_name,
           p.pattern_type, p.metric, p.description, p.hour_of_day, p.day_of_week,
           p.avg_value, p.baseline_value, p.confidence,
           p.detected_at, p.last_seen_at, p.occurrence_count
    FROM device_patterns p
    JOIN monitored_devices d ON d.id = p.device_id
    ${filter}
    ORDER BY p.confidence DESC, p.last_seen_at DESC
    LIMIT 200
  `, params);
  res.json(r.rows);
}));

// Correlated incidents with root cause + affected device list.
app.get('/api/intelligence/incidents', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) {
    params.push(String(req.query.status));
    where.push(`i.status = $${params.length}`);
  }
  if (req.query.days) {
    params.push(safeInt(req.query.days, 30, 3650));
    where.push(`i.started_at >= NOW() - ($${params.length} || ' days')::interval`);
  }
  const incSc = siteFilterClause(getSiteFilter(req), params, 'd3.site_id');
  if (incSc) {
    where.push(`EXISTS (
      SELECT 1 FROM alerts a3 JOIN monitored_devices d3 ON d3.id = a3.device_id
       WHERE a3.incident_id = i.id AND ${incSc}
    )`);
  }
  params.push(safeInt(req.query.limit, 20, 200));
  const limitIdx = params.length;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await sv.query(`
    SELECT i.id, i.title, i.root_cause_device_id, rc.name AS root_cause_device_name,
           i.affected_count, i.severity, i.status, i.started_at, i.resolved_at,
           i.duration_seconds, i.summary, i.timeline,
           (SELECT ARRAY_AGG(DISTINCT d2.name)
              FROM alerts a2 JOIN monitored_devices d2 ON d2.id = a2.device_id
             WHERE a2.incident_id = i.id) AS affected_devices
    FROM incidents i
    LEFT JOIN monitored_devices rc ON rc.id = i.root_cause_device_id
    ${whereSql}
    ORDER BY i.started_at DESC
    LIMIT $${limitIdx}
  `, params);
  res.json(r.rows);
}));

// Smart threshold recommendations (highest confidence first).
app.get('/api/intelligence/thresholds', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT t.id, t.device_id, d.name AS device_name, d.site_id, d.site_name,
           t.metric, t.current_threshold, t.recommended_threshold,
           t.reasoning, t.confidence, t.computed_at
    FROM threshold_recommendations t
    JOIN monitored_devices d ON d.id = t.device_id
    WHERE d.active = TRUE
    ORDER BY t.confidence DESC, ABS(t.recommended_threshold - t.current_threshold) DESC
  `);
  res.json(r.rows);
}));

// Apply a recommended threshold to a device.
app.post('/api/intelligence/thresholds/:device_id/apply', wrap(async (req, res) => {
  const deviceId = safeInt(req.params.device_id, 0);
  if (!deviceId) return res.status(400).json({ error: 'invalid device_id' });
  const rec = await sv.query(`
    SELECT recommended_threshold FROM threshold_recommendations
    WHERE device_id = $1 AND metric = 'response_ms'
  `, [deviceId]);
  if (!rec.rows[0]) return res.status(404).json({ error: 'no recommendation for this device' });
  const recommended = Math.round(Number(rec.rows[0].recommended_threshold));
  const upd = await sv.query(`
    UPDATE monitored_devices SET ping_threshold_ms = $1, updated_at = NOW()
    WHERE id = $2
    RETURNING id, name, ping_threshold_ms
  `, [recommended, deviceId]);
  if (!upd.rows[0]) return res.status(404).json({ error: 'device not found' });
  // The recommendation is now applied — clear it so the advisor reflects reality.
  await sv.query(`DELETE FROM threshold_recommendations WHERE device_id = $1 AND metric = 'response_ms'`, [deviceId]);
  res.json({ ok: true, device: upd.rows[0], applied_threshold: recommended });
}));

// Consolidated intelligence summary for a single device (device detail card).
app.get('/api/intelligence/device/:id', wrap(async (req, res) => {
  const deviceId = safeInt(req.params.id, 0);
  if (!deviceId) return res.status(400).json({ error: 'invalid device id' });

  const health = await sv.query(`
    SELECT h.score, h.grade, h.trend, h.uptime_score, h.response_score,
           h.anomaly_score, h.alert_score, h.computed_at,
           ROUND(h.uptime_score / 40.0 * 100, 1) AS uptime_pct
    FROM device_health_scores h WHERE h.device_id = $1
  `, [deviceId]);

  const baseline = await sv.query(`
    SELECT mean, stddev, p50, p95, p99, min_val, max_val, sample_count, computed_at
    FROM device_baselines WHERE device_id = $1 AND metric = 'response_ms'
  `, [deviceId]);

  const anomalies = await sv.query(`
    SELECT id, metric, value, baseline_mean, baseline_stddev, z_score, severity, detected_at
    FROM device_anomalies WHERE device_id = $1 AND status = 'active'
    ORDER BY detected_at DESC
  `, [deviceId]);

  const patterns = await sv.query(`
    SELECT id, pattern_type, metric, description, hour_of_day, day_of_week,
           confidence, occurrence_count, last_seen_at
    FROM device_patterns WHERE device_id = $1
    ORDER BY confidence DESC LIMIT 10
  `, [deviceId]);

  const threshold = await sv.query(`
    SELECT metric, current_threshold, recommended_threshold, reasoning, confidence
    FROM threshold_recommendations WHERE device_id = $1 AND metric = 'response_ms'
  `, [deviceId]);

  res.json({
    health: health.rows[0] || null,
    baseline: baseline.rows[0] || null,
    anomalies: anomalies.rows,
    patterns: patterns.rows,
    threshold: threshold.rows[0] || null,
  });
}));

// Manually trigger a full recompute (testing / refresh).
app.post('/api/intelligence/baselines/recompute', wrap(async (_req, res) => {
  intelligence.runAll().catch((e) => console.error('[Intelligence] manual recompute:', e.message));
  res.json({ started: true });
}));

// ── Error handler (generic message in production) ─────────────
app.use((err, _req, res, _next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ error: PROD ? 'Internal server error' : err.message });
});

// ── License: check on startup, refresh every 24h ──────────────
getLicense(true).then((lic) => {
  const state = getLicenseState(lic);
  console.log(`[License] Status: ${lic?.status || 'unreachable'}, mode: ${state.mode}`);
});
setInterval(() => getLicense(true), 24 * 60 * 60 * 1000);

// ── Update check: on startup + every 24h (cached for the notifier banner) ─────
checkForUpdates();
setInterval(checkForUpdates, 24 * 60 * 60 * 1000);

// Central error handler — log the route + stack and return clean JSON so a 500 is
// diagnosable in the UI / network tab instead of an opaque default HTML page.
// (Must be registered AFTER all routes.)
app.use((err, req, res, _next) => {
  console.error(`[500] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: (err && err.message) || 'Internal server error', path: req.path });
});

// Apply scripts/schema.sql through the existing pg pool on startup. The schema is
// fully idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so this
// is safe to run every boot and keeps the DB in sync with the deployed code
// without depending on psql or the installer's (best-effort) schema step.
async function applySchema() {
  try {
    const sqlPath = path.join(__dirname, '..', 'scripts', 'schema.sql');
    const sql = require('fs').readFileSync(sqlPath, 'utf8');
    // Serialize across processes (e.g. collector) so concurrent identical DDL
    // can't race; advisory lock auto-releases when the session ends.
    const client = await sv.connect();
    try {
      await client.query('SELECT pg_advisory_lock(8723451)');
      await client.query(sql);
      console.log('[schema] scripts/schema.sql applied (idempotent)');
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(8723451)'); } catch (_e) { /* ignore */ }
      client.release();
    }
  } catch (err) {
    console.error('[schema] auto-apply failed (continuing — apply scripts/schema.sql manually):', err.message);
  }
}

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`SpanVault API listening on 127.0.0.1:${PORT}`);
  // Ensure the DB schema matches this build before anything else starts.
  await applySchema();
  // Reset cached column-capability probes so they re-evaluate post-migration.
  alertCaps = null;
  _wcStickyCol = null;
  if (agentColExists._cache) agentColExists._cache = {};
  // Start the agent WebSocket server (bound to all interfaces so remote agents
  // can reach it; the API itself stays loopback-only).
  const wsPort = parseInt(process.env.SV_WS_PORT || '3010', 10);
  try {
    startWsServer(wsPort);
  } catch (err) {
    console.error('[WS] Failed to start WebSocket server:', err.message);
  }
  // Start the intelligence engine (baselines, anomalies, health, patterns,
  // thresholds, incidents) — runs on timers inside this process.
  try {
    intelligence.startIntelligenceEngine();
  } catch (err) {
    console.error('[Intelligence] Failed to start engine:', err.message);
  }
  // Start the scheduled-reports engine (daily/weekly/monthly email delivery).
  try {
    reportScheduler.startReportScheduler(sv, getSmtpSettings);
  } catch (err) {
    console.error('[Reports] Failed to start scheduler:', err.message);
  }
});

// SMTP config for scheduled reports, read from app_settings (the same keys the
// collector uses for alert emails). Returns null-ish when unconfigured.
async function getSmtpSettings() {
  const r = await sv.query(
    `SELECT key, value FROM app_settings WHERE key IN
       ('smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from')`
  );
  const m = {};
  for (const row of r.rows) m[row.key] = row.value;
  return {
    host: m.smtp_host || '',
    port: m.smtp_port ? parseInt(m.smtp_port, 10) : 587,
    user: m.smtp_user || '',
    pass: m.smtp_pass || '',
    from: m.smtp_from || '',
  };
}

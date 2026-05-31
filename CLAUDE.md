Update CLAUDE.md — append to the Active enhancements section:

### Site detail page — /sites/[id]
New page: frontend/src/app/(app)/sites/[id]/page.tsx
- Fetches site info from GET /api/netvault/sites (name, city, code)
- Fetches devices filtered by site_id from GET /api/devices?site_id=X
- Fetches active alerts for those devices
- Shows: site name + city as heading, status summary bar (up/down/warning counts),
  device list with same row style as devices page, active alerts list scoped to site
- Each device row links to /devices/[id]
- Back button → /devices

### Devices page drill-down
On the devices page site accordion headers, make the site name a clickable link 
to /sites/[id] — not just a collapse toggle. Click the arrow to collapse, 
click the site name to drill into the site detail page.

### Global alert banner
A persistent banner component rendered in the root layout (above the sidebar/content),
visible on all pages. Polls GET /api/dashboard/summary every 30s. When down > 0 or 
warning > 0 shows: "X down · X warning" in red/yellow with a link to /alerts?status=active.
Hidden when all devices are up. Component defined in components/AlertBanner.tsx.

### Dashboard enhancements
- Auto-refresh every 30s with a visible "Updated X seconds ago" counter
- Recent alerts feed: last 5 alerts from GET /api/alerts?limit=5 shown below stat cards
- Site status breakdown: one row per site showing up/down counts, 
  fetch from GET /api/map which already groups by site

### On-demand ping on device detail
A "Ping Now" button on /devices/[id] that calls POST /api/devices/[id]/ping-now,
shows spinner, then displays result inline (response ms or timeout).
Add the API endpoint POST /api/devices/:id/ping-now to api/server.js — 
it runs a single ping to the device IP and returns { ms, status }.

### Animated status dots
All status indicators (up/down/warning/unknown) use a colored dot.
Down = red pulsing CSS animation (@keyframes pulse), Warning = yellow pulse, 
Up = solid green, Unknown = solid grey.
Define as a reusable StatusDot component in components/StatusDot.tsx.

### Ctrl+K global search
Keyboard shortcut opens a modal overlay. Searches devices by name or IP via 
GET /api/devices?q=X. Results show device name, IP, site, status dot. 
Click result navigates to /devices/[id]. Esc closes. 
Component in components/GlobalSearch.tsx, rendered in root layout.
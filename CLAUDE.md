# SpanVault — NocVault Suite

## What this is
SpanVault is a Network Monitoring System (NMS) in the NocVault suite. It runs alongside
NetVault (port 3000), LogVault (port 3004), and DDIVault (port 3006) on the same Windows Server.
SpanVault runs on port 3008 (frontend) and port 3009 (API).

## Installer parity (IMPORTANT — read before any deploy-affecting change)

This app is provisioned two ways that BOTH must stay in sync: the per-app updater
`installer/Update-SpanVault.ps1` (upgrades) and the shared **suite installer**
`../netvault/installer/Install-NocVault-Suite.ps1` (fresh install of the whole NocVault
suite — it lives in the **netvault** repo, a sibling of this one). Any change — even a
small one — that affects how the app is provisioned MUST be reflected in BOTH, in the
same change, or fresh installs silently break. This includes: a new/renamed env var the
app reads, a new scheduled task, a new or changed schema file (or required DB
extension/grant), a new NSSM service or changed entrypoint/port, a new firewall port, a
new cross-DB grant, or a new build step. Update and commit the suite installer in the
netvault repo too; if you can't, flag it explicitly so it isn't missed.

**Post-install test script (keep in sync too):** the suite ships a fresh-install smoke
tester at `../netvault/installer/Test-NocVault-Suite.ps1` (it lives in the netvault repo and
verifies services, ports, health/versions, schema, the collectors end-to-end, the tamper
model and cross-DB grants). If you build a feature that a fresh install should be verified
for — a new NSSM service or port, a new DB table/column/seed/extension/grant, a new collector
data path, a new scheduled task, or a new health/endpoint contract — update BOTH the suite
installer AND this test script (both in the netvault repo) in the same change, so fresh
installs stay verifiable.

## Known Security Debt (scheduled, not yet done)

Tracked npm-audit findings deliberately deferred (triaged 2026-06-26). NOT fixable with a
safe `npm audit fix` — each needs a breaking change, so schedule as deliberate, tested
work. **NEVER run `npm audit fix --force`.**

- **nodemailer → v9 (root).** The current v6 line carries a high advisory
  (GHSA-p6gq-j5cr-w38f: the message-level `raw` option bypasses
  `disableFileAccess`/`disableUrlAccess` → file-read/SSRF) plus an addressparser ReDoS.
  The only fix is the breaking major **9.0.1**. Not currently reachable — SMTP config is
  admin-only and `api/reportScheduler.js` never uses the `raw` option — so low risk on the
  internal LAN. Upgrade to nodemailer 9.x in a maintenance window and re-test the scheduled
  report email path.
- **Next.js 14 → 15 (frontend).** The frontend is on the latest 14.2.x patch (14.2.35),
  but the remaining `next` advisories (RSC/image-optimizer DoS, rewrites request-smuggling,
  CSP-nonce XSS, middleware cache-poisoning) are only patched in the 15.x/16.x line — there
  is no 14.x backport. Exposure is reduced (firewalled, SSO-gated, authenticated internal
  users only). Plan a tested **Next.js 14→15 migration for DDIVault and SpanVault together**
  (App Router / runtime breaking changes) rather than a forced bump.

## Repo layout
api/server.js          ← Express API (port 3009, 127.0.0.1 only)
collector/collector.js ← Background polling service (ICMP + SNMP)
frontend/              ← Next.js 14 app (App Router, port 3008)
src/app/             ← Pages (App Router)
src/components/      ← Shared components
src/lib/             ← auth.ts, db.ts
src/middleware.ts    ← withAuth SSO guard
scripts/schema.sql     ← spanvault DB schema
installer/             ← Update-SpanVault.ps1
.env.local             ← gitignored; .env.local.example is the committed template

## Tech stack (exact versions — do not upgrade)
- Next.js 14.2.5 + React 18.3 + next-auth 4.24.7
- Express 4 (plain JavaScript, NO TypeScript in api/ or collector/)
- PostgreSQL 16 via pg 8.12

## CRITICAL RULES — always follow these

### No hardcoded IPs or hostnames
Never write `192.168.x.x` or any server IP in any file.
All URLs come from environment variables:
- `process.env.NOCVAULT_HUB_URL` (server-side)
- `process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL` (client-side)
Safe fallback: `|| 'http://localhost:3000'` only. Never a real IP.

### SSO — no local login page
SpanVault has NO login page. Auth is provided by the NocVault hub.
- Unauthenticated requests → redirect to `HUB_URL/login?callbackUrl=...`
- Hub redirects back to `/sso?token=xxx` after login
- `/sso` page verifies token with hub at `HUB_URL/api/auth/sso-verify`
- Then calls `signIn('credentials', { ssoToken: token })` from next-auth
- middleware.ts uses `withAuth` from 'next-auth/middleware' — not a custom guard

### No sub-components inside React components
NEVER define a component (function that returns JSX) inside another component.
Always define them at the top level of the file or in a separate file.
This causes input focus loss on every keystroke (remounts on each render).

### API/ and collector/ are plain JavaScript
No TypeScript syntax (no `as string`, no `: string[]`, no type annotations) in
api/server.js or collector/collector.js. Frontend (frontend/src/) uses TypeScript.

### frontend/ is NOT standalone build
next.config.js does NOT have `output: 'standalone'`. The NSSM service runs
`next start -p 3008` directly. Static file copying is NOT needed.

### Environment variables
- .env.local is gitignored. Never commit real credentials.
- .env.local.example is committed with SERVER_IP placeholders.
- NEXT_PUBLIC_* vars bake in at build time — they must be in .env.local on the
  server before `npm run build` runs (the update script handles this).

### After any change
Run `npm run build` inside frontend/ to verify before committing.
Commit message format: `feat: <short description>` or `fix: <short description>`
Always: `git add -A && git commit -m "..." && git push`

## Database connections

### spanvault DB (read/write)
```js
const sv = new Pool({
  host: process.env.SV_DB_HOST || 'localhost',
  port: parseInt(process.env.SV_DB_PORT || '5432', 10),
  database: process.env.SV_DB_NAME || 'spanvault',
  user: process.env.SV_DB_USER || 'spanvault_user',
  password: process.env.SV_DB_PASS || '',
  ssl: false,
});
```

### netvault DB (read-only — users + devices + sites source)
```js
const nv = new Pool({
  host: process.env.NETVAULT_DB_HOST || 'localhost',
  port: parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user: process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  ssl: false,
});
```

### NetVault schema (read-only reference)
devices: id, name, ip_address (INET — use host() to cast to text), device_type_id,
         site_id, device_status ('Active'/'Decommed'/etc)
device_types: id, name
sites: id, name, code, city, site_status
users: id, name, email, password_hash, role ('admin'/'super_admin'/'site_admin'/'viewer')

### SSO verify endpoint (already built in NetVault)
POST `{HUB_URL}/api/auth/sso-verify`  body: { token: string }
Response: { email, role, name, userId }
Shared secret: process.env.NEXTAUTH_SECRET

## auth.ts pattern (frontend/src/lib/auth.ts)
```ts
import NextAuth, { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { verify } from 'jsonwebtoken';

const netvaultPool = new Pool({ /* netvault connection, ssl: false */ });

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: 'jwt' },
  pages: { signIn: `${process.env.NOCVAULT_HUB_URL || 'http://localhost:3000'}/login` },
  providers: [
    CredentialsProvider({
      name: 'SpanVault',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        ssoToken: { label: 'SSO Token', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials) return null;
        if (credentials.ssoToken) {
          // SSO path: verify JWT signed by shared NEXTAUTH_SECRET
          const payload = verify(credentials.ssoToken, process.env.NEXTAUTH_SECRET!) as any;
          return { id: String(payload.userId), email: payload.email,
                   name: payload.name, role: payload.role };
        }
        // Direct credentials (fallback, hub only — SpanVault has no login UI)
        return null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }: any) {
      if (user) { token.role = user.role; token.id = user.id; }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) { session.user.role = token.role; session.user.id = token.id; }
      return session;
    },
  },
};
```

## middleware.ts pattern (frontend/src/middleware.ts)
```ts
import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

const HUB = process.env.NOCVAULT_HUB_URL || 'http://localhost:3000';
const CALLBACK = encodeURIComponent('/sso');

export default withAuth(
  function middleware(_req) { return NextResponse.next(); },
  {
    callbacks: { authorized: ({ token }) => !!token },
    pages: { signIn: `${HUB}/login?callbackUrl=${CALLBACK}` },
  }
);

export const config = {
  matcher: ['/((?!api|sso|_next/static|_next/image|favicon.ico).*)'],
};
```

## API proxy pattern (critical — do not use next.config.js rewrites for this)
SpanVault proxies /api/* to Express (port 3009) using middleware.ts, NOT
next.config.js rewrites. Rewrites intercept /api/auth/* before NextAuth
can handle it, breaking useSession() which internally calls /api/auth/session.

The correct pattern is in middleware.ts:
- Matcher explicitly excludes /api/auth/*
- Non-auth /api/* calls are rewritten to Express via NextResponse.rewrite()
- Page routes get the auth guard via getToken()
- /api/auth/* routes are never touched — NextAuth handles them directly

Never change this to a next.config.js rewrite approach.

## UI design (match NetVault exactly)
- Sidebar: #1a2744 (dark navy), white text/icons, 220px wide
- Accent: #C8102E (crimson red) for primary buttons, active nav, stat card highlights
- Content area: white (#ffffff) background
- Top bar: white, with home button (links to HUB_URL/launcher), user avatar + dropdown
- Home button icon: house SVG, links to process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL + '/launcher'
- Sign out: calls signOut() then redirects to HUB_URL/launcher
- Nav items: Dashboard, Devices, Alerts, Reports, Network Map, Settings
- Stat cards: colored border-left (green=up, red=down, yellow=warning, grey=unknown)
- Sidebar nav uses the suite-standard colored icon chips (`.sv-nav-chip`, 28×28 radius 8)
  with a per-route tint via `--chip-color`/`--chip-bg` inline props; only the active
  item is colored, inactive chips are neutral. Logo renders at 44px and header
  icon-buttons use radius 8 — shared NocVault suite standard.

## Typography & design tokens (suite standard)
Styling is a custom CSS design system in `frontend/src/app/globals.css` (CSS custom
properties in `:root` + `[data-theme="dark"]`) — NOT Tailwind.

- **Body font:** Inter (loaded via Google Fonts in globals.css).
- **Monospace:** `var(--font-mono)` = `'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace`. One mono stack everywhere — never hardcode a mono font-family.

**7-step type scale** (defined once in `:root`; sizes do NOT change per theme):

| Token         | px   | Use |
|---------------|------|-----|
| `--text-xs`   | 11px | table headers, badges, micro-labels |
| `--text-sm`   | 12px | secondary labels, captions |
| `--text-base` | 13px | buttons, inputs, table body |
| `--text-md`   | 14px | body text, card titles (base body size) |
| `--text-lg`   | 16px | section / panel headings |
| `--text-xl`   | 20px | page titles |
| `--text-2xl`  | 28px | stat numbers / display |

**Rule:** NEVER hardcode font sizes or colors that duplicate a token. Always use
`var(--text-*)` for type and the color tokens (`--text-primary/-secondary/-muted`,
`--bg-primary/-card`, `--border`, `--border-light`, `--primary`, `--primary-dark`, etc.).
Hardcoded hex that duplicates a token breaks dark mode (hex doesn't flip themes).
Display/hero sizes >= 34px (e.g. the NOC full-screen stat ~56px, the all-clear icon ~42px,
loader glyphs) may stay literal — they are intentional display sizes, not body type.

This is the **NocVault SUITE-WIDE standard** — the same scale and rule apply to
ddivault, logvault, and netvault. SpanVault is the reference implementation; copy
this pattern exactly into the other apps.

### Adaptive surface & tint tokens (dark-mode safe)
Tinted or neutral surfaces that sit BEHIND text must use these tokens — never a
hardcoded light hex (a light hex doesn't flip in dark mode and produces an
unreadable washed-out box). Defined in both `:root` and `[data-theme="dark"]`:

- `--surface-subtle` — neutral near-white panel/track fill (light `#f8fafc`,
  dark `rgba(255,255,255,0.04)`).
- `--tint-info` / `--tint-info-fg` — blue info wash + readable foreground.
- `--tint-success` / `--tint-success-fg` — green.
- `--tint-warn` / `--tint-warn-fg` — amber.
- `--tint-danger` / `--tint-danger-fg` — red.
- `--tint-purple` / `--tint-purple-fg` — purple/violet (light `#f5f3ff`/`#6d28d9`,
  dark `rgba(139,92,246,0.15)`/`#c4b5fd`). Suite-standard token (identical in
  netvault, logvault, ddivault). Note: this is for purple SURFACES behind text
  (e.g. `.badge-purple`) — NOT the `--purple` (`#7c3aed`) status/chart/sensor-line
  signal color, which stays raw.

Rule: a tinted callout/badge/banner uses the matching `--tint-*` for its
background (and border) and `--tint-*-fg` for its text; a plain neutral surface
uses `--surface-subtle`.

### Sticky headers / pinned toolbars MUST be opaque (suite-wide standard)
Any element with `position: sticky` that content scrolls UNDERNEATH (sticky table
`<thead>`/header rows, pinned toolbars/filter bars, sticky tab bars) MUST have an
OPAQUE background token — `var(--bg-card)` for card-level tables, `var(--bg-primary)`
for bars on the page surface. NEVER a semi-transparent tint (`var(--surface-subtle)`,
any `rgba(...)` alpha < 1 such as the dark `th` `rgba(255,255,255,0.03)`, or no bg) —
the scrolled rows bleed through and garble the header text (worst in dark mode). Also
give it `z-index: 5+` and a bottom separator (`box-shadow: 0 1px 0 var(--border)` or
`border-bottom: 1px solid var(--border)`). Same fix applied in netvault/logvault/ddivault. Also note `--primary-light` has a dark override
(`rgba(200,16,46,0.18)`) so crimson report banners adapt. These are the same
tokens used in **logvault** and **ddivault** (suite-wide standard).

### Dropdowns & native form controls (dark-mode readability)
- **Native controls** (`<select>` option popups, native scrollbars, date pickers)
  are themed via `color-scheme`: `light` in `:root`, `dark` in `[data-theme="dark"]`.
  Base rules also set `select`/`option` to `var(--bg-card)` + `var(--text-primary)`.
  Without `color-scheme`, a native `<select>` option list renders as a white box
  with near-invisible text in dark mode.
- **Custom dropdown / menu / picker panels** (`.sv-dropdown`, `.sv-tbsearch-menu`,
  `.sv-ctxmenu`, `.sv-dep-pick`, `.sv-site-picker`, GlobalSearch, etc.) use
  `var(--bg-card)` + `border: 1px solid var(--border)` for the panel surface,
  `var(--surface-subtle)` (or a `--tint-*`) for hover/active rows, and
  `var(--text-primary)`/`--text-secondary` for option text — never a hardcoded
  light hex (`#fff`/`#f8fafc`/`#eff6ff`), which doesn't flip in dark mode.
- This is the **suite-wide standard** — apply the same `color-scheme` + tokenised
  panel pattern in netvault, logvault, and ddivault.

## Build status — all phases complete ✅
Phase 1: scaffold, schema (scripts/schema.sql), config — done
Phase 2: api/server.js — Express API (devices, alerts, rules, reports, settings, NetVault sync) — done
Phase 3: collector/collector.js — ICMP ping, SNMP polling, alert evaluation,
          NetVault device sync on startup + every 30 min, writes ping_results/snmp_results/alerts — done
Phase 4: auth/SSO layer — frontend/src/lib/auth.ts, middleware.ts, app/sso/page.tsx,
          api/auth/[...nextauth]/route.ts, providers.tsx, layout.tsx (top bar + sidebar shell) — done
Phase 5: frontend pages — dashboard, devices list, device detail (graphs), alerts,
          reports, network map, settings — done
Phase 6: installer/Update-SpanVault.ps1 — 3 NSSM services (SpanVault-API, SpanVault-App,
          SpanVault-Collector), -ServerIp writes .env.local from template — done

Next step: deploy on the Windows Server and test end-to-end (SSO login via hub,
NetVault device sync, ICMP/SNMP polling, alerts, dashboard graphs).

## Deployment notes (server testing)
- Run installer/Update-SpanVault.ps1 -ServerIp <ip> on the server; it writes .env.local
  from .env.local.example (existing .env.local is preserved — see commit f12b787).
- Both root .env.local and frontend/.env.local must exist before `npm run build` because
  NEXT_PUBLIC_* vars bake in at build time. The installer handles this.
- Three services must be running: SpanVault-API (3009), SpanVault-App (3008), SpanVault-Collector.
- Verify DB access: spanvault (read/write) + netvault (read-only) reachable from the server.
- SSO: ensure NEXTAUTH_SECRET matches the hub's so sso-verify / JWT verification succeeds.

## Completed enhancements
Post-Phase-6 UI/API enhancements (all built, committed, and pushed to main):

0. **PRTG-style Devices page** (`df9fd75`) — devices grouped into collapsible per-site
   accordions with up/down/warning/unknown summary pills; rows show status dot, name,
   IP/type, latency, last-seen, and inline monitoring badges (Ping ms, SNMP CPU%/Mem%,
   greyed-out NetFlow "coming soon"). API `/api/devices` returns latest_cpu_pct/latest_mem_pct
   via LATERAL joins on snmp_results.
1. **Site detail page** `/sites/[id]` (`b839e4c`) — frontend/src/app/(app)/sites/[id]/page.tsx:
   site name/city/code heading, status summary cards, device list (same row style as devices
   page, each links to /devices/[id]), active-alerts list scoped to the site, back button →
   /devices. Devices-page accordion header site name is now a Link to /sites/[id] (arrow/row
   still toggles collapse).
2. **Global alert banner** (`f59065c`) — components/AlertBanner.tsx, rendered in (app)/layout.tsx
   above the shell. Polls /api/dashboard/summary every 30s; shows "X down · X warning" (red/yellow,
   pulsing dot) linking to /alerts?status=active; hidden when all devices up.
3. **Dashboard enhancements** (`4101c54`) — auto-refresh every 30s with a live "Updated X seconds
   ago" counter, recent-alerts feed (last 5 from /api/alerts?limit=5), and a site status breakdown
   table from /api/map (up/down/warning per site, names link to /sites/[id]).
4. **On-demand ping** (`4715fad`) — POST /api/devices/:id/ping-now (single ICMP probe → { ms, status },
   no history written) + "Ping Now" button on /devices/[id] with inline spinner and latency/Timeout badge.
5. **Animated StatusDot** (`df4d62e`) — components/StatusDot.tsx: down/warning pulse (CSS box-shadow
   keyframes), up solid green, unknown solid grey. Replaced device-status dots on the devices list,
   site detail, and network map nodes; added a pulsing dot to the device detail header.
6. **Ctrl+K global search** (`51800b1`) — components/GlobalSearch.tsx, rendered in (app)/layout.tsx.
   Cmd/Ctrl+K opens a command-palette modal (Esc closes); debounced search via /api/devices?q=X;
   results show status dot, name, IP, site; click navigates to /devices/[id].

---

## Versioning Policy

This app follows semantic versioning. Baseline: 1.2.0 (Jun 2026)

Every commit must include a version bump:
- Bug fix, UI tweak, copy change, config fix → PATCH (x.x.+1)
  Run: npm version patch --no-git-tag-version
- New feature, new page, new API, new chart → MINOR (x.+1.0)
  Run: npm version minor --no-git-tag-version
- Breaking change, DB migration, architecture overhaul → MAJOR (+1.0.0)
  Run: npm version major --no-git-tag-version

Examples of what counts as each type:
- Login page overhaul → Minor
- New dashboard with charts → Minor
- Health score tracking → Minor
- Bug fix (hardcoded IP, broken link, wrong email) → Patch
- New EOL intelligence integration → Minor
- Schema breaking change → Major

Rules:
- ALWAYS bump version as part of the same commit as the changes
- NEVER skip the version bump
- Run npm version BEFORE npm run build
- The app reads version from package.json via /api/health
- NocVault suite itself has no version number — only the 4 apps
- When bumping version, also update the releaseNotes object in the update status API with 3-5 bullets describing what changed. No CHANGELOG.md — release notes live in the update status API only.

## Database Access (Read-Only Diagnostics)

A read-only PostgreSQL user exists for Claude Code to query the live production
database directly during development. No psql installation needed — use the
Node.js `pg` module directly.

Connection details:

```
Host:      192.168.6.111
Port:      5432
User:      claude_readonly
Password:  [stored in Claude project memory — ask Amrin]
Databases: logvault, netvault, ddivault, spanvault
```

Usage in Claude Code:

```js
const { Client } = require('pg');
const client = new Client({
  host: '192.168.6.111',
  port: 5432,
  user: 'claude_readonly',
  password: process.env.DB_READONLY_PASS,
  database: 'spanvault',  // change per app
  ssl: false
});
await client.connect();
const { rows } = await client.query('SELECT ...');
await client.end();
```

Permissions: SELECT only — cannot INSERT, UPDATE, DELETE, or modify schema.

Use it to:
- Check actual DB schema before writing queries
- Verify data exists before writing display code
- Diagnose query performance issues
- Confirm migrations worked correctly
- Inspect app_settings, known_hosts, alert_rules, etc.

The password is **never** stored in this repo — it lives in Claude Code's project
memory and is provided at the start of each session. Never log it or commit it to
any repo.

## Live Server Verification (Diagnostics)

The suite runs on the production server **192.168.6.111**. Verify the *running*
deployment directly from the dev host over HTTP — no SSH needed — using `curl`
(Bash tool) or `Invoke-WebRequest` (PowerShell). Pair this with the read-only DB
access above: **curl answers "is it up / what version / what HTTP status", the DB
answers "is the data correct".**

**Health / deployed version** (unauthenticated — safe to hit anytime; use it to
confirm a deploy actually landed):

```bash
curl http://192.168.6.111:3008/api/health        # -> { status, service, version, ... }
```
```powershell
Invoke-WebRequest -Uri "http://192.168.6.111:3008/api/health" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Use each app's **frontend** port (it also serves `/api/*`). The separate backend
API ports (3005/3007/3009) are internal/proxied and not reliably reachable from
outside, so verify via the frontend port:

| App | Health URL |
|---|---|
| netvault  | http://192.168.6.111:3000/api/health |
| logvault  | http://192.168.6.111:3004/api/health |
| ddivault  | http://192.168.6.111:3006/api/health |
| spanvault | http://192.168.6.111:3008/api/health |

**This app: spanvault → frontend port 3008 (backend API 3009 is proxied).**

**Verifying behaviour & data:**
- Most endpoints require an authenticated session + RBAC. An unauthenticated
  `curl` of them returns empty / 401 / a login redirect — that does **not** prove
  the endpoint is broken. To check the DATA an endpoint should return, query the
  read-only DB (above) or use the logged-in browser UI.
- Use `curl` for: `/api/health` (status/service/version), any explicitly public
  endpoint, and HTTP-status sanity (200 vs 500, e.g.
  `curl -s -o /dev/null -w "%{http_code}" http://192.168.6.111:3008/api/health`).
- Deploys are **manual** — Amrin runs the app's updater script; Claude never
  deploys. Always verify **after** the deploy: confirm `/api/health` shows the new
  version, then confirm data via the read-only DB, then eyeball the UI.

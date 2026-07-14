# SpanVault — NocVault Suite

## What this is
SpanVault is a Network Monitoring System (NMS) in the NocVault suite. It runs alongside
NetVault (port 3000), LogVault (port 3004), and DDIVault (port 3006) on the same Windows Server.
SpanVault runs on port 3008 (frontend), port 3009 (API), and port 3010 (WebSocket
server for remote polling agents — `api/ws-server.js`, started from `api/server.js`,
bound to all interfaces so remote agent hosts can reach it; the API itself stays
loopback-only).

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

**Graphical installer/uninstaller/tester (GUI `.exe` wrappers) — IMPORTANT.** The suite ships
Windows GUI wrappers in the netvault repo (`../netvault/installer/`:
`Install-`/`Uninstall-`/`Test-NocVault-Suite-GUI.ps1`, compiled to `NocVault-Suite-Setup.exe` /
`-Uninstall.exe` / `-Test.exe` via `Build-Setup-Exe.ps1` with ps2exe). **These `.exe`s are thin
GUI shells only — all the real logic lives in the `.ps1` scripts they drive**
(`Install-`/`Uninstall-`/`Test-NocVault-Suite.ps1`, launched with `-Unattended`/`-Force`). So for
normal install/uninstall/test changes (a new step, schema, service, grant, env var, port, task)
you just edit the `.ps1` — **no exe rebuild needed**. The ONE exception: if you add or rename a
`param()` on one of those `.ps1` scripts, the matching `*-GUI.ps1` must be updated to pass the
new argument AND the exe rebuilt (`Build-Setup-Exe.ps1`). Always check the parameter surface
when editing an installer script.

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
api/server.js          ← Express API (port 3009, 127.0.0.1 only); also starts ws-server.js
api/ws-server.js       ← WebSocket server for remote polling agents (port 3010, all interfaces)
api/intelligence.js    ← intelligence analytics engine
api/licenseCheck.js    ← license/feature-gate checks
api/pdfCharts.js       ← chart rendering helpers for PDF reports
api/reportScheduler.js ← scheduled report email delivery
api/reportsPdf.js      ← pdfkit report renderers
collector/collector.js ← Background polling service (ICMP + SNMP), NetVault device sync
collector/discovery.js ← LLDP/CDP topology discovery
collector/topology.js  ← topology engine
collector/snmp-session.js         ← shared SNMP session helper
collector/wirelessCollector.js    ← wireless (AP/controller/client) SNMP polling
collector/wirelessIntelligence.js ← wireless RF statistical analytics
collector/parsers/     ← per-vendor SNMP parsers (Cisco, Aruba, HPE, Juniper, Fortinet, etc.)
collector/wireless/    ← per-vendor wireless parsers (Aruba, Cisco, Ruckus, HPE, etc.)
agent/agent.js         ← remote polling agent (poll + ship + offline buffer over WS)
agent/install.ps1      ← agent NSSM service installer
frontend/              ← Next.js 14 app (App Router, port 3008)
  src/app/(app)/       ← Pages: dashboard, devices, sites, alerts, services, reports,
                          maps, wireless, topology, agents, intelligence, settings
  src/components/      ← Shared components (Sidebar.tsx, TopBar.tsx, etc.)
  src/lib/             ← auth.ts, api.ts, rbac.ts, theme.ts, publicUrl.ts, mapExport.ts,
                          mapIcons.tsx, mapTypes.ts — no db.ts; the frontend never talks
                          to Postgres directly, only through the Express API
  src/middleware.ts    ← plain custom middleware (proxy + SSO redirect + per-user
                          app-access gating — see the middleware.ts section below;
                          NOT a withAuth guard)
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

**Cross-app URLs (hub URL, own public URL) are resolved per-request, not from a
static env var** (`frontend/src/lib/publicUrl.ts` `resolveOrigin(req, port,
legacyFallback)`, and the equivalent plain-JS copy in `api/server.js` next to
`/api/hub/settings`). It derives the origin from the CURRENT request's
`x-forwarded-host`/`host` + `x-forwarded-proto` (validated against a hostname-
shape regex), so links keep working when the suite is reached via a hostname
different from the install-time server IP (a customer's own local-DNS name,
for instance) — added 2026-07 after exactly this class of bug broke cross-app
navigation on a customer box. Client-side call sites mirror this with
`window.location`-derived helpers instead of reading `NEXT_PUBLIC_*` directly.
The env vars (`NOCVAULT_HUB_URL` / `NEXT_PUBLIC_NOCVAULT_HUB_URL`) are now only
the LAST-RESORT fallback (used when a request carries no usable Host at all) —
don't reintroduce a raw `process.env.NOCVAULT_HUB_URL` read as the primary
source in new code; use/extend `resolveOrigin` instead.

### SSO — no local login page
SpanVault has NO login page. Auth is provided by the NocVault hub.
- Unauthenticated requests → redirect to `HUB_URL/login?callbackUrl=...`
- Hub redirects back to `/sso?token=xxx` after login
- `/sso` page (`frontend/src/app/sso/page.tsx`) posts the token to this app's
  OWN `/api/sso` (Express route in `api/server.js`, NOT a Next.js route — see
  the API proxy gotcha below) — that route verifies it against the hub's
  `HUB_URL/api/auth/sso-verify` **server-to-server** (a direct browser fetch to
  the hub would be cross-origin and CORS-blocked; this bit us in 1.71.3, fixed
  in 1.71.4)
- Then calls `signIn('credentials', { ssoToken: token, ... })` from next-auth
- `middleware.ts` is a plain custom `async function middleware(req)` (NOT
  `withAuth` from `next-auth/middleware` — that was the original scaffold and
  is no longer accurate; see the real file for the current shape, which also
  does per-user app-access gating and the API proxying described below)

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

### Remote agents, the WebSocket server, and SV_PUBLIC_URL
SpanVault supports distributed polling via remote agents (`agent/agent.js`,
installed with `agent/install.ps1` as an NSSM service on the remote host). Agents
connect back over WebSocket to `api/ws-server.js`, started from `api/server.js` on
`SV_WS_PORT` (default 3010, all interfaces — see the port list in "What this is").

`SV_PUBLIC_URL` (`.env.local.example`) is the base URL agents use to download the
installer/config and dial back to this app. `api/server.js`'s `getServerUrl(req)`
resolves it with **`SV_PUBLIC_URL` checked FIRST**, falling back to deriving the
origin from the incoming request (`x-forwarded-host`/`host` +
`x-forwarded-proto`) only if it's unset:

```js
function getServerUrl(req) {
  if (process.env.SV_PUBLIC_URL) return process.env.SV_PUBLIC_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}
```

**This priority order is the deliberate OPPOSITE of `resolveOrigin`** (the
request-derived-first pattern documented under "No hardcoded IPs or hostnames"
above) — and that's intentional, not a bug to "fix" into consistency. A browser
link can safely follow whatever hostname the user's current request came in on;
an already-installed remote agent cannot. The agent dials back on its own
schedule with no incoming "request" to derive a host from, and it must keep
hitting the same address it was configured with at install time even if an
admin later also starts browsing the suite via a different hostname — a value
that shifted with request traffic would silently break every agent's
connectivity. Don't change `getServerUrl` to prefer the request-derived origin
to match `resolveOrigin`'s pattern; the two functions solve different problems
on purpose.

Related env vars (`.env.local.example`): `SV_WS_PORT` (WS server port, default
3010), `SV_WS_TLS_CERT`/`SV_WS_TLS_KEY` (optional, terminate `wss://` on the
agent WebSocket — leave blank for plain `ws://` on a trusted LAN/behind a
proxy), `SV_NSSM_PATH` (nssm.exe path the server hands to the agent installer,
defaults to NetVault's bundled copy).

### `testController`'s "dry run" is NOT write-free for API controllers with rotating credentials
`collector/wirelessCollector.js`'s `testController(pool, controller)` (the
"Test Connection" button's handler) is commented as a dry-run — no DB writes —
which is true for SNMP controllers, but **deliberately false for API
controllers whose vendor client can rotate a stored credential**, currently
just `aruba_central`. Aruba Central's refresh_token rotates on every use: the
instant a refresh request lands, Central issues a new access_token AND a new
refresh_token and invalidates the one that was sent. If `testController` used
that new token without persisting it (to stay "pure"), the only refresh_token
left in the DB would be the old, now-invalidated one — permanently bricking
the integration, recoverable only by a human re-authorizing it from scratch in
the Central UI. That's why `testController` still takes `pool` and forwards it
into `pollApiController(controller, pool)` exactly like a real poll, even
though its own comment calls it a dry run. **Don't "fix" this by dropping the
`pool` argument to make the dry-run description literally true** — that
reads as a harmless cleanup (builds clean, passes every static check) and
bricks the integration on the next "Test Connection" click. This bit us for
real: `pollApiController`'s signature was updated to take `pool` for exactly
this reason, but its second call site — inside `testController` — was missed,
so testing an aruba_central controller failed outright with `"aruba_central:
pool is required for token persistence"` (the client's own defensive guard
against running without persistence, working as intended) until the missed
call site was fixed. If a future API vendor is added with its own rotating
credential, the same rule applies to it too.

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
  max: 10,
  idleTimeoutMillis: 30000,
});
sv.on('error', (err) => console.error('[DB sv] Pool error:', err.message));
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
  max: 5,
  idleTimeoutMillis: 30000,
});
nv.on('error', (err) => console.error('[DB nv] Pool error:', err.message));
```

### NetVault schema (read-only reference)
devices: id, name, ip_address (character varying — plain text, NOT inet;
         confirmed 2026-07 against information_schema.columns after a
         `host(d.ip_address)` cast broke NetVault sync/import in three places
         with "function host(character varying) does not exist" — do NOT
         re-add a host()/inet cast here), device_type_id,
         site_id, device_status ('Active'/'Decommed'/etc)
device_types: id, name
sites: id, name, code, city, site_status
users: id, name, email, password_hash, role ('admin'/'super_admin'/'site_admin'/'viewer')

### SSO verify endpoint (already built in NetVault)
POST `{HUB_URL}/api/auth/sso-verify`  body: { token: string }
Response: { email, role, name, userId }
Shared secret: process.env.NEXTAUTH_SECRET
**Call this server-to-server, never as a direct browser fetch** — see the SSO
bullet above and the API proxy gotcha below for why (CORS).

## auth.ts pattern (frontend/src/lib/auth.ts) — simplified illustration, not current
The real file additionally resolves per-user app-access (`resolveUserApps`,
fail-open cross-DB read of `netvault.user_apps`) and looks up `sites`/`name`
from the netvault `users`/`user_sites` tables when the SSO JWT omits them —
read the actual file for the current shape; treat this snippet as the
original scaffold, not a spec.

### App-access resolution differs from the other satellites — do NOT "fix" it to match them
SpanVault mints its OWN NextAuth token (it does not read NetVault's shared
session cookie), so it cannot inherit an `apps` claim the way a cookie-sharing
satellite could. Instead it resolves the allowed-apps set at `authorize()` time
in `frontend/src/lib/auth.ts` (`resolveUserApps(userId, role)`) via a direct
read of `netvault.user_apps` on its OWN read-only NETVAULT_DB_* pool —
`super_admin` = all apps, no rows = default-all, fail-open on any error
(mirrors NetVault's `getUserApps`) — and persists it to `token.apps` /
`session.user.apps` so `getToken()` in `middleware.ts` sees it. This is
deliberately different from siblings that lift the claim off a shared cookie;
don't rewrite it to match them.
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

## middleware.ts (frontend/src/middleware.ts) — outdated snippet removed
The original scaffold above (a `withAuth`-wrapped page guard with no API
proxying) is **no longer accurate** — don't use it as a reference. The real
file is a plain custom `async function middleware(req: NextRequest)` that does
three things: (1) proxies non-auth `/api/*` calls to Express — see the proxy
gotcha immediately below, (2) redirects unauthenticated page requests to the
hub login (via `resolveOrigin`, not a static `HUB` const), (3) per-user
app-access gating (`appAllowed`, redirects a denied user to the hub launcher
with `?denied=spanvault`). Read the actual file before changing it.

### App-access must gate BOTH the page-route AND the `/api/*` proxy branch of `middleware.ts`
A per-user access gate has to run on every path reachable with the same
session — a gate on only the page-render branch leaves a denied user's
still-valid session able to pull full data straight from the API. `middleware.ts`
now calls `appAllowed((token as any).apps, 'spanvault')` in BOTH branches: the
`/api/*` proxy branch returns a JSON `403 {error:'forbidden',
reason:'app_access_denied'}`, the page branch redirects to
`HUB/launcher?denied=spanvault`. **SpanVault was the one suite app that shipped
a release (1.71.1) whose notes CLAIMED this API-branch check while the commit
never touched `middleware.ts` at all** — the fix didn't actually land until
1.71.7 (`accb4c2`). Lesson: when a release note claims an enforcement fix,
`git show --stat` the commit and re-read the live enforcement file to confirm
the check reached it — don't trust the notes. Every sibling app already had
this on both branches.

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

### ⚠️ Corollary — a Next.js route under `frontend/src/app/api/**` is DEAD CODE here
Because middleware forwards **every** `/api/*` request (except `/api/auth/*`)
straight to Express, adding a Next.js App Router route handler anywhere under
`frontend/src/app/api/` (other than the NextAuth catch-all) will **never
run** — the request gets intercepted and rewritten to Express first, which
then 404s with no matching route. This bit us for real: 1.71.3 added
`frontend/src/app/api/sso/route.ts` to fix a CORS bug (copying DDIVault's
working `/api/sso` proxy-route pattern verbatim), and it type-checked and
built cleanly but never actually worked at runtime — the request always hit
Express's 404 instead. Fixed in 1.71.4 by moving the exact same logic into
`api/server.js` (`POST /api/sso`, right next to the near-identical
`/api/hub/settings` proxy) and adding it to middleware's `PUBLIC_API`
allowlist (it must be reachable with no session — that's the means by which
a session gets created).
**DDIVault's equivalent works differently and is NOT a transferable pattern**:
DDIVault uses `next.config.js` rewrites for a specific allowlist of routes,
and `/api/sso` isn't on that list, so its own `frontend/src/app/api/sso/route.ts`
is a real, reachable Next.js route there. Before porting an "add a proxy route"
fix between suite apps, check which of the four different `/api/*` routing
architectures (LogVault: `proxy.ts` header-injection proxy; DDIVault:
`next.config.js` rewrite allowlist; SpanVault: `middleware.ts` blanket-proxy-
except-auth; NetVault: no proxying, it IS the hub) the target app actually
uses — a working pattern in one app can silently never run in another that
looks similar on the surface, and a clean build will not catch it.

### Checklist: adding a new intentionally-public API route
A route that must work with **no session** (an SSO bootstrap endpoint, an
unauthenticated agent-install script, etc.) has to clear three INDEPENDENT
gates, each in a different file/layer, and each only surfaces once the
previous one is fixed. This is not hypothetical: adding one such route
(`POST /api/sso`, the SSO-verify proxy) took **three separate broken
releases in a row** (1.71.4 → 1.71.5 → 1.71.6) because each fix only exposed
the next blocking gate. Check all three in one pass before shipping a new one:

1. **`frontend/src/middleware.ts`'s `PUBLIC_API` allowlist regex** (in the
   `/api/*` proxy branch). A route not matched here requires a valid
   `getToken()` session before it's even forwarded to Express — so a
   route reachable pre-login must be added to this regex.
2. **`api/server.js`'s write-side RBAC gate — the `WRITE_GATE_EXEMPT` array**,
   checked by the `app.use` registered right after `userRank()`/`ROLE_RANK`.
   `userRank()` defaults a missing `x-user-role` header to `'viewer'` (rank 0),
   and an unauthenticated request never carries that header — so any public
   route that does a POST/PUT/PATCH/DELETE gets 403'd ("Your role is
   read-only") before its own handler runs unless it's listed here.
3. **`api/server.js`'s `enforceLicense` middleware** — has TWO separate checks
   in the same function that both need the route added: the grace-period
   write-block (the `isAck`/`isSso`-style exemption inside the
   `!state.canWrite` branch) and the fully-disabled-state `exemptPaths` array
   (matched with `req.path.startsWith(p)`). A route can clear gates 1 and 2
   and still get a 402 from either of these during a license grace period or
   once the license is fully expired.

All three currently exempt `/api/sso` (verified against the live file:
`PUBLIC_API` includes `sso$`, `WRITE_GATE_EXEMPT` includes `/^\/api\/sso$/`,
and `enforceLicense` exempts it in both its write-block `isSso` check and its
`exemptPaths` array). Check the next new public route against all three
in one pass instead of discovering them one broken release at a time.

### Site-scoping — audit every sibling route in a batch, not just the one that gets reported
When a feature adds several similar routes for one resource (list/detail/
history, etc.), don't assume consistency across the batch just because most
of them got it right. The `service_checks` feature shipped `GET
/api/service-checks/:id` and `/api/service-checks/:id/results` with **zero**
`getSiteFilter(req)` scoping, while a third route added in the very same
commit (`/api/reports/service-detail`) had the identical pattern implemented
correctly right next to it. This was an isolated oversight, not a knowledge
gap — the correct pattern already existed in the same diff. Both routes are
now fixed (each calls `getSiteFilter(req)` and 403s with `'forbidden: service
outside your assigned sites'` when the check's `site_id` isn't in the
caller's assigned sites — see `api/server.js` around the `/api/service-checks/
:id` and `:id/results` handlers). Rule: when a commit adds several routes for
the same resource, verify EACH one individually against the established
`getSiteFilter` pattern — don't spot-check one and assume the rest match.

## UI design (match NetVault exactly)
- Sidebar: #1a2744 (dark navy), white text/icons, 220px wide
- Accent: #C8102E (crimson red) for primary buttons, active nav, stat card highlights
- Content area: white (#ffffff) background
- Top bar: white, user avatar + dropdown containing a "NocVault Hub" item (house
  icon, links to `HUB/launcher`)
- Hub URL for that link is client-derived (`getHubUrl()` in `TopBar.tsx`, `window.
  location`-based, env var only as an SSR fallback) — see CRITICAL RULES above,
  not a raw `process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL` read
- Sign out: calls signOut() then redirects to HUB_URL/launcher
- Nav items (in order, `frontend/src/components/Sidebar.tsx`): Dashboard, Devices,
  Alerts, Services, Reports, Maps, Wireless, Topology, Agents (admin-only, gated
  by `canManageAgents`), Intelligence, Settings (admin-only, gated by
  `canManageSettings`)
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

## Build status — historical snapshot (Phases 1-6 only, baseline ~1.2.0)
This section and "Completed enhancements" below it are a **historical snapshot**
frozen at roughly the original 6-page app (Dashboard/Devices/Alerts/Reports/Map/
Settings) plus its first round of polish. The app is now on version `1.71.x`+
(see `package.json`) and has grown several entire subsystems since — see
"Since then" below "Completed enhancements" for what actually shipped. Don't
treat the phase list or the "Next step" that used to follow it as current state;
the app has been deployed, iterated on, and is live on the production server
(see "Live Server Verification" below) for a long time.

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

## Deployment notes (server testing)
- Run installer/Update-SpanVault.ps1 -ServerIp <ip> on the server; it writes .env.local
  from .env.local.example (existing .env.local is preserved — see commit f12b787).
- Both root .env.local and frontend/.env.local must exist before `npm run build` because
  NEXT_PUBLIC_* vars bake in at build time. The installer handles this.
- Three services must be running: SpanVault-API (3009), SpanVault-App (3008), SpanVault-Collector.
- Verify DB access: spanvault (read/write) + netvault (read-only) reachable from the server.
- SSO: ensure NEXTAUTH_SECRET matches the hub's so sso-verify / JWT verification succeeds.

## Completed enhancements
Post-Phase-6 UI/API enhancements (all built, committed, and pushed to main). Items
0-6 below are the **original** post-Phase-6 batch (through commit `51800b1`,
Ctrl+K search, ~1.2.0) — kept verbatim as a historical record. Items 7+ are the
headline subsystems added since, at a much higher level than 0-6 (there have been
100+ feature/fix commits since 1.2.0; this is not exhaustive — check `git log` for
full detail on any one of them):

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

### Since then (major subsystems, verified via `git log`/current files — not exhaustive)

7. **Wireless monitoring** (`034e0c8` onward, e.g. `f3b1239` UI overhaul, `60e3a70`
   1.68.0) — full SNMP-based AP/controller/client polling
   (`collector/wirelessCollector.js`, per-vendor parsers in `collector/wireless/`)
   with its own `/wireless` page (Overview/Intelligence/Controllers/Clients/SSIDs
   tabs), an RF statistical-analytics engine (`collector/wirelessIntelligence.js`),
   HA cluster peer roster (`4c4c1e3`, 1.66.0), and dedicated wireless report
   templates.
8. **Services / service_checks as first-class entities** (`2d711a2`, 1.69.0) —
   `/services` page + detail, its own alert-rule tab, and dashboard/API
   integration alongside devices.
9. **Remote agent subsystem** (`c985c77`…`43cc32f`, "distributed polling parts
   1-7", plus later hardening phases through `bbfc4c8`, 1.70.0) — top-level
   `agent/` directory (`agent.js`, `install.ps1`) shipping a poll/ship/
   offline-buffer agent that connects to `api/ws-server.js` over WebSocket
   (port 3010); `/agents` page (admin-only), zero-touch device discovery,
   agent fleet health/self-update, and per-user app-access enforcement layered
   on top (`4c77651`, `035af3e`).
10. **Topology mapping** (`f156876`) — LLDP/CDP discovery (`collector/discovery.js`,
    `collector/topology.js`), `/topology` page with a visual link map grouped
    by site.
11. **Intelligence page** (`28805af`…`06cc0f3`) — `api/intelligence.js` analytics
    engine, `/intelligence` page (multi-tab), plus intelligence signals surfaced
    on the dashboard and device detail.
12. **Dashboard KPI rework** (`a31f610` 1.3.0 enterprise dashboard, `b523610`
    1.67.1 narrowed the top strip, `add1c09` 1.67.2 conditional Agents/Services
    tiles) — the dashboard has been substantially reworked multiple times since
    the original Phase 5 page; don't assume the current KPI layout matches the
    Phase 5 description above.
13. **PDF report rendering** (`b94301d` 1.59.0 two-pane redesign + server-side
    pdfkit engine, followed by per-report-type pdfkit renderers in
    `api/reportsPdf.js`/`api/pdfCharts.js`) — reports now render as real PDFs
    server-side rather than the original Phase 5 report page.

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
- **Exception: pure documentation changes do NOT require a version bump.**
  A commit that touches ONLY CLAUDE.md and/or code comments — no change to
  actual runtime behavior — can skip `npm version`. Everything else, however
  small (a copy tweak, a config default, a hardcoded value), still counts as
  a real change and needs the bump. If a commit mixes a doc change with any
  runtime change, it needs the bump.
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

### `wireless_controllers` secrets are deliberately EXCLUDED from claude_readonly/nocvault_readonly — do NOT blanket-regrant
`wireless_controllers` holds live, rotating third-party API credentials
(`api_key`, `api_password`, `api_client_secret`, `api_refresh_token`,
`api_access_token` — the last two are Aruba Central's OAuth2 tokens, which
actively rotate on every refresh). Both readonly roles used to have plain
table-wide `SELECT` on this table (inherited from the suite's own blanket
`GRANT SELECT ON ALL TABLES IN SCHEMA public`), which meant every diagnostic
query — including an innocuous `SELECT *` — could read a live customer's
cloud API secret. Fixed 2026-07 with a **column-level** grant instead: both
roles can read every column on this table EXCEPT those five. This is a
deliberate, narrower exception to the suite's normal blanket-grant pattern —
**never re-run a blanket `GRANT SELECT ON ALL TABLES IN SCHEMA public TO
claude_readonly / nocvault_readonly` in a way that touches this table** (e.g.
a fresh-install/suite-installer grant step, or a "just re-grant everything"
troubleshooting command) — that silently re-widens it back to table-wide
SELECT, undoing this fix with no error or warning. If a NEW secret-bearing
column is ever added to this table (or the same pattern is used for another
vendor's credentials elsewhere), it must be explicitly excluded from the next
grant the same way — a column-level grant fails closed (a new column is
simply invisible to diagnostics until explicitly granted), which is the
correct trade: a missing column in a debug query is a far smaller problem
than a newly-added secret silently becoming world-readable to every readonly
role.

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

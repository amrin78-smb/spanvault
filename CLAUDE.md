# SpanVault — NocVault Suite

## What this is
SpanVault is a Network Monitoring System (NMS) in the NocVault suite. It runs alongside
NetVault (port 3000), LogVault (port 3004), and DDIVault (port 3006) on the same Windows Server.
SpanVault runs on port 3008 (frontend) and port 3009 (API).

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

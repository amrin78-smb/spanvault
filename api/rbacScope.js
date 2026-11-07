'use strict';

/**
 * rbacScope.js — the PURE half of SpanVault's RBAC site scoping.
 *
 * Why this file exists: every predicate in here used to be an inline helper (or,
 * worse, an inline hand-rolled expression) inside `api/server.js`, which cannot
 * be `require`d by a test — it opens two Postgres pools, starts the agent
 * WebSocket listener and binds a port. So the rules that decide what a
 * `site_admin` can see had no test coverage at all, in a codebase whose own
 * gotchas.md records this exact bug class recurring five times.
 *
 * Everything here is pure: no DB, no network, no `req` mutation. The DB-touching
 * wrappers (`deviceVisible`, `mapVisible`, `layoutIdsInScope`) stay in server.js
 * and call into these. Regression suite: `node tests/test-rbac-scoping.js`.
 *
 * ⛔ Plain JavaScript only — no TypeScript syntax (api/ and collector/ rule).
 */

// Role ranks. viewer = read-only; site_admin may do operational writes within
// its own sites; admin/super_admin may change configuration/infrastructure.
const ROLE_RANK = { viewer: 0, site_admin: 1, admin: 2, super_admin: 3 };

// The frontend proxy sets x-user-role from the VERIFIED session token and
// strips any client-supplied copy first (frontend/src/lib/apiGate.ts). An
// unknown or missing role floors at 'viewer' (rank 0).
function userRank(req) {
  const role = (req && req.headers && req.headers['x-user-role']) || 'viewer';
  return ROLE_RANK[role] != null ? ROLE_RANK[role] : 0;
}

// x-user-sites / x-user-role are set by the frontend proxy from the verified
// session. A site_admin is scoped to their assigned sites; admin/viewer (and
// missing headers) get null = no filter. Enforced server-side in Express, so a
// site_admin cannot bypass it by calling the API directly.
function getSiteFilter(req) {
  const sites = req && req.headers && req.headers['x-user-sites'];
  const role = req && req.headers && req.headers['x-user-role'];
  if (role === 'site_admin' && sites) {
    const siteIds = String(sites).split(',').map(Number).filter(Boolean);
    return siteIds.length > 0 ? siteIds : null;
  }
  return null; // no filter for admin/viewer
}

// Push a site filter onto `params` and return the SQL clause (or null when the
// user is unscoped). `col` is the site_id column reference, e.g. 'd.site_id'.
//
// ⛔ `site_id = ANY(...)` is NULL for a NULL site_id, never TRUE — so a row with
// no site is invisible to a scoped caller. That is the WANTED behaviour (fail
// closed), and `OR <col> IS NULL` is the trap that inverts it. See gotchas.md's
// "a site-less alert must fail CLOSED" entry: that exact addition handed a
// site_admin 8,554 rows where 8,536 were theirs.
function siteFilterClause(siteFilter, params, col) {
  if (!siteFilter || !siteFilter.length) return null;
  params.push(siteFilter);
  return `${col} = ANY($${params.length}::int[])`;
}

// The single decision every per-ROW scope check makes, so the ten routes that
// resolve one row's site_id and then compare it all read from one place instead
// of hand-rolling the comparison (and its NULL handling) ten times.
// `null`/`undefined` site_id fails closed for a scoped caller, matching
// siteFilterClause's SQL behaviour exactly.
function rowInScope(siteFilter, siteId) {
  if (!siteFilter || !siteFilter.length) return true; // admin / viewer — unscoped
  if (siteId === null || siteId === undefined) return false;
  return siteFilter.includes(siteId);
}

// Guard for a WRITE whose PAYLOAD names a site (create a device, move a device
// between sites). The read-side guards resolve the site from the STORED row, so
// they cannot see a site the caller supplied themselves.
function siteWritable(req, siteId) {
  const siteFilter = getSiteFilter(req);
  if (!siteFilter || !siteFilter.length) return true;
  const n = siteId === null || siteId === undefined ? null : parseInt(siteId, 10);
  return n !== null && Number.isFinite(n) && siteFilter.includes(n);
}

// ⛔ `sv_maps` HAS NO `site_id` — a map's scope is DERIVED from its nodes.
// Returns a SQL fragment that is TRUE for a map having at least one
// entity-linked node outside the caller's scope. A node linked to neither a
// device nor a service check is decorative and carries no data, so it is
// ignored; a node whose device/service has a NULL site_id belongs to no site and
// fails CLOSED. `-1` can never be a real site id (the sequence starts at 1),
// which is what makes `COALESCE(..., -1) <> ALL(...)` treat "no site" as out of
// scope rather than silently dropping the row the way a NULL comparison would.
function mapOutOfScopeSql(mapIdExpr, paramIdx) {
  return `EXISTS (
    SELECT 1
      FROM map_devices mdx
      LEFT JOIN monitored_devices dx  ON dx.id  = mdx.device_id
      LEFT JOIN service_checks    scx ON scx.id = mdx.service_check_id
     WHERE mdx.map_id = ${mapIdExpr}
       AND (mdx.device_id IS NOT NULL OR mdx.service_check_id IS NOT NULL)
       AND COALESCE(dx.site_id, scx.site_id, -1) <> ALL($${paramIdx}::int[])
  )`;
}

// Entity ids a PUT /api/maps/:id/layout payload wants to place. Every one of
// them has to be checked against the caller's scope, or the layout route is a
// way to pull another site's devices into a map you legitimately own and read
// their name/ip_address/live status straight back out of GET /api/maps/:id.
// Non-numeric and absent values are dropped rather than coerced — `Number(null)`
// is 0, and a 0 would silently pass a "not found" check instead of failing one.
function collectLayoutEntityIds(devices) {
  const deviceIds = [];
  const checkIds = [];
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || typeof d !== 'object') continue;
    if (d.device_id !== null && d.device_id !== undefined) {
      const n = Number(d.device_id);
      if (Number.isInteger(n) && n > 0) deviceIds.push(n);
    }
    if (d.service_check_id !== null && d.service_check_id !== undefined) {
      const n = Number(d.service_check_id);
      if (Number.isInteger(n) && n > 0) checkIds.push(n);
    }
  }
  return { deviceIds, checkIds };
}

// ── The 404 convention ──────────────────────────────────────────────────────
// ⛔ An out-of-scope answer must be INDISTINGUISHABLE from a not-found answer.
// The routes used to return 403 "forbidden: X outside your assigned sites" for
// out-of-scope and let the route's own 404 handle absent, which read as
// deliberate and was a working enumeration oracle: walking /api/devices/1..5000
// mapped the exact device-id population of the estate, and the same walk on
// /api/wireless/clients/:mac revealed whether a MAC is present anywhere.
// DDIVault (`/api/scopes/:scopeId/history`) and LogVault already answer 404 for
// both.
//
// Only the `device` entry is currently SHARED by both branches as an object
// (GUARD 1's out-of-scope branch and GET /api/devices/:id's absent branch) —
// that is the family the enumeration walk actually targets. The others are
// here so the wording lives in one place and so moving the remaining routes
// onto them is a mechanical change; today those routes still hold
// byte-identical literals, so if you touch one, change BOTH branches.
const NOT_FOUND = Object.freeze({
  device:       Object.freeze({ error: 'Device not found' }),
  ap:           Object.freeze({ error: 'AP not found' }),
  client:       Object.freeze({ error: 'Client not found' }),
  serviceCheck: Object.freeze({ error: 'Service check not found' }),
  map:          Object.freeze({ error: 'Map not found' }),
  savedReport:  Object.freeze({ error: 'not found' }),
});

// GUARD 1 for the whole `/api/devices/:id…` family, as a factory so a test can
// drive it with a stubbed `query` instead of a live Postgres. `query(sql, params)
// => { rows }`. Mounted in server.js; see the long comment there for WHY it is
// a mount-level middleware rather than ~20 per-route checks.
//
// Inside a mounted middleware Express rewrites `req.url`, so `req.path` here is
// the remainder ('/2/interfaces'), not the full path — the regex matches only a
// NUMERIC first segment, so `/api/devices` itself and `/api/devices/sparklines`
// fall straight through to their own handlers.
function makeDeviceScopeGuard(query) {
  return async function deviceScopeGuard(req, res, next) {
    const m = /^\/(\d+)(\/|$)/.exec(req.path);
    if (!m) return next();
    const siteFilter = getSiteFilter(req);
    // getSiteFilter returns null for admin/super_admin/viewer, and we return
    // before touching the DB in that case — no added query on the common path.
    if (!siteFilter || !siteFilter.length) return next();
    const id = parseInt(m[1], 10);
    if (!Number.isFinite(id)) return next();
    const r = await query('SELECT site_id FROM monitored_devices WHERE id = $1', [id]);
    // Absent row: next(), so the route answers its own 404 — with the SAME body
    // object the out-of-scope branch uses just below.
    if (!r.rows[0]) return next();
    if (!rowInScope(siteFilter, r.rows[0].site_id)) {
      return res.status(404).json(NOT_FOUND.device);
    }
    return next();
  };
}

// ── Disclosure-safe error text ───────────────────────────────────────────────
// ⛔ nodemailer's `err.message` routinely embeds the SMTP host, port, configured
// username and the mail server's verbatim auth rejection. It used to be both
// returned to the caller of POST /api/reports/saved/:id/run-now (rank >= 1) AND
// persisted to report_history.error, which GET /api/reports/saved/:id/history
// hands back. `code`/`responseCode` are what an operator actually triages on and
// carry no configuration, so only those leave the process.
function mailErrorSummary(e) {
  const code = e && (e.code || e.responseCode);
  return code
    ? `Report delivery failed (${String(code).slice(0, 40)}) — see the API log for detail.`
    : 'Report delivery failed — see the API log for detail.';
}

// ── SSRF: a server-side fetch target is not a browser link ───────────────────
// `resolveOrigin` in server.js derives its host from the REQUEST, which is right
// for a redirect the browser follows. Handing the same value to `fetch()` is an
// SSRF primitive: Host/X-Forwarded-Host are attacker-controlled on a plain-HTTP
// install and on a TLS install whose terminator has no TLS_PUBLIC_HOST pin (it
// then echoes the client Host), and both fetch sinks are in middleware's
// PUBLIC_API — i.e. reachable with NO session.
//
// The legitimate behaviour is kept: the request-derived origin is still used,
// but only when its hostname is one this install was CONFIGURED with.
function trustedFetchHostnames(env) {
  const e = env || {};
  const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const add = (v) => {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return;
    try { set.add(new URL(raw).hostname.toLowerCase()); }
    catch (_e) { set.add(raw.split('/')[0].split(':')[0].toLowerCase()); }
  };
  add(e.NOCVAULT_HUB_URL);
  add(e.NEXT_PUBLIC_NOCVAULT_HUB_URL);
  add(e.SV_PUBLIC_URL);
  add(e.NEXTAUTH_URL);
  add(e.TLS_PUBLIC_HOST);
  for (const h of String(e.NOCVAULT_TRUSTED_HOSTS || '').split(',')) add(h);
  set.delete('');
  return set;
}

// `candidate` is the request-derived origin (or null/'' when the request carried
// no usable Host). Returns the origin a server-side fetch may actually use.
function pickHubFetchOrigin(env, candidate) {
  const e = env || {};
  const fallback = String(
    e.NOCVAULT_HUB_URL || e.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000'
  ).replace(/\/+$/, '');
  if (!candidate) return fallback;
  let host;
  try { host = new URL(candidate).hostname.toLowerCase(); } catch (_e) { return fallback; }
  return trustedFetchHostnames(e).has(host) ? String(candidate).replace(/\/+$/, '') : fallback;
}

module.exports = {
  NOT_FOUND,
  makeDeviceScopeGuard,
  ROLE_RANK,
  userRank,
  getSiteFilter,
  siteFilterClause,
  rowInScope,
  siteWritable,
  mapOutOfScopeSql,
  collectLayoutEntityIds,
  mailErrorSummary,
  trustedFetchHostnames,
  pickHubFetchOrigin,
};

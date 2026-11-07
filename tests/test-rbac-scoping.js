'use strict';
/**
 * Offline regression tests for the 2026-11 site-scoping / disclosure sweep.
 *
 * What they cover, and why each one exists:
 *   1. The site-scoping predicates (`getSiteFilter`, `siteFilterClause`,
 *      `rowInScope`, `siteWritable`) — gotchas.md records this bug class
 *      recurring FIVE times and the predicates had no coverage at all.
 *   2. The 404 convention — GUARD 1 on `/api/devices/:id…` driven for real
 *      with a stubbed `query`: an out-of-scope id must answer with the exact
 *      body an absent id produces, not a 403.
 *   3. The maps scope model — `sv_maps` has no `site_id`, so scope is derived
 *      from its nodes; the predicate must fail CLOSED on a site-less node.
 *   4. The agent-ownership check — the exact SQL the three ws-server telemetry
 *      paths run must bind `agent_id`, not just `id`.
 *   5. The WS frame cap.
 *   6. Header stripping + the public-API allow-list in `frontend/src/lib/apiGate.ts`.
 *   7. The SSRF allow-list for server-side fetch targets.
 *   8. The nodemailer error summary (no SMTP host/user/message text escapes).
 *
 * No network, no DB, no test framework — same house style as the parser suites
 * and tests/test-sso-authorize.js. `apiGate.ts` is transpiled on the fly with
 * the frontend's own TypeScript (no new dependency, nothing left in src/).
 *
 *   node tests/test-rbac-scoping.js      (or: npm run test:rbac)
 *
 * HONEST LIMITS — stated rather than papered over:
 *   • Nothing here runs a query. Whether a scoped SQL fragment selects the right
 *     ROWS is a property of Postgres + live data and needs the DB.
 *   • Tests 4 assert the exact exported statement strings the telemetry paths
 *     execute. They catch the predicate being weakened; they cannot catch a
 *     handler that stops using the constant altogether.
 *   • The per-route 403->404 conversions outside the `/api/devices` family are
 *     not exercised end to end here — only the shared body objects and the one
 *     guard that could be extracted are.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');

const scope = require(path.join(ROOT, 'api/rbacScope'));
const {
  getSiteFilter, siteFilterClause, rowInScope, siteWritable, mapOutOfScopeSql,
  collectLayoutEntityIds, mailErrorSummary, pickHubFetchOrigin, trustedFetchHostnames,
  NOT_FOUND, makeDeviceScopeGuard, userRank,
} = scope;

const checks = [];
function check(name, ok) { checks.push([name, !!ok]); }
const req = (role, sites) => ({ headers: Object.assign({}, role ? { 'x-user-role': role } : {},
  sites !== undefined ? { 'x-user-sites': sites } : {}) });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {

  // ── 1. getSiteFilter ───────────────────────────────────────────────────────
  check('getSiteFilter scopes a site_admin to their listed sites',
    eq(getSiteFilter(req('site_admin', '31,35')), [31, 35]));
  check('getSiteFilter returns null (unscoped) for admin', getSiteFilter(req('admin', '31,35')) === null);
  check('getSiteFilter returns null (unscoped) for super_admin', getSiteFilter(req('super_admin', '31')) === null);
  check('getSiteFilter returns null (unscoped) for viewer', getSiteFilter(req('viewer', '31,35')) === null);
  check('getSiteFilter returns null with no headers at all', getSiteFilter({ headers: {} }) === null);
  check('getSiteFilter returns null for a site_admin with an empty site list',
    getSiteFilter(req('site_admin', '')) === null);
  check('userRank floors an unknown role at viewer (0)', userRank(req('wizard')) === 0);
  check('userRank floors a missing role at viewer (0)', userRank({ headers: {} }) === 0);
  check('userRank gives admin rank 2', userRank(req('admin')) === 2);

  // ── 2. siteFilterClause ────────────────────────────────────────────────────
  {
    const p = [];
    check('siteFilterClause is null and pushes nothing for an unscoped caller',
      siteFilterClause(null, p, 'd.site_id') === null && p.length === 0);
  }
  {
    const p = [];
    const c = siteFilterClause([31, 35], p, 'd.site_id');
    check('siteFilterClause emits the canonical ANY() form on the given column',
      c === 'd.site_id = ANY($1::int[])' && p.length === 1 && eq(p[0], [31, 35]));
  }
  {
    const p = ['24 hours'];
    const c = siteFilterClause([7], p, 'c.site_id');
    check('siteFilterClause numbers its placeholder from the existing params',
      c === 'c.site_id = ANY($2::int[])' && p.length === 2);
  }
  check('siteFilterClause never emits an "OR ... IS NULL" escape hatch',
    !/IS\s+NULL/i.test(siteFilterClause([1], [], 'd.site_id')));

  // ── 3. rowInScope — the ONE per-row predicate (gotchas: never hand-roll another)
  check('rowInScope lets an unscoped caller see any row', rowInScope(null, 9) === true);
  check('rowInScope lets an unscoped caller see a site-less row', rowInScope(null, null) === true);
  check('rowInScope allows an in-scope row', rowInScope([31, 35], 35) === true);
  check('rowInScope denies an out-of-scope row', rowInScope([31, 35], 9) === false);
  check('rowInScope FAILS CLOSED on a NULL site_id', rowInScope([31, 35], null) === false);
  check('rowInScope FAILS CLOSED on an undefined site_id', rowInScope([31, 35], undefined) === false);

  // ── 4. siteWritable — payload-supplied site on a device create/move ────────
  // (New: POST /api/devices and PUT /api/devices/:id had NO site check at all,
  // so a site_admin could create or park a device in a site they cannot see.)
  check('siteWritable lets an unscoped caller write any site', siteWritable(req('admin'), 99) === true);
  check('siteWritable lets an unscoped caller write a null site', siteWritable(req('admin'), null) === true);
  check('siteWritable allows a site_admin to write their own site',
    siteWritable(req('site_admin', '31,35'), 35) === true);
  check('siteWritable accepts a numeric STRING site id (form bodies send strings)',
    siteWritable(req('site_admin', '31,35'), '35') === true);
  check('siteWritable DENIES a site_admin writing another site',
    siteWritable(req('site_admin', '31,35'), 9) === false);
  check('siteWritable FAILS CLOSED on a null site for a site_admin',
    siteWritable(req('site_admin', '31,35'), null) === false);
  check('siteWritable FAILS CLOSED on a non-numeric site for a site_admin',
    siteWritable(req('site_admin', '31,35'), 'all') === false);

  // ── 5. The 404 convention, driven for real ─────────────────────────────────
  // GUARD 1 on the /api/devices/:id family, with the DB stubbed. Pre-fix this
  // branch returned 403 {error:'forbidden: device outside your assigned sites'},
  // which is exactly the oracle that let /api/devices/1..5000 be walked.
  {
    const rows = { 7: { site_id: 35 }, 8: { site_id: 9 } };
    const query = async (_sql, params) => ({ rows: rows[params[0]] ? [rows[params[0]]] : [] });
    const guard = makeDeviceScopeGuard(query);
    const fakeRes = () => {
      const r = { code: null, body: null };
      r.status = (c) => { r.code = c; return r; };
      r.json = (b) => { r.body = b; return r; };
      return r;
    };
    const drive = async (p, role, sites) => {
      const res = fakeRes();
      let nexted = false;
      await guard(Object.assign({ path: p }, req(role, sites)), res, () => { nexted = true; });
      return { res, nexted };
    };

    const inScope = await drive('/7', 'site_admin', '31,35');
    check('device guard passes an IN-scope id straight through', inScope.nexted && inScope.res.code === null);

    const out = await drive('/8', 'site_admin', '31,35');
    check('device guard answers 404 (NOT 403) for an OUT-of-scope id',
      !out.nexted && out.res.code === 404);
    check('device guard out-of-scope body is the shared NOT_FOUND.device object',
      out.res.body === NOT_FOUND.device);
    check('device guard out-of-scope body is byte-identical to the absent answer',
      eq(out.res.body, { error: 'Device not found' }));
    check('device guard leaks no scoping language in the body',
      !/forbidden|assigned sites|site/i.test(JSON.stringify(out.res.body)));

    const absent = await drive('/4242', 'site_admin', '31,35');
    check('device guard lets an ABSENT id fall through to the route\'s own 404',
      absent.nexted && absent.res.code === null);

    const asAdmin = await drive('/8', 'admin', '31,35');
    check('device guard never touches the DB for an unscoped caller',
      asAdmin.nexted && asAdmin.res.code === null);

    for (const p of ['/', '/sparklines', '/sparklines/x']) {
      const r = await drive(p, 'site_admin', '31,35');
      check(`device guard ignores the non-numeric path "${p}"`, r.nexted && r.res.code === null);
    }
  }

  // The shared bodies for the other converted families. The point is that they
  // are the SAME frozen objects both branches of each route use, so the
  // out-of-scope answer cannot drift away from the not-found answer.
  check('NOT_FOUND carries a body for every converted family',
    ['device', 'ap', 'client', 'serviceCheck', 'map', 'savedReport'].every((k) => NOT_FOUND[k] && NOT_FOUND[k].error));
  check('no NOT_FOUND body mentions scoping, sites or forbidden',
    !/forbidden|assigned|site/i.test(JSON.stringify(NOT_FOUND)));
  check('NOT_FOUND bodies are frozen (a route cannot mutate a shared answer)',
    Object.isFrozen(NOT_FOUND) && Object.isFrozen(NOT_FOUND.device));

  // ── 6. The maps scope model (sv_maps has no site_id) ───────────────────────
  {
    const sql = mapOutOfScopeSql('m.id', 1);
    check('mapOutOfScopeSql derives a map\'s scope from its nodes, not sv_maps',
      /FROM map_devices/.test(sql) && !/sv_maps/.test(sql));
    check('mapOutOfScopeSql resolves a node\'s site through device OR service check',
      /dx\.site_id/.test(sql) && /scx\.site_id/.test(sql));
    check('mapOutOfScopeSql ignores decorative (unlinked) nodes',
      /mdx\.device_id IS NOT NULL OR mdx\.service_check_id IS NOT NULL/.test(sql));
    check('mapOutOfScopeSql FAILS CLOSED on a site-less node via the -1 sentinel',
      /COALESCE\(dx\.site_id, scx\.site_id, -1\) <> ALL\(\$1::int\[\]\)/.test(sql));
    check('mapOutOfScopeSql has no "OR ... IS NULL" fail-open escape',
      !/OR[^)]*IS NULL/i.test(sql.replace(/mdx\.(device_id|service_check_id) IS NOT NULL/g, '')));
    check('mapOutOfScopeSql uses the map-id expression it was given',
      /mdx\.map_id = m\.id/.test(sql) && /mdx\.map_id = \$1/.test(mapOutOfScopeSql('$1', 2)));
    check('mapOutOfScopeSql uses the param index it was given',
      /\$4::int\[\]/.test(mapOutOfScopeSql('m.id', 4)));
  }

  // Layout payload ids — PUT /api/maps/:id/layout accepted any device id.
  {
    const got = collectLayoutEntityIds([
      { device_id: 12 }, { service_check_id: '5' }, { device_id: '77', x: 1 },
      { device_id: null }, { service_check_id: undefined }, { x: 1, y: 2 },
      null, 'nonsense', { device_id: 'all' }, { device_id: 0 }, { device_id: -3 },
    ]);
    check('collectLayoutEntityIds collects every device id a payload places',
      eq(got.deviceIds, [12, 77]));
    check('collectLayoutEntityIds collects every service-check id a payload places',
      eq(got.checkIds, [5]));
    check('collectLayoutEntityIds drops 0 (a "not found" id would pass a count check)',
      got.deviceIds.indexOf(0) === -1 && got.deviceIds.indexOf(-3) === -1);
    check('collectLayoutEntityIds survives a non-array payload',
      eq(collectLayoutEntityIds(undefined), { deviceIds: [], checkIds: [] }));
  }

  // ── 7. The agent-ownership check (api/ws-server.js) ────────────────────────
  {
    const ws = require(path.join(ROOT, 'api/ws-server'));
    const t = ws.__testables;
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

    check('ownedDeviceExists binds the agent, not just the device id',
      /agent_id = \$6/.test(t.ownedDeviceExists('$1', '$6')) &&
      /id = \$1/.test(t.ownedDeviceExists('$1', '$6')));

    const probe = norm(t.SQL_DEVICE_OWNED_PROBE);
    check('the snmp_batch existence probe requires agent ownership',
      /monitored_devices/.test(probe) && /agent_id=\$2/.test(probe));

    const ping = norm(t.SQL_INSERT_PING_RESULT);
    check('ping_result inserts only for a device THIS agent owns',
      /INSERT INTO ping_results/.test(ping) &&
      /EXISTS \(SELECT 1 FROM monitored_devices WHERE id = \$1 AND agent_id = \$6\)/.test(ping));
    check('ping_result is not the pre-fix existence-only shape',
      !/WHERE id = \$1\)/.test(ping));

    const snmp = norm(t.SQL_INSERT_SNMP_RESULT);
    check('snmp_result inserts only for a device THIS agent owns',
      /INSERT INTO snmp_results/.test(snmp) &&
      /EXISTS \(SELECT 1 FROM monitored_devices WHERE id = \$1 AND agent_id = \$8\)/.test(snmp));
    check('snmp_result is an INSERT...SELECT...WHERE EXISTS, not a bare VALUES',
      /SELECT \$1/.test(snmp) && !/VALUES \(\$1/.test(snmp));

    // ── 8. The WS frame cap. Read at module load, so each value needs its own
    // process — same spawn-per-case shape run-parser-tests.js uses.
    const payloadIn = (env) => Number(execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./api/ws-server').__testables.WS_MAX_PAYLOAD))"],
      { cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8' }
    ));
    check('the agent WebSocket has a frame cap at all (32 MB by default)',
      payloadIn({ SV_WS_MAX_PAYLOAD_MB: '' }) === 32 * 1024 * 1024);
    check('SV_WS_MAX_PAYLOAD_MB raises the frame cap',
      payloadIn({ SV_WS_MAX_PAYLOAD_MB: '7' }) === 7 * 1024 * 1024);
    check('a junk SV_WS_MAX_PAYLOAD_MB falls back to the default rather than 0/NaN',
      payloadIn({ SV_WS_MAX_PAYLOAD_MB: 'lots' }) === 32 * 1024 * 1024);
  }

  // ── 9. The SSRF allow-list for server-side fetch targets ──────────────────
  {
    const env = {
      NOCVAULT_HUB_URL: 'http://10.1.2.3:3000',
      TLS_PUBLIC_HOST: 'nocvault.example.com',
      NOCVAULT_TRUSTED_HOSTS: 'alt.example.net',
    };
    const hub = 'http://10.1.2.3:3000';

    check('a spoofed Host falls back to the configured hub, it is NOT fetched',
      pickHubFetchOrigin(env, 'http://evil.example.com:3000') === hub);
    check('a dotted-IPv4 Host (which the hostname regex accepts) is refused',
      pickHubFetchOrigin(env, 'http://169.254.169.254:3000') === hub);
    check('an internal-metadata-style host is refused',
      pickHubFetchOrigin(env, 'http://metadata.google.internal:3000') === hub);
    check('the CONFIGURED hub host is still honoured from the request',
      pickHubFetchOrigin(env, 'http://10.1.2.3:3000') === hub);
    check('TLS_PUBLIC_HOST (the terminator\'s pinned name) is honoured — the case resolveOrigin exists for',
      pickHubFetchOrigin(env, 'https://nocvault.example.com:3000') === 'https://nocvault.example.com:3000');
    check('NOCVAULT_TRUSTED_HOSTS lets an operator add a name none of the other vars carry',
      pickHubFetchOrigin(env, 'http://alt.example.net:3000') === 'http://alt.example.net:3000');
    check('loopback is honoured (server-to-server calls on the same box)',
      pickHubFetchOrigin(env, 'http://127.0.0.1:3000') === 'http://127.0.0.1:3000');
    check('no candidate at all falls back to the configured hub',
      pickHubFetchOrigin(env, null) === hub && pickHubFetchOrigin(env, '') === hub);
    check('a malformed candidate falls back rather than throwing',
      pickHubFetchOrigin(env, 'not a url') === hub);
    check('a trailing slash is stripped from the chosen origin',
      pickHubFetchOrigin(env, 'http://10.1.2.3:3000/') === hub);
    check('with no hub configured at all the fallback is loopback, never the request',
      pickHubFetchOrigin({}, 'http://evil.example.com:3000') === 'http://localhost:3000');
    check('this is strictly narrower than the pre-fix behaviour (which returned the candidate)',
      pickHubFetchOrigin(env, 'http://evil.example.com:3000') !== 'http://evil.example.com:3000');
    check('trustedFetchHostnames never contains an empty string (which would match a hostless URL)',
      !trustedFetchHostnames({ NOCVAULT_HUB_URL: '' }).has(''));
  }

  // ── 10. The nodemailer error summary ──────────────────────────────────────
  {
    const e = new Error('Invalid login: 535 5.7.3 Authentication unsuccessful for reports@corp.example on smtp.corp.example:587');
    e.code = 'EAUTH';
    const out = mailErrorSummary(e);
    check('mail error summary keeps the triage code', /EAUTH/.test(out));
    for (const secret of ['smtp.corp.example', '587', 'reports@corp.example', 'Authentication unsuccessful', '535']) {
      check(`mail error summary does not leak "${secret}"`, out.indexOf(secret) === -1);
    }
    check('mail error summary differs from the raw message (the pre-fix value)', out !== e.message);
    check('mail error summary still says something useful with no code at all',
      /Report delivery failed/.test(mailErrorSummary(new Error('boom'))));
    check('mail error summary bounds a hostile code string',
      mailErrorSummary({ code: 'X'.repeat(500) }).length < 120);
  }

  // ── 11. frontend/src/lib/apiGate.ts — header stripping + public allow-list ─
  {
    const ts = require(path.join(FRONTEND, 'node_modules/typescript'));
    const SRC = path.join(FRONTEND, 'src/lib/apiGate.ts');
    // Lands under frontend/node_modules/.cache so `next build` never sees it
    // (same trick tests/test-sso-authorize.js uses).
    const OUT_DIR = path.join(FRONTEND, 'node_modules/.cache/spanvault-rbac-test');
    const OUT_FILE = path.join(OUT_DIR, 'apiGate.build.cjs');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
      fileName: 'apiGate.ts',
    }).outputText);
    let gate;
    try { gate = require(OUT_FILE); }
    finally { try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch (_e) {} }

    const { CLIENT_SPOOFABLE_HEADERS, stripClientIdentity, isPublicApiPath } = gate;

    check('every header the Express API trusts verbatim is on the strip list',
      ['x-user-role', 'x-user-sites', 'x-user-email'].every((h) => CLIENT_SPOOFABLE_HEADERS.indexOf(h) !== -1));
    {
      const store = new Map([['x-user-role', 'super_admin'], ['x-user-sites', '1,2,3'],
        ['x-user-email', 'attacker@example.com'], ['accept', 'application/json']]);
      const h = { delete: (k) => store.delete(k) };
      stripClientIdentity(h);
      check('stripClientIdentity removes a client-supplied x-user-role',
        !store.has('x-user-role') && !store.has('x-user-sites') && !store.has('x-user-email'));
      check('stripClientIdentity leaves unrelated headers alone', store.has('accept'));
    }

    check('/api/health stays public', isPublicApiPath('/api/health', 'GET') === true);
    check('/api/stats stays public', isPublicApiPath('/api/stats', 'GET') === true);
    check('POST /api/sso stays public (sign-in cannot require a session)',
      isPublicApiPath('/api/sso', 'POST') === true);
    check('/api/license-status stays public (root-layout LicenseProvider depends on it)',
      isPublicApiPath('/api/license-status', 'GET') === true);
    check('GET /api/maps/public/:uuid stays public', isPublicApiPath('/api/maps/public/abc-123', 'GET') === true);
    check('HEAD /api/maps/public/:uuid stays public', isPublicApiPath('/api/maps/public/abc-123', 'HEAD') === true);

    check('a WRITE under maps/public is NOT public any more',
      isPublicApiPath('/api/maps/public/abc-123', 'POST') === false);
    check('a DEEPER path under maps/public is NOT public any more',
      isPublicApiPath('/api/maps/public/7/toggle-public', 'GET') === false);
    check('a deeper WRITE under maps/public is NOT public any more',
      isPublicApiPath('/api/maps/public/7/toggle-public', 'POST') === false);
    check('the exact-match entries are anchored (/api/healthz is not public)',
      isPublicApiPath('/api/healthz', 'GET') === false);
    check('the exact-match entries are anchored (/api/health/x is not public)',
      isPublicApiPath('/api/health/x', 'GET') === false);
    check('an ordinary data route is not public', isPublicApiPath('/api/devices', 'GET') === false);
    check('/api/system/update-status is deliberately NOT public',
      isPublicApiPath('/api/system/update-status', 'GET') === false);

    // The pre-fix regex, verbatim, so the fix is demonstrably a narrowing.
    const PRE_FIX = /^\/api\/(maps\/public\/|health$|stats$|sso$|license-status$)/;
    check('the pre-fix regex DID match a deeper write under maps/public (this is the bug)',
      PRE_FIX.test('/api/maps/public/7/toggle-public') === true);
    check('the fix rejects exactly what the pre-fix regex let through',
      isPublicApiPath('/api/maps/public/7/toggle-public', 'POST') === false);
  }

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — suite threw: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

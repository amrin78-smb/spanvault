'use strict';
/**
 * Offline tests for the SSO authorize path in frontend/src/lib/auth.ts.
 *
 * Why these exist: a valid HS256 signature over NEXTAUTH_SECRET used to be the
 * ONLY thing `authorize()` checked. The same secret signs the remote agents'
 * data-plane JWTs ({ sub:'agt_…', typ:'agent', aud }, see api/agent-identity.js),
 * which sit on disk on every agent host — so replaying one as `ssoToken` while
 * POSTing `role=super_admin` in the body produced a full SpanVault admin
 * session, because the token carried no `role` and the body's string won.
 *
 * No network, no DB, no test framework — same house style as the parser suites.
 * The NetVault lookups are stubbed through `authorizeSsoToken`'s injectable
 * `deps.query`; the module itself is transpiled on the fly with the frontend's
 * own TypeScript (no new dependency, nothing left behind in src/).
 *
 *   node tests/test-sso-authorize.js      (or: npm run test:auth)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const SRC = path.join(FRONTEND, 'src/lib/auth.ts');

const ts = require(path.join(FRONTEND, 'node_modules/typescript'));
const jwt = require(path.join(FRONTEND, 'node_modules/jsonwebtoken'));

const SECRET = 'unit-test-secret-not-a-real-one';
const OTHER_SECRET = 'a-different-secret-entirely';
process.env.NEXTAUTH_SECRET = SECRET;

// ── Transpile auth.ts into a throwaway CJS module ────────────────────────────
// It lands under frontend/node_modules/.cache so (a) module resolution still
// finds next-auth / jsonwebtoken / pg, and (b) `next build` never sees it.
const OUT_DIR = path.join(FRONTEND, 'node_modules/.cache/spanvault-sso-test');
const OUT_FILE = path.join(OUT_DIR, 'auth.build.cjs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  fileName: 'auth.ts',
}).outputText;
fs.writeFileSync(OUT_FILE, js);

let auth;
try {
  auth = require(OUT_FILE);
} finally {
  try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch (_e) {}
}
const { authorizeSsoToken, authOptions } = auth;

// ── Stub NetVault ───────────────────────────────────────────────────────────
function stubDb(opts) {
  const o = opts || {};
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/FROM users/i.test(sql)) return { rows: o.userRow ? [o.userRow] : [] };
    if (/FROM user_sites/i.test(sql)) {
      return { rows: (o.sites || []).map((s) => ({ site_id: s })) };
    }
    if (/FROM user_apps/i.test(sql)) return { rows: (o.apps || []).map((a) => ({ app: a })) };
    if (o.throws) throw new Error('simulated DB failure');
    return { rows: [] };
  };
  const failing = async () => { throw new Error('simulated DB failure'); };
  return { calls, query: o.throws ? failing : query };
}

const run = (credentials, db) =>
  authorizeSsoToken(credentials, { query: db.query, secret: SECRET });

const checks = [];
function check(name, ok) { checks.push([name, ok]); }

// Canonical hub-minted SpanVault SSO token (net-vault/app/api/sso/spanvault/route.ts):
// jwt.sign({ userId, email, role, name, app:'spanvault', apps }, NEXTAUTH_SECRET, { expiresIn:'2m' })
const ssoTokenFor = (over, secret, signOpts) =>
  jwt.sign(
    Object.assign(
      { userId: 7, email: 'viewer@example.com', role: 'viewer', name: 'Vera Viewer', app: 'spanvault', apps: ['spanvault'] },
      over || {}
    ),
    secret || SECRET,
    Object.assign({ expiresIn: '2m' }, signOpts || {})
  );

// The agent data-plane JWT, exactly as api/agent-identity.js documents it.
const agentToken = (over, secret) =>
  jwt.sign(
    Object.assign({ sub: 'agt_abc123', typ: 'agent', aud: ['span', 'spanvault'] }, over || {}),
    secret || SECRET,
    { expiresIn: '30d' }
  );

const VIEWER_ROW = { id: 7, name: 'Vera Viewer', email: 'viewer@example.com', role: 'viewer' };

(async () => {
  // ── 1. The live exploit: agent token + role=super_admin in the body ───────
  {
    const db = stubDb({ userRow: VIEWER_ROW });
    const r = await run(
      { ssoToken: agentToken(), role: 'super_admin', userId: '1', name: 'Attacker' },
      db
    );
    check('agent-shaped token (typ:agent, no userId) + credentials.role=super_admin is REJECTED', r === null);
    check('rejected agent token never reaches the NetVault DB at all', db.calls.length === 0);
  }

  // ── 2. Belt: an agent token that somehow gained userId + app is still out ─
  {
    const db = stubDb({ userRow: VIEWER_ROW });
    const r = await run(
      { ssoToken: agentToken({ userId: 7, app: 'spanvault' }), role: 'super_admin' },
      db
    );
    check('typ:agent is rejected even WITH userId and app:spanvault present', r === null);
  }

  // ── 3. credentials.role can no longer set the session role ───────────────
  {
    const db = stubDb({ userRow: VIEWER_ROW, apps: ['spanvault'] });
    const r = await run({ ssoToken: ssoTokenFor(), role: 'super_admin' }, db);
    check('valid SSO token + credentials.role=super_admin does NOT yield super_admin',
      r !== null && r.role !== 'super_admin');
    check('role comes from the NetVault users row (viewer)', r !== null && r.role === 'viewer');
  }

  // ── 4. The DB row beats the token's own role claim ────────────────────────
  {
    const db = stubDb({ userRow: VIEWER_ROW, apps: ['spanvault'] });
    const r = await run({ ssoToken: ssoTokenFor({ role: 'super_admin' }) }, db);
    check('dbUser.role wins over a stale payload.role claim', r !== null && r.role === 'viewer');
  }

  // ── 5. "No such row" vs "the query failed" are DIFFERENT answers ─────────
  // A zero-row result is definitive: this user does not exist in NetVault, so
  // the login is refused. Only a THROWN query (a transient cross-DB failure)
  // may fall back to the hub-signed role claim. This matters because the hub's
  // handoff route reads the session with getToken() on a JWT with no maxAge
  // (30-day next-auth default), so a DELETED user still holds a cookie that
  // mints a token claiming their old role — a zero-row fallback would hand it
  // straight back. logvault/frontend/src/auth.ts refuses a no-row user too.
  {
    const db = stubDb({ userRow: null });
    const r = await run({ ssoToken: ssoTokenFor({ role: 'admin' }), role: 'super_admin' }, db);
    check('no DB row (deleted user) is REJECTED, claim NOT honoured', r === null);
  }
  {
    const db = stubDb({ userRow: null });
    const r = await run({ ssoToken: ssoTokenFor({ role: 'super_admin' }) }, db);
    check('deleted user with a stale super_admin CLAIM is REJECTED', r === null);
  }
  {
    // Transient failure: login survives (no estate-wide lockout on a DB blip)
    // and the hub-signed claim is honoured, but the POST body still is not.
    const db = stubDb({ throws: true });
    const r = await run({ ssoToken: ssoTokenFor({ role: 'admin' }), role: 'super_admin' }, db);
    check('DB THROW -> falls back to the signed payload.role, not credentials.role',
      r !== null && r.role === 'admin');
  }
  {
    const db = stubDb({ throws: true });
    const r = await run({ ssoToken: ssoTokenFor({ role: 'not_a_role' }), role: 'super_admin' }, db);
    check('an unrecognised payload.role falls to the viewer floor', r !== null && r.role === 'viewer');
  }
  {
    const db = stubDb({ throws: true });
    const r = await run({ ssoToken: ssoTokenFor({ role: 'viewer' }), role: 'super_admin' }, db);
    check('a NetVault DB failure still cannot be escalated via credentials.role',
      r !== null && r.role === 'viewer');
  }

  // ── 6. Wrong app / not an SSO token at all ───────────────────────────────
  {
    const db = stubDb({ userRow: VIEWER_ROW });
    check("validly-signed token with app:'logvault' is REJECTED",
      (await run({ ssoToken: ssoTokenFor({ app: 'logvault' }) }, db)) === null);
    check('validly-signed token with NO app claim is REJECTED',
      (await run({ ssoToken: jwt.sign({ userId: 7, email: 'v@e.com', role: 'super_admin' }, SECRET, { expiresIn: '2m' }) }, db)) === null);
    check('validly-signed token with app:spanvault but NO userId is REJECTED',
      (await run({ ssoToken: jwt.sign({ email: 'v@e.com', role: 'super_admin', app: 'spanvault' }, SECRET, { expiresIn: '2m' }) }, db)) === null);
    check('userId: empty string is REJECTED',
      (await run({ ssoToken: ssoTokenFor({ userId: '' }) }, db)) === null);
  }

  // ── 7. Signature / algorithm / expiry ────────────────────────────────────
  {
    const db = stubDb({ userRow: VIEWER_ROW });
    check('token signed with the WRONG secret is REJECTED',
      (await run({ ssoToken: ssoTokenFor({}, OTHER_SECRET) }, db)) === null);
    check('alg:none token is REJECTED (HS256 is pinned)',
      (await run({ ssoToken: jwt.sign({ userId: 7, app: 'spanvault', role: 'super_admin' }, '', { algorithm: 'none' }) }, db)) === null);
    check('expired SSO token is REJECTED',
      (await run({ ssoToken: ssoTokenFor({}, SECRET, { expiresIn: '-10s' }) }, db)) === null);
    check('missing ssoToken is REJECTED', (await run({ role: 'super_admin' }, db)) === null);
    check('null credentials is REJECTED', (await run(null, db)) === null);
    check('garbage ssoToken is REJECTED', (await run({ ssoToken: 'not.a.jwt' }, db)) === null);
  }

  // ── 8. Happy path: full session subject ──────────────────────────────────
  {
    const db = stubDb({ userRow: VIEWER_ROW, apps: ['spanvault', 'logvault'] });
    const r = await run({ ssoToken: ssoTokenFor() }, db);
    check('happy path returns a session', r !== null);
    check('happy path id', r && r.id === '7');
    check('happy path email', r && r.email === 'viewer@example.com');
    check('happy path name', r && r.name === 'Vera Viewer');
    check('happy path role', r && r.role === 'viewer');
    check('happy path sites (viewer is unscoped)', r && Array.isArray(r.sites) && r.sites.length === 0);
    check('happy path apps from netvault.user_apps',
      r && r.apps.join(',') === 'spanvault,logvault');
    const usersCall = db.calls.find((c) => /FROM users/i.test(c.sql));
    check('users row is looked up by the VERIFIED token id',
      !!usersCall && usersCall.params.length === 1 && usersCall.params[0] === '7');
    check('no query anywhere receives a credentials-supplied value',
      db.calls.every((c) => c.params.every((p) => p !== 'super_admin' && p !== '99')));
  }

  // ── 9. credentials.userId / .name / .email are all ignored ───────────────
  {
    const db = stubDb({ userRow: VIEWER_ROW, apps: ['spanvault'] });
    const r = await run(
      { ssoToken: ssoTokenFor(), userId: '99', name: 'Attacker', email: 'admin@example.com', role: 'admin' },
      db
    );
    check('credentials.userId cannot redirect the users lookup', r && r.id === '7');
    check('credentials.name cannot set the display name', r && r.name === 'Vera Viewer');
    check('credentials.email cannot set the session email', r && r.email === 'viewer@example.com');
    const usersCall = db.calls.find((c) => /FROM users/i.test(c.sql));
    check('credentials.email never reaches the users query',
      !!usersCall && !usersCall.params.includes('admin@example.com'));
  }

  // ── 10. site_admin scoping still resolves off the right id ───────────────
  {
    const row = { id: 12, name: 'Sam', email: 'sam@example.com', role: 'site_admin' };
    const db = stubDb({ userRow: row, sites: [3, 5], apps: ['spanvault'] });
    const r = await run({ ssoToken: ssoTokenFor({ userId: 12, email: 'sam@example.com' }), role: 'super_admin' }, db);
    check('site_admin role survives', r && r.role === 'site_admin');
    check('site_admin sites resolved', r && r.sites.join(',') === '3,5');
    const sitesCall = db.calls.find((c) => /FROM user_sites/i.test(c.sql));
    check('user_sites keyed on the DB row id', !!sitesCall && sitesCall.params[0] === '12');
  }
  {
    // super_admin short-circuits resolveUserApps to all four apps.
    const row = { id: 1, name: 'Root', email: 'root@example.com', role: 'super_admin' };
    const db = stubDb({ userRow: row });
    const r = await run({ ssoToken: ssoTokenFor({ userId: 1, role: 'viewer' }) }, db);
    check('a genuine super_admin DB row still gets super_admin + all apps',
      r && r.role === 'super_admin' && r.apps.length === 4);
  }

  // ── 11. The wired-up NextAuth provider (not just the helper) ─────────────
  {
    // NOTE: next-auth v4's CredentialsProvider() returns
    // { id, name, type, credentials: {}, authorize: () => null, options }
    // — our real `credentials`/`authorize` live under `.options` and are merged
    // in later by next-auth's own lib/providers.js. Reaching for
    // `providers[0].authorize` gets the library's always-null stub, so a test
    // written that way passes no matter what the app does. Use `.options`.
    const provider = authOptions.providers[0].options;
    const declared = Object.keys(provider.credentials || {});
    check('provider no longer declares role/userId/name credentials',
      !declared.includes('role') && !declared.includes('userId') && !declared.includes('name'));
    // Uses the real (unreachable) pool, but returns before any DB call.
    const viaProvider = await provider.authorize(
      { ssoToken: agentToken(), role: 'super_admin', userId: '1' },
      {}
    );
    check('authOptions provider rejects the agent-token replay end to end', viaProvider === null);
    check('authOptions provider rejects a password-only login',
      (await provider.authorize({ email: 'a@b.c', password: 'x' }, {})) === null);
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

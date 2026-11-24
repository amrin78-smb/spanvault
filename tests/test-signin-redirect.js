'use strict';
/**
 * Offline regression tests for the hub sign-in redirect (`pages.signIn`).
 *
 * The bug these pin, measured live on production:
 *   `GET /api/auth/signin` answered
 *   `302 → http://<server-ip>:3000/login?callbackUrl=https://<server-ip>:3008`
 *   — a bare IP over plain http, which the site certificate does not name, so
 *   the browser also warned. Cause: `authOptions.pages.signIn` was a template
 *   string built from `process.env.NOCVAULT_HUB_URL`, and NextAuth v4 evaluates
 *   `pages` ONCE at module load, so it can never follow a request. That env var
 *   is DELIBERATELY the hub's server-side origin (a TLS install must not route
 *   server-to-server hub calls through the public front door), so the fix is a
 *   local relative `pages.signIn` plus a request-aware route — not a change to
 *   what the env var holds.
 *
 * What is covered:
 *   1. `hubSigninUrl` — the hub origin follows the request's forwarded
 *      host/proto, NOT the env var; the env var is used only when the request
 *      carries no usable Host.
 *   2. The `callbackUrl` is a CONSTANT, and no client input can reach the
 *      output. This is asserted by construction, not by filtering: the same
 *      request with a hostile `callbackUrl` query produces a byte-identical
 *      result to one with none.
 *   3. That constant is the one spelling the hub honours — checked against the
 *      hub's own login filter, replicated here, AND (when the sibling repo is
 *      present) against the hub's SSO issuer verbatim.
 *   4. `authOptions.pages.signIn` is still a local relative path (source
 *      assertion — the regression would be someone restoring the env template).
 *   5. `middleware.ts`'s page matcher still exempts `/auth/signin`, driven
 *      through the real regex extracted from the file. A gated sign-in route is
 *      an infinite redirect loop.
 *   6. `middleware.ts`'s page gate sends the SAME constant (source assertion).
 *      The gate used to send `/sso`, which the hub's filter refuses outright —
 *      and that failure is SILENT (the hub substitutes `/launcher`, nothing
 *      errors), which is exactly why it needs a test rather than a comment.
 *   7. The page gate's LOOP GUARD. `getToken()` returns null for both "no
 *      cookie" and "a cookie I cannot read", so a callbackUrl the hub HONOURS
 *      is only safe when the absence of a session is certain. No cookie ⇒
 *      callbackUrl; a cookie under either name ⇒ bare /login.
 *
 * No network, no DB, no test framework — same house style as the parser suites,
 * tests/test-sso-authorize.js and tests/test-rbac-scoping.js. The two TS lib
 * files are transpiled on the fly with the frontend's own TypeScript (no new
 * dependency, nothing left behind in src/).
 *
 *   node tests/test-signin-redirect.js      (or: npm run test:signin)
 *
 * HONEST LIMITS:
 *   • Nothing here runs Next.js. That `pages.signIn` is consumed as a relative
 *     URL, and that the route handler is reached, are properties of NextAuth +
 *     the Next router; tests 4/5 assert the two contracts this repo controls.
 *   • The route handler itself (app/auth/signin/route.ts) is not executed — it
 *     imports next/server. It is three lines whose only logic is `hubSigninUrl`,
 *     which IS exercised here.
 *   • Test 3's hub-side half is a REPLICA of the hub's filter, not the hub's
 *     code. The cross-repo check that would catch a drift in the real thing is
 *     skipped when `../net-vault` is absent (a customer box, CI).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');

const checks = [];
function check(name, ok) { checks.push([name, !!ok]); }

// Source assertions below run against COMMENT-STRIPPED source. Both files they
// read carry long explanatory comments that quote the very strings being
// asserted about — the old `${process.env.NOCVAULT_HUB_URL}/login` template, and
// the `/sso` the page gate used to send — so an un-stripped search would find
// the prose and pass (or fail) for the wrong reason. Line comments are only
// stripped where they START a line, which is every comment in both files.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// ── load the TS libs ────────────────────────────────────────────────────────
// Transpiled into frontend/node_modules/.cache so `next build` never sees them
// (same trick tests/test-rbac-scoping.js and tests/test-sso-authorize.js use).
// Both files land in ONE directory as plain .js so hubSignin's
// `require('./publicUrl')` resolves between them.
const ts = require(path.join(FRONTEND, 'node_modules/typescript'));
const OUT_DIR = path.join(FRONTEND, 'node_modules/.cache/spanvault-signin-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

function emit(relSrc, outName) {
  const src = path.join(FRONTEND, relSrc);
  const out = path.join(OUT_DIR, outName);
  fs.writeFileSync(out, ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    fileName: path.basename(relSrc),
  }).outputText);
  return out;
}

// Pin the env var BEFORE requiring, and to a value no real install uses, so a
// test can tell "came from the request" apart from "came from the env var".
const HUB_ENV = 'http://hub-fallback.example.com:3000';
process.env.NOCVAULT_HUB_URL = HUB_ENV;

let hubSignin;
try {
  emit('src/lib/publicUrl.ts', 'publicUrl.js');
  const signinOut = emit('src/lib/hubSignin.ts', 'hubSignin.js');
  hubSignin = require(signinOut);
} finally {
  try { fs.rmSync(OUT_DIR, { recursive: true, force: true }); } catch (_e) {}
}

const { hubSigninUrl, HUB_PORT, HUB_CALLBACK_PATH, SESSION_COOKIE, hasSessionCookie } = hubSignin;
const CB = encodeURIComponent(HUB_CALLBACK_PATH);

// A minimal stand-in for NextRequest: resolveOrigin only reads `headers.get()`
// and `nextUrl.protocol`.
function mkReq(headers, url) {
  const lower = {};
  for (const k of Object.keys(headers || {})) lower[k.toLowerCase()] = headers[k];
  return {
    headers: { get: (k) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) },
    nextUrl: new URL(url || 'https://ignored.example.com/auth/signin'),
  };
}

// The shape production actually serves: a TLS front door that pins the public
// hostname, with this app's own port on the incoming Host.
const PUBLIC_HOST = 'nocvault.example.com';
const fwd = (query) => mkReq(
  { 'x-forwarded-host': `${PUBLIC_HOST}:3008`, 'x-forwarded-proto': 'https',
    host: '127.0.0.1:3008' },
  `https://${PUBLIC_HOST}:3008/auth/signin${query || ''}`
);

// ── 1. the hub origin is request-derived, not env-derived ───────────────────
{
  const url = hubSigninUrl(fwd());
  check('redirects to the FORWARDED public host, not the env var',
    url === `https://${PUBLIC_HOST}:${HUB_PORT}/login?callbackUrl=${CB}`);
  check('the redirect keeps the forwarded scheme (https, not http)', url.startsWith('https://'));
  check('the env-var hub origin does NOT appear in the redirect (this is the bug)',
    url.indexOf('hub-fallback.example.com') === -1);
}
{
  // A plain-http install reached by its own hostname, no proxy headers.
  check('a plain-http install follows its own Host header',
    hubSigninUrl(mkReq({ host: 'nms.example.com:3008' }, 'http://nms.example.com:3008/auth/signin'))
      === `http://nms.example.com:${HUB_PORT}/login?callbackUrl=${CB}`);
}
{
  // No usable Host at all — the one case the env var is for.
  check('with no usable Host, the hub env var IS the fallback',
    hubSigninUrl(mkReq({}, 'https://./auth/signin')) === `${HUB_ENV}/login?callbackUrl=${CB}`);
  check('a Host that fails the hostname-shape check falls back to the env var',
    hubSigninUrl(mkReq({ host: 'not_a*hostname' }, 'https://x.example.com:3008/auth/signin'))
      === `${HUB_ENV}/login?callbackUrl=${CB}`);
}
{
  // ⛔ A hostile Host header DOES make this redirect follow it — identical to
  // the page gate in middleware.ts, and the accepted trade-off for the hostname
  // flexibility resolveOrigin exists to give (gotchas.md: fix the FETCH sinks,
  // not resolveOrigin — this value never reaches a fetch). Pinned so the
  // behaviour is deliberate and visible rather than discovered later, and so
  // the one real guarantee is asserted: whatever the Host carries, the result is
  // an ORIGIN — path/query/credentials junk in the header cannot smuggle
  // anything past the hostname-shape check.
  check('a Host header is used as an origin only, never as a path',
    hubSigninUrl(mkReq({ host: 'attacker.example.net:3008/x?a=b' },
      'https://attacker.example.net:3008/auth/signin'))
      === `https://attacker.example.net:${HUB_PORT}/login?callbackUrl=${CB}`);
}

// ── 2. the callbackUrl is a CONSTANT — no client input reaches the output ───
{
  const baseline = hubSigninUrl(fwd());
  // NextAuth appends its own `callbackUrl` (an absolute URL built from
  // NEXTAUTH_URL's origin) to whatever `pages.signIn` is, and anyone can put
  // anything there by hand. None of it is read: there is no sanitiser to get
  // wrong because the value never enters the flow.
  const hostile = [
    '?callbackUrl=https%3A%2F%2Fevil.example.net%2Fsteal',
    '?callbackUrl=%2F%2Fevil.example.net%2Fsteal',
    '?callbackUrl=javascript%3Aalert(1)',
    '?callbackUrl=%2Fwireless',
    '?callbackUrl=&error=CredentialsSignin',
  ];
  for (const q of hostile) {
    const url = hubSigninUrl(fwd(q));
    check(`a client-supplied callbackUrl changes nothing: ${q.slice(0, 44)}`, url === baseline);
  }
  check('no foreign host can appear in the output (by construction)',
    hostile.every((q) => hubSigninUrl(fwd(q)).indexOf('evil.example.net') === -1));
  check('the callbackUrl is exactly the hub SSO-issuer path',
    new URL(baseline).searchParams.get('callbackUrl') === '/api/sso/spanvault');
  check('it is spelled on the wire the way the hub spells it',
    baseline.endsWith('/login?callbackUrl=%2Fapi%2Fsso%2Fspanvault'));
}

// ── 3. the hub actually honours that spelling ───────────────────────────────
{
  // The hub's login page (net-vault/app/(auth)/login/page.tsx), replicated: it
  // honours ONLY a same-origin relative target and falls back to /launcher.
  const hubHonours = (raw) => raw.startsWith('/') && !raw.startsWith('//') &&
    !raw.startsWith('/sso') && !raw.startsWith('/login');
  check('the hub honours our callbackUrl', hubHonours(HUB_CALLBACK_PATH) === true);
  // Why `/sso` is called out specifically: it is what BOTH senders used to get
  // wrong — `middleware.ts`'s page gate sent `callbackUrl=%2Fsso` until 1.121.2,
  // and it is the obvious-looking value for anyone "simplifying" this constant
  // back to a SpanVault path. This filter is the reason the constant is a HUB
  // path: the hub refuses `/sso` and substitutes `/launcher` without erroring,
  // so the mistake costs the user a click and announces nothing. Section 6
  // asserts the gate itself; this asserts why it matters.
  check('the hub REFUSES /sso, which is why the constant is a hub path',
    hubHonours('/sso') === false);
  check('an absolute callbackUrl would have been discarded by the hub',
    hubHonours('https://nocvault.example.com:3008/wireless') === false);

  // Cross-repo: the hub's own SSO issuer redirects with this exact string when
  // hit without a session. Skipped when the sibling repo isn't checked out.
  const issuer = path.join(ROOT, '../net-vault/app/api/sso/spanvault/route.ts');
  if (fs.existsSync(issuer)) {
    check('matches the hub SSO issuer\'s own spelling, verbatim',
      fs.readFileSync(issuer, 'utf8').indexOf(`/login?callbackUrl=${CB}`) !== -1);
  } else {
    console.log('SKIP — hub SSO issuer not checked out (../net-vault absent)');
  }
}

// ── 4. pages.signIn is a LOCAL RELATIVE path ────────────────────────────────
{
  // Comments are stripped first (see stripComments): the block carries a long
  // explanatory comment that quotes the old
  // `${process.env.NOCVAULT_HUB_URL}/login` template, whose own braces would end
  // the match early and whose text would defeat the env-var assertion below.
  const src = stripComments(fs.readFileSync(path.join(FRONTEND, 'src/lib/auth.ts'), 'utf8'));
  const m = src.match(/pages:\s*\{[\s\S]*?\}/);
  const pages = m ? m[0] : '';
  check('authOptions declares a pages.signIn', /signIn:/.test(pages));
  check('pages.signIn is the local relative route', /signIn:\s*'\/auth\/signin'/.test(pages));
  check('pages.signIn does NOT read NOCVAULT_HUB_URL (frozen at module load)',
    pages.indexOf('NOCVAULT_HUB_URL') === -1);
}

// ── 5. the sign-in route is NOT gated and NOT proxied ───────────────────────
{
  const src = fs.readFileSync(path.join(FRONTEND, 'src/middleware.ts'), 'utf8');
  const matchers = (src.match(/matcher:\s*\[([\s\S]*?)\]/) || [, ''])[1]
    .split('\n').map((l) => (l.match(/'([^']+)'/) || [, ''])[1]).filter(Boolean);
  check('two matchers found in middleware.ts', matchers.length === 2);

  const apiMatcher = matchers.find((p) => p.startsWith('/api/'));
  const pageMatcher = matchers.find((p) => !p.startsWith('/api/'));
  const hits = (p, s) => new RegExp('^' + p + '$').test(s);

  check('/auth/signin is NOT matched by the API proxy branch',
    !hits(apiMatcher, '/auth/signin'));
  check('/auth/signin is NOT matched by the page gate (a gated one loops forever)',
    !hits(pageMatcher, '/auth/signin'));
  // The exemption must be surgical, not a blanket /auth escape hatch.
  check('an ordinary page IS still matched by the page gate', hits(pageMatcher, '/dashboard'));
  check('a nested ordinary page IS still matched', hits(pageMatcher, '/wireless/aps/7'));
  check('the pre-fix matcher DID gate /auth/signin (this was the loop)',
    hits('/((?!api|sso|maps/public|_next/static|_next/image|favicon.ico).*)', '/auth/signin'));

  // The route file must stay outside app/api/** — middleware rewrites every
  // /api/* except /api/auth/* to Express, so a handler there is dead code.
  check('the route handler lives at app/auth/signin/route.ts, outside app/api/**',
    fs.existsSync(path.join(FRONTEND, 'src/app/auth/signin/route.ts')) &&
    !fs.existsSync(path.join(FRONTEND, 'src/app/api/auth/signin/route.ts')));
}

// ── 6. the page gate sends the SAME hub-honoured constant ───────────────────
{
  // ⛔ WHY THIS NEEDS A TEST AND NOT A COMMENT. `middleware.ts`'s page gate —
  // the OTHER place that redirects a browser to the hub login — used to send
  // `callbackUrl=encodeURIComponent('/sso')`. The hub's login page refuses
  // anything starting `/sso` (replicated in section 3) and silently substitutes
  // `/launcher`: nothing errors, nothing logs, the user simply lands on the
  // launcher and has to click SpanVault again. A failure with no error anywhere
  // is exactly the kind that survives for releases, and it is invisible to every
  // other check in this file — sections 1-3 exercise `hubSigninUrl`, which is a
  // different sender. Both must send the shared constant or they drift apart,
  // and only one of them would be caught.
  const src = stripComments(fs.readFileSync(path.join(FRONTEND, 'src/middleware.ts'), 'utf8'));

  check('the gate imports HUB_CALLBACK_PATH from the shared module',
    /import\s*\{[^}]*\bHUB_CALLBACK_PATH\b[^}]*\}\s*from\s*'@\/lib\/hubSignin'/.test(src));
  check('the gate builds its callbackUrl from HUB_CALLBACK_PATH',
    /encodeURIComponent\(\s*HUB_CALLBACK_PATH\s*\)/.test(src));
  check('the gate does NOT send /sso (the hub refuses it, silently, to /launcher)',
    !/encodeURIComponent\(\s*['"`]\/sso['"`]\s*\)/.test(src));
  // Belt-and-braces: catch an inlined pre-encoded literal too, which neither of
  // the two assertions above would see.
  check('the gate does not hardcode a pre-encoded /sso callbackUrl',
    !/callbackUrl=%2Fsso(?![a-zA-Z0-9])/i.test(src));
  // And that the constant it imported is actually the one it interpolates into
  // the redirect, rather than being imported and then ignored.
  check('the gate\'s hub-login redirect interpolates that callbackUrl',
    /\/login\?callbackUrl=\$\{CALLBACK\}/.test(src) &&
    /const\s+CALLBACK\s*=\s*encodeURIComponent\(\s*HUB_CALLBACK_PATH\s*\)/.test(src));
}

// ── 7. the loop guard on the page gate ──────────────────────────────────────
{
  // ⛔ WHAT THIS PROTECTS. `getToken()` returns null for BOTH "no session
  // cookie" and "a cookie I cannot read" (a name/flag divergence between the
  // writer and the reader, or a rotated NEXTAUTH_SECRET). Attaching a callbackUrl
  // the hub HONOURS in the second case is an infinite redirect with no hop
  // counter on either side — gate → hub → token → /sso sets a cookie → the gate
  // still cannot read it → hub → ERR_TOO_MANY_REDIRECTS. It was latent while the
  // callbackUrl was `/sso`, because the hub refused that and the cycle stopped
  // at /launcher by accident; section 6's fix removed the accident.
  //
  // Driven through the gate's REAL source, with the cookie names next-auth
  // actually uses. Pure string/AST-free assertions, like sections 4-6: the
  // middleware itself imports next/server and cannot be required here.
  const src = stripComments(fs.readFileSync(path.join(FRONTEND, 'src/middleware.ts'), 'utf8'));

  // ── the predicate itself, as BEHAVIOUR ────────────────────────────────────
  // hasSessionCookie is a pure function over cookie NAMES (that is why it lives
  // in lib/hubSignin and not inline in the middleware), so this is a real unit
  // test rather than a regex over source.
  check('no cookies at all ⇒ no session ⇒ the callbackUrl is safe to send',
    hasSessionCookie([]) === false);
  check('the BARE session cookie is detected',
    hasSessionCookie(['next-auth.session-token']) === true);
  check('the __Secure- prefixed session cookie is detected',
    hasSessionCookie(['__Secure-next-auth.session-token']) === true);

  // ⛔ THE CHUNKED FORMS. next-auth splits a >4096-byte session into
  // `<name>.0`, `<name>.1`, … and writes NO un-suffixed name (SessionStore's
  // #chunk() in next-auth/core/lib/cookie.js), while getToken() reassembles
  // them. So `cookies.has('<name>')` is FALSE for a session getToken() can
  // read — and a chunked-and-unreadable session would fall straight back into
  // the loop this guard exists to stop. A large `apps` claim or a long group
  // membership is what pushes a JWT past 4096 bytes, so it is reachable.
  check('a CHUNKED session cookie is detected (.0/.1, no un-suffixed name)',
    hasSessionCookie(['next-auth.session-token.0', 'next-auth.session-token.1']) === true);
  check('a chunked __Secure- session cookie is detected',
    hasSessionCookie(['__Secure-next-auth.session-token.0']) === true);
  check('a high chunk index is detected too (not just .0/.1)',
    hasSessionCookie(['next-auth.session-token.17']) === true);

  // Not over-broad: next-auth's OTHER cookies, and a name that merely begins
  // with ours, must not read as a session.
  check('next-auth\'s other cookies do NOT count as a session',
    hasSessionCookie(['next-auth.csrf-token', 'next-auth.callback-url',
      'next-auth.pkce.code_verifier', 'next-auth.state', 'theme']) === false);
  check('a name merely PREFIXED by ours is not a chunk of ours',
    hasSessionCookie(['next-auth.session-tokenfoo']) === false);

  // The default name is only correct while authOptions overrides no `cookies`
  // block — next-auth prefixes its DEFAULTS only, and a literal override is
  // used verbatim by writer and reader alike (LogVault does exactly that). If
  // someone adds one here, this is what says the guard now reads a dead name.
  const authSrc = stripComments(fs.readFileSync(path.join(FRONTEND, 'src/lib/auth.ts'), 'utf8'));
  check('lib/auth.ts still configures NO custom cookie name (so defaults apply)',
    !/\bcookies\s*:/.test(authSrc));
  // `useSecureCookies` matters for the same reason: it is one of the two
  // independent inputs to the write-side prefix decision
  // (core/init.js:60 `authOptions.useSecureCookies ?? url.base…`), and setting
  // it alone can make the written name disagree with the one getToken() reads
  // (jwt/index.js:65 consults NEXTAUTH_URL/VERCEL only, never this).
  check('lib/auth.ts sets NO useSecureCookies (both base names stay in play)',
    !/useSecureCookies/.test(authSrc));
  check('the shared constant is next-auth\'s default session-cookie name',
    SESSION_COOKIE === 'next-auth.session-token');

  // ── and that the gate actually uses it, over NAMES ────────────────────────
  check('the gate calls hasSessionCookie, not cookies.has',
    /hasSessionCookie\(\s*req\.cookies\.getAll\(\)\.map\(\s*\(c\)\s*=>\s*c\.name\s*\)\s*\)/.test(src) &&
    !/req\.cookies\.has\(/.test(src));

  // The behaviour itself: cookie present ⇒ bare /login; otherwise ⇒ callbackUrl.
  // Asserted on the ORDER of the two returns, which is what makes it a guard
  // rather than two unrelated branches.
  //
  // The guard's redirect target is captured as the whole template literal and
  // compared EXACTLY, so "no callbackUrl" is proven by the string being nothing
  // but the origin and `/login` — not by a substring search that a reordering
  // could satisfy. (Delimiting on backticks matters: a `[\s\S]*?\}` body match
  // stops at `${hub}`'s own closing brace, which is how the first draft of this
  // assertion failed against correct code.)
  const guardReturn = src.match(
    /if\s*\(\s*hasSessionCookie\([\s\S]*?\)\s*\)\s*\{\s*return\s+NextResponse\.redirect\(\s*`([^`]*)`\s*\)\s*;?\s*\}/
  );
  check('a readable-cookie-less session still gets the full return address',
    /\/login\?callbackUrl=\$\{CALLBACK\}/.test(src));
  check('an UNREADABLE cookie gets a bare /login with NO callbackUrl (no loop)',
    !!guardReturn && guardReturn[1] === '${hub}/login');
  check('the guard returns BEFORE the callbackUrl form is reached',
    !!guardReturn && guardReturn.index < src.indexOf('/login?callbackUrl=${CALLBACK}'));

  // ── the /api/* branch needs no guard, CONFIRMED not assumed ───────────────
  // It shares the same `!token` ambiguity, but a JSON 401 is TERMINAL: it sends
  // the caller nowhere, so an unreadable session surfaces as a failed fetch
  // rather than a loop. Nothing on the client turns it into a navigation either
  // (lib/api.ts throws on !res.ok; the only login navigations in the app are
  // IdleTimeout's idle logout and the /sso page's manual link) — asserted
  // below so adding such a handler has to come past this test.
  //
  // The branch is isolated and checked for the ABSENCE of a redirect, which is
  // the actual safety property — "it returns a 401" alone would still pass if
  // someone added a redirect above it.
  const apiBranch = src.slice(
    src.indexOf("pathname.startsWith('/api/')"),
    src.indexOf('// Public map view pages') > 0
      ? src.indexOf('// Public map view pages')
      : src.indexOf("pathname.startsWith('/maps/public/')")
  );
  check('the /api/* branch was located for inspection', apiBranch.length > 200);
  check('the /api/* branch answers 401 JSON (terminal, sends the caller nowhere)',
    /return\s+NextResponse\.json\(\s*\{\s*error:\s*'Unauthorized'\s*\}\s*,\s*\{\s*status:\s*401\s*\}\s*\)/
      .test(apiBranch));
  check('the /api/* branch contains NO redirect at all (so it cannot loop)',
    apiBranch.indexOf('NextResponse.redirect') === -1);
  check('no client code turns a 401 into a hub-login navigation',
    !/\.status\s*===\s*401[\s\S]{0,200}(location|router\.(push|replace))/i
      .test(fs.readFileSync(path.join(FRONTEND, 'src/lib/api.ts'), 'utf8')));
}

let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) fail++;
}
console.log(`\n${checks.length - fail}/${checks.length} passed`);
process.exit(fail ? 1 : 0);

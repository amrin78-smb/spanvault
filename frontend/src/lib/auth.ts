import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { verify } from 'jsonwebtoken';
import { Pool } from 'pg';

/**
 * SpanVault has NO login UI. Authentication is delegated to the NocVault hub:
 *   - Unauthenticated requests redirect to HUB/login?callbackUrl=/sso
 *   - The hub redirects back to /sso?token=xxx after a successful login
 *   - /sso verifies the token with the hub, then calls signIn('credentials', { ssoToken })
 *
 * The SSO token is a JWT signed with the shared NEXTAUTH_SECRET, so we can verify
 * it locally without another round-trip.
 *
 * SECURITY — a valid signature is NOT proof of a valid SSO token. NEXTAUTH_SECRET
 * is shared across the whole suite and is also the signing key for the remote
 * agents' data-plane JWTs (see `api/agent-identity.js`). Everything the session
 * is trusted with therefore has to come from claims we have positively
 * identified as hub-SSO claims, plus the NetVault users row — never from the
 * request body. See `authorizeSsoToken` below.
 */

// NetVault DB (read-only) — the authoritative source for a user's role, display
// name and site assignments.
const netvaultPool = new Pool({
  host: process.env.NETVAULT_DB_HOST || 'localhost',
  port: parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user: process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  ssl: false,
});

/**
 * Minimal query surface used by the SSO authorize path. Production always runs
 * on the real read-only pool; `tests/test-sso-authorize.js` injects a stub so
 * the token-trust rules can be unit-tested with no database.
 */
export type NetvaultQuery = (sql: string, params: any[]) => Promise<{ rows: any[] }>;

const defaultQuery: NetvaultQuery = (sql, params) => netvaultPool.query(sql, params);

/**
 * The `app` claim the hub stamps into a SpanVault SSO token
 * (`net-vault/app/api/sso/spanvault/route.ts`). Tokens minted for a sibling app
 * — or for anything that is not an SSO token at all — must not be accepted here.
 */
const APP_SLUG = 'spanvault';

/** Roles NetVault issues. Used only to sanity-check a token's own role claim. */
const KNOWN_ROLES = ['viewer', 'site_admin', 'admin', 'super_admin'];

/**
 * Resolve which suite apps this user may access (per-user app-access, Phase 2).
 * Mirrors NetVault's getUserApps semantics so the two stay in lockstep:
 *   - super_admin        → all apps
 *   - no user_apps rows  → all apps (legacy / default-all)
 *   - otherwise          → the explicit set stored in netvault.user_apps
 * Fails OPEN (returns []) on any error so a transient DB problem or an older
 * NetVault schema without user_apps never locks a user out of SpanVault.
 * An empty array is treated as "default-all" by the middleware gate.
 */
async function resolveUserApps(
  userId: string,
  role: string,
  query: NetvaultQuery = defaultQuery
): Promise<string[]> {
  if (role === 'super_admin') return ['netvault', 'logvault', 'ddivault', 'spanvault'];
  const id = parseInt(userId, 10);
  if (!Number.isFinite(id)) return [];
  try {
    const r = await query('SELECT app FROM user_apps WHERE user_id = $1', [id]);
    if (r.rows.length === 0) return []; // default-all
    return r.rows.map((row) => row.app as string);
  } catch {
    return []; // fail open — never lock out on a transient error
  }
}

/** The session subject SpanVault mints from a hub SSO token. */
export interface SsoUser {
  id: string;
  email: string;
  name: string;
  role: string;
  sites: number[];
  apps: string[];
}

/**
 * Verify a hub SSO token and build the session subject from it.
 *
 * Exported (rather than inlined in the provider) purely so it can be tested
 * with a stubbed NetVault query — the NextAuth config shape is unchanged.
 *
 * NOTE ON `credentials`: in next-auth v4 the `credentials` argument handed to
 * `authorize()` is the raw POST body, NOT a filtered copy of the provider's
 * declared `credentials` fields. Removing a field from that declaration does
 * not stop a caller sending it. So this function must read NOTHING from
 * `credentials` except `ssoToken`, and it deliberately does not.
 */
export async function authorizeSsoToken(
  credentials: Record<string, any> | null | undefined,
  deps: { query?: NetvaultQuery; secret?: string } = {}
): Promise<SsoUser | null> {
  const query = deps.query || defaultQuery;
  const secret = deps.secret ?? (process.env.NEXTAUTH_SECRET as string);
  const ssoToken =
    credentials && typeof credentials.ssoToken === 'string' ? credentials.ssoToken : '';
  if (!ssoToken || !secret) return null;

  let payload: any;
  try {
    // Pin HS256. The secret is symmetric and suite-shared, so an unpinned
    // verify leaves algorithm confusion on the table for no benefit — the hub
    // only ever signs HS256. Same shape as api/agent-identity.js's
    // verifyHubAgentJwt().
    payload = verify(ssoToken, secret, { algorithms: ['HS256'] }) as any;
  } catch {
    return null; // bad signature, wrong alg, expired, malformed
  }
  if (!payload || typeof payload !== 'object') return null;

  // ── Token-TYPE gate (the privilege-escalation fix) ───────────────────────
  // A signature check alone says only "something holding NEXTAUTH_SECRET
  // produced this" — not "the hub produced this as a SpanVault login". The
  // same secret signs the remote agents' data-plane JWTs
  // ({ sub: 'agt_…', typ: 'agent', aud, iat, exp } — see api/agent-identity.js),
  // and that token is on disk on every agent host by design. Replayed here as
  // `ssoToken` it verified cleanly, carried no `role`, and so let the POST
  // body's own `role` string become the session role → `x-user-role:
  // super_admin` → full SpanVault admin.
  //
  // The hub mints a SpanVault SSO token as
  // { userId, email, role, name, app: 'spanvault', apps } with a 2m expiry
  // (net-vault/app/api/sso/spanvault/route.ts). Requiring `userId` AND
  // `app === 'spanvault'` accepts exactly that and rejects an agent token
  // (no `userId`, no `app`) and a sibling app's token (`app` mismatch),
  // with no change needed on the hub side.
  if (payload.typ === 'agent') return null;
  if (payload.userId === undefined || payload.userId === null || payload.userId === '') {
    return null;
  }
  if (payload.app !== APP_SLUG) return null;

  const userId = String(payload.userId);
  const tokenEmail = typeof payload.email === 'string' ? payload.email : '';
  // Look the user up by the VERIFIED token id ONLY. This lookup used to also
  // match on `credentials.email`; now that the DB row decides the role, letting
  // the request body choose which row is read would just move the escalation
  // one step along. `id::text` keeps both NetVault id variants working (SERIAL
  // installs and UUID-variant installs).
  //
  // ⛔ "NO SUCH ROW" AND "THE QUERY FAILED" ARE DIFFERENT ANSWERS, and the role
  // fallback below must only ever apply to the second. A zero-row result is
  // definitive — this user does not exist in NetVault — so the login is
  // refused. LogVault's reference implementation
  // (logvault/frontend/src/auth.ts) refuses a no-row user for the same reason.
  //
  // ⚠ CORRECTED (hub net-vault 1.63.0). This comment used to justify the check
  // by saying the hub "reads the session with getToken() on a JWT that has NO
  // maxAge (30-day next-auth default) and re-resolves the role only for Entra
  // users". BOTH HALVES ARE NOW FALSE: the hub bounds its session at 12h, sets
  // jwt.maxAge as well as session.maxAge, re-resolves the role from `users` on
  // every token use for local accounts too, clears the role when the account's
  // row is gone, and refuses a cleared-role session at all three handoffs. So a
  // deleted user's stale token is now also stopped upstream.
  //
  // The check stays anyway, and not out of inertia: it is the half of the
  // defence that lives in THIS repo. The reason this suite keeps re-finding
  // this bug class is that each app trusted the one next to it to get it right.
  let dbUser: { id?: number | string; name?: string; email?: string; role?: string } = {};
  let lookupFailed = false;
  try {
    const r = await query(
      `SELECT id, name, email, role FROM users WHERE id::text = $1 LIMIT 1`,
      [userId]
    );
    if (r.rows.length === 0) return null; // definitively not a NetVault user
    dbUser = r.rows[0] || {};
  } catch {
    // Transient cross-DB failure — fall through to the token-claim fallback so
    // a NetVault DB blip does not lock the whole app out.
    lookupFailed = true;
  }

  const email = dbUser.email || tokenEmail;
  const tokenName = typeof payload.name === 'string' ? payload.name : '';
  // Display name only — no authorization rides on it.
  const userName = dbUser.name || tokenName || (email ? email.split('@')[0] : '');

  // ── Role resolution ──────────────────────────────────────────────────────
  // The NetVault users row wins outright. The token's own `role` claim is only
  // a fallback for the case where the cross-DB read FAILED (a zero-row result
  // has already returned null above) — deliberate: the claim IS hub-signed, so
  // it is trustworthy input,
  // but it is also a 2-minute-old snapshot. If the hub demotes a super_admin
  // while their SSO token is still in flight, the live DB row is the correct
  // answer and the claim is stale, so the claim must never be able to override
  // it. Keeping the claim as a fallback preserves the existing behaviour that a
  // transient NetVault DB blip does not lock everyone out (consistent with
  // resolveUserApps' documented fail-open), rather than hard-failing the login
  // the way logvault's reference implementation does.
  //
  // `credentials.role` is NOT in this chain and must never be re-added: it is
  // an attacker-controlled POST field. That is the whole bug this file is being
  // fixed for.
  const claimRole =
    typeof payload.role === 'string' && KNOWN_ROLES.includes(payload.role) ? payload.role : '';
  // The claim is reachable ONLY on the transient-failure path (a zero-row
  // result already returned null above).
  const userRole = dbUser.role || (lookupFailed ? claimRole : '') || 'viewer';

  // Prefer the DB row's own id; fall back to the verified token id.
  const id = dbUser.id != null ? String(dbUser.id) : userId;

  // Site assignments scope a site_admin to their sites. Looked up from the
  // NetVault user_sites table; admin/viewer are unscoped (empty). `id` is now
  // always either the DB row's id or the verified token claim — never a value
  // taken from the request body.
  let userSites: number[] = [];
  if (userRole === 'site_admin' && id) {
    try {
      const sitesResult = await query('SELECT site_id FROM user_sites WHERE user_id = $1', [id]);
      userSites = sitesResult.rows
        .map((r) => parseInt(r.site_id, 10))
        .filter((n) => Number.isFinite(n));
    } catch {
      // best effort — an unscoped site_admin simply sees no sites
    }
  }

  // Per-user app-access set (fail-open) so middleware can gate SpanVault.
  const apps = await resolveUserApps(id, userRole, query);

  return { id, email, name: userName, role: userRole, sites: userSites, apps };
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: 'jwt' },
  pages: {
    signIn: `${process.env.NOCVAULT_HUB_URL || 'http://localhost:3000'}/login`,
  },
  providers: [
    CredentialsProvider({
      name: 'SpanVault',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        ssoToken: { label: 'SSO Token', type: 'text' },
        // No `name`/`role`/`userId` fields: the /sso page used to forward the
        // hub's sso-verify profile here and authorize() trusted it, which made
        // the session role a client-supplied string. Identity now comes from the
        // signed token plus the NetVault users row only.
      },
      async authorize(credentials) {
        if (!credentials) return null;
        if (credentials.ssoToken) return authorizeSsoToken(credentials);
        // Direct credentials are not supported — SpanVault has no login UI.
        return null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }: any) {
      if (user) {
        token.role = user.role;
        token.id = user.id;
        token.name = user.name;
        token.email = user.email;
        token.sites = (user as any).sites || [];
        token.apps = (user as any).apps || [];
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.role = token.role;
        session.user.id = token.id;
        session.user.name = token.name;
        session.user.email = token.email;
        (session.user as any).sites = token.sites || [];
        (session.user as any).apps = token.apps || [];
      }
      return session;
    },
  },
};

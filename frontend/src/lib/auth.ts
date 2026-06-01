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
 */

// NetVault DB (read-only) — used to look up the user's display name when the
// SSO token payload omits it (the hub does not always include `name`).
const netvaultPool = new Pool({
  host: process.env.NETVAULT_DB_HOST || 'localhost',
  port: parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user: process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  ssl: false,
});
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
        // Profile fields the /sso page forwards from the hub's sso-verify
        // response — authoritative even when the raw JWT omits them.
        name: { label: 'Name', type: 'text' },
        role: { label: 'Role', type: 'text' },
        userId: { label: 'User ID', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials) return null;
        if (credentials.ssoToken) {
          try {
            // Verify the JWT (signed with the shared NEXTAUTH_SECRET) for trust.
            const payload = verify(
              credentials.ssoToken,
              process.env.NEXTAUTH_SECRET as string
            ) as any;

            // Resolve email + id from whichever source has them: the verified
            // JWT payload, or the sso-verify profile the /sso page forwarded.
            const tokenEmail = payload.email || credentials.email || '';
            const userId = String(
              payload.userId || payload.sub || credentials.userId || ''
            );

            // The hub's SSO JWT often omits `name`/`role` (and sometimes the
            // email), so look the user up in the NetVault users table. Match by
            // email case-insensitively, or by id when no email is in the token —
            // so we can recover the real name even from an id-only token.
            let dbUser: { id?: number; name?: string; email?: string; role?: string } = {};
            if (tokenEmail || userId) {
              try {
                const r = await netvaultPool.query(
                  `SELECT id, name, email, role FROM users
                    WHERE ($1 <> '' AND LOWER(email) = LOWER($1))
                       OR ($2 <> '' AND id::text = $2)
                    LIMIT 1`,
                  [tokenEmail, userId]
                );
                dbUser = r.rows[0] || {};
              } catch {
                // Best-effort — fall through to the fallbacks below.
              }
            }

            const email = tokenEmail || dbUser.email || '';
            const userName =
              payload.name ||
              credentials.name ||
              dbUser.name ||
              (email ? email.split('@')[0] : '');
            const userRole = payload.role || credentials.role || dbUser.role || 'viewer';
            const id = userId || (dbUser.id != null ? String(dbUser.id) : '');

            return { id, email, name: userName, role: userRole };
          } catch {
            return null;
          }
        }
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
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.role = token.role;
        session.user.id = token.id;
        session.user.name = token.name;
        session.user.email = token.email;
      }
      return session;
    },
  },
};

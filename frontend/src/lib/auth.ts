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
      },
      async authorize(credentials) {
        if (!credentials) return null;
        if (credentials.ssoToken) {
          try {
            const payload = verify(
              credentials.ssoToken,
              process.env.NEXTAUTH_SECRET as string
            ) as any;
            // The hub's SSO payload often omits `name` (and sometimes `role`),
            // so look both up from the NetVault users table by email. Fall back
            // to the email local-part for the name and 'viewer' for the role, so
            // the top bar always has a real name to show.
            let dbUser: { name?: string; role?: string } = {};
            if (payload.email) {
              try {
                const r = await netvaultPool.query(
                  'SELECT name, role FROM users WHERE email = $1',
                  [payload.email]
                );
                dbUser = r.rows[0] || {};
              } catch {
                // Best-effort — fall through to the fallbacks below.
              }
            }
            const userName =
              payload.name ||
              dbUser.name ||
              (payload.email ? String(payload.email).split('@')[0] : '');
            const userRole = payload.role || dbUser.role || 'viewer';
            return {
              id: String(payload.userId),
              email: payload.email,
              name: userName,
              role: userRole,
            };
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

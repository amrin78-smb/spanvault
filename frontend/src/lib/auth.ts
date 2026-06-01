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
            // The hub's SSO payload may omit `name`. Fall back to the NetVault
            // users table (by email), then to the email local-part, so the top
            // bar never has to show a generic placeholder.
            let dbName: string | undefined;
            if ((!payload.name || !String(payload.name).trim()) && payload.email) {
              try {
                const r = await netvaultPool.query(
                  'SELECT name FROM users WHERE email = $1',
                  [payload.email]
                );
                dbName = r.rows[0]?.name;
              } catch {
                // Best-effort — fall through to the email local-part below.
              }
            }
            const userName =
              payload.name ||
              dbName ||
              (payload.email ? String(payload.email).split('@')[0] : '');
            return {
              id: String(payload.userId),
              email: payload.email,
              name: userName,
              role: payload.role,
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

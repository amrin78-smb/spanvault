'use strict';

/**
 * agent-identity.js — verify a hub-signed agent JWT on SpanVault's data plane.
 *
 * Phase 3 (identity reconciliation): the NocVault hub (NetVault) issues each
 * agent a durable, HS256-signed JWT with the suite-shared NEXTAUTH_SECRET — the
 * same trust root SSO already uses. SpanVault verifies that signature to accept
 * an agent's WebSocket data tunnel instead of minting/checking its own api_key.
 *
 * This is a faithful, dependency-free port of the hub's `verifyAgentIdentity`
 * (netvault/lib/agentIdentity.ts) — kept ~identical so DDIVault/LogVault can copy
 * it verbatim when they gain the same data plane. Reuses the existing
 * `jsonwebtoken` dep; adds NO new dependency.
 *
 * Contract (must match the hub exactly):
 *   Claims: { sub: <hub agent id "agt_…">, typ: 'agent',
 *             aud: <string|string[] of module slugs>, iat, exp }
 *   - HS256, signed with process.env.NEXTAUTH_SECRET.
 *   - REQUIRE typ === 'agent' and sub present.
 *   - `aud` is the module list (normalised to an array).
 *   - Returns null on ANY failure (bad sig, wrong typ, expired, missing sub).
 *
 * Plain JavaScript only — no TypeScript syntax.
 */

const jwt = require('jsonwebtoken');

// Verify signature + typ + expiry. Returns { agentId, modules } or null.
function verifyHubAgentJwt(token) {
  if (!token) return null;
  try {
    // Pin HS256 so a hub-symmetric secret can never be tricked into accepting a
    // different algorithm (defence-in-depth; the hub only ever signs HS256).
    const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET, {
      algorithms: ['HS256'],
    });
    if (!decoded || decoded.typ !== 'agent' || !decoded.sub) return null;
    const aud = decoded.aud;
    const modules = Array.isArray(aud) ? aud : (aud ? [aud] : []);
    return { agentId: decoded.sub, modules };
  } catch (_e) {
    return null;
  }
}

module.exports = { verifyHubAgentJwt };

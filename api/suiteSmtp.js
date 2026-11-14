'use strict';

/**
 * suiteSmtp.js — resolve which SMTP transport SpanVault should send through.
 *
 * Phase 2 of the suite SMTP centralization (see
 * `../../net-vault/docs/nocvault-smtp-centralization-plan.md`, §3 and §5).
 *
 * The NocVault hub (NetVault) owns a single `smtp_config` row in the `netvault`
 * database. When that row is ENABLED and has a host, every satellite sends
 * through it; otherwise each satellite keeps using its own local
 * `app_settings` values exactly as before. Precedence is what makes the
 * migration non-breaking: an install whose hub has no SMTP row — or whose hub
 * predates the table entirely — behaves exactly as it did yesterday, with zero
 * admin action.
 *
 * ── What is shared and what is NOT ──────────────────────────────────────────
 * Shared (hub-owned): host, port, secure, username, password.
 * LOCAL, always:      the From identity (`smtp_from`), recipients,
 *                     notification routes, cooldowns, escalation, templates.
 * "SpanVault Alerts" in a recipient's inbox is a feature, not drift — so the
 * caller's own `from` wins over the hub's `from_email`, which is only used as a
 * fallback when SpanVault has no From address of its own configured.
 *
 * ── ⛔ FAIL SOFT. NEVER THROW. ──────────────────────────────────────────────
 * This module is required by `collector/collector.js`, which is SpanVault's
 * entire polling engine. A throw here — at require() time or on a send — would
 * stop ICMP/SNMP polling, alerting and discovery over a *mail* setting. So:
 *
 *   - Nothing throws at module load. The pool is built lazily, inside a
 *     try/catch, on first use.
 *   - `resolveSmtp()` never rejects. Every failure path returns the caller's
 *     own local config with `source: 'local'`.
 *   - Every distinct failure warns exactly ONCE per process (a 5-minute cache
 *     means up to ~288 retries a day; one line each is a signal, 288 is noise).
 *
 * The failures that fall back, all of them silent-but-working rather than loud:
 *   1. `NEXTAUTH_SECRET` is not set        → cannot decrypt → local.
 *   2. Postgres 42P01 `undefined_table`    → a hub that has not been updated to
 *      netvault 1.65.1+ yet. This WILL happen in the field and is not an error
 *      worth alarming an operator about → local.
 *   3. Any other query / connection error  → local.
 *   4. The stored password will not decrypt (wrong NEXTAUTH_SECRET, tampered or
 *      truncated value) → local, because sending with a blank password against
 *      a host that requires auth fails anyway, and local creds might work.
 *   5. No row / `enabled = false` / empty host → local. NOT a failure: that is
 *      simply an install that has not opted in. No warning.
 *
 * ── Encryption contract ─────────────────────────────────────────────────────
 * `smtp_config.password` is AES-256-GCM, stored as
 * `${ivHex}:${authTagHex}:${ciphertextHex}` with a 12-byte IV and the key
 * derived as `sha256(NEXTAUTH_SECRET)` — a plain digest, not HKDF.
 *
 * ⛔ This is byte-identical to `ddivault/collector/credStore.js` and to
 * NetVault's `lib/credStore.ts`, and it must stay that way. The password is
 * written by the hub and read here; changing the format, the IV length or the
 * key derivation on either side silently breaks every satellite's mail. It is
 * duplicated per-repo rather than shared because these are four independent
 * apps with no shared-code mechanism — the same decision recorded for
 * `resolveOrigin`.
 *
 * `NEXTAUTH_SECRET` is the same value in all four apps (it is the SSO signing
 * secret), so this encryption defends against a DB dump and against the
 * readonly diagnostic roles — NOT against a sibling app. Do not reason about it
 * as app isolation.
 *
 * Plain JavaScript only — this file is loaded by both `api/server.js` and
 * `collector/collector.js`.
 */

const crypto = require('crypto');
const { Pool } = require('pg');

// How long a hub lookup (success OR failure) is reused. SpanVault previously
// had no cache at all on this path — `getSmtpSettings()` queried on every
// single send. Caching the failure matters as much as caching the success: a
// hub without the table must not be re-queried once per alert email.
const CACHE_MS = 5 * 60 * 1000;

const ALGORITHM = 'aes-256-gcm';

// ── One-shot warnings ─────────────────────────────────────────
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[suiteSmtp] ${message}`);
}

// ── Lazy netvault pool ────────────────────────────────────────
// Its OWN small pool rather than the `nv` pool api/server.js and the collector
// already hold: the timeouts here are deliberately short (a mail setting must
// never stall a send for 30s), and those are the wrong timeouts for the device
// /site sync queries that share the other pool.
let pool = null;

// ⛔ NO PERMANENT "could not build a pool" LATCH. There used to be a
// `poolFailed` flag set in the catch below and never cleared, so one failed
// construction pinned this process to local SMTP until the service was
// restarted — days, on a box nobody reboots. `new Pool()` does not connect, so
// the only way it throws is a bad option object, which a later call is no more
// likely to survive; but "no more likely" is not "impossible", and the cost of
// retrying is one object allocation against a 5-minute cache. `warnOnce` is
// what keeps the log quiet, which is all the latch was really buying.
function getPool(injected) {
  if (injected) return injected;
  if (pool) return pool;
  try {
    pool = new Pool({
      host: process.env.NETVAULT_DB_HOST || 'localhost',
      port: parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
      database: process.env.NETVAULT_DB_NAME || 'netvault',
      user: process.env.NETVAULT_DB_USER || 'netvault',
      password: process.env.NETVAULT_DB_PASS || '',
      ssl: false,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 3000,
      // Bound the query itself too: a connection that establishes and then
      // hangs would otherwise block a send indefinitely.
      statement_timeout: 3000,
      query_timeout: 3000,
    });
    // ⛔ An 'error' listener is mandatory on a pg Pool. Without one, an idle
    // client dropped by the server emits an unhandled 'error' event, which in
    // Node is a process-level throw — i.e. exactly the "kill the collector over
    // a mail setting" failure this whole module is written to avoid.
    pool.on('error', (err) => {
      warnOnce('pool-error', `netvault pool error: ${err.message} (SMTP falls back to local settings)`);
    });
    return pool;
  } catch (err) {
    warnOnce('pool-create', `could not open a netvault pool: ${err.message} (using local SMTP settings)`);
    return null;
  }
}

// ── Decrypt (contract: see the header) ────────────────────────
function decryptCred(encrypted) {
  if (!encrypted) return '';
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) return '';
  try {
    const [ivHex, tagHex, encHex] = String(encrypted).split(':');
    if (!ivHex || !tagHex || !encHex) return '';
    const key = crypto.createHash('sha256').update(s).digest();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_err) {
    // Deliberately quiet here — the caller decides whether a failed decrypt is
    // worth a warning, and it must not log the value or the error detail.
    return '';
  }
}

// ── Hub lookup (cached, never throws) ─────────────────────────
// Resolves to the hub transport, or null when the hub has none to offer.
let cache = null; // { at: number, hub: object|null }

// ⛔ ONE LOOKUP AT A TIME, SHARED BY EVERY CONCURRENT CALLER.
//
// The cache alone does not bound concurrency: it is only written once an answer
// has arrived, so N sends that start inside the same cold window each open their
// own lookup. That is not hypothetical here — an alert storm raises many alerts
// in the same tick, and this pool is deliberately `max: 2` with a 3s connect
// timeout. Ten simultaneous lookups meant two queries and eight connection
// timeouts, every one of which returns null and reads as "the hub has no SMTP";
// whichever finished last then wrote THAT into the cache, pinning the app to its
// local settings for the next five minutes. The burst caused the fallback it
// then blamed on the hub.
//
// So callers that arrive while a lookup is open await the SAME promise. A
// rejection is not cached at all (the `.then` below never runs), which is the
// other half of the fix: an unforeseen throw must not freeze the answer either.
//
// `generation` makes an admin's save win a race with a lookup already in the
// air: clearSmtpCache() bumps it, and a stale lookup resolving afterwards is
// handed back to whoever was waiting but is NOT allowed to write the cache.
let inflight = null;
let generation = 0;

async function loadHubConfig(injectedPool) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.hub;
  if (inflight) return inflight;

  const gen = generation;
  const p = readHubConfig(injectedPool)
    .then((hub) => {
      if (gen === generation) cache = { at: Date.now(), hub };
      return hub;
    })
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

async function readHubConfig(injectedPool) {
  return await (async () => {
    if (!process.env.NEXTAUTH_SECRET) {
      // Not fatal: a hub row with no password (an unauthenticated internal
      // relay) would still be usable. But we cannot tell one from the other
      // without reading the row, and a row WITH a password would silently send
      // with blank credentials. Refusing up front is the honest answer.
      warnOnce('no-secret',
        'NEXTAUTH_SECRET is not set, so the hub SMTP password cannot be decrypted — using local SMTP settings.');
      return null;
    }
    const p = getPool(injectedPool);
    if (!p) return null;
    let row;
    try {
      const r = await p.query(
        `SELECT host, port, secure, username, password, from_email, enabled, allow_self_signed
           FROM smtp_config
          ORDER BY id
          LIMIT 1`,
      );
      row = r.rows[0];
    } catch (err) {
      if (err && err.code === '42P01') {
        // The hub predates netvault 1.65.1. Expected in the field during a
        // staggered suite upgrade — note it once and carry on locally.
        warnOnce('no-table',
          'the hub has no smtp_config table yet (NetVault 1.65.1+ adds it) — using local SMTP settings.');
      } else {
        warnOnce('query-failed',
          `could not read the hub SMTP config: ${err && err.message} — using local SMTP settings.`);
      }
      return null;
    }

    // Not opted in. Not a failure, not worth a warning.
    if (!row || row.enabled !== true) return null;
    const host = String(row.host || '').trim();
    if (!host) return null;

    let pass = '';
    if (row.password) {
      pass = decryptCred(row.password);
      if (!pass) {
        warnOnce('decrypt-failed',
          'the hub SMTP password could not be decrypted (NEXTAUTH_SECRET mismatch?) — using local SMTP settings.');
        return null;
      }
    }

    return {
      host,
      port: parseInt(row.port, 10) || 587,
      // ⛔ A REAL boolean, not `port === 465`. Both of SpanVault's senders used
      // to derive TLS purely from the port, which leaves a relay on 25/2525
      // speaking STARTTLS with no correct setting. When the config comes from
      // the hub, the hub's flag decides.
      secure: row.secure === true,
      user: String(row.username || ''),
      pass,
      from: String(row.from_email || '').trim(),
      allowSelfSigned: row.allow_self_signed === true,
    };
  })();
}

/**
 * Decide which transport to send through.
 *
 * @param {object} local  SpanVault's own `app_settings` values:
 *                        { host, port, user, pass, from }.
 *                        `from` is the raw `smtp_from` — pass it WITHOUT the
 *                        caller's own fallback chain, so the hub's from_email
 *                        can sit between "SpanVault has one" and "give up".
 * @param {object} [opts] { pool } to reuse an existing netvault pool.
 * @returns {Promise<{source: 'hub'|'local', cfg: {host, port, secure, user, pass, from, allowSelfSigned}}>}
 *
 * ⛔ Never rejects. Every failure yields `{ source: 'local' }`.
 */
async function resolveSmtp(local, opts) {
  const l = local || {};
  const localPort = parseInt(l.port, 10) || 587;
  const localCfg = {
    host: String(l.host || ''),
    port: localPort,
    // Local config keeps the historical port-derived rule, deliberately: an
    // existing install must not change behaviour because this module shipped.
    secure: localPort === 465,
    user: String(l.user || ''),
    pass: String(l.pass || ''),
    from: String(l.from || ''),
    // SpanVault has always verified the server's certificate on the local path.
    allowSelfSigned: false,
  };

  let hub = null;
  try {
    hub = await loadHubConfig(opts && opts.pool);
  } catch (err) {
    // loadHubConfig already handles everything it can foresee; this is the
    // backstop that guarantees the "never throws into the collector" promise
    // even if something unforeseen (a pg internal, an OOM in the driver) gets
    // out of it.
    warnOnce('unexpected', `unexpected failure resolving hub SMTP: ${err && err.message} — using local SMTP settings.`);
    hub = null;
  }

  if (!hub) return { source: 'local', cfg: localCfg };

  return {
    source: 'hub',
    cfg: {
      host: hub.host,
      port: hub.port,
      secure: hub.secure,
      user: hub.user,
      pass: hub.pass,
      // The From identity stays LOCAL. The hub's from_email is only a fallback
      // for an install that never set one here.
      from: localCfg.from || hub.from,
      allowSelfSigned: hub.allowSelfSigned,
    },
  };
}

/**
 * Drop the cached hub lookup — used by tests and after a hub config change.
 *
 * Bumping `generation` is the part that matters: a lookup that was already in
 * flight when this was called must not be allowed to write its now-stale answer
 * over the fresh one the next caller will fetch.
 */
function clearSmtpCache() {
  cache = null;
  inflight = null;
  generation += 1;
}

module.exports = { resolveSmtp, clearSmtpCache, CACHE_MS, __decryptCred: decryptCred };

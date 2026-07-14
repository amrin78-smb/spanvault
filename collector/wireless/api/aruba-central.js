'use strict';

// Aruba Central (cloud) wireless API client — OAuth2 refresh_token flow.
//
// ─────────────────────────────────────────────────────────────────────────
// TOKEN-REFRESH ORDERING IS SAFETY-CRITICAL — READ BEFORE EDITING.
//
// Aruba Central ROTATES the refresh_token on every use: the refresh_token you
// send in the request is invalidated the instant Central issues the new one.
// If this process crashes, or the poll cycle is otherwise interrupted, AFTER
// receiving a refreshed { access_token, refresh_token } pair but BEFORE that
// pair is written to wireless_controllers, the only refresh_token left in the
// DB is the OLD one — which Central has already invalidated by rotating it.
// There is no programmatic recovery from that state: the integration is
// PERMANENTLY BRICKED until a human re-authorizes it from scratch in the
// Aruba Central UI.
//
// The rule that prevents this: PERSIST FIRST, USE SECOND. Every refresh in
// this file goes through refreshAndPersist(), which writes the rotated
// tokens to the DB and only returns the new access_token to the caller once
// that write has resolved successfully. After a refresh, this module never
// reads controller.api_access_token again (that in-memory object is stale) —
// it always uses the local `accessToken` variable instead.
//
// Central also only allows a refresh roughly once per 15 minutes, so this
// module refreshes AT MOST ONCE per poll() invocation — whether triggered
// proactively (stale/near-expiry stored token) or reactively (401 from a
// data call) — guarded by the `refreshedThisPoll` boolean below. A poll()
// call never chains a second refresh attempt.
// ─────────────────────────────────────────────────────────────────────────
//
// API NOTE: endpoints are best-effort / approximate, mirroring the other
// clients in this directory (omada.js, ubiquiti.js, grandstream.js):
//   POST {controller_url}/oauth2/token?client_id=...&client_secret=...&grant_type=refresh_token&refresh_token=...
//     -> { access_token, refresh_token, expires_in, ... }
//   GET  {controller_url}/monitoring/v2/aps[?group=<api_group_filter>]
//     Bearer token + TenantID header -> AP inventory with per-radio detail.
// Central's cloud endpoint uses a publicly-trusted TLS cert, so none of the
// self-signed-cert caveats in ./_http.js's TLS NOTE apply here.

// _http.js's httpFetch throws away the response body on any non-2xx status —
// its `if (!res.ok) throw ...` fires before anything ever calls res.json()/
// res.text(). That's fine for vendors that don't return a useful error body,
// but Aruba Central's OAuth2 endpoint (and its data endpoints) return a JSON
// body on failure — { "error": "invalid_grant", "error_description": "..." }
// — and without it, every failure collapses to an opaque "HTTP 400 from
// controller" with no way to tell invalid_grant from invalid_client from a
// malformed request. This client therefore does NOT use httpJson for its two
// calls (token refresh, AP list) — it uses fetchJsonVerbose below instead,
// which reads the body before deciding whether to throw. Kept local rather
// than changing _http.js's shared behavior, which every other API client
// (omada/ubiquiti/grandstream) also depends on and has never needed this for.
// `opLabel` (e.g. "token refresh", "AP fetch") is prefixed onto every thrown
// error from this function so a failure log line says WHICH of the two calls
// failed, not just "aruba_central: HTTP 400" with no way to tell a bad
// refresh_token from a bad group filter. The path included in that message is
// always `new URL(url).pathname` — the pathname ONLY, never the query string
// — since the token-refresh URL's query string carries client_id/
// client_secret/refresh_token. This makes it structurally impossible for a
// credential to end up in a log line here, rather than relying on every call
// site to remember not to pass the full URL.
async function fetchJsonVerbose(url, options, timeoutMs, opLabel) {
  const label = opLabel || 'request';
  let path;
  try { path = new URL(url).pathname; } catch (_e) { path = '(unknown path)'; }

  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  let res;
  try {
    res = await fetch(url, Object.assign({}, options, { signal: abort.signal }));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`aruba_central: ${label} (${path}) timed out after ${ms}ms`);
    }
    throw new Error(`aruba_central: ${label} (${path}) failed: ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  let bodyText = null;
  try { bodyText = await res.text(); } catch (_e) { /* no readable body */ }
  let bodyJson = null;
  if (bodyText) { try { bodyJson = JSON.parse(bodyText); } catch (_e) { /* not JSON */ } }

  if (!res.ok) {
    // Only fold PARSED error/error_description/message fields from Central's
    // own JSON error body into the message — deliberately NOT a raw-text
    // fallback. The token/data-call query string carries client_secret and
    // refresh_token, and while Central's own OAuth2 JSON errors never echo
    // credentials back, a malformed-enough request can get rejected by a
    // gateway/WAF layer in front of Central instead, whose generic HTML/text
    // error page could echo the raw request line — URL and all — back in the
    // body. Only ever surface fields we've explicitly parsed out of a JSON
    // body, never the body text itself.
    const errCode = bodyJson && bodyJson.error;
    const errDesc = bodyJson && (bodyJson.error_description || bodyJson.message);
    const detail = (errCode || errDesc) ? [errCode, errDesc].filter(Boolean).join(' — ') : null;
    const err = new Error(
      `aruba_central: ${label} (${path}) failed: HTTP ${res.status}` + (detail ? ' — ' + detail : '')
    );
    err.status = res.status;
    throw err;
  }

  if (bodyJson === null) {
    throw new Error(`aruba_central: ${label} (${path}) returned invalid JSON`);
  }
  return bodyJson;
}

const TIMEOUT_MS = 20000;
// Treat a stored token as needing refresh once it is within 5 minutes of its
// recorded expiry, not only once it has strictly already expired — avoids a
// race where the token expires mid-poll between the freshness check and the
// data call.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int0(v) {
  const n = num(v);
  return n === null ? 0 : Math.trunc(n);
}

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// Band matcher. LIVE-VERIFIED against production Aruba Central (curl'd
// against GET /monitoring/v2/aps): radios[].band is a NUMERIC index, not a
// string — 0 = 2.4GHz, 1 = 5GHz. No 6GHz value has been observed/confirmed on
// this endpoint. Numeric match is checked FIRST and is authoritative for this
// endpoint. The string-substring matching below is kept only as a fallback —
// for forward-compatibility in case a different Central API surface, or a
// future Central version, ever reports band as a human-readable string
// ("2.4GHz", "5GHz", "6GHz") or enum-style token ("RADIO_TYPE_2_4GHZ") instead
// of the numeric index this endpoint actually returns today.
function bandOf(raw) {
  if (raw === 0 || raw === '0') return '2g';
  if (raw === 1 || raw === '1') return '5g';
  const s = str(raw);
  if (!s) return null;
  const low = s.toLowerCase().replace(/[\s_-]/g, '');
  if (low.includes('6g') || low.includes('6e')) return '6g';
  if (low.includes('5g')) return '5g';
  if (low.includes('2.4') || low.includes('24g') || low.includes('2g')) return '2g';
  return null;
}

function mapStatus(v) {
  const s = str(v);
  if (s === null) return 'unknown';
  const low = s.toLowerCase();
  if (low === 'up' || low === 'online' || low === 'connected') return 'online';
  if (low === 'down' || low === 'offline' || low === 'disconnected') return 'offline';
  return 'unknown';
}

// Central's AP-list response is commonly { aps: [...] } but tolerate a bare
// array or a { data: [...] } wrapper too, mirroring the other API clients'
// apArray()/dataArray() helpers.
function apArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.aps)) return body.aps;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

function apsUrl(controller) {
  const base = String(controller.controller_url).replace(/\/+$/, '') + '/monitoring/v2/aps';
  const group = str(controller.api_group_filter);
  return group ? (base + '?group=' + encodeURIComponent(group)) : base;
}

async function fetchAps(controller, accessToken) {
  // Safe to log the FULL URL including its query string here: apsUrl()'s only
  // possible query param is `group=<api_group_filter>`, never a secret (unlike
  // the token-refresh URL below, which carries client_id/client_secret/
  // refresh_token and is deliberately NOT logged in full — see that call site).
  console.log('[wireless] aruba_central: GET', apsUrl(controller));
  return fetchJsonVerbose(apsUrl(controller), {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'TenantID': str(controller.api_customer_id) || '',
    },
  }, TIMEOUT_MS, 'AP fetch');
}

// Single UPDATE — writes the rotated tokens to the DB. See the module-level
// comment: this MUST complete before the new access_token is used for
// anything. Throws on failure (the caller must not fall through to using an
// unsaved token if this rejects).
async function persistTokens(pool, controllerId, accessToken, refreshToken, expiresAt) {
  await pool.query(
    `UPDATE wireless_controllers
        SET api_access_token = $2, api_refresh_token = $3, api_token_expires_at = $4
      WHERE id = $1`,
    [controllerId, accessToken, refreshToken, expiresAt]);
}

// Perform the OAuth2 refresh_token exchange against Central, PERSIST the
// rotated { access_token, refresh_token, expires_at } to the DB, and only
// THEN return the new access token to the caller. Never returns before the
// DB write has resolved — see the module-level "PERSIST FIRST, USE SECOND"
// comment for why.
async function refreshAndPersist(controller, pool) {
  // .trim() every stored credential — a trailing newline from a UI copy-paste
  // (or a value typed with trailing whitespace) is invisible in the form but
  // produces the exact same "invalid_grant"-style 400 as a genuinely wrong
  // value, and is easy to rule out here for free. str() already trims and
  // collapses '' to null, so `|| ''` after it is still needed for the actual
  // request (Central must see an empty string, not the literal text "null").
  const qs = [
    'client_id=' + encodeURIComponent(str(controller.api_client_id) || ''),
    'client_secret=' + encodeURIComponent(str(controller.api_client_secret) || ''),
    'grant_type=refresh_token',
    'refresh_token=' + encodeURIComponent(str(controller.api_refresh_token) || ''),
  ].join('&');
  const url = String(controller.controller_url).replace(/\/+$/, '') + '/oauth2/token?' + qs;

  // DEVIATION from a literal "log the request path + query string before each
  // fetch" instruction: this call's real query string carries client_id,
  // client_secret, and refresh_token as literal values (see `qs` above) — this
  // is not a hypothetical risk, log files from this exact server were
  // downloaded and shared in a support conversation earlier today, a real
  // leak vector for live OAuth2 credentials. So instead of the full query
  // string, log only the request path plus a REDACTED query string that shows
  // the parameter names/order/count (useful for confirming the request shape)
  // and never their values.
  console.log(
    '[wireless] aruba_central: POST', new URL(url).pathname +
    '?client_id=[REDACTED]&client_secret=[REDACTED]&grant_type=refresh_token&refresh_token=[REDACTED]'
  );

  // POST with the four OAuth2 params in the QUERY STRING and an EMPTY body —
  // this is Aruba Central's refresh_token grant specifically. Don't
  // "normalise" this to send a JSON body: Central's authorization_code grant
  // DOES take one, but the refresh_token grant does not, and sending one here
  // produces the same opaque 400 this function exists to stop guessing at.
  const body = await fetchJsonVerbose(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, TIMEOUT_MS, 'token refresh');

  const accessToken = str(pick(body, ['access_token']));
  const refreshToken = str(pick(body, ['refresh_token']));
  const expiresIn = num(pick(body, ['expires_in']));
  if (!accessToken || !refreshToken) {
    throw new Error('aruba_central: token refresh (/oauth2/token) response missing access_token/refresh_token');
  }
  // Central's own docs give expires_in in seconds; fall back to a conservative
  // 2h assumption only if the field is ever absent/malformed (never used to
  // skip a real value — Number.isFinite(expiresIn) is checked first).
  const expiresAt = new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000);

  // CRITICAL: this write must complete before refreshAndPersist returns. If
  // it throws, the caller propagates the error rather than using the
  // now-rotated-but-unsaved tokens (see module-level comment).
  await persistTokens(pool, controller.id, accessToken, refreshToken, expiresAt);

  return { accessToken, refreshToken, expiresAt };
}

// Map one Central AP object + its radios[] into the shared wireless_aps
// contract. Returns { ap, radios } — radios is passed back out so
// collectSsidsFromAp() can also inspect it without re-deriving the array.
//
// LIVE-VERIFIED (curl'd against production GET /monitoring/v2/aps): this
// endpoint's AP objects/radios[] carry ONLY: name, macaddr, model,
// ip_address, status, firmware_version, serial — plus, per radio: band,
// index, macaddr, radio_name, radio_type, spatial_stream, status. It does
// NOT return channel, utilization, client counts, tx power, or uptime at any
// level. Every field below that isn't backed by one of those confirmed keys
// is set to an explicit `null` rather than a guessed/fabricated value.
function mapAp(apRaw) {
  const radios = Array.isArray(apRaw.radios) ? apRaw.radios : [];
  const out = {
    // 'name' is the only confirmed field name; 'hostname' kept as a single
    // low-risk fallback for minor API variance, not a guessed candidate list.
    name: str(pick(apRaw, ['name', 'hostname'])),
    mac_address: str(pick(apRaw, ['macaddr'])),
    model: str(pick(apRaw, ['model'])),
    ip_address: str(pick(apRaw, ['ip_address'])),
    status: mapStatus(pick(apRaw, ['status'])),
    firmware_version: str(pick(apRaw, ['firmware_version'])),
    serial_number: str(pick(apRaw, ['serial'])),
    // None of these are present anywhere in the verified /monitoring/v2/aps
    // response (per-AP or per-radio) — explicit null, never a computed/
    // fabricated value.
    radio_2g_channel: null,
    radio_5g_channel: null,
    radio_6g_channel: null,
    radio_2g_util_pct: null,
    radio_5g_util_pct: null,
    tx_power_2g: null,
    tx_power_5g: null,
    uptime_seconds: null,
    // Client counts are explicit `null`, NOT `0` — deliberately different from
    // the int0()-based 0-default other vendor parsers in this directory use
    // when they DO have real client-count data. This endpoint returns no
    // client-count field at all, per-radio or per-AP, so there's no data to
    // report. Writing `0` here would read on the dashboard as "confirmed
    // nobody connected", which actively misleads an operator when the truth
    // is "we don't have this data from this endpoint." Populating real client
    // counts requires a separate RF/client-enrichment Central API call this
    // integration does NOT make in this patch — that's a future phase, and it
    // needs its own rate-limit budget worked out against Central's
    // ~5000-calls/day cap (see the poll_interval_seconds warning above)
    // before it's added.
    clients_2g: null,
    clients_5g: null,
    clients_6g: null,
    clients_total: null,
  };

  // Still walk radios[] with the now-fixed numeric-aware bandOf() — not to
  // extract any per-band value (there is currently nothing numeric to pull
  // from a radio entry on this endpoint), but to surface a diagnostic if
  // Central ever reports a band value this parser doesn't recognise. That's
  // real signal (a schema change worth investigating, or a 6GHz radio, which
  // has never been observed on this endpoint) rather than a silently-dropped
  // radio, and it keeps this loop a useful hook for a future enrichment phase
  // instead of dead code that computes something nothing reads.
  for (const radio of radios) {
    const band = bandOf(pick(radio, ['band', 'radio_type', 'radio_band', 'type']));
    if (!band) {
      console.warn(
        `[wireless] aruba_central: AP "${out.name || '?'}" has a radio with an unrecognised band value ` +
        `(${JSON.stringify(pick(radio, ['band', 'radio_type', 'radio_band', 'type']))}) — no per-band data ` +
        'is extracted from this endpoint yet, but this is worth checking.'
      );
    }
  }

  return { ap: out, radios };
}

// Fold whatever per-AP / per-radio SSID info Central exposes into `ssidMap`
// (ssid_name -> accumulated clients_total). SSID membership isn't part of
// the exact response shape this client was written against, so this checks
// several plausible array locations/field names, matching the tolerant
// pick()-based style used for AP fields above.
function collectSsidsFromAp(ssidMap, apRaw, radios) {
  const arrays = [];
  if (Array.isArray(apRaw.ssids)) arrays.push(apRaw.ssids);
  if (Array.isArray(apRaw.wlans)) arrays.push(apRaw.wlans);
  for (const radio of radios) {
    const arr = pick(radio, ['ssids', 'essids', 'wlans', 'ssid_list']);
    if (Array.isArray(arr)) arrays.push(arr);
  }
  for (const arr of arrays) {
    for (const entry of arr) {
      let name = null;
      let clients = 0;
      if (typeof entry === 'string') {
        name = str(entry);
      } else if (entry && typeof entry === 'object') {
        name = str(pick(entry, ['ssid', 'ssid_name', 'name', 'essid']));
        clients = int0(pick(entry, ['clients', 'client_count', 'num_clients', 'clients_total']));
      }
      if (!name) continue;
      ssidMap.set(name, (ssidMap.get(name) || 0) + clients);
    }
  }
}

module.exports = {
  name: 'aruba_central',
  async poll(controller, pool) {
    if (!controller || !controller.controller_url) {
      throw new Error('aruba_central: missing controller_url');
    }
    if (!pool) {
      // Token persistence is mandatory (see module-level comment) — refuse
      // to run rather than silently skip the DB write a refresh requires.
      throw new Error('aruba_central: pool is required for token persistence');
    }

    // Defensive warning only — the actual clamp/enforcement lives at the API
    // layer (wireless_controllers.poll_interval_seconds validation) and is
    // owned elsewhere; this poll() call still runs regardless.
    const intervalSec = num(controller.poll_interval_seconds);
    if (intervalSec !== null && intervalSec < 120) {
      console.warn(
        `[wireless] aruba_central controller "${controller.name}" has poll_interval_seconds=${intervalSec} ` +
        '(< 120s). Aruba Central caps API usage at roughly 5000 calls/day and 7 calls/sec — the default ' +
        '300s interval already costs ~600 calls/day for this integration. Polling faster than 120s risks ' +
        'exceeding the daily cap and getting the account locked out until GMT midnight.'
      );
    }

    // refreshedThisPoll bounds THIS poll() invocation to at most one refresh,
    // whether it happens proactively (below) or reactively (401 handler) —
    // see the module-level comment on why a second refresh must never chain
    // within one poll() call.
    let refreshedThisPoll = false;
    let accessToken;

    const now = Date.now();
    const storedExpiry = controller.api_token_expires_at
      ? new Date(controller.api_token_expires_at).getTime()
      : 0;

    if (controller.api_access_token && Number.isFinite(storedExpiry) && (storedExpiry - now) > EXPIRY_SKEW_MS) {
      // (a) Stored access token is still valid for >5 min — use it directly,
      // no refresh needed this cycle.
      accessToken = controller.api_access_token;
    } else {
      // (b)+(c) Refresh, PERSIST, then use — refreshAndPersist() guarantees
      // the DB write completes before it returns the new token.
      const refreshed = await refreshAndPersist(controller, pool);
      accessToken = refreshed.accessToken;
      refreshedThisPoll = true;
      // From here on, NEVER read controller.api_access_token again — that
      // in-memory row is now stale. `accessToken` (local) is authoritative
      // for the rest of this poll() call.
    }

    let body;
    try {
      body = await fetchAps(controller, accessToken);
    } catch (e) {
      if (e && e.status === 401 && !refreshedThisPoll) {
        // (d) Reactive refresh-once-and-retry: the token used above was
        // rejected (revoked, clock skew, expired sooner than Central's own
        // expires_in claimed, etc). Refresh ONCE, persist, retry the SAME
        // data call ONCE. Guarded by refreshedThisPoll so this can never
        // chain into a second refresh within this poll() call — if the
        // retry below also fails, it propagates (no further retry/refresh).
        const refreshed = await refreshAndPersist(controller, pool);
        accessToken = refreshed.accessToken;
        refreshedThisPoll = true;
        body = await fetchAps(controller, accessToken);
      } else {
        throw e;
      }
    }

    const apsRaw = apArray(body);
    const aps = [];
    const ssidMap = new Map();
    for (const apRaw of apsRaw) {
      const { ap, radios } = mapAp(apRaw);
      aps.push(ap);
      collectSsidsFromAp(ssidMap, apRaw, radios);
    }
    const ssids = Array.from(ssidMap.entries()).map(([ssid_name, clients_total]) => ({ ssid_name, clients_total }));

    // Object shape (not a bare array) — this is the first API client to also
    // report SSIDs; pollApiController() in wirelessCollector.js normalises
    // both shapes, but return the richer one directly.
    return { aps, ssids };
  },
};

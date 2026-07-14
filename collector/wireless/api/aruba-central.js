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
//     Bearer token -> AP inventory with per-radio detail. TenantID header is
//     OPTIONAL and only sent when api_customer_id is set — it's an MSP-only
//     concern (querying a specific downstream customer's tenant); a direct
//     (non-MSP) Central account has none to send, and sending it with an
//     empty value (rather than omitting it) makes Central 500. See fetchAps().
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
  // calculate_client_count / calculate_ssid_count are UNCONDITIONAL (always
  // sent) — LIVE-VERIFIED to add two AP-level fields (client_count,
  // ssid_count) at zero extra API cost on this same call. `group` keeps the
  // existing conditional-omission rule: omitted entirely when
  // api_group_filter is blank, never sent as `group=`.
  const params = ['calculate_client_count=true', 'calculate_ssid_count=true'];
  if (group) params.push('group=' + encodeURIComponent(group));
  return base + '?' + params.join('&');
}

async function fetchAps(controller, accessToken) {
  // Safe to log the FULL URL including its query string here: apsUrl()'s only
  // possible query params are the two unconditional `calculate_*` flags and
  // `group=<api_group_filter>`, none of them a secret (unlike the
  // token-refresh URL below, which carries client_id/client_secret/
  // refresh_token and is deliberately NOT logged in full — see that call site).
  console.log('[wireless] aruba_central: GET', apsUrl(controller));
  // TenantID is OPTIONAL — only needed for an MSP-structured Central account
  // querying a specific downstream customer's tenant; a direct (non-MSP)
  // Central account has no TenantID to send at all. Build the headers object
  // CONDITIONALLY and never include the key at all when api_customer_id is
  // blank. `'TenantID': str(controller.api_customer_id) || ''` (the previous
  // code) does NOT omit the header when blank — it sends a real HTTP header
  // with an EMPTY VALUE, which is a different thing entirely: Node's fetch
  // transmits an empty-valued header exactly as given, whereas curl's `-H
  // "TenantID:"` shorthand (which was used to sanity-check this endpoint
  // earlier) silently drops an empty header instead of sending it — so that
  // earlier manual test never actually exercised this case, and passed by
  // accident. Confirmed live against production Central: sending TenantID
  // with an empty value makes Central try to resolve tenant "" and return
  // HTTP 500 ("An unexpected error occurred") — the exact 500 already seen in
  // this server's own production logs. Omitting the header entirely (the
  // correct behavior for a direct, non-MSP tenant) returns 200.
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const tenantId = str(controller.api_customer_id);
  if (tenantId) headers.TenantID = tenantId;

  return fetchJsonVerbose(apsUrl(controller), { method: 'GET', headers }, TIMEOUT_MS, 'AP fetch');
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
// contract. Returns { ap, radios }.
//
// LIVE-VERIFIED (curl'd against production GET /monitoring/v2/aps): this
// endpoint's AP objects/radios[] carry ONLY: name, macaddr, model,
// ip_address, status, firmware_version, serial, plus (with
// calculate_client_count=true / calculate_ssid_count=true, see apsUrl())
// client_count and ssid_count — plus, per radio: band, index, macaddr,
// radio_name, radio_type, spatial_stream, status. It does NOT return
// channel, utilization, tx power, uptime, or any per-band client breakdown
// at any level. Every field below that isn't backed by one of those
// confirmed keys is set to an explicit `null` rather than a guessed/
// fabricated value.
//
// RF data (channel/utilization/noise_floor/tx_power) is OUT OF SCOPE for
// this bulk endpoint — LIVE-VERIFIED: GET /monitoring/v2/aps?fields=radios
// returns radios[] with ONLY band, index, macaddr, radio_name, radio_type,
// spatial_stream, status; channel/utilization/noise_floor/tx_power are
// marked optional in Central's schema and are NOT populated for these APs.
// The only real RF source found is GET /monitoring/v3/aps/{serial}/
// rf_summary — but that's PER-AP: 8 APs x 288 polls/day (5-min interval)
// is ~2300 calls/day against Central's ~5000/day cap, on top of everything
// else this integration already calls. If this is ever added, it MUST run
// on its own slower cycle (15-30 min), never the main poll interval. Future
// phase — not built here, this comment exists so a future implementer
// doesn't have to re-derive the finding.
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
    // clients_total: LIVE-VERIFIED — passing calculate_client_count=true on
    // GET /monitoring/v2/aps (see apsUrl()) adds an AP-level `client_count`
    // integer field at zero extra API cost. Mapped via num() below: real
    // integer when present, explicit `null` (not 0) if the key is ever
    // absent, so a genuinely-missing value never reads as "confirmed nobody
    // connected" on the dashboard.
    //
    // clients_2g / clients_5g / clients_6g are STILL explicit `null` — this
    // is NOT the same situation as clients_total. LIVE-VERIFIED TWICE:
    // Central provides NO per-band client breakdown anywhere on this
    // endpoint (per-AP or per-radio), only the single AP-level total above.
    // Do NOT divide, estimate, or apportion clients_total across bands here
    // — that would fabricate data this endpoint does not provide. Populating
    // real per-band client counts would require a separate RF/client-
    // enrichment Central API call this integration does NOT make in this
    // patch — that's a future phase, and it needs its own rate-limit budget
    // worked out against Central's ~5000-calls/day cap (see the
    // poll_interval_seconds warning above) before it's added.
    clients_2g: null,
    clients_5g: null,
    clients_6g: null,
    clients_total: num(pick(apRaw, ['client_count'])),
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

// Central's SSID/network-list response is { count, networks: [...] } per the
// verified GET /monitoring/v2/networks shape — tolerate a bare array or a
// { data: [...] } wrapper too, mirroring apArray() above.
function networksArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.networks)) return body.networks;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

function networksUrl(controller) {
  const base = String(controller.controller_url).replace(/\/+$/, '') + '/monitoring/v2/networks';
  const group = str(controller.api_group_filter);
  // Same conditional-omission rule as apsUrl(): `group` is a supported param
  // on this endpoint too (confirmed in Central's Swagger), but must be
  // omitted entirely when api_group_filter is blank — never sent as `group=`.
  const params = ['calculate_client_count=true'];
  if (group) params.push('group=' + encodeURIComponent(group));
  return base + '?' + params.join('&');
}

// Bulk SSID/network fetch — ONE call per poll (not per-AP). v1 of this
// endpoint 404s; v2 only. LIVE-VERIFIED shape:
//   { count, networks: [ { essid, security, type, client_count }, ... ] }
// SSID name is `essid` (NOT `ssid`, NOT `name`). Same header rules as
// fetchAps(): TenantID is OMITTED ENTIRELY when api_customer_id is blank
// (never sent with an empty value — see fetchAps()'s comment for the
// production HTTP 500 this exact mistake caused earlier).
async function fetchNetworks(controller, accessToken) {
  // Safe to log the full URL: networksUrl()'s only params are the
  // unconditional calculate_client_count flag and `group=<api_group_filter>`
  // — never a secret.
  console.log('[wireless] aruba_central: GET', networksUrl(controller));
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const tenantId = str(controller.api_customer_id);
  if (tenantId) headers.TenantID = tenantId;

  return fetchJsonVerbose(networksUrl(controller), { method: 'GET', headers }, TIMEOUT_MS, 'SSID fetch');
}

// Map one Central network object (from GET /monitoring/v2/networks) into the
// fields wirelessCollector.js's upsertSsid() actually consumes. Only fields
// with real, verified data are mapped — status/bytes_in/bytes_out/
// auth_successes/auth_failures are left unset; upsertSsid() already
// defaults/null-coalesces those sensibly (`ssid.status || 'up'`,
// `intOrNull(ssid.bytes_in)`, etc).
function mapNetwork(netRaw) {
  return {
    ssid_name: str(pick(netRaw, ['essid'])),
    // clients_total: real integer via num(), null (not 0) if the key is
    // absent — same known limitation as mapAp()'s clients_total: upsertSsid()
    // itself does `intOrNull(ssid.clients_total) || 0`, coercing an honest
    // null back to 0 before the actual INSERT/UPDATE (wireless_ssids.
    // clients_total is NOT NULL DEFAULT 0). That DB-layer coercion is a
    // pre-existing architectural limitation, not something to fix here.
    clients_total: num(pick(netRaw, ['client_count'])),
    // encryption_type has a real destination column (wireless_ssids.
    // encryption_type TEXT, added via ALTER TABLE in scripts/schema.sql).
    // Central's `type` field ("Employee" etc.) has no matching column and is
    // deliberately NOT mapped — adding one is a schema change, out of scope.
    encryption_type: str(pick(netRaw, ['security'])),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// RF ENRICHMENT — independent, slower cycle. Read before editing.
//
// The main poll() above (5-min cycle) cannot get channel/utilization/tx
// power/noise floor from Central's bulk /monitoring/v2/aps endpoint — see
// mapAp()'s comment. LIVE-VERIFIED: GET /monitoring/v1/aps/{serial} DOES
// carry that data, one call per AP, no query params needed:
//   { "band": 0, "channel": "6", "noise_floor": 88, "tx_power": 9,
//     "utilization": 10, "radio_type": "2.4 GHz", ... }
// (GET /monitoring/v3/aps/{serial}/rf_summary was also tried — it requires a
// mandatory `band` query param, 400s without it, so it costs 2 calls/AP plus
// a time-series to collapse for the same point-in-time snapshot. Strictly
// worse than v1/aps/{serial}. Do not switch to it.)
//
// This is why pollRf() below is a SEPARATE entry point from poll(), driven by
// its own timer in wirelessCollector.js (NOT the 5-min wireless poll cycle):
// 8 APs x 1 call every 15 min is ~770 calls/day on top of the ~890/day the
// main poll + SSID call already cost. On the 5-min cycle it would be ~2300/
// day — unsafe stacked against Central's ~5000/day cap. Channel/noise/tx
// power change slowly; 15-min granularity loses nothing operationally.
//
// pollRf() deliberately does NOT refresh the OAuth token — it reuses
// whatever access token the main poll() most recently persisted. Central
// only allows a refresh roughly once per 15 minutes (see the module-level
// comment at the top of this file); running a second, independent refresher
// on this pass would risk two refreshes racing within that window, and this
// integration already has exactly one place responsible for the
// PERSIST-FIRST-USE-SECOND refresh contract (poll(), above). If the stored
// token is missing or already expired, this pass skips the controller
// entirely for this cycle — the next main poll (within 5 min) will refresh
// it, and the next RF cycle (15 min later) will find a valid token.
// ─────────────────────────────────────────────────────────────────────────

function apRfUrl(controller, serial) {
  return String(controller.controller_url).replace(/\/+$/, '') + '/monitoring/v1/aps/' + encodeURIComponent(serial);
}

async function fetchApRf(controller, accessToken, serial) {
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const tenantId = str(controller.api_customer_id);
  if (tenantId) headers.TenantID = tenantId;
  return fetchJsonVerbose(apRfUrl(controller, serial), { method: 'GET', headers }, TIMEOUT_MS, 'RF fetch');
}

// `channel` on this endpoint is a STRING (e.g. "44E" — the "E" suffix marks a
// 40MHz channel extension, per Aruba's convention). parseInt() stops at the
// first non-digit character ("44E" -> 44, "6" -> 6) and never throws; a
// wholly non-numeric value parses to NaN, mapped to null here rather than a
// garbage channel number.
function parseChannel(v) {
  const s = str(v);
  if (s === null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// Same sign convention as the SNMP Aruba parser (collector/wireless/aruba.js:
// `const dbm = nf > 0 ? -nf : nf;`) — stored as negative dBm. Central
// LIVE-VERIFIED returns noise_floor as a POSITIVE integer (magnitude only,
// e.g. 88 meaning -88 dBm), so without this conversion the same physical AP
// would read +88 via Central and -88 via SNMP depending on which integration
// polled it.
function noiseFloorDbm(v) {
  const n = num(v);
  if (n === null) return null;
  return n > 0 ? -n : n;
}

// Map one GET /monitoring/v1/aps/{serial} response into the wireless_aps RF
// columns this pass writes. Tolerates a bare `radios` array or an array body
// (mirrors apArray()'s tolerance above) since the exact top-level wrapper
// wasn't pinned down during verification. Any band not present in the
// response stays null here — the caller COALESCEs against the existing DB
// row rather than wiping a known-good value with a transient miss (see
// wirelessCollector.js's pollRf loop).
function mapApRf(body) {
  const radios = Array.isArray(body && body.radios) ? body.radios
    : Array.isArray(body) ? body : [];
  const out = {
    radio_2g_channel: null, radio_5g_channel: null,
    radio_2g_util_pct: null, radio_5g_util_pct: null,
    tx_power_2g: null, tx_power_5g: null,
    noise_floor_2g: null, noise_floor_5g: null,
  };
  for (const radio of radios) {
    const band = bandOf(pick(radio, ['band', 'radio_type', 'radio_band', 'type']));
    if (band === '2g') {
      out.radio_2g_channel = parseChannel(pick(radio, ['channel']));
      out.radio_2g_util_pct = num(pick(radio, ['utilization']));
      out.tx_power_2g = num(pick(radio, ['tx_power']));
      out.noise_floor_2g = noiseFloorDbm(pick(radio, ['noise_floor']));
    } else if (band === '5g') {
      out.radio_5g_channel = parseChannel(pick(radio, ['channel']));
      out.radio_5g_util_pct = num(pick(radio, ['utilization']));
      out.tx_power_5g = num(pick(radio, ['tx_power']));
      out.noise_floor_5g = noiseFloorDbm(pick(radio, ['noise_floor']));
    }
    // 6GHz: wireless_aps has no tx_power_6g/noise_floor_6g columns, and no
    // 6GHz radio has been observed on this vendor yet (see bandOf() above) —
    // skip rather than guess a column mapping that doesn't exist.
  }
  return out;
}

// One controller's RF enrichment pass. Never throws — a failure here (token
// unusable, DB error, etc.) is logged and swallowed so it can't take down the
// caller's loop over other controllers, matching pollController()'s own
// never-throws contract in wirelessCollector.js.
async function pollRf(controller, pool) {
  try {
    const accessToken = controller.api_access_token;
    const expiresAt = controller.api_token_expires_at ? new Date(controller.api_token_expires_at).getTime() : NaN;
    if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      console.warn(
        `[wireless-rf] aruba_central "${controller.name}": no valid stored access token — ` +
        'skipping this RF cycle (the next main poll will refresh it)'
      );
      return;
    }

    const apRows = (await pool.query(
      `SELECT id, serial_number FROM wireless_aps WHERE controller_id = $1 AND serial_number IS NOT NULL`,
      [controller.id]
    )).rows;

    for (const apRow of apRows) {
      try {
        const body = await fetchApRf(controller, accessToken, apRow.serial_number);
        const rf = mapApRf(body);
        // COALESCE: a band missing from this response (radio briefly not
        // reporting) must not wipe the last known-good value — mirrors the
        // same precedent in wirelessCollector.js's pollController() for
        // controller-level metadata.
        await pool.query(
          `UPDATE wireless_aps SET
             radio_2g_channel  = COALESCE($2, radio_2g_channel),
             radio_5g_channel  = COALESCE($3, radio_5g_channel),
             radio_2g_util_pct = COALESCE($4, radio_2g_util_pct),
             radio_5g_util_pct = COALESCE($5, radio_5g_util_pct),
             tx_power_2g       = COALESCE($6, tx_power_2g),
             tx_power_5g       = COALESCE($7, tx_power_5g),
             noise_floor_2g    = COALESCE($8, noise_floor_2g),
             noise_floor_5g    = COALESCE($9, noise_floor_5g)
           WHERE id = $1`,
          [apRow.id, rf.radio_2g_channel, rf.radio_5g_channel,
            rf.radio_2g_util_pct, rf.radio_5g_util_pct,
            rf.tx_power_2g, rf.tx_power_5g,
            rf.noise_floor_2g, rf.noise_floor_5g]);
      } catch (e) {
        // Per-AP isolation: one AP's RF call failing (timeout, a
        // decommissioned serial returning 404, etc.) must never abort the
        // rest of this controller's APs.
        console.warn(
          `[wireless-rf] aruba_central "${controller.name}" AP ${apRow.serial_number}: ` +
          (e && e.message ? e.message : String(e))
        );
      }
    }
  } catch (e) {
    console.error(
      `[wireless-rf] aruba_central "${controller.name}" RF cycle failed:`,
      e && e.message ? e.message : String(e)
    );
  }
}

module.exports = {
  name: 'aruba_central',
  pollRf,
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
    const aps = apsRaw.map((apRaw) => mapAp(apRaw).ap);

    // SSID fetch is a SEPARATE bulk call and must NOT fail the whole poll —
    // the AP list above is the primary, must-succeed payload; SSIDs are a
    // best-effort addition. Reuses the SAME accessToken already resolved
    // above (which may have been reactively refreshed by fetchAps()'s own
    // 401-retry logic) rather than requesting its own token. On any failure
    // here — including a 401 — log and fall back to an empty SSID list; do
    // NOT attempt a refresh-and-retry of our own (that logic is owned
    // exclusively by the fetchAps() 401 handler above, and duplicating it
    // here would risk a second refresh within one poll() call, which the
    // module-level "at most one refresh per poll()" rule forbids).
    let ssids = [];
    try {
      const networksBody = await fetchNetworks(controller, accessToken);
      ssids = networksArray(networksBody).map(mapNetwork).filter((s) => s.ssid_name);
    } catch (e) {
      console.warn(
        `[wireless] aruba_central: SSID fetch failed for controller "${controller.name}" — ` +
        `continuing with AP data only (no SSIDs this poll): ${e && e.message ? e.message : String(e)}`
      );
      ssids = [];
    }

    // Object shape (not a bare array) — this is the first API client to also
    // report SSIDs; pollApiController() in wirelessCollector.js normalises
    // both shapes, but return the richer one directly.
    return { aps, ssids };
  },
};

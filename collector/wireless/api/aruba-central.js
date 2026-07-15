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

// Band matcher for the AP/RF endpoints ONLY (GET /monitoring/v2/aps, GET
// /monitoring/v1/aps/{serial} — used by mapAp()/mapRf()). LIVE-VERIFIED
// against production Aruba Central (curl'd against GET /monitoring/v2/aps):
// radios[].band is a NUMERIC index, not a string — 0 = 2.4GHz, 1 = 5GHz. No
// 6GHz value has been observed/confirmed on this endpoint. Numeric match is
// checked FIRST and is authoritative for this endpoint. The string-substring
// matching below is kept only as a fallback — for forward-compatibility in
// case a different Central API surface, or a future Central version, ever
// reports band as a human-readable string ("2.4GHz", "5GHz", "6GHz") or
// enum-style token ("RADIO_TYPE_2_4GHZ") instead of the numeric index this
// endpoint actually returns today.
//
// DO NOT use this for the CLIENT endpoint (GET /monitoring/v1/clients/
// wireless) — it uses a COMPLETELY DIFFERENT numeric convention (the GHz
// value itself, not a radio index: 2/5/6, not 0/1). See clientBandOf() below,
// which exists specifically because reusing this function for clients
// silently mapped every 5GHz client to null in production (5 !== 0, 5 !== 1,
// and none of the string fallbacks match a bare "5" either) — confirmed live:
// band='2.4GHz' was set correctly by string-fallback accident, but every
// 5GHz channel (36/44/56/64/104/112/153/161) had band=NULL. Keep these two
// mappers separate — do not "unify" them back into one function.
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

// Band matcher for the CLIENT endpoint ONLY (GET /monitoring/v1/clients/
// wireless — used by mapClient() below). DIFFERENT convention from bandOf()
// above: band here is the GHZ VALUE itself, not a radio index — LIVE-
// VERIFIED against a real client object (band:5, channel:"56 (80 MHz)" —
// channel 56 is 5GHz-only, confirming band:5 means 5GHz, not "radio index
// 5"). Numeric 2/5/6 map directly to GHz; the string-substring fallback below
// mirrors bandOf()'s style for forward-compat (a human-readable "2.4GHz"/
// "5GHz"/"6GHz"/"6E" string instead of a bare number).
function clientBandOf(raw) {
  if (raw === 2 || raw === '2') return '2g';
  if (raw === 5 || raw === '5') return '5g';
  if (raw === 6 || raw === '6') return '6g';
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
  // calculate_client_count / calculate_ssid_count / show_resource_details are
  // UNCONDITIONAL (always sent) — LIVE-VERIFIED to add extra AP-level fields
  // (client_count, ssid_count, and — per show_resource_details — uptime,
  // cpu_utilization, mem_total, mem_free, mesh_role, mode) at zero extra API
  // cost on this same call. uptime/cpu_utilization/mem_total/mem_free are
  // mapped below (see mapAp()) onto wireless_aps.uptime_seconds/cpu_pct/
  // mem_total/mem_free. mesh_role/mode have no wireless_aps columns or UI
  // surface and are NOT mapped — deliberately, not a silent gap: neither has
  // an obvious destination column, and adding one without a concrete use
  // wouldn't be worth the schema churn. `group` keeps the existing
  // conditional-omission rule: omitted entirely when api_group_filter is
  // blank, never sent as `group=`.
  const params = ['calculate_client_count=true', 'calculate_ssid_count=true', 'show_resource_details=true'];
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
// LIVE-VERIFIED (curl'd against production GET /monitoring/v2/aps): with
// calculate_client_count=true / calculate_ssid_count=true / show_resource_
// details=true (see apsUrl()), this endpoint's AP objects carry: name,
// macaddr, model, ip_address, status, firmware_version, serial, client_count,
// ssid_count, uptime, cpu_utilization, mem_total, mem_free (plus mesh_role/
// mode, not mapped — see apsUrl()'s comment for why), and per radio: band,
// index, macaddr, radio_name, radio_type, spatial_stream, status. It
// does NOT return channel, utilization, tx power, or any per-band client
// breakdown at any level — those are OUT OF SCOPE for this bulk endpoint no
// matter which flags are passed (LIVE-VERIFIED separately: GET /monitoring/
// v2/aps?fields=radios returns radios[] with ONLY band, index, macaddr,
// radio_name, radio_type, spatial_stream, status). Every field below that
// isn't backed by one of those confirmed keys is set to an explicit `null`
// rather than a guessed/fabricated value.
//
// RF data (channel/utilization/noise_floor/tx_power) comes from a SEPARATE,
// PER-AP endpoint instead — see pollRf() further down this file (its own
// slower ~15-min cycle, not the main poll interval — 8 APs x 1 call/15min
// stays well under Central's ~5000/day cap; the same data on the 5-min main
// cycle would not).
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
    // Channel/util/tx power are NOT present on this bulk endpoint even with
    // show_resource_details=true (that flag adds uptime/cpu/mem/mesh info,
    // not RF detail) — explicit null here, never a computed/fabricated
    // value. Real values for these come from the separate pollRf() pass
    // below (its own slower cycle, see the RF-enrichment section).
    radio_2g_channel: null,
    radio_5g_channel: null,
    radio_6g_channel: null,
    radio_2g_util_pct: null,
    radio_5g_util_pct: null,
    tx_power_2g: null,
    tx_power_5g: null,
    // uptime: LIVE-VERIFIED — show_resource_details=true (see apsUrl()) adds
    // an AP-level `uptime` field at zero extra API cost. Unit not spelled out
    // in Central's schema; treated as seconds (matches this column's name and
    // every other vendor's convention) via num() — real integer when present,
    // explicit null (not 0) if the key is ever absent.
    uptime_seconds: num(pick(apRaw, ['uptime'])),
    // cpu_pct/mem_total/mem_free: LIVE-VERIFIED — also added by
    // show_resource_details=true, same call, zero extra cost. cpu_utilization
    // maps straight to cpu_pct (matches the wireless_controllers.cpu_pct
    // naming convention). mem_total/mem_free are stored as the raw values
    // Central reports (unit not converted) rather than a computed mem_pct —
    // see the wireless_aps.mem_total/mem_free column comments in schema.sql.
    cpu_pct: num(pick(apRaw, ['cpu_utilization'])),
    mem_total: num(pick(apRaw, ['mem_total'])),
    mem_free: num(pick(apRaw, ['mem_free'])),
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

// ─────────────────────────────────────────────────────────────────────────
// CLIENT ACQUISITION — bulk call, MAIN 5-min poll cycle (not a separate
// timer like RF enrichment above). Read before editing.
//
// LIVE-VERIFIED against production Central (not assumed from Swagger docs):
//   GET /monitoring/v1/clients/wireless?group=<g>&limit=1000
// NOT /monitoring/v2/clients — that "unified" endpoint returns count:0 for
// this deployment (IAP-managed APs). v1/clients/wireless is the one with
// real data. count == total at limit=1000 for the current fleet (81
// clients), so pagination is not exercised today, but fetchClients() below
// still implements the offset loop defensively for a larger future fleet.
//
// fetchClients() deliberately does NOT refresh the OAuth token — same rule
// as pollRf() above: exactly one place in this file (poll()) owns the
// PERSIST-FIRST-USE-SECOND refresh contract. Unlike pollRf() (which has its
// own independent timer and therefore tolerates/skips a missing-or-expired
// token gracefully), fetchClients() is called as part of the SAME main poll
// cycle as poll() itself, right after AP acquisition — by the time it runs,
// poll() has already guaranteed a valid, possibly-just-refreshed
// controller.api_access_token exists for this cycle. So a missing token
// here is treated as a real error (thrown), not a "skip this cycle"
// no-op — don't "fix" this to silently return [] on a missing token like
// pollRf() does; that's the right behavior for pollRf()'s independent timer,
// not for this call site.
// ─────────────────────────────────────────────────────────────────────────

// Same conditional-omission style as apsUrl()/networksUrl(): `group` is only
// added when api_group_filter is set, `offset` is only added when non-zero
// (the first page never sends offset=0).
function clientsUrl(controller, offset) {
  const base = String(controller.controller_url).replace(/\/+$/, '') + '/monitoring/v1/clients/wireless';
  const group = str(controller.api_group_filter);
  const params = ['limit=1000'];
  if (group) params.push('group=' + encodeURIComponent(group));
  if (offset > 0) params.push('offset=' + offset);
  return base + '?' + params.join('&');
}

// One page of the client list. Same header rules as fetchAps()/
// fetchNetworks(): TenantID conditionally included, never sent empty. Safe
// to log the full URL — clientsUrl()'s only params are limit/group/offset,
// none of them secret (unlike the token-refresh URL).
async function fetchClientsPage(controller, accessToken, offset) {
  const url = clientsUrl(controller, offset);
  console.log('[wireless] aruba_central: GET', url);
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const tenantId = str(controller.api_customer_id);
  if (tenantId) headers.TenantID = tenantId;

  return fetchJsonVerbose(url, { method: 'GET', headers }, TIMEOUT_MS, 'client fetch');
}

// Tolerant extraction, mirroring apArray()/networksArray()'s exact pattern —
// the precise top-level wrapper key wasn't 100% pinned down during
// verification (the Swagger reference doc says `clients`, but apply the same
// defensive tolerance as the other *Array() helpers in this file rather than
// assuming only one shape works).
function clientArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.clients)) return body.clients;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

const CLIENT_BAND_LABELS = { '2g': '2.4GHz', '5g': '5GHz', '6g': '6GHz' };

// Normalize a MAC to lowercase colon-separated hex (e.g. "aa:bb:cc:dd:ee:ff")
// — the canonical format the rest of this codebase's wireless client
// pipeline uses everywhere (collector/wireless/clients/_util.js's hexMac/
// macFromTail/macFromHead helpers, shared by every SNMP vendor client
// parser). Central's raw value is already reported as lowercase-colon in
// production, so this is a no-op in practice today — but real normalization
// is done anyway (not a passthrough) as defensive insurance: a silent
// mismatch here would make the same physical client appear as two different
// rows (once from SNMP, once from this path) and break roam-event detection,
// which keys strictly on exact mac_address string equality. Returns null
// (never a mangled value) if the input doesn't contain exactly 12 hex
// digits.
function normalizeMac(raw) {
  const s = str(raw);
  if (!s) return null;
  const hex = s.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

// last_connection_time -> connected_since. IMPORTANT: the exact unit of this
// field was NOT 100% pinned down during verification. Treated as epoch
// MILLISECONDS here (JS's Date constructor already takes milliseconds — do
// NOT divide by 1000 first, that would produce a 1970 date if the value
// truly is milliseconds). A plausibility guard catches the case where that
// assumption is wrong: if the resulting date is before year 2000 or more
// than 1 day in the future, it's logged and treated as a unit mismatch
// (connected_since left null) rather than stored as a nonsense date. Flag
// this field for double-checking against a real sample response if one
// becomes available.
function parseConnectedSince(raw, macForLog) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  const year2000Ms = Date.UTC(2000, 0, 1);
  const oneDayFutureMs = Date.now() + 24 * 60 * 60 * 1000;
  if (d.getTime() < year2000Ms || d.getTime() > oneDayFutureMs) {
    console.warn(
      `[wireless] aruba_central: client ${macForLog || '?'} last_connection_time (${JSON.stringify(raw)}) ` +
      'is implausible as an epoch-milliseconds value — leaving connected_since null. This field\'s unit was ' +
      'not confirmed against a real sample response during verification; check this if one becomes available.'
    );
    return null;
  }
  return d;
}

// Map one client object from GET /monitoring/v1/clients/wireless into the
// wireless_clients-shaped output object the wirelessCollector.js refactor
// will consume. This is NOT the same shape as mapAp()'s AP object — ap_id is
// not part of it; AP-id resolution from ap_name/ap_serial happens on the
// consumer side, not here. Only fields with real, verified data are mapped;
// everything else is explicit null, mirroring mapAp()'s discipline of never
// letting one missing field imply another is also missing.
function mapClient(clientRaw) {
  const macAddress = normalizeMac(pick(clientRaw, ['macaddr']));

  const bandRaw = pick(clientRaw, ['band']);
  const bandCode = clientBandOf(bandRaw);
  let band = null;
  if (bandCode && CLIENT_BAND_LABELS[bandCode]) {
    band = CLIENT_BAND_LABELS[bandCode];
  } else if (bandRaw !== undefined) {
    console.warn(
      `[wireless] aruba_central: client "${macAddress || JSON.stringify(pick(clientRaw, ['macaddr'])) || '?'}" ` +
      `has an unrecognised band value (${JSON.stringify(bandRaw)}) — leaving band null.`
    );
  }

  return {
    mac_address: macAddress,
    // IS present on this endpoint — LIVE-VERIFIED ("ip_address":
    // "172.24.208.57" on a real client object). An earlier version of this
    // mapper wrongly generalised from the /monitoring/v2/clients ("unified")
    // schema, where this field's presence wasn't confirmed, to this endpoint
    // (GET /monitoring/v1/clients/wireless), where it is.
    ip_address: str(pick(clientRaw, ['ip_address'])),
    hostname: str(pick(clientRaw, ['name', 'hostname'])),
    ap_name: str(pick(clientRaw, ['associated_device_name'])),
    ap_serial: str(pick(clientRaw, ['associated_device'])),
    ssid_name: str(pick(clientRaw, ['network'])),
    band,
    channel: parseChannel(pick(clientRaw, ['channel'])),
    rssi_dbm: null,
    tx_rate_mbps: null,
    rx_rate_mbps: null,
    connected_since: parseConnectedSince(pick(clientRaw, ['last_connection_time']), macAddress),
    os_type: str(pick(clientRaw, ['os_type'])),
    vlan_id: num(pick(clientRaw, ['vlan'])),
    auth_type: str(pick(clientRaw, ['authentication_type'])),
    phy_mode: null,
    rx_bytes: null,
    tx_bytes: null,
    byte_counter_bits: null,
  };
}

// Exported entry point — signature deliberately mirrors poll(controller,
// pool) for call-site consistency, but `pool` is unused here (no token
// persistence needed on this read-only path); accepted anyway so the
// caller's call site looks uniform with poll()/pollRf().
//
// Does NOT wrap its own errors in a try/catch — they propagate to the
// caller. wirelessCollector.js's refactored pollClients() owns per-
// controller failure isolation for this path ("an aruba_central
// client-fetch failure must not fail the AP poll or any other controller's
// client collection"), mirroring how poll() itself doesn't swallow its own
// errors — pollController() in wirelessCollector.js does that.
async function fetchClients(controller, pool) {
  if (!controller || !controller.api_access_token) {
    // Real error, not a silent skip — see the section comment above for why
    // this differs from pollRf()'s missing-token handling.
    throw new Error('aruba_central: fetchClients: no stored access token (expected one already refreshed by this poll cycle\'s poll() call)');
  }
  const accessToken = controller.api_access_token;

  const rawClients = [];
  let offset = 0;
  for (;;) {
    const body = await fetchClientsPage(controller, accessToken, offset);
    const page = clientArray(body);
    rawClients.push(...page);

    // Defensive pagination: read count/total (names not 100% pinned down
    // during verification) and loop on offset while count < total, same
    // fallback-gracefully spirit as the other *Array() helpers in this file.
    // If either field is missing/unrecognisable, stop after this page rather
    // than loop on an assumption that could run forever.
    const count = num(pick(body, ['count']));
    const total = num(pick(body, ['total']));
    if (count === null || total === null || count >= total || page.length === 0) break;
    offset += page.length;
  }

  // Filter out anything without a usable identity — mirrors the main poll's
  // `.filter((s) => s.ssid_name)` for SSIDs, same reasoning: can't upsert a
  // client row with no key to upsert on.
  return rawClients.map(mapClient).filter((c) => c.mac_address);
}

// ─────────────────────────────────────────────────────────────────────────
// TIME WINDOWS — shared by the events feed and top-N bandwidth below.
// CRITICAL — READ BEFORE EDITING.
//
// Central's time-series endpoints (GET /monitoring/v2/events, GET
// /monitoring/v2/aps/bandwidth_usage/topn) take from_timestamp/to_timestamp
// as epoch SECONDS in UTC, and REJECT any to_timestamp in the future
// ("to_timestamp cannot be greater than current time", error 0002).
//
// Date.now() is ALREADY UTC (epoch milliseconds since 1970 UTC, independent
// of the server's local timezone) — Math.floor(Date.now() / 1000) is
// correct and is the ONLY way this function builds a timestamp. NEVER derive
// one from a Date object's LOCAL-time accessors (getHours(), toString(),
// toLocaleString(), etc.) or from any local-time library call — this exact
// mistake costs real debugging time: a local-time epoch is 7 hours AHEAD for
// this tenant (UTC+7), so to_timestamp lands in Central's future and every
// call 400s with error 0002.
//
// `marginSec` is subtracted from "now" before it becomes to_timestamp, to
// absorb client/server clock skew — without it, even a few seconds of drift
// alone can trigger the same rejection.
function timeWindow(windowSec, marginSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  const margin = Number.isFinite(marginSec) && marginSec >= 0 ? marginSec : 300;
  const toTimestamp = nowSec - margin;
  const fromTimestamp = toTimestamp - windowSec;
  return { from_timestamp: fromTimestamp, to_timestamp: toTimestamp };
}

// ─────────────────────────────────────────────────────────────────────────
// EVENTS FEED — independent, own cycle. Read before editing.
//
// VERIFIED endpoint: GET /monitoring/v2/events. This is Central's NATIVE
// event stream (AP up/down, radio changes, client auth failures, config
// events) — a DIFFERENT source from the roam/join/leave/low_signal events
// processClientSnapshot() in wirelessCollector.js already SYNTHESISES from
// client-snapshot diffs. This section ADDS a source; it does not touch that
// synthesis.
//
// Same token-reuse rule as pollRf(): this runs on its OWN independent timer
// (SV_ARUBA_EVENTS_POLL_INTERVAL_SECONDS in wirelessCollector.js, default
// 300s), so it reuses whatever token poll() most recently persisted and
// never refreshes itself — skip the cycle entirely on a missing/expired
// token rather than risk a second refresh racing the main poll's within
// Central's ~15-min refresh window.
// ─────────────────────────────────────────────────────────────────────────

function eventsUrl(controller, window, offset) {
  const base = String(controller.controller_url).replace(/\/+$/, '') + '/monitoring/v2/events';
  const group = str(controller.api_group_filter);
  const params = [
    'from_timestamp=' + window.from_timestamp,
    'to_timestamp=' + window.to_timestamp,
    'sort=-timestamp',
  ];
  if (group) params.push('group=' + encodeURIComponent(group));
  if (offset > 0) params.push('offset=' + offset);
  return base + '?' + params.join('&');
}

// Same header rules as fetchAps()/fetchClientsPage(). Safe to log the full
// URL — no secrets in eventsUrl()'s params.
async function fetchEventsPage(controller, accessToken, window, offset) {
  const url = eventsUrl(controller, window, offset);
  console.log('[wireless] aruba_central: GET', url);
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const tenantId = str(controller.api_customer_id);
  if (tenantId) headers.TenantID = tenantId;
  return fetchJsonVerbose(url, { method: 'GET', headers }, TIMEOUT_MS, 'events fetch');
}

// Tolerant extraction, mirroring apArray()/clientArray()'s exact pattern.
function eventArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.events)) return body.events;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

// LIVE-VERIFIED against a real GET /monitoring/v2/events object: `timestamp`
// is epoch MILLISECONDS (e.g. 1784085024000) — a straight `new Date(n)`, no
// guessing needed (this field's unit is confirmed, unlike the two-attempt
// heuristic parseConnectedSince() still needs for the client endpoint's
// last_connection_time). Do NOT read `ts_ms` — LIVE-VERIFIED to be 0 on every
// real event, a trap field that looks plausible but is always garbage.
function parseEventTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return new Date(n);
}

// LIVE-VERIFIED against a real GET /monitoring/v2/events object (previous
// version of this mapper read `id`/`event_id`/`uuid` and a bare `type` —
// WRONG on both counts, neither field exists on the real response; see the
// module-level history in git blame if ever curious). Confirmed field names:
// event_uuid (a real GUID — the ONLY dedup key that matters, see pollEvents()
// below), event_type (classification, e.g. "Client Roaming Success" — NOT
// `type`), description, level (e.g. "positive"), device_mac, device_serial,
// device_type ("CLIENT"/"ACCESS POINT"/etc), hostname, timestamp (epoch ms,
// see parseEventTimestamp() above). group_name/sites[] are also present but
// unused — nothing here needs them yet.
function mapEvent(eventRaw) {
  const centralEventId = str(pick(eventRaw, ['event_uuid']));
  const ts = parseEventTimestamp(pick(eventRaw, ['timestamp']));
  const deviceMac = str(pick(eventRaw, ['device_mac']));
  const type = str(pick(eventRaw, ['event_type']));
  // Dedup key: event_uuid is a real GUID, always present on a genuine Central
  // event — the fallback composite below exists only for a malformed/partial
  // response missing it, not the normal case. (The PREVIOUS version of this
  // mapper read a nonexistent `id` field, so central_event_id was always
  // null and EVERY event silently fell through to this fallback — which was
  // itself degraded, since `type` was also misread — see pollEvents()'s
  // purge-on-deploy comment for the cleanup this required.)
  const dedupeKey = centralEventId
    || `${ts ? ts.toISOString() : 'unknown'}::${deviceMac || 'unknown'}::${type || 'unknown'}`;
  return {
    central_event_id: centralEventId,
    dedupe_key: dedupeKey,
    ts,
    device_type: str(pick(eventRaw, ['device_type'])),
    device_mac: deviceMac,
    serial: str(pick(eventRaw, ['device_serial'])),
    hostname: str(pick(eventRaw, ['hostname'])),
    level: str(pick(eventRaw, ['level'])),
    type,
    description: str(pick(eventRaw, ['description'])),
  };
}

// Runaway-pagination backstop — a misbehaving response that always reports
// count < total would otherwise loop indefinitely. 20 pages is generous
// headroom over anything this integration's event volume should produce in
// one poll window.
const EVENTS_MAX_PAGES = 20;

// One controller's events pass. Never throws — mirrors pollRf()'s
// never-throws contract; a failure here must not affect AP/RF/client
// polling. windowSec/marginSec let the caller (wirelessCollector.js) control
// the poll window + overlap without this function needing to know about
// timers.
async function pollEvents(controller, pool, windowSec, marginSec) {
  try {
    const accessToken = controller.api_access_token;
    const expiresAt = controller.api_token_expires_at ? new Date(controller.api_token_expires_at).getTime() : NaN;
    if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      console.warn(
        `[wireless-events] aruba_central "${controller.name}": no valid stored access token — ` +
        'skipping this events cycle (the next main poll will refresh it)'
      );
      return;
    }

    const window = timeWindow(windowSec, marginSec);
    const rawEvents = [];
    let offset = 0;
    for (let page = 0; page < EVENTS_MAX_PAGES; page++) {
      const body = await fetchEventsPage(controller, accessToken, window, offset);
      const pageEvents = eventArray(body);
      rawEvents.push(...pageEvents);

      const count = num(pick(body, ['count']));
      const total = num(pick(body, ['total']));
      if (count === null || total === null || count >= total || pageEvents.length === 0) break;
      offset += pageEvents.length;
    }

    for (const eventRaw of rawEvents) {
      const ev = mapEvent(eventRaw);
      try {
        await pool.query(
          `INSERT INTO wireless_central_events
             (controller_id, central_event_id, dedupe_key, ts, device_type,
              device_mac, serial, hostname, level, type, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (controller_id, dedupe_key) DO NOTHING`,
          [controller.id, ev.central_event_id, ev.dedupe_key, ev.ts, ev.device_type,
            ev.device_mac, ev.serial, ev.hostname, ev.level, ev.type, ev.description]);
      } catch (e) {
        // Per-event isolation: one bad row must never abort the rest of this
        // controller's events.
        console.warn(
          `[wireless-events] aruba_central "${controller.name}" event insert failed: ` +
          (e && e.message ? e.message : String(e))
        );
      }
    }

    if (rawEvents.length) {
      console.log(`[wireless-events] aruba_central "${controller.name}": ${rawEvents.length} event(s) fetched`);
    }
  } catch (e) {
    console.error(
      `[wireless-events] aruba_central "${controller.name}" events cycle failed:`,
      e && e.message ? e.message : String(e)
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TOP-N AP BANDWIDTH — independent cycle. Read before editing.
//
// VERIFIED returning real data: GET /monitoring/v2/aps/bandwidth_usage/topn
// -> { count, aps: [{ name, serial, rx_data_bytes, tx_data_bytes }] }. ONE
// bulk call (no per-AP fan-out) — cheap. This is the endpoint that surfaced
// the local-time-vs-UTC timestamp bug during verification, so it is the
// canonical test that timeWindow() above is being used correctly: a wrong
// (local-time) to_timestamp 400s here immediately with Central's
// "to_timestamp cannot be greater than current time" (error 0002).
// ─────────────────────────────────────────────────────────────────────────

function topBandwidthUrl(controller, window, count) {
  const base = String(controller.controller_url).replace(/\/+$/, '') + '/monitoring/v2/aps/bandwidth_usage/topn';
  const group = str(controller.api_group_filter);
  const params = [
    'count=' + count,
    'from_timestamp=' + window.from_timestamp,
    'to_timestamp=' + window.to_timestamp,
  ];
  if (group) params.push('group=' + encodeURIComponent(group));
  return base + '?' + params.join('&');
}

async function fetchTopBandwidth(controller, accessToken, window, count) {
  const url = topBandwidthUrl(controller, window, count);
  console.log('[wireless] aruba_central: GET', url);
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const tenantId = str(controller.api_customer_id);
  if (tenantId) headers.TenantID = tenantId;
  return fetchJsonVerbose(url, { method: 'GET', headers }, TIMEOUT_MS, 'top bandwidth fetch');
}

// Tolerant extraction, mirroring apArray()/clientArray()'s pattern.
function topBandwidthArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.aps)) return body.aps;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

// LIVE-VERIFIED response shape: { name, serial, rx_data_bytes, tx_data_bytes }.
function mapTopBandwidthAp(raw) {
  return {
    ap_name: str(pick(raw, ['name'])),
    serial: str(pick(raw, ['serial'])),
    rx_bytes: num(pick(raw, ['rx_data_bytes'])),
    tx_bytes: num(pick(raw, ['tx_data_bytes'])),
  };
}

// One controller's top-N bandwidth pass. Never throws, same contract as
// pollRf()/pollEvents() above.
async function pollTopBandwidth(controller, pool, windowSec, marginSec, count) {
  try {
    const accessToken = controller.api_access_token;
    const expiresAt = controller.api_token_expires_at ? new Date(controller.api_token_expires_at).getTime() : NaN;
    if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      console.warn(
        `[wireless-bw] aruba_central "${controller.name}": no valid stored access token — ` +
        'skipping this bandwidth cycle (the next main poll will refresh it)'
      );
      return;
    }

    const window = timeWindow(windowSec, marginSec);
    const body = await fetchTopBandwidth(controller, accessToken, window, count);
    const topAps = topBandwidthArray(body).map(mapTopBandwidthAp).filter((a) => a.serial);

    // Resolve ap_id by serial, same join strategy as the RF-enrichment pass.
    const apRows = (await pool.query(
      `SELECT id, serial_number FROM wireless_aps WHERE controller_id = $1 AND serial_number IS NOT NULL`,
      [controller.id]
    )).rows;
    const apBySerial = new Map(apRows.map((a) => [a.serial_number, a.id]));

    for (const ap of topAps) {
      try {
        await pool.query(
          `INSERT INTO wireless_ap_bandwidth_topn
             (controller_id, ap_id, ap_name, serial, rx_bytes, tx_bytes, window_start, window_end, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (controller_id, serial) DO UPDATE SET
             ap_id        = EXCLUDED.ap_id,
             ap_name      = EXCLUDED.ap_name,
             rx_bytes     = EXCLUDED.rx_bytes,
             tx_bytes     = EXCLUDED.tx_bytes,
             window_start = EXCLUDED.window_start,
             window_end   = EXCLUDED.window_end,
             updated_at   = NOW()`,
          [controller.id, apBySerial.get(ap.serial) || null, ap.ap_name, ap.serial,
            ap.rx_bytes, ap.tx_bytes,
            new Date(window.from_timestamp * 1000), new Date(window.to_timestamp * 1000)]);
      } catch (e) {
        console.warn(
          `[wireless-bw] aruba_central "${controller.name}" AP ${ap.serial} upsert failed: ` +
          (e && e.message ? e.message : String(e))
        );
      }
    }

    // Prune rows for APs no longer in this cycle's top-N — keeps the widget
    // honest, an AP that drops out of the top N shouldn't linger forever
    // showing a stale snapshot. Skipped entirely on a zero-result cycle (a
    // transient empty response must not wipe the last known-good snapshot).
    if (topAps.length) {
      const keepSerials = topAps.map((a) => a.serial);
      await pool.query(
        `DELETE FROM wireless_ap_bandwidth_topn WHERE controller_id = $1 AND serial <> ALL($2::text[])`,
        [controller.id, keepSerials]);
    }
  } catch (e) {
    console.error(
      `[wireless-bw] aruba_central "${controller.name}" bandwidth cycle failed:`,
      e && e.message ? e.message : String(e)
    );
  }
}

module.exports = {
  name: 'aruba_central',
  pollRf,
  fetchClients,
  pollEvents,
  pollTopBandwidth,
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

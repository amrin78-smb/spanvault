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

const { httpJson } = require('./_http');

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

// Tolerant band-name matcher. Central has been observed (and documented by
// third parties) to report a radio's band as a human-readable string on some
// API surfaces ("2.4GHz", "5GHz", "6GHz") and as an enum-style token on
// others ("RADIO_TYPE_2_4GHZ", "5GHZ_RADIO", etc.) — normalise and match by
// substring rather than assuming one exact shape.
function bandOf(raw) {
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
  return httpJson(apsUrl(controller), {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'TenantID': controller.api_customer_id || '',
    },
  }, TIMEOUT_MS);
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
  const qs = [
    'client_id=' + encodeURIComponent(controller.api_client_id || ''),
    'client_secret=' + encodeURIComponent(controller.api_client_secret || ''),
    'grant_type=refresh_token',
    'refresh_token=' + encodeURIComponent(controller.api_refresh_token || ''),
  ].join('&');
  const url = String(controller.controller_url).replace(/\/+$/, '') + '/oauth2/token?' + qs;

  const body = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, TIMEOUT_MS);

  const accessToken = str(pick(body, ['access_token']));
  const refreshToken = str(pick(body, ['refresh_token']));
  const expiresIn = num(pick(body, ['expires_in']));
  if (!accessToken || !refreshToken) {
    throw new Error('aruba_central: refresh response missing access_token/refresh_token');
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
// contract (matches omada.js's field set exactly). Returns { ap, radios } —
// radios is passed back out so collectSsidsFromAp() can also inspect it
// without re-deriving the array.
function mapAp(apRaw) {
  const radios = Array.isArray(apRaw.radios) ? apRaw.radios : [];
  const out = {
    name: str(pick(apRaw, ['name', 'ap_name', 'hostname'])),
    mac_address: str(pick(apRaw, ['macaddr', 'mac_address', 'mac'])),
    model: str(pick(apRaw, ['model', 'ap_model'])),
    ip_address: str(pick(apRaw, ['ip_address', 'ip'])),
    status: mapStatus(pick(apRaw, ['status', 'ap_status', 'state'])),
    radio_2g_channel: null,
    radio_5g_channel: null,
    radio_6g_channel: null,
    radio_2g_util_pct: null,
    radio_5g_util_pct: null,
    clients_2g: 0,
    clients_5g: 0,
    clients_6g: 0,
    clients_total: null,
    tx_power_2g: null,
    tx_power_5g: null,
    uptime_seconds: num(pick(apRaw, ['uptime', 'uptime_seconds'])),
    firmware_version: str(pick(apRaw, ['firmware_version', 'swversion', 'sw_version'])),
  };

  for (const radio of radios) {
    const band = bandOf(pick(radio, ['band', 'radio_type', 'radio_band', 'type']));
    if (!band) continue;
    const channel = num(pick(radio, ['channel', 'curr_channel', 'channel_number']));
    const util = num(pick(radio, ['utilization', 'channel_utilization', 'util']));
    const clients = int0(pick(radio, ['client_count', 'num_clients', 'clients']));
    const txPower = num(pick(radio, ['tx_power', 'eirp', 'power_level']));

    if (band === '2g') {
      out.radio_2g_channel = channel;
      out.radio_2g_util_pct = util;
      out.clients_2g = clients;
      out.tx_power_2g = txPower;
    } else if (band === '5g') {
      out.radio_5g_channel = channel;
      out.radio_5g_util_pct = util;
      out.clients_5g = clients;
      out.tx_power_5g = txPower;
    } else if (band === '6g') {
      out.radio_6g_channel = channel;
      out.clients_6g = clients;
      // The shared AP contract has no radio_6g_util_pct/tx_power_6g columns
      // (see omada.js/ubiquiti.js — 6g never carried them either), so there
      // is nothing further to map for this band.
    }
  }

  let total = num(pick(apRaw, ['client_count', 'clients', 'num_clients']));
  out.clients_total = total === null ? (out.clients_2g + out.clients_5g + out.clients_6g) : Math.trunc(total);

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

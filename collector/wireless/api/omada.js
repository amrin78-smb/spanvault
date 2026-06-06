'use strict';

// TP-Link Omada Controller REST API client (best-effort).
//
// TLS NOTE: see collector/wireless/api/_http.js. Omada controllers use a
// self-signed cert by default; TLS failures surface as thrown Errors here.
// Production should pass an undici dispatcher to handle self-signed certs.
//
// API NOTE: Omada's API shape varies significantly by major version
// (Controller v4 vs v5, and the standalone OpenAPI surface). This client
// targets the OpenAPI v1 surface for AP listing while logging in via the
// controller login endpoint. Endpoints are approximate:
//   POST {controller_url}/api/v2/login                               body { username, password } -> { result: { token } }
//   GET  {controller_url}/openapi/v1/{omadacId}/sites/{siteId}/aps   token header -> AP list
// omadacId / siteId are deployment-specific. They are read from
// controller.api_key formatted as "omadacId:siteId" when provided; otherwise
// the request is attempted without them (and will likely error, which the
// caller catches and reports as controller status = error).

const { httpJson } = require('./_http');

const TIMEOUT_MS = 15000;

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

// Parse "omadacId:siteId" out of controller.api_key.
function parseIds(controller) {
  const raw = controller && controller.api_key ? String(controller.api_key).trim() : '';
  if (!raw) return { omadacId: '', siteId: '' };
  const parts = raw.split(':');
  return {
    omadacId: (parts[0] || '').trim(),
    siteId: (parts[1] || '').trim(),
  };
}

function mapStatus(v) {
  // Omada often reports status as numeric (0 disconnected, 1 connected,
  // 2 isolated/heartbeat-missing, etc) or a string.
  const n = num(v);
  if (n !== null) {
    if (n === 1) return 'online';
    if (n === 0) return 'offline';
    return 'unknown';
  }
  const s = str(v);
  if (s === null) return 'unknown';
  const low = s.toLowerCase();
  if (low === 'connected' || low === 'online' || low === 'up') return 'online';
  if (low === 'disconnected' || low === 'offline' || low === 'down') return 'offline';
  return 'unknown';
}

// Omada list responses are commonly { errorCode: 0, result: { data: [...] } }.
function apArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  const r = body.result;
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') {
    if (Array.isArray(r.data)) return r.data;
    if (Array.isArray(r.aps)) return r.aps;
    if (Array.isArray(r.list)) return r.list;
  }
  return [];
}

async function login(controller) {
  const url = controller.controller_url + '/api/v2/login';
  const body = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      username: controller.api_username,
      password: controller.api_password,
    }),
  }, TIMEOUT_MS);
  const token = str(pick(body, ['token', 'access_token']))
    || str(pick(body.result || {}, ['token', 'access_token']));
  if (!token) throw new Error('omada login: no token in response');
  return token;
}

module.exports = {
  name: 'omada',
  async poll(controller) {
    if (!controller || !controller.controller_url) {
      throw new Error('omada: missing controller_url');
    }
    const { omadacId, siteId } = parseIds(controller);
    const token = await login(controller);

    // Build the OpenAPI v1 AP-list path. When ids are absent the path is
    // best-effort and will most likely error (caught by the caller).
    const idSeg = omadacId ? ('/' + encodeURIComponent(omadacId)) : '';
    const siteSeg = siteId ? ('/sites/' + encodeURIComponent(siteId)) : '/sites';
    const url = controller.controller_url + '/openapi/v1' + idSeg + siteSeg + '/aps';

    const body = await httpJson(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + token,
        // Some Omada versions expect the token under a custom header instead:
        'Csrf-Token': token,
      },
    }, TIMEOUT_MS);

    const aps = apArray(body);
    const out = [];
    for (const ap of aps) {
      const c2 = int0(pick(ap, ['clientNum2g', 'clients_2g', 'client2g', 'sta2g']));
      const c5 = int0(pick(ap, ['clientNum5g', 'clients_5g', 'client5g', 'sta5g']));
      const c6 = int0(pick(ap, ['clientNum6g', 'clients_6g', 'client6g', 'sta6g']));
      let total = num(pick(ap, ['clientNum', 'clients_total', 'clientNumber', 'numSta', 'clients']));
      total = total === null ? (c2 + c5 + c6) : Math.trunc(total);

      out.push({
        name: str(pick(ap, ['name', 'apName', 'deviceName'])),
        mac_address: str(pick(ap, ['mac', 'mac_address', 'macAddress'])),
        model: str(pick(ap, ['model', 'showModel', 'deviceModel'])),
        ip_address: str(pick(ap, ['ip', 'ip_address', 'ipAddress'])),
        status: mapStatus(pick(ap, ['status', 'state', 'statusCategory'])),
        radio_2g_channel: num(pick(ap, ['channel2g', 'radio_2g_channel', 'chan2g'])),
        radio_5g_channel: num(pick(ap, ['channel5g', 'radio_5g_channel', 'chan5g'])),
        radio_6g_channel: num(pick(ap, ['channel6g', 'radio_6g_channel', 'chan6g'])),
        radio_2g_util_pct: num(pick(ap, ['txUtil2g', 'util2g', 'radio_2g_util_pct', 'channelUtil2g'])),
        radio_5g_util_pct: num(pick(ap, ['txUtil5g', 'util5g', 'radio_5g_util_pct', 'channelUtil5g'])),
        clients_2g: c2,
        clients_5g: c5,
        clients_6g: c6,
        clients_total: total,
        tx_power_2g: num(pick(ap, ['txPower2g', 'power2g', 'tx_power_2g'])),
        tx_power_5g: num(pick(ap, ['txPower5g', 'power5g', 'tx_power_5g'])),
        uptime_seconds: num(pick(ap, ['uptime', 'uptimeLong', 'uptime_seconds'])),
        firmware_version: str(pick(ap, ['firmwareVersion', 'firmware', 'version', 'fwVersion'])),
      });
    }
    return out;
  },
};

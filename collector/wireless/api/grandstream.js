'use strict';

// Grandstream GWN Manager / GWN.Cloud (local) REST API client.
//
// TLS NOTE: see collector/wireless/api/_http.js. Self-signed certs on the
// controller surface as thrown TLS errors here; production should supply an
// undici dispatcher to handle them.
//
// ENDPOINT NOTE: Grandstream's local management API surface is only loosely
// documented and varies by GWN Manager firmware version. The endpoints below
// are best-effort / approximate:
//   POST {controller_url}/api/login                  body { username, password } -> { token } | { access_token }
//   GET  {controller_url}/api/v1/device/ap/list      Bearer token -> AP inventory
//   GET  {controller_url}/api/v1/device/ap/status    Bearer token -> AP status + client counts
// The list and status results are merged by AP MAC (falling back to serial).

const { httpJson } = require('./_http');

const TIMEOUT_MS = 15000;

// num: finite Number or null.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// int0: finite integer or 0 (for client counts).
function int0(v) {
  const n = num(v);
  return n === null ? 0 : Math.trunc(n);
}

// str: trimmed non-empty string or null.
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// pick: first non-undefined/null property from obj across candidate keys.
function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

// asArray: tolerate various response envelopes for list-shaped payloads.
function asArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const cands = [body.data, body.result, body.aps, body.list, body.devices];
  for (const c of cands) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === 'object') {
      if (Array.isArray(c.aps)) return c.aps;
      if (Array.isArray(c.list)) return c.list;
      if (Array.isArray(c.data)) return c.data;
    }
  }
  return [];
}

function keyOf(o) {
  const mac = str(pick(o, ['mac', 'mac_address', 'macAddress']));
  if (mac) return mac.toLowerCase();
  const sn = str(pick(o, ['serial', 'serial_number', 'sn']));
  return sn ? sn.toLowerCase() : null;
}

function mapStatus(v) {
  const s = str(v);
  if (s === null) return 'unknown';
  const low = s.toLowerCase();
  if (low === 'online' || low === 'up' || low === '1' || low === 'true' || low === 'connected') return 'online';
  if (low === 'offline' || low === 'down' || low === '0' || low === 'false' || low === 'disconnected') return 'offline';
  return 'unknown';
}

async function login(controller) {
  const url = controller.controller_url + '/api/login';
  const body = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      username: controller.api_username,
      password: controller.api_password,
    }),
  }, TIMEOUT_MS);
  const token = str(pick(body, ['token', 'access_token', 'accessToken']))
    || str(pick(body.data || {}, ['token', 'access_token', 'accessToken']));
  if (!token) throw new Error('grandstream login: no token in response');
  return token;
}

async function getList(controller, token, path) {
  const url = controller.controller_url + path;
  return httpJson(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
  }, TIMEOUT_MS);
}

module.exports = {
  name: 'grandstream',
  async poll(controller) {
    if (!controller || !controller.controller_url) {
      throw new Error('grandstream: missing controller_url');
    }
    const token = await login(controller);

    const [listBody, statusBody] = await Promise.all([
      getList(controller, token, '/api/v1/device/ap/list'),
      getList(controller, token, '/api/v1/device/ap/status'),
    ]);

    const list = asArray(listBody);
    const statuses = asArray(statusBody);

    // Index status records by AP key for merge.
    const statusByKey = {};
    for (const s of statuses) {
      const k = keyOf(s);
      if (k) statusByKey[k] = s;
    }

    const out = [];
    for (const item of list) {
      const k = keyOf(item);
      const st = (k && statusByKey[k]) ? statusByKey[k] : {};
      const merged = Object.assign({}, item, st);

      const c2 = int0(pick(merged, ['clients_2g', 'client_2g', 'sta_2g', 'num_sta_2g']));
      const c5 = int0(pick(merged, ['clients_5g', 'client_5g', 'sta_5g', 'num_sta_5g']));
      const c6 = int0(pick(merged, ['clients_6g', 'client_6g', 'sta_6g', 'num_sta_6g']));
      let total = num(pick(merged, ['clients_total', 'client_total', 'clients', 'num_sta', 'sta_total']));
      total = total === null ? (c2 + c5 + c6) : Math.trunc(total);

      out.push({
        name: str(pick(merged, ['name', 'ap_name', 'device_name', 'hostname'])),
        mac_address: str(pick(merged, ['mac', 'mac_address', 'macAddress'])),
        model: str(pick(merged, ['model', 'product_model', 'device_model'])),
        ip_address: str(pick(merged, ['ip', 'ip_address', 'ipAddress'])),
        status: mapStatus(pick(merged, ['status', 'state', 'online'])),
        radio_2g_channel: num(pick(merged, ['radio_2g_channel', 'channel_2g', 'chan_2g'])),
        radio_5g_channel: num(pick(merged, ['radio_5g_channel', 'channel_5g', 'chan_5g'])),
        radio_6g_channel: num(pick(merged, ['radio_6g_channel', 'channel_6g', 'chan_6g'])),
        radio_2g_util_pct: num(pick(merged, ['radio_2g_util_pct', 'util_2g', 'channel_util_2g'])),
        radio_5g_util_pct: num(pick(merged, ['radio_5g_util_pct', 'util_5g', 'channel_util_5g'])),
        clients_2g: c2,
        clients_5g: c5,
        clients_6g: c6,
        clients_total: total,
        tx_power_2g: num(pick(merged, ['tx_power_2g', 'txpower_2g', 'power_2g'])),
        tx_power_5g: num(pick(merged, ['tx_power_5g', 'txpower_5g', 'power_5g'])),
        uptime_seconds: num(pick(merged, ['uptime', 'uptime_seconds', 'up_time'])),
        firmware_version: str(pick(merged, ['firmware', 'firmware_version', 'fw_version', 'version'])),
      });
    }
    return out;
  },
};

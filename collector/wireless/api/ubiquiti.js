'use strict';

// Ubiquiti UniFi Controller (local) REST API client — cookie auth.
//
// TLS NOTE: see collector/wireless/api/_http.js. UniFi controllers ship a
// self-signed cert by default; TLS failures surface as thrown Errors here.
// Production should pass an undici dispatcher to handle self-signed certs.
//
// API NOTE: This implements the CLASSIC UniFi controller API path:
//   POST {controller_url}/api/login                       body { username, password } -> Set-Cookie
//   GET  {controller_url}/api/s/{site}/stat/device        -> device list (filter type === 'uap')
//   GET  {controller_url}/api/s/{site}/stat/sta           -> connected clients
// Newer UniFi OS consoles (UDM/UDM-Pro/Cloud Key Gen2+) proxy the network
// application under /proxy/network and use POST /api/auth/login. If you target
// those, prefix paths with '/proxy/network' and adjust the login endpoint.
// We capture the Set-Cookie header from login and replay it on later requests.

const { httpFetch, httpJson } = require('./_http');

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

// resolveSite: use controller.site_name if it looks like a UniFi site id
// (short alphanumeric token, no spaces), else default to 'default'.
function resolveSite(controller) {
  const s = controller && controller.site_name ? String(controller.site_name).trim() : '';
  if (s && /^[A-Za-z0-9_-]+$/.test(s)) return s;
  return 'default';
}

// Parse the Set-Cookie header(s) into a single "k=v; k2=v2" Cookie string.
function buildCookie(setCookie) {
  if (!setCookie) return '';
  const parts = [];
  for (const sc of setCookie) {
    if (!sc) continue;
    // Take the "name=value" portion before the first ';' (drop attributes).
    const first = String(sc).split(';')[0].trim();
    if (first) parts.push(first);
  }
  return parts.join('; ');
}

// Read Set-Cookie headers from a Response across runtime variants.
function extractSetCookie(res) {
  if (res && res.headers && typeof res.headers.getSetCookie === 'function') {
    const arr = res.headers.getSetCookie();
    if (arr && arr.length) return arr;
  }
  const single = res && res.headers ? res.headers.get('set-cookie') : null;
  return single ? [single] : [];
}

async function login(controller) {
  const url = controller.controller_url + '/api/login';
  const res = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      username: controller.api_username,
      password: controller.api_password,
    }),
  }, TIMEOUT_MS);
  // Drain body to free the socket; content is not needed for cookie auth.
  try { await res.text(); } catch (e) { /* ignore */ }
  const cookie = buildCookie(extractSetCookie(res));
  if (!cookie) throw new Error('unifi login: no auth cookie returned');
  return cookie;
}

async function getJsonWithCookie(controller, cookie, path) {
  const url = controller.controller_url + path;
  return httpJson(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Cookie': cookie },
  }, TIMEOUT_MS);
}

// UniFi list responses are { data: [...], meta: {...} }.
function dataArray(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

// Extract per-band channel + util from a UniFi radio_table / radio_table_stats.
function radioInfo(d) {
  const out = {
    ch2: null, ch5: null, ch6: null, util2: null, util5: null, txp2: null, txp5: null,
  };
  const table = Array.isArray(d.radio_table) ? d.radio_table : [];
  for (const r of table) {
    const band = str(r.radio); // 'ng' (2.4), 'na' (5), '6e' (6)
    const ch = num(r.channel);
    const txp = num(r.tx_power);
    if (band === 'ng') { out.ch2 = ch; if (txp !== null) out.txp2 = txp; }
    else if (band === 'na') { out.ch5 = ch; if (txp !== null) out.txp5 = txp; }
    else if (band === '6e' || band === 'ax6' || band === '6g') { out.ch6 = ch; }
  }
  const stats = Array.isArray(d.radio_table_stats) ? d.radio_table_stats : [];
  for (const s of stats) {
    const band = str(s.radio);
    // cu_total is channel utilization percent on newer firmwares.
    const util = num(s.cu_total !== undefined ? s.cu_total : s.channel_utilization);
    if (band === 'ng') out.util2 = util;
    else if (band === 'na') out.util5 = util;
  }
  return out;
}

module.exports = {
  name: 'ubiquiti',
  async poll(controller) {
    if (!controller || !controller.controller_url) {
      throw new Error('ubiquiti: missing controller_url');
    }
    const site = resolveSite(controller);
    const cookie = await login(controller);

    const [devBody, staBody] = await Promise.all([
      getJsonWithCookie(controller, cookie, '/api/s/' + site + '/stat/device'),
      getJsonWithCookie(controller, cookie, '/api/s/' + site + '/stat/sta'),
    ]);

    const devices = dataArray(devBody);
    const clients = dataArray(staBody);

    // Tally clients per AP-mac per band as a fallback when the device record
    // doesn't carry na-num_sta / ng-num_sta directly.
    const tally = {}; // ap_mac -> { c2, c5, c6 }
    for (const c of clients) {
      const apMac = str(c.ap_mac);
      if (!apMac) continue;
      const k = apMac.toLowerCase();
      if (!tally[k]) tally[k] = { c2: 0, c5: 0, c6: 0 };
      // is_11ax/radio: classify by 'radio' field or radio_proto when present.
      const radio = str(c.radio); // 'ng' | 'na' | '6e'
      if (radio === 'na') tally[k].c5 += 1;
      else if (radio === '6e' || radio === '6g') tally[k].c6 += 1;
      else tally[k].c2 += 1;
    }

    const out = [];
    for (const d of devices) {
      if (str(d.type) !== 'uap') continue;
      const r = radioInfo(d);
      const mac = str(d.mac);
      const t = (mac && tally[mac.toLowerCase()]) ? tally[mac.toLowerCase()] : { c2: 0, c5: 0, c6: 0 };

      // Prefer device-reported per-band counts when present.
      const c2 = d['ng-num_sta'] !== undefined ? int0(d['ng-num_sta']) : t.c2;
      const c5 = d['na-num_sta'] !== undefined ? int0(d['na-num_sta']) : t.c5;
      const c6 = d['6e-num_sta'] !== undefined ? int0(d['6e-num_sta']) : t.c6;
      let total = num(d.num_sta);
      total = total === null ? (c2 + c5 + c6) : Math.trunc(total);

      out.push({
        name: str(d.name) || mac,
        mac_address: mac,
        model: str(d.model),
        ip_address: str(d.ip),
        status: num(d.state) === 1 ? 'online' : (d.state === undefined ? 'unknown' : 'offline'),
        radio_2g_channel: r.ch2,
        radio_5g_channel: r.ch5,
        radio_6g_channel: r.ch6,
        radio_2g_util_pct: r.util2,
        radio_5g_util_pct: r.util5,
        clients_2g: c2,
        clients_5g: c5,
        clients_6g: c6,
        clients_total: total,
        tx_power_2g: r.txp2,
        tx_power_5g: r.txp5,
        uptime_seconds: num(d.uptime),
        firmware_version: str(d.version),
      });
    }
    return out;
  },
};

'use strict';
/**
 * SpanVault Agent — polls local devices, reports to the SpanVault server.
 *
 * The agent is DUMB: it only polls (ICMP + SNMP) and ships results over a single
 * outbound WebSocket. No local alerting, no local storage beyond buffer.json
 * (used to hold results while the server is unreachable, flushed on reconnect).
 * The server pushes device config on connect and does all alert evaluation.
 *
 * Config: agent/config.json  { serverUrl, apiKey, wsPort? }
 * Buffer: agent/buffer.json  — results queued while offline (capped at MAX_BUFFER)
 */
const WebSocket = require('ws');
const ping = require('ping');
const snmp = require('net-snmp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const BUFFER_PATH = path.join(__dirname, 'buffer.json');
const VERSION = '1.2.0';
const MAX_BUFFER = 500;

// ── Config ────────────────────────────────────────────────────
// Strip a leading UTF-8 BOM (U+FEFF) — PowerShell can write config.json with one
// and JSON.parse rejects it.
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
const { serverUrl, apiKey } = config;
const WS_PORT = config.wsPort || 3010;

// ── Log ring ──────────────────────────────────────────────────
// Keep the last N log lines in memory so the central UI can pull a live tail
// without needing filesystem access to the remote NSSM log.
const LOG_RING = [];
const LOG_RING_MAX = 300;
function ringPush(level, args) {
  const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_e) { return String(a); } })())).join(' ');
  LOG_RING.push(`${new Date().toISOString()} ${level} ${text}`);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.shift();
}
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...a) => { ringPush('INFO', a); _log(...a); };
console.error = (...a) => { ringPush('ERROR', a); _err(...a); };

// ── State ─────────────────────────────────────────────────────
let ws = null;
let devices = [];
let settings = {};
const pollTimers = new Map();
let reconnectTimeout = null;
let reconnectAttempts = 0;
let buffer = loadBuffer();

function loadBuffer() {
  try { return JSON.parse(fs.readFileSync(BUFFER_PATH, 'utf8')); }
  catch { return []; }
}
function saveBuffer() {
  try { fs.writeFileSync(BUFFER_PATH, JSON.stringify(buffer.slice(-MAX_BUFFER))); }
  catch (e) { console.error('[Agent] Buffer save error:', e.message); }
}
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // Heartbeats are worthless once stale — a buffered one replayed on reconnect
    // would bump last_seen_at to NOW() and mask how long the agent was actually
    // gone. Only buffer real poll results.
    if (msg.type === 'heartbeat') return;
    buffer.push(msg);
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    saveBuffer();
  }
}

// ── Connection ────────────────────────────────────────────────
function connect() {
  // Build the WS URL from the server host + dedicated WS port. Strip any port on
  // serverUrl (which usually points at the frontend, e.g. http://host:3008) so we
  // never produce host:3008:3010.
  let host = serverUrl;
  try { host = new URL(serverUrl).hostname; } catch { /* serverUrl may be bare */ }
  const wsProto = /^https/i.test(serverUrl) ? 'wss' : 'ws';
  // Send the API key in the Authorization header rather than the URL so it never
  // lands in proxy/access logs. (The ws client supports custom headers.)
  const wsUrl = `${wsProto}://${host}:${WS_PORT}/`;
  console.log('[Agent] Connecting to', wsUrl);
  ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });

  ws.on('open', () => {
    console.log('[Agent] Connected to SpanVault server');
    reconnectAttempts = 0; // reset backoff on a successful connect
    sendHeartbeat();
    // Flush any buffered results accumulated while offline.
    if (buffer.length > 0) {
      ws.send(JSON.stringify({ type: 'batch', results: buffer }));
      console.log(`[Agent] Flushed ${buffer.length} buffered result(s)`);
      buffer = [];
      saveBuffer();
    }
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'config') applyConfig(msg);
      else if (msg.type === 'discover') {
        runDiscovery(msg).catch((e) => console.error('[Agent] Discovery error:', e.message));
      } else if (msg.type === 'restart') {
        console.log('[Agent] Restart requested by server — exiting (service will restart)');
        process.exit(0);
      } else if (msg.type === 'get_logs') {
        try { ws.send(JSON.stringify({ type: 'logs', lines: LOG_RING.slice(-200) })); } catch (_e) { /* ignore */ }
      }
    } catch (e) { console.error('[Agent] Message error:', e.message); }
  });

  ws.on('close', () => {
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[Agent] WS error:', err.message);
    scheduleReconnect();
  });
}

// Exponential backoff with jitter, capped at 2 minutes, so a fleet of agents
// doesn't reconnect in lockstep and hammer the server after an outage.
function scheduleReconnect() {
  reconnectAttempts++;
  const base = Math.min(120000, 10000 * Math.pow(1.5, reconnectAttempts - 1));
  const delay = Math.round(base * (0.8 + Math.random() * 0.4));
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(connect, delay);
  console.log(`[Agent] Disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
}

// ── Agent host health ─────────────────────────────────────────
// Sampled and shipped on each heartbeat so operators can see the agent box's own
// health (not just the devices it polls) and spot a struggling collector early.
let prevCpu = cpuSample();
let lastDiskPct = null;

function cpuSample() {
  let idle = 0, total = 0;
  for (const c of os.cpus() || []) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
function cpuPct() {
  const cur = cpuSample();
  const dIdle = cur.idle - prevCpu.idle;
  const dTotal = cur.total - prevCpu.total;
  prevCpu = cur;
  if (dTotal <= 0) return null;
  return Math.round((1 - dIdle / dTotal) * 1000) / 10;
}
function sampleDisk() {
  try {
    if (typeof fs.statfs !== 'function') return; // Node < 18.15
    fs.statfs(__dirname, (err, st) => {
      if (err || !st || !st.blocks) return;
      const total = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      lastDiskPct = total ? Math.round(((total - free) / total) * 1000) / 10 : null;
    });
  } catch (_e) { /* ignore */ }
}
setInterval(sampleDisk, 60000);
sampleDisk();

function buildHealth() {
  const totalMem = os.totalmem();
  return {
    cpu_pct: cpuPct(),
    mem_pct: totalMem ? Math.round((1 - os.freemem() / totalMem) * 1000) / 10 : null,
    disk_pct: lastDiskPct,
    host_uptime_s: Math.round(os.uptime()),
    agent_uptime_s: Math.round(process.uptime()),
    device_count: devices.length,
    buffer_depth: buffer.length,
  };
}

function sendHeartbeat() {
  send({ type: 'heartbeat', version: VERSION, hostname: os.hostname(), health: buildHealth() });
}
setInterval(sendHeartbeat, 30000);

// ── Config application ────────────────────────────────────────
function applyConfig(msg) {
  devices = msg.devices || [];
  settings = msg.settings || {};
  console.log(`[Agent] Config received: ${devices.length} device(s)`);
  for (const t of pollTimers.values()) clearInterval(t);
  pollTimers.clear();
  for (const device of devices) schedulePoll(device);
  // The server advertises the canonical agent.js fingerprint with every config.
  if (msg.agent_sha) maybeSelfUpdate(msg.agent_sha);
}

// ── Self-update ───────────────────────────────────────────────
// The server sends the sha256 of its canonical agent.js. If ours differs, pull
// the new file, verify it hashes to exactly what the server advertised, overwrite
// ourselves, and exit so NSSM restarts us on the new code. No version math, no
// update loops (after restart our hash matches and we no-op).
let updating = false;

function ownFileSha() {
  try { return crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'); }
  catch (_e) { return ''; }
}
function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = /^https/i.test(url) ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
async function maybeSelfUpdate(serverSha) {
  if (!serverSha || updating) return;
  if (ownFileSha() === serverSha) return;
  updating = true;
  try {
    console.log('[Agent] New agent version advertised — downloading update...');
    const body = await httpGetBuffer(`${serverUrl}/api/agent/agent.js`);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    if (sha !== serverSha) {
      console.log('[Agent] Downloaded agent.js does not match advertised fingerprint — skipping update');
      updating = false;
      return;
    }
    fs.writeFileSync(__filename, body);
    console.log('[Agent] Updated agent.js — exiting so the service restarts on the new version');
    process.exit(0);
  } catch (e) {
    console.error('[Agent] Self-update failed:', e.message);
    updating = false;
  }
}

function schedulePoll(device) {
  const interval = (device.poll_interval_seconds ||
    parseInt(settings.icmp_poll_interval_seconds, 10) || 300) * 1000;
  const run = () => pollDevice(device).catch(
    (e) => console.error(`[Agent] Poll error for ${device.name || device.id}:`, e.message));
  run();
  const t = setInterval(run, interval);
  pollTimers.set(device.id, t);
}

async function pollDevice(device) {
  await doPing(device);
  if (device.snmp_enabled) await doSnmp(device);
}

// ── ICMP ──────────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';

async function doPing(device) {
  const countFlag = IS_WIN ? '-n' : '-c';
  try {
    const res = await ping.promise.probe(device.ip_address, { timeout: 5, extra: [countFlag, '3'] });
    let ms = null;
    if (res.alive && res.avg !== undefined && res.avg !== 'unknown') {
      const t = parseFloat(res.avg);
      if (!isNaN(t)) ms = t;
    }
    const threshold = device.ping_threshold_ms || 500;
    const status = res.alive ? (ms !== null && ms > threshold ? 'warning' : 'up') : 'down';
    send({
      type: 'ping_result', device_id: device.id,
      ts: new Date().toISOString(), response_ms: ms,
      packet_loss_pct: res.alive ? 0 : 100, status,
    });
  } catch (e) {
    send({
      type: 'ping_result', device_id: device.id,
      ts: new Date().toISOString(), response_ms: null,
      packet_loss_pct: 100, status: 'down',
    });
  }
}

// ── SNMP ──────────────────────────────────────────────────────
const SNMP_OID = {
  cpu_pct:   '1.3.6.1.2.1.25.3.3.1.2.1',
  mem_used:  '1.3.6.1.2.1.25.2.3.1.6.1',
  mem_total: '1.3.6.1.2.1.25.2.3.1.5.1',
  uptime:    '1.3.6.1.2.1.1.3.0',
};

function snmpGet(session, oid) {
  return new Promise((resolve) => {
    session.get([oid], (err, varbinds) => {
      if (!err && varbinds[0] && !snmp.isVarbindError(varbinds[0])) {
        const v = Number(varbinds[0].value);
        resolve(isNaN(v) ? null : v);
      } else {
        resolve(null);
      }
    });
  });
}

// Build a version-aware SNMP session (matches collector/snmp-session.js so v3
// devices assigned to an agent poll identically to locally-polled ones).
function createSnmpSession(device) {
  const port = device.snmp_port || 161;
  const opts = { port, timeout: 3000, retries: 1 };
  if (String(device.snmp_version) === '3') {
    opts.version = snmp.Version3;
    const user = {
      name: device.snmp_v3_user || '',
      level: device.snmp_v3_priv_pass
        ? snmp.SecurityLevel.authPriv
        : (device.snmp_v3_auth_pass ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv),
      authProtocol: snmp.AuthProtocols.sha,
      authKey: device.snmp_v3_auth_pass || undefined,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: device.snmp_v3_priv_pass || undefined,
    };
    return snmp.createV3Session(device.ip_address, user, opts);
  }
  opts.version = String(device.snmp_version) === '1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(device.ip_address, device.snmp_community || 'public', opts);
}

async function doSnmp(device) {
  const session = createSnmpSession(device);
  const ts = new Date().toISOString();

  try {
    const [cpu, memUsed, memTotal, uptime] = await Promise.all([
      snmpGet(session, SNMP_OID.cpu_pct),
      snmpGet(session, SNMP_OID.mem_used),
      snmpGet(session, SNMP_OID.mem_total),
      snmpGet(session, SNMP_OID.uptime),
    ]);

    if (cpu !== null) {
      send({ type: 'snmp_result', device_id: device.id, ts,
             oid: SNMP_OID.cpu_pct, metric_name: 'cpu_pct', value: cpu });
    }
    if (memUsed !== null && memTotal !== null && memTotal > 0) {
      send({ type: 'snmp_result', device_id: device.id, ts,
             oid: SNMP_OID.mem_used, metric_name: 'mem_pct',
             value: Math.round((memUsed / memTotal) * 1000) / 10 });
    }
    if (uptime !== null) {
      send({ type: 'snmp_result', device_id: device.id, ts,
             oid: SNMP_OID.uptime, metric_name: 'uptime', value: uptime });
    }
  } catch (e) {
    console.error(`[Agent] SNMP error for ${device.ip_address}:`, e.message);
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

// ── Zero-touch discovery ──────────────────────────────────────
// On a server "discover" command, sweep the agent's local /24(s) with ICMP, then
// SNMP-probe responders for sysName/sysDescr and report candidates. This is what
// lets an operator drop an agent at a site and adopt everything it finds — no
// manual device entry. Self-contained (ping + net-snmp only).
let discovering = false;

function localSubnets() {
  const seen = new Set();
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const parts = String(a.address).split('.');
      if (parts.length !== 4) continue;
      const base = `${parts[0]}.${parts[1]}.${parts[2]}`; // bound the sweep to the /24
      if (!seen.has(base)) { seen.add(base); out.push({ base, self: a.address }); }
    }
  }
  return out;
}

function pingHost(ip) {
  return ping.promise.probe(ip, { timeout: 1, extra: [IS_WIN ? '-n' : '-c', '1'] })
    .then((r) => !!r.alive).catch(() => false);
}

function snmpProbe(ip, communities) {
  const tries = (communities && communities.length) ? communities : ['public'];
  return tryCommunity(ip, tries, 0);
}
function tryCommunity(ip, tries, i) {
  if (i >= tries.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let session;
    try {
      session = snmp.createSession(ip, tries[i], { timeout: 1500, retries: 0, version: snmp.Version2c });
    } catch (_e) { return resolve(null); }
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { session.close(); } catch (_e) {} resolve(v); };
    const timer = setTimeout(() => finish(null), 2500);
    // sysName (1.3.6.1.2.1.1.5.0), sysDescr (1.3.6.1.2.1.1.1.0)
    session.get(['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.1.0'], (err, vbs) => {
      clearTimeout(timer);
      if (err || !vbs) return finish(null);
      const val = (k) => (vbs[k] && !snmp.isVarbindError(vbs[k])) ? String(vbs[k].value) : '';
      const sysName = val(0), sysDescr = val(1);
      if (!sysName && !sysDescr) return finish(null);
      finish({ sys_name: sysName, sys_descr: sysDescr, community: tries[i] });
    });
  }).then((v) => v || tryCommunity(ip, tries, i + 1));
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (next < items.length) { const idx = next++; ret[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return ret;
}

async function runDiscovery(msg) {
  if (discovering) { console.log('[Agent] Discovery already running — ignoring'); return; }
  discovering = true;
  try {
    const communities = (msg && Array.isArray(msg.communities) && msg.communities.length) ? msg.communities : ['public'];
    const subnets = localSubnets();
    console.log(`[Agent] Discovery: sweeping ${subnets.length} subnet(s)`);
    const hosts = [];
    for (const sn of subnets) {
      const ips = [];
      for (let h = 1; h <= 254; h++) ips.push(`${sn.base}.${h}`);
      const alive = (await mapLimit(ips, 32, async (ip) => (await pingHost(ip)) ? ip : null)).filter(Boolean);
      const probed = await mapLimit(alive, 16, async (ip) => {
        const info = await snmpProbe(ip, communities);
        return {
          ip_address: ip, snmp_ok: !!info,
          sys_name: info ? info.sys_name : '', sys_descr: info ? info.sys_descr : '',
        };
      });
      hosts.push(...probed);
    }
    console.log(`[Agent] Discovery: ${hosts.length} live host(s) found`);
    send({ type: 'discovery', hosts });
  } finally {
    discovering = false;
  }
}

// ── Start ─────────────────────────────────────────────────────
connect();
console.log(`[Agent] SpanVault Agent v${VERSION} started`);

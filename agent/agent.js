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

const CONFIG_PATH = path.join(__dirname, 'config.json');
const BUFFER_PATH = path.join(__dirname, 'buffer.json');
const VERSION = '1.0.0';
const MAX_BUFFER = 500;

// ── Config ────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { serverUrl, apiKey } = config;
const WS_PORT = config.wsPort || 3010;

// ── State ─────────────────────────────────────────────────────
let ws = null;
let devices = [];
let settings = {};
const pollTimers = new Map();
let reconnectTimeout = null;
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
  const wsUrl = `${wsProto}://${host}:${WS_PORT}/?key=${encodeURIComponent(apiKey)}`;
  console.log('[Agent] Connecting to', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[Agent] Connected to SpanVault server');
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
    } catch (e) { console.error('[Agent] Message error:', e.message); }
  });

  ws.on('close', () => {
    console.log('[Agent] Disconnected. Reconnecting in 10s...');
    scheduleReconnect(10000);
  });

  ws.on('error', (err) => {
    console.error('[Agent] WS error:', err.message);
    scheduleReconnect(10000);
  });
}

function scheduleReconnect(delay) {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(connect, delay);
}

function sendHeartbeat() {
  send({ type: 'heartbeat', version: VERSION, hostname: os.hostname() });
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
}

function schedulePoll(device) {
  const interval = (device.poll_interval_seconds ||
    parseInt(settings.icmp_poll_interval_seconds, 10) || 300) * 1000;
  pollDevice(device);
  const t = setInterval(() => pollDevice(device), interval);
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

async function doSnmp(device) {
  const community = device.snmp_community || 'public';
  const port = device.snmp_port || 161;
  const session = snmp.createSession(device.ip_address, community, { port });
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

// ── Start ─────────────────────────────────────────────────────
connect();
console.log(`[Agent] SpanVault Agent v${VERSION} started`);

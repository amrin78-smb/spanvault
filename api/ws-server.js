'use strict';

/**
 * ws-server.js — SpanVault WebSocket server for distributed polling agents.
 *
 * Agents connect outbound to ws://<server>:SV_WS_PORT/?key=<api_key>. On connect
 * the server validates the API key, marks the agent online, and pushes its device
 * config. Agents then ship heartbeats + ping/snmp results (or a buffered batch on
 * reconnect). The server does ALL alert evaluation + storage — the agent is dumb.
 *
 * Plain JavaScript only — no TypeScript syntax. Started from api/server.js.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const { OID } = require('../collector/snmp-session');
const { detectVendor } = require('../collector/parsers');
const {
  collectCandidates, candidatesToSamples, buildFetchPlan, PrefetchedSession,
} = require('../collector/discovery');

const AGENT_JS = path.join(__dirname, '..', 'agent', 'agent.js');

// Per-device interface octet history for bps deltas on agent-polled devices
// (mirrors the collector's ifPrev for locally-polled devices).
const agentIfPrev = new Map();

// Fingerprint + version of the canonical agent.js, advertised to agents so they
// can self-update. Cached and refreshed when the file's mtime changes.
let _agentMeta = null;
function agentMeta() {
  try {
    const stat = fs.statSync(AGENT_JS);
    if (_agentMeta && _agentMeta.mtimeMs === stat.mtimeMs) return _agentMeta;
    const buf = fs.readFileSync(AGENT_JS);
    const txt = buf.toString('utf8');
    const m = txt.match(/const VERSION = '([^']+)'/);
    _agentMeta = {
      mtimeMs: stat.mtimeMs,
      sha: crypto.createHash('sha256').update(buf).digest('hex'),
      version: m ? m[1] : null,
    };
  } catch (_e) {
    _agentMeta = { mtimeMs: 0, sha: '', version: null };
  }
  return _agentMeta;
}

// agents.health is a later migration — probe once so heartbeats don't error on
// an un-migrated DB.
let _healthCol = null;
async function hasHealthCol() {
  if (_healthCol !== null) return _healthCol;
  try {
    const r = await sv.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='agents' AND column_name='health') AS x`);
    _healthCol = !!r.rows[0].x;
  } catch (_e) { _healthCol = false; }
  return _healthCol;
}

// SpanVault DB (read/write) — own pool so this module is self-contained.
const sv = new Pool({
  host:     process.env.SV_DB_HOST || 'localhost',
  port:     parseInt(process.env.SV_DB_PORT || '5432', 10),
  database: process.env.SV_DB_NAME || 'spanvault',
  user:     process.env.SV_DB_USER || 'spanvault_user',
  password: process.env.SV_DB_PASS || '',
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30000,
});
sv.on('error', (err) => console.error('[WS DB] Pool error:', err.message));

// Map of api_key → live WebSocket connection.
const connectedAgents = new Map();

// Map of agent_id → { lines, ts } — last log tail an agent pushed on request.
const agentLogs = new Map();

// Read the agent's API key from the Authorization header (preferred — keeps the
// secret out of URLs and proxy/access logs) and fall back to the legacy ?key=
// query param so already-deployed agents keep working during a rolling upgrade.
function getApiKey(req) {
  const auth = req.headers && req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  try { return new URL(req.url, 'ws://x').searchParams.get('key'); } catch (_e) { return null; }
}

// Forcibly drop a connected agent by api_key (used when it is disabled/rotated).
function disconnectAgent(apiKey, reason) {
  const ws = connectedAgents.get(apiKey);
  if (ws) { try { ws.close(4003, reason || 'Disconnected'); } catch (_e) { /* ignore */ } }
}

function startWsServer(port) {
  // Optional TLS: if a cert + key are configured, terminate wss:// here. Otherwise
  // serve plain ws:// (expected on trusted LAN / behind a TLS-terminating proxy).
  let wss;
  const certPath = process.env.SV_WS_TLS_CERT;
  const keyPath = process.env.SV_WS_TLS_KEY;
  if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const httpsServer = require('https').createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    });
    wss = new WebSocketServer({ server: httpsServer });
    httpsServer.listen(port);
    console.log('[WS] TLS enabled (SV_WS_TLS_CERT/KEY configured)');
  } else {
    wss = new WebSocketServer({ port });
  }

  wss.on('connection', async (ws, req) => {
    let agent = null;
    let apiKey = null;
    try {
      apiKey = getApiKey(req);
      if (!apiKey) { ws.close(4001, 'No API key'); return; }

      const r = await sv.query('SELECT * FROM agents WHERE api_key = $1', [apiKey]);
      if (!r.rows[0]) { ws.close(4003, 'Invalid API key'); return; }
      agent = r.rows[0];
      if (agent.disabled) {
        console.log(`[WS] Rejected disabled agent: ${agent.name}`);
        ws.close(4003, 'Agent disabled');
        return;
      }

      connectedAgents.set(apiKey, ws);

      // remoteAddress may be IPv6-mapped (::ffff:1.2.3.4) — strip the prefix.
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      await sv.query(
        `UPDATE agents SET status='online', connected_at=NOW(),
           last_seen_at=NOW(), ip_address=$2, updated_at=NOW() WHERE id=$1`,
        [agent.id, ip]
      );
      console.log(`[WS] Agent connected: ${agent.name} (${ip})`);

      // Push device config immediately on connect.
      await pushConfigToAgent(ws, agent.id);
    } catch (err) {
      console.error('[WS] Connection setup error:', err.message);
      try { ws.close(4000, 'Setup error'); } catch (_e) { /* ignore */ }
      return;
    }

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        await handleAgentMessage(agent, msg);
      } catch (e) { console.error('[WS] Message error:', e.message); }
    });

    ws.on('close', async () => {
      // If the agent already reconnected on a new socket, the map points at that
      // newer socket — do NOT evict it or mark devices offline for a stale close.
      if (connectedAgents.get(apiKey) !== ws) {
        console.log(`[WS] Stale socket closed for ${agent.name}; live connection retained`);
        return;
      }
      connectedAgents.delete(apiKey);
      try {
        await sv.query(`UPDATE agents SET status='offline', updated_at=NOW() WHERE id=$1`, [agent.id]);
        await sv.query(`UPDATE monitored_devices SET current_status='agent_offline' WHERE agent_id=$1`, [agent.id]);
      } catch (e) { console.error('[WS] Close handler error:', e.message); }
      console.log(`[WS] Agent disconnected: ${agent.name}`);
    });

    ws.on('error', (err) => console.error('[WS] Socket error:', err.message));
  });

  wss.on('error', (err) => console.error('[WS] Server error:', err.message));

  // Heartbeat monitor — every 30s, mark agents offline if silent for 90s.
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 90000).toISOString();
      const stale = await sv.query(
        `SELECT id, name FROM agents WHERE status='online' AND (last_seen_at IS NULL OR last_seen_at < $1)`,
        [cutoff]
      );
      for (const row of stale.rows) {
        await sv.query(`UPDATE agents SET status='offline', updated_at=NOW() WHERE id=$1`, [row.id]);
        await sv.query(`UPDATE monitored_devices SET current_status='agent_offline' WHERE agent_id=$1`, [row.id]);
        console.log(`[WS] Agent ${row.name} (#${row.id}) timed out`);
      }
    } catch (err) {
      console.error('[WS] Heartbeat monitor error:', err.message);
    }
  }, 30000);

  console.log(`SpanVault WebSocket server listening on port ${port}`);
  return { wss, connectedAgents };
}

// Build + send the device config snapshot for an agent.
async function pushConfigToAgent(ws, agentId) {
  // 1 === WebSocket.OPEN; compare numerically so we don't depend on the instance
  // exposing the OPEN constant.
  if (!ws || ws.readyState !== 1) return;
  try {
    const devices = await sv.query(`
      SELECT id, name, ip_address, snmp_enabled, snmp_version, snmp_community,
             snmp_port, snmp_v3_user, snmp_v3_auth_pass, snmp_v3_priv_pass,
             poll_interval_seconds, ping_threshold_ms, ping_failures_before_down,
             device_vendor
      FROM monitored_devices WHERE agent_id=$1 AND active=TRUE`, [agentId]);

    // Attach a per-device SNMP fetch plan (the exact OIDs collectCandidates reads
    // for the device's detected vendor, plus any custom-OID sensors). The agent
    // fetches these raw and ships an snmp_batch; the server interprets centrally
    // via the shared collector logic — so agent-polled devices get the same
    // vendor/interface/sensor coverage as locally-polled ones, with no OID
    // knowledge living in the agent.
    for (const d of devices.rows) {
      if (!d.snmp_enabled) continue;
      const plan = buildFetchPlan(d.device_vendor);
      try {
        const custom = await sv.query(
          `SELECT oid FROM device_sensors
            WHERE device_id=$1 AND is_custom=TRUE AND enabled=TRUE AND oid IS NOT NULL`,
          [d.id]);
        for (const c of custom.rows) if (c.oid && plan.gets.indexOf(c.oid) === -1) plan.gets.push(c.oid);
      } catch (_e) { /* device_sensors may be un-migrated — skip custom OIDs */ }
      d.snmp_plan = plan;
    }

    const settings = await sv.query(
      `SELECT key, value FROM app_settings
        WHERE key IN ('icmp_poll_interval_seconds','snmp_poll_interval_seconds')`);
    const settingsMap = {};
    for (const r of settings.rows) settingsMap[r.key] = r.value;

    // Agentless service checks assigned to this agent. service_checks is a later
    // migration — degrade to an empty array on an un-migrated DB rather than
    // breaking the whole config push.
    let serviceChecks = [];
    try {
      const checks = await sv.query(
        `SELECT id, type, target, interval_seconds, params
           FROM service_checks WHERE agent_id=$1 AND active=TRUE`, [agentId]);
      serviceChecks = checks.rows;
    } catch (_e) { serviceChecks = []; }

    const meta = agentMeta();
    ws.send(JSON.stringify({
      type: 'config', devices: devices.rows, settings: settingsMap,
      service_checks: serviceChecks,
      agent_sha: meta.sha, agent_version: meta.version,
    }));
  } catch (err) {
    console.error('[WS] pushConfigToAgent error:', err.message);
  }
}

// Interpret a remote agent's raw SNMP batch through the shared collector logic
// and persist the results. The agent fetched the OIDs named in its pushed plan;
// here we replay them via a PrefetchedSession so collectCandidates() runs exactly
// as it does for locally-polled devices (vendor CPU/mem fold-in, interface
// status/bps/utilization, sensor selection).
async function handleSnmpBatch(agent, msg) {
  const deviceId = msg.device_id;
  if (!deviceId) return;

  // Reconstruct varbind values; the agent base64-encodes Buffers as { b: ... }.
  const dec = (v) => (v && typeof v === 'object' && typeof v.b === 'string')
    ? Buffer.from(v.b, 'base64') : v;
  const asStr = (v) => (v == null) ? '' : (Buffer.isBuffer(v) ? v.toString() : String(v));
  const walks = {};
  for (const base of Object.keys(msg.walks || {})) {
    walks[base] = (msg.walks[base] || []).map((r) => ({ oid: r.oid, value: dec(r.value) }));
  }
  const gets = {};
  for (const o of Object.keys(msg.gets || {})) gets[o] = dec(msg.gets[o]);

  // Detect vendor from sysDescr; persist + re-push config when it changes so the
  // next batch already includes that vendor's OIDs.
  const vendor = detectVendor(asStr(gets[OID.sysDescr]), asStr(gets[OID.sysObjectID]));
  try {
    const vr = await sv.query(`SELECT device_vendor FROM monitored_devices WHERE id=$1`, [deviceId]);
    const prevVendor = vr.rows[0] ? vr.rows[0].device_vendor : null;
    if (vendor && vendor !== prevVendor) {
      await sv.query(`UPDATE monitored_devices SET device_vendor=$2, updated_at=NOW() WHERE id=$1`, [deviceId, vendor]);
      try { await pushConfigToAgentId(agent.id); } catch (_e) { /* best-effort re-push */ }
    }
  } catch (_e) { /* device_vendor column may be un-migrated — proceed with detected vendor */ }

  // Interpret + persist via the shared collector path.
  let prev = agentIfPrev.get(deviceId);
  if (!prev) { prev = new Map(); agentIfPrev.set(deviceId, prev); }
  const session = new PrefetchedSession({ walks, gets });
  const candidates = await collectCandidates(session, vendor, prev, Date.now());

  let sensors = [];
  try {
    const sr = await sv.query(
      `SELECT sensor_key, sensor_name, category, metric_name, oid
         FROM device_sensors WHERE device_id=$1 AND enabled=TRUE`, [deviceId]);
    sensors = sr.rows;
  } catch (_e) { sensors = []; }
  const samples = candidatesToSamples(candidates, sensors);

  // Uptime — continuity with the legacy agent path (sysUpTime timeticks).
  const upt = Number(asStr(gets[OID.sysUpTime]));
  if (isFinite(upt) && upt > 0) {
    samples.push({ metric_name: 'uptime', value: upt, oid: OID.sysUpTime, if_index: null, if_name: null });
  }

  const ts = msg.ts || new Date();
  let written = 0;
  for (const s of samples) {
    if (s.value === null || s.value === undefined || !isFinite(s.value)) continue;
    await sv.query(
      `INSERT INTO snmp_results (device_id, ts, oid, metric_name, value, if_index, if_name, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [deviceId, ts, s.oid || null, s.metric_name, s.value, s.if_index || null, s.if_name || null, agent.id]);
    written += 1;
  }

  // Custom-OID sensors — arbitrary OIDs the agent fetched as part of the plan.
  try {
    const cr = await sv.query(
      `SELECT oid, sensor_name FROM device_sensors
        WHERE device_id=$1 AND is_custom=TRUE AND enabled=TRUE AND oid IS NOT NULL`, [deviceId]);
    for (const cs of cr.rows) {
      const val = Number(asStr(gets[cs.oid]));
      if (!isFinite(val)) continue;
      await sv.query(
        `INSERT INTO snmp_results (device_id, ts, oid, metric_name, value, if_index, if_name, agent_id)
         VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6)`,
        [deviceId, ts, cs.oid, cs.sensor_name, val, agent.id]);
      written += 1;
    }
  } catch (_e) { /* skip custom sensors if table un-migrated */ }
}

// Push fresh config to an agent by id, if it is currently connected.
async function pushConfigToAgentId(agentId) {
  const r = await sv.query(`SELECT api_key FROM agents WHERE id=$1`, [agentId]);
  const key = r.rows[0] && r.rows[0].api_key;
  if (!key) return;
  const ws = connectedAgents.get(key);
  if (ws) await pushConfigToAgent(ws, agentId);
}

// Send an arbitrary control message to a connected agent by id. Returns whether
// the agent was online to receive it (e.g. a "discover" command).
async function sendToAgentId(agentId, msg) {
  const r = await sv.query(`SELECT api_key FROM agents WHERE id=$1`, [agentId]);
  const key = r.rows[0] && r.rows[0].api_key;
  if (!key) return false;
  const ws = connectedAgents.get(key);
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

async function handleAgentMessage(agent, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'heartbeat':
      if (await hasHealthCol()) {
        await sv.query(
          `UPDATE agents SET last_seen_at=NOW(), status='online',
             version=$2, hostname=$3, health=$4, updated_at=NOW() WHERE id=$1`,
          [agent.id, msg.version || null, msg.hostname || null,
           msg.health ? JSON.stringify(msg.health) : null]
        );
      } else {
        await sv.query(
          `UPDATE agents SET last_seen_at=NOW(), status='online',
             version=$2, hostname=$3, updated_at=NOW() WHERE id=$1`,
          [agent.id, msg.version || null, msg.hostname || null]
        );
      }
      break;

    case 'ping_result':
      await sv.query(
        `INSERT INTO ping_results (device_id, ts, response_ms, packet_loss_pct, status, agent_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [msg.device_id, msg.ts || new Date(), msg.response_ms,
         msg.packet_loss_pct, msg.status, agent.id]
      );
      await sv.query(
        `UPDATE monitored_devices SET
           current_status=$2, last_response_ms=$3, last_checked_at=$4,
           last_seen_at=CASE WHEN $2='up' THEN NOW() ELSE last_seen_at END,
           updated_at=NOW()
         WHERE id=$1`,
        [msg.device_id, msg.status, msg.response_ms, new Date()]
      );
      break;

    case 'snmp_result':
      await sv.query(
        `INSERT INTO snmp_results (device_id, ts, oid, metric_name, value, if_index, if_name, agent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [msg.device_id, msg.ts || new Date(), msg.oid, msg.metric_name,
         msg.value, msg.if_index || null, msg.if_name || null, agent.id]
      );
      break;

    case 'snmp_batch':
      // Raw varbinds the agent fetched for its server-pushed plan. The server
      // interprets them centrally through the shared collector logic, so adding a
      // vendor stays a single collector parser file and instantly covers agents.
      await handleSnmpBatch(agent, msg);
      break;

    case 'service_result':
      // Result of an agentless service check (HTTP/TCP/SSL/DNS) run by a remote
      // agent. Scope updates to this agent for safety. The collector evaluates
      // alerts from current_status — we only store here. service_checks /
      // service_check_results are a later migration; ignore if missing.
      if (msg.check_id == null) break;
      try {
        await sv.query(
          `UPDATE service_checks SET current_status=$2, last_response_ms=$3,
             last_detail=$4, last_checked_at=NOW(), updated_at=NOW()
           WHERE id=$1 AND agent_id=$5`,
          [msg.check_id, msg.status, msg.response_ms != null ? msg.response_ms : null,
           msg.detail || null, agent.id]
        );
        await sv.query(
          `INSERT INTO service_check_results (check_id, ts, status, response_ms, detail)
           VALUES ($1, NOW(), $2, $3, $4)`,
          [msg.check_id, msg.status, msg.response_ms != null ? msg.response_ms : null,
           msg.detail || null]
        );
      } catch (e) { console.error('[WS] service_result error:', e.message); }
      break;

    case 'logs':
      // Live log tail the agent pushed in response to a get_logs request.
      if (Array.isArray(msg.lines)) {
        agentLogs.set(agent.id, { lines: msg.lines.slice(-300), ts: Date.now() });
      }
      break;

    case 'discovery':
      // Candidates the agent found by sweeping its local subnet(s).
      if (Array.isArray(msg.hosts)) {
        for (const h of msg.hosts) {
          if (!h || !h.ip_address) continue;
          await sv.query(`
            INSERT INTO agent_discovered_devices
              (agent_id, ip_address, sys_name, sys_descr, snmp_ok, snmp_community, snmp_version, last_seen_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
            ON CONFLICT (agent_id, ip_address) DO UPDATE SET
              sys_name = EXCLUDED.sys_name, sys_descr = EXCLUDED.sys_descr,
              snmp_ok = EXCLUDED.snmp_ok,
              snmp_community = COALESCE(EXCLUDED.snmp_community, agent_discovered_devices.snmp_community),
              snmp_version = COALESCE(EXCLUDED.snmp_version, agent_discovered_devices.snmp_version),
              last_seen_at = NOW()`,
            [agent.id, h.ip_address, h.sys_name || null, h.sys_descr || null, !!h.snmp_ok,
             h.snmp_community || null, h.snmp_version || null]);
        }
        console.log(`[WS] Discovery from ${agent.name}: ${msg.hosts.length} host(s)`);
      }
      break;

    case 'batch':
      // Buffered results flushed on reconnect.
      if (Array.isArray(msg.results)) {
        for (const r of msg.results) await handleAgentMessage(agent, r);
      }
      break;

    default:
      break;
  }
}

module.exports = { startWsServer, connectedAgents, agentLogs, pushConfigToAgent, pushConfigToAgentId, disconnectAgent, sendToAgentId };

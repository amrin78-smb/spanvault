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

const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

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

function startWsServer(port) {
  const wss = new WebSocketServer({ port });

  wss.on('connection', async (ws, req) => {
    let agent = null;
    let apiKey = null;
    try {
      apiKey = new URL(req.url, 'ws://x').searchParams.get('key');
      if (!apiKey) { ws.close(4001, 'No API key'); return; }

      const r = await sv.query('SELECT * FROM agents WHERE api_key = $1', [apiKey]);
      if (!r.rows[0]) { ws.close(4003, 'Invalid API key'); return; }
      agent = r.rows[0];

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
             poll_interval_seconds, ping_threshold_ms, ping_failures_before_down
      FROM monitored_devices WHERE agent_id=$1 AND active=TRUE`, [agentId]);

    const settings = await sv.query(
      `SELECT key, value FROM app_settings
        WHERE key IN ('icmp_poll_interval_seconds','snmp_poll_interval_seconds')`);
    const settingsMap = {};
    for (const r of settings.rows) settingsMap[r.key] = r.value;

    ws.send(JSON.stringify({ type: 'config', devices: devices.rows, settings: settingsMap }));
  } catch (err) {
    console.error('[WS] pushConfigToAgent error:', err.message);
  }
}

// Push fresh config to an agent by id, if it is currently connected.
async function pushConfigToAgentId(agentId) {
  const r = await sv.query(`SELECT api_key FROM agents WHERE id=$1`, [agentId]);
  const key = r.rows[0] && r.rows[0].api_key;
  if (!key) return;
  const ws = connectedAgents.get(key);
  if (ws) await pushConfigToAgent(ws, agentId);
}

async function handleAgentMessage(agent, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'heartbeat':
      await sv.query(
        `UPDATE agents SET last_seen_at=NOW(), status='online',
           version=$2, hostname=$3, updated_at=NOW() WHERE id=$1`,
        [agent.id, msg.version || null, msg.hostname || null]
      );
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

module.exports = { startWsServer, connectedAgents, pushConfigToAgent, pushConfigToAgentId };

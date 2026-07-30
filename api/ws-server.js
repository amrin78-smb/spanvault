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
const { verifyHubAgentJwt } = require('./agent-identity');
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

// NetVault DB (read-only) — needed for the Phase 3 hub-JWT path to honour hub
// revocation at connect (a signature check alone can't see a hub-side revoke).
// SpanVault already reads this DB for site names elsewhere; the default role
// (`netvault`) has full SELECT on netvault.agents, so `revoked_at` is readable.
const nv = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  ssl: false,
  max: 5,
  idleTimeoutMillis: 30000,
});
nv.on('error', (err) => console.error('[WS DB nv] Pool error:', err.message));

// Map of local agents.id (integer) → live WebSocket connection. Keyed by the
// LOCAL primary key (not api_key) so both auth paths — legacy api_key rows and
// hub-JWT rows, which have NO api_key — resolve to the same map key.
const connectedAgents = new Map();

// Map of agent_id → { lines, ts } — last log tail an agent pushed on request.
const agentLogs = new Map();

// Read the agent's API key from the Authorization header (preferred — keeps the
// secret out of URLs and proxy/access logs) and fall back to the legacy ?key=
// query param so already-deployed agents keep working during a rolling upgrade.
// Returns { key, legacy } — legacy is true when the key came from the deprecated
// ?key= fallback (so callers can warn without ever logging the key itself).
function getApiKey(req) {
  const auth = req.headers && req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) {
    return { key: auth.replace(/^Bearer\s+/i, '').trim(), legacy: false };
  }
  try {
    return { key: new URL(req.url, 'ws://x').searchParams.get('key'), legacy: true };
  } catch (_e) {
    return { key: null, legacy: false };
  }
}

// Read a Bearer token from the Authorization header ONLY (never the legacy ?key=
// query param — that path is api_key-exclusive). Used to try the hub-JWT path
// before falling back to the legacy api_key lookup.
function getBearerToken(req) {
  const auth = req.headers && req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

// Forcibly drop a connected agent by local agents.id (used when it is
// disabled/rotated/deleted, or when the hub revokes it). No-op if not connected.
function disconnectAgent(agentId, reason) {
  const ws = connectedAgents.get(agentId);
  if (ws) { try { ws.close(4003, reason || 'Disconnected'); } catch (_e) { /* ignore */ } }
}

// ── Phase 3 "duplicate row" fix ─────────────────────────────────────────────
// docs/nocvault-agents-phase3-plan.md (the team's own migration design doc)
// calls out this exact risk: a physical agent migrating from api_key to
// hub-JWT auth connects with a NEW identity (the JWT's hub_agent_id) that has
// no local row yet, so the naive "auto-provision by hub_agent_id" INSERT
// strands the agent's OLD (api_key) row — orphaning its site assignment and
// ping/snmp history — and starts a second, empty row from zero. The doc's own
// suggested mitigation is two-part: (1) auto-link by matching a real signal
// against the existing row, (2) an admin manual-link fallback for when that
// signal is ambiguous or not yet available. Both are implemented here.

// Merge two agents rows into one. `legacyId` (an existing api_key row) keeps
// its id/history and gets `hubAgentId` stamped onto it; every row that
// referenced `duplicateId` (a hub-JWT auto-provisioned row) is reassigned to
// `legacyId`; `duplicateId` is then deleted. Shared by both the automatic
// hostname-link below and the admin manual-link fallback
// (POST /api/agents/:id/link-legacy in api/server.js) — one merge routine,
// two ways to decide which two rows to feed it. Throws on failure (rolled
// back); callers decide how to report that.
async function mergeAgentRows(legacyId, duplicateId, hubAgentId) {
  const client = await sv.connect();
  try {
    await client.query('BEGIN');
    // Every table that carries an agents.id FK. Table names here are a fixed
    // internal list (never user input) — safe to interpolate.
    for (const table of [
      'agent_sites', 'agent_discovered_devices', 'monitored_devices',
      'ping_results', 'snmp_results', 'service_checks', 'alerts',
    ]) {
      await client.query(`UPDATE ${table} SET agent_id = $1 WHERE agent_id = $2`, [legacyId, duplicateId]);
    }
    const upd = await client.query(
      `UPDATE agents SET hub_agent_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [legacyId, hubAgentId]
    );
    if (!upd.rows[0]) throw new Error(`legacy agent #${legacyId} not found`);
    await client.query(`DELETE FROM agents WHERE id = $1`, [duplicateId]);
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_e2) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// Try to auto-link a freshly auto-provisioned hub-JWT agent row to a matching
// legacy (api_key) row, using the agent's reported hostname — the earliest
// real identifying signal available for this connection. The JWT itself
// carries none (the hub mints it before it has ever seen the agent's
// hostname); the hostname only becomes known once the agent's first
// `heartbeat` message arrives, sent immediately on WS open (agent/agent.js's
// `ws.on('open', ...)` calls `sendHeartbeat()` before anything else) — so
// this runs from the message handler, not the connect handler.
//
// Only eligible rows: `agent.hub_agent_id` set, `agent.api_key` NULL (a
// hub-JWT row), and `agent.name === agent.hub_agent_id` — i.e. still carrying
// its placeholder name, meaning it has never been linked, renamed, or already
// hostname-adopted. That's the SAME guard the plain hostname-adoption CASE in
// the 'heartbeat' handler below already uses, so this is naturally a one-shot
// check per row: after either this link or the plain adoption renames it, the
// guard trips and every later heartbeat short-circuits on a cheap string
// comparison with no DB hit.
//
// Only merges on an UNAMBIGUOUS match (exactly one legacy row with that
// hostname). Zero or multiple candidates leave both rows alone — the exact
// case the admin manual-link fallback exists for. This is a real, accepted
// limitation: two genuinely different hosts that happen to share a hostname
// (or a legacy row whose hostname is stale/wrong) can still merge into the
// wrong row. There is no stronger signal available in the current protocol
// to disambiguate further (see the plan doc — no per-agent MAC/serial is
// collected today).
async function tryLinkAgentByHostname(agent, hostname) {
  if (!hostname || !agent || !agent.hub_agent_id || agent.api_key) return null;
  if (agent.name !== agent.hub_agent_id) return null;

  try {
    const cand = await sv.query(
      `SELECT id, name FROM agents
        WHERE api_key IS NOT NULL AND hub_agent_id IS NULL
          AND hostname IS NOT NULL AND lower(hostname) = lower($1)`,
      [hostname]
    );
    if (cand.rows.length !== 1) return null; // none or ambiguous — leave for admin manual-link
    const legacy = cand.rows[0];
    const provisionalId = agent.id;

    const merged = await mergeAgentRows(legacy.id, provisionalId, agent.hub_agent_id);
    // Stamp live-connection fields now that the merge landed on the legacy row
    // (mergeAgentRows itself only touches hub_agent_id — it's shared with the
    // admin path, which shouldn't force status/connected_at for an agent that
    // may not currently be connected).
    const r = await sv.query(
      `UPDATE agents SET status = 'online', hostname = $2,
          last_seen_at = NOW(), connected_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [merged.id, hostname]
    );
    console.log(
      `[WS] Auto-linked hub agent ${agent.hub_agent_id} to existing legacy agent ` +
      `"${legacy.name}" (#${legacy.id}, hostname="${hostname}") by hostname match — ` +
      `provisional row #${provisionalId} merged and removed`
    );
    return r.rows[0];
  } catch (e) {
    console.error(`[WS] Auto-link by hostname failed for hub agent ${agent.hub_agent_id}:`, e.message);
    return null;
  }
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
    console.warn(
      `[WS] WARNING: TLS is NOT configured — agent connections are unencrypted (plain ws://) ` +
      `on port ${port}. This exposes the agent self-update mechanism (SHA-256 check over an ` +
      `unauthenticated channel) to MITM tampering. Set SV_WS_TLS_CERT and SV_WS_TLS_KEY to a ` +
      `certificate/key pair to enable wss:// and close this gap.`
    );
  }

  wss.on('connection', async (ws, req) => {
    let agent = null;
    // Local agents.id used as the connectedAgents map key + close-handler key.
    // Both auth paths resolve to a local row, so agent.id is the common key.
    let agentKey = null;
    try {
      // ── Accept-both, JWT-first ──────────────────────────────────────────────
      // Try the Authorization: Bearer token as a hub-signed agent JWT (local
      // crypto, no DB). If it verifies AND its audience includes this app's
      // module, take the JWT path; otherwise fall through to the legacy api_key
      // path completely unchanged.
      const bearer = getBearerToken(req);
      const claims = bearer ? verifyHubAgentJwt(bearer) : null;
      const aud = claims ? claims.modules.map((m) => String(m).toLowerCase()) : [];
      const isSpanJwt = !!claims && (aud.indexOf('span') !== -1 || aud.indexOf('spanvault') !== -1);

      if (isSpanJwt) {
        // ── JWT PATH (hub identity) ──────────────────────────────────────────
        // Honour hub revocation at connect: the signature alone can't see a
        // hub-side revoke, so cross-check the NetVault agent registry. Any DB
        // failure fails CLOSED (refuse) rather than silently skipping the check.
        try {
          const rev = await nv.query(
            'SELECT 1 FROM agents WHERE id = $1 AND revoked_at IS NULL', [claims.agentId]);
          if (!rev.rows[0]) { ws.close(4003, 'Agent revoked'); return; }
        } catch (e) {
          console.error(`[WS] JWT revocation check failed (NetVault DB) for ${claims.agentId}: ${e.message}`);
          ws.close(4003, 'Agent revoked');
          return;
        }

        // Auto-provision / link the local agents row by hub_agent_id. A first
        // connect creates one row (api_key NULL, name = hub id until a heartbeat
        // supplies the hostname); a reconnect resolves to the same row/id.
        // api_key is set NULL EXPLICITLY: the column DEFAULT is
        // gen_random_uuid()::text, so omitting it would mint a phantom, unused
        // credential — plan decisions #3/#5 require JWT-provisioned rows to have
        // no api_key.
        const prov = await sv.query(
          `INSERT INTO agents (hub_agent_id, name, status, api_key)
             VALUES ($1, $1, 'online', NULL)
           ON CONFLICT (hub_agent_id) DO UPDATE SET status = 'online'
           RETURNING *`,
          [claims.agentId]
        );
        agent = prov.rows[0];
        console.log(`[WS] Agent authenticated via hub JWT: ${agent.name} (#${agent.id}, hub=${claims.agentId})`);
      } else {
        // ── LEGACY api_key PATH (unchanged) ──────────────────────────────────
        const keyInfo = getApiKey(req);
        const apiKey = keyInfo.key;
        if (!apiKey) { ws.close(4001, 'No API key'); return; }

        const r = await sv.query('SELECT * FROM agents WHERE api_key = $1', [apiKey]);
        if (!r.rows[0]) { ws.close(4003, 'Invalid API key'); return; }
        agent = r.rows[0];
        if (agent.disabled) {
          console.log(`[WS] Rejected disabled agent: ${agent.name}`);
          ws.close(4003, 'Agent disabled');
          return;
        }
        if (keyInfo.legacy) {
          console.warn(
            `[WS] WARNING: agent "${agent.name}" (#${agent.id}) authenticated via the ` +
            `deprecated ?key= URL query param, not the Authorization header. This agent ` +
            `needs updating to a newer agent.js that sends the API key via header.`
          );
        }
      }

      agentKey = agent.id;
      connectedAgents.set(agentKey, ws);

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
        // First real chance to auto-link a just-provisioned hub-JWT row to a
        // matching legacy row (see tryLinkAgentByHostname above) — the
        // heartbeat is the earliest message carrying a hostname. A no-op for
        // legacy agents, already-linked/renamed rows, and no-match cases.
        if (msg && msg.type === 'heartbeat' && msg.hostname) {
          const linked = await tryLinkAgentByHostname(agent, msg.hostname);
          if (linked) {
            // Re-key the live socket + close-handler state onto the merged
            // (legacy) row so every subsequent message/config push/close uses
            // the correct identity for the rest of this connection.
            connectedAgents.delete(agentKey);
            agent = linked;
            agentKey = linked.id;
            connectedAgents.set(agentKey, ws);
            // The connect-time config push above was for the brand-new
            // provisional row (zero devices) — push the legacy row's real
            // config now that the socket is correctly identified.
            try { await pushConfigToAgent(ws, agentKey); } catch (_e) { /* best-effort */ }
          }
        }
        await handleAgentMessage(agent, msg);
      } catch (e) { console.error('[WS] Message error:', e.message); }
    });

    ws.on('close', async () => {
      // If the agent already reconnected on a new socket, the map points at that
      // newer socket — do NOT evict it or mark devices offline for a stale close.
      if (connectedAgents.get(agentKey) !== ws) {
        console.log(`[WS] Stale socket closed for ${agent.name}; live connection retained`);
        return;
      }
      connectedAgents.delete(agentKey);
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

// Push fresh config to an agent by local id, if it is currently connected. The
// live-socket map is keyed by local agents.id, so this works for both api_key and
// hub-JWT agents (the latter have no api_key to look up).
async function pushConfigToAgentId(agentId) {
  const ws = connectedAgents.get(agentId);
  if (ws) await pushConfigToAgent(ws, agentId);
}

// Send an arbitrary control message to a connected agent by local id. Returns
// whether the agent was online to receive it (e.g. a "discover" command).
async function sendToAgentId(agentId, msg) {
  const ws = connectedAgents.get(agentId);
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

async function handleAgentMessage(agent, msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'heartbeat':
      // For a hub-JWT agent whose name is still its placeholder hub id, adopt the
      // reported hostname the first time one arrives. The `hub_agent_id IS NOT
      // NULL AND name = hub_agent_id` guard makes this a strict no-op for legacy
      // api_key agents (hub_agent_id NULL) and for any JWT agent already renamed.
      if (await hasHealthCol()) {
        await sv.query(
          `UPDATE agents SET last_seen_at=NOW(), status='online',
             version=$2, hostname=$3, health=$4,
             name=CASE WHEN hub_agent_id IS NOT NULL AND name=hub_agent_id AND $3 IS NOT NULL
                       THEN $3 ELSE name END,
             updated_at=NOW() WHERE id=$1`,
          [agent.id, msg.version || null, msg.hostname || null,
           msg.health ? JSON.stringify(msg.health) : null]
        );
      } else {
        await sv.query(
          `UPDATE agents SET last_seen_at=NOW(), status='online',
             version=$2, hostname=$3,
             name=CASE WHEN hub_agent_id IS NOT NULL AND name=hub_agent_id AND $3 IS NOT NULL
                       THEN $3 ELSE name END,
             updated_at=NOW() WHERE id=$1`,
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
      // Candidates the agent found by sweeping its local subnet(s). Same
      // one-bad-item-kills-the-rest shape as 'batch' below: many independent hosts
      // in a single message sharing one loop. Isolate each so a single bad row
      // (e.g. unexpected data shape) doesn't drop every other host in the sweep.
      if (Array.isArray(msg.hosts)) {
        let discFailed = 0;
        for (const h of msg.hosts) {
          if (!h || !h.ip_address) continue;
          try {
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
          } catch (e) {
            discFailed += 1;
            console.error(`[WS] Discovery host ${h.ip_address} from ${agent.name} failed: ${e.message}`);
          }
        }
        console.log(`[WS] Discovery from ${agent.name}: ${msg.hosts.length} host(s)` +
          (discFailed > 0 ? `, ${discFailed} failed` : ''));
      }
      break;

    case 'batch': {
      // Buffered results flushed on reconnect. The agent already cleared + persisted
      // its local buffer as empty the instant this was sent (no ack round-trip exists
      // in this protocol) — so if one bad item (e.g. a device deleted while the agent
      // was offline, orphaning its ping_results/snmp_results FK) threw out of a shared
      // for-loop, EVERY remaining item in the batch would be silently dropped, even
      // though the agent already considers them delivered. Isolate each item so one
      // failure can't take out unrelated devices' data; log failures clearly since
      // this is the only remaining visibility into buffered data loss.
      if (Array.isArray(msg.results)) {
        let failed = 0;
        for (let i = 0; i < msg.results.length; i++) {
          const r = msg.results[i];
          try {
            await handleAgentMessage(agent, r);
          } catch (e) {
            failed += 1;
            console.error(
              `[WS] Batch item ${i + 1}/${msg.results.length} from ${agent.name} failed ` +
              `(type=${r && r.type}, device_id=${r && r.device_id}): ${e.message}`
            );
          }
        }
        if (failed > 0) {
          console.error(`[WS] Batch from ${agent.name}: ${failed}/${msg.results.length} item(s) failed and were dropped`);
        }
      }
      break;
    }

    default:
      break;
  }
}

module.exports = {
  startWsServer, connectedAgents, agentLogs, pushConfigToAgent, pushConfigToAgentId,
  disconnectAgent, sendToAgentId, agentMeta, mergeAgentRows,
};

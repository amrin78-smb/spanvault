'use strict';

/**
 * collector.js — SpanVault background polling service.
 *
 * Responsibilities:
 *   1. Sync devices from NetVault on startup and every N minutes.
 *   2. ICMP ping every active device on its poll interval.
 *   3. SNMP poll every SNMP-enabled device (CPU, memory, interfaces).
 *   4. Evaluate alert rules + built-in down/latency detection.
 *   5. Write to ping_results / snmp_results / alerts; keep monitored_devices fresh.
 *
 * Plain JavaScript only — no TypeScript syntax. Runs as the SpanVault-Collector
 * NSSM service: `node collector/collector.js`.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const http       = require('http');
const https      = require('https');
const net        = require('net');
const tls        = require('tls');
const dns         = require('dns');
const urlmod     = require('url');
const { Pool }   = require('pg');
const ping       = require('ping');
const nodemailer = require('nodemailer');
const { detectVendor } = require('./parsers');
const { createSession, get, OID } = require('./snmp-session');
const { collectCandidates, candidatesToSamples } = require('./discovery');
const { discoverAndStore } = require('./topology');
const { startWirelessCollector } = require('./wirelessCollector');

// ── Crash resilience ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ── Internal API notification (loopback) ────────────────────────
// reassignAgents() below updates monitored_devices.agent_id directly in the DB,
// but the collector process has no in-process handle on the live agent WebSocket
// connections — those live in api/ws-server.js, inside the separate api/server.js
// OS process (SpanVault-API service). Without this, an agent that lost or gained
// devices keeps polling its stale cached config for up to 30 min until it happens
// to reconnect. This calls the internal loopback-only endpoint added in
// api/server.js (POST /api/internal/agents/push-config) which pushes a fresh
// config to any of the given agent ids that are currently connected — mirrors
// what POST /api/agents/:id/sites already does for the manual reassignment path.
// Best-effort only: never throws, never blocks the sync cycle. A failure here
// just means the pre-existing 30-minute-late self-correction is what applies.
const API_PORT = parseInt(process.env.SV_API_PORT || '3009', 10);
function notifyAgentsConfigChanged(agentIds) {
  const ids = Array.from(new Set((agentIds || []).filter((id) => id !== null && id !== undefined)));
  if (!ids.length) return;
  try {
    const body = JSON.stringify({ agent_ids: ids });
    const req = http.request({
      host: '127.0.0.1',
      port: API_PORT,
      path: '/api/internal/agents/push-config',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      res.resume(); // drain, don't care about the body
      if (res.statusCode >= 400) {
        console.warn(`[sync] push-config notify returned HTTP ${res.statusCode}`);
      }
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (err) => console.warn('[sync] push-config notify failed:', err.message));
    req.write(body);
    req.end();
  } catch (err) {
    console.warn('[sync] push-config notify failed:', err.message);
  }
}

// ── Databases ─────────────────────────────────────────────────
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
sv.on('error', (err) => console.error('[DB sv] Pool error:', err.message));

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
nv.on('error', (err) => console.error('[DB nv] Pool error:', err.message));

// ── Settings cache ────────────────────────────────────────────
let settings = {};
function setting(key, def) {
  const v = settings[key];
  return v === undefined || v === null ? def : v;
}
function settingInt(key, def) {
  const n = parseInt(setting(key, def), 10);
  return isNaN(n) ? def : n;
}
function settingBool(key) {
  return String(setting(key, 'false')).toLowerCase() === 'true';
}
async function loadSettings() {
  try {
    const r = await sv.query('SELECT key, value FROM app_settings');
    const out = {};
    for (const row of r.rows) out[row.key] = row.value;
    settings = out;
  } catch (err) {
    console.error('[settings] load failed:', err.message);
  }
}

// Liveness heartbeat: the collector stamps app_settings on a fixed cadence so
// the API can report "running" even on a fresh install with 0 devices (where no
// ping_results are ever written). The API treats the collector as alive if this
// timestamp is recent. Kept independent of device polling on purpose.
async function writeHeartbeat() {
  try {
    await sv.query(
      `INSERT INTO app_settings (key, value) VALUES ('collector_heartbeat', NOW()::text)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
  } catch (err) {
    console.error('[heartbeat] write failed:', err.message);
  }
}

// Standard OID constants + walk/get live in ./snmp-session (shared with the API).

// Track previous interface octet counters for bps computation.
// Map<deviceId, Map<ifIndex, { inOctets, outOctets, ts }>>
const ifPrev = new Map();

// Devices whose alerts are currently suppressed because their site gateway is
// down. Refreshed each ping tick by runSuppressionPass(); read by raiseAlert().
let suppressedDevices = new Set();

// ══════════════════════════════════════════════════════════════
// NetVault device sync
// ══════════════════════════════════════════════════════════════
async function syncNetVaultDevices() {
  try {
    // netvault.devices.ip_address is `character varying` on the live DB, NOT
    // `inet` — confirmed directly against information_schema.columns. This
    // used to be wrapped in host(...) (an inet-only function, presumably
    // written against an older/assumed schema shape), which threw "function
    // host(character varying) does not exist" on every single sync attempt.
    // No cast needed now — the column already stores a plain address string.
    const r = await nv.query(`
      SELECT d.id AS netvault_device_id, d.name, d.ip_address AS ip_address,
             dt.name AS device_type, d.site_id, s.name AS site_name
      FROM devices d
      LEFT JOIN device_types dt ON dt.id = d.device_type_id
      LEFT JOIN sites s ON s.id = d.site_id
      WHERE d.ip_address IS NOT NULL
        AND COALESCE(d.device_status, 'Active') <> 'Decommed'
    `);
    let updated = 0;
    for (const row of r.rows) {
      // Keep metadata fresh for already-imported devices; never auto-import.
      const u = await sv.query(`
        UPDATE monitored_devices
           SET name = $2, device_type = $3, site_id = $4, site_name = $5, updated_at = NOW()
         WHERE netvault_device_id = $1
      `, [row.netvault_device_id, row.name, row.device_type, row.site_id, row.site_name]);
      updated += u.rowCount;
    }
    log(`[sync] NetVault sync complete: refreshed ${updated} monitored device(s).`);
    // Re-derive agent ownership in case devices changed site since last sync.
    await reassignAgents();
  } catch (err) {
    console.error('[sync] NetVault sync failed:', err.message);
  }
}

// Reconcile monitored_devices.agent_id with agent_sites. A device in a site an
// agent owns is assigned to that agent; a device whose agent no longer owns its
// site falls back to local polling (agent_id → NULL). 'agent_offline' status is
// reset to 'unknown' so the local collector repolls it on the next tick.
async function reassignAgents() {
  const affected = new Set();
  try {
    // Snapshot which devices are about to change agent ownership (and to/from
    // which agent ids) BEFORE each UPDATE runs — plain SQL UPDATE ... RETURNING
    // only exposes post-update values, so the old owner has to be read first.
    // Both the old and new owner need a fresh push: the old owner must stop
    // polling a device it no longer owns, the new owner must start.
    const reassigning = await sv.query(`
      SELECT d.agent_id AS old_agent_id, sub.agent_id AS new_agent_id
        FROM monitored_devices d
        JOIN (SELECT DISTINCT ON (site_id) site_id, agent_id
                FROM agent_sites ORDER BY site_id, agent_id) sub
          ON d.site_id = sub.site_id
       WHERE d.agent_id IS DISTINCT FROM sub.agent_id
    `);
    for (const row of reassigning.rows) {
      if (row.old_agent_id) affected.add(row.old_agent_id);
      if (row.new_agent_id) affected.add(row.new_agent_id);
    }
    await sv.query(`
      UPDATE monitored_devices d
         SET agent_id = sub.agent_id, updated_at = NOW()
        FROM (SELECT DISTINCT ON (site_id) site_id, agent_id
                FROM agent_sites ORDER BY site_id, agent_id) sub
       WHERE d.site_id = sub.site_id AND d.agent_id IS DISTINCT FROM sub.agent_id
    `);

    const unassigning = await sv.query(`
      SELECT d.agent_id AS old_agent_id
        FROM monitored_devices d
       WHERE d.agent_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_sites s WHERE s.site_id = d.site_id AND s.agent_id = d.agent_id
         )
    `);
    for (const row of unassigning.rows) {
      if (row.old_agent_id) affected.add(row.old_agent_id);
    }
    await sv.query(`
      UPDATE monitored_devices d
         SET agent_id = NULL,
             current_status = CASE WHEN current_status = 'agent_offline' THEN 'unknown' ELSE current_status END,
             updated_at = NOW()
       WHERE d.agent_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_sites s WHERE s.site_id = d.site_id AND s.agent_id = d.agent_id
         )
    `);

    if (affected.size) notifyAgentsConfigChanged(Array.from(affected));
  } catch (err) {
    console.error('[sync] agent reassignment failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ICMP ping
// ══════════════════════════════════════════════════════════════
const IS_WIN = process.platform === 'win32';

async function pingDevice(device) {
  const countFlag = IS_WIN ? '-n' : '-c';
  let alive = false;
  let timeMs = null;
  let lossPct = 100;
  try {
    const res = await ping.promise.probe(device.ip_address, {
      timeout: 2,
      extra: [countFlag, '3'],
    });
    alive = !!res.alive;
    if (res.time !== undefined && res.time !== 'unknown' && res.time !== null) {
      const t = parseFloat(res.time);
      if (!isNaN(t)) timeMs = t;
    }
    if (res.packetLoss !== undefined && res.packetLoss !== 'unknown') {
      const p = parseFloat(res.packetLoss);
      if (!isNaN(p)) lossPct = p;
    } else {
      lossPct = alive ? 0 : 100;
    }
  } catch (err) {
    alive = false;
    lossPct = 100;
  }

  const threshold = device.ping_threshold_ms || settingInt('ping_threshold_ms', 500);
  const failsBeforeDown = device.ping_failures_before_down || settingInt('ping_failures_before_down', 3);

  let status;
  if (!alive) status = 'down';
  else if (timeMs !== null && timeMs > threshold) status = 'warning';
  else status = 'up';

  // Record the raw sample.
  await sv.query(
    `INSERT INTO ping_results (device_id, response_ms, packet_loss_pct, status) VALUES ($1,$2,$3,$4)`,
    [device.id, timeMs, lossPct, status]
  );

  // Update consecutive failure counter + derived device status.
  let consecutive = device.consecutive_failures || 0;
  if (alive) consecutive = 0;
  else consecutive += 1;

  let newStatus;
  if (alive) newStatus = status; // 'up' or 'warning'
  else newStatus = consecutive >= failsBeforeDown ? 'down' : (device.current_status || 'unknown');

  await sv.query(`
    UPDATE monitored_devices
       SET current_status = $2,
           consecutive_failures = $3,
           last_response_ms = $4,
           last_checked_at = NOW(),
           last_seen_at = CASE WHEN $5 THEN NOW() ELSE last_seen_at END,
           updated_at = NOW()
     WHERE id = $1
  `, [device.id, newStatus, consecutive, timeMs, alive]);

  // Alert evaluation for reachability + latency.
  const inMaint = await inMaintenance({ deviceId: device.id });
  if (newStatus === 'down' && !inMaint) {
    await raiseAlert(device, 'device_down', 'critical',
      await buildDeviceDownMessage(device), null);
  } else if (newStatus !== 'down') {
    const wasDown = await resolveAlert(device.id, 'device_down');
    if (wasDown) { await deviceRecoveryEvent(device, timeMs); await notifyRecovery(device, 'device_down', 'Device down'); }
  }

  if (alive && timeMs !== null && timeMs > threshold && !inMaint) {
    await raiseAlert(device, 'high_latency', 'warning',
      await buildHighLatencyMessage(device, timeMs), timeMs);
  } else if (alive && (timeMs === null || timeMs <= threshold)) {
    if (await resolveAlert(device.id, 'high_latency')) await notifyRecovery(device, 'high_latency', 'High latency');
  }

  // User-defined ping-context rules (device_down / response_time / packet_loss).
  await evaluateEffectiveRules(device, {
    device_down: newStatus === 'down' ? 1 : 0,
    response_time: alive ? timeMs : null,
    packet_loss: lossPct,
  });

  return { status: newStatus, timeMs };
}

// ══════════════════════════════════════════════════════════════
// SNMP polling
// ══════════════════════════════════════════════════════════════
// Load the device's enabled sensor selection (empty array = poll standard set).
async function loadEnabledSensors(deviceId) {
  try {
    const r = await sv.query(
      `SELECT sensor_key, sensor_name, category, metric_name, oid
         FROM device_sensors WHERE device_id = $1 AND enabled = TRUE`,
      [deviceId]
    );
    return r.rows;
  } catch (err) {
    console.error('[snmp] sensor load failed:', err.message);
    return [];
  }
}

async function snmpPollDevice(device) {
  const session = createSession(device);
  let candidates = [];
  let vendor = device.device_vendor || 'generic';

  // Per-device interface octet history for bps deltas.
  let prev = ifPrev.get(device.id);
  if (!prev) { prev = new Map(); ifPrev.set(device.id, prev); }
  const now = Date.now();

  // If the user has selected sensors, poll only those; otherwise the standard set.
  const sensors = await loadEnabledSensors(device.id);

  try {
    // ── Vendor detection — fetch sysDescr + sysObjectID, pick a parser ──
    const idRows = await get(session, [OID.sysDescr, OID.sysObjectID]);
    const idByOid = new Map(idRows.map((r) => [String(r.oid).replace(/^\./, ''), r.value]));
    const sysDescr = idByOid.has(OID.sysDescr) ? String(idByOid.get(OID.sysDescr)) : '';
    const sysObjId = idByOid.has(OID.sysObjectID) ? String(idByOid.get(OID.sysObjectID)) : '';
    vendor = detectVendor(sysDescr, sysObjId);
    await persistVendor(device, vendor);

    // When sensors are selected, skip OID categories that aren't needed.
    let want;
    if (sensors.length) {
      const keys = new Set(sensors.map((s) => s.sensor_key));
      const cats = new Set(sensors.map((s) => s.category));
      want = {
        cpu: keys.has('cpu'),
        mem: keys.has('mem'),
        iface: cats.has('interface'),
        // Vendor walk also feeds vendor-supplied cpu/mem on enterprise gear.
        vendor: cats.has('vendor') || ((keys.has('cpu') || keys.has('mem')) && vendor !== 'generic'),
      };
    }

    candidates = await collectCandidates(session, vendor, prev, now, want);
  } catch (err) {
    console.error(`[snmp] ${device.name} (${device.ip_address}) poll error:`, err.message);
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }

  // Map candidates → rows to persist (selective vs standard set + interface
  // utilization %). Shared with the remote-agent batch handler in ws-server.js.
  const samples = candidatesToSamples(candidates, sensors);

  // Persist samples (skip ones with no value — e.g. bps on the first poll).
  let written = 0;
  for (const s of samples) {
    if (s.value === null || s.value === undefined) continue;
    await sv.query(
      `INSERT INTO snmp_results (device_id, oid, metric_name, value, if_index, if_name)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [device.id, s.oid || null, s.metric_name, isFinite(s.value) ? s.value : null,
       s.if_index || null, s.if_name || null]
    );
    written += 1;
  }

  // Custom user-defined OID sensors are polled separately — arbitrary OIDs that
  // aren't part of the standard/vendor candidate set.
  written += await pollCustomSensors(device);

  await evaluateSnmpAlerts(device, samples);
  return written;
}

// Poll a device's custom OID sensors (one SNMP GET each) and store the numeric
// result in snmp_results under the sensor's name. Separate from the standard
// candidate path so any OID can be graphed.
async function pollCustomSensors(device) {
  let custom;
  try {
    custom = await sv.query(
      `SELECT id, oid, sensor_name, custom_unit
         FROM device_sensors
        WHERE device_id = $1 AND is_custom = TRUE AND enabled = TRUE`,
      [device.id]
    );
  } catch (err) {
    console.error('[snmp] custom sensor load failed:', err.message);
    return 0;
  }
  if (!custom.rows.length) return 0;

  const session = createSession(device);
  let written = 0;
  try {
    for (const s of custom.rows) {
      if (!s.oid) continue;
      const res = await get(session, [s.oid]);
      if (!res.length) continue;
      const raw = res[0].value;
      const value = Number(Buffer.isBuffer(raw) ? raw.toString() : raw);
      if (!isFinite(value)) continue;
      await sv.query(
        `INSERT INTO snmp_results (device_id, oid, metric_name, value, if_index, if_name)
         VALUES ($1,$2,$3,$4,NULL,NULL)`,
        [device.id, s.oid, s.sensor_name, value]
      );
      written += 1;
    }
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
  return written;
}

// Store the detected vendor on the device when it changes (avoids an UPDATE
// every poll). device.device_vendor is updated in-memory so the parser lookup
// below this poll uses the freshly detected value.
async function persistVendor(device, vendor) {
  if (!vendor || vendor === device.device_vendor) return;
  try {
    await sv.query(
      `UPDATE monitored_devices SET device_vendor = $2, updated_at = NOW() WHERE id = $1`,
      [device.id, vendor]
    );
    device.device_vendor = vendor;
    log(`[snmp] ${device.name} detected vendor: ${vendor}`);
  } catch (err) {
    console.error('[snmp] vendor persist failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// Alert evaluation (rules + global thresholds)
// ══════════════════════════════════════════════════════════════
function compare(value, operator, threshold) {
  switch (operator) {
    case '>':  return value > threshold;
    case '>=': return value >= threshold;
    case '<':  return value < threshold;
    case '<=': return value <= threshold;
    case '=':
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default:   return value > threshold;
  }
}

async function evaluateSnmpAlerts(device, samples) {
  if (await inMaintenance({ deviceId: device.id })) return;

  // Latest non-interface metric values (cpu_pct, mem_pct).
  const latest = {};
  for (const s of samples) {
    if (s.if_index) continue;
    latest[s.metric_name] = s.value;
  }

  // Global CPU / memory thresholds from app_settings.
  const cpuThresh = settingInt('cpu_threshold_pct', 80);
  const memThresh = settingInt('mem_threshold_pct', 85);
  if (latest.cpu_pct !== undefined) {
    if (latest.cpu_pct > cpuThresh) {
      await raiseAlert(device, 'high_cpu', 'warning',
        buildHighCpuMessage(device, latest.cpu_pct, cpuThresh), latest.cpu_pct);
    } else {
      await resolveAlert(device.id, 'high_cpu');
    }
  }
  if (latest.mem_pct !== undefined) {
    if (latest.mem_pct > memThresh) {
      await raiseAlert(device, 'high_memory', 'warning',
        buildHighMemMessage(device, latest.mem_pct, memThresh), latest.mem_pct);
    } else {
      await resolveAlert(device.id, 'high_memory');
    }
  }

  // ── Vendor sensor thresholds (Fortinet HA, firewall session table, BGP) ──
  // Fortinet HA sync lost: ha_sync_status reported and equal to 0.
  if (latest.ha_sync_status !== undefined) {
    if (Number(latest.ha_sync_status) === 0) {
      await raiseAlert(device, 'ha_sync_lost', 'critical',
        `Fortinet HA sync lost on ${device.name}`, latest.ha_sync_status);
    } else {
      await resolveAlert(device.id, 'ha_sync_lost');
    }
  }

  // Session table near capacity: firewall session utilization over threshold.
  const sessThresh = settingInt('session_util_threshold_pct', 90);
  const sessUtil = latest.session_table_util_pct !== undefined
    ? latest.session_table_util_pct
    : latest.session_util_pct;
  if (sessUtil !== undefined && sessUtil !== null) {
    if (Number(sessUtil) > sessThresh) {
      await raiseAlert(device, 'session_table_high', 'warning',
        `Session table near capacity on ${device.name} (${Number(sessUtil).toFixed(0)}% > ${sessThresh}%)`,
        sessUtil);
    } else {
      await resolveAlert(device.id, 'session_table_high');
    }
  }

  // BGP peer down: established peers fell below the total discovered peers.
  if (latest.bgp_peers_established !== undefined && latest.bgp_peers_total !== undefined) {
    const est = Number(latest.bgp_peers_established);
    const total = Number(latest.bgp_peers_total);
    if (total > 0 && est < total) {
      await raiseAlert(device, 'bgp_peer_down', 'warning',
        `BGP peer down on ${device.name} (${est}/${total} established)`, est);
    } else {
      await resolveAlert(device.id, 'bgp_peer_down');
    }
  }

  // SNMP-context user rules (cpu_pct / mem_pct / interface_down / snmp_no_data).
  let interfaceDown = 0;
  for (const s of samples) {
    if ((s.metric_name === 'if_oper_status' || /_oper$/.test(s.metric_name)) && Number(s.value) === 0) {
      interfaceDown = 1;
      break;
    }
  }
  // Minutes since the most recent SNMP sample (drives snmp_no_data).
  let snmpNoDataMin = null;
  try {
    const r = await sv.query(`SELECT MAX(ts) AS last_ts FROM snmp_results WHERE device_id = $1`, [device.id]);
    const lastTs = r.rows[0] && r.rows[0].last_ts;
    snmpNoDataMin = lastTs ? (Date.now() - new Date(lastTs).getTime()) / 60000 : null;
  } catch (_e) { /* ignore */ }

  // Device-level bandwidth utilization = peak interface util this poll.
  let maxUtil = null;
  for (const s of samples) {
    if (/_util_pct$/.test(s.metric_name) && s.value != null) {
      const v = Number(s.value);
      if (isFinite(v) && (maxUtil === null || v > maxUtil)) maxUtil = v;
    }
  }

  await evaluateEffectiveRules(device, {
    cpu_pct: latest.cpu_pct !== undefined ? latest.cpu_pct : null,
    mem_pct: latest.mem_pct !== undefined ? latest.mem_pct : null,
    interface_down: interfaceDown,
    snmp_no_data: snmpNoDataMin,
    bandwidth_pct: maxUtil,
  });
}

// ── Maintenance suppression ───────────────────────────────────
// Three-way scope match against maintenance_windows:
//  - A row with device_id IS NULL AND service_check_id IS NULL is a GLOBAL window
//    and always matches (first OR clause) — this preserves the original
//    "device_id IS NULL = global" semantics for both devices and services.
//  - A row with device_id set only matches when deviceId equals it.
//  - A row with service_check_id set only matches when serviceCheckId equals it.
// Passing null for the arg you're not using is safe: `device_id = NULL` (or
// `service_check_id = NULL`) is never TRUE in SQL, so a null param cannot
// accidentally match a NULL-scoped column — ordinary `=` is NULL-safe here,
// we deliberately avoid `IS NOT DISTINCT FROM` which WOULD match nulls.
async function inMaintenance({ deviceId = null, serviceCheckId = null } = {}) {
  try {
    const r = await sv.query(`
      SELECT 1 FROM maintenance_windows
       WHERE ((device_id IS NULL AND service_check_id IS NULL)
              OR device_id = $1
              OR service_check_id = $2)
         AND starts_at <= NOW() AND ends_at >= NOW()
       LIMIT 1
    `, [deviceId, serviceCheckId]);
    return r.rowCount > 0;
  } catch (_err) {
    return false;
  }
}

// ── Raise / resolve alerts (idempotent via unique active index) ─
async function raiseAlert(device, alertType, severity, message, metricValue) {
  // Gateway suppression: this device's site gateway is down, so its outage is a
  // downstream consequence — don't raise new alerts for it.
  if (suppressedDevices.has(device.id)) return;
  try {
    const r = await sv.query(`
      INSERT INTO alerts (device_id, alert_type, severity, message, metric_value, status)
      VALUES ($1,$2,$3,$4,$5,'active')
      ON CONFLICT (device_id, alert_type) WHERE status = 'active' DO NOTHING
      RETURNING id
    `, [device.id, alertType, severity, message, isFinite(metricValue) ? metricValue : null]);
    if (r.rows[0]) {
      log(`[alert] RAISED ${alertType} on ${device.name}: ${message}`);
      await notifyAlertRaise(device, severity, alertType, `[SpanVault] ${severity.toUpperCase()}: ${message}`, message);
    }
  } catch (err) {
    console.error('[alerts] raise failed:', err.message);
  }
}

async function resolveAlert(deviceId, alertType) {
  try {
    const r = await sv.query(`
      UPDATE alerts SET status = 'resolved', resolved_at = NOW()
       WHERE device_id = $1 AND alert_type = $2 AND status <> 'resolved'
       RETURNING id
    `, [deviceId, alertType]);
    if (r.rows[0]) { log(`[alert] RESOLVED ${alertType} on device ${deviceId}`); return true; }
    return false;
  } catch (err) {
    console.error('[alerts] resolve failed:', err.message);
    return false;
  }
}

// ── Agent-level alerts (agent_down) ───────────────────────────
// An agent being offline references the agent, not a device. One active
// agent_down per agent is enforced by idx_alerts_active_agent_unique.
async function raiseAgentAlert(agent, message) {
  try {
    const r = await sv.query(`
      INSERT INTO alerts (agent_id, alert_type, severity, message, status)
      VALUES ($1,'agent_down','critical',$2,'active')
      ON CONFLICT (agent_id, alert_type) WHERE status = 'active' AND agent_id IS NOT NULL DO NOTHING
      RETURNING id
    `, [agent.id, message]);
    if (r.rows[0]) {
      log(`[alert] RAISED agent_down on ${agent.name}: ${message}`);
      await notifyAlertRaise({ agent: true, id: agent.id }, 'critical', 'agent_down',
        `[SpanVault] CRITICAL: ${message}`, message);
    }
  } catch (err) {
    console.error('[alerts] agent raise failed:', err.message);
  }
}

async function resolveAgentAlert(agentId) {
  try {
    const r = await sv.query(`
      UPDATE alerts SET status = 'resolved', resolved_at = NOW()
       WHERE agent_id = $1 AND alert_type = 'agent_down' AND status <> 'resolved'
       RETURNING id
    `, [agentId]);
    if (r.rows[0]) { log(`[alert] RESOLVED agent_down on agent ${agentId}`); return true; }
    return false;
  } catch (err) {
    console.error('[alerts] agent resolve failed:', err.message);
    return false;
  }
}

// Evaluate ONE agent-owned device from its STORED state (the agent has already
// written current_status / last_response_ms / last_seen_at + ping/snmp rows).
// Mirrors pingDevice's reachability + latency + rules evaluation.
async function evaluateStoredDevice(device) {
  const newStatus = device.current_status;
  const timeMs = device.last_response_ms != null ? Number(device.last_response_ms) : null;
  const threshold = device.ping_threshold_ms || 500;

  // No usable data — agent-offline suppression is handled by evaluateAgentDevices.
  if (newStatus === 'agent_offline' || newStatus === 'unknown' || newStatus == null) return;

  const inMaint = await inMaintenance({ deviceId: device.id });

  // Reachability.
  if (newStatus === 'down' && !inMaint) {
    await raiseAlert(device, 'device_down', 'critical',
      await buildDeviceDownMessage(device), null);
  } else if (newStatus !== 'down') {
    if (await resolveAlert(device.id, 'device_down')) await notifyRecovery(device, 'device_down', 'Device down');
  }

  // Latency.
  const alive = (newStatus === 'up' || newStatus === 'warning');
  if (alive && timeMs !== null && timeMs > threshold && !inMaint) {
    await raiseAlert(device, 'high_latency', 'warning',
      await buildHighLatencyMessage(device, timeMs), timeMs);
  } else if (alive && (timeMs === null || timeMs <= threshold)) {
    if (await resolveAlert(device.id, 'high_latency')) await notifyRecovery(device, 'high_latency', 'High latency');
  }

  // SNMP-metric rules from the latest stored samples (best-effort).
  let cpu_pct = null;
  let mem_pct = null;
  try {
    const r = await sv.query(
      `SELECT DISTINCT ON (metric_name) metric_name, value
         FROM snmp_results
        WHERE device_id = $1 AND metric_name IN ('cpu_pct','mem_pct')
        ORDER BY metric_name, ts DESC`,
      [device.id]
    );
    for (const row of r.rows) {
      if (row.metric_name === 'cpu_pct') cpu_pct = row.value != null ? Number(row.value) : null;
      else if (row.metric_name === 'mem_pct') mem_pct = row.value != null ? Number(row.value) : null;
    }
  } catch (_e) { /* ignore — no SNMP data yet */ }

  await evaluateEffectiveRules(device, {
    device_down: newStatus === 'down' ? 1 : 0,
    response_time: timeMs,
    cpu_pct,
    mem_pct,
  });
}

// Alert pass for agent-polled devices. When an agent is OFFLINE we raise ONE
// agent_down alert and SUPPRESS its devices' alerts (we can't see them, so we
// don't spam N device-down alerts). When ONLINE we evaluate each device from its
// stored state. Agents that never connected are never alerted on.
async function evaluateAgentDevices() {
  try {
    const agents = (await sv.query(`SELECT id, name, status FROM agents`)).rows;
    for (const agent of agents) {
      if (agent.status === 'offline') {
        // Dependency: the agent is down, so its devices' outages are unknowable.
        let count = 0;
        try {
          const c = (await sv.query(
            `SELECT COUNT(*)::int AS c FROM monitored_devices WHERE agent_id = $1 AND active = TRUE`,
            [agent.id]
          )).rows[0];
          count = c ? c.c : 0;
        } catch (_e) { /* ignore */ }
        await raiseAgentAlert(agent,
          `Agent ${agent.name} is offline — ${count} device(s) at its site(s) are not being polled`);
        try {
          await sv.query(
            `UPDATE alerts SET status = 'suppressed', resolved_at = NOW(), suppression_reason = $2
              WHERE status = 'active'
                AND device_id IN (SELECT id FROM monitored_devices WHERE agent_id = $1)`,
            [agent.id, `Agent ${agent.name} is offline`]
          );
        } catch (err) {
          console.error('[agent-eval] suppress failed:', err.message);
        }
      } else if (agent.status === 'online') {
        await resolveAgentAlert(agent.id);
        const devs = (await sv.query(
          `SELECT * FROM monitored_devices WHERE agent_id = $1 AND active = TRUE`,
          [agent.id]
        )).rows;
        for (const d of devs) {
          await evaluateStoredDevice(d).catch((e) =>
            console.error('[agent-eval]', d.name, e.message));
        }
      } else {
        // never_connected or other — never alert; clear any stale agent_down.
        await resolveAgentAlert(agent.id);
      }
    }
  } catch (err) {
    console.error('[agent-eval] tick failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// Human-language alert messages
// ══════════════════════════════════════════════════════════════
// Each builder composes a readable, context-rich message. All enrichment
// queries are best-effort: any failure degrades to a simpler sentence rather
// than blocking the alert.

function humanDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return 'an unknown time';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Baseline mean for a metric (prefers the shortest period — usually 7/30d).
async function getBaselineMean(deviceId, metric) {
  try {
    const r = await sv.query(
      `SELECT mean FROM device_baselines
        WHERE device_id = $1 AND metric = $2 AND mean IS NOT NULL
        ORDER BY period_days ASC LIMIT 1`, [deviceId, metric]);
    return r.rows[0] ? Number(r.rows[0].mean) : null;
  } catch (_e) { return null; }
}

// The most recently seen LLDP/CDP neighbor of a device (for "connected via …").
async function getFirstTopologyLink(deviceId) {
  try {
    const r = await sv.query(
      `SELECT t.from_port, COALESCE(nd.name, t.to_name, t.to_ip) AS neighbor
         FROM topology_links t
         LEFT JOIN monitored_devices nd ON nd.id = t.to_device_id
        WHERE t.from_device_id = $1 AND COALESCE(nd.name, t.to_name, t.to_ip) IS NOT NULL
        ORDER BY t.last_seen_at DESC LIMIT 1`, [deviceId]);
    return r.rows[0] || null;
  } catch (_e) { return null; }
}

// An UP "backup" device in the same site (name heuristic), if any.
async function getUpBackupInSite(device) {
  if (device.site_id == null) return null;
  try {
    const r = await sv.query(
      `SELECT name FROM monitored_devices
        WHERE site_id = $1 AND id <> $2 AND active = TRUE
          AND current_status = 'up' AND name ILIKE '%backup%' LIMIT 1`,
      [device.site_id, device.id]);
    return r.rows[0] || null;
  } catch (_e) { return null; }
}

// A recurring pattern description for a metric, if one has been detected.
async function getPatternNote(deviceId, metric) {
  try {
    const r = await sv.query(
      `SELECT description FROM device_patterns
        WHERE device_id = $1 AND metric = $2
        ORDER BY confidence DESC NULLS LAST LIMIT 1`, [deviceId, metric]);
    return r.rows[0] ? r.rows[0].description : null;
  } catch (_e) { return null; }
}

async function buildDeviceDownMessage(device) {
  let msg = `${device.name} (${device.ip_address}) is unreachable.`;
  const lastSeen = device.last_seen_at
    ? humanDuration(Date.now() - new Date(device.last_seen_at).getTime()) : null;
  const baseline = await getBaselineMean(device.id, 'response_ms');
  if (lastSeen && baseline != null) msg += ` Last seen ${lastSeen} ago with ${Math.round(baseline)}ms avg response time.`;
  else if (lastSeen) msg += ` Last seen ${lastSeen} ago.`;
  const link = await getFirstTopologyLink(device.id);
  if (link) msg += ` Connected via ${link.from_port || 'an uplink'} to ${link.neighbor}.`;
  const backup = await getUpBackupInSite(device);
  if (backup) msg += ` ${backup.name} is UP and may be handling traffic.`;
  return msg;
}

async function buildHighLatencyMessage(device, timeMs) {
  let msg = `${device.name} is responding slowly — ${Math.round(timeMs)}ms average`;
  const baseline = await getBaselineMean(device.id, 'response_ms');
  if (baseline != null && baseline > 0) {
    msg += ` (normal: ${Math.round(baseline)}ms). This is ${(timeMs / baseline).toFixed(1)}x above the normal baseline.`;
  } else {
    msg += '.';
  }
  const pattern = await getPatternNote(device.id, 'response_ms');
  if (pattern) msg += ` This has occurred before: ${pattern}.`;
  return msg;
}

function buildHighCpuMessage(device, pct, threshold) {
  let msg = `${device.name} CPU is at ${Math.round(pct)}% (threshold: ${threshold}%).`;
  const v = (device.device_vendor || '').toLowerCase();
  if (v === 'fortinet') msg += ' Check active sessions and VPN tunnels.';
  else if (v === 'cisco') msg += ' Check for routing loops or high traffic.';
  return msg;
}

function buildHighMemMessage(device, pct, threshold) {
  return `${device.name} memory usage is at ${Math.round(pct)}% (threshold: ${threshold}%). `
    + 'Consider investigating running processes or memory leaks.';
}

async function buildInterfaceDownMessage(device) {
  let msg = `An interface on ${device.name} has gone down.`;
  const link = await getFirstTopologyLink(device.id);
  if (link) msg += ` This link connects to ${link.neighbor}.`;
  return msg;
}

// One-shot recovery record for a device coming back up, with downtime + latency.
async function deviceRecoveryEvent(device, timeMs) {
  try {
    const r = await sv.query(
      `SELECT triggered_at, resolved_at FROM alerts
        WHERE device_id = $1 AND alert_type = 'device_down'
        ORDER BY triggered_at DESC LIMIT 1`, [device.id]);
    let downtime = 'an unknown time';
    if (r.rows[0]) {
      const t = new Date(r.rows[0].triggered_at).getTime();
      const e = r.rows[0].resolved_at ? new Date(r.rows[0].resolved_at).getTime() : Date.now();
      downtime = humanDuration(e - t);
    }
    const rt = timeMs != null ? `${Math.round(timeMs)}ms` : 'normal';
    const msg = `${device.name} has recovered. Downtime was ${downtime}. Response time is back to ${rt}.`;
    await sv.query(
      `INSERT INTO alerts (device_id, alert_type, severity, message, status, resolved_at)
       VALUES ($1,'recovery','info',$2,'resolved',NOW())`, [device.id, msg]);
    log(`[alert] RECOVERY device_down on ${device.name}`);
  } catch (err) {
    console.error('[alerts] device recovery event failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// Site-gateway alert suppression
// ══════════════════════════════════════════════════════════════
// When a site's gateway device is down, the whole site is assumed unreachable
// through it, so alerts for every OTHER device at that site are suppressed. When
// the gateway recovers (or a site has no gateway), suppression is cleared and
// normal evaluation resumes. Updates the in-memory suppressedDevices set.
async function runSuppressionPass() {
  let downGateways;
  try {
    downGateways = (await sv.query(
      `SELECT id, name, site_id FROM monitored_devices
        WHERE is_gateway = TRUE AND current_status = 'down' AND active = TRUE`
    )).rows;
  } catch (err) {
    console.error('[suppress] load failed:', err.message);
    return;
  }

  const next = new Set();
  // 1+2. For each down gateway, suppress all other active devices in its site.
  for (const g of downGateways) {
    try {
      const r = await sv.query(
        `UPDATE monitored_devices
            SET alert_suppressed = TRUE, suppressed_by_device_id = $2, updated_at = NOW()
          WHERE site_id IS NOT DISTINCT FROM $1 AND id <> $2 AND active = TRUE
          RETURNING id`,
        [g.site_id, g.id]
      );
      const ids = r.rows.map((row) => row.id);
      for (const dId of ids) next.add(dId);
      // Resolve any active alerts on the suppressed devices to 'suppressed'.
      if (ids.length) {
        await sv.query(
          `UPDATE alerts
              SET status = 'suppressed', resolved_at = NOW(),
                  suppressed_by = $2, suppression_reason = $3
            WHERE device_id = ANY($1::int[]) AND status = 'active'`,
          [ids, g.id, `Site gateway ${g.name} is down`]
        );
      }
    } catch (err) {
      console.error('[suppress] apply failed:', err.message);
    }
  }

  // 3. Clear suppression everywhere a down gateway is no longer responsible
  //    (gateway recovered, gateway cleared, or site never had a down gateway).
  const downIds = downGateways.map((g) => g.id);
  try {
    await sv.query(
      `UPDATE monitored_devices
          SET alert_suppressed = FALSE, suppressed_by_device_id = NULL, updated_at = NOW()
        WHERE suppressed_by_device_id IS NOT NULL
          AND NOT (suppressed_by_device_id = ANY($1::int[]))`,
      [downIds.length ? downIds : [0]]
    );
  } catch (err) {
    console.error('[suppress] clear failed:', err.message);
  }

  suppressedDevices = next;
}

// ══════════════════════════════════════════════════════════════
// Multi-level rule evaluation (global → site → device inheritance)
// ══════════════════════════════════════════════════════════════
const METRIC_LABELS = {
  device_down: 'Device down', response_time: 'Response time', packet_loss: 'Packet loss',
  cpu_pct: 'CPU', mem_pct: 'Memory', interface_down: 'Interface down',
  snmp_no_data: 'SNMP no data', bandwidth_pct: 'Bandwidth',
};
const METRIC_UNITS = {
  response_time: 'ms', packet_loss: '%', cpu_pct: '%', mem_pct: '%',
  snmp_no_data: 'm', bandwidth_pct: '%',
};

// Service-check metric namespace — kept distinct from the device METRIC_LABELS/
// METRIC_UNITS above so a device-scoped global rule (e.g. cpu_pct) can never be
// mistaken for a service rule, and vice versa (see getEffectiveServiceRules).
const SERVICE_METRICS = ['service_down', 'service_response_time', 'ssl_expiring'];
const SERVICE_METRIC_LABELS = {
  service_down: 'Service down', service_response_time: 'Response time', ssl_expiring: 'SSL expiring',
};
const SERVICE_METRIC_UNITS = {
  service_response_time: 'ms',
};

// Effective rules for a device: global + matching-site + device, merged by
// metric with device > site > global precedence.
async function getEffectiveRules(device) {
  const r = await sv.query(
    `SELECT * FROM alert_rules WHERE enabled = TRUE AND (
        scope = 'global'
        OR (scope = 'site'   AND site_id IS NOT DISTINCT FROM $2)
        OR (scope = 'device' AND device_id = $1)
     )`,
    [device.id, device.site_id == null ? null : device.site_id]
  );
  const prec = { global: 0, site: 1, device: 2 };
  const byMetric = new Map();
  for (const rule of r.rows) {
    const cur = byMetric.get(rule.metric);
    if (!cur || (prec[rule.scope] || 0) >= (prec[cur.scope] || 0)) byMetric.set(rule.metric, rule);
  }
  return Array.from(byMetric.values());
}

// Effective rules for a service check: global + matching-site + service, merged
// by metric with service > site > global precedence. The global/site branches
// are filtered to the SERVICE_METRICS namespace so a device-scoped global rule
// (e.g. metric='cpu_pct') is never treated as effective for a service, and a
// service-scoped rule is never picked up by a device's getEffectiveRules().
async function getEffectiveServiceRules(check) {
  const r = await sv.query(
    `SELECT * FROM alert_rules WHERE enabled = TRUE AND (
        (scope = 'global' AND metric = ANY($3::text[]))
        OR (scope = 'site' AND site_id IS NOT DISTINCT FROM $2 AND metric = ANY($3::text[]))
        OR (scope = 'service' AND service_check_id = $1)
     )`,
    [check.id, check.site_id == null ? null : check.site_id, SERVICE_METRICS]
  );
  const prec = { global: 0, site: 1, service: 2 };
  const byMetric = new Map();
  for (const rule of r.rows) {
    const cur = byMetric.get(rule.metric);
    if (!cur || (prec[rule.scope] || 0) >= (prec[cur.scope] || 0)) byMetric.set(rule.metric, rule);
  }
  return Array.from(byMetric.values());
}

function ruleMessage(device, rule, val) {
  const label = METRIC_LABELS[rule.metric] || rule.metric;
  if (rule.metric === 'device_down') return `${device.name} is down`;
  if (rule.metric === 'interface_down') return `${device.name} has an interface down`;
  if (rule.metric === 'snmp_no_data') {
    return `${device.name} has no SNMP data for ${Math.round(Number(val))}m (threshold ${rule.threshold}m)`;
  }
  const unit = METRIC_UNITS[rule.metric] || '';
  const num = typeof val === 'number' ? val.toFixed(1) : val;
  return `${device.name} ${label} ${num}${unit} ${rule.operator || '>'} ${rule.threshold}${unit}`;
}

// Log a one-shot recovery record (resolved immediately) for the event timeline.
async function recoveryEvent(device, rule) {
  try {
    await sv.query(
      `INSERT INTO alerts (device_id, alert_type, severity, message, status, resolved_at)
       VALUES ($1,$2,'info',$3,'resolved',NOW())`,
      [device.id, `recovery_${rule.id}`,
       `${device.name} recovered: ${METRIC_LABELS[rule.metric] || rule.metric} back to normal`]
    );
    log(`[alert] RECOVERY ${rule.metric} on ${device.name}`);
  } catch (err) {
    console.error('[alerts] recovery event failed:', err.message);
  }
}

// Evaluate a device's effective rules against the metric values available in
// this context. Metrics absent from `metrics` are left untouched (a different
// poll path owns them); null/undefined values are skipped (no data yet).
async function evaluateEffectiveRules(device, metrics) {
  if (await inMaintenance({ deviceId: device.id })) return;
  let rules;
  try { rules = await getEffectiveRules(device); }
  catch (err) { console.error('[alerts] effective rule fetch failed:', err.message); return; }

  for (const rule of rules) {
    const m = rule.metric;
    if (!(m in metrics)) continue;
    const val = metrics[m];
    if (val === undefined || val === null) continue;
    const alertType = `rule_${rule.id}`;

    const triggered = (m === 'device_down' || m === 'interface_down')
      ? Number(val) === 1
      : compare(Number(val), rule.operator || '>', Number(rule.threshold));

    if (triggered) {
      const message = m === 'interface_down'
        ? await buildInterfaceDownMessage(device)
        : ruleMessage(device, rule, val);
      await raiseAlert(device, alertType, rule.severity || 'warning',
        message, typeof val === 'number' ? val : null);
    } else {
      const wasActive = await resolveAlert(device.id, alertType);
      if (wasActive && rule.notify_recovery) {
        await recoveryEvent(device, rule);
        await notifyRecovery(device, alertType, METRIC_LABELS[rule.metric] || rule.metric);
      }
    }
  }
}

// ── Email notifications ───────────────────────────────────────
// Recipients for an alert, honoring notification_routes. A NULL/omitted match
// dimension means "any". Falls back to the global alert_email_to when no route
// matches (or the table doesn't exist yet).
async function recipientsFor(siteId, severity, alertType) {
  try {
    const r = await sv.query(
      `SELECT email_to FROM notification_routes
        WHERE enabled = TRUE
          AND (match_severity   IS NULL OR $1::text IS NULL OR match_severity   = $1)
          AND (match_site_id    IS NULL OR $2::int  IS NULL OR match_site_id    = $2)
          AND (match_alert_type IS NULL OR $3::text IS NULL OR match_alert_type = $3)`,
      [severity || null, siteId == null ? null : siteId, alertType || null]
    );
    const set = new Set();
    for (const row of r.rows) {
      for (const e of String(row.email_to).split(/[\s,;]+/)) { if (e) set.add(e.trim()); }
    }
    if (set.size) return Array.from(set).join(',');
  } catch (_e) { /* table may not exist yet — fall through to global */ }
  return setting('alert_email_to', '');
}

// Throttle: stamp + return true if we may notify, false if within the cooldown
// window (suppresses re-notification of a flapping alert). 0 disables throttle.
async function notifyCooldownOk(deviceId, agentId, alertType) {
  const mins = settingInt('notify_cooldown_minutes', 15);
  if (mins <= 0) return true;
  try {
    const r = await sv.query(
      `INSERT INTO notification_state (device_id, agent_id, alert_type, last_notified_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (device_id, agent_id, alert_type) DO UPDATE SET last_notified_at = NOW()
         WHERE notification_state.last_notified_at < NOW() - make_interval(mins => $4::int)
       RETURNING device_id`,
      [deviceId || 0, agentId || 0, alertType, mins]
    );
    return r.rowCount > 0;
  } catch (_e) { return true; } // if table missing, never block notifications
}

// Notify on a NEW alert (routed + throttled). entity = a device row, or
// { agent:true, id } for an agent-level alert.
async function notifyAlertRaise(entity, severity, alertType, subject, body) {
  const isAgent = !!entity.agent;
  if (!(await notifyCooldownOk(isAgent ? 0 : entity.id, isAgent ? entity.id : 0, alertType))) return;
  const to = await recipientsFor(isAgent ? null : entity.site_id, severity, alertType);
  if (to) await sendAlertEmail(subject, body, to);
}

// Notify that an alert cleared (the "all-clear"), routed to the same recipients.
async function notifyRecovery(device, alertType, label) {
  if (String(setting('email_recovery_enabled', 'true')).toLowerCase() === 'false') return;
  const to = await recipientsFor(device.site_id, null, alertType);
  if (to) {
    await sendAlertEmail(
      `[SpanVault] RESOLVED: ${label} on ${device.name}`,
      `${label} on ${device.name} (${device.ip_address || 'unknown IP'}) has recovered.`,
      to
    );
  }
}

async function sendAlertEmail(subject, body, to) {
  if (!settingBool('email_alerts_enabled')) return;
  const host = setting('smtp_host', '');
  const recipients = to || setting('alert_email_to', '');
  if (!host || !recipients) return;
  try {
    const transport = nodemailer.createTransport({
      host,
      port: settingInt('smtp_port', 587),
      secure: settingInt('smtp_port', 587) === 465,
      auth: setting('smtp_user', '') ? { user: setting('smtp_user', ''), pass: setting('smtp_pass', '') } : undefined,
    });
    await transport.sendMail({
      from: setting('smtp_from', '') || setting('smtp_user', 'spanvault@localhost'),
      to: recipients,
      subject,
      text: body,
    });
  } catch (err) {
    console.error('[email] send failed:', err.message);
  }
}

// ── Escalation + on-call ──────────────────────────────────────
// Comma-joined emails of whoever's on-call shift covers now.
async function currentOnCall() {
  try {
    const r = await sv.query(
      `SELECT contact_email FROM oncall_shifts WHERE NOW() BETWEEN starts_at AND ends_at`);
    const set = new Set();
    for (const row of r.rows) {
      for (const e of String(row.contact_email).split(/[\s,;]+/)) { if (e) set.add(e.trim()); }
    }
    return Array.from(set).join(',');
  } catch (_e) { return ''; }
}

// Every minute: for each active, unacknowledged alert, fire any escalation step
// whose delay has elapsed and hasn't fired yet (email that step's recipients).
async function escalationTick() {
  if (String(setting('escalation_enabled', 'false')).toLowerCase() !== 'true') return;
  try {
    const steps = (await sv.query(
      `SELECT * FROM escalation_steps WHERE enabled = TRUE ORDER BY step_order, after_minutes`)).rows;
    if (!steps.length) return;
    const minSev = setting('escalation_min_severity', 'critical');
    const sevClause = minSev === 'warning' ? '' : `AND a.severity = 'critical'`;
    const alerts = (await sv.query(`
      SELECT a.id, a.severity, a.message, a.triggered_at,
             COALESCE(d.name, ag.name, sc.name) AS subject_name
        FROM alerts a
        LEFT JOIN monitored_devices d ON d.id = a.device_id
        LEFT JOIN agents ag ON ag.id = a.agent_id
        LEFT JOIN service_checks sc ON sc.id = a.service_check_id
       WHERE a.status = 'active' AND a.acknowledged_at IS NULL ${sevClause}`)).rows;
    if (!alerts.length) return;
    let oncall = null; // resolved lazily, reused across alerts this tick
    for (const al of alerts) {
      const ageMin = (Date.now() - new Date(al.triggered_at).getTime()) / 60000;
      for (const step of steps) {
        if (ageMin < step.after_minutes) continue;
        const claim = await sv.query(
          `INSERT INTO alert_escalations (alert_id, step_id) VALUES ($1,$2)
           ON CONFLICT (alert_id, step_id) DO NOTHING RETURNING alert_id`, [al.id, step.id]);
        if (!claim.rows[0]) continue; // already fired this step for this alert
        let to = step.email_to || '';
        if (step.use_oncall) { if (oncall === null) oncall = await currentOnCall(); to = oncall; }
        if (to) {
          await sendAlertEmail(
            `[SpanVault] ESCALATION: ${al.message || al.subject_name || 'alert'}`,
            `Alert on ${al.subject_name || 'unknown'} has been unacknowledged for ${Math.round(ageMin)} min.\n\n${al.message || ''}`,
            to);
          log(`[escalation] step ${step.step_order} fired for alert ${al.id}`);
        }
      }
    }
  } catch (err) {
    console.error('[escalation] tick failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// Agentless service checks (HTTP / TCP / SSL / DNS)
// ══════════════════════════════════════════════════════════════
// Each runner probes a target with Node built-ins and resolves to
// { status, response_ms, detail } — NEVER throws. Central (agent_id IS NULL)
// checks are run here; agent-owned checks have their status written by the WS
// handler. serviceCheckTick() evaluates alerts for ALL active checks from their
// stored current_status.

function svcParams(check) {
  // params is JSONB → already an object via pg, but tolerate a string or null.
  const p = check && check.params;
  if (!p) return {};
  if (typeof p === 'string') { try { return JSON.parse(p) || {}; } catch (_e) { return {}; } }
  return p;
}

// Split "host:port" → { host, port }. port falls back to params.port / def.
function hostPort(target, paramsPort, def) {
  let host = String(target || '').trim();
  let port = null;
  // Strip an optional scheme so tcp/ssl targets like "https://h:443" still work.
  host = host.replace(/^[a-z]+:\/\//i, '');
  // Drop any trailing path.
  host = host.split('/')[0];
  const idx = host.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(host.slice(idx + 1))) {
    port = parseInt(host.slice(idx + 1), 10);
    host = host.slice(0, idx);
  }
  if (!port && paramsPort) port = parseInt(paramsPort, 10);
  if (!port) port = def;
  return { host, port };
}

// HTTP/HTTPS GET. up = status in expect-range AND (no keyword OR body contains it).
function checkHttp(target, params) {
  return new Promise((resolve) => {
    const p = params || {};
    const timeout = parseInt(p.timeout_ms, 10) || 10000;
    let url = String(target || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    let parsed;
    try { parsed = new urlmod.URL(url); }
    catch (_e) { return resolve({ status: 'down', response_ms: null, detail: 'Invalid URL' }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const keyword = p.keyword ? String(p.keyword) : null;
    const start = Date.now();
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };

    let req;
    try {
      req = lib.request(url, { method: 'GET', timeout }, (res) => {
        const code = res.statusCode || 0;
        let body = '';
        // Only buffer body when a keyword match is required (bounded to ~256KB).
        res.on('data', (chunk) => {
          if (!keyword) return;
          if (body.length < 262144) body += chunk.toString();
        });
        res.on('end', () => {
          const ms = Date.now() - start;
          const okCode = matchExpectStatus(code, p.expect_status);
          if (!okCode) return finish({ status: 'down', response_ms: ms, detail: `HTTP ${code}` });
          if (keyword && body.indexOf(keyword) === -1) {
            return finish({ status: 'down', response_ms: ms, detail: `HTTP ${code} — keyword not found` });
          }
          finish({ status: 'up', response_ms: ms, detail: `HTTP ${code}` });
        });
        res.on('error', (err) =>
          finish({ status: 'down', response_ms: Date.now() - start, detail: err.message }));
      });
    } catch (err) {
      return finish({ status: 'down', response_ms: Date.now() - start, detail: err.message });
    }
    req.on('timeout', () => { try { req.destroy(); } catch (_e) {}
      finish({ status: 'down', response_ms: Date.now() - start, detail: 'Timeout' }); });
    req.on('error', (err) =>
      finish({ status: 'down', response_ms: Date.now() - start, detail: err.message }));
    try { req.end(); } catch (_e) { /* error event handles it */ }
  });
}

// Is an HTTP status code accepted? expect = number, "200", "200,301", "200-399"
// (default 200-399). Ranges and CSV lists are both supported.
function matchExpectStatus(code, expect) {
  if (expect === undefined || expect === null || expect === '') return code >= 200 && code <= 399;
  const parts = String(expect).split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { if (code >= parseInt(m[1], 10) && code <= parseInt(m[2], 10)) return true; }
    else if (parseInt(part, 10) === code) return true;
  }
  return false;
}

// TCP connect. up = connected within timeout; down = error/timeout.
function checkTcp(target, params) {
  return new Promise((resolve) => {
    const p = params || {};
    const timeout = parseInt(p.timeout_ms, 10) || 10000;
    const { host, port } = hostPort(target, p.port, null);
    if (!host || !port) return resolve({ status: 'down', response_ms: null, detail: 'No host/port' });
    const start = Date.now();
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch (_e) {} resolve(r); };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeout);
    sock.on('connect', () => finish({ status: 'up', response_ms: Date.now() - start, detail: `Connected to ${host}:${port}` }));
    sock.on('timeout', () => finish({ status: 'down', response_ms: Date.now() - start, detail: 'Timeout' }));
    sock.on('error', (err) => finish({ status: 'down', response_ms: Date.now() - start, detail: err.message }));
  });
}

// SSL/TLS cert check. warning = cert expires within ssl_warn_days (default 14);
// down = connect/handshake error; up otherwise.
function checkSsl(target, params) {
  return new Promise((resolve) => {
    const p = params || {};
    const timeout = parseInt(p.timeout_ms, 10) || 10000;
    const warnDays = parseInt(p.ssl_warn_days, 10) || 14;
    const { host, port } = hostPort(target, p.port, 443);
    if (!host) return resolve({ status: 'down', response_ms: null, detail: 'No host' });
    const start = Date.now();
    let done = false;
    let sock;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch (_e) {} resolve(r); };
    try {
      sock = tls.connect({ host, port, servername: host, timeout, rejectUnauthorized: false }, () => {
        const ms = Date.now() - start;
        const cert = sock.getPeerCertificate();
        if (!cert || !cert.valid_to) return finish({ status: 'down', response_ms: ms, detail: 'No certificate' });
        const validTo = new Date(cert.valid_to);
        if (isNaN(validTo.getTime())) return finish({ status: 'down', response_ms: ms, detail: 'Bad cert date' });
        const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
        const ymd = validTo.toISOString().slice(0, 10);
        const detail = `Cert expires in ${daysLeft} days (${ymd})`;
        if (daysLeft <= warnDays) finish({ status: 'warning', response_ms: ms, detail });
        else finish({ status: 'up', response_ms: ms, detail });
      });
    } catch (err) {
      return finish({ status: 'down', response_ms: Date.now() - start, detail: err.message });
    }
    sock.on('timeout', () => finish({ status: 'down', response_ms: Date.now() - start, detail: 'Timeout' }));
    sock.on('error', (err) => finish({ status: 'down', response_ms: Date.now() - start, detail: err.message }));
  });
}

// DNS resolve. up = ≥1 record; down = error/empty.
function checkDns(target, params) {
  return new Promise((resolve) => {
    const p = params || {};
    const timeout = parseInt(p.timeout_ms, 10) || 10000;
    let host = String(target || '').trim().replace(/^[a-z]+:\/\//i, '').split('/')[0];
    const idx = host.lastIndexOf(':');
    if (idx > 0 && /^\d+$/.test(host.slice(idx + 1))) host = host.slice(0, idx);
    if (!host) return resolve({ status: 'down', response_ms: null, detail: 'No hostname' });
    const start = Date.now();
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    // dns.resolve has no native timeout — guard it.
    const timer = setTimeout(() =>
      finish({ status: 'down', response_ms: Date.now() - start, detail: 'Timeout' }), timeout);
    dns.resolve(host, (err, records) => {
      clearTimeout(timer);
      const ms = Date.now() - start;
      if (err) return finish({ status: 'down', response_ms: ms, detail: err.message });
      const n = Array.isArray(records) ? records.length : 0;
      if (n < 1) return finish({ status: 'down', response_ms: ms, detail: 'No records' });
      finish({ status: 'up', response_ms: ms, detail: `Resolved ${n} record(s)` });
    });
  });
}

// Dispatch a check to the right runner. Always resolves to {status,response_ms,detail}.
async function runServiceCheck(check) {
  const params = svcParams(check);
  const type = String(check.type || '').toLowerCase();
  try {
    switch (type) {
      case 'http':
      case 'https': return await checkHttp(check.target, params);
      case 'tcp':   return await checkTcp(check.target, params);
      case 'ssl':
      case 'tls':   return await checkSsl(check.target, params);
      case 'dns':   return await checkDns(check.target, params);
      default:      return { status: 'unknown', response_ms: null, detail: `Unknown check type: ${check.type}` };
    }
  } catch (err) {
    return { status: 'down', response_ms: null, detail: err.message };
  }
}

// ── Service-level alerts (keyed on service_check_id, device_id NULL) ──
async function raiseServiceAlert(check, alertType, severity, message) {
  try {
    const r = await sv.query(`
      INSERT INTO alerts (service_check_id, alert_type, severity, message, status)
      VALUES ($1,$2,$3,$4,'active')
      ON CONFLICT (service_check_id, alert_type) WHERE status = 'active' AND service_check_id IS NOT NULL DO NOTHING
      RETURNING id
    `, [check.id, alertType, severity, message]);
    if (r.rows[0]) {
      log(`[alert] RAISED ${alertType} on service ${check.name}: ${message}`);
      // Route + throttle: key the throttle on the check id via the agent_id slot
      // (negative so it never collides with a real agent id), and route by site.
      if (await notifyCooldownOk(0, -check.id, alertType)) {
        const to = await recipientsFor(check.site_id, severity, alertType);
        if (to) await sendAlertEmail(`[SpanVault] ${severity.toUpperCase()}: ${message}`, message, to);
      }
    }
  } catch (err) {
    console.error('[alerts] service raise failed:', err.message);
  }
}

async function resolveServiceAlert(checkId, alertType) {
  try {
    const r = await sv.query(`
      UPDATE alerts SET status = 'resolved', resolved_at = NOW()
       WHERE service_check_id = $1 AND alert_type = $2 AND status <> 'resolved'
       RETURNING id
    `, [checkId, alertType]);
    if (r.rows[0]) { log(`[alert] RESOLVED ${alertType} on service ${checkId}`); return true; }
    return false;
  } catch (err) {
    console.error('[alerts] service resolve failed:', err.message);
    return false;
  }
}

// Log a one-shot recovery record for a service rule (mirrors recoveryEvent()
// for devices, keyed on service_check_id instead of device_id).
async function serviceRecoveryEvent(check, rule) {
  try {
    await sv.query(
      `INSERT INTO alerts (service_check_id, alert_type, severity, message, status, resolved_at)
       VALUES ($1,$2,'info',$3,'resolved',NOW())`,
      [check.id, `recovery_${rule.id}`,
       `${check.name} recovered: ${SERVICE_METRIC_LABELS[rule.metric] || rule.metric} back to normal`]
    );
    log(`[alert] RECOVERY ${rule.metric} on service ${check.name}`);
  } catch (err) {
    console.error('[alerts] service recovery event failed:', err.message);
  }
}

// Notify that a service alert cleared (mirrors notifyRecovery() for devices).
async function notifyServiceRecovery(check, alertType, label) {
  if (String(setting('email_recovery_enabled', 'true')).toLowerCase() === 'false') return;
  const to = await recipientsFor(check.site_id, null, alertType);
  if (to) {
    await sendAlertEmail(
      `[SpanVault] RESOLVED: ${label} on ${check.name}`,
      `${label} on ${check.name} has recovered.`,
      to
    );
  }
}

// Run one central check, persist its status + a result row.
async function runAndStoreServiceCheck(check) {
  const res = await runServiceCheck(check);
  const ms = (res.response_ms != null && isFinite(res.response_ms)) ? res.response_ms : null;
  try {
    await sv.query(`
      UPDATE service_checks
         SET current_status = $2, last_response_ms = $3, last_detail = $4,
             last_checked_at = NOW(), updated_at = NOW()
       WHERE id = $1
    `, [check.id, res.status, ms, res.detail || null]);
    await sv.query(
      `INSERT INTO service_check_results (check_id, status, response_ms, detail) VALUES ($1,$2,$3,$4)`,
      [check.id, res.status, ms, res.detail || null]
    );
  } catch (err) {
    console.error(`[svc] ${check.name} store failed:`, err.message);
  }
  // Update in-memory copy so the same-tick alert pass sees fresh state.
  check.current_status = res.status;
  check.last_detail = res.detail || null;
  check.last_response_ms = ms;
}

// Evaluate alerts for one check from its STORED status (central + agent alike).
// Consults configurable service rules (getEffectiveServiceRules) where present;
// falls back to the original hardcoded behavior for any metric with no matching
// rule, so a deployment with zero service rules configured behaves identically
// to before this function grew rule support.
async function evaluateServiceCheckAlerts(check) {
  if (await inMaintenance({ serviceCheckId: check.id })) return;
  let rules = [];
  try { rules = await getEffectiveServiceRules(check); }
  catch (err) {
    // Rule lookup failed — degrade to the pre-existing hardcoded behavior below.
    console.error('[alerts] effective service rule fetch failed:', err.message);
    rules = [];
  }
  const byMetric = new Map(rules.map((r) => [r.metric, r]));

  // Reachability — service_down.
  const downRule = byMetric.get('service_down');
  if (!downRule) {
    // No rule configured: identical to pre-rule-engine behavior (always critical).
    if (check.current_status === 'down') {
      await raiseServiceAlert(check, 'service_down', 'critical',
        `Service ${check.name} is down — ${check.last_detail || ''}`.trim());
    } else {
      await resolveServiceAlert(check.id, 'service_down');
    }
  } else if (downRule.enabled) {
    const alertType = `rule_${downRule.id}`;
    if (check.current_status === 'down') {
      await raiseServiceAlert(check, alertType, downRule.severity || 'critical',
        `Service ${check.name} is down — ${check.last_detail || ''}`.trim());
    } else {
      const wasActive = await resolveServiceAlert(check.id, alertType);
      if (wasActive && downRule.notify_recovery) {
        await serviceRecoveryEvent(check, downRule);
        await notifyServiceRecovery(check, alertType, SERVICE_METRIC_LABELS.service_down);
      }
    }
  }
  // downRule exists but disabled: skip alerting entirely for this metric, as
  // specified — no raise, no resolve.

  // Response time — service_response_time. NEW capability: only evaluated when
  // a rule exists (no rule = no response-time alerting, matching pre-existing
  // absence of this feature).
  const rtRule = byMetric.get('service_response_time');
  if (rtRule && rtRule.enabled) {
    const val = check.last_response_ms;
    const alertType = `rule_${rtRule.id}`;
    if (val !== undefined && val !== null) {
      const triggered = compare(Number(val), rtRule.operator || '>', Number(rtRule.threshold));
      if (triggered) {
        await raiseServiceAlert(check, alertType, rtRule.severity || 'warning',
          `${check.name} response time ${val}ms ${rtRule.operator} ${rtRule.threshold}ms`);
      } else {
        const wasActive = await resolveServiceAlert(check.id, alertType);
        if (wasActive && rtRule.notify_recovery) {
          await serviceRecoveryEvent(check, rtRule);
          await notifyServiceRecovery(check, alertType, SERVICE_METRIC_LABELS.service_response_time);
        }
      }
    }
  }

  // SSL expiry — ssl_expiring. The SSL runner reports status='warning' when the
  // cert is within ssl_warn_days; a matching rule overrides severity/enabled/
  // notify_recovery, defaulting to the original hardcoded 'warning' when absent.
  if (String(check.type || '').toLowerCase() === 'ssl') {
    const sslRule = byMetric.get('ssl_expiring');
    if (!sslRule) {
      if (check.current_status === 'warning') {
        await raiseServiceAlert(check, 'ssl_expiring', 'warning',
          `SSL for ${check.name}: ${check.last_detail || ''}`.trim());
      } else {
        await resolveServiceAlert(check.id, 'ssl_expiring');
      }
    } else if (sslRule.enabled) {
      const alertType = `rule_${sslRule.id}`;
      if (check.current_status === 'warning') {
        await raiseServiceAlert(check, alertType, sslRule.severity || 'warning',
          `SSL for ${check.name}: ${check.last_detail || ''}`.trim());
      } else {
        const wasActive = await resolveServiceAlert(check.id, alertType);
        if (wasActive && sslRule.notify_recovery) {
          await serviceRecoveryEvent(check, sslRule);
          await notifyServiceRecovery(check, alertType, SERVICE_METRIC_LABELS.ssl_expiring);
        }
      }
    }
    // sslRule exists but disabled: skip entirely, same as service_down above.
  }
}

let svcBusy = false;
async function serviceCheckTick() {
  if (svcBusy) return;
  svcBusy = true;
  try {
    let checks;
    try {
      checks = (await sv.query(`SELECT * FROM service_checks WHERE active = TRUE`)).rows;
    } catch (_e) {
      // Table not migrated yet — nothing to do.
      return;
    }

    // 1. Run DUE central checks (agent_id IS NULL).
    const now = Date.now();
    const due = checks.filter((c) => {
      if (c.agent_id != null) return false;
      const iv = (c.interval_seconds || 60) * 1000;
      if (!c.last_checked_at) return true;
      return now - new Date(c.last_checked_at).getTime() >= iv - 1000;
    });
    await runPooled(due, 10, (c) => runAndStoreServiceCheck(c).catch((e) =>
      console.error(`[svc] ${c.name} run failed:`, e.message)));
    if (due.length) log(`[svc] checked ${due.length} service(s)`);

    // 2. Evaluate alerts for ALL active checks from stored status (central +
    //    agent — agent checks have current_status set by the WS handler).
    for (const c of checks) {
      await evaluateServiceCheckAlerts(c).catch((e) =>
        console.error(`[svc] ${c.name} eval failed:`, e.message));
    }
  } catch (err) {
    console.error('[svc] tick failed:', err.message);
  } finally {
    svcBusy = false;
  }
}

// ── Baseline / anomaly alerting ───────────────────────────────
// Raise/resolve alerts from the intelligence engine's active anomalies (deviation
// from each metric's learned baseline). Opt-in via anomaly_alerts_enabled.
const ANOMALY_LABELS = { response_ms: 'Response time', cpu_pct: 'CPU', mem_pct: 'Memory' };
async function evaluateAnomalyAlerts() {
  if (String(setting('anomaly_alerts_enabled', 'false')).toLowerCase() !== 'true') return;
  try {
    const active = (await sv.query(`
      SELECT a.device_id, a.metric, a.severity, a.value, a.baseline_mean, a.z_score,
             d.name, d.site_id, d.ip_address
        FROM device_anomalies a
        JOIN monitored_devices d ON d.id = a.device_id
       WHERE a.status = 'active'`)).rows;
    const live = new Set();
    for (const row of active) {
      const alertType = `anomaly_${row.metric}`;
      live.add(`${row.device_id}:${alertType}`);
      const device = { id: row.device_id, name: row.name, site_id: row.site_id, ip_address: row.ip_address };
      const label = ANOMALY_LABELS[row.metric] || row.metric;
      const r1 = (v) => Math.round(Number(v) * 10) / 10;
      await raiseAlert(device, alertType, row.severity || 'warning',
        `Anomaly: ${label} on ${row.name} is ${r1(row.value)} (baseline ~${r1(row.baseline_mean)}, z=${r1(row.z_score)})`,
        Number(row.value));
    }
    const open = (await sv.query(
      `SELECT device_id, alert_type FROM alerts WHERE status='active' AND alert_type LIKE 'anomaly%'`)).rows;
    for (const al of open) {
      if (!live.has(`${al.device_id}:${al.alert_type}`)) await resolveAlert(al.device_id, al.alert_type);
    }
  } catch (e) {
    console.error('[anomaly] alert eval failed:', e.message);
  }
}

// ── Wireless alerting ─────────────────────────────────────────
// Wireless APs/controllers live in their own tables (not monitored_devices), so
// the device alert paths never touch them. This pass raises/resolves alerts for
// AP down, controller offline, high channel utilization, and AP reboots/flaps.
const wirelessApUptime = new Map(); // ap_id → last seen uptime_seconds (flap detection)

async function raiseWirelessAlert(idCol, entity, alertType, severity, message) {
  try {
    const r = await sv.query(
      `INSERT INTO alerts (${idCol}, alert_type, severity, message, status)
       VALUES ($1,$2,$3,$4,'active')
       ON CONFLICT (${idCol}, alert_type) WHERE status = 'active' AND ${idCol} IS NOT NULL DO NOTHING
       RETURNING id`,
      [entity.id, alertType, severity, message]);
    if (r.rows[0]) {
      log(`[alert] RAISED ${alertType} on ${entity.name}`);
      const to = await recipientsFor(entity.site_id, severity, alertType);
      if (to) await sendAlertEmail(`[SpanVault] ${severity.toUpperCase()}: ${message}`, message, to);
    }
  } catch (e) { console.error('[wireless-alert] raise failed:', e.message); }
}
async function resolveWirelessAlert(idCol, id, alertType) {
  try {
    await sv.query(
      `UPDATE alerts SET status='resolved', resolved_at=NOW()
        WHERE ${idCol}=$1 AND alert_type=$2 AND status <> 'resolved'`, [id, alertType]);
  } catch (e) { console.error('[wireless-alert] resolve failed:', e.message); }
}

// Two-tier (warning/critical) checks can't just call raiseWirelessAlert directly
// when conditions cross from one tier to the other: idx_alerts_active_wap_unique/
// idx_alerts_active_wctl_unique enforce one ACTIVE row per (id, alert_type), so
// re-raising the SAME alert_type at a NEW severity while the old-severity row is
// still active hits ON CONFLICT ... DO NOTHING and silently never escalates (or
// de-escalates). Resolve any existing active alert of this type at a DIFFERENT
// severity first, then raise fresh so the insert isn't blocked by its own stale row.
async function raiseWirelessAlertWithSeverityChange(idCol, entity, alertType, severity, message) {
  try {
    const existing = await sv.query(
      `SELECT severity FROM alerts WHERE ${idCol} = $1 AND alert_type = $2 AND status = 'active'`,
      [entity.id, alertType]);
    if (existing.rows[0] && existing.rows[0].severity !== severity) {
      await resolveWirelessAlert(idCol, entity.id, alertType);
    }
  } catch (e) { console.error('[wireless-alert] severity-change check failed:', e.message); }
  await raiseWirelessAlert(idCol, entity, alertType, severity, message);
}

// Sustained-high-bandwidth client alerts (wireless_client_bandwidth_high) are
// a hardcoded-threshold check, deliberately NOT a user-configurable alert_rule
// like the device/service rule engine (getEffectiveRules/getEffectiveServiceRules
// below) — a wireless_clients row is a live 15-min snapshot with a fresh SERIAL
// id on every reconnect, not the stable permanent entity that engine is built
// for. This mirrors wireless_ap_down/wireless_high_util above instead.
//
// A wireless client has no single stable id column the way an AP/controller
// does, so it can't reuse raiseWirelessAlert/resolveWirelessAlert's single-
// idCol shape — it's keyed by the composite (mac_address, controller_id)
// identity already established by wireless_client_events/wireless_client_history
// (see scripts/schema.sql's wireless_client_mac/wireless_controller_id columns
// and idx_alerts_active_wclient_unique). The actual threshold check + the
// consecutive-poll debounce live in wirelessCollector.js's pollClients(); these
// two functions are injected into it as `alertHooks` via startWirelessCollector()
// below (not required back into this module) to avoid a require() cycle between
// collector.js and wirelessCollector.js (collector.js already requires
// wirelessCollector.js at the top of the file).
async function raiseClientBandwidthAlert(mac, controllerId, siteId, message) {
  try {
    const r = await sv.query(
      `INSERT INTO alerts (wireless_client_mac, wireless_controller_id, alert_type, severity, message, status)
       VALUES ($1,$2,'wireless_client_bandwidth_high','warning',$3,'active')
       ON CONFLICT (wireless_client_mac, wireless_controller_id, alert_type)
         WHERE status = 'active' AND wireless_client_mac IS NOT NULL DO NOTHING
       RETURNING id`,
      [mac, controllerId, message]);
    if (r.rows[0]) {
      log(`[alert] RAISED wireless_client_bandwidth_high on ${mac}`);
      const to = await recipientsFor(siteId, 'warning', 'wireless_client_bandwidth_high');
      if (to) await sendAlertEmail(`[SpanVault] WARNING: ${message}`, message, to);
    }
  } catch (e) { console.error('[wireless-alert] raise client bandwidth failed:', e.message); }
}
async function resolveClientBandwidthAlert(mac, controllerId) {
  try {
    await sv.query(
      `UPDATE alerts SET status='resolved', resolved_at=NOW()
        WHERE wireless_client_mac=$1 AND wireless_controller_id=$2
          AND alert_type='wireless_client_bandwidth_high' AND status <> 'resolved'`,
      [mac, controllerId]);
  } catch (e) { console.error('[wireless-alert] resolve client bandwidth failed:', e.message); }
}

async function evaluateWirelessAlerts() {
  try {
    // Rolling-window RF checks (utilization/retry/interference/noise floor) all
    // read wireless_history over the same trailing window — one setting shared
    // across them keeps this simple (a separate window per metric would just be
    // more knobs nobody will individually tune).
    const utilWindowMinutes = settingInt('wireless_util_window_minutes', 15);
    const utilWarnPct = settingInt('wireless_util_warn_pct', 65);
    const utilCritPct = settingInt('wireless_util_crit_pct', 85);
    const retryThresholdPct = settingInt('wireless_retry_threshold_pct', 15);
    const imbalanceMinClients = settingInt('wireless_imbalance_min_clients', 15);
    const imbalanceRatioPct = settingInt('wireless_imbalance_ratio_pct', 90);
    const interferenceThresholdPct = settingInt('wireless_interference_threshold_pct', 30);
    // Noise floor is negative dBm — LESS negative (closer to 0) is WORSE, so
    // "degraded" means the average is >= this threshold (e.g. -80 is worse than
    // -95). Don't flip this to LEAST like a normal "high value is bad" check.
    const noiseFloorThresholdDbm = settingInt('wireless_noise_floor_threshold_dbm', -85);
    const roamStormCount = settingInt('wireless_roam_storm_count', 15);
    const roamStormWindowMinutes = settingInt('wireless_roam_storm_window_minutes', 10);
    // Controllers — offline when the last poll errored.
    const ctrls = (await sv.query(
      `SELECT id, name, status, site_id, vendor, last_error FROM wireless_controllers WHERE active = TRUE`)).rows;
    for (const c of ctrls) {
      if (c.status === 'error') {
        await raiseWirelessAlert('wireless_controller_id', c, 'wireless_controller_down', 'critical',
          `Wireless controller ${c.name} is unreachable`);
      } else if (c.status === 'ok') {
        await resolveWirelessAlert('wireless_controller_id', c.id, 'wireless_controller_down');
      }
      // API vendors with a rotating OAuth2 credential (currently just
      // aruba_central — see the CLAUDE.md testController note) can fail in a
      // way wireless_controller_down's generic "unreachable" message hides:
      // Central confirming the stored refresh_token itself is dead (HTTP 4xx
      // from the /oauth2/token call, not a timeout/network/5xx that might
      // self-resolve next poll). That needs a human to re-authorize in
      // Central's UI, not a firewall/connectivity check — a materially
      // different remediation, so it gets its own alert type layered on top
      // of (not replacing) wireless_controller_down. No new plumbing: the
      // full, already-redacted error message (see aruba-central.js's
      // fetchJsonVerbose) is already persisted to last_error by
      // wirelessCollector.js's pollController() on every failed poll — this
      // just classifies what's already stored. If a future API vendor gains
      // its own rotating credential, extend this same match rather than
      // adding a parallel per-vendor alert type.
      const tokenDead = c.vendor === 'aruba_central' && typeof c.last_error === 'string' &&
        c.last_error.startsWith('aruba_central: token refresh') && /HTTP 4\d\d/.test(c.last_error);
      if (tokenDead) {
        await raiseWirelessAlert('wireless_controller_id', c, 'wireless_api_token_invalid', 'critical',
          `Wireless controller ${c.name}'s Aruba Central API credential was rejected — re-authorize the integration in Central's UI (${c.last_error})`);
      } else if (c.status === 'ok') {
        await resolveWirelessAlert('wireless_controller_id', c.id, 'wireless_api_token_invalid');
      }
    }
    // APs — down / reboot / rolling-window RF health / structural imbalance.
    const aps = (await sv.query(`
      SELECT a.id, a.name, a.status, a.site_id, a.uptime_seconds,
             a.clients_2g, a.clients_5g, a.clients_6g, a.clients_total,
             a.radio_2g_channel, a.radio_5g_channel, a.radio_6g_channel
        FROM wireless_aps a
        JOIN wireless_controllers c ON c.id = a.controller_id AND c.active = TRUE`)).rows;
    const apsById = new Map(aps.map(a => [a.id, a]));

    // One grouped query covers the utilization/retry/interference/noise-floor
    // checks together (all read the same wireless_history rows over the same
    // window) — far cheaper than a separate round trip per metric. Isolated in
    // its own try/catch so a missing/un-migrated wireless_history table doesn't
    // take out reboot/imbalance/roam-storm checks below, matching the rogue-AP
    // block's "missing table on un-migrated DB — ignore" pattern.
    const historyAggByAp = new Map();
    try {
      const hr = await sv.query(
        `SELECT ap_id,
                AVG(radio_2g_util) AS avg_util_2g, AVG(radio_5g_util) AS avg_util_5g,
                AVG(retry_rate_2g) AS avg_retry_2g, AVG(retry_rate_5g) AS avg_retry_5g,
                AVG(interference_pct_2g) AS avg_intf_2g, AVG(interference_pct_5g) AS avg_intf_5g,
                AVG(noise_floor_2g) AS avg_noise_2g, AVG(noise_floor_5g) AS avg_noise_5g
           FROM wireless_history
          WHERE ts >= NOW() - make_interval(mins => $1)
          GROUP BY ap_id`, [utilWindowMinutes]);
      for (const row of hr.rows) historyAggByAp.set(row.ap_id, row);
    } catch (e) { console.error('[wireless-alert] rolling-window history query failed:', e.message); }

    for (const ap of aps) {
      if (ap.status === 'offline') {
        await raiseWirelessAlert('wireless_ap_id', ap, 'wireless_ap_down', 'critical',
          `Access point ${ap.name} is offline`);
      } else if (ap.status === 'online') {
        await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_ap_down');

        const agg = historyAggByAp.get(ap.id);

        // 1. Tiered rolling-window utilization (replaces the old single-poll
        // snapshot check — a burst that only lands on 1-2 of the ~3 polls in the
        // window used to slip under a single-poll threshold entirely).
        const avgUtil2g = agg ? Number(agg.avg_util_2g) || 0 : 0;
        const avgUtil5g = agg ? Number(agg.avg_util_5g) || 0 : 0;
        const util = Math.max(avgUtil2g, avgUtil5g);
        if (util >= utilCritPct) {
          await raiseWirelessAlertWithSeverityChange('wireless_ap_id', ap, 'wireless_high_util', 'critical',
            `Access point ${ap.name} channel utilization averaged ${Math.round(util)}% over the last ${utilWindowMinutes} min (>= ${utilCritPct}% critical)`);
        } else if (util >= utilWarnPct) {
          await raiseWirelessAlertWithSeverityChange('wireless_ap_id', ap, 'wireless_high_util', 'warning',
            `Access point ${ap.name} channel utilization averaged ${Math.round(util)}% over the last ${utilWindowMinutes} min (>= ${utilWarnPct}% warning)`);
        } else {
          await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_high_util');
        }

        // 2. Sustained high retry rate — contention/interference symptom that a
        // single-poll utilization check can't see at all.
        const avgRetry2g = agg ? Number(agg.avg_retry_2g) || 0 : 0;
        const avgRetry5g = agg ? Number(agg.avg_retry_5g) || 0 : 0;
        const retry = Math.max(avgRetry2g, avgRetry5g);
        if (retry >= retryThresholdPct) {
          await raiseWirelessAlert('wireless_ap_id', ap, 'wireless_high_retry', 'warning',
            `Access point ${ap.name} frame retry rate averaged ${Math.round(retry)}% over the last ${utilWindowMinutes} min (>= ${retryThresholdPct}% — possible contention/interference)`);
        } else {
          await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_high_retry');
        }

        // 3. Per-radio client imbalance — a live structural snapshot, not a
        // rolling window. Only bands the AP actually has active (channel not
        // null) count as "in play", so a single-radio AP (e.g. 2.4GHz-only) is
        // never flagged just for having 0 clients on a radio it doesn't have.
        const bandClients = [];
        if (ap.radio_2g_channel != null) bandClients.push(Number(ap.clients_2g) || 0);
        if (ap.radio_5g_channel != null) bandClients.push(Number(ap.clients_5g) || 0);
        if (ap.radio_6g_channel != null) bandClients.push(Number(ap.clients_6g) || 0);
        const clientsTotal = Number(ap.clients_total) || 0;
        let imbalanced = false;
        if (bandClients.length >= 2 && clientsTotal >= imbalanceMinClients) {
          const dominant = Math.max(...bandClients);
          const pct = Math.round((dominant / clientsTotal) * 100);
          if (pct >= imbalanceRatioPct) {
            imbalanced = true;
            await raiseWirelessAlert('wireless_ap_id', ap, 'wireless_client_imbalance', 'warning',
              `Access point ${ap.name} has ${dominant} of ${clientsTotal} clients (${pct}%) on a single radio band while its other radio(s) sit idle — capacity/band-steering imbalance`);
          }
        }
        if (!imbalanced) await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_client_imbalance');

        // 4a. RF interference — missing telemetry (old firmware, no OID) reads
        // as NULL, safely treated as 0% here (same as the utilization/retry
        // fallback above — "no data" should never itself look alarming).
        const avgIntf2g = agg ? Number(agg.avg_intf_2g) || 0 : 0;
        const avgIntf5g = agg ? Number(agg.avg_intf_5g) || 0 : 0;
        const interference = Math.max(avgIntf2g, avgIntf5g);
        if (interference >= interferenceThresholdPct) {
          await raiseWirelessAlert('wireless_ap_id', ap, 'wireless_high_interference', 'warning',
            `Access point ${ap.name} RF interference averaged ${Math.round(interference)}% over the last ${utilWindowMinutes} min (>= ${interferenceThresholdPct}%)`);
        } else {
          await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_high_interference');
        }

        // 4b. Noise floor degradation — unlike the metrics above, NULL must NOT
        // default to 0 here: 0 dBm reads as catastrophically WORSE than a
        // missing-telemetry AP's true (unknown) floor, since less-negative is
        // worse. An AP with no noise-floor data at all is simply skipped/resolved
        // rather than treated as a 0 dBm reading.
        const noise2g = agg && agg.avg_noise_2g != null ? Number(agg.avg_noise_2g) : null;
        const noise5g = agg && agg.avg_noise_5g != null ? Number(agg.avg_noise_5g) : null;
        if (noise2g != null || noise5g != null) {
          const noise = Math.max(
            noise2g != null ? noise2g : -Infinity,
            noise5g != null ? noise5g : -Infinity);
          if (noise >= noiseFloorThresholdDbm) {
            await raiseWirelessAlert('wireless_ap_id', ap, 'wireless_degraded_noise_floor', 'warning',
              `Access point ${ap.name} noise floor averaged ${Math.round(noise)} dBm over the last ${utilWindowMinutes} min (>= ${noiseFloorThresholdDbm} dBm — degraded RF environment)`);
          } else {
            await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_degraded_noise_floor');
          }
        } else {
          await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_degraded_noise_floor');
        }
      }
      // Reboot/flap: uptime went backwards since we last saw it.
      const up = ap.uptime_seconds != null ? Number(ap.uptime_seconds) : null;
      if (up != null) {
        const prev = wirelessApUptime.get(ap.id);
        if (prev != null && up < prev - 60) {
          await raiseWirelessAlert('wireless_ap_id', ap, 'wireless_ap_rebooted', 'warning',
            `Access point ${ap.name} rebooted (uptime reset)`);
        } else if (up > 7200) {
          // Stable for >2h — clear any lingering reboot flag.
          await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_ap_rebooted');
        }
        wirelessApUptime.set(ap.id, up);
      }
    }

    // 5. Roam/disconnect storm — count roams landing on each AP in the last
    // window (HAVING filters to APs at/over the threshold in SQL rather than in
    // JS). Isolated in its own try/catch like the history query above, since
    // wireless_client_events is a separate table with its own migration history.
    const roamStormApIds = new Set();
    try {
      const rr = await sv.query(
        `SELECT to_ap_id, COUNT(*) AS c
           FROM wireless_client_events
          WHERE event_type = 'roam' AND to_ap_id IS NOT NULL
            AND ts >= NOW() - make_interval(mins => $1)
          GROUP BY to_ap_id
         HAVING COUNT(*) >= $2`, [roamStormWindowMinutes, roamStormCount]);
      for (const row of rr.rows) {
        const ap = apsById.get(row.to_ap_id);
        if (!ap) continue;
        roamStormApIds.add(ap.id);
        await raiseWirelessAlert('wireless_ap_id', ap, 'wireless_roam_storm', 'warning',
          `Access point ${ap.name} saw ${row.c} client roams in the last ${roamStormWindowMinutes} min (>= ${roamStormCount}) — possible sticky-client/roaming thrash`);
      }
    } catch (e) { console.error('[wireless-alert] roam storm query failed:', e.message); }
    for (const ap of aps) {
      if (ap.status === 'online' && !roamStormApIds.has(ap.id)) {
        await resolveWirelessAlert('wireless_ap_id', ap.id, 'wireless_roam_storm');
      }
    }

    // Rogue AP detection (opt-in via setting). For each active controller, count
    // rogue/malicious detections seen in the last hour; raise a warning when any
    // are present, otherwise resolve. Uses the controller rows already loaded.
    if (String(setting('wireless_rogue_alerts_enabled', 'false')).toLowerCase() === 'true') {
      for (const c of ctrls) {
        try {
          const rc = await sv.query(
            `SELECT COUNT(*)::int AS c FROM wireless_rogue_aps
              WHERE controller_id = $1 AND last_seen_at >= NOW() - INTERVAL '1 hour'
                AND classification IN ('rogue','malicious')`,
            [c.id]);
          const count = rc.rows[0] ? rc.rows[0].c : 0;
          if (count > 0) {
            await raiseWirelessAlert('wireless_controller_id', c, 'wireless_rogue_detected', 'warning',
              `${count} rogue AP(s) detected near controller ${c.name}`);
          } else {
            await resolveWirelessAlert('wireless_controller_id', c.id, 'wireless_rogue_detected');
          }
        } catch (_e) { /* missing table on un-migrated DB — ignore */ }
      }
    }
  } catch (err) {
    if (!/wireless_aps|wireless_controllers/.test(err.message)) {
      console.error('[wireless-alert] tick failed:', err.message);
    }
  }
}

// ── Data retention / rollups ──────────────────────────────────
// Roll raw ping samples up to daily availability_summary, then purge raw samples
// (ping/snmp/service) and old rollups/audit beyond configurable windows so the
// time-series tables don't grow without bound. 0 days = keep forever.
async function retentionTick() {
  try {
    const rawDays = settingInt('retention_raw_days', 14);
    const rollupDays = settingInt('retention_rollup_days', 730);
    const auditDays = settingInt('retention_audit_days', 365);

    // 1. Daily availability rollup from ping_results (idempotent upsert).
    await sv.query(`
      INSERT INTO availability_summary
        (device_id, date, uptime_pct, avg_response_ms, min_response_ms, max_response_ms, total_checks, failed_checks)
      SELECT device_id, ts::date,
             100.0 * SUM(CASE WHEN status <> 'down' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
             AVG(response_ms) FILTER (WHERE status <> 'down'),
             MIN(response_ms) FILTER (WHERE status <> 'down'),
             MAX(response_ms) FILTER (WHERE status <> 'down'),
             COUNT(*), SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END)
        FROM ping_results
       WHERE ts >= NOW() - make_interval(days => $1)
       GROUP BY device_id, ts::date
      ON CONFLICT (device_id, date) DO UPDATE SET
        uptime_pct = EXCLUDED.uptime_pct, avg_response_ms = EXCLUDED.avg_response_ms,
        min_response_ms = EXCLUDED.min_response_ms, max_response_ms = EXCLUDED.max_response_ms,
        total_checks = EXCLUDED.total_checks, failed_checks = EXCLUDED.failed_checks
    `, [rawDays > 0 ? rawDays + 1 : 3650]);

    // 2. Purge raw samples older than the retention window.
    if (rawDays > 0) {
      const p1 = await sv.query(`DELETE FROM ping_results WHERE ts < NOW() - make_interval(days => $1)`, [rawDays]);
      const p2 = await sv.query(`DELETE FROM snmp_results WHERE ts < NOW() - make_interval(days => $1)`, [rawDays]);
      try { await sv.query(`DELETE FROM service_check_results WHERE ts < NOW() - make_interval(days => $1)`, [rawDays]); } catch (_e) { /* table optional */ }
      log(`[retention] purged ${p1.rowCount} ping + ${p2.rowCount} snmp sample(s) older than ${rawDays}d`);
    }

    // 3. Purge old rollups + audit entries.
    if (rollupDays > 0) await sv.query(`DELETE FROM availability_summary WHERE date < CURRENT_DATE - $1::int`, [rollupDays]);
    if (auditDays > 0) {
      try { await sv.query(`DELETE FROM audit_log WHERE ts < NOW() - make_interval(days => $1)`, [auditDays]); } catch (_e) { /* table optional */ }
    }
  } catch (err) {
    console.error('[retention] tick failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// Schedulers
// ══════════════════════════════════════════════════════════════
async function getActiveDevices() {
  // Only poll devices owned locally — agent_id IS NOT NULL devices are polled by
  // their remote agent, which ships results straight to the server.
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE active = TRUE AND agent_id IS NULL`);
  return r.rows;
}

let pingBusy = false;
async function pingTick() {
  if (pingBusy) return;
  pingBusy = true;
  try {
    // Refresh dependency-based suppression before evaluating alerts this cycle.
    await runSuppressionPass();
    const devices = await getActiveDevices();
    const defaultInterval = settingInt('icmp_poll_interval_seconds', 300);
    const now = Date.now();
    const due = devices.filter((d) => {
      const iv = (d.poll_interval_seconds || defaultInterval) * 1000;
      if (!d.last_checked_at) return true;
      return now - new Date(d.last_checked_at).getTime() >= iv - 1000;
    });
    // Bound concurrency to avoid hammering the host.
    await runPooled(due, 20, (d) => pingDevice(d).catch((e) =>
      console.error(`[ping] ${d.name} failed:`, e.message)));
    if (due.length) log(`[ping] checked ${due.length} device(s)`);
    // Evaluate agent-polled devices from their stored state every tick, even
    // when there are no local devices due.
    await evaluateAgentDevices();
  } catch (err) {
    console.error('[ping] tick failed:', err.message);
  } finally {
    pingBusy = false;
  }
}

let snmpBusy = false;
let lastSnmpRun = 0;
async function snmpTick() {
  if (snmpBusy) return;
  const interval = settingInt('snmp_poll_interval_seconds', 300) * 1000;
  if (Date.now() - lastSnmpRun < interval - 1000) return;
  snmpBusy = true;
  lastSnmpRun = Date.now();
  try {
    const devices = (await getActiveDevices()).filter((d) => d.snmp_enabled);
    await runPooled(devices, 10, (d) => snmpPollDevice(d).catch((e) =>
      console.error(`[snmp] ${d.name} failed:`, e.message)));
    if (devices.length) log(`[snmp] polled ${devices.length} device(s)`);
  } catch (err) {
    console.error('[snmp] tick failed:', err.message);
  } finally {
    snmpBusy = false;
  }
}

// ══════════════════════════════════════════════════════════════
// Topology discovery (LLDP / CDP)
// ══════════════════════════════════════════════════════════════
// Walks every locally-polled SNMP device's LLDP/CDP neighbor tables and stores
// the links directly in topology_links. Topology changes infrequently, so this
// runs once shortly after startup and then every 6 hours.
let topoBusy = false;
async function topologyTick() {
  if (topoBusy) return;
  topoBusy = true;
  try {
    const devices = (await getActiveDevices()).filter((d) => d.snmp_enabled);
    let links = 0;
    for (const d of devices) {
      try {
        links += await discoverAndStore(sv, d);
      } catch (e) {
        console.error(`[topology] ${d.name} failed:`, e.message);
      }
    }
    if (devices.length) {
      log(`[topology] discovered ${links} link(s) across ${devices.length} SNMP device(s)`);
    }
  } catch (err) {
    console.error('[topology] tick failed:', err.message);
  } finally {
    topoBusy = false;
  }
}

// Simple bounded-concurrency runner.
async function runPooled(items, limit, fn) {
  const queue = items.slice();
  const workers = [];
  for (let i = 0; i < Math.min(limit, queue.length); i++) {
    workers.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        await fn(item);
      }
    })());
  }
  await Promise.all(workers);
}

// ══════════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════════
async function main() {
  log('SpanVault collector starting…');
  await loadSettings();

  // Stamp liveness immediately, then keep it fresh every 30s regardless of
  // whether there are any devices to poll.
  await writeHeartbeat();
  setInterval(writeHeartbeat, 30 * 1000);

  await syncNetVaultDevices();

  // Reload settings periodically so UI changes take effect.
  setInterval(loadSettings, 60 * 1000);

  // NetVault metadata sync.
  const syncMs = settingInt('netvault_sync_minutes', 30) * 60 * 1000;
  setInterval(syncNetVaultDevices, syncMs);

  // Poll scheduler ticks. The due-check inside honors per-device intervals.
  setInterval(pingTick, 15 * 1000);
  setInterval(snmpTick, 15 * 1000);

  // Alert escalation sweep — every minute.
  setInterval(escalationTick, 60 * 1000);

  // Baseline/anomaly → alert sweep — every minute (opt-in).
  setInterval(evaluateAnomalyAlerts, 60 * 1000);

  // Wireless alert sweep (AP/controller down, high util, reboots) — every minute.
  setInterval(evaluateWirelessAlerts, 60 * 1000);

  // Data retention / rollup — shortly after startup, then every 12 hours.
  setTimeout(retentionTick, 90 * 1000);
  setInterval(retentionTick, 12 * 60 * 60 * 1000);

  // Agentless service checks (HTTP/TCP/SSL/DNS). The due-check inside honors
  // each check's interval_seconds; alert evaluation runs for central + agent
  // checks every tick.
  setInterval(serviceCheckTick, 15 * 1000);

  // Topology discovery — once shortly after startup, then every 6 hours.
  setTimeout(topologyTick, 60 * 1000);
  setInterval(topologyTick, 6 * 60 * 60 * 1000);

  // Wireless controller polling (SNMP + API) on its own 5-minute cadence.
  // The alertHooks object is how pollClients() (in wirelessCollector.js) raises/
  // resolves wireless_client_bandwidth_high without requiring collector.js back
  // (see the comment on raiseClientBandwidthAlert above).
  startWirelessCollector(sv, { raise: raiseClientBandwidthAlert, resolve: resolveClientBandwidthAlert });

  // Kick off an immediate first pass.
  pingTick();
  setTimeout(snmpTick, 5 * 1000);

  log('SpanVault collector running.');
}

main().catch((err) => {
  console.error('[FATAL] collector main failed:', err.message, err.stack);
  process.exit(1);
});

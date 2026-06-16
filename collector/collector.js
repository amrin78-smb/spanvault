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

const { Pool }   = require('pg');
const ping       = require('ping');
const nodemailer = require('nodemailer');
const { detectVendor } = require('./parsers');
const { createSession, get, OID } = require('./snmp-session');
const { collectCandidates } = require('./discovery');
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
    const r = await nv.query(`
      SELECT d.id AS netvault_device_id, d.name, host(d.ip_address) AS ip_address,
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
  try {
    await sv.query(`
      UPDATE monitored_devices d
         SET agent_id = sub.agent_id, updated_at = NOW()
        FROM (SELECT DISTINCT ON (site_id) site_id, agent_id
                FROM agent_sites ORDER BY site_id, agent_id) sub
       WHERE d.site_id = sub.site_id AND d.agent_id IS DISTINCT FROM sub.agent_id
    `);
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
  const inMaint = await inMaintenance(device.id);
  if (newStatus === 'down' && !inMaint) {
    await raiseAlert(device, 'device_down', 'critical',
      await buildDeviceDownMessage(device), null);
  } else if (newStatus !== 'down') {
    const wasDown = await resolveAlert(device.id, 'device_down');
    if (wasDown) await deviceRecoveryEvent(device, timeMs);
  }

  if (alive && timeMs !== null && timeMs > threshold && !inMaint) {
    await raiseAlert(device, 'high_latency', 'warning',
      await buildHighLatencyMessage(device, timeMs), timeMs);
  } else if (alive && (timeMs === null || timeMs <= threshold)) {
    await resolveAlert(device.id, 'high_latency');
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
    // ── Vendor detection — fetch sysDescr, pick a parser ──────────
    const sysDescrRows = await get(session, [OID.sysDescr]);
    const sysDescr = sysDescrRows.length ? String(sysDescrRows[0].value) : '';
    vendor = detectVendor(sysDescr);
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

  // Map candidates → rows to persist.
  let samples;
  if (sensors.length) {
    // Selective: keep only enabled sensors, write with the sensor's metric_name.
    const byKey = new Map(sensors.map((s) => [s.sensor_key, s]));
    samples = [];
    for (const c of candidates) {
      const sensor = byKey.get(c.key);
      if (!sensor) continue;
      samples.push({
        metric_name: sensor.metric_name, value: c.value, oid: c.oid,
        if_index: c.if_index, if_name: c.if_name,
      });
    }
  } else {
    // Backward-compatible: write the standard shared metric_names.
    samples = candidates.map((c) => ({
      metric_name: c.std_metric, value: c.value, oid: c.oid,
      if_index: c.if_index, if_name: c.if_name,
    }));
  }

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
  if (await inMaintenance(device.id)) return;

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

  await evaluateEffectiveRules(device, {
    cpu_pct: latest.cpu_pct !== undefined ? latest.cpu_pct : null,
    mem_pct: latest.mem_pct !== undefined ? latest.mem_pct : null,
    interface_down: interfaceDown,
    snmp_no_data: snmpNoDataMin,
    bandwidth_pct: null, // interface capacity not tracked yet — reserved
  });
}

// ── Maintenance suppression ───────────────────────────────────
async function inMaintenance(deviceId) {
  try {
    const r = await sv.query(`
      SELECT 1 FROM maintenance_windows
       WHERE (device_id = $1 OR device_id IS NULL)
         AND starts_at <= NOW() AND ends_at >= NOW()
       LIMIT 1
    `, [deviceId]);
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
      await sendAlertEmail(`[SpanVault] ${severity.toUpperCase()}: ${message}`, message);
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
      await sendAlertEmail(`[SpanVault] CRITICAL: ${message}`, message);
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

  const inMaint = await inMaintenance(device.id);

  // Reachability.
  if (newStatus === 'down' && !inMaint) {
    await raiseAlert(device, 'device_down', 'critical',
      await buildDeviceDownMessage(device), null);
  } else if (newStatus !== 'down') {
    await resolveAlert(device.id, 'device_down');
  }

  // Latency.
  const alive = (newStatus === 'up' || newStatus === 'warning');
  if (alive && timeMs !== null && timeMs > threshold && !inMaint) {
    await raiseAlert(device, 'high_latency', 'warning',
      await buildHighLatencyMessage(device, timeMs), timeMs);
  } else if (alive && (timeMs === null || timeMs <= threshold)) {
    await resolveAlert(device.id, 'high_latency');
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
  if (await inMaintenance(device.id)) return;
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
      if (wasActive && rule.notify_recovery) await recoveryEvent(device, rule);
    }
  }
}

// ── Email notifications ───────────────────────────────────────
async function sendAlertEmail(subject, body) {
  if (!settingBool('email_alerts_enabled')) return;
  const host = setting('smtp_host', '');
  const to = setting('alert_email_to', '');
  if (!host || !to) return;
  try {
    const transport = nodemailer.createTransport({
      host,
      port: settingInt('smtp_port', 587),
      secure: settingInt('smtp_port', 587) === 465,
      auth: setting('smtp_user', '') ? { user: setting('smtp_user', ''), pass: setting('smtp_pass', '') } : undefined,
    });
    await transport.sendMail({
      from: setting('smtp_from', '') || setting('smtp_user', 'spanvault@localhost'),
      to,
      subject,
      text: body,
    });
  } catch (err) {
    console.error('[email] send failed:', err.message);
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

  // Topology discovery — once shortly after startup, then every 6 hours.
  setTimeout(topologyTick, 60 * 1000);
  setInterval(topologyTick, 6 * 60 * 60 * 1000);

  // Wireless controller polling (SNMP + API) on its own 5-minute cadence.
  startWirelessCollector(sv);

  // Kick off an immediate first pass.
  pingTick();
  setTimeout(snmpTick, 5 * 1000);

  log('SpanVault collector running.');
}

main().catch((err) => {
  console.error('[FATAL] collector main failed:', err.message, err.stack);
  process.exit(1);
});

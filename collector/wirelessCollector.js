'use strict';

/**
 * wirelessCollector.js — polls wireless controllers (SNMP or vendor HTTP API)
 * and upserts their access points + a time-series sample into the DB.
 *
 * Imported and started from collector/collector.js. Wireless polling is SEPARATE
 * from the per-device SNMP polling in collector.js: it uses controller/AP OID
 * sets (or REST APIs) and writes wireless_aps / wireless_history (never
 * snmp_results). Plain JavaScript only — no TypeScript syntax.
 *
 * Failure handling: a controller that is unreachable is logged and marked
 * status='error'; existing AP records are kept (only last_seen is left as-is).
 * Credentials (snmp_community, api_*) are never logged.
 */

const { createSession, walk } = require('./snmp-session');
const { getWirelessParser, wirelessVendorFor } = require('./wireless');

// Vendor HTTP API clients (controller_url based).
const apiClients = {
  grandstream: require('./wireless/api/grandstream'),
  ubiquiti:    require('./wireless/api/ubiquiti'),
  omada:       require('./wireless/api/omada'),
};

const log = (...a) => console.log(`[${new Date().toISOString()}] [wireless]`, ...a);

// ── SNMP polling ──────────────────────────────────────────────
// Walk every OID a parser declares and group varbinds by the parser's logical
// key → { key: [ { oid, value } ... ] }, exactly what parseApTable() expects.
async function walkParserOids(session, parser) {
  const walked = {};
  for (const key of Object.keys(parser.snmpOids)) {
    walked[key] = await walk(session, parser.snmpOids[key]);
  }
  return walked;
}

async function pollSnmpController(pool, controller) {
  const dq = await pool.query(`SELECT * FROM monitored_devices WHERE id = $1`, [controller.snmp_device_id]);
  const device = dq.rows[0];
  if (!device) throw new Error('linked SNMP device not found');

  // Prefer the controller's declared vendor; fall back to the device's detected
  // vendor mapped onto a wireless parser key.
  let parser = getWirelessParser(controller.vendor);
  if (!parser && device.device_vendor) {
    parser = getWirelessParser(wirelessVendorFor(device.device_vendor));
  }
  if (!parser) throw new Error(`no wireless SNMP parser for vendor "${controller.vendor}"`);

  const session = createSession(device, 10000);
  try {
    const walked = await walkParserOids(session, parser);
    return parser.parseApTable(walked) || [];
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

// ── API polling ───────────────────────────────────────────────
async function pollApiController(controller) {
  const client = apiClients[controller.vendor];
  if (!client) throw new Error(`no wireless API client for vendor "${controller.vendor}"`);
  return (await client.poll(controller)) || [];
}

// ── Persistence ───────────────────────────────────────────────
function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Best-effort link of an AP to a monitored device by IP (so the AP can show on
// device pages). Returns the monitored device id or null.
async function matchMonitoredDevice(pool, ap) {
  if (!ap.ip_address) return null;
  try {
    const r = await pool.query(`SELECT id FROM monitored_devices WHERE ip_address = $1 LIMIT 1`, [ap.ip_address]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (_e) {
    return null;
  }
}

// Upsert one AP (keyed by controller_id + name) and append a history sample.
async function upsertAp(pool, controller, ap) {
  const name = ap.name || ap.mac_address || ap.ip_address || 'AP';
  const monitoredId = await matchMonitoredDevice(pool, ap);
  const clientsTotal = intOrNull(ap.clients_total) || 0;
  const clients2g = intOrNull(ap.clients_2g) || 0;
  const clients5g = intOrNull(ap.clients_5g) || 0;
  const clients6g = intOrNull(ap.clients_6g) || 0;

  const r = await pool.query(`
    INSERT INTO wireless_aps
      (controller_id, monitored_device_id, name, mac_address, model, ip_address,
       site_id, site_name, status, radio_2g_channel, radio_5g_channel, radio_6g_channel,
       radio_2g_util_pct, radio_5g_util_pct, clients_2g, clients_5g, clients_6g, clients_total,
       tx_power_2g, tx_power_5g, uptime_seconds, firmware_version, last_seen_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),NOW())
    ON CONFLICT (controller_id, name) DO UPDATE SET
      monitored_device_id = EXCLUDED.monitored_device_id,
      mac_address      = EXCLUDED.mac_address,
      model            = EXCLUDED.model,
      ip_address       = EXCLUDED.ip_address,
      site_id          = EXCLUDED.site_id,
      site_name        = EXCLUDED.site_name,
      status           = EXCLUDED.status,
      radio_2g_channel = EXCLUDED.radio_2g_channel,
      radio_5g_channel = EXCLUDED.radio_5g_channel,
      radio_6g_channel = EXCLUDED.radio_6g_channel,
      radio_2g_util_pct = EXCLUDED.radio_2g_util_pct,
      radio_5g_util_pct = EXCLUDED.radio_5g_util_pct,
      clients_2g       = EXCLUDED.clients_2g,
      clients_5g       = EXCLUDED.clients_5g,
      clients_6g       = EXCLUDED.clients_6g,
      clients_total    = EXCLUDED.clients_total,
      tx_power_2g      = EXCLUDED.tx_power_2g,
      tx_power_5g      = EXCLUDED.tx_power_5g,
      uptime_seconds   = EXCLUDED.uptime_seconds,
      firmware_version = EXCLUDED.firmware_version,
      last_seen_at     = NOW(),
      updated_at       = NOW()
    RETURNING id
  `, [
    controller.id, monitoredId, name, ap.mac_address || null, ap.model || null, ap.ip_address || null,
    controller.site_id || null, controller.site_name || null, ap.status || 'unknown',
    intOrNull(ap.radio_2g_channel), intOrNull(ap.radio_5g_channel), intOrNull(ap.radio_6g_channel),
    numOrNull(ap.radio_2g_util_pct), numOrNull(ap.radio_5g_util_pct),
    clients2g, clients5g, clients6g, clientsTotal,
    intOrNull(ap.tx_power_2g), intOrNull(ap.tx_power_5g),
    intOrNull(ap.uptime_seconds), ap.firmware_version || null,
  ]);

  const apId = r.rows[0].id;
  await pool.query(`
    INSERT INTO wireless_history (ap_id, clients_total, clients_2g, clients_5g, radio_2g_util, radio_5g_util)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [apId, clientsTotal, clients2g, clients5g, numOrNull(ap.radio_2g_util_pct), numOrNull(ap.radio_5g_util_pct)]);

  return apId;
}

// ── Auto-detection of SNMP wireless controllers ───────────────
// Any monitored, SNMP-enabled device whose detected vendor maps to a wireless
// parser gets a wireless_controller (snmp_device_id) created once.
async function autoDetectControllers(pool) {
  let created = 0;
  try {
    const r = await pool.query(`
      SELECT id, name, device_vendor, site_id, site_name
      FROM monitored_devices
      WHERE active = TRUE AND snmp_enabled = TRUE AND device_vendor IS NOT NULL
        AND id NOT IN (SELECT snmp_device_id FROM wireless_controllers WHERE snmp_device_id IS NOT NULL)
    `);
    for (const d of r.rows) {
      const wkey = wirelessVendorFor(d.device_vendor);
      if (!wkey) continue;
      const ins = await pool.query(`
        INSERT INTO wireless_controllers (name, vendor, snmp_device_id, site_id, site_name)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (snmp_device_id) WHERE snmp_device_id IS NOT NULL DO NOTHING
        RETURNING id
      `, [`${d.name} (wireless)`, wkey, d.id, d.site_id || null, d.site_name || null]);
      if (ins.rows[0]) created++;
    }
  } catch (err) {
    console.error('[wireless] auto-detect failed:', err.message);
  }
  if (created) log(`auto-created ${created} SNMP wireless controller(s)`);
}

// ── Per-controller poll ───────────────────────────────────────
async function pollController(pool, controller) {
  try {
    let aps = [];
    if (controller.snmp_device_id) {
      aps = await pollSnmpController(pool, controller);
    } else if (controller.controller_url) {
      aps = await pollApiController(controller);
    } else {
      throw new Error('controller has neither an SNMP device nor an API URL');
    }

    for (const ap of aps) {
      try { await upsertAp(pool, controller, ap); }
      catch (e) { console.error(`[wireless] AP upsert failed on ${controller.name}:`, e.message); }
    }

    await pool.query(
      `UPDATE wireless_controllers SET last_polled_at = NOW(), status = 'ok', last_error = NULL WHERE id = $1`,
      [controller.id]);
    log(`polled ${controller.name}: ${aps.length} AP(s)`);
  } catch (e) {
    // Keep existing AP records; just record the failure on the controller.
    try {
      await pool.query(
        `UPDATE wireless_controllers SET last_polled_at = NOW(), status = 'error', last_error = $2 WHERE id = $1`,
        [controller.id, String(e.message).slice(0, 500)]);
    } catch (_e) { /* ignore */ }
    console.error(`[wireless] ${controller.name} poll failed:`, e.message);
  }
}

// ── Poll cycle ────────────────────────────────────────────────
let busy = false;
async function pollAll(pool) {
  if (busy) return;
  busy = true;
  try {
    await autoDetectControllers(pool);
    const r = await pool.query(`SELECT * FROM wireless_controllers WHERE active = TRUE`);
    for (const c of r.rows) {
      await pollController(pool, c);
    }
  } catch (err) {
    console.error('[wireless] poll cycle failed:', err.message);
  } finally {
    busy = false;
  }
}

// Dry-run a controller (no DB writes) for the "Test Connection" button.
async function testController(pool, controller) {
  try {
    let aps = [];
    if (controller.snmp_device_id) aps = await pollSnmpController(pool, controller);
    else if (controller.controller_url) aps = await pollApiController(controller);
    else return { ok: false, message: 'No SNMP device or API URL configured' };
    return { ok: true, message: `Reached controller — ${aps.length} AP(s) found`, ap_count: aps.length };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// Start the wireless collector on a 5-minute cadence (first pass after 20s so
// the initial NetVault sync + vendor detection has a chance to populate).
function startWirelessCollector(pool) {
  setTimeout(() => pollAll(pool), 20 * 1000);
  setInterval(() => pollAll(pool), 5 * 60 * 1000);
  log('wireless collector started (every 5 min)');
}

module.exports = { startWirelessCollector, pollAll, pollController, upsertAp, autoDetectControllers, testController };

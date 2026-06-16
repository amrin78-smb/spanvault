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

const { createSession, walk, get } = require('./snmp-session');
const { getWirelessParser, wirelessVendorFor } = require('./wireless');
const { getClientParser } = require('./wireless/clients');
const { runWirelessIntelligence } = require('./wirelessIntelligence');

// Vendor SNMP metric support matrix (what each parser actually returns):
//   Aruba:        radio channel/util/clients/noise/retry + per-SSID stats
//                 (no byte/error counters, so throughput & rx/tx errors stay NULL)
//   Cisco:        partial (per-SSID clients + traffic, noise floor; retry approx)
//   Ruckus:       full radio metrics (noise, util, throughput) + per-SSID clients
//   MikroTik/HPE/Grandstream: basic only (no radio/SSID stats) — fields stay NULL

// Vendor HTTP API clients (controller_url based).
const apiClients = {
  grandstream: require('./wireless/api/grandstream'),
  ubiquiti:    require('./wireless/api/ubiquiti'),
  omada:       require('./wireless/api/omada'),
};

const log = (...a) => console.log(`[${new Date().toISOString()}] [wireless]`, ...a);

// Coerce a raw SNMP value to text (Buffers → ascii via .toString()); null-safe.
function asStr(val) {
  return val == null ? null : String(val);
}

// Format an SNMP IP value as a dotted quad. A 4-byte Buffer is the canonical
// IpAddress encoding; otherwise fall back to the string form.
function asIp(val) {
  if (val == null) return null;
  if (Buffer.isBuffer(val) && val.length === 4) {
    return `${val[0]}.${val[1]}.${val[2]}.${val[3]}`;
  }
  return String(val);
}

// ── Capability probe (one-time OID discovery) ─────────────────
// Per-vendor candidate OIDs for each controller-metadata capability. Probed ONCE
// per controller; the first OID that returns a real value is stored in the
// controller's `capabilities` JSONB and reused on every subsequent poll (no more
// per-poll guessing). Aruba OIDs are confirmed against live Aruba7205 / ArubaOS
// 8.10.0.8 hardware.
const VENDOR_OID_CANDIDATES = {
  aruba: {
    model:        ['1.3.6.1.4.1.14823.2.2.1.2.1.3.0'],
    firmware:     ['1.3.6.1.4.1.14823.2.2.1.2.1.28.0'],
    licensed_aps: ['1.3.6.1.4.1.14823.2.2.1.2.1.23.0'],
    ha_role:      ['1.3.6.1.4.1.14823.2.2.1.2.1.4.0'],
    ha_peer_name: ['1.3.6.1.4.1.14823.2.2.1.2.1.2.0'],
    ha_sync:      ['1.3.6.1.4.1.14823.2.2.1.2.1.21.0'],
  },
  cisco: {
    model:        ['1.3.6.1.2.1.1.1.0'],
    firmware:     ['1.3.6.1.2.1.1.1.0'],
    licensed_aps: ['1.3.6.1.4.1.14179.1.1.1.18', '1.3.6.1.4.1.14179.1.1.1.19'],
    ha_role:      ['1.3.6.1.4.1.14179.2.6.3.34.0'],
  },
  ruckus:   { model: ['1.3.6.1.2.1.1.1.0'], licensed_aps: ['1.3.6.1.4.1.25053.1.2.2.1.1.1.1.16.0'] },
  mikrotik: { model: ['1.3.6.1.2.1.1.1.0'] },
  hpe:      { model: ['1.3.6.1.2.1.1.1.0'] },
};

// Aruba returns a short model code (e.g. "A7205"); map to the friendly name.
const MODEL_MAP = {
  aruba: { 'A7205': 'Aruba 7205', 'A7210': 'Aruba 7210', 'A7220': 'Aruba 7220', 'A7240': 'Aruba 7240', 'A7280': 'Aruba 7280' },
};
const HA_ROLE_MAP = { '1': 'Active', '2': 'Standby' };
const HA_SYNC_MAP = { '1': 'Synced', '2': 'Not Synced', '3': 'In Progress', '4': 'Standalone' };

// Single non-throwing scalar GET → raw value (or null on any error / varbind
// error / missing row). Used by both the capability probe and metadata polling.
async function getOid(session, oid) {
  const rows = await get(session, [oid]);
  if (!rows || !rows[0]) return null;
  const v = rows[0].value;
  return v == null ? null : v;
}

// One-time capability probe: try each candidate OID per capability for the
// controller's vendor and remember the first OID that returns a real value in
// the controller's `capabilities` JSONB. Never throws.
async function probeControllerCapabilities(pool, controller) {
  const capabilities = {};
  try {
    if (!controller.snmp_device_id) return {};
    const dq = await pool.query('SELECT * FROM monitored_devices WHERE id = $1', [controller.snmp_device_id]);
    const device = dq.rows[0];
    if (!device) return {};

    const vendor = controller.vendor;
    const candidates = VENDOR_OID_CANDIDATES[vendor] || {};
    const capKeys = Object.keys(candidates);

    const session = createSession(device, 10000);
    try {
      for (const cap of capKeys) {
        for (const oid of candidates[cap]) {
          const val = await getOid(session, oid);
          if (val != null) { capabilities[cap] = oid; break; }
        }
      }
    } finally {
      try { session.close(); } catch (_e) { /* ignore */ }
    }

    capabilities.probe_done = true;
    await pool.query(
      'UPDATE wireless_controllers SET capabilities = $2, capabilities_probed_at = NOW() WHERE id = $1',
      [controller.id, capabilities]);

    const found = capKeys.filter((k) => capabilities[k]).length;
    log(`[WirelessProbe] ${controller.name}: found ${found}/${capKeys.length} capabilities`);
    return capabilities;
  } catch (e) {
    console.error(`[wireless] capability probe failed on ${controller.name}:`, e.message);
    return {};
  }
}

// Poll controller metadata using ONLY the stored capability OIDs (discovered once
// by probeControllerCapabilities). No per-poll guessing or diagnostic walks.
// Always returns the full object shape; fields are null when the capability OID
// is absent or returns no value. Best-effort — never crashes the caller.
async function pollControllerMetadata(session, controller) {
  const md = {
    model: null,
    firmware_version: null,
    licensed_aps: null,
    ha_mode: null,
    ha_peer_ip: null,
    ha_sync_status: null,
  };
  const caps = controller.capabilities || {};
  const vendor = controller.vendor;

  if (caps.model) {
    const raw = asStr(await getOid(session, caps.model));
    if (raw != null) {
      const mapped = vendor === 'aruba' && MODEL_MAP.aruba[raw];
      md.model = mapped || raw;
    }
  }
  if (caps.firmware) {
    md.firmware_version = asStr(await getOid(session, caps.firmware));
  }
  if (caps.licensed_aps) {
    const lic = await getOid(session, caps.licensed_aps);
    if (lic != null) {
      const n = Number(lic);
      md.licensed_aps = Number.isFinite(n) ? n : null;
    }
  }
  if (caps.ha_role) {
    const role = await getOid(session, caps.ha_role);
    if (role != null) md.ha_mode = HA_ROLE_MAP[String(role)] || 'unknown';
  }
  if (caps.ha_peer_name) {
    md.ha_peer_ip = asStr(await getOid(session, caps.ha_peer_name));
  }
  if (caps.ha_sync) {
    const sync = await getOid(session, caps.ha_sync);
    if (sync != null) md.ha_sync_status = HA_SYNC_MAP[String(sync)] || 'unknown';
  }

  return md;
}

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
    const aps = parser.parseApTable(walked) || [];
    // Per-SSID stats are optional — only some vendor parsers implement parseSsids.
    let ssids = [];
    if (typeof parser.parseSsids === 'function') {
      try { ssids = parser.parseSsids(walked) || []; } catch (_e) { ssids = []; }
    }
    let metadata = {};
    try { metadata = await pollControllerMetadata(session, controller); }
    catch (_e) { metadata = {}; }
    return { aps, ssids, metadata };
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

// ── API polling ───────────────────────────────────────────────
async function pollApiController(controller) {
  const client = apiClients[controller.vendor];
  if (!client) throw new Error(`no wireless API client for vendor "${controller.vendor}"`);
  const result = (await client.poll(controller)) || [];
  // API clients return a bare AP array; normalise to the { aps, ssids } shape.
  if (Array.isArray(result)) return { aps: result, ssids: [] };
  return { aps: result.aps || [], ssids: result.ssids || [] };
}

// ── Persistence ───────────────────────────────────────────────
function intOrNull(v) {
  // Number(null) === 0, so guard absent values explicitly — otherwise an
  // unreported metric (e.g. noise floor) would be stored as a misleading 0
  // instead of NULL. A genuine numeric 0 is still preserved.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
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

// Throughput counters are cumulative bytes; we keep the previous reading per AP
// (keyed by controller_id::name) in memory so each poll can derive a rate.
// { key -> { rx, tx, t(ms) } }
const prevCounters = new Map();

// Derive throughput in BITS per second from cumulative byte counters.
// Returns { inBps, outBps } (either may be null when there is no usable delta,
// e.g. first poll, counter reset/wrap, or the vendor did not expose the counter).
function deriveThroughput(key, curRx, curTx, nowMs) {
  let inBps = null;
  let outBps = null;
  const prev = prevCounters.get(key);
  if (prev) {
    const elapsed = (nowMs - prev.t) / 1000;
    if (elapsed > 0) {
      if (curRx !== null && prev.rx !== null && curRx >= prev.rx) {
        inBps = Math.round(((curRx - prev.rx) * 8) / elapsed);
      }
      if (curTx !== null && prev.tx !== null && curTx >= prev.tx) {
        outBps = Math.round(((curTx - prev.tx) * 8) / elapsed);
      }
    }
  }
  // Only remember a reading when at least one counter is present.
  if (curRx !== null || curTx !== null) {
    prevCounters.set(key, { rx: curRx, tx: curTx, t: nowMs });
  }
  return { inBps, outBps };
}

// Upsert one AP (keyed by controller_id + name) and append a history sample.
// Decimal-MAC AP name guard (e.g. "108.196.159.202.125.210"). Aruba's parser
// already rejects these, but this protects the shared write path for ALL vendors.
const DECIMAL_MAC_RE = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;

async function upsertAp(pool, controller, ap) {
  // Skip before any DB write: unnamed APs and decimal-MAC names are bad parses.
  if (!ap.name || DECIMAL_MAC_RE.test(ap.name)) {
    console.log('[wireless] skipped decimal-MAC AP:', ap.name);
    return;
  }
  const name = ap.name || ap.mac_address || ap.ip_address || 'AP';
  const monitoredId = await matchMonitoredDevice(pool, ap);
  const clientsTotal = intOrNull(ap.clients_total) || 0;
  const clients2g = intOrNull(ap.clients_2g) || 0;
  const clients5g = intOrNull(ap.clients_5g) || 0;
  const clients6g = intOrNull(ap.clients_6g) || 0;

  // Convert cumulative rx/tx byte counters into a per-poll bits/sec rate.
  const { inBps, outBps } = deriveThroughput(
    `${controller.id}::${name}`, numOrNull(ap.rx_bytes), numOrNull(ap.tx_bytes), Date.now());

  const noise2g = intOrNull(ap.noise_floor_2g);
  const noise5g = intOrNull(ap.noise_floor_5g);
  const authFailures = intOrNull(ap.auth_failures);

  const r = await pool.query(`
    INSERT INTO wireless_aps
      (controller_id, monitored_device_id, name, mac_address, model, ip_address,
       site_id, site_name, status, radio_2g_channel, radio_5g_channel, radio_6g_channel,
       radio_2g_util_pct, radio_5g_util_pct, clients_2g, clients_5g, clients_6g, clients_total,
       tx_power_2g, tx_power_5g, uptime_seconds, firmware_version,
       noise_floor_2g, noise_floor_5g, retry_rate_2g, retry_rate_5g,
       rx_errors_2g, tx_errors_2g, rx_errors_5g, tx_errors_5g,
       throughput_in_bps, throughput_out_bps, serial_number, auth_failures,
       last_seen_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
            $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,NOW(),NOW())
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
      noise_floor_2g   = EXCLUDED.noise_floor_2g,
      noise_floor_5g   = EXCLUDED.noise_floor_5g,
      retry_rate_2g    = EXCLUDED.retry_rate_2g,
      retry_rate_5g    = EXCLUDED.retry_rate_5g,
      rx_errors_2g     = EXCLUDED.rx_errors_2g,
      tx_errors_2g     = EXCLUDED.tx_errors_2g,
      rx_errors_5g     = EXCLUDED.rx_errors_5g,
      tx_errors_5g     = EXCLUDED.tx_errors_5g,
      throughput_in_bps  = EXCLUDED.throughput_in_bps,
      throughput_out_bps = EXCLUDED.throughput_out_bps,
      serial_number    = EXCLUDED.serial_number,
      auth_failures    = EXCLUDED.auth_failures,
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
    noise2g, noise5g, numOrNull(ap.retry_rate_2g), numOrNull(ap.retry_rate_5g),
    intOrNull(ap.rx_errors_2g), intOrNull(ap.tx_errors_2g),
    intOrNull(ap.rx_errors_5g), intOrNull(ap.tx_errors_5g),
    inBps, outBps, ap.serial_number || null, authFailures,
  ]);

  const apId = r.rows[0].id;
  await pool.query(`
    INSERT INTO wireless_history
      (ap_id, clients_total, clients_2g, clients_5g, radio_2g_util, radio_5g_util,
       noise_floor_2g, noise_floor_5g, throughput_in_bps, throughput_out_bps, auth_failures,
       retry_rate_2g, retry_rate_5g)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  `, [apId, clientsTotal, clients2g, clients5g, numOrNull(ap.radio_2g_util_pct), numOrNull(ap.radio_5g_util_pct),
      noise2g, noise5g, inBps, outBps, authFailures,
      numOrNull(ap.retry_rate_2g), numOrNull(ap.retry_rate_5g)]);

  return apId;
}

// Upsert one SSID stat row (keyed by controller_id + ssid_name).
async function upsertSsid(pool, controller, ssid) {
  const name = ssid.ssid_name;
  if (!name) return;
  await pool.query(`
    INSERT INTO wireless_ssids
      (controller_id, ssid_name, site_id, site_name, status,
       clients_total, bytes_in, bytes_out, auth_successes, auth_failures, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (controller_id, ssid_name) DO UPDATE SET
      site_id        = EXCLUDED.site_id,
      site_name      = EXCLUDED.site_name,
      status         = EXCLUDED.status,
      clients_total  = EXCLUDED.clients_total,
      bytes_in       = EXCLUDED.bytes_in,
      bytes_out      = EXCLUDED.bytes_out,
      auth_successes = EXCLUDED.auth_successes,
      auth_failures  = EXCLUDED.auth_failures,
      updated_at     = NOW()
  `, [
    controller.id, name, controller.site_id || null, controller.site_name || null,
    ssid.status || 'up', intOrNull(ssid.clients_total) || 0,
    intOrNull(ssid.bytes_in), intOrNull(ssid.bytes_out),
    intOrNull(ssid.auth_successes) || 0, intOrNull(ssid.auth_failures) || 0,
  ]);
}

// ── Auto-detection of SNMP wireless controllers ───────────────
// SQL predicate (on the given device_type column) that identifies genuine
// wireless gear — a WLC, an access point, or anything tagged wireless/wifi.
// Vendor alone is NOT sufficient: a Cisco/Aruba router or switch is not a
// wireless controller, so device_type must confirm wireless capability.
function wirelessTypeClause(col) {
  return `(
       ${col} ILIKE '%wireless%'
    OR ${col} ILIKE '%wifi%'
    OR ${col} ILIKE '%access point%'
    OR ${col} ILIKE '%wlc%'
  )`;
}

// A monitored, SNMP-enabled device gets a wireless_controller (snmp_device_id)
// created once ONLY when its device_type indicates wireless gear AND its vendor
// maps to a wireless parser. Routers/switches/firewalls are skipped regardless
// of vendor.
async function autoDetectControllers(pool) {
  let created = 0;
  try {
    const r = await pool.query(`
      SELECT id, name, device_vendor, site_id, site_name
      FROM monitored_devices
      WHERE active = TRUE AND snmp_enabled = TRUE AND device_vendor IS NOT NULL
        AND device_type IS NOT NULL AND ${wirelessTypeClause('device_type')}
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

// Remove wireless_controller rows that were auto-created (name ends "(wireless)",
// no API URL, linked to an SNMP device) whose linked device's device_type is NOT
// wireless — i.e. the over-aggressive entries created before the device_type
// guard existed (e.g. routers/switches like the ITC-SK *MPLS links). Their APs
// cascade-delete via the wireless_aps FK. Manually-configured controllers (with
// a controller_url, or without the "(wireless)" suffix) are left untouched.
async function cleanupBadAutoControllers(pool) {
  try {
    const r = await pool.query(`
      DELETE FROM wireless_controllers wc
      USING monitored_devices d
      WHERE wc.snmp_device_id = d.id
        AND wc.controller_url IS NULL
        AND wc.name LIKE '% (wireless)'
        AND (d.device_type IS NULL OR NOT ${wirelessTypeClause('d.device_type')})
      RETURNING wc.name
    `);
    if (r.rowCount) {
      log(`removed ${r.rowCount} mis-detected wireless controller(s): ${r.rows.map((x) => x.name).join(', ')}`);
    }
  } catch (err) {
    console.error('[wireless] cleanup of mis-detected controllers failed:', err.message);
  }
}

// Remove stale AP records whose `name` is a decimal-MAC string (6 decimal octets
// separated by dots, e.g. "108.196.159.202.125.210"). These were created by old
// incorrect SNMP parsing before parseApTable() rejected MAC-shaped names; the
// real APs re-appear with proper names on the next poll. Run once on startup.
async function cleanupDecimalMacAps(pool) {
  try {
    const r = await pool.query(`
      DELETE FROM wireless_aps
      WHERE name ~ '^\\d+\\.\\d+\\.\\d+\\.\\d+\\.\\d+\\.\\d+$'
        AND controller_id IN (SELECT id FROM wireless_controllers)
      RETURNING name
    `);
    if (r.rowCount) {
      log(`removed ${r.rowCount} stale decimal-MAC AP record(s)`);
    }
  } catch (err) {
    console.error('[wireless] cleanup of decimal-MAC APs failed:', err.message);
  }
}

// ── Per-controller poll ───────────────────────────────────────
async function pollController(pool, controller) {
  try {
    let aps = [];
    let ssids = [];
    let metadata = {};
    if (controller.snmp_device_id) {
      // One-time capability discovery: probe OIDs once, then reuse stored OIDs.
      if (!controller.capabilities || !controller.capabilities.probe_done) {
        await probeControllerCapabilities(pool, controller);
        const rq = await pool.query('SELECT * FROM wireless_controllers WHERE id = $1', [controller.id]);
        if (rq.rows[0]) controller = rq.rows[0];
      }
      ({ aps, ssids, metadata = {} } = await pollSnmpController(pool, controller));
    } else if (controller.controller_url) {
      ({ aps, ssids } = await pollApiController(controller));
    } else {
      throw new Error('controller has neither an SNMP device nor an API URL');
    }

    for (const ap of aps) {
      try { await upsertAp(pool, controller, ap); }
      catch (e) { console.error(`[wireless] AP upsert failed on ${controller.name}:`, e.message); }
    }

    for (const ssid of ssids) {
      try { await upsertSsid(pool, controller, ssid); }
      catch (e) { console.error(`[wireless] SSID upsert failed on ${controller.name}:`, e.message); }
    }

    // AP disconnects in the last 24h = distinct clients that 'leave' on this
    // controller (sourced from wireless_client_events).
    let apDisc = 0;
    try {
      const discq = await pool.query(
        `SELECT COUNT(DISTINCT mac_address)::int AS n FROM wireless_client_events
         WHERE controller_id = $1 AND event_type = 'leave' AND ts >= NOW() - INTERVAL '24 hours'`,
        [controller.id]);
      apDisc = discq.rows[0] ? discq.rows[0].n : 0;
    } catch (_e) { apDisc = 0; }

    const md = metadata || {};
    await pool.query(
      `UPDATE wireless_controllers SET last_polled_at = NOW(), status = 'ok', last_error = NULL,
         model = $2, firmware_version = $3, licensed_aps = $4,
         ha_mode = $5, ha_peer_ip = $6, ha_sync_status = $7, ap_disconnects_24h = $8
       WHERE id = $1`,
      [
        controller.id,
        md.model ?? null,
        md.firmware_version ?? null,
        md.licensed_aps ?? null,
        md.ha_mode ?? null,
        md.ha_peer_ip ?? null,
        md.ha_sync_status ?? null,
        apDisc,
      ]);
    const s0 = aps[0];
    const sample = s0
      ? ` — e.g. ${s0.name}: clients=${s0.clients_total} ch=${s0.radio_2g_channel ?? '-'} /${s0.radio_5g_channel ?? '-'} util=${s0.radio_2g_util_pct ?? '-'}%/${s0.radio_5g_util_pct ?? '-'}%`
      : '';
    log(`polled ${controller.name} (${controller.vendor}): ${aps.length} AP(s), ${ssids.length} SSID(s)${sample}`);
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
    await runWirelessIntelligence(pool);
  } catch (err) {
    console.error('[wireless] poll cycle failed:', err.message);
  } finally {
    busy = false;
  }
}

// Dry-run a controller (no DB writes) for the "Test Connection" button.
async function testController(pool, controller) {
  try {
    let result;
    if (controller.snmp_device_id) result = await pollSnmpController(pool, controller);
    else if (controller.controller_url) result = await pollApiController(controller);
    else return { ok: false, message: 'No SNMP device or API URL configured' };
    const aps = result.aps || [];
    const ssids = result.ssids || [];
    const ssidNote = ssids.length ? `, ${ssids.length} SSID(s)` : '';
    return {
      ok: true,
      message: `Reached controller — ${aps.length} AP(s)${ssidNote} found`,
      ap_count: aps.length,
      ssid_count: ssids.length,
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// Decode a raw SNMP value for human-readable diagnostics: buffers are shown as
// both hex (for MACs / binary) and printable ASCII; everything else verbatim.
function decodeSnmpVal(v) {
  if (Buffer.isBuffer(v)) {
    return { hex: v.toString('hex'), ascii: v.toString('latin1').replace(/[^\x20-\x7e]/g, '.') };
  }
  return v;
}

// Live raw-SNMP-walk diagnostic for a controller. Walks both the parser's own
// declared OIDs (to show what the CURRENT parser actually receives) and the
// broad Aruba AP/radio/BSSID/ESSID parent subtrees + the Aruba Instant AP table
// (to reveal the real table structure and index format on the device). No DB
// writes. Returns capped raw {oid, value} samples so OIDs can be validated
// against ground truth instead of guessed. SNMP-based controllers only.
async function debugWalk(pool, controller) {
  if (!controller.snmp_device_id) {
    return { ok: false, message: 'Controller is API-based (no SNMP device to walk)' };
  }
  const dq = await pool.query('SELECT * FROM monitored_devices WHERE id = $1', [controller.snmp_device_id]);
  const device = dq.rows[0];
  if (!device) return { ok: false, message: 'Linked SNMP device not found' };

  const PER_TREE_CAP = 60;
  const parser = getWirelessParser(controller.vendor)
    || (device.device_vendor ? getWirelessParser(wirelessVendorFor(device.device_vendor)) : null);

  // Broad Aruba parent subtrees that expose the real structure + index format.
  const subtrees = {
    aruba_ap_table:      '1.3.6.1.4.1.14823.2.2.1.5.2.1.4',  // wlsxWlanAPTable
    aruba_radio_table:   '1.3.6.1.4.1.14823.2.2.1.5.2.1.5',  // wlsxWlanRadioTable
    aruba_instant_ap:    '1.3.6.1.4.1.14823.2.3.3.1.2.1',    // aiAccessPointTable (Instant)
    aruba_instant_ssid:  '1.3.6.1.4.1.14823.2.3.3.1.1.7.1',  // aiWlanSSIDTable (Instant)
    // Client/station table candidates (for verifying the wireless_clients source).
    aruba_station_table: '1.3.6.1.4.1.14823.2.2.1.5.2.2.1',  // wlsxWlanStationTable (primary)
    aruba_user_table:    '1.3.6.1.4.1.14823.2.2.1.4.1.2',    // wlsxUserTable (IP + AP name)
    aruba_station_mgmt:  '1.3.6.1.4.1.14823.2.2.1.1.2.2',    // wlsxSwitchStationMgmtTable
    aruba_instant_client: '1.3.6.1.4.1.14823.2.3.3.1.2.4',   // aiClientTable (Instant)
  };

  // Candidate ESSID/SSID source tables — each is walked and counted so the
  // populated SSID source is obvious from one call.
  const essidCandidates = {
    'wlsxWlanESSIDTable (...5.2.1.8)':    '1.3.6.1.4.1.14823.2.2.1.5.2.1.8',
    'alt (...1.7.1)':                     '1.3.6.1.4.1.14823.2.2.1.1.7.1',
    'wlsxWlanAPStatsTable (...5.3.1.1)':  '1.3.6.1.4.1.14823.2.2.1.5.3.1.1',
    'wlsxWlanAPBssidTable (...5.2.1.7)':  '1.3.6.1.4.1.14823.2.2.1.5.2.1.7',
  };

  // Controller-metadata scalar OIDs per vendor (validated against real hardware).
  // sysDescr is always included; vendor-specific license/HA OIDs follow.
  const metadataOids = { common_sysDescr: '1.3.6.1.2.1.1.1.0' };
  if (controller.vendor === 'aruba') {
    metadataOids.aruba_licensed_aps = '1.3.6.1.4.1.14823.2.2.1.1.1.40';
    metadataOids.aruba_ha_state     = '1.3.6.1.4.1.14823.2.2.1.2.1.19.0';
    metadataOids.aruba_ha_peer_ip   = '1.3.6.1.4.1.14823.2.2.1.2.1.20.0';
    metadataOids.aruba_ha_sync      = '1.3.6.1.4.1.14823.2.2.1.2.1.21.0';
  } else if (controller.vendor === 'cisco') {
    metadataOids.cisco_max_assoc    = '1.3.6.1.4.1.14179.1.1.1.18';
    metadataOids.cisco_redundancy   = '1.3.6.1.4.1.14179.2.6.3.34.0';
  } else if (controller.vendor === 'ruckus') {
    metadataOids.ruckus_max_aps     = '1.3.6.1.4.1.25053.1.2.2.1.1.1.1.16.0';
  }

  const session = createSession(device, 12000);
  const out = {
    ok: true, vendor: controller.vendor, device_ip: device.ip_address,
    parser_oids: {}, subtrees: {}, essid_table: {}, metadata_probe: {},
  };
  try {
    // 0) Controller-metadata scalar probes (best-effort; capped to the small map).
    for (const [label, oid] of Object.entries(metadataOids)) {
      try {
        const rows = await get(session, [oid]);
        const v = rows[0] ? rows[0].value : null;
        out.metadata_probe[label] = { oid, value: v == null ? null : decodeSnmpVal(v) };
      } catch (_e) {
        out.metadata_probe[label] = { oid, value: null };
      }
    }
    // 1) What the current parser's declared OIDs return right now.
    if (parser && parser.snmpOids) {
      for (const [key, oid] of Object.entries(parser.snmpOids)) {
        const rows = await walk(session, oid);
        out.parser_oids[key] = {
          oid,
          count: rows.length,
          sample: rows.slice(0, 5).map((r) => ({ oid: r.oid, value: decodeSnmpVal(r.value) })),
        };
      }
    }
    // 2) Ground-truth discovery walks of the broad parent subtrees.
    for (const [key, base] of Object.entries(subtrees)) {
      const rows = await walk(session, base);
      out.subtrees[key] = {
        base,
        count: rows.length,
        truncated: rows.length > PER_TREE_CAP,
        sample: rows.slice(0, PER_TREE_CAP).map((r) => ({ oid: r.oid, value: decodeSnmpVal(r.value) })),
      };
    }
    // 3) Per-OID ESSID candidate comparison — raw row count from each attempt.
    for (const [label, base] of Object.entries(essidCandidates)) {
      const rows = await walk(session, base);
      out.essid_table[label] = {
        base,
        count: rows.length,
        sample: rows.slice(0, 12).map((r) => ({ oid: r.oid, value: decodeSnmpVal(r.value) })),
      };
    }
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
  return out;
}

// Operator-driven generic SNMP walk: walk ANY OID on a controller's linked SNMP
// device so the correct OID for any metric can be discovered against live
// hardware (instead of relying on hardcoded per-vendor metadata OIDs). Falls
// back to a scalar GET when the subtree walk is empty (e.g. a ...x.0 scalar).
// No DB writes. Never throws — failures are returned as { ok: false, message }.
// Credentials are never returned (only device_ip is exposed).
async function walkOid(pool, controller, oid) {
  if (!controller.snmp_device_id) {
    return { ok: false, message: 'Controller is API-based (no SNMP device to walk)' };
  }
  if (typeof oid !== 'string' || !/^\.?\d+(\.\d+)+$/.test(oid)) {
    return { ok: false, message: 'Invalid OID (expected numeric dotted form like 1.3.6.1.2.1.1)' };
  }
  oid = oid.replace(/^\./, '');

  const dq = await pool.query('SELECT * FROM monitored_devices WHERE id = $1', [controller.snmp_device_id]);
  const device = dq.rows[0];
  if (!device) return { ok: false, message: 'Linked SNMP device not found' };

  const CAP = 500;
  const session = createSession(device, 12000);
  try {
    let rows = await walk(session, oid);
    if (rows.length === 0) {
      const g = await get(session, [oid]);
      if (g.length) rows = g;
    }
    return {
      ok: true,
      oid,
      vendor: controller.vendor,
      device_ip: device.ip_address,
      count: rows.length,
      truncated: rows.length > CAP,
      rows: rows.slice(0, CAP).map((r) => ({ oid: r.oid, value: decodeSnmpVal(r.value) })),
    };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

// ── Client-level troubleshooting (Tier 1) ─────────────────────
// Poll a controller's associated clients (SNMP), detect roam/join/leave/
// low-signal events vs the previous snapshot, upsert the current client set,
// and prune stale clients + old events. Never throws; a client-poll failure is
// isolated and never affects AP polling.
async function pollClients(pool, controller, apList) {
  const parser = getClientParser(controller.vendor);
  if (!parser || !controller.snmp_device_id) return; // unsupported vendor or no SNMP device

  const apByName = new Map(apList.map((a) => [a.name, a]));
  const apByMac = new Map(apList.filter((a) => a.mac_address).map((a) => [a.mac_address, a]));

  const dq = await pool.query('SELECT * FROM monitored_devices WHERE id = $1', [controller.snmp_device_id]);
  const device = dq.rows[0];
  if (!device) return;

  const session = createSession(device, 10000);
  let clients = [];
  try {
    clients = (await parser.parseClients(session, { byName: apByName, byMac: apByMac })) || [];
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
  if (clients.length === 0) {
    log(`[clients] ${controller.name} (${controller.vendor}): 0 clients (no rows from the client table OID)`);
    return;
  }

  // Previous snapshot for roaming/leave detection.
  const prev = await pool.query(
    `SELECT mac_address, ap_id, ap_name, rssi_dbm FROM wireless_clients WHERE controller_id = $1`,
    [controller.id]);
  const prevMap = new Map(prev.rows.map((c) => [c.mac_address, c]));

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const events = [];
  const seen = new Set();

  for (const client of clients) {
    if (!client.mac_address) continue;
    seen.add(client.mac_address);
    const p = prevMap.get(client.mac_address);
    if (p) {
      if (p.ap_id && client.ap_id && p.ap_id !== client.ap_id) {
        events.push({
          mac_address: client.mac_address, controller_id: controller.id, event_type: 'roam',
          from_ap_id: p.ap_id, from_ap_name: p.ap_name, to_ap_id: client.ap_id, to_ap_name: client.ap_name,
          rssi_dbm: client.rssi_dbm, ssid_name: client.ssid_name, ts: now,
        });
      }
    } else {
      events.push({
        mac_address: client.mac_address, controller_id: controller.id, event_type: 'join',
        to_ap_id: client.ap_id, to_ap_name: client.ap_name,
        rssi_dbm: client.rssi_dbm, ssid_name: client.ssid_name, ts: now,
      });
    }
    if (client.rssi_dbm !== null && client.rssi_dbm !== undefined && client.rssi_dbm < -75) {
      events.push({
        mac_address: client.mac_address, controller_id: controller.id, event_type: 'low_signal',
        to_ap_id: client.ap_id, to_ap_name: client.ap_name,
        rssi_dbm: client.rssi_dbm, ssid_name: client.ssid_name, ts: now,
      });
    }
  }

  // Clients that left (in previous snapshot, not in current).
  for (const [mac, p] of prevMap) {
    if (!seen.has(mac)) {
      events.push({
        mac_address: mac, controller_id: controller.id, event_type: 'leave',
        from_ap_id: p.ap_id, from_ap_name: p.ap_name, ts: now,
      });
    }
  }

  // Upsert current clients (roaming_count from the last hour of roam events).
  for (const client of clients) {
    if (!client.mac_address) continue;
    const rc = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM wireless_client_events
       WHERE mac_address = $1 AND controller_id = $2 AND event_type = 'roam' AND ts >= $3`,
      [client.mac_address, controller.id, oneHourAgo]);
    const roamCount = rc.rows[0] ? rc.rows[0].cnt : 0;
    const hasRssi = client.rssi_dbm !== null && client.rssi_dbm !== undefined;
    const isProblem = (hasRssi && client.rssi_dbm < -75) || roamCount > 5;
    // Sticky: poor signal but NOT roaming away (clings to a far AP) — the opposite
    // failure mode from excessive roaming, so it's tracked separately.
    const isSticky = hasRssi && client.rssi_dbm <= -72 && roamCount <= 1;

    await pool.query(`
      INSERT INTO wireless_clients
        (mac_address, ip_address, hostname, controller_id, ap_id, ap_name, ssid_name, band, channel,
         rssi_dbm, tx_rate_mbps, rx_rate_mbps, connected_since, last_seen_at, auth_type,
         is_problem, roaming_count, vendor, is_sticky)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (controller_id, mac_address) DO UPDATE SET
        ip_address    = EXCLUDED.ip_address,
        hostname      = COALESCE(EXCLUDED.hostname, wireless_clients.hostname),
        ap_id         = EXCLUDED.ap_id,
        ap_name       = EXCLUDED.ap_name,
        ssid_name     = EXCLUDED.ssid_name,
        band          = EXCLUDED.band,
        channel       = EXCLUDED.channel,
        rssi_dbm      = EXCLUDED.rssi_dbm,
        tx_rate_mbps  = EXCLUDED.tx_rate_mbps,
        rx_rate_mbps  = EXCLUDED.rx_rate_mbps,
        connected_since = COALESCE(EXCLUDED.connected_since, wireless_clients.connected_since),
        last_seen_at  = EXCLUDED.last_seen_at,
        auth_type     = EXCLUDED.auth_type,
        is_problem    = EXCLUDED.is_problem,
        roaming_count = EXCLUDED.roaming_count,
        is_sticky     = EXCLUDED.is_sticky
    `, [
      client.mac_address, client.ip_address || null, client.hostname || null, controller.id,
      client.ap_id || null, client.ap_name || null, client.ssid_name || null, client.band || null,
      intOrNull(client.channel), intOrNull(client.rssi_dbm),
      numOrNull(client.tx_rate_mbps), numOrNull(client.rx_rate_mbps), client.connected_since || null,
      now, client.auth_type || null, isProblem, roamCount, controller.vendor, isSticky,
    ]);
  }

  // Insert detected events.
  for (const e of events) {
    await pool.query(`
      INSERT INTO wireless_client_events
        (mac_address, controller_id, event_type, from_ap_id, from_ap_name, to_ap_id, to_ap_name,
         rssi_dbm, ssid_name, ts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      e.mac_address, e.controller_id, e.event_type, e.from_ap_id || null, e.from_ap_name || null,
      e.to_ap_id || null, e.to_ap_name || null, intOrNull(e.rssi_dbm), e.ssid_name || null, e.ts,
    ]);
  }

  // Prune clients not seen in 15 minutes; purge events older than 7 days.
  await pool.query(
    `DELETE FROM wireless_clients WHERE controller_id = $1 AND last_seen_at < NOW() - INTERVAL '15 minutes'`,
    [controller.id]);
  await pool.query(`DELETE FROM wireless_client_events WHERE ts < NOW() - INTERVAL '7 days'`);

  log(`[clients] ${controller.name}: ${clients.length} client(s), ${events.length} event(s)`);
}

// Client poll cycle — separate (slower) cadence than the AP poll.
let clientsBusy = false;
async function pollAllClients(pool) {
  if (clientsBusy) return;
  clientsBusy = true;
  try {
    const r = await pool.query(`SELECT * FROM wireless_controllers WHERE active = TRUE`);
    for (const c of r.rows) {
      if (!c.snmp_device_id) continue;
      try {
        const apq = await pool.query(
          `SELECT id, name, mac_address FROM wireless_aps WHERE controller_id = $1`, [c.id]);
        await pollClients(pool, c, apq.rows);
      } catch (e) {
        // Client polling never affects AP polling — isolate per-controller failures.
        console.error(`[wireless] client poll failed on ${c.name}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[wireless] client poll cycle failed:', err.message);
  } finally {
    clientsBusy = false;
  }
}

// Clients are polled on a slower cadence than APs to reduce SNMP load on the
// controllers (note 2): every 15 minutes, with a first pass 30s after startup.
const CLIENT_POLL_INTERVAL = 15 * 60 * 1000;

// Start the wireless collector on a 5-minute cadence (first pass after 20s so
// the initial NetVault sync + vendor detection has a chance to populate).
function startWirelessCollector(pool) {
  // One-shot startup cleanup of previously mis-detected (non-wireless) controllers.
  cleanupBadAutoControllers(pool).catch((e) => console.error('[wireless] startup cleanup:', e.message));
  // One-shot startup cleanup of stale decimal-MAC AP records (old bad SNMP parsing).
  cleanupDecimalMacAps(pool).catch((e) => console.error('[wireless] decimal-MAC cleanup:', e.message));
  setTimeout(() => pollAll(pool), 20 * 1000);
  setInterval(() => pollAll(pool), 5 * 60 * 1000);
  // Client polling on its own (slower) schedule, separate from the AP poll.
  setTimeout(() => pollAllClients(pool), 30 * 1000);
  setInterval(() => pollAllClients(pool), CLIENT_POLL_INTERVAL);
  log('wireless collector started (APs every 5 min, clients every 15 min)');
}

module.exports = {
  startWirelessCollector, pollAll, pollController, upsertAp, upsertSsid,
  autoDetectControllers, cleanupBadAutoControllers, cleanupDecimalMacAps, testController, debugWalk,
  walkOid, pollClients, pollAllClients, probeControllerCapabilities,
};

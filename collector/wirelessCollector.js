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
    return { aps, ssids };
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
async function upsertAp(pool, controller, ap) {
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
       noise_floor_2g, noise_floor_5g, throughput_in_bps, throughput_out_bps, auth_failures)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [apId, clientsTotal, clients2g, clients5g, numOrNull(ap.radio_2g_util_pct), numOrNull(ap.radio_5g_util_pct),
      noise2g, noise5g, inBps, outBps, authFailures]);

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

// ── Per-controller poll ───────────────────────────────────────
async function pollController(pool, controller) {
  try {
    let aps = [];
    let ssids = [];
    if (controller.snmp_device_id) {
      ({ aps, ssids } = await pollSnmpController(pool, controller));
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

    await pool.query(
      `UPDATE wireless_controllers SET last_polled_at = NOW(), status = 'ok', last_error = NULL WHERE id = $1`,
      [controller.id]);
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
  };

  // Candidate ESSID/SSID source tables — each is walked and counted so the
  // populated SSID source is obvious from one call.
  const essidCandidates = {
    'wlsxWlanESSIDTable (...5.2.1.8)':    '1.3.6.1.4.1.14823.2.2.1.5.2.1.8',
    'alt (...1.7.1)':                     '1.3.6.1.4.1.14823.2.2.1.1.7.1',
    'wlsxWlanAPStatsTable (...5.3.1.1)':  '1.3.6.1.4.1.14823.2.2.1.5.3.1.1',
    'wlsxWlanAPBssidTable (...5.2.1.7)':  '1.3.6.1.4.1.14823.2.2.1.5.2.1.7',
  };

  const session = createSession(device, 12000);
  const out = {
    ok: true, vendor: controller.vendor, device_ip: device.ip_address,
    parser_oids: {}, subtrees: {}, essid_table: {},
  };
  try {
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

// Start the wireless collector on a 5-minute cadence (first pass after 20s so
// the initial NetVault sync + vendor detection has a chance to populate).
function startWirelessCollector(pool) {
  // One-shot startup cleanup of previously mis-detected (non-wireless) controllers.
  cleanupBadAutoControllers(pool).catch((e) => console.error('[wireless] startup cleanup:', e.message));
  setTimeout(() => pollAll(pool), 20 * 1000);
  setInterval(() => pollAll(pool), 5 * 60 * 1000);
  log('wireless collector started (every 5 min)');
}

module.exports = {
  startWirelessCollector, pollAll, pollController, upsertAp, upsertSsid,
  autoDetectControllers, cleanupBadAutoControllers, testController, debugWalk,
};

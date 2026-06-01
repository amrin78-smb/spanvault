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
const snmp       = require('net-snmp');
const nodemailer = require('nodemailer');
const { SYSDESCR_OID, detectVendor, getParser } = require('./parsers');

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

// ── Standard SNMP OIDs ────────────────────────────────────────
const OID = {
  sysUpTime:       '1.3.6.1.2.1.1.3.0',
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',   // table: per-processor load %
  hrStorageType:   '1.3.6.1.2.1.25.2.3.1.2',   // table: storage type OID
  hrStorageSize:   '1.3.6.1.2.1.25.2.3.1.5',   // table: total units
  hrStorageUsed:   '1.3.6.1.2.1.25.2.3.1.6',   // table: used units
  ifName:          '1.3.6.1.2.1.31.1.1.1.1',   // ifXTable
  ifHCInOctets:    '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets:   '1.3.6.1.2.1.31.1.1.1.10',
  ifOperStatus:    '1.3.6.1.2.1.2.2.1.8',      // ifTable: 1=up
  ifDescr:         '1.3.6.1.2.1.2.2.1.2',      // fallback name
};
const HR_STORAGE_RAM = '1.3.6.1.2.1.25.2.1.2'; // hrStorageRam type

// Track previous interface octet counters for bps computation.
// Map<deviceId, Map<ifIndex, { inOctets, outOctets, ts }>>
const ifPrev = new Map();

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
  } catch (err) {
    console.error('[sync] NetVault sync failed:', err.message);
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
      `${device.name} (${device.ip_address}) is unreachable`, null);
  } else if (newStatus !== 'down') {
    await resolveAlert(device.id, 'device_down');
  }

  if (alive && timeMs !== null && timeMs > threshold && !inMaint) {
    await raiseAlert(device, 'high_latency', 'warning',
      `${device.name} latency ${timeMs}ms exceeds ${threshold}ms`, timeMs);
  } else if (alive && (timeMs === null || timeMs <= threshold)) {
    await resolveAlert(device.id, 'high_latency');
  }

  return { status: newStatus, timeMs };
}

// ══════════════════════════════════════════════════════════════
// SNMP polling
// ══════════════════════════════════════════════════════════════
function createSnmpSession(device) {
  const port = device.snmp_port || 161;
  const opts = { port, timeout: 3000, retries: 1 };
  if (device.snmp_version === '3') {
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
  opts.version = device.snmp_version === '1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(device.ip_address, device.snmp_community || 'public', opts);
}

// Promisified subtree walk → returns array of { oid, value }
function walk(session, baseOid) {
  return new Promise((resolve) => {
    const out = [];
    session.subtree(baseOid, 20, (varbinds) => {
      for (const vb of varbinds) {
        if (!snmp.isVarbindError(vb)) out.push({ oid: vb.oid, value: vb.value });
      }
    }, (err) => {
      if (err) return resolve(out); // best-effort: return what we have
      resolve(out);
    });
  });
}

// Promisified scalar GET → returns array of { oid, value } (errors → []).
function get(session, oids) {
  return new Promise((resolve) => {
    try {
      session.get(oids, (err, varbinds) => {
        if (err) return resolve([]);
        const out = [];
        for (const vb of varbinds || []) {
          if (!snmp.isVarbindError(vb)) out.push({ oid: vb.oid, value: vb.value });
        }
        resolve(out);
      });
    } catch (_e) {
      resolve([]);
    }
  });
}

// Fetch each parser metric: WALK for tables, GET for scalars. Returns a map
// keyed by metric def `name` → array of { oid, value } varbinds.
async function fetchVendorMetrics(session, parser) {
  const raw = {};
  for (const m of parser.metrics) {
    if (m.kind === 'table') raw[m.name] = await walk(session, m.oid);
    else raw[m.name] = await get(session, [m.oid]);
  }
  return raw;
}

// Merge core + vendor samples. A vendor scalar metric (no if_index) overrides
// the core's standard-MIB sample of the same metric_name — vendor MIBs are more
// authoritative for cpu_pct/mem_pct on enterprise gear. Interface/table samples
// from both sides are kept.
function mergeSamples(core, vendor) {
  const vendorScalars = new Set(
    vendor.filter((s) => !s.if_index).map((s) => s.metric_name)
  );
  const out = [];
  for (const s of core) {
    if (!s.if_index && vendorScalars.has(s.metric_name)) continue; // overridden by vendor
    out.push(s);
  }
  for (const s of vendor) out.push(s);
  return out;
}

// Last index segment of an OID (the table row index).
function lastIndex(oid) {
  const parts = oid.split('.');
  return parseInt(parts[parts.length - 1], 10);
}

async function snmpPollDevice(device) {
  const session = createSnmpSession(device);
  const samples = [];       // core standard-MIB samples
  let vendorSamples = [];    // vendor-specific samples (parser output)
  try {
    // ── Vendor detection — fetch sysDescr, pick a parser ──────────
    const sysDescrRows = await get(session, [SYSDESCR_OID]);
    const sysDescr = sysDescrRows.length ? String(sysDescrRows[0].value) : '';
    const vendor = detectVendor(sysDescr);
    await persistVendor(device, vendor);

    // CPU — average hrProcessorLoad across processors.
    const cpus = await walk(session, OID.hrProcessorLoad);
    if (cpus.length) {
      const vals = cpus.map((c) => Number(c.value)).filter((n) => !isNaN(n));
      if (vals.length) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        samples.push({ metric_name: 'cpu_pct', value: avg, oid: OID.hrProcessorLoad });
      }
    }

    // Memory — hrStorage rows of type hrStorageRam.
    const [types, sizes, useds] = await Promise.all([
      walk(session, OID.hrStorageType),
      walk(session, OID.hrStorageSize),
      walk(session, OID.hrStorageUsed),
    ]);
    const sizeByIdx = new Map(sizes.map((s) => [lastIndex(s.oid), Number(s.value)]));
    const usedByIdx = new Map(useds.map((u) => [lastIndex(u.oid), Number(u.value)]));
    for (const t of types) {
      // hrStorageType is an OBJECT IDENTIFIER; net-snmp returns it as a dotted string.
      const typeStr = String(t.value);
      if (typeStr.indexOf(HR_STORAGE_RAM) !== -1) {
        const idx = lastIndex(t.oid);
        const size = sizeByIdx.get(idx);
        const used = usedByIdx.get(idx);
        if (size > 0 && used >= 0) {
          samples.push({ metric_name: 'mem_pct', value: (used / size) * 100, oid: OID.hrStorageUsed });
          break;
        }
      }
    }

    // Interfaces — names, oper status, and bps rates from HC octet counters.
    const [names, descrs, opers, inOct, outOct] = await Promise.all([
      walk(session, OID.ifName),
      walk(session, OID.ifDescr),
      walk(session, OID.ifOperStatus),
      walk(session, OID.ifHCInOctets),
      walk(session, OID.ifHCOutOctets),
    ]);
    const nameByIdx = new Map(names.map((n) => [lastIndex(n.oid), String(n.value)]));
    const descrByIdx = new Map(descrs.map((d) => [lastIndex(d.oid), String(d.value)]));
    const inByIdx = new Map(inOct.map((o) => [lastIndex(o.oid), Number(o.value)]));
    const outByIdx = new Map(outOct.map((o) => [lastIndex(o.oid), Number(o.value)]));

    const now = Date.now();
    let prevDev = ifPrev.get(device.id);
    if (!prevDev) { prevDev = new Map(); ifPrev.set(device.id, prevDev); }

    for (const o of opers) {
      const idx = lastIndex(o.oid);
      const ifName = nameByIdx.get(idx) || descrByIdx.get(idx) || `if${idx}`;
      const operUp = Number(o.value) === 1 ? 1 : 0;
      samples.push({ metric_name: 'if_oper_status', value: operUp, oid: o.oid, if_index: idx, if_name: ifName });

      const curIn = inByIdx.get(idx);
      const curOut = outByIdx.get(idx);
      const prev = prevDev.get(idx);
      if (prev && curIn !== undefined && curOut !== undefined) {
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec > 0) {
          // Guard against counter wrap/reset → negative delta.
          const dIn = curIn - prev.inOctets;
          const dOut = curOut - prev.outOctets;
          if (dIn >= 0) samples.push({ metric_name: 'if_in_bps', value: (dIn * 8) / dtSec, oid: OID.ifHCInOctets, if_index: idx, if_name: ifName });
          if (dOut >= 0) samples.push({ metric_name: 'if_out_bps', value: (dOut * 8) / dtSec, oid: OID.ifHCOutOctets, if_index: idx, if_name: ifName });
        }
      }
      if (curIn !== undefined && curOut !== undefined) {
        prevDev.set(idx, { inOctets: curIn, outOctets: curOut, ts: now });
      }
    }

    // ── Vendor-specific OIDs — in addition to the standard set above ──
    const parser = getParser(device.device_vendor || 'generic');
    if (parser.metrics.length) {
      try {
        const raw = await fetchVendorMetrics(session, parser);
        vendorSamples = parser.parse(raw) || [];
      } catch (err) {
        console.error(`[snmp] ${device.name} vendor parse (${parser.name}) failed:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[snmp] ${device.name} (${device.ip_address}) poll error:`, err.message);
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }

  // Vendor scalar metrics override core standard-MIB metrics of the same name.
  const merged = mergeSamples(samples, vendorSamples);

  // Persist samples.
  for (const s of merged) {
    await sv.query(
      `INSERT INTO snmp_results (device_id, oid, metric_name, value, if_index, if_name)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [device.id, s.oid || null, s.metric_name, isFinite(s.value) ? s.value : null,
       s.if_index || null, s.if_name || null]
    );
  }

  await evaluateSnmpAlerts(device, merged);
  return merged.length;
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
        `${device.name} CPU ${latest.cpu_pct.toFixed(0)}% exceeds ${cpuThresh}%`, latest.cpu_pct);
    } else {
      await resolveAlert(device.id, 'high_cpu');
    }
  }
  if (latest.mem_pct !== undefined) {
    if (latest.mem_pct > memThresh) {
      await raiseAlert(device, 'high_memory', 'warning',
        `${device.name} memory ${latest.mem_pct.toFixed(0)}% exceeds ${memThresh}%`, latest.mem_pct);
    } else {
      await resolveAlert(device.id, 'high_memory');
    }
  }

  // User-defined alert_rules — global (device_id NULL) + device-specific.
  let rules = [];
  try {
    const r = await sv.query(
      `SELECT * FROM alert_rules WHERE enabled = TRUE AND (device_id IS NULL OR device_id = $1)`,
      [device.id]
    );
    rules = r.rows;
  } catch (err) {
    console.error('[alerts] rule fetch failed:', err.message);
  }
  for (const rule of rules) {
    const val = latest[rule.metric];
    if (val === undefined) continue;
    const alertType = `rule_${rule.id}`;
    if (compare(val, rule.operator, Number(rule.threshold))) {
      await raiseAlert(device, alertType, rule.severity || 'warning',
        `${device.name} ${rule.metric} ${val.toFixed(1)} ${rule.operator} ${rule.threshold}`, val);
    } else {
      await resolveAlert(device.id, alertType);
    }
  }
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
    if (r.rows[0]) log(`[alert] RESOLVED ${alertType} on device ${deviceId}`);
  } catch (err) {
    console.error('[alerts] resolve failed:', err.message);
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
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE active = TRUE`);
  return r.rows;
}

let pingBusy = false;
async function pingTick() {
  if (pingBusy) return;
  pingBusy = true;
  try {
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
  await syncNetVaultDevices();

  // Reload settings periodically so UI changes take effect.
  setInterval(loadSettings, 60 * 1000);

  // NetVault metadata sync.
  const syncMs = settingInt('netvault_sync_minutes', 30) * 60 * 1000;
  setInterval(syncNetVaultDevices, syncMs);

  // Poll scheduler ticks. The due-check inside honors per-device intervals.
  setInterval(pingTick, 15 * 1000);
  setInterval(snmpTick, 15 * 1000);

  // Kick off an immediate first pass.
  pingTick();
  setTimeout(snmpTick, 5 * 1000);

  log('SpanVault collector running.');
}

main().catch((err) => {
  console.error('[FATAL] collector main failed:', err.message, err.stack);
  process.exit(1);
});

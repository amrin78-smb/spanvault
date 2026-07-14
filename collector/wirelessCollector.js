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

const { createSession, walk, get, OID } = require('./snmp-session');
const { getWirelessParser, wirelessVendorFor } = require('./wireless');
const { getClientParser } = require('./wireless/clients');
const { runWirelessIntelligence } = require('./wirelessIntelligence');

// Vendor SNMP metric support matrix (what each parser actually returns):
//   Aruba:        radio channel/util/clients/noise/retry/interference + per-radio
//                 byte counters (throughput) + per-SSID clients — live-verified
//                 (no per-SSID byte/auth counters, no rx/tx error counters)
//   Cisco:        radio channel/util/clients/noise + retry approx + per-SSID
//                 clients/status — MIB-verified, unvalidated on hardware
//                 (no per-WLAN traffic counters exist in AIRESPACE-WIRELESS-MIB)
//   Ruckus (ZD):  radio channel/util/clients + throughput + per-SSID
//                 clients/bytes/auth — MIB-verified, unvalidated on hardware
//                 (no noise-floor object in RUCKUS-ZD-WLAN-MIB; SmartZone uses a
//                 different subtree and is NOT supported by this parser)
//   MikroTik:     per-interface SSID/clients/noise via mtxrWlApTable (basic)
//   HPE/Fortinet/Grandstream: basic presence/status only — other fields NULL

// Vendor HTTP API clients (controller_url based).
const apiClients = {
  grandstream:    require('./wireless/api/grandstream'),
  ubiquiti:       require('./wireless/api/ubiquiti'),
  omada:          require('./wireless/api/omada'),
  aruba_central:  require('./wireless/api/aruba-central'),
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

// Parse an Aruba chassis-temperature DisplayString into a numeric Celsius
// reading + the device's own qualitative status word, e.g.
// "Ambient Temperature 34.00 degrees Celsius (NORMAL)" -> { c: 34, status: "NORMAL" }
// "26.50 degrees Celsius (Normal)" -> { c: 26.5, status: "Normal" } (live-verified
// on both Aruba7205 and Aruba9106 hardware — the leading label is not always present).
function parseChassisTemp(raw) {
  if (raw == null) return { c: null, status: null };
  const s = String(raw);
  const numMatch = s.match(/(-?\d+(\.\d+)?)/);
  const n = numMatch ? Number(numMatch[1]) : null;
  const statusMatch = s.match(/\(([^()]+)\)\s*$/);
  return {
    c: Number.isFinite(n) ? n : null,
    status: statusMatch ? statusMatch[1].trim() : null,
  };
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
    chassis_temp:          ['1.3.6.1.4.1.14823.2.2.1.2.1.10.0'],
    last_reboot_reason:    ['1.3.6.1.4.1.14823.2.2.1.2.1.25.0'],
    reported_ap_count:     ['1.3.6.1.4.1.14823.2.2.1.5.2.1.1.0'],
    reported_client_count: ['1.3.6.1.4.1.14823.2.2.1.5.2.1.2.0'],
    // WLSX-HA-MIB (wlsxHaMIB = wlsxEnterpriseMibModules.20) — live-verified real
    // on both an Active/Standby pair (nonzero on the active member, 0 on standby)
    // and a standalone controller (nonzero, mirroring its own AP count).
    ha_active_aps:          ['1.3.6.1.4.1.14823.2.2.1.20.1.2.1.1.0'],
    ha_standby_aps:         ['1.3.6.1.4.1.14823.2.2.1.20.1.2.1.2.0'],
    ha_total_aps:           ['1.3.6.1.4.1.14823.2.2.1.20.1.2.1.3.0'],
    ha_active_vap_tunnels:  ['1.3.6.1.4.1.14823.2.2.1.20.1.5.1.1.0'],
    ha_standby_vap_tunnels: ['1.3.6.1.4.1.14823.2.2.1.20.1.5.1.2.0'],
    ha_total_vap_tunnels:   ['1.3.6.1.4.1.14823.2.2.1.20.1.5.1.3.0'],
    ha_ap_hbt_tunnels:      ['1.3.6.1.4.1.14823.2.2.1.20.1.5.1.4.0'],
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

    const found = capKeys.filter((k) => capabilities[k]).length;
    // Only persist probe_done when at least one capability OID resolved (or the
    // vendor has none to probe). A device that answered NOTHING was most likely
    // unreachable during the probe — writing probe_done=true then would freeze
    // the controller with permanently-empty capabilities, so leave it unprobed
    // and let the next cycle retry.
    if (capKeys.length > 0 && found === 0) {
      log(`[WirelessProbe] ${controller.name}: 0/${capKeys.length} capabilities resolved (unreachable?) — will retry next cycle`);
      return {};
    }
    capabilities.probe_done = true;
    await pool.query(
      'UPDATE wireless_controllers SET capabilities = $2, capabilities_probed_at = NOW() WHERE id = $1',
      [controller.id, capabilities]);

    log(`[WirelessProbe] ${controller.name}: found ${found}/${capKeys.length} capabilities`);
    return capabilities;
  } catch (e) {
    console.error(`[wireless] capability probe failed on ${controller.name}:`, e.message);
    return {};
  }
}

// Like probeControllerCapabilities, but also returns a per-capability breakdown
// (which OID resolved + the live value, and which capabilities weren't found) so
// the UI can SHOW what the controller exposes instead of probing silently.
async function probeControllerCapabilitiesDetailed(pool, controller) {
  if (!controller.snmp_device_id) {
    return { capabilities: {}, details: [], message: 'Controller is API-based — no SNMP device to probe.' };
  }
  try {
    const dq = await pool.query('SELECT * FROM monitored_devices WHERE id = $1', [controller.snmp_device_id]);
    const device = dq.rows[0];
    if (!device) return { capabilities: {}, details: [], message: 'Linked SNMP device not found.' };
    const candidates = VENDOR_OID_CANDIDATES[controller.vendor] || {};
    const capKeys = Object.keys(candidates);
    if (!capKeys.length) return { capabilities: {}, details: [], message: `No capability OIDs defined for vendor "${controller.vendor}".` };

    const capabilities = {};
    const details = [];
    const session = createSession(device, 10000);
    try {
      for (const cap of capKeys) {
        let resolvedOid = null;
        let value = null;
        for (const oid of candidates[cap]) {
          const val = await getOid(session, oid);
          if (val != null) { resolvedOid = oid; value = decodeSnmpVal(val); capabilities[cap] = oid; break; }
        }
        details.push({ capability: cap, found: !!resolvedOid, oid: resolvedOid, value, tried: candidates[cap].length });
      }
    } finally {
      try { session.close(); } catch (_e) { /* ignore */ }
    }
    // Same rule as probeControllerCapabilities: a device that resolved ZERO
    // capabilities was likely unreachable — don't persist probe_done, so the
    // next cycle retries instead of freezing empty capabilities.
    if (details.every((d) => !d.found)) {
      return { capabilities: {}, details, message: 'No capability OIDs answered (device unreachable?) — probe not persisted; it will retry.' };
    }
    capabilities.probe_done = true;
    await pool.query(
      'UPDATE wireless_controllers SET capabilities = $2, capabilities_probed_at = NOW() WHERE id = $1',
      [controller.id, capabilities]);
    return { capabilities, details };
  } catch (e) {
    return { capabilities: {}, details: [], message: e.message };
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
    chassis_temp_c: null,
    chassis_temp_status: null,
    last_reboot_reason: null,
    reported_ap_count: null,
    reported_client_count: null,
    ha_active_aps: null,
    ha_standby_aps: null,
    ha_total_aps: null,
    ha_active_vap_tunnels: null,
    ha_standby_vap_tunnels: null,
    ha_total_vap_tunnels: null,
    ha_ap_hbt_tunnels: null,
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
  if (caps.chassis_temp) {
    const raw = asStr(await getOid(session, caps.chassis_temp));
    if (raw != null) {
      const { c, status } = parseChassisTemp(raw);
      md.chassis_temp_c = c;
      md.chassis_temp_status = status;
    }
  }
  if (caps.last_reboot_reason) {
    md.last_reboot_reason = asStr(await getOid(session, caps.last_reboot_reason));
  }
  if (caps.reported_ap_count) {
    const n = await getOid(session, caps.reported_ap_count);
    if (n != null) {
      const parsed = Number(n);
      md.reported_ap_count = Number.isFinite(parsed) ? parsed : null;
    }
  }
  if (caps.reported_client_count) {
    const n = await getOid(session, caps.reported_client_count);
    if (n != null) {
      const parsed = Number(n);
      md.reported_client_count = Number.isFinite(parsed) ? parsed : null;
    }
  }
  if (caps.ha_active_aps) {
    const n = await getOid(session, caps.ha_active_aps);
    if (n != null) { const parsed = Number(n); md.ha_active_aps = Number.isFinite(parsed) ? parsed : null; }
  }
  if (caps.ha_standby_aps) {
    const n = await getOid(session, caps.ha_standby_aps);
    if (n != null) { const parsed = Number(n); md.ha_standby_aps = Number.isFinite(parsed) ? parsed : null; }
  }
  if (caps.ha_total_aps) {
    const n = await getOid(session, caps.ha_total_aps);
    if (n != null) { const parsed = Number(n); md.ha_total_aps = Number.isFinite(parsed) ? parsed : null; }
  }
  if (caps.ha_active_vap_tunnels) {
    const n = await getOid(session, caps.ha_active_vap_tunnels);
    if (n != null) { const parsed = Number(n); md.ha_active_vap_tunnels = Number.isFinite(parsed) ? parsed : null; }
  }
  if (caps.ha_standby_vap_tunnels) {
    const n = await getOid(session, caps.ha_standby_vap_tunnels);
    if (n != null) { const parsed = Number(n); md.ha_standby_vap_tunnels = Number.isFinite(parsed) ? parsed : null; }
  }
  if (caps.ha_total_vap_tunnels) {
    const n = await getOid(session, caps.ha_total_vap_tunnels);
    if (n != null) { const parsed = Number(n); md.ha_total_vap_tunnels = Number.isFinite(parsed) ? parsed : null; }
  }
  if (caps.ha_ap_hbt_tunnels) {
    const n = await getOid(session, caps.ha_ap_hbt_tunnels);
    if (n != null) { const parsed = Number(n); md.ha_ap_hbt_tunnels = Number.isFinite(parsed) ? parsed : null; }
  }

  return md;
}

// Aruba cluster/peer roster (WLSX-SYSTEMEXT-MIB) — a TABLE walk, so it doesn't fit
// the scalar VENDOR_OID_CANDIDATES capability-probe pattern above. Two candidate
// tables were checked against primary MIB text (WLSX-SYSTEMEXT-MIB.txt) and
// live-verified column-by-column on all three Aruba controllers in this
// deployment:
//   wlsxSysExtSwitchListTable  (1.3.6.1.4.1.14823.2.2.1.2.1.19) — entry cols:
//     1 sysExtSwitchIPAddress   (index, IpAddress — native 4-octet OID index)
//     2 sysExtSwitchRole        (ArubaSwitchRole:   1 master / 2 local / 3 backupmaster / 4 standalone)
//     3 sysExtSwitchLocation    (DisplayString) — live-verified populated ("Building1.floor1")
//     4 sysExtSwitchSWVersion   (DisplayString) — live-verified EMPTY on all 3 controllers, not captured
//     5 sysExtSwitchStatus      (ArubaActiveState: 1 active / 2 inactive) — populated
//     6 sysExtSwitchName        (DisplayString) — live-verified EMPTY on all 3 controllers, not captured
//     7 sysExtSwitchSerNo       (DisplayString) — live-verified EMPTY on all 3 controllers (this table)
//   wlsxNSysExtSwitchListTable (1.3.6.1.4.1.14823.2.2.1.2.1.40) — IPv4/IPv6-capable
//     successor with an extra leading index column; role/location/status are
//     identical to the table above, but ITS SerNo column (col 8) IS populated
//     live (e.g. "CS0012829") where the older table's SerNo (col 7) is empty on
//     this firmware. So the "N" table is authoritative for serial number; role/
//     location/status/ip are read from the simpler-to-parse original table.
// Result: one row per peer IP: { ip, role, status, location, serial }.
const ARUBA_SWITCH_ROLE_MAP = { '1': 'master', '2': 'local', '3': 'backupmaster', '4': 'standalone' };
const ARUBA_ACTIVE_STATE_MAP = { '1': 'active', '2': 'inactive' };

// Empty OCTET STRING columns decode to a zero-length Buffer/string on this
// firmware (verified live) — treat as "not reported", not an empty-but-real value.
function strOrNull(v) {
  const s = asStr(v);
  return s && s.length ? s : null;
}

async function pollHaPeers(session, controller) {
  if (controller.vendor !== 'aruba') return [];
  const peers = new Map(); // ip -> { ip, role, status, location, serial }
  const getPeer = (ip) => {
    if (!peers.has(ip)) peers.set(ip, { ip, role: null, status: null, location: null, serial: null });
    return peers.get(ip);
  };
  try {
    // wlsxSysExtSwitchListTable — native IpAddress index, so the OID suffix after
    // the column number IS the dotted-quad IP (4 sub-identifiers), no decoding needed.
    const base19 = '1.3.6.1.4.1.14823.2.2.1.2.1.19.1';
    const rows19 = await walk(session, base19, 200);
    for (const row of rows19) {
      if (!row.oid.startsWith(`${base19}.`)) continue;
      const parts = row.oid.slice(base19.length + 1).split('.');
      const col = parts[0];
      const ip = parts.slice(1).join('.');
      if (!ip || parts.length - 1 !== 4) continue; // expect exactly 4 octets
      const p = getPeer(ip);
      if (col === '2') p.role = ARUBA_SWITCH_ROLE_MAP[String(row.value)] || null;
      else if (col === '3') p.location = strOrNull(row.value);
      else if (col === '5') p.status = ARUBA_ACTIVE_STATE_MAP[String(row.value)] || null;
    }

    // wlsxNSysExtSwitchListTable — only used here for its populated SerNo (col 8).
    // Index is (sysExtNSwitchIPAddressType, sysExtNSwitchIPAddress): a fixed
    // Integer32 sub-identifier followed by the DisplayString IP address encoded
    // BER-in-OID as <length>.<ascii-code-per-char>. Decode that back to the
    // dotted-quad IP so it can be matched against the peers collected above.
    const base40 = '1.3.6.1.4.1.14823.2.2.1.2.1.40.1';
    const rows40 = await walk(session, base40, 200);
    for (const row of rows40) {
      if (!row.oid.startsWith(`${base40}.`)) continue;
      const parts = row.oid.slice(base40.length + 1).split('.');
      const col = parts[0];
      if (col !== '8') continue; // only need SerNo from this table
      const idx = parts.slice(1); // [addrType, len, char1, char2, ...]
      const len = parseInt(idx[1], 10);
      if (!Number.isFinite(len) || len <= 0 || idx.length - 2 !== len) continue;
      const chars = idx.slice(2, 2 + len);
      const ip = chars.map((c) => String.fromCharCode(parseInt(c, 10))).join('');
      const serial = strOrNull(row.value);
      if (!ip || !serial) continue;
      getPeer(ip).serial = serial;
    }
  } catch (_e) {
    return [];
  }
  return Array.from(peers.values());
}

// ── SNMP polling ──────────────────────────────────────────────
// Ceiling on rows per parser-column walk. Generous — the biggest legitimate
// tables are one row per AP radio (a few hundred rows on a large controller) —
// but it stops a mispointed OID (e.g. a per-client table) from walking tens of
// thousands of varbinds every poll cycle.
const PARSER_WALK_ROW_CAP = 5000;

// Wall-clock budget for a single real per-controller SNMP poll. Generous — well
// under the STALE_AP_MINUTES (15 min) age-out window so it never fires in normal
// operation. It only trips a slow-but-alive controller, so a truncated poll can't
// overrun the stale window and mass-age-out APs it simply hadn't reached yet.
const POLL_DEADLINE_MS = 8 * 60 * 1000; // 480000 ms

// Walk every OID a parser declares and group varbinds by the parser's logical
// key → { key: [ { oid, value } ... ] }, exactly what parseApTable() expects.
// pastDeadline (optional) is checked BETWEEN sequential column walks (same
// granularity as debugWalk): if it trips, we stop and return the partial walk
// gathered so far, logging how far we got. Un-reached APs are simply absent from
// the result — they are never marked fresh or downed by a truncated poll.
async function walkParserOids(session, parser, controller, pastDeadline) {
  const walked = {};
  const keys = Object.keys(parser.snmpOids);
  for (let i = 0; i < keys.length; i++) {
    if (pastDeadline && pastDeadline()) {
      console.warn(`[wireless] poll deadline reached on ${controller ? controller.name : '?'} (id=${controller ? controller.id : '?'}) after ${i}/${keys.length} OID columns — returning partial walk; un-reached APs left untouched (not aged out / downed)`);
      break;
    }
    walked[keys[i]] = await walk(session, parser.snmpOids[keys[i]], PARSER_WALK_ROW_CAP);
  }
  return walked;
}

// Walk a parser's rogue-AP OID set (parser.snmpRogueOids) the same way as
// walkParserOids, grouping varbinds by logical key. Returns {} on any failure
// so a controller that doesn't expose the rogue table never breaks the poll.
async function walkRogueOids(session, parser) {
  const walked = {};
  try {
    for (const key of Object.keys(parser.snmpRogueOids)) {
      try { walked[key] = await walk(session, parser.snmpRogueOids[key], PARSER_WALK_ROW_CAP); }
      catch (_e) { walked[key] = []; }
    }
  } catch (_e) { return {}; }
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
  // Wall-clock deadline for this poll — a slow-but-alive controller must not
  // overrun the stale-AP window (see POLL_DEADLINE_MS). Checked inside
  // walkParserOids between OID-column walks, mirroring debugWalk's pastDeadline.
  const pollStartedAt = Date.now();
  const pastDeadline = () => (Date.now() - pollStartedAt) >= POLL_DEADLINE_MS;
  try {
    // Fail-fast reachability pre-flight: walk()/get() never reject, so a dead
    // controller would otherwise burn one timeout per parser walk (~22 walks ×
    // up to 20s ≈ minutes, risking poll-cycle overrun of the 15-min stale-AP
    // age-out) and then look like a healthy "0 AP" poll. One scalar GET bounds
    // the cost of a dead controller to a single timeout.
    const preflight = await get(session, [OID.sysUpTime]);
    if (!preflight || preflight.length === 0) {
      throw new Error('SNMP unreachable (no response to sysUpTime)');
    }

    const walked = await walkParserOids(session, parser, controller, pastDeadline);
    const aps = parser.parseApTable(walked) || [];
    // Per-SSID stats are optional — only some vendor parsers implement parseSsids.
    let ssids = [];
    if (typeof parser.parseSsids === 'function') {
      try { ssids = parser.parseSsids(walked) || []; } catch (_e) { ssids = []; }
    }
    // Visibility: parsers swallow all errors and walks return [] on failure, so
    // a wrong OID set otherwise fails SILENTLY (plausible-but-empty data). One
    // line per poll makes a dead vendor OID set obvious in the collector log.
    const walkedRows = Object.values(walked).reduce((s, rows) => s + (rows ? rows.length : 0), 0);
    log(`${controller.name}: walked ${walkedRows} varbinds → parsed ${aps.length} APs, ${ssids.length} SSIDs`);
    // Defense-in-depth behind the pre-flight: the controller answered at first
    // but every parser walk still came back empty — re-probe before reporting
    // an "ok, 0 AP / 0 SSID" poll (a controller that died mid-poll would
    // otherwise be marked status='ok' and have its metadata wiped with NULLs).
    if (aps.length === 0 && ssids.length === 0) {
      const probe = await get(session, [OID.sysUpTime]);
      if (!probe || probe.length === 0) {
        throw new Error('SNMP unreachable (no response to sysUpTime)');
      }
    }
    // Rogue/unmanaged APs are optional — only some vendor parsers declare the
    // rogue OID set + parseRogueAps. Failures here never affect AP/SSID polling.
    let rogues = [];
    if (parser.snmpRogueOids && typeof parser.parseRogueAps === 'function') {
      let rogueWalked = {};
      try { rogueWalked = await walkRogueOids(session, parser); } catch (_e) { rogueWalked = {}; }
      try { rogues = parser.parseRogueAps(rogueWalked) || []; } catch (_e) { rogues = []; }
    }
    let metadata = {};
    try { metadata = await pollControllerMetadata(session, controller); }
    catch (_e) { metadata = {}; }
    // Cluster/peer roster (Aruba only) — a table walk, isolated from metadata so
    // a failure here never affects the scalar metadata above. Never throws.
    let haPeers = [];
    try { haPeers = await pollHaPeers(session, controller); }
    catch (_e) { haPeers = []; }
    return { aps, ssids, rogues, metadata, haPeers };
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

// ── API polling ───────────────────────────────────────────────
// `pool` is passed through so an API client can persist rotated OAuth tokens
// (see wireless/api/aruba-central.js) — it must PERSIST a refreshed token
// before using it, so it needs a live DB handle, not just the controller row.
async function pollApiController(controller, pool) {
  const client = apiClients[controller.vendor];
  if (!client) throw new Error(`no wireless API client for vendor "${controller.vendor}"`);
  const result = (await client.poll(controller, pool)) || [];
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
// (keyed by controller_id::<parser _index or name> — the parser index is the AP
// MAC where available, so two APs sharing a duplicate name can't corrupt each
// other's deltas). { key -> { rx, tx, t(ms) } }
const prevCounters = new Map();

// Separate Map + prune cadence for per-CLIENT counters. Clients poll on their
// own, slower interval (CLIENT_POLL_INTERVAL, currently 10 min) than APs
// (WIRELESS_POLL_INTERVAL, 5 min) — reusing prevCounters would have it pruned
// by the AP loop's 5-min-interval sweep (evicting anything idle 3*5=15 min).
// When CLIENT_POLL_INTERVAL was originally 15 min, that AP-side prune window
// landed exactly on a client's own poll period, so a client's entry could be
// evicted moments before its own next poll needed it, making rx_bps/tx_bps
// unreliably null — a dedicated Map pruned on the CLIENT interval avoids that
// race regardless of how the two intervals relate going forward.
const prevClientCounters = new Map();

// Sustained-high-bandwidth client alerting — see raiseClientBandwidthAlert/
// resolveClientBandwidthAlert in collector.js (injected here as `alertHooks`,
// see startWirelessCollector below) for the alert-row plumbing. 500 Mbps
// sustained on a SINGLE client is deliberately generous: real-world sustained
// single-client throughput essentially never approaches even Wi-Fi 6's
// theoretical link-layer max (~9.6 Gbps) in practice, let alone the fraction
// of that one station could realistically sustain — this is meant to catch a
// genuinely abnormal sustained transfer (compromised host, runaway backup/
// sync job, etc.), not to flag "this client looks a bit busy". Comfortably
// inside deriveThroughput()'s own MAX_SANE_BPS cap (2 Gbps) above, so a real
// breach is never itself squashed as an implausible reading.
const CLIENT_BANDWIDTH_THRESHOLD_BPS = 500_000_000;
// Consecutive-poll breach counter, keyed the same way as prevClientCounters
// (`${controller.id}::${mac}`). A single poll over threshold (e.g. one large
// file transfer) must not raise an alert — this requires TWO consecutive
// polls over threshold first (simple in-memory debounce; a restart just
// resets the count, delaying a raise by at most one extra poll, never causing
// a false one). Entries are deleted as soon as a client drops back under
// threshold or disconnects, so this stays bounded to currently-breaching
// clients rather than growing over the life of the process.
const clientBandwidthBreaches = new Map();

// Wrap-aware delta between two cumulative counter readings, UNIT-AGNOSTIC (no
// sanity cap, no rate conversion — just the raw delta in whatever unit cur/prev
// are). A decrease from a value still inside 32-bit range is most likely a
// Counter32 wrap (4.3 billion — minutes on a busy AP for a byte counter, much
// longer for a packet-error counter), so return the wrapped delta; a decrease
// from a value at/above that range is a genuine counter reset (null, sample
// skipped). Shared by counterDeltaBps (bandwidth, bits/sec) below and
// errorCountDelta (error packets/sec, see deriveErrorDeltas) — each caller
// converts to its own unit and applies its own unit-appropriate sanity cap.
const COUNTER32_WRAP = 2 ** 32;
function wrapAwareDelta(cur, prev, counterBits) {
  if (cur === null || prev === null) return null;
  if (cur >= prev) return cur - prev;
  if (counterBits !== 64 && prev < COUNTER32_WRAP) return cur + COUNTER32_WRAP - prev;
  return null;
}

// Delta between two cumulative byte-counter readings, converted to bits/sec.
const MAX_SANE_BPS = 2e9;
function counterDeltaBps(cur, prev, elapsed, counterBits) {
  const delta = wrapAwareDelta(cur, prev, counterBits);
  if (delta == null) return null;
  // The MAX_SANE_BPS cap below was previously applied only on the wrap-
  // recovery branch (a wrapped Counter32 producing an implausible rate is
  // easy to hit deliberately). The "normal" cur>=prev branch had no such
  // cap at all — in practice a transient timing artifact around a collector
  // restart (prevCounters/prevClientCounters is in-memory only, so any
  // restart mid-cycle can leave `elapsed` abnormally small relative to a
  // real byte delta) produced a one-off multi-hundred-Gbps client bandwidth
  // reading that looked absurd on the wireless page before self-correcting
  // on the next clean poll. Apply the same sanity cap regardless of which
  // branch produced the delta, rather than relying on every future timing
  // edge case to self-correct on its own.
  const bps = Math.round((delta * 8) / elapsed);
  return bps < MAX_SANE_BPS ? bps : null;
}

// Delta between two cumulative error-packet-counter readings, in packets/sec.
// Sanity cap mirrors counterDeltaBps's MAX_SANE_BPS guard against the same
// collector-restart timing artifact (abnormally small `elapsed` vs a real
// delta) — 10M error packets/sec is comfortably above any physically
// plausible sustained AP frame-error rate, so a spurious huge delta from a
// bad `elapsed` reading is rejected (null) rather than shown as a spike.
const MAX_SANE_ERR_PKTS_PER_SEC = 10_000_000;
function errorCountDelta(cur, prev, elapsed, counterBits) {
  const delta = wrapAwareDelta(cur, prev, counterBits);
  if (delta == null) return null;
  return (delta / elapsed) < MAX_SANE_ERR_PKTS_PER_SEC ? delta : null;
}

// Derive throughput in BITS per second from cumulative byte counters.
// Returns { inBps, outBps } (either may be null when there is no usable delta,
// e.g. first poll, counter reset/wrap, or the vendor did not expose the counter).
// `map` selects which prevCounters store to read/write from — pass prevCounters
// for APs, prevClientCounters for clients (see the comment on prevClientCounters
// for why they must not share one Map/prune cadence).
function deriveThroughput(map, key, curRx, curTx, nowMs, counterBits) {
  let inBps = null;
  let outBps = null;
  const prev = map.get(key);
  if (prev) {
    const elapsed = (nowMs - prev.t) / 1000;
    if (elapsed > 0) {
      inBps = counterDeltaBps(curRx, prev.rx, elapsed, counterBits);
      outBps = counterDeltaBps(curTx, prev.tx, elapsed, counterBits);
    }
  }
  // Only remember a reading when at least one counter is present.
  if (curRx !== null || curTx !== null) {
    map.set(key, { rx: curRx, tx: curTx, t: nowMs });
  }
  return { inBps, outBps };
}

// Error-packet counters mirror the throughput-counter pattern above (cumulative
// SNMP counter -> per-poll delta), but are kept in their OWN Map rather than
// reusing prevCounters: prevCounters' entry shape is a single { rx, tx, t }
// throughput reading, while an AP reports FOUR independent error counters
// (rx/tx x 2g/5g) — folding them into the same entry would make prevCounters'
// shape ambiguous between "byte reading" and "error-packet reading". Same key
// format (`${controller.id}::${ap._index || name}`) and pruned on the same
// AP-poll cadence via prunePrevCounters (see pollAll), so its lifecycle exactly
// mirrors prevCounters.
const prevErrorCounters = new Map();

// Derive a per-poll error-packet delta for one AP's four error counters
// (rx/tx x 2g/5g). Returns { rxErr2g, txErr2g, rxErr5g, txErr5g }, each null
// when there is no usable delta — first poll for this AP (no previous reading
// yet), a counter reset, or the vendor not exposing that counter — mirroring
// deriveThroughput's null-on-first-poll behavior. Error counters are ordinary
// SNMP Counter32s on every vendor parser that reports them (see cisco.js/
// aruba.js — FCS error counts, not high-capacity 64-bit interface counters),
// so counterBits is always treated as 32.
function deriveErrorDeltas(key, curRxErr2g, curTxErr2g, curRxErr5g, curTxErr5g, nowMs) {
  const prev = prevErrorCounters.get(key);
  let rxErr2g = null, txErr2g = null, rxErr5g = null, txErr5g = null;
  if (prev) {
    const elapsed = (nowMs - prev.t) / 1000;
    if (elapsed > 0) {
      rxErr2g = errorCountDelta(curRxErr2g, prev.rxErr2g, elapsed, 32);
      txErr2g = errorCountDelta(curTxErr2g, prev.txErr2g, elapsed, 32);
      rxErr5g = errorCountDelta(curRxErr5g, prev.rxErr5g, elapsed, 32);
      txErr5g = errorCountDelta(curTxErr5g, prev.txErr5g, elapsed, 32);
    }
  }
  // Only remember a reading when at least one counter is present.
  if (curRxErr2g !== null || curTxErr2g !== null || curRxErr5g !== null || curTxErr5g !== null) {
    prevErrorCounters.set(key, { rxErr2g: curRxErr2g, txErr2g: curTxErr2g, rxErr5g: curRxErr5g, txErr5g: curTxErr5g, t: nowMs });
  }
  return { rxErr2g, txErr2g, rxErr5g, txErr5g };
}

// Evict entries not refreshed for 3+ poll cycles (APs/clients that were
// renamed, removed, or whose controller was deleted) so the Map can't grow
// without bound over months of churn. Call with prevCounters + the AP interval
// from the AP poll cycle, and with prevClientCounters + the client interval
// from the client poll cycle — each Map must be pruned on ITS OWN cadence.
function prunePrevCounters(map, nowMs, intervalMs) {
  const cutoff = nowMs - 3 * intervalMs;
  for (const [key, entry] of map) {
    if (entry.t < cutoff) map.delete(key);
  }
}

// clientBandwidthBreaches (see the comment above CLIENT_BANDWIDTH_THRESHOLD_BPS)
// is normally kept bounded by the "clients that left" loop in pollClients, which
// deletes an entry as soon as a client disconnects or drops back under
// threshold. But that loop only runs from a controller's OWN poll — if a
// wireless_controllers row is deleted/deactivated while one of its clients has
// an in-flight breach count, pollClients never runs for it again and that
// entry leaks for the life of the process. This is a membership-based sweep
// (not age-based like prunePrevCounters above, since a legitimately-still-
// breaching client's entry must never be pruned just for being "old"): call
// once per client poll cycle with the set of controller ids that are still
// active, and drop any entry whose `${controllerId}::${mac}` key's controller
// isn't in that set.
function pruneBreachesForInactiveControllers(activeControllerIds) {
  for (const key of clientBandwidthBreaches.keys()) {
    const controllerId = key.slice(0, key.indexOf('::'));
    if (!activeControllerIds.has(controllerId)) clientBandwidthBreaches.delete(key);
  }
}

// Upsert one AP (keyed by controller_id + name) and append a history sample.
// Decimal-MAC AP name guard (e.g. "108.196.159.202.125.210"). Aruba's parser
// already rejects these, but this protects the shared write path for ALL vendors.
const DECIMAL_MAC_RE = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;

async function upsertAp(pool, controller, ap) {
  // Resolve the row name FIRST (mac/ip fallback for API vendors that report
  // nameless APs), THEN validate — an all-null identity or a decimal-MAC name
  // (a bad SNMP parse) is skipped before any DB write.
  const name = ap.name || ap.mac_address || ap.ip_address || null;
  if (!name) {
    console.log('[wireless] skipped AP with no name/mac/ip from controller', controller.id);
    return;
  }
  if (DECIMAL_MAC_RE.test(name)) {
    console.log('[wireless] skipped decimal-MAC AP:', name);
    return;
  }
  const monitoredId = await matchMonitoredDevice(pool, ap);
  const clientsTotal = intOrNull(ap.clients_total) || 0;
  const clients2g = intOrNull(ap.clients_2g) || 0;
  const clients5g = intOrNull(ap.clients_5g) || 0;
  const clients6g = intOrNull(ap.clients_6g) || 0;

  // Keyed by the parser's stable _index (the AP MAC) when present, so duplicate
  // AP names on one controller can't interleave counters into bogus deltas.
  // Shared by both the throughput delta (bandwidth) and the error-count delta
  // (below) — same AP, same poll cycle, same identity.
  const counterKey = `${controller.id}::${ap._index != null ? ap._index : name}`;
  const pollTime = Date.now();

  // Convert cumulative rx/tx byte counters into a per-poll bits/sec rate.
  const { inBps, outBps } = deriveThroughput(
    prevCounters, counterKey,
    numOrNull(ap.rx_bytes), numOrNull(ap.tx_bytes), pollTime, ap.byte_counter_bits);

  // Convert cumulative rx/tx error-packet counters into a per-poll delta (see
  // deriveErrorDeltas for why this uses its own Map rather than prevCounters).
  // rx_errors_2g/tx_errors_2g/rx_errors_5g/tx_errors_5g on the row stay the raw
  // lifetime totals (unchanged, still useful as a "since last reboot" diagnostic)
  // — these deltas are additive columns, not a replacement.
  const { rxErr2g: rxErrDelta2g, txErr2g: txErrDelta2g, rxErr5g: rxErrDelta5g, txErr5g: txErrDelta5g } =
    deriveErrorDeltas(
      counterKey, intOrNull(ap.rx_errors_2g), intOrNull(ap.tx_errors_2g),
      intOrNull(ap.rx_errors_5g), intOrNull(ap.tx_errors_5g), pollTime);

  const noise2g = intOrNull(ap.noise_floor_2g);
  const noise5g = intOrNull(ap.noise_floor_5g);
  const authFailures = intOrNull(ap.auth_failures);

  // $1..$42 — the full ordered column value set, written identically by the
  // INSERT and by the (site_id, name) in-place UPDATE below. Keep this array and
  // both column lists in lock-step so no field is ever dropped from a write.
  const vals = [
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
    numOrNull(ap.interference_pct_2g), numOrNull(ap.interference_pct_5g),
    intOrNull(ap.reboot_count), intOrNull(ap.bootstrap_count),
    rxErrDelta2g, txErrDelta2g, rxErrDelta5g, txErrDelta5g,
  ];

  let apId = null;

  // Stable physical identity is the AP `name` within its `site_id` — mac_address
  // and serial_number are NULL on this feed, so they can't anchor identity. When
  // site_id is known, match on (site_id, name): if a row already exists, UPDATE it
  // in place (keeping its id, so wireless_history stays continuous) and point
  // controller_id at whoever reports the AP NOW. This collapses the duplicate that
  // an HA failover/sync otherwise creates under the peer controller's id. The
  // existing per-(controller_id, name) ON CONFLICT below is the INSERT fallback.
  if (controller.site_id != null) {
    const existing = await pool.query(
      `SELECT id FROM wireless_aps WHERE site_id = $1 AND name = $2 LIMIT 1`,
      [controller.site_id, name]);
    if (existing.rows[0]) {
      const u = await pool.query(`
        UPDATE wireless_aps SET
          controller_id       = $1,
          monitored_device_id = $2,
          name                = $3,
          mac_address         = $4,
          model               = $5,
          ip_address          = $6,
          site_id             = $7,
          site_name           = $8,
          status              = $9,
          radio_2g_channel    = $10,
          radio_5g_channel    = $11,
          radio_6g_channel    = $12,
          radio_2g_util_pct   = $13,
          radio_5g_util_pct   = $14,
          clients_2g          = $15,
          clients_5g          = $16,
          clients_6g          = $17,
          clients_total       = $18,
          tx_power_2g         = $19,
          tx_power_5g         = $20,
          uptime_seconds      = $21,
          firmware_version    = $22,
          noise_floor_2g      = $23,
          noise_floor_5g      = $24,
          retry_rate_2g       = $25,
          retry_rate_5g       = $26,
          rx_errors_2g        = $27,
          tx_errors_2g        = $28,
          rx_errors_5g        = $29,
          tx_errors_5g        = $30,
          throughput_in_bps   = $31,
          throughput_out_bps  = $32,
          serial_number       = $33,
          auth_failures       = $34,
          interference_pct_2g = $35,
          interference_pct_5g = $36,
          reboot_count        = $37,
          bootstrap_count     = $38,
          rx_errors_delta_2g  = $39,
          tx_errors_delta_2g  = $40,
          rx_errors_delta_5g  = $41,
          tx_errors_delta_5g  = $42,
          last_seen_at        = NOW(),
          updated_at          = NOW()
        WHERE id = $43
        RETURNING id
      `, [...vals, existing.rows[0].id]);
      apId = u.rows[0].id;
    }
  }

  // INSERT when there is no (site_id, name) match, OR when site_id IS NULL — in
  // the null-site case we keep the original per-(controller_id, name) upsert so we
  // never wrongly merge two distinct site-less APs from different controllers.
  if (apId == null) {
    const r = await pool.query(`
      INSERT INTO wireless_aps
        (controller_id, monitored_device_id, name, mac_address, model, ip_address,
         site_id, site_name, status, radio_2g_channel, radio_5g_channel, radio_6g_channel,
         radio_2g_util_pct, radio_5g_util_pct, clients_2g, clients_5g, clients_6g, clients_total,
         tx_power_2g, tx_power_5g, uptime_seconds, firmware_version,
         noise_floor_2g, noise_floor_5g, retry_rate_2g, retry_rate_5g,
         rx_errors_2g, tx_errors_2g, rx_errors_5g, tx_errors_5g,
         throughput_in_bps, throughput_out_bps, serial_number, auth_failures,
         interference_pct_2g, interference_pct_5g, reboot_count, bootstrap_count,
         rx_errors_delta_2g, tx_errors_delta_2g, rx_errors_delta_5g, tx_errors_delta_5g,
         last_seen_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
              $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,NOW(),NOW())
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
        interference_pct_2g = EXCLUDED.interference_pct_2g,
        interference_pct_5g = EXCLUDED.interference_pct_5g,
        reboot_count     = EXCLUDED.reboot_count,
        bootstrap_count  = EXCLUDED.bootstrap_count,
        rx_errors_delta_2g = EXCLUDED.rx_errors_delta_2g,
        tx_errors_delta_2g = EXCLUDED.tx_errors_delta_2g,
        rx_errors_delta_5g = EXCLUDED.rx_errors_delta_5g,
        tx_errors_delta_5g = EXCLUDED.tx_errors_delta_5g,
        last_seen_at     = NOW(),
        updated_at       = NOW()
      RETURNING id
    `, vals);
    apId = r.rows[0].id;
  }
  await pool.query(`
    INSERT INTO wireless_history
      (ap_id, clients_total, clients_2g, clients_5g, radio_2g_util, radio_5g_util,
       noise_floor_2g, noise_floor_5g, throughput_in_bps, throughput_out_bps, auth_failures,
       retry_rate_2g, retry_rate_5g, interference_pct_2g, interference_pct_5g)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `, [apId, clientsTotal, clients2g, clients5g, numOrNull(ap.radio_2g_util_pct), numOrNull(ap.radio_5g_util_pct),
      noise2g, noise5g, inBps, outBps, authFailures,
      numOrNull(ap.retry_rate_2g), numOrNull(ap.retry_rate_5g),
      numOrNull(ap.interference_pct_2g), numOrNull(ap.interference_pct_5g)]);

  return apId;
}

// Upsert one SSID stat row (keyed by controller_id + ssid_name).
async function upsertSsid(pool, controller, ssid) {
  const name = ssid.ssid_name;
  if (!name) return;
  await pool.query(`
    INSERT INTO wireless_ssids
      (controller_id, ssid_name, site_id, site_name, status,
       clients_total, bytes_in, bytes_out, auth_successes, auth_failures, encryption_type, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (controller_id, ssid_name) DO UPDATE SET
      site_id        = EXCLUDED.site_id,
      site_name      = EXCLUDED.site_name,
      status         = EXCLUDED.status,
      clients_total  = EXCLUDED.clients_total,
      bytes_in       = EXCLUDED.bytes_in,
      bytes_out      = EXCLUDED.bytes_out,
      auth_successes = EXCLUDED.auth_successes,
      auth_failures  = EXCLUDED.auth_failures,
      encryption_type = EXCLUDED.encryption_type,
      updated_at     = NOW()
  `, [
    controller.id, name, controller.site_id || null, controller.site_name || null,
    ssid.status || 'up', intOrNull(ssid.clients_total) || 0,
    intOrNull(ssid.bytes_in), intOrNull(ssid.bytes_out),
    intOrNull(ssid.auth_successes) || 0, intOrNull(ssid.auth_failures) || 0,
    ssid.encryption_type || null,
  ]);
}

// Upsert one rogue AP (keyed by controller_id + bssid) into wireless_rogue_aps.
// Skips rows with no bssid. Wrapped so a missing table (un-migrated DB) is fine.
async function upsertRogueAp(pool, controller, rogue) {
  const bssid = rogue && rogue.bssid ? String(rogue.bssid) : null;
  if (!bssid) return;
  try {
    await pool.query(`
      INSERT INTO wireless_rogue_aps
        (controller_id, bssid, ssid, rssi_dbm, channel, classification, detecting_ap, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (controller_id, bssid) DO UPDATE SET
        ssid           = EXCLUDED.ssid,
        rssi_dbm       = EXCLUDED.rssi_dbm,
        channel        = EXCLUDED.channel,
        classification = EXCLUDED.classification,
        detecting_ap   = EXCLUDED.detecting_ap,
        last_seen_at   = NOW()
    `, [
      controller.id, bssid, rogue.ssid || null,
      intOrNull(rogue.rssi_dbm), intOrNull(rogue.channel),
      rogue.classification || null, rogue.detecting_ap || null,
    ]);
  } catch (e) {
    // Missing table on an un-migrated DB (or any write error) is non-fatal.
    console.error(`[wireless] rogue upsert failed on ${controller.name}:`, e.message);
  }
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
    let rogues = [];
    let metadata = {};
    let haPeers = [];
    if (controller.snmp_device_id) {
      // One-time capability discovery: probe OIDs once, then reuse stored OIDs.
      if (!controller.capabilities || !controller.capabilities.probe_done) {
        await probeControllerCapabilities(pool, controller);
        const rq = await pool.query('SELECT * FROM wireless_controllers WHERE id = $1', [controller.id]);
        if (rq.rows[0]) controller = rq.rows[0];
      }
      ({ aps, ssids, rogues = [], metadata = {}, haPeers = [] } = await pollSnmpController(pool, controller));
    } else if (controller.controller_url) {
      ({ aps, ssids } = await pollApiController(controller, pool));
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

    // Rogue/unmanaged APs (SNMP controllers only — pollApiController returns none).
    for (const rogue of rogues) {
      await upsertRogueAp(pool, controller, rogue);
    }
    // Prune rogues not heard from in 24h so the table reflects current detections.
    try {
      await pool.query(
        `DELETE FROM wireless_rogue_aps WHERE controller_id = $1 AND last_seen_at < NOW() - INTERVAL '24 hours'`,
        [controller.id]);
    } catch (_e) { /* missing table on un-migrated DB — ignore */ }

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
    // COALESCE keeps the stored value when this poll's metadata field is NULL —
    // a partial poll (capability OID timed out / not exposed) must never wipe
    // known-good model/firmware/license/HA info.
    //
    // ha_peers is the one exception: it is ALWAYS overwritten, not COALESCEd,
    // mirroring the existing ap_disconnects_24h precedent just above — a fresh
    // empty array from a poll that reached this point (the SNMP session already
    // answered; see the pre-flight/re-probe checks above) means "no peers
    // reported this cycle" (e.g. a non-master cluster member, per the MIB's own
    // "valid only when queried from the master controller" note), which is a
    // real, meaningful result, not a partial-failure signal to mask with
    // COALESCE. A poll that fails outright never reaches this UPDATE at all
    // (see the catch block below), so ha_peers is left untouched in that case.
    await pool.query(
      `UPDATE wireless_controllers SET last_polled_at = NOW(), status = 'ok', last_error = NULL,
         model                 = COALESCE($2, model),
         firmware_version      = COALESCE($3, firmware_version),
         licensed_aps          = COALESCE($4, licensed_aps),
         ha_mode               = COALESCE($5, ha_mode),
         ha_peer_ip            = COALESCE($6, ha_peer_ip),
         ha_sync_status        = COALESCE($7, ha_sync_status),
         ap_disconnects_24h    = $8,
         chassis_temp_c        = COALESCE($9, chassis_temp_c),
         chassis_temp_status   = COALESCE($10, chassis_temp_status),
         last_reboot_reason    = COALESCE($11, last_reboot_reason),
         reported_ap_count     = COALESCE($12, reported_ap_count),
         reported_client_count = COALESCE($13, reported_client_count),
         ha_active_aps          = COALESCE($14, ha_active_aps),
         ha_standby_aps         = COALESCE($15, ha_standby_aps),
         ha_total_aps           = COALESCE($16, ha_total_aps),
         ha_active_vap_tunnels  = COALESCE($17, ha_active_vap_tunnels),
         ha_standby_vap_tunnels = COALESCE($18, ha_standby_vap_tunnels),
         ha_total_vap_tunnels   = COALESCE($19, ha_total_vap_tunnels),
         ha_ap_hbt_tunnels      = COALESCE($20, ha_ap_hbt_tunnels),
         ha_peers               = $21::jsonb
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
        md.chassis_temp_c ?? null,
        md.chassis_temp_status ?? null,
        md.last_reboot_reason ?? null,
        md.reported_ap_count ?? null,
        md.reported_client_count ?? null,
        md.ha_active_aps ?? null,
        md.ha_standby_aps ?? null,
        md.ha_total_aps ?? null,
        md.ha_active_vap_tunnels ?? null,
        md.ha_standby_vap_tunnels ?? null,
        md.ha_total_vap_tunnels ?? null,
        md.ha_ap_hbt_tunnels ?? null,
        JSON.stringify(haPeers || []),
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
// Wireless AP poll cadence (mirrors the setInterval in startWirelessCollector).
const WIRELESS_POLL_INTERVAL = 5 * 60 * 1000;
// Mark an AP offline once it hasn't been reported for 3 poll cycles (15 min):
// long enough to ride out a single missed/slow poll, short enough that an AP that
// failed over away or whose controller went down flips to offline instead of
// lingering as a false "online" forever. APs updated this cycle have
// last_seen_at = NOW(), so they're naturally excluded.
const STALE_AP_MINUTES = Math.round((3 * WIRELESS_POLL_INTERVAL) / 60000);

// One guarded UPDATE per cycle: flip stale APs to offline. Never throws.
async function ageOutStaleAps(pool) {
  try {
    const r = await pool.query(
      `UPDATE wireless_aps SET status = 'offline', updated_at = NOW()
        WHERE last_seen_at < NOW() - make_interval(mins => $1)
          AND status <> 'offline'`,
      [STALE_AP_MINUTES]);
    if (r.rowCount) {
      log(`aged out ${r.rowCount} stale AP(s) to offline (no poll in ${STALE_AP_MINUTES} min)`);
    }
  } catch (err) {
    console.error('[wireless] stale AP aging failed:', err.message);
  }
}

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
    // Flip no-longer-reported APs to offline so a failed-over-away / down-controller
    // AP doesn't stay a false "online".
    await ageOutStaleAps(pool);
    prunePrevCounters(prevCounters, Date.now(), WIRELESS_POLL_INTERVAL);
    prunePrevCounters(prevErrorCounters, Date.now(), WIRELESS_POLL_INTERVAL);
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

  const PER_TREE_CAP = 60;          // rows shown per tree in the response
  const WALK_ROW_CAP = 300;         // rows actually walked per tree (bounds SNMP time on huge tables)
  const DEBUG_WALK_DEADLINE_MS = 25000; // overall wall-clock budget — must beat the frontend proxy timeout
  const startedAt = Date.now();
  const skipped = [];
  const pastDeadline = () => (Date.now() - startedAt) >= DEBUG_WALK_DEADLINE_MS;
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

  let session;
  const out = {
    ok: true, vendor: controller.vendor, device_ip: device.ip_address,
    parser_oids: {}, subtrees: {}, essid_table: {}, metadata_probe: {},
  };
  try {
    // createSession can throw synchronously (e.g. net-snmp v3 with malformed
    // credentials), so build it INSIDE the try — a throw becomes ok:false here.
    session = createSession(device, 3000); // snappy: a dead OID costs ~6s (1 retry), not 24s
    // 0) Controller-metadata scalar probes (best-effort; capped to the small map).
    for (const [label, oid] of Object.entries(metadataOids)) {
      if (pastDeadline()) { skipped.push(`metadata:${label}`); continue; }
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
        if (pastDeadline()) { skipped.push(`parser:${key}`); continue; }
        const rows = await walk(session, oid, WALK_ROW_CAP);
        out.parser_oids[key] = {
          oid,
          count: rows.length,
          truncated: rows.length >= WALK_ROW_CAP,
          sample: rows.slice(0, 5).map((r) => ({ oid: r.oid, value: decodeSnmpVal(r.value) })),
        };
      }
    }
    // 2) Ground-truth discovery walks of the broad parent subtrees.
    for (const [key, base] of Object.entries(subtrees)) {
      if (pastDeadline()) { skipped.push(key); continue; }
      const rows = await walk(session, base, WALK_ROW_CAP);
      out.subtrees[key] = {
        base,
        count: rows.length,
        truncated: rows.length > PER_TREE_CAP,
        sample: rows.slice(0, PER_TREE_CAP).map((r) => ({ oid: r.oid, value: decodeSnmpVal(r.value) })),
      };
    }
    // 3) Per-OID ESSID candidate comparison — raw row count from each attempt.
    for (const [label, base] of Object.entries(essidCandidates)) {
      if (pastDeadline()) { skipped.push(`essid:${label}`); continue; }
      const rows = await walk(session, base, WALK_ROW_CAP);
      out.essid_table[label] = {
        base,
        count: rows.length,
        truncated: rows.length >= WALK_ROW_CAP,
        sample: rows.slice(0, 12).map((r) => ({ oid: r.oid, value: decodeSnmpVal(r.value) })),
      };
    }
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  } finally {
    try { if (session) session.close(); } catch (_e) { /* ignore */ }
  }
  out.timed_out = skipped.length > 0;
  out.skipped = skipped;
  out.duration_ms = Date.now() - startedAt;
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
  let session;
  try {
    session = createSession(device, 12000); // can throw synchronously (v3) — keep inside try
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
    try { if (session) session.close(); } catch (_e) { /* ignore */ }
  }
}

// ── Client-level troubleshooting (Tier 1) ─────────────────────
// Poll a controller's associated clients (SNMP), detect roam/join/leave/
// low-signal events vs the previous snapshot, upsert the current client set,
// and prune stale clients + old events. Never throws; a client-poll failure is
// isolated and never affects AP polling.
// `alertHooks` (optional — { raise(mac, controllerId, siteId, message), resolve(mac,
// controllerId) }) is how wireless_client_bandwidth_high alerts get raised/resolved;
// see the CLIENT_BANDWIDTH_THRESHOLD_BPS comment above and startWirelessCollector
// below for why it's injected rather than required from collector.js directly.
async function pollClients(pool, controller, apList, alertHooks) {
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

  // Previous snapshot for roaming/leave detection. Also carries the persisted
  // byte-counter baseline (rx_bytes_raw/tx_bytes_raw/byte_counter_bits/
  // bw_sampled_at) so a collector restart can resume computing rx_bps/tx_bps
  // from the LAST poll instead of losing the in-memory prevClientCounters
  // baseline and going blank for a full extra poll cycle — see the seeding
  // step right before the upsert loop below.
  // byte_counter_bits is intentionally NOT selected here: the warm-start seed
  // below only carries rx/tx/t into prevClientCounters (see deriveThroughput's
  // `map` param), and every poll — warm-started or not — always uses the
  // CURRENT live poll's client.byte_counter_bits from the vendor parser, never
  // a value threaded through this Map. See the schema.sql comment on this
  // column for the same clarification.
  const prev = await pool.query(
    `SELECT mac_address, ap_id, ap_name, rssi_dbm,
            rx_bytes_raw, tx_bytes_raw, bw_sampled_at
       FROM wireless_clients WHERE controller_id = $1`,
    [controller.id]);
  const prevMap = new Map(prev.rows.map((c) => [c.mac_address, c]));

  // Warm-start prevClientCounters from the DB-persisted baseline for any
  // client this in-memory process has no entry for yet (a fresh collector
  // process — every restart clears the Map, but not the DB). Only seeds when
  // BOTH raw counters were actually persisted (an older row from before this
  // feature existed, or a vendor/firmware with no byte-counter support at
  // all, correctly stays unseeded — deriveThroughput() already treats "no
  // prev entry" as "first sample, no rate yet" exactly as intended).
  const clientCounterKey = (mac) => `${controller.id}::${mac}`;
  for (const p of prevMap.values()) {
    const key = clientCounterKey(p.mac_address);
    if (prevClientCounters.has(key)) continue; // in-memory value is always fresher
    if (p.rx_bytes_raw == null && p.tx_bytes_raw == null) continue;
    if (!p.bw_sampled_at) continue;
    prevClientCounters.set(key, {
      rx: p.rx_bytes_raw == null ? null : Number(p.rx_bytes_raw),
      tx: p.tx_bytes_raw == null ? null : Number(p.tx_bytes_raw),
      t: new Date(p.bw_sampled_at).getTime(),
    });
  }

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

  // Clients that left (in previous snapshot, not in current). A client that
  // disconnects must not leave a dangling active wireless_client_bandwidth_high
  // alert behind forever — resolve it here alongside the leave event, and drop
  // its breach counter (a later reconnect starts the debounce fresh).
  for (const [mac, p] of prevMap) {
    if (!seen.has(mac)) {
      events.push({
        mac_address: mac, controller_id: controller.id, event_type: 'leave',
        from_ap_id: p.ap_id, from_ap_name: p.ap_name, ts: now,
      });
      if (alertHooks) {
        clientBandwidthBreaches.delete(`${controller.id}::${mac}`);
        try {
          await alertHooks.resolve(mac, controller.id);
        } catch (e) {
          console.error(`[wireless] client bandwidth alert resolve (disconnect) failed on ${controller.name} (${mac}):`, e.message);
        }
      }
    }
  }

  // Roam counts (last hour) for ALL clients on this controller in one grouped
  // query, rather than one SELECT per client — avoids an N+1 pattern that gets
  // costly at the faster (5-min) client cadence. The current cycle's roam events
  // are inserted further below, so this sees the same table state for every row.
  const roamRows = await pool.query(
    `SELECT mac_address, COUNT(*)::int AS cnt FROM wireless_client_events
     WHERE controller_id = $1 AND event_type = 'roam' AND ts >= $2
     GROUP BY mac_address`,
    [controller.id, oneHourAgo]);
  const roamByMac = new Map(roamRows.rows.map((r) => [r.mac_address, r.cnt]));

  // Upsert current clients (roaming_count from the last hour of roam events).
  for (const client of clients) {
    if (!client.mac_address) continue;
    const roamCount = roamByMac.get(client.mac_address) || 0;
    const hasRssi = client.rssi_dbm !== null && client.rssi_dbm !== undefined;
    const isProblem = (hasRssi && client.rssi_dbm < -75) || roamCount > 5;
    // Sticky: poor signal but NOT roaming away (clings to a far AP) — the opposite
    // failure mode from excessive roaming, so it's tracked separately.
    const isSticky = hasRssi && client.rssi_dbm <= -72 && roamCount <= 1;

    // Convert cumulative rx/tx byte counters into a per-poll bits/sec rate, the
    // same way AP throughput is derived (see upsertAp above) — but keyed by MAC
    // on the dedicated prevClientCounters map/cadence, not prevCounters (which
    // is pruned on the AP interval and would race a client's own slower poll
    // cycle — see the comment on prevClientCounters for why they can't share).
    // rx_bps here is what the CLIENT downloaded, tx_bps what it uploaded.
    const { inBps: rxBps, outBps: txBps } = deriveThroughput(
      prevClientCounters, `${controller.id}::${client.mac_address}`,
      numOrNull(client.rx_bytes), numOrNull(client.tx_bytes), Date.now(), client.byte_counter_bits);

    // Sustained-high-bandwidth alerting (wireless_client_bandwidth_high) — see
    // CLIENT_BANDWIDTH_THRESHOLD_BPS above for the threshold rationale and the
    // consecutive-poll debounce. rx+tx combined, since either direction alone
    // sustained at/near the threshold is equally abnormal for one client.
    if (alertHooks) {
      const bwKey = `${controller.id}::${client.mac_address}`;
      const totalBps = (rxBps || 0) + (txBps || 0);
      if (totalBps > CLIENT_BANDWIDTH_THRESHOLD_BPS) {
        const breaches = (clientBandwidthBreaches.get(bwKey) || 0) + 1;
        clientBandwidthBreaches.set(bwKey, breaches);
        if (breaches >= 2) {
          const label = client.hostname || client.mac_address;
          const mbps = Math.round(totalBps / 1e6);
          const thresholdMbps = Math.round(CLIENT_BANDWIDTH_THRESHOLD_BPS / 1e6);
          try {
            await alertHooks.raise(
              client.mac_address, controller.id, controller.site_id,
              `Wireless client ${label} on ${controller.name} sustained ${mbps} Mbps (>= ${thresholdMbps} Mbps)`);
          } catch (e) {
            console.error(`[wireless] client bandwidth alert raise failed on ${controller.name} (${client.mac_address}):`, e.message);
          }
        }
      } else {
        clientBandwidthBreaches.delete(bwKey);
        try {
          await alertHooks.resolve(client.mac_address, controller.id);
        } catch (e) {
          console.error(`[wireless] client bandwidth alert resolve failed on ${controller.name} (${client.mac_address}):`, e.message);
        }
      }
    }

    // Persist the raw counters + sample time alongside the computed rate, so a
    // collector restart can warm-start prevClientCounters from the DB instead
    // of losing the baseline (see the seeding step earlier in this function).
    const rawRx = numOrNull(client.rx_bytes);
    const rawTx = numOrNull(client.tx_bytes);
    const bwSampledAt = (rawRx !== null || rawTx !== null) ? now : null;

    try {
    await pool.query(`
      INSERT INTO wireless_clients
        (mac_address, ip_address, hostname, controller_id, ap_id, ap_name, ssid_name, band, channel,
         rssi_dbm, tx_rate_mbps, rx_rate_mbps, connected_since, last_seen_at, auth_type,
         is_problem, roaming_count, vendor, is_sticky, phy_mode, vlan_id, rx_bps, tx_bps,
         rx_bytes_raw, tx_bytes_raw, byte_counter_bits, bw_sampled_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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
        is_sticky     = EXCLUDED.is_sticky,
        phy_mode      = EXCLUDED.phy_mode,
        vlan_id       = EXCLUDED.vlan_id,
        rx_bps        = EXCLUDED.rx_bps,
        tx_bps        = EXCLUDED.tx_bps,
        rx_bytes_raw  = EXCLUDED.rx_bytes_raw,
        tx_bytes_raw  = EXCLUDED.tx_bytes_raw,
        byte_counter_bits = EXCLUDED.byte_counter_bits,
        bw_sampled_at = EXCLUDED.bw_sampled_at
    `, [
      client.mac_address, client.ip_address || null, client.hostname || null, controller.id,
      client.ap_id || null, client.ap_name || null, client.ssid_name || null, client.band || null,
      intOrNull(client.channel), intOrNull(client.rssi_dbm),
      numOrNull(client.tx_rate_mbps), numOrNull(client.rx_rate_mbps), client.connected_since || null,
      now, client.auth_type || null, isProblem, roamCount, controller.vendor, isSticky,
      client.phy_mode || null, intOrNull(client.vlan_id), rxBps, txBps,
      rawRx, rawTx, client.byte_counter_bits || null, bwSampledAt,
    ]);
    await pool.query(
      `INSERT INTO wireless_client_history (mac_address, controller_id, ts, rx_bps, tx_bps, rssi_dbm)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [client.mac_address, controller.id, now, rxBps, txBps, intOrNull(client.rssi_dbm)]);
    } catch (e) {
      // Isolate per-row failures so one bad client doesn't skip the rest of the
      // controller's clients / all events / the prune.
      console.error(`[wireless] client upsert failed on ${controller.name} (${client.mac_address}):`, e.message);
      continue;
    }
  }

  // Insert detected events.
  for (const e of events) {
    try {
    await pool.query(`
      INSERT INTO wireless_client_events
        (mac_address, controller_id, event_type, from_ap_id, from_ap_name, to_ap_id, to_ap_name,
         rssi_dbm, ssid_name, ts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      e.mac_address, e.controller_id, e.event_type, e.from_ap_id || null, e.from_ap_name || null,
      e.to_ap_id || null, e.to_ap_name || null, intOrNull(e.rssi_dbm), e.ssid_name || null, e.ts,
    ]);
    } catch (err) {
      // Isolate per-row failures so one bad event doesn't skip the rest / the prune.
      console.error(`[wireless] client event insert failed on ${controller.name} (${e.mac_address}):`, err.message);
      continue;
    }
  }

  // Prune clients not seen in 15 minutes; purge events older than 7 days.
  // (Tightening this does NOT reconcile the Clients-tab total with Wireless Insights:
  // the controller re-reports aged-out stations every poll, so they never go stale on
  // our side. The Clients-tab counts are instead sourced from the live per-AP
  // associated gauge in the API.)
  try {
    await pool.query(
      `DELETE FROM wireless_clients WHERE controller_id = $1 AND last_seen_at < NOW() - INTERVAL '15 minutes'`,
      [controller.id]);
    await pool.query(`DELETE FROM wireless_client_events WHERE ts < NOW() - INTERVAL '7 days'`);
    // Same 7-day retention as events above — one history row per client per
    // poll adds up fast (1000+ clients x every 10 min), so this is bounded
    // rather than left to grow indefinitely the way wireless_history (AP-level)
    // currently is.
    await pool.query(`DELETE FROM wireless_client_history WHERE ts < NOW() - INTERVAL '7 days'`);
  } catch (e) {
    // A prune failure must not abort the poll.
    console.error(`[wireless] client prune failed on ${controller.name}:`, e.message);
  }

  log(`[clients] ${controller.name}: ${clients.length} client(s), ${events.length} event(s)`);
}

// Client poll cycle — separate (slower) cadence than the AP poll.
let clientsBusy = false;
async function pollAllClients(pool, alertHooks) {
  if (clientsBusy) return;
  clientsBusy = true;
  try {
    const r = await pool.query(`SELECT * FROM wireless_controllers WHERE active = TRUE`);
    for (const c of r.rows) {
      if (!c.snmp_device_id) continue;
      try {
        const apq = await pool.query(
          `SELECT id, name, mac_address FROM wireless_aps WHERE controller_id = $1`, [c.id]);
        await pollClients(pool, c, apq.rows, alertHooks);
      } catch (e) {
        // Client polling never affects AP polling — isolate per-controller failures.
        console.error(`[wireless] client poll failed on ${c.name}:`, e.message);
      }
    }
    prunePrevCounters(prevClientCounters, Date.now(), CLIENT_POLL_INTERVAL);
    // Sweep any clientBandwidthBreaches entry left behind by a controller that
    // was deleted/deactivated mid-breach — see pruneBreachesForInactiveControllers.
    pruneBreachesForInactiveControllers(new Set(r.rows.map((c) => String(c.id))));
  } catch (err) {
    console.error('[wireless] client poll cycle failed:', err.message);
  } finally {
    clientsBusy = false;
  }
}

// Clients are polled on a slower cadence than APs to reduce SNMP load on the
// controllers: every 10 minutes (was 15 — tightened for fresher per-client
// bandwidth data; the busiest production controller's client table is ~6.5x
// the row count of its AP table, so this wasn't dropped straight to the 5-min
// AP cadence — watch actual cycle-to-cycle spacing after this change the same
// way it was checked before making it, since poll DURATION itself isn't
// directly observable, only the gap between completed cycles), with a first
// pass 30s after startup. (A faster cadence does not reconcile the Clients-tab
// total with Wireless Insights — the controller re-reports aged-out stations
// each poll — so the count is sourced from the live per-AP associated gauge in
// the API instead.)
const CLIENT_POLL_INTERVAL = 10 * 60 * 1000;

// Start the wireless collector on a 5-minute cadence (first pass after 20s so
// the initial NetVault sync + vendor detection has a chance to populate).
// `alertHooks` (optional — { raise(mac, controllerId, siteId, message), resolve(mac,
// controllerId) }) is passed straight through to pollAllClients/pollClients so they
// can raise/resolve wireless_client_bandwidth_high alerts via collector.js's
// raiseClientBandwidthAlert/resolveClientBandwidthAlert without this module
// requiring collector.js back (collector.js already requires this module).
function startWirelessCollector(pool, alertHooks) {
  // One-shot startup cleanup of previously mis-detected (non-wireless) controllers.
  cleanupBadAutoControllers(pool).catch((e) => console.error('[wireless] startup cleanup:', e.message));
  // One-shot startup cleanup of stale decimal-MAC AP records (old bad SNMP parsing).
  cleanupDecimalMacAps(pool).catch((e) => console.error('[wireless] decimal-MAC cleanup:', e.message));
  setTimeout(() => pollAll(pool), 20 * 1000);
  setInterval(() => pollAll(pool), WIRELESS_POLL_INTERVAL);
  // Client polling on its own (slower) schedule, separate from the AP poll.
  setTimeout(() => pollAllClients(pool, alertHooks), 30 * 1000);
  setInterval(() => pollAllClients(pool, alertHooks), CLIENT_POLL_INTERVAL);
  log('wireless collector started (APs every 5 min, clients every 10 min)');
}

module.exports = {
  startWirelessCollector, pollAll, pollController, upsertAp, upsertSsid, upsertRogueAp,
  autoDetectControllers, cleanupBadAutoControllers, cleanupDecimalMacAps, testController, debugWalk,
  walkOid, pollClients, pollAllClients, probeControllerCapabilities, probeControllerCapabilitiesDetailed,
};

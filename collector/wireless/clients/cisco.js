'use strict';

// Wireless CLIENT parser for a Cisco WLC (AIRESPACE-WIRELESS-MIB,
// bsnMobileStationTable ...2.1.4.1). INDEX = 6 MAC octets, so macFromTail(idx, 6)
// yields the client MAC. Column numbers verified against the MIB in the
// 2026-07 audit; no Cisco hardware in the lab — validate against real hardware.
//
// NOT populated (no correct OID in this table / deliberately dropped):
//   • connected_since — ...4.1.6 is bsnMobileStationEssIndex (the WLAN id),
//     NOT an association-time, so no uptime can be derived → null.
//   • tx/rx rate — ...4.1.21/.22 are bsnMobileStationPortNumber /
//     bsnMobileStationDeleteAction, not data rates → null. (Per-client
//     Counter64 byte counters exist in the stats table but are deliberately
//     not walked in this pass.)
//   • hostname — ...4.1.3 is bsnMobileStationUserName; the client row schema
//     has no username field, so it is not walked.
//   • channel — not exposed in this table → null.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const { num, str, macFromTail, hexMac, emptyClient } = require('./_util');

// bsnMobileStationTable entry — INDEX = client MAC (6 octets).
const TABLE = '1.3.6.1.4.1.14179.2.1.4.1';
const cIp = TABLE + '.2';        // bsnMobileStationIpAddress
const cApMac = TABLE + '.4';     // bsnMobileStationAPMacAddr
const cSsid = TABLE + '.7';      // bsnMobileStationSsid
const cProtocol = TABLE + '.25'; // bsnMobileStationProtocol (802.11 PHY → band)
const cPolicy = TABLE + '.30';   // bsnMobileStationPolicyType (security → auth_type)

// bsnMobileStationRSSI lives in the per-client STATS table
// (bsnMobileStationStatsTable ...2.1.6.1), same client-MAC index.
const cRssi = '1.3.6.1.4.1.14179.2.1.6.1.1'; // bsnMobileStationRSSI (Integer32 dBm)

// Cap every per-client walk: a large WLC can carry tens of thousands of
// stations, and an uncapped subtree walk per column could run for minutes.
// walk()'s maxRows cancels the walk once the cap is hit; 5000 clients per
// column is ample for our deployments.
const WALK_ROW_CAP = 5000;

// bsnMobileStationPolicyType → auth_type label. MIB enum (validate against
// real hardware): dot1x(0), wpa1(1), wpa2(2); newer AireOS builds append more
// values — anything unmapped becomes 'other' rather than a wrong label.
const POLICY_LABELS = { 0: 'dot1x', 1: 'wpa1', 2: 'wpa2' };
function authTypeFromPolicy(v) {
  const n = num(v);
  if (n === null) return null;
  return POLICY_LABELS[n] !== undefined ? POLICY_LABELS[n] : 'other';
}

// bsnMobileStationProtocol → band. MIB enum: dot11a(1), dot11b(2), dot11g(3),
// unknown(4), mobile(5), dot11n24(6), dot11n5(7).
//   {1 dot11a, 7 dot11n5} → 5GHz;  {2 dot11b, 3 dot11g, 6 dot11n24} → 2.4GHz.
// Later firmwares append 802.11ac/ax codes: dot11ac(8) is 5 GHz-only so it is
// mapped best-effort; the ax enum values vary by release, so unmatched codes
// return null instead of guessing. Validate against real hardware.
function bandFromProtocol(v) {
  const n = num(v);
  if (n === null) return null;
  if (n === 1 || n === 7) return '5GHz';
  if (n === 2 || n === 3 || n === 6) return '2.4GHz';
  if (n === 8) return '5GHz'; // dot11ac — best-effort
  return null;
}

async function parseClients(session, apMap) {
  const out = [];
  try {
    // Each walk is capped (see WALK_ROW_CAP above).
    const ip = columnMap(await walk(session, cIp, WALK_ROW_CAP), cIp);
    const apMacRows = columnMap(await walk(session, cApMac, WALK_ROW_CAP), cApMac);
    const ssid = columnMap(await walk(session, cSsid, WALK_ROW_CAP), cSsid);
    const protocol = columnMap(await walk(session, cProtocol, WALK_ROW_CAP), cProtocol);
    const policy = columnMap(await walk(session, cPolicy, WALK_ROW_CAP), cPolicy);
    const rssi = columnMap(await walk(session, cRssi, WALK_ROW_CAP), cRssi);

    const idxs = new Set();
    [ip, apMacRows, ssid, protocol, policy, rssi].forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6);
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ip[idx]);
      c.ssid_name = str(ssid[idx]);

      const apMacRaw = apMacRows[idx];
      const apMac = hexMac(apMacRaw);
      const ap = apMac ? apMap.byMac.get(apMac) : null;
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; }

      // bsnMobileStationRSSI is Integer32 dBm (negative), stored as-is.
      c.rssi_dbm = num(rssi[idx]);

      c.auth_type = authTypeFromPolicy(policy[idx]);
      c.band = bandFromProtocol(protocol[idx]);

      // connected_since / tx_rate_mbps / rx_rate_mbps / channel stay null —
      // see the header comment for why.

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

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
//     bsnMobileStationDeleteAction, not data rates → null.
//   • hostname — ...4.1.3 is bsnMobileStationUserName; the client row schema
//     has no username field, so it is not walked.
//   • channel — not exposed in this table → null.
//
// rx_bytes/tx_bytes (2026-07): bsnMobileStationStatsTable also carries two
// Counter64 byte counters, bsnMobileStationBytesReceived (...6.1.2) and
// bsnMobileStationBytesSent (...6.1.3), now walked alongside RSSI below.
// Direction mapping — MIB text verified against the raw AIRESPACE-WIRELESS-MIB
// (matched across multiple independent MIB mirrors; no Cisco hardware in the
// lab to confirm live, so validate against real hardware):
//   • bsnMobileStationBytesReceived: "Bytes received from Mobile Station" —
//     device-centric (the CONTROLLER's perspective): bytes the controller
//     received FROM the station. That's the client's UPLOAD, which in this
//     struct's client-relative convention (see clients/_util.js emptyClient())
//     is tx_bytes (uploaded BY the client).
//   • bsnMobileStationBytesSent: "Bytes sent to Mobile Station" — bytes the
//     controller sent TO the station. That's the client's DOWNLOAD, i.e.
//     rx_bytes (downloaded BY the client).
//   This is the opposite of a naive "Received=rx_bytes" reading — the MIB
//   names are from the controller's point of view, not the client's.

const { walk } = require('../../snmp-session');
const { columnMap, counterNum } = require('../_util');
const { num, str, macFromTail, hexMac, emptyClient } = require('./_util');

// bsnMobileStationTable entry — INDEX = client MAC (6 octets).
const TABLE = '1.3.6.1.4.1.14179.2.1.4.1';
const cIp = TABLE + '.2';        // bsnMobileStationIpAddress
const cApMac = TABLE + '.4';     // bsnMobileStationAPMacAddr
const cSsid = TABLE + '.7';      // bsnMobileStationSsid
const cProtocol = TABLE + '.25'; // bsnMobileStationProtocol (802.11 PHY → band)
const cPolicy = TABLE + '.30';   // bsnMobileStationPolicyType (security → auth_type)

// bsnMobileStationStatsTable — per-client stats, same client-MAC index.
const STATS_TABLE = '1.3.6.1.4.1.14179.2.1.6.1';
const cRssi = STATS_TABLE + '.1';          // bsnMobileStationRSSI (Integer32 dBm)
const cBytesReceived = STATS_TABLE + '.2'; // bsnMobileStationBytesReceived (Counter64) → client tx_bytes (see header comment)
const cBytesSent = STATS_TABLE + '.3';     // bsnMobileStationBytesSent (Counter64) → client rx_bytes (see header comment)

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
    const bytesReceived = columnMap(await walk(session, cBytesReceived, WALK_ROW_CAP), cBytesReceived);
    const bytesSent = columnMap(await walk(session, cBytesSent, WALK_ROW_CAP), cBytesSent);

    const idxs = new Set();
    [ip, apMacRows, ssid, protocol, policy, rssi, bytesReceived, bytesSent].forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

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

      // bsnMobileStationBytesReceived/Sent are Counter64 — decode with
      // counterNum() (handles both Buffer-encoded 64-bit values and plain
      // numbers). Direction mapping per the header comment: BytesReceived
      // (by the controller, from the station) is the client's upload →
      // tx_bytes; BytesSent (by the controller, to the station) is the
      // client's download → rx_bytes.
      const bRx = counterNum(bytesReceived[idx]);
      const bTx = counterNum(bytesSent[idx]);
      if (bRx !== null) c.tx_bytes = bRx;
      if (bTx !== null) c.rx_bytes = bTx;
      if (bRx !== null || bTx !== null) c.byte_counter_bits = 64;

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

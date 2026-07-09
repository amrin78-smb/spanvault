'use strict';

// Wireless CLIENT parser for HPE Aruba Instant (AI-AP-MIB, aiClientTable).
// OIDs verified against the AI-AP-MIB text (LibreNMS mirror) in the 2026-07
// audit — no HPE/Aruba Instant hardware in the lab; validate against real
// hardware. Rebased onto the SAME enterprise branch as the sibling AP-level
// parser (../hpe.js): enterprise 14823 (aiStateGroup), NOT the old 47196
// base this file previously pointed at — that branch "has no published AP
// table" (see ../hpe.js's header comment) and the guessed client leaf under
// it was equally dead, never migrated when the AP-level file was rebased.
//
// aiClientTable = { aiStateGroup 4 } -> base 1.3.6.1.4.1.14823.2.3.3.1.2.4.1
// (aiClientEntry), INDEX { aiClientMACAddress } — a single 6-octet client
// MAC, so the client MAC comes from the OID index tail via macFromTail(),
// NOT from a walked column (the old 47196-based file wrongly read the MAC
// from a column value).
//
// NOT populated (no correct destination field / deliberately dropped —
// future work if a use is found):
//   • ssid_name — aiClientTable has no SSID string column at all, only the
//     BSSID at .2 (aiClientWlanMACAddress). apMap (built from the AP objects
//     this same poll cycle already parsed — see emptyAp() in
//     collector/wireless/_util.js) carries no SSID either, so there is no
//     BSSID->AP->SSID chain available to derive it from. Left null rather
//     than guessed.
//   • hostname — aiClientName (.5) is "Name of user using the client" (a
//     username), not a device hostname; same reasoning clients/cisco.js uses
//     to skip bsnMobileStationUserName (.3) rather than mis-populate the
//     hostname field with a username.
//   • OS fingerprint — aiClientOperatingSystem (.6) has no destination field
//     in emptyClient() (collector/wireless/clients/_util.js).
//   • tx/rx frame+byte counters and retry counts (.8-.10, .12-.14) —
//     Counter32, but emptyClient() has no counter fields to hold them; not
//     walked at all.
//   • HT mode — aiClientHtMode (.18) has no destination field; not walked.
//   • channel / auth_type — no OIDs for either in this table → stay null.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, hexMac, emptyClient, connectedSinceFromSeconds,
} = require('./_util');

// aiClientEntry — base 1.3.6.1.4.1.14823.2.3.3.1.2.4.1, INDEX = client MAC (6 octets).
const TABLE = '1.3.6.1.4.1.14823.2.3.3.1.2.4.1';
const cBssid   = TABLE + '.2';  // aiClientWlanMACAddress — BSSID of the AP the client is on
const cIp      = TABLE + '.3';  // aiClientIPAddress
const cApIp    = TABLE + '.4';  // aiClientAPIPAddress — fallback AP-correlation key
const cSnr     = TABLE + '.7';  // aiClientSNR (signal-to-noise ratio, NOT raw dBm)
const cTxRate  = TABLE + '.11'; // aiClientTxRate — DESCRIPTION: "Transmit rate of client in mbps"
const cRxRate  = TABLE + '.15'; // aiClientRxRate — DESCRIPTION: "Receive rate of client in mbps"
const cUptime  = TABLE + '.16'; // aiClientUptime (TimeTicks, hundredths of a second)
const cPhyType = TABLE + '.17'; // aiClientPhyType (ArubaPhyType enum)

// ArubaPhyType (AI-AP-MIB): dot11a(1), dot11b(2), dot11g(3), dot11ag(4), wired(5).
// dot11a is 5GHz-only and dot11b/dot11g are 2.4GHz-only, so those three map
// cleanly to a band; dot11ag(4) (dual a/g capable) is genuinely ambiguous and
// wired(5) isn't wireless at all, so both stay null rather than guess — same
// "unmatched code -> null" convention as bandFromProtocol() in clients/cisco.js.
function bandFromPhyType(v) {
  const n = num(v);
  if (n === null) return null;
  if (n === 1) return '5GHz';
  if (n === 2 || n === 3) return '2.4GHz';
  return null; // dot11ag(4) ambiguous, wired(5) not wireless, anything else unknown
}

// Build a fallback ip_address -> AP lookup from the AP objects already
// reachable through apMap (apMap itself only indexes by name/mac — see
// pollClients() in collector/wirelessCollector.js). Used when the BSSID (.2)
// doesn't resolve against apMap.byMac.
function buildApIpMap(apMap) {
  const out = new Map();
  const src = apMap && apMap.byMac && apMap.byMac.size ? apMap.byMac : (apMap && apMap.byName);
  if (!src) return out;
  for (const ap of src.values()) {
    if (ap && ap.ip_address) out.set(ap.ip_address, ap);
  }
  return out;
}

async function parseClients(session, apMap) {
  const out = [];
  try {
    const bssidCol = columnMap(await walk(session, cBssid), cBssid);
    const ipCol = columnMap(await walk(session, cIp), cIp);
    const apIpCol = columnMap(await walk(session, cApIp), cApIp);
    const snrCol = columnMap(await walk(session, cSnr), cSnr);
    const txCol = columnMap(await walk(session, cTxRate), cTxRate);
    const rxCol = columnMap(await walk(session, cRxRate), cRxRate);
    const upCol = columnMap(await walk(session, cUptime), cUptime);
    const phyCol = columnMap(await walk(session, cPhyType), cPhyType);

    const idxs = new Set();
    [bssidCol, ipCol, apIpCol, snrCol, txCol, rxCol, upCol, phyCol]
      .forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    const apByIp = buildApIpMap(apMap);

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6); // aiClientEntry index IS the 6-octet client MAC
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ipCol[idx]);

      // AP correlation: prefer the BSSID (AP radio MAC) matched against known
      // AP MACs; fall back to the associated AP's own IP when the BSSID
      // lookup misses.
      let ap = null;
      const bssid = hexMac(bssidCol[idx]);
      if (bssid) ap = apMap.byMac.get(bssid);
      if (!ap) {
        const apIp = str(apIpCol[idx]);
        if (apIp) ap = apByIp.get(apIp);
      }
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; }

      // aiClientSNR is a signal-to-noise RATIO, not raw dBm. Convert to an
      // approximate RSSI the same way clients/aruba.js does (typical -95 dBm
      // noise floor); a firmware that already returns a negative dBm value is
      // kept as-is.
      const sig = num(snrCol[idx]);
      if (sig !== null) c.rssi_dbm = sig > 0 ? sig - 95 : sig;

      // aiClientTxRate / aiClientRxRate are documented "in mbps" — used directly.
      c.tx_rate_mbps = num(txCol[idx]);
      c.rx_rate_mbps = num(rxCol[idx]);

      // aiClientUptime is TimeTicks (hundredths of a second).
      const ticks = num(upCol[idx]);
      c.connected_since = connectedSinceFromSeconds(ticks === null ? null : Math.floor(ticks / 100));

      c.band = bandFromPhyType(phyCol[idx]);

      // ssid_name / hostname / auth_type / channel intentionally left null —
      // see the header comment for why.

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

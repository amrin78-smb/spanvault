'use strict';

// MikroTik wireless CLIENT parser (mtxrWlRtabTable).
// OIDs verified against MIKROTIK-MIB (LibreNMS MIB mirror):
//   MtxrWlRtabEntry ::= SEQUENCE {
//     mtxrWlRtabAddr MacAddress, mtxrWlRtabIface ObjectIndex, ... }
//   INDEX { mtxrWlRtabAddr, mtxrWlRtabIface }
// The index is therefore 7 dotted components: the 6 client MAC octets FIRST,
// then the interface index LAST. The MAC must be recovered with
// macFromHead(idx, 6) — macFromTail(idx, 6) grabs octets 2-6 of the MAC plus
// the trailing iface number as a fake 6th octet, corrupting the join key on
// every row.
//
// mtxrWlRtabTable carries no SSID/band column, so those are enriched by
// walking the sibling mtxrWlApTable (the same base OID and columns the
// already-fixed AP-level parser at collector/wireless/mikrotik.js uses) and
// joining on the recovered interface index.

const { walk } = require('../../snmp-session');
const { columnMap, counterNum } = require('../_util');
const {
  num, str, macFromHead, emptyClient, connectedSinceFromSeconds,
} = require('./_util');

// mtxrWlRtabTable: 1.3.6.1.4.1.14988.1.1.1.2.1
const RTAB_BASE = '1.3.6.1.4.1.14988.1.1.1.2.1';
const cStrength = RTAB_BASE + '.3';  // mtxrWlRtabStrength (Integer32, dBm) -> rssi_dbm
const cTxBytes = RTAB_BASE + '.4';   // mtxrWlRtabTxBytes (Counter32) -> rx_bytes (client's download — see note below)
const cRxBytes = RTAB_BASE + '.5';   // mtxrWlRtabRxBytes (Counter32) -> tx_bytes (client's upload — see note below)
const cTxRate = RTAB_BASE + '.8';    // mtxrWlRtabTxRate (Gauge32, bits/sec) -> tx_rate_mbps
const cRxRate = RTAB_BASE + '.9';    // mtxrWlRtabRxRate (Gauge32, bits/sec) -> rx_rate_mbps
const cUptime = RTAB_BASE + '.11';   // mtxrWlRtabUptime (TimeTicks) -> connected_since
// .4/.5 (TxBytes/RxBytes) are MIB-verified to exist at these OIDs (MIKROTIK-MIB
// SEQUENCE order, confirmed against the LibreNMS MIB mirror and oidref.com's
// per-column OID pages) but the MIB's own DESCRIPTION fields are empty, so
// direction is NOT MIB-text-confirmed and NOT live-verified against real
// hardware. mtxrWlRtabTable is RouterOS's wireless *registration table* — the
// router's own view of each connected station (device-centric), matching
// Cisco's bsnMobileStationStatsTable, NOT a client-self-reported table like
// Ruckus/HPE's "Sta*"/"aiClient*" columns. Per RouterOS's own documented
// convention for this table ("Tx goes from router to client — so client
// download is the Tx rate on the router"), Tx/Rx here are relative to the
// ROUTER, the opposite of every other field in this struct (which are all
// CLIENT-relative per emptyClient()'s convention) — so they must be swapped,
// not read directly: mtxrWlRtabTxBytes (router -> client) is what the CLIENT
// received -> rx_bytes; mtxrWlRtabRxBytes (client -> router) is what the
// CLIENT sent -> tx_bytes. Both are Counter32 (not Counter64, matching HPE and
// unlike Aruba/Cisco/Ruckus), decoded with counterNum() and reported with
// byte_counter_bits = 32 so wirelessCollector.js's shared delta helper applies
// Counter32 wraparound handling (these wrap at ~4.3GB, easily within an hour on
// a busy client).
//
// NOTE (flagged, not fixed here — out of scope for this change): tx_rate_mbps/
// rx_rate_mbps below (.8/.9) are read directly with NO such swap, even though
// they're columns in this SAME router-relative table and the RouterOS
// convention quoted above applies to "Tx rate" by name too — this may be a
// pre-existing inversion of those two fields (predates this change, already
// shipped). Left untouched here since fixing it needs its own dedicated
// verification pass, not a side effect of the byte-counter fix.
//
// Deliberately skipped (no field in emptyClient() to hold them):
//   .6/.7 TxPackets/RxPackets (packet counts, not bytes), .10 RouterOSVersion,
//   .12 SignalToNoise, .13-.18 per-antenna-chain Tx/RxStrengthCh0/1/2,
//   .19 TxStrength, .20 RadioName.

// mtxrWlApTable: 1.3.6.1.4.1.14988.1.1.1.3.1 — sibling AP-level table (same
// base + columns as collector/wireless/mikrotik.js). Walked here only for the
// SSID/Freq columns needed to enrich each client by its interface index.
const AP_BASE = '1.3.6.1.4.1.14988.1.1.1.3.1';
const apSsid = AP_BASE + '.4'; // mtxrWlApSsid
const apFreq = AP_BASE + '.7'; // mtxrWlApFreq (MHz)

// Mirrors bandForFreq() in collector/wireless/mikrotik.js (same MHz
// thresholds), but returns the '2.4GHz'/'5GHz' label convention used by the
// other vendor CLIENT parsers' band field (aruba/ruckus), not that file's
// short '2g'/'5g' codes.
function bandForFreq(freqMhz) {
  const f = num(freqMhz);
  if (f === null) return null;
  if (f >= 2400 && f <= 2500) return '2.4GHz';
  if (f >= 4900 && f <= 6100) return '5GHz';
  return null;
}

async function parseClients(session, apMap) {
  const out = [];
  try {
    const strength = columnMap(await walk(session, cStrength), cStrength);
    const txBytes = columnMap(await walk(session, cTxBytes), cTxBytes);
    const rxBytes = columnMap(await walk(session, cRxBytes), cRxBytes);
    const txRate = columnMap(await walk(session, cTxRate), cTxRate);
    const rxRate = columnMap(await walk(session, cRxRate), cRxRate);
    const uptime = columnMap(await walk(session, cUptime), cUptime);

    // Interface index -> { ssid, band }, from the sibling AP table (same
    // approach/columns as the AP-level parser's parseApTable()).
    const ssids = columnMap(await walk(session, apSsid), apSsid);
    const freqs = columnMap(await walk(session, apFreq), apFreq);
    const ifaceInfo = {};
    const ifaceIdxs = new Set();
    Object.keys(ssids).forEach((k) => ifaceIdxs.add(k));
    Object.keys(freqs).forEach((k) => ifaceIdxs.add(k));
    for (const iface of ifaceIdxs) {
      const ssid = str(ssids[iface]);
      ifaceInfo[iface] = { ssid, band: bandForFreq(freqs[iface]) };
    }

    const aps = Array.from(apMap.byName.values());
    const soleAp = aps.length === 1 ? aps[0] : null;

    const idxs = new Set();
    [strength, txBytes, rxBytes, txRate, rxRate, uptime]
      .forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    for (const idx of idxs) {
      // INDEX { mtxrWlRtabAddr, mtxrWlRtabIface } — MAC (6 octets) first,
      // iface index last. macFromHead recovers the real MAC; the iface is the
      // remaining trailing component.
      const mac = macFromHead(idx, 6);
      if (!mac) continue;
      const parts = String(idx).split('.');
      const iface = parts[parts.length - 1];

      const c = emptyClient();
      c.mac_address = mac;
      c.rssi_dbm = num(strength[idx]);
      // Swapped relative to the raw OID names — see the router-relative-vs-
      // client-relative note above cTxBytes/cRxBytes.
      c.rx_bytes = counterNum(txBytes[idx]);
      c.tx_bytes = counterNum(rxBytes[idx]);
      c.byte_counter_bits = 32;

      const t = num(txRate[idx]);
      c.tx_rate_mbps = t === null ? null : t / 1000000;
      const r = num(rxRate[idx]);
      c.rx_rate_mbps = r === null ? null : r / 1000000;

      // mtxrWlRtabUptime is TimeTicks (hundredths of a second).
      const ticks = num(uptime[idx]);
      c.connected_since = connectedSinceFromSeconds(ticks === null ? null : Math.floor(ticks / 100));

      const info = ifaceInfo[iface];
      let ap = null;
      if (info && info.ssid) {
        c.ssid_name = info.ssid;
        c.band = info.band;
        // The AP-level parser names each AP `MikroTik ${ssid} (${idx})` —
        // reuse that exact naming convention to resolve the AP record.
        ap = apMap.byName.get(`MikroTik ${info.ssid} (${iface})`);
      }
      if (!ap) ap = soleAp;
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; }

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

'use strict';

// Grandstream wireless CLIENT parser (GRANDSTREAM-GWN-MIB, gwnClientTable).
//
// SOURCE / CONFIDENCE: the OIDs below come directly from Grandstream's own
// published MIB source file, GRANDSTREAM-GWN-MIB.my — linked from the
// official "GWN76XX Wi-Fi Access Points SNMP Guide" PDF
// (grandstream.com/hubfs/Product_Documentation/gwn76xx_snmp_guide.pdf),
// "GWN76XX MIB REFERENCE" section, which points at
// http://firmware.grandstream.com/GRANDSTREAM-GWN-MIB.my. That URL 404s as
// of this change (2026-07); the identical file content was recovered via the
// Wayback Machine's 2022-07-06 snapshot of the same URL, and independently
// cross-checked against Observium's mirrored copy of the same MIB
// (mibs.observium.org/mib/GRANDSTREAM-GWN-MIB/) — both sources agree exactly
// on every object name, OID, and SYNTAX type below (raw ASN.1 text compared,
// not an AI summary of either page). HIGH confidence the table exists at
// this OID with these columns; LOW confidence on a few individual column
// *semantics* beyond what the object name implies (see inline notes),
// because every DESCRIPTION field in Grandstream's own MIB source is the
// literal placeholder string "Description." — the vendor never filled them
// in. No Grandstream GWN hardware available to live-verify any of this.
//
// gwnClientTable = { gwnApWireless 3 } = { gwnMIB 3 3 } -> base
// 1.3.6.1.4.1.42397.1.1.3.3 (gwnClientEntry), INDEX { gwnClientMACAddress } —
// a single 6-octet client MAC, so the MAC comes from the OID index tail via
// macFromTail(), the same table shape as HPE's aiClientTable
// (clients/hpe.js), NOT MikroTik/Aruba's "MAC + something else" composite index.
//
// NOTE on the sibling AP-level parser (../grandstream.js): despite this MIB
// genuinely existing — and gwnApWireless also carrying gwnRadioTable
// (per-radio stats) and gwnWlanTable (per-SSID stats) alongside
// gwnClientTable — ../grandstream.js does NOT use any of the GWN enterprise
// branch (1.3.6.1.4.1.42397) today. It only walks standard SNMPv2-MIB/IF-MIB
// OIDs (sysName/sysUpTime/ifDescr/ifOperStatus) and returns a single
// synthetic "AP" representing the polled device itself, with ap.mac_address
// left null. That's a pre-existing gap in the AP-level file and out of scope
// here (this change only adds the CLIENT parser) — but it means
// apMap.byMac will be empty in practice for this vendor until the AP-level
// file is rebased onto the real GWN MIB too. AP correlation below still
// tries gwnClientWlanMACAddress (BSSID) against apMap.byMac first
// (future-proof, a harmless no-op today), then falls back to the sole AP
// object when apMap has exactly one entry — consistent with the AP-level
// file's own "at most ONE WirelessAP representing the device itself" design
// (the same soleAp fallback pattern clients/mikrotik.js uses).
//
// GwnClientEntry columns (SEQUENCE order in the raw MIB):
//   .1  gwnClientMACAddress    MacAddress    — INDEX (client MAC)
//   .2  gwnClienttIPAddress    IpAddress     — client IP (sic: the literal
//                                              object name has a double "t",
//                                              a typo in Grandstream's own
//                                              MIB source — not a transcription
//                                              error here)
//   .3  gwnClientWlanMACAddress MacAddress   — AP radio BSSID the client is on
//   .4  gwnClientESSID         DisplayString — SSID
//   .5  gwnClientRSSI          Integer32     — named RSSI (not SNR/ratio like
//                                              Aruba/HPE's client tables), so
//                                              used directly as dBm, no conversion
//   .6  gwnClientAssoctime     TimeTicks     — association time (1/100 s)
//   .7  gwnClientManufacture   DisplayString — OUI vendor guess; no destination
//                                              field in emptyClient(), skipped
//   .8  gwnClientHostname      DisplayString — client-reported hostname
//   .9  gwnClientOS            DisplayString — OS fingerprint; no destination
//                                              field, skipped (same reasoning
//                                              clients/hpe.js uses for
//                                              aiClientOperatingSystem)
//   .10 gwnClientTxRate        Integer32     — negotiated tx rate; the MIB
//                                              gives no unit (blank
//                                              DESCRIPTION), used directly as
//                                              Mbps by the same naming
//                                              convention every other
//                                              vendor's explicitly-named
//                                              Tx/RxRate column follows (e.g.
//                                              HPE's aiClientTxRate, MIB-
//                                              documented "in mbps") — NOT
//                                              itself MIB-confirmed for
//                                              Grandstream.
//   .11 gwnClientTxDataFrames  Counter32     — frame count; no destination
//                                              field, skipped
//   .12 gwnClientTxDataBytes   Counter32     — byte counter; direction
//                                              treated as client-relative
//                                              (uploaded BY the client) by
//                                              analogy with HPE's
//                                              aiClientTxDataBytes — the
//                                              closest documented precedent
//                                              for a client-centric (not
//                                              radio/AP-centric) Tx/RxDataBytes
//                                              pair. NOT MIB-confirmed here
//                                              (blank DESCRIPTION) — MEDIUM
//                                              confidence at best.
//   .13 gwnClientRxRate        Integer32     — same treatment as .10
//   .14 gwnClientRxDataFrames  Counter32     — frame count; no destination
//                                              field, skipped
//   .15 gwnClientRxDataBytes   Counter32     — see .12 (downloaded BY the client)
//   .16 gwnClientnode54        Integer32     — the MIB's own compiler could not
//                                              resolve ANY symbolic meaning for
//                                              this column (literal placeholder
//                                              name); skipped entirely.
//   .17 gwnClientnode55        Integer32     — same as .16, skipped.
//
// Deliberately left null (no OID anywhere in gwnClientTable for any of
// these): channel, band, auth_type, phy_mode, vlan_id.

const { walk } = require('../../snmp-session');
const { columnMap, counterNum } = require('../_util');
const {
  num, str, macFromTail, hexMac, emptyClient, connectedSinceFromSeconds,
} = require('./_util');

// gwnClientEntry — base 1.3.6.1.4.1.42397.1.1.3.3.1, INDEX = client MAC (6 octets).
const TABLE = '1.3.6.1.4.1.42397.1.1.3.3.1';
const cIp       = TABLE + '.2';  // gwnClienttIPAddress
const cBssid    = TABLE + '.3';  // gwnClientWlanMACAddress
const cSsid     = TABLE + '.4';  // gwnClientESSID
const cRssi     = TABLE + '.5';  // gwnClientRSSI (dBm, used directly)
const cAssoc    = TABLE + '.6';  // gwnClientAssoctime (TimeTicks)
const cHostname = TABLE + '.8';  // gwnClientHostname
const cTxRate   = TABLE + '.10'; // gwnClientTxRate (Mbps, by naming convention)
const cTxBytes  = TABLE + '.12'; // gwnClientTxDataBytes (Counter32)
const cRxRate   = TABLE + '.13'; // gwnClientRxRate (Mbps, by naming convention)
const cRxBytes  = TABLE + '.15'; // gwnClientRxDataBytes (Counter32)

async function parseClients(session, apMap) {
  const out = [];
  try {
    const ipCol = columnMap(await walk(session, cIp), cIp);
    const bssidCol = columnMap(await walk(session, cBssid), cBssid);
    const ssidCol = columnMap(await walk(session, cSsid), cSsid);
    const rssiCol = columnMap(await walk(session, cRssi), cRssi);
    const assocCol = columnMap(await walk(session, cAssoc), cAssoc);
    const hostCol = columnMap(await walk(session, cHostname), cHostname);
    const txRateCol = columnMap(await walk(session, cTxRate), cTxRate);
    const txBytesCol = columnMap(await walk(session, cTxBytes), cTxBytes);
    const rxRateCol = columnMap(await walk(session, cRxRate), cRxRate);
    const rxBytesCol = columnMap(await walk(session, cRxBytes), cRxBytes);

    const idxs = new Set();
    [ipCol, bssidCol, ssidCol, rssiCol, assocCol, hostCol, txRateCol, txBytesCol, rxRateCol, rxBytesCol]
      .forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    // ../grandstream.js (AP-level) returns at most ONE synthetic AP
    // representing the polled device itself — see the header note above.
    const aps = Array.from(apMap.byName.values());
    const soleAp = aps.length === 1 ? aps[0] : null;

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6); // gwnClientEntry index IS the 6-octet client MAC
      if (!mac) continue;

      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ipCol[idx]);
      c.hostname = str(hostCol[idx]);
      c.ssid_name = str(ssidCol[idx]);
      c.rssi_dbm = num(rssiCol[idx]); // named RSSI directly -> dBm, no SNR-style conversion

      c.tx_rate_mbps = num(txRateCol[idx]);
      c.rx_rate_mbps = num(rxRateCol[idx]);

      const txBytes = counterNum(txBytesCol[idx]);
      const rxBytes = counterNum(rxBytesCol[idx]);
      if (txBytes !== null || rxBytes !== null) {
        c.tx_bytes = txBytes;
        c.rx_bytes = rxBytes;
        c.byte_counter_bits = 32; // gwnClientTxDataBytes/RxDataBytes are Counter32
      }

      // gwnClientAssoctime is TimeTicks (hundredths of a second).
      const ticks = num(assocCol[idx]);
      c.connected_since = connectedSinceFromSeconds(ticks === null ? null : Math.floor(ticks / 100));

      // AP correlation: prefer the BSSID matched against known AP MACs
      // (currently a no-op in this codebase — see the header note that
      // ../grandstream.js never populates ap.mac_address today, so
      // apMap.byMac is always empty for this vendor); fall back to the sole
      // AP when this vendor's device-as-AP model has exactly one entry.
      let ap = null;
      const bssid = hexMac(bssidCol[idx]);
      if (bssid) ap = apMap.byMac.get(bssid);
      if (!ap) ap = soleAp;
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; }

      // band / channel / auth_type / phy_mode / vlan_id intentionally left
      // null — gwnClientTable has no OID for any of them (see header).

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

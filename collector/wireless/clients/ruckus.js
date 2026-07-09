'use strict';

// Wireless CLIENT parser for a Ruckus ZoneDirector (ruckusZDWLANStaTable).
// OIDs verified against RUCKUS-ZD-WLAN-MIB (LibreNMS mirror), 2026-07 audit.
//
// ruckusZDWLANStaInfo = { ruckusZDWLANObjects 3 }
// ruckusZDWLANStaTable = { ruckusZDWLANStaInfo 1 }, base
// 1.3.6.1.4.1.25053.1.2.2.1.1.3.1.1 (entry), INDEX { ruckusZDWLANStaMacAddr }
// — a single 6-octet MAC, so the client MAC comes from the OID index tail
// (same pattern as the already-corrected AP table in ../ruckus.js), never
// from a value column.
//
// The OLD base this file used to walk (...1.1.2.3.1) is actually
// ruckusZDWLANVapTable (a per-VAP/per-SSID aggregate byte-counter table
// indexed by VAP BSSID) — not a per-client table at all. Every column read
// from it was garbage (an SSID string read as an IP, a Counter64 byte-counter
// buffer read via plain num() as an RSSI, etc). See ../ruckus.js's header for
// the sibling AP/radio-table fix this file now matches.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, hexMac, bandFromCode, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

// ruckusZDWLANStaTable entry — base 1.3.6.1.4.1.25053.1.2.2.1.1.3.1.1,
// INDEX = client MAC (6 octets).
const TABLE = '1.3.6.1.4.1.25053.1.2.2.1.1.3.1.1';
const staApMac = TABLE + '.2';    // ruckusZDWLANStaAPMacAddr (MacAddress) — AP correlation
const staBssid = TABLE + '.3';    // ruckusZDWLANStaBSSID (MacAddress) — secondary AP correlation
const staSsid = TABLE + '.4';     // ruckusZDWLANStaSSID (RuckusSSID, string)
// '.5' StaUser (DisplayString, logged-in username) — no field in emptyClient(),
// not walked.
const staRadioType = TABLE + '.6'; // ruckusZDWLANStaRadioType (INTEGER, see enum below)
const staChannel = TABLE + '.7';   // ruckusZDWLANStaChannel (Unsigned32)
const staIp = TABLE + '.8';        // ruckusZDWLANStaIPAddr (IpAddress)
// '.9' StaAvgRSSI and '.21' StaSNR both exist but neither documents dBm units
// in the MIB — '.81' StaSignalStrength (below) is the only column with an
// explicit "UNITS dBm" and is preferred for rssi_dbm.
const staAssocTime = TABLE + '.15'; // ruckusZDWLANStaAssocTime (TimeTicks, 1/100s)
// '.11' StaRxBytes / '.13' StaTxBytes (Counter64) exist and are available, but
// emptyClient() has no rx_bytes/tx_bytes field to put them in today, so they
// are deliberately not walked in this pass (same call as the Cisco client
// parser's per-client byte counters) — future work if per-client throughput
// is ever needed.
// '.30' StaVlanID exists but emptyClient() has no vlan field — not walked.
const staAuthMode = TABLE + '.80'; // ruckusZDWLANStaAuthMode (DisplayString) — ready-made auth label
const staSignalStrength = TABLE + '.81'; // ruckusZDWLANStaSignalStrength (Integer32, UNITS dBm) → rssi_dbm

// ruckusZDWLANStaRadioType INTEGER enum — DIFFERENT/shifted from the AP-level
// ruckusZDWLANAPRadioStatsRadioType enum in ../ruckus.js (radio11bg(0)/
// radio11a(1)/radio11ng(2)/radio11na(3)/radio11ac(4)). Do NOT reuse that
// mapping here. This table's enum:
//   radio11a(0), radio11na(4), radio11ac(5) -> 5GHz
//   radio11b(1), radio11g(2), radio11ng(3)  -> 2.4GHz
const RUCKUS_STA_BAND = { 0: '5GHz', 1: '2.4GHz', 2: '2.4GHz', 3: '2.4GHz', 4: '5GHz', 5: '5GHz' };

// No tx/rx PHY-rate column exists anywhere in RuckusZDWLANStaEntry (confirmed
// against the primary MIB SEQUENCE — MacAddr, APMacAddr, BSSID, SSID, User,
// RadioType, Channel, IPAddr, AvgRSSI, RxPkts, RxBytes, TxPkts, TxBytes,
// Retries, AssocTime, RxError, TxSuccess, 11bgReassoc, AssocTimestamp,
// RetryBytes, SNR, RxDrop, TxDrop, TxError, VlanID, AuthMode, SignalStrength).
// tx_rate_mbps / rx_rate_mbps therefore stay null unconditionally for Ruckus —
// never guess/repurpose an unrelated column.

async function parseClients(session, apMap) {
  const out = [];
  try {
    const apMacCol = columnMap(await walk(session, staApMac), staApMac);
    const bssidCol = columnMap(await walk(session, staBssid), staBssid);
    const ssid = columnMap(await walk(session, staSsid), staSsid);
    const radio = columnMap(await walk(session, staRadioType), staRadioType);
    const chan = columnMap(await walk(session, staChannel), staChannel);
    const ip = columnMap(await walk(session, staIp), staIp);
    const assocTime = columnMap(await walk(session, staAssocTime), staAssocTime);
    const authMode = columnMap(await walk(session, staAuthMode), staAuthMode);
    const signal = columnMap(await walk(session, staSignalStrength), staSignalStrength);

    const idxs = new Set();
    [apMacCol, bssidCol, ssid, radio, chan, ip, assocTime, authMode, signal].forEach((m) =>
      Object.keys(m).forEach((k) => idxs.add(k))
    );

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6); // table index IS the 6-octet client MAC
      if (!mac) continue;

      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ip[idx]);
      c.ssid_name = str(ssid[idx]);
      c.channel = num(chan[idx]);
      c.auth_type = str(authMode[idx]); // ready-made label, no enum mapping needed

      // Prefer the explicitly dBm-labelled SignalStrength (.81) over the
      // unit-less AvgRSSI (.9) / SNR (.21).
      c.rssi_dbm = num(signal[idx]);

      // tx_rate_mbps / rx_rate_mbps: no PHY-rate column exists in this table.
      c.tx_rate_mbps = null;
      c.rx_rate_mbps = null;

      let band = bandFromCode(radio[idx], RUCKUS_STA_BAND);
      if (!band) band = bandFromChannelNum(c.channel);
      c.band = band;

      // ruckusZDWLANStaAssocTime is TimeTicks (hundredths of a second).
      const ticks = num(assocTime[idx]);
      c.connected_since = connectedSinceFromSeconds(ticks === null ? null : Math.floor(ticks / 100));

      // AP correlation: prefer the AP MAC (.2); fall back to the radio BSSID
      // (.3) if the AP MAC didn't resolve.
      let ap = null;
      const apMac = hexMac(apMacCol[idx]);
      if (apMac) ap = apMap.byMac.get(apMac);
      if (!ap) {
        const bssid = hexMac(bssidCol[idx]);
        if (bssid) ap = apMap.byMac.get(bssid);
      }
      if (ap) {
        c.ap_id = ap.id;
        c.ap_name = ap.name;
      }

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

'use strict';

// Aruba mobility controller (ArubaOS 6/8) wireless CLIENT/STATION parser.
// OIDs verified against WLSX-WLAN-MIB / WLSX-USER-MIB (LibreNMS MIB + oidref).
//
// Primary table: wlsxWlanStationTable (...5.2.2.1.1), INDEX = station MAC as a
// single 6-octet index. It carries the AP BSSID, channel, SSID, tx rate, signal
// (SNR) and uptime — but NOT the station IP or AP name. Those are enriched from
// wlsxUserTable / nUserEntry (...4.1.2.1, INDEX = station MAC(6) + IPv4(4)),
// joined on the station MAC.
//
// The old base (...2.2.1.1.2.1.1) was wlsxSwitchUserEntry — a generic user
// table, not a station table — which is why it returned zero clients.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, macFromHead, hexMac, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

// wlsxWlanStationTable entry — base ...5.2.2.1.1, INDEX = station MAC (6 octets).
const STA_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.2.1.1';
const staApBssid = STA_BASE + '.2';   // wlanStaApBssid (AP radio BSSID)
const staChannel = STA_BASE + '.6';   // wlanStaChannel
const staTxRate = STA_BASE + '.10';   // wlanStaTransmitRate (Mbps)
const staEssid = STA_BASE + '.12';    // wlanStaAccessPointESSID (SSID)
const staRssi = STA_BASE + '.14';     // wlanStaRSSI (signal-to-noise ratio, dB)
const staUpTime = STA_BASE + '.15';   // wlanStaUpTime (TimeTicks, 1/100 s)

// wlsxUserTable / nUserEntry — base ...4.1.2.1, INDEX = station MAC(6) + IPv4(4).
const USER_BASE = '1.3.6.1.4.1.14823.2.2.1.4.1.2.1';
const nUserApName = USER_BASE + '.10'; // nUserApLocation (AP name)

async function parseClients(session, apMap) {
  const out = [];
  try {
    // Enrichment: station MAC -> { ip, apName } from the user table. Its index
    // is MAC(6).IPv4(4); the MAC is the leading 6 octets, the IP the trailing 4.
    const userMap = new Map();
    const apNameCol = columnMap(await walk(session, nUserApName), nUserApName);
    for (const idx of Object.keys(apNameCol)) {
      const parts = idx.split('.');
      if (parts.length < 10) continue;
      const mac = macFromHead(idx, 6);
      if (!mac) continue;
      const ip = parts.slice(parts.length - 4).join('.');
      userMap.set(mac, { ip, apName: str(apNameCol[idx]) });
    }

    // Station table — one row per associated client, indexed by the client MAC.
    const bssid = columnMap(await walk(session, staApBssid), staApBssid);
    const chan = columnMap(await walk(session, staChannel), staChannel);
    const tx = columnMap(await walk(session, staTxRate), staTxRate);
    const essid = columnMap(await walk(session, staEssid), staEssid);
    const rssi = columnMap(await walk(session, staRssi), staRssi);
    const up = columnMap(await walk(session, staUpTime), staUpTime);

    const idxs = new Set();
    [bssid, chan, tx, essid, rssi, up].forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6); // station-table index IS the 6-octet MAC
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;

      const u = userMap.get(mac);
      if (u && u.ip) c.ip_address = u.ip;

      c.ssid_name = str(essid[idx]);
      c.channel = num(chan[idx]);
      c.band = bandFromChannelNum(c.channel);
      c.tx_rate_mbps = num(tx[idx]); // already Mbps (no scaling)

      // wlanStaRSSI is a signal-to-noise RATIO (positive dB). Convert to an
      // approximate RSSI in dBm using a typical -95 dBm noise floor so the
      // dBm-based signal-quality buckets stay meaningful. If a firmware returns
      // a negative dBm value directly, keep it as-is.
      const sig = num(rssi[idx]);
      if (sig !== null) c.rssi_dbm = sig > 0 ? sig - 95 : sig;

      // wlanStaUpTime is TimeTicks (hundredths of a second).
      const ticks = num(up[idx]);
      c.connected_since = connectedSinceFromSeconds(ticks === null ? null : Math.floor(ticks / 100));

      // AP correlation: prefer the AP name from the user table; fall back to the
      // BSSID matched against known AP MACs.
      const apName = u ? u.apName : null;
      let ap = apName ? apMap.byName.get(apName) : null;
      if (!ap) {
        const apb = hexMac(bssid[idx]);
        if (apb) ap = apMap.byMac.get(apb);
      }
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; }
      else if (apName) { c.ap_name = apName; }

      out.push(c);
    }
  } catch (e) {
    console.error('[clients] aruba parseClients failed:', e.message);
    return [];
  }
  return out;
}

module.exports = { parseClients };

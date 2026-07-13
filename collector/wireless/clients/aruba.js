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
//
// Per-client byte counters (nUserEntry .42/.43) — LIVE-VERIFIED, not from
// cached MIB text (none was available for WLSX-USER-MIB at the time). A live
// SNMP walk against 3 real Aruba controllers (~1150 real clients) confirmed
// both columns are Counter64 (8-byte values), growing monotonically at
// byte-count rates roughly 200-470x the growth rate of the smaller-magnitude
// .40/.41 pair sampled alongside them (packet counters), so: .40=TxPackets,
// .41=RxPackets, .42=TxBytes, .43=RxBytes. The .42-vs-.43 direction mapping is
// a WORKING HYPOTHESIS inferred from traffic-ratio statistics (12 real
// clients polled twice, 39s apart: .43 > .42 in 11/12 samples, ratios ~1.4x-
// 27x — consistent with typical download-heavy consumer WiFi, and with the
// common MIB convention of ordering "Input" (into the network, i.e. client
// TX) before "Output" (out to the client, i.e. client RX) in a matching pair)
// — NOT confirmed against an actual MIB DESCRIPTION field. Should be spot-
// checked again post-deploy (e.g. a client mid-large-download should show .43
// increasing fastest).

const { walk } = require('../../snmp-session');
const { columnMap, counterNum } = require('../_util');
const {
  num, str, macFromTail, macFromHead, hexMac, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

// wlsxWlanStationTable entry — base ...5.2.2.1.1, INDEX = station MAC (6 octets).
const STA_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.2.1.1';
const staApBssid = STA_BASE + '.2';   // wlanStaApBssid (AP radio BSSID)
const staChannel = STA_BASE + '.6';   // wlanStaChannel
// wlanStaTransmitRate (.10) is a dead/legacy field on AOS 8.10/8.13 — live SNMP
// walks show it only ever returns {0, 7, 10, 12, 255} across ~1150 real
// stations regardless of actual PHY rate (255 = 0xFF cap/sentinel). Its MIB
// DESCRIPTION doesn't even state a unit. wlanStaTransmitRateCode (.17) is the
// only column in this table whose DESCRIPTION explicitly says "unit is mbps",
// and live data confirms it: the same stations show a realistic, wide spread
// (6-1201 Mbps) matching real 802.11n/ac/ax rate tables, verified against
// ArubaOS 8.10 (7205) and 8.13 (9106) hardware. No scaling needed — raw value
// is already Mbps.
const staTxRate = STA_BASE + '.17';   // wlanStaTransmitRateCode (mbps)
const staEssid = STA_BASE + '.12';    // wlanStaAccessPointESSID (SSID)
const staRssi = STA_BASE + '.14';     // wlanStaRSSI (signal-to-noise ratio, dB)
const staUpTime = STA_BASE + '.15';   // wlanStaUpTime (TimeTicks, 1/100 s)
const staVlanId = STA_BASE + '.7';    // wlanStaVlanId (ArubaVlanValidRange, plain integer)
const staHTMode = STA_BASE + '.16';   // wlanStaHTMode (ArubaHTMode enum) — HT/VHT/HE capability

// ArubaHTMode enum (ARUBA-TC textual convention), verified against the raw MIB
// text: none(1), ht20(2), ht40(3), vht20(4), vht40(5), vht80(6), vht160(7),
// vht80plus80(8), he20(9), he40(10), he80(11), he160(12), he80plus80(13).
// Mapped to a human-readable "802.11<gen> (<width>)" label. none(1) -> null
// (no HT capability negotiated, nothing meaningful to show).
const HT_MODE_LABELS = {
  1: null,
  2: '802.11n (20MHz)',
  3: '802.11n (40MHz)',
  4: '802.11ac (20MHz)',
  5: '802.11ac (40MHz)',
  6: '802.11ac (80MHz)',
  7: '802.11ac (160MHz)',
  8: '802.11ac (80+80MHz)',
  9: '802.11ax (20MHz)',
  10: '802.11ax (40MHz)',
  11: '802.11ax (80MHz)',
  12: '802.11ax (160MHz)',
  13: '802.11ax (80+80MHz)',
};

// wlsxUserTable / nUserEntry — base ...4.1.2.1, INDEX = station MAC(6) + IPv4(4).
const USER_BASE = '1.3.6.1.4.1.14823.2.2.1.4.1.2.1';
const nUserApName = USER_BASE + '.10'; // nUserApLocation (AP name)
// Counter64 byte counters — see the byte-counter comment in the header above
// for the empirical basis of this column-to-direction mapping.
const nUserTxBytes = USER_BASE + '.42'; // client TX bytes (empirically inferred)
const nUserRxBytes = USER_BASE + '.43'; // client RX bytes (empirically inferred)

async function parseClients(session, apMap) {
  const out = [];
  try {
    // Enrichment: station MAC -> { ip, apName, txBytes, rxBytes } from the user
    // table. Its index is MAC(6).IPv4(4); the MAC is the leading 6 octets, the
    // IP the trailing 4.
    const userMap = new Map();
    const apNameCol = columnMap(await walk(session, nUserApName), nUserApName);
    const txBytesCol = columnMap(await walk(session, nUserTxBytes), nUserTxBytes);
    const rxBytesCol = columnMap(await walk(session, nUserRxBytes), nUserRxBytes);
    for (const idx of Object.keys(apNameCol)) {
      const parts = idx.split('.');
      if (parts.length < 10) continue;
      const mac = macFromHead(idx, 6);
      if (!mac) continue;
      const ip = parts.slice(parts.length - 4).join('.');
      userMap.set(mac, {
        ip,
        apName: str(apNameCol[idx]),
        txBytes: counterNum(txBytesCol[idx]),
        rxBytes: counterNum(rxBytesCol[idx]),
      });
    }

    // Station table — one row per associated client, indexed by the client MAC.
    const bssid = columnMap(await walk(session, staApBssid), staApBssid);
    const chan = columnMap(await walk(session, staChannel), staChannel);
    const tx = columnMap(await walk(session, staTxRate), staTxRate);
    const essid = columnMap(await walk(session, staEssid), staEssid);
    const rssi = columnMap(await walk(session, staRssi), staRssi);
    const up = columnMap(await walk(session, staUpTime), staUpTime);
    const vlan = columnMap(await walk(session, staVlanId), staVlanId);
    const htMode = columnMap(await walk(session, staHTMode), staHTMode);

    const idxs = new Set();
    [bssid, chan, tx, essid, rssi, up, vlan, htMode].forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6); // station-table index IS the 6-octet MAC
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;

      const u = userMap.get(mac);
      if (u && u.ip) c.ip_address = u.ip;
      if (u && (u.txBytes !== null || u.rxBytes !== null)) {
        c.tx_bytes = u.txBytes;
        c.rx_bytes = u.rxBytes;
        c.byte_counter_bits = 64; // nUserEntry .42/.43 are confirmed Counter64
      }

      c.ssid_name = str(essid[idx]);
      c.channel = num(chan[idx]);
      c.band = bandFromChannelNum(c.channel);
      c.tx_rate_mbps = num(tx[idx]); // already Mbps (no scaling)

      // wlanStaRSSI is a signal-to-noise RATIO (positive dB). Convert to an
      // approximate RSSI in dBm using a typical -95 dBm noise floor so the
      // dBm-based signal-quality buckets stay meaningful. If a firmware returns
      // a negative dBm value directly, keep it as-is.
      const sig = num(rssi[idx]);
      if (sig !== null) c.rssi_dbm = sig >= 0 ? sig - 95 : sig;

      // wlanStaUpTime is TimeTicks (hundredths of a second).
      const ticks = num(up[idx]);
      c.connected_since = connectedSinceFromSeconds(ticks === null ? null : Math.floor(ticks / 100));

      c.vlan_id = num(vlan[idx]);
      const htCode = num(htMode[idx]);
      c.phy_mode = htCode !== null ? (HT_MODE_LABELS[htCode] || null) : null;

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

'use strict';

// Wireless CLIENT parser for a FortiGate/FortiAP wireless controller
// (fgWcStaTable, FORTINET-FORTIGATE-MIB) — same enterprise MIB family the
// sibling AP-level parser (../fortinet.js) already trusts (fgWc =
// fnFortiGateMib.14 = 1.3.6.1.4.1.12356.101.14), NOT a switch to
// FORTINET-FORTIAP-MIB.
//
// SOURCES (raw ASN.1 text fetched directly, not an AI-summarized page —
// WebFetch's summarizer was unreliable on this same MIB earlier in this
// session, so this file was written straight off the two downloads below):
//   1) https://raw.githubusercontent.com/librenms/librenms/master/mibs/fortinet/FORTINET-FORTIGATE-MIB
//      (fgWcStaTable at line ~10750; includes the newer fgWcStaCPAuth column 22)
//   2) https://raw.githubusercontent.com/netdisco/netdisco-mibs/master/fortinet/fortinet-fortigate-mib.mib
//      (fgWcStaTable at line ~9908; an older MIB revision — identical table
//      name/OID/INDEX and columns 1-21 verbatim, just missing the newer .22
//      fgWcStaCPAuth column, i.e. simple version drift, not a conflict)
// Both independent mirrors agree EXACTLY on: table name, numeric OID, INDEX
// clause, and every column 1-21 (name/SYNTAX/DESCRIPTION/column number) used
// below — HIGH confidence. Also confirmed in both: `fgWc OBJECT IDENTIFIER
// ::= { fnFortiGateMib 14 }`, the same enterprise root ../fortinet.js's
// fgWcWtpSessionTable (fgWc.4.4.1) already uses. No live Fortinet hardware
// in the lab to cross-check against — validate against real hardware.
//
// fgWcStaTable ::= { fgWc 5 } -> base 1.3.6.1.4.1.12356.101.14.5
// fgWcStaEntry ::= { fgWcStaTable 1 } -> 1.3.6.1.4.1.12356.101.14.5.1
// DESCRIPTION: "A table that provides information of all the wireless
// stations that are accessing the wireless service provided by the AC."
// INDEX { fgVdEntIndex, ifIndex, fgWcStaMacAddress } — three components:
// the vdom integer, an ifIndex integer, then the client MAC. MAC is
// PhysAddress (SIZE(6|8)) — a variable-length OCTET STRING, and the INDEX
// clause does NOT mark it IMPLIED, so its OID encoding carries an explicit
// length-prefix sub-id before the octets themselves:
//   <fgVdEntIndex>.<ifIndex>.<macLen>.<octet1>...<octet(macLen)>
// (the same length-prefixed-index convention ../fortinet.js's AP-level
// wtpNameFromIndex() already decodes for the WTP-id string in
// fgWcWtpSessionTable — see that file's header). This parser only handles
// the overwhelmingly common macLen===6 case (a real 802.11 client MAC); the
// rare macLen===8 alternative is left unhandled (row skipped) rather than
// guessed at.
//
// AP correlation: fgWcStaWtpId ("Unique identifier of the WTP that a
// wireless station is connected to") is the SAME WTP-id string
// ../fortinet.js's parseApTable() decodes into ap.name (via
// wtpNameFromIndex on the AP-level table's own index) — so this table can
// be joined straight onto apMap.byName, no MAC/BSSID correlation needed
// (and none would work anyway: ../fortinet.js never populates
// ap.mac_address, so apMap.byMac is always empty for this vendor).
//
// NOT populated (no correct OID / deliberately dropped):
//   • connected_since — fgWcStaIdle (.14) is INACTIVE time ("how long a
//     wireless station is inactive, in seconds"), not an association/uptime
//     duration, so no join-time can be derived from it → null (same
//     reasoning clients/cisco.js documents for its own missing uptime OID).
//   • tx_rate_mbps / rx_rate_mbps — fgWcStaBandwidthTx/Rx (.15/.16) are
//     Gauge32 "TX/RX bandwidth ... in kbps", i.e. an instantaneous
//     throughput/usage reading, NOT a negotiated PHY link rate (contrast
//     Aruba's wlanStaTransmitRateCode, whose MIB text explicitly says
//     "unit is mbps" for the PHY rate). Populating tx_rate_mbps from a
//     bandwidth-usage gauge would be misleading, so left null.
//   • rx_bytes / tx_bytes / byte_counter_bits — for the SAME reason: this
//     table has no CUMULATIVE byte/octet counter anywhere in
//     FgWcStaEntry's SEQUENCE (only the instantaneous BandwidthTx/Rx Gauge32
//     kbps pair above). wirelessCollector.js's deriveThroughput() computes
//     rx_bps/tx_bps strictly from the DELTA between two cumulative-counter
//     polls (see collector/wirelessCollector.js pollClients()); feeding it
//     an already-instantaneous Gauge32 as if it were a monotonic counter
//     would produce garbage deltas (this repo's wireless bandwidth path has
//     already had several real bugs of exactly this shape — see the
//     1.72.2-1.72.5 fix commits). There is also no schema field to carry an
//     already-computed instantaneous rate directly (rx_bps/tx_bps are only
//     ever written by deriveThroughput()). So Fortinet client bandwidth
//     stays unpopulated rather than shipping a wrong number — a real gap
//     versus Aruba/Cisco/Ruckus, not an oversight.
//   • auth_type uses fgWcStaSecurity (.19), not fgWcStaEncrypt (.20) — the
//     Security enum (open/captivePortal/wep/wpa*/wpa3*/osen) is the more
//     complete/informative label of the two; Encrypt (other/none/tkip/aes/
//     tkipAes) is not separately surfaced (no second auth-ish field in
//     emptyClient() to put it in).
//   • fgWcStaUser / fgWcStaGroup / fgWcStaVci — no destination field in
//     emptyClient() (username/usergroup/DHCP-vendor-class-id); not walked.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const { num, str, emptyClient, bandFromChannelNum } = require('./_util');

// fgWcStaEntry — base 1.3.6.1.4.1.12356.101.14.5.1, INDEX =
// { fgVdEntIndex, ifIndex, fgWcStaMacAddress } (see header for the
// length-prefixed MAC encoding this produces in the OID index tail).
const TABLE = '1.3.6.1.4.1.12356.101.14.5.1';
// '.1' fgWcStaMacAddress is the index itself (not-accessible) — not walked
// as a column; decoded from the index tail by macFromStaIndex() below.
const cWlan       = TABLE + '.2';  // fgWcStaWlan — WLAN interface the station is on (see AP-correlation note)
const cWtpId      = TABLE + '.3';  // fgWcStaWtpId — WTP id, joins onto apMap.byName (see header)
// '.4' fgWcStaRadioId (FgWcWtpRadioId) — a bare radio-slot integer with no
// band information of its own (band comes from RadioType at .18 instead);
// no destination field in emptyClient() for a raw radio-slot id, not walked.
const cVlanId      = TABLE + '.5';  // fgWcStaVlanId -> vlan_id
const cIpAddrType  = TABLE + '.6';  // fgWcStaIpAddressType — ipv4(1) | ipv6(2), gates decoding of .7
const cIpAddr      = TABLE + '.7';  // fgWcStaIpAddress (InetAddress) -> ip_address
// '.8' fgWcStaVci, '.10' fgWcStaUser, '.11' fgWcStaGroup — see header, not walked.
const cHost        = TABLE + '.9';  // fgWcStaHost — "host name of a wireless station" -> hostname (direct)
const cSignal      = TABLE + '.12'; // fgWcStaSignal (Integer32, dBm) -> rssi_dbm
// '.13' fgWcStaNoise (dBm) — no per-CLIENT noise-floor field in emptyClient()
// (noise_floor_2g/_5g are AP-level only); not walked.
// '.14' fgWcStaIdle, '.15'/'.16' BandwidthTx/Rx — see header, not walked.
const cChannel     = TABLE + '.17'; // fgWcStaChannel (FgWcWtpRadioChannelNumber, Integer32 0..255)
const cRadioType   = TABLE + '.18'; // fgWcStaRadioType (FgWcWtpRadioType) -> band + phy_mode
const cSecurity    = TABLE + '.19'; // fgWcStaSecurity (FgWcWlanSecurityType) -> auth_type
// '.20' fgWcStaEncrypt — see header (auth_type note), not walked.
const cOnline      = TABLE + '.21'; // fgWcStaOnline INTEGER {yes(1),no(2)} — filters out explicitly-offline rows
// '.22' fgWcStaCPAuth only exists on newer FortiOS builds (absent from the
// older of the two mirrors above) and has no destination field anyway; not walked.

// Cap every per-client walk, matching clients/cisco.js's WALK_ROW_CAP
// convention — a large FortiGate WLC deployment can carry thousands of
// stations, and an uncapped subtree walk per column could run for minutes.
const WALK_ROW_CAP = 5000;

// FgWcWtpRadioType (raw MIB enum, verified against both mirrors above) ->
// band. Also doubles as the phy_mode label source below (same column drives
// both — this table has no separate channel-width column to append, unlike
// Aruba's ArubaHTMode which additionally encodes width).
//   2.4GHz: dot11b(2), dot11g(3), dot11n2g(5), dot11ngOnly(7), dot11gOnly(8),
//           dot11n2GHzOnly(9), dot11ax2g(13), dot11axng2gOnly(16),
//           dot11axn2gOnly(17), dot11ax2gOnly(18)
//   5GHz:   dot11a(1), dot11n5g(4), dot11ac(6), dot11n5GHzOnly(10),
//           dot11acnOnly(11), dot11acOnly(12), dot11ax5g(14),
//           dot11axacn5gOnly(19), dot11axac5gOnly(20), dot11ax5gOnly(21)
//   6GHz:   dot11ax6g(15)
//   other(0) -> null (fall back to channel-number heuristic below)
const RADIO_BAND = {
  1: '5GHz', 2: '2.4GHz', 3: '2.4GHz', 4: '5GHz', 5: '2.4GHz', 6: '5GHz',
  7: '2.4GHz', 8: '2.4GHz', 9: '2.4GHz', 10: '5GHz', 11: '5GHz', 12: '5GHz',
  13: '2.4GHz', 14: '5GHz', 15: '6GHz', 16: '2.4GHz', 17: '2.4GHz', 18: '2.4GHz',
  19: '5GHz', 20: '5GHz', 21: '5GHz',
};

// Same enum -> a human phy_mode label (no channel-width data in this table,
// so unlike Aruba's HT_MODE_LABELS these can't say "(80MHz)" etc.).
const RADIO_PHY_LABEL = {
  1: '802.11a', 2: '802.11b', 3: '802.11g', 4: '802.11n (5GHz)',
  5: '802.11n (2.4GHz)', 6: '802.11ac', 7: '802.11n (2.4GHz)', 8: '802.11g',
  9: '802.11n (2.4GHz)', 10: '802.11n (5GHz)', 11: '802.11ac/n', 12: '802.11ac',
  13: '802.11ax (2.4GHz)', 14: '802.11ax (5GHz)', 15: '802.11ax (6GHz)',
  16: '802.11ax/n (2.4GHz)', 17: '802.11ax/n (2.4GHz)', 18: '802.11ax (2.4GHz)',
  19: '802.11ax/ac/n (5GHz)', 20: '802.11ax/ac (5GHz)', 21: '802.11ax (5GHz)',
};

// FgWcWlanSecurityType (raw MIB enum) -> auth_type label.
const SECURITY_LABELS = {
  0: 'other',
  1: 'open',
  2: 'captive-portal',
  3: 'wep64',
  4: 'wep128',
  5: 'wpa-personal',
  6: 'wpa-enterprise',
  7: 'wpa2-personal',
  8: 'wpa2-enterprise',
  9: 'wpa-personal',
  10: 'wpa-enterprise',
  11: 'wpa-personal-captive-portal',
  12: 'wpa2-personal-captive-portal',
  13: 'wpa-personal-captive-portal',
  14: 'wpa3-sae',
  15: 'wpa3-sae-transition',
  16: 'wpa3-enterprise',
  17: 'wpa3-owe',
  18: 'osen',
};
function authTypeFromSecurity(v) {
  const n = num(v);
  if (n === null) return null;
  return SECURITY_LABELS[n] !== undefined ? SECURITY_LABELS[n] : 'other';
}

// Decode the { fgVdEntIndex, ifIndex, fgWcStaMacAddress } index into the
// client MAC (see header for the length-prefixed-PhysAddress shape). Only
// handles the standard 6-octet MAC case; returns null for anything else
// (an 8-octet PhysAddress, or a malformed/short index) rather than guessing.
// Never throws.
function macFromStaIndex(idx) {
  try {
    if (idx === null || idx === undefined) return null;
    const parts = String(idx).split('.').map(Number);
    if (parts.length < 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
    const macLen = parts[2];
    if (macLen !== 6) return null; // 8-octet PhysAddress not handled — see header
    if (parts.length !== 3 + macLen) return null;
    const octets = parts.slice(3);
    if (octets.some((o) => o > 255)) return null;
    return octets.map((o) => o.toString(16).padStart(2, '0')).join(':');
  } catch (e) {
    return null;
  }
}

// Decode an InetAddress value (raw OCTET STRING — NOT the special tagged
// IpAddress type, so net-snmp delivers it as a Buffer, not an
// auto-formatted dotted string) against its companion InetAddressType
// column. fgWcStaIpAddressType's DESCRIPTION explicitly limits it to
// ipv4(1)/ipv6(2) ("Only ipv4(1) and ipv6(2) are supported by the object."),
// matching the standard InetAddressType TC values. Never throws.
function decodeInetAddress(typeVal, addrVal) {
  try {
    const t = num(typeVal);
    if (Buffer.isBuffer(addrVal)) {
      if (t === 1 && addrVal.length === 4) return Array.from(addrVal).join('.');
      if (t === 2 && addrVal.length === 16) {
        const groups = [];
        for (let i = 0; i < 16; i += 2) groups.push(((addrVal[i] << 8) | addrVal[i + 1]).toString(16));
        return groups.join(':');
      }
      // Type column didn't answer for this row — fall back to buffer length.
      if (t === null && addrVal.length === 4) return Array.from(addrVal).join('.');
      return null;
    }
    // Some net-snmp/agent combinations may already deliver a decoded string.
    const s = str(addrVal);
    return s && /^\d+\.\d+\.\d+\.\d+$/.test(s) ? s : null;
  } catch (e) {
    return null;
  }
}

async function parseClients(session, apMap) {
  const out = [];
  try {
    const wlan = columnMap(await walk(session, cWlan, WALK_ROW_CAP), cWlan);
    const wtpId = columnMap(await walk(session, cWtpId, WALK_ROW_CAP), cWtpId);
    const vlan = columnMap(await walk(session, cVlanId, WALK_ROW_CAP), cVlanId);
    const ipType = columnMap(await walk(session, cIpAddrType, WALK_ROW_CAP), cIpAddrType);
    const ip = columnMap(await walk(session, cIpAddr, WALK_ROW_CAP), cIpAddr);
    const host = columnMap(await walk(session, cHost, WALK_ROW_CAP), cHost);
    const signal = columnMap(await walk(session, cSignal, WALK_ROW_CAP), cSignal);
    const channel = columnMap(await walk(session, cChannel, WALK_ROW_CAP), cChannel);
    const radioType = columnMap(await walk(session, cRadioType, WALK_ROW_CAP), cRadioType);
    const security = columnMap(await walk(session, cSecurity, WALK_ROW_CAP), cSecurity);
    const online = columnMap(await walk(session, cOnline, WALK_ROW_CAP), cOnline);

    const idxs = new Set();
    [wlan, wtpId, vlan, ipType, ip, host, signal, channel, radioType, security, online].forEach((m) =>
      Object.keys(m).forEach((k) => idxs.add(k))
    );

    for (const idx of idxs) {
      // fgWcStaOnline: yes(1)/no(2). Skip rows explicitly marked offline;
      // a missing/unanswered column is treated as online (this table's own
      // DESCRIPTION says it lists stations "accessing the wireless service",
      // so an unset flag defaults to "still in the table = still relevant").
      if (num(online[idx]) === 2) continue;

      const mac = macFromStaIndex(idx);
      if (!mac) continue;

      const c = emptyClient();
      c.mac_address = mac;
      c.hostname = str(host[idx]);
      c.ssid_name = str(wlan[idx]);
      c.vlan_id = num(vlan[idx]);
      c.channel = num(channel[idx]);
      c.rssi_dbm = num(signal[idx]);
      c.ip_address = decodeInetAddress(ipType[idx], ip[idx]);
      c.auth_type = authTypeFromSecurity(security[idx]);

      const radioCode = num(radioType[idx]);
      c.band = (radioCode !== null && RADIO_BAND[radioCode]) || bandFromChannelNum(c.channel);
      c.phy_mode = radioCode !== null ? (RADIO_PHY_LABEL[radioCode] || null) : null;

      // AP correlation via fgWcStaWtpId -> apMap.byName (see header; no MAC/
      // BSSID fallback exists/works for this vendor).
      const wtpIdStr = str(wtpId[idx]);
      const ap = wtpIdStr ? apMap.byName.get(wtpIdStr) : null;
      if (ap) {
        c.ap_id = ap.id;
        c.ap_name = ap.name;
      } else if (wtpIdStr) {
        c.ap_name = wtpIdStr; // unresolved WTP id — still surface it as a label
      }

      // connected_since / tx_rate_mbps / rx_rate_mbps / rx_bytes / tx_bytes /
      // byte_counter_bits intentionally left null — see header comment.

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

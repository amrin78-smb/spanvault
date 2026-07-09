'use strict';

// Fortinet (FortiGate wireless controller) parser.
// OIDs verified against FORTINET-FORTIGATE-MIB (LibreNMS MIB mirror).
//
// The live per-AP data lives in fgWcWtpSessionTable (…14.4.4), NOT the
// fgWcWtpConfigTable (…14.4.3) this parser previously walked — the config
// table describes provisioned WTP profiles, not connected APs.
//
// fgWcWtpSessionEntry INDEX = { fgVdEntIndex, fgWcWtpSessionWtpId }: the vdom
// integer, then the WTP id as a length-prefixed string encoded into the OID
// (first sub-id after the vdom = string length, then that many char codes).
// There is no readable name column in the table, so the AP name is decoded
// from that index. Column suffixes pending validation on real hardware.

const { num, str, columnMap, emptyAp } = require('./_util');

// fgWcWtpSessionTable: 1.3.6.1.4.1.12356.101.14.4.4.1
const WTP_SESSION_BASE = '1.3.6.1.4.1.12356.101.14.4.4.1';
// fgWcWtpSessionWtpLocalIpAddress — the AP's own IP. ('.3' is
// fgWcWtpSessionWtpIpAddr, an InetAddress alternative, if '.5' proves empty
// on real hardware.)
const fgWcWtpSessionWtpLocalIpAddress = WTP_SESSION_BASE + '.5';
// fgWcWtpSessionConnectionState INTEGER: other(0), offLine(1), onLine(2).
const fgWcWtpSessionConnectionState = WTP_SESSION_BASE + '.7';
// fgWcWtpSessionWtpStationCount (Gauge32) — associated clients.
const fgWcWtpSessionWtpStationCount = WTP_SESSION_BASE + '.17';

// fgWcWtpSessionConnectionState: other(0), offLine(1), onLine(2).
function mapStatus(v) {
  const n = num(v);
  if (n === 2) return 'online';
  if (n === 1) return 'offline';
  if (n === 0) return 'unknown'; // other(0)
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('offline') || l.includes('down') || l.includes('disconnect')) return 'offline';
    if (l.includes('online') || l.includes('connect') || l.includes('up')) return 'online';
  }
  return 'unknown';
}

// Decode the WTP id from the table index. INDEX = {fgVdEntIndex,
// fgWcWtpSessionWtpId}: the first sub-id is the vdom integer, the second is
// the WTP-id string length, then that many character codes. Returns the
// decoded ASCII name, or null when the index doesn't fit that shape
// (defensive — never throws).
function wtpNameFromIndex(idx) {
  try {
    if (idx === null || idx === undefined) return null;
    const parts = String(idx).split('.').map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
    const len = parts[1];
    if (len <= 0 || parts.length < 2 + len) return null;
    const codes = parts.slice(2, 2 + len);
    if (codes.some((c) => c < 32 || c > 126)) return null; // non-printable → bail
    const name = String.fromCharCode.apply(null, codes).trim();
    return name.length ? name : null;
  } catch (e) {
    return null;
  }
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const ips = columnMap(walked.wtpIp, fgWcWtpSessionWtpLocalIpAddress);
    const states = columnMap(walked.wtpState, fgWcWtpSessionConnectionState);
    const stations = columnMap(walked.wtpStations, fgWcWtpSessionWtpStationCount);

    const indexes = new Set();
    [ips, states, stations].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx; // full index (vdom + length-prefixed WTP id)
      // No readable name column — decode the WTP id from the index; fall back
      // to the raw index so the AP is still uniquely identified.
      ap.name = wtpNameFromIndex(idx) || `wtp-${idx}`;
      ap.ip_address = str(ips[idx]);
      ap.status = mapStatus(states[idx]);

      const c = num(stations[idx]);
      ap.clients_total = c === null ? 0 : c;

      out.push(ap);
    }
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  const out = [];
  try {
    walked = walked || {};
    const stations = columnMap(walked.wtpStations, fgWcWtpSessionWtpStationCount);
    for (const idx of Object.keys(stations)) {
      const c = num(stations[idx]);
      out.push({ apKey: idx, clients: c === null ? 0 : c });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

module.exports = {
  name: 'fortinet',
  snmpOids: {
    wtpIp: fgWcWtpSessionWtpLocalIpAddress,
    wtpState: fgWcWtpSessionConnectionState,
    wtpStations: fgWcWtpSessionWtpStationCount,
  },
  parseApTable,
  parseClientCounts,
};

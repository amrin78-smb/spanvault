'use strict';

// Fortinet (FortiGate wireless controller) parser.
// OIDs from FORTINET-FORTIGATE-MIB, fgWcWtpTable.
// NOTE: column suffixes are best-effort / approximate from the MIB and will
// be validated against real hardware later.

const { num, str, columnMap, emptyAp } = require('./_util');

// fgWcWtpTable: 1.3.6.1.4.1.12356.101.14.4.3.1
const WTP_BASE = '1.3.6.1.4.1.12356.101.14.4.3.1';
const fgWcWtpId = WTP_BASE + '.1'; // WTP id / local id
const fgWcWtpLocalId = WTP_BASE + '.2'; // best-effort
const fgWcWtpIpAddress = WTP_BASE + '.4'; // best-effort
const fgWcWtpConnectionState = WTP_BASE + '.6'; // best-effort
const fgWcWtpStationCount = WTP_BASE + '.16'; // best-effort: associated clients

function mapStatus(v) {
  const n = num(v);
  // fgWcWtpConnectionState: commonly 1 = connected/up, 2 = down (approx)
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('connect') || l.includes('up') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline') || l.includes('disconnect')) return 'offline';
  }
  return 'unknown';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const ids = columnMap(walked.wtpId, fgWcWtpId);
    const localIds = columnMap(walked.wtpLocalId, fgWcWtpLocalId);
    const ips = columnMap(walked.wtpIp, fgWcWtpIpAddress);
    const states = columnMap(walked.wtpState, fgWcWtpConnectionState);
    const stations = columnMap(walked.wtpStations, fgWcWtpStationCount);

    const indexes = new Set();
    [ids, localIds, ips, states, stations].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(localIds[idx]) || str(ids[idx]) || idx;
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
    const stations = columnMap(walked.wtpStations, fgWcWtpStationCount);
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
    wtpId: fgWcWtpId,
    wtpLocalId: fgWcWtpLocalId,
    wtpIp: fgWcWtpIpAddress,
    wtpState: fgWcWtpConnectionState,
    wtpStations: fgWcWtpStationCount,
  },
  parseApTable,
  parseClientCounts,
};

'use strict';

// MikroTik wireless parser.
// OIDs from MIKROTIK-MIB.
// - mtxrWlCMChannelTable: CAPsMAN channel info.
// - mtxrWlRtabTable: wireless registration table (each row = one client).
// MikroTik standalone APs expose clients via the registration table; AP
// identity comes from the wireless interface name.
// NOTE: column suffixes are best-effort / approximate from the MIB and will
// be validated against real hardware later.

const { num, str, columnMap, bandForChannel, emptyAp } = require('./_util');

// mtxrWlRtabTable: 1.3.6.1.4.1.14988.1.1.1.2.1 (registration table = clients)
const RTAB_BASE = '1.3.6.1.4.1.14988.1.1.1.2.1';
const mtxrWlRtabAddr = RTAB_BASE + '.1'; // client MAC (registration row)
const mtxrWlRtabIface = RTAB_BASE + '.7'; // best-effort: interface name/index the client is on

// mtxrWlCMChannelTable: 1.3.6.1.4.1.14988.1.1.1.3.1 (CAPsMAN channel info)
const CM_BASE = '1.3.6.1.4.1.14988.1.1.1.3.1';
const mtxrWlCMChannelName = CM_BASE + '.2'; // best-effort: interface/radio name
const mtxrWlCMChannelFreq = CM_BASE + '.4'; // best-effort: frequency (MHz)

// ifTable name (used to label the AP / radio interface).
const ifDescr = '1.3.6.1.2.1.2.2.1.2';

// Convert a frequency in MHz to an approximate channel band hint.
function bandForFreq(freqMhz) {
  const f = num(freqMhz);
  if (f === null) return null;
  if (f >= 2400 && f < 2500) return '2g';
  if (f >= 5000 && f < 5900) return '5g';
  if (f >= 5925) return '6g';
  return null;
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};

    // Build one AP per wireless interface (CAPsMAN channel table or ifDescr).
    const chanNames = columnMap(walked.cmName, mtxrWlCMChannelName);
    const chanFreqs = columnMap(walked.cmFreq, mtxrWlCMChannelFreq);
    const ifNames = columnMap(walked.ifDescr, ifDescr);

    // Count clients per interface index from the registration table.
    const counts = countRegByIface(walked);

    const indexes = new Set();
    Object.keys(chanNames).forEach((k) => indexes.add(k));
    Object.keys(chanFreqs).forEach((k) => indexes.add(k));

    // If no CAPsMAN channel rows, fall back to interface names that look wireless.
    if (indexes.size === 0) {
      for (const idx of Object.keys(ifNames)) {
        const nm = str(ifNames[idx]);
        if (nm && /wlan|wifi|wireless|cap/i.test(nm)) indexes.add(idx);
      }
    }

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(chanNames[idx]) || str(ifNames[idx]) || idx;
      ap.status = 'online'; // a present radio interface is treated as online

      const band = bandForFreq(chanFreqs[idx]);
      const ch = num(chanFreqs[idx]);
      // We store frequency-derived band only; channel number unknown from freq, leave null.
      if (band === null) {
        const b2 = bandForChannel(ch);
        if (b2 === '2g') ap.radio_2g_channel = ch;
        else if (b2 === '5g') ap.radio_5g_channel = ch;
        else if (b2 === '6g') ap.radio_6g_channel = ch;
      }

      const c = counts[idx];
      ap.clients_total = c === undefined ? 0 : c;

      out.push(ap);
    }

    // If we found no interfaces at all but there are registrations, emit a single
    // device-level AP carrying the total client count.
    if (out.length === 0) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0 || (Array.isArray(walked.rtabAddr) && walked.rtabAddr.length)) {
        const ap = emptyAp();
        ap._index = null;
        ap.name = 'MikroTik AP';
        ap.status = 'online';
        ap.clients_total = total;
        out.push(ap);
      }
    }
  } catch (e) {
    // never throw
  }
  return out;
}

// Count registration-table rows grouped by interface index.
function countRegByIface(walked) {
  const counts = {};
  try {
    const ifaceRows = Array.isArray(walked.rtabIface) ? walked.rtabIface : [];
    if (ifaceRows.length) {
      for (const r of ifaceRows) {
        if (!r) continue;
        const key = str(r.value) || num(r.value);
        const k = key === null ? 'unknown' : String(key);
        counts[k] = (counts[k] || 0) + 1;
      }
      return counts;
    }
    // No iface column: cannot group, return empty (caller falls back to total).
  } catch (e) {
    // never throw
  }
  return counts;
}

function parseClientCounts(walked) {
  const out = [];
  try {
    walked = walked || {};
    const counts = countRegByIface(walked);
    const keys = Object.keys(counts);
    if (keys.length) {
      for (const idx of keys) out.push({ apKey: idx, clients: counts[idx] });
      return out;
    }
    // Fall back: total registration rows as a single count.
    const addrRows = Array.isArray(walked.rtabAddr) ? walked.rtabAddr : [];
    if (addrRows.length) out.push({ apKey: 'total', clients: addrRows.length });
  } catch (e) {
    // never throw
  }
  return out;
}

module.exports = {
  name: 'mikrotik',
  snmpOids: {
    rtabAddr: mtxrWlRtabAddr,
    rtabIface: mtxrWlRtabIface,
    cmName: mtxrWlCMChannelName,
    cmFreq: mtxrWlCMChannelFreq,
    ifDescr: ifDescr,
  },
  parseApTable,
  parseClientCounts,
};

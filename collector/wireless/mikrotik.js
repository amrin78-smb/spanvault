'use strict';

// MikroTik wireless parser.
// OIDs verified against MIKROTIK-MIB (LibreNMS MIB mirror).
// - mtxrWlApTable (…1.1.1.3.1): one row per WIRELESS INTERFACE on the device
//   (despite the historical "CAPsMAN channel table" label) — SSID, frequency,
//   client count and noise floor per radio interface.
// - mtxrWlRtabTable (…1.1.1.2.1): registration table, one row per associated
//   CLIENT. INDEX = MacAddr (6 sub-ids) + iface index, so clients are grouped
//   by the LAST index component. NOTE: the walk is unbounded (one row per
//   client); the row cap lives in the shared collector (PARSER_WALK_ROW_CAP),
//   out of scope here.
// Column suffixes pending validation on real hardware.

const { num, str, columnMap, emptyAp } = require('./_util');

// mtxrWlRtabTable: 1.3.6.1.4.1.14988.1.1.1.2.1 (registration table = clients).
// '.1' (Addr) and '.2' (Iface) are not-accessible INDEX columns — walking them
// returns nothing. Walk an accessible data column instead ('.3' Strength) and
// recover the interface from the index tail.
const RTAB_BASE = '1.3.6.1.4.1.14988.1.1.1.2.1';
const mtxrWlRtabStrength = RTAB_BASE + '.3'; // signal strength (accessible; used for row/iface enumeration)

// mtxrWlApTable: 1.3.6.1.4.1.14988.1.1.1.3.1 (per wireless interface).
const AP_BASE = '1.3.6.1.4.1.14988.1.1.1.3.1';
const mtxrWlApSsid = AP_BASE + '.4'; // mtxrWlApSsid (the SSID string)
const mtxrWlApClientCount = AP_BASE + '.6'; // mtxrWlApClientCount (Counter32, plain number)
const mtxrWlApFreq = AP_BASE + '.7'; // mtxrWlApFreq (MHz)
const mtxrWlApNoiseFloor = AP_BASE + '.9'; // mtxrWlApNoiseFloor (negative dBm)

// ifTable name (used to label the AP / radio interface).
const ifDescr = '1.3.6.1.2.1.2.2.1.2';

// Convert a frequency in MHz to a band. Channel NUMBER derivation from the
// frequency is intentionally skipped (left null) — band is what the per-band
// metrics need.
function bandForFreq(freqMhz) {
  const f = num(freqMhz);
  if (f === null) return null;
  if (f >= 2400 && f <= 2500) return '2g';
  if (f >= 4900 && f <= 6100) return '5g';
  return null;
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};

    // Build one AP per wireless interface (mtxrWlApTable or ifDescr fallback).
    const ssids = columnMap(walked.apSsid, mtxrWlApSsid);
    const freqs = columnMap(walked.apFreq, mtxrWlApFreq);
    const apClients = columnMap(walked.apClientCount, mtxrWlApClientCount);
    const noiseFloors = columnMap(walked.apNoiseFloor, mtxrWlApNoiseFloor);
    const ifNames = columnMap(walked.ifDescr, ifDescr);

    // Count clients per interface index from the registration table.
    const counts = countRegByIface(walked);

    const indexes = new Set();
    [ssids, freqs, apClients, noiseFloors].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    // If no mtxrWlApTable rows, fall back to interface names that look wireless.
    if (indexes.size === 0) {
      for (const idx of Object.keys(ifNames)) {
        const nm = str(ifNames[idx]);
        if (nm && /wlan|wifi|wireless|cap/i.test(nm)) indexes.add(idx);
      }
    }

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      // Prefix the device vendor so two MikroTik devices at the same site do
      // not collide on a bare interface label in the site-merge.
      const ssid = str(ssids[idx]);
      ap.name = `MikroTik ${ssid || str(ifNames[idx]) || 'wlan' + idx}`;
      ap.status = 'online'; // a present radio interface is treated as online

      // Band from the frequency (MHz). Channel number is not derivable here —
      // channels stay null (acceptable; band-level metrics still attribute).
      const band = bandForFreq(freqs[idx]);
      const nf = num(noiseFloors[idx]);
      // Interface client count: prefer mtxrWlApClientCount, else the
      // registration-table row count for this interface.
      let c = num(apClients[idx]);
      if (c === null) c = counts[idx] === undefined ? null : counts[idx];

      if (band === '2g') {
        if (c !== null) ap.clients_2g = c;
        if (nf !== null) ap.noise_floor_2g = nf;
      } else if (band === '5g') {
        if (c !== null) ap.clients_5g = c;
        if (nf !== null) ap.noise_floor_5g = nf;
      }

      ap.clients_total = c === null ? 0 : c;

      out.push(ap);
    }

    // If we found no interfaces at all but there are registrations, emit a single
    // device-level AP carrying the total client count.
    if (out.length === 0) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0 || (Array.isArray(walked.rtabStrength) && walked.rtabStrength.length)) {
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

// Count registration-table rows grouped by interface index. The row index is
// MacAddr (6 sub-ids) + iface, so the interface is the LAST index component.
function countRegByIface(walked) {
  const counts = {};
  try {
    const rows = columnMap(walked.rtabStrength, mtxrWlRtabStrength);
    for (const idx of Object.keys(rows)) {
      const parts = String(idx).split('.');
      const iface = parts[parts.length - 1];
      if (!iface) continue;
      counts[iface] = (counts[iface] || 0) + 1;
    }
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
    // Fall back: per-interface client counts from mtxrWlApTable.
    const apClients = columnMap(walked.apClientCount, mtxrWlApClientCount);
    for (const idx of Object.keys(apClients)) {
      const c = num(apClients[idx]);
      if (c !== null) out.push({ apKey: idx, clients: c });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

module.exports = {
  name: 'mikrotik',
  snmpOids: {
    rtabStrength: mtxrWlRtabStrength,
    apSsid: mtxrWlApSsid,
    apClientCount: mtxrWlApClientCount,
    apFreq: mtxrWlApFreq,
    apNoiseFloor: mtxrWlApNoiseFloor,
    ifDescr: ifDescr,
  },
  parseApTable,
  parseClientCounts,
};

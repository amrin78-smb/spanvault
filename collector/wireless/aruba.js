'use strict';

// Aruba mobility controller (ArubaOS 6/8) wireless parser.
// OIDs verified against WLSX-WLAN-MIB (LibreNMS MIB source + oidref.com).
//
// Tables (all under the Aruba enterprise prefix 1.3.6.1.4.1.14823):
//   • wlsxWlanAPTable     ...5.2.1.4.1  — one row per AP, indexed by AP MAC
//     (6-octet PhysAddress → 6 dotted sub-identifiers).
//   • wlsxWlanRadioTable  ...5.2.1.5.1  — one row per AP+radio, indexed by
//     AP MAC + radioNumber (7 sub-identifiers). Holds channel, utilization,
//     and per-radio associated clients. The radio NUMBER (1/2) is NOT a fixed
//     band, so band is derived from the reported channel number.
//   • wlsxWlanESSIDTable  ...5.2.1.8.1  — one row per SSID, indexed by the
//     (string-encoded) SSID name. Holds the SSID name + station count.
//
// NOT available on a mobility controller (left null, never faked):
//   • per-radio noise floor / frame-retry rate (no such columns here)
//   • per-SSID byte counters and auth success/failure counters

const {
  num, str, columnMap, bandForChannel, emptyAp, splitRadioIndex,
} = require('./_util');

// ── AP table (wlsxWlanAPTable) — base ...5.2.1.4.1, index = AP MAC (6 octets) ─
const AP_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.4.1';
const wlanAPIpAddress = AP_BASE + '.2';  // wlanAPIpAddress
const wlanAPName = AP_BASE + '.3';        // wlanAPName
const wlanAPUpTime = AP_BASE + '.12';     // wlanAPUpTime (seconds)
const wlanAPModelName = AP_BASE + '.13';  // wlanAPModelName (readable model string)
const wlanAPStatus = AP_BASE + '.19';     // wlanAPStatus: up(1) / down(2)

// ── Radio table (wlsxWlanRadioTable) — base ...5.2.1.5.1 ─────────────────────
// Index = AP MAC (6 octets) + radioNumber. Band is derived from the channel.
const RADIO_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.5.1';
const wlanAPRadioChannel = RADIO_BASE + '.3';               // wlanAPRadioChannel
const wlanAPRadioUtilization = RADIO_BASE + '.6';           // wlanAPRadioUtilization (%)
const wlanAPRadioNumAssociatedClients = RADIO_BASE + '.7';  // wlanAPRadioNumAssociatedClients

// ── ESSID table (wlsxWlanESSIDTable) — base ...5.2.1.8.1 ─────────────────────
// Index = the (length-prefixed) SSID name. wlanESSID's value is the name string.
const ESSID_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.8.1';
const wlanESSID = ESSID_BASE + '.1';            // wlanESSID (name; also the index)
const wlanESSIDNumStations = ESSID_BASE + '.2'; // wlanESSIDNumStations (client count)

function mapStatus(v) {
  const n = num(v);
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline')) return 'offline';
  }
  return 'unknown';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const ips = columnMap(walked.apIp, wlanAPIpAddress);
    const names = columnMap(walked.apName, wlanAPName);
    const uptimes = columnMap(walked.apUptime, wlanAPUpTime);
    const models = columnMap(walked.apModel, wlanAPModelName);
    const statuses = columnMap(walked.apStatus, wlanAPStatus);

    const indexes = new Set();
    [ips, names, uptimes, models, statuses].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    const byIndex = new Map();
    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(names[idx]) || idx;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);
      const up = num(uptimes[idx]);
      if (up !== null) ap.uptime_seconds = up;
      out.push(ap);
      byIndex.set(idx, ap);
    }

    // ── Correlate per-radio metrics. The radio index is "<apMAC>.<radioNum>",
    //    so the apKey (everything before the last dot) matches the AP-table
    //    index. Band comes from the reported channel (≤14 = 2.4G, else 5/6G) —
    //    radioNum (1/2) is not a reliable band on its own.
    const radioChan = columnMap(walked.radioChannel, wlanAPRadioChannel);
    const radioUtil = columnMap(walked.radioUtil, wlanAPRadioUtilization);
    const radioClients = columnMap(walked.radioClients, wlanAPRadioNumAssociatedClients);

    const radioIdxs = new Set([
      ...Object.keys(radioChan), ...Object.keys(radioUtil), ...Object.keys(radioClients),
    ]);
    for (const ridx of radioIdxs) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;

      const ch = num(radioChan[ridx]);
      const band = bandForChannel(ch);
      if (!band) continue; // can't place this radio without a channel → skip

      if (ch !== null) {
        if (band === '2g') ap.radio_2g_channel = ch;
        else if (band === '5g') ap.radio_5g_channel = ch;
        else if (band === '6g') ap.radio_6g_channel = ch;
      }
      const util = num(radioUtil[ridx]);
      if (util !== null) {
        if (band === '2g') ap.radio_2g_util_pct = util;
        else if (band === '5g') ap.radio_5g_util_pct = util;
      }
      const cl = num(radioClients[ridx]);
      if (cl !== null) {
        if (band === '2g') ap.clients_2g = cl;
        else if (band === '5g') ap.clients_5g = cl;
      }
    }

    // No per-AP total-clients OID on the controller → sum the radios.
    for (const ap of out) {
      ap.clients_total = (ap.clients_2g || 0) + (ap.clients_5g || 0);
    }
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  // Derived from the AP table (per-radio client sum), keyed by AP index.
  try {
    return parseApTable(walked).map((ap) => ({ apKey: ap._index, clients: ap.clients_total }));
  } catch (e) {
    return [];
  }
}

// Parse wlsxWlanESSIDTable into per-SSID rows. The controller exposes only the
// SSID name and its station count — byte/auth counters do not exist here.
function parseSsids(walked) {
  const out = [];
  try {
    walked = walked || {};
    const names = columnMap(walked.essidName, wlanESSID);
    const stations = columnMap(walked.essidStations, wlanESSIDNumStations);

    const indexes = new Set([...Object.keys(names), ...Object.keys(stations)]);
    for (const idx of indexes) {
      const ssid_name = str(names[idx]);
      if (!ssid_name) continue; // skip rows with no name
      out.push({
        ssid_name,
        status: 'up',
        clients_total: num(stations[idx]) || 0,
        bytes_in: null,   // not exposed by WLSX-WLAN-MIB
        bytes_out: null,
        auth_successes: 0,
        auth_failures: 0,
      });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

module.exports = {
  name: 'aruba',
  snmpOids: {
    // AP table (index = AP MAC)
    apIp: wlanAPIpAddress,
    apName: wlanAPName,
    apUptime: wlanAPUpTime,
    apModel: wlanAPModelName,
    apStatus: wlanAPStatus,
    // Radio table (index = AP MAC + radioNumber)
    radioChannel: wlanAPRadioChannel,
    radioUtil: wlanAPRadioUtilization,
    radioClients: wlanAPRadioNumAssociatedClients,
    // ESSID table (index = SSID name)
    essidName: wlanESSID,
    essidStations: wlanESSIDNumStations,
  },
  parseApTable,
  parseClientCounts,
  parseSsids,
};

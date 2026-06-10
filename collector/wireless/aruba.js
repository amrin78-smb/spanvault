'use strict';

// Aruba (controller-based) wireless parser.
// OIDs from WLSX-WLAN-MIB / ARUBA-MIB, corrected against real ArubaOS hardware.
//
// Two correlated tables drive an AP's metrics:
//   • wlsxWlanAPTable      — one row per AP   (name, ip, status, total clients)
//   • wlsxWlanRadioStatsTable — one row per AP+radio (channel, util, clients,
//     noise, retry); index is "<apIndex>.<radioIndex>", radioIndex 0=2.4G,1=5G.
//   • wlsxWlanESSIDStatsTable — one row per SSID (name, clients, bytes, auth).

const {
  num, str, columnMap, emptyAp, splitRadioIndex, bandForRadioIndex,
} = require('./_util');

// Scalars
const wlsxSysExtNumActiveClients = '1.3.6.1.4.1.14823.2.2.1.1.1.39.0';
const wlsxNumMonitoredAP = '1.3.6.1.4.1.14823.2.2.1.1.1.4.0';

// ── AP table (wlsxWlanAPTable) — base 1.3.6.1.4.1.14823.2.2.1.5.2.1.4.1 ───────
const AP_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.4.1';
const apName = AP_BASE + '.3';        // wlsxWlanAPName
const apIpAddress = AP_BASE + '.2';   // wlsxWlanAPIpAddress
const apModel = AP_BASE + '.5';       // wlsxWlanAPModel
const apStatus = AP_BASE + '.19';     // wlsxWlanAPStatus (1=up, 2=down)
const apNumClients = AP_BASE + '.37'; // wlsxWlanAPNumClients (total associated clients)
const apUpTime = AP_BASE + '.18';     // wlsxWlanAPUpTime (seconds) — best-effort
const apSerialNum = AP_BASE + '.7';   // wlsxWlanAPSerialNumber — best-effort

// ── Radio stats table (wlsxWlanRadioStatsTable) — base ...5.2.1.7.1 ──────────
// Index = "<apIndex>.<radioIndex>" (radioIndex 0=2.4GHz, 1=5GHz). apIndex
// matches the AP-table row index, so radios correlate back to their AP.
const RADIO_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1';
const radioChannel = RADIO_BASE + '.4';      // wlsxWlanRadioChannel
const radioUtil = RADIO_BASE + '.22';        // wlsxWlanRadioChannelUtilization (%)
const radioClients = RADIO_BASE + '.26';     // wlsxWlanRadioNumAssociatedClients
const radioNoiseFloor = RADIO_BASE + '.27';  // wlsxWlanRadioNoiseFloor (dBm, negative)
const radioRetryRate = RADIO_BASE + '.23';   // wlsxWlanRadioFrameRetryRate (%)

// ── Per-SSID stats table (wlsxWlanESSIDStatsTable) — base ...1.7.1.2.1 ───────
const ESSID_BASE = '1.3.6.1.4.1.14823.2.2.1.1.7.1.2.1';
const essidName = ESSID_BASE + '.2';      // wlsxWlanESSID (SSID name)
const essidNumClients = ESSID_BASE + '.3'; // wlsxWlanESSIDNumStations (clients)
const essidTxBytes = ESSID_BASE + '.6';   // wlsxWlanESSIDTxBytes
const essidRxBytes = ESSID_BASE + '.7';   // wlsxWlanESSIDRxBytes
const essidAuthOk = ESSID_BASE + '.8';    // wlsxWlanESSIDNumAuthSuccesses
const essidAuthFail = ESSID_BASE + '.9';  // wlsxWlanESSIDNumAuthFailures

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

// Assign a per-radio metric to the matching AP's 2.4 / 5 GHz field.
function assignByBand(byIndex, colMap, set2g, set5g) {
  for (const ridx of Object.keys(colMap)) {
    const { apKey, radioKey } = splitRadioIndex(ridx);
    const ap = byIndex.get(apKey);
    if (!ap) continue;
    const v = num(colMap[ridx]);
    if (v === null) continue;
    const band = bandForRadioIndex(radioKey);
    if (band === '2g') set2g(ap, v);
    else if (band === '5g') set5g(ap, v);
  }
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const names = columnMap(walked.apName, apName);
    const ips = columnMap(walked.apIp, apIpAddress);
    const models = columnMap(walked.apModel, apModel);
    const statuses = columnMap(walked.apStatus, apStatus);
    const apClients = columnMap(walked.apClients, apNumClients);
    const uptimes = columnMap(walked.apUptime, apUpTime);
    const serials = columnMap(walked.apSerial, apSerialNum);

    const indexes = new Set();
    [names, ips, models, statuses, apClients].forEach((m) => {
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
      // Total client count straight from the AP table (.37). Kept as-is (may be
      // null); a per-radio fallback is applied after the radio table is parsed.
      ap.clients_total = num(apClients[idx]);
      const up = num(uptimes[idx]);
      if (up !== null) ap.uptime_seconds = up;
      const sn = str(serials[idx]);
      if (sn !== null) ap.serial_number = sn;
      out.push(ap);
      byIndex.set(idx, ap);
    }

    // ── Correlate per-radio metrics, mapping radioIndex 0→2.4G, 1→5G. ──
    assignByBand(byIndex, columnMap(walked.radioChannel, radioChannel),
      (ap, v) => { ap.radio_2g_channel = v; }, (ap, v) => { ap.radio_5g_channel = v; });
    assignByBand(byIndex, columnMap(walked.radioUtil, radioUtil),
      (ap, v) => { ap.radio_2g_util_pct = v; }, (ap, v) => { ap.radio_5g_util_pct = v; });
    assignByBand(byIndex, columnMap(walked.radioClients, radioClients),
      (ap, v) => { ap.clients_2g = v; }, (ap, v) => { ap.clients_5g = v; });
    assignByBand(byIndex, columnMap(walked.radioNoise, radioNoiseFloor),
      (ap, v) => { ap.noise_floor_2g = v; }, (ap, v) => { ap.noise_floor_5g = v; });
    assignByBand(byIndex, columnMap(walked.radioRetry, radioRetryRate),
      (ap, v) => { ap.retry_rate_2g = v; }, (ap, v) => { ap.retry_rate_5g = v; });

    // Finalize total clients: if the AP table didn't report it, sum the radios.
    for (const ap of out) {
      if (ap.clients_total === null) {
        ap.clients_total = (ap.clients_2g || 0) + (ap.clients_5g || 0);
      }
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
    const clients = columnMap(walked.apClients, apNumClients);
    for (const idx of Object.keys(clients)) {
      const c = num(clients[idx]);
      out.push({ apKey: idx, clients: c === null ? 0 : c });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

// Parse the per-SSID table (wlsxWlanESSIDStatsTable) into a list of SSID rows.
function parseSsids(walked) {
  const out = [];
  try {
    walked = walked || {};
    const names = columnMap(walked.essidName, essidName);
    const clients = columnMap(walked.essidClients, essidNumClients);
    const txBytes = columnMap(walked.essidTx, essidTxBytes);
    const rxBytes = columnMap(walked.essidRx, essidRxBytes);
    const authOk = columnMap(walked.essidAuthOk, essidAuthOk);
    const authFail = columnMap(walked.essidAuthFail, essidAuthFail);

    const indexes = new Set();
    [names, clients, txBytes, rxBytes, authOk, authFail].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ssid_name = str(names[idx]);
      if (ssid_name === null) continue; // skip rows with no name

      out.push({
        ssid_name,
        status: 'up',
        clients_total: num(clients[idx]) || 0,
        bytes_in: num(rxBytes[idx]),  // rx = received = in
        bytes_out: num(txBytes[idx]),
        auth_successes: num(authOk[idx]) || 0,
        auth_failures: num(authFail[idx]) || 0,
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
    sysActiveClients: wlsxSysExtNumActiveClients,
    numMonitoredAp: wlsxNumMonitoredAP,
    // AP table
    apName: apName,
    apIp: apIpAddress,
    apModel: apModel,
    apStatus: apStatus,
    apClients: apNumClients,
    apUptime: apUpTime,
    apSerial: apSerialNum,
    // Radio stats table
    radioChannel: radioChannel,
    radioUtil: radioUtil,
    radioClients: radioClients,
    radioNoise: radioNoiseFloor,
    radioRetry: radioRetryRate,
    // ESSID stats table
    essidName: essidName,
    essidClients: essidNumClients,
    essidTx: essidTxBytes,
    essidRx: essidRxBytes,
    essidAuthOk: essidAuthOk,
    essidAuthFail: essidAuthFail,
  },
  parseApTable,
  parseClientCounts,
  parseSsids,
};

'use strict';

// Aruba (controller-based) wireless parser.
// OIDs from WLSX-WLAN-MIB / ARUBA-MIB.
// NOTE: the wlsxAPTable column suffixes below are best-effort / approximate
// from the MIB and will be validated against real hardware later.

const {
  num,
  str,
  columnMap,
  bandForChannel,
  emptyAp,
  splitRadioIndex,
  bandForRadioIndex,
} = require('./_util');

// Scalars
const wlsxSysExtNumActiveClients = '1.3.6.1.4.1.14823.2.2.1.1.1.39.0';
const wlsxNumMonitoredAP = '1.3.6.1.4.1.14823.2.2.1.1.1.4.0';

// wlsxAPTable base: 1.3.6.1.4.1.14823.2.2.1.5.2.1.4
// Columns live under .1.<col>. Suffixes chosen as sensible/approximate.
const AP_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.4.1';
const apName = AP_BASE + '.3'; // best-effort column for AP name
const apIpAddress = AP_BASE + '.2'; // best-effort column for AP IP
const apModel = AP_BASE + '.5'; // best-effort column for AP model
const apStatus = AP_BASE + '.19'; // best-effort column for AP up/down status
const apESSID = AP_BASE + '.4'; // best-effort column for ESSID
const apChannel = AP_BASE + '.7'; // best-effort column for radio channel
const apTxPower = AP_BASE + '.6'; // best-effort column for tx power
const apNumAssociatedClients = AP_BASE + '.8'; // best-effort column for client count
const wlsxAPUpTime = AP_BASE + '.18'; // wlsxAPUpTime (seconds), index = apIndex
const wlsxAPSerialNum = AP_BASE + '.7'; // wlsxAPSerialNum, index = apIndex

// wlsxAPStatsRadioTable — per-AP per-radio statistics.
// Index of each entry = "<apIndex>.<radioIndex>" (radioIndex 0=2.4GHz, 1=5GHz).
const ARUBA_AP_RADIO_TABLE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.7';
const radioChannel = ARUBA_AP_RADIO_TABLE + '.1'; // wlsxAPStatsRadioChannel
const radioNoiseFloor = ARUBA_AP_RADIO_TABLE + '.4'; // wlsxAPStatsRadioNoiseFloor (dBm, usually negative)
const radioFrameRetryRate = ARUBA_AP_RADIO_TABLE + '.6'; // wlsxAPStatsRadioFrameRetryRate (percent)
const radioRxFrameErrors = ARUBA_AP_RADIO_TABLE + '.13'; // wlsxAPStatsRadioRxFrameErrors
const radioTxFrameErrors = ARUBA_AP_RADIO_TABLE + '.14'; // wlsxAPStatsRadioTxFrameErrors
const radioBytesReceived = ARUBA_AP_RADIO_TABLE + '.17'; // wlsxAPStatsRadioBytesReceived
const radioBytesSent = ARUBA_AP_RADIO_TABLE + '.18'; // wlsxAPStatsRadioBytesSent

// wlsxESSIDTable — per-SSID statistics. Index = essid index.
const ARUBA_ESSID_TABLE = '1.3.6.1.4.1.14823.2.2.1.1.7.1.2';
const essidName = ARUBA_ESSID_TABLE + '.1'; // wlsxESSIDName
const essidNumStations = ARUBA_ESSID_TABLE + '.2'; // wlsxESSIDNumStations (clients)
const essidTxBytes = ARUBA_ESSID_TABLE + '.6'; // wlsxESSIDTxBytes
const essidRxBytes = ARUBA_ESSID_TABLE + '.7'; // wlsxESSIDRxBytes
const essidNumAuthSuccesses = ARUBA_ESSID_TABLE + '.8'; // wlsxESSIDNumAuthSuccesses
const essidNumAuthFailures = ARUBA_ESSID_TABLE + '.9'; // wlsxESSIDNumAuthFailures

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
    const names = columnMap(walked.apName, apName);
    const ips = columnMap(walked.apIp, apIpAddress);
    const models = columnMap(walked.apModel, apModel);
    const statuses = columnMap(walked.apStatus, apStatus);
    const channels = columnMap(walked.apChannel, apChannel);
    const txpowers = columnMap(walked.apTxPower, apTxPower);
    const clients = columnMap(walked.apClients, apNumAssociatedClients);

    const indexes = new Set();
    [names, ips, models, statuses, channels, txpowers, clients].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(names[idx]) || idx;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);

      const ch = num(channels[idx]);
      const band = bandForChannel(ch);
      if (band === '2g') ap.radio_2g_channel = ch;
      else if (band === '5g') ap.radio_5g_channel = ch;
      else if (band === '6g') ap.radio_6g_channel = ch;

      const tx = num(txpowers[idx]);
      if (tx !== null) {
        if (band === '5g') ap.tx_power_5g = tx;
        else ap.tx_power_2g = tx;
      }

      const c = num(clients[idx]);
      ap.clients_total = c === null ? 0 : c;

      out.push(ap);
    }

    // ── Correlate per-radio metrics (wlsxAPStatsRadioTable) onto each AP.
    // The radio table is indexed "<apIndex>.<radioIndex>"; apIndex matches the
    // AP-table _index built above, and radioIndex selects the band (0=2g, 1=5g).
    const byIndex = new Map();
    for (const ap of out) byIndex.set(ap._index, ap);

    const rChannel = columnMap(walked.radioChannel, radioChannel);
    const rNoise = columnMap(walked.radioNoise, radioNoiseFloor);
    const rRetry = columnMap(walked.radioRetry, radioFrameRetryRate);
    const rRxErr = columnMap(walked.radioRxErr, radioRxFrameErrors);
    const rTxErr = columnMap(walked.radioTxErr, radioTxFrameErrors);
    const rRxBytes = columnMap(walked.radioRxBytes, radioBytesReceived);
    const rTxBytes = columnMap(walked.radioTxBytes, radioBytesSent);

    // Noise floor (dBm, may be negative — store as-is).
    for (const ridx of Object.keys(rNoise)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const band = bandForRadioIndex(radioKey);
      const v = num(rNoise[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.noise_floor_2g = v;
      else if (band === '5g') ap.noise_floor_5g = v;
    }

    // Frame retry rate (percent).
    for (const ridx of Object.keys(rRetry)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const band = bandForRadioIndex(radioKey);
      const v = num(rRetry[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.retry_rate_2g = v;
      else if (band === '5g') ap.retry_rate_5g = v;
    }

    // Rx frame errors.
    for (const ridx of Object.keys(rRxErr)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const band = bandForRadioIndex(radioKey);
      const v = num(rRxErr[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.rx_errors_2g = v;
      else if (band === '5g') ap.rx_errors_5g = v;
    }

    // Tx frame errors.
    for (const ridx of Object.keys(rTxErr)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const band = bandForRadioIndex(radioKey);
      const v = num(rTxErr[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.tx_errors_2g = v;
      else if (band === '5g') ap.tx_errors_5g = v;
    }

    // Bytes received — accumulate across radios into ap.rx_bytes.
    for (const ridx of Object.keys(rRxBytes)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(rRxBytes[ridx]);
      if (v === null) continue;
      ap.rx_bytes = (ap.rx_bytes === null ? 0 : ap.rx_bytes) + v;
    }

    // Bytes sent — accumulate across radios into ap.tx_bytes.
    for (const ridx of Object.keys(rTxBytes)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(rTxBytes[ridx]);
      if (v === null) continue;
      ap.tx_bytes = (ap.tx_bytes === null ? 0 : ap.tx_bytes) + v;
    }

    // Channel from the radio table (only fills in when not already set above).
    for (const ridx of Object.keys(rChannel)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const band = bandForRadioIndex(radioKey);
      const v = num(rChannel[ridx]);
      if (v === null) continue;
      if (band === '2g' && ap.radio_2g_channel === null) ap.radio_2g_channel = v;
      else if (band === '5g' && ap.radio_5g_channel === null) ap.radio_5g_channel = v;
    }

    // Per-AP uptime (seconds) and serial number, indexed by apIndex == _index.
    const uptimes = columnMap(walked.apUptime, wlsxAPUpTime);
    const serials = columnMap(walked.apSerial, wlsxAPSerialNum);
    for (const ap of out) {
      const up = num(uptimes[ap._index]);
      if (up !== null) ap.uptime_seconds = up;
      const sn = str(serials[ap._index]);
      if (sn !== null) ap.serial_number = sn;
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
    const clients = columnMap(walked.apClients, apNumAssociatedClients);
    for (const idx of Object.keys(clients)) {
      const c = num(clients[idx]);
      out.push({ apKey: idx, clients: c === null ? 0 : c });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

// Parse the per-SSID table (wlsxESSIDTable) into a list of SSID stat rows.
function parseSsids(walked) {
  const out = [];
  try {
    walked = walked || {};
    const names = columnMap(walked.essidName, essidName);
    const stations = columnMap(walked.essidStations, essidNumStations);
    const txBytes = columnMap(walked.essidTxBytes, essidTxBytes);
    const rxBytes = columnMap(walked.essidRxBytes, essidRxBytes);
    const authOk = columnMap(walked.essidAuthSuccess, essidNumAuthSuccesses);
    const authFail = columnMap(walked.essidAuthFail, essidNumAuthFailures);

    const indexes = new Set();
    [names, stations, txBytes, rxBytes, authOk, authFail].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ssid_name = str(names[idx]);
      if (ssid_name === null) continue; // skip rows with no name

      out.push({
        ssid_name,
        status: 'up',
        clients_total: num(stations[idx]) || 0,
        bytes_in: num(rxBytes[idx]), // rx = received = in
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
    apName: apName,
    apIp: apIpAddress,
    apModel: apModel,
    apStatus: apStatus,
    apEssid: apESSID,
    apChannel: apChannel,
    apTxPower: apTxPower,
    apClients: apNumAssociatedClients,
    apUptime: wlsxAPUpTime,
    apSerial: wlsxAPSerialNum,
    // wlsxAPStatsRadioTable columns
    radioChannel: radioChannel,
    radioNoise: radioNoiseFloor,
    radioRetry: radioFrameRetryRate,
    radioRxErr: radioRxFrameErrors,
    radioTxErr: radioTxFrameErrors,
    radioRxBytes: radioBytesReceived,
    radioTxBytes: radioBytesSent,
    // wlsxESSIDTable columns
    essidName: essidName,
    essidStations: essidNumStations,
    essidTxBytes: essidTxBytes,
    essidRxBytes: essidRxBytes,
    essidAuthSuccess: essidNumAuthSuccesses,
    essidAuthFail: essidNumAuthFailures,
  },
  parseApTable,
  parseClientCounts,
  parseSsids,
};

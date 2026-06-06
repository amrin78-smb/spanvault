'use strict';

// Aruba (controller-based) wireless parser.
// OIDs from WLSX-WLAN-MIB / ARUBA-MIB.
// NOTE: the wlsxAPTable column suffixes below are best-effort / approximate
// from the MIB and will be validated against real hardware later.

const { num, str, columnMap, bandForChannel, emptyAp } = require('./_util');

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
  },
  parseApTable,
  parseClientCounts,
};

'use strict';

// HPE Aruba Instant wireless parser.
// OIDs from ARUBA-INSTANT-MIB, aiAPTable.
// NOTE: column suffixes are best-effort / approximate from the MIB and will
// be validated against real hardware later.

const { num, str, columnMap, bandForChannel, emptyAp } = require('./_util');

// aiAPTable: 1.3.6.1.4.1.47196.4.1.1.3.7.1.1
const AP_BASE = '1.3.6.1.4.1.47196.4.1.1.3.7.1.1';
const aiAPMacAddress = AP_BASE + '.1'; // best-effort (often index)
const aiAPName = AP_BASE + '.2'; // best-effort
const aiAPIPAddress = AP_BASE + '.3'; // best-effort
const aiAPModel = AP_BASE + '.6'; // best-effort
const aiAPStatus = AP_BASE + '.11'; // best-effort
const aiAPChannel = AP_BASE + '.5'; // best-effort
const aiAPClientCount = AP_BASE + '.8'; // best-effort: associated clients

function mapStatus(v) {
  const n = num(v);
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('online') || l.includes('active')) return 'online';
    if (l.includes('down') || l.includes('offline')) return 'offline';
  }
  return 'unknown';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const macs = columnMap(walked.apMac, aiAPMacAddress);
    const names = columnMap(walked.apName, aiAPName);
    const ips = columnMap(walked.apIp, aiAPIPAddress);
    const models = columnMap(walked.apModel, aiAPModel);
    const statuses = columnMap(walked.apStatus, aiAPStatus);
    const channels = columnMap(walked.apChannel, aiAPChannel);
    const clients = columnMap(walked.apClients, aiAPClientCount);

    const indexes = new Set();
    [macs, names, ips, models, statuses, channels, clients].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.mac_address = str(macs[idx]);
      ap.name = str(names[idx]) || ap.mac_address || idx;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);

      const ch = num(channels[idx]);
      const band = bandForChannel(ch);
      if (band === '2g') ap.radio_2g_channel = ch;
      else if (band === '5g') ap.radio_5g_channel = ch;
      else if (band === '6g') ap.radio_6g_channel = ch;

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
    const clients = columnMap(walked.apClients, aiAPClientCount);
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
  name: 'hpe',
  snmpOids: {
    apMac: aiAPMacAddress,
    apName: aiAPName,
    apIp: aiAPIPAddress,
    apModel: aiAPModel,
    apStatus: aiAPStatus,
    apChannel: aiAPChannel,
    apClients: aiAPClientCount,
  },
  parseApTable,
  parseClientCounts,
};

'use strict';

// Ruckus (ZoneDirector) wireless parser.
// OIDs from RUCKUS-ZD-WLAN-MIB, ruckusZDSystemAPTable.
// NOTE: column suffixes are best-effort / approximate from the MIB and will
// be validated against real hardware later.

const { num, str, columnMap, bandForChannel, emptyAp } = require('./_util');

// ruckusZDSystemAPTable: 1.3.6.1.4.1.25053.1.2.2.1.1.2.2.1
const AP_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.2.1';
const ruckusZDAPMacAddress = AP_BASE + '.1'; // best-effort (often the index too)
const ruckusZDAPName = AP_BASE + '.2'; // best-effort
const ruckusZDAPIpAddress = AP_BASE + '.10'; // best-effort
const ruckusZDAPModel = AP_BASE + '.4'; // best-effort
const ruckusZDAPStatus = AP_BASE + '.3'; // best-effort
const ruckusZDAPNumSta = AP_BASE + '.15'; // best-effort: num associated clients
const ruckusZDAPChannel = AP_BASE + '.11'; // best-effort

function mapStatus(v) {
  const n = num(v);
  // 1 = up/connected (approx), other = offline
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('connect') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline') || l.includes('disconnect')) return 'offline';
  }
  return 'unknown';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const macs = columnMap(walked.apMac, ruckusZDAPMacAddress);
    const names = columnMap(walked.apName, ruckusZDAPName);
    const ips = columnMap(walked.apIp, ruckusZDAPIpAddress);
    const models = columnMap(walked.apModel, ruckusZDAPModel);
    const statuses = columnMap(walked.apStatus, ruckusZDAPStatus);
    const clients = columnMap(walked.apClients, ruckusZDAPNumSta);
    const channels = columnMap(walked.apChannel, ruckusZDAPChannel);

    const indexes = new Set();
    [macs, names, ips, models, statuses, clients, channels].forEach((m) => {
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
    const clients = columnMap(walked.apClients, ruckusZDAPNumSta);
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
  name: 'ruckus',
  snmpOids: {
    apMac: ruckusZDAPMacAddress,
    apName: ruckusZDAPName,
    apIp: ruckusZDAPIpAddress,
    apModel: ruckusZDAPModel,
    apStatus: ruckusZDAPStatus,
    apClients: ruckusZDAPNumSta,
    apChannel: ruckusZDAPChannel,
  },
  parseApTable,
  parseClientCounts,
};

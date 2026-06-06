'use strict';

// Cisco wireless parser.
// OIDs from CISCO-LWAPP-AP-MIB and AIRESPACE-WIRELESS-MIB (legacy WLC).
// NOTE: column suffixes are best-effort / approximate from the MIBs and will
// be validated against real hardware later.

const { num, str, columnMap, bandForChannel, emptyAp } = require('./_util');

// cLApTable (CISCO-LWAPP-AP-MIB): 1.3.6.1.4.1.9.9.513.1.1.1
const CLAP_BASE = '1.3.6.1.4.1.9.9.513.1.1.1.1';
const cLApName = CLAP_BASE + '.5'; // best-effort
const cLApIpAddress = CLAP_BASE + '.19'; // best-effort
const cLApModel = CLAP_BASE + '.16'; // best-effort

// bsnAPTable (AIRESPACE-WIRELESS-MIB, legacy WLC): 1.3.6.1.4.1.14179.2.2.1.1
const BSN_BASE = '1.3.6.1.4.1.14179.2.2.1.1';
const bsnAPName = BSN_BASE + '.3';
const bsnApIpAddress = BSN_BASE + '.19'; // best-effort
const bsnAPModel = BSN_BASE + '.16';
const bsnAPOperationStatus = BSN_BASE + '.6';
const bsnApAssociatedClientCount = BSN_BASE + '.38'; // best-effort

// bsnAPIfTable radio stats base (best-effort): channel column.
const BSN_IF_BASE = '1.3.6.1.4.1.14179.2.2.2.1';
const bsnAPIfPhyChannelNumber = BSN_IF_BASE + '.4'; // best-effort

function mapStatus(v) {
  const n = num(v);
  // bsnAPOperationStatus: 1 = associated/up, 2 = disassociating, 3 = downloading
  if (n === 1) return 'online';
  if (n === 2 || n === 3) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('associat') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline')) return 'offline';
  }
  return 'unknown';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};

    // Prefer modern cLApTable; merge legacy bsnAPTable by index when present.
    const cnames = columnMap(walked.cLApName, cLApName);
    const cips = columnMap(walked.cLApIp, cLApIpAddress);
    const cmodels = columnMap(walked.cLApModel, cLApModel);

    const bnames = columnMap(walked.bsnAPName, bsnAPName);
    const bips = columnMap(walked.bsnApIp, bsnApIpAddress);
    const bmodels = columnMap(walked.bsnAPModel, bsnAPModel);
    const bstatus = columnMap(walked.bsnAPStatus, bsnAPOperationStatus);
    const bclients = columnMap(walked.bsnApClients, bsnApAssociatedClientCount);
    const bchannel = columnMap(walked.bsnApChannel, bsnAPIfPhyChannelNumber);

    const indexes = new Set();
    [cnames, cips, cmodels, bnames, bips, bmodels, bstatus, bclients, bchannel].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(cnames[idx]) || str(bnames[idx]) || idx;
      ap.ip_address = str(cips[idx]) || str(bips[idx]);
      ap.model = str(cmodels[idx]) || str(bmodels[idx]);
      ap.status = mapStatus(bstatus[idx]);

      const ch = num(bchannel[idx]);
      const band = bandForChannel(ch);
      if (band === '2g') ap.radio_2g_channel = ch;
      else if (band === '5g') ap.radio_5g_channel = ch;
      else if (band === '6g') ap.radio_6g_channel = ch;

      const c = num(bclients[idx]);
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
    const clients = columnMap(walked.bsnApClients, bsnApAssociatedClientCount);
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
  name: 'cisco',
  snmpOids: {
    cLApName: cLApName,
    cLApIp: cLApIpAddress,
    cLApModel: cLApModel,
    bsnAPName: bsnAPName,
    bsnApIp: bsnApIpAddress,
    bsnAPModel: bsnAPModel,
    bsnAPStatus: bsnAPOperationStatus,
    bsnApClients: bsnApAssociatedClientCount,
    bsnApChannel: bsnAPIfPhyChannelNumber,
  },
  parseApTable,
  parseClientCounts,
};

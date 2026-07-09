'use strict';

// Grandstream wireless parser.
// SNMP support on Grandstream GWN APs is limited; we use standard RFC MIBs
// (SNMPv2-MIB sysName, IF-MIB ifTable) plus GWN-GATEWAY-MIB where available.
// We return at most ONE WirelessAP representing the device itself, with a
// coarse client/interface count derived from ifTable.
// NOTE: API enrichment (GWN cloud / local API) is the preferred data source
// for Grandstream and is handled elsewhere; this is a best-effort SNMP fallback.

const { num, str, columnMap, emptyAp } = require('./_util');

// Standard RFC OIDs. These feed subtree WALKS, so they must be the object
// base (no trailing '.0' scalar instance — walking '…1.5.0' returns nothing;
// walking '…1.5' returns the '.0' instance).
const sysName = '1.3.6.1.2.1.1.5';
const sysUpTime = '1.3.6.1.2.1.1.3'; // TimeTicks (1/100s)

// IF-MIB ifTable columns (coarse interface count)
const ifDescr = '1.3.6.1.2.1.2.2.1.2';
const ifOperStatus = '1.3.6.1.2.1.2.2.1.8'; // 1 = up

function firstValue(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] ? rows[0].value : null;
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};

    const name = str(firstValue(walked.sysName));
    const opers = columnMap(walked.ifOperStatus, ifOperStatus);
    const descrs = columnMap(walked.ifDescr, ifDescr);

    // Determine whether any data came back at all.
    const hasData =
      name !== null ||
      Object.keys(opers).length > 0 ||
      Object.keys(descrs).length > 0;

    if (!hasData) return out;

    const ap = emptyAp();
    ap._index = null;
    ap.name = name || 'Grandstream AP';
    ap.status = 'online'; // any data returned => treat as online

    // sysUpTime is TimeTicks (hundredths of a second).
    const ticks = num(firstValue(walked.sysUpTime));
    if (ticks !== null) ap.uptime_seconds = Math.floor(ticks / 100);

    // Coarse client/interface count: number of operationally-up interfaces.
    let upCount = 0;
    for (const idx of Object.keys(opers)) {
      if (num(opers[idx]) === 1) upCount += 1;
    }
    ap.clients_total = upCount;

    out.push(ap);
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  const out = [];
  try {
    walked = walked || {};
    const opers = columnMap(walked.ifOperStatus, ifOperStatus);
    let upCount = 0;
    for (const idx of Object.keys(opers)) {
      if (num(opers[idx]) === 1) upCount += 1;
    }
    out.push({ apKey: 'self', clients: upCount });
  } catch (e) {
    // never throw
  }
  return out;
}

module.exports = {
  name: 'grandstream',
  snmpOids: {
    sysName: sysName,
    sysUpTime: sysUpTime,
    ifDescr: ifDescr,
    ifOperStatus: ifOperStatus,
  },
  parseApTable,
  parseClientCounts,
};

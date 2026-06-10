'use strict';

// Wireless CLIENT parser for HPE Aruba Instant (aiClientTable).
// Client MAC and AP name come from column VALUES, not the OID index.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, hexMac, bandFromCode, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

const TABLE = '1.3.6.1.4.1.47196.4.1.1.3.8.1.1';
const cMac = TABLE + '.2', cIp = TABLE + '.3', cApName = TABLE + '.4', cSsid = TABLE + '.5',
      cRssi = TABLE + '.6', cTx = TABLE + '.9', cRx = TABLE + '.10', cBand = TABLE + '.13';

async function parseClients(session, apMap) {
  const out = [];
  try {
    const macCol = columnMap(await walk(session, cMac), cMac);
    const ip = columnMap(await walk(session, cIp), cIp);
    const apn = columnMap(await walk(session, cApName), cApName);
    const ssid = columnMap(await walk(session, cSsid), cSsid);
    const rssi = columnMap(await walk(session, cRssi), cRssi);
    const tx = columnMap(await walk(session, cTx), cTx);
    const rx = columnMap(await walk(session, cRx), cRx);
    const band = columnMap(await walk(session, cBand), cBand);
    const idxs = new Set();
    [macCol, ip, apn, ssid, rssi, tx, rx, band].forEach(m => Object.keys(m).forEach(k => idxs.add(k)));
    for (const idx of idxs) {
      const mac = hexMac(macCol[idx]);
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ip[idx]);
      const apName = str(apn[idx]);
      const ap = apName ? apMap.byName.get(apName) : null;
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; } else { c.ap_name = apName; }
      c.ssid_name = str(ssid[idx]);
      c.rssi_dbm = num(rssi[idx]);
      const t = num(tx[idx]); c.tx_rate_mbps = t === null ? null : t / 1000;
      const r = num(rx[idx]); c.rx_rate_mbps = r === null ? null : r / 1000;
      c.band = bandFromCode(band[idx]);
      out.push(c);
    }
  } catch (e) { return []; }
  return out;
}

module.exports = { parseClients };

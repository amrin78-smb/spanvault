'use strict';

// Wireless CLIENT parser for an Aruba mobility controller (wlsxClientTable).
// INDEX = 6 MAC octets, so macFromTail(idx, 6) yields the client MAC.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, hexMac, bandFromCode, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

const TABLE = '1.3.6.1.4.1.14823.2.2.1.1.2.1.1';
const cIp = TABLE + '.2', cSsid = TABLE + '.3', cApName = TABLE + '.4', cRssi = TABLE + '.8',
      cTx = TABLE + '.9', cRx = TABLE + '.29', cBand = TABLE + '.14', cChan = TABLE + '.16',
      cAuth = TABLE + '.20', cAssoc = TABLE + '.25';

async function parseClients(session, apMap) {
  const out = [];
  try {
    const ip = columnMap(await walk(session, cIp), cIp);
    const ssid = columnMap(await walk(session, cSsid), cSsid);
    const apn = columnMap(await walk(session, cApName), cApName);
    const rssi = columnMap(await walk(session, cRssi), cRssi);
    const tx = columnMap(await walk(session, cTx), cTx);
    const rx = columnMap(await walk(session, cRx), cRx);
    const band = columnMap(await walk(session, cBand), cBand);
    const chan = columnMap(await walk(session, cChan), cChan);
    const auth = columnMap(await walk(session, cAuth), cAuth);
    const assoc = columnMap(await walk(session, cAssoc), cAssoc);

    const idxs = new Set();
    [ip, ssid, apn, rssi, tx, rx, band, chan, auth, assoc].forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6);
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ip[idx]);
      c.ssid_name = str(ssid[idx]);
      const apName = str(apn[idx]);
      const ap = apName ? apMap.byName.get(apName) : null;
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; } else { c.ap_name = apName; }
      c.rssi_dbm = num(rssi[idx]);
      c.tx_rate_mbps = num(tx[idx]) === null ? null : num(tx[idx]) / 100;
      c.rx_rate_mbps = num(rx[idx]) === null ? null : num(rx[idx]) / 100;
      c.band = bandFromCode(band[idx], { 1: '2.4GHz', 2: '5GHz' });
      c.channel = num(chan[idx]);
      c.auth_type = str(auth[idx]);
      c.connected_since = connectedSinceFromSeconds(assoc[idx]);
      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

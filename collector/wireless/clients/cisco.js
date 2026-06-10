'use strict';

// Wireless CLIENT parser for a Cisco WLC (AIRESPACE-WIRELESS-MIB,
// bsnMobileStationTable). INDEX = 6 MAC octets, so macFromTail(idx, 6) yields
// the client MAC.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, hexMac, bandFromCode, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

const TABLE = '1.3.6.1.4.1.14179.2.1.4.1';
const cIp = TABLE + '.2', cSsid = TABLE + '.3', cApMac = TABLE + '.4', cAssoc = TABLE + '.6',
      cRssi = TABLE + '.14', cTx = TABLE + '.21', cRx = TABLE + '.22', cAuth = TABLE + '.25',
      cBand = TABLE + '.42';

async function parseClients(session, apMap) {
  const out = [];
  try {
    const ip = columnMap(await walk(session, cIp), cIp);
    const ssid = columnMap(await walk(session, cSsid), cSsid);
    const apMacRows = columnMap(await walk(session, cApMac), cApMac);
    const assoc = columnMap(await walk(session, cAssoc), cAssoc);
    const rssi = columnMap(await walk(session, cRssi), cRssi);
    const tx = columnMap(await walk(session, cTx), cTx);
    const rx = columnMap(await walk(session, cRx), cRx);
    const auth = columnMap(await walk(session, cAuth), cAuth);
    const band = columnMap(await walk(session, cBand), cBand);

    const idxs = new Set();
    [ip, ssid, apMacRows, assoc, rssi, tx, rx, auth, band].forEach((m) => Object.keys(m).forEach((k) => idxs.add(k)));

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6);
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ip[idx]);
      c.ssid_name = str(ssid[idx]);

      const apMacRaw = apMacRows[idx];
      const apMac = hexMac(apMacRaw);
      const ap = apMac ? apMap.byMac.get(apMac) : null;
      if (ap) { c.ap_id = ap.id; c.ap_name = ap.name; }

      c.connected_since = connectedSinceFromSeconds(assoc[idx]);
      c.rssi_dbm = num(rssi[idx]);

      const t = num(tx[idx]);
      c.tx_rate_mbps = t === null ? null : t * 0.5;
      const r = num(rx[idx]);
      c.rx_rate_mbps = r === null ? null : r * 0.5;

      c.auth_type = str(auth[idx]);
      c.band = bandFromCode(band[idx]);
      // channel is not exposed in this table — leave null.

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

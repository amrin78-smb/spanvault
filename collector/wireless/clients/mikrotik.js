'use strict';

// MikroTik wireless CLIENT parser (mtxrWlRtabTable).
// MikroTik has no centralized client table; the registration table IS the
// client list, one row per associated station. INDEX = ifIndex followed by
// the 6 client MAC octets, so the client MAC is the LAST 6 octets.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, hexMac, bandFromCode, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

const TABLE = '1.3.6.1.4.1.14988.1.1.1.2.1';
const cSsid = TABLE + '.3', cRssi = TABLE + '.5', cTx = TABLE + '.7', cRx = TABLE + '.8',
      cUptime = TABLE + '.11', cIface = TABLE + '.14';

async function parseClients(session, apMap) {
  const out = [];
  try {
    const ssid = columnMap(await walk(session, cSsid), cSsid);
    const rssi = columnMap(await walk(session, cRssi), cRssi);
    const tx = columnMap(await walk(session, cTx), cTx);
    const rx = columnMap(await walk(session, cRx), cRx);
    const uptime = columnMap(await walk(session, cUptime), cUptime);
    const iface = columnMap(await walk(session, cIface), cIface);

    const aps = Array.from(apMap.byName.values());
    const soleAp = aps.length === 1 ? aps[0] : null;

    const idxs = new Set();
    [ssid, rssi, tx, rx, uptime, iface].forEach(m => Object.keys(m).forEach(k => idxs.add(k)));

    for (const idx of idxs) {
      const mac = macFromTail(idx, 6);
      if (!mac) continue;
      const c = emptyClient();
      c.mac_address = mac;
      c.ssid_name = str(ssid[idx]);
      c.rssi_dbm = num(rssi[idx]);
      const t = num(tx[idx]); c.tx_rate_mbps = t === null ? null : t / 1000000;
      const r = num(rx[idx]); c.rx_rate_mbps = r === null ? null : r / 1000000;
      c.connected_since = connectedSinceFromSeconds(uptime[idx]);
      const bn = (str(iface[idx]) || '').toLowerCase();
      c.band = bn.includes('5') ? '5GHz' : bn.includes('2') ? '2.4GHz' : null;
      if (soleAp) { c.ap_id = soleAp.id; c.ap_name = soleAp.name; }
      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

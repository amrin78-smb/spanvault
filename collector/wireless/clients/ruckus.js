'use strict';

// Wireless CLIENT parser for a Ruckus ZoneDirector (ruckusZDClientTable).
// Base OID: 1.3.6.1.4.1.25053.1.2.2.1.1.2.3.1
// Unlike index-keyed tables, the client MAC and AP MAC come from COLUMN VALUES.

const { walk } = require('../../snmp-session');
const { columnMap } = require('../_util');
const {
  num, str, macFromTail, hexMac, bandFromCode, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
} = require('./_util');

const TABLE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.3.1';
const cMac = TABLE + '.2';   // client MAC (hex string or Buffer)
const cIp = TABLE + '.3';    // client IP
const cApMac = TABLE + '.4'; // AP MAC (hex/Buffer)
const cSsid = TABLE + '.5';  // SSID
const cRssi = TABLE + '.6';  // RSSI (dBm)
const cTx = TABLE + '.7';    // Tx rate (Kbps)
const cRx = TABLE + '.8';    // Rx rate (Kbps)
const cChan = TABLE + '.9';  // channel
const cRadio = TABLE + '.10'; // radio type (1=11b/g,2=11a,3=11n,4=11ac,5=11ax)

// Radio type -> band. 11n (3) is dual-band, so it's omitted here and derived
// from the channel number instead.
const RUCKUS_BAND = { 1: '2.4GHz', 2: '5GHz', 4: '5GHz', 5: '6GHz' };

async function parseClients(session, apMap) {
  const out = [];
  try {
    const macCol = columnMap(await walk(session, cMac), cMac);
    const ip = columnMap(await walk(session, cIp), cIp);
    const apMacCol = columnMap(await walk(session, cApMac), cApMac);
    const ssid = columnMap(await walk(session, cSsid), cSsid);
    const rssi = columnMap(await walk(session, cRssi), cRssi);
    const tx = columnMap(await walk(session, cTx), cTx);
    const rx = columnMap(await walk(session, cRx), cRx);
    const chan = columnMap(await walk(session, cChan), cChan);
    const radio = columnMap(await walk(session, cRadio), cRadio);

    const idxs = new Set();
    [macCol, ip, apMacCol, ssid, rssi, tx, rx, chan, radio].forEach((m) =>
      Object.keys(m).forEach((k) => idxs.add(k))
    );

    for (const idx of idxs) {
      const mac = hexMac(macCol[idx]);
      if (!mac) continue;

      const c = emptyClient();
      c.mac_address = mac;
      c.ip_address = str(ip[idx]);
      c.ssid_name = str(ssid[idx]);
      c.rssi_dbm = num(rssi[idx]);
      c.channel = num(chan[idx]);

      const t = num(tx[idx]);
      c.tx_rate_mbps = t === null ? null : t / 1000;
      const r = num(rx[idx]);
      c.rx_rate_mbps = r === null ? null : r / 1000;

      const apMac = hexMac(apMacCol[idx]);
      const ap = apMac ? apMap.byMac.get(apMac) : null;
      if (ap) {
        c.ap_id = ap.id;
        c.ap_name = ap.name;
      }

      let band = bandFromCode(radio[idx], RUCKUS_BAND);
      if (!band) band = bandFromChannelNum(c.channel);
      c.band = band;

      out.push(c);
    }
  } catch (e) {
    return [];
  }
  return out;
}

module.exports = { parseClients };

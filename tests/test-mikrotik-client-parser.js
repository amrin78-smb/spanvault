'use strict';
// Offline check of the CORRECTED MikroTik CLIENT parser (mtxrWlRtabTable),
// MIB-verified against MIKROTIK-MIB (LibreNMS mirror):
//   MtxrWlRtabEntry ::= SEQUENCE {
//     mtxrWlRtabAddr MacAddress, mtxrWlRtabIface ObjectIndex,
//     mtxrWlRtabStrength Integer32 ("dBm"), mtxrWlRtabTxBytes Counter32,
//     mtxrWlRtabRxBytes Counter32, mtxrWlRtabTxPackets Counter32,
//     mtxrWlRtabRxPackets Counter32, mtxrWlRtabTxRate Gauge32 ("bits per second"),
//     mtxrWlRtabRxRate Gauge32 ("bits per second"), ... mtxrWlRtabUptime TimeTicks, ... }
//   INDEX { mtxrWlRtabAddr, mtxrWlRtabIface }
// i.e. the index is the 6 MAC octets FIRST, then the interface index LAST (7
// components total). This locks in macFromHead(idx, 6) as the fix, and the
// corrected column mapping (.3 Strength -> rssi_dbm, .8/.9 Tx/RxRate -> mbps).
const path = require('path');
const ROOT = path.join(__dirname, '..');
const mikrotikClients = require(path.join(ROOT, 'collector/wireless/clients/mikrotik.js'));
const { macFromHead, macFromTail } = require(path.join(ROOT, 'collector/wireless/clients/_util'));

const RTAB_BASE = '1.3.6.1.4.1.14988.1.1.1.2.1';
const AP_BASE = '1.3.6.1.4.1.14988.1.1.1.3.1';

// Client 1: MAC aa:bb:cc:dd:ee:ff, associated on interface 2.
// Index = 170.187.204.221.238.255.2 (6 MAC octets + iface, per the INDEX clause).
const MAC1_HEAD = '170.187.204.221.238.255';
const IFACE1 = '2';
const IDX1 = `${MAC1_HEAD}.${IFACE1}`;

// Client 2: MAC 11:22:33:44:55:66, associated on interface 5 (an interface
// with NO matching mtxrWlApTable row / SSID — exercises the "info missing,
// fall back to null ssid/band" path, and proves AP resolution isn't just
// blindly defaulting to a single AP).
const MAC2_HEAD = '17.34.51.68.85.102';
const IFACE2 = '5';
const IDX2 = `${MAC2_HEAD}.${IFACE2}`;

const rtabWalked = [
  // Client 1 — correct columns.
  { oid: `${RTAB_BASE}.3.${IDX1}`, value: -55 },        // Strength (dBm) -> rssi_dbm
  { oid: `${RTAB_BASE}.5.${IDX1}`, value: 999999999 },  // RxBytes (decoy — must NOT be read as rssi)
  { oid: `${RTAB_BASE}.7.${IDX1}`, value: 424242 },     // RxPackets (decoy — must NOT be read as a rate)
  { oid: `${RTAB_BASE}.8.${IDX1}`, value: 866700000 },  // TxRate (bits/sec) -> tx_rate_mbps
  { oid: `${RTAB_BASE}.9.${IDX1}`, value: 400000000 },  // RxRate (bits/sec) -> rx_rate_mbps
  { oid: `${RTAB_BASE}.11.${IDX1}`, value: 360000 },    // Uptime (TimeTicks) -> 3600s

  // Client 2 — different values, no AP-table match for its interface.
  { oid: `${RTAB_BASE}.3.${IDX2}`, value: -70 },
  { oid: `${RTAB_BASE}.8.${IDX2}`, value: 54000000 },   // 54 Mbps
  { oid: `${RTAB_BASE}.9.${IDX2}`, value: 24000000 },   // 24 Mbps
  { oid: `${RTAB_BASE}.11.${IDX2}`, value: 72000 },     // 720s
];

const apWalked = [
  { oid: `${AP_BASE}.4.${IFACE1}`, value: 'TestNet' }, // mtxrWlApSsid for iface 2
  { oid: `${AP_BASE}.7.${IFACE1}`, value: 5180 },      // mtxrWlApFreq (MHz) -> 5GHz
];

const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const all = base.indexOf(AP_BASE) === 0 ? apWalked : rtabWalked;
    const rows = all.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};

const apMap = {
  byName: new Map([
    ['MikroTik TestNet (2)', { id: 42, name: 'MikroTik TestNet (2)' }],
    ['MikroTik OtherNet', { id: 99, name: 'MikroTik OtherNet' }], // unrelated 2nd AP
  ]),
  byMac: new Map(),
};

(async () => {
  const clients = await mikrotikClients.parseClients(fakeSession, apMap);
  console.log(JSON.stringify(clients, null, 2));

  const byMac = {};
  for (const c of clients) byMac[c.mac_address] = c;

  const correctMac1 = macFromHead(IDX1, 6);
  const buggyMac1 = macFromTail(IDX1, 6); // what the OLD code would have produced

  const c1 = byMac[correctMac1] || {};
  const c2 = byMac[macFromHead(IDX2, 6)] || {};

  const checks = [
    ['two clients parsed', clients.length === 2],

    // ── Bug 1: INDEX order / MAC recovery ──────────────────────────────
    ['correct MAC (macFromHead) present', correctMac1 === 'aa:bb:cc:dd:ee:ff'],
    ['buggy MAC (macFromTail) differs from correct MAC', buggyMac1 !== correctMac1],
    ['client 1 keyed under the CORRECT (head) MAC', !!byMac[correctMac1]],
    ['client 1 is NOT keyed under the buggy (tail) MAC', !byMac[buggyMac1]],
    ['client 1 mac_address === macFromHead result exactly', c1.mac_address === correctMac1],

    // ── Bug 2: column mapping ──────────────────────────────────────────
    ['rssi_dbm from .3 (-55), not .5 (RxBytes decoy)', c1.rssi_dbm === -55],
    ['tx_rate_mbps from .8 ÷ 1e6 = 866.7, not from .7/.8 swapped', c1.tx_rate_mbps === 866.7],
    ['rx_rate_mbps from .9 ÷ 1e6 = 400, not swapped with tx', c1.rx_rate_mbps === 400],
    ['tx_rate_mbps not derived from RxPackets decoy (.7)', c1.tx_rate_mbps !== 424242 / 1000000],
    ['uptime/connected_since still works (.11 ÷100 = 3600s)',
      c1.connected_since instanceof Date &&
      Math.abs((Date.now() - c1.connected_since.getTime()) - 3600 * 1000) < 5000],
    ['client 2 rssi_dbm from .3 (-70)', c2.rssi_dbm === -70],
    ['client 2 tx_rate_mbps = 54', c2.tx_rate_mbps === 54],
    ['client 2 rx_rate_mbps = 24', c2.rx_rate_mbps === 24],

    // ── Bug 3: SSID/band cross-reference via sibling mtxrWlApTable ──────
    ['client 1 ssid resolved via mtxrWlApTable iface lookup', c1.ssid_name === 'TestNet'],
    ['client 1 band resolved from freq 5180 MHz -> 5GHz', c1.band === '5GHz'],
    ['client 1 ap resolved via "MikroTik <ssid> (<iface>)" name join', c1.ap_id === 42 && c1.ap_name === 'MikroTik TestNet (2)'],
    ['client 2 (no AP-table row for its iface) has null ssid/band', c2.ssid_name === null && c2.band === null],
    ['client 2 not force-matched to the unrelated 2nd AP', c2.ap_id !== 99],
  ];

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} passed`);
  process.exit(fail ? 1 : 0);
})();

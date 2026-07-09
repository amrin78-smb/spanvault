'use strict';
// Offline check of the HPE Aruba Instant CLIENT parser (AI-AP-MIB aiClientTable)
// with synthetic walked data. Column numbers verified against the primary
// AI-AP-MIB text (LibreNMS mirror) in the 2026-07 audit; no HPE/Aruba Instant
// hardware in the lab — validate against real hardware.
//
// aiClientEntry — base 1.3.6.1.4.1.14823.2.3.3.1.2.4.1, INDEX = client MAC (6
// octets), so the client MAC comes from the OID index tail, never a column.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const hpeClients = require(path.join(ROOT, 'collector/wireless/clients/hpe.js'));

const TABLE = '1.3.6.1.4.1.14823.2.3.3.1.2.4.1';

// Client 1: aa:bb:cc:11:22:33 -> decimal index 170.187.204.17.34.51.
// BSSID matches the known AP's MAC directly -> primary (BSSID) correlation.
// Positive SNR (30) -> must convert to rssi_dbm = 30 - 95 = -65.
const CMAC1 = '170.187.204.17.34.51';

// Client 2: 11:22:33:44:55:66 -> decimal index 17.34.51.68.85.102.
// BSSID is unknown (no matching AP) -> falls back to AP-IP correlation via
// aiClientAPIPAddress. SNR is already negative (-70), i.e. a firmware that
// reports raw dBm directly -> must be kept as-is (not double-converted).
const CMAC2 = '17.34.51.68.85.102';

const AP_MAC = '1c:28:af:c1:a3:d6';
const AP_IP = '10.50.60.70';

const clientWalked = [
  // ── Client 1 ──
  { oid: `${TABLE}.2.${CMAC1}`, value: Buffer.from([0x1c, 0x28, 0xaf, 0xc1, 0xa3, 0xd6]) }, // aiClientWlanMACAddress (BSSID)
  { oid: `${TABLE}.3.${CMAC1}`, value: '10.10.10.11' },  // aiClientIPAddress
  { oid: `${TABLE}.4.${CMAC1}`, value: AP_IP },          // aiClientAPIPAddress
  { oid: `${TABLE}.7.${CMAC1}`, value: 30 },             // aiClientSNR (positive -> convert)
  { oid: `${TABLE}.11.${CMAC1}`, value: 300 },           // aiClientTxRate (mbps, direct)
  { oid: `${TABLE}.15.${CMAC1}`, value: 150 },           // aiClientRxRate (mbps, direct)
  { oid: `${TABLE}.16.${CMAC1}`, value: 360000 },        // aiClientUptime (ticks -> 3600s)
  { oid: `${TABLE}.17.${CMAC1}`, value: 1 },             // aiClientPhyType: dot11a -> 5GHz

  // ── Client 2 ──
  { oid: `${TABLE}.2.${CMAC2}`, value: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) }, // unknown BSSID
  { oid: `${TABLE}.3.${CMAC2}`, value: '10.10.10.22' },
  { oid: `${TABLE}.4.${CMAC2}`, value: AP_IP },          // matches AP's own IP -> fallback correlation
  { oid: `${TABLE}.7.${CMAC2}`, value: -70 },            // aiClientSNR (already negative -> kept as-is)
  { oid: `${TABLE}.11.${CMAC2}`, value: 54 },
  { oid: `${TABLE}.15.${CMAC2}`, value: 24 },
  { oid: `${TABLE}.16.${CMAC2}`, value: 100 },           // 100 ticks -> 1s
  { oid: `${TABLE}.17.${CMAC2}`, value: 2 },             // aiClientPhyType: dot11b -> 2.4GHz
];

// Fake SNMP session: subtree(base, maxReps, feed, done) filtered from the flat
// varbind list — same {oid, value} shape the real walk() emits (see
// tests/test-aruba-parser.js and tests/test-cisco-parser.js for the pattern).
const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const rows = clientWalked.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};

const apMap = {
  byMac: new Map([[AP_MAC, { id: 5, name: 'AP-TEST-01', ip_address: AP_IP }]]),
  byName: new Map([['AP-TEST-01', { id: 5, name: 'AP-TEST-01', ip_address: AP_IP }]]),
};

(async () => {
  const clients = await hpeClients.parseClients(fakeSession, apMap);
  console.log(JSON.stringify(clients, null, 2));

  const cl1 = clients.find((c) => c.mac_address === 'aa:bb:cc:11:22:33') || {};
  const cl2 = clients.find((c) => c.mac_address === '11:22:33:44:55:66') || {};

  const now = Date.now();

  const checks = [
    ['two clients parsed', clients.length === 2],
    // Client 1: MAC from index, IP, tx/rx mbps, connected_since, BSSID correlation
    ['client1 mac from index (not a column)', cl1.mac_address === 'aa:bb:cc:11:22:33'],
    ['client1 ip_address', cl1.ip_address === '10.10.10.11'],
    ['client1 tx_rate_mbps = 300 direct (no scaling)', cl1.tx_rate_mbps === 300],
    ['client1 rx_rate_mbps = 150 direct (no scaling)', cl1.rx_rate_mbps === 150],
    ['client1 connected_since ~3600s ago',
      cl1.connected_since instanceof Date &&
      Math.abs((now - cl1.connected_since.getTime()) / 1000 - 3600) < 5],
    ['client1 rssi_dbm = 30 - 95 = -65 (positive SNR converted)', cl1.rssi_dbm === -65],
    ['client1 band 5GHz (dot11a)', cl1.band === '5GHz'],
    ['client1 AP resolved via BSSID', cl1.ap_id === 5 && cl1.ap_name === 'AP-TEST-01'],
    ['client1 ssid_name left null (no SSID column in aiClientTable)', cl1.ssid_name === null],
    // Client 2: already-negative SNR kept as-is, AP-IP fallback correlation
    ['client2 mac from index', cl2.mac_address === '11:22:33:44:55:66'],
    ['client2 rssi_dbm = -70 kept as-is (already negative dBm)', cl2.rssi_dbm === -70],
    ['client2 band 2.4GHz (dot11b)', cl2.band === '2.4GHz'],
    ['client2 AP resolved via AP-IP fallback (BSSID unknown)', cl2.ap_id === 5 && cl2.ap_name === 'AP-TEST-01'],
    ['client2 connected_since ~1s ago',
      cl2.connected_since instanceof Date &&
      Math.abs((now - cl2.connected_since.getTime()) / 1000 - 1) < 5],
  ];

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();

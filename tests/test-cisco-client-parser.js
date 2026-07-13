'use strict';
// Offline check of the Cisco WLC CLIENT parser (AIRESPACE-WIRELESS-MIB
// bsnMobileStationTable/bsnMobileStationStatsTable) with synthetic walked data.
// Column numbers verified against the MIB text in the 2026-07 audit; no Cisco
// hardware in the lab — validate against real hardware. This is a structural
// regression guard (OID mapping / direction / decoding), not a live-hardware
// validation.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ciscoClients = require(path.join(ROOT, 'collector/wireless/clients/cisco.js'));

const TABLE = '1.3.6.1.4.1.14179.2.1.4.1';
const STATS_TABLE = '1.3.6.1.4.1.14179.2.1.6.1';

// Client 1: aa:bb:cc:11:22:33 -> decimal index 170.187.204.17.34.51.
// AP MAC given as a raw 6-byte Buffer; RSSI already dBm (no SNR conversion in
// this parser, unlike HPE) -> must be kept exactly as-is, including negative.
const CMAC1 = '170.187.204.17.34.51';

// Client 2: 11:22:33:44:55:66 -> decimal index 17.34.51.68.85.102.
// AP MAC given as a colon-hex STRING (exercises hexMac()'s string-parsing
// branch, not just the Buffer branch client1 covers). RSSI = 0 boundary ->
// must stay 0, not be reinterpreted as a weak-signal SNR the way HPE's would.
// Byte counters given as an 8-byte Counter64 Buffer spanning the 32-bit
// boundary (2^32 + 1000) to prove counterNum() decodes a true 64-bit value,
// not just a value that happens to fit in 32 bits.
const CMAC2 = '17.34.51.68.85.102';

// Client 3: 22:33:44:55:66:77 -> decimal index 34.51.68.85.102.119.
// No AP MAC, no RSSI, no byte counters, no SSID, no IP walked at all for this
// client -> every one of those fields must resolve to null, not 0/undefined.
// Unmapped protocol/policy codes -> band null, auth_type 'other'.
const CMAC3 = '34.51.68.85.102.119';

const AP_MAC = '1c:28:af:c1:a3:d6';

// 2^32 + 1000 = 4294968296, big-endian 8-byte Counter64 encoding.
const COUNTER64_OVER_32BIT = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x03, 0xe8]);

const clientWalked = [
  // ── Client 1 ──
  { oid: `${TABLE}.2.${CMAC1}`, value: '10.10.10.11' },   // bsnMobileStationIpAddress
  { oid: `${TABLE}.4.${CMAC1}`, value: Buffer.from([0x1c, 0x28, 0xaf, 0xc1, 0xa3, 0xd6]) }, // bsnMobileStationAPMacAddr (Buffer)
  { oid: `${TABLE}.7.${CMAC1}`, value: 'Corp-WiFi' },     // bsnMobileStationSsid
  { oid: `${TABLE}.25.${CMAC1}`, value: 1 },              // bsnMobileStationProtocol: dot11a -> 5GHz
  { oid: `${TABLE}.30.${CMAC1}`, value: 2 },              // bsnMobileStationPolicyType: wpa2
  { oid: `${STATS_TABLE}.1.${CMAC1}`, value: -55 },       // bsnMobileStationRSSI (already dBm, negative)
  { oid: `${STATS_TABLE}.2.${CMAC1}`, value: 500000 },    // bsnMobileStationBytesReceived (plain int) -> tx_bytes
  { oid: `${STATS_TABLE}.3.${CMAC1}`, value: 750000 },    // bsnMobileStationBytesSent (plain int) -> rx_bytes

  // ── Client 2 ──
  { oid: `${TABLE}.2.${CMAC2}`, value: '10.10.10.22' },
  { oid: `${TABLE}.4.${CMAC2}`, value: AP_MAC },          // AP MAC as a colon-hex string, not a Buffer
  { oid: `${TABLE}.7.${CMAC2}`, value: 'Guest-WiFi' },
  { oid: `${TABLE}.25.${CMAC2}`, value: 6 },              // dot11n24 -> 2.4GHz
  { oid: `${TABLE}.30.${CMAC2}`, value: 0 },              // dot1x
  { oid: `${STATS_TABLE}.1.${CMAC2}`, value: 0 },         // RSSI = 0 boundary -> must stay 0, not be converted
  { oid: `${STATS_TABLE}.2.${CMAC2}`, value: COUNTER64_OVER_32BIT }, // -> tx_bytes = 4294968296
  { oid: `${STATS_TABLE}.3.${CMAC2}`, value: 654321 },    // -> rx_bytes (plain int)

  // ── Client 3 ── (only protocol + policy walked; everything else absent)
  { oid: `${TABLE}.25.${CMAC3}`, value: 99 },             // unmapped protocol code -> band null
  { oid: `${TABLE}.30.${CMAC3}`, value: 5 },              // unmapped policy code -> auth_type 'other'
];

// Fake SNMP session: subtree(base, maxReps, feed, done) filtered from the flat
// varbind list — same {oid, value} shape the real walk() emits (see
// tests/test-hpe-client-parser.js for the pattern this mirrors).
const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const rows = clientWalked.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};

const apMap = {
  byMac: new Map([[AP_MAC, { id: 5, name: 'AP-TEST-01', ip_address: '10.50.60.70' }]]),
  byName: new Map([['AP-TEST-01', { id: 5, name: 'AP-TEST-01', ip_address: '10.50.60.70' }]]),
};

(async () => {
  const clients = await ciscoClients.parseClients(fakeSession, apMap);
  console.log(JSON.stringify(clients, null, 2));

  const cl1 = clients.find((c) => c.mac_address === 'aa:bb:cc:11:22:33') || {};
  const cl2 = clients.find((c) => c.mac_address === '11:22:33:44:55:66') || {};
  const cl3 = clients.find((c) => c.mac_address === '22:33:44:55:66:77') || {};

  const checks = [
    ['three clients parsed', clients.length === 3],

    // Client 1
    ['client1 mac from index (not a column)', cl1.mac_address === 'aa:bb:cc:11:22:33'],
    ['client1 ip_address', cl1.ip_address === '10.10.10.11'],
    ['client1 ssid_name', cl1.ssid_name === 'Corp-WiFi'],
    ['client1 band 5GHz (dot11a)', cl1.band === '5GHz'],
    ['client1 auth_type wpa2 (policy=2)', cl1.auth_type === 'wpa2'],
    ['client1 rssi_dbm = -55 kept as-is (no SNR conversion for Cisco)', cl1.rssi_dbm === -55],
    ['client1 AP resolved via Buffer-encoded AP MAC', cl1.ap_id === 5 && cl1.ap_name === 'AP-TEST-01'],
    // Direction mapping per the header comment: BytesReceived (by the controller,
    // FROM the station) is the client's upload -> tx_bytes; BytesSent (by the
    // controller, TO the station) is the client's download -> rx_bytes.
    ['client1 tx_bytes = 500000 (BytesReceived, plain int -> client upload)', cl1.tx_bytes === 500000],
    ['client1 rx_bytes = 750000 (BytesSent, plain int -> client download)', cl1.rx_bytes === 750000],
    ['client1 byte_counter_bits === 64 (Counter64)', cl1.byte_counter_bits === 64],
    ['client1 connected_since stays null (no association-time OID in this table)', cl1.connected_since === null],
    ['client1 tx_rate_mbps stays null (no data-rate OID in this table)', cl1.tx_rate_mbps === null],
    ['client1 rx_rate_mbps stays null (no data-rate OID in this table)', cl1.rx_rate_mbps === null],
    ['client1 channel stays null (not exposed in this table)', cl1.channel === null],

    // Client 2
    ['client2 mac from index', cl2.mac_address === '11:22:33:44:55:66'],
    ['client2 ssid_name', cl2.ssid_name === 'Guest-WiFi'],
    ['client2 band 2.4GHz (dot11n24)', cl2.band === '2.4GHz'],
    ['client2 auth_type dot1x (policy=0)', cl2.auth_type === 'dot1x'],
    ['client2 rssi_dbm = 0 boundary kept as literal 0 (not reinterpreted)', cl2.rssi_dbm === 0],
    ['client2 AP resolved via colon-hex-STRING AP MAC (hexMac string branch)', cl2.ap_id === 5 && cl2.ap_name === 'AP-TEST-01'],
    ['client2 tx_bytes = 4294968296 (Counter64 Buffer spanning 32-bit boundary)', cl2.tx_bytes === 4294968296],
    ['client2 rx_bytes = 654321 (BytesSent, plain int)', cl2.rx_bytes === 654321],
    ['client2 byte_counter_bits === 64', cl2.byte_counter_bits === 64],

    // Client 3 — only protocol/policy walked; everything else must be null, not 0.
    ['client3 mac from index', cl3.mac_address === '22:33:44:55:66:77'],
    ['client3 ip_address null when column absent from the walk', cl3.ip_address === null],
    ['client3 ssid_name null when column absent from the walk', cl3.ssid_name === null],
    ['client3 band null for an unmapped protocol code', cl3.band === null],
    ['client3 auth_type "other" for an unmapped policy code', cl3.auth_type === 'other'],
    ['client3 rssi_dbm null when no RSSI walked', cl3.rssi_dbm === null],
    ['client3 AP unresolved (no AP MAC walked)', cl3.ap_id === null && cl3.ap_name === null],
    ['client3 tx_bytes null when no byte counters walked', cl3.tx_bytes === null],
    ['client3 rx_bytes null when no byte counters walked', cl3.rx_bytes === null],
    ['client3 byte_counter_bits stays null when no byte counters present', cl3.byte_counter_bits === null],
  ];

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();

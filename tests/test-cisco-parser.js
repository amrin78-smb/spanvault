'use strict';
// Offline check of the MIB-audited Cisco parser with synthetic walked data on
// the CORRECTED OIDs: bsnAPTable index = 6-octet Dot3 MAC; radio/load tables
// MAC+slot; noise table MAC+slot+channel (8 components); ESS table by WLAN id;
// rogue table by rogue MAC; client table by client MAC.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const cisco = require(path.join(ROOT, 'collector/wireless/cisco.js'));
const ciscoClients = require(path.join(ROOT, 'collector/wireless/clients/cisco.js'));

// AP1: 00:1b:d3:05:06:07 — slot 0 = dot11b (2.4G, ch 6), slot 1 = XOR56 (ch 149 → 5g)
const MAC1 = '0.27.211.5.6.7';
// AP2: 00:1b:d3:05:6:8 — slot 0 = dot11a (5G, ch 36), noise 0 on the matching channel → null
const MAC2 = '0.27.211.5.6.8';

const AP_BASE = '1.3.6.1.4.1.14179.2.2.1.1';
const IF_BASE = '1.3.6.1.4.1.14179.2.2.2.1';
const LOAD_BASE = '1.3.6.1.4.1.14179.2.2.13.1';
const NOISE = '1.3.6.1.4.1.14179.2.2.15.1.21';
const ESS_BASE = '1.3.6.1.4.1.14179.2.1.1.1';
const ROGUE_BASE = '1.3.6.1.4.1.14179.2.1.7.1';
const STA_BASE = '1.3.6.1.4.1.14179.2.1.4.1';
const STA_STATS = '1.3.6.1.4.1.14179.2.1.6.1';

const walked = {
  // ── bsnAPTable (index = Ethernet/Dot3 MAC) ──
  bsnAPName: [
    { oid: `${AP_BASE}.3.${MAC1}`, value: 'AP-CISCO-01' },
    { oid: `${AP_BASE}.3.${MAC2}`, value: 'AP-CISCO-02' },
  ],
  bsnApIp: [
    { oid: `${AP_BASE}.19.${MAC1}`, value: '10.20.30.41' },
    { oid: `${AP_BASE}.19.${MAC2}`, value: '10.20.30.42' },
  ],
  bsnAPModel: [
    { oid: `${AP_BASE}.16.${MAC1}`, value: 'AIR-CAP3702I-E-K9' },
    { oid: `${AP_BASE}.16.${MAC2}`, value: 'AIR-AP2802I-E-K9' },
  ],
  bsnAPStatus: [
    { oid: `${AP_BASE}.6.${MAC1}`, value: 1 },  // associated → online
    { oid: `${AP_BASE}.6.${MAC2}`, value: 2 },  // disassociating → offline
  ],
  bsnApSerial: [{ oid: `${AP_BASE}.17.${MAC1}`, value: 'FCW1234A5BC' }],
  bsnApSwVersion: [{ oid: `${AP_BASE}.8.${MAC1}`, value: '8.10.185.0' }],
  // ── bsnAPIfTable (index = MAC.slot): type decides the band ──
  bsnApIfType: [
    { oid: `${IF_BASE}.2.${MAC1}.0`, value: 1 }, // dot11b → 2g
    { oid: `${IF_BASE}.2.${MAC1}.1`, value: 7 }, // xor56 → channel decides (149 → 5g)
    { oid: `${IF_BASE}.2.${MAC2}.0`, value: 2 }, // dot11a → 5g (slot heuristic would say 2g!)
  ],
  bsnApChannel: [
    { oid: `${IF_BASE}.4.${MAC1}.0`, value: 6 },
    { oid: `${IF_BASE}.4.${MAC1}.1`, value: 149 },
    { oid: `${IF_BASE}.4.${MAC2}.0`, value: 36 },
  ],
  // ── load table (index = MAC.slot) ──
  bsnApIfRxUtil: [
    { oid: `${LOAD_BASE}.1.${MAC1}.0`, value: 10 },
    { oid: `${LOAD_BASE}.1.${MAC1}.1`, value: 3 },
  ],
  bsnApIfTxUtil: [
    { oid: `${LOAD_BASE}.2.${MAC1}.0`, value: 12 },
    { oid: `${LOAD_BASE}.2.${MAC1}.1`, value: 8 },
  ],
  bsnApChannelUtil: [
    { oid: `${LOAD_BASE}.3.${MAC1}.0`, value: 30 },
    { oid: `${LOAD_BASE}.3.${MAC1}.1`, value: 55 },
    { oid: `${LOAD_BASE}.3.${MAC2}.0`, value: 21 },
  ],
  bsnApLoadClients: [
    { oid: `${LOAD_BASE}.4.${MAC1}.0`, value: 4 },
    { oid: `${LOAD_BASE}.4.${MAC1}.1`, value: 9 },
    { oid: `${LOAD_BASE}.4.${MAC2}.0`, value: 2 },
  ],
  // ── noise table (index = MAC.slot.channel — 8 components) ──
  bsnApNoise: [
    { oid: `${NOISE}.${MAC1}.0.1`, value: -70 },   // wrong channel (radio is on 6) → skipped
    { oid: `${NOISE}.${MAC1}.0.6`, value: -88 },   // matches current channel → picked
    { oid: `${NOISE}.${MAC1}.0.11`, value: -66 },  // wrong channel → skipped
    { oid: `${NOISE}.${MAC1}.1.149`, value: -95 }, // matches → picked (5g)
    { oid: `${NOISE}.${MAC2}.0.36`, value: 0 },    // matching channel but 0 → null
  ],
  // ── bsnDot11EssTable (index = WLAN id) ──
  bsnEssSsid: [
    { oid: `${ESS_BASE}.2.1`, value: 'CORP' },
    { oid: `${ESS_BASE}.2.2`, value: 'GUEST' },
  ],
  bsnEssAdmin: [
    { oid: `${ESS_BASE}.6.1`, value: 1 }, // enable → up
    { oid: `${ESS_BASE}.6.2`, value: 0 }, // disable → down
  ],
  bsnEssClients: [
    { oid: `${ESS_BASE}.38.1`, value: 42 },
    { oid: `${ESS_BASE}.38.2`, value: 0 },
  ],
};

// ── rogue table (index = rogue MAC) ──
const R1 = '170.187.204.221.238.255'; // aa:bb:cc:dd:ee:ff — classType 2 → malicious
const R2 = '2.4.6.8.10.12';           // 02:04:06:08:0a:0c — no class, state 2 (alert) → rogue
const rogueWalked = {
  rogueMac: [{ oid: `${ROGUE_BASE}.1.${R1}`, value: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]) }],
  rogueSsid: [
    { oid: `${ROGUE_BASE}.11.${R1}`, value: 'FreeWifi' },
    { oid: `${ROGUE_BASE}.11.${R2}`, value: 'Linksys' },
  ],
  rogueRssi: [{ oid: `${ROGUE_BASE}.10.${R1}`, value: -60 }],
  rogueDetector: [{ oid: `${ROGUE_BASE}.13.${R1}`, value: Buffer.from([0x00, 0x1b, 0xd3, 0x05, 0x06, 0x07]) }],
  rogueState: [
    { oid: `${ROGUE_BASE}.24.${R1}`, value: 6 },  // contained — but class wins
    { oid: `${ROGUE_BASE}.24.${R2}`, value: 2 },  // alert → rogue (state fallback)
  ],
  rogueClass: [{ oid: `${ROGUE_BASE}.25.${R1}`, value: 2 }], // malicious
  rogueChannel: [{ oid: `${ROGUE_BASE}.26.${R1}`, value: 11 }],
};

// ── client table (bsnMobileStationTable, index = client MAC) + stats RSSI ──
const CMAC = '16.32.48.64.80.96'; // 10:20:30:40:50:60
const clientVarbinds = [
  { oid: `${STA_BASE}.2.${CMAC}`, value: '10.1.2.3' },                                    // IpAddress
  { oid: `${STA_BASE}.4.${CMAC}`, value: Buffer.from([0x00, 0x1b, 0xd3, 0x05, 0x06, 0x07]) }, // AP MAC
  { oid: `${STA_BASE}.3.${CMAC}`, value: 'jdoe' },       // UserName — must NOT be picked up as SSID
  { oid: `${STA_BASE}.7.${CMAC}`, value: 'CORP' },       // bsnMobileStationSsid
  { oid: `${STA_BASE}.6.${CMAC}`, value: 3 },            // EssIndex — must NOT become connected_since
  { oid: `${STA_BASE}.25.${CMAC}`, value: 7 },           // dot11n5 → 5GHz
  { oid: `${STA_BASE}.30.${CMAC}`, value: 2 },           // wpa2
  { oid: `${STA_STATS}.1.${CMAC}`, value: -57 },         // bsnMobileStationRSSI
];

// Fake SNMP session: subtree(base, maxReps, feed, done) filtered from the flat
// varbind list — same {oid, value} shape the real walk() emits.
const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const rows = clientVarbinds.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};

const apMap = {
  byMac: new Map([['00:1b:d3:05:06:07', { id: 77, name: 'AP-CISCO-01' }]]),
  byName: new Map(),
};

(async () => {
  const aps = cisco.parseApTable(walked);
  const ap1 = aps.find((a) => a.name === 'AP-CISCO-01') || {};
  const ap2 = aps.find((a) => a.name === 'AP-CISCO-02') || {};
  const counts = cisco.parseClientCounts(walked);
  const ssids = cisco.parseSsids(walked);
  const corp = ssids.find((s) => s.ssid_name === 'CORP') || {};
  const guest = ssids.find((s) => s.ssid_name === 'GUEST') || {};
  const rogues = cisco.parseRogueAps(rogueWalked);
  const rogue1 = rogues.find((r) => r.bssid === 'aa:bb:cc:dd:ee:ff') || {};
  const rogue2 = rogues.find((r) => r.bssid === '02:04:06:08:0a:0c') || {};
  const clients = await ciscoClients.parseClients(fakeSession, apMap);
  const cl = clients[0] || {};

  console.log(JSON.stringify({ aps, counts, ssids, rogues, clients }, null, 2));

  const checks = [
    // AP identity (C1/C2/C3/C16): bsnAPTable-only, MAC from index, serial/firmware
    ['two APs parsed (no cLAp ghost rows)', aps.length === 2],
    ['ap1 name', ap1.name === 'AP-CISCO-01'],
    ['ap1 ip from bsnApIpAddress', ap1.ip_address === '10.20.30.41'],
    ['ap1 model from bsnAPModel', ap1.model === 'AIR-CAP3702I-E-K9'],
    ['ap1 mac from Dot3 index', ap1.mac_address === '00:1b:d3:05:06:07'],
    ['ap1 serial', ap1.serial_number === 'FCW1234A5BC'],
    ['ap1 firmware', ap1.firmware_version === '8.10.185.0'],
    ['ap1 online / ap2 offline', ap1.status === 'online' && ap2.status === 'offline'],
    ['tx_power stays null (level, not dBm)', ap1.tx_power_2g === null && ap1.tx_power_5g === null],
    // C4: per-radio clients from load table, summed into clients_total
    ['ap1 clients 2g=4 5g=9 total=13', ap1.clients_2g === 4 && ap1.clients_5g === 9 && ap1.clients_total === 13],
    ['ap2 clients total=2 on 5g (ifType 2, not slot 0=2g)', ap2.clients_5g === 2 && ap2.clients_2g === 0 && ap2.clients_total === 2],
    // C14: band via bsnAPIfType (incl. XOR via channel) drives util placement
    ['ap1 util 2g=30 5g=55 (xor slot 1 → 5g by ch 149)', ap1.radio_2g_util_pct === 30 && ap1.radio_5g_util_pct === 55],
    ['ap2 util on 5g=21 despite slot 0', ap2.radio_5g_util_pct === 21 && ap2.radio_2g_util_pct === null],
    ['ap1 channels 2g=6 5g=149', ap1.radio_2g_channel === 6 && ap1.radio_5g_channel === 149],
    // C5: retry approximation from corrected load OIDs (max of rx/tx)
    ['ap1 retry 2g=max(10,12)=12 5g=max(3,8)=8', ap1.retry_rate_2g === 12 && ap1.retry_rate_5g === 8],
    // C6: noise picked by current-channel match, negative, per band; 0 → null
    ['ap1 noise 2g=-88 (ch 6 row, not -70/-66)', ap1.noise_floor_2g === -88],
    ['ap1 noise 5g=-95', ap1.noise_floor_5g === -95],
    ['ap2 noise null (0 on matching channel)', ap2.noise_floor_5g === null && ap2.noise_floor_2g === null],
    // M2: parseClientCounts derived from the fixed AP table
    ['parseClientCounts maps apKey→clients', counts.length === 2 &&
      counts.find((c) => c.apKey === MAC1).clients === 13 &&
      counts.find((c) => c.apKey === MAC2).clients === 2],
    // C7/C8/C9/C10/C11: SSID name, admin status, station count, nulled counters
    ['CORP up, 42 clients', corp.status === 'up' && corp.clients_total === 42],
    ['GUEST down', guest.status === 'down'],
    ['SSID bytes_in/out null (no per-WLAN octets in MIB)', corp.bytes_in === null && corp.bytes_out === null],
    ['SSID auth_failures null (not 0)', corp.auth_failures === null],
    // C12/C13: rogue table rewired, classType preferred, state fallback
    ['rogue1 classType 2 → malicious', rogue1.classification === 'malicious'],
    ['rogue1 ssid/rssi/channel', rogue1.ssid === 'FreeWifi' && rogue1.rssi_dbm === -60 && rogue1.channel === 11],
    ['rogue1 detecting AP mac', rogue1.detecting_ap === '00:1b:d3:05:06:07'],
    ['rogue2 state alert(2) → rogue', rogue2.classification === 'rogue'],
    // K2/K4/K5/K6/K7/K8: client columns
    ['one client parsed', clients.length === 1],
    ['client mac from index', cl.mac_address === '10:20:30:40:50:60'],
    ['client ssid from .7 (not UserName .3)', cl.ssid_name === 'CORP'],
    ['client rssi from stats table = -57', cl.rssi_dbm === -57],
    ['client band from protocol 7 → 5GHz', cl.band === '5GHz'],
    ['client auth from policy 2 → wpa2', cl.auth_type === 'wpa2'],
    ['client connected_since null (K4)', cl.connected_since === null],
    ['client tx/rx rates null (K6)', cl.tx_rate_mbps === null && cl.rx_rate_mbps === null],
    ['client AP correlated by MAC', cl.ap_id === 77 && cl.ap_name === 'AP-CISCO-01'],
    ['client ip', cl.ip_address === '10.1.2.3'],
  ];

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();

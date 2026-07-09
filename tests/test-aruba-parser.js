'use strict';
// Offline check of the Aruba parser with synthetic walked data that mirrors the
// live formats confirmed on the 7205/9106: index = 6 MAC octets + radioNumber,
// noise positive-encoded, byte counters as 8-byte BE Buffers (Counter64).
const path = require('path');
const ROOT = path.join(__dirname, '..');
const aruba = require(path.join(ROOT, 'collector/wireless/aruba.js'));
const arubaClients = require(path.join(ROOT, 'collector/wireless/clients/aruba.js'));

const MAC = '28.40.175.193.163.214'; // 1c:28:af:c1:a3:d6 as decimal index
const AP_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.4.1';
const RADIO_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.5.1';
const CH_BASE = '1.3.6.1.4.1.14823.2.2.1.5.3.1.6.1';
const RS_BASE = '1.3.6.1.4.1.14823.2.2.1.5.3.1.9.1';

function c64(n) { // encode a number as an 8-byte BE buffer like net-snmp Counter64
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

const walked = {
  apName:   [{ oid: `${AP_BASE}.3.${MAC}`, value: 'AP-TEST-01' }],
  apIp:     [{ oid: `${AP_BASE}.2.${MAC}`, value: Buffer.from([172, 64, 200, 10]) }],
  apStatus: [{ oid: `${AP_BASE}.19.${MAC}`, value: 1 }],
  apUptime: [{ oid: `${AP_BASE}.12.${MAC}`, value: 360000 }],
  apModel:  [{ oid: `${AP_BASE}.13.${MAC}`, value: 'AP-535' }],
  apSerial:   [{ oid: `${AP_BASE}.6.${MAC}`, value: 'CNLBKPPCL7' }],
  apFirmware: [{ oid: `${AP_BASE}.34.${MAC}`, value: '8.10.0.8' }],
  // radio 1 = ch 36 (5g), radio 2 = ch 6 (2g)
  radioChannel: [
    { oid: `${RADIO_BASE}.3.${MAC}.1`, value: 36 },
    { oid: `${RADIO_BASE}.3.${MAC}.2`, value: 6 },
  ],
  // wlanAPRadioTransmitPower10x is dBm x10 — 180/60 → 18.0/6.0 dBm.
  radioTxPower10x: [
    { oid: `${RADIO_BASE}.17.${MAC}.1`, value: 180 },
    { oid: `${RADIO_BASE}.17.${MAC}.2`, value: 60 },
  ],
  radioUtil: [
    { oid: `${RADIO_BASE}.6.${MAC}.1`, value: 17 },
    { oid: `${RADIO_BASE}.6.${MAC}.2`, value: 62 },
  ],
  radioClients: [
    { oid: `${RADIO_BASE}.7.${MAC}.1`, value: 12 },
    { oid: `${RADIO_BASE}.7.${MAC}.2`, value: 5 },
  ],
  chNoise: [
    { oid: `${CH_BASE}.9.${MAC}.1`, value: 92 },   // → -92 dBm on 5g
    { oid: `${CH_BASE}.9.${MAC}.2`, value: 0 },    // 0 = not reported → null
  ],
  chRetry: [
    { oid: `${CH_BASE}.12.${MAC}.1`, value: 14 },
    { oid: `${CH_BASE}.12.${MAC}.2`, value: 0 },
  ],
  // busy 45, rx 12, tx 19 → interference 14 on 5g; 2g missing txUtil → null
  chBusy: [
    { oid: `${CH_BASE}.37.${MAC}.1`, value: 45 },
    { oid: `${CH_BASE}.37.${MAC}.2`, value: 62 },
  ],
  chRxUtil: [
    { oid: `${CH_BASE}.35.${MAC}.1`, value: 12 },
    { oid: `${CH_BASE}.35.${MAC}.2`, value: 40 },
  ],
  chTxUtil: [
    { oid: `${CH_BASE}.36.${MAC}.1`, value: 19 },
  ],
  // wlanAPChFCSErrorCount → rx_errors_*. 2g deliberately omitted to exercise
  // the null-when-absent case (never fake a 0 for an unreported metric).
  chFcsErrors: [
    { oid: `${CH_BASE}.32.${MAC}.1`, value: 1380799423 },
  ],
  radioRxBytes: [
    { oid: `${RS_BASE}.2.${MAC}.1`, value: c64(607531766574) },
    { oid: `${RS_BASE}.2.${MAC}.2`, value: c64(1000) },
  ],
  radioTxBytes: [
    { oid: `${RS_BASE}.4.${MAC}.1`, value: c64(1681273835390) },
    { oid: `${RS_BASE}.4.${MAC}.2`, value: c64(2000) },
  ],
  // wlanAPRadioTxErrorPkts → tx_errors_*.
  radioTxErrors: [
    { oid: `${RS_BASE}.6.${MAC}.1`, value: 1840360 },
    { oid: `${RS_BASE}.6.${MAC}.2`, value: 29911 },
  ],
};

// ── Client (station) table — wlsxWlanStationTable, base ...5.2.2.1.1 ──
// Live SNMP evidence (both an Aruba 7205/AOS 8.10 and a 9106/AOS 8.13): column
// .10 (wlanStaTransmitRate) is a dead/legacy field that only ever returned
// {0,7,10,12,255} across ~1150 real stations regardless of actual PHY rate —
// 255 is a 0xFF cap/sentinel. Column .17 (wlanStaTransmitRateCode) is the only
// column whose MIB DESCRIPTION states "unit is mbps", and live data confirmed
// it: the same stations showed a realistic 6-1201 Mbps spread matching real
// 802.11n/ac/ax rate tables. This test locks in .17 as the source column.
const STA_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.2.1.1';
const USER_BASE = '1.3.6.1.4.1.14823.2.2.1.4.1.2.1';
const CMAC = '80.42.34.128.16.32'; // 50:2a:22:80:10:20
const staWalked = [
  { oid: `${STA_BASE}.2.${CMAC}`, value: Buffer.from([0x1c, 0x28, 0xaf, 0xc1, 0xa3, 0xd6]) }, // AP BSSID
  { oid: `${STA_BASE}.6.${CMAC}`, value: 36 },      // channel (5g)
  { oid: `${STA_BASE}.10.${CMAC}`, value: 255 },    // wlanStaTransmitRate — dead field, must be IGNORED
  { oid: `${STA_BASE}.17.${CMAC}`, value: 455 },    // wlanStaTransmitRateCode — real rate, 455 Mbps (802.11ac)
  { oid: `${STA_BASE}.12.${CMAC}`, value: 'Corp-WiFi' },
  { oid: `${STA_BASE}.14.${CMAC}`, value: 30 },     // SNR 30dB → rssi ≈ 30-95 = -65 dBm
  { oid: `${STA_BASE}.15.${CMAC}`, value: 360000 }, // TimeTicks → 3600s
];
const userWalked = [
  { oid: `${USER_BASE}.10.${CMAC}.10.20.30.40`, value: 'AP-TEST-01' },
];
const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const all = base.startsWith(USER_BASE) ? userWalked : staWalked;
    const rows = all.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};
const apMap = {
  byMac: new Map([['1c:28:af:c1:a3:d6', { id: 5, name: 'AP-TEST-01' }]]),
  byName: new Map([['AP-TEST-01', { id: 5, name: 'AP-TEST-01' }]]),
};

(async () => {
  const aps = aruba.parseApTable(walked);
  console.log(JSON.stringify(aps, null, 2));

  const ap = aps[0] || {};
  const clients = await arubaClients.parseClients(fakeSession, apMap);
  const cl = clients[0] || {};
  console.log(JSON.stringify(clients, null, 2));

  const checks = [
    ['one AP parsed', aps.length === 1],
    ['noise_floor_5g = -92', ap.noise_floor_5g === -92],
    ['noise_floor_2g null (0 → null)', ap.noise_floor_2g === null],
    ['retry_rate_5g = 14', ap.retry_rate_5g === 14],
    ['retry_rate_2g = 0 (legit zero kept)', ap.retry_rate_2g === 0],
    ['rx_bytes summed', ap.rx_bytes === 607531766574 + 1000],
    ['tx_bytes summed', ap.tx_bytes === 1681273835390 + 2000],
    ['channels/util/clients unchanged', ap.radio_5g_channel === 36 && ap.radio_2g_util_pct === 62 && ap.clients_total === 17],
    ['interference_pct_5g = 45-12-19 = 14', ap.interference_pct_5g === 14],
    ['interference_pct_2g null (txUtil missing)', ap.interference_pct_2g === null],
    // Newly-wired fields (tx_power, serial, firmware, rx/tx errors) — live-verified 2026-07-09.
    ['serial_number', ap.serial_number === 'CNLBKPPCL7'],
    ['firmware_version', ap.firmware_version === '8.10.0.8'],
    ['tx_power_5g = 180/10 = 18 dBm', ap.tx_power_5g === 18],
    ['tx_power_2g = 60/10 = 6 dBm', ap.tx_power_2g === 6],
    ['rx_errors_5g from FCS count', ap.rx_errors_5g === 1380799423],
    ['rx_errors_2g null (OID absent, never fake a 0)', ap.rx_errors_2g === null],
    ['tx_errors_5g from TxErrorPkts', ap.tx_errors_5g === 1840360],
    ['tx_errors_2g from TxErrorPkts', ap.tx_errors_2g === 29911],
    // Client rate regression: must read .17 (455), NEVER .10 (255)
    ['one client parsed', clients.length === 1],
    ['tx_rate_mbps = 455 from .17, not 255 from .10', cl.tx_rate_mbps === 455],
    ['client mac from station index', cl.mac_address === '50:2a:22:80:10:20'],
    ['client ssid', cl.ssid_name === 'Corp-WiFi'],
    ['client band 5GHz (channel 36)', cl.band === '5GHz'],
    ['client ap resolved via bssid', cl.ap_name === 'AP-TEST-01'],
  ];
  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  process.exit(fail ? 1 : 0);
})();

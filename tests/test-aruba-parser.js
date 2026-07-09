'use strict';
// Offline check of the Aruba parser with synthetic walked data that mirrors the
// live formats confirmed on the 7205/9106: index = 6 MAC octets + radioNumber,
// noise positive-encoded, byte counters as 8-byte BE Buffers (Counter64).
const path = require('path');
const ROOT = path.join(__dirname, '..');
const aruba = require(path.join(ROOT, 'collector/wireless/aruba.js'));

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
  // radio 1 = ch 36 (5g), radio 2 = ch 6 (2g)
  radioChannel: [
    { oid: `${RADIO_BASE}.3.${MAC}.1`, value: 36 },
    { oid: `${RADIO_BASE}.3.${MAC}.2`, value: 6 },
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
  radioRxBytes: [
    { oid: `${RS_BASE}.2.${MAC}.1`, value: c64(607531766574) },
    { oid: `${RS_BASE}.2.${MAC}.2`, value: c64(1000) },
  ],
  radioTxBytes: [
    { oid: `${RS_BASE}.4.${MAC}.1`, value: c64(1681273835390) },
    { oid: `${RS_BASE}.4.${MAC}.2`, value: c64(2000) },
  ],
};

const aps = aruba.parseApTable(walked);
console.log(JSON.stringify(aps, null, 2));

const ap = aps[0] || {};
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
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);

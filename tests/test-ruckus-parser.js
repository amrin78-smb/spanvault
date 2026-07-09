'use strict';
// Offline check of the CORRECTED Ruckus (ZoneDirector) parser with synthetic
// walked data on the MIB-verified OIDs:
//   AP table    …25053.1.2.2.1.1.2.1.1 (INDEX = 6-octet MAC)
//   Radio stats …25053.1.2.2.1.1.2.2.1 (INDEX = MAC + radioIndex, RadioType col)
//   WLAN table  …25053.1.2.2.1.1.1.1.1 (INDEX = integer)
//   Rogue table …25053.1.2.2.1.1.4.1.1 (INDEX = integer, MAC in column .1)
// Counter64 values delivered as 8-byte BE Buffers, like net-snmp.
// Also quick assertions for the fortinet and mikrotik fixes.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ruckus = require(path.join(ROOT, 'collector/wireless/ruckus.js'));
const fortinet = require(path.join(ROOT, 'collector/wireless/fortinet.js'));
const mikrotik = require(path.join(ROOT, 'collector/wireless/mikrotik.js'));

function c64(n) { // encode a number as an 8-byte BE buffer like net-snmp Counter64
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

const checks = [];
function check(name, ok) { checks.push([name, ok]); }

// ── Ruckus ───────────────────────────────────────────────────────────────────
const MAC = '44.28.168.1.2.3'; // 2c:1c:a8:01:02:03 as dotted-decimal index
const MAC_BUF = Buffer.from([0x2c, 0x1c, 0xa8, 0x01, 0x02, 0x03]);
const AP_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.1.1';
const RADIO_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.2.1';
const WLAN_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.1.1.1';
const ROGUE_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.4.1.1';

const walked = {
  // AP table (index = 6-octet MAC). MacAddress value = 6-byte Buffer.
  apMac:     [{ oid: `${AP_BASE}.1.${MAC}`, value: MAC_BUF }],
  apName:    [{ oid: `${AP_BASE}.2.${MAC}`, value: 'RuckusAP-Lobby' }],
  apStatus:  [{ oid: `${AP_BASE}.3.${MAC}`, value: 1 }], // connected(1)
  apModel:   [{ oid: `${AP_BASE}.4.${MAC}`, value: 'R650' }],
  apUptime:  [{ oid: `${AP_BASE}.6.${MAC}`, value: 8640000 }], // TimeTicks → 86400 s
  apIp:      [{ oid: `${AP_BASE}.10.${MAC}`, value: '10.20.30.40' }],
  apClients: [{ oid: `${AP_BASE}.15.${MAC}`, value: 21 }],
  // Radio stats (index = MAC.radioIndex). RadioType: radio11ng(2) → 2g,
  // radio11ac(4) → 5g (radio numbers deliberately NOT following the 0/1
  // convention on the 5g row, so RadioType must win).
  radioType: [
    { oid: `${RADIO_BASE}.3.${MAC}.0`, value: 2 }, // radio11ng → 2g
    { oid: `${RADIO_BASE}.3.${MAC}.1`, value: 4 }, // radio11ac → 5g
  ],
  radioChannel: [
    { oid: `${RADIO_BASE}.4.${MAC}.0`, value: 11 },
    { oid: `${RADIO_BASE}.4.${MAC}.1`, value: 149 },
  ],
  radioChannelUtil: [
    { oid: `${RADIO_BASE}.40.${MAC}.0`, value: 37 },
    { oid: `${RADIO_BASE}.40.${MAC}.1`, value: 12 },
  ],
  radioNumSta: [
    { oid: `${RADIO_BASE}.8.${MAC}.0`, value: 6 },
    { oid: `${RADIO_BASE}.8.${MAC}.1`, value: 15 },
  ],
  radioRxBytes: [
    { oid: `${RADIO_BASE}.11.${MAC}.0`, value: c64(123456789012) },
    { oid: `${RADIO_BASE}.11.${MAC}.1`, value: c64(5000) },
  ],
  radioTxBytes: [
    { oid: `${RADIO_BASE}.14.${MAC}.0`, value: c64(987654321098) },
    { oid: `${RADIO_BASE}.14.${MAC}.1`, value: c64(7000) },
  ],
  // WLAN table (index = integer). SSID from .1, clients .12, bytes Counter64.
  ssidName:        [{ oid: `${WLAN_BASE}.1.5`, value: 'CorpWiFi' }],
  ssidNumSta:      [{ oid: `${WLAN_BASE}.12.5`, value: 42 }],
  ssidRxBytes:     [{ oid: `${WLAN_BASE}.14.5`, value: c64(111222333444) }],
  ssidTxBytes:     [{ oid: `${WLAN_BASE}.16.5`, value: c64(555666777888) }],
  ssidAuthSuccess: [{ oid: `${WLAN_BASE}.28.5`, value: c64(9001) }],
  ssidAuthFail:    [{ oid: `${WLAN_BASE}.29.5`, value: c64(17) }],
};

const aps = ruckus.parseApTable(walked);
console.log(JSON.stringify(aps, null, 2));

const ap = aps[0] || {};
check('ruckus: one AP parsed', aps.length === 1);
check('ruckus: name from AP .2', ap.name === 'RuckusAP-Lobby');
check('ruckus: ip from AP .10', ap.ip_address === '10.20.30.40');
check('ruckus: model from AP .4', ap.model === 'R650');
check('ruckus: mac colon-hex from Buffer', ap.mac_address === '2c:1c:a8:01:02:03');
check('ruckus: status connected(1) → online', ap.status === 'online');
check('ruckus: uptime TimeTicks ÷100', ap.uptime_seconds === 86400);
check('ruckus: 2g channel via RadioType', ap.radio_2g_channel === 11);
check('ruckus: 5g channel via RadioType (radioIndex 1 would also say 5g; ch 149 proves .4)', ap.radio_5g_channel === 149);
check('ruckus: 2g util from .40', ap.radio_2g_util_pct === 37);
check('ruckus: 5g util from .40', ap.radio_5g_util_pct === 12);
check('ruckus: clients_2g from .8', ap.clients_2g === 6);
check('ruckus: clients_5g from .8', ap.clients_5g === 15);
check('ruckus: clients_total from AP table .15', ap.clients_total === 21);
check('ruckus: rx_bytes summed via counterNum', ap.rx_bytes === 123456789012 + 5000);
check('ruckus: tx_bytes summed via counterNum', ap.tx_bytes === 987654321098 + 7000);
check('ruckus: noise floor stays null (no MIB object)', ap.noise_floor_2g === null && ap.noise_floor_5g === null);

// RadioType actually wins over radio-index convention: give a 2g RadioType on
// radioIndex 1 (which the index heuristic would call 5g).
const apsRt = ruckus.parseApTable({
  apName: [{ oid: `${AP_BASE}.2.${MAC}`, value: 'RT-Test' }],
  radioType: [{ oid: `${RADIO_BASE}.3.${MAC}.1`, value: 0 }], // radio11bg → 2g
  radioChannel: [{ oid: `${RADIO_BASE}.4.${MAC}.1`, value: 6 }],
});
check('ruckus: RadioType overrides radio-index band', apsRt[0] && apsRt[0].radio_2g_channel === 6 && apsRt[0].radio_5g_channel === null);
// Fallback to radio index when RadioType is absent.
const apsFb = ruckus.parseApTable({
  apName: [{ oid: `${AP_BASE}.2.${MAC}`, value: 'FB-Test' }],
  radioChannel: [
    { oid: `${RADIO_BASE}.4.${MAC}.0`, value: 1 },
    { oid: `${RADIO_BASE}.4.${MAC}.1`, value: 36 },
  ],
});
check('ruckus: bandForRadioIndex fallback when RadioType absent', apsFb[0] && apsFb[0].radio_2g_channel === 1 && apsFb[0].radio_5g_channel === 36);

// AP-status enum edges.
const stAps = ruckus.parseApTable({
  apStatus: [
    { oid: `${AP_BASE}.3.1.2.3.4.5.6`, value: 0 }, // disconnected → offline
    { oid: `${AP_BASE}.3.1.2.3.4.5.7`, value: 3 }, // upgradingFirmware → unknown
  ],
});
const stByMac = {};
for (const a of stAps) stByMac[a._index] = a.status;
check('ruckus: disconnected(0) → offline', stByMac['1.2.3.4.5.6'] === 'offline');
check('ruckus: upgradingFirmware(3) → unknown', stByMac['1.2.3.4.5.7'] === 'unknown');

// SSIDs.
const ssids = ruckus.parseSsids(walked);
console.log(JSON.stringify(ssids, null, 2));
const s = ssids[0] || {};
check('ruckus: one SSID parsed', ssids.length === 1);
check('ruckus: SSID name from .1', s.ssid_name === 'CorpWiFi');
check('ruckus: SSID clients from .12', s.clients_total === 42);
check('ruckus: SSID bytes_in via counterNum (.14)', s.bytes_in === 111222333444);
check('ruckus: SSID bytes_out via counterNum (.16)', s.bytes_out === 555666777888);
check('ruckus: SSID auth_successes via counterNum (.28)', s.auth_successes === 9001);
check('ruckus: SSID auth_failures via counterNum (.29)', s.auth_failures === 17);

// Rogues: integer index, MAC in value column .1; RSSI dBm from .11;
// classification always 'unclassified'; empty-MAC row skipped.
const rogues = ruckus.parseRogueAps({
  rogueMac: [
    { oid: `${ROGUE_BASE}.1.7`, value: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]) },
    { oid: `${ROGUE_BASE}.1.8`, value: Buffer.alloc(0) }, // empty MAC column → row skipped
  ],
  rogueSsid: [
    { oid: `${ROGUE_BASE}.2.7`, value: 'FreeWiFi' },
    { oid: `${ROGUE_BASE}.2.8`, value: 'Ghost' },
  ],
  rogueChannel: [{ oid: `${ROGUE_BASE}.4.7`, value: 6 }],
  rogueType: [{ oid: `${ROGUE_BASE}.6.7`, value: 0 }], // ap(0) — device type, not threat class
  rogueRssi: [{ oid: `${ROGUE_BASE}.11.7`, value: -61 }],
});
console.log(JSON.stringify(rogues, null, 2));
const rg = rogues[0] || {};
check('rogue: one row parsed (empty-MAC row skipped)', rogues.length === 1);
check('rogue: bssid from value column .1', rg.bssid === 'de:ad:be:ef:00:01');
check('rogue: ssid', rg.ssid === 'FreeWiFi');
check('rogue: channel', rg.channel === 6);
check('rogue: rssi_dbm from .11', rg.rssi_dbm === -61);
check('rogue: classification always unclassified', rg.classification === 'unclassified');
check('rogue: detecting_ap null (no column)', rg.detecting_ap === null);

// ── Fortinet ─────────────────────────────────────────────────────────────────
const FGT_BASE = '1.3.6.1.4.1.12356.101.14.4.4.1';
// INDEX = vdom(1) + length-prefixed WtpId: "FAP231F" → 1.7.70.65.80.50.51.49.70
const FGT_IDX = '1.7.70.65.80.50.51.49.70';
const FGT_IDX2 = '1.4.65.80.45.50'; // "AP-2"
const fgtAps = fortinet.parseApTable({
  wtpIp: [{ oid: `${FGT_BASE}.5.${FGT_IDX}`, value: '10.9.8.7' }],
  wtpState: [
    { oid: `${FGT_BASE}.7.${FGT_IDX}`, value: 2 },  // onLine(2) → online
    { oid: `${FGT_BASE}.7.${FGT_IDX2}`, value: 1 }, // offLine(1) → offline
  ],
  wtpStations: [{ oid: `${FGT_BASE}.17.${FGT_IDX}`, value: 13 }],
});
console.log(JSON.stringify(fgtAps, null, 2));
const fgtByIdx = {};
for (const a of fgtAps) fgtByIdx[a._index] = a;
check('fortinet: two APs parsed', fgtAps.length === 2);
check('fortinet: name decoded from length-prefixed index', fgtByIdx[FGT_IDX] && fgtByIdx[FGT_IDX].name === 'FAP231F');
check('fortinet: second name decoded', fgtByIdx[FGT_IDX2] && fgtByIdx[FGT_IDX2].name === 'AP-2');
check('fortinet: onLine(2) → online', fgtByIdx[FGT_IDX] && fgtByIdx[FGT_IDX].status === 'online');
check('fortinet: offLine(1) → offline', fgtByIdx[FGT_IDX2] && fgtByIdx[FGT_IDX2].status === 'offline');
check('fortinet: ip from .5', fgtByIdx[FGT_IDX] && fgtByIdx[FGT_IDX].ip_address === '10.9.8.7');
check('fortinet: clients from .17', fgtByIdx[FGT_IDX] && fgtByIdx[FGT_IDX].clients_total === 13);

// ── MikroTik ─────────────────────────────────────────────────────────────────
const MT_AP = '1.3.6.1.4.1.14988.1.1.1.3.1';
const MT_RTAB = '1.3.6.1.4.1.14988.1.1.1.2.1';
const mtAps = mikrotik.parseApTable({
  apSsid: [{ oid: `${MT_AP}.4.2`, value: 'HomeNet' }],
  apFreq: [{ oid: `${MT_AP}.7.2`, value: 5180 }],
  apClientCount: [{ oid: `${MT_AP}.6.2`, value: 9 }],
  apNoiseFloor: [{ oid: `${MT_AP}.9.2`, value: -110 }],
  // Registration rows: INDEX = 6 MAC octets + iface; iface = last component.
  rtabStrength: [
    { oid: `${MT_RTAB}.3.170.187.204.221.238.255.2`, value: -55 },
    { oid: `${MT_RTAB}.3.170.187.204.221.238.1.2`, value: -60 },
    { oid: `${MT_RTAB}.3.1.2.3.4.5.6.3`, value: -70 },
  ],
});
console.log(JSON.stringify(mtAps, null, 2));
const mt = mtAps[0] || {};
check('mikrotik: one AP (interface) parsed', mtAps.length === 1);
check('mikrotik: ssid from .4 in name', mt.name === 'MikroTik HomeNet (2)');
check('mikrotik: clients from .6 (5g band via freq)', mt.clients_5g === 9 && mt.clients_total === 9);
check('mikrotik: noise floor from .9 on 5g', mt.noise_floor_5g === -110);
check('mikrotik: channel left null (freq not misused)', mt.radio_5g_channel === null && mt.radio_2g_channel === null);
const mtCounts = mikrotik.parseClientCounts({
  rtabStrength: [
    { oid: `${MT_RTAB}.3.170.187.204.221.238.255.2`, value: -55 },
    { oid: `${MT_RTAB}.3.170.187.204.221.238.1.2`, value: -60 },
    { oid: `${MT_RTAB}.3.1.2.3.4.5.6.3`, value: -70 },
  ],
});
console.log(JSON.stringify(mtCounts));
const mtByKey = {};
for (const r of mtCounts) mtByKey[r.apKey] = r.clients;
check('mikrotik: grouped by index tail (iface 2 → 2 clients)', mtByKey['2'] === 2);
check('mikrotik: grouped by index tail (iface 3 → 1 client)', mtByKey['3'] === 1);

// ── Results ──────────────────────────────────────────────────────────────────
let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) fail++;
}
console.log(`\n${checks.length - fail}/${checks.length} passed`);
process.exit(fail ? 1 : 0);

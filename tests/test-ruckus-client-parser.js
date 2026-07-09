'use strict';
// Offline check of the CORRECTED Ruckus (ZoneDirector) CLIENT parser with
// synthetic walked data on the MIB-verified ruckusZDWLANStaTable OIDs:
//   Base 1.3.6.1.4.1.25053.1.2.2.1.1.3.1.1 (INDEX = client MAC, 6 octets)
// This table replaces the old (wrong) base ...1.1.2.3.1, which was actually
// ruckusZDWLANVapTable (a per-VAP/per-SSID byte-counter aggregate, not a
// per-client table) — see collector/wireless/clients/ruckus.js's header.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ruckusClients = require(path.join(ROOT, 'collector/wireless/clients/ruckus.js'));
const { counterNum } = require(path.join(ROOT, 'collector/wireless/_util.js'));

function c64(n) { // encode a number as an 8-byte BE buffer like net-snmp Counter64
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

const checks = [];
function check(name, ok) { checks.push([name, ok]); }

const TABLE = '1.3.6.1.4.1.25053.1.2.2.1.1.3.1.1';

// Client 1: aa:bb:cc:dd:ee:ff, resolved via AP MAC (.2), radio11b(1) -> 2.4GHz.
const MAC1 = '170.187.204.221.238.255';
const AP_MAC_BUF = Buffer.from([0x2c, 0x1c, 0xa8, 0x01, 0x02, 0x03]); // 2c:1c:a8:01:02:03
const BSSID1_BUF = Buffer.from([0x2c, 0x1c, 0xa8, 0x01, 0x02, 0x04]); // radio BSSID, deliberately NOT in apMap

// Client 2: 12:34:56:78:9a:bc, .2 unresolved (not in apMap) so correlation
// must fall back to .3 (BSSID) which DOES match a known AP; no RadioType
// given so band must be derived from channel (149 -> 5GHz).
const MAC2 = '18.52.86.120.154.188';
const UNKNOWN_AP_MAC_BUF = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x09]); // not in apMap
const BSSID2_BUF = AP_MAC_BUF; // matches the known AP via fallback

const staWalked = [
  // ── Client 1 ──────────────────────────────────────────────────────────
  { oid: `${TABLE}.2.${MAC1}`, value: AP_MAC_BUF },
  { oid: `${TABLE}.3.${MAC1}`, value: BSSID1_BUF },
  { oid: `${TABLE}.4.${MAC1}`, value: 'Corp-WiFi' },
  { oid: `${TABLE}.6.${MAC1}`, value: 1 },        // radio11b(1) -> 2.4GHz
  { oid: `${TABLE}.7.${MAC1}`, value: 6 },        // channel 6
  { oid: `${TABLE}.8.${MAC1}`, value: '10.1.2.3' },
  { oid: `${TABLE}.9.${MAC1}`, value: -999 },     // AvgRSSI decoy — must NOT be used for rssi_dbm
  { oid: `${TABLE}.15.${MAC1}`, value: 360000 },  // TimeTicks (1/100s) -> 3600s
  { oid: `${TABLE}.21.${MAC1}`, value: -888 },    // SNR decoy — must NOT be used for rssi_dbm
  { oid: `${TABLE}.80.${MAC1}`, value: 'wpa2-psk' },
  { oid: `${TABLE}.81.${MAC1}`, value: -58 },     // StaSignalStrength, UNITS dBm — the real rssi_dbm source

  // ── Client 2 ──────────────────────────────────────────────────────────
  { oid: `${TABLE}.2.${MAC2}`, value: UNKNOWN_AP_MAC_BUF },
  { oid: `${TABLE}.3.${MAC2}`, value: BSSID2_BUF },
  { oid: `${TABLE}.4.${MAC2}`, value: 'Guest-WiFi' },
  { oid: `${TABLE}.7.${MAC2}`, value: 149 },      // no RadioType row -> band from channel (5GHz)
  { oid: `${TABLE}.8.${MAC2}`, value: '10.1.2.4' },
  { oid: `${TABLE}.80.${MAC2}`, value: 'open' },
  { oid: `${TABLE}.81.${MAC2}`, value: -72 },
];

const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const rows = staWalked.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};

const apMap = {
  byMac: new Map([['2c:1c:a8:01:02:03', { id: 5, name: 'RuckusAP-Lobby' }]]),
  byName: new Map([['RuckusAP-Lobby', { id: 5, name: 'RuckusAP-Lobby' }]]),
};

(async () => {
  const clients = await ruckusClients.parseClients(fakeSession, apMap);
  console.log(JSON.stringify(clients, null, 2));

  const byMac = {};
  for (const c of clients) byMac[c.mac_address] = c;
  const c1 = byMac['aa:bb:cc:dd:ee:ff'] || {};
  const c2 = byMac['12:34:56:78:9a:bc'] || {};

  check('two clients parsed', clients.length === 2);

  // ── Client 1 ──────────────────────────────────────────────────────────
  check('client1: MAC decoded from index tail (colon-hex)', c1.mac_address === 'aa:bb:cc:dd:ee:ff');
  check('client1: ssid_name from .4 (corrected column)', c1.ssid_name === 'Corp-WiFi');
  check('client1: channel from .7 (corrected column)', c1.channel === 6);
  check('client1: ip_address from .8 (corrected column)', c1.ip_address === '10.1.2.3');
  check('client1: rssi_dbm from .81 SignalStrength, NOT .9 AvgRSSI or .21 SNR', c1.rssi_dbm === -58);
  check('client1: auth_type straight from .80 string (no enum lookup)', c1.auth_type === 'wpa2-psk');
  check('client1: band 2.4GHz via RadioType radio11b(1)', c1.band === '2.4GHz');
  check('client1: tx_rate_mbps null (no PHY-rate column in this table)', c1.tx_rate_mbps === null);
  check('client1: rx_rate_mbps null (no PHY-rate column in this table)', c1.rx_rate_mbps === null);
  check('client1: connected_since derived from TimeTicks .15 (~3600s ago)', (() => {
    if (!(c1.connected_since instanceof Date)) return false;
    const deltaSec = (Date.now() - c1.connected_since.getTime()) / 1000;
    return Math.abs(deltaSec - 3600) < 5;
  })());
  check('client1: AP correlation via .2 StaAPMacAddr resolves through apMap', c1.ap_id === 5 && c1.ap_name === 'RuckusAP-Lobby');

  // ── Client 2 ──────────────────────────────────────────────────────────
  check('client2: MAC decoded from index tail (colon-hex)', c2.mac_address === '12:34:56:78:9a:bc');
  check('client2: ssid_name', c2.ssid_name === 'Guest-WiFi');
  check('client2: band derived from channel 149 (5GHz) when RadioType absent', c2.band === '5GHz');
  check('client2: tx_rate_mbps null', c2.tx_rate_mbps === null);
  check('client2: rx_rate_mbps null', c2.rx_rate_mbps === null);
  check('client2: AP correlation falls back to .3 BSSID when .2 does not resolve', c2.ap_id === 5 && c2.ap_name === 'RuckusAP-Lobby');

  // ── Counter64 handling for .11/.13 (StaRxBytes/StaTxBytes) ──────────────
  // ruckus.js's client parser deliberately does NOT walk .11/.13 today
  // (emptyClient() has no rx_bytes/tx_bytes field), but confirm the shared
  // counterNum() helper it would use for them decodes an 8-byte BE Counter64
  // buffer correctly and never throws, so the file wouldn't crash if that
  // decoding is wired in later.
  const rxBuf = c64(9876543210);
  check('counterNum decodes an 8-byte BE Counter64 buffer (StaRxBytes shape)', counterNum(rxBuf) === 9876543210);
  const txBuf = c64(1234567890123);
  check('counterNum decodes a larger Counter64 buffer (StaTxBytes shape)', counterNum(txBuf) === 1234567890123);

  // ── Resilience: never throws even on a broken/empty session ─────────────
  const brokenSession = { subtree(_base, _maxReps, _feed, done) { throw new Error('boom'); } };
  let threw = false;
  let brokenResult = null;
  try {
    brokenResult = await ruckusClients.parseClients(brokenSession, apMap);
  } catch (e) {
    threw = true;
  }
  check('parseClients never throws (returns [] on failure)', threw === false && Array.isArray(brokenResult) && brokenResult.length === 0);

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} passed`);
  process.exit(fail ? 1 : 0);
})();

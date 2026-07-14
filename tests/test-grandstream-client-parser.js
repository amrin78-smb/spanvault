'use strict';
// Offline check of the Grandstream CLIENT parser (GRANDSTREAM-GWN-MIB
// gwnClientTable), OIDs verified against Grandstream's own published MIB
// source (GRANDSTREAM-GWN-MIB.my, recovered via the Wayback Machine after the
// vendor's live download URL 404'd, and cross-checked against Observium's
// mirrored copy of the same MIB — both agree exactly). No Grandstream GWN
// hardware in the lab; every column DESCRIPTION in the vendor's own MIB file
// is a blank placeholder, so a few column *semantics* (byte-counter
// direction, Tx/RxRate units) are convention-based inferences, not
// MIB-confirmed — see collector/wireless/clients/grandstream.js's header.
//
// gwnClientEntry — base 1.3.6.1.4.1.42397.1.1.3.3.1, INDEX = client MAC (6
// octets), so the client MAC comes from the OID index tail, never a column
// (same table shape as HPE's aiClientTable).
const path = require('path');
const ROOT = path.join(__dirname, '..');
const grandstreamClients = require(path.join(ROOT, 'collector/wireless/clients/grandstream.js'));

const checks = [];
function check(name, ok) { checks.push([name, ok]); }

const TABLE = '1.3.6.1.4.1.42397.1.1.3.3.1';

// Client 1: aa:bb:cc:11:22:33 -> decimal index 170.187.204.17.34.51.
// BSSID matches the known AP's MAC directly -> primary (BSSID) correlation.
const CMAC1 = '170.187.204.17.34.51';

// Client 2: 11:22:33:44:55:66 -> decimal index 17.34.51.68.85.102.
// No BSSID column at all -> must fall back to the "sole AP" correlation
// (Grandstream's AP-level parser represents the polled device as a single AP).
const CMAC2 = '17.34.51.68.85.102';

const AP_MAC = '1c:28:af:c1:a3:d6';

const clientWalked = [
  // ── Client 1 ──
  { oid: `${TABLE}.2.${CMAC1}`, value: '10.10.10.11' },  // gwnClienttIPAddress
  { oid: `${TABLE}.3.${CMAC1}`, value: Buffer.from([0x1c, 0x28, 0xaf, 0xc1, 0xa3, 0xd6]) }, // gwnClientWlanMACAddress (BSSID)
  { oid: `${TABLE}.4.${CMAC1}`, value: 'Corp-WiFi' },    // gwnClientESSID
  { oid: `${TABLE}.5.${CMAC1}`, value: -55 },            // gwnClientRSSI (dBm, used directly)
  { oid: `${TABLE}.6.${CMAC1}`, value: 360000 },         // gwnClientAssoctime (ticks -> 3600s)
  { oid: `${TABLE}.8.${CMAC1}`, value: 'johns-iphone' }, // gwnClientHostname
  { oid: `${TABLE}.10.${CMAC1}`, value: 866 },           // gwnClientTxRate (mbps, direct)
  { oid: `${TABLE}.12.${CMAC1}`, value: 123456 },        // gwnClientTxDataBytes (Counter32, plain int)
  { oid: `${TABLE}.13.${CMAC1}`, value: 400 },           // gwnClientRxRate (mbps, direct)
  { oid: `${TABLE}.15.${CMAC1}`, value: 789012 },        // gwnClientRxDataBytes (Counter32, plain int)

  // ── Client 2 ── (no BSSID row -> sole-AP fallback; byte counters as
  // 4-byte big-endian Buffers -> counterNum() decode path)
  { oid: `${TABLE}.2.${CMAC2}`, value: '10.10.10.22' },
  { oid: `${TABLE}.4.${CMAC2}`, value: 'Guest-WiFi' },
  { oid: `${TABLE}.5.${CMAC2}`, value: -70 },
  { oid: `${TABLE}.6.${CMAC2}`, value: 100 },            // 100 ticks -> 1s
  { oid: `${TABLE}.8.${CMAC2}`, value: 'android-42' },
  { oid: `${TABLE}.10.${CMAC2}`, value: 54 },
  { oid: `${TABLE}.12.${CMAC2}`, value: Buffer.from([0x00, 0x01, 0x5e, 0x86]) }, // 89734
  { oid: `${TABLE}.13.${CMAC2}`, value: 24 },
  { oid: `${TABLE}.15.${CMAC2}`, value: Buffer.from([0x00, 0x00, 0x27, 0x10]) }, // 10000
];

// Fake SNMP session: subtree(base, maxReps, feed, done) filtered from the flat
// varbind list — same {oid, value} shape the real walk() emits.
const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const rows = clientWalked.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};

const apMap = {
  byMac: new Map([[AP_MAC, { id: 7, name: 'Grandstream AP' }]]),
  byName: new Map([['Grandstream AP', { id: 7, name: 'Grandstream AP' }]]),
};

(async () => {
  const clients = await grandstreamClients.parseClients(fakeSession, apMap);
  console.log(JSON.stringify(clients, null, 2));

  const byMac = {};
  for (const c of clients) byMac[c.mac_address] = c;
  const c1 = byMac['aa:bb:cc:11:22:33'] || {};
  const c2 = byMac['11:22:33:44:55:66'] || {};

  const now = Date.now();

  check('two clients parsed', clients.length === 2);

  // ── Client 1 ──────────────────────────────────────────────────────────
  check('client1: MAC decoded from index tail (colon-hex)', c1.mac_address === 'aa:bb:cc:11:22:33');
  check('client1: ip_address from .2 gwnClienttIPAddress', c1.ip_address === '10.10.10.11');
  check('client1: ssid_name from .4 gwnClientESSID', c1.ssid_name === 'Corp-WiFi');
  check('client1: hostname from .8 gwnClientHostname', c1.hostname === 'johns-iphone');
  check('client1: rssi_dbm used directly (named RSSI, not SNR)', c1.rssi_dbm === -55);
  check('client1: tx_rate_mbps = 866 direct (no scaling)', c1.tx_rate_mbps === 866);
  check('client1: rx_rate_mbps = 400 direct (no scaling)', c1.rx_rate_mbps === 400);
  check('client1: connected_since ~3600s ago (TimeTicks .6 / 100)', (() => {
    if (!(c1.connected_since instanceof Date)) return false;
    const deltaSec = (now - c1.connected_since.getTime()) / 1000;
    return Math.abs(deltaSec - 3600) < 5;
  })());
  check('client1: AP resolved via BSSID (.3) against apMap.byMac', c1.ap_id === 7 && c1.ap_name === 'Grandstream AP');
  check('client1: tx_bytes = 123456 (gwnClientTxDataBytes, plain int)', c1.tx_bytes === 123456);
  check('client1: rx_bytes = 789012 (gwnClientRxDataBytes, plain int)', c1.rx_bytes === 789012);
  check('client1: byte_counter_bits === 32 (Counter32, not Counter64)', c1.byte_counter_bits === 32);
  check('client1: channel/band/auth_type/phy_mode/vlan_id all null (no OIDs in this table)',
    c1.channel === null && c1.band === null && c1.auth_type === null && c1.phy_mode === null && c1.vlan_id === null);

  // ── Client 2 ──────────────────────────────────────────────────────────
  check('client2: MAC decoded from index tail', c2.mac_address === '11:22:33:44:55:66');
  check('client2: ip_address', c2.ip_address === '10.10.10.22');
  check('client2: ssid_name', c2.ssid_name === 'Guest-WiFi');
  check('client2: hostname', c2.hostname === 'android-42');
  check('client2: rssi_dbm used directly', c2.rssi_dbm === -70);
  check('client2: connected_since ~1s ago', (() => {
    if (!(c2.connected_since instanceof Date)) return false;
    const deltaSec = (now - c2.connected_since.getTime()) / 1000;
    return Math.abs(deltaSec - 1) < 5;
  })());
  check('client2: AP correlation falls back to the sole AP (no BSSID row at all)', c2.ap_id === 7 && c2.ap_name === 'Grandstream AP');
  check('client2: tx_bytes = 89734 decoded from a 4-byte Buffer (counterNum)', c2.tx_bytes === 89734);
  check('client2: rx_bytes = 10000 decoded from a 4-byte Buffer (counterNum)', c2.rx_bytes === 10000);
  check('client2: byte_counter_bits === 32', c2.byte_counter_bits === 32);

  // ── Resilience: never throws even on a broken/empty session ─────────────
  const brokenSession = { subtree(_base, _maxReps, _feed, done) { throw new Error('boom'); } };
  let threw = false;
  let brokenResult = null;
  try {
    brokenResult = await grandstreamClients.parseClients(brokenSession, apMap);
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

'use strict';
// Offline check of the new Fortinet (FortiGate wireless controller) CLIENT
// parser with synthetic walked data on the MIB-verified fgWcStaTable OIDs:
//   Base 1.3.6.1.4.1.12356.101.14.5.1 (fgWc.5.1 = fgWcStaEntry)
//   INDEX = { fgVdEntIndex, ifIndex, fgWcStaMacAddress } -> OID index tail
//   shape "<vdom>.<ifIndex>.<macLen=6>.<mac octet 1..6>" (PhysAddress
//   SIZE(6|8) is not IMPLIED, so it carries an explicit length-prefix sub-id)
// See collector/wireless/clients/fortinet.js's header for the two
// independent raw-MIB-text sources this table/OID set was verified against.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fortinetClients = require(path.join(ROOT, 'collector/wireless/clients/fortinet.js'));

const checks = [];
function check(name, ok) { checks.push([name, ok]); }

const TABLE = '1.3.6.1.4.1.12356.101.14.5.1';

// Client 1: aa:bb:cc:dd:ee:ff — vdom 1, ifIndex 5, resolves AP via fgWcStaWtpId
// matching a known apMap.byName entry. IPv4 InetAddress (.6/.7), radioType
// dot11ac(6) -> 5GHz / "802.11ac", security wpa2OnlyEnterprise(8) -> 'wpa2-enterprise'.
const IDX1 = '1.5.6.170.187.204.221.238.255'; // aa.bb.cc.dd.ee.ff in decimal
const IP1 = Buffer.from([10, 1, 2, 3]);

// Client 2: 12:34:56:78:9a:bc — vdom 1, ifIndex 7, fgWcStaWtpId does NOT match
// any known AP (so ap_id stays null but ap_name surfaces the raw WTP id).
// No vlan/ip/host/security/radioType rows at all — every optional field must
// fall back to null (or, for band, the channel-based heuristic).
const IDX2 = '1.7.6.18.52.86.120.154.188'; // 12.34.56.78.9a.bc in decimal

// Client 3: 00:11:22:33:44:55 — explicitly marked OFFLINE (fgWcStaOnline =
// no(2)). Must be filtered out of the result entirely, even though every
// other column is present and well-formed.
const IDX3 = '1.9.6.0.17.34.51.68.85';

const staWalked = [
  // ── Client 1 ──────────────────────────────────────────────────────────
  { oid: `${TABLE}.2.${IDX1}`, value: 'Corp-WiFi' },       // fgWcStaWlan -> ssid_name
  { oid: `${TABLE}.3.${IDX1}`, value: 'AP-Lobby' },        // fgWcStaWtpId -> AP correlation
  { oid: `${TABLE}.5.${IDX1}`, value: 20 },                // fgWcStaVlanId
  { oid: `${TABLE}.6.${IDX1}`, value: 1 },                 // fgWcStaIpAddressType: ipv4(1)
  { oid: `${TABLE}.7.${IDX1}`, value: IP1 },                // fgWcStaIpAddress
  { oid: `${TABLE}.9.${IDX1}`, value: 'johns-iphone' },    // fgWcStaHost -> hostname
  { oid: `${TABLE}.12.${IDX1}`, value: -55 },               // fgWcStaSignal -> rssi_dbm
  { oid: `${TABLE}.14.${IDX1}`, value: 999 },               // fgWcStaIdle — decoy, must NOT become connected_since
  { oid: `${TABLE}.15.${IDX1}`, value: 12000 },             // fgWcStaBandwidthTx (kbps gauge) — decoy, must NOT become tx_bytes
  { oid: `${TABLE}.16.${IDX1}`, value: 45000 },             // fgWcStaBandwidthRx (kbps gauge) — decoy, must NOT become rx_bytes
  { oid: `${TABLE}.17.${IDX1}`, value: 36 },                // fgWcStaChannel
  { oid: `${TABLE}.18.${IDX1}`, value: 6 },                 // fgWcStaRadioType: dot11ac(6) -> 5GHz
  { oid: `${TABLE}.19.${IDX1}`, value: 8 },                 // fgWcStaSecurity: wpa2OnlyEnterprise(8)
  { oid: `${TABLE}.21.${IDX1}`, value: 1 },                 // fgWcStaOnline: yes(1)

  // ── Client 2 ──────────────────────────────────────────────────────────
  { oid: `${TABLE}.2.${IDX2}`, value: 'Guest-WiFi' },
  { oid: `${TABLE}.3.${IDX2}`, value: 'AP-Unresolved' }, // not in apMap
  { oid: `${TABLE}.17.${IDX2}`, value: 6 },              // channel 6 -> band fallback = 2.4GHz (no radioType row)
  { oid: `${TABLE}.21.${IDX2}`, value: 1 },              // online yes(1)

  // ── Client 3 (offline — must be excluded) ────────────────────────────
  { oid: `${TABLE}.2.${IDX3}`, value: 'Corp-WiFi' },
  { oid: `${TABLE}.3.${IDX3}`, value: 'AP-Lobby' },
  { oid: `${TABLE}.12.${IDX3}`, value: -40 },
  { oid: `${TABLE}.17.${IDX3}`, value: 1 },
  { oid: `${TABLE}.21.${IDX3}`, value: 2 },              // fgWcStaOnline: no(2) -> excluded
];

const fakeSession = {
  subtree(base, _maxReps, feed, done) {
    const rows = staWalked.filter((v) => v.oid.startsWith(base + '.'));
    if (rows.length) feed(rows);
    done();
  },
};

const apMap = {
  byName: new Map([['AP-Lobby', { id: 5, name: 'AP-Lobby' }]]),
  byMac: new Map(), // Fortinet's AP-level parser never populates mac_address — always empty
};

(async () => {
  const clients = await fortinetClients.parseClients(fakeSession, apMap);
  console.log(JSON.stringify(clients, null, 2));

  const byMac = {};
  for (const c of clients) byMac[c.mac_address] = c;
  const c1 = byMac['aa:bb:cc:dd:ee:ff'] || {};
  const c2 = byMac['12:34:56:78:9a:bc'] || {};

  check('two clients parsed (offline client excluded)', clients.length === 2);
  check('offline client (fgWcStaOnline=no) is excluded entirely', !byMac['00:11:22:33:44:55']);

  // ── Client 1 ──────────────────────────────────────────────────────────
  check('client1: MAC decoded from length-prefixed index tail', c1.mac_address === 'aa:bb:cc:dd:ee:ff');
  check('client1: ssid_name from fgWcStaWlan (.2)', c1.ssid_name === 'Corp-WiFi');
  check('client1: hostname from fgWcStaHost (.9)', c1.hostname === 'johns-iphone');
  check('client1: vlan_id from fgWcStaVlanId (.5)', c1.vlan_id === 20);
  check('client1: ip_address decoded from InetAddress (.6 type=ipv4 + .7 buffer)', c1.ip_address === '10.1.2.3');
  check('client1: rssi_dbm from fgWcStaSignal (.12)', c1.rssi_dbm === -55);
  check('client1: channel from fgWcStaChannel (.17)', c1.channel === 36);
  check('client1: band 5GHz via RadioType dot11ac(6)', c1.band === '5GHz');
  check('client1: phy_mode "802.11ac" via RadioType dot11ac(6)', c1.phy_mode === '802.11ac');
  check('client1: auth_type "wpa2-enterprise" via Security wpa2OnlyEnterprise(8)', c1.auth_type === 'wpa2-enterprise');
  check('client1: AP correlation via fgWcStaWtpId -> apMap.byName', c1.ap_id === 5 && c1.ap_name === 'AP-Lobby');
  check('client1: connected_since stays null (fgWcStaIdle is inactive-time, not uptime)', c1.connected_since === null);
  check('client1: tx_rate_mbps/rx_rate_mbps stay null (BandwidthTx/Rx are kbps gauges, not PHY rate)',
    c1.tx_rate_mbps === null && c1.rx_rate_mbps === null);
  check('client1: rx_bytes/tx_bytes/byte_counter_bits stay null (no cumulative counter in this table)',
    c1.rx_bytes === null && c1.tx_bytes === null && c1.byte_counter_bits === null);

  // ── Client 2 ──────────────────────────────────────────────────────────
  check('client2: MAC decoded from length-prefixed index tail', c2.mac_address === '12:34:56:78:9a:bc');
  check('client2: ssid_name', c2.ssid_name === 'Guest-WiFi');
  check('client2: band derived from channel 6 (2.4GHz) when RadioType absent', c2.band === '2.4GHz');
  check('client2: phy_mode null when RadioType absent', c2.phy_mode === null);
  check('client2: vlan_id null when .5 row absent', c2.vlan_id === null);
  check('client2: ip_address null when .6/.7 rows absent', c2.ip_address === null);
  check('client2: hostname null when .9 row absent', c2.hostname === null);
  check('client2: auth_type null when .19 row absent (not "other")', c2.auth_type === null);
  check('client2: AP correlation falls back to raw WTP id when unresolved in apMap',
    c2.ap_id === null && c2.ap_name === 'AP-Unresolved');

  // ── Resilience: never throws even on a broken/empty session ─────────────
  const brokenSession = { subtree(_base, _maxReps, _feed, done) { throw new Error('boom'); } };
  let threw = false;
  let brokenResult = null;
  try {
    brokenResult = await fortinetClients.parseClients(brokenSession, apMap);
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

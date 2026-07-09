'use strict';
// Offline check of the Aruba rogue/neighboring-AP parser (parseRogueAps) with
// synthetic walked data mirroring the live wlsxMonAPInfoTable format confirmed
// this session on SMT_WLC (Aruba 7205/AOS 8.10) and TUFS-OKF-WLC-1 (Aruba
// 9106/AOS 8.13): 13-component index = detecting-AP MAC(6) + radioNumber(1) +
// monitored/rogue BSSID(6). classification values 1/2/3/7 were observed live;
// this test additionally exercises 4/5/6 (not seen live, but documented in
// ARUBA-TC.txt) so the full enum mapping is covered.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const aruba = require(path.join(ROOT, 'collector/wireless/aruba.js'));

const ROGUE_BASE = '1.3.6.1.4.1.14823.2.2.1.6.7.1.1.1';
const monAPInfoChannel = ROGUE_BASE + '.2';
const monAPInfoClassification = ROGUE_BASE + '.3';
const monAPInfoESSID = ROGUE_BASE + '.4';
const monAPInfoRSSI = ROGUE_BASE + '.5';

// Detector A = 1c:28:af:c1:a3:d6 — the same MAC used as the AP fixture in
// test-aruba-parser.js (captured from a real controller's AP table).
const DETECTOR_A = '1c:28:af:c1:a3:d6';
// Detector B = 20:9c:b4:c4:62:5e — a second real detecting-AP MAC, used only
// for the dedup (same rogue BSSID heard by two APs) check below.
const DETECTOR_B = '20:9c:b4:c4:62:5e';

function macToDec(mac) {
  return mac.split(':').map((h) => parseInt(h, 16)).join('.');
}
function idx13(detectorMac, radioNum, bssidMac) {
  return `${macToDec(detectorMac)}.${radioNum}.${macToDec(bssidMac)}`;
}

// Rogue BSSIDs used across the fixture rows.
const BSSID_INTERFERING = '00:0e:a0:0f:2d:3f'; // classification 2
const BSSID_FRIENDLY = '1c:28:af:9a:3d:70';    // classification 1, also the dedup target
const BSSID_UNSECURE = '02:0e:a0:0f:2d:3f';    // classification 3
const BSSID_DOS = '02:0e:a0:0f:2d:40';         // classification 4
const BSSID_UNKNOWN = '02:0e:a0:0f:2d:41';     // classification 5
const BSSID_KNOWN_INTERFERING = '02:0e:a0:0f:2d:42'; // classification 6
const BSSID_SUSPECTED_UNSECURE = '02:0e:a0:0f:2d:43'; // classification 7

const idxInterfering = idx13(DETECTOR_A, 1, BSSID_INTERFERING);
const idxFriendly = idx13(DETECTOR_A, 1, BSSID_FRIENDLY);
const idxFriendlyDup = idx13(DETECTOR_B, 1, BSSID_FRIENDLY); // same rogue BSSID, different detector
const idxUnsecure = idx13(DETECTOR_A, 1, BSSID_UNSECURE);
const idxDos = idx13(DETECTOR_A, 1, BSSID_DOS);
const idxUnknown = idx13(DETECTOR_A, 1, BSSID_UNKNOWN);
const idxKnownInterfering = idx13(DETECTOR_A, 1, BSSID_KNOWN_INTERFERING);
const idxSuspectedUnsecure = idx13(DETECTOR_A, 1, BSSID_SUSPECTED_UNSECURE);

// idxFriendly is listed BEFORE idxFriendlyDup in every column array below, so
// parseRogueAps' "first-seen wins" dedup must keep detector A / channel 108 /
// ssid "TU-Guest" and discard detector B's duplicate row for the same BSSID.
const walked = {
  rogueChannel: [
    { oid: `${monAPInfoChannel}.${idxInterfering}`, value: 149 },
    { oid: `${monAPInfoChannel}.${idxFriendly}`, value: 108 },
    { oid: `${monAPInfoChannel}.${idxFriendlyDup}`, value: 112 },
    { oid: `${monAPInfoChannel}.${idxUnsecure}`, value: 149 },
    { oid: `${monAPInfoChannel}.${idxDos}`, value: 149 },
    { oid: `${monAPInfoChannel}.${idxUnknown}`, value: 1 },
    { oid: `${monAPInfoChannel}.${idxKnownInterfering}`, value: 6 },
    { oid: `${monAPInfoChannel}.${idxSuspectedUnsecure}`, value: 149 },
  ],
  rogueClassification: [
    { oid: `${monAPInfoClassification}.${idxInterfering}`, value: 2 },
    { oid: `${monAPInfoClassification}.${idxFriendly}`, value: 1 },
    { oid: `${monAPInfoClassification}.${idxFriendlyDup}`, value: 1 },
    { oid: `${monAPInfoClassification}.${idxUnsecure}`, value: 3 },
    { oid: `${monAPInfoClassification}.${idxDos}`, value: 4 },
    { oid: `${monAPInfoClassification}.${idxUnknown}`, value: 5 },
    { oid: `${monAPInfoClassification}.${idxKnownInterfering}`, value: 6 },
    { oid: `${monAPInfoClassification}.${idxSuspectedUnsecure}`, value: 7 },
  ],
  rogueSsid: [
    { oid: `${monAPInfoESSID}.${idxInterfering}`, value: 'WHE_AP_5G_0F2D40' },
    { oid: `${monAPInfoESSID}.${idxFriendly}`, value: 'TU-Guest' },
    { oid: `${monAPInfoESSID}.${idxFriendlyDup}`, value: 'TU-Guest-dup' },
    { oid: `${monAPInfoESSID}.${idxUnsecure}`, value: 'Free-Evil-3' },
    { oid: `${monAPInfoESSID}.${idxDos}`, value: 'Free-Evil-4' },
    { oid: `${monAPInfoESSID}.${idxUnknown}`, value: 'Unknown-SSID' },
    { oid: `${monAPInfoESSID}.${idxKnownInterfering}`, value: 'Known-Interferer' },
    { oid: `${monAPInfoESSID}.${idxSuspectedUnsecure}`, value: 'Suspected-Evil' },
  ],
  rogueRssi: [
    { oid: `${monAPInfoRSSI}.${idxInterfering}`, value: 3 },     // SNR 3 -> -92 dBm
    { oid: `${monAPInfoRSSI}.${idxFriendly}`, value: 27 },       // SNR 27 -> -68 dBm
    { oid: `${monAPInfoRSSI}.${idxFriendlyDup}`, value: 50 },
    { oid: `${monAPInfoRSSI}.${idxUnsecure}`, value: 10 },
    { oid: `${monAPInfoRSSI}.${idxDos}`, value: 10 },
    { oid: `${monAPInfoRSSI}.${idxUnknown}`, value: -40 },       // already-negative dBm, kept as-is
    { oid: `${monAPInfoRSSI}.${idxKnownInterfering}`, value: 15 },
    { oid: `${monAPInfoRSSI}.${idxSuspectedUnsecure}`, value: 20 },
  ],
};

(async () => {
  const rogues = aruba.parseRogueAps(walked);
  console.log(JSON.stringify(rogues, null, 2));

  const byBssid = new Map(rogues.map((r) => [r.bssid, r]));
  const interfering = byBssid.get(BSSID_INTERFERING) || {};
  const friendly = byBssid.get(BSSID_FRIENDLY) || {};
  const unsecure = byBssid.get(BSSID_UNSECURE) || {};
  const dos = byBssid.get(BSSID_DOS) || {};
  const unknown = byBssid.get(BSSID_UNKNOWN) || {};
  const knownInterfering = byBssid.get(BSSID_KNOWN_INTERFERING) || {};
  const suspectedUnsecure = byBssid.get(BSSID_SUSPECTED_UNSECURE) || {};

  const checks = [
    // Dedup collapses the two idxFriendly*/idxFriendlyDup rows into one row per
    // rogueBssid, so 7 distinct rogue BSSIDs -> 7 output rows, not 8.
    ['7 distinct rogue rows (dedup collapsed the duplicate BSSID)', rogues.length === 7],

    // Index split is NOT swapped: bssid must be the trailing 6 octets, and
    // detecting_ap the leading 6 octets — never the reverse.
    ['bssid split correctly (not swapped with detector)', interfering.bssid === BSSID_INTERFERING],
    ['detecting_ap split correctly (not swapped with bssid)', interfering.detecting_ap === DETECTOR_A],

    // Classification enum, all 7 ArubaRogueApType values.
    ['classification 1 (valid) -> friendly', friendly.classification === 'friendly'],
    ['classification 2 (interfering) -> interfering', interfering.classification === 'interfering'],
    ['classification 3 (unsecure) -> malicious', unsecure.classification === 'malicious'],
    ['classification 4 (dos) -> malicious', dos.classification === 'malicious'],
    ['classification 5 (unknown) -> unclassified', unknown.classification === 'unclassified'],
    ['classification 6 (knownInterfering) -> interfering', knownInterfering.classification === 'interfering'],
    ['classification 7 (suspectedUnsecure) -> malicious', suspectedUnsecure.classification === 'malicious'],

    // SSID / channel pass through unchanged.
    ['ssid mapped', interfering.ssid === 'WHE_AP_5G_0F2D40' && friendly.ssid === 'TU-Guest'],
    ['channel mapped', interfering.channel === 149 && friendly.channel === 108],

    // RSSI/SNR -> dBm conversion (same rule as clients/aruba.js: sig>0 ? sig-95 : sig).
    ['rssi_dbm = 3-95 = -92 (positive SNR converted)', interfering.rssi_dbm === -92],
    ['rssi_dbm = 27-95 = -68 (positive SNR converted)', friendly.rssi_dbm === -68],
    ['rssi_dbm = -40 kept as-is (already negative)', unknown.rssi_dbm === -40],

    // Dedup: two rows with the same rogue BSSID but different detecting APs
    // must not crash, and the FIRST-seen row (detector A) wins.
    ['dedup keeps first-seen detecting_ap (A, not B)', friendly.detecting_ap === DETECTOR_A],
    ['dedup keeps first-seen channel (108, not the dup\'s 112)', friendly.channel === 108],
    ['dedup keeps first-seen ssid ("TU-Guest", not the dup\'s)', friendly.ssid === 'TU-Guest'],
  ];

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  process.exit(fail ? 1 : 0);
})();

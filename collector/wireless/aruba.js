'use strict';

// Aruba mobility controller (ArubaOS 6/8) wireless parser.
// OIDs verified against WLSX-WLAN-MIB (LibreNMS MIB source + oidref.com).
//
// Tables (all under the Aruba enterprise prefix 1.3.6.1.4.1.14823):
//   • wlsxWlanAPTable     ...5.2.1.4.1  — one row per AP, indexed by AP MAC
//     (6-octet PhysAddress → 6 dotted sub-identifiers).
//   • wlsxWlanRadioTable  ...5.2.1.5.1  — one row per AP+radio, indexed by
//     AP MAC + radioNumber (7 sub-identifiers). Holds channel, utilization,
//     and per-radio associated clients. The radio NUMBER (1/2) is NOT a fixed
//     band, so band is derived from the reported channel number.
//   • wlsxWlanESSIDTable  ...5.2.1.8.1  — one row per SSID, indexed by the
//     (string-encoded) SSID name. Holds the SSID name + station count.
//   • wlsxWlanAPChStatsTable    ...5.3.1.6.1 — per AP+radio channel stats
//     (noise floor, frame retry rate). Same AP MAC + radioNumber index as the
//     radio table. Live-verified on Aruba 7205 / AOS 8.10.0.8 and 9106 / 8.13.2.2.
//   • wlsxWlanAPRadioStatsTable ...5.3.1.9.1 — per AP+radio cumulative rx/tx
//     byte counters (Counter64), summed per AP for throughput derivation.
//
// NOT available on a mobility controller (left null, never faked):
//   • per-SSID byte counters and auth success/failure counters
//
// Live-verified 2026-07-09 against SMT_WLC (Aruba 7205 / AOS 8.10.0.8) and
// TUFS-OKF-WLC-1 (Aruba 9106 / AOS 8.13.2.2) via a direct SNMP walk (net-snmp,
// timeout 4000ms/retries 1) + a full-row dump per table to confirm exact
// column numbering. This newly wires up tx_power_2g/5g, serial_number,
// firmware_version, and rx_errors_2g/5g / tx_errors_2g/5g — see the OID
// comments below (radio, AP, channel-stats, radio-stats tables) for the
// live values and scaling that were confirmed for each.

const {
  num, counterNum, str, columnMap, bandForChannel, emptyAp, splitRadioIndex,
} = require('./_util');

// ── AP table (wlsxWlanAPTable) — base ...5.2.1.4.1, index = AP MAC (6 octets) ─
const AP_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.4.1';
const wlanAPIpAddress = AP_BASE + '.2';  // wlanAPIpAddress
const wlanAPName = AP_BASE + '.3';        // wlanAPName
const wlanAPUpTime = AP_BASE + '.12';     // wlanAPUpTime (TimeTicks, 1/100 s)
const wlanAPModelName = AP_BASE + '.13';  // wlanAPModelName (readable model string)
const wlanAPStatus = AP_BASE + '.19';     // wlanAPStatus: up(1) / down(2)
// wlanAPSerialNumber / wlanAPSwVersion — live-verified on both controllers:
// serials are short alphanumeric strings (e.g. "CNLBKPPCL7", "CNPWLBMF0S",
// matching Aruba's real serial format) and sw versions read "8.10.0.8" /
// "8.13.2.2", matching this same controller's own firmware_version column
// (wireless_controllers.firmware_version, minus the " LSR" build suffix).
// wlanAPHwVersion (.33, e.g. "A1.0") was also checked for context but there is
// no schema column for it, so it is not wired in.
const wlanAPSerialNumber = AP_BASE + '.6';  // wlanAPSerialNumber
const wlanAPSwVersion = AP_BASE + '.34';    // wlanAPSwVersion
// wlanAPNumBootstraps (.20) / wlanAPNumReboots (.21) — cumulative lifetime
// counters (Integer32, per WLSX-WLAN-MIB: "Number of times the AP has
// bootstrapped with the controller" / "...has rebooted"), NOT deltas. Live-
// verified on SMT_WLC (AOS 8.10.0.8): reboots ranged 0-28822 across 111 APs
// (one outlier AP at 28822 with a normal ~2212h uptime — plausible as a
// long-lived historical total, not a current flapping signal) and on
// TUFS-OKF-WLC-1 (AOS 8.13.2.2): reboots ranged 0-66 across 98 APs, a fully
// plausible range. Surfaced as an informational AP-stability signal only —
// not wired into any alert threshold, since a "high" absolute value's
// plausibility varies a lot by AP age/history.
const wlanAPNumBootstraps = AP_BASE + '.20'; // wlanAPNumBootstraps
const wlanAPNumReboots = AP_BASE + '.21';    // wlanAPNumReboots

// ── Radio table (wlsxWlanRadioTable) — base ...5.2.1.5.1 ─────────────────────
// Index = AP MAC (6 octets) + radioNumber. Band is derived from the channel.
const RADIO_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.5.1';
const wlanAPRadioChannel = RADIO_BASE + '.3';               // wlanAPRadioChannel
const wlanAPRadioUtilization = RADIO_BASE + '.6';           // wlanAPRadioUtilization (%)
const wlanAPRadioNumAssociatedClients = RADIO_BASE + '.7';  // wlanAPRadioNumAssociatedClients
// wlanAPRadioTransmitPower10x (.17) — live-verified on both controllers as
// dBm x10 (e.g. raw 180/60/90/150/120 -> 18.0/6.0/9.0/15.0/12.0 dBm, all in a
// sane 0-30 dBm range and landing on the 3dB steps Aruba ARM uses). The plain
// ".4" column (wlanAPRadioTransmitPower) was ALSO checked and is real data,
// but a simultaneous cross-poll showed ".4" is exactly HALF of ".17"/10 on
// every row (e.g. .4=36 vs .17/10=18) — i.e. ".4" needs its own undocumented
// x0.5 scaling that its name doesn't advertise, whereas ".17"'s "10x" suffix
// documents its scaling directly and checks out. Use ".17" / 10 as the source
// of truth; do not use ".4".
const wlanAPRadioTransmitPower10x = RADIO_BASE + '.17'; // wlanAPRadioTransmitPower10x (dBm x10)

// ── Channel stats table (wlsxWlanAPChStatsTable) — base ...5.3.1.6.1 ─────────
// Same AP MAC + radioNumber index as the radio table, so rows join 1:1.
// wlanAPChNoise is positive-encoded dBm: a value of 92 means −92 dBm (0 = not
// reported → null). wlanAPChFrameRetryRate is retry frames as a % (0–100) of
// the channel's total tx+rx. Both live-verified on AOS 8.10 and 8.13.
const CHSTATS_BASE = '1.3.6.1.4.1.14823.2.2.1.5.3.1.6.1';
const wlanAPChNoise = CHSTATS_BASE + '.9';           // wlanAPChNoise
const wlanAPChFrameRetryRate = CHSTATS_BASE + '.12'; // wlanAPChFrameRetryRate
// Channel airtime split (all INTEGER 0..100, % of time): .35 receiving, .36
// transmitting, .37 total busy. busy − rx − tx ≈ airtime consumed by OTHER
// devices on the channel = measured interference. (wlanAPChBusyRate .18 reads 0
// on AOS 8.x — do not use it.)
const wlanAPChRxUtilization = CHSTATS_BASE + '.35';  // wlanAPChRxUtilization
const wlanAPChTxUtilization = CHSTATS_BASE + '.36';  // wlanAPChTxUtilization
const wlanAPChUtilization = CHSTATS_BASE + '.37';    // wlanAPChUtilization (busy %)
// wlanAPChFCSErrorCount (.32) — used as the schema's rx_errors_2g/5g source.
// FCS decode failures are inherently RX-side (frames the AP receives but
// cannot validate), which is the standard/universal "receive errors" metric.
// Live-verified populated with large-but-in-range Counter32 values (< 2^32,
// non-negative) on both controllers; a simultaneous full-row dump confirmed
// it is byte-for-byte IDENTICAL to wlanAPChTotMacErrPkts (.8) on every row —
// this firmware evidently implements FCS-error tracking as the same counter
// as its MAC-error counter (semantically consistent: FCS failures are a
// MAC-layer decode failure). wlanAPChTotPhyErrPkts (.7) was also checked and
// is a genuinely distinct, populated counter, but .32/FCSErrorCount is kept
// as the single rx-error source per the "most standard receive-errors metric,
// don't sum multiple" rule — summing .7 in as well would double-count against
// .8-equivalent data with no clearer semantics. wlanAPChFailedCount (.23) was
// also checked and returns exactly 0 on every one of ~400 rows across both
// controllers with zero exceptions — not used, looks unimplemented on this
// firmware rather than a legitimately all-clear counter.
const wlanAPChFCSErrorCount = CHSTATS_BASE + '.32'; // wlanAPChFCSErrorCount

// ── Radio stats table (wlsxWlanAPRadioStatsTable) — base ...5.3.1.9.1 ────────
// Same AP MAC + radioNumber index. Cumulative Counter64 byte counters (net-snmp
// delivers them as 8-byte BE Buffers → counterNum). Summed across an AP's radios
// into ap.rx_bytes / ap.tx_bytes; the collector turns those into throughput bps.
const RADIOSTATS_BASE = '1.3.6.1.4.1.14823.2.2.1.5.3.1.9.1';
const wlanAPRadioRxBytes = RADIOSTATS_BASE + '.2';   // wlanAPRadioRxBytes (Counter64)
const wlanAPRadioTxBytes = RADIOSTATS_BASE + '.4';   // wlanAPRadioTxBytes (Counter64)
// wlanAPRadioTxErrorPkts (.6) — unambiguously TX-side, used as the schema's
// tx_errors_2g/5g source. Live-verified populated with sane, moderate
// (non-Counter64-scale) integer values on both controllers. A simultaneous
// full-row dump showed it is byte-for-byte identical to wlanAPRadioTxDroppedPkts
// (.5) on every row — this firmware tracks tx-dropped and tx-error as the same
// counter — so only .6 (the more precisely-named column) is wired in.
const wlanAPRadioTxErrorPkts = RADIOSTATS_BASE + '.6'; // wlanAPRadioTxErrorPkts

// ── ESSID summary table (wlsxWlanESSIDTable) — base ...5.2.1.8.1 ─────────────
// Index = the (length-prefixed) SSID name. wlanESSID's value is the name string.
// On some ArubaOS builds this controller-level summary is empty even when SSIDs
// are active, so parseSsids() falls back to the per-BSSID table below.
//
// wlanESSIDEncryptionType (column .5) — confirmed against the primary MIB
// source (WLSX-WLAN-MIB, wlsxWlanESSIDEntry ::= { wlsxWlanESSIDTable 1 },
// wlanESSIDEncryptionType ::= { wlsxWlanESSIDEntry 5 }) and its SYNTAX
// ArubaEncryptionMethods, defined in ARUBA-TC as a BITS textual convention:
//   disabled(0) static-wep(1) dynamic-wep(2) static-wpa(3) dynamic-wpa(4)
//   wpa2-psk-aes(5) wpa2-8021x-aes(6) wpa2PreAuth(7) xsec(8) wpa-psk-aes(9)
//   wpa-aes(10) wpa2-psk-tkip(11) wpa2-8021x-tkip(12) bSec-128(13)
//   bSec-256(14) owe-aes(16) wpa3-sae-aes(17) wpa3-cnsa(18)
//   wpa3-aes-ccm-128(19) mpsk-aes(21) wpa3-aes-gcm-256(22)
// Live-verified 2026-07-09 on SMT_WLC and TUFS-OKF-WLC-1: the column IS
// populated (12 and 9 rows respectively) even though wlanESSID's own VALUE
// walk (column .1) returns ZERO rows on both controllers — column .1 is
// declared MAX-ACCESS not-accessible in the MIB (it exists purely as the
// table INDEX), so this firmware never returns a walkable value for it,
// which is also why parseEssidSummary() below has always fallen through to
// the BSSID-aggregated table in production. wlanESSIDEncryptionType (.5) IS
// read-only/accessible and DOES return values, with the SSID name recoverable
// from its own OID index (standard SMI length-prefixed DisplayString index
// encoding) — see ssidNameFromIndex(). Live samples decoded per the BITS
// encoding (RFC 2578 §7.1.4: bit 0 = MSB of octet 0): hex 04 00 00 -> bit 5
// set -> wpa2-psk-aes (seen on e.g. "VIP", "TGIF", "TU-WiFi"); hex 80 00 00
// -> bit 0 set -> disabled (seen on the "TU-Guest" SSID, i.e. an open guest
// network) — both decodes are semantically sane for their SSID names.
const ESSID_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.8.1';
const wlanESSID = ESSID_BASE + '.1';            // wlanESSID (name; also the index)
const wlanESSIDNumStations = ESSID_BASE + '.2'; // wlanESSIDNumStations (client count)
const wlanESSIDEncryptionType = ESSID_BASE + '.5'; // wlanESSIDEncryptionType (ArubaEncryptionMethods BITS)

// Bit position -> human label for the ArubaEncryptionMethods BITS value
// (ARUBA-TC.txt, confirmed against the primary MIB source — see the OID
// comment above). Bits 15 and 20 are gaps in the TC (not assigned) and are
// intentionally absent here.
const ENCRYPTION_BIT_LABELS = {
  0: 'Open',
  1: 'WEP (Static)',
  2: 'WEP (Dynamic)',
  3: 'WPA (Static)',
  4: 'WPA (Dynamic)',
  5: 'WPA2-PSK (AES)',
  6: 'WPA2-Enterprise (AES)',
  7: 'WPA2 (Pre-Auth)',
  8: 'xSec',
  9: 'WPA-PSK (AES)',
  10: 'WPA (AES)',
  11: 'WPA2-PSK (TKIP)',
  12: 'WPA2-Enterprise (TKIP)',
  13: 'bSec-128',
  14: 'bSec-256',
  16: 'WPA3-OWE (AES)',
  17: 'WPA3-SAE (AES)',
  18: 'WPA3-CNSA',
  19: 'WPA3-Enterprise (AES-CCM-128)',
  21: 'MPSK (AES)',
  22: 'WPA3-Enterprise (AES-GCM-256)',
};

// Decode an ArubaEncryptionMethods BITS value (arrives from net-snmp as an
// OCTET STRING Buffer — the wire encoding for SNMPv2 BITS) into a
// human-readable summary label. Per RFC 2578 §7.1.4, bit 0 is the MSB of the
// first octet, bit 1 the next, etc. When more than one bit is set (a
// mixed-mode SSID, e.g. transitioning WPA2 -> WPA3) every matching label is
// joined with ", " rather than picking just one, so the label never hides a
// weaker method the SSID is still offering. Never throws — an unrecognised
// shape (missing OID, unexpected type) just yields null, matching this file's
// established defensive style.
function decodeEncryptionType(v) {
  try {
    if (v === null || v === undefined) return null;
    let buf;
    if (Buffer.isBuffer(v)) buf = v;
    else if (typeof v === 'string') buf = Buffer.from(v, 'latin1');
    else return null; // BITS should arrive as an OCTET STRING/Buffer — never guess at a bare number
    if (buf.length === 0) return null;
    const labels = [];
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];
      if (byte === 0) continue;
      for (let bitInByte = 0; bitInByte < 8; bitInByte++) {
        if ((byte & (0x80 >> bitInByte)) !== 0) {
          const label = ENCRYPTION_BIT_LABELS[i * 8 + bitInByte];
          if (label) labels.push(label);
        }
      }
    }
    return labels.length ? labels.join(', ') : null;
  } catch (e) {
    return null;
  }
}

// Recover an SSID name directly from a wlsxWlanESSIDTable row's OID index.
// The table is INDEX {wlanESSID}, and wlanESSID is a DisplayString index, so
// per standard SMI string-index encoding the index itself is
// "<length>.<octet>.<octet>...". This is needed because wlanESSID's own VALUE
// column (.1) is not-accessible and returns nothing on live firmware (see the
// OID comment above) — the index is the only place the name is available.
// Never throws; returns null on any malformed index.
function ssidNameFromIndex(idx) {
  try {
    if (!idx) return null;
    const parts = String(idx).split('.').map(Number);
    if (parts.length < 2) return null;
    const len = parts[0];
    if (!Number.isFinite(len) || len <= 0 || parts.length !== len + 1) return null;
    const bytes = parts.slice(1);
    if (bytes.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) return null;
    const s = Buffer.from(bytes).toString('latin1').trim();
    return s.length ? s : null;
  } catch (e) {
    return null;
  }
}

// ── Per-BSSID table (wlsxWlanAPBssidTable) — base ...5.2.1.7.1 ───────────────
// One row per broadcast BSSID (AP MAC + radio + BSSID). Each row carries its
// ESSID name and associated-station count, so SSIDs can be aggregated by name.
// This is the reliable SSID source: it lives in the same ...5.2.1 AP-info tree
// that already returns AP/radio data.
const BSSID_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1';
const wlanAPESSID = BSSID_BASE + '.2';                       // wlanAPESSID (SSID name)
const wlanAPBssidNumAssociatedStations = BSSID_BASE + '.12'; // wlanAPBssidNumAssociatedStations

// Reject AP "names" that are actually a MAC address. Old/incorrect SNMP parsing
// produced decimal-MAC names (6 decimal octets, e.g. "108.196.159.202.125.210")
// and hex MACs (e.g. "40:e3:d6:cc:3a:16") get into the name column when the real
// wlanAPName OID returns empty and we fell back to the index. A genuine AP name
// always contains at least one letter (e.g. "AP-100_FL32_IR", "TH-ITCS-ACP-001").
const DECIMAL_MAC_RE = /^\d+\.\d+\.\d+\.\d+\.\d+\.\d+$/;       // 108.196.159.202.125.210
const HEX_MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;       // 40:e3:d6:cc:3a:16
function isValidApName(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  if (DECIMAL_MAC_RE.test(s) || HEX_MAC_RE.test(s)) return false;
  // Accept only names that start with "AP" or contain at least one letter.
  if (/^AP/i.test(s)) return true;
  return /[A-Za-z]/.test(s);
}

function mapStatus(v) {
  const n = num(v);
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline')) return 'offline';
  }
  return 'unknown';
}

// ── Rogue / neighboring AP table (WLSX-MON-MIB wlsxMonAPInfoTable) ───────────
// NOTE: this table is NOT in WLSX-WLAN-MIB (unlike the AP/radio/ESSID tables
// above) — it lives in the separate WLSX-MON-MIB module. Base ...6.7.1.1.1,
// INDEX = { monPhyAddress (detecting AP MAC, 6 octets), monRadioNumber (1
// component), monitoredApBSSID (the monitored/rogue AP's own BSSID, 6 octets)
// } — 13 dotted components total per row, NOT a simple 6-octet MAC index.
// Live-verified on SMT_WLC (Aruba 7205 / AOS 8.10) and TUFS-OKF-WLC-1 (Aruba
// 9106 / AOS 8.13): thousands of rows on both controllers, every documented
// column populated, and monAPInfoClassification values of 1/2/3/7 observed —
// an exact match for the ArubaRogueApType enum with no discrepancy from the
// MIB text (see classifyRogue below).
const ROGUE_BASE = '1.3.6.1.4.1.14823.2.2.1.6.7.1.1.1';
const monAPInfoChannel = ROGUE_BASE + '.2';        // monAPInfoCurrentChannel
const monAPInfoClassification = ROGUE_BASE + '.3'; // monAPInfoClassification (ArubaRogueApType)
const monAPInfoESSID = ROGUE_BASE + '.4';          // monAPInfoESSID (SSID)
const monAPInfoRSSI = ROGUE_BASE + '.5';           // monAPInfoRSSI — actually SNR, see parseRogueAps

// Format a 6-octet MAC (Buffer) / dotted-decimal index / bare-hex string as colon-hex.
function fmtMac(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    if (v.length === 0) return null;
    return Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join(':');
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^[0-9a-f]{2}([:-][0-9a-f]{2})+$/i.test(s)) return s.replace(/-/g, ':').toLowerCase();
  if (/^\d+(\.\d+){5}$/.test(s)) {
    return s.split('.').map((d) => (Number(d) & 0xff).toString(16).padStart(2, '0')).join(':');
  }
  if (/^[0-9a-f]{12}$/i.test(s)) return s.match(/.{2}/g).join(':').toLowerCase();
  return s;
}

// Normalise monAPInfoClassification (the ArubaRogueApType TC, confirmed from
// ARUBA-TC.txt and live-verified on SMT_WLC/TUFS-OKF-WLC-1 — values 1/2/3/7
// all observed live) to the classification set already rendered by the
// frontend (frontend/src/app/(app)/wireless/page.tsx): friendly / interfering
// / malicious / unclassified / rogue. The confirmed enum never itself maps to
// 'rogue' (every one of its 7 values has a more specific target below) — that
// string stays reserved for a future manual/operator classification, and the
// string-fallback path below still recognises it for forward compatibility.
//   valid(1)             -> friendly       (known-good neighbor, e.g. same org's other SSIDs)
//   interfering(2)       -> interfering
//   unsecure(3)          -> malicious
//   dos(4)                -> malicious
//   unknown(5)            -> unclassified
//   knownInterfering(6)   -> interfering
//   suspectedUnsecure(7)  -> malicious
function classifyRogue(v) {
  const n = num(v);
  if (n !== null) {
    if (n === 1) return 'friendly';
    if (n === 2 || n === 6) return 'interfering';
    if (n === 3 || n === 4 || n === 7) return 'malicious';
    if (n === 5) return 'unclassified';
  }
  // Never-throw fallback for a firmware variant that returns text instead of
  // the documented INTEGER enum.
  const s = (str(v) || '').toLowerCase();
  if (s) {
    if (s.includes('valid') || s.includes('known') || s.includes('friend')) return 'friendly';
    if (s.includes('interfer')) return 'interfering';
    if (s.includes('dos') || s.includes('unsecure') || s.includes('malicious') || s.includes('threat')) return 'malicious';
    if (s.includes('rogue') || s.includes('suspect')) return 'rogue';
  }
  return 'unclassified';
}

// Split a 13-component wlsxMonAPInfoTable row index into its three INDEX
// fields: monPhyAddress (detecting AP MAC, octets 0-5), monRadioNumber
// (component 6), monitoredApBSSID (the monitored/rogue AP's own BSSID,
// octets 7-12). Deliberately NOT splitRadioIndex (that helper assumes a
// single trailing scalar component; this index has 6 trailing components
// making up the BSSID). Field order confirmed live: the leading 6 octets
// decode to plausible/known AP MACs (e.g. 1c:28:af:c1:a3:d6 on SMT_WLC — the
// same MAC used as the AP fixture in tests/test-aruba-parser.js, captured
// from this controller's real AP table), while the trailing 6 octets decode
// to distinct, varied neighboring BSSIDs — confirming detector-then-rogue
// index order, not the reverse.
function splitMonIndex(idx) {
  if (idx === null || idx === undefined) return null;
  const parts = String(idx).split('.');
  if (parts.length !== 13) return null;
  const detectingApMac = fmtMac(parts.slice(0, 6).join('.'));
  const radioNum = parts[6];
  const rogueBssid = fmtMac(parts.slice(7, 13).join('.'));
  if (!detectingApMac || !rogueBssid) return null;
  return { detectingApMac, radioNum, rogueBssid };
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const ips = columnMap(walked.apIp, wlanAPIpAddress);
    const names = columnMap(walked.apName, wlanAPName);
    const uptimes = columnMap(walked.apUptime, wlanAPUpTime);
    const models = columnMap(walked.apModel, wlanAPModelName);
    const statuses = columnMap(walked.apStatus, wlanAPStatus);
    const serials = columnMap(walked.apSerial, wlanAPSerialNumber);
    const swVersions = columnMap(walked.apFirmware, wlanAPSwVersion);
    const reboots = columnMap(walked.apReboots, wlanAPNumReboots);
    const bootstraps = columnMap(walked.apBootstraps, wlanAPNumBootstraps);

    const indexes = new Set();
    [ips, names, uptimes, models, statuses].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    const byIndex = new Map();
    for (const idx of indexes) {
      // The AP name comes from wlanAPName; when that OID is empty the only
      // fallback is the table index (the AP MAC as dotted decimals), which is a
      // MAC, not a name. Reject MAC-shaped names so stale decimal-MAC AP records
      // are never (re)created.
      const apName = str(names[idx]);
      if (!isValidApName(apName)) continue;

      const ap = emptyAp();
      ap._index = idx;
      ap.byte_counter_bits = 64;
      ap.name = apName;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);
      ap.serial_number = str(serials[idx]);
      ap.firmware_version = str(swVersions[idx]);
      // wlanAPUpTime is TimeTicks (hundredths of a second) — convert to seconds,
      // like the other vendor parsers. (Storing it raw inflated uptime ~100×.)
      const up = num(uptimes[idx]);
      if (up !== null) ap.uptime_seconds = Math.floor(up / 100);
      // Cumulative lifetime counters — see the wlanAPNumReboots/wlanAPNumBootstraps
      // OID comment above. Stored as-is (not deltas).
      ap.reboot_count = num(reboots[idx]);
      ap.bootstrap_count = num(bootstraps[idx]);
      out.push(ap);
      byIndex.set(idx, ap);
    }

    // ── Correlate per-radio metrics. The radio index is "<apMAC>.<radioNum>",
    //    so the apKey (everything before the last dot) matches the AP-table
    //    index. Band comes from the reported channel (≤14 = 2.4G, else 5/6G) —
    //    radioNum (1/2) is not a reliable band on its own.
    const radioChan = columnMap(walked.radioChannel, wlanAPRadioChannel);
    const radioUtil = columnMap(walked.radioUtil, wlanAPRadioUtilization);
    const radioClients = columnMap(walked.radioClients, wlanAPRadioNumAssociatedClients);
    const chNoise = columnMap(walked.chNoise, wlanAPChNoise);
    const chRetry = columnMap(walked.chRetry, wlanAPChFrameRetryRate);
    const chBusy = columnMap(walked.chBusy, wlanAPChUtilization);
    const chRxUtil = columnMap(walked.chRxUtil, wlanAPChRxUtilization);
    const chTxUtil = columnMap(walked.chTxUtil, wlanAPChTxUtilization);
    const radioTxPower10x = columnMap(walked.radioTxPower10x, wlanAPRadioTransmitPower10x);
    const chFcsErrors = columnMap(walked.chFcsErrors, wlanAPChFCSErrorCount);
    const radioTxErrors = columnMap(walked.radioTxErrors, wlanAPRadioTxErrorPkts);

    const radioIdxs = new Set([
      ...Object.keys(radioChan), ...Object.keys(radioUtil), ...Object.keys(radioClients),
    ]);
    for (const ridx of radioIdxs) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;

      const ch = num(radioChan[ridx]);
      const band = bandForChannel(ch);
      if (!band) continue; // can't place this radio without a channel → skip

      if (ch !== null) {
        if (band === '2g') ap.radio_2g_channel = ch;
        else if (band === '5g') ap.radio_5g_channel = ch;
        else if (band === '6g') ap.radio_6g_channel = ch;
      }
      const util = num(radioUtil[ridx]);
      if (util !== null) {
        if (band === '2g') ap.radio_2g_util_pct = util;
        else if (band === '5g') ap.radio_5g_util_pct = util;
      }
      const cl = num(radioClients[ridx]);
      if (cl !== null) {
        if (band === '2g') ap.clients_2g = cl;
        else if (band === '5g') ap.clients_5g = cl;
      }
      // Noise floor: positive-encoded dBm (92 → −92 dBm); 0 = not reported.
      const nf = num(chNoise[ridx]);
      if (nf !== null && nf !== 0) {
        const dbm = nf > 0 ? -nf : nf;
        if (band === '2g') ap.noise_floor_2g = dbm;
        else if (band === '5g') ap.noise_floor_5g = dbm;
      }
      const rr = num(chRetry[ridx]);
      if (rr !== null && rr >= 0 && rr <= 100) {
        if (band === '2g') ap.retry_rate_2g = rr;
        else if (band === '5g') ap.retry_rate_5g = rr;
      }
      // Transmit power: wlanAPRadioTransmitPower10x is dBm x10 (live-verified,
      // see the OID comment above) — divide by 10. A real 0 dBm reading is kept
      // (not treated as "not reported"); only an absent OID stays null.
      const txp10 = num(radioTxPower10x[ridx]);
      if (txp10 !== null) {
        const dbm = txp10 / 10;
        if (band === '2g') ap.tx_power_2g = dbm;
        else if (band === '5g') ap.tx_power_5g = dbm;
      }
      // rx_errors_* from wlanAPChFCSErrorCount (channel-stats table, RX-side
      // decode failures); tx_errors_* from wlanAPRadioTxErrorPkts (radio-stats
      // table, explicitly TX-side). See the OID comments above for the live
      // verification and the aliasing this firmware exhibits.
      const fcs = num(chFcsErrors[ridx]);
      if (fcs !== null && fcs >= 0) {
        if (band === '2g') ap.rx_errors_2g = fcs;
        else if (band === '5g') ap.rx_errors_5g = fcs;
      }
      const txErr = num(radioTxErrors[ridx]);
      if (txErr !== null && txErr >= 0) {
        if (band === '2g') ap.tx_errors_2g = txErr;
        else if (band === '5g') ap.tx_errors_5g = txErr;
      }
      // Interference = channel busy time minus this AP's own rx/tx airtime.
      // Only derived when all three columns answered; clamped — the three
      // gauges are sampled independently so the difference can dip below 0.
      const busy = num(chBusy[ridx]);
      const rxU = num(chRxUtil[ridx]);
      const txU = num(chTxUtil[ridx]);
      if (busy !== null && rxU !== null && txU !== null) {
        const intf = Math.max(0, Math.min(100, busy - rxU - txU));
        if (band === '2g') ap.interference_pct_2g = intf;
        else if (band === '5g') ap.interference_pct_5g = intf;
      }
    }

    // ── Cumulative rx/tx byte counters: sum across the AP's radios (band does
    //    not matter for totals, so this runs on the stats-table index directly).
    const radioRx = columnMap(walked.radioRxBytes, wlanAPRadioRxBytes);
    const radioTx = columnMap(walked.radioTxBytes, wlanAPRadioTxBytes);
    const statIdxs = new Set([...Object.keys(radioRx), ...Object.keys(radioTx)]);
    for (const ridx of statIdxs) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const rx = counterNum(radioRx[ridx]);
      if (rx !== null) ap.rx_bytes = (ap.rx_bytes === null ? 0 : ap.rx_bytes) + rx;
      const tx = counterNum(radioTx[ridx]);
      if (tx !== null) ap.tx_bytes = (ap.tx_bytes === null ? 0 : ap.tx_bytes) + tx;
    }

    // No per-AP total-clients OID on the controller → sum the radios.
    for (const ap of out) {
      ap.clients_total = (ap.clients_2g || 0) + (ap.clients_5g || 0) + (ap.clients_6g || 0);
    }
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  // Derived from the AP table (per-radio client sum), keyed by AP index.
  try {
    return parseApTable(walked).map((ap) => ({ apKey: ap._index, clients: ap.clients_total }));
  } catch (e) {
    return [];
  }
}

// Build an SSID row with the controller-unavailable counters nulled out.
// encryption_type defaults to null — only the ESSID-summary path (below) has
// a confirmed live source for it; the BSSID-fallback table was not verified
// to carry an equivalent column, so it stays null rather than guessing.
function ssidRow(ssid_name, clients_total, encryption_type) {
  return {
    ssid_name,
    status: 'up',
    clients_total: clients_total || 0,
    bytes_in: null,   // per-SSID byte/auth counters are not in WLSX-WLAN-MIB
    bytes_out: null,
    auth_successes: 0,
    auth_failures: 0,
    encryption_type: encryption_type || null,
  };
}

// SSIDs from the controller ESSID summary table (...5.2.1.8): one row per SSID.
function parseEssidSummary(walked) {
  const out = [];
  const names = columnMap(walked.essidName, wlanESSID);
  const stations = columnMap(walked.essidStations, wlanESSIDNumStations);
  const encryption = columnMap(walked.essidEncryption, wlanESSIDEncryptionType);
  console.log('[Aruba] ESSID walk:', Object.keys(names).length, 'raw OIDs (wlsxWlanESSIDTable ...5.2.1.8)');
  const indexes = new Set([...Object.keys(names), ...Object.keys(stations), ...Object.keys(encryption)]);
  for (const idx of indexes) {
    // wlanESSID (.1) is MAX-ACCESS not-accessible and returns no value on some
    // ArubaOS builds (live-verified — see the OID comment above); when that
    // happens, recover the name from the row's own OID index instead (the
    // index IS the SSID name, standard SMI string-index encoding).
    const ssid_name = str(names[idx]) || ssidNameFromIndex(idx);
    if (!ssid_name) continue;
    out.push(ssidRow(ssid_name, num(stations[idx]), decodeEncryptionType(encryption[idx])));
  }
  return out;
}

// SSIDs aggregated from the per-BSSID table (...5.2.1.7): every AP radio
// broadcasts a BSSID per SSID, so sum the station counts across all BSSIDs that
// share an SSID name to get the per-SSID client total. No encryption-type
// column was confirmed on this table, so encryption_type stays null here
// (see ssidRow's default) — only the ESSID-summary path above sets it.
function parseBssidAggregated(walked) {
  const names = columnMap(walked.bssidEssid, wlanAPESSID);
  const stations = columnMap(walked.bssidStations, wlanAPBssidNumAssociatedStations);
  console.log('[Aruba] ESSID walk:', Object.keys(names).length, 'raw OIDs (wlsxWlanAPBssidTable ...5.2.1.7)');
  const agg = new Map(); // ssid_name -> summed clients
  for (const idx of Object.keys(names)) {
    const ssid_name = str(names[idx]);
    if (!ssid_name) continue;
    agg.set(ssid_name, (agg.get(ssid_name) || 0) + (num(stations[idx]) || 0));
  }
  const out = [];
  for (const [ssid_name, clients] of agg.entries()) out.push(ssidRow(ssid_name, clients));
  return out;
}

// Per-SSID stats: try each known SSID source in order, use the first that
// returns rows. The controller ESSID summary (...5.2.1.8) is empty on some
// ArubaOS builds, so we fall back to aggregating the per-BSSID table (...5.2.1.7),
// which lives in the same AP-info tree that already returns AP/radio data.
function parseSsids(walked) {
  try {
    walked = walked || {};
    let rows = parseEssidSummary(walked);   // 1.3.6.1.4.1.14823.2.2.1.5.2.1.8
    if (rows.length === 0) rows = parseBssidAggregated(walked); // ...5.2.1.7 fallback
    console.log('[Aruba] SSIDs parsed:', rows.length);
    return rows;
  } catch (e) {
    return [];
  }
}

// Parse the rogue/neighboring AP table (WLSX-MON-MIB wlsxMonAPInfoTable).
// bssid and detecting_ap both come from the row INDEX (see splitMonIndex),
// not from a value column. Never throws.
//
// De-dup: wireless_rogue_aps is UNIQUE(controller_id, bssid), but the SAME
// rogue/neighbor BSSID is commonly heard by multiple detecting APs (many
// live rows share a rogueBssid with a different detectingApMac). We keep the
// FIRST row encountered per rogueBssid and drop later duplicates for that
// BSSID — simplest option that can never collide on the unique constraint.
// This is stable poll-to-poll (not flapping which detecting AP "wins") because
// net-snmp walks return rows in a fixed lexicographic-index order. A
// confidence/monitor-time tie-break was considered, but in the live sample
// confidence was ~always 100 across rows, so it would not have changed the
// outcome — not worth the extra OID walk for a field upsertRogueAp() doesn't
// even store.
function parseRogueAps(walked) {
  const out = new Map(); // rogueBssid -> row
  try {
    walked = walked || {};

    const channels = columnMap(walked.rogueChannel, monAPInfoChannel);
    const classes = columnMap(walked.rogueClassification, monAPInfoClassification);
    const ssids = columnMap(walked.rogueSsid, monAPInfoESSID);
    const rssis = columnMap(walked.rogueRssi, monAPInfoRSSI);

    const indexes = new Set();
    [channels, classes, ssids, rssis].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const split = splitMonIndex(idx);
      if (!split) continue;
      const { detectingApMac, rogueBssid } = split;
      if (out.has(rogueBssid)) continue; // first-seen wins — see comment above

      const channel = num(channels[idx]);
      // monAPInfoRSSI is documented as RSSI but is actually a signal-to-noise
      // RATIO (positive dB) on the wire — same caveat as wlanStaRSSI in
      // clients/aruba.js. Convert with the same -95dBm typical noise floor.
      const sig = num(rssis[idx]);
      const rssi_dbm = sig === null ? null : (sig > 0 ? sig - 95 : sig);

      out.set(rogueBssid, {
        bssid: rogueBssid,
        ssid: str(ssids[idx]) || null,
        rssi_dbm,
        channel: channel === null ? null : channel,
        classification: classifyRogue(classes[idx]),
        detecting_ap: detectingApMac,
      });
    }
  } catch (e) {
    // never throw
    return [];
  }
  return Array.from(out.values());
}

const snmpRogueOids = {
  rogueChannel: monAPInfoChannel,
  rogueClassification: monAPInfoClassification,
  rogueSsid: monAPInfoESSID,
  rogueRssi: monAPInfoRSSI,
};

module.exports = {
  name: 'aruba',
  snmpOids: {
    // AP table (index = AP MAC)
    apIp: wlanAPIpAddress,
    apName: wlanAPName,
    apUptime: wlanAPUpTime,
    apModel: wlanAPModelName,
    apStatus: wlanAPStatus,
    apSerial: wlanAPSerialNumber,
    apFirmware: wlanAPSwVersion,
    apReboots: wlanAPNumReboots,
    apBootstraps: wlanAPNumBootstraps,
    // Radio table (index = AP MAC + radioNumber)
    radioChannel: wlanAPRadioChannel,
    radioUtil: wlanAPRadioUtilization,
    radioClients: wlanAPRadioNumAssociatedClients,
    radioTxPower10x: wlanAPRadioTransmitPower10x,
    // Channel stats table (index = AP MAC + radioNumber)
    chNoise: wlanAPChNoise,
    chRetry: wlanAPChFrameRetryRate,
    chBusy: wlanAPChUtilization,
    chRxUtil: wlanAPChRxUtilization,
    chTxUtil: wlanAPChTxUtilization,
    chFcsErrors: wlanAPChFCSErrorCount,
    // Radio stats table (index = AP MAC + radioNumber, Counter64 byte counters)
    radioRxBytes: wlanAPRadioRxBytes,
    radioTxBytes: wlanAPRadioTxBytes,
    radioTxErrors: wlanAPRadioTxErrorPkts,
    // ESSID summary table (index = SSID name)
    essidName: wlanESSID,
    essidStations: wlanESSIDNumStations,
    essidEncryption: wlanESSIDEncryptionType,
    // Per-BSSID table fallback (index = AP MAC + radio + BSSID)
    bssidEssid: wlanAPESSID,
    bssidStations: wlanAPBssidNumAssociatedStations,
  },
  snmpRogueOids,
  parseApTable,
  parseClientCounts,
  parseSsids,
  parseRogueAps,
};

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
//   • per-radio rx/tx ERROR counters

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

// ── Radio table (wlsxWlanRadioTable) — base ...5.2.1.5.1 ─────────────────────
// Index = AP MAC (6 octets) + radioNumber. Band is derived from the channel.
const RADIO_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.5.1';
const wlanAPRadioChannel = RADIO_BASE + '.3';               // wlanAPRadioChannel
const wlanAPRadioUtilization = RADIO_BASE + '.6';           // wlanAPRadioUtilization (%)
const wlanAPRadioNumAssociatedClients = RADIO_BASE + '.7';  // wlanAPRadioNumAssociatedClients

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

// ── Radio stats table (wlsxWlanAPRadioStatsTable) — base ...5.3.1.9.1 ────────
// Same AP MAC + radioNumber index. Cumulative Counter64 byte counters (net-snmp
// delivers them as 8-byte BE Buffers → counterNum). Summed across an AP's radios
// into ap.rx_bytes / ap.tx_bytes; the collector turns those into throughput bps.
const RADIOSTATS_BASE = '1.3.6.1.4.1.14823.2.2.1.5.3.1.9.1';
const wlanAPRadioRxBytes = RADIOSTATS_BASE + '.2';   // wlanAPRadioRxBytes (Counter64)
const wlanAPRadioTxBytes = RADIOSTATS_BASE + '.4';   // wlanAPRadioTxBytes (Counter64)

// ── ESSID summary table (wlsxWlanESSIDTable) — base ...5.2.1.8.1 ─────────────
// Index = the (length-prefixed) SSID name. wlanESSID's value is the name string.
// On some ArubaOS builds this controller-level summary is empty even when SSIDs
// are active, so parseSsids() falls back to the per-BSSID table below.
const ESSID_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.8.1';
const wlanESSID = ESSID_BASE + '.1';            // wlanESSID (name; also the index)
const wlanESSIDNumStations = ESSID_BASE + '.2'; // wlanESSIDNumStations (client count)

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

// ── Rogue / unsecure AP table (WLSX-WLAN-MIB wlsxWlanAPRogueTable) ───────────
// Aruba publishes detected rogue/unsecure APs under the wlsxWlanMonRadioInfo /
// rogue AP tree. The reliable, documented table is wlsxWlanAPRogueTable at
// ...5.2.1.10.1, indexed by the rogue BSSID (6-octet MAC). Best-effort column
// suffixes from the MIB — validate against real hardware.
const ROGUE_BASE = '1.3.6.1.4.1.14823.2.2.1.5.2.1.10.1';
const wlanAPRogueBSSID = ROGUE_BASE + '.1';     // rogue BSSID (also the index)
const wlanAPRogueSSID = ROGUE_BASE + '.2';      // rogue SSID name
const wlanAPRogueChannel = ROGUE_BASE + '.3';   // channel
const wlanAPRogueRSSI = ROGUE_BASE + '.4';      // RSSI (dBm)
const wlanAPRogueType = ROGUE_BASE + '.5';      // classification (rogue/interfering/known)
const wlanAPRogueDetectingAP = ROGUE_BASE + '.6'; // detecting AP MAC (best-effort)

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

// Normalise an Aruba rogue type to the shared classification set.
// WLSX-WLAN-MIB rogue type INTEGER (best-effort): 1 valid, 2 interfering,
// 3 dos, 4 rogue, 5 known-interfering, 6 unsecure, 7 suspect-rogue.
function classifyRogue(v) {
  const n = num(v);
  if (n !== null) {
    if (n === 1) return 'friendly';                 // valid / known-good
    if (n === 2 || n === 5) return 'interfering';   // interfering
    if (n === 3 || n === 6) return 'malicious';     // dos / unsecure
    if (n === 4 || n === 7) return 'rogue';         // rogue / suspect-rogue
  }
  const s = (str(v) || '').toLowerCase();
  if (s) {
    if (s.includes('valid') || s.includes('known') || s.includes('friend')) return 'friendly';
    if (s.includes('interfer')) return 'interfering';
    if (s.includes('dos') || s.includes('unsecure') || s.includes('malicious') || s.includes('threat')) return 'malicious';
    if (s.includes('rogue') || s.includes('suspect')) return 'rogue';
  }
  return 'unclassified';
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
      ap.name = apName;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);
      // wlanAPUpTime is TimeTicks (hundredths of a second) — convert to seconds,
      // like the other vendor parsers. (Storing it raw inflated uptime ~100×.)
      const up = num(uptimes[idx]);
      if (up !== null) ap.uptime_seconds = Math.floor(up / 100);
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
function ssidRow(ssid_name, clients_total) {
  return {
    ssid_name,
    status: 'up',
    clients_total: clients_total || 0,
    bytes_in: null,   // per-SSID byte/auth counters are not in WLSX-WLAN-MIB
    bytes_out: null,
    auth_successes: 0,
    auth_failures: 0,
  };
}

// SSIDs from the controller ESSID summary table (...5.2.1.8): one row per SSID.
function parseEssidSummary(walked) {
  const out = [];
  const names = columnMap(walked.essidName, wlanESSID);
  const stations = columnMap(walked.essidStations, wlanESSIDNumStations);
  console.log('[Aruba] ESSID walk:', Object.keys(names).length, 'raw OIDs (wlsxWlanESSIDTable ...5.2.1.8)');
  const indexes = new Set([...Object.keys(names), ...Object.keys(stations)]);
  for (const idx of indexes) {
    const ssid_name = str(names[idx]);
    if (!ssid_name) continue;
    out.push(ssidRow(ssid_name, num(stations[idx])));
  }
  return out;
}

// SSIDs aggregated from the per-BSSID table (...5.2.1.7): every AP radio
// broadcasts a BSSID per SSID, so sum the station counts across all BSSIDs that
// share an SSID name to get the per-SSID client total.
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

// Parse the rogue/unsecure AP table (wlsxWlanAPRogueTable). Indexed by the rogue
// BSSID; when the BSSID value column is empty the table index is the BSSID.
// Never throws.
function parseRogueAps(walked) {
  const out = [];
  try {
    walked = walked || {};

    const bssids = columnMap(walked.rogueBssid, wlanAPRogueBSSID);
    const ssids = columnMap(walked.rogueSsid, wlanAPRogueSSID);
    const channels = columnMap(walked.rogueChannel, wlanAPRogueChannel);
    const rssis = columnMap(walked.rogueRssi, wlanAPRogueRSSI);
    const types = columnMap(walked.rogueType, wlanAPRogueType);
    const detectors = columnMap(walked.rogueDetector, wlanAPRogueDetectingAP);

    const indexes = new Set();
    [bssids, ssids, channels, rssis, types].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const bssid = fmtMac(bssids[idx]) || fmtMac(idx);
      if (!bssid) continue;

      const ssid = str(ssids[idx]);
      const channel = num(channels[idx]);
      const rssi = num(rssis[idx]);
      const detecting_ap = fmtMac(detectors[idx]);

      out.push({
        bssid,
        ssid: ssid || null,
        rssi_dbm: rssi === null ? null : rssi,
        channel: channel === null ? null : channel,
        classification: classifyRogue(types[idx]),
        detecting_ap: detecting_ap || null,
      });
    }
  } catch (e) {
    // never throw
    return [];
  }
  return out;
}

const snmpRogueOids = {
  rogueBssid: wlanAPRogueBSSID,
  rogueSsid: wlanAPRogueSSID,
  rogueChannel: wlanAPRogueChannel,
  rogueRssi: wlanAPRogueRSSI,
  rogueType: wlanAPRogueType,
  rogueDetector: wlanAPRogueDetectingAP,
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
    // Radio table (index = AP MAC + radioNumber)
    radioChannel: wlanAPRadioChannel,
    radioUtil: wlanAPRadioUtilization,
    radioClients: wlanAPRadioNumAssociatedClients,
    // Channel stats table (index = AP MAC + radioNumber)
    chNoise: wlanAPChNoise,
    chRetry: wlanAPChFrameRetryRate,
    chBusy: wlanAPChUtilization,
    chRxUtil: wlanAPChRxUtilization,
    chTxUtil: wlanAPChTxUtilization,
    // Radio stats table (index = AP MAC + radioNumber, Counter64 byte counters)
    radioRxBytes: wlanAPRadioRxBytes,
    radioTxBytes: wlanAPRadioTxBytes,
    // ESSID summary table (index = SSID name)
    essidName: wlanESSID,
    essidStations: wlanESSIDNumStations,
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

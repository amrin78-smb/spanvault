'use strict';

// Ruckus (ZoneDirector) wireless parser.
// OIDs verified against RUCKUS-ZD-WLAN-MIB / RUCKUS-ROOT-MIB (LibreNMS MIB
// mirrors). All tables live under ruckusZDWLANObjects =
// 1.3.6.1.4.1.25053.1.2.2.1.1:
//   • ruckusZDWLANTable        ...1.1.1.1  — one row per WLAN/SSID (INDEX = integer)
//   • ruckusZDWLANAPTable      ...1.2.1.1  — one row per AP (INDEX = 6-octet MAC
//     → 6 dotted sub-identifiers)
//   • ruckusZDWLANAPRadioStatsTable ...1.2.2.1 — one row per AP+radio
//     (INDEX = AP MAC + radioIndex, 7 sub-identifiers)
//   • ruckusZDWLANRogueTable   ...1.4.1.1  — one row per detected rogue
//     (INDEX = integer; the rogue MAC is a VALUE column, not the index)
// NOTE: ...1.3.1.1 is the per-client STATION table — never walk it here (one
// row per associated client; huge, and its rows are not APs or rogues).
// Column suffixes below are MIB-verified but still pending validation against
// real hardware.

const {
  num,
  counterNum,
  str,
  columnMap,
  emptyAp,
  splitRadioIndex,
  bandForRadioIndex,
} = require('./_util');

// ruckusZDWLANAPTable: 1.3.6.1.4.1.25053.1.2.2.1.1.2.1.1 (INDEX = 6-octet MAC)
const AP_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.1.1';
const ruckusZDWLANAPMacAddr = AP_BASE + '.1'; // ruckusZDWLANAPMacAddr (MacAddress; also the index)
const ruckusZDWLANAPDescription = AP_BASE + '.2'; // AP name/description
const ruckusZDWLANAPStatus = AP_BASE + '.3'; // see mapStatus() enum below
const ruckusZDWLANAPModel = AP_BASE + '.4'; // model string
const ruckusZDWLANAPUptime = AP_BASE + '.6'; // TimeTicks (1/100 s) → ÷100 = seconds
const ruckusZDWLANAPIPAddr = AP_BASE + '.10'; // AP IP address
const ruckusZDWLANAPNumSta = AP_BASE + '.15'; // total associated clients
// (No per-AP channel column exists in this table — channels come from the
// radio table below.)

// ruckusZDWLANAPRadioStatsTable: 1.3.6.1.4.1.25053.1.2.2.1.1.2.2.1
// INDEX = AP MAC (6 octets) + radioIndex.
const RADIO_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.2.1';
// ruckusZDWLANAPRadioStatsRadioType INTEGER: radio11bg(0), radio11a(1),
// radio11ng(2), radio11na(3), radio11ac(4) → authoritative band source.
const ruckusZDWLANAPRadioStatsRadioType = RADIO_BASE + '.3';
const ruckusZDWLANAPRadioStatsChannel = RADIO_BASE + '.4'; // current channel
const ruckusZDWLANAPRadioStatsNumSta = RADIO_BASE + '.8'; // clients on this radio (not the configured cap)
const ruckusZDWLANAPRadioStatsRxBytes = RADIO_BASE + '.11'; // Counter64 → counterNum
const ruckusZDWLANAPRadioStatsTxBytes = RADIO_BASE + '.14'; // Counter64 → counterNum
const ruckusZDWLANAPRadioStatsResourceUtil = RADIO_BASE + '.40'; // channel util % (0-100)
// NOTE: no noise-floor object exists in RUCKUS-ZD-WLAN-MIB (…2.2.1.16 is a
// TxFail Counter64, not noise) — noise_floor_2g/_5g stay null for Ruckus.
// Do NOT repurpose AvgStaRSSI as a noise floor.

// ruckusZDWLANTable: 1.3.6.1.4.1.25053.1.2.2.1.1.1.1.1 (INDEX = wlan integer)
const WLAN_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.1.1.1';
const ruckusZDWLANSSID = WLAN_BASE + '.1'; // ruckusZDWLANSSID (the SSID string; .2 is Description)
const ruckusZDWLANNumSta = WLAN_BASE + '.12'; // ruckusZDWLANNumSta (clients)
const ruckusZDWLANRxBytes = WLAN_BASE + '.14'; // Counter64 (→ bytes_in)
const ruckusZDWLANTxBytes = WLAN_BASE + '.16'; // Counter64 (→ bytes_out)
const ruckusZDWLANAuthTotal = WLAN_BASE + '.28'; // AuthSuccessTotal, Counter64
const ruckusZDWLANAuthFail = WLAN_BASE + '.29'; // AuthFail, Counter64

// ruckusZDWLANAPStatus INTEGER: disconnected(0), connected(1),
// approvalPending(2), upgradingFirmware(3), provisioning(4).
function mapStatus(v) {
  const n = num(v);
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline'; // disconnected / approvalPending
  if (n === 3 || n === 4) return 'unknown'; // upgradingFirmware / provisioning
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('connect') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline') || l.includes('disconnect')) return 'offline';
  }
  return 'unknown';
}

// ruckusZDWLANAPRadioStatsRadioType → band. radio11bg(0)/radio11ng(2) are
// 2.4 GHz; radio11a(1)/radio11na(3)/radio11ac(4) are 5 GHz.
function bandForRadioType(v) {
  const n = num(v);
  if (n === 0 || n === 2) return '2g';
  if (n === 1 || n === 3 || n === 4) return '5g';
  return null;
}

// ── Rogue AP table (RUCKUS-ZD-WLAN-MIB ruckusZDWLANRogueTable) ───────────────
// Base 1.3.6.1.4.1.25053.1.2.2.1.1.4.1.1 — INDEX is a plain integer, so the
// rogue MAC must come from the value column (never from the index).
// (The previous …1.3.1.1 base was the per-client STATION table — every
// associated client was being reported as a rogue AP.)
const ROGUE_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.4.1.1';
const ruckusZDWLANRogueMacAddr = ROGUE_BASE + '.1'; // rogue MAC / BSSID (MacAddress value column)
const ruckusZDWLANRogueSSID = ROGUE_BASE + '.2'; // rogue SSID
const ruckusZDWLANRogueChannel = ROGUE_BASE + '.4'; // channel
// '.5' is RSSI-as-SNR (signal-to-noise, NOT dBm) — do not report it as dBm.
const ruckusZDWLANRogueType = ROGUE_BASE + '.6'; // INTEGER {ap(0), ad-hoc(1)} — device type, NOT a threat class
const ruckusZDWLANRogueSignalStrength = ROGUE_BASE + '.11'; // UNITS dBm → rssi_dbm
// No detecting-AP column exists in this table ('.8' does not exist) →
// detecting_ap is always null for Ruckus.

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

// Ruckus rogue "type" (ruckusZDWLANRogueType) is INTEGER {ap(0), ad-hoc(1)} —
// a DEVICE type, not a threat classification. The ZoneDirector MIB exposes no
// friendly/malicious/interfering classification, so every detected rogue is
// reported as 'unclassified' (never guess a threat level from a device type).
function classifyRogue(_v) {
  return 'unclassified';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const macs = columnMap(walked.apMac, ruckusZDWLANAPMacAddr);
    const names = columnMap(walked.apName, ruckusZDWLANAPDescription);
    const ips = columnMap(walked.apIp, ruckusZDWLANAPIPAddr);
    const models = columnMap(walked.apModel, ruckusZDWLANAPModel);
    const statuses = columnMap(walked.apStatus, ruckusZDWLANAPStatus);
    const clients = columnMap(walked.apClients, ruckusZDWLANAPNumSta);
    const uptimes = columnMap(walked.apUptime, ruckusZDWLANAPUptime);

    const indexes = new Set();
    [macs, names, ips, models, statuses, clients, uptimes].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    // Map of constructed APs keyed by _index so radio metrics can correlate back.
    const byIndex = new Map();

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      // MacAddress arrives as a 6-byte Buffer — str() would produce mojibake.
      // The table index IS the MAC (6 dotted decimals), so it is the fallback.
      ap.mac_address = fmtMac(macs[idx]) || fmtMac(idx);
      ap.name = str(names[idx]) || ap.mac_address || idx;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);

      // ruckusZDWLANAPUptime is TimeTicks (hundredths of a second) → seconds.
      const up = num(uptimes[idx]);
      if (up !== null) ap.uptime_seconds = Math.floor(up / 100);

      // Total clients from the AP table; nullable so a per-radio fallback applies.
      ap.clients_total = num(clients[idx]);

      byIndex.set(idx, ap);
      out.push(ap);
    }

    // ── Correlate the per-radio stats table onto each AP ─────────────────────
    // Radio index = <apMAC 6 octets>.radioIndex; apKey matches ap._index.
    // Band comes from the RadioType column; when RadioType did not answer for
    // a row we fall back to the radioIndex convention (0 = 2.4G, 1 = 5G).
    const radioTypes = columnMap(walked.radioType, ruckusZDWLANAPRadioStatsRadioType);
    const radioChannels = columnMap(walked.radioChannel, ruckusZDWLANAPRadioStatsChannel);
    const channelUtils = columnMap(walked.radioChannelUtil, ruckusZDWLANAPRadioStatsResourceUtil);
    const radioNumStas = columnMap(walked.radioNumSta, ruckusZDWLANAPRadioStatsNumSta);
    const radioRxBytes = columnMap(walked.radioRxBytes, ruckusZDWLANAPRadioStatsRxBytes);
    const radioTxBytes = columnMap(walked.radioTxBytes, ruckusZDWLANAPRadioStatsTxBytes);

    const bandFor = (ridx, radioKey) => {
      const b = bandForRadioType(radioTypes[ridx]);
      return b || bandForRadioIndex(radioKey);
    };

    // Channel → radio_2g_channel / radio_5g_channel
    for (const ridx of Object.keys(radioChannels)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const band = bandFor(ridx, radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(radioChannels[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.radio_2g_channel = v;
      else if (band === '5g') ap.radio_5g_channel = v;
    }

    // Channel util (ResourceUtil, 0-100 %) → radio_2g_util_pct / radio_5g_util_pct
    for (const ridx of Object.keys(channelUtils)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const band = bandFor(ridx, radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(channelUtils[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.radio_2g_util_pct = v;
      else if (band === '5g') ap.radio_5g_util_pct = v;
    }

    // Per-radio clients → clients_2g / clients_5g. Only set when the OID
    // actually answered — a genuinely-absent count must not be coerced to 0
    // (emptyAp's 0 default stays for rows the walk never covered, matching the
    // aruba parser's behavior).
    for (const ridx of Object.keys(radioNumStas)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const band = bandFor(ridx, radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(radioNumStas[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.clients_2g = v;
      else if (band === '5g') ap.clients_5g = v;
    }

    // Rx bytes (Counter64 → 8-byte BE Buffer → counterNum): ACCUMULATE into
    // ap.rx_bytes (sum across radios, from null).
    for (const ridx of Object.keys(radioRxBytes)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = counterNum(radioRxBytes[ridx]);
      if (v === null) continue;
      ap.rx_bytes = (ap.rx_bytes === null ? 0 : ap.rx_bytes) + v;
    }

    // Tx bytes (Counter64) → ACCUMULATE into ap.tx_bytes (sum across radios).
    for (const ridx of Object.keys(radioTxBytes)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = counterNum(radioTxBytes[ridx]);
      if (v === null) continue;
      ap.tx_bytes = (ap.tx_bytes === null ? 0 : ap.tx_bytes) + v;
    }

    // Total clients: fall back to the per-radio sum when the AP table omitted it.
    for (const ap of out) {
      if (ap.clients_total === null) ap.clients_total = (ap.clients_2g || 0) + (ap.clients_5g || 0) + (ap.clients_6g || 0);
    }
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  // Derived from the parsed AP table (AP-table NumSta with per-radio fallback),
  // keyed by the AP index (the AP MAC as dotted decimals).
  try {
    return parseApTable(walked).map((ap) => ({ apKey: ap._index, clients: ap.clients_total }));
  } catch (e) {
    return [];
  }
}

function parseSsids(walked) {
  const out = [];
  try {
    walked = walked || {};
    const ssids = columnMap(walked.ssidName, ruckusZDWLANSSID);
    const numStas = columnMap(walked.ssidNumSta, ruckusZDWLANNumSta);
    const rxBytes = columnMap(walked.ssidRxBytes, ruckusZDWLANRxBytes);
    const txBytes = columnMap(walked.ssidTxBytes, ruckusZDWLANTxBytes);
    const authSucc = columnMap(walked.ssidAuthSuccess, ruckusZDWLANAuthTotal);
    const authFail = columnMap(walked.ssidAuthFail, ruckusZDWLANAuthFail);

    for (const idx of Object.keys(ssids)) {
      const ssidName = str(ssids[idx]);
      if (!ssidName) continue; // skip rows without an SSID name
      const clients = num(numStas[idx]);
      const as = counterNum(authSucc[idx]);
      const af = counterNum(authFail[idx]);
      out.push({
        ssid_name: ssidName,
        status: 'up',
        clients_total: clients === null ? 0 : clients,
        // Counter64 byte counters arrive as 8-byte BE Buffers → counterNum.
        bytes_in: counterNum(rxBytes[idx]),
        bytes_out: counterNum(txBytes[idx]),
        auth_successes: as === null ? 0 : as,
        auth_failures: af === null ? 0 : af,
      });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

// Parse the rogue AP table (ruckusZDWLANRogueTable). The table INDEX is a
// plain integer, so the rogue MAC must come from the '.1' value column; when
// that column is empty the row is SKIPPED (formatting the integer index as a
// MAC would emit garbage). Never throws.
function parseRogueAps(walked) {
  const out = [];
  try {
    walked = walked || {};

    const macs = columnMap(walked.rogueMac, ruckusZDWLANRogueMacAddr);
    const ssids = columnMap(walked.rogueSsid, ruckusZDWLANRogueSSID);
    const channels = columnMap(walked.rogueChannel, ruckusZDWLANRogueChannel);
    const rssis = columnMap(walked.rogueRssi, ruckusZDWLANRogueSignalStrength);
    const types = columnMap(walked.rogueType, ruckusZDWLANRogueType);

    const indexes = new Set();
    [macs, ssids, channels, rssis, types].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const bssid = fmtMac(macs[idx]); // value column only — never the integer index
      if (!bssid) continue;

      const ssid = str(ssids[idx]);
      const channel = num(channels[idx]);
      const rssi = num(rssis[idx]); // ruckusZDWLANRogueSignalStrength, UNITS dBm

      out.push({
        bssid,
        ssid: ssid || null,
        rssi_dbm: rssi === null ? null : rssi,
        channel: channel === null ? null : channel,
        classification: classifyRogue(types[idx]),
        detecting_ap: null, // no detecting-AP column in ruckusZDWLANRogueTable
      });
    }
  } catch (e) {
    // never throw
    return [];
  }
  return out;
}

const snmpRogueOids = {
  rogueMac: ruckusZDWLANRogueMacAddr,
  rogueSsid: ruckusZDWLANRogueSSID,
  rogueChannel: ruckusZDWLANRogueChannel,
  rogueRssi: ruckusZDWLANRogueSignalStrength,
  rogueType: ruckusZDWLANRogueType,
};

module.exports = {
  name: 'ruckus',
  snmpOids: {
    // AP table (index = 6-octet MAC)
    apMac: ruckusZDWLANAPMacAddr,
    apName: ruckusZDWLANAPDescription,
    apIp: ruckusZDWLANAPIPAddr,
    apModel: ruckusZDWLANAPModel,
    apStatus: ruckusZDWLANAPStatus,
    apClients: ruckusZDWLANAPNumSta,
    apUptime: ruckusZDWLANAPUptime,
    // Per-AP radio stats (index = AP MAC + radioIndex)
    radioType: ruckusZDWLANAPRadioStatsRadioType,
    radioChannel: ruckusZDWLANAPRadioStatsChannel,
    radioChannelUtil: ruckusZDWLANAPRadioStatsResourceUtil,
    radioNumSta: ruckusZDWLANAPRadioStatsNumSta,
    radioTxBytes: ruckusZDWLANAPRadioStatsTxBytes,
    radioRxBytes: ruckusZDWLANAPRadioStatsRxBytes,
    // Per-SSID stats (index = wlan index)
    ssidName: ruckusZDWLANSSID,
    ssidNumSta: ruckusZDWLANNumSta,
    ssidRxBytes: ruckusZDWLANRxBytes,
    ssidTxBytes: ruckusZDWLANTxBytes,
    ssidAuthSuccess: ruckusZDWLANAuthTotal,
    ssidAuthFail: ruckusZDWLANAuthFail,
  },
  snmpRogueOids,
  parseApTable,
  parseClientCounts,
  parseSsids,
  parseRogueAps,
};

'use strict';

// Ruckus (ZoneDirector) wireless parser.
// OIDs from RUCKUS-ZD-WLAN-MIB, ruckusZDSystemAPTable.
// NOTE: column suffixes are best-effort / approximate from the MIB and will
// be validated against real hardware later.

const {
  num,
  str,
  columnMap,
  bandForChannel,
  emptyAp,
  splitRadioIndex,
  bandForRadioIndex,
} = require('./_util');

// ruckusZDSystemAPTable: 1.3.6.1.4.1.25053.1.2.2.1.1.2.2.1
const AP_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.2.1';
const ruckusZDAPMacAddress = AP_BASE + '.1'; // best-effort (often the index too)
const ruckusZDAPName = AP_BASE + '.2'; // best-effort
const ruckusZDAPIpAddress = AP_BASE + '.10'; // best-effort
const ruckusZDAPModel = AP_BASE + '.4'; // best-effort
const ruckusZDAPStatus = AP_BASE + '.3'; // best-effort
const ruckusZDAPNumSta = AP_BASE + '.15'; // best-effort: num associated clients
const ruckusZDAPChannel = AP_BASE + '.11'; // best-effort
const ruckusZDWLANAPUptime = AP_BASE + '.21'; // ruckusZDWLANAPUptime (seconds), index = apIndex

// ruckusZDWLANAPRadioTable: 1.3.6.1.4.1.25053.1.2.2.1.1.2.1.1
// index = apIndex.radioIndex (0 = 2.4GHz, 1 = 5GHz)
const RADIO_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.2.1.1';
const ruckusZDWLANAPRadioNoiseFloor = RADIO_BASE + '.16'; // ruckusZDWLANAPRadioNoiseFloor
const ruckusZDWLANAPRadioChannel = RADIO_BASE + '.17'; // ruckusZDWLANAPRadioChannel
const ruckusZDWLANAPRadioChannelUtil = RADIO_BASE + '.18'; // ruckusZDWLANAPRadioChannelUtil (%)
const ruckusZDWLANAPRadioNumSta = RADIO_BASE + '.19'; // ruckusZDWLANAPRadioNumSta (clients on radio)
const ruckusZDWLANAPRadioTxPkts = RADIO_BASE + '.21'; // ruckusZDWLANAPRadioTxPkts
const ruckusZDWLANAPRadioRxPkts = RADIO_BASE + '.22'; // ruckusZDWLANAPRadioRxPkts
const ruckusZDWLANAPRadioTxBytes = RADIO_BASE + '.25'; // ruckusZDWLANAPRadioTxBytes (→ tx_bytes)
const ruckusZDWLANAPRadioRxBytes = RADIO_BASE + '.26'; // ruckusZDWLANAPRadioRxBytes (→ rx_bytes)

// ruckusZDWLANTable: 1.3.6.1.4.1.25053.1.2.2.1.1.1.1.1
// index = wlan index
const WLAN_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.1.1.1';
const ruckusZDWLANSSID = WLAN_BASE + '.2'; // ruckusZDWLANSSID
const ruckusZDWLANNumSta = WLAN_BASE + '.32'; // ruckusZDWLANNumSta (clients)
const ruckusZDWLANRxBytes = WLAN_BASE + '.34'; // ruckusZDWLANRxBytes (→ bytes_in)
const ruckusZDWLANTxBytes = WLAN_BASE + '.35'; // ruckusZDWLANTxBytes (→ bytes_out)

function mapStatus(v) {
  const n = num(v);
  // 1 = up/connected (approx), other = offline
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('connect') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline') || l.includes('disconnect')) return 'offline';
  }
  return 'unknown';
}

// ── Rogue AP table (RUCKUS-ZD-WLAN-MIB ruckusZDWLANRogueTable) ───────────────
// Base 1.3.6.1.4.1.25053.1.2.2.1.1.3.1.1 ; indexed by rogue MAC/BSSID. Best-effort
// column suffixes from the MIB — validate against real hardware.
const ROGUE_BASE = '1.3.6.1.4.1.25053.1.2.2.1.1.3.1.1';
const ruckusZDRogueMac = ROGUE_BASE + '.1';      // rogue MAC / BSSID (often the index too)
const ruckusZDRogueSSID = ROGUE_BASE + '.2';     // rogue SSID
const ruckusZDRogueChannel = ROGUE_BASE + '.4';  // channel
const ruckusZDRogueRSSI = ROGUE_BASE + '.5';     // RSSI (dBm)
const ruckusZDRogueType = ROGUE_BASE + '.6';     // type (rogue / known)
const ruckusZDRogueIsActive = ROGUE_BASE + '.7'; // best-effort active flag
const ruckusZDRogueDetectingAP = ROGUE_BASE + '.8'; // detecting AP MAC (best-effort)

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

// Normalise a Ruckus rogue type to the shared classification set.
// RUCKUS-ZD-WLAN-MIB rogue type INTEGER (best-effort): 1 known/recognized,
// 2 rogue, 3 malicious/spoof, 4 interfering. Strings handled too.
function classifyRogue(v) {
  const n = num(v);
  if (n !== null) {
    if (n === 1) return 'friendly';
    if (n === 2) return 'rogue';
    if (n === 3) return 'malicious';
    if (n === 4) return 'interfering';
  }
  const s = (str(v) || '').toLowerCase();
  if (s) {
    if (s.includes('known') || s.includes('recogn') || s.includes('friend')) return 'friendly';
    if (s.includes('malicious') || s.includes('spoof') || s.includes('threat')) return 'malicious';
    if (s.includes('interfer')) return 'interfering';
    if (s.includes('rogue')) return 'rogue';
  }
  return 'unclassified';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const macs = columnMap(walked.apMac, ruckusZDAPMacAddress);
    const names = columnMap(walked.apName, ruckusZDAPName);
    const ips = columnMap(walked.apIp, ruckusZDAPIpAddress);
    const models = columnMap(walked.apModel, ruckusZDAPModel);
    const statuses = columnMap(walked.apStatus, ruckusZDAPStatus);
    const clients = columnMap(walked.apClients, ruckusZDAPNumSta);
    const channels = columnMap(walked.apChannel, ruckusZDAPChannel);

    const indexes = new Set();
    [macs, names, ips, models, statuses, clients, channels].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    // Map of constructed APs keyed by _index so radio metrics can correlate back.
    const byIndex = new Map();

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.mac_address = str(macs[idx]);
      ap.name = str(names[idx]) || ap.mac_address || idx;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);

      const ch = num(channels[idx]);
      const band = bandForChannel(ch);
      if (band === '2g') ap.radio_2g_channel = ch;
      else if (band === '5g') ap.radio_5g_channel = ch;
      else if (band === '6g') ap.radio_6g_channel = ch;

      // Total clients from the AP table; nullable so a per-radio fallback applies.
      ap.clients_total = num(clients[idx]);

      byIndex.set(idx, ap);
      out.push(ap);
    }

    // ── Correlate the per-radio table onto each AP ────────────────────────────
    // Radio index = apIndex.radioIndex; apKey must match ap._index.
    const noiseFloors = columnMap(walked.radioNoiseFloor, ruckusZDWLANAPRadioNoiseFloor);
    const radioChannels = columnMap(walked.radioChannel, ruckusZDWLANAPRadioChannel);
    const channelUtils = columnMap(walked.radioChannelUtil, ruckusZDWLANAPRadioChannelUtil);
    const radioRxBytes = columnMap(walked.radioRxBytes, ruckusZDWLANAPRadioRxBytes);
    const radioTxBytes = columnMap(walked.radioTxBytes, ruckusZDWLANAPRadioTxBytes);

    // Noise floor → noise_floor_2g / noise_floor_5g
    for (const ridx of Object.keys(noiseFloors)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(noiseFloors[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.noise_floor_2g = v;
      else if (band === '5g') ap.noise_floor_5g = v;
    }

    // Channel util → radio_2g_util_pct / radio_5g_util_pct
    for (const ridx of Object.keys(channelUtils)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(channelUtils[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.radio_2g_util_pct = v;
      else if (band === '5g') ap.radio_5g_util_pct = v;
    }

    // Per-radio clients (ruckusZDWLANAPRadioNumSta) → clients_2g / clients_5g
    const radioNumStas = columnMap(walked.radioNumSta, ruckusZDWLANAPRadioNumSta);
    for (const ridx of Object.keys(radioNumStas)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(radioNumStas[ridx]);
      if (v === null) continue;
      if (band === '2g') ap.clients_2g = v;
      else if (band === '5g') ap.clients_5g = v;
    }

    // Channel → radio_2g_channel / radio_5g_channel (only if not already set)
    for (const ridx of Object.keys(radioChannels)) {
      const { apKey, radioKey } = splitRadioIndex(ridx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(radioChannels[ridx]);
      if (v === null) continue;
      if (band === '2g' && ap.radio_2g_channel === null) ap.radio_2g_channel = v;
      else if (band === '5g' && ap.radio_5g_channel === null) ap.radio_5g_channel = v;
    }

    // Rx bytes → ACCUMULATE into ap.rx_bytes (sum across radios, from null)
    for (const ridx of Object.keys(radioRxBytes)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(radioRxBytes[ridx]);
      if (v === null) continue;
      ap.rx_bytes = (ap.rx_bytes === null ? 0 : ap.rx_bytes) + v;
    }

    // Tx bytes → ACCUMULATE into ap.tx_bytes (sum across radios, from null)
    for (const ridx of Object.keys(radioTxBytes)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(radioTxBytes[ridx]);
      if (v === null) continue;
      ap.tx_bytes = (ap.tx_bytes === null ? 0 : ap.tx_bytes) + v;
    }

    // Uptime → ap.uptime_seconds (index = apKey == _index)
    const uptimes = columnMap(walked.apUptime, ruckusZDWLANAPUptime);
    for (const idx of Object.keys(uptimes)) {
      const ap = byIndex.get(idx);
      if (!ap) continue;
      const v = num(uptimes[idx]);
      if (v === null) continue;
      ap.uptime_seconds = v;
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
  const out = [];
  try {
    walked = walked || {};
    const clients = columnMap(walked.apClients, ruckusZDAPNumSta);
    for (const idx of Object.keys(clients)) {
      const c = num(clients[idx]);
      out.push({ apKey: idx, clients: c === null ? 0 : c });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

function parseSsids(walked) {
  const out = [];
  try {
    walked = walked || {};
    const ssids = columnMap(walked.ssidName, ruckusZDWLANSSID);
    const numStas = columnMap(walked.ssidNumSta, ruckusZDWLANNumSta);
    const rxBytes = columnMap(walked.ssidRxBytes, ruckusZDWLANRxBytes);
    const txBytes = columnMap(walked.ssidTxBytes, ruckusZDWLANTxBytes);

    for (const idx of Object.keys(ssids)) {
      const ssidName = str(ssids[idx]);
      if (!ssidName) continue; // skip rows without an SSID name
      const clients = num(numStas[idx]);
      out.push({
        ssid_name: ssidName,
        status: 'up',
        clients_total: clients === null ? 0 : clients,
        bytes_in: num(rxBytes[idx]),
        bytes_out: num(txBytes[idx]),
        auth_successes: 0, // no OID exposed — leave 0
        auth_failures: 0, // no OID exposed — leave 0
      });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

// Parse the rogue AP table (ruckusZDWLANRogueTable). Indexed by rogue MAC; when
// the MAC value column is empty the table index is the MAC. Never throws.
function parseRogueAps(walked) {
  const out = [];
  try {
    walked = walked || {};

    const macs = columnMap(walked.rogueMac, ruckusZDRogueMac);
    const ssids = columnMap(walked.rogueSsid, ruckusZDRogueSSID);
    const channels = columnMap(walked.rogueChannel, ruckusZDRogueChannel);
    const rssis = columnMap(walked.rogueRssi, ruckusZDRogueRSSI);
    const types = columnMap(walked.rogueType, ruckusZDRogueType);
    const detectors = columnMap(walked.rogueDetector, ruckusZDRogueDetectingAP);

    const indexes = new Set();
    [macs, ssids, channels, rssis, types].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const bssid = fmtMac(macs[idx]) || fmtMac(idx);
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
  rogueMac: ruckusZDRogueMac,
  rogueSsid: ruckusZDRogueSSID,
  rogueChannel: ruckusZDRogueChannel,
  rogueRssi: ruckusZDRogueRSSI,
  rogueType: ruckusZDRogueType,
  rogueIsActive: ruckusZDRogueIsActive,
  rogueDetector: ruckusZDRogueDetectingAP,
};

module.exports = {
  name: 'ruckus',
  snmpOids: {
    apMac: ruckusZDAPMacAddress,
    apName: ruckusZDAPName,
    apIp: ruckusZDAPIpAddress,
    apModel: ruckusZDAPModel,
    apStatus: ruckusZDAPStatus,
    apClients: ruckusZDAPNumSta,
    apChannel: ruckusZDAPChannel,
    apUptime: ruckusZDWLANAPUptime,
    // Per-AP radio stats (index = apIndex.radioIndex)
    radioNoiseFloor: ruckusZDWLANAPRadioNoiseFloor,
    radioChannel: ruckusZDWLANAPRadioChannel,
    radioChannelUtil: ruckusZDWLANAPRadioChannelUtil,
    radioNumSta: ruckusZDWLANAPRadioNumSta,
    radioTxPkts: ruckusZDWLANAPRadioTxPkts,
    radioRxPkts: ruckusZDWLANAPRadioRxPkts,
    radioTxBytes: ruckusZDWLANAPRadioTxBytes,
    radioRxBytes: ruckusZDWLANAPRadioRxBytes,
    // Per-SSID stats (index = wlan index)
    ssidName: ruckusZDWLANSSID,
    ssidNumSta: ruckusZDWLANNumSta,
    ssidRxBytes: ruckusZDWLANRxBytes,
    ssidTxBytes: ruckusZDWLANTxBytes,
  },
  snmpRogueOids,
  parseApTable,
  parseClientCounts,
  parseSsids,
  parseRogueAps,
};

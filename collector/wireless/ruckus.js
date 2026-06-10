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

      const c = num(clients[idx]);
      ap.clients_total = c === null ? 0 : c;

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
  parseApTable,
  parseClientCounts,
  parseSsids,
};

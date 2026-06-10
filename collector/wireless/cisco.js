'use strict';

// Cisco wireless parser.
// OIDs from CISCO-LWAPP-AP-MIB and AIRESPACE-WIRELESS-MIB (legacy WLC).
// NOTE: column suffixes are best-effort / approximate from the MIBs and will
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

// cLApTable (CISCO-LWAPP-AP-MIB): 1.3.6.1.4.1.9.9.513.1.1.1
const CLAP_BASE = '1.3.6.1.4.1.9.9.513.1.1.1.1';
const cLApName = CLAP_BASE + '.5'; // best-effort
const cLApIpAddress = CLAP_BASE + '.19'; // best-effort
const cLApModel = CLAP_BASE + '.16'; // best-effort

// bsnAPTable (AIRESPACE-WIRELESS-MIB, legacy WLC): 1.3.6.1.4.1.14179.2.2.1.1
const BSN_BASE = '1.3.6.1.4.1.14179.2.2.1.1';
const bsnAPName = BSN_BASE + '.3';
const bsnApIpAddress = BSN_BASE + '.19'; // best-effort
const bsnAPModel = BSN_BASE + '.16';
const bsnAPOperationStatus = BSN_BASE + '.6';
const bsnApAssociatedClientCount = BSN_BASE + '.38'; // best-effort

// bsnAPIfTable radio stats base (best-effort): channel column.
// index = apIndex.radioIndex (0 = 2.4GHz, 1 = 5GHz).
const BSN_IF_BASE = '1.3.6.1.4.1.14179.2.2.2.1';
const bsnAPIfPhyChannelNumber = BSN_IF_BASE + '.4'; // best-effort
// Per-radio Rx/Tx load utilization (used to approximate a retry_rate per band).
const bsnAPIfLoadRxUtilization = BSN_IF_BASE + '.31'; // bsnAPIfLoadRxUtilization (AIRESPACE-WIRELESS-MIB)
const bsnAPIfLoadTxUtilization = BSN_IF_BASE + '.32'; // bsnAPIfLoadTxUtilization (AIRESPACE-WIRELESS-MIB)

// bsnApDot11Table (AIRESPACE-WIRELESS-MIB): 1.3.6.1.4.1.14179.2.2.13.1
// index = apIndex.radioIndex (0 = 2.4GHz, 1 = 5GHz).
const BSN_DOT11_BASE = '1.3.6.1.4.1.14179.2.2.13.1';
const bsnApDot11LoadChannelUtilization = BSN_DOT11_BASE + '.22'; // bsnApDot11LoadChannelUtilization (channel util %)
const bsnApDot11LoadNumAssociations = BSN_DOT11_BASE + '.19'; // bsnApDot11LoadNumAssociations (clients on the radio)
const bsnApDot11QosNoiseFloor = BSN_DOT11_BASE + '.18'; // bsnApDot11QosNoiseFloor (noise floor dBm, negative)

// bsnDot11EssTable (AIRESPACE-WIRELESS-MIB): 1.3.6.1.4.1.14179.2.1.1.1
// index = ess index (WLAN id).
const BSN_ESS_BASE = '1.3.6.1.4.1.14179.2.1.1.1';
const bsnDot11EsSsid = BSN_ESS_BASE + '.1'; // bsnDot11EsSsid (SSID name)
const bsnDot11EssTotalAssociations = BSN_ESS_BASE + '.38'; // bsnDot11EssTotalAssociations (client count)
const bsnDot11EssAdminStatus = BSN_ESS_BASE + '.8'; // bsnDot11EssAdminStatus (1 = up, 0 = down)

// bsnDot11EssWlanStatTable (AIRESPACE-WIRELESS-MIB): 1.3.6.1.4.1.14179.2.1.6.1
// index = ess index (correlates to bsnDot11EssTable).
const BSN_ESS_STAT_BASE = '1.3.6.1.4.1.14179.2.1.6.1';
const bsnDot11EssWlanIfInOctets = BSN_ESS_STAT_BASE + '.1'; // bsnDot11EssWlanIfInOctets (→ bytes_in)
const bsnDot11EssWlanIfOutOctets = BSN_ESS_STAT_BASE + '.2'; // bsnDot11EssWlanIfOutOctets (→ bytes_out)

// bsnAuthFailureCount (AIRESPACE-WIRELESS-MIB): best-effort per-SSID auth failures.
const bsnAuthFailureCount = '1.3.6.1.4.1.14179.2.1.13.1.1.7'; // bsnAuthFailureCount

function mapStatus(v) {
  const n = num(v);
  // bsnAPOperationStatus: 1 = associated/up, 2 = disassociating, 3 = downloading
  if (n === 1) return 'online';
  if (n === 2 || n === 3) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('associat') || l.includes('online')) return 'online';
    if (l.includes('down') || l.includes('offline')) return 'offline';
  }
  return 'unknown';
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};

    // Prefer modern cLApTable; merge legacy bsnAPTable by index when present.
    const cnames = columnMap(walked.cLApName, cLApName);
    const cips = columnMap(walked.cLApIp, cLApIpAddress);
    const cmodels = columnMap(walked.cLApModel, cLApModel);

    const bnames = columnMap(walked.bsnAPName, bsnAPName);
    const bips = columnMap(walked.bsnApIp, bsnApIpAddress);
    const bmodels = columnMap(walked.bsnAPModel, bsnAPModel);
    const bstatus = columnMap(walked.bsnAPStatus, bsnAPOperationStatus);
    const bclients = columnMap(walked.bsnApClients, bsnApAssociatedClientCount);
    const bchannel = columnMap(walked.bsnApChannel, bsnAPIfPhyChannelNumber);

    const indexes = new Set();
    [cnames, cips, cmodels, bnames, bips, bmodels, bstatus, bclients, bchannel].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(cnames[idx]) || str(bnames[idx]) || idx;
      ap.ip_address = str(cips[idx]) || str(bips[idx]);
      ap.model = str(cmodels[idx]) || str(bmodels[idx]);
      ap.status = mapStatus(bstatus[idx]);

      const ch = num(bchannel[idx]);
      const band = bandForChannel(ch);
      if (band === '2g') ap.radio_2g_channel = ch;
      else if (band === '5g') ap.radio_5g_channel = ch;
      else if (band === '6g') ap.radio_6g_channel = ch;

      const c = num(bclients[idx]);
      ap.clients_total = c === null ? 0 : c;

      out.push(ap);
    }

    // ── Correlate the per-radio bsnApDot11Table / bsnAPIfTable metrics onto the
    //    constructed APs. Radio tables are indexed by apIndex.radioIndex, so we
    //    split the index, resolve the band, and find the matching AP by _index.
    const byIndex = new Map();
    for (const ap of out) byIndex.set(ap._index, ap);

    // Noise floor (dBm, negative) → noise_floor_2g / noise_floor_5g.
    const noiseCol = columnMap(walked.bsnApNoiseFloor, bsnApDot11QosNoiseFloor);
    for (const idx of Object.keys(noiseCol)) {
      const { apKey, radioKey } = splitRadioIndex(idx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(noiseCol[idx]);
      if (v === null) continue;
      if (band === '2g') ap.noise_floor_2g = v;
      else if (band === '5g') ap.noise_floor_5g = v;
    }

    // Channel utilization (%) → radio_2g_util_pct / radio_5g_util_pct.
    // Only set when not already populated (never overwrite / default to 0).
    const utilCol = columnMap(walked.bsnApChannelUtil, bsnApDot11LoadChannelUtilization);
    for (const idx of Object.keys(utilCol)) {
      const { apKey, radioKey } = splitRadioIndex(idx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(utilCol[idx]);
      if (v === null) continue;
      if (band === '2g' && ap.radio_2g_util_pct === null) ap.radio_2g_util_pct = v;
      else if (band === '5g' && ap.radio_5g_util_pct === null) ap.radio_5g_util_pct = v;
    }

    // Retry rate approximation: Cisco does not expose a true per-radio retry %
    // here, so we approximate it as the GREATER of the per-radio Rx/Tx load
    // utilization (best-effort — flagged as an approximation).
    const rxUtilCol = columnMap(walked.bsnApIfRxUtil, bsnAPIfLoadRxUtilization);
    const txUtilCol = columnMap(walked.bsnApIfTxUtil, bsnAPIfLoadTxUtilization);
    const retryIdxs = new Set([...Object.keys(rxUtilCol), ...Object.keys(txUtilCol)]);
    for (const idx of retryIdxs) {
      const { apKey, radioKey } = splitRadioIndex(idx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const rx = num(rxUtilCol[idx]);
      const tx = num(txUtilCol[idx]);
      if (rx === null && tx === null) continue;
      // best-effort approximation of retry_rate per band: max(Rx util, Tx util).
      const approx = Math.max(rx === null ? -Infinity : rx, tx === null ? -Infinity : tx);
      if (!Number.isFinite(approx)) continue;
      if (band === '2g') ap.retry_rate_2g = approx;
      else if (band === '5g') ap.retry_rate_5g = approx;
    }

    // rx_errors_*, tx_errors_*, rx_bytes, tx_bytes are NOT available per-AP on
    // Cisco here — they remain null (defaulted by emptyAp()).
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  const out = [];
  try {
    walked = walked || {};
    const clients = columnMap(walked.bsnApClients, bsnApAssociatedClientCount);
    for (const idx of Object.keys(clients)) {
      const c = num(clients[idx]);
      out.push({ apKey: idx, clients: c === null ? 0 : c });
    }
  } catch (e) {
    // never throw
  }
  return out;
}

// Parse per-SSID (WLAN) stats from bsnDot11EssTable + bsnDot11EssWlanStatTable.
// Correlates the two tables by ess index (WLAN id). Never throws.
function parseSsids(walked) {
  const out = [];
  try {
    walked = walked || {};

    const ssids = columnMap(walked.bsnEssSsid, bsnDot11EsSsid);
    const assocs = columnMap(walked.bsnEssAssoc, bsnDot11EssTotalAssociations);
    const admins = columnMap(walked.bsnEssAdmin, bsnDot11EssAdminStatus);
    const inOctets = columnMap(walked.bsnEssInOctets, bsnDot11EssWlanIfInOctets);
    const outOctets = columnMap(walked.bsnEssOutOctets, bsnDot11EssWlanIfOutOctets);
    const authFails = columnMap(walked.bsnAuthFailures, bsnAuthFailureCount);

    const indexes = new Set();
    [ssids, assocs, admins, inOctets, outOctets].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ssidName = str(ssids[idx]);
      if (!ssidName) continue; // skip rows with no SSID name

      // adminStatus: 1 → 'up', else 'down'; default 'up' when absent.
      let status = 'up';
      if (admins[idx] !== undefined) {
        status = num(admins[idx]) === 1 ? 'up' : 'down';
      }

      const clients = num(assocs[idx]);
      const bytesIn = num(inOctets[idx]);
      const bytesOut = num(outOctets[idx]);
      // best-effort: map bsnAuthFailureCount onto this SSID row by matching index.
      const fails = num(authFails[idx]);

      out.push({
        ssid_name: ssidName,
        status: status,
        clients_total: clients === null ? 0 : clients,
        bytes_in: bytesIn,
        bytes_out: bytesOut,
        auth_successes: 0, // no OID available — leave 0
        auth_failures: fails === null ? 0 : fails,
      });
    }
  } catch (e) {
    // never throw
    return [];
  }
  return out;
}

module.exports = {
  name: 'cisco',
  snmpOids: {
    cLApName: cLApName,
    cLApIp: cLApIpAddress,
    cLApModel: cLApModel,
    bsnAPName: bsnAPName,
    bsnApIp: bsnApIpAddress,
    bsnAPModel: bsnAPModel,
    bsnAPStatus: bsnAPOperationStatus,
    bsnApClients: bsnApAssociatedClientCount,
    bsnApChannel: bsnAPIfPhyChannelNumber,
    // Per-radio metrics (bsnApDot11Table / bsnAPIfTable, index apIndex.radioIndex).
    bsnApNoiseFloor: bsnApDot11QosNoiseFloor,
    bsnApChannelUtil: bsnApDot11LoadChannelUtilization,
    bsnApDot11Clients: bsnApDot11LoadNumAssociations,
    bsnApIfRxUtil: bsnAPIfLoadRxUtilization,
    bsnApIfTxUtil: bsnAPIfLoadTxUtilization,
    // Per-SSID (bsnDot11EssTable / bsnDot11EssWlanStatTable, index = ess index).
    bsnEssSsid: bsnDot11EsSsid,
    bsnEssAssoc: bsnDot11EssTotalAssociations,
    bsnEssAdmin: bsnDot11EssAdminStatus,
    bsnEssInOctets: bsnDot11EssWlanIfInOctets,
    bsnEssOutOctets: bsnDot11EssWlanIfOutOctets,
    bsnAuthFailures: bsnAuthFailureCount,
  },
  parseApTable,
  parseClientCounts,
  parseSsids,
};

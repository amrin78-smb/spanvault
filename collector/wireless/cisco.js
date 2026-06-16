'use strict';

// Cisco wireless parser.
// OIDs from CISCO-LWAPP-AP-MIB and AIRESPACE-WIRELESS-MIB (legacy WLC).
// NOTE: column suffixes are best-effort / approximate from the MIBs and will
// be validated against real hardware later.

const {
  num,
  str,
  columnMap,
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

// ── Rogue AP table (bsnRogueAPTable, AIRESPACE-WIRELESS-MIB) ─────────────────
// Base 1.3.6.1.4.1.14179.2.1.7 ; the table itself is ...2.1.7.1, columns ...2.1.7.1.1.x
// Index = bsnRogueAPDot11MacAddress (6-octet MAC). Best-effort column suffixes
// from the MIB — validate against real hardware.
const BSN_ROGUE_BASE = '1.3.6.1.4.1.14179.2.1.7.1.1';
const bsnRogueAPDot11MacAddress = BSN_ROGUE_BASE + '.1'; // rogue radio MAC (BSSID)
const bsnRogueAPSsid = BSN_ROGUE_BASE + '.2';            // bsnRogueAPSsid
const bsnRogueAPState = BSN_ROGUE_BASE + '.5';           // bsnRogueAPState (class/state)
const bsnRogueAPClassType = BSN_ROGUE_BASE + '.24';      // bsnRogueAPClassType (best-effort)
// First / detecting AP reporting this rogue, plus the rogue's RSSI and channel as
// seen by that AP. These live on the per-detecting-AP entry (bsnRogueAPAirespaceAPTable
// / bsnRogueAPFirstReportedBy). Index there is rogueMAC.detectingApMAC; we read the
// best-of column values keyed by the rogue MAC prefix.
const bsnRogueAPChannel = BSN_ROGUE_BASE + '.14';        // best-effort channel
const bsnRogueAPRssi = BSN_ROGUE_BASE + '.13';           // best-effort RSSI (dBm)
const bsnRogueAPFirstReportedApMac = BSN_ROGUE_BASE + '.20'; // best-effort detecting AP MAC

// Format a 6-octet MAC (Buffer) or dotted-decimal index as colon-hex.
function fmtMac(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    if (v.length === 0) return null;
    return Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join(':');
  }
  const s = String(v).trim();
  if (!s) return null;
  // Already colon/dash-hex.
  if (/^[0-9a-f]{2}([:-][0-9a-f]{2})+$/i.test(s)) return s.replace(/-/g, ':').toLowerCase();
  // Dotted-decimal octets (e.g. "0.27.211.5.6.7" from an OID index) → colon-hex.
  if (/^\d+(\.\d+){5}$/.test(s)) {
    return s.split('.').map((d) => (Number(d) & 0xff).toString(16).padStart(2, '0')).join(':');
  }
  // Bare hex string (e.g. "001bd3050607") → colon-hex.
  if (/^[0-9a-f]{12}$/i.test(s)) return s.match(/.{2}/g).join(':').toLowerCase();
  return s;
}

// Normalise a Cisco bsnRogueAPState / class to the shared classification set.
// AIRESPACE-WIRELESS-MIB bsnRogueAPState INTEGER:
//   1 initializing, 2 pending, 3 alert/lrad, 4 detected-lrad,
//   5 known, 6 acknowledged, 7 contained, 8 threat, 9 unknown-contained,
//   10 contained-pending. bsnRogueAPClassType (when present): 1 friendly,
//   2 malicious, 3 unclassified, 4 custom.
function classifyRogue(stateV, classV) {
  const cls = num(classV);
  if (cls === 1) return 'friendly';
  if (cls === 2) return 'malicious';
  if (cls === 3) return 'unclassified';

  const st = num(stateV);
  if (st !== null) {
    if (st === 5 || st === 6) return 'friendly';        // known / acknowledged
    if (st === 7 || st === 8 || st === 9 || st === 10) return 'malicious'; // contained / threat
    if (st === 3 || st === 4) return 'rogue';           // alert / detected
    if (st === 1 || st === 2) return 'unclassified';    // initializing / pending
  }

  const s = (str(stateV) || str(classV) || '').toLowerCase();
  if (s) {
    if (s.includes('friend') || s.includes('known') || s.includes('acknowledg')) return 'friendly';
    if (s.includes('malicious') || s.includes('threat') || s.includes('contain')) return 'malicious';
    if (s.includes('interfer')) return 'interfering';
    if (s.includes('rogue') || s.includes('alert') || s.includes('detect')) return 'rogue';
  }
  return 'unclassified';
}

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

    // NOTE: bsnAPIfPhyChannelNumber is a PER-RADIO column (index apIndex.radioIndex)
    // and is correlated below — NOT merged into the AP-index set, which would both
    // create phantom AP rows and never map a channel back to its band.
    const indexes = new Set();
    [cnames, cips, cmodels, bnames, bips, bmodels, bstatus, bclients].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    const byIndex = new Map();
    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(cnames[idx]) || str(bnames[idx]) || idx;
      ap.ip_address = str(cips[idx]) || str(bips[idx]);
      ap.model = str(cmodels[idx]) || str(bmodels[idx]);
      ap.status = mapStatus(bstatus[idx]);
      // Total clients from the AP table; kept nullable for a per-radio fallback.
      ap.clients_total = num(bclients[idx]);
      out.push(ap);
      byIndex.set(idx, ap);
    }

    // ── Correlate per-radio metrics onto the constructed APs. Radio tables are
    //    indexed apIndex.radioIndex; split the index, resolve the band (0=2.4G,
    //    1=5G), and find the matching AP by _index.

    // Channel (bsnAPIfPhyChannelNumber) → radio_2g_channel / radio_5g_channel.
    const chanCol = columnMap(walked.bsnApChannel, bsnAPIfPhyChannelNumber);
    for (const idx of Object.keys(chanCol)) {
      const { apKey, radioKey } = splitRadioIndex(idx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(chanCol[idx]);
      if (v === null) continue;
      if (band === '2g') ap.radio_2g_channel = v;
      else if (band === '5g') ap.radio_5g_channel = v;
    }

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

    // Per-radio clients (bsnApDot11LoadNumAssociations) → clients_2g / clients_5g.
    const radioClientsCol = columnMap(walked.bsnApDot11Clients, bsnApDot11LoadNumAssociations);
    for (const idx of Object.keys(radioClientsCol)) {
      const { apKey, radioKey } = splitRadioIndex(idx);
      const band = bandForRadioIndex(radioKey);
      if (!band) continue;
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(radioClientsCol[idx]);
      if (v === null) continue;
      if (band === '2g') ap.clients_2g = v;
      else if (band === '5g') ap.clients_5g = v;
    }

    // Total clients: fall back to the per-radio sum when the AP table omitted it.
    for (const ap of out) {
      if (ap.clients_total === null) ap.clients_total = (ap.clients_2g || 0) + (ap.clients_5g || 0) + (ap.clients_6g || 0);
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

// Parse the rogue/unmanaged AP table (bsnRogueAPTable). The main columns are
// indexed by the rogue MAC; RSSI/channel/detecting-AP may be on a per-detecting-AP
// sub-table indexed "<rogueMAC>.<detectingApMAC>", so we correlate those back to
// the rogue MAC by longest matching index prefix. Never throws.
function parseRogueAps(walked) {
  const out = [];
  try {
    walked = walked || {};

    const macs = columnMap(walked.rogueMac, bsnRogueAPDot11MacAddress);
    const ssids = columnMap(walked.rogueSsid, bsnRogueAPSsid);
    const states = columnMap(walked.rogueState, bsnRogueAPState);
    const classes = columnMap(walked.rogueClass, bsnRogueAPClassType);
    const channels = columnMap(walked.rogueChannel, bsnRogueAPChannel);
    const rssis = columnMap(walked.rogueRssi, bsnRogueAPRssi);
    const detectors = columnMap(walked.rogueDetector, bsnRogueAPFirstReportedApMac);

    // Helper: given a per-rogue column keyed by either "<rogueIdx>" or
    // "<rogueIdx>.<extra>", find the value whose index equals or starts with idx.
    function pick(col, idx) {
      if (col[idx] !== undefined) return col[idx];
      const prefix = idx + '.';
      for (const k of Object.keys(col)) {
        if (k === idx || k.startsWith(prefix)) return col[k];
      }
      return undefined;
    }

    // The set of rogue rows: primary index source is the MAC column; fall back to
    // SSID/state index keys when the MAC column came back empty.
    const indexes = new Set();
    [macs, ssids, states, classes].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      // BSSID: prefer the MAC value column; otherwise the index itself is the MAC.
      const bssid = fmtMac(macs[idx]) || fmtMac(idx);
      if (!bssid) continue;

      const ssid = str(pick(ssids, idx));
      const rssi = num(pick(rssis, idx));
      const channel = num(pick(channels, idx));
      const classification = classifyRogue(pick(states, idx), pick(classes, idx));
      const detecting_ap = fmtMac(pick(detectors, idx));

      out.push({
        bssid,
        ssid: ssid || null,
        rssi_dbm: rssi === null ? null : rssi,
        channel: channel === null ? null : channel,
        classification,
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
  rogueMac: bsnRogueAPDot11MacAddress,
  rogueSsid: bsnRogueAPSsid,
  rogueState: bsnRogueAPState,
  rogueClass: bsnRogueAPClassType,
  rogueChannel: bsnRogueAPChannel,
  rogueRssi: bsnRogueAPRssi,
  rogueDetector: bsnRogueAPFirstReportedApMac,
};

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
  snmpRogueOids,
  parseApTable,
  parseClientCounts,
  parseSsids,
  parseRogueAps,
};

'use strict';

// Cisco WLC (AireOS) wireless parser.
// OIDs verified against AIRESPACE-WIRELESS-MIB (+ CISCO-LWAPP-AP-MIB) in the
// 2026-07 MIB audit. No Cisco hardware in the lab — items flagged
// "validate against real hardware" are MIB-verified but not live-verified.
//
// Tables used (all under 1.3.6.1.4.1.14179):
//   • bsnAPTable                   ...2.2.1.1  — one row per AP. INDEX =
//     bsnAPDot3MacAddress (the AP's ETHERNET MAC → 6 dotted sub-identifiers).
//   • bsnAPIfTable                 ...2.2.2.1  — per radio. INDEX = {Dot3 MAC,
//     bsnAPIfSlotId}. Radio type (band) + current channel.
//   • bsnAPIfLoadParametersTable   ...2.2.13.1 — per radio. INDEX = {Dot3 MAC,
//     slot}. Rx/Tx/channel utilization (0..100) + per-radio client count.
//   • bsnAPIfChannelNoiseInfoTable ...2.2.15.1 — per radio PER SCANNED CHANNEL.
//     INDEX = {Dot3 MAC (6), slot, channel} — 8 sub-identifiers.
//   • bsnDot11EssTable             ...2.1.1.1  — per WLAN/SSID. INDEX = ESS index.
//   • bsnRogueAPTable              ...2.1.7.1  — per rogue. INDEX = rogue MAC.
//
// The CISCO-LWAPP-AP-MIB cLApTable (1.3.6.1.4.1.9.9.513.1.1.1) is deliberately
// NOT walked any more:
//   – ...513.1.1.1.1.19 is cLApFailoverPriority (enum 1..4), NOT an IP address;
//   – ...513.1.1.1.1.16 is cLApLastRebootReason (enum), NOT a model string;
//   – cLApTable is indexed by the AP's RADIO-base MAC while bsnAPTable is
//     indexed by the ETHERNET (Dot3) MAC, so "merging" the two tables by
//     identical index materialized a duplicate ghost AP (status unknown,
//     clients 0) for every physical AP and made its DB row flap.
// After dropping the two mis-mapped columns only cLApName remained, and
// bsnAPName carries the same value — so AP rows are built from bsnAPTable only.
//
// NOT available in AIRESPACE-WIRELESS-MIB (left null, never faked):
//   • per-WLAN byte counters — "...2.1.6.1" is the PER-CLIENT
//     bsnMobileStationStatsTable (indexed by client MAC), not a per-ESS table;
//   • per-SSID auth-failure counters — ...2.1.13 is a per-client, by-username
//     table, not per-WLAN;
//   • AP tx power in dBm — bsnAPIfPhyTxPowerLevel is a discrete power LEVEL
//     (1..8), not dBm, so tx_power_2g/5g stay null;
//   • per-AP rx/tx error and byte counters.

const {
  num,
  counterNum,
  str,
  columnMap,
  emptyAp,
  splitRadioIndex,
  bandForRadioIndex,
  bandForChannel,
} = require('./_util');

// ── bsnAPTable (AIRESPACE-WIRELESS-MIB): 1.3.6.1.4.1.14179.2.2.1.1 ───────────
// INDEX = bsnAPDot3MacAddress (Ethernet MAC, 6 dotted-decimal sub-identifiers).
const BSN_BASE = '1.3.6.1.4.1.14179.2.2.1.1';
const bsnAPName = BSN_BASE + '.3';            // bsnAPName (DisplayString)
const bsnAPOperationStatus = BSN_BASE + '.6'; // associated(1)/disassociating(2)/downloading(3)
const bsnAPSoftwareVersion = BSN_BASE + '.8'; // bsnAPSoftwareVersion → firmware_version
const bsnAPModel = BSN_BASE + '.16';          // bsnAPModel (DisplayString)
const bsnAPSerialNumber = BSN_BASE + '.17';   // bsnAPSerialNumber → serial_number
const bsnApIpAddress = BSN_BASE + '.19';      // bsnApIpAddress (IpAddress)

// ── bsnAPIfTable: 1.3.6.1.4.1.14179.2.2.2.1 — INDEX = {Dot3 MAC, slot} ───────
const BSN_IF_BASE = '1.3.6.1.4.1.14179.2.2.2.1';
// bsnAPIfType INTEGER { dot11b(1), dot11a(2), uwb(4), dot116ghz(6),
// dot11xor56ghz(7) } — the authoritative band source (slot number is NOT a
// reliable band on XOR / dual-5G / 6 GHz APs).
const bsnAPIfType = BSN_IF_BASE + '.2';
const bsnAPIfPhyChannelNumber = BSN_IF_BASE + '.4'; // current operating channel

// ── bsnAPIfLoadParametersTable: 1.3.6.1.4.1.14179.2.2.13.1 ───────────────────
// INDEX = {Dot3 MAC, slot}. All INTEGER 0..100 except NumOfClients (Integer32).
const BSN_LOAD_BASE = '1.3.6.1.4.1.14179.2.2.13.1';
const bsnAPIfLoadRxUtilization = BSN_LOAD_BASE + '.1';      // bsnAPIfLoadRxUtilization
const bsnAPIfLoadTxUtilization = BSN_LOAD_BASE + '.2';      // bsnAPIfLoadTxUtilization
const bsnAPIfLoadChannelUtilization = BSN_LOAD_BASE + '.3'; // bsnAPIfLoadChannelUtilization
const bsnAPIfLoadNumOfClients = BSN_LOAD_BASE + '.4';       // bsnAPIfLoadNumOfClients

// ── bsnAPIfChannelNoiseInfoTable: 1.3.6.1.4.1.14179.2.2.15.1 ─────────────────
// INDEX = {Dot3 MAC (6), slot, channel} — 8 sub-identifiers, one row per
// SCANNED channel. bsnAPIfDBNoisePower is Integer32 dBm (already negative).
const bsnAPIfDBNoisePower = '1.3.6.1.4.1.14179.2.2.15.1.21';

// ── bsnDot11EssTable: 1.3.6.1.4.1.14179.2.1.1.1 — INDEX = ESS (WLAN) index ───
const BSN_ESS_BASE = '1.3.6.1.4.1.14179.2.1.1.1';
const bsnDot11EssSsid = BSN_ESS_BASE + '.2';        // bsnDot11EssSsid (DisplayString)
const bsnDot11EssAdminStatus = BSN_ESS_BASE + '.6'; // INTEGER { disable(0), enable(1) }
// Counter32 count of stations on the WLAN (was mislabelled "TotalAssociations").
const bsnDot11EssNumberOfMobileStations = BSN_ESS_BASE + '.38';

// ── bsnRogueAPTable: entry = 1.3.6.1.4.1.14179.2.1.7.1, columns ...2.1.7.1.N ─
// INDEX = bsnRogueAPDot11MacAddress (6-octet rogue MAC).
const BSN_ROGUE_BASE = '1.3.6.1.4.1.14179.2.1.7.1';
const bsnRogueAPDot11MacAddress = BSN_ROGUE_BASE + '.1';  // MacAddress (also the INDEX)
const bsnRogueAPMaxDetectedRSSI = BSN_ROGUE_BASE + '.10'; // Integer32, best RSSI seen
const bsnRogueAPSSID = BSN_ROGUE_BASE + '.11';            // DisplayString
const bsnRogueAPMaxRssiApMacAddress = BSN_ROGUE_BASE + '.13'; // detecting AP MAC
const bsnRogueAPState = BSN_ROGUE_BASE + '.24';           // bsnRogueAPState (enum below)
const bsnRogueAPClassType = BSN_ROGUE_BASE + '.25';       // bsnRogueAPClassType (enum below)
const bsnRogueAPChannel = BSN_ROGUE_BASE + '.26';         // Integer32

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

// Normalise Cisco rogue class/state to the shared classification set.
//
// bsnRogueAPClassType (preferred when present):
//   pending(0), friendly(1), malicious(2), unclassified(3)
//   → 1 = 'friendly', 2 = 'malicious', 0/3 = 'unclassified'.
//
// bsnRogueAPState fallback (MIB enum):
//   initializing(0), pending(1), alert(2), detectedLrad(3), known(4),
//   acknowledge(5), contained(6), threat(7), containedPending(8),
//   knownContained(9), trustedMissing(10)
//   → 4/5 = 'friendly' (known/acknowledged);
//     6/7/8/9 = 'malicious' (contained/threat/contained-pending/known-contained);
//     2/3 = 'rogue' (alert/detected);
//     0/1/10 = 'unclassified' (initializing/pending/trusted-missing).
function classifyRogue(stateV, classV) {
  const cls = num(classV);
  if (cls === 1) return 'friendly';
  if (cls === 2) return 'malicious';
  if (cls === 3 || cls === 0) return 'unclassified';

  const st = num(stateV);
  if (st !== null) {
    if (st === 4 || st === 5) return 'friendly';
    if (st === 6 || st === 7 || st === 8 || st === 9) return 'malicious';
    if (st === 2 || st === 3) return 'rogue';
    if (st === 0 || st === 1 || st === 10) return 'unclassified';
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
  // bsnAPOperationStatus INTEGER { associated(1), disassociating(2), downloading(3) }
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

// Split a bsnAPIfChannelNoiseInfoTable index ("m1.m2.m3.m4.m5.m6.slot.channel",
// 8 sub-identifiers) into the AP key (the 6-octet Dot3 MAC — the bsnAPTable
// index), the radio key ("MAC.slot" — the same key the bsnAPIfTable / load
// tables use) and the scanned channel number. Returns null on a malformed index.
function splitNoiseIndex(idx) {
  if (idx === null || idx === undefined) return null;
  const parts = String(idx).split('.');
  if (parts.length !== 8) return null;
  const apKey = parts.slice(0, 6).join('.');
  const channel = Number(parts[7]);
  if (!Number.isFinite(channel)) return null;
  return { apKey, radioIdx: apKey + '.' + parts[6], channel };
}

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};

    // AP rows materialize ONLY from bsnAPTable (index = Ethernet/Dot3 MAC).
    // See the header comment for why cLApTable is not merged in.
    const names = columnMap(walked.bsnAPName, bsnAPName);
    const ips = columnMap(walked.bsnApIp, bsnApIpAddress);
    const models = columnMap(walked.bsnAPModel, bsnAPModel);
    const statuses = columnMap(walked.bsnAPStatus, bsnAPOperationStatus);
    const serials = columnMap(walked.bsnApSerial, bsnAPSerialNumber);
    const swVersions = columnMap(walked.bsnApSwVersion, bsnAPSoftwareVersion);

    const indexes = new Set();
    [names, ips, models, statuses, serials, swVersions].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    const byIndex = new Map();
    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      ap.name = str(names[idx]) || idx;
      // The bsnAPTable index IS the AP's Ethernet (Dot3) MAC as 6 dotted
      // decimal octets → colon-hex.
      ap.mac_address = fmtMac(idx);
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.serial_number = str(serials[idx]);
      ap.firmware_version = str(swVersions[idx]);
      ap.status = mapStatus(statuses[idx]);
      // tx_power_2g/5g stay null: bsnAPIfPhyTxPowerLevel is a discrete power
      // LEVEL (1..8), not dBm — storing it in a dBm column would be wrong.
      out.push(ap);
      byIndex.set(idx, ap);
    }

    // ── Per-radio band resolution (bsnAPIfTable, INDEX = {Dot3 MAC, slot}) ──
    // Prefer bsnAPIfType (authoritative), then the current channel, then the
    // legacy slot heuristic (0 = 2.4G, 1 = 5G) as the last resort. Slot alone
    // is wrong on XOR / dual-5G / 6 GHz APs.
    const ifTypes = columnMap(walked.bsnApIfType, bsnAPIfType);
    const chans = columnMap(walked.bsnApChannel, bsnAPIfPhyChannelNumber);

    function bandForRadio(ridx) {
      const t = num(ifTypes[ridx]);
      if (t === 1) return '2g'; // dot11b (2.4 GHz radio)
      if (t === 2) return '5g'; // dot11a (5 GHz radio)
      if (t === 6) return '6g'; // dot116ghz
      if (t === 7) return bandForChannel(chans[ridx]); // dot11xor56ghz — channel decides
      // uwb(4) / unknown / missing type → derive from the current channel,
      // then fall back to the old slot heuristic.
      const byChan = bandForChannel(chans[ridx]);
      if (byChan) return byChan;
      return bandForRadioIndex(splitRadioIndex(ridx).radioKey);
    }

    // Channel (bsnAPIfPhyChannelNumber) → radio_*_channel per band.
    for (const ridx of Object.keys(chans)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(chans[ridx]);
      if (v === null || v <= 0) continue;
      const band = bandForRadio(ridx);
      if (band === '2g' && ap.radio_2g_channel === null) ap.radio_2g_channel = v;
      else if (band === '5g' && ap.radio_5g_channel === null) ap.radio_5g_channel = v;
      else if (band === '6g' && ap.radio_6g_channel === null) ap.radio_6g_channel = v;
    }

    // Per-radio clients (bsnAPIfLoadNumOfClients) → clients_2g/5g/6g, and the
    // per-AP SUM → clients_total (bsnApAssociatedClientCount ...2.2.1.1.38
    // does NOT exist in the MIB — the load table is the real client source).
    // Bands accumulate (+=) so dual-5G APs sum instead of overwriting.
    const loadClients = columnMap(walked.bsnApLoadClients, bsnAPIfLoadNumOfClients);
    const clientTotals = new Map();
    for (const ridx of Object.keys(loadClients)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(loadClients[ridx]);
      if (v === null || v < 0) continue;
      clientTotals.set(apKey, (clientTotals.get(apKey) || 0) + v);
      const band = bandForRadio(ridx);
      if (band === '2g') ap.clients_2g += v;
      else if (band === '5g') ap.clients_5g += v;
      else if (band === '6g') ap.clients_6g += v;
    }
    for (const [apKey, total] of clientTotals) {
      const ap = byIndex.get(apKey);
      if (ap) ap.clients_total = total;
    }

    // Channel utilization % (bsnAPIfLoadChannelUtilization) → radio_*_util_pct.
    // Only set when not already populated (never overwrite / default to 0).
    // The shared AP shape has no radio_6g_util_pct — 6 GHz util is dropped.
    const utilCol = columnMap(walked.bsnApChannelUtil, bsnAPIfLoadChannelUtilization);
    for (const ridx of Object.keys(utilCol)) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const v = num(utilCol[ridx]);
      if (v === null) continue;
      const band = bandForRadio(ridx);
      if (band === '2g' && ap.radio_2g_util_pct === null) ap.radio_2g_util_pct = v;
      else if (band === '5g' && ap.radio_5g_util_pct === null) ap.radio_5g_util_pct = v;
    }

    // Retry rate approximation: Cisco does not expose a true per-radio retry %
    // here, so we approximate it as the GREATER of the per-radio Rx/Tx load
    // utilization (bsnAPIfLoadRxUtilization/.TxUtilization, 0..100) —
    // best-effort, flagged as an approximation; validate against real hardware.
    const rxUtilCol = columnMap(walked.bsnApIfRxUtil, bsnAPIfLoadRxUtilization);
    const txUtilCol = columnMap(walked.bsnApIfTxUtil, bsnAPIfLoadTxUtilization);
    const retryIdxs = new Set([...Object.keys(rxUtilCol), ...Object.keys(txUtilCol)]);
    for (const ridx of retryIdxs) {
      const { apKey } = splitRadioIndex(ridx);
      const ap = byIndex.get(apKey);
      if (!ap) continue;
      const rx = num(rxUtilCol[ridx]);
      const tx = num(txUtilCol[ridx]);
      if (rx === null && tx === null) continue;
      // best-effort approximation of retry_rate per band: max(Rx util, Tx util).
      const approx = Math.max(rx === null ? -Infinity : rx, tx === null ? -Infinity : tx);
      if (!Number.isFinite(approx)) continue;
      const band = bandForRadio(ridx);
      if (band === '2g') ap.retry_rate_2g = approx;
      else if (band === '5g') ap.retry_rate_5g = approx;
    }

    // Noise floor (bsnAPIfDBNoisePower): the noise table reports one row per
    // SCANNED channel (INDEX = MAC.slot.channel), so pick the row whose channel
    // equals the radio's CURRENT operating channel (bsnAPIfPhyChannelNumber).
    // Values are Integer32 dBm and already negative — store as-is; 0 and
    // positive readings are not plausible noise floors → null.
    // The shared AP shape has no noise_floor_6g — 6 GHz noise is dropped.
    const noiseCol = columnMap(walked.bsnApNoise, bsnAPIfDBNoisePower);
    for (const nidx of Object.keys(noiseCol)) {
      const parts = splitNoiseIndex(nidx);
      if (!parts) continue;
      const ap = byIndex.get(parts.apKey);
      if (!ap) continue;
      const curChan = num(chans[parts.radioIdx]);
      if (curChan === null || parts.channel !== curChan) continue;
      const v = num(noiseCol[nidx]);
      if (v === null || v >= 0) continue;
      const band = bandForRadio(parts.radioIdx);
      if (band === '2g') ap.noise_floor_2g = v;
      else if (band === '5g') ap.noise_floor_5g = v;
    }

    // rx_errors_*, tx_errors_*, rx_bytes, tx_bytes are NOT available per-AP in
    // this MIB — they remain null (defaulted by emptyAp()).
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  // Derived from the parsed AP table (per-radio load-table client sum), keyed
  // by the bsnAPTable index. (The old standalone OID ...2.2.1.1.38 does not
  // exist in the MIB.)
  try {
    return parseApTable(walked).map((ap) => ({ apKey: ap._index, clients: ap.clients_total }));
  } catch (e) {
    return [];
  }
}

// Parse per-SSID (WLAN) stats from bsnDot11EssTable. Never throws.
function parseSsids(walked) {
  const out = [];
  try {
    walked = walked || {};

    const ssids = columnMap(walked.bsnEssSsid, bsnDot11EssSsid);
    const admins = columnMap(walked.bsnEssAdmin, bsnDot11EssAdminStatus);
    const stations = columnMap(walked.bsnEssClients, bsnDot11EssNumberOfMobileStations);

    const indexes = new Set();
    [ssids, admins, stations].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ssidName = str(ssids[idx]);
      if (!ssidName) continue; // skip rows with no SSID name

      // bsnDot11EssAdminStatus INTEGER { disable(0), enable(1) }:
      // 1 → 'up', 0 → 'down'; default 'up' when absent.
      let status = 'up';
      if (admins[idx] !== undefined) {
        status = num(admins[idx]) === 1 ? 'up' : 'down';
      }

      // bsnDot11EssNumberOfMobileStations is a Counter32 → counterNum.
      const clients = counterNum(stations[idx]);

      out.push({
        ssid_name: ssidName,
        status: status,
        clients_total: clients === null ? 0 : clients,
        // No per-WLAN octet counters exist in AIRESPACE-WIRELESS-MIB (the
        // "...2.1.6.1 stats table" is per-CLIENT, indexed by client MAC) → null.
        bytes_in: null,
        bytes_out: null,
        auth_successes: 0, // no OID available — leave 0
        // No per-SSID auth-failure OID either (...2.1.13 is a per-client,
        // by-username table) → null, never a fake 0.
        auth_failures: null,
      });
    }
  } catch (e) {
    // never throw
    return [];
  }
  return out;
}

// Parse the rogue AP table (bsnRogueAPTable, entry ...2.1.7.1). Every column
// lives on the same entry and shares the same INDEX (the 6-octet rogue MAC),
// so rows correlate directly by index. Never throws.
function parseRogueAps(walked) {
  const out = [];
  try {
    walked = walked || {};

    const macs = columnMap(walked.rogueMac, bsnRogueAPDot11MacAddress);
    const ssids = columnMap(walked.rogueSsid, bsnRogueAPSSID);
    const states = columnMap(walked.rogueState, bsnRogueAPState);
    const classes = columnMap(walked.rogueClass, bsnRogueAPClassType);
    const channels = columnMap(walked.rogueChannel, bsnRogueAPChannel);
    const rssis = columnMap(walked.rogueRssi, bsnRogueAPMaxDetectedRSSI);
    const detectors = columnMap(walked.rogueDetector, bsnRogueAPMaxRssiApMacAddress);

    const indexes = new Set();
    [macs, ssids, states, classes].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      // BSSID: prefer the MAC value column; otherwise the index itself is the MAC.
      const bssid = fmtMac(macs[idx]) || fmtMac(idx);
      if (!bssid) continue;

      const ssid = str(ssids[idx]);
      const rssi = num(rssis[idx]);
      const channel = num(channels[idx]);
      const classification = classifyRogue(states[idx], classes[idx]);
      const detecting_ap = fmtMac(detectors[idx]);

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
  rogueSsid: bsnRogueAPSSID,
  rogueState: bsnRogueAPState,
  rogueClass: bsnRogueAPClassType,
  rogueChannel: bsnRogueAPChannel,
  rogueRssi: bsnRogueAPMaxDetectedRSSI,
  rogueDetector: bsnRogueAPMaxRssiApMacAddress,
};

module.exports = {
  name: 'cisco',
  snmpOids: {
    // bsnAPTable (index = Ethernet/Dot3 MAC)
    bsnAPName: bsnAPName,
    bsnApIp: bsnApIpAddress,
    bsnAPModel: bsnAPModel,
    bsnAPStatus: bsnAPOperationStatus,
    bsnApSerial: bsnAPSerialNumber,
    bsnApSwVersion: bsnAPSoftwareVersion,
    // bsnAPIfTable per-radio (index = MAC.slot)
    bsnApIfType: bsnAPIfType,
    bsnApChannel: bsnAPIfPhyChannelNumber,
    // bsnAPIfLoadParametersTable per-radio (index = MAC.slot)
    bsnApIfRxUtil: bsnAPIfLoadRxUtilization,
    bsnApIfTxUtil: bsnAPIfLoadTxUtilization,
    bsnApChannelUtil: bsnAPIfLoadChannelUtilization,
    bsnApLoadClients: bsnAPIfLoadNumOfClients,
    // bsnAPIfChannelNoiseInfoTable per-radio-per-channel (index = MAC.slot.channel)
    bsnApNoise: bsnAPIfDBNoisePower,
    // bsnDot11EssTable per-SSID (index = ESS index)
    bsnEssSsid: bsnDot11EssSsid,
    bsnEssAdmin: bsnDot11EssAdminStatus,
    bsnEssClients: bsnDot11EssNumberOfMobileStations,
  },
  snmpRogueOids,
  parseApTable,
  parseClientCounts,
  parseSsids,
  parseRogueAps,
};

'use strict';

// HPE wireless parser — targets Aruba Instant-style HPE APs.
// OIDs from AI-AP-MIB (Aruba Instant, enterprise 14823 — LibreNMS MIB mirror).
// The previous 1.3.6.1.4.1.47196.4.1.1.3.7.1.1 base has no published AP table,
// so those walks were always empty on real hardware. NOTE: unvalidated on real
// hardware — column suffixes are MIB-verified best-effort.

const { num, str, columnMap, emptyAp } = require('./_util');

// aiAccessPointTable: 1.3.6.1.4.1.14823.2.3.3.1.2.1, entry '.1'.
// INDEX = aiAPMACAddress (6-octet MAC → 6 dotted sub-identifiers).
const AP_BASE = '1.3.6.1.4.1.14823.2.3.3.1.2.1.1';
const aiAPMACAddress = AP_BASE + '.1'; // MacAddress (also the index) → decode colon-hex
const aiAPName = AP_BASE + '.2'; // aiAPName
const aiAPIPAddress = AP_BASE + '.3'; // aiAPIPAddress
const aiAPModelName = AP_BASE + '.6'; // aiAPModelName (readable string; '.5' is an OBJECT IDENTIFIER — don't use)
const aiAPStatus = AP_BASE + '.11'; // aiAPStatus: up(1) / down(2)
// No channel or client-count column in aiAccessPointTable — channels stay null
// and client counts keep the emptyAp defaults. Per-client data lives in
// aiClientTable (future work).

function mapStatus(v) {
  const n = num(v);
  if (n === 1) return 'online';
  if (n === 0 || n === 2) return 'offline';
  const s = str(v);
  if (s) {
    const l = s.toLowerCase();
    if (l.includes('up') || l.includes('online') || l.includes('active')) return 'online';
    if (l.includes('down') || l.includes('offline')) return 'offline';
  }
  return 'unknown';
}

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

function parseApTable(walked) {
  const out = [];
  try {
    walked = walked || {};
    const macs = columnMap(walked.apMac, aiAPMACAddress);
    const names = columnMap(walked.apName, aiAPName);
    const ips = columnMap(walked.apIp, aiAPIPAddress);
    const models = columnMap(walked.apModel, aiAPModelName);
    const statuses = columnMap(walked.apStatus, aiAPStatus);

    const indexes = new Set();
    [macs, names, ips, models, statuses].forEach((m) => {
      Object.keys(m).forEach((k) => indexes.add(k));
    });

    for (const idx of indexes) {
      const ap = emptyAp();
      ap._index = idx;
      // MacAddress arrives as a 6-byte Buffer (str() would mojibake it); the
      // table index IS the MAC as dotted decimals, so it is the fallback.
      ap.mac_address = fmtMac(macs[idx]) || fmtMac(idx);
      ap.name = str(names[idx]) || ap.mac_address || idx;
      ap.ip_address = str(ips[idx]);
      ap.model = str(models[idx]);
      ap.status = mapStatus(statuses[idx]);
      // channels null / clients at emptyAp defaults — no OIDs in this table
      // (aiClientTable enrichment is future work).

      out.push(ap);
    }
  } catch (e) {
    // never throw
  }
  return out;
}

function parseClientCounts(walked) {
  // aiAccessPointTable carries no client count — report the parsed APs with
  // their emptyAp default (0) so the AP key list stays consistent.
  try {
    return parseApTable(walked).map((ap) => ({ apKey: ap._index, clients: ap.clients_total }));
  } catch (e) {
    return [];
  }
}

module.exports = {
  name: 'hpe',
  snmpOids: {
    apMac: aiAPMACAddress,
    apName: aiAPName,
    apIp: aiAPIPAddress,
    apModel: aiAPModelName,
    apStatus: aiAPStatus,
  },
  parseApTable,
  parseClientCounts,
};

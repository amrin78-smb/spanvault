'use strict';

// Shared helpers for vendor wireless SNMP parsers.
// Values from the walk helper may be a Node Buffer, a number, or a string.

// num(v): decode to a finite Number, or null on failure / NaN.
function num(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) v = v.toString();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// counterNum(v): decode an SNMP counter to a Number, or null. Counter64 values
// arrive from net-snmp as an 8-byte big-endian Buffer — num() would stringify
// that to NaN — so decode buffers as BE unsigned integers (same approach as
// discovery.js). Counter32/Gauge values arrive as plain numbers and pass through.
function counterNum(v) {
  if (Buffer.isBuffer(v)) {
    if (v.length === 0 || v.length > 8) return null;
    let n = 0;
    for (const b of v) n = n * 256 + b;
    return Number.isFinite(n) ? n : null;
  }
  return num(v);
}

// str(v): decode to a trimmed string, or null when empty / absent.
function str(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) v = v.toString();
  const s = String(v).trim();
  return s.length ? s : null;
}

// indexAfter(oid, base): return the trailing portion of `oid` after `base`
// (the table index used to correlate columns across OID walks), or null when
// `oid` is not under `base`.
// Tolerates a leading dot on either side and a base that is/ isn't dot-terminated.
function indexAfter(oid, base) {
  if (!oid) return null;
  let o = String(oid);
  let b = String(base || '');
  if (o[0] === '.') o = o.slice(1);
  if (b[0] === '.') b = b.slice(1);
  if (b && o.startsWith(b)) {
    let rest = o.slice(b.length);
    // The match must end on a component boundary: the remainder is either empty
    // or starts with '.' — otherwise '1.2.3' would wrongly match '1.2.34.5'.
    if (rest === '' || rest[0] === '.') {
      if (rest[0] === '.') rest = rest.slice(1);
      return rest.length ? rest : null;
    }
  }
  // Base doesn't match at all: return null. (Guessing the last OID component
  // here would silently mis-key rows across unrelated columns.)
  return null;
}

// Build a map { index -> value } from a walked column array given its base OID.
function columnMap(rows, base) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r) continue;
    const idx = indexAfter(r.oid, base);
    if (idx === null) continue;
    out[idx] = r.value;
  }
  return out;
}

// Map a single reported channel number onto a band: '2g' | '5g' | '6g'.
// channel<=14 -> 2g, 15..177 -> 5g, else 6g. Channel 0 / negative (a disabled
// or unreported radio) maps to null, not '2g'.
// NOTE: 6 GHz channel numbers (1..233) overlap the 2.4/5 GHz numbering — a
// parser that has a radio-type/band OID must prefer it over this heuristic.
function bandForChannel(ch) {
  const c = num(ch);
  if (c === null) return null;
  if (c <= 0) return null;
  if (c <= 14) return '2g';
  if (c <= 177) return '5g';
  return '6g';
}

// Radio tables are indexed by "<apIndex>.<radioIndex>" (e.g. "5.0" = AP 5,
// radio 0). splitRadioIndex returns { apKey, radioKey } so radio-level metrics
// can be correlated back to the AP-table index (which is apKey) and the band.
function splitRadioIndex(idx) {
  if (idx === null || idx === undefined) return { apKey: null, radioKey: null };
  const s = String(idx);
  const dot = s.lastIndexOf('.');
  if (dot < 0) return { apKey: s, radioKey: null };
  return { apKey: s.slice(0, dot), radioKey: s.slice(dot + 1) };
}

// Vendor radio indexes: 0 = 2.4GHz, 1 = 5GHz (the dominant convention across
// Aruba/Cisco/Ruckus MIBs). Returns '2g' | '5g' | null.
function bandForRadioIndex(radioKey) {
  const r = num(radioKey);
  if (r === 0) return '2g';
  if (r === 1) return '5g';
  return null;
}

// A fresh WirelessAP with all the required defaults applied.
function emptyAp() {
  return {
    name: null,
    mac_address: null,
    model: null,
    ip_address: null,
    status: 'unknown',
    radio_2g_channel: null,
    radio_5g_channel: null,
    radio_6g_channel: null,
    radio_2g_util_pct: null,
    radio_5g_util_pct: null,
    clients_2g: 0,
    clients_5g: 0,
    clients_6g: 0,
    clients_total: 0,
    tx_power_2g: null,
    tx_power_5g: null,
    uptime_seconds: null,
    firmware_version: null,
    // ── Expanded radio metrics (best-effort; null when the vendor/firmware
    //    does not expose the OID — never default to 0, which would be misleading).
    noise_floor_2g: null,    // dBm, negative
    noise_floor_5g: null,    // dBm, negative
    retry_rate_2g: null,     // percent
    retry_rate_5g: null,     // percent
    // Measured channel interference: % of airtime consumed by traffic that is
    // NOT this AP's own rx/tx (channelBusy − rxUtil − txUtil, clamped 0..100).
    interference_pct_2g: null,
    interference_pct_5g: null,
    rx_errors_2g: null,
    tx_errors_2g: null,
    rx_errors_5g: null,
    tx_errors_5g: null,
    // Raw cumulative byte counters (sum across radios). The collector converts
    // these to throughput_in_bps / throughput_out_bps via a per-poll delta.
    rx_bytes: null,          // bytes received by the AP (→ throughput_in_bps)
    tx_bytes: null,          // bytes sent by the AP    (→ throughput_out_bps)
    serial_number: null,
    auth_failures: null,
    // Cumulative lifetime counts — a stability/flapping signal, not alerted on.
    reboot_count: null,
    bootstrap_count: null,
    _index: null,
  };
}

module.exports = {
  num, counterNum, str, indexAfter, columnMap, bandForChannel, emptyAp,
  splitRadioIndex, bandForRadioIndex,
};

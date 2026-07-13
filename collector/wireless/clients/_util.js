'use strict';

// Shared helpers for vendor wireless CLIENT parsers (collector/wireless/clients).
// Client tables are indexed by the client MAC (and sometimes more), so the most
// common task is turning an OID index tail into a readable MAC address.

const { num, str } = require('../_util');

// Convert the last `n` dotted-decimal components of an OID index into a
// colon-separated lowercase hex MAC. e.g. "0.27.10.5.3.20" -> "00:1b:0a:05:03:14".
// Returns null when the index doesn't hold `n` valid octets.
function macFromTail(idx, n = 6) {
  if (idx === null || idx === undefined) return null;
  const parts = String(idx).split('.').filter((p) => p !== '');
  if (parts.length < n) return null;
  const tail = parts.slice(parts.length - n);
  const hex = [];
  for (const p of tail) {
    const v = parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    hex.push(v.toString(16).padStart(2, '0'));
  }
  return hex.join(':');
}

// Convert the FIRST `n` dotted-decimal components of an OID index into a MAC.
// Used for tables whose index is MAC followed by more sub-identifiers (e.g.
// Aruba's user table index is station-MAC(6) + IPv4(4)).
function macFromHead(idx, n = 6) {
  if (idx === null || idx === undefined) return null;
  const parts = String(idx).split('.').filter((p) => p !== '');
  if (parts.length < n) return null;
  const head = parts.slice(0, n);
  const hex = [];
  for (const p of head) {
    const v = parseInt(p, 10);
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    hex.push(v.toString(16).padStart(2, '0'));
  }
  return hex.join(':');
}

// Normalize a MAC value (6-byte Buffer, or a hex/colon/dash string) to
// colon-separated lowercase hex. Returns null if it can't be parsed.
function hexMac(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    if (v.length < 6) return null;
    return Array.from(v.subarray(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join(':');
  }
  const hexOnly = String(v).replace(/[^0-9a-fA-F]/g, '');
  if (hexOnly.length < 12) return null;
  const pairs = hexOnly.slice(0, 12).match(/.{2}/g) || [];
  return pairs.join(':').toLowerCase();
}

// Map a numeric band/radio code to a label. Default map covers the common
// 1=2.4GHz, 2=5GHz, 3=6GHz convention; pass a vendor-specific map to override.
function bandFromCode(code, map) {
  const n = num(code);
  if (n === null) return null;
  const m = map || { 1: '2.4GHz', 2: '5GHz', 3: '6GHz' };
  return m[n] || null;
}

// Best-effort band from a channel number when no band code is available.
function bandFromChannelNum(ch) {
  const c = num(ch);
  if (c === null) return null;
  if (c >= 1 && c <= 14) return '2.4GHz';
  if (c >= 32 && c <= 196) return '5GHz';
  return null;
}

// A fresh client record with all collector-expected fields defaulted to null.
// controller_id / vendor / last_seen_at / is_problem / roaming_count are filled
// in by the collector, not the parser.
function emptyClient() {
  return {
    mac_address: null,
    ip_address: null,
    hostname: null,
    ap_id: null,
    ap_name: null,
    ssid_name: null,
    band: null,
    channel: null,
    rssi_dbm: null,
    tx_rate_mbps: null,
    rx_rate_mbps: null,
    connected_since: null,
    auth_type: null,
    // PHY/HT capability (e.g. "802.11ac (80MHz)") — distinct from tx_rate_mbps
    // (the negotiated rate). VLAN is the client's assigned VLAN ID.
    phy_mode: null,
    vlan_id: null,
    // Cumulative byte counters read straight off the SNMP table, direction
    // relative to the CLIENT (rx_bytes = downloaded BY the client, tx_bytes =
    // uploaded BY the client) — matches the rest of this struct's convention
    // (tx_rate_mbps/rx_rate_mbps are already client-relative). These are
    // in-memory only, never written to the DB directly: wirelessCollector.js's
    // shared deriveThroughput() delta helper converts the counter difference
    // between this poll and the last into wireless_clients.rx_bps/tx_bps.
    // byte_counter_bits (32 or 64) tells deriveThroughput() whether to apply
    // Counter32-wrap handling — set it whenever rx_bytes/tx_bytes are set.
    rx_bytes: null,
    tx_bytes: null,
    byte_counter_bits: null,
  };
}

// connected_since (a Date) from an "associated for N seconds" value.
function connectedSinceFromSeconds(sec) {
  const s = num(sec);
  if (s === null || s < 0) return null;
  return new Date(Date.now() - s * 1000);
}

module.exports = {
  num, str, macFromTail, macFromHead, hexMac, bandFromCode, bandFromChannelNum,
  emptyClient, connectedSinceFromSeconds,
};

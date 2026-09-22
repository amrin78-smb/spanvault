'use strict';

/**
 * Shared helpers for the SNMP vendor parsers.
 *
 * Parsers receive a `raw` object keyed by the metric definition `name`, where
 * each value is an array of { oid, value } varbinds (from a scalar GET or a
 * table WALK). These helpers normalise net-snmp values (which may be Buffers,
 * numbers, or dotted OID strings) into the numbers the parsers emit.
 *
 * Plain JavaScript only — no TypeScript syntax (matches collector.js).
 */

// Coerce a raw SNMP value to a finite number, or null if not numeric.
function num(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) v = v.toString();
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? null : n;
}

// Coerce a 64-bit SNMP value to a number. net-snmp has no 64-bit integer type,
// so Counter64 / CounterBasedGauge64 varbinds arrive as big-endian Buffers —
// num() would run Buffer.toString() over those raw bytes and yield NaN. Use
// this for any OID whose MIB SYNTAX is Counter64 or CounterBasedGauge64.
function num64(v) {
  if (Buffer.isBuffer(v)) {
    if (!v.length) return null;
    // A Buffer that is printable ASCII digits is a DisplayString, NOT a 64-bit
    // integer — byte-decoding it silently returns a plausible wrong number
    // (Buffer.from('42') would read as 13362). Firmware that reports a numeric
    // field as a string is then parsed, not mangled.
    const asText = v.toString('latin1');
    if (/^\s*\d+\s*$/.test(asText)) return num(asText);
    // BER pads a value >= 2^63 with a leading zero byte, making it 9 long.
    let start = 0;
    while (start < v.length - 1 && v[start] === 0) start += 1;
    if (v.length - start > 8) return null;
    let n = 0n;
    for (let i = start; i < v.length; i += 1) n = (n << 8n) | BigInt(v[i]);
    return Number(n);
  }
  return num(v);
}

// Coerce a raw SNMP value to a string (Buffers → utf8).
function str(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) return v.toString();
  return String(v);
}

// All numeric values from a list of { oid, value } rows.
function rowsNum(rows) {
  return (rows || []).map((r) => num(r.value)).filter((n) => n !== null);
}

// First numeric value (handy for scalar GETs), or null.
function first(rows) {
  const ns = rowsNum(rows);
  return ns.length ? ns[0] : null;
}

// Average of the numeric values, or null if none.
function avg(rows) {
  const ns = rowsNum(rows);
  if (!ns.length) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

// Sum of the numeric values, or null if none.
function sum(rows) {
  const ns = rowsNum(rows);
  if (!ns.length) return null;
  return ns.reduce((a, b) => a + b, 0);
}

// Count rows whose numeric value satisfies the predicate.
function countWhere(rows, pred) {
  let c = 0;
  for (const r of rows || []) {
    const n = num(r.value);
    if (n !== null && pred(n)) c += 1;
  }
  return c;
}

// Last dotted segment of an OID — the table row index.
function lastIndex(oid) {
  const p = String(oid).split('.');
  return parseInt(p[p.length - 1], 10);
}

// Build a sample object in the shape collector.js persists to snmp_results.
function sample(metricName, value, oid, ifIndex, ifName) {
  return {
    metric_name: metricName,
    value: value,
    oid: oid || null,
    if_index: ifIndex || null,
    if_name: ifName || null,
  };
}

module.exports = { num, num64, str, rowsNum, first, avg, sum, countWhere, lastIndex, sample };

'use strict';

/**
 * juniper.js — Juniper JUNOS (JUNIPER-MIB jnxOperating table, enterprise 2636,
 * plus the standard BGP4-MIB).
 *
 * Key metrics: Routing Engine CPU, memory-buffer utilisation, FPC/component
 * temperatures, and a count of established BGP peers. The jnxOperating table is
 * indexed by (type, L1, L2, L3); we average across all reporting components and
 * surface temperature per component.
 */

const U = require('./_util');

const JNX_OPER = '1.3.6.1.4.1.2636.3.1.13.1';
const OPER_DESCR  = `${JNX_OPER}.5`;   // jnxOperatingDescr
const OPER_TEMP   = `${JNX_OPER}.7`;   // jnxOperatingTemp (Celsius)
const OPER_CPU    = `${JNX_OPER}.8`;   // jnxOperatingCPU (%)
const OPER_BUFFER = `${JNX_OPER}.11`;  // jnxOperatingBuffer (% memory used)

// BGP4-MIB bgpPeerState: 1 idle … 6 established.
const BGP_PEER_STATE = '1.3.6.1.2.1.15.3.1.2';

const metrics = [
  { name: 'descr',     oid: OPER_DESCR,     kind: 'table', desc: 'jnxOperatingDescr' },
  { name: 'temp',      oid: OPER_TEMP,      kind: 'table', desc: 'jnxOperatingTemp (C)' },
  { name: 'cpu',       oid: OPER_CPU,       kind: 'table', desc: 'jnxOperatingCPU (%)' },
  { name: 'buffer',    oid: OPER_BUFFER,    kind: 'table', desc: 'jnxOperatingBuffer (%)' },
  { name: 'bgp_state', oid: BGP_PEER_STATE, kind: 'table', desc: 'bgpPeerState' },
];

// jnxOperating rows are indexed by 4 trailing sub-identifiers; key on those.
function operKey(oid, baseLen) {
  return String(oid).split('.').slice(baseLen).join('.');
}

function parse(raw) {
  const out = [];
  const baseLen = OPER_DESCR.split('.').length;

  // CPU — average across components actually reporting a non-zero engine load.
  const cpu = U.avg((raw.cpu || []).filter((r) => U.num(r.value) !== null && U.num(r.value) > 0));
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, OPER_CPU));

  // Memory buffer utilisation — average across reporting components.
  const mem = U.avg((raw.buffer || []).filter((r) => U.num(r.value) !== null && U.num(r.value) > 0));
  if (mem !== null) out.push(U.sample('mem_pct', mem, OPER_BUFFER));

  // Temperatures — one sample per component that reports a non-zero reading.
  const descrByKey = new Map((raw.descr || []).map((r) => [operKey(r.oid, baseLen), U.str(r.value)]));
  for (const r of raw.temp || []) {
    const t = U.num(r.value);
    if (t === null || t <= 0) continue; // 0 = sensor absent
    const key = operKey(r.oid, baseLen);
    const label = descrByKey.get(key) || `comp${key}`;
    out.push(U.sample('temperature_c', t, OPER_TEMP, U.lastIndex(r.oid), label));
  }

  // BGP — count peers in the established (6) state.
  if (raw.bgp_state && raw.bgp_state.length) {
    const established = U.countWhere(raw.bgp_state, (n) => n === 6);
    out.push(U.sample('bgp_peers_established', established, BGP_PEER_STATE));
    out.push(U.sample('bgp_peers_total', raw.bgp_state.length, BGP_PEER_STATE));
  }

  return out;
}

module.exports = { name: 'juniper', metrics, parse };

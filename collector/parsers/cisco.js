'use strict';

/**
 * cisco.js — Cisco IOS / IOS-XE / NX-OS (CISCO-PROCESS-MIB,
 * CISCO-MEMORY-POOL-MIB, IF-MIB).
 *
 * Key metrics: 5-minute CPU utilisation (averaged across CPU entities),
 * memory-pool utilisation (used / (used + free)), and per-interface in/out
 * error counters.
 */

const U = require('./_util');

// CISCO-PROCESS-MIB cpmCPUTotal5minRev (per cpmCPUTotalIndex).
const CPM_CPU_5MIN   = '1.3.6.1.4.1.9.9.109.1.1.1.1.8';
// Older fallback column cpmCPUTotal5min (kept for pre-12.x devices).
const CPM_CPU_5MIN_OLD = '1.3.6.1.4.1.9.9.109.1.1.1.1.5';
// CISCO-MEMORY-POOL-MIB.
const MEM_USED = '1.3.6.1.4.1.9.9.48.1.1.1.5';
const MEM_FREE = '1.3.6.1.4.1.9.9.48.1.1.1.6';
// IF-MIB error counters.
const IF_IN_ERR  = '1.3.6.1.2.1.2.2.1.14';
const IF_OUT_ERR = '1.3.6.1.2.1.2.2.1.20';
const IF_DESCR   = '1.3.6.1.2.1.2.2.1.2';
// CISCO-BGP4-MIB cbgpPeer2State (6 = established).
const CBGP_PEER2_STATE = '1.3.6.1.4.1.9.9.187.1.2.5.1.3';
// CISCO-CLASS-BASED-QOS-MIB cbQosCMDropBitRate.
const CBQOS_DROP_BITRATE = '1.3.6.1.4.1.9.9.166.1.15.1.1.9';

const metrics = [
  { name: 'cpu5min',     oid: CPM_CPU_5MIN,     kind: 'table', desc: 'cpmCPUTotal5minRev (%)' },
  { name: 'cpu5min_old', oid: CPM_CPU_5MIN_OLD, kind: 'table', desc: 'cpmCPUTotal5min (%)' },
  { name: 'mem_used',    oid: MEM_USED,         kind: 'table', desc: 'ciscoMemoryPoolUsed (bytes)' },
  { name: 'mem_free',    oid: MEM_FREE,         kind: 'table', desc: 'ciscoMemoryPoolFree (bytes)' },
  { name: 'if_in_err',   oid: IF_IN_ERR,        kind: 'table', desc: 'ifInErrors' },
  { name: 'if_out_err',  oid: IF_OUT_ERR,       kind: 'table', desc: 'ifOutErrors' },
  { name: 'if_descr',    oid: IF_DESCR,         kind: 'table', desc: 'ifDescr' },
  { name: 'bgp_state',   oid: CBGP_PEER2_STATE, kind: 'table', desc: 'cbgpPeer2State (6=established)' },
  { name: 'qos_drop',    oid: CBQOS_DROP_BITRATE, kind: 'table', desc: 'cbQosCMDropBitRate' },
];

function parse(raw) {
  const out = [];

  // CPU — prefer the Rev column, fall back to the legacy column.
  const cpu = U.avg(raw.cpu5min && raw.cpu5min.length ? raw.cpu5min : raw.cpu5min_old);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPM_CPU_5MIN));

  // Memory — aggregate all pools: used / (used + free).
  const usedTotal = U.sum(raw.mem_used);
  const freeTotal = U.sum(raw.mem_free);
  if (usedTotal !== null && freeTotal !== null && usedTotal + freeTotal > 0) {
    out.push(U.sample('mem_pct', (usedTotal / (usedTotal + freeTotal)) * 100, MEM_USED));
  }

  // Per-interface error counters.
  const descrByIdx = new Map((raw.if_descr || []).map((r) => [U.lastIndex(r.oid), U.str(r.value)]));
  for (const r of raw.if_in_err || []) {
    const idx = U.lastIndex(r.oid);
    const v = U.num(r.value);
    if (v !== null) out.push(U.sample('if_in_errors', v, IF_IN_ERR, idx, descrByIdx.get(idx) || `if${idx}`));
  }
  for (const r of raw.if_out_err || []) {
    const idx = U.lastIndex(r.oid);
    const v = U.num(r.value);
    if (v !== null) out.push(U.sample('if_out_errors', v, IF_OUT_ERR, idx, descrByIdx.get(idx) || `if${idx}`));
  }

  // BGP peers — count sessions in the established state (6).
  if (raw.bgp_state && raw.bgp_state.length) {
    const established = U.countWhere(raw.bgp_state, (n) => n === 6);
    out.push(U.sample('bgp_peers_established', established, CBGP_PEER2_STATE));
    out.push(U.sample('bgp_peers_total', raw.bgp_state.length, CBGP_PEER2_STATE));
  }

  // QoS — aggregate drop bit-rate across all class-map entries.
  if (raw.qos_drop && raw.qos_drop.length) {
    const total = U.sum(raw.qos_drop);
    if (total !== null) out.push(U.sample('qos_drop_rate', total, CBQOS_DROP_BITRATE));
  }

  return out;
}

module.exports = { name: 'cisco', metrics, parse };

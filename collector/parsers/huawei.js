'use strict';

/**
 * huawei.js — Huawei VRP (HUAWEI-ENTITY-EXTENT-MIB, enterprise 2011).
 *
 * Key metrics: per-board CPU and memory utilisation (averaged across boards
 * that report a non-zero value), reported via the hwEntityState extension
 * table. Standard interface counters come from the collector core's IF-MIB poll.
 */

const U = require('./_util');

const HW_EXT = '1.3.6.1.4.1.2011.5.25.31.1.1.1.1';
const CPU = `${HW_EXT}.5`; // hwEntityCpuUsage (%)
const MEM = `${HW_EXT}.7`; // hwEntityMemUsage (%)

const metrics = [
  { name: 'cpu', oid: CPU, kind: 'table', desc: 'hwEntityCpuUsage (%)' },
  { name: 'mem', oid: MEM, kind: 'table', desc: 'hwEntityMemUsage (%)' },
];

function parse(raw) {
  const out = [];
  // Boards report 0 when not applicable; average only the active ones.
  const cpu = U.avg((raw.cpu || []).filter((r) => U.num(r.value) !== null && U.num(r.value) > 0));
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU));
  const mem = U.avg((raw.mem || []).filter((r) => U.num(r.value) !== null && U.num(r.value) > 0));
  if (mem !== null) out.push(U.sample('mem_pct', mem, MEM));
  return out;
}

module.exports = { name: 'huawei', metrics, parse };

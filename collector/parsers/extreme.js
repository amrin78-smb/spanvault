'use strict';

/**
 * extreme.js — Extreme Networks EXOS (EXTREME-SOFTWARE-MONITOR-MIB and
 * EXTREME-SYSTEM-MIB, enterprise 1916).
 *
 * Key metrics: total CPU utilisation (averaged across monitored slots) and
 * system memory utilisation derived from free/total. Port utilisation comes
 * from the collector core's IF-MIB poll.
 */

const U = require('./_util');

// extremeCpuMonitorTotalUtilization (per slot), %.
const CPU_TOTAL = '1.3.6.1.4.1.1916.1.32.1.4.1.4';
// extremeMemoryMonitorSystemTotal / ...Free (KB), per slot.
const MEM_TOTAL = '1.3.6.1.4.1.1916.1.32.2.2.1.2';
const MEM_FREE  = '1.3.6.1.4.1.1916.1.32.2.2.1.3';

const metrics = [
  { name: 'cpu',      oid: CPU_TOTAL, kind: 'table', desc: 'extremeCpuMonitorTotalUtilization (%)' },
  { name: 'mem_total', oid: MEM_TOTAL, kind: 'table', desc: 'extremeMemoryMonitorSystemTotal (KB)' },
  { name: 'mem_free',  oid: MEM_FREE,  kind: 'table', desc: 'extremeMemoryMonitorSystemFree (KB)' },
];

function parse(raw) {
  const out = [];
  const cpu = U.avg(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU_TOTAL));
  const total = U.sum(raw.mem_total);
  const free = U.sum(raw.mem_free);
  if (total !== null && free !== null && total > 0) {
    out.push(U.sample('mem_pct', ((total - free) / total) * 100, MEM_TOTAL));
  }
  return out;
}

module.exports = { name: 'extreme', metrics, parse };

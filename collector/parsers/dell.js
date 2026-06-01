'use strict';

/**
 * dell.js — Dell Networking / Force10 (FORCE10-SMI, enterprise 6027).
 *
 * Key metrics: per stack-unit CPU (5-minute) and memory utilisation, plus a
 * count of stack units in the "ok" status. Covers Force10/DNOS and OS10
 * chassis that implement the f10ChStackUnit table.
 */

const U = require('./_util');

const STACK = '1.3.6.1.4.1.6027.3.10.1.2.9.1';
const CPU_5MIN = `${STACK}.5`; // chStackUnitCpuUtil5Min (%)
const MEM_UTIL = `${STACK}.6`; // chStackUnitMemUsageUtil (%)

// chStackUnitStatus: 1=ok, 2=unsupported, 3=codeMismatch, 4=configMismatch ...
const STACK_STATUS = '1.3.6.1.4.1.6027.3.10.1.2.2.1.6';

const metrics = [
  { name: 'cpu',    oid: CPU_5MIN,     kind: 'table', desc: 'chStackUnitCpuUtil5Min (%)' },
  { name: 'mem',    oid: MEM_UTIL,     kind: 'table', desc: 'chStackUnitMemUsageUtil (%)' },
  { name: 'status', oid: STACK_STATUS, kind: 'table', desc: 'chStackUnitStatus' },
];

function parse(raw) {
  const out = [];
  const cpu = U.avg(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU_5MIN));
  const mem = U.avg(raw.mem);
  if (mem !== null) out.push(U.sample('mem_pct', mem, MEM_UTIL));
  if (raw.status && raw.status.length) {
    out.push(U.sample('stack_units_total', raw.status.length, STACK_STATUS));
    out.push(U.sample('stack_units_ok', U.countWhere(raw.status, (n) => n === 1), STACK_STATUS));
  }
  return out;
}

module.exports = { name: 'dell', metrics, parse };

'use strict';

/**
 * hpe-comware.js — HPE Comware / H3C / 3Com (HH3C-ENTITY-EXT-MIB,
 * enterprise 25506). Comware is the OS behind HPE FlexNetwork/FlexFabric,
 * H3C, and legacy 3Com switches.
 *
 * Key metrics: per-slot (entity) CPU and memory utilisation, averaged across
 * slots that report a non-zero value. VLAN/interface counters come from the
 * collector core's IF-MIB poll.
 */

const U = require('./_util');

const HH3C_EXT = '1.3.6.1.4.1.25506.2.6.1.1.1.1';
const CPU = `${HH3C_EXT}.6`; // hh3cEntityExtCpuUsage (%)
const MEM = `${HH3C_EXT}.8`; // hh3cEntityExtMemUsage (%)

const metrics = [
  { name: 'cpu', oid: CPU, kind: 'table', desc: 'hh3cEntityExtCpuUsage (%)' },
  { name: 'mem', oid: MEM, kind: 'table', desc: 'hh3cEntityExtMemUsage (%)' },
];

function parse(raw) {
  const out = [];
  // Only slots that are actually populated report a non-zero usage.
  const cpu = U.avg((raw.cpu || []).filter((r) => U.num(r.value) !== null && U.num(r.value) > 0));
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU));
  const mem = U.avg((raw.mem || []).filter((r) => U.num(r.value) !== null && U.num(r.value) > 0));
  if (mem !== null) out.push(U.sample('mem_pct', mem, MEM));
  return out;
}

module.exports = { name: 'hpe-comware', metrics, parse };

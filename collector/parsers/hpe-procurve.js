'use strict';

/**
 * hpe-procurve.js — HPE / HP ProCurve & Aruba-OS Switch (STATISTICS-MIB and
 * NETSWITCH-MIB under enterprise 11.2.14.11).
 *
 * Key metrics: switch CPU, system memory utilisation (used / total across
 * memory slots), and total PoE power drawn across PSE ports. Port utilisation
 * comes from the collector core's IF-MIB poll.
 */

const U = require('./_util');

// hpSwitchCpuStat — overall CPU %.
const CPU = '1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.0';
// hpLocalMemTotalBytes / hpLocalMemAllocBytes per slot.
const MEM_TOTAL = '1.3.6.1.4.1.11.2.14.11.5.1.1.2.1.1.5';
const MEM_ALLOC = '1.3.6.1.4.1.11.2.14.11.5.1.1.2.1.1.6';
// hpicfPoePethPsePortActualPower (watts) per PSE port.
const POE_PORT_POWER = '1.3.6.1.4.1.11.2.14.11.1.9.1.1.1.7';

const metrics = [
  { name: 'cpu',       oid: CPU,            kind: 'scalar', desc: 'hpSwitchCpuStat (%)' },
  { name: 'mem_total', oid: MEM_TOTAL,      kind: 'table',  desc: 'hpLocalMemTotalBytes' },
  { name: 'mem_alloc', oid: MEM_ALLOC,      kind: 'table',  desc: 'hpLocalMemAllocBytes' },
  { name: 'poe',       oid: POE_PORT_POWER, kind: 'table',  desc: 'hpicfPoePsePortActualPower (W)' },
];

function parse(raw) {
  const out = [];
  const cpu = U.first(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU));
  const total = U.sum(raw.mem_total);
  const alloc = U.sum(raw.mem_alloc);
  if (total !== null && alloc !== null && total > 0) {
    out.push(U.sample('mem_pct', (alloc / total) * 100, MEM_ALLOC));
  }
  const poe = U.sum(raw.poe);
  if (poe !== null) out.push(U.sample('poe_power_w', poe, POE_PORT_POWER));
  return out;
}

module.exports = { name: 'hpe-procurve', metrics, parse };

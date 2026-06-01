'use strict';

/**
 * brocade.js — Brocade / Foundry ICX FastIron (FOUNDRY-SN-AGENT-MIB,
 * enterprise 1991).
 *
 * Key metrics: global 1-minute CPU utilisation, dynamic memory utilisation,
 * and a count of stack/fabric units present. Port stats come from the
 * collector core's IF-MIB poll.
 */

const U = require('./_util');

const SN_AGENT = '1.3.6.1.4.1.1991.1.1.2.1';
const CPU_1MIN = `${SN_AGENT}.52.0`; // snAgGblCpuUtil1MinAvg (%)
const MEM_UTIL = `${SN_AGENT}.54.0`; // snAgGblDynMemUtil (%)

// snStackingGlobalConfigState / unit table — count rows present.
const STACK_UNIT = '1.3.6.1.4.1.1991.1.1.3.31.1.1.1.2'; // snStackingOperUnitId

const metrics = [
  { name: 'cpu',   oid: CPU_1MIN,   kind: 'scalar', desc: 'snAgGblCpuUtil1MinAvg (%)' },
  { name: 'mem',   oid: MEM_UTIL,   kind: 'scalar', desc: 'snAgGblDynMemUtil (%)' },
  { name: 'units', oid: STACK_UNIT, kind: 'table',  desc: 'snStackingOperUnitId' },
];

function parse(raw) {
  const out = [];
  const cpu = U.first(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU_1MIN));
  const mem = U.first(raw.mem);
  if (mem !== null) out.push(U.sample('mem_pct', mem, MEM_UTIL));
  if (raw.units && raw.units.length) {
    out.push(U.sample('stack_units_total', raw.units.length, STACK_UNIT));
  }
  return out;
}

module.exports = { name: 'brocade', metrics, parse };

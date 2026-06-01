'use strict';

/**
 * netgear.js — Netgear ProSAFE / managed switches.
 *
 * Netgear managed switches expose CPU/memory inconsistently across the smart-
 * managed (GS/JGS) vs fully-managed (M-series) lines, but reliably answer the
 * standard SNMPv2-MIB and IF-MIB. This parser surfaces device uptime; CPU,
 * memory, and interface stats come from the collector core's standard-MIB poll
 * (hrProcessorLoad / hrStorage / ifTable).
 */

const U = require('./_util');

const SYS_UPTIME = '1.3.6.1.2.1.1.3.0'; // sysUpTime (TimeTicks, 1/100 s)

const metrics = [
  { name: 'uptime', oid: SYS_UPTIME, kind: 'scalar', desc: 'sysUpTime (centiseconds)' },
];

function parse(raw) {
  const out = [];
  const ticks = U.first(raw.uptime);
  if (ticks !== null) out.push(U.sample('uptime_seconds', ticks / 100, SYS_UPTIME));
  return out;
}

module.exports = { name: 'netgear', metrics, parse };

'use strict';

/**
 * meraki.js — Cisco Meraki (standard MIBs only).
 *
 * Meraki devices answer local SNMP for the standard SNMPv2-MIB / IF-MIB only
 * (rich telemetry lives in the Meraki Dashboard API, not on-box SNMP). This
 * parser surfaces device uptime; interface counters and oper-status come from
 * the collector core's IF-MIB poll.
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

module.exports = { name: 'meraki', metrics, parse };

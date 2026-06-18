'use strict';

/**
 * sonicwall.js — SonicWall firewalls (SONICWALL-FIREWALL-IP-STATISTICS-MIB,
 * enterprise 1.3.6.1.4.1.8741).
 *
 * CPU and RAM are exposed directly as utilisation percentages, so no maths is
 * needed. (Some Gen7 firmware deprecates these; if so they return null and the
 * collector falls back to the standard HOST-RESOURCES MIB.)
 */

const U = require('./_util');

const FW = '1.3.6.1.4.1.8741.1.3.1';
const CONN = FW + '.1.0';   // sonicCurrentConnCacheEntries
const CPU  = FW + '.3.0';   // sonicCurrentCPUUtil (%)
const RAM  = FW + '.4.0';   // sonicCurrentRAMUtil (%)

const metrics = [
  { name: 'cpu',  oid: CPU,  kind: 'scalar', desc: 'sonicCurrentCPUUtil (%)' },
  { name: 'ram',  oid: RAM,  kind: 'scalar', desc: 'sonicCurrentRAMUtil (%)' },
  { name: 'conn', oid: CONN, kind: 'scalar', desc: 'sonicCurrentConnCacheEntries' },
];

function parse(raw) {
  const out = [];
  const cpu = U.first(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU));
  const ram = U.first(raw.ram);
  if (ram !== null) out.push(U.sample('mem_pct', ram, RAM));
  const conn = U.first(raw.conn);
  if (conn !== null) out.push(U.sample('session_count', conn, CONN));
  return out;
}

module.exports = { name: 'sonicwall', metrics, parse };

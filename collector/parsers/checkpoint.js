'use strict';

/**
 * checkpoint.js — Check Point firewalls (Gaia / SVN, CHECKPOINT-MIB,
 * enterprise 1.3.6.1.4.1.2620).
 *
 * Check Point appliances on Gaia report a generic Linux sysDescr, so they are
 * usually matched by sysObjectID (enterprise 2620), not sysDescr. CPU comes from
 * the per-core multiProcUsage table (averaged); memory from memActiveReal64 over
 * memTotalReal64. HOST-RESOURCES is unreliable here, so these vendor OIDs win.
 */

const U = require('./_util');

const PERF = '1.3.6.1.4.1.2620.1.6.7';
const CPU_TABLE  = PERF + '.5.1.1.5';   // multiProcUsage (per-CPU total usage %)
const MEM_TOTAL  = PERF + '.4.3.0';     // memTotalReal64 (KB)
const MEM_ACTIVE = PERF + '.4.4.0';     // memActiveReal64 (KB, in use)
const FW_NUMCONN = '1.3.6.1.4.1.2620.1.1.25.3.0'; // fwNumConn (concurrent connections)

const metrics = [
  { name: 'cpu',        oid: CPU_TABLE,  kind: 'table',  desc: 'multiProcUsage per-CPU %' },
  { name: 'mem_total',  oid: MEM_TOTAL,  kind: 'scalar', desc: 'memTotalReal64 (KB)' },
  { name: 'mem_active', oid: MEM_ACTIVE, kind: 'scalar', desc: 'memActiveReal64 (KB)' },
  { name: 'conn',       oid: FW_NUMCONN, kind: 'scalar', desc: 'fwNumConn (connections)' },
];

function parse(raw) {
  const out = [];
  const cpu = U.avg(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU_TABLE));
  const total = U.first(raw.mem_total);
  const active = U.first(raw.mem_active);
  if (total !== null && active !== null && total > 0) {
    out.push(U.sample('mem_pct', (active / total) * 100, MEM_ACTIVE));
  }
  const conn = U.first(raw.conn);
  if (conn !== null) out.push(U.sample('session_count', conn, FW_NUMCONN));
  return out;
}

module.exports = { name: 'checkpoint', metrics, parse };

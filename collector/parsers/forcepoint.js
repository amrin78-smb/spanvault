'use strict';

/**
 * forcepoint.js — Forcepoint NGFW engines (FORCEPOINT-NGFW-ENGINE-MIB,
 * enterprise 1.3.6.1.4.1.47565, subtree .1.1 = ngfw.engine).
 *
 * NOT enterprise 1369 — that is the legacy Stonesoft/StoneGate tree. Modern
 * engines answer under 47565 and report a Forcepoint sysDescr, so both the
 * sysDescr pattern and the 47565 sysObjectID fallback in ./index.js reach here.
 *
 * Verified live 2026-09-22 against two production engines on firmware 7.1.11
 * (appliance models 120-1-C3 and 330-0-C1) by walking the whole 47565 subtree.
 * What that walk settled, and why this file looks the way it does:
 *
 * - CPU comes from nodeCPULoad, NOT fwCpuTotal. fwCpuTotal is delta-based and
 *   reads 0 on the first poll after the engine has not been asked recently;
 *   nodeCPULoad is an absolute gauge and matched the fwCpuTotal aggregate once
 *   that had warmed up (2% and 36% on the two engines). fwCpuTotal is kept as a
 *   fallback for firmware that lacks netNodeObjects.
 * - mem_pct is derived from fwMemBytesAvailable, not fwMemBytesUsed. "Used"
 *   counts buffers/cache, exactly like the standard hrStorage figure the core
 *   collector would otherwise use, and reads ~20 points high: the two engines
 *   showed 90.2%/98.1% used-over-total against 70.8%/79.0% once available
 *   memory was taken into account.
 * - disk_usage_pct EXCLUDES the root filesystem. On NGFW appliances "/" is a
 *   read-only system partition that is 100% full by design (verified: size ==
 *   used, avail == 0 on both engines), so including it pins the metric at 100%
 *   forever and buries the partitions that actually fill up (/data, /spool).
 * - No hardware-sensor tables. fwHwTempSensorTable (16), fwPsuTable (17),
 *   fwFanTable (18) and fwVoltageTable (20) returned nothing on either engine,
 *   as did fwVpnEp6Table (13), fwMbrInterfaceTable (14) and fwVETable (21).
 *   Larger chassis may expose them; add them here if a walk ever shows them.
 *
 * Counter64 note: fwConnNumber, the fwMemBytes and fwSwapBytes scalars and the
 * partition columns are Counter64/CounterBasedGauge64, which net-snmp hands
 * back as Buffers. They must go through U.num64 — U.num would return null.
 */

const U = require('./_util');

const ENG = '1.3.6.1.4.1.47565.1.1.1';   // engineObjects
const HW = `${ENG}.11`;                  // fwHardware
const MEM = `${HW}.2`;                   // fwMemoryInfo
const NODE = `${ENG}.19`;                // netNodeObjects

const OID = {
  connNumber:     `${ENG}.4.0`,          // fwConnNumber (CounterBasedGauge64)
  cpuTotal:       `${HW}.1.1.3`,         // fwCpuTotal table (index 0 = aggregate)
  swapTotal:      `${MEM}.1.0`,          // fwSwapBytesTotal
  swapUsed:       `${MEM}.2.0`,          // fwSwapBytesUsed
  memTotal:       `${MEM}.4.0`,          // fwMemBytesTotal
  memUsed:        `${MEM}.5.0`,          // fwMemBytesUsed
  memAvailable:   `${MEM}.10.0`,         // fwMemBytesAvailable
  inspectionPct:  `${MEM}.12.0`,         // fwInspectionPercentageUsed (Unsigned32 0..100)
  partMount:      `${HW}.3.1.3`,         // fwMountPointName table
  partSize:       `${HW}.3.1.4`,         // fwPartitionSize table
  partUsed:       `${HW}.3.1.5`,         // fwPartitionUsed table
  vpnIpsecSa:     `${ENG}.12.1.7`,       // fwVpnEp4IpsecSa table (SAs per endpoint)
  nodeOperState:  `${NODE}.3.0`,         // nodeOperState enum
  nodeCpuLoad:    `${NODE}.4.0`,         // nodeCPULoad (Integer32 0..100)
  nodeTestResult: `${NODE}.7.1.3`,       // nodeTestResult table: success(1)/failure(2)
};

// nodeOperState values that mean "this node is carrying traffic".
const ONLINE_STATES = new Set([1 /* online */, 3 /* lockedOnline */]);

const metrics = [
  { name: 'conn',           oid: OID.connNumber,     kind: 'scalar', desc: 'fwConnNumber (current connections)' },
  { name: 'cpu_table',      oid: OID.cpuTotal,       kind: 'table',  desc: 'fwCpuTotal % (0 = aggregate row)' },
  { name: 'swap_total',     oid: OID.swapTotal,      kind: 'scalar', desc: 'fwSwapBytesTotal' },
  { name: 'swap_used',      oid: OID.swapUsed,       kind: 'scalar', desc: 'fwSwapBytesUsed' },
  { name: 'mem_total',      oid: OID.memTotal,       kind: 'scalar', desc: 'fwMemBytesTotal' },
  { name: 'mem_used',       oid: OID.memUsed,        kind: 'scalar', desc: 'fwMemBytesUsed (includes cache)' },
  { name: 'mem_available',  oid: OID.memAvailable,   kind: 'scalar', desc: 'fwMemBytesAvailable' },
  { name: 'inspection',     oid: OID.inspectionPct,  kind: 'scalar', desc: 'fwInspectionPercentageUsed (%)' },
  { name: 'part_mount',     oid: OID.partMount,      kind: 'table',  desc: 'fwMountPointName' },
  { name: 'part_size',      oid: OID.partSize,       kind: 'table',  desc: 'fwPartitionSize' },
  { name: 'part_used',      oid: OID.partUsed,       kind: 'table',  desc: 'fwPartitionUsed' },
  { name: 'vpn_sa',         oid: OID.vpnIpsecSa,     kind: 'table',  desc: 'fwVpnEp4IpsecSa per endpoint' },
  { name: 'node_state',     oid: OID.nodeOperState,  kind: 'scalar', desc: 'nodeOperState (1=online)' },
  { name: 'node_cpu',       oid: OID.nodeCpuLoad,    kind: 'scalar', desc: 'nodeCPULoad (%)' },
  { name: 'node_tests',     oid: OID.nodeTestResult, kind: 'table',  desc: 'nodeTestResult (1=success, 2=failure)' },
];

// First 64-bit value of a scalar GET result, or null.
function first64(rows) {
  const r = (rows || [])[0];
  return r ? U.num64(r.value) : null;
}

// fwCpuStatsTable carries an aggregate row at index 0 ("Cpu(s)") plus one row
// per core. Prefer the aggregate; average the per-core rows only if it is
// missing, since averaging all rows would double-count the aggregate.
function cpuFromTable(rows) {
  if (!rows || !rows.length) return null;
  const agg = rows.find((r) => U.lastIndex(r.oid) === 0);
  if (agg) return U.num(agg.value);
  return U.avg(rows.filter((r) => U.lastIndex(r.oid) !== 0));
}

function parse(raw) {
  const out = [];

  // ── CPU: nodeCPULoad first, fwCpuTotal aggregate as fallback ──
  let cpu = U.first(raw.node_cpu);
  let cpuOid = OID.nodeCpuLoad;
  if (cpu === null) {
    cpu = cpuFromTable(raw.cpu_table);
    cpuOid = OID.cpuTotal;
  }
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, cpuOid));

  // ── Memory: available-based, so cache/buffers aren't counted as in use ──
  const memTotal = first64(raw.mem_total);
  const memAvail = first64(raw.mem_available);
  const memUsed = first64(raw.mem_used);
  if (memTotal > 0 && memAvail !== null) {
    out.push(U.sample('mem_pct', ((memTotal - memAvail) / memTotal) * 100, OID.memAvailable));
  } else if (memTotal > 0 && memUsed !== null) {
    // Older firmware without fwMemBytesAvailable — inflated, but better than nothing.
    out.push(U.sample('mem_pct', (memUsed / memTotal) * 100, OID.memUsed));
  }

  // ── Swap ──
  const swapTotal = first64(raw.swap_total);
  const swapUsed = first64(raw.swap_used);
  if (swapTotal > 0 && swapUsed !== null) {
    out.push(U.sample('swap_usage_pct', (swapUsed / swapTotal) * 100, OID.swapUsed));
  }

  // ── Connections ──
  const conn = first64(raw.conn);
  if (conn !== null) out.push(U.sample('session_count', conn, OID.connNumber));

  // ── Inspection memory (Unsigned32 percentage, not a 64-bit counter) ──
  const inspection = U.first(raw.inspection);
  if (inspection !== null) out.push(U.sample('inspection_mem_pct', inspection, OID.inspectionPct));

  // ── Disk: worst writable partition (see header — "/" is read-only/always full) ──
  const sizeByIdx = new Map((raw.part_size || []).map((r) => [U.lastIndex(r.oid), U.num64(r.value)]));
  const usedByIdx = new Map((raw.part_used || []).map((r) => [U.lastIndex(r.oid), U.num64(r.value)]));
  let worstPct = null;
  for (const r of raw.part_mount || []) {
    const mount = U.str(r.value).trim();
    if (!mount || mount === '/') continue;
    const idx = U.lastIndex(r.oid);
    const size = sizeByIdx.get(idx);
    const used = usedByIdx.get(idx);
    if (!(size > 0) || used === null || used === undefined) continue;
    const pct = (used / size) * 100;
    if (worstPct === null || pct > worstPct) worstPct = pct;
  }
  if (worstPct !== null) out.push(U.sample('disk_usage_pct', worstPct, OID.partUsed));

  // ── VPN: endpoints with at least one IPsec SA are carrying a tunnel ──
  if (raw.vpn_sa && raw.vpn_sa.length) {
    out.push(U.sample('vpn_tunnels_total', raw.vpn_sa.length, OID.vpnIpsecSa));
    out.push(U.sample('vpn_tunnels_active',
      U.countWhere(raw.vpn_sa.map((r) => ({ value: U.num64(r.value) })), (n) => n > 0), OID.vpnIpsecSa));
  }

  // ── Cluster node state + engine self-tests ──
  const state = U.first(raw.node_state);
  if (state !== null) {
    out.push(U.sample('node_online', ONLINE_STATES.has(state) ? 1 : 0, OID.nodeOperState));
  }
  if (raw.node_tests && raw.node_tests.length) {
    out.push(U.sample('node_test_failure_count',
      U.countWhere(raw.node_tests, (n) => n === 2), OID.nodeTestResult));
  }

  return out;
}

module.exports = { name: 'forcepoint', metrics, parse };

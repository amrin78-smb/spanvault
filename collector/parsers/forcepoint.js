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
  vpnLocal:       `${ENG}.12.1.2`,       // fwVpnEp4Local (InetAddressIPv4) — the uplink
  vpnRemote:      `${ENG}.12.1.3`,       // fwVpnEp4Remote (InetAddressIPv4)
  vpnRemoteType:  `${ENG}.12.1.4`,       // fwVpnEp4RemoteType (VpnEndpointType)
  vpnIpsecSa:     `${ENG}.12.1.7`,       // fwVpnEp4IpsecSa table (SAs per endpoint)
  nodeOperState:  `${NODE}.3.0`,         // nodeOperState enum
  nodeCpuLoad:    `${NODE}.4.0`,         // nodeCPULoad (Integer32 0..100)
  nodeTestIdent:  `${NODE}.7.1.2`,       // nodeTestIdentity table: test description
  nodeTestResult: `${NODE}.7.1.3`,       // nodeTestResult table: success(1)/failure(2)
};

// nodeOperState values that mean "this node is carrying traffic".
const ONLINE_STATES = new Set([1 /* online */, 3 /* lockedOnline */]);

// VpnEndpointType. mobile(3) is a VPN client, not a site-to-site tunnel — the
// engine reports all mobile clients as one aggregate row per local endpoint.
const REMOTE_MOBILE = 3;

// InetAddressIPv4 arrives as a 4-byte Buffer.
function ipv4(v) {
  if (Buffer.isBuffer(v) && v.length === 4) return Array.from(v).join('.');
  return U.str(v);
}

// Stable sensor index for a per-row sensor (a VPN peer, an uplink, a self-test).
// A sensor's identity is metric_name + if_index, and the underlying SNMP row
// indexes renumber whenever the engine's configuration changes — so the index
// is derived from the row's own name instead, which keeps a sensor's history
// attached to the thing it describes. FNV-1a masked to 31 bits, because
// if_index is an INTEGER column and an IPv4 read as one overflows above 127.x.
function stableIndex(text) {
  const s = String(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) & 0x7fffffff) || 1;  // never 0 — collectCandidates tests truthiness
}

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
  { name: 'vpn_local',      oid: OID.vpnLocal,       kind: 'table',  desc: 'fwVpnEp4Local (local uplink address)' },
  { name: 'vpn_remote',     oid: OID.vpnRemote,      kind: 'table',  desc: 'fwVpnEp4Remote (peer address)' },
  { name: 'vpn_type',       oid: OID.vpnRemoteType,  kind: 'table',  desc: 'fwVpnEp4RemoteType (3=mobile client)' },
  { name: 'vpn_sa',         oid: OID.vpnIpsecSa,     kind: 'table',  desc: 'fwVpnEp4IpsecSa per endpoint' },
  { name: 'node_state',     oid: OID.nodeOperState,  kind: 'scalar', desc: 'nodeOperState (1=online)' },
  { name: 'node_cpu',       oid: OID.nodeCpuLoad,    kind: 'scalar', desc: 'nodeCPULoad (%)' },
  { name: 'node_test_name', oid: OID.nodeTestIdent,  kind: 'table',  desc: 'nodeTestIdentity (test description)' },
  { name: 'node_tests',     oid: OID.nodeTestResult, kind: 'table',  desc: 'nodeTestResult (1=success, 2=failure)' },
];

// nodeTestIdentity is a long sentence that repeats the engine name, e.g.
// "Link Status:EU-SEY-CLU01/NIC 3" or "Multiping AIRTEL:EU-SEY-CLU01, src:
// interface 3, ping : 8.8.4.4 8.8.8.8". Keep the test kind, plus the NIC when
// there is one, and drop the rest — the engine name is already the device.
function testLabel(identity) {
  const s = U.str(identity).trim();
  if (!s) return '';
  const kind = s.split(':')[0].trim();
  const nic = s.match(/\/(NIC\s*\d+)/i);
  return nic ? `${kind} ${nic[1]}` : kind;
}

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

  // ── VPN: fwVpnEp4Table rolled up by remote peer ──
  // These are IPsec endpoint pairs (fwVpnEp4IpsecSa counts established IPsec
  // SAs); SSL VPN does not appear anywhere in this MIB. An engine with two
  // internet uplinks lists every peer once per local endpoint, so counting
  // rows reports each peer's idle backup path as a down tunnel — EU-SEY-CLU01
  // reads 31 of 55 rows against 23 of 24 actual peers. Peers are therefore
  // keyed by remote address, and a peer is up when any path to it has an SA.
  // Two row kinds can't be a named peer: mobile(3) rows are per-local-endpoint
  // aggregates of all VPN clients, and a dynamic peer that has never connected
  // reports 0.0.0.0. Both are counted separately rather than folded in.
  const localByIdx = new Map((raw.vpn_local || []).map((r) => [U.lastIndex(r.oid), ipv4(r.value)]));
  const remoteByIdx = new Map((raw.vpn_remote || []).map((r) => [U.lastIndex(r.oid), ipv4(r.value)]));
  const typeByIdx = new Map((raw.vpn_type || []).map((r) => [U.lastIndex(r.oid), U.num(r.value)]));
  const peers = new Map();
  const uplinks = new Map();   // local address -> tunnels currently up on it
  let mobileRows = 0, mobileSas = 0, dynTotal = 0, dynUp = 0, pathsDown = 0;

  for (const r of raw.vpn_sa || []) {
    const i = U.lastIndex(r.oid);
    const sas = U.num64(r.value) || 0;
    if (typeByIdx.get(i) === REMOTE_MOBILE) { mobileRows += 1; mobileSas += sas; continue; }
    const addr = remoteByIdx.get(i) || '';
    if (!addr || addr === '0.0.0.0') { dynTotal += 1; if (sas > 0) dynUp += 1; continue; }

    // Per-uplink tally: which local endpoint is actually carrying tunnels.
    // Peer-level availability stays quiet during an uplink failover by design,
    // so this is what shows an uplink has stopped carrying anything.
    const local = localByIdx.get(i);
    if (local && local !== '0.0.0.0') {
      const u = uplinks.get(local) || { up: 0, oid: `${OID.vpnLocal}.${i}` };
      if (sas > 0) u.up += 1;
      uplinks.set(local, u);
    }

    const p = peers.get(addr) || { up: false, oid: `${OID.vpnRemote}.${i}` };
    if (sas > 0) p.up = true; else pathsDown += 1;
    peers.set(addr, p);
  }

  for (const [addr, u] of uplinks) {
    out.push(U.sample('vpn_uplink_tunnels', u.up, u.oid, stableIndex(addr), addr));
  }

  if (peers.size) {
    let down = 0;
    for (const [addr, p] of peers) {
      if (!p.up) down += 1;
      out.push(U.sample('vpn_peer_up', p.up ? 1 : 0, p.oid, stableIndex(addr), addr));
    }
    out.push(U.sample('vpn_peers_total', peers.size, OID.vpnRemote));
    out.push(U.sample('vpn_peers_up', peers.size - down, OID.vpnIpsecSa));
    out.push(U.sample('vpn_peers_down', down, OID.vpnIpsecSa));
    // Paths, not peers: on a dual-uplink engine this is what exposes a failover
    // that peer-level availability deliberately stays quiet about.
    out.push(U.sample('vpn_paths_down', pathsDown, OID.vpnIpsecSa));
  }
  if (dynTotal) {
    out.push(U.sample('vpn_dynamic_total', dynTotal, OID.vpnRemote));
    out.push(U.sample('vpn_dynamic_up', dynUp, OID.vpnIpsecSa));
  }
  if (mobileRows) out.push(U.sample('vpn_mobile_sas', mobileSas, OID.vpnIpsecSa));

  // ── Cluster node state + engine self-tests ──
  const state = U.first(raw.node_state);
  if (state !== null) {
    out.push(U.sample('node_online', ONLINE_STATES.has(state) ? 1 : 0, OID.nodeOperState));
  }
  if (raw.node_tests && raw.node_tests.length) {
    out.push(U.sample('node_test_failure_count',
      U.countWhere(raw.node_tests, (n) => n === 2), OID.nodeTestResult));

    // One sensor per engine self-test. These are the engine's own health
    // checks — link status per NIC, and on a multi-uplink engine a Multiping
    // per ISP, which is the most direct uplink-reachability signal it has.
    // Tests can share a label (two "Free Swap Space" rows, one per node), so
    // same-labelled tests collapse into one sensor that is down if any fails.
    const nameByIdx = new Map((raw.node_test_name || []).map((r) => [U.lastIndex(r.oid), testLabel(r.value)]));
    const tests = new Map();
    for (const r of raw.node_tests) {
      const i = U.lastIndex(r.oid);
      const label = nameByIdx.get(i);
      if (!label) continue;
      const t = tests.get(label) || { ok: true, oid: `${OID.nodeTestResult}.${i}` };
      if (U.num(r.value) === 2) t.ok = false;
      tests.set(label, t);
    }
    for (const [label, t] of tests) {
      out.push(U.sample('node_test_ok', t.ok ? 1 : 0, t.oid, stableIndex(label), label));
    }
  }

  return out;
}

module.exports = { name: 'forcepoint', metrics, parse };

'use strict';
// Offline check of the Forcepoint NGFW SNMP parser (FORCEPOINT-NGFW-ENGINE-MIB,
// enterprise 47565). The synthetic varbinds below reproduce what a live walk
// returned on 2026-09-22 from two production engines on firmware 7.1.11
// (EU-DUB-FW01, appliance 120-1-C3; EU-SEY-CLU01, appliance 330-0-C1), so the
// expected values here are measured, not invented.
//
// The Counter64 columns are deliberately fed as Buffers, which is how net-snmp
// actually returns them — that is the bug class this parser has to survive.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const forcepoint = require(path.join(ROOT, 'collector/parsers/forcepoint.js'));
const { detectVendor } = require(path.join(ROOT, 'collector/parsers/index.js'));

const checks = [];
function check(name, ok) { checks.push([name, ok]); }
function near(a, b, tol) { return a !== null && a !== undefined && Math.abs(a - b) <= (tol || 0.05); }

const ENG = '1.3.6.1.4.1.47565.1.1.1';
const HW = `${ENG}.11`;
const MEM = `${HW}.2`;
const NODE = `${ENG}.19`;

// Counter64 / CounterBasedGauge64 arrive as big-endian Buffers.
function c64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
const scalar = (oid, value) => [{ oid, value }];
const byName = (samples) => new Map(samples.map((s) => [s.metric_name, s]));

// ── EU-SEY-CLU01: live values ────────────────────────────────────────────────
// mem 3989274624 total / 836907008 available -> 79.0% (used-over-total would
// have said 98.1%); swap 989134848 of 1006628864; inspection 85%; 5466 conns.
const seyRaw = {
  conn:          scalar(`${ENG}.4.0`, c64(5466)),
  cpu_table: [
    { oid: `${HW}.1.1.3.0`, value: 38 },   // aggregate row
    { oid: `${HW}.1.1.3.1`, value: 31 },
    { oid: `${HW}.1.1.3.2`, value: 45 },
  ],
  swap_total:    scalar(`${MEM}.1.0`, c64(1006628864)),
  swap_used:     scalar(`${MEM}.2.0`, c64(989134848)),
  mem_total:     scalar(`${MEM}.4.0`, c64(3989274624)),
  mem_used:      scalar(`${MEM}.5.0`, c64(3911958528)),
  mem_available: scalar(`${MEM}.10.0`, c64(836907008)),
  inspection:    scalar(`${MEM}.12.0`, 85),
  part_mount: [
    { oid: `${HW}.3.1.3.1`, value: Buffer.from('/') },
    { oid: `${HW}.3.1.3.2`, value: Buffer.from('/data') },
    { oid: `${HW}.3.1.3.3`, value: Buffer.from('/spool') },
  ],
  part_size: [
    { oid: `${HW}.3.1.4.1`, value: c64(486400) },
    { oid: `${HW}.3.1.4.2`, value: c64(1980080) },
    { oid: `${HW}.3.1.4.3`, value: c64(3286984) },
  ],
  part_used: [
    { oid: `${HW}.3.1.5.1`, value: c64(486400) },   // "/" is 100% by design
    { oid: `${HW}.3.1.5.2`, value: c64(328680) },   // /data  16.6%
    { oid: `${HW}.3.1.5.3`, value: c64(2265680) },  // /spool 68.9% <- the worst real one
  ],
  // Dual-uplink shape, as on the real EU-SEY-CLU01: every peer is listed once
  // per local endpoint. Rows 1/2 are the mobile-client aggregates (one per
  // uplink), 3/4 are peer A on each uplink (up via .50 only — a failover, not
  // an outage), 5/6 are peer B (up on both), 7 is a dynamic peer that has
  // never connected, 8/9 are peer C (down on both — a genuinely dead tunnel).
  vpn_local: [
    { oid: `${ENG}.12.1.2.1`, value: Buffer.from([41, 79, 60, 50]) },
    { oid: `${ENG}.12.1.2.2`, value: Buffer.from([154, 70, 164, 16]) },
    { oid: `${ENG}.12.1.2.3`, value: Buffer.from([41, 79, 60, 50]) },
    { oid: `${ENG}.12.1.2.4`, value: Buffer.from([154, 70, 164, 16]) },
    { oid: `${ENG}.12.1.2.5`, value: Buffer.from([41, 79, 60, 50]) },
    { oid: `${ENG}.12.1.2.6`, value: Buffer.from([154, 70, 164, 16]) },
    { oid: `${ENG}.12.1.2.7`, value: Buffer.from([41, 79, 60, 50]) },
    { oid: `${ENG}.12.1.2.8`, value: Buffer.from([41, 79, 60, 50]) },
    { oid: `${ENG}.12.1.2.9`, value: Buffer.from([154, 70, 164, 16]) },
  ],
  vpn_remote: [
    { oid: `${ENG}.12.1.3.1`, value: Buffer.from([0, 0, 0, 0]) },        // mobile aggregate
    { oid: `${ENG}.12.1.3.2`, value: Buffer.from([0, 0, 0, 0]) },        // mobile aggregate
    { oid: `${ENG}.12.1.3.3`, value: Buffer.from([62, 6, 45, 58]) },     // peer A
    { oid: `${ENG}.12.1.3.4`, value: Buffer.from([62, 6, 45, 58]) },     // peer A
    { oid: `${ENG}.12.1.3.5`, value: Buffer.from([88, 157, 159, 18]) },  // peer B
    { oid: `${ENG}.12.1.3.6`, value: Buffer.from([88, 157, 159, 18]) },  // peer B
    { oid: `${ENG}.12.1.3.7`, value: Buffer.from([0, 0, 0, 0]) },        // dynamic, never connected
    { oid: `${ENG}.12.1.3.8`, value: Buffer.from([213, 146, 77, 58]) },  // peer C
    { oid: `${ENG}.12.1.3.9`, value: Buffer.from([213, 146, 77, 58]) },  // peer C
  ],
  vpn_type: [
    { oid: `${ENG}.12.1.4.1`, value: 3 },  // mobile
    { oid: `${ENG}.12.1.4.2`, value: 3 },  // mobile
    { oid: `${ENG}.12.1.4.3`, value: 1 },
    { oid: `${ENG}.12.1.4.4`, value: 1 },
    { oid: `${ENG}.12.1.4.5`, value: 1 },
    { oid: `${ENG}.12.1.4.6`, value: 1 },
    { oid: `${ENG}.12.1.4.7`, value: 2 },  // dynamic
    { oid: `${ENG}.12.1.4.8`, value: 1 },
    { oid: `${ENG}.12.1.4.9`, value: 1 },
  ],
  vpn_sa: [
    { oid: `${ENG}.12.1.7.1`, value: 2 },  // mobile SAs on uplink .50
    { oid: `${ENG}.12.1.7.2`, value: 0 },
    { oid: `${ENG}.12.1.7.3`, value: 3 },  // peer A up via .50
    { oid: `${ENG}.12.1.7.4`, value: 0 },  // peer A idle on .16
    { oid: `${ENG}.12.1.7.5`, value: 4 },  // peer B up via .50
    { oid: `${ENG}.12.1.7.6`, value: 3 },  // peer B up via .16 too
    { oid: `${ENG}.12.1.7.7`, value: 0 },  // dynamic, not connected
    { oid: `${ENG}.12.1.7.8`, value: 0 },  // peer C down
    { oid: `${ENG}.12.1.7.9`, value: 0 },  // peer C down
  ],
  node_state:    scalar(`${NODE}.3.0`, 1),
  node_cpu:      scalar(`${NODE}.4.0`, 36),
  node_test_name: [
    { oid: `${NODE}.7.1.2.1`, value: Buffer.from('Link Status:EU-SEY-CLU01/NIC 4') },
    { oid: `${NODE}.7.1.2.2`, value: Buffer.from('Multiping INTELVISION:EU-SEY-CLU01, src: interface 5, ping : 8.8.8.8 8.8.4.4') },
    { oid: `${NODE}.7.1.2.3`, value: Buffer.from('Multiping AIRTEL:EU-SEY-CLU01, src: interface 3, ping : 8.8.4.4 8.8.8.8') },
  ],
  node_tests: [
    { oid: `${NODE}.7.1.3.1`, value: 1 },
    { oid: `${NODE}.7.1.3.2`, value: 1 },
    { oid: `${NODE}.7.1.3.3`, value: 1 },
  ],
};

const sey = byName(forcepoint.parse(seyRaw));

check('cpu_pct comes from nodeCPULoad, not the fwCpuTotal aggregate',
  sey.get('cpu_pct').value === 36 && sey.get('cpu_pct').oid === `${NODE}.4.0`);
check('mem_pct is available-based (79.0%), not used-over-total (98.1%)',
  near(sey.get('mem_pct').value, 79.0, 0.1));
check('mem_pct decodes Counter64 Buffers (not NaN/null)',
  Number.isFinite(sey.get('mem_pct').value));
check('session_count decodes a Counter64 Buffer',
  sey.get('session_count').value === 5466);
check('swap_usage_pct = 98.3%', near(sey.get('swap_usage_pct').value, 98.26, 0.05));
check('inspection_mem_pct passes through the Unsigned32 gauge',
  sey.get('inspection_mem_pct').value === 85);
check('disk_usage_pct ignores the always-full read-only "/" and reports /spool',
  near(sey.get('disk_usage_pct').value, 68.93, 0.05));
// ── VPN: peers, not rows ─────────────────────────────────────────────────────
const byMetric = (samples, name) => samples.filter((s) => s.metric_name === name);
const seyAll = forcepoint.parse(seyRaw);

check('vpn_peers_total counts distinct peers, not table rows (3, not 9)',
  sey.get('vpn_peers_total').value === 3);
check('vpn_peers_up treats a peer as up when ANY uplink has an SA',
  sey.get('vpn_peers_up').value === 2);
check('vpn_peers_down counts only peers down on every uplink',
  sey.get('vpn_peers_down').value === 1);
check('vpn_paths_down counts individual down paths (peer A idle + peer C x2)',
  sey.get('vpn_paths_down').value === 3);
check('mobile-client rows are excluded from the peer counts',
  sey.get('vpn_peers_total').value === 3);
check('vpn_mobile_sas sums SAs across the mobile aggregate rows',
  sey.get('vpn_mobile_sas').value === 2);
check('a dynamic peer that never connected is counted separately, not as a peer',
  sey.get('vpn_dynamic_total').value === 1 && sey.get('vpn_dynamic_up').value === 0);

const peerRows = byMetric(seyAll, 'vpn_peer_up');
const peerBy = new Map(peerRows.map((s) => [s.if_name, s]));
check('one vpn_peer_up sensor per peer, labelled with the peer address',
  peerRows.length === 3 && peerBy.has('62.6.45.58') && peerBy.has('88.157.159.18') && peerBy.has('213.146.77.58'));
check('peer up on only one uplink still reads up (failover is not an outage)',
  peerBy.get('62.6.45.58').value === 1);
check('peer down on every uplink reads down',
  peerBy.get('213.146.77.58').value === 0);
check('per-peer sensor indexes are unique and positive',
  new Set(peerRows.map((s) => s.if_index)).size === 3 && peerRows.every((s) => s.if_index > 0));
check('per-peer sensor index is stable across polls (derived from the address)',
  byMetric(forcepoint.parse(seyRaw), 'vpn_peer_up')
    .every((s, i) => s.if_index === peerRows[i].if_index));
check('per-peer index fits an INTEGER column',
  peerRows.every((s) => s.if_index <= 2147483647));

// ── VPN: per-uplink ──────────────────────────────────────────────────────────
const uplinks = new Map(byMetric(seyAll, 'vpn_uplink_tunnels').map((s) => [s.if_name, s.value]));
check('one vpn_uplink_tunnels sensor per local endpoint', uplinks.size === 2);
check('uplink 41.79.60.50 is carrying 2 tunnels', uplinks.get('41.79.60.50') === 2);
check('uplink 154.70.164.16 is carrying 1 tunnel', uplinks.get('154.70.164.16') === 1);
check('uplink tallies ignore the mobile aggregate rows',
  uplinks.get('41.79.60.50') + uplinks.get('154.70.164.16') === 3);

// An uplink that has gone dead reports 0 while peer availability stays quiet.
const deadUplink = Object.assign({}, seyRaw, {
  vpn_sa: seyRaw.vpn_sa.map((r) => (['3', '5'].includes(r.oid.split('.').pop())
    ? { oid: r.oid, value: 0 } : r)),
});
const du = forcepoint.parse(deadUplink);
const duUp = new Map(byMetric(du, 'vpn_uplink_tunnels').map((s) => [s.if_name, s.value]));
const duBy = new Map(du.map((s) => [s.metric_name, s]));
check('a dead uplink reports 0 tunnels while its peers stay up via the other uplink',
  duUp.get('41.79.60.50') === 0 && duUp.get('154.70.164.16') === 1);
check('peer A drops to down when both of its uplinks lose SAs',
  duBy.get('vpn_peers_down').value === 2);

// ── Engine self-tests ────────────────────────────────────────────────────────
const tests = new Map(byMetric(seyAll, 'node_test_ok').map((s) => [s.if_name, s.value]));
check('one node_test_ok sensor per engine self-test', tests.size === 3);
check('nodeTestIdentity is shortened to the test kind plus NIC',
  tests.has('Link Status NIC 4'));
check('per-ISP Multiping tests surface under their own names',
  tests.has('Multiping INTELVISION') && tests.has('Multiping AIRTEL'));
check('a passing test reads 1', tests.get('Multiping AIRTEL') === 1);

const failedTest = Object.assign({}, seyRaw, {
  node_tests: [
    { oid: `${NODE}.7.1.3.1`, value: 1 },
    { oid: `${NODE}.7.1.3.2`, value: 1 },
    { oid: `${NODE}.7.1.3.3`, value: 2 },  // AIRTEL multiping failing
  ],
});
const ft = new Map(byMetric(forcepoint.parse(failedTest), 'node_test_ok').map((s) => [s.if_name, s.value]));
check('a failing per-ISP multiping reads 0 while the other stays 1',
  ft.get('Multiping AIRTEL') === 0 && ft.get('Multiping INTELVISION') === 1);

// Two tests can share a label (one row per cluster node) — they must collapse
// into a single sensor that is down if either fails, not two colliding sensors.
const dupLabels = Object.assign({}, seyRaw, {
  node_test_name: [
    { oid: `${NODE}.7.1.2.1`, value: Buffer.from('Free Swap Space:EU-DUB-FW01 executed on : EU-DUB-FW01 node 1') },
    { oid: `${NODE}.7.1.2.2`, value: Buffer.from('Free Swap Space:EU-DUB-FW01 executed on : EU-DUB-FW01 node 2') },
  ],
  node_tests: [
    { oid: `${NODE}.7.1.3.1`, value: 1 },
    { oid: `${NODE}.7.1.3.2`, value: 2 },
  ],
});
const dl = byMetric(forcepoint.parse(dupLabels), 'node_test_ok');
check('same-labelled tests collapse to one sensor, down if either fails',
  dl.length === 1 && dl[0].if_name === 'Free Swap Space' && dl[0].value === 0);
check('node_online = 1 for nodeOperState online(1)', sey.get('node_online').value === 1);
check('node_test_failure_count = 0 when every test succeeds',
  sey.get('node_test_failure_count').value === 0);

// ── Fallbacks and edge cases ─────────────────────────────────────────────────

// Firmware without netNodeObjects: CPU must fall back to the fwCpuTotal
// aggregate row (index 0), NOT the average of aggregate + per-core rows.
const noNode = Object.assign({}, seyRaw, { node_cpu: [], node_state: [], node_tests: [] });
const nn = byName(forcepoint.parse(noNode));
check('cpu_pct falls back to the fwCpuTotal aggregate row when nodeCPULoad is absent',
  nn.get('cpu_pct').value === 38 && nn.get('cpu_pct').oid === `${HW}.1.1.3`);
check('no node_online / node_test_failure_count emitted without netNodeObjects',
  !nn.has('node_online') && !nn.has('node_test_failure_count'));

// Per-core only (no aggregate row) -> average of the cores.
const coresOnly = Object.assign({}, seyRaw, {
  node_cpu: [],
  cpu_table: [
    { oid: `${HW}.1.1.3.1`, value: 30 },
    { oid: `${HW}.1.1.3.2`, value: 40 },
  ],
});
check('cpu_pct averages per-core rows when there is no aggregate row',
  byName(forcepoint.parse(coresOnly)).get('cpu_pct').value === 35);

// Older firmware without fwMemBytesAvailable -> used/total, inflated but present.
const noAvail = Object.assign({}, seyRaw, { mem_available: [] });
const na = byName(forcepoint.parse(noAvail));
check('mem_pct falls back to used/total when fwMemBytesAvailable is missing',
  near(na.get('mem_pct').value, 98.06, 0.05) && na.get('mem_pct').oid === `${MEM}.5.0`);

// Cluster states: lockedOnline(3) counts as online; offline(5) and standby(9) do not.
const stateOf = (v) => byName(forcepoint.parse(Object.assign({}, seyRaw,
  { node_state: scalar(`${NODE}.3.0`, v) }))).get('node_online').value;
check('node_online = 1 for lockedOnline(3)', stateOf(3) === 1);
check('node_online = 0 for offline(5)', stateOf(5) === 0);
check('node_online = 0 for standby(9)', stateOf(9) === 0);

// A failing engine self-test must be counted.
const withFailure = Object.assign({}, seyRaw, {
  node_tests: [
    { oid: `${NODE}.7.1.3.1`, value: 1 },
    { oid: `${NODE}.7.1.3.2`, value: 2 },  // failure
    { oid: `${NODE}.7.1.3.3`, value: 2 },  // failure
  ],
});
check('node_test_failure_count counts nodeTestResult == failure(2)',
  byName(forcepoint.parse(withFailure)).get('node_test_failure_count').value === 2);

// Every partition read-only/full -> no disk metric rather than a bogus 100%.
const rootOnly = Object.assign({}, seyRaw, {
  part_mount: [{ oid: `${HW}.3.1.3.1`, value: Buffer.from('/') }],
  part_size:  [{ oid: `${HW}.3.1.4.1`, value: c64(486400) }],
  part_used:  [{ oid: `${HW}.3.1.5.1`, value: c64(486400) }],
});
check('disk_usage_pct omitted when "/" is the only partition',
  !byName(forcepoint.parse(rootOnly)).has('disk_usage_pct'));

// Zero-size partition must not produce Infinity/NaN.
const zeroSize = Object.assign({}, seyRaw, {
  part_mount: [{ oid: `${HW}.3.1.3.2`, value: Buffer.from('/data') }],
  part_size:  [{ oid: `${HW}.3.1.4.2`, value: c64(0) }],
  part_used:  [{ oid: `${HW}.3.1.5.2`, value: c64(0) }],
});
check('disk_usage_pct skips a zero-size partition (no NaN/Infinity)',
  !byName(forcepoint.parse(zeroSize)).has('disk_usage_pct'));

// A device that answers nothing must yield no samples and must not throw.
let threw = false;
let empty = null;
try { empty = forcepoint.parse({}); } catch (_e) { threw = true; }
check('parse({}) returns [] and never throws',
  threw === false && Array.isArray(empty) && empty.length === 0);

// Every emitted value must be a finite number — the collector inserts these
// straight into snmp_results.value.
const allFinite = forcepoint.parse(seyRaw).every((s) => Number.isFinite(Number(s.value)));
check('every sample value is a finite number', allFinite);

// ── Vendor detection ─────────────────────────────────────────────────────────
check('sysObjectID under enterprise 47565 detects as forcepoint',
  detectVendor('', '1.3.6.1.4.1.47565.1.1.1.19.9.0') === 'forcepoint');
check('legacy enterprise 1369 still detects as forcepoint',
  detectVendor('', '1.3.6.1.4.1.1369.5.2') === 'forcepoint');
check('Forcepoint sysDescr still detects as forcepoint',
  detectVendor('Forcepoint NGFW 7.1.11', '') === 'forcepoint');
check('47565 detection does not hijack other enterprises',
  detectVendor('', '1.3.6.1.4.1.9.1.1745') === 'generic');

let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) fail++;
}
console.log(`\n${checks.length - fail}/${checks.length} passed`);
process.exit(fail ? 1 : 0);

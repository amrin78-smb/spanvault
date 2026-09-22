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
  vpn_sa: [
    { oid: `${ENG}.12.1.7.1`, value: 0 },
    { oid: `${ENG}.12.1.7.2`, value: 2 },
    { oid: `${ENG}.12.1.7.3`, value: 2 },
    { oid: `${ENG}.12.1.7.4`, value: 0 },
    { oid: `${ENG}.12.1.7.5`, value: 3 },
  ],
  node_state:    scalar(`${NODE}.3.0`, 1),
  node_cpu:      scalar(`${NODE}.4.0`, 36),
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
check('vpn_tunnels_total counts every endpoint row',
  sey.get('vpn_tunnels_total').value === 5);
check('vpn_tunnels_active counts only endpoints with >= 1 IPsec SA',
  sey.get('vpn_tunnels_active').value === 3);
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

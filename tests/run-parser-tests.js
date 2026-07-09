'use strict';

// Offline wireless-parser test runner — no test framework, no network, no DB.
// Each test file feeds synthetic SNMP walk data (formats verified against the
// vendor MIBs, and against live hardware for Aruba) into the vendor parsers and
// asserts the parsed AP/SSID/rogue/client fields. Run after ANY change to
// collector/wireless/* or collector/snmp-session.js:
//
//   node tests/run-parser-tests.js      (or: npm run test:parsers)
//
// Exits non-zero if any suite fails, so it can gate commits/CI.

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'test-aruba-parser.js',   // live-verified OIDs (Aruba 7205 / 9106, AOS 8.10 / 8.13)
  'test-aruba-rogue-parser.js', // live-verified WLSX-MON-MIB wlsxMonAPInfoTable (SMT_WLC / TUFS-OKF-WLC-1)
  'test-cisco-parser.js',   // MIB-verified (AIRESPACE-WIRELESS-MIB + CISCO-LWAPP-AP-MIB)
  'test-ruckus-parser.js',  // MIB-verified (RUCKUS-ZD-WLAN-MIB) + fortinet/mikrotik checks
  'test-mikrotik-client-parser.js', // MIB-verified (MIKROTIK-MIB mtxrWlRtabTable client parser)
  'test-ruckus-client-parser.js', // MIB-verified client table (RUCKUS-ZD-WLAN-MIB ruckusZDWLANStaTable)
  'test-hpe-client-parser.js', // MIB-verified (AI-AP-MIB aiClientTable) — no HPE hardware in lab
];

let failed = 0;
for (const suite of SUITES) {
  const file = path.join(__dirname, suite);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const passes = (out.match(/^PASS/gm) || []).length;
  const fails = (out.match(/^FAIL/gm) || []).length;
  if (r.status === 0 && fails === 0) {
    console.log(`[OK]   ${suite} — ${passes} checks passed`);
  } else {
    failed++;
    console.log(`[FAIL] ${suite} — exit ${r.status}, ${fails} failed check(s)`);
    console.log(out.trim().split('\n').filter((l) => /^FAIL|Error/.test(l)).join('\n'));
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) failed`);
  process.exit(1);
}
console.log('\nAll parser suites passed');

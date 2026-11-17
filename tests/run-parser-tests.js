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
  'test-cisco-client-parser.js', // MIB-verified (AIRESPACE-WIRELESS-MIB bsnMobileStationStatsTable) — was never registered here
  'test-fortinet-client-parser.js', // MIB-verified (FORTINET-FORTIGATE-MIB fgWcStaTable) — no Fortinet hardware in lab
  'test-grandstream-client-parser.js', // MIB-verified (GRANDSTREAM-GWN-MIB gwnClientTable) — no Grandstream GWN hardware in lab
  'test-forcepoint-parser.js', // live-verified SNMP vendor parser (FORCEPOINT-NGFW-ENGINE-MIB, engines on fw 7.1.11)
  'test-vendor-fetch.js', // discovery.js fetchVendorRaw batching/by-OID match/SNMPv1 fallback + unitFor
];

// Database-backed suites. Skipped unless SV_DB_NAME names a *test* database,
// because unlike the parser suites these need real PostgreSQL — and must never
// be pointed at a live install. Set one up with:
//   createdb sv_retire_test
//   pg_dump -s --no-owner --no-acl -d spanvault_dev | psql -d sv_retire_test
//   SV_DB_NAME=sv_retire_test node tests/run-parser-tests.js
const DB_SUITES = [
  'test-wireless-retirement.js', // AP retirement, controller-down suppression, wireless incidents
];
if (process.env.SV_DB_NAME && /test/.test(process.env.SV_DB_NAME)) {
  SUITES.push(...DB_SUITES);
} else if (DB_SUITES.length) {
  console.log(`[SKIP] ${DB_SUITES.join(', ')} — set SV_DB_NAME to a test database to run`);
}

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

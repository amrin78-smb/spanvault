'use strict';
// Offline check of the vendor OID fetch path and the unit derivation — the two
// pieces of collector/discovery.js that today's Forcepoint work leans on and
// that had no test coverage at all.
//
// fetchVendorRaw() batches scalar GETs, walks tables concurrently, matches the
// GET replies back BY OID (net-snmp drops varbind errors, so reply order and
// length can't be trusted), and falls back to one GET per OID when a multi-OID
// GET comes back empty — which is how SNMPv1 fails a whole PDU if any single
// OID in it is missing. Each of those is a silent-wrong-data failure if broken,
// not a crash.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { fetchVendorRaw, unitFor } = require(path.join(ROOT, 'collector/discovery.js'));

const checks = [];
function check(name, ok) { checks.push([name, ok]); }

// A stand-in net-snmp session. `mode` drives the failure being simulated.
function fakeSession(mode) {
  const calls = { gets: [], walks: [], maxInFlight: 0 };
  let inFlight = 0;
  return {
    calls,
    _enter() { inFlight += 1; calls.maxInFlight = Math.max(calls.maxInFlight, inFlight); },
    _leave() { inFlight -= 1; },
    get(oids, cb) {
      calls.gets.push(oids.slice());
      if (mode === 'v1-pdu-error' && oids.length > 1) return cb(new Error('NoSuchName'));
      // Reply deliberately OUT OF ORDER, with one OID missing and one carrying
      // a leading dot — all three things the by-OID match has to survive.
      const vbs = oids
        .filter((o) => !o.endsWith('.missing'))
        .map((o) => ({ oid: o === oids[0] ? `.${o}` : o, value: `v:${o}` }))
        .reverse();
      cb(null, vbs);
    },
    subtree(base, _maxRep, feed, done) {
      calls.walks.push(base);
      this._enter();
      setTimeout(() => {
        feed([{ oid: `${base}.1`, value: `w:${base}` }]);
        this._leave();
        done();
      }, mode === 'slow-walks' ? 20 : 0);
    },
    close() {},
  };
}

const parser = {
  metrics: [
    { name: 's1', oid: '1.3.6.1.4.1.1.1.0', kind: 'scalar' },
    { name: 's2', oid: '1.3.6.1.4.1.1.2.0', kind: 'scalar' },
    { name: 's3', oid: '1.3.6.1.4.1.1.3.missing', kind: 'scalar' },
    { name: 't1', oid: '1.3.6.1.4.1.1.10', kind: 'table' },
    { name: 't2', oid: '1.3.6.1.4.1.1.11', kind: 'table' },
  ],
};

(async () => {
  // ── Batching + by-OID matching ─────────────────────────────────────────────
  const s = fakeSession('ok');
  const raw = await fetchVendorRaw(s, parser);

  check('all scalars go out in ONE GET, not one per metric',
    s.calls.gets.length === 1 && s.calls.gets[0].length === 3);
  check('every table is walked', s.calls.walks.length === 2);
  check('a scalar is matched to its own OID despite the reply being reordered',
    raw.s1.length === 1 && raw.s1[0].value === 'v:1.3.6.1.4.1.1.1.0');
  check('a leading dot in the reply OID still matches',
    raw.s2.length === 1 && raw.s2[0].value === 'v:1.3.6.1.4.1.1.2.0');
  check('a scalar missing from the reply yields [] rather than another metric\'s value',
    Array.isArray(raw.s3) && raw.s3.length === 0);
  check('table results land under their own metric name',
    raw.t1[0].value === 'w:1.3.6.1.4.1.1.10' && raw.t2[0].value === 'w:1.3.6.1.4.1.1.11');
  check('every declared metric has an entry, present or not',
    parser.metrics.every((m) => Array.isArray(raw[m.name])));

  // ── SNMPv1 fallback ────────────────────────────────────────────────────────
  const v1 = fakeSession('v1-pdu-error');
  const rawV1 = await fetchVendorRaw(v1, parser);
  check('an empty multi-OID GET retries one OID at a time (SNMPv1 fails the whole PDU)',
    v1.calls.gets.length === 4 && v1.calls.gets[0].length === 3
    && v1.calls.gets.slice(1).every((g) => g.length === 1));
  check('the present scalars still come back through the fallback',
    rawV1.s1[0].value === 'v:1.3.6.1.4.1.1.1.0' && rawV1.s2.length === 1 && rawV1.s3.length === 0);

  // ── Walks run concurrently, not in series ──────────────────────────────────
  // Asserted by OVERLAP, not by elapsed time: Windows timer granularity is
  // ~15.6ms, so two concurrent 20ms timers can measure as 46ms and a timing
  // assertion fails on a correct implementation.
  const slow = fakeSession('slow-walks');
  await fetchVendorRaw(slow, parser);
  check(`both table walks are in flight at once (peak concurrency ${slow.calls.maxInFlight})`,
    slow.calls.maxInFlight === 2);

  // ── A parser with no metrics must not issue a GET ──────────────────────────
  const none = fakeSession('ok');
  const rawNone = await fetchVendorRaw(none, { metrics: [] });
  check('a parser with no metrics issues no requests',
    none.calls.gets.length === 0 && none.calls.walks.length === 0
    && Object.keys(rawNone).length === 0);

  // ── unitFor: the suffix tolerance that 1.107.1 turned on ───────────────────
  const units = {
    node_test_ok: 'state', node_test_ok_348228451: 'state',
    vpn_peer_up_9: 'state', node_online: 'state',
    if_10_oper: 'state', if_oper_status: 'state',
    vpn_uplink_tunnels_1490548310: 'count', vpn_peers_down: 'count',
    swap_usage_pct: '%', if_10_in_bps: 'bps', session_count: 'count',
  };
  const wrong = Object.entries(units).filter(([m, want]) => unitFor(m) !== want);
  check(`unitFor maps every shape correctly${wrong.length ? ` (wrong: ${JSON.stringify(wrong)})` : ''}`,
    wrong.length === 0);
  check('a per-sensor state metric is NOT mistaken for a plain number',
    unitFor('node_test_ok_348228451') === 'state');

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} passed`);
  process.exit(fail ? 1 : 0);
})();

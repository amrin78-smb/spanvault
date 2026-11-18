'use strict';
// Offline check of neighbour-discovery OUTCOMES — no network, no DB.
//
// The bug these pin: collector/topology.js#walkOid resolved `{}` on ANY error
// and storeNeighbors stamped topology_discovered_at on every pass, so a device
// whose SNMP agent never answered, a device whose community has no view of the
// LLDP subtree, and a device genuinely without neighbours were one identical
// result — zero rows and a fresh timestamp. Production carried two Forcepoint
// firewalls in that state for a week with nothing in the UI to say so.
//
// Two things are tested, and both are silent-wrong-answer failures rather than
// crashes:
//   1. the four-way outcome decision in discoverLldpNeighbors, and
//   2. the prune guard in storeNeighbors — pruning on an EMPTY read would wipe
//      a device's whole known topology the first time its LLDP went quiet.
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(name, ok) { checks.push([name, ok]); }

// ── A stand-in net-snmp, installed in the module cache before topology.js is
// loaded, so the real decision tree runs against synthetic walk results. ──────
function installFakeSnmp(behaviour) {
  const snmpPath = require.resolve('net-snmp');
  const fake = {
    Version1: 1,
    Version2c: 2,
    SecurityLevel: { authPriv: 3 },
    AuthProtocols: { sha: 'sha' },
    PrivProtocols: { aes: 'aes' },
    isVarbindError: (vb) => !!(vb && vb.isError),
    createSession: () => makeSession(behaviour),
    createV3Session: () => makeSession(behaviour),
  };
  require.cache[snmpPath] = {
    id: snmpPath, filename: snmpPath, loaded: true, exports: fake, children: [], paths: [],
  };
  // Drop any cached copy of the modules under test so they pick the fake up.
  for (const m of ['collector/topology.js', 'collector/topologyStatus.js']) {
    const f = path.join(ROOT, m);
    try { delete require.cache[require.resolve(f)]; } catch (e) { /* not loaded */ }
  }
  return require(path.join(ROOT, 'collector/topology.js'));
}

function makeSession(b) {
  return {
    close() {},
    get(oids, cb) {
      if (b.agentDead) return cb(new Error('Request timed out'));
      cb(null, [{ oid: oids[0], value: 'SW-TEST' }]);
    },
    subtree(base, _maxRep, feed, done) {
      const rows = (b.walks && b.walks[base]) || null;
      if (b.walkErrors && b.walkErrors[base]) {
        if (rows) feed(rows);
        return done(new Error(b.walkErrors[base]));
      }
      if (b.agentDead) return done(new Error('Request timed out'));
      if (rows) feed(rows);
      done(null);
    },
  };
}

const REM_SYSNAME = '1.0.8802.1.1.2.1.4.1.1.9';
const REM_PORTDESC = '1.0.8802.1.1.2.1.4.1.1.8';
const LOC_PORTDESC = '1.0.8802.1.1.2.1.3.7.1.4';
const DEV = { id: 7, name: 'EU-TEST-FW01', ip_address: '10.0.0.1', snmp_version: '2c', snmp_community: 'x' };

// A single neighbour on local port 9, with a real local port description.
const ONE_NEIGHBOUR = {
  walks: {
    [REM_SYSNAME]: [{ oid: `${REM_SYSNAME}.0.9.1`, value: 'CORE-SW01' }],
    [REM_PORTDESC]: [{ oid: `${REM_PORTDESC}.0.9.1`, value: 'Gi1/0/24' }],
    [LOC_PORTDESC]: [{ oid: `${LOC_PORTDESC}.9`, value: 'eth0_9' }],
  },
};

// ── A fake pg pool that records every statement ──────────────────────────────
function fakePool() {
  const sql = [];
  return {
    sql,
    async query(text, params) {
      sql.push([text.replace(/\s+/g, ' ').trim(), params]);
      if (/SELECT NOW\(\)/.test(text)) return { rows: [{ t: new Date('2026-11-18T10:00:00Z') }] };
      if (/^SELECT id, name, ip_address FROM monitored_devices/.test(text.trim())) return { rows: [] };
      if (/^DELETE FROM topology_links/.test(text.trim())) return { rowCount: 3, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
}

(async () => {
  const ts = require(path.join(ROOT, 'collector/topologyStatus.js'));

  // ── 1. The four outcomes ───────────────────────────────────────────────────
  {
    const topo = installFakeSnmp(ONE_NEIGHBOUR);
    const r = await topo.discoverLldpNeighbors(DEV);
    check('a neighbour table with rows is ok', r.status === 'ok' && r.neighbors.length === 1);
    // ⛔ THE OID FIX. lldpLocPortDesc sits under lldpLocalSystemData (.3); the
    // old constant omitted it, so this always fell through to `port<N>` —
    // 66 of 66 production links carried the fallback.
    check('the local port is its real description, not the port<N> fallback',
      r.neighbors[0].localPort === 'eth0_9');
    check('the neighbour port comes from the far end', r.neighbors[0].neighborPort === 'Gi1/0/24');
  }
  {
    // THE ORIGINAL SYMPTOM: agent answers, table is empty.
    const topo = installFakeSnmp({ walks: {} });
    const r = await topo.discoverLldpNeighbors(DEV);
    check('an empty table on a live agent is no_data, NOT an error', r.status === 'no_data');
    check('no_data still carries an explanation naming what we cannot tell apart',
      !!r.error && /LLDP MIB|disabled/.test(r.error));
  }
  {
    // THE DANGEROUS CONFUSION: the agent is not answering at all.
    const topo = installFakeSnmp({ agentDead: true });
    const r = await topo.discoverLldpNeighbors(DEV);
    check('an agent that does not answer is unreachable, NOT "no neighbours"',
      r.status === 'unreachable');
  }
  {
    // A walk that fails on a live agent.
    const topo = installFakeSnmp({ walks: {}, walkErrors: { [REM_SYSNAME]: 'authorizationError' } });
    const r = await topo.discoverLldpNeighbors(DEV);
    check('a failed walk on a live agent is an error, and reports the reason',
      r.status === 'error' && /authorizationError/.test(r.error || ''));
  }
  {
    // A walk that died part way still returns what it reached.
    const topo = installFakeSnmp({
      walks: ONE_NEIGHBOUR.walks,
      walkErrors: { [REM_SYSNAME]: 'Request timed out' },
    });
    const r = await topo.discoverLldpNeighbors(DEV);
    check('rows win: a partial walk is ok with the error recorded, not a failure',
      r.status === 'ok' && r.neighbors.length === 1 && /timed out/.test(r.error || ''));
  }

  // ── 2. CDP applicability ───────────────────────────────────────────────────
  check('CDP is not_applicable on a non-Cisco device', !ts.cdpApplicable({ device_vendor: 'forcepoint' }));
  check('CDP applies to a Cisco device', ts.cdpApplicable({ device_vendor: 'Cisco Systems' }));
  check('a missing vendor is not guessed into Cisco', !ts.cdpApplicable({}));
  {
    const topo = installFakeSnmp({ walks: {} });
    const d = await topo.discoverDevice({ ...DEV, device_vendor: 'forcepoint' });
    const cdp = d.parts.find((p) => p.protocol === 'cdp');
    check('a non-Cisco device never walks CDP, and reports it not_applicable',
      cdp.status === 'not_applicable');
    check('not_applicable does not drag the verdict away from the LLDP result',
      d.status === 'no_data');
  }

  // ── 3. The collapse rule ───────────────────────────────────────────────────
  check('a device never walked is pending, not ok',
    ts.collapse(ts.pendingParts({ device_vendor: 'forcepoint' })) === 'pending');
  check('ok outranks a side error — the two protocols are one dataset',
    ts.collapse([ts.part('lldp', 'ok', 4), ts.part('cdp', 'error', 0, 'x')]) === 'ok');
  check('unreachable outranks everything, including rows from an earlier pass',
    ts.collapse([ts.part('lldp', 'unreachable', 0, 'timeout'), ts.part('cdp', 'ok', 2)]) === 'unreachable');
  check('all-empty collapses to no_data, not ok',
    ts.collapse([ts.part('lldp', 'no_data', 0, 'empty'), ts.part('cdp', 'not_applicable', 0)]) === 'no_data');
  check('an all-not_applicable device reports unknown rather than borrowing an answer',
    ts.collapse([ts.part('lldp', 'not_applicable', 0), ts.part('cdp', 'not_applicable', 0)]) === 'unknown');

  // ── 4. describeTopology is JSON-safe and degrades on an un-migrated row ────
  {
    const d = ts.describeTopology({
      topology_status: 'no_data',
      topology_parts: [{ protocol: 'lldp', status: 'no_data', count: 0, error: 'empty' }],
      topology_error: 'empty',
      topology_discovered_at: new Date('2026-11-18T08:22:00Z'),
    });
    check('describeTopology serialises the timestamp',
      d.topology_discovered_at === '2026-11-18T08:22:00.000Z');
    check('describeTopology survives a JSON round-trip',
      JSON.stringify(JSON.parse(JSON.stringify(d))) === JSON.stringify(d));
    const bare = ts.describeTopology({ id: 1, device_vendor: 'forcepoint' });
    check('a row written before the columns existed reads as pending, not ok',
      bare.topology_status === 'pending');
    const broken = ts.describeTopology({ topology_parts: '{not json' });
    check('a malformed topology_parts degrades to pending instead of throwing',
      broken.topology_status === 'pending');
  }

  // ── 5. The prune guard — the one that can destroy data ─────────────────────
  {
    const topo = installFakeSnmp(ONE_NEIGHBOUR);
    const pool = fakePool();
    const result = await topo.discoverDevice({ ...DEV, device_vendor: 'forcepoint' });
    const out = await topo.storeNeighbors(pool, DEV, result);
    const deletes = pool.sql.filter(([t]) => t.startsWith('DELETE FROM topology_links'));
    check('a successful walk prunes links that did not come back', deletes.length === 1);
    check('the prune is scoped to one device AND one protocol',
      deletes.length === 1 && deletes[0][1][0] === DEV.id && deletes[0][1][1] === 'lldp');
    check('the prune marker is the DATABASE clock, not the app clock',
      pool.sql.some(([t]) => /SELECT NOW\(\)/.test(t)));
    check('the outcome is persisted alongside the timestamp',
      pool.sql.some(([t, p]) => /UPDATE monitored_devices/.test(t) && /topology_status/.test(t)
        && p && p[1] === 'ok'));
    check('storeNeighbors reports what it did', out.links === 1 && out.status === 'ok');
  }
  {
    // ⛔ THE INVERTED FAILURE. An empty read must never delete anything: one
    // quiet cycle, or a community whose view was tightened, would otherwise
    // erase the device's entire known topology and the map would go blank with
    // nothing to explain it.
    const topo = installFakeSnmp({ walks: {} });
    const pool = fakePool();
    const result = await topo.discoverDevice({ ...DEV, device_vendor: 'forcepoint' });
    const out = await topo.storeNeighbors(pool, DEV, result);
    const deletes = pool.sql.filter(([t]) => t.startsWith('DELETE FROM topology_links'));
    check('an EMPTY read prunes nothing — known links are kept', deletes.length === 0);
    check('and the device records no_data so the staleness is visible', out.status === 'no_data');
  }
  {
    const topo = installFakeSnmp({ agentDead: true });
    const pool = fakePool();
    const result = await topo.discoverDevice({ ...DEV, device_vendor: 'forcepoint' });
    const out = await topo.storeNeighbors(pool, DEV, result);
    check('an unreachable agent prunes nothing',
      pool.sql.filter(([t]) => t.startsWith('DELETE FROM topology_links')).length === 0);
    check('an unreachable agent is recorded as unreachable', out.status === 'unreachable');
  }

  let fail = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) fail++;
  }
  console.log(`\n${checks.length - fail}/${checks.length} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });

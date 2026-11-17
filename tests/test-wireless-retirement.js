'use strict';
/**
 * test-wireless-retirement.js — AP retirement, controller-down suppression and
 * wireless incident correlation, exercised against a real PostgreSQL database.
 *
 * ⛔ THESE BRANCHES ONLY MATTER WHEN SOMETHING IS ALREADY WRONG, so reading the
 * code is not evidence. Every assertion below drives the REAL
 * evaluateWirelessAlerts()/correlateIncidents() against real rows and then reads
 * the database back.
 *
 * Needs a scratch database (schema cloned from a dev DB), named by SV_DB_NAME.
 * It is dropped and recreated by the runner, never pointed at a live install.
 */
const assert = require('assert');

const DB = process.env.SV_DB_NAME;
if (!DB || !/test/.test(DB)) {
  console.error('[FAIL] refusing to run: SV_DB_NAME must be a *test* database, got', DB);
  process.exit(1);
}

// Set BEFORE requiring the modules — both build their pool at require time, and
// dotenv does not overwrite an env var that is already set.
process.env.SV_DB_HOST = process.env.SV_DB_HOST || '/var/run/postgresql';
process.env.SV_DB_USER = process.env.SV_DB_USER || process.env.USER;
process.env.SV_DB_PASS = process.env.SV_DB_PASS || '';

const collector = require('../collector/collector.js');
const intelligence = require('../api/intelligence.js');
const sv = collector.sv;

let checks = 0;
// `PASS`-prefixed so run-parser-tests.js's shared counter picks these up.
function ok(cond, msg) { assert.ok(cond, msg); checks++; console.log('PASS', msg); }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; console.log('PASS', msg); }

const DAY = 86400000;
async function reset() {
  await sv.query('TRUNCATE alerts, incidents, wireless_aps, wireless_controllers RESTART IDENTITY CASCADE');
  await sv.query(`DELETE FROM app_settings WHERE key = 'wireless_ap_stale_days'`);
  await collector.loadSettings();
}
async function ctrl(name, status) {
  const r = await sv.query(
    `INSERT INTO wireless_controllers (name, vendor, active, status, site_id)
     VALUES ($1,'cisco',TRUE,$2,1) RETURNING id`, [name, status]);
  return r.rows[0].id;
}
async function ap(controllerId, name, status, daysUnseen) {
  const seen = daysUnseen == null ? null : new Date(Date.now() - daysUnseen * DAY);
  const r = await sv.query(
    `INSERT INTO wireless_aps (controller_id, name, status, site_id, site_name, last_seen_at)
     VALUES ($1,$2,$3,1,'HQ',$4) RETURNING id`, [controllerId, name, status, seen]);
  return r.rows[0].id;
}
const alertsFor = async (apId) => (await sv.query(
  `SELECT status, alert_type, suppression_reason, incident_id FROM alerts
    WHERE wireless_ap_id = $1 AND alert_type = 'wireless_ap_down'`, [apId])).rows;
const retiredAt = async (apId) => (await sv.query(
  `SELECT retired_at FROM wireless_aps WHERE id = $1`, [apId])).rows[0].retired_at;

async function main() {
  // ── A. stale vs genuinely-down ────────────────────────────────────────────
  await reset();
  const c1 = await ctrl('wlc-a', 'ok');
  const gone   = await ap(c1, 'ap-gone',   'offline', 158); // the production case
  const downNow = await ap(c1, 'ap-down',  'offline', 0.2);
  const upNow   = await ap(c1, 'ap-up',    'online',  0);
  await collector.evaluateWirelessAlerts();

  ok(await retiredAt(gone), 'A1: an AP unseen 158 days is retired');
  eq(alertsFor(gone).then ? (await alertsFor(gone)).filter(a => a.status === 'active').length : -1, 0,
    'A2: a retired AP raises no active critical');
  const dn = await alertsFor(downNow);
  eq(dn.filter((a) => a.status === 'active').length, 1, 'A3: an AP down since this morning DOES alert');
  eq(await retiredAt(downNow), null, 'A4: a recently-down AP is not retired');
  eq((await alertsFor(upNow)).length, 0, 'A5: an online AP has no alert');

  // ⛔ The whole point: the noise is gone and the signal survived.
  const active = (await sv.query(
    `SELECT count(*)::int n FROM alerts WHERE status='active' AND alert_type='wireless_ap_down'`)).rows[0].n;
  eq(active, 1, 'A6: 3 APs, 1 real outage, exactly 1 active critical');

  // ── B. idempotence + un-retirement ────────────────────────────────────────
  await collector.evaluateWirelessAlerts();
  eq((await alertsFor(gone)).filter((a) => a.status === 'active').length, 0,
    'B1: a second pass does not re-raise a retired AP');

  await sv.query(`UPDATE wireless_aps SET status='online', last_seen_at=NOW() WHERE id=$1`, [gone]);
  await collector.evaluateWirelessAlerts();
  eq(await retiredAt(gone), null, 'B2: an AP that reports again is un-retired automatically');

  // ⛔ and it must be able to alert again afterwards, or un-retiring is cosmetic
  await sv.query(`UPDATE wireless_aps SET status='offline' WHERE id=$1`, [gone]);
  await collector.evaluateWirelessAlerts();
  eq((await alertsFor(gone)).filter((a) => a.status === 'active').length, 1,
    'B3: a restored AP alerts normally when it goes down again');

  // ── C. the threshold is the SETTING, not a literal ────────────────────────
  await reset();
  const c2 = await ctrl('wlc-b', 'ok');
  const midAged = await ap(c2, 'ap-10d', 'offline', 10);
  await collector.evaluateWirelessAlerts();
  eq(await retiredAt(midAged), null, 'C1: 10 days is inside the default 14-day threshold');
  await sv.query(`INSERT INTO app_settings (key, value) VALUES ('wireless_ap_stale_days','7')
                  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
  // The collector caches app_settings and refreshes once a minute, so the new
  // value is not live until then — in production a threshold change takes up to
  // 60s to take effect. Drive that refresh explicitly rather than sleeping.
  await collector.loadSettings();
  await collector.evaluateWirelessAlerts();
  ok(await retiredAt(midAged), 'C2: lowering the setting to 7 retires the same AP');

  // ⛔ A ZERO/NEGATIVE THRESHOLD MUST NOT RETIRE THE WHOLE ESTATE. app_settings
  // is freeform key/value and hand-edited, and at 0 every AP with a past
  // last_seen_at is instantly stale — which would silently end AP alerting
  // altogether. The floor lives where the value is used, not just in the form.
  await reset();
  const c2b = await ctrl('wlc-b2', 'ok');
  const fresh = await ap(c2b, 'ap-down-today', 'offline', 0.1);
  await sv.query(`INSERT INTO app_settings (key, value) VALUES ('wireless_ap_stale_days','0')
                  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
  await collector.loadSettings();
  await collector.evaluateWirelessAlerts();
  eq(await retiredAt(fresh), null, 'C3: a 0-day threshold is floored, not obeyed');
  eq((await alertsFor(fresh)).filter((x) => x.status === 'active').length, 1,
    'C4: and the AP that is genuinely down still alerts');

  // ── D. controller down suppresses, it does not resolve ────────────────────
  await reset();
  const c3 = await ctrl('wlc-c', 'ok');
  const a1 = await ap(c3, 'ap-c1', 'offline', 0.1);
  const a2 = await ap(c3, 'ap-c2', 'offline', 0.1);
  await collector.evaluateWirelessAlerts();
  eq((await alertsFor(a1)).filter((x) => x.status === 'active').length, 1, 'D1: AP alerts raised while controller ok');

  await sv.query(`UPDATE wireless_controllers SET status='error' WHERE id=$1`, [c3]);
  await collector.evaluateWirelessAlerts();
  const sup = (await alertsFor(a1)).filter((x) => x.status === 'suppressed');
  eq(sup.length, 1, 'D2: a down controller SUPPRESSES its APs alerts');
  ok(/wlc-c/.test(sup[0].suppression_reason || ''), 'D3: the suppression names the controller');
  eq((await alertsFor(a1)).filter((x) => x.status === 'resolved').length, 0,
    'D4: suppressed, NOT resolved — resolved would claim the AP came back');
  const ctrlAlert = (await sv.query(
    `SELECT count(*)::int n FROM alerts WHERE wireless_controller_id=$1
       AND alert_type='wireless_controller_down' AND status='active'`, [c3])).rows[0].n;
  eq(ctrlAlert, 1, 'D5: one controller alert stands in for the AP flood');

  // ⛔ recovery must restore alerting, or suppression is a silent black hole
  await sv.query(`UPDATE wireless_controllers SET status='ok' WHERE id=$1`, [c3]);
  await collector.evaluateWirelessAlerts();
  eq((await alertsFor(a1)).filter((x) => x.status === 'active').length, 1,
    'D6: when the controller recovers the still-down AP alerts again');

  // ── E. incident correlation ───────────────────────────────────────────────
  await reset();
  const c4 = await ctrl('wlc-d', 'ok');
  const e1 = await ap(c4, 'ap-d1', 'offline', 0.1);
  const e2 = await ap(c4, 'ap-d2', 'offline', 0.1);
  const e3 = await ap(c4, 'ap-d3', 'offline', 0.1);
  await collector.evaluateWirelessAlerts();
  await intelligence.correlateIncidents();
  const inc = (await sv.query(`SELECT id, title, affected_count FROM incidents WHERE status='active'`)).rows;
  eq(inc.length, 1, 'E1: three APs down together become ONE incident');
  eq(inc[0].affected_count, 3, 'E2: the incident counts all three');
  ok(/wlc-d/.test(inc[0].title), 'E3: the incident is named for the controller');
  for (const id of [e1, e2, e3]) {
    ok((await alertsFor(id))[0].incident_id === inc[0].id, `E4: ap ${id} is linked to the incident`);
  }

  // ⛔ THE INCIDENT MUST NOT CARRY A COUNT THAT GOES STALE. Caught live on the
  // 1.119.0 deploy: the title read "15 access points down on TUFS-OKF-WLC-1"
  // while 4 still were, because the count was written into the title at
  // creation and the other 11 had since been retired. A wrong number stated
  // confidently is the failure this whole change set exists to remove.
  ok(!/\d+ access points down/.test(inc[0].title), 'E7: the title carries no count');
  await sv.query(`UPDATE alerts SET status='resolved', resolved_at=NOW() WHERE wireless_ap_id=$1`, [e3]);
  await intelligence.correlateIncidents();
  const after = (await sv.query(`SELECT affected_count, status FROM incidents WHERE id=$1`, [inc[0].id])).rows[0];
  eq(after.affected_count, 2, 'E8: affected_count follows the APs that are still down');
  eq(after.status, 'active', 'E9: the incident stays open while any AP is still down');
  await sv.query(`UPDATE alerts SET status='resolved', resolved_at=NOW() WHERE incident_id=$1`, [inc[0].id]);
  await intelligence.correlateIncidents();
  eq((await sv.query(`SELECT status FROM incidents WHERE id=$1`, [inc[0].id])).rows[0].status, 'resolved',
    'E10: the incident auto-resolves once every linked alert has');

  // ⛔ A DEVICE INCIDENT WHOSE ROOT DEVICE WAS DELETED ALSO HAS A NULL
  // root_cause_device_id (the FK is ON DELETE SET NULL) — production has two.
  // The refresh above must key on the alerts actually being wireless, not on
  // that column, or it silently rewrites device incidents' counts too.
  const orphan = (await sv.query(
    `INSERT INTO incidents (title, root_cause_device_id, affected_count, severity, status, started_at)
     VALUES ('2 devices down in Nowhere', NULL, 2, 'critical', 'active', NOW()) RETURNING id`)).rows[0].id;
  await intelligence.correlateIncidents();
  const orphanAfter = (await sv.query(`SELECT affected_count, title FROM incidents WHERE id=$1`, [orphan])).rows[0];
  eq(orphanAfter.affected_count, 2, 'E11: a device incident with a deleted root device is NOT touched');
  eq(orphanAfter.title, '2 devices down in Nowhere', 'E12: and its title is left alone');

  // ⛔ a retired AP must never be dragged into an incident
  await reset();
  const c5 = await ctrl('wlc-e', 'ok');
  await ap(c5, 'ap-e-gone1', 'offline', 100);
  await ap(c5, 'ap-e-gone2', 'offline', 100);
  await collector.evaluateWirelessAlerts();
  await intelligence.correlateIncidents();
  eq((await sv.query(`SELECT count(*)::int n FROM incidents`)).rows[0].n, 0,
    'E5: retired APs produce no incident (nothing is wrong)');

  // ⛔ a lone AP stays a lone alert — an "incident" of one is just a longer row
  await reset();
  const c6 = await ctrl('wlc-f', 'ok');
  await ap(c6, 'ap-f1', 'offline', 0.1);
  await collector.evaluateWirelessAlerts();
  await intelligence.correlateIncidents();
  eq((await sv.query(`SELECT count(*)::int n FROM incidents`)).rows[0].n, 0,
    'E6: a single AP down does not become an incident');

  console.log(`[OK]   test-wireless-retirement.js — ${checks} checks passed`);
}

main()
  .then(async () => { await sv.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[FAIL]', e.message);
    try { await sv.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  });

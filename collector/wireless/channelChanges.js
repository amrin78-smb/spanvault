'use strict';

/**
 * channelChanges.js — records AP channel transitions into
 * wireless_channel_changes.
 *
 * Shared because there are TWO independent writers of wireless_aps' channel
 * columns, and a change seen by only one of them is a change that never gets
 * recorded:
 *   1. wirelessCollector.js upsertAp()      — every SNMP/API poll (~5 min)
 *   2. wireless/api/aruba-central.js pollRf() — the separate ~15-min RF pass,
 *      which is the ONLY writer of channel for aruba_central APs (their main
 *      poll reports channel as null by design; see mapAp()).
 *
 * Kept in its own module rather than exported from wirelessCollector.js:
 * wirelessCollector already requires aruba-central, so importing back the other
 * way would be a cycle.
 */

// DFS band (ETSI/FCC): 52-144. On detecting radar an AP must vacate the channel
// and stay off it for 30 minutes, so "was on DFS, now is not" is the strongest
// radar signal obtainable from polling alone — the radar event itself is only
// ever visible in the controller's own trap/syslog feed.
const DFS_LOW = 52;
const DFS_HIGH = 144;
const isDfsChannel = (ch) => ch != null && ch >= DFS_LOW && ch <= DFS_HIGH;

// Measured interference (%) at the moment of the change above which we call it
// interference-driven. Matches the wireless_interference_threshold_pct alert
// default so the two features never disagree about the same AP.
const CHANGE_INTERFERENCE_PCT = 30;

const intOrNull = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const numOrNull = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * recordChannelChanges(pool, apId, prev, next)
 *
 * `prev` — the AP row's channels BEFORE the write (or undefined/null: nothing
 *          is recorded, which is the correct behaviour for a first insert).
 * `next` — an object carrying radio_*_channel plus optional RF context for the
 *          same poll.
 *
 * Two cases that are NOT changes and must be skipped, or this table fills with
 * fiction:
 *   - next channel is null. A partial poll reports nothing and the caller's
 *     COALESCE leaves the stored value alone. aruba_central's 5-minute main poll
 *     ALWAYS does this, so counting it would invent two bogus changes per AP per
 *     cycle — more fabricated events than real ones.
 *   - prev channel is null. First channel ever seen for that radio: an
 *     observation, not a transition.
 *
 * Never throws. A logging failure must not break the poll that produced the data.
 */
async function recordChannelChanges(pool, apId, prev, next) {
  if (!apId || !prev || !next) return;
  const bands = [
    ['2.4', prev.radio_2g_channel, intOrNull(next.radio_2g_channel),
      numOrNull(next.radio_2g_util_pct), numOrNull(next.interference_pct_2g),
      intOrNull(next.noise_floor_2g), numOrNull(next.retry_rate_2g)],
    ['5', prev.radio_5g_channel, intOrNull(next.radio_5g_channel),
      numOrNull(next.radio_5g_util_pct), numOrNull(next.interference_pct_5g),
      intOrNull(next.noise_floor_5g), numOrNull(next.retry_rate_5g)],
    // 6GHz: no interference/noise/util on this feed yet, and it is not a DFS
    // band, so a move there is only ever recorded as 'unknown'.
    ['6', prev.radio_6g_channel, intOrNull(next.radio_6g_channel), null, null, null, null],
  ];

  for (const [band, from, to, util, interference, noise, retry] of bands) {
    if (to == null || from == null || from === to) continue;
    const leftDfs = isDfsChannel(from) && !isDfsChannel(to);
    // SUSPECTED, never confirmed: polling sees the consequence of radar, not
    // radar. Raw context is stored alongside so a human can judge for themselves.
    const cause = leftDfs
      ? 'radar_suspected'
      : (interference != null && interference >= CHANGE_INTERFERENCE_PCT)
        ? 'interference_suspected'
        : 'unknown';
    try {
      await pool.query(
        `INSERT INTO wireless_channel_changes
           (ap_id, band, from_channel, to_channel, left_dfs, inferred_cause,
            util_pct, interference_pct, noise_floor, retry_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [apId, band, from, to, leftDfs, cause, util, interference, noise, retry]
      );
      console.log(`[wireless] AP ${apId} ${band}GHz channel ${from} -> ${to} (${cause})`);
    } catch (e) {
      console.error('[wireless] channel-change insert failed:', e.message);
    }
  }
}

module.exports = { recordChannelChanges, isDfsChannel, DFS_LOW, DFS_HIGH, CHANGE_INTERFERENCE_PCT };

'use strict';

// Blends the RF signals the Wireless page already shows per-AP (channel
// utilization, retry rate, interference, band imbalance, weak-client ratio)
// into one 0-100 "how congested is this AP" number, so an admin doesn't have
// to mentally cross-reference 4+ separate metrics. Pure function — callers
// (api/server.js) fetch/aggregate the inputs; this just scores them.
//
// util dominates the blend (it's the most direct "is this AP busy" signal).
// retry/interference are scaled up before weighting since they rarely reach
// 100 even at genuinely bad levels (a 20% retry rate is already quite bad).
// imbalance and weak-client ratio are secondary structural signals, not
// moment-to-moment load, so they carry the smallest weights.
function computeCongestionScore({ util, retry, interference, imbalancePct, weakClientRatioPct }) {
  const utilC = Math.min(100, Math.max(0, util || 0)) * 0.35;
  const retryC = Math.min(100, Math.max(0, retry || 0) * 4) * 0.25;
  const intfC = Math.min(100, Math.max(0, interference || 0) * 2.5) * 0.15;
  const imbalanceC = Math.min(100, Math.max(0, imbalancePct || 0)) * 0.15;
  const weakC = Math.min(100, Math.max(0, weakClientRatioPct || 0)) * 0.10;
  const score = Math.round(utilC + retryC + intfC + imbalanceC + weakC);
  const clamped = Math.max(0, Math.min(100, score));

  // Per-factor breakdown, so a "High" badge can be explained instead of just
  // asserted. Without this the UI showed the level next to UTILISATION, which
  // is usually the SMALLEST real contributor — on a live example util supplied
  // 11 points of 58 while a saturated retry rate supplied 25 and a 100% band
  // imbalance supplied 15, so the badge read as contradicting the number
  // printed beside it.
  //
  // `saturated` is the other half of the explanation: each input is scaled then
  // capped at 100 before weighting, so past a threshold a factor stops
  // responding — a 38% and a 95% retry rate score identically. An operator
  // needs to see that the dial is already pinned.
  const factors = [
    { key: 'util',        label: 'Utilisation',    input: Math.max(0, util || 0),
      unit: '%', points: utilC,      max: 35, saturatesAt: 100, saturated: (util || 0) >= 100 },
    { key: 'retry',       label: 'Retry rate',     input: Math.max(0, retry || 0),
      unit: '%', points: retryC,     max: 25, saturatesAt: 25,  saturated: (retry || 0) >= 25 },
    { key: 'interference', label: 'Interference',  input: Math.max(0, interference || 0),
      unit: '%', points: intfC,      max: 15, saturatesAt: 40,  saturated: (interference || 0) >= 40 },
    { key: 'imbalance',   label: 'Band imbalance', input: Math.max(0, imbalancePct || 0),
      unit: '%', points: imbalanceC, max: 15, saturatesAt: 100, saturated: (imbalancePct || 0) >= 100 },
    { key: 'weak',        label: 'Weak clients',   input: Math.max(0, weakClientRatioPct || 0),
      unit: '%', points: weakC,      max: 10, saturatesAt: 100, saturated: (weakClientRatioPct || 0) >= 100 },
  ].map((f) => ({ ...f, points: Math.round(f.points * 10) / 10 }));
  // Found in the 2026-07-22 bug sweep: with the ORIGINAL 70/40 cutoffs, util
  // saturated at 100% contributes only 35 points (its own weight) and could
  // never alone escape "low", directly contradicting this file's own "util
  // dominates" comment above. Thresholds are now set against what the actual
  // weighted components can produce: util alone maxed = 35 (one major signal
  // maxed -> at least "medium"); util+retry both maxed = 60 (two major
  // signals maxed -> "high"). Re-derive these by hand again if the weights
  // above ever change — they're tuned together, not independently.
  const level = clamped >= 60 ? 'high' : clamped >= 35 ? 'medium' : 'low';
  // `factors` is additive — existing callers destructure { score, level } and are
  // unaffected. The LIST route deliberately does NOT serialise it (227 APs x 5
  // factors of payload for a column that only shows the level); the AP detail
  // route does, because that is where the number has to be justified.
  return { score: clamped, level, factors };
}

module.exports = { computeCongestionScore };

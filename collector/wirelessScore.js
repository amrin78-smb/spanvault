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
  // Found in the 2026-07-22 bug sweep: with the ORIGINAL 70/40 cutoffs, util
  // saturated at 100% contributes only 35 points (its own weight) and could
  // never alone escape "low", directly contradicting this file's own "util
  // dominates" comment above. Thresholds are now set against what the actual
  // weighted components can produce: util alone maxed = 35 (one major signal
  // maxed -> at least "medium"); util+retry both maxed = 60 (two major
  // signals maxed -> "high"). Re-derive these by hand again if the weights
  // above ever change — they're tuned together, not independently.
  const level = clamped >= 60 ? 'high' : clamped >= 35 ? 'medium' : 'low';
  return { score: clamped, level };
}

module.exports = { computeCongestionScore };

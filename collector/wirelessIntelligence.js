'use strict';
const { Pool } = require('pg');

async function computeWirelessIntelligence(pool, controllerId) {
  const aps = await pool.query(`
    SELECT * FROM wireless_aps
    WHERE controller_id = $1 AND status = 'online'
  `, [controllerId]);

  if (aps.rows.length === 0) return;
  const apList = aps.rows;

  // ── ALGORITHM 1: CO-CHANNEL INTERFERENCE DETECTION ──────────
  const channels2g = apList.map(a => a.radio_2g_channel).filter(Boolean);
  const channels5g = apList.map(a => a.radio_5g_channel).filter(Boolean);

  // Count APs that have at least one co-channel neighbor (i.e. share a channel
  // with another AP). This measures how many APs are AFFECTED by co-channel
  // interference — far more meaningful than total pairwise combinations, which
  // explode quadratically (e.g. 111 APs on channels 1/6/11 → thousands of pairs).
  function countAffectedByCoChannel(channels) {
    const freq = {};
    channels.forEach(ch => freq[ch] = (freq[ch] || 0) + 1);
    let affected = 0;
    Object.values(freq).forEach(count => {
      if (count > 1) affected += count;
    });
    return affected;
  }

  const coAffected2g = countAffectedByCoChannel(channels2g);
  const coAffected5g = countAffectedByCoChannel(channels5g);
  const totalCoAffected = coAffected2g + coAffected5g;

  const badChannels2g = channels2g.filter(
    ch => ![1,6,11].includes(ch)
  ).length;

  const interferenceScore = Math.min(100,
    (totalCoAffected / apList.length) * 30 +
    (badChannels2g / apList.length) * 20
  );

  // ── ALGORITHM 2: LOAD BALANCE ANALYSIS ──────────────────────
  const MAX_CLIENTS_PER_AP = 50;
  const clientCounts = apList.map(a => a.clients_total || 0);
  const totalClients = clientCounts.reduce((s,v) => s+v, 0);
  const avgClients = totalClients / apList.length;
  const maxClients = Math.max(...clientCounts);
  const overloadedAps = clientCounts.filter(c => c > 25).length;
  const underloadedAps = clientCounts.filter(c => c === 0).length;

  const variance = clientCounts.reduce((s,c) =>
    s + Math.pow(c - avgClients, 2), 0) / apList.length;
  const stdDev = Math.sqrt(variance);
  const cv = avgClients > 0 ? stdDev / avgClients : 0;

  const loadBalanceScore = Math.max(0,
    100 - (cv * 50) - (overloadedAps / apList.length * 30)
  );

  // ── ALGORITHM 3: BAND STEERING EFFECTIVENESS ────────────────
  const total2g = apList.reduce((s,a) => s + (a.clients_2g||0), 0);
  const total5g = apList.reduce((s,a) => s + (a.clients_5g||0), 0);
  const totalBandClients = total2g + total5g;

  const pct2g = totalBandClients > 0 ?
    (total2g / totalBandClients) * 100 : 0;
  const pct5g = totalBandClients > 0 ?
    (total5g / totalBandClients) * 100 : 0;

  // An idle controller (no associated clients) has no band-steering signal —
  // treat it as neutral (100) rather than penalizing it down to 0.
  const bandScore = totalBandClients === 0 ? 100 : Math.min(100, (pct5g / 60) * 100);

  // ── ALGORITHM 4: CAPACITY ANALYSIS ──────────────────────────
  const utilValues = apList.map(a => Math.max(a.radio_2g_util_pct || 0, a.radio_5g_util_pct || 0));
  const highUtilAps = utilValues.filter(u => u > 70).length;
  const criticalUtilAps = utilValues.filter(u => u > 90).length;
  const avgUtil = utilValues.length > 0 ? utilValues.reduce((s,v) => s+v, 0) / utilValues.length : 0;
  const capacityScore = Math.max(0, 100 - (highUtilAps / apList.length) * 40 - (criticalUtilAps / apList.length) * 40 - (avgUtil > 60 ? (avgUtil - 60) * 2 : 0));

  // ── ALGORITHM 5: CHANNEL REUSE EFFICIENCY ───────────────────
  const uniqueChannels5g = new Set(channels5g).size;
  const channelDiversityScore = channels5g.length > 0 ?
    Math.min(100, (uniqueChannels5g / channels5g.length) * 100 * 2) : 100;

  // ── OVERALL SCORE ────────────────────────────────────────────
  const overallScore = Math.round(loadBalanceScore * 0.30 + capacityScore * 0.30 + bandScore * 0.20 + Math.max(0, 100 - interferenceScore) * 0.20);

  const grade = overallScore >= 90 ? 'A' :
                overallScore >= 80 ? 'B' :
                overallScore >= 70 ? 'C' :
                overallScore >= 60 ? 'D' : 'F';

  // ── GENERATE RECOMMENDATIONS ─────────────────────────────────
  const recommendations = [];

  if (badChannels2g > 0) recommendations.push({
    priority: 'high',
    category: 'RF Planning',
    issue: `${badChannels2g} AP(s) using non-standard 2.4GHz channels`,
    action: 'Change 2.4GHz channels to 1, 6, or 11 only to avoid adjacent-channel interference',
    affected_aps: apList
      .filter(a => a.radio_2g_channel &&
        ![1,6,11].includes(a.radio_2g_channel))
      .map(a => a.name)
  });

  if (coAffected2g > 2) recommendations.push({
    priority: 'high',
    category: 'RF Planning',
    issue: `${coAffected2g} APs affected by co-channel interference on 2.4GHz`,
    action: 'Enable ARM/RRM auto channel assignment or manually distribute channels 1, 6, 11',
    affected_count: coAffected2g
  });

  if (overloadedAps > 0) recommendations.push({
    priority: 'high',
    category: 'Capacity',
    issue: `${overloadedAps} AP(s) have >25 clients`,
    action: 'Consider adding APs in high-density areas or enabling client load balancing',
    affected_aps: apList
      .filter(a => (a.clients_total||0) > 25)
      .map(a => `${a.name} (${a.clients_total} clients)`)
  });

  if (underloadedAps > apList.length * 0.3) recommendations.push({
    priority: 'medium',
    category: 'Load Balancing',
    issue: `${underloadedAps} APs have 0 clients while others are overloaded`,
    action: 'Enable aggressive band steering and client load balancing on the controller',
    affected_count: underloadedAps
  });

  if (pct2g > 40) recommendations.push({
    priority: 'medium',
    category: 'Band Steering',
    issue: `${Math.round(pct2g)}% of clients on 2.4GHz (target: <40%)`,
    action: 'Enable band steering to push capable devices to 5GHz. Check if 5GHz coverage is adequate.',
    metric: `${Math.round(pct5g)}% on 5GHz, target >60%`
  });

  if (criticalUtilAps > 0) recommendations.push({
    priority: 'critical',
    category: 'Capacity',
    issue: `${criticalUtilAps} AP(s) at >90% channel utilization`,
    action: 'Immediate attention needed. Add APs or redistribute clients to prevent connectivity issues.',
    affected_aps: apList
      .filter(a =>
        Math.max(a.radio_2g_util_pct||0, a.radio_5g_util_pct||0) > 90
      )
      .map(a => a.name)
  });

  if (uniqueChannels5g < 4 && channels5g.length > 8)
    recommendations.push({
    priority: 'low',
    category: 'RF Planning',
    issue: 'Low 5GHz channel diversity — only ' +
      uniqueChannels5g + ' unique channels used',
    action: 'Spread APs across more 5GHz channels (36,40,44,48,149,153,157,161) for better throughput',
    metric: `${uniqueChannels5g} channels for ${channels5g.length} APs`
  });

  // ── PER-AP INTELLIGENCE ──────────────────────────────────────
  for (const ap of apList) {
    const apIssues = [];
    const apRecs = [];

    const ch2g = ap.radio_2g_channel;
    const ch5g = ap.radio_5g_channel;
    const clients = ap.clients_total || 0;
    const util = Math.max(ap.radio_2g_util_pct||0, ap.radio_5g_util_pct||0);

    if (ch2g && ![1,6,11].includes(ch2g)) {
      apIssues.push(`Non-standard 2.4GHz channel ${ch2g}`);
      apRecs.push(`Change 2.4GHz to channel 1, 6, or 11`);
    }

    // An AP with no reported channel on a band has no co-channel neighbors on
    // that band — without the null guard, null === null would make every
    // channel-less AP count all the other channel-less APs as neighbors.
    const coNeighbors2g = ch2g == null ? 0 : apList.filter(b =>
      b.id !== ap.id && b.radio_2g_channel === ch2g
    ).length;
    const coNeighbors5g = ch5g == null ? 0 : apList.filter(b =>
      b.id !== ap.id && b.radio_5g_channel === ch5g
    ).length;

    if (coNeighbors2g > 0) {
      apIssues.push(
        `${coNeighbors2g} neighbor(s) on same 2.4GHz channel ${ch2g}`
      );
      apRecs.push('Change 2.4GHz channel to reduce interference');
    }

    let loadStatus = 'normal';
    const loadPct = Math.min(100, (clients / MAX_CLIENTS_PER_AP) * 100);
    if (clients > 40) {
      loadStatus = 'critical';
      apIssues.push(`Overloaded: ${clients} clients`);
      apRecs.push('Redistribute clients or add nearby AP');
    } else if (clients > 25) {
      loadStatus = 'high';
      apIssues.push(`High load: ${clients} clients`);
    } else if (clients === 0) {
      loadStatus = 'low';
    }

    if (util > 90) {
      apIssues.push(
        `Critical channel utilization: ${util}%`
      );
      apRecs.push(
        'Reduce client count or move to less congested channel'
      );
    } else if (util > 70) {
      apIssues.push(`High channel utilization: ${util}%`);
    }

    const ap2g = ap.clients_2g || 0;
    const ap5g = ap.clients_5g || 0;
    const apTotal = ap2g + ap5g;
    const bandHealthy = apTotal === 0 ||
      (ap5g / apTotal) >= 0.5;

    if (!bandHealthy && apTotal > 5) {
      apIssues.push(
        `${Math.round((ap2g/apTotal)*100)}% clients on 2.4GHz`
      );
      apRecs.push('Check band steering configuration for this AP');
    }

    let apScore = 100;
    if (loadStatus === 'critical') apScore -= 30;
    else if (loadStatus === 'high') apScore -= 15;
    if (util > 90) apScore -= 30;
    else if (util > 70) apScore -= 15;
    if (coNeighbors2g > 0) apScore -= 10;
    if (ch2g && ![1,6,11].includes(ch2g)) apScore -= 10;
    if (!bandHealthy && apTotal > 5) apScore -= 10;
    apScore = Math.max(0, apScore);

    const apGrade = apScore >= 90 ? 'A' :
                    apScore >= 80 ? 'B' :
                    apScore >= 70 ? 'C' :
                    apScore >= 60 ? 'D' : 'F';

    const used5gChannels = new Set(channels5g);
    const preferred5g = [36,40,44,48,149,153,157,161];
    const freeCh5g = preferred5g.find(c =>
      !used5gChannels.has(c) || c === ch5g
    );
    // Only recommend a 5GHz channel change when the AP actually reports a 5GHz
    // channel — an AP with a null channel has nothing to move away from.
    const channelRec = ch5g != null && freeCh5g && freeCh5g !== ch5g ?
      `Consider channel ${freeCh5g}` : null;

    // Isolate per-AP failures so one bad row can't abort the whole controller's
    // intelligence (which would also skip the controller-level summary below).
    try {
      await pool.query(`
        INSERT INTO wireless_ap_intelligence
          (ap_id, health_score, health_grade, co_channel_neighbors,
           channel_recommendation, load_status, load_pct,
           band_ratio_healthy, issues, recommendations)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (ap_id) DO UPDATE SET
          health_score=EXCLUDED.health_score,
          health_grade=EXCLUDED.health_grade,
          co_channel_neighbors=EXCLUDED.co_channel_neighbors,
          channel_recommendation=EXCLUDED.channel_recommendation,
          load_status=EXCLUDED.load_status,
          load_pct=EXCLUDED.load_pct,
          band_ratio_healthy=EXCLUDED.band_ratio_healthy,
          issues=EXCLUDED.issues,
          recommendations=EXCLUDED.recommendations,
          computed_at=NOW()
      `, [ap.id, apScore, apGrade, coNeighbors2g + coNeighbors5g,
          channelRec, loadStatus, loadPct, bandHealthy,
          JSON.stringify(apIssues), JSON.stringify(apRecs)]);
    } catch (e) {
      console.error(`[WirelessIntel] AP ${ap.id} intelligence upsert failed:`, e.message);
    }
  }

  await pool.query(`
    INSERT INTO wireless_intelligence
      (controller_id, co_channel_pairs, interference_score,
       load_balance_score, overloaded_aps, underloaded_aps,
       avg_clients_per_ap, max_clients_per_ap,
       band_2g_pct, band_5g_pct, band_steering_score,
       high_util_ap_count, critical_util_count, capacity_score,
       overall_score, overall_grade, recommendations)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (controller_id) DO UPDATE SET
      co_channel_pairs=EXCLUDED.co_channel_pairs,
      interference_score=EXCLUDED.interference_score,
      load_balance_score=EXCLUDED.load_balance_score,
      overloaded_aps=EXCLUDED.overloaded_aps,
      underloaded_aps=EXCLUDED.underloaded_aps,
      avg_clients_per_ap=EXCLUDED.avg_clients_per_ap,
      max_clients_per_ap=EXCLUDED.max_clients_per_ap,
      band_2g_pct=EXCLUDED.band_2g_pct,
      band_5g_pct=EXCLUDED.band_5g_pct,
      band_steering_score=EXCLUDED.band_steering_score,
      high_util_ap_count=EXCLUDED.high_util_ap_count,
      critical_util_count=EXCLUDED.critical_util_count,
      capacity_score=EXCLUDED.capacity_score,
      overall_score=EXCLUDED.overall_score,
      overall_grade=EXCLUDED.overall_grade,
      recommendations=EXCLUDED.recommendations,
      computed_at=NOW()
  `, [controllerId, totalCoAffected, interferenceScore,
      loadBalanceScore, overloadedAps, underloadedAps,
      avgClients, maxClients, pct2g, pct5g, bandScore,
      highUtilAps, criticalUtilAps, capacityScore,
      overallScore, grade, JSON.stringify(recommendations)]);

  console.log(
    `[WirelessIntel] ${controllerId}: score=${overallScore} ` +
    `grade=${grade} co-ch-affected=${totalCoAffected} ` +
    `overloaded=${overloadedAps} band5g=${Math.round(pct5g)}%`
  );
}

async function runWirelessIntelligence(pool) {
  const controllers = await pool.query(
    `SELECT id FROM wireless_controllers WHERE active=TRUE`
  );
  for (const c of controllers.rows) {
    try {
      await computeWirelessIntelligence(pool, c.id);
    } catch(e) {
      console.error('[WirelessIntel] error:', e.message);
    }
  }
}

module.exports = { runWirelessIntelligence };

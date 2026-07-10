'use strict';

/**
 * intelligence.js — SpanVault Intelligence Layer
 *
 * Pure-statistics analytics engine that runs on top of the raw monitoring data
 * (ping_results, snmp_results, alerts). No external AI/ML services. Everything
 * is computed in-process on a timer (see startIntelligenceEngine).
 *
 * Computes: baselines, anomalies, health scores, capacity forecasts, recurring
 * patterns, smart threshold recommendations, and correlated incidents.
 *
 * Plain JavaScript only — no TypeScript syntax.
 */

const { Pool } = require('pg');

// SpanVault's own DB (read/write). Same connection shape as server.js / collector.
const sv = new Pool({
  host:     process.env.SV_DB_HOST || 'localhost',
  port:     parseInt(process.env.SV_DB_PORT || '5432', 10),
  database: process.env.SV_DB_NAME || 'spanvault',
  user:     process.env.SV_DB_USER || 'spanvault_user',
  password: process.env.SV_DB_PASS || '',
  ssl: false,
  max: 4,
  idleTimeoutMillis: 30000,
});
sv.on('error', (err) => console.error('[Intelligence] Pool error:', err.message));

// ── Statistical helpers ────────────────────────────────────────
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function linearRegression(points) {
  // points: [{x, y}] where x is some monotonically increasing axis, y = value
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0] ? points[0].y : 0 };
  const xm = mean(points.map((p) => p.x));
  const ym = mean(points.map((p) => p.y));
  const num = points.reduce((s, p) => s + (p.x - xm) * (p.y - ym), 0);
  const den = points.reduce((s, p) => s + (p.x - xm) ** 2, 0);
  const slope = den ? num / den : 0;
  return { slope, intercept: ym - slope * xm };
}

// ── Baseline computation ───────────────────────────────────────
async function computeBaselines() {
  try {
    const devices = await sv.query('SELECT id FROM monitored_devices WHERE active = TRUE');

    for (const dev of devices.rows) {
      const deviceId = dev.id;

      // Response time baseline from ping_results.
      await computeMetricBaseline(deviceId, 'response_ms', `
        SELECT response_ms AS value FROM ping_results
        WHERE device_id = $1 AND ts >= NOW() - INTERVAL '30 days'
          AND status = 'up' AND response_ms IS NOT NULL
      `);

      // SNMP metric baselines from snmp_results.
      const metrics = ['cpu_pct', 'mem_pct', 'if_in_bps', 'if_out_bps'];
      for (const metric of metrics) {
        await computeMetricBaseline(deviceId, metric, `
          SELECT value FROM snmp_results
          WHERE device_id = $1 AND metric_name = '${metric}'
            AND ts >= NOW() - INTERVAL '30 days' AND value IS NOT NULL
        `);
      }
    }
    console.log('[Intelligence] Baselines computed');
  } catch (e) {
    console.error('[Intelligence] computeBaselines error:', e.message);
  }
}

async function computeMetricBaseline(deviceId, metric, query) {
  try {
    const r = await sv.query(query, [deviceId]);
    const vals = r.rows
      .map((row) => parseFloat(row.value))
      .filter((v) => !isNaN(v) && isFinite(v));
    if (vals.length < 10) return; // not enough data

    const sorted = [...vals].sort((a, b) => a - b);
    const m = mean(vals);
    const s = stddev(vals);

    await sv.query(`
      INSERT INTO device_baselines
        (device_id, metric, mean, stddev, p50, p95, p99, min_val, max_val, sample_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (device_id, metric, period_days) DO UPDATE SET
        mean=EXCLUDED.mean, stddev=EXCLUDED.stddev, p50=EXCLUDED.p50,
        p95=EXCLUDED.p95, p99=EXCLUDED.p99, min_val=EXCLUDED.min_val,
        max_val=EXCLUDED.max_val, sample_count=EXCLUDED.sample_count,
        computed_at=NOW()
    `, [deviceId, metric, m, s,
      percentile(sorted, 50), percentile(sorted, 95), percentile(sorted, 99),
      sorted[0], sorted[sorted.length - 1], vals.length]);
  } catch (e) {
    console.error(`[Intelligence] Baseline error ${deviceId}/${metric}:`, e.message);
  }
}

// ── Anomaly detection ──────────────────────────────────────────
// Compare each device's last-15-min average for a metric against its baseline;
// flag a z-score anomaly (|z|>=2.5 warning, >=3.5 critical) and auto-resolve when
// it falls back in-band. `recentSql` must return rows {device_id, avg_v, mean, stddev}.
async function detectMetricAnomalies(metric, recentSql, params) {
  const recent = await sv.query(recentSql, params || []);
  const live = [];
  for (const row of recent.rows) {
    const v = parseFloat(row.avg_v);
    const bMean = parseFloat(row.mean);
    const bStd = parseFloat(row.stddev);
    if (!(bStd > 0) || !isFinite(v)) continue;
    const z = Math.abs((v - bMean) / bStd);
    if (z >= 2.5) {
      live.push(row.device_id);
      const severity = z >= 3.5 ? 'critical' : 'warning';
      await sv.query(`
        INSERT INTO device_anomalies
          (device_id, metric, value, baseline_mean, baseline_stddev, z_score, severity)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (device_id, metric) WHERE status = 'active' DO NOTHING
      `, [row.device_id, metric, v, bMean, bStd, z, severity]);
    }
  }
  // Resolve anomalies for this metric whose device is no longer out-of-band
  // (small grace period so it doesn't flap immediately).
  await sv.query(`
    UPDATE device_anomalies SET status='resolved', resolved_at=NOW()
     WHERE status='active' AND metric=$1
       AND detected_at < NOW() - INTERVAL '10 minutes'
       AND device_id <> ALL($2::int[])
  `, [metric, live.length ? live : [-1]]);
}

async function detectAnomalies() {
  try {
    await detectMetricAnomalies('response_ms', `
      SELECT p.device_id, AVG(p.response_ms) AS avg_v, b.mean, b.stddev
      FROM ping_results p
      JOIN device_baselines b ON b.device_id = p.device_id AND b.metric = 'response_ms'
      WHERE p.ts >= NOW() - INTERVAL '15 minutes'
        AND p.status = 'up' AND p.response_ms IS NOT NULL
        AND b.sample_count >= 10 AND b.stddev > 0
      GROUP BY p.device_id, b.mean, b.stddev`);
    for (const metric of ['cpu_pct', 'mem_pct']) {
      await detectMetricAnomalies(metric, `
        SELECT s.device_id, AVG(s.value) AS avg_v, b.mean, b.stddev
        FROM snmp_results s
        JOIN device_baselines b ON b.device_id = s.device_id AND b.metric = $1
        WHERE s.metric_name = $1 AND s.ts >= NOW() - INTERVAL '15 minutes'
          AND s.value IS NOT NULL AND b.sample_count >= 10 AND b.stddev > 0
        GROUP BY s.device_id, b.mean, b.stddev`, [metric]);
    }
  } catch (e) {
    console.error('[Intelligence] detectAnomalies error:', e.message);
  }
}

// ── Health score computation ───────────────────────────────────
async function computeHealthScores() {
  try {
    const devices = await sv.query('SELECT id FROM monitored_devices WHERE active = TRUE');

    for (const dev of devices.rows) {
      const deviceId = dev.id;

      // Uptime score (40 pts): based on the last 7 days of uptime.
      const uptime = await sv.query(`
        SELECT ROUND(100.0 * SUM(CASE WHEN status='up' THEN 1 ELSE 0 END)
               / NULLIF(COUNT(*),0), 2) AS pct
        FROM ping_results WHERE device_id=$1 AND ts >= NOW() - INTERVAL '7 days'
      `, [deviceId]);
      const uptimePct = parseFloat(uptime.rows[0] && uptime.rows[0].pct != null ? uptime.rows[0].pct : 100);
      const uptimeScore = (uptimePct / 100) * 40;

      // Response score (20 pts): trend direction over the last 7 days
      // (hourly-averaged response time, x in epoch seconds).
      const trend = await sv.query(`
        SELECT EXTRACT(EPOCH FROM DATE_TRUNC('hour', ts)) AS x, AVG(response_ms) AS y
        FROM ping_results
        WHERE device_id=$1 AND ts >= NOW() - INTERVAL '7 days' AND status='up'
          AND response_ms IS NOT NULL
        GROUP BY DATE_TRUNC('hour', ts)
        ORDER BY x
      `, [deviceId]);
      let responseScore = 20;
      if (trend.rows.length >= 2) {
        const points = trend.rows.map((r) => ({ x: parseFloat(r.x), y: parseFloat(r.y) }));
        const reg = linearRegression(points);
        // Negative slope (improving) = full points; positive slope (degrading) = fewer.
        const base = points[0].y || 1;
        const trendPct = Math.max(0, Math.min(1, 1 - (reg.slope * 86400 * 7) / base));
        responseScore = trendPct * 20;
      }

      // Anomaly score (20 pts): fewer anomalies in 7 days = higher score.
      const anomalies = await sv.query(`
        SELECT COUNT(*) AS cnt FROM device_anomalies
        WHERE device_id=$1 AND detected_at >= NOW() - INTERVAL '7 days'
      `, [deviceId]);
      const anomalyCount = parseInt(anomalies.rows[0] ? anomalies.rows[0].cnt : 0, 10) || 0;
      const anomalyScore = Math.max(0, 20 - anomalyCount * 4);

      // Alert score (20 pts): fewer alerts in 7 days = higher score
      // (recovery_* records are informational, not real alerts).
      const alertCountRow = await sv.query(`
        SELECT COUNT(*) AS cnt FROM alerts
        WHERE device_id=$1 AND triggered_at >= NOW() - INTERVAL '7 days'
          AND alert_type NOT LIKE 'recovery%'
      `, [deviceId]);
      const alertCount = parseInt(alertCountRow.rows[0] ? alertCountRow.rows[0].cnt : 0, 10) || 0;
      const alertScore = Math.max(0, 20 - alertCount * 5);

      const totalScore = Math.round(uptimeScore + responseScore + anomalyScore + alertScore);
      const grade = totalScore >= 90 ? 'A' : totalScore >= 80 ? 'B' :
        totalScore >= 70 ? 'C' : totalScore >= 60 ? 'D' : 'F';

      // Trend: simplified signal from uptime + anomaly direction.
      const trendDir = uptimePct >= 99.5 && anomalyCount === 0 ? 'improving' :
        uptimePct < 95 || anomalyCount > 3 ? 'degrading' : 'stable';

      await sv.query(`
        INSERT INTO device_health_scores
          (device_id, score, uptime_score, response_score, anomaly_score,
           alert_score, grade, trend)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (device_id) DO UPDATE SET
          score=EXCLUDED.score, uptime_score=EXCLUDED.uptime_score,
          response_score=EXCLUDED.response_score, anomaly_score=EXCLUDED.anomaly_score,
          alert_score=EXCLUDED.alert_score, grade=EXCLUDED.grade,
          trend=EXCLUDED.trend, computed_at=NOW()
      `, [deviceId, totalScore, uptimeScore, responseScore, anomalyScore, alertScore, grade, trendDir]);
    }
  } catch (e) {
    console.error('[Intelligence] computeHealthScores error:', e.message);
  }
}

// ── Service health score computation ───────────────────────────
// Deliberately scoped-down sibling of computeHealthScores(): uptime (40) +
// response-time trend (20) + alert-count (20) only. NO anomaly component —
// a service check is a binary up/down/warning signal (service_check_results
// .status), not a continuous metric stream like ping/SNMP, so the device
// engine's baseline-deviation anomaly scoring (device_baselines /
// device_anomalies, z-scores) doesn't fit it and would require a much larger,
// not-recommended schema migration (per-service baselines) to extend. Kept
// as its own function (not folded into computeHealthScores' loop) because the
// query shapes genuinely differ (service_checks/service_check_results vs.
// monitored_devices/ping_results) enough that a single generic loop would be
// harder to read than the two side by side.
//
// The missing anomaly slot is filled with a flat neutral 20/20 (full points)
// rather than dropped-and-rescaled to an 80-max scale. That keeps the total
// on the same 0-100 scale as devices, so the existing grade thresholds
// (>=90 A, >=80 B, >=70 C, >=60 D, else F) and every score-driven UI helper
// (scoreColor/GradeBadge/ScoreMiniBar) apply to service rows unmodified —
// no separate scaling path or special-casing needed for the service kind.
async function computeServiceHealthScores() {
  try {
    const checks = await sv.query('SELECT id FROM service_checks WHERE active = TRUE');

    for (const svc of checks.rows) {
      const checkId = svc.id;

      // Uptime score (40 pts): last 7 days — identical shape to the device
      // version, service_check_results/check_id in place of ping_results/device_id.
      const uptime = await sv.query(`
        SELECT ROUND(100.0 * SUM(CASE WHEN status='up' THEN 1 ELSE 0 END)
               / NULLIF(COUNT(*),0), 2) AS pct
        FROM service_check_results WHERE check_id=$1 AND ts >= NOW() - INTERVAL '7 days'
      `, [checkId]);
      const uptimePct = parseFloat(uptime.rows[0] && uptime.rows[0].pct != null ? uptime.rows[0].pct : 100);
      const uptimeScore = (uptimePct / 100) * 40;

      // Response score (20 pts): trend direction over the last 7 days
      // (hourly-averaged response time, x in epoch seconds) — reuses the same
      // linearRegression() helper as the device version.
      const trend = await sv.query(`
        SELECT EXTRACT(EPOCH FROM DATE_TRUNC('hour', ts)) AS x, AVG(response_ms) AS y
        FROM service_check_results
        WHERE check_id=$1 AND ts >= NOW() - INTERVAL '7 days' AND status='up'
          AND response_ms IS NOT NULL
        GROUP BY DATE_TRUNC('hour', ts)
        ORDER BY x
      `, [checkId]);
      let responseScore = 20;
      if (trend.rows.length >= 2) {
        const points = trend.rows.map((r) => ({ x: parseFloat(r.x), y: parseFloat(r.y) }));
        const reg = linearRegression(points);
        // Negative slope (improving) = full points; positive slope (degrading) = fewer.
        const base = points[0].y || 1;
        const trendPct = Math.max(0, Math.min(1, 1 - (reg.slope * 86400 * 7) / base));
        responseScore = trendPct * 20;
      }

      // Anomaly score (20 pts): out of scope for services — see file comment
      // above. Neutral full points every cycle (not a penalty, not a bonus).
      const anomalyScore = 20;

      // Alert score (20 pts): fewer alerts in 7 days = higher score
      // (recovery_* records are informational, not real alerts) — identical
      // formula to the device version, scoped by service_check_id.
      const alertCountRow = await sv.query(`
        SELECT COUNT(*) AS cnt FROM alerts
        WHERE service_check_id=$1 AND triggered_at >= NOW() - INTERVAL '7 days'
          AND alert_type NOT LIKE 'recovery%'
      `, [checkId]);
      const alertCount = parseInt(alertCountRow.rows[0] ? alertCountRow.rows[0].cnt : 0, 10) || 0;
      const alertScore = Math.max(0, 20 - alertCount * 5);

      const totalScore = Math.round(uptimeScore + responseScore + anomalyScore + alertScore);
      const grade = totalScore >= 90 ? 'A' : totalScore >= 80 ? 'B' :
        totalScore >= 70 ? 'C' : totalScore >= 60 ? 'D' : 'F';

      // Trend: same two-signal shape as the device version (uptime + a
      // secondary frequency signal), but substitutes alertCount for
      // anomalyCount since services have no anomaly component to read from.
      const trendDir = uptimePct >= 99.5 && alertCount === 0 ? 'improving' :
        uptimePct < 95 || alertCount > 3 ? 'degrading' : 'stable';

      await sv.query(`
        INSERT INTO device_health_scores
          (service_check_id, score, uptime_score, response_score, anomaly_score,
           alert_score, grade, trend)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (service_check_id) WHERE service_check_id IS NOT NULL DO UPDATE SET
          score=EXCLUDED.score, uptime_score=EXCLUDED.uptime_score,
          response_score=EXCLUDED.response_score, anomaly_score=EXCLUDED.anomaly_score,
          alert_score=EXCLUDED.alert_score, grade=EXCLUDED.grade,
          trend=EXCLUDED.trend, computed_at=NOW()
      `, [checkId, totalScore, uptimeScore, responseScore, anomalyScore, alertScore, grade, trendDir]);
    }
  } catch (e) {
    console.error('[Intelligence] computeServiceHealthScores error:', e.message);
  }
}

// ── Capacity forecasting ───────────────────────────────────────
async function computeCapacityForecasts(deviceId) {
  // Daily average + peak bandwidth for the last 30 days.
  const bwData = await sv.query(`
    SELECT DATE(ts) AS day,
           AVG(CASE WHEN metric_name='if_in_bps' THEN value END) AS avg_in,
           AVG(CASE WHEN metric_name='if_out_bps' THEN value END) AS avg_out,
           MAX(CASE WHEN metric_name='if_in_bps' THEN value END) AS max_in,
           MAX(CASE WHEN metric_name='if_out_bps' THEN value END) AS max_out
    FROM snmp_results
    WHERE device_id=$1 AND ts >= NOW() - INTERVAL '30 days'
      AND metric_name IN ('if_in_bps','if_out_bps')
    GROUP BY DATE(ts) ORDER BY day
  `, [deviceId]);

  if (bwData.rows.length < 7) {
    return { device_id: deviceId, enough_data: false, days_collected: bwData.rows.length };
  }

  const points = bwData.rows.map((r, i) => ({
    x: i,
    day: r.day,
    in: parseFloat(r.avg_in || 0),
    out: parseFloat(r.avg_out || 0),
    max_in: parseFloat(r.max_in || 0),
    max_out: parseFloat(r.max_out || 0),
  }));

  const regIn = linearRegression(points.map((p) => ({ x: p.x, y: p.in })));
  const regOut = linearRegression(points.map((p) => ({ x: p.x, y: p.out })));

  const peakIn = Math.max(...points.map((p) => p.max_in), 0);
  const peakOut = Math.max(...points.map((p) => p.max_out), 0);

  // Project forward 30/60/90 days.
  const currentDay = points.length;
  const forecasts = [];
  for (const days of [30, 60, 90]) {
    const projIn = regIn.slope * (currentDay + days) + regIn.intercept;
    const projOut = regOut.slope * (currentDay + days) + regOut.intercept;
    forecasts.push({
      days,
      proj_in_bps: Math.max(0, projIn),
      proj_out_bps: Math.max(0, projOut),
    });
  }

  // History series the UI can chart directly.
  const history = points.map((p) => ({
    day: p.day, in_bps: p.in, out_bps: p.out,
  }));

  return {
    device_id: deviceId,
    enough_data: true,
    days_collected: points.length,
    peak_in_bps: peakIn,
    peak_out_bps: peakOut,
    trend_in: regIn.slope > 0 ? 'increasing' : 'decreasing',
    trend_out: regOut.slope > 0 ? 'increasing' : 'decreasing',
    weekly_growth_in: regIn.slope * 7,
    weekly_growth_out: regOut.slope * 7,
    history,
    forecasts,
  };
}

// ── Pattern detection ──────────────────────────────────────────
async function detectPatterns() {
  try {
    const devices = await sv.query('SELECT id, name FROM monitored_devices WHERE active = TRUE');

    for (const device of devices.rows) {
      // Hourly pattern: is response time consistently high at certain hours?
      const hourly = await sv.query(`
        SELECT EXTRACT(HOUR FROM ts) AS hour,
               AVG(response_ms) AS avg_ms,
               COUNT(*) AS samples
        FROM ping_results
        WHERE device_id=$1 AND ts >= NOW() - INTERVAL '30 days' AND status='up'
          AND response_ms IS NOT NULL
        GROUP BY EXTRACT(HOUR FROM ts)
        HAVING COUNT(*) >= 5
        ORDER BY avg_ms DESC
      `, [device.id]);

      const baseline = await sv.query(`
        SELECT mean FROM device_baselines
        WHERE device_id=$1 AND metric='response_ms'
      `, [device.id]);

      const baselineMean = parseFloat(baseline.rows[0] ? baseline.rows[0].mean : 0);
      if (!(baselineMean > 0)) continue;

      for (const row of hourly.rows) {
        const avgMs = parseFloat(row.avg_ms);
        const ratio = avgMs / baselineMean;
        if (ratio >= 1.5) { // 50%+ above baseline at this hour
          const hour = parseInt(row.hour, 10);
          const nextHour = (hour + 1) % 24;
          const pct = Math.round(ratio * 100 - 100);
          const desc = `High latency at ${pad2(hour)}:00-${pad2(nextHour)}:00 (${pct}% above normal)`;
          const confidence = Math.min(0.99, parseFloat(row.samples) / 30);
          // Upsert against the (device, type, metric, hour, day) slot so recurring
          // detections bump occurrence_count / last_seen_at instead of duplicating.
          await sv.query(`
            INSERT INTO device_patterns
              (device_id, pattern_type, metric, description, hour_of_day,
               avg_value, baseline_value, confidence)
            VALUES ($1, 'hourly', 'response_ms', $2, $3, $4, $5, $6)
            ON CONFLICT (device_id, pattern_type, metric,
                         COALESCE(hour_of_day, -1), COALESCE(day_of_week, -1))
            DO UPDATE SET
              description=EXCLUDED.description,
              avg_value=EXCLUDED.avg_value,
              baseline_value=EXCLUDED.baseline_value,
              confidence=EXCLUDED.confidence,
              last_seen_at=NOW(),
              occurrence_count=device_patterns.occurrence_count + 1
          `, [device.id, desc, hour, avgMs, baselineMean, confidence]);
        }
      }
    }
    console.log('[Intelligence] Patterns detected');
  } catch (e) {
    console.error('[Intelligence] detectPatterns error:', e.message);
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

// ── Smart threshold recommendations ───────────────────────────
async function computeThresholdRecommendations() {
  try {
    const baselines = await sv.query(`
      SELECT b.*, d.ping_threshold_ms AS current_threshold
      FROM device_baselines b
      JOIN monitored_devices d ON d.id = b.device_id
      WHERE b.metric = 'response_ms' AND b.sample_count >= 50
    `);

    for (const row of baselines.rows) {
      // Recommend threshold at p99 * 2 — catches real problems, ignores noise.
      const p99 = parseFloat(row.p99);
      const meanVal = parseFloat(row.mean);
      const recommended = Math.round(p99 * 2);
      const current = parseFloat(row.current_threshold);

      if (!isFinite(recommended) || recommended <= 0) continue;
      if (Math.abs(recommended - current) < 10) continue; // not worth recommending

      let reasoning;
      if (recommended < current * 0.3) {
        const ratio = meanVal > 0 ? Math.round(current / meanVal) : '?';
        reasoning = `Current threshold (${current}ms) is ${ratio}x your normal response time. Recommended (${recommended}ms) is 2x your p99 (${Math.round(p99)}ms) — catches real degradation while ignoring noise.`;
      } else if (recommended > current) {
        reasoning = `Current threshold (${current}ms) may cause false alerts. Normal p99 is ${Math.round(p99)}ms. Recommend ${recommended}ms to reduce noise.`;
      } else {
        reasoning = `Tighten threshold from ${current}ms to ${recommended}ms (2x p99 of ${Math.round(p99)}ms) to catch degradation earlier.`;
      }

      await sv.query(`
        INSERT INTO threshold_recommendations
          (device_id, metric, current_threshold, recommended_threshold, reasoning, confidence)
        VALUES ($1, 'response_ms', $2, $3, $4, $5)
        ON CONFLICT (device_id, metric) DO UPDATE SET
          current_threshold=EXCLUDED.current_threshold,
          recommended_threshold=EXCLUDED.recommended_threshold,
          reasoning=EXCLUDED.reasoning,
          confidence=EXCLUDED.confidence,
          computed_at=NOW()
      `, [row.device_id, current, recommended, reasoning,
        Math.min(0.99, parseInt(row.sample_count, 10) / 1000)]);
    }
    console.log('[Intelligence] Threshold recommendations computed');
  } catch (e) {
    console.error('[Intelligence] computeThresholdRecommendations error:', e.message);
  }
}

// ── Incident correlation ───────────────────────────────────────
async function correlateIncidents() {
  try {
    // Recent unassigned device_down alerts, with device + site + gateway info.
    const recent = await sv.query(`
      SELECT a.id, a.device_id, a.alert_type, a.triggered_at, a.status,
             d.name AS device_name, d.site_id, d.site_name, d.is_gateway
      FROM alerts a
      JOIN monitored_devices d ON d.id = a.device_id
      WHERE a.triggered_at >= NOW() - INTERVAL '2 hours'
        AND a.alert_type = 'device_down'
        AND a.incident_id IS NULL
      ORDER BY a.triggered_at
    `);

    if (recent.rows.length >= 2) {
      // Group alerts into clusters within 2-minute windows.
      const clusters = [];
      let current = [recent.rows[0]];
      for (let i = 1; i < recent.rows.length; i++) {
        const gap = new Date(recent.rows[i].triggered_at) - new Date(recent.rows[i - 1].triggered_at);
        if (gap <= 120000) { // 2 minutes
          current.push(recent.rows[i]);
        } else {
          if (current.length >= 2) clusters.push([...current]);
          current = [recent.rows[i]];
        }
      }
      if (current.length >= 2) clusters.push(current);

      for (const cluster of clusters) {
        // Root cause: the site gateway if one went down, otherwise the first device.
        const gateway = cluster.find((a) => a.is_gateway);
        const rootCause = gateway || cluster[0];

        const timeline = cluster.map((a) => ({
          ts: a.triggered_at,
          device: a.device_name,
          event: 'went DOWN',
          alert_id: a.id,
        }));

        const siteName = rootCause.site_name || 'Unknown';
        const title = gateway
          ? `${siteName} gateway outage — ${cluster.length} devices affected`
          : `${cluster.length} devices down in ${siteName}`;

        const result = await sv.query(`
          INSERT INTO incidents (title, root_cause_device_id, affected_count,
            severity, status, started_at, timeline, summary)
          VALUES ($1,$2,$3,'critical','active',$4,$5,$6)
          RETURNING id
        `, [title, rootCause.device_id, cluster.length, cluster[0].triggered_at,
          JSON.stringify(timeline),
          `${cluster.length} devices went down within 2 minutes. Root cause: ${rootCause.device_name}.`]);

        const incidentId = result.rows[0].id;

        // Link the cluster's alerts to the incident.
        const alertIds = cluster.map((a) => a.id);
        await sv.query(`
          UPDATE alerts SET incident_id=$1 WHERE id = ANY($2::int[])
        `, [incidentId, alertIds]);
      }
    }

    // Auto-resolve incidents once all of their linked alerts are resolved.
    await sv.query(`
      UPDATE incidents SET status='resolved', resolved_at=NOW(),
        duration_seconds=EXTRACT(EPOCH FROM (NOW()-started_at))::int
      WHERE status='active'
        AND id NOT IN (
          SELECT DISTINCT incident_id FROM alerts
          WHERE incident_id IS NOT NULL AND status='active'
        )
    `);
  } catch (e) {
    console.error('[Intelligence] correlateIncidents error:', e.message);
  }
}

// ── Run the full pipeline once (used on startup + manual recompute) ──
async function runAll() {
  await computeBaselines();
  await computeHealthScores();
  await computeServiceHealthScores();
  await detectAnomalies();
  await detectPatterns();
  await computeThresholdRecommendations();
  await correlateIncidents();
}

// ── Schedule all intelligence jobs ────────────────────────────
function startIntelligenceEngine() {
  // Run shortly after start, once the API + collector are warm.
  setTimeout(() => { runAll().catch((e) => console.error('[Intelligence] initial run:', e.message)); }, 5000);

  setInterval(computeBaselines, 60 * 60 * 1000);                 // every hour
  setInterval(computeHealthScores, 5 * 60 * 1000);               // every 5 min
  setInterval(computeServiceHealthScores, 5 * 60 * 1000);        // every 5 min
  setInterval(detectAnomalies, 5 * 60 * 1000);                   // every 5 min
  setInterval(detectPatterns, 6 * 60 * 60 * 1000);               // every 6 hours
  setInterval(computeThresholdRecommendations, 24 * 60 * 60 * 1000); // daily
  setInterval(correlateIncidents, 5 * 60 * 1000);                // every 5 min

  console.log('[Intelligence] Engine started');
}

module.exports = {
  startIntelligenceEngine, runAll, computeBaselines, computeHealthScores,
  computeServiceHealthScores, detectAnomalies, computeCapacityForecasts,
  detectPatterns, computeThresholdRecommendations, correlateIncidents,
};

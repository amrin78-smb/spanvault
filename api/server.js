'use strict';

/**
 * server.js — SpanVault REST API
 * Port: SV_API_PORT (default 3009), bound to 127.0.0.1 only.
 * The Next.js frontend proxies /api/* here; /api/auth/* stays in Next.
 * Plain JavaScript only — no TypeScript syntax.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const express  = require('express');
const cors     = require('cors');
const ping     = require('ping');
const { Pool } = require('pg');
const { discoverDevice, snmpTest } = require('../collector/discovery');

const IS_WIN = process.platform === 'win32';

// ── Crash resilience ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

const app  = express();
const PORT = parseInt(process.env.SV_API_PORT || '3009', 10);
const PROD = process.env.NODE_ENV === 'production';

// ── Databases ─────────────────────────────────────────────────
// SpanVault's own DB (read/write)
const sv = new Pool({
  host:     process.env.SV_DB_HOST || 'localhost',
  port:     parseInt(process.env.SV_DB_PORT || '5432', 10),
  database: process.env.SV_DB_NAME || 'spanvault',
  user:     process.env.SV_DB_USER || 'spanvault_user',
  password: process.env.SV_DB_PASS || '',
  ssl: false,
  max: 10,
  idleTimeoutMillis: 30000,
});
sv.on('error', (err) => console.error('[DB sv] Pool error:', err.message));

// NetVault DB (read-only — devices & sites source)
const nv = new Pool({
  host:     process.env.NETVAULT_DB_HOST || 'localhost',
  port:     parseInt(process.env.NETVAULT_DB_PORT || '5432', 10),
  database: process.env.NETVAULT_DB_NAME || 'netvault',
  user:     process.env.NETVAULT_DB_USER || 'netvault',
  password: process.env.NETVAULT_DB_PASS || '',
  ssl: false,
  max: 5,
  idleTimeoutMillis: 30000,
});
nv.on('error', (err) => console.error('[DB nv] Pool error:', err.message));

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Helpers ───────────────────────────────────────────────────
function safeInt(val, def, max) {
  const n = parseInt(val, 10);
  if (isNaN(n) || n <= 0) return def;
  return (max && n > max) ? max : n;
}
function rangeToInterval(range) {
  switch (range) {
    case '7d':  return '7 days';
    case '30d': return '30 days';
    case '90d': return '90 days';
    case '24h':
    default:    return '24 hours';
  }
}
function rangeToBucket(range) {
  switch (range) {
    case '7d':  return '1 hour';
    case '30d': return '6 hours';
    case '90d': return '1 day';
    case '24h':
    default:    return '5 minutes';
  }
}
function toCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = cols.join(',');
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
  return head + '\n' + body;
}
function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(rows));
}
// async route wrapper
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Device-scope filter for report queries (monitored_devices aliased as d).
// Pushes any site_id/device_id values onto `params` and returns clause strings.
function reportFilters(q, params) {
  const f = ['d.active = TRUE'];
  if (q.site_id)   { params.push(parseInt(q.site_id, 10));   f.push(`d.site_id = $${params.length}`); }
  if (q.device_id) { params.push(parseInt(q.device_id, 10)); f.push(`d.id = $${params.length}`); }
  return f;
}

// ══════════════════════════════════════════════════════════════
// Health
// ══════════════════════════════════════════════════════════════
app.get('/api/health', wrap(async (_req, res) => {
  await sv.query('SELECT 1');
  res.json({ status: 'ok', service: 'spanvault-api', time: new Date().toISOString() });
}));

// Collector liveness: 'running' if any ping has been written in the last 10 min.
app.get('/api/collector/status', wrap(async (_req, res) => {
  const r = await sv.query(`SELECT MAX(ts) AS last_ts FROM ping_results WHERE ts >= NOW() - INTERVAL '10 minutes'`);
  const lastTs = r.rows[0] && r.rows[0].last_ts;
  res.json({ status: lastTs ? 'running' : 'stopped', last_ts: lastTs || null });
}));

// ══════════════════════════════════════════════════════════════
// Dashboard
// ══════════════════════════════════════════════════════════════
app.get('/api/dashboard/summary', wrap(async (_req, res) => {
  const q = await sv.query(`
    SELECT current_status AS status, COUNT(*)::int AS count
    FROM monitored_devices WHERE active = TRUE
    GROUP BY current_status
  `);
  const counts = { up: 0, down: 0, warning: 0, unknown: 0 };
  for (const row of q.rows) {
    if (counts[row.status] !== undefined) counts[row.status] = row.count;
  }
  const total = counts.up + counts.down + counts.warning + counts.unknown;
  const active = await sv.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE status = 'active'`);
  res.json({ total, ...counts, active_alerts: active.rows[0].c });
}));

// Active problems — every device currently down or warning, worst first.
app.get('/api/dashboard/problems', wrap(async (_req, res) => {
  // Suppressed devices are hidden — when a site gateway is down they're covered
  // by the gateway's entry. A down gateway reports how many devices its outage
  // is suppressing at the same site.
  const r = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.site_id, d.site_name, d.current_status,
           d.last_response_ms, d.last_checked_at, d.last_seen_at, d.consecutive_failures,
           d.is_gateway,
           CASE WHEN d.is_gateway THEN (
             SELECT COUNT(*)::int FROM monitored_devices c
              WHERE c.site_id IS NOT DISTINCT FROM d.site_id AND c.id <> d.id
                AND c.active = TRUE AND c.alert_suppressed = TRUE
           ) ELSE 0 END AS suppressed_in_site
    FROM monitored_devices d
    WHERE d.active = TRUE AND d.current_status IN ('down', 'warning')
      AND d.alert_suppressed = FALSE
    ORDER BY CASE d.current_status WHEN 'down' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
             d.name
  `);
  res.json(r.rows);
}));

// Top 10 worst devices by average response time over the last hour.
app.get('/api/dashboard/top-worst', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT d.id, d.name, d.site_id, d.site_name, d.current_status,
           ROUND(AVG(p.response_ms)::numeric, 1)      AS avg_ms,
           ROUND(MAX(p.response_ms)::numeric, 1)      AS max_ms,
           ROUND(AVG(p.packet_loss_pct)::numeric, 1)  AS packet_loss_pct
    FROM ping_results p
    JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts >= NOW() - INTERVAL '1 hour' AND d.active = TRUE
    GROUP BY d.id, d.name, d.site_id, d.site_name, d.current_status
    HAVING AVG(p.response_ms) IS NOT NULL
    ORDER BY AVG(p.response_ms) DESC
    LIMIT 10
  `);
  res.json(r.rows);
}));

// 24h network availability trend in 30-minute buckets (sparkline/area chart).
app.get('/api/dashboard/network-trend', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT date_bin('30 minutes', ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           COUNT(*)::int AS total_checks,
           SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END)::int AS up_checks
    FROM ping_results
    WHERE ts >= NOW() - INTERVAL '24 hours'
    GROUP BY bucket
    ORDER BY bucket
  `);
  const rows = r.rows.map((row) => ({
    bucket: row.bucket,
    total_checks: row.total_checks,
    up_checks: row.up_checks,
    pct_up: row.total_checks
      ? Math.round((row.up_checks / row.total_checks) * 1000) / 10
      : null,
  }));
  res.json(rows);
}));

// Per-site health: device counts + 24h uptime (reachable = not down).
app.get('/api/dashboard/site-health', wrap(async (_req, res) => {
  const r = await sv.query(`
    WITH dev AS (
      SELECT COALESCE(site_id, 0)            AS site_id,
             COALESCE(site_name, 'Unassigned') AS site_name,
             COUNT(*)::int                                                  AS total_devices,
             SUM(CASE WHEN current_status = 'up'      THEN 1 ELSE 0 END)::int AS up_count,
             SUM(CASE WHEN current_status = 'down'    THEN 1 ELSE 0 END)::int AS down_count,
             SUM(CASE WHEN current_status = 'warning' THEN 1 ELSE 0 END)::int AS warning_count,
             SUM(CASE WHEN current_status = 'unknown' THEN 1 ELSE 0 END)::int AS unknown_count
      FROM monitored_devices WHERE active = TRUE
      GROUP BY 1, 2
    ),
    upt AS (
      SELECT COALESCE(d.site_id, 0) AS site_id,
             ROUND(100.0 * SUM(CASE WHEN p.status <> 'down' THEN 1 ELSE 0 END)
                         / NULLIF(COUNT(*), 0), 1) AS avg_uptime_pct
      FROM ping_results p
      JOIN monitored_devices d ON d.id = p.device_id
      WHERE p.ts >= NOW() - INTERVAL '24 hours' AND d.active = TRUE
      GROUP BY 1
    )
    SELECT dev.site_id, dev.site_name, dev.total_devices, dev.up_count,
           dev.down_count, dev.warning_count, dev.unknown_count,
           upt.avg_uptime_pct
    FROM dev LEFT JOIN upt ON upt.site_id = dev.site_id
    ORDER BY dev.down_count DESC, dev.warning_count DESC, dev.site_name
  `);
  res.json(r.rows);
}));

// Last 20 notable events — alerts triggered or resolved in the last 24h.
app.get('/api/dashboard/events', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT a.id, a.device_id, d.name AS device_name, d.site_id, d.site_name,
           a.alert_type, a.severity, a.status, a.message,
           a.triggered_at, a.resolved_at,
           GREATEST(a.triggered_at, COALESCE(a.resolved_at, a.triggered_at)) AS event_at
    FROM alerts a
    LEFT JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.triggered_at >= NOW() - INTERVAL '24 hours'
       OR a.resolved_at  >= NOW() - INTERVAL '24 hours'
    ORDER BY event_at DESC
    LIMIT 20
  `);
  res.json(r.rows);
}));

// ══════════════════════════════════════════════════════════════
// Monitored devices
// ══════════════════════════════════════════════════════════════
app.get('/api/devices', wrap(async (req, res) => {
  const { status, site_id, q } = req.query;
  const where = ['d.active = TRUE'];
  const params = [];
  if (status)  { params.push(status);  where.push(`d.current_status = $${params.length}`); }
  if (site_id) { params.push(parseInt(site_id, 10)); where.push(`d.site_id = $${params.length}`); }
  if (q)       { params.push(`%${q}%`); where.push(`(d.name ILIKE $${params.length} OR d.ip_address ILIKE $${params.length})`); }
  const rows = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.device_type, d.site_id, d.site_name,
           d.current_status, d.last_response_ms, d.last_seen_at, d.last_checked_at,
           d.snmp_enabled, d.poll_interval_seconds, d.netvault_device_id,
           d.is_gateway, d.alert_suppressed, d.suppressed_by_device_id,
           cpu.value AS latest_cpu_pct, mem.value AS latest_mem_pct,
           avail.uptime_24h_pct
    FROM monitored_devices d
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = d.id AND metric_name = 'cpu_pct'
      ORDER BY ts DESC LIMIT 1
    ) cpu ON TRUE
    LEFT JOIN LATERAL (
      SELECT value FROM snmp_results
      WHERE device_id = d.id AND metric_name = 'mem_pct'
      ORDER BY ts DESC LIMIT 1
    ) mem ON TRUE
    LEFT JOIN LATERAL (
      SELECT ROUND((1 - (SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::numeric
                    / NULLIF(COUNT(*), 0))) * 100, 1) AS uptime_24h_pct
      FROM ping_results
      WHERE device_id = d.id AND ts >= NOW() - INTERVAL '24 hours'
    ) avail ON TRUE
    WHERE ${where.join(' AND ')}
    ORDER BY d.site_name NULLS LAST, d.name
  `, params);
  res.json(rows.rows);
}));

app.get('/api/devices/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE id = $1`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(r.rows[0]);
}));

app.post('/api/devices', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.ip_address) return res.status(400).json({ error: 'name and ip_address are required' });
  const r = await sv.query(`
    INSERT INTO monitored_devices
      (name, ip_address, device_type, site_id, site_name,
       snmp_enabled, snmp_version, snmp_community, snmp_port,
       snmp_v3_user, snmp_v3_auth_pass, snmp_v3_priv_pass,
       poll_interval_seconds, ping_threshold_ms, ping_failures_before_down)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (ip_address) DO NOTHING
    RETURNING *
  `, [
    b.name, b.ip_address, b.device_type || null, b.site_id || null, b.site_name || null,
    b.snmp_enabled || false, b.snmp_version || '2c', b.snmp_community || 'public',
    safeInt(b.snmp_port, 161), b.snmp_v3_user || null, b.snmp_v3_auth_pass || null,
    b.snmp_v3_priv_pass || null, safeInt(b.poll_interval_seconds, 300),
    safeInt(b.ping_threshold_ms, 500), safeInt(b.ping_failures_before_down, 3),
  ]);
  if (!r.rows[0]) return res.status(409).json({ error: 'A device with this IP is already monitored' });
  res.status(201).json(r.rows[0]);
}));

app.put('/api/devices/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = [
    'name','ip_address','device_type','site_id','site_name','snmp_enabled','snmp_version',
    'snmp_community','snmp_port','snmp_v3_user','snmp_v3_auth_pass','snmp_v3_priv_pass',
    'poll_interval_seconds','ping_threshold_ms','ping_failures_before_down','active',
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (b[key] !== undefined) { params.push(b[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  params.push(id);
  const r = await sv.query(
    `UPDATE monitored_devices SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(r.rows[0]);
}));

app.delete('/api/devices/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await sv.query(`DELETE FROM monitored_devices WHERE id = $1`, [id]);
  res.json({ ok: true });
}));

// Ping history (bucketed)
app.get('/api/devices/:id/ping-history', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const interval = rangeToInterval(req.query.range);
  const bucket = rangeToBucket(req.query.range);
  const r = await sv.query(`
    SELECT date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           ROUND(AVG(response_ms)::numeric, 1) AS avg_ms,
           ROUND(MAX(packet_loss_pct)::numeric, 1) AS max_loss,
           SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS down_samples
    FROM ping_results
    WHERE device_id = $2 AND ts >= NOW() - $3::interval
    GROUP BY bucket ORDER BY bucket
  `, [bucket, id, interval]);
  res.json(r.rows);
}));

// SNMP history (bucketed, per metric, optionally per interface)
app.get('/api/devices/:id/snmp-history', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const metric = String(req.query.metric || 'cpu_pct');
  const interval = rangeToInterval(req.query.range);
  const bucket = rangeToBucket(req.query.range);
  const r = await sv.query(`
    SELECT date_bin($1::interval, ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           if_name,
           ROUND(AVG(value)::numeric, 2) AS avg_value
    FROM snmp_results
    WHERE device_id = $2 AND metric_name = $3 AND ts >= NOW() - $4::interval
    GROUP BY bucket, if_name ORDER BY bucket
  `, [bucket, id, metric, interval]);
  res.json(r.rows);
}));

app.get('/api/devices/:id/alerts', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`
    SELECT id, alert_type, severity, message, metric_value,
           triggered_at, acknowledged_at, acknowledged_by, resolved_at, status
    FROM alerts WHERE device_id = $1 ORDER BY triggered_at DESC LIMIT 200
  `, [id]);
  res.json(r.rows);
}));

// ══════════════════════════════════════════════════════════════
// Device dependencies (parent-child) for alert suppression
// ══════════════════════════════════════════════════════════════
async function depInfo(deviceId) {
  const parent = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.site_id, d.site_name, d.current_status
    FROM device_dependencies dd JOIN monitored_devices d ON d.id = dd.parent_device_id
    WHERE dd.child_device_id = $1 LIMIT 1
  `, [deviceId]);
  const children = await sv.query(`
    SELECT d.id, d.name, d.ip_address, d.site_id, d.site_name, d.current_status, d.alert_suppressed
    FROM device_dependencies dd JOIN monitored_devices d ON d.id = dd.child_device_id
    WHERE dd.parent_device_id = $1 ORDER BY d.name
  `, [deviceId]);
  return { parent: parent.rows[0] || null, children: children.rows };
}

app.get('/api/devices/:id/dependencies', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(await depInfo(id));
}));

// Set or clear this device's parent. parent_device_id null removes the parent.
app.post('/api/devices/:id/dependencies', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const raw = req.body ? req.body.parent_device_id : null;
  const parentId = raw === null || raw === undefined || raw === '' ? null : parseInt(raw, 10);

  if (parentId === null) {
    await sv.query(`DELETE FROM device_dependencies WHERE child_device_id = $1`, [id]);
    return res.json(await depInfo(id));
  }
  if (parentId === id) return res.status(400).json({ error: 'A device cannot depend on itself' });
  const exists = await sv.query(`SELECT 1 FROM monitored_devices WHERE id = $1`, [parentId]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'Parent device not found' });

  // Circular-dependency guard: the chosen parent must not be a descendant of
  // this device (otherwise a cycle would form).
  const cycle = await sv.query(`
    WITH RECURSIVE descendants AS (
      SELECT child_device_id FROM device_dependencies WHERE parent_device_id = $1
      UNION
      SELECT dd.child_device_id
      FROM device_dependencies dd JOIN descendants ds ON ds.child_device_id = dd.parent_device_id
    )
    SELECT 1 FROM descendants WHERE child_device_id = $2 LIMIT 1
  `, [id, parentId]);
  if (cycle.rows[0]) {
    return res.status(400).json({ error: 'Circular dependency: that device already depends on this one' });
  }

  // Single parent per device — replace any existing parent link.
  await sv.query(`DELETE FROM device_dependencies WHERE child_device_id = $1`, [id]);
  await sv.query(`
    INSERT INTO device_dependencies (child_device_id, parent_device_id) VALUES ($1, $2)
    ON CONFLICT (child_device_id, parent_device_id) DO NOTHING
  `, [id, parentId]);
  res.json(await depInfo(id));
}));

// Full dependency tree (flat array with depth + parent_device_id).
app.get('/api/dependencies/tree', wrap(async (_req, res) => {
  const r = await sv.query(`
    WITH RECURSIVE dep_tree AS (
      SELECT id, name, ip_address, site_name, current_status, alert_suppressed,
             NULL::integer AS parent_device_id, 0 AS depth
      FROM monitored_devices
      WHERE id NOT IN (SELECT child_device_id FROM device_dependencies) AND active = TRUE
      UNION ALL
      SELECT d.id, d.name, d.ip_address, d.site_name, d.current_status, d.alert_suppressed,
             dd.parent_device_id, dt.depth + 1
      FROM monitored_devices d
      JOIN device_dependencies dd ON dd.child_device_id = d.id
      JOIN dep_tree dt ON dt.id = dd.parent_device_id
    )
    SELECT * FROM dep_tree ORDER BY depth, parent_device_id, name
  `);
  res.json(r.rows);
}));

// On-demand single ping (does not write history — just an instant probe)
app.post('/api/devices/:id/ping-now', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT id, ip_address, ping_threshold_ms FROM monitored_devices WHERE id = $1`, [id]);
  const dev = r.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  const countFlag = IS_WIN ? '-n' : '-c';
  let alive = false;
  let ms = null;
  try {
    const result = await ping.promise.probe(dev.ip_address, { timeout: 2, extra: [countFlag, '1'] });
    alive = !!result.alive;
    if (result.time !== undefined && result.time !== 'unknown' && result.time !== null) {
      const t = parseFloat(result.time);
      if (!isNaN(t)) ms = t;
    }
  } catch (err) {
    alive = false;
  }

  const threshold = dev.ping_threshold_ms || 500;
  let status;
  if (!alive) status = 'down';
  else if (ms !== null && ms > threshold) status = 'warning';
  else status = 'up';

  res.json({ ms, status });
}));

// ══════════════════════════════════════════════════════════════
// Site gateway (one per site; gateway-down suppresses the site)
// ══════════════════════════════════════════════════════════════
// Mark this device as its site's gateway. Any existing gateway at the same site
// is cleared first so the one-gateway-per-site partial unique index holds.
app.post('/api/devices/:id/set-gateway', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dq = await sv.query(`SELECT id, site_id FROM monitored_devices WHERE id = $1`, [id]);
  const dev = dq.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  const client = await sv.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE monitored_devices SET is_gateway = FALSE, updated_at = NOW()
        WHERE site_id IS NOT DISTINCT FROM $1 AND id <> $2 AND is_gateway = TRUE`,
      [dev.site_id, id]
    );
    const r = await client.query(
      `UPDATE monitored_devices SET is_gateway = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Clear this device's gateway status.
app.post('/api/devices/:id/clear-gateway', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(
    `UPDATE monitored_devices SET is_gateway = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(r.rows[0]);
}));

// ══════════════════════════════════════════════════════════════
// SNMP discovery & sensor selection
// ══════════════════════════════════════════════════════════════
// Walk the device and return grouped, available sensors with current values.
app.post('/api/devices/:id/snmp-discover', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE id = $1`, [id]);
  const dev = r.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  if (!dev.snmp_enabled) return res.status(400).json({ error: 'SNMP is not enabled for this device' });

  const result = await discoverDevice(dev, 15000);
  if (result.error) return res.status(502).json({ error: result.error });
  res.json(result);
}));

// All saved sensors for a device.
app.get('/api/devices/:id/sensors', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(
    `SELECT id, sensor_key, sensor_name, category, metric_name, oid, enabled, created_at
       FROM device_sensors WHERE device_id = $1
       ORDER BY category, sensor_name`,
    [id]
  );
  res.json(r.rows);
}));

// Upsert the device's sensor selection.
app.put('/api/devices/:id/sensors', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const list = Array.isArray(req.body && req.body.sensors) ? req.body.sensors : null;
  if (!list) return res.status(400).json({ error: 'sensors array required' });

  const dev = await sv.query(`SELECT id FROM monitored_devices WHERE id = $1`, [id]);
  if (!dev.rows[0]) return res.status(404).json({ error: 'Device not found' });

  for (const s of list) {
    if (!s || !s.sensor_key || !s.metric_name) continue;
    await sv.query(`
      INSERT INTO device_sensors (device_id, sensor_key, sensor_name, category, metric_name, oid, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (device_id, sensor_key) DO UPDATE
        SET sensor_name = EXCLUDED.sensor_name,
            category    = EXCLUDED.category,
            metric_name = EXCLUDED.metric_name,
            oid         = EXCLUDED.oid,
            enabled     = EXCLUDED.enabled
    `, [
      id, s.sensor_key, s.sensor_name || s.sensor_key, s.category || 'system',
      s.metric_name, s.oid || null, s.enabled !== false,
    ]);
  }

  const saved = await sv.query(
    `SELECT id, sensor_key, sensor_name, category, metric_name, oid, enabled, created_at
       FROM device_sensors WHERE device_id = $1
       ORDER BY category, sensor_name`,
    [id]
  );
  res.json(saved.rows);
}));

// Test SNMP reachability for a saved device using its stored credentials.
app.post('/api/devices/:id/snmp-test', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`SELECT * FROM monitored_devices WHERE id = $1`, [id]);
  const dev = r.rows[0];
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  res.json(await snmpTest(dev, 10000));
}));

// Test SNMP with ad-hoc credentials (before a device is saved).
app.post('/api/snmp-test-adhoc', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.ip_address) return res.status(400).json({ error: 'ip_address required' });
  const dev = {
    ip_address: b.ip_address,
    snmp_version: b.snmp_version || '2c',
    snmp_community: b.snmp_community || 'public',
    snmp_port: safeInt(b.snmp_port, 161),
    snmp_v3_user: b.snmp_v3_user || null,
    snmp_v3_auth_pass: b.snmp_v3_auth_pass || null,
    snmp_v3_priv_pass: b.snmp_v3_priv_pass || null,
  };
  res.json(await snmpTest(dev, 10000));
}));

// ══════════════════════════════════════════════════════════════
// NetVault integration (read-only source)
// ══════════════════════════════════════════════════════════════
// Devices in NetVault that are NOT yet monitored
app.get('/api/netvault/devices', wrap(async (_req, res) => {
  const monitored = await sv.query(`SELECT netvault_device_id FROM monitored_devices WHERE netvault_device_id IS NOT NULL`);
  const existing = new Set(monitored.rows.map((r) => r.netvault_device_id));
  const r = await nv.query(`
    SELECT d.id AS netvault_device_id,
           d.name,
           host(d.ip_address) AS ip_address,
           dt.name AS device_type,
           d.site_id,
           s.name AS site_name
    FROM devices d
    LEFT JOIN device_types dt ON dt.id = d.device_type_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.ip_address IS NOT NULL
      AND COALESCE(d.device_status, 'Active') <> 'Decommed'
    ORDER BY s.name NULLS LAST, d.name
  `);
  res.json(r.rows.filter((row) => !existing.has(row.netvault_device_id)));
}));

// Import selected NetVault devices into monitoring
app.post('/api/netvault/import', wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.device_ids) ? req.body.device_ids : [];
  if (ids.length === 0) return res.status(400).json({ error: 'device_ids array required' });
  const src = await nv.query(`
    SELECT d.id AS netvault_device_id, d.name, host(d.ip_address) AS ip_address,
           dt.name AS device_type, d.site_id, s.name AS site_name
    FROM devices d
    LEFT JOIN device_types dt ON dt.id = d.device_type_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.id = ANY($1::int[]) AND d.ip_address IS NOT NULL
  `, [ids]);
  let imported = 0;
  for (const row of src.rows) {
    const r = await sv.query(`
      INSERT INTO monitored_devices (name, ip_address, device_type, site_id, site_name, netvault_device_id)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (ip_address) DO NOTHING
      RETURNING id
    `, [row.name, row.ip_address, row.device_type, row.site_id, row.site_name, row.netvault_device_id]);
    if (r.rows[0]) imported++;
  }
  res.json({ imported, requested: ids.length });
}));

// Sites from NetVault (for map + filters)
app.get('/api/netvault/sites', wrap(async (_req, res) => {
  const r = await nv.query(`
    SELECT id, name, code, city
    FROM sites
    WHERE COALESCE(site_status, 'Active') = 'Active'
    ORDER BY name
  `);
  res.json(r.rows);
}));

// ══════════════════════════════════════════════════════════════
// Alerts
// ══════════════════════════════════════════════════════════════
app.get('/api/alerts', wrap(async (req, res) => {
  const { status, severity, device_id } = req.query;
  const where = [];
  const params = [];
  if (status)    { params.push(status);    where.push(`a.status = $${params.length}`); }
  if (severity)  { params.push(severity);  where.push(`a.severity = $${params.length}`); }
  if (device_id) { params.push(parseInt(device_id, 10)); where.push(`a.device_id = $${params.length}`); }
  const limit = safeInt(req.query.limit, 200, 1000);
  const rows = await sv.query(`
    SELECT a.id, a.device_id, d.name AS device_name, d.ip_address,
           a.alert_type, a.severity, a.message, a.metric_value,
           a.triggered_at, a.acknowledged_at, a.acknowledged_by, a.resolved_at, a.status,
           a.suppressed_by, a.suppression_reason, sb.name AS suppressed_by_name
    FROM alerts a
    LEFT JOIN monitored_devices d  ON d.id = a.device_id
    LEFT JOIN monitored_devices sb ON sb.id = a.suppressed_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.triggered_at DESC
    LIMIT ${limit}
  `, params);
  res.json(rows.rows);
}));

app.post('/api/alerts/:id/acknowledge', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const by = (req.body && req.body.acknowledged_by) || 'unknown';
  const r = await sv.query(`
    UPDATE alerts SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2
    WHERE id = $1 AND status = 'active' RETURNING *
  `, [id, by]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Active alert not found' });
  res.json(r.rows[0]);
}));

app.post('/api/alerts/:id/resolve', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await sv.query(`
    UPDATE alerts SET status = 'resolved', resolved_at = NOW()
    WHERE id = $1 AND status <> 'resolved' RETURNING *
  `, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Alert not found or already resolved' });
  res.json(r.rows[0]);
}));

// ══════════════════════════════════════════════════════════════
// Alert rules
// ══════════════════════════════════════════════════════════════
// Conditions that carry no operator/threshold.
const NO_THRESHOLD_METRICS = ['device_down', 'interface_down'];

// Merge global → site → device rules by metric (later scope wins).
function mergeEffectiveRules(rows) {
  const prec = { global: 0, site: 1, device: 2 };
  const byMetric = new Map();
  for (const rule of rows) {
    const cur = byMetric.get(rule.metric);
    if (!cur || (prec[rule.scope] ?? 0) >= (prec[cur.scope] ?? 0)) byMetric.set(rule.metric, rule);
  }
  return Array.from(byMetric.values());
}

app.get('/api/alert-rules', wrap(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.scope)     { params.push(String(req.query.scope));        where.push(`r.scope = $${params.length}`); }
  if (req.query.site_id)   { params.push(parseInt(req.query.site_id, 10)); where.push(`r.site_id = $${params.length}`); }
  if (req.query.device_id) { params.push(parseInt(req.query.device_id, 10)); where.push(`r.device_id = $${params.length}`); }
  const r = await sv.query(`
    SELECT r.*, d.name AS device_name
    FROM alert_rules r LEFT JOIN monitored_devices d ON d.id = r.device_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.scope, r.site_name NULLS FIRST, r.device_id NULLS FIRST, r.metric
  `, params);
  res.json(r.rows);
}));

// Effective ruleset for a device after global → site → device inheritance.
app.get('/api/alert-rules/effective/:device_id', wrap(async (req, res) => {
  const id = parseInt(req.params.device_id, 10);
  const dq = await sv.query(`SELECT id, name, site_id, site_name FROM monitored_devices WHERE id = $1`, [id]);
  const device = dq.rows[0];
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const r = await sv.query(`
    SELECT r.*, d.name AS device_name
    FROM alert_rules r LEFT JOIN monitored_devices d ON d.id = r.device_id
    WHERE r.enabled = TRUE AND (
      r.scope = 'global'
      OR (r.scope = 'site'   AND r.site_id IS NOT DISTINCT FROM $2)
      OR (r.scope = 'device' AND r.device_id = $1)
    )
    ORDER BY r.metric
  `, [id, device.site_id == null ? null : device.site_id]);
  res.json({ device, rules: mergeEffectiveRules(r.rows) });
}));

app.post('/api/alert-rules', wrap(async (req, res) => {
  const b = req.body || {};
  const noThreshold = NO_THRESHOLD_METRICS.includes(b.metric);
  if (!b.metric || (!noThreshold && (b.threshold === undefined || b.threshold === null || b.threshold === ''))) {
    return res.status(400).json({ error: 'metric and threshold required' });
  }
  const scope = b.scope || (b.device_id ? 'device' : b.site_id ? 'site' : 'global');
  const r = await sv.query(`
    INSERT INTO alert_rules
      (device_id, site_id, site_name, scope, metric, operator, threshold, severity, enabled, notify_recovery, description)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [
    b.device_id || null, b.site_id || null, b.site_name || null, scope, b.metric,
    b.operator || '>', noThreshold ? null : b.threshold, b.severity || 'warning',
    b.enabled === undefined ? true : !!b.enabled, !!b.notify_recovery, b.description || null,
  ]);
  res.status(201).json(r.rows[0]);
}));

app.put('/api/alert-rules/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['metric', 'operator', 'threshold', 'severity', 'enabled', 'device_id',
                   'scope', 'site_id', 'site_name', 'notify_recovery', 'description'];
  const sets = [];
  const params = [];
  for (const k of allowed) if (b[k] !== undefined) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(id);
  const r = await sv.query(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'Rule not found' });
  res.json(r.rows[0]);
}));

app.delete('/api/alert-rules/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM alert_rules WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// ══════════════════════════════════════════════════════════════
// Network map — devices grouped by site
// ══════════════════════════════════════════════════════════════
app.get('/api/map', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT COALESCE(d.site_id, 0) AS site_id,
           COALESCE(d.site_name, 'Unassigned') AS site_name,
           d.id, d.name, d.ip_address, d.device_type, d.current_status,
           d.alert_suppressed, d.suppressed_by_device_id,
           dd.parent_device_id, p.name AS parent_name
    FROM monitored_devices d
    LEFT JOIN device_dependencies dd ON dd.child_device_id = d.id
    LEFT JOIN monitored_devices p ON p.id = dd.parent_device_id
    WHERE d.active = TRUE
    ORDER BY d.site_name NULLS LAST, d.name
  `);
  const sites = {};
  for (const row of r.rows) {
    const key = row.site_id;
    if (!sites[key]) sites[key] = { site_id: row.site_id, site_name: row.site_name, devices: [] };
    sites[key].devices.push({
      id: row.id, name: row.name, ip_address: row.ip_address,
      device_type: row.device_type, status: row.current_status,
      alert_suppressed: row.alert_suppressed,
      suppressed_by_device_id: row.suppressed_by_device_id,
      parent_device_id: row.parent_device_id, parent_name: row.parent_name,
    });
  }
  res.json(Object.values(sites));
}));

// ══════════════════════════════════════════════════════════════
// Reports (?format=csv supported)
// ══════════════════════════════════════════════════════════════
app.get('/api/reports/availability', wrap(async (req, res) => {
  const interval = rangeToInterval(req.query.range);
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           ROUND((1 - (SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::numeric
                  / NULLIF(COUNT(*), 0))) * 100, 2) AS uptime_pct,
           COUNT(*)::int AS total_checks,
           SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks
    FROM monitored_devices d
    LEFT JOIN ping_results p ON p.device_id = d.id AND p.ts >= NOW() - $1::interval
    WHERE d.active = TRUE
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    ORDER BY uptime_pct ASC NULLS LAST
  `, [interval]);
  if (req.query.format === 'csv') return sendCsv(res, 'availability.csv', r.rows);
  res.json(r.rows);
}));

app.get('/api/reports/response-time', wrap(async (req, res) => {
  const interval = rangeToInterval(req.query.range);
  const bucket = rangeToBucket(req.query.range);

  const p1 = [interval];
  const f1 = reportFilters(req.query, p1);
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           ROUND(AVG(p.response_ms)::numeric, 1) AS avg_ms,
           ROUND(MIN(p.response_ms)::numeric, 1) AS min_ms,
           ROUND(MAX(p.response_ms)::numeric, 1) AS max_ms,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY p.response_ms)::numeric, 1) AS p95_ms
    FROM monitored_devices d
    LEFT JOIN ping_results p ON p.device_id = d.id AND p.ts >= NOW() - $1::interval AND p.status = 'up'
    WHERE ${f1.join(' AND ')}
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    ORDER BY avg_ms DESC NULLS LAST
  `, p1);

  // Per-device sparkline series (bucketed average) for the trend column.
  const p2 = [bucket, interval];
  const f2 = reportFilters(req.query, p2);
  const sp = await sv.query(`
    SELECT p.device_id,
           date_bin($1::interval, p.ts, TIMESTAMPTZ '2000-01-01') AS bucket,
           ROUND(AVG(p.response_ms)::numeric, 1) AS avg_ms
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts >= NOW() - $2::interval AND p.status = 'up' AND ${f2.join(' AND ')}
    GROUP BY p.device_id, bucket ORDER BY p.device_id, bucket
  `, p2);
  const sparkByDev = new Map();
  for (const row of sp.rows) {
    if (!sparkByDev.has(row.device_id)) sparkByDev.set(row.device_id, []);
    sparkByDev.get(row.device_id).push(Number(row.avg_ms));
  }

  const rows = r.rows.map((row) => ({ ...row, spark: sparkByDev.get(row.device_id) || [] }));
  if (req.query.format === 'csv') return sendCsv(res, 'response-time.csv', r.rows);
  res.json(rows);
}));

app.get('/api/reports/alerts', wrap(async (req, res) => {
  const interval = rangeToInterval(req.query.range);
  const params = [interval];
  const f = reportFilters(req.query, params);
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           COUNT(a.*)::int AS total_alerts,
           COUNT(*) FILTER (WHERE a.severity = 'critical')::int AS critical_count,
           COUNT(*) FILTER (WHERE a.severity = 'warning')::int  AS warning_count,
           ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)
                 FILTER (WHERE a.resolved_at IS NOT NULL)::numeric, 1) AS mttr_minutes,
           MODE() WITHIN GROUP (ORDER BY a.alert_type) AS most_common_type
    FROM monitored_devices d
    LEFT JOIN alerts a ON a.device_id = d.id AND a.triggered_at >= NOW() - $1::interval
    WHERE ${f.join(' AND ')}
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    HAVING COUNT(a.*) > 0
    ORDER BY total_alerts DESC
  `, params);
  if (req.query.format === 'csv') return sendCsv(res, 'alert-summary.csv', r.rows);
  res.json(r.rows);
}));

// ── SLA / bandwidth report helpers ────────────────────────────
// Returns the leading window params + a clause builder for a timestamp column.
function windowParams(q) {
  if (q.range === 'custom' && q.from && q.to) return { custom: true, params: [q.from, q.to] };
  const map = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };
  return { custom: false, params: [map[q.range] || '30 days'] };
}
function windowClause(col, w, start) {
  return w.custom
    ? `${col} >= $${start} AND ${col} <= $${start + 1}`
    : `${col} >= NOW() - $${start}::interval`;
}

// Per-device SLA rows for the requested window/scope. Shared by both SLA routes.
async function slaRows(q) {
  const w = windowParams(q);
  const params = [...w.params];
  const pingTs = windowClause('ts', w, 1);
  const alertTs = windowClause('triggered_at', w, 1);
  const filters = ['d.active = TRUE'];
  if (q.site_id)   { params.push(parseInt(q.site_id, 10));   filters.push(`d.site_id = $${params.length}`); }
  if (q.device_id) { params.push(parseInt(q.device_id, 10)); filters.push(`d.id = $${params.length}`); }
  const t = parseFloat(q.sla_target);
  const slaTarget = isNaN(t) ? 99.5 : t;

  const r = await sv.query(`
    WITH pings AS (
      SELECT device_id, COUNT(*)::int AS total_checks,
             SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks,
             AVG(response_ms) FILTER (WHERE status = 'up') AS avg_ms,
             MAX(response_ms) AS max_ms,
             MIN(response_ms) FILTER (WHERE status = 'up') AS min_ms
      FROM ping_results WHERE ${pingTs} GROUP BY device_id
    ),
    als AS (
      SELECT device_id, COUNT(*)::int AS total_alerts,
             AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at)) / 60.0)
               FILTER (WHERE resolved_at IS NOT NULL) AS mttr
      FROM alerts WHERE ${alertTs} GROUP BY device_id
    )
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           COALESCE(pg.total_checks, 0)  AS total_checks,
           COALESCE(pg.failed_checks, 0) AS failed_checks,
           CASE WHEN pg.total_checks > 0
                THEN ROUND((1 - pg.failed_checks::numeric / pg.total_checks) * 100, 3)
                ELSE NULL END AS uptime_pct,
           ROUND(pg.avg_ms::numeric, 1) AS avg_response_ms,
           ROUND(pg.max_ms::numeric, 1) AS max_response_ms,
           ROUND(pg.min_ms::numeric, 1) AS min_response_ms,
           COALESCE(al.total_alerts, 0) AS total_alerts,
           ROUND(al.mttr::numeric, 1)   AS mttr_minutes,
           ROUND(COALESCE(pg.failed_checks, 0) * d.poll_interval_seconds / 60.0, 1) AS downtime_minutes
    FROM monitored_devices d
    LEFT JOIN pings pg ON pg.device_id = d.id
    LEFT JOIN als   al ON al.device_id = d.id
    WHERE ${filters.join(' AND ')}
    ORDER BY uptime_pct ASC NULLS LAST, d.name
  `, params);

  const rows = r.rows.map((row) => ({
    ...row,
    sla_met: row.uptime_pct != null && Number(row.uptime_pct) >= slaTarget,
  }));
  return { rows, slaTarget };
}

app.get('/api/reports/sla', wrap(async (req, res) => {
  const { rows, slaTarget } = await slaRows(req.query);
  res.json({ sla_target: slaTarget, generated_at: new Date().toISOString(), devices: rows });
}));

app.get('/api/reports/sla/summary', wrap(async (req, res) => {
  const { rows, slaTarget } = await slaRows(req.query);
  const withData = rows.filter((r) => r.total_checks > 0);
  const totalChecks = withData.reduce((a, r) => a + r.total_checks, 0);
  const totalFailed = withData.reduce((a, r) => a + r.failed_checks, 0);
  const overall = totalChecks ? Math.round((1 - totalFailed / totalChecks) * 100 * 1000) / 1000 : null;
  const totalDowntime = Math.round(rows.reduce((a, r) => a + (Number(r.downtime_minutes) || 0), 0) * 10) / 10;
  let worst = null, best = null;
  for (const r of withData) {
    const u = Number(r.uptime_pct);
    if (worst === null || u < worst.uptime_pct) worst = { name: r.device_name, uptime_pct: u };
    if (best === null || u > best.uptime_pct)  best  = { name: r.device_name, uptime_pct: u };
  }
  res.json({
    sla_target: slaTarget,
    total_devices: rows.length,
    devices_meeting_sla: rows.filter((r) => r.sla_met).length,
    overall_availability_pct: overall,
    total_downtime_minutes: totalDowntime,
    worst_device: worst,
    best_device: best,
  });
}));

app.get('/api/reports/bandwidth', wrap(async (req, res) => {
  const q = req.query;
  const w = windowParams(q);
  const params = [...w.params];
  const filters = [
    `s.metric_name ~ '^if_[0-9]+_(in|out)_bps$'`,
    windowClause('s.ts', w, 1),
  ];
  if (q.site_id)   { params.push(parseInt(q.site_id, 10));   filters.push(`d.site_id = $${params.length}`); }
  if (q.device_id) { params.push(parseInt(q.device_id, 10)); filters.push(`d.id = $${params.length}`); }
  const r = await sv.query(`
    SELECT s.device_id, d.name AS device_name, d.site_name, s.if_name, s.metric_name,
           ROUND(AVG(s.value)::numeric, 0) AS avg_bps,
           ROUND(MAX(s.value)::numeric, 0) AS max_bps,
           ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.value)::numeric, 0) AS p95_bps
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE ${filters.join(' AND ')}
    GROUP BY s.device_id, d.name, d.site_name, s.if_name, s.metric_name
  `, params);

  // Pair in/out per interface index into one row.
  const map = new Map();
  for (const row of r.rows) {
    const m = /^if_(\d+)_(in|out)_bps$/.exec(row.metric_name);
    if (!m) continue;
    const idx = m[1], dir = m[2];
    const key = `${row.device_id}|${idx}`;
    let e = map.get(key);
    if (!e) {
      e = { device_id: row.device_id, device_name: row.device_name, site_name: row.site_name,
            sensor_name: row.if_name || `Interface ${idx}`,
            avg_in_bps: null, avg_out_bps: null, max_in_bps: null, max_out_bps: null,
            p95_in_bps: null, p95_out_bps: null };
      map.set(key, e);
    }
    if (row.if_name) e.sensor_name = row.if_name;
    if (dir === 'in')  { e.avg_in_bps = row.avg_bps;  e.max_in_bps = row.max_bps;  e.p95_in_bps = row.p95_bps; }
    else               { e.avg_out_bps = row.avg_bps; e.max_out_bps = row.max_bps; e.p95_out_bps = row.p95_bps; }
  }
  const out = Array.from(map.values()).sort((a, b) =>
    (a.device_name || '').localeCompare(b.device_name || '') ||
    (a.sensor_name || '').localeCompare(b.sensor_name || ''));
  res.json(out);
}));

// ══════════════════════════════════════════════════════════════
// Settings
// ══════════════════════════════════════════════════════════════
app.get('/api/settings', wrap(async (_req, res) => {
  const r = await sv.query(`SELECT key, value FROM app_settings`);
  const out = {};
  for (const row of r.rows) out[row.key] = row.value;
  res.json(out);
}));

app.put('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const keys = Object.keys(b);
  for (const k of keys) {
    await sv.query(`
      INSERT INTO app_settings (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [k, b[k] === null ? null : String(b[k])]);
  }
  res.json({ ok: true, updated: keys.length });
}));

// ══════════════════════════════════════════════════════════════
// Maintenance windows
// ══════════════════════════════════════════════════════════════
app.get('/api/maintenance', wrap(async (_req, res) => {
  const r = await sv.query(`
    SELECT m.*, d.name AS device_name FROM maintenance_windows m
    LEFT JOIN monitored_devices d ON d.id = m.device_id
    ORDER BY m.starts_at DESC
  `);
  res.json(r.rows);
}));

app.post('/api/maintenance', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.starts_at || !b.ends_at) return res.status(400).json({ error: 'starts_at and ends_at required' });
  const r = await sv.query(`
    INSERT INTO maintenance_windows (device_id, starts_at, ends_at, reason)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [b.device_id || null, b.starts_at, b.ends_at, b.reason || null]);
  res.status(201).json(r.rows[0]);
}));

app.delete('/api/maintenance/:id', wrap(async (req, res) => {
  await sv.query(`DELETE FROM maintenance_windows WHERE id = $1`, [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// ── Error handler (generic message in production) ─────────────
app.use((err, _req, res, _next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ error: PROD ? 'Internal server error' : err.message });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SpanVault API listening on 127.0.0.1:${PORT}`);
});

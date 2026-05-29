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
const { Pool } = require('pg');

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
    case '24h':
    default:    return '24 hours';
  }
}
function rangeToBucket(range) {
  switch (range) {
    case '7d':  return '1 hour';
    case '30d': return '6 hours';
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

// ══════════════════════════════════════════════════════════════
// Health
// ══════════════════════════════════════════════════════════════
app.get('/api/health', wrap(async (_req, res) => {
  await sv.query('SELECT 1');
  res.json({ status: 'ok', service: 'spanvault-api', time: new Date().toISOString() });
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

// ══════════════════════════════════════════════════════════════
// Monitored devices
// ══════════════════════════════════════════════════════════════
app.get('/api/devices', wrap(async (req, res) => {
  const { status, site_id, q } = req.query;
  const where = ['active = TRUE'];
  const params = [];
  if (status)  { params.push(status);  where.push(`current_status = $${params.length}`); }
  if (site_id) { params.push(parseInt(site_id, 10)); where.push(`site_id = $${params.length}`); }
  if (q)       { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR ip_address ILIKE $${params.length})`); }
  const rows = await sv.query(`
    SELECT id, name, ip_address, device_type, site_id, site_name,
           current_status, last_response_ms, last_seen_at, last_checked_at,
           snmp_enabled, poll_interval_seconds, netvault_device_id
    FROM monitored_devices
    WHERE ${where.join(' AND ')}
    ORDER BY site_name NULLS LAST, name
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
           a.triggered_at, a.acknowledged_at, a.acknowledged_by, a.resolved_at, a.status
    FROM alerts a
    LEFT JOIN monitored_devices d ON d.id = a.device_id
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
app.get('/api/alert-rules', wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.device_id) { params.push(parseInt(req.query.device_id, 10)); where = `WHERE r.device_id = $1`; }
  const r = await sv.query(`
    SELECT r.*, d.name AS device_name
    FROM alert_rules r LEFT JOIN monitored_devices d ON d.id = r.device_id
    ${where} ORDER BY r.device_id NULLS FIRST, r.metric
  `, params);
  res.json(r.rows);
}));

app.post('/api/alert-rules', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.metric || b.threshold === undefined) return res.status(400).json({ error: 'metric and threshold required' });
  const r = await sv.query(`
    INSERT INTO alert_rules (device_id, metric, operator, threshold, severity, enabled)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
  `, [b.device_id || null, b.metric, b.operator || '>', b.threshold, b.severity || 'warning',
      b.enabled === undefined ? true : !!b.enabled]);
  res.status(201).json(r.rows[0]);
}));

app.put('/api/alert-rules/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const allowed = ['metric', 'operator', 'threshold', 'severity', 'enabled', 'device_id'];
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
    SELECT COALESCE(site_id, 0) AS site_id,
           COALESCE(site_name, 'Unassigned') AS site_name,
           id, name, ip_address, device_type, current_status
    FROM monitored_devices WHERE active = TRUE
    ORDER BY site_name NULLS LAST, name
  `);
  const sites = {};
  for (const row of r.rows) {
    const key = row.site_id;
    if (!sites[key]) sites[key] = { site_id: row.site_id, site_name: row.site_name, devices: [] };
    sites[key].devices.push({
      id: row.id, name: row.name, ip_address: row.ip_address,
      device_type: row.device_type, status: row.current_status,
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
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           ROUND(AVG(p.response_ms)::numeric, 1) AS avg_ms,
           ROUND(MIN(p.response_ms)::numeric, 1) AS min_ms,
           ROUND(MAX(p.response_ms)::numeric, 1) AS max_ms
    FROM monitored_devices d
    LEFT JOIN ping_results p ON p.device_id = d.id AND p.ts >= NOW() - $1::interval AND p.status = 'up'
    WHERE d.active = TRUE
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    ORDER BY avg_ms DESC NULLS LAST
  `, [interval]);
  if (req.query.format === 'csv') return sendCsv(res, 'response-time.csv', r.rows);
  res.json(r.rows);
}));

app.get('/api/reports/alerts', wrap(async (req, res) => {
  const interval = rangeToInterval(req.query.range);
  const r = await sv.query(`
    SELECT d.id AS device_id, d.name AS device_name, d.ip_address, d.site_name,
           COUNT(a.*)::int AS total_alerts,
           ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)
                 FILTER (WHERE a.resolved_at IS NOT NULL)::numeric, 1) AS mttr_minutes
    FROM monitored_devices d
    LEFT JOIN alerts a ON a.device_id = d.id AND a.triggered_at >= NOW() - $1::interval
    WHERE d.active = TRUE
    GROUP BY d.id, d.name, d.ip_address, d.site_name
    HAVING COUNT(a.*) > 0
    ORDER BY total_alerts DESC
  `, [interval]);
  if (req.query.format === 'csv') return sendCsv(res, 'alert-summary.csv', r.rows);
  res.json(r.rows);
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

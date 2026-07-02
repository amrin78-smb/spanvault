/* eslint-disable no-console */
//
// SpanVault — DEMO DATA seed script
// =================================
// Generates a realistic 14-day monitoring dataset for the shared NocVault demo
// scenario (org "Cahaya Teknologi Sdn Bhd"). Populates the tables that drive the
// SpanVault UI: device list, status dashboard, latency/bandwidth charts,
// availability rollups, and alerts.
//
// RUN ON THE TEST LAPTOP (Postgres local). `pg` resolves from this folder
// (spanvault/frontend/node_modules).
//
//   Fresh reseed (recommended):
//     RESET=1 node demo-seed.js
//
//   Connection is env-overridable (defaults shown):
//     PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=amed1920 \
//     PGDATABASE=spanvault RESET=1 node demo-seed.js
//
// RESET=1 clears ONLY the metric/history/demo tables (ping_results, snmp_results,
// availability_summary, alerts, device_health_scores) before reseeding. Device,
// interface (device_sensors), config, settings and users are NEVER deleted — the
// device/sensor registries are upserted idempotently.
//
const { Client } = require('pg');

// ── Tunables ───────────────────────────────────────────────────────────────
const DAYS = 14; // history window
const STEP_MIN = 15; // sample interval (minutes) → 14d @15m ≈ 1344 pts/series
const RESET = process.env.RESET === '1';
const STEP_MS = STEP_MIN * 60 * 1000;

const conn = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'amed1920',
  database: process.env.PGDATABASE || 'spanvault',
  ssl: false,
};

// ── Shared scenario ──────────────────────────────────────────────────────────
const SITES = {
  KLHQ: { id: 1, name: 'Kuala Lumpur HQ' },
  PEN: { id: 2, name: 'Penang' },
  JB: { id: 3, name: 'Johor Bahru' },
};

// vendor lowercased to match the collector's vendor parser (fortinet/cisco/aruba)
const DEVICES = [
  { name: 'FG-KLHQ-01', ip: '10.10.0.1', vendor: 'fortinet', type: 'firewall', site: 'KLHQ', gateway: true },
  { name: 'FG-PEN-01', ip: '10.20.0.1', vendor: 'fortinet', type: 'firewall', site: 'PEN', gateway: true },
  { name: 'FG-JB-01', ip: '10.30.0.1', vendor: 'fortinet', type: 'firewall', site: 'JB', gateway: true },
  { name: 'SW-KLHQ-CORE-01', ip: '10.10.0.2', vendor: 'cisco', type: 'core-switch', site: 'KLHQ' },
  { name: 'SW-KLHQ-CORE-02', ip: '10.10.0.3', vendor: 'cisco', type: 'core-switch', site: 'KLHQ' },
  { name: 'SW-PEN-CORE-01', ip: '10.20.0.2', vendor: 'aruba', type: 'core-switch', site: 'PEN' },
  { name: 'SW-JB-CORE-01', ip: '10.30.0.2', vendor: 'aruba', type: 'core-switch', site: 'JB' }, // degraded/outage
  { name: 'SW-KLHQ-ACC-01', ip: '10.10.0.10', vendor: 'cisco', type: 'access-switch', site: 'KLHQ' },
  { name: 'SW-PEN-ACC-01', ip: '10.20.0.10', vendor: 'aruba', type: 'access-switch', site: 'PEN' },
  { name: 'RTR-WAN-01', ip: '10.10.0.254', vendor: 'cisco', type: 'router', site: 'KLHQ' },
  { name: 'AP-KLHQ-01', ip: '10.10.5.11', vendor: 'aruba', type: 'ap', site: 'KLHQ' },
  { name: 'SRV-DC01', ip: '10.10.1.10', vendor: null, type: 'server', site: 'KLHQ' },
  { name: 'SRV-WEB01', ip: '10.10.1.20', vendor: null, type: 'server', site: 'KLHQ' },
  { name: 'SRV-DB01', ip: '10.10.1.30', vendor: null, type: 'server', site: 'KLHQ' },
];

const M = 1e6;
// Per-type behaviour profile. Remote sites (PEN/JB) add WAN latency.
function profileFor(d) {
  const remote = SITES[d.site].id !== 1;
  let p;
  switch (d.type) {
    case 'firewall': p = { latBase: 3, latVar: 2, cpuBase: 18, cpuAmp: 30, memBase: 45, memAmp: 18, upCap: 400 * M, downCap: 250 * M }; break;
    case 'core-switch': p = { latBase: 1.2, latVar: 1.5, cpuBase: 10, cpuAmp: 22, memBase: 35, memAmp: 12, upCap: 600 * M, downCap: 400 * M }; break;
    case 'access-switch': p = { latBase: 2, latVar: 1.5, cpuBase: 8, cpuAmp: 15, memBase: 32, memAmp: 10, upCap: 200 * M, downCap: 120 * M }; break;
    case 'router': p = { latBase: 5, latVar: 3, cpuBase: 15, cpuAmp: 25, memBase: 40, memAmp: 12, upCap: 350 * M, downCap: 300 * M }; break;
    case 'ap': p = { latBase: 4, latVar: 2.5, cpuBase: 10, cpuAmp: 15, memBase: 30, memAmp: 10, upCap: 120 * M, downCap: 80 * M }; break;
    case 'server': p = { latBase: 1, latVar: 1, cpuBase: 22, cpuAmp: 30, memBase: 55, memAmp: 18, upCap: 250 * M, downCap: 180 * M }; break;
    default: p = { latBase: 3, latVar: 2, cpuBase: 15, cpuAmp: 20, memBase: 40, memAmp: 12, upCap: 200 * M, downCap: 120 * M };
  }
  if (d.name === 'SRV-DB01') { p.memBase = 65; p.memAmp = 16; } // DB server runs hot on memory
  if (remote) { p.latBase += 9; p.latVar += 6; }
  return p;
}

// Two interfaces per device (uplink + downlink) for interface-bandwidth metrics.
function ifacesFor(d) {
  if (d.type === 'server') return [{ idx: 1, name: 'eth0', role: 'uplink' }, { idx: 2, name: 'eth1', role: 'downlink' }];
  if (d.type === 'router') return [{ idx: 1, name: 'Gi0/0', role: 'uplink' }, { idx: 2, name: 'Gi0/1', role: 'downlink' }];
  if (d.type === 'ap') return [{ idx: 1, name: 'eth0', role: 'uplink' }, { idx: 2, name: 'eth1', role: 'downlink' }];
  return [{ idx: 1, name: 'Gi1/0/1', role: 'uplink' }, { idx: 2, name: 'Gi1/0/2', role: 'downlink' }];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Business-hours daily curve (0..1): low overnight, ramps 06–09, peaks midday,
// tapers 18–22, weekends damped.
function dayCurve(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  let f;
  if (h < 6) f = 0.05;
  else if (h < 9) f = 0.05 + ((h - 6) / 3) * 0.75;
  else if (h <= 18) f = 0.8 + 0.2 * Math.sin(((h - 9) / 9) * Math.PI);
  else if (h < 22) f = 0.8 - ((h - 18) / 4) * 0.7;
  else f = 0.1;
  const dow = d.getDay();
  const wk = dow === 0 || dow === 6 ? 0.45 : 1.0;
  return Math.max(0.03, f * wk);
}

// Chunked multi-row INSERT (keeps placeholders under Postgres' 65535 param cap).
async function bulkInsert(client, table, cols, rows, conflict) {
  if (!rows.length) return 0;
  const ncol = cols.length;
  const chunkSize = Math.max(1, Math.floor(60000 / ncol));
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const params = [];
    const tuples = slice.map((row, r) => {
      const ph = cols.map((_, c) => `$${r * ncol + c + 1}`);
      for (const v of row) params.push(v);
      return `(${ph.join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}${conflict ? ' ' + conflict : ''}`;
    await client.query(sql, params);
    total += slice.length;
  }
  return total;
}

async function main() {
  const client = new Client(conn);
  await client.connect();
  console.log(`Connected to ${conn.user}@${conn.host}:${conn.port}/${conn.database}`);
  const counts = {};
  const now = new Date();
  const nowMs = now.getTime();
  const startMs = nowMs - DAYS * 24 * 60 * 60 * 1000;

  // SW-JB-CORE-01 incident windows (3 days ago, 02:00 local: 90-min hard outage
  // bracketed by degraded periods).
  const outageStart = new Date(now); outageStart.setDate(outageStart.getDate() - 3); outageStart.setHours(2, 0, 0, 0);
  const outageStartMs = outageStart.getTime();
  const outageEndMs = outageStartMs + 90 * 60 * 1000;
  const degradedStartMs = outageStartMs - 2 * 3600 * 1000;
  const degradedEndMs = outageEndMs + 2.5 * 3600 * 1000;

  try {
    await client.query('BEGIN');

    // ── RESET: clear metric/history/demo tables only ─────────────────────────
    if (RESET) {
      for (const t of ['ping_results', 'snmp_results', 'availability_summary', 'alerts', 'device_health_scores']) {
        const r = await client.query(`DELETE FROM ${t}`);
        console.log(`  RESET: cleared ${t} (${r.rowCount} rows)`);
      }
    }

    // ── monitored_devices (upsert on ip_address) ─────────────────────────────
    const devCols = ['name', 'ip_address', 'device_type', 'site_id', 'site_name', 'snmp_enabled',
      'snmp_version', 'snmp_community', 'device_vendor', 'current_status', 'last_response_ms',
      'last_checked_at', 'last_seen_at', 'active', 'is_gateway', 'poll_interval_seconds'];
    const devRows = DEVICES.map((d) => {
      const prof = profileFor(d);
      const repLat = round2(prof.latBase + prof.latVar * 0.5);
      return [d.name, d.ip, d.type, SITES[d.site].id, SITES[d.site].name, true, '2c', 'public',
        d.vendor, 'up', repLat, now, now, true, !!d.gateway, 300];
    });
    {
      const ncol = devCols.length;
      const params = [];
      const tuples = devRows.map((row, r) => {
        const ph = devCols.map((_, c) => `$${r * ncol + c + 1}`);
        for (const v of row) params.push(v);
        return `(${ph.join(',')})`;
      });
      const sql = `INSERT INTO monitored_devices (${devCols.join(',')}) VALUES ${tuples.join(',')}
        ON CONFLICT (ip_address) DO UPDATE SET
          name=EXCLUDED.name, device_type=EXCLUDED.device_type, site_id=EXCLUDED.site_id,
          site_name=EXCLUDED.site_name, snmp_enabled=EXCLUDED.snmp_enabled,
          snmp_version=EXCLUDED.snmp_version, snmp_community=EXCLUDED.snmp_community,
          device_vendor=EXCLUDED.device_vendor, current_status=EXCLUDED.current_status,
          last_response_ms=EXCLUDED.last_response_ms, last_checked_at=EXCLUDED.last_checked_at,
          last_seen_at=EXCLUDED.last_seen_at, active=EXCLUDED.active,
          is_gateway=EXCLUDED.is_gateway, poll_interval_seconds=EXCLUDED.poll_interval_seconds,
          updated_at=NOW()
        RETURNING id, name`;
      const r = await client.query(sql, params);
      const idByName = {};
      for (const row of r.rows) idByName[row.name] = row.id;
      counts.monitored_devices = r.rows.length;

      // ── device_sensors (upsert on device_id, sensor_key) ───────────────────
      const senCols = ['device_id', 'sensor_key', 'sensor_name', 'category', 'metric_name', 'oid', 'enabled'];
      const senRows = [];
      for (const d of DEVICES) {
        const id = idByName[d.name];
        senRows.push([id, 'cpu', 'CPU Utilization', 'system', 'cpu_pct', null, true]);
        senRows.push([id, 'mem', 'Memory Utilization', 'system', 'mem_pct', null, true]);
        for (const f of ifacesFor(d)) {
          senRows.push([id, `if_${f.idx}_in_bps`, `${f.name} — In`, 'interface', `if_${f.idx}_in_bps`, null, true]);
          senRows.push([id, `if_${f.idx}_out_bps`, `${f.name} — Out`, 'interface', `if_${f.idx}_out_bps`, null, true]);
          senRows.push([id, `if_${f.idx}_oper`, `${f.name} — Status`, 'interface', `if_${f.idx}_oper`, null, true]);
        }
      }
      counts.device_sensors = await bulkInsert(client, 'device_sensors', senCols, senRows,
        `ON CONFLICT (device_id, sensor_key) DO UPDATE SET
          sensor_name=EXCLUDED.sensor_name, category=EXCLUDED.category,
          metric_name=EXCLUDED.metric_name, oid=EXCLUDED.oid, enabled=EXCLUDED.enabled`);

      // ── time-series: ping_results + snmp_results + availability rollups ─────
      const pingCols = ['device_id', 'ts', 'response_ms', 'packet_loss_pct', 'status'];
      const snmpCols = ['device_id', 'ts', 'oid', 'metric_name', 'value', 'if_index', 'if_name'];
      const availCols = ['device_id', 'date', 'uptime_pct', 'avg_response_ms', 'min_response_ms',
        'max_response_ms', 'total_checks', 'failed_checks'];
      let pingTotal = 0;
      let snmpTotal = 0;
      const availRows = [];

      for (const d of DEVICES) {
        const id = idByName[d.name];
        const prof = profileFor(d);
        const ifs = ifacesFor(d);
        const isJB = d.name === 'SW-JB-CORE-01';
        const pingRows = [];
        const snmpRows = [];
        const dayStats = new Map(); // dateStr -> {tot,fail,sum,cnt,min,max}

        for (let t = startMs; t <= nowMs; t += STEP_MS) {
          const ts = new Date(t);
          let state = 'normal';
          if (isJB) {
            if (t >= outageStartMs && t < outageEndMs) state = 'outage';
            else if ((t >= degradedStartMs && t < outageStartMs) || (t >= outageEndMs && t < degradedEndMs)) state = 'degraded';
          }

          // ICMP ping sample
          let resp;
          let loss;
          let status;
          if (state === 'outage') { resp = null; loss = 100; status = 'down'; }
          else if (state === 'degraded') {
            resp = 80 + Math.random() * 140;
            loss = Math.random() < 0.6 ? 3 + Math.random() * 22 : 0;
            status = 'warning';
          } else {
            resp = prof.latBase + Math.random() * prof.latVar;
            if (Math.random() < 0.01) resp += 18 + Math.random() * 30; // occasional spike
            resp = Math.max(0.4, resp);
            loss = Math.random() < 0.005 ? 1 + Math.random() * 7 : 0; // rare blip
            status = resp > 500 ? 'warning' : 'up';
          }
          const respR = round2(resp);
          pingRows.push([id, ts, respR, round2(loss), status]);

          // availability rollup accumulation
          const dk = dateStr(ts);
          let st = dayStats.get(dk);
          if (!st) { st = { tot: 0, fail: 0, sum: 0, cnt: 0, min: null, max: null }; dayStats.set(dk, st); }
          st.tot += 1;
          if (status === 'down') st.fail += 1;
          if (respR != null) {
            st.sum += respR; st.cnt += 1;
            st.min = st.min == null ? respR : Math.min(st.min, respR);
            st.max = st.max == null ? respR : Math.max(st.max, respR);
          }

          // SNMP samples
          const curve = dayCurve(ts);
          if (state !== 'outage') {
            let cpu = prof.cpuBase + prof.cpuAmp * curve + (Math.random() * 8 - 4);
            let mem = prof.memBase + prof.memAmp * (0.4 + 0.6 * curve) + Math.sin(t / 86400000) * 4;
            if (state === 'degraded') { cpu = 80 + Math.random() * 17; mem = mem + 15; }
            cpu = clamp(cpu, 2, 98);
            mem = clamp(mem, 10, 95);
            snmpRows.push([id, ts, null, 'cpu_pct', round2(cpu), null, null]);
            snmpRows.push([id, ts, null, 'mem_pct', round2(mem), null, null]);
          }
          for (const f of ifs) {
            const cap = f.role === 'uplink' ? prof.upCap : prof.downCap;
            let inb;
            let outb;
            let oper;
            if (state === 'outage') { inb = 0; outb = 0; oper = 0; }
            else {
              const dampen = state === 'degraded' ? 0.5 : 1;
              inb = Math.round(cap * (0.12 + 0.88 * curve) * (0.8 + Math.random() * 0.35) * dampen);
              outb = Math.round(cap * 0.7 * (0.12 + 0.88 * curve) * (0.8 + Math.random() * 0.35) * dampen);
              oper = 1;
            }
            snmpRows.push([id, ts, null, `if_${f.idx}_in_bps`, inb, f.idx, f.name]);
            snmpRows.push([id, ts, null, `if_${f.idx}_out_bps`, outb, f.idx, f.name]);
            snmpRows.push([id, ts, null, `if_${f.idx}_oper`, oper, f.idx, f.name]);
          }
        }

        // daily availability rows for this device
        for (const [dk, st] of dayStats) {
          const uptime = st.tot ? round2((100 * (st.tot - st.fail)) / st.tot) : null;
          const avg = st.cnt ? round2(st.sum / st.cnt) : null;
          availRows.push([id, dk, uptime, avg, st.min, st.max, st.tot, st.fail]);
        }

        // flush per device to keep memory bounded
        pingTotal += await bulkInsert(client, 'ping_results', pingCols, pingRows);
        snmpTotal += await bulkInsert(client, 'snmp_results', snmpCols, snmpRows);
        console.log(`  ${d.name}: +${pingRows.length} ping, +${snmpRows.length} snmp`);
      }
      counts.ping_results = pingTotal;
      counts.snmp_results = snmpTotal;
      counts.availability_summary = await bulkInsert(client, 'availability_summary', availCols, availRows,
        `ON CONFLICT (device_id, date) DO UPDATE SET
          uptime_pct=EXCLUDED.uptime_pct, avg_response_ms=EXCLUDED.avg_response_ms,
          min_response_ms=EXCLUDED.min_response_ms, max_response_ms=EXCLUDED.max_response_ms,
          total_checks=EXCLUDED.total_checks, failed_checks=EXCLUDED.failed_checks`);

      // ── alerts ──────────────────────────────────────────────────────────────
      const jb = idByName['SW-JB-CORE-01'];
      const alertCols = ['device_id', 'alert_type', 'severity', 'message', 'metric_value',
        'triggered_at', 'resolved_at', 'status'];
      const oStart = new Date(outageStartMs);
      const oEnd = new Date(outageEndMs);
      const dStart = new Date(degradedStartMs);
      const dEnd = new Date(degradedEndMs);
      const ago = (mins) => new Date(nowMs - mins * 60000);

      const resolvedAlerts = [
        // The SW-JB-CORE-01 outage + degradation (resolved history)
        [jb, 'device_down', 'critical',
          'SW-JB-CORE-01 (10.30.0.2) is not responding to ICMP. 3 consecutive ping failures.',
          100, oStart, oEnd, 'resolved'],
        [jb, 'response_time', 'warning',
          'SW-JB-CORE-01 latency elevated (peaked ~210ms) with intermittent packet loss.',
          210, dStart, dEnd, 'resolved'],
        [jb, 'recovery', 'info',
          'SW-JB-CORE-01 has recovered. Downtime was 1h 30m. Response time is back to normal.',
          null, oEnd, oEnd, 'resolved'],
        // A little history on other devices
        [idByName['FG-PEN-01'], 'response_time', 'warning',
          'FG-PEN-01 WAN latency briefly exceeded threshold (peaked ~640ms).',
          640, ago(6 * 24 * 60 + 30), ago(6 * 24 * 60), 'resolved'],
        [idByName['SW-KLHQ-CORE-01'], 'mem_pct', 'warning',
          'SW-KLHQ-CORE-01 memory usage reached 88% (threshold 85%).',
          88, ago(9 * 24 * 60), ago(9 * 24 * 60 - 45), 'resolved'],
        [idByName['RTR-WAN-01'], 'packet_loss', 'warning',
          'RTR-WAN-01 packet loss reached 12% on the WAN uplink.',
          12, ago(4 * 24 * 60 + 20), ago(4 * 24 * 60), 'resolved'],
      ];
      const activeAlerts = [
        // one currently-active warning so the Alerts view has a live row
        [jb, 'cpu_pct', 'warning',
          'SW-JB-CORE-01 CPU usage is at 88% (threshold 80%). Check for routing loops or high traffic.',
          88, ago(25), null, 'active'],
      ];

      let alertN = await bulkInsert(client, 'alerts', alertCols, resolvedAlerts);
      // active alerts respect the partial-unique (device_id, alert_type) WHERE active index
      alertN += await bulkInsert(client, 'alerts', alertCols, activeAlerts, 'ON CONFLICT DO NOTHING');
      counts.alerts = alertN;

      // ── device_health_scores (upsert on device_id) ──────────────────────────
      const hsCols = ['device_id', 'score', 'uptime_score', 'response_score', 'anomaly_score',
        'alert_score', 'grade', 'trend', 'computed_at'];
      const hsRows = DEVICES.map((d) => {
        const id = idByName[d.name];
        if (d.name === 'SW-JB-CORE-01') return [id, 72, 60, 70, 78, 80, 'C', 'degrading', now];
        if (d.name === 'RTR-WAN-01') return [id, 88, 92, 84, 90, 88, 'B', 'stable', now];
        if (d.name === 'FG-PEN-01') return [id, 91, 95, 86, 94, 92, 'A', 'stable', now];
        const s = round2(95 + Math.random() * 4);
        return [id, s, 98, 96, 97, 99, 'A', 'stable', now];
      });
      counts.device_health_scores = await bulkInsert(client, 'device_health_scores', hsCols, hsRows,
        `ON CONFLICT (device_id) DO UPDATE SET
          score=EXCLUDED.score, uptime_score=EXCLUDED.uptime_score,
          response_score=EXCLUDED.response_score, anomaly_score=EXCLUDED.anomaly_score,
          alert_score=EXCLUDED.alert_score, grade=EXCLUDED.grade, trend=EXCLUDED.trend,
          computed_at=EXCLUDED.computed_at`);
    }

    await client.query('COMMIT');

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n──────────── Seed complete ────────────');
    console.log(`Window: last ${DAYS} days @ ${STEP_MIN}-min interval   RESET=${RESET ? 'yes' : 'no'}`);
    for (const [k, v] of Object.entries(counts)) {
      console.log(`  ${k.padEnd(24)} ${v} rows`);
    }
    console.log('───────────────────────────────────────');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nSEED FAILED — rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

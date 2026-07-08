'use strict';

/**
 * reportsPdf.js — server-side PDF generation engine for SpanVault reports.
 *
 * Renders SpanVault reports to a branded PDF Buffer using pdfkit (vector only —
 * no headless browser). The engine provides a branded document scaffold (cover +
 * repeating header/footer), a wrapped-height data table, KPI tiles, and reuses
 * the trend-chart renderer in ./pdfCharts.
 *
 * Public contract (consumed by api/server.js and collector/reportScheduler.js):
 *   async function generateReportPdf(db, { template, params, meta }): Promise<Buffer>
 *   function hasPdfRenderer(template): boolean
 *   module.exports = { generateReportPdf, hasPdfRenderer }
 *
 * `db`     — the pg Pool/Client used to fetch report data server-side.
 * `params` — the report's query params (range/from/to/site scope/etc).
 * `meta`   — { title, company, generatedBy, generatedAt }.
 */

const PDFDocument = require('pdfkit');
const { renderTrendChart } = require('./pdfCharts');

// ── Brand palette (NocVault suite — navy/red) ─────────────────
const RED = '#C8102E';
const NAVY = '#1a2744';
const MUTED = '#64748b';
const LIGHT = '#f1f5f9';
const BORDER = '#e2e8f0';
const GREEN = '#16a34a';
const YELLOW = '#d97706';

// ── Small formatting helpers ──────────────────────────────────
function fmtDay(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-GB'); } catch (_e) { return String(d); }
}
function pctStr(v) { return v == null ? '—' : `${v}%`; }
function num(n) { return (n == null || n === '') ? '—' : String(n); }
// Faithful copy of the API's uptime helper: % of checks that were "up".
function pct2(failed, total) { return total > 0 ? Math.round((1 - failed / total) * 10000) / 100 : null; }
function gradeFromUptime(u) {
  if (u == null) return null;
  const n = Number(u);
  return n >= 99.9 ? 'A' : n >= 99.5 ? 'B' : n >= 99 ? 'C' : n >= 95 ? 'D' : 'F';
}
// Normalize a Date|string|undefined into a stable display stamp.
function fmtStamp(d) {
  const dt = d instanceof Date ? d : (d != null && d !== '' ? new Date(d) : new Date());
  const t = dt.getTime();
  const use = isFinite(t) ? new Date(t) : new Date();
  return use.toLocaleString('en-GB', { hour12: false });
}

// ── Date-range resolver (mirror of server.js getDateRange) ────
function getDateRange(query) {
  const q = query || {};
  const range = q.range || '30d';
  const dateFrom = q.date_from || q.from;
  const dateTo = q.date_to || q.to;
  if (range === 'custom' && dateFrom && dateTo) {
    return {
      start: new Date(dateFrom).toISOString(),
      end: new Date(dateTo + 'T23:59:59').toISOString(),
      label: `${dateFrom} to ${dateTo}`,
    };
  }
  const days = range === '7d' ? 7 : range === '90d' ? 90 : range === '24h' ? 1 : 30;
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: `Last ${days === 1 ? '24 hours' : days + ' days'}`,
  };
}

// Optional RBAC site scoping. The PDF endpoint threads the caller's allowed site
// ids through `params._siteFilter` (array of ints); the scheduler leaves it unset
// (estate-wide). Push the filter onto `params` and return the SQL clause or null.
function resolveSiteFilter(q) {
  const f = q && q._siteFilter;
  if (Array.isArray(f)) {
    const ids = f.map(Number).filter(Boolean);
    return ids.length ? ids : null;
  }
  return null;
}
function siteClause(siteFilter, params, col) {
  if (!siteFilter || !siteFilter.length) return null;
  params.push(siteFilter);
  return `${col} = ANY($${params.length}::int[])`;
}

// Intelligence tables (incidents / device_health_scores) are created by later
// migrations. Probe once and cache so queries can skip tables that don't exist
// yet rather than throwing.
let _caps = null;
async function getCaps(db) {
  if (_caps) return _caps;
  try {
    const r = await db.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'device_health_scores') AS health,
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'incidents')            AS incidents
    `);
    _caps = r.rows[0] || { health: false, incidents: false };
  } catch (_e) {
    _caps = { health: false, incidents: false };
  }
  return _caps;
}

// ── PDF glyph safety ──────────────────────────────────────────
// pdfkit's built-in Helvetica uses WinAnsi (CP1252), which lacks many Unicode
// glyphs we use (→ ≥ ≤ – — • curly quotes, NBSP). `pdfSafe` maps them to ASCII
// so they never render as mojibake. Applied at the doc.text layer only.
function pdfSafe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[→➜➔➙➡⇒⮕]/g, 'to')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/[↑]/g, '+')
    .replace(/[↓]/g, '-')
    .replace(/[–—―]/g, '-')
    .replace(/•/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/ /g, ' ');
}
// Monkey-patch a PDFDocument so EVERY doc.text(...) is sanitized before it
// reaches the WinAnsi encoder — one place covers cover/tables/charts/footer.
function installPdfSafeText(doc) {
  const origText = doc.text.bind(doc);
  doc.text = (text, ...rest) => origText(pdfSafe(text), ...rest);
  return doc;
}

// ── Cover page ────────────────────────────────────────────────
function drawCover(doc, o, layout) {
  const { title, company, generatedBy, dateRange, summary, generatedAt } = o;
  const { pageW, left, contentW } = layout;

  doc.rect(0, 0, pageW, 150).fill(NAVY);
  doc.rect(0, 150, pageW, 6).fill(RED);
  // Logo placeholder — brand letter "S".
  doc.roundedRect(left, 44, 64, 64, 10).fill(RED);
  doc.fillColor('#fff').fontSize(30).font('Helvetica-Bold').text('S', left, 60, { width: 64, align: 'center' });
  doc.fillColor('#fff').fontSize(22).font('Helvetica-Bold').text('SpanVault', left + 80, 56);
  doc.fillColor('#cbd5e1').fontSize(11).font('Helvetica').text('Network Monitoring', left + 80, 86);

  doc.fillColor(NAVY).fontSize(28).font('Helvetica-Bold').text(title, left, 196, { width: contentW });
  doc.moveTo(left, 238).lineTo(left + 120, 238).lineWidth(3).stroke(RED);

  const meta = [
    ['Company', company],
    ['Generated', generatedAt],
    ['Generated by', generatedBy || 'system'],
    ['Date range', dateRange || 'All time'],
  ];
  let my = 262;
  doc.fontSize(11);
  meta.forEach(([k, v]) => {
    doc.fillColor(MUTED).font('Helvetica-Bold').text(k, left, my, { width: 120, continued: false });
    doc.fillColor('#0f172a').font('Helvetica').text(v, left + 130, my, { width: contentW - 130 });
    my += 22;
  });

  // Summary chips.
  if (summary && summary.length) {
    my += 12;
    doc.fillColor(NAVY).fontSize(13).font('Helvetica-Bold').text('Summary', left, my);
    my += 22;
    let cx = left;
    const chipW = Math.min(170, (contentW - 30) / Math.max(summary.length, 1));
    summary.forEach(s => {
      doc.roundedRect(cx, my, chipW - 10, 52, 8).fillAndStroke(LIGHT, BORDER);
      doc.fillColor(s.color || NAVY).fontSize(18).font('Helvetica-Bold').text(String(s.value), cx + 10, my + 8, { width: chipW - 26 });
      doc.fillColor(MUTED).fontSize(8).font('Helvetica').text(s.label, cx + 10, my + 32, { width: chipW - 26 });
      cx += chipW;
    });
  }
}

// ── KPI tiles ─────────────────────────────────────────────────
// Draws a row of tiles with a colored left border; returns the y below them.
function drawKpiTiles(doc, layout, y, tiles) {
  const { left, contentW } = layout;
  const gap = 12;
  const n = Math.max(tiles.length, 1);
  const tileW = (contentW - gap * (n - 1)) / n;
  const tileH = 62;
  tiles.forEach((t, i) => {
    const tx = left + i * (tileW + gap);
    doc.roundedRect(tx, y, tileW, tileH, 8).fillAndStroke('#ffffff', BORDER);
    doc.rect(tx, y, 4, tileH).fill(t.color || NAVY);
    doc.fillColor('#0f172a').fontSize(22).font('Helvetica-Bold')
      .text(String(t.value), tx + 14, y + 10, { width: tileW - 22, lineBreak: false });
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
      .text(String(t.label).toUpperCase(), tx + 14, y + 40, { width: tileW - 22, lineBreak: false });
  });
  return y + tileH;
}

// ── Data table (zebra, wrapped per-row height) ────────────────
// Measures each text cell's wrapped height so a row is tall enough for its
// tallest cell. With o2.continueOnPage the table flows on the current page,
// otherwise it starts on a fresh page.
function drawTable(doc, tbl, layout, o2 = {}) {
  const { columns, rows } = tbl;
  const { left, contentW, pageH } = layout;
  if (o2.continueOnPage) { doc.y = doc.y + 8; }
  else { doc.addPage(); }
  const rowH = 18;
  const headerH = 22;
  const pad = 5;
  const totalW = columns.reduce((a, c) => a + (c.width || 80), 0);
  const scale = contentW / totalW;
  const colX = [];
  let acc = left;
  columns.forEach(c => { colX.push(acc); acc += (c.width || 80) * scale; });
  const colW = (c) => (c.width || 80) * scale;

  function drawHeader() {
    const y = doc.y;
    doc.rect(left, y, contentW, headerH).fill(NAVY);
    doc.fillColor('#fff').fontSize(8).font('Helvetica-Bold');
    columns.forEach((c, i) => {
      doc.text(c.label, colX[i] + 4, y + 7, { width: colW(c) - 8, align: c.align || 'left', ellipsis: true, lineBreak: false });
    });
    doc.y = y + headerH;
  }

  drawHeader();
  rows.forEach((r, idx) => {
    doc.font('Helvetica').fontSize(8);
    let rh = rowH;
    columns.forEach((c) => {
      const txt = String(r[c.key] == null ? '' : r[c.key]);
      const th = doc.heightOfString(pdfSafe(txt), { width: colW(c) - 8 }) + pad * 2;
      if (th > rh) rh = th;
    });
    if (doc.y + rh > pageH - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
      doc.font('Helvetica').fontSize(8);
    }
    const y = doc.y;
    if (idx % 2 === 1) doc.rect(left, y, contentW, rh).fill(LIGHT);
    columns.forEach((c, i) => {
      const color = typeof c.color === 'function' ? (c.color(r) || '#1e293b') : (c.color || '#1e293b');
      doc.fillColor(color).font('Helvetica').fontSize(8)
        .text(String(r[c.key] == null ? '' : r[c.key]), colX[i] + 4, y + pad, { width: colW(c) - 8, align: c.align || 'left' });
    });
    doc.y = y + rh;
  });

  if (rows.length === 0) {
    doc.fillColor(MUTED).fontSize(11).font('Helvetica-Oblique')
      .text('No data matched the selected filters.', left, doc.y + 14, { width: contentW, align: 'center' });
  }
}

// ── Header / footer / page numbers on every buffered page ─────
function stampHeadersFooters(doc, { title, company, generatedAt }) {
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const contentW = right - left;
  const range = doc.bufferedPageRange();
  // An explicit bounded `height` on every stamp text is what stops pdfkit from
  // auto-paginating a footer drawn near the page bottom into a phantom page.
  const stampH = 12;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (i > range.start) {
      doc.fillColor(MUTED).fontSize(8).font('Helvetica')
        .text(`${title}`, left, 18, { width: contentW / 2, align: 'left', lineBreak: false, height: stampH });
      doc.text(company, left + contentW / 2, 18, { width: contentW / 2, align: 'right', lineBreak: false, height: stampH });
      doc.moveTo(left, 30).lineTo(right, 30).lineWidth(0.5).strokeColor(BORDER).stroke();
    }
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
      .text(`Generated ${generatedAt}`, left, pageH - 26, { width: contentW / 2, align: 'left', lineBreak: false, height: stampH });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + contentW / 2, pageH - 26, { width: contentW / 2, align: 'right', lineBreak: false, height: stampH });
  }
}

// ════════════════════════════════════════════════════════════
// EXECUTIVE SUMMARY — data gather (server-side, faithful to
// GET /api/reports/executive) + renderer
// ════════════════════════════════════════════════════════════
async function gatherExecutive(db, params) {
  const q = params || {};
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const durationMs = Date.parse(win.end) - Date.parse(win.start);
  const prevStart = new Date(Date.parse(win.start) - durationMs).toISOString();
  const siteFilter = resolveSiteFilter(q);

  const pWin = [win.start, win.end];
  const scWin = siteClause(siteFilter, pWin, 'd.site_id');
  const scWinAnd = scWin ? ` AND ${scWin}` : '';

  const pPrev = [win.start, win.end, prevStart];
  const scPrev = siteClause(siteFilter, pPrev, 'd.site_id');
  const scPrevAnd = scPrev ? ` AND ${scPrev}` : '';

  const pPrevWin = [prevStart, win.start];
  const scPrevWin = siteClause(siteFilter, pPrevWin, 'd.site_id');
  const scPrevWinAnd = scPrevWin ? ` AND ${scPrevWin}` : '';

  const pSite = [];
  const scSite = siteClause(siteFilter, pSite, 'd.site_id');
  const scSiteAnd = scSite ? ` AND ${scSite}` : '';

  const caps = await getCaps(db);

  const runQ = async (label, sql, p, fb) => {
    try { return await db.query(sql, p); }
    catch (e) { console.error(`[reportsPdf/executive] query '${label}' failed: ${e.message}`); return { rows: fb }; }
  };

  const ov = await runQ('overview', `
    SELECT COUNT(*)::int AS tc, SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts BETWEEN $1::timestamptz AND $2::timestamptz${scWinAnd}`, pWin, [{ tc: 0, bad: 0 }]);
  const prev = await runQ('prev-overview', `
    SELECT COUNT(*)::int AS tc, SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts >= $1::timestamptz AND p.ts < $2::timestamptz${scPrevWinAnd}`, pPrevWin, [{ tc: 0, bad: 0 }]);
  const dt = await runQ('downtime', `
    SELECT COALESCE(SUM(sub.failed * d.poll_interval_seconds / 60.0), 0) AS dt
    FROM monitored_devices d
    JOIN LATERAL (
      SELECT SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END) AS failed
      FROM ping_results WHERE device_id = d.id AND ts BETWEEN $1::timestamptz AND $2::timestamptz
    ) sub ON TRUE
    WHERE d.active = TRUE${scWinAnd}`, pWin, [{ dt: 0 }]);
  const alertCounts = await runQ('alert-counts', `
    SELECT
      COUNT(*) FILTER (WHERE a.triggered_at BETWEEN $1::timestamptz AND $2::timestamptz)::int AS cur,
      COUNT(*) FILTER (WHERE a.triggered_at >= $3::timestamptz AND a.triggered_at < $1::timestamptz)::int AS prev
    FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.alert_type <> 'recovery' AND a.triggered_at >= $3::timestamptz${scPrevAnd}`, pPrev, [{ cur: 0, prev: 0 }]);
  const siteRows = await runQ('site-rows', `
    WITH site_alerts AS (
      SELECT COALESCE(d.site_name, 'Unassigned') AS site_name, COUNT(*)::int AS incidents
      FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
      WHERE a.alert_type = 'device_down' AND a.triggered_at BETWEEN $1::timestamptz AND $2::timestamptz${scWinAnd}
      GROUP BY 1
    )
    SELECT COALESCE(d.site_name, 'Unassigned') AS site_name,
           COUNT(p.*)::int AS tc, SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad,
           COALESCE(MAX(sa.incidents), 0)::int AS incidents
    FROM monitored_devices d
    LEFT JOIN ping_results p ON p.device_id = d.id AND p.ts BETWEEN $1::timestamptz AND $2::timestamptz
    LEFT JOIN site_alerts sa ON sa.site_name = COALESCE(d.site_name, 'Unassigned')
    WHERE d.active = TRUE${scWinAnd}
    GROUP BY COALESCE(d.site_name, 'Unassigned') ORDER BY 1`, pWin, []);

  // Daily uptime trend for the PDF chart (executive JSON carries no series).
  const trend = await runQ('trend', `
    SELECT to_char(date_trunc('day', p.ts), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS tc,
           SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts BETWEEN $1::timestamptz AND $2::timestamptz${scWinAnd}
    GROUP BY 1 ORDER BY 1`, pWin, []);
  const trendPoints = trend.rows
    .map((r) => ({ t: r.day, v: pct2(r.bad, r.tc) }))
    .filter((p) => p.v != null);

  let totalIncidents = 0, biggest = null, prevIncidents = 0;
  if (caps.incidents) {
    try {
      const ic = await db.query(`SELECT COUNT(*)::int AS c FROM incidents WHERE started_at BETWEEN $1::timestamptz AND $2::timestamptz`, [win.start, win.end]);
      totalIncidents = ic.rows[0] ? ic.rows[0].c : 0;
      const bg = await db.query(`
        SELECT title, duration_seconds, affected_count FROM incidents
        WHERE started_at BETWEEN $1::timestamptz AND $2::timestamptz
        ORDER BY COALESCE(duration_seconds, 0) DESC, affected_count DESC LIMIT 1`, [win.start, win.end]);
      if (bg.rows[0]) biggest = {
        title: bg.rows[0].title,
        duration_minutes: bg.rows[0].duration_seconds != null ? Math.round(bg.rows[0].duration_seconds / 60) : null,
        affected: bg.rows[0].affected_count,
      };
      const pic = await db.query(`SELECT COUNT(*)::int AS c FROM incidents WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz`, [prevStart, win.start]);
      prevIncidents = pic.rows[0] ? pic.rows[0].c : 0;
    } catch (e) { console.error('[reportsPdf/executive] incidents query failed:', e.message); }
  }

  const curUptime = pct2(ov.rows[0].bad, ov.rows[0].tc);
  const prevUptime = pct2(prev.rows[0].bad, prev.rows[0].tc);
  const downtimeMinutes = Math.round(Number(dt.rows[0].dt) * 10) / 10;
  const period = q.range || '30d';
  const periodLabel = { '24h': 'the last 24 hours', '7d': 'this week', '30d': 'this month', '90d': 'this quarter' }[period] || 'this period';

  const sites_summary = siteRows.rows.map((s) => ({
    site: s.site_name, uptime_pct: pct2(s.bad, s.tc),
    health_grade: gradeFromUptime(pct2(s.bad, s.tc)), incidents: s.incidents,
  }));

  const curAlerts = alertCounts.rows[0].cur || 0;
  const prevAlerts = alertCounts.rows[0].prev || 0;
  const alertDelta = curAlerts - prevAlerts;

  // Recommendations — data-driven, priority order (mirrors the endpoint).
  const cpuRow = await runQ('cpu', `
    SELECT d.name AS device_name, ROUND(AVG(s.value)::numeric, 0) AS cpu
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE s.metric_name ILIKE '%cpu%' AND s.ts BETWEEN $1::timestamptz AND $2::timestamptz${scWinAnd}
    GROUP BY d.name HAVING AVG(s.value) >= 75 ORDER BY cpu DESC LIMIT 1`, pWin, []);
  let degradingCount = 0;
  if (caps.health) {
    const dg = await runQ('degrading', `
      SELECT COUNT(*)::int AS c FROM device_health_scores h
      JOIN monitored_devices d ON d.id = h.device_id
      WHERE h.trend = 'degrading' AND d.active = TRUE${scSiteAnd}`, pSite, [{ c: 0 }]);
    degradingCount = dg.rows[0] ? dg.rows[0].c : 0;
  }

  const recommendations = [];
  if (cpuRow.rows[0]) {
    recommendations.push(`Consider upgrading ${cpuRow.rows[0].device_name} - its CPU is averaging ${cpuRow.rows[0].cpu}%, approaching capacity.`);
  }
  const worstSite = [...sites_summary].filter((s) => s.uptime_pct != null).sort((a, b) => a.uptime_pct - b.uptime_pct)[0];
  if (worstSite && worstSite.uptime_pct < 99.5) {
    recommendations.push(`${worstSite.site} availability (${worstSite.uptime_pct}%) is below SLA - investigate recurring outages.`);
  }
  if (degradingCount > 0) {
    recommendations.push(`${degradingCount} device${degradingCount > 1 ? 's are' : ' is'} showing degrading health trends - proactive maintenance recommended.`);
  }
  if (alertDelta > 0) {
    recommendations.push(`Alert volume rose by ${alertDelta} versus the previous period - review recurring offenders for remediation.`);
  }
  if (biggest && biggest.duration_minutes && biggest.duration_minutes > 30) {
    recommendations.push(`The longest incident ("${biggest.title}") lasted ${biggest.duration_minutes} minutes - consider redundancy for the affected path.`);
  }
  if (!recommendations.length) {
    recommendations.push('Network is healthy - no critical actions required this period. Maintain current monitoring coverage.');
  }

  const uptimeDelta = curUptime != null && prevUptime != null ? Math.round((curUptime - prevUptime) * 100) / 100 : null;

  return {
    title: 'Executive Summary',
    dateRange: win.label,
    rangeLabel: `Availability - ${win.label}`,
    headline: `Network was ${curUptime != null ? curUptime : '—'}% available ${periodLabel}`,
    kpis: {
      uptime: curUptime, uptimeDelta,
      incidents: totalIncidents,
      downtime: downtimeMinutes,
    },
    vsPrev: {
      uptime: { current: curUptime, previous: prevUptime, delta: uptimeDelta },
      alerts: { current: curAlerts, previous: prevAlerts, delta: alertDelta },
      incidents: { current: totalIncidents, previous: prevIncidents, delta: totalIncidents - prevIncidents },
    },
    sites_summary,
    biggest_incident: biggest,
    recommendations: recommendations.slice(0, 3),
    trendPoints,
    summary: [
      { label: 'Overall Uptime', value: pctStr(curUptime), color: GREEN },
      { label: 'Total Incidents', value: String(totalIncidents), color: RED },
      { label: 'Downtime (min)', value: String(downtimeMinutes), color: YELLOW },
    ],
  };
}

// Format a signed change value with an ASCII arrow (pdfSafe leaves it intact).
function fmtChange(delta, unit) {
  if (delta == null) return '—';
  if (delta === 0) return `= 0${unit}`;
  const arrow = delta > 0 ? '+' : '-';
  return `${arrow} ${Math.abs(delta)}${unit}`;
}

function renderExecutive(doc, data, layout) {
  const { left, contentW, pageH } = layout;
  doc.addPage();
  let y = doc.page.margins.top;

  // Title + headline.
  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(data.headline || '', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;

  // KPI tiles.
  const k = data.kpis || {};
  y = drawKpiTiles(doc, layout, y, [
    { value: pctStr(k.uptime), label: 'Overall Uptime', color: GREEN },
    { value: k.incidents != null ? String(k.incidents) : '—', label: 'Total Incidents', color: RED },
    { value: `${k.downtime != null ? k.downtime : 0} min`, label: 'Downtime', color: YELLOW },
  ]);
  y += 22;

  // Availability trend chart.
  doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text('Availability Trend', left, y, { width: contentW });
  y = doc.y + 6;
  const chartH = 150;
  renderTrendChart(doc, {
    x: left, y, width: contentW, height: chartH,
    points: data.trendPoints || [], rangeLabel: data.rangeLabel,
    yMax: 100, ySuffix: '%', color: RED,
  });
  doc.y = y + chartH + 18;

  // Network Performance vs Previous Period.
  doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text('Network Performance vs Previous Period', left, doc.y, { width: contentW });
  const vp = data.vsPrev || {};
  const vsRows = [
    { metric: 'Uptime', current: pctStr(vp.uptime ? vp.uptime.current : null), previous: pctStr(vp.uptime ? vp.uptime.previous : null), change: fmtChange(vp.uptime ? vp.uptime.delta : null, '%'), _good: (vp.uptime && vp.uptime.delta != null) ? vp.uptime.delta >= 0 : null },
    { metric: 'Alerts', current: num(vp.alerts ? vp.alerts.current : null), previous: num(vp.alerts ? vp.alerts.previous : null), change: fmtChange(vp.alerts ? vp.alerts.delta : null, ''), _good: (vp.alerts && vp.alerts.delta != null) ? vp.alerts.delta <= 0 : null },
    { metric: 'Incidents', current: num(vp.incidents ? vp.incidents.current : null), previous: num(vp.incidents ? vp.incidents.previous : null), change: fmtChange(vp.incidents ? vp.incidents.delta : null, ''), _good: (vp.incidents && vp.incidents.delta != null) ? vp.incidents.delta <= 0 : null },
  ];
  const changeColor = (r) => r._good == null ? MUTED : (r._good ? GREEN : RED);
  drawTable(doc, {
    columns: [
      { key: 'metric', label: 'Metric', width: 140 },
      { key: 'current', label: 'Current', width: 110, align: 'right' },
      { key: 'previous', label: 'Previous', width: 110, align: 'right' },
      { key: 'change', label: 'Change', width: 120, align: 'right', color: changeColor },
    ],
    rows: vsRows,
  }, layout, { continueOnPage: true });
  doc.y += 18;

  // Sites Summary.
  doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text('Sites Summary', left, doc.y, { width: contentW });
  const siteRows = (data.sites_summary || []).map((s) => ({
    site: s.site, grade: s.health_grade || '—',
    uptime: pctStr(s.uptime_pct), incidents: s.incidents,
    _u: s.uptime_pct,
  }));
  drawTable(doc, {
    columns: [
      { key: 'site', label: 'Site', width: 200 },
      { key: 'grade', label: 'Grade', width: 70, align: 'center' },
      { key: 'uptime', label: 'Uptime %', width: 110, align: 'right', color: (r) => r._u == null ? MUTED : (r._u >= 99.5 ? GREEN : r._u >= 95 ? YELLOW : RED) },
      { key: 'incidents', label: 'Incidents', width: 90, align: 'right' },
    ],
    rows: siteRows,
  }, layout, { continueOnPage: true });
  doc.y += 18;

  // Biggest incident highlight.
  const bi = data.biggest_incident;
  if (bi) {
    const boxH = 62;
    if (doc.y + boxH > pageH - doc.page.margins.bottom) doc.addPage();
    const by = doc.y;
    doc.roundedRect(left, by, contentW, boxH, 8).fillAndStroke('#fdecee', '#f3b4bd');
    doc.rect(left, by, 4, boxH).fill(RED);
    doc.fillColor(RED).fontSize(9).font('Helvetica-Bold').text('BIGGEST INCIDENT', left + 14, by + 8, { width: contentW - 24, lineBreak: false });
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(String(bi.title || '—'), left + 14, by + 22, { width: contentW - 24 });
    const dur = bi.duration_minutes == null ? '—' : `${bi.duration_minutes} min`;
    doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(`Lasted ${dur}  ·  ${bi.affected != null ? bi.affected : 0} device(s) affected`, left + 14, by + 40, { width: contentW - 24, lineBreak: false });
    doc.y = by + boxH + 18;
  }

  // Recommendations.
  const recs = data.recommendations || [];
  doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text('Recommendations', left, doc.y, { width: contentW });
  doc.y += 4;
  if (recs.length) {
    recs.forEach((r) => {
      const ry = doc.y + 4;
      const rh = doc.heightOfString(pdfSafe(String(r)), { width: contentW - 16 });
      if (ry + rh > pageH - doc.page.margins.bottom) doc.addPage();
      const y2 = doc.y + 4;
      doc.fillColor(RED).fontSize(9).font('Helvetica-Bold').text('-', left, y2, { width: 12, lineBreak: false });
      doc.fillColor('#334155').fontSize(10).font('Helvetica').text(String(r), left + 12, y2, { width: contentW - 16 });
      doc.y = doc.y + 2;
    });
  } else {
    doc.fillColor(MUTED).fontSize(10).font('Helvetica-Oblique').text('No recommendations - network is performing well.', left, doc.y + 4, { width: contentW });
  }
}

// ── Renderer registry ─────────────────────────────────────────
// Canonical template keys → { title, gather, render }. `hasPdfRenderer` and
// `generateReportPdf` both resolve through normalizeTemplate() so an alias like
// 'executive-summary' maps to the same 'executive' renderer.
const RENDERERS = {
  'executive': { title: 'Executive Summary', gather: gatherExecutive, render: renderExecutive },
};
const ALIASES = { 'executive-summary': 'executive' };

function normalizeTemplate(template) {
  const t = String(template || '').trim();
  return ALIASES[t] || t;
}

function hasPdfRenderer(template) {
  return Object.prototype.hasOwnProperty.call(RENDERERS, normalizeTemplate(template));
}

// ── Public: generate a report PDF as a Buffer ─────────────────
async function generateReportPdf(db, { template, params, meta } = {}) {
  const key = normalizeTemplate(template);
  const def = RENDERERS[key];
  if (!def) throw new Error(`No PDF renderer for template: ${template}`);

  const m = meta || {};
  const data = await def.gather(db, params || {});

  const doc = installPdfSafeText(new PDFDocument({ size: 'A4', layout: 'portrait', margin: 36, bufferPages: true }));
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const contentW = right - left;
  const layout = { pageW, pageH, left, right, contentW };

  const generatedAt = fmtStamp(m.generatedAt);
  const title = m.title || def.title;
  const company = m.company || 'SpanVault';

  drawCover(doc, {
    title,
    company,
    generatedBy: m.generatedBy,
    dateRange: data.dateRange,
    summary: data.summary,
    generatedAt,
  }, layout);

  def.render(doc, data, layout);

  stampHeadersFooters(doc, { title, company, generatedAt });

  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = { generateReportPdf, hasPdfRenderer };

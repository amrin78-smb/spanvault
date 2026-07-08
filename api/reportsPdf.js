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

// ════════════════════════════════════════════════════════════
// Shared local helpers for the additional report renderers.
// (Faithful copies of the equivalents in api/server.js so the PDF path fetches
// the SAME data shape server-side, using the `db` handle it is given.)
// ════════════════════════════════════════════════════════════
function round1(v) { return v == null ? null : Math.round(Number(v) * 10) / 10; }
function gradeFromScore(s) {
  if (s == null) return null;
  const n = Number(s);
  return n >= 90 ? 'A' : n >= 80 ? 'B' : n >= 70 ? 'C' : n >= 60 ? 'D' : 'F';
}

// Per-device aggregation shared by several report templates (mirror of
// server.js perDeviceAggSql). $1/$2 are the window; any site clause is appended
// by the caller. `caps.health` decides whether device_health_scores is joined.
function perDeviceAggSql(extraWhere, caps) {
  const hasHealth = caps && caps.health;
  const healthSel = hasHealth
    ? 'h.score AS health_score, h.grade AS health_grade'
    : 'NULL::numeric AS health_score, NULL::text AS health_grade';
  const healthJoin = hasHealth ? 'LEFT JOIN device_health_scores h ON h.device_id = d.id' : '';
  return `
    SELECT d.id, d.name AS device_name, d.ip_address, d.device_type,
           COALESCE(d.site_name, 'Unassigned') AS site_name, d.site_id,
           d.current_status, d.poll_interval_seconds,
           COALESCE(pa.total_checks, 0)::int  AS total_checks,
           COALESCE(pa.failed_checks, 0)::int AS failed_checks,
           CASE WHEN pa.total_checks > 0
                THEN ROUND((1 - pa.failed_checks::numeric / pa.total_checks) * 100, 2)
                ELSE NULL END AS uptime_pct,
           ROUND(pa.avg_ms::numeric, 1) AS avg_response_ms,
           COALESCE(al.cnt, 0)::int AS alerts_count,
           ${healthSel}
    FROM monitored_devices d
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS total_checks,
             SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks,
             AVG(response_ms) FILTER (WHERE status = 'up') AS avg_ms
      FROM ping_results WHERE device_id = d.id AND ts BETWEEN $1 AND $2
    ) pa ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM alerts
       WHERE device_id = d.id AND alert_type <> 'recovery' AND triggered_at BETWEEN $1 AND $2
    ) al ON TRUE
    ${healthJoin}
    WHERE d.active = TRUE${extraWhere || ''}`;
}
function downtimeMin(d) {
  return Math.round((d.failed_checks * (d.poll_interval_seconds || 300) / 60) * 10) / 10;
}

// Per-gatherer query wrapper: never throws — logs and degrades to the supplied
// fallback rows so an empty/un-migrated DB still yields a valid PDF.
function mkRunQ(db, tag) {
  return async (label, sql, p, fb) => {
    try { return await db.query(sql, p); }
    catch (e) { console.error(`[reportsPdf/${tag}] query '${label}' failed: ${e.message}`); return { rows: fb }; }
  };
}

// Daily availability (% up) trend for the chart. Optional site_id + RBAC filter.
async function uptimeTrendPoints(runQ, win, siteFilter, siteId) {
  const tp = [win.start, win.end];
  let extra = '';
  if (siteId != null && !isNaN(siteId)) { tp.push(siteId); extra += ` AND d.site_id = $${tp.length}`; }
  const sc = siteClause(siteFilter, tp, 'd.site_id');
  if (sc) extra += ` AND ${sc}`;
  const trend = await runQ('trend', `
    SELECT to_char(date_trunc('day', p.ts), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS tc,
           SUM(CASE WHEN p.status <> 'up' THEN 1 ELSE 0 END)::int AS bad
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.ts BETWEEN $1::timestamptz AND $2::timestamptz${extra}
    GROUP BY 1 ORDER BY 1`, tp, []);
  return trend.rows.map((r) => ({ t: r.day, v: pct2(r.bad, r.tc) })).filter((x) => x.v != null);
}

// Section title (adds a page when there's no room for it + a first row).
function sectionTitle(doc, layout, text) {
  const { left, contentW, pageH } = layout;
  if (doc.y + 46 > pageH - doc.page.margins.bottom) doc.addPage();
  doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text(text, left, doc.y, { width: contentW });
}

// Titled trend chart block; advances doc.y past it.
function renderChartBlock(doc, layout, title, points, opts) {
  const { left, contentW, pageH } = layout;
  const chartH = 150;
  if (doc.y + chartH + 60 > pageH - doc.page.margins.bottom) doc.addPage();
  doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text(title, left, doc.y, { width: contentW });
  const y = doc.y + 6;
  renderTrendChart(doc, Object.assign({ x: left, y, width: contentW, height: chartH, points: points || [] }, opts || {}));
  doc.y = y + chartH + 18;
}

// Red-bulleted list (key findings / risk lines / analysis fallback).
function bulletList(doc, layout, items, emptyText) {
  const { left, contentW, pageH } = layout;
  if (!items || !items.length) {
    doc.fillColor(MUTED).fontSize(10).font('Helvetica-Oblique').text(emptyText || 'None.', left, doc.y + 4, { width: contentW });
    doc.y += 4;
    return;
  }
  doc.y += 4;
  items.forEach((r) => {
    const rh = doc.heightOfString(pdfSafe(String(r)), { width: contentW - 16 });
    if (doc.y + rh + 8 > pageH - doc.page.margins.bottom) doc.addPage();
    const y2 = doc.y + 4;
    doc.fillColor(RED).fontSize(9).font('Helvetica-Bold').text('-', left, y2, { width: 12, lineBreak: false });
    doc.fillColor('#334155').fontSize(10).font('Helvetica').text(String(r), left + 12, y2, { width: contentW - 16 });
    doc.y += 2;
  });
}

const uptimeCol = (r) => r._u == null ? MUTED : (r._u >= 99 ? GREEN : r._u >= 95 ? YELLOW : RED);

// ════════════════════════════════════════════════════════════
// NETWORK SUMMARY — mirror of GET /api/reports/network-summary
// ════════════════════════════════════════════════════════════
async function gatherNetworkSummary(db, params) {
  const q = params || {};
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const siteFilter = resolveSiteFilter(q);
  const caps = await getCaps(db);
  const runQ = mkRunQ(db, 'network-summary');

  const pAgg = [win.start, win.end];
  const scAgg = siteClause(siteFilter, pAgg, 'd.site_id');
  const dr = await runQ('agg', perDeviceAggSql(scAgg ? ` AND ${scAgg}` : '', caps), pAgg, []);

  const pMttr = [win.start, win.end];
  const scMttr = siteClause(siteFilter, pMttr, 'd.site_id');
  const mr = await runQ('mttr', `
    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)::numeric, 1) AS mttr
    FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.resolved_at IS NOT NULL AND a.triggered_at BETWEEN $1 AND $2${scMttr ? ` AND ${scMttr}` : ''}`,
    pMttr, [{ mttr: null }]);

  const devices = dr.rows;
  const siteMap = new Map();
  let tChecks = 0, tFailed = 0, tAlerts = 0, respSum = 0, respN = 0, upN = 0, downN = 0;
  for (const d of devices) {
    const s = siteMap.get(d.site_name) || { site_name: d.site_name, devices: 0, up: 0, down: 0, warning: 0, checks: 0, failed: 0, alerts: 0, respSum: 0, respN: 0 };
    s.devices++;
    const st = (d.current_status || 'unknown').toLowerCase();
    if (st === 'up') { s.up++; upN++; } else if (st === 'down') { s.down++; downN++; } else if (st === 'warning') s.warning++;
    s.checks += d.total_checks; s.failed += d.failed_checks; s.alerts += d.alerts_count;
    if (d.avg_response_ms != null) { s.respSum += Number(d.avg_response_ms); s.respN++; respSum += Number(d.avg_response_ms); respN++; }
    siteMap.set(d.site_name, s);
    tChecks += d.total_checks; tFailed += d.failed_checks; tAlerts += d.alerts_count;
  }
  const sites = Array.from(siteMap.values()).map((s) => ({
    site_name: s.site_name, devices: s.devices, up: s.up, down: s.down, warning: s.warning,
    uptime_pct: pct2(s.failed, s.checks),
    avg_response_ms: s.respN ? round1(s.respSum / s.respN) : null,
    alerts_count: s.alerts,
    grade: gradeFromUptime(pct2(s.failed, s.checks)),
  })).sort((a, b) => a.site_name.localeCompare(b.site_name));

  const withDt = devices.map((d) => ({ ...d, downtime_minutes: downtimeMin(d) }));
  const top_issues = withDt.filter((d) => d.failed_checks > 0)
    .sort((a, b) => b.downtime_minutes - a.downtime_minutes).slice(0, 5)
    .map((d) => ({ device_name: d.device_name, site_name: d.site_name, uptime_pct: d.uptime_pct, downtime_minutes: d.downtime_minutes }));
  const top_alerts = withDt.filter((d) => d.alerts_count > 0)
    .sort((a, b) => b.alerts_count - a.alerts_count).slice(0, 5)
    .map((d) => ({ device_name: d.device_name, alerts_count: d.alerts_count }));

  const uptimePct = pct2(tFailed, tChecks);
  const trendPoints = await uptimeTrendPoints(runQ, win, siteFilter, null);

  // Key findings (faithful to the endpoint) — compares current vs previous window.
  const periodLabel = ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days' })[q.range] || 'this period';
  const durationMs = Date.parse(win.end) - Date.parse(win.start);
  const prevStart = new Date(Date.parse(win.start) - durationMs).toISOString();
  const prevParams = [prevStart, win.start];
  const prevSc = siteClause(siteFilter, prevParams, 'd.site_id');
  const prevResp = await runQ('prevResp', `
    SELECT p.device_id, AVG(p.response_ms) AS avg_ms
    FROM ping_results p JOIN monitored_devices d ON d.id = p.device_id
    WHERE p.status = 'up' AND p.ts >= $1::timestamptz AND p.ts < $2::timestamptz${prevSc ? ` AND ${prevSc}` : ''}
    GROUP BY p.device_id`, prevParams, []);
  const cpuParams = [win.start, win.end];
  const cpuSc = siteClause(siteFilter, cpuParams, 'd.site_id');
  const cpuRisk = await runQ('cpuRisk', `
    SELECT d.name AS device_name, ROUND(AVG(s.value)::numeric, 0) AS cpu
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE s.metric_name ILIKE '%cpu%' AND s.ts BETWEEN $1 AND $2${cpuSc ? ` AND ${cpuSc}` : ''}
    GROUP BY d.name HAVING AVG(s.value) >= 75 ORDER BY cpu DESC LIMIT 1`, cpuParams, []);

  const key_findings = [];
  const bestSite = [...sites].filter((s) => s.uptime_pct != null).sort((a, b) => b.uptime_pct - a.uptime_pct)[0];
  if (bestSite) key_findings.push(`${bestSite.site_name} was the most available site at ${bestSite.uptime_pct}% over ${periodLabel}.`);
  const prevMap = new Map(prevResp.rows.map((r) => [r.device_id, r.avg_ms != null ? Number(r.avg_ms) : null]));
  let improved = null;
  for (const d of devices) {
    const cur = d.avg_response_ms != null ? Number(d.avg_response_ms) : null;
    const prev = prevMap.get(d.id);
    if (cur != null && prev != null && prev > 0) {
      const ch = ((prev - cur) / prev) * 100;
      if (ch > 20 && (!improved || ch > improved.ch)) improved = { name: d.device_name, ch: Math.round(ch) };
    }
  }
  if (improved) key_findings.push(`${improved.name} response time improved ${improved.ch}% versus the previous period.`);
  if (top_alerts[0] && top_alerts[0].alerts_count > 0) key_findings.push(`${top_alerts[0].device_name} triggered ${top_alerts[0].alerts_count} alerts - the most in the network.`);
  if (cpuRisk.rows[0]) key_findings.push(`${cpuRisk.rows[0].device_name} CPU is averaging ${cpuRisk.rows[0].cpu}% - approaching its threshold.`);

  const gradeCounts = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const s of sites) if (s.grade && gradeCounts[s.grade] != null) gradeCounts[s.grade]++;

  return {
    title: 'Network Summary',
    dateRange: win.label,
    rangeLabel: `Availability - ${win.label}`,
    headline: `Network was ${uptimePct != null ? uptimePct : '—'}% available over ${periodLabel}`,
    kpis: {
      devices: devices.length, uptime_pct: uptimePct, total_alerts: tAlerts,
      avg_response_ms: respN ? round1(respSum / respN) : null,
      mttr_minutes: mr.rows[0] ? mr.rows[0].mttr : null,
    },
    sites, top_issues, key_findings, gradeCounts, trendPoints,
    summary: [
      { label: 'Total Devices', value: String(devices.length), color: NAVY },
      { label: 'Overall Uptime', value: pctStr(uptimePct), color: GREEN },
      { label: 'Total Alerts', value: String(tAlerts), color: RED },
    ],
  };
}

function renderNetworkSummary(doc, data, layout) {
  const { left, contentW } = layout;
  doc.addPage();
  let y = doc.page.margins.top;

  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(data.headline || '', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;

  const k = data.kpis || {};
  y = drawKpiTiles(doc, layout, y, [
    { value: String(k.devices != null ? k.devices : 0), label: 'Total Devices', color: NAVY },
    { value: pctStr(k.uptime_pct), label: 'Overall Uptime', color: GREEN },
    { value: String(k.total_alerts != null ? k.total_alerts : 0), label: 'Total Alerts', color: YELLOW },
    { value: `${k.avg_response_ms != null ? k.avg_response_ms : '—'} ms`, label: 'Avg Response', color: NAVY },
    { value: `${k.mttr_minutes != null ? k.mttr_minutes : '—'} min`, label: 'Avg MTTR', color: RED },
  ]);
  y += 22;
  doc.y = y;

  renderChartBlock(doc, layout, 'Availability Trend', data.trendPoints, { yMax: 100, ySuffix: '%', color: RED, rangeLabel: data.rangeLabel });

  sectionTitle(doc, layout, 'Sites');
  drawTable(doc, {
    columns: [
      { key: 'site_name', label: 'Site', width: 150 },
      { key: 'devices', label: 'Devices', width: 60, align: 'right' },
      { key: 'up', label: 'Up', width: 45, align: 'right' },
      { key: 'down', label: 'Down', width: 50, align: 'right' },
      { key: 'uptime', label: 'Uptime %', width: 75, align: 'right', color: uptimeCol },
      { key: 'avg_ms', label: 'Avg ms', width: 60, align: 'right' },
      { key: 'alerts_count', label: 'Alerts', width: 55, align: 'right' },
      { key: 'grade', label: 'Grade', width: 50, align: 'center' },
    ],
    rows: (data.sites || []).map((s) => ({
      site_name: s.site_name, devices: s.devices, up: s.up, down: s.down,
      uptime: s.uptime_pct == null ? '—' : `${s.uptime_pct}%`, _u: s.uptime_pct,
      avg_ms: s.avg_response_ms == null ? '—' : String(s.avg_response_ms),
      alerts_count: s.alerts_count, grade: s.grade || '—',
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'Key Findings');
  bulletList(doc, layout, data.key_findings, 'No notable findings this period.');
  doc.y += 14;

  sectionTitle(doc, layout, 'Top Issues');
  drawTable(doc, {
    columns: [
      { key: 'device_name', label: 'Device', width: 180 },
      { key: 'site_name', label: 'Site', width: 150 },
      { key: 'uptime', label: 'Uptime %', width: 90, align: 'right', color: uptimeCol },
      { key: 'downtime', label: 'Downtime (min)', width: 100, align: 'right' },
    ],
    rows: (data.top_issues || []).map((d) => ({
      device_name: d.device_name, site_name: d.site_name,
      uptime: d.uptime_pct == null ? '—' : `${d.uptime_pct}%`, _u: d.uptime_pct,
      downtime: String(d.downtime_minutes),
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'Health Grade Distribution');
  const gc = data.gradeCounts || {};
  drawTable(doc, {
    columns: [
      { key: 'grade', label: 'Grade', width: 120, align: 'center' },
      { key: 'count', label: 'Sites', width: 120, align: 'right' },
    ],
    rows: ['A', 'B', 'C', 'D', 'F'].map((g) => ({ grade: g, count: String(gc[g] || 0) })),
  }, layout, { continueOnPage: true });
}

// ════════════════════════════════════════════════════════════
// SITE REPORT — mirror of GET /api/reports/site-summary
// ════════════════════════════════════════════════════════════
async function gatherSite(db, params) {
  const q = params || {};
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const siteFilter = resolveSiteFilter(q);
  const siteId = parseInt(q.site_id, 10);
  const t = parseFloat(q.sla_target);
  const slaTarget = isNaN(t) ? 99.5 : t;
  const caps = await getCaps(db);
  const runQ = mkRunQ(db, 'site');

  let devices = [], rows = [], site_name = q.site_name || (isNaN(siteId) ? 'Site' : `Site ${siteId}`);
  if (!isNaN(siteId)) {
    const p = [win.start, win.end, siteId];
    const sc = siteClause(siteFilter, p, 'd.site_id');
    const r = await runQ('agg', perDeviceAggSql(` AND d.site_id = $3${sc ? ` AND ${sc}` : ''}`, caps) + ` ORDER BY uptime_pct ASC NULLS LAST, d.name`, p, []);
    rows = r.rows;
    devices = rows.map((d) => ({
      name: d.device_name, ip: d.ip_address, device_type: d.device_type,
      uptime_pct: d.uptime_pct, avg_response_ms: d.avg_response_ms, alerts_count: d.alerts_count,
      sla_met: d.uptime_pct != null && Number(d.uptime_pct) >= slaTarget,
      health_grade: d.health_grade, downtime_minutes: downtimeMin(d),
    }));
    if (rows[0] && rows[0].site_name) site_name = rows[0].site_name;
  }

  const withData = rows.filter((d) => d.total_checks > 0);
  const checks = withData.reduce((a, d) => a + d.total_checks, 0);
  const failed = withData.reduce((a, d) => a + d.failed_checks, 0);
  const up = rows.filter((d) => (d.current_status || '').toLowerCase() === 'up').length;
  const down = rows.filter((d) => (d.current_status || '').toLowerCase() === 'down').length;
  const avgUptime = pct2(failed, checks);
  const total_alerts = devices.reduce((a, d) => a + d.alerts_count, 0);

  // Site analysis paragraph (faithful to the endpoint).
  const periodLabel = ({ '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days' })[q.range] || 'this period';
  const netAvg = await runQ('netAvg', `SELECT ROUND(AVG(response_ms)::numeric, 1) AS avg FROM ping_results WHERE status = 'up' AND ts BETWEEN $1 AND $2`, [win.start, win.end], []);
  const best = devices.filter((d) => d.uptime_pct != null).sort((a, b) => Number(b.uptime_pct) - Number(a.uptime_pct))[0];
  const mostAlerts = [...devices].sort((a, b) => b.alerts_count - a.alerts_count)[0];
  const respVals = devices.map((d) => d.avg_response_ms).filter((v) => v != null).map(Number);
  const siteAvg = respVals.length ? Math.round((respVals.reduce((a, b) => a + b, 0) / respVals.length) * 10) / 10 : null;
  const netAvgMs = netAvg.rows[0] && netAvg.rows[0].avg != null ? Number(netAvg.rows[0].avg) : null;
  let analysis = `${site_name} maintained ${avgUptime != null ? avgUptime : '—'}% availability over ${periodLabel}.`;
  if (best) analysis += ` ${best.name} was the most reliable device (${best.uptime_pct != null ? best.uptime_pct : '—'}% uptime).`;
  if (mostAlerts && mostAlerts.alerts_count > 0) analysis += ` ${mostAlerts.name} had the most issues with ${mostAlerts.alerts_count} alert${mostAlerts.alerts_count > 1 ? 's' : ''}.`;
  if (siteAvg != null) {
    const cmp = netAvgMs == null ? null : siteAvg < netAvgMs ? 'better than' : siteAvg > netAvgMs ? 'worse than' : 'in line with';
    analysis += ` Average response time was ${siteAvg}ms${cmp ? `, ${cmp} the network average of ${netAvgMs}ms` : ''}.`;
  }

  const trendPoints = isNaN(siteId) ? [] : await uptimeTrendPoints(runQ, win, siteFilter, siteId);

  return {
    title: site_name,
    dateRange: win.label,
    rangeLabel: `Availability - ${win.label}`,
    slaTarget,
    kpis: { total: devices.length, up, down, avg_uptime: avgUptime, total_alerts },
    analysis, devices, trendPoints,
    summary: [
      { label: 'Devices', value: String(devices.length), color: NAVY },
      { label: 'Overall Uptime', value: avgUptime == null ? '—' : `${avgUptime}%`, color: GREEN },
      { label: 'Total Alerts', value: String(total_alerts), color: RED },
    ],
  };
}

function renderSite(doc, data, layout) {
  const { left, contentW } = layout;
  doc.addPage();
  let y = doc.page.margins.top;

  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  const k = data.kpis || {};
  doc.fillColor(MUTED).fontSize(11).font('Helvetica')
    .text(`${k.total || 0} devices  ·  ${k.avg_uptime == null ? '—' : k.avg_uptime + '%'} overall uptime  ·  ${k.total_alerts || 0} alerts`, left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;

  y = drawKpiTiles(doc, layout, y, [
    { value: String(k.total || 0), label: 'Devices', color: NAVY },
    { value: String(k.up || 0), label: 'Up', color: GREEN },
    { value: String(k.down || 0), label: 'Down', color: RED },
    { value: k.avg_uptime == null ? '—' : `${k.avg_uptime}%`, label: 'Overall Uptime', color: YELLOW },
  ]);
  y += 22;
  doc.y = y;

  renderChartBlock(doc, layout, 'Availability Trend', data.trendPoints, { yMax: 100, ySuffix: '%', color: RED, rangeLabel: data.rangeLabel });

  if (data.analysis && data.analysis.trim() !== '') {
    sectionTitle(doc, layout, 'Site Analysis');
    doc.fillColor('#334155').fontSize(10).font('Helvetica').text(data.analysis, left, doc.y + 6, { width: contentW, align: 'left' });
    doc.y += 14;
  }

  sectionTitle(doc, layout, 'Devices');
  drawTable(doc, {
    columns: [
      { key: 'name', label: 'Device', width: 130 },
      { key: 'device_type', label: 'Type', width: 80 },
      { key: 'ip', label: 'IP', width: 90 },
      { key: 'uptime', label: 'Uptime %', width: 70, align: 'right', color: uptimeCol },
      { key: 'avg_ms', label: 'Avg ms', width: 55, align: 'right' },
      { key: 'alerts_count', label: 'Alerts', width: 50, align: 'right' },
      { key: 'sla', label: 'SLA', width: 60, align: 'center', color: (r) => r._met ? GREEN : RED },
      { key: 'grade', label: 'Grade', width: 50, align: 'center' },
    ],
    rows: (data.devices || []).map((d) => ({
      name: d.name || '—', device_type: d.device_type || '—', ip: d.ip || '—',
      uptime: d.uptime_pct == null ? '—' : `${d.uptime_pct}%`, _u: d.uptime_pct,
      avg_ms: d.avg_response_ms == null ? '—' : String(d.avg_response_ms),
      alerts_count: d.alerts_count == null ? 0 : d.alerts_count,
      sla: d.sla_met ? 'MET' : 'FAILED', _met: d.sla_met, grade: d.health_grade || '—',
    })),
  }, layout, { continueOnPage: true });
}

// ════════════════════════════════════════════════════════════
// SLA COMPLIANCE — mirror of GET /api/reports/sla-compliance
// ════════════════════════════════════════════════════════════
async function slaComplianceRows(runQ, q, siteFilter) {
  const win = getDateRange(q);
  const params = [win.start, win.end];
  const filters = ['d.active = TRUE'];
  if (q.site_id)   { params.push(parseInt(q.site_id, 10));   filters.push(`d.site_id = $${params.length}`); }
  if (q.device_id) { params.push(parseInt(q.device_id, 10)); filters.push(`d.id = $${params.length}`); }
  const sc = siteClause(siteFilter, params, 'd.site_id');
  if (sc) filters.push(sc);
  const t = parseFloat(q.sla_target);
  const slaTarget = isNaN(t) ? 99.5 : t;
  const r = await runQ('sla', `
    WITH pings AS (
      SELECT device_id, COUNT(*)::int AS total_checks,
             SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks,
             AVG(response_ms) FILTER (WHERE status = 'up') AS avg_ms
      FROM ping_results WHERE ts BETWEEN $1 AND $2 GROUP BY device_id
    )
    SELECT d.id AS device_id, d.name AS device_name, d.site_name,
           COALESCE(pg.total_checks, 0)  AS total_checks,
           COALESCE(pg.failed_checks, 0) AS failed_checks,
           CASE WHEN pg.total_checks > 0
                THEN ROUND((1 - pg.failed_checks::numeric / pg.total_checks) * 100, 3)
                ELSE NULL END AS uptime_pct,
           ROUND(COALESCE(pg.failed_checks, 0) * d.poll_interval_seconds / 60.0, 1) AS downtime_minutes
    FROM monitored_devices d
    LEFT JOIN pings pg ON pg.device_id = d.id
    WHERE ${filters.join(' AND ')}
    ORDER BY uptime_pct ASC NULLS LAST, d.name`, params, []);
  const rows = r.rows.map((row) => ({ ...row, sla_met: row.uptime_pct != null && Number(row.uptime_pct) >= slaTarget }));
  return { rows, slaTarget, win };
}

async function gatherSla(db, params) {
  const q = params || {};
  const siteFilter = resolveSiteFilter(q);
  const runQ = mkRunQ(db, 'sla-compliance');
  const { rows, slaTarget, win } = await slaComplianceRows(runQ, q, siteFilter);

  const withData = rows.filter((r) => r.total_checks > 0);
  const tChecks = withData.reduce((a, r) => a + r.total_checks, 0);
  const tFailed = withData.reduce((a, r) => a + r.failed_checks, 0);

  const at_risk = [];
  for (const r of rows) {
    const u = r.uptime_pct != null ? Number(r.uptime_pct) : null;
    if (u == null || u >= 100) continue;
    if (u >= 99 && u <= slaTarget + 0.4 && u >= slaTarget - 0.6) {
      const minsPerCheck = r.failed_checks > 0 ? Number(r.downtime_minutes) / r.failed_checks : null;
      const periodMins = minsPerCheck != null ? r.total_checks * minsPerCheck : null;
      const toBreach = periodMins != null ? Math.max(0, Math.round(periodMins * (u - slaTarget) / 100)) : null;
      at_risk.push({ device_name: r.device_name, site_name: r.site_name, uptime_pct: u, minutes_to_breach: toBreach });
    }
  }
  at_risk.sort((a, b) => a.uptime_pct - b.uptime_pct);

  const trends = [];
  try {
    const durationMs = Date.parse(win.end) - Date.parse(win.start);
    const fmtD = (ms) => new Date(ms).toISOString().slice(0, 10);
    const prevQ = { range: 'custom', from: fmtD(Date.parse(win.start) - durationMs), to: fmtD(Date.parse(win.start)),
      sla_target: q.sla_target, site_id: q.site_id, device_id: q.device_id };
    const prev = await slaComplianceRows(runQ, prevQ, siteFilter);
    const prevMap = new Map(prev.rows.map((r) => [r.device_id, Number(r.downtime_minutes) || 0]));
    const incr = [];
    for (const r of rows) {
      const cur = Number(r.downtime_minutes) || 0;
      const pv = prevMap.get(r.device_id);
      if (pv != null && pv > 0 && cur > pv) {
        const pct = Math.round(((cur - pv) / pv) * 100);
        if (pct >= 40) incr.push({ name: r.device_name, pct });
      }
    }
    incr.sort((a, b) => b.pct - a.pct);
    for (const i of incr.slice(0, 2)) trends.push(`${i.name} downtime increased ${i.pct}% versus the previous period.`);
  } catch (e) { console.error('[reportsPdf/sla-compliance] trend failed:', e.message); }

  // Worst-first ordering (failing first) to match the on-screen table.
  const sorted = rows.map((d, index) => ({ d, index })).sort((a, b) => {
    if (a.d.sla_met !== b.d.sla_met) return a.d.sla_met ? 1 : -1;
    const au = a.d.uptime_pct == null ? Infinity : a.d.uptime_pct;
    const bu = b.d.uptime_pct == null ? Infinity : b.d.uptime_pct;
    if (au !== bu) return au - bu;
    return a.index - b.index;
  }).map((e) => e.d);

  const overall = tChecks ? Math.round((1 - tFailed / tChecks) * 100000) / 1000 : null;
  const stats = {
    total: rows.length,
    meeting: rows.filter((r) => r.sla_met).length,
    failing: rows.filter((r) => !r.sla_met && r.uptime_pct != null).length,
    overall_uptime_pct: overall,
    total_downtime_minutes: Math.round(rows.reduce((a, r) => a + (Number(r.downtime_minutes) || 0), 0) * 10) / 10,
  };
  const trendPoints = await uptimeTrendPoints(runQ, win, siteFilter, q.site_id ? parseInt(q.site_id, 10) : null);

  return {
    title: 'SLA Compliance',
    dateRange: win.label,
    rangeLabel: `Availability - ${win.label}`,
    slaTarget, stats, devices: sorted, risk: { at_risk, trends }, trendPoints,
    summary: [
      { label: 'Meeting SLA', value: `${stats.meeting}/${stats.total}`, color: GREEN },
      { label: 'Failing', value: String(stats.failing), color: RED },
      { label: 'Overall Uptime', value: overall == null ? '—' : `${overall}%`, color: NAVY },
    ],
  };
}

function renderSla(doc, data, layout) {
  const { left, contentW } = layout;
  doc.addPage();
  let y = doc.page.margins.top;

  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(`SLA target ${data.slaTarget}%`, left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;

  const s = data.stats || {};
  y = drawKpiTiles(doc, layout, y, [
    { value: `${data.slaTarget}%`, label: 'SLA Target', color: RED },
    { value: `${s.meeting || 0}/${s.total || 0}`, label: 'Meeting SLA', color: GREEN },
    { value: String(s.failing || 0), label: 'Failing', color: RED },
    { value: s.overall_uptime_pct == null ? '—' : `${s.overall_uptime_pct}%`, label: 'Overall Uptime', color: NAVY },
    { value: `${s.total_downtime_minutes || 0} min`, label: 'Total Downtime', color: YELLOW },
  ]);
  y += 22;
  doc.y = y;

  renderChartBlock(doc, layout, 'Availability Trend', data.trendPoints, { yMax: 100, ySuffix: '%', color: RED, rangeLabel: data.rangeLabel });

  sectionTitle(doc, layout, 'Device Compliance');
  drawTable(doc, {
    columns: [
      { key: 'device_name', label: 'Device', width: 170 },
      { key: 'site_name', label: 'Site', width: 130 },
      { key: 'uptime', label: 'Uptime %', width: 80, align: 'right', color: (r) => r._u == null ? MUTED : (r._met ? GREEN : RED) },
      { key: 'downtime', label: 'Downtime (min)', width: 100, align: 'right' },
      { key: 'status', label: 'SLA Status', width: 80, align: 'center', color: (r) => r._met ? GREEN : RED },
    ],
    rows: (data.devices || []).map((d) => ({
      device_name: d.device_name || '—', site_name: d.site_name || '—',
      uptime: d.uptime_pct == null ? '—' : `${d.uptime_pct}%`, _u: d.uptime_pct,
      downtime: d.downtime_minutes == null ? '—' : String(d.downtime_minutes),
      status: d.sla_met ? 'PASS' : 'FAIL', _met: d.sla_met,
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  const risk = data.risk || {};
  const atRisk = risk.at_risk || [];
  const trends = risk.trends || [];
  sectionTitle(doc, layout, 'Risk Assessment');
  const riskLines = [
    ...atRisk.map((r) => `At Risk: ${r.device_name}${r.site_name ? ` (${r.site_name})` : ''} at ${r.uptime_pct}%${r.minutes_to_breach != null ? ` - ${r.minutes_to_breach} minutes from SLA breach` : ''}`),
    ...trends,
  ];
  bulletList(doc, layout, riskLines, 'No SLA risks detected - all devices have comfortable headroom.');
}

// ════════════════════════════════════════════════════════════
// CAPACITY — mirror of GET /api/reports/capacity
// ════════════════════════════════════════════════════════════
function capacityAtRisk(row) {
  if (row.utilization_pct != null && row.utilization_pct >= 80) return true;
  if (row.trend_in === 'increasing' && (row.proj_90d_in || 0) > (row.avg_in_mbps || 0) * 1.5) return true;
  return false;
}

async function gatherCapacity(db, params) {
  const q = params || {};
  const win = getDateRange({ ...q, range: q.range || '90d' });
  const siteFilter = resolveSiteFilter(q);
  const runQ = mkRunQ(db, 'capacity');
  const midpoint = new Date((Date.parse(win.start) + Date.parse(win.end)) / 2).toISOString();

  const p = [win.start, win.end, midpoint];
  const filters = [`s.metric_name ~ '^if_[0-9]+_(in|out)_bps$'`, `s.ts BETWEEN $1 AND $2`];
  if (q.site_id) { p.push(parseInt(q.site_id, 10)); filters.push(`d.site_id = $${p.length}`); }
  const sc = siteClause(siteFilter, p, 'd.site_id');
  if (sc) filters.push(sc);
  const r = await runQ('capacity', `
    SELECT s.device_id, d.name AS device_name, COALESCE(d.site_name, 'Unassigned') AS site_name,
           s.if_name, s.metric_name,
           AVG(s.value) AS avg_bps, MAX(s.value) AS peak_bps,
           AVG(s.value) FILTER (WHERE s.ts <  $3) AS first_half,
           AVG(s.value) FILTER (WHERE s.ts >= $3) AS second_half
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE ${filters.join(' AND ')}
    GROUP BY s.device_id, d.name, site_name, s.if_name, s.metric_name`, p, []);

  const toMbps = (v) => (v == null ? null : Math.round(Number(v) / 1e6 * 100) / 100);
  const map = new Map();
  for (const row of r.rows) {
    const m = /^if_(\d+)_(in|out)_bps$/.exec(row.metric_name);
    if (!m) continue;
    const idx = m[1], dir = m[2];
    const key = `${row.device_id}|${idx}`;
    let e = map.get(key) || {
      device_name: row.device_name, site_name: row.site_name, interface: row.if_name || `Interface ${idx}`,
      avg_in_mbps: null, avg_out_mbps: null, peak_in_mbps: null, peak_out_mbps: null, _f: null, _s: null,
    };
    if (row.if_name) e.interface = row.if_name;
    if (dir === 'in') { e.avg_in_mbps = toMbps(row.avg_bps); e.peak_in_mbps = toMbps(row.peak_bps); e._f = row.first_half; e._s = row.second_half; }
    else { e.avg_out_mbps = toMbps(row.avg_bps); e.peak_out_mbps = toMbps(row.peak_bps); }
    map.set(key, e);
  }
  const rows = Array.from(map.values()).map((e) => {
    const f = Number(e._f) || 0, sh = Number(e._s) || 0;
    let trend_in = 'stable';
    if (f > 0) { const r2 = (sh - f) / f; trend_in = r2 > 0.1 ? 'increasing' : r2 < -0.1 ? 'decreasing' : 'stable'; }
    else if (sh > 0) trend_in = 'increasing';
    const cur = e.avg_in_mbps || 0;
    const growthPerMonth = Math.max(0, (sh - f) / 1e6);
    const proj = (months) => Math.round((cur + growthPerMonth * months) * 100) / 100;
    delete e._f; delete e._s;
    return { ...e, trend_in, proj_30d_in: proj(1), proj_60d_in: proj(2), proj_90d_in: proj(3), utilization_pct: null };
  }).sort((a, b) => (a.device_name || '').localeCompare(b.device_name || '') || (a.interface || '').localeCompare(b.interface || ''));

  for (const row of rows) row._atRisk = capacityAtRisk(row);

  // Aggregate inbound-bandwidth trend for the chart (daily average, Mbps).
  const tp = [win.start, win.end];
  const tFilters = [`s.metric_name ~ '^if_[0-9]+_in_bps$'`, `s.ts BETWEEN $1 AND $2`];
  if (q.site_id) { tp.push(parseInt(q.site_id, 10)); tFilters.push(`d.site_id = $${tp.length}`); }
  const tsc = siteClause(siteFilter, tp, 'd.site_id');
  if (tsc) tFilters.push(tsc);
  const tr = await runQ('bwtrend', `
    SELECT to_char(date_trunc('day', s.ts), 'YYYY-MM-DD') AS day, AVG(s.value) AS avg_bps
    FROM snmp_results s JOIN monitored_devices d ON d.id = s.device_id
    WHERE ${tFilters.join(' AND ')}
    GROUP BY 1 ORDER BY 1`, tp, []);
  const trendPoints = tr.rows.map((x) => ({ t: x.day, v: x.avg_bps == null ? null : Math.round(Number(x.avg_bps) / 1e6 * 100) / 100 })).filter((x) => x.v != null);
  const maxV = trendPoints.reduce((a, x) => Math.max(a, x.v), 0);
  const trendYMax = maxV > 0 ? Math.max(4, Math.ceil(maxV * 1.2)) : 100;

  const atRiskCount = rows.filter((row) => row._atRisk).length;
  const avgInVals = rows.map((row) => row.avg_in_mbps).filter((v) => v != null).map(Number);
  const avgIn = avgInVals.length ? Math.round((avgInVals.reduce((a, b) => a + b, 0) / avgInVals.length) * 100) / 100 : null;
  const peakIn = rows.reduce((a, row) => Math.max(a, row.peak_in_mbps || 0), 0);

  return {
    title: 'Capacity Planning',
    dateRange: win.label,
    rangeLabel: `Inbound bandwidth (Mbps) - ${win.label}`,
    rows,
    kpis: { interfaces: rows.length, atRisk: atRiskCount, avgIn, peakIn: rows.length ? peakIn : null },
    trendPoints, trendYMax,
    summary: [
      { label: 'Interfaces', value: String(rows.length), color: NAVY },
      { label: 'At Risk', value: String(atRiskCount), color: atRiskCount > 0 ? RED : GREEN },
      { label: 'Avg In (Mbps)', value: avgIn == null ? '—' : String(avgIn), color: NAVY },
    ],
  };
}

function renderCapacity(doc, data, layout) {
  const { left, contentW } = layout;
  const fmtMbps = (v) => (v == null ? '—' : `${Number(v).toFixed(2)} Mbps`);
  doc.addPage();
  let y = doc.page.margins.top;

  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text('Bandwidth trends and utilization projections', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;

  const k = data.kpis || {};
  y = drawKpiTiles(doc, layout, y, [
    { value: String(k.interfaces || 0), label: 'Interfaces', color: NAVY },
    { value: String(k.atRisk || 0), label: 'At Risk', color: (k.atRisk || 0) > 0 ? RED : GREEN },
    { value: fmtMbps(k.avgIn), label: 'Avg In', color: NAVY },
    { value: fmtMbps(k.peakIn), label: 'Peak In', color: YELLOW },
  ]);
  y += 22;
  doc.y = y;

  renderChartBlock(doc, layout, 'Inbound Bandwidth Trend', data.trendPoints, { yMax: data.trendYMax, ySuffix: ' Mb', color: RED, rangeLabel: data.rangeLabel });

  sectionTitle(doc, layout, 'Interface Capacity');
  drawTable(doc, {
    columns: [
      { key: 'device', label: 'Device / Site', width: 130 },
      { key: 'interface', label: 'Interface', width: 80 },
      { key: 'avg_in', label: 'Avg In', width: 65, align: 'right' },
      { key: 'avg_out', label: 'Avg Out', width: 65, align: 'right' },
      { key: 'peak', label: 'Peak In/Out', width: 95, align: 'right' },
      { key: 'trend', label: 'Trend', width: 65, color: (r) => r.trend === 'increasing' ? RED : r.trend === 'decreasing' ? MUTED : GREEN },
      { key: 'p30', label: '30d', width: 55, align: 'right' },
      { key: 'p60', label: '60d', width: 55, align: 'right' },
      { key: 'p90', label: '90d', width: 55, align: 'right' },
      { key: 'status', label: 'Status', width: 55, align: 'center', color: (r) => r._risk ? RED : GREEN },
    ],
    rows: (data.rows || []).map((row) => ({
      device: `${row.device_name || '—'}${row.site_name ? ` / ${row.site_name}` : ''}`,
      interface: row.interface || '—',
      avg_in: fmtMbps(row.avg_in_mbps), avg_out: fmtMbps(row.avg_out_mbps),
      peak: `${fmtMbps(row.peak_in_mbps)} / ${fmtMbps(row.peak_out_mbps)}`,
      trend: row.trend_in,
      p30: fmtMbps(row.proj_30d_in), p60: fmtMbps(row.proj_60d_in), p90: fmtMbps(row.proj_90d_in),
      status: row._atRisk ? 'At Risk' : 'OK', _risk: row._atRisk,
    })),
  }, layout, { continueOnPage: true });
}

// ── Renderer registry ─────────────────────────────────────────
// Canonical template keys → { title, gather, render }. `hasPdfRenderer` and
// `generateReportPdf` both resolve through normalizeTemplate() so an alias like
// 'executive-summary' maps to the same 'executive' renderer.
const RENDERERS = {
  'executive': { title: 'Executive Summary', gather: gatherExecutive, render: renderExecutive },
  'network-summary': { title: 'Network Summary', gather: gatherNetworkSummary, render: renderNetworkSummary },
  'site-summary': { title: 'Site Report', gather: gatherSite, render: renderSite },
  'sla-compliance': { title: 'SLA Compliance', gather: gatherSla, render: renderSla },
  'capacity': { title: 'Capacity Planning', gather: gatherCapacity, render: renderCapacity },
};
const ALIASES = {
  'executive-summary': 'executive',
  'network': 'network-summary',
  'site': 'site-summary',
  'sla': 'sla-compliance',
  'sla-report': 'sla-compliance',
  'capacity-planning': 'capacity',
};

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

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

// ════════════════════════════════════════════════════════════
// WIRELESS REPORTS — faithful mirrors of GET /api/reports/wireless-*.
// Those endpoints scope by controller_id (wlCtrl) rather than by site; the PDF
// path mirrors that AND additionally honours params._siteFilter (RBAC) on
// wireless_aps.site_id (the one wireless table that carries a site_id). Every
// wireless table is treated as optional — queries are wrapped by mkRunQ so an
// un-migrated / empty DB degrades to empty rows and still yields a valid PDF.
// ════════════════════════════════════════════════════════════
// SQL expression for an AP's effective utilisation (higher of the two bands) —
// identical to server.js WL_UTIL.
const WL_UTIL = 'GREATEST(COALESCE(a.radio_2g_util_pct,0), COALESCE(a.radio_5g_util_pct,0))';
const wlMean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
// Coerce a JSONB issues/recommendations element to a display string (server parity).
function wlText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.message || v.text || v.title || v.recommendation || JSON.stringify(v);
  return String(v);
}
function wlGradeFromUtil(util) {
  if (util == null) return null;
  return gradeFromScore(Math.max(0, 100 - Number(util)));
}
function wlPctStr(v) { return v == null || v === '' ? '—' : `${Number(v)}%`; }
function wlNumOrDash(v) { return v == null || v === '' ? '—' : String(v); }
function wlLastSeen(v) {
  if (v == null || v === '') return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { hour12: false });
}
function wlFmtUptime(seconds) {
  if (seconds == null || !isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
function wlSortChannels(keys) {
  const numeric = keys.filter((k) => String(k).toLowerCase() !== 'other');
  const other = keys.filter((k) => String(k).toLowerCase() === 'other');
  numeric.sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (isNaN(na) && isNaN(nb)) return String(a).localeCompare(String(b));
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    return na - nb;
  });
  return [...numeric, ...other];
}
// controller_id + RBAC context for the wireless family.
function wlScope(q) {
  const id = parseInt(q && q.controller_id, 10);
  return { hasCtrl: !isNaN(id), ctrlId: isNaN(id) ? null : id, siteFilter: resolveSiteFilter(q) };
}
// Build the WHERE/AND clause + params for a wireless_aps query aliased `a`
// (controller_id filter, mirroring wlCtrl, plus optional RBAC site_id clause).
function wlApClauses(scope) {
  const params = [];
  const parts = [];
  if (scope.hasCtrl) { params.push(scope.ctrlId); parts.push(`a.controller_id = $${params.length}`); }
  const sc = siteClause(scope.siteFilter, params, 'a.site_id'); if (sc) parts.push(sc);
  return { params, where: parts.length ? 'WHERE ' + parts.join(' AND ') : '', and: parts.length ? ' AND ' + parts.join(' AND ') : '' };
}
// controller-only clause (tables without a site_id: controllers/ssids/clients/intel).
function wlCtrlOnly(scope, col) {
  const params = [];
  let where = '', and = '';
  if (scope.hasCtrl) { params.push(scope.ctrlId); where = `WHERE ${col} = $1`; and = ` AND ${col} = $1`; }
  return { params, where, and };
}

// Section header used by the maxUtil colour rules in the AP-health table.
const wlUtilCol = (r) => r._util == null ? '#1e293b' : (r._util > 85 ? RED : r._util > 70 ? YELLOW : '#1e293b');
const wlRssiCol = (r) => r._rssi == null ? MUTED : (r._rssi < -75 ? RED : r._rssi < -67 ? YELLOW : GREEN);
const wlStatusCol = (r) => {
  const s = String(r.status || '').toLowerCase();
  return s === 'online' ? GREEN : s === 'offline' ? RED : MUTED;
};

// ── Wireless Overview — mirror of GET /api/reports/wireless-overview ──
async function gatherWirelessOverview(db, params) {
  const q = params || {};
  const scope = wlScope(q);
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const runQ = mkRunQ(db, 'wireless-overview');

  // Combined summary: controllers subquery + AP aggregate (controller id shared).
  const sp = [];
  let ctrlSub = '';
  const apParts = [];
  if (scope.hasCtrl) { sp.push(scope.ctrlId); ctrlSub = `WHERE id = $${sp.length}`; apParts.push(`a.controller_id = $${sp.length}`); }
  const sSite = siteClause(scope.siteFilter, sp, 'a.site_id'); if (sSite) apParts.push(sSite);
  const apW = apParts.length ? 'WHERE ' + apParts.join(' AND ') : '';
  const sum = await runQ('summary', `
    SELECT
      (SELECT COUNT(*)::int FROM wireless_controllers ${ctrlSub}) AS total_controllers,
      COUNT(*)::int AS total_aps,
      COUNT(*) FILTER (WHERE a.status = 'online')::int  AS online_aps,
      COUNT(*) FILTER (WHERE a.status = 'offline')::int AS offline_aps,
      COALESCE(SUM(a.clients_total), 0)::int AS total_clients,
      ROUND(AVG(${WL_UTIL})::numeric, 1) AS avg_utilization
    FROM wireless_aps a ${apW}`, sp, [{}]);

  const co = wlCtrlOnly(scope, 'controller_id');
  const intel = await runQ('intel', `
    SELECT ROUND(AVG(overall_score)::numeric, 0) AS score
    FROM wireless_intelligence ${co.where}`, co.params, []);

  const bs = wlApClauses(scope);
  const bySite = await runQ('by_site', `
    SELECT COALESCE(a.site_name, 'Unassigned') AS site_name,
           COUNT(DISTINCT a.controller_id)::int AS controllers,
           COUNT(*)::int AS aps,
           COUNT(*) FILTER (WHERE a.status = 'online')::int AS online_aps,
           COALESCE(SUM(a.clients_total), 0)::int AS clients,
           ROUND(AVG(${WL_UTIL})::numeric, 1) AS avg_utilization
    FROM wireless_aps a ${bs.where}
    GROUP BY 1 ORDER BY 1`, bs.params, []);

  const ta = wlApClauses(scope);
  const topAps = await runQ('top_aps', `
    SELECT a.name, COALESCE(a.site_name, 'Unassigned') AS site_name,
           COALESCE(a.clients_total, 0)::int AS clients,
           ROUND(${WL_UTIL}::numeric, 1) AS util
    FROM wireless_aps a ${ta.where}
    ORDER BY a.clients_total DESC NULLS LAST LIMIT 5`, ta.params, []);

  const ss = wlCtrlOnly(scope, 'controller_id');
  const topSsids = await runQ('top_ssids', `
    SELECT ssid_name, COALESCE(clients_total, 0)::int AS client_count
    FROM wireless_ssids ${ss.where}
    ORDER BY clients_total DESC NULLS LAST LIMIT 5`, ss.params, []);

  const of = wlApClauses(scope);
  const offline = await runQ('offline', `
    SELECT a.name, COALESCE(a.site_name, 'Unassigned') AS site_name, a.last_seen_at AS last_seen
    FROM wireless_aps a WHERE a.status = 'offline'${of.and}
    ORDER BY a.last_seen_at ASC NULLS LAST LIMIT 50`, of.params, []);

  const s = sum.rows[0] || {};
  const score = intel.rows[0] && intel.rows[0].score != null ? Number(intel.rows[0].score) : null;
  const summary = {
    total_controllers: s.total_controllers || 0,
    total_aps: s.total_aps || 0,
    online_aps: s.online_aps || 0,
    offline_aps: s.offline_aps || 0,
    total_clients: s.total_clients || 0,
    avg_utilization: s.avg_utilization != null ? Number(s.avg_utilization) : null,
    overall_health_score: score,
    overall_grade: gradeFromScore(score),
  };
  return {
    title: 'Wireless Overview',
    dateRange: win.label,
    headline: `${summary.total_aps} access point${summary.total_aps === 1 ? '' : 's'} - ${summary.online_aps} online, ${summary.total_clients} clients`,
    stats: summary,
    by_site: bySite.rows.map((r) => ({ ...r, health_grade: wlGradeFromUtil(r.avg_utilization) })),
    top_aps: topAps.rows,
    top_ssids: topSsids.rows,
    offline_aps: offline.rows,
    summary: [
      { label: 'Total APs', value: String(summary.total_aps), color: NAVY },
      { label: 'Online APs', value: String(summary.online_aps), color: GREEN },
      { label: 'Total Clients', value: String(summary.total_clients), color: RED },
    ],
  };
}

function renderWirelessOverview(doc, data, layout) {
  const { left, contentW } = layout;
  const s = data.stats || {};
  doc.addPage();
  let y = doc.page.margins.top;
  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(data.headline || '', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;
  y = drawKpiTiles(doc, layout, y, [
    { value: String(s.total_controllers || 0), label: 'Controllers', color: NAVY },
    { value: String(s.total_aps || 0), label: 'Total APs', color: NAVY },
    { value: String(s.online_aps || 0), label: 'Online APs', color: GREEN },
    { value: String(s.offline_aps || 0), label: 'Offline APs', color: (s.offline_aps || 0) > 0 ? RED : MUTED },
  ]);
  y += 12;
  y = drawKpiTiles(doc, layout, y, [
    { value: String(s.total_clients || 0), label: 'Total Clients', color: NAVY },
    { value: wlPctStr(s.avg_utilization), label: 'Avg Utilization', color: YELLOW },
    { value: s.overall_health_score == null ? '—' : `${s.overall_health_score}${s.overall_grade ? ' ' + s.overall_grade : ''}`, label: 'Overall Health', color: GREEN },
  ]);
  doc.y = y + 22;

  sectionTitle(doc, layout, 'Site Breakdown');
  drawTable(doc, {
    columns: [
      { key: 'site_name', label: 'Site', width: 150 },
      { key: 'controllers', label: 'Controllers', width: 75, align: 'right' },
      { key: 'aps', label: 'APs', width: 55, align: 'right' },
      { key: 'online', label: 'Online', width: 55, align: 'right' },
      { key: 'clients', label: 'Clients', width: 60, align: 'right' },
      { key: 'util', label: 'Avg Util %', width: 75, align: 'right' },
      { key: 'grade', label: 'Grade', width: 50, align: 'center' },
    ],
    rows: (data.by_site || []).map((r) => ({
      site_name: r.site_name, controllers: r.controllers, aps: r.aps, online: r.online_aps,
      clients: r.clients, util: r.avg_utilization == null ? '—' : String(r.avg_utilization), grade: r.health_grade || '—',
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'Top APs by Clients');
  drawTable(doc, {
    columns: [
      { key: 'name', label: 'Access Point', width: 190 },
      { key: 'site_name', label: 'Site', width: 150 },
      { key: 'clients', label: 'Clients', width: 70, align: 'right' },
      { key: 'util', label: 'Util %', width: 70, align: 'right' },
    ],
    rows: (data.top_aps || []).map((r) => ({
      name: r.name || '—', site_name: r.site_name || '—',
      clients: r.clients == null ? 0 : r.clients, util: wlPctStr(r.util),
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'Top SSIDs');
  drawTable(doc, {
    columns: [
      { key: 'ssid_name', label: 'SSID', width: 300 },
      { key: 'client_count', label: 'Clients', width: 90, align: 'right' },
    ],
    rows: (data.top_ssids || []).map((r) => ({ ssid_name: r.ssid_name || '—', client_count: r.client_count == null ? 0 : r.client_count })),
  }, layout, { continueOnPage: true });

  if (data.offline_aps && data.offline_aps.length) {
    doc.y += 18;
    sectionTitle(doc, layout, 'Offline APs');
    drawTable(doc, {
      columns: [
        { key: 'name', label: 'Access Point', width: 180 },
        { key: 'site_name', label: 'Site', width: 150 },
        { key: 'last_seen', label: 'Last Seen', width: 130, align: 'right' },
      ],
      rows: data.offline_aps.map((r) => ({ name: r.name || '—', site_name: r.site_name || '—', last_seen: wlLastSeen(r.last_seen) })),
    }, layout, { continueOnPage: true });
  }
}

// ── Wireless AP Health — mirror of GET /api/reports/wireless-ap-health ──
async function gatherWirelessApHealth(db, params) {
  const q = params || {};
  const scope = wlScope(q);
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const runQ = mkRunQ(db, 'wireless-ap-health');
  const cl = wlApClauses(scope);
  const baseCols = `
    a.name, c.name AS controller_name, COALESCE(a.site_name, 'Unassigned') AS site_name,
    a.status, COALESCE(a.clients_total, 0)::int AS clients,
    a.radio_2g_channel, a.radio_5g_channel, a.radio_2g_util_pct, a.radio_5g_util_pct,
    a.noise_floor_2g, a.noise_floor_5g, a.uptime_seconds`;

  // Try with the optional AP-intelligence join; fall back without it.
  let rows;
  const full = await runQ('aps-full', `
    SELECT ${baseCols},
           ai.health_score, ai.health_grade, ai.load_status,
           ROUND(ai.load_pct::numeric, 1) AS load_pct,
           COALESCE(ai.issues, '[]'::jsonb) AS issues
    FROM wireless_aps a
    LEFT JOIN wireless_controllers c ON c.id = a.controller_id
    LEFT JOIN wireless_ap_intelligence ai ON ai.ap_id = a.id
    ${cl.where}
    ORDER BY ai.health_score ASC NULLS LAST, a.name`, cl.params, null);
  if (full.rows == null) {
    const cl2 = wlApClauses(scope);
    const base = await runQ('aps-base', `
      SELECT ${baseCols}, NULL::numeric AS health_score, NULL::text AS health_grade,
             NULL::text AS load_status, NULL::numeric AS load_pct, '[]'::jsonb AS issues
      FROM wireless_aps a LEFT JOIN wireless_controllers c ON c.id = a.controller_id
      ${cl2.where} ORDER BY a.name`, cl2.params, []);
    rows = base.rows;
  } else {
    rows = full.rows;
  }

  const aps = rows.map((r) => {
    const util = Math.max(Number(r.radio_2g_util_pct || 0), Number(r.radio_5g_util_pct || 0));
    return {
      name: r.name, controller_name: r.controller_name, site_name: r.site_name,
      status: r.status, clients: r.clients,
      radio_2g_channel: r.radio_2g_channel, radio_5g_channel: r.radio_5g_channel,
      radio_2g_util_pct: r.radio_2g_util_pct != null ? Number(r.radio_2g_util_pct) : null,
      radio_5g_util_pct: r.radio_5g_util_pct != null ? Number(r.radio_5g_util_pct) : null,
      noise_floor_2g: r.noise_floor_2g, noise_floor_5g: r.noise_floor_5g,
      uptime_seconds: r.uptime_seconds != null ? Number(r.uptime_seconds) : null,
      health_score: r.health_score != null ? Number(r.health_score) : null,
      health_grade: r.health_grade || null,
      util, _load_status: r.load_status,
      issues: Array.isArray(r.issues) ? r.issues.map(wlText).filter(Boolean) : [],
    };
  });
  const scores = aps.map((a) => a.health_score).filter((v) => v != null);
  const summary = {
    total: aps.length,
    online: aps.filter((a) => a.status === 'online').length,
    offline: aps.filter((a) => a.status === 'offline').length,
    avg_health_score: scores.length ? Math.round(wlMean(scores)) : null,
    overloaded_count: aps.filter((a) => a._load_status === 'overloaded' || a.util > 85).length,
    high_util_count: aps.filter((a) => a.util > 70).length,
  };
  return {
    title: 'Wireless AP Health',
    dateRange: win.label,
    headline: `${summary.total} access point${summary.total === 1 ? '' : 's'} - avg health ${summary.avg_health_score == null ? 'n/a' : summary.avg_health_score}`,
    aps, stats: summary,
    summary: [
      { label: 'Total APs', value: String(summary.total), color: NAVY },
      { label: 'Online', value: String(summary.online), color: GREEN },
      { label: 'Avg Health', value: summary.avg_health_score == null ? '—' : String(summary.avg_health_score), color: YELLOW },
    ],
  };
}

function renderWirelessApHealth(doc, data, layout) {
  const { left, contentW } = layout;
  const s = data.stats || {};
  doc.addPage();
  let y = doc.page.margins.top;
  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(data.headline || '', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;
  y = drawKpiTiles(doc, layout, y, [
    { value: String(s.total || 0), label: 'Total APs', color: NAVY },
    { value: String(s.online || 0), label: 'Online', color: GREEN },
    { value: String(s.offline || 0), label: 'Offline', color: (s.offline || 0) > 0 ? RED : MUTED },
  ]);
  y += 12;
  y = drawKpiTiles(doc, layout, y, [
    { value: s.avg_health_score == null ? '—' : String(s.avg_health_score), label: 'Avg Health Score', color: GREEN },
    { value: String(s.overloaded_count || 0), label: 'Overloaded', color: (s.overloaded_count || 0) > 0 ? RED : MUTED },
    { value: String(s.high_util_count || 0), label: 'High Util', color: (s.high_util_count || 0) > 0 ? YELLOW : MUTED },
  ]);
  doc.y = y + 22;

  sectionTitle(doc, layout, 'Access Points');
  drawTable(doc, {
    columns: [
      { key: 'name', label: 'Name', width: 130 },
      { key: 'site_name', label: 'Site', width: 90 },
      { key: 'status', label: 'Status', width: 60, color: wlStatusCol },
      { key: 'clients', label: 'Clients', width: 50, align: 'right' },
      { key: 'chan', label: 'Ch 2.4/5', width: 60, align: 'center' },
      { key: 'util', label: 'Util', width: 45, align: 'right', color: wlUtilCol },
      { key: 'noise', label: 'Noise (dBm)', width: 75, align: 'center' },
      { key: 'uptime', label: 'Uptime', width: 55, align: 'right' },
      { key: 'grade', label: 'Grade', width: 45, align: 'center' },
    ],
    rows: (data.aps || []).map((ap) => ({
      name: ap.issues && ap.issues.length ? `${ap.name || '—'}\n${ap.issues.join(', ')}` : (ap.name || '—'),
      site_name: ap.site_name || '—',
      status: ap.status || '—',
      clients: ap.clients == null ? 0 : ap.clients,
      chan: `${ap.radio_2g_channel == null ? '—' : ap.radio_2g_channel} / ${ap.radio_5g_channel == null ? '—' : ap.radio_5g_channel}`,
      util: ap.util == null ? '—' : `${Math.round(ap.util)}%`, _util: ap.util,
      noise: `${ap.noise_floor_2g == null ? '—' : ap.noise_floor_2g} / ${ap.noise_floor_5g == null ? '—' : ap.noise_floor_5g}`,
      uptime: wlFmtUptime(ap.uptime_seconds),
      grade: ap.health_grade || '—',
    })),
  }, layout, { continueOnPage: true });
}

// ── Wireless Client — mirror of GET /api/reports/wireless-clients ──
async function gatherWirelessClients(db, params) {
  const q = params || {};
  const scope = wlScope(q);
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const runQ = mkRunQ(db, 'wireless-clients');
  const c = wlCtrlOnly(scope, 'controller_id');

  const sum = await runQ('summary', `
    SELECT COUNT(*)::int AS total_clients,
           COUNT(*) FILTER (WHERE is_problem)::int AS problem_clients,
           COUNT(*) FILTER (WHERE rssi_dbm < -75)::int AS low_signal_count,
           COUNT(*) FILTER (WHERE roaming_count > 5)::int AS frequent_roamers,
           COUNT(*) FILTER (WHERE band = '2.4GHz')::int AS b2,
           COUNT(*) FILTER (WHERE band = '5GHz')::int  AS b5
    FROM wireless_clients ${c.where}`, c.params, [{}]);
  const problem = await runQ('problem', `
    SELECT mac_address, hostname, ap_name, ssid_name, band, rssi_dbm, COALESCE(roaming_count, 0)::int AS roaming_count
    FROM wireless_clients WHERE is_problem = TRUE${c.and}
    ORDER BY rssi_dbm ASC NULLS LAST LIMIT 100`, c.params, []);
  const byBand = await runQ('by_band', `
    SELECT COALESCE(band, 'Unknown') AS band, COUNT(*)::int AS n
    FROM wireless_clients ${c.where} GROUP BY 1`, c.params, []);
  const roam = await runQ('roam', `
    SELECT COUNT(*)::int AS n FROM wireless_client_events
    WHERE event_type = 'roam' AND ts >= NOW() - INTERVAL '24 hours'${c.and}`, c.params, [{ n: 0 }]);
  const busiest = await runQ('busiest', `
    SELECT ap_name AS name, COUNT(*)::int AS clients
    FROM wireless_clients WHERE ap_name IS NOT NULL${c.and}
    GROUP BY ap_name ORDER BY clients DESC LIMIT 5`, c.params, []);

  const s = sum.rows[0] || {};
  const bandTotal = (s.b2 || 0) + (s.b5 || 0);
  const by_band = {};
  for (const r of byBand.rows) by_band[r.band] = r.n;
  const summary = {
    total_clients: s.total_clients || 0,
    problem_clients: s.problem_clients || 0,
    low_signal_count: s.low_signal_count || 0,
    frequent_roamers: s.frequent_roamers || 0,
    band_2g_pct: bandTotal ? Math.round((s.b2 / bandTotal) * 1000) / 10 : null,
    band_5g_pct: bandTotal ? Math.round((s.b5 / bandTotal) * 1000) / 10 : null,
  };
  const problem_clients = problem.rows.map((r) => {
    const reasons = [];
    if (r.rssi_dbm != null && r.rssi_dbm < -75) reasons.push('Low signal');
    if (r.roaming_count > 5) reasons.push('Frequent roaming');
    return { ...r, reason: reasons.join(', ') || 'Flagged' };
  });
  return {
    title: 'Wireless Client',
    dateRange: win.label,
    headline: `${summary.total_clients} client${summary.total_clients === 1 ? '' : 's'} - ${summary.problem_clients} flagged`,
    stats: summary, problem_clients, by_band,
    roaming_events_24h: roam.rows[0] ? roam.rows[0].n : 0,
    busiest_aps: busiest.rows,
    summary: [
      { label: 'Total Clients', value: String(summary.total_clients), color: NAVY },
      { label: 'Problem Clients', value: String(summary.problem_clients), color: RED },
      { label: 'Roaming 24h', value: String(roam.rows[0] ? roam.rows[0].n : 0), color: YELLOW },
    ],
  };
}

function renderWirelessClients(doc, data, layout) {
  const { left, contentW } = layout;
  const s = data.stats || {};
  doc.addPage();
  let y = doc.page.margins.top;
  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(data.headline || '', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;
  y = drawKpiTiles(doc, layout, y, [
    { value: String(s.total_clients || 0), label: 'Total Clients', color: NAVY },
    { value: String(s.problem_clients || 0), label: 'Problem Clients', color: (s.problem_clients || 0) > 0 ? RED : MUTED },
    { value: String(s.low_signal_count || 0), label: 'Low Signal', color: YELLOW },
  ]);
  y += 12;
  y = drawKpiTiles(doc, layout, y, [
    { value: String(s.frequent_roamers || 0), label: 'Frequent Roamers', color: NAVY },
    { value: String(data.roaming_events_24h || 0), label: 'Roaming Events 24h', color: YELLOW },
    { value: `2.4G ${s.band_2g_pct == null ? 0 : Math.round(s.band_2g_pct)}% / 5G ${s.band_5g_pct == null ? 0 : Math.round(s.band_5g_pct)}%`, label: 'Band Split', color: NAVY },
  ]);
  doc.y = y + 22;

  sectionTitle(doc, layout, 'Band Distribution');
  const bandEntries = Object.entries(data.by_band || {});
  const bandTotal = bandEntries.reduce((acc, [, n]) => acc + (n || 0), 0);
  drawTable(doc, {
    columns: [
      { key: 'band', label: 'Band', width: 160 },
      { key: 'clients', label: 'Clients', width: 100, align: 'right' },
      { key: 'pct', label: 'Share', width: 100, align: 'right' },
    ],
    rows: bandEntries.map(([band, n]) => ({
      band, clients: n == null ? 0 : n,
      pct: bandTotal > 0 ? `${Math.round(((n || 0) / bandTotal) * 100)}%` : '—',
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'Problem Clients');
  drawTable(doc, {
    columns: [
      { key: 'client', label: 'Client', width: 120 },
      { key: 'ap', label: 'AP', width: 90 },
      { key: 'ssid', label: 'SSID', width: 80 },
      { key: 'band', label: 'Band', width: 55 },
      { key: 'rssi', label: 'RSSI (dBm)', width: 70, align: 'right', color: wlRssiCol },
      { key: 'roams', label: 'Roams', width: 50, align: 'right' },
      { key: 'reason', label: 'Reason', width: 100 },
    ],
    rows: (data.problem_clients || []).map((r) => ({
      client: r.hostname || r.mac_address || '—', ap: r.ap_name || '—', ssid: r.ssid_name || '—',
      band: r.band || '—', rssi: r.rssi_dbm == null ? '—' : String(r.rssi_dbm), _rssi: r.rssi_dbm,
      roams: r.roaming_count == null ? 0 : r.roaming_count, reason: r.reason || '—',
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'Busiest APs');
  drawTable(doc, {
    columns: [
      { key: 'name', label: 'Name', width: 320 },
      { key: 'clients', label: 'Clients', width: 90, align: 'right' },
    ],
    rows: (data.busiest_aps || []).map((r) => ({ name: r.name || '—', clients: r.clients == null ? 0 : r.clients })),
  }, layout, { continueOnPage: true });
}

// ── Wireless RF — mirror of GET /api/reports/wireless-rf ──
async function gatherWirelessRf(db, params) {
  const q = params || {};
  const scope = wlScope(q);
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const runQ = mkRunQ(db, 'wireless-rf');
  const ci = wlCtrlOnly(scope, 'controller_id');

  const agg = await runQ('agg', `
    SELECT ROUND(AVG(overall_score)::numeric, 0)      AS overall_score,
           COALESCE(SUM(co_channel_pairs), 0)::int     AS co_channel_affected,
           ROUND(AVG(interference_score)::numeric, 1)  AS interference_score,
           ROUND(AVG(band_steering_score)::numeric, 1) AS band_steering_score,
           ROUND(AVG(band_2g_pct)::numeric, 1)         AS band_2g_pct,
           ROUND(AVG(band_5g_pct)::numeric, 1)         AS band_5g_pct,
           ROUND(AVG(load_balance_score)::numeric, 1)  AS load_balance_score,
           COALESCE(SUM(overloaded_aps), 0)::int       AS overloaded_aps
    FROM wireless_intelligence ${ci.where}`, ci.params, [{}]);
  const recRows = await runQ('recs', `
    SELECT recommendations FROM wireless_intelligence ${ci.where}`, ci.params, []);
  const ch = wlApClauses(scope);
  const chans = await runQ('chans', `
    SELECT a.radio_2g_channel AS ch2, a.radio_5g_channel AS ch5
    FROM wireless_aps a ${ch.where}`, ch.params, []);
  const gr = wlApClauses(scope);
  const grades = await runQ('grades', `
    SELECT ai.health_grade AS g, COUNT(*)::int AS n
    FROM wireless_ap_intelligence ai JOIN wireless_aps a ON a.id = ai.ap_id ${gr.where}
    GROUP BY 1`, gr.params, []);

  const recommendations = [];
  const seen = new Set();
  for (const row of recRows.rows) {
    const arr = Array.isArray(row.recommendations) ? row.recommendations : [];
    for (const item of arr) {
      const t = wlText(item);
      if (t && !seen.has(t)) { seen.add(t); recommendations.push(t); }
    }
  }
  const dist24 = { '1': 0, '6': 0, '11': 0, other: 0 };
  const dist5 = {};
  for (const r of chans.rows) {
    if (r.ch2 != null) { const k = [1, 6, 11].includes(r.ch2) ? String(r.ch2) : 'other'; dist24[k] = (dist24[k] || 0) + 1; }
    if (r.ch5 != null) { const k = String(r.ch5); dist5[k] = (dist5[k] || 0) + 1; }
  }
  const ap_health_distribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of grades.rows) {
    if (r.g && Object.prototype.hasOwnProperty.call(ap_health_distribution, r.g)) ap_health_distribution[r.g] = r.n;
  }
  const a = agg.rows[0] || {};
  const score = a.overall_score != null ? Number(a.overall_score) : null;
  return {
    title: 'Wireless RF',
    dateRange: win.label,
    headline: `RF health ${score == null ? 'n/a' : score}${score != null ? ` (${gradeFromScore(score)})` : ''} - ${a.overloaded_aps || 0} overloaded AP(s)`,
    overall_score: score, overall_grade: gradeFromScore(score),
    co_channel_affected: a.co_channel_affected || 0,
    interference_score: a.interference_score != null ? Number(a.interference_score) : null,
    band_steering_score: a.band_steering_score != null ? Number(a.band_steering_score) : null,
    load_balance_score: a.load_balance_score != null ? Number(a.load_balance_score) : null,
    overloaded_aps: a.overloaded_aps || 0,
    recommendations: recommendations.slice(0, 10),
    channel_distribution: { '2.4GHz': dist24, '5GHz': dist5 },
    ap_health_distribution,
    summary: [
      { label: 'Overall Score', value: score == null ? '—' : String(score), color: GREEN },
      { label: 'Co-Channel', value: String(a.co_channel_affected || 0), color: YELLOW },
      { label: 'Overloaded APs', value: String(a.overloaded_aps || 0), color: RED },
    ],
  };
}

function renderWirelessRf(doc, data, layout) {
  const { left, contentW } = layout;
  doc.addPage();
  let y = doc.page.margins.top;
  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(data.headline || '', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;
  y = drawKpiTiles(doc, layout, y, [
    { value: data.overall_score == null ? '—' : `${data.overall_score}${data.overall_grade ? ' ' + data.overall_grade : ''}`, label: 'Overall', color: GREEN },
    { value: data.interference_score == null ? '—' : String(data.interference_score), label: 'Interference', color: NAVY },
    { value: data.band_steering_score == null ? '—' : String(data.band_steering_score), label: 'Band Steering', color: NAVY },
  ]);
  y += 12;
  y = drawKpiTiles(doc, layout, y, [
    { value: data.load_balance_score == null ? '—' : String(data.load_balance_score), label: 'Load Balance', color: NAVY },
    { value: String(data.co_channel_affected || 0), label: 'Co-Channel Affected', color: YELLOW },
    { value: String(data.overloaded_aps || 0), label: 'Overloaded APs', color: (data.overloaded_aps || 0) > 0 ? RED : MUTED },
  ]);
  doc.y = y + 22;

  sectionTitle(doc, layout, 'Recommendations');
  bulletList(doc, layout, data.recommendations, 'No RF recommendations - the wireless environment looks healthy.');
  doc.y += 14;

  const cd = data.channel_distribution || { '2.4GHz': {}, '5GHz': {} };
  const chanRows = (map) => wlSortChannels(Object.keys(map || {})).map((k) => ({ ch: k, aps: String(map[k] || 0) }));
  sectionTitle(doc, layout, 'Channel Distribution - 2.4GHz');
  drawTable(doc, {
    columns: [
      { key: 'ch', label: 'Channel', width: 200, align: 'center' },
      { key: 'aps', label: 'APs', width: 120, align: 'right' },
    ],
    rows: chanRows(cd['2.4GHz']),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'Channel Distribution - 5GHz');
  drawTable(doc, {
    columns: [
      { key: 'ch', label: 'Channel', width: 200, align: 'center' },
      { key: 'aps', label: 'APs', width: 120, align: 'right' },
    ],
    rows: chanRows(cd['5GHz']),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  const gd = data.ap_health_distribution || {};
  sectionTitle(doc, layout, 'AP Grade Distribution');
  drawTable(doc, {
    columns: [
      { key: 'grade', label: 'Grade', width: 200, align: 'center' },
      { key: 'count', label: 'APs', width: 120, align: 'right' },
    ],
    rows: ['A', 'B', 'C', 'D', 'F'].map((g) => ({ grade: g, count: String(gd[g] || 0) })),
  }, layout, { continueOnPage: true });
}

// ── Wireless Capacity — mirror of GET /api/reports/wireless-capacity ──
async function gatherWirelessCapacity(db, params) {
  const q = params || {};
  const scope = wlScope(q);
  const win = getDateRange({ ...q, range: q.range || '90d' });
  const runQ = mkRunQ(db, 'wireless-capacity');

  const lc = wlCtrlOnly(scope, 'id');
  const lic = await runQ('licensed', `
    SELECT COALESCE(SUM(licensed_aps), 0)::int AS licensed
    FROM wireless_controllers ${lc.where}`, lc.params, [{ licensed: 0 }]);
  const uc = wlApClauses(scope);
  const used = await runQ('used', `
    SELECT COUNT(*)::int AS used, COALESCE(SUM(a.clients_total), 0)::int AS total_clients
    FROM wireless_aps a ${uc.where}`, uc.params, [{ used: 0, total_clients: 0 }]);
  const tc = wlApClauses(scope);
  const trendR = await runQ('trend', `
    WITH per_poll AS (
      SELECT date_trunc('hour', h.ts) AS bucket, SUM(h.clients_total) AS total
      FROM wireless_history h JOIN wireless_aps a ON a.id = h.ap_id
      WHERE h.ts >= NOW() - INTERVAL '30 days'${tc.and}
      GROUP BY 1
    )
    SELECT to_char(date_trunc('day', bucket), 'YYYY-MM-DD') AS day, ROUND(AVG(total))::int AS clients
    FROM per_poll GROUP BY 1 ORDER BY 1`, tc.params, []);
  const hc = wlApClauses(scope);
  const highUtil = await runQ('high_util', `
    SELECT a.name, COALESCE(a.site_name, 'Unassigned') AS site_name, ROUND(${WL_UTIL}::numeric, 1) AS util
    FROM wireless_aps a WHERE ${WL_UTIL} > 70${hc.and}
    ORDER BY util DESC LIMIT 50`, hc.params, []);

  const licensed = lic.rows[0] ? lic.rows[0].licensed : 0;
  const usedAps = used.rows[0] ? used.rows[0].used : 0;
  const totalClients = used.rows[0] ? used.rows[0].total_clients : 0;
  const trend = trendR.rows;
  const capacity_pct = licensed > 0 ? Math.round((usedAps / licensed) * 1000) / 10 : null;
  let peak = null;
  for (const t of trend) if (!peak || t.clients > peak.count) peak = { date: t.day, count: t.clients };

  let growth_rate = 'n/a', days_to_80pct = null, days_to_full = null;
  if (trend.length >= 8) {
    const half = Math.floor(trend.length / 2);
    const firstAvg = wlMean(trend.slice(0, half).map((t) => t.clients));
    const lastAvg = wlMean(trend.slice(-half).map((t) => t.clients));
    const gap = Math.max(1, trend.length - half);
    const perDay = (lastAvg - firstAvg) / gap;
    if (firstAvg > 0 && perDay > 0) {
      growth_rate = `${Math.round((perDay * 7 / firstAvg) * 1000) / 10}% per week`;
      const ceiling = licensed > 0 ? licensed * 50 : null;
      if (ceiling) {
        const d80 = (0.8 * ceiling - lastAvg) / perDay;
        const dFull = (ceiling - lastAvg) / perDay;
        if (d80 > 0 && isFinite(d80)) days_to_80pct = Math.round(d80);
        if (dFull > 0 && isFinite(dFull)) days_to_full = Math.round(dFull);
      }
    } else {
      growth_rate = 'flat/declining';
    }
  }
  const trendPoints = trend.map((t) => ({ t: t.day, v: t.clients == null ? null : Number(t.clients) })).filter((x) => x.v != null);
  const maxV = trendPoints.reduce((a, x) => Math.max(a, x.v), 0);
  return {
    title: 'Wireless Capacity',
    dateRange: win.label,
    rangeLabel: 'Client trend (last 30 days)',
    headline: `${usedAps} of ${licensed || 'n/a'} licensed AP(s) in use${capacity_pct == null ? '' : ` - ${capacity_pct}% capacity`}`,
    licensed_aps: licensed || null, used_aps: usedAps, capacity_pct,
    avg_clients_per_ap: usedAps > 0 ? Math.round((totalClients / usedAps) * 10) / 10 : null,
    peak_clients: peak, growth_rate,
    projected_capacity: { days_to_80pct, days_to_full },
    high_util_aps: highUtil.rows,
    trendPoints, trendYMax: maxV > 0 ? Math.max(4, Math.ceil(maxV * 1.2)) : 10,
    summary: [
      { label: 'Used APs', value: String(usedAps), color: NAVY },
      { label: 'Capacity %', value: capacity_pct == null ? '—' : `${capacity_pct}%`, color: RED },
      { label: 'Peak Clients', value: peak ? String(peak.count) : '—', color: YELLOW },
    ],
  };
}

function renderWirelessCapacity(doc, data, layout) {
  const { left, contentW } = layout;
  doc.addPage();
  let y = doc.page.margins.top;
  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(data.headline || '', left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;
  y = drawKpiTiles(doc, layout, y, [
    { value: wlNumOrDash(data.licensed_aps), label: 'Licensed APs', color: NAVY },
    { value: String(data.used_aps || 0), label: 'Used APs', color: NAVY },
    { value: data.capacity_pct == null ? '—' : `${data.capacity_pct}%`, label: 'Capacity', color: RED },
  ]);
  y += 12;
  y = drawKpiTiles(doc, layout, y, [
    { value: wlNumOrDash(data.avg_clients_per_ap), label: 'Avg Clients/AP', color: NAVY },
    { value: data.peak_clients ? String(data.peak_clients.count) : '—', label: 'Peak Clients', color: YELLOW },
    { value: String(data.growth_rate || 'n/a'), label: 'Growth Rate', color: GREEN },
  ]);
  doc.y = y + 22;

  renderChartBlock(doc, layout, 'Client Trend (last 30 days)', data.trendPoints, { yMax: data.trendYMax, ySuffix: '', color: RED, rangeLabel: data.rangeLabel });

  sectionTitle(doc, layout, 'Licensed vs Used');
  doc.fillColor('#334155').fontSize(11).font('Helvetica')
    .text(`${data.used_aps || 0} of ${wlNumOrDash(data.licensed_aps)} licensed access points in use${data.capacity_pct == null ? '.' : ` (${data.capacity_pct}% capacity).`}`, left, doc.y + 6, { width: contentW });
  doc.y += 14;

  const pc = data.projected_capacity || {};
  sectionTitle(doc, layout, 'Growth Projection');
  bulletList(doc, layout, [
    `Days to 80% capacity: ${pc.days_to_80pct == null ? 'Not projected' : pc.days_to_80pct}`,
    `Days to full: ${pc.days_to_full == null ? 'Not projected' : pc.days_to_full}`,
    `Growth rate: ${data.growth_rate || 'n/a'}`,
  ], 'No growth projection available.');
  doc.y += 14;

  sectionTitle(doc, layout, 'High Utilization APs');
  drawTable(doc, {
    columns: [
      { key: 'name', label: 'Name', width: 200 },
      { key: 'site_name', label: 'Site', width: 140 },
      { key: 'util', label: 'Util %', width: 80, align: 'right', color: (r) => r._u == null ? MUTED : (r._u > 85 ? RED : r._u > 70 ? YELLOW : '#1e293b') },
    ],
    rows: (data.high_util_aps || []).map((r) => ({
      name: r.name || '—', site_name: r.site_name || '—',
      util: r.util == null ? '—' : `${r.util}%`, _u: r.util == null ? null : Number(r.util),
    })),
  }, layout, { continueOnPage: true });
}

// ════════════════════════════════════════════════════════════
// TOP N WORST — mirror of GET /api/reports/top-worst
// KPIs + the ranked table. The on-screen TopWorstReport has NO trend chart,
// so this renderer has none either.
// ════════════════════════════════════════════════════════════
async function gatherTopWorst(db, params) {
  const q = params || {};
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const siteFilter = resolveSiteFilter(q);
  const metric = ['uptime', 'response', 'alerts'].includes(q.metric) ? q.metric : 'uptime';
  const limitN = Math.max(1, Math.min(parseInt(q.limit, 10) || 10, 100));
  const caps = await getCaps(db);
  const runQ = mkRunQ(db, 'top-worst');

  const p = [win.start, win.end];
  const sc = siteClause(siteFilter, p, 'd.site_id');
  let extra = sc ? ` AND ${sc}` : '';
  const siteId = parseInt(q.site_id, 10);
  if (!isNaN(siteId)) { p.push(siteId); extra += ` AND d.site_id = $${p.length}`; }

  const r = await runQ('agg', perDeviceAggSql(extra, caps), p, []);
  let rows = r.rows.map((d) => ({
    device_id: d.id, device_name: d.device_name, site_name: d.site_name,
    uptime_pct: d.uptime_pct, avg_response_ms: d.avg_response_ms,
    alerts_count: d.alerts_count, downtime_minutes: downtimeMin(d),
  }));
  if (metric === 'uptime') rows = rows.filter((d) => d.uptime_pct != null).sort((a, b) => Number(a.uptime_pct) - Number(b.uptime_pct));
  else if (metric === 'response') rows = rows.filter((d) => d.avg_response_ms != null).sort((a, b) => Number(b.avg_response_ms) - Number(a.avg_response_ms));
  else rows = rows.filter((d) => d.alerts_count > 0).sort((a, b) => b.alerts_count - a.alerts_count);
  rows = rows.slice(0, limitN);

  const label = { uptime: 'Availability', response: 'Response Time', alerts: 'Alerts' }[metric];
  const valHeader = { uptime: 'Uptime %', response: 'Avg Response', alerts: 'Alerts' }[metric];
  const fmtVal = (d) => metric === 'uptime'
    ? (d.uptime_pct == null ? '—' : `${d.uptime_pct}%`)
    : metric === 'response'
      ? (d.avg_response_ms == null ? '—' : `${d.avg_response_ms} ms`)
      : String(d.alerts_count == null ? 0 : d.alerts_count);
  const worst = rows[0];

  return {
    title: 'Top Worst', metric, label, valHeader, fmtVal, rows,
    dateRange: win.label,
    kpis: { ranked: rows.length, worstValue: worst ? fmtVal(worst) : '—', worstName: worst ? worst.device_name : '—' },
    summary: [
      { label: 'Devices Ranked', value: String(rows.length), color: NAVY },
      { label: `Worst by ${label}`, value: worst ? fmtVal(worst) : '—', color: RED },
      { label: 'Metric', value: label, color: YELLOW },
    ],
  };
}

function renderTopWorst(doc, data, layout) {
  const { left, contentW } = layout;
  const rows = data.rows || [];
  doc.addPage();
  let y = doc.page.margins.top;

  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(`Top ${rows.length} Worst by ${data.label}`, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(`Ranked worst-first over ${data.dateRange}`, left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;

  const k = data.kpis || {};
  y = drawKpiTiles(doc, layout, y, [
    { value: String(k.ranked || 0), label: 'Devices Ranked', color: NAVY },
    { value: String(k.worstValue || '—'), label: `Worst ${data.label}`, color: RED },
    { value: String(k.worstName || '—'), label: 'Worst Device', color: YELLOW },
  ]);
  doc.y = y + 22;

  sectionTitle(doc, layout, 'Ranked Devices');
  drawTable(doc, {
    columns: [
      { key: 'rank', label: 'Rank', width: 45, align: 'center', color: (r) => r._rank <= 3 ? RED : MUTED },
      { key: 'device', label: 'Device', width: 180 },
      { key: 'site', label: 'Site', width: 140 },
      { key: 'value', label: data.valHeader, width: 100, align: 'right', color: (r) => r._rank <= 3 ? RED : '#1e293b' },
    ],
    rows: rows.map((d, i) => ({
      rank: `#${i + 1}`, _rank: i + 1,
      device: d.device_name || '—', site: d.site_name || '—', value: data.fmtVal(d),
    })),
  }, layout, { continueOnPage: true });
}

// ════════════════════════════════════════════════════════════
// ALERT ANALYSIS — mirror of GET /api/reports/alert-analysis
// KPIs + an alert-volume trend chart (daily counts, derived here — the JSON
// carries no series) + breakdown tables.
// ════════════════════════════════════════════════════════════
const AA_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function aaDayName(d) { return (d == null || d < 0 || d > 6) ? '—' : AA_DAY_NAMES[d]; }
function aaHour(h) { return (h == null || h < 0 || h > 23) ? '—' : `${String(h).padStart(2, '0')}:00`; }

async function gatherAlertAnalysis(db, params) {
  const q = params || {};
  const win = getDateRange({ ...q, range: q.range || '30d' });
  const siteFilter = resolveSiteFilter(q);
  const runQ = mkRunQ(db, 'alert-analysis');

  const p = [win.start, win.end];
  const sc = siteClause(siteFilter, p, 'd.site_id');
  let extra = sc ? ` AND ${sc}` : '';
  const siteId = parseInt(q.site_id, 10);
  if (!isNaN(siteId)) { p.push(siteId); extra += ` AND d.site_id = $${p.length}`; }
  const base = `FROM alerts a JOIN monitored_devices d ON d.id = a.device_id
    WHERE a.alert_type <> 'recovery' AND a.triggered_at BETWEEN $1 AND $2${extra}`;

  const tot = await runQ('tot', `SELECT COUNT(*)::int AS c ${base}`, p, [{ c: 0 }]);
  const byType = await runQ('byType', `SELECT a.alert_type AS key, COUNT(*)::int AS count ${base} GROUP BY a.alert_type ORDER BY count DESC`, p, []);
  const bySev = await runQ('bySev', `SELECT a.severity AS key, COUNT(*)::int AS count ${base} GROUP BY a.severity ORDER BY count DESC`, p, []);
  const bySite = await runQ('bySite', `SELECT COALESCE(d.site_name, 'Unassigned') AS key, COUNT(*)::int AS count ${base} GROUP BY 1 ORDER BY count DESC`, p, []);
  const byDevice = await runQ('byDevice', `
    SELECT d.id AS device_id, d.name AS device_name, COALESCE(d.site_name, 'Unassigned') AS site_name,
           COUNT(*)::int AS count,
           ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)
             FILTER (WHERE a.resolved_at IS NOT NULL)::numeric, 1) AS mttr_minutes
    ${base} GROUP BY d.id, d.name, site_name ORDER BY count DESC LIMIT 10`, p, []);
  const mttr = await runQ('mttr', `
    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)) / 60.0)::numeric, 1) AS mttr
    ${base} AND a.resolved_at IS NOT NULL`, p, [{ mttr: null }]);
  const hour = await runQ('hour', `SELECT EXTRACT(HOUR FROM a.triggered_at)::int AS key, COUNT(*)::int AS count ${base} GROUP BY 1 ORDER BY count DESC LIMIT 1`, p, []);
  const day = await runQ('day', `SELECT EXTRACT(DOW FROM a.triggered_at)::int AS key, COUNT(*)::int AS count ${base} GROUP BY 1 ORDER BY count DESC LIMIT 1`, p, []);
  const trend = await runQ('trend', `SELECT to_char(date_trunc('day', a.triggered_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count ${base} GROUP BY 1 ORDER BY 1`, p, []);

  const trendPoints = trend.rows.map((r) => ({ t: r.day, v: Number(r.count) })).filter((x) => isFinite(x.v));
  const maxV = trendPoints.reduce((a, x) => Math.max(a, x.v), 0);
  const busiestHour = hour.rows[0] ? hour.rows[0].key : null;
  const busiestDay = day.rows[0] ? day.rows[0].key : null;

  return {
    title: 'Alerts & Anomalies',
    dateRange: win.label,
    rangeLabel: `Alerts per day - ${win.label}`,
    total_alerts: tot.rows[0] ? tot.rows[0].c : 0,
    avg_mttr_minutes: mttr.rows[0] ? mttr.rows[0].mttr : null,
    busiest_hour: busiestHour, busiest_day: busiestDay,
    by_type: byType.rows, by_severity: bySev.rows, by_site: bySite.rows,
    top_alerted: byDevice.rows,
    trendPoints, trendYMax: maxV > 0 ? Math.max(4, Math.ceil(maxV * 1.2)) : 5,
    summary: [
      { label: 'Total Alerts', value: String(tot.rows[0] ? tot.rows[0].c : 0), color: YELLOW },
      { label: 'Avg MTTR (min)', value: mttr.rows[0] && mttr.rows[0].mttr != null ? String(Math.round(mttr.rows[0].mttr)) : '—', color: NAVY },
      { label: 'Busiest Hour', value: aaHour(busiestHour), color: RED },
    ],
  };
}

function renderAlertAnalysis(doc, data, layout) {
  const { left, contentW } = layout;
  doc.addPage();
  let y = doc.page.margins.top;

  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
  y = doc.y + 2;
  doc.fillColor(MUTED).fontSize(11).font('Helvetica').text(`Alert volume, MTTR and patterns over ${data.dateRange}`, left, y, { width: contentW });
  y = doc.y + 4;
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;

  y = drawKpiTiles(doc, layout, y, [
    { value: String(data.total_alerts || 0), label: 'Total Alerts', color: YELLOW },
    { value: data.avg_mttr_minutes != null ? `${Math.round(data.avg_mttr_minutes)} min` : '—', label: 'Avg MTTR', color: NAVY },
    { value: aaHour(data.busiest_hour), label: 'Busiest Hour', color: RED },
    { value: aaDayName(data.busiest_day), label: 'Busiest Day', color: NAVY },
  ]);
  y += 22;
  doc.y = y;

  renderChartBlock(doc, layout, 'Alert Volume (daily)', data.trendPoints, { yMax: data.trendYMax, ySuffix: '', color: RED, rangeLabel: data.rangeLabel });

  // Pattern insight line.
  sectionTitle(doc, layout, 'Alert Pattern');
  const hasPattern = data.busiest_day != null && data.busiest_hour != null;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(
    hasPattern
      ? `Most alerts occur on ${aaDayName(data.busiest_day)} around ${aaHour(data.busiest_hour)}.`
      : 'Not enough data to detect a pattern.',
    left, doc.y + 6, { width: contentW });
  doc.y += 14;

  sectionTitle(doc, layout, 'Top Alerted Devices');
  drawTable(doc, {
    columns: [
      { key: 'device_name', label: 'Device', width: 180 },
      { key: 'site_name', label: 'Site', width: 140 },
      { key: 'count', label: 'Alerts', width: 70, align: 'right' },
      { key: 'mttr', label: 'MTTR (min)', width: 90, align: 'right' },
    ],
    rows: (data.top_alerted || []).map((d) => ({
      device_name: d.device_name || '—', site_name: d.site_name || '—',
      count: d.count == null ? 0 : d.count,
      mttr: d.mttr_minutes == null ? '—' : String(Math.round(d.mttr_minutes)),
    })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'By Type');
  drawTable(doc, {
    columns: [
      { key: 'key', label: 'Type', width: 300 },
      { key: 'count', label: 'Count', width: 90, align: 'right' },
    ],
    rows: (data.by_type || []).map((t) => ({ key: t.key || '—', count: t.count == null ? 0 : t.count })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'By Severity');
  drawTable(doc, {
    columns: [
      { key: 'key', label: 'Severity', width: 300 },
      { key: 'count', label: 'Count', width: 90, align: 'right' },
    ],
    rows: (data.by_severity || []).map((s) => ({ key: s.key || '—', count: s.count == null ? 0 : s.count })),
  }, layout, { continueOnPage: true });
  doc.y += 18;

  sectionTitle(doc, layout, 'By Site');
  drawTable(doc, {
    columns: [
      { key: 'key', label: 'Site', width: 300 },
      { key: 'count', label: 'Count', width: 90, align: 'right' },
    ],
    rows: (data.by_site || []).map((s) => ({ key: s.key || '—', count: s.count == null ? 0 : s.count })),
  }, layout, { continueOnPage: true });
}

// ════════════════════════════════════════════════════════════
// GRANULAR PER-ENTITY REPORTS — device-detail & ap-detail
// Each renders ONE OR MORE selected entities; every entity is its own PDF
// SECTION (starts on a fresh page → clean breaks, charts never split) with an
// entity header, a row of summary KPI tiles, and one trend chart per selected
// metric series. Mirrors GET /api/reports/device-detail?device_id=&from=&to=&bucket=
// and GET /api/reports/ap-detail/:id?from=&to=&bucket=.
// ════════════════════════════════════════════════════════════

// Whitelisted bucket intervals + range resolver (faithful copies of server.js
// BUCKET_INTERVALS / bucketIntervalSql / resolveSeriesRange). The SQL interval
// string is chosen from this whitelist only — never interpolated from raw input.
const PDF_BUCKET_INTERVALS = {
  '5m': { sql: '5 minutes', minutes: 5 },
  '15m': { sql: '15 minutes', minutes: 15 },
  '1h': { sql: '1 hour', minutes: 60 },
  '6h': { sql: '6 hours', minutes: 360 },
  '1d': { sql: '1 day', minutes: 1440 },
};
const PDF_BUCKET_ORDER = ['5m', '15m', '1h', '6h', '1d'];
function pdfAutoBucketKey(windowMs) {
  const hours = windowMs / 3600000;
  if (hours <= 6) return '5m';
  if (hours <= 48) return '15m';
  if (hours <= 24 * 14) return '1h';
  if (hours <= 24 * 60) return '6h';
  return '1d';
}
function pdfResolveSeriesRange(query) {
  const q = query || {};
  const PRESET_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
  let from, to;
  if (q.from && q.to && isFinite(Date.parse(q.from)) && isFinite(Date.parse(q.to))) {
    from = new Date(q.from).toISOString();
    to = new Date(q.to).toISOString();
  } else {
    const days = PRESET_DAYS[q.range] || 7;
    to = new Date().toISOString();
    from = new Date(Date.now() - days * 24 * 3600000).toISOString();
  }
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  const windowMs = (isFinite(fromMs) && isFinite(toMs) && toMs > fromMs) ? (toMs - fromMs) : 7 * 24 * 3600000;
  let key = (q.bucket && q.bucket !== 'auto' && PDF_BUCKET_INTERVALS[q.bucket]) ? q.bucket : pdfAutoBucketKey(windowMs);
  let idx = PDF_BUCKET_ORDER.indexOf(key);
  while (idx < PDF_BUCKET_ORDER.length - 1) {
    if ((windowMs / 60000) / PDF_BUCKET_INTERVALS[PDF_BUCKET_ORDER[idx]].minutes <= 1500) break;
    idx += 1;
  }
  key = PDF_BUCKET_ORDER[idx];
  return { from, to, bucket: key, intervalSql: PDF_BUCKET_INTERVALS[key].sql };
}

// Parse a param that may be a CSV string, single value, or array into a deduped
// list of positive integer ids (order-preserving).
function parseIdList() {
  const out = [], seen = new Set();
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    for (const x of arr) {
      const n = parseInt(String(x).trim(), 10);
      if (!isNaN(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}
// Parse selected metric keys (CSV/array). Returns null when none supplied, which
// means "render every metric that has data" (mirrors the components' undefined).
function parseMetricList() {
  const out = [], seen = new Set();
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    for (const x of arr) {
      const k = String(x).trim();
      if (k && !seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  return out.length ? out : null;
}
// Build { t, v } points from bucketed rows for a single numeric column.
function seriesPointsCol(rows, vKey, transform) {
  const out = [];
  for (const r of rows) {
    const raw = r[vKey];
    if (raw == null) continue;
    let v = Number(raw);
    if (!isFinite(v)) continue;
    if (transform) v = transform(v);
    out.push({ t: r.ts, v });
  }
  return out;
}
// A sane y-axis top for a non-percentage series (headroom above the peak).
function autoYMax(points) {
  const m = points.reduce((a, p) => Math.max(a, p.v), 0);
  return m > 0 ? Math.max(1, Math.ceil(m * 1.2)) : 10;
}

// Shared per-entity section renderer (used by device-detail + ap-detail). Each
// entity starts on a fresh page so charts never split across a page boundary.
function renderEntitySection(doc, layout, ent) {
  const { left, contentW } = layout;
  doc.addPage();
  let y = doc.page.margins.top;
  doc.fillColor(NAVY).fontSize(18).font('Helvetica-Bold').text(ent.header.name || '—', left, y, { width: contentW });
  y = doc.y + 2;
  if (ent.header.subline) {
    doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(ent.header.subline, left, y, { width: contentW });
    y = doc.y + 4;
  }
  doc.moveTo(left, y).lineTo(left + 90, y).lineWidth(2).stroke(RED);
  y += 14;
  if (ent.stats && ent.stats.length) { y = drawKpiTiles(doc, layout, y, ent.stats); y += 22; }
  doc.y = y;

  if (!ent.charts || !ent.charts.length) {
    doc.fillColor(MUTED).fontSize(10).font('Helvetica-Oblique')
      .text('No time-series data for the selected metrics in this period.', left, doc.y + 6, { width: contentW });
    return;
  }
  ent.charts.forEach((c) => renderChartBlock(doc, layout, c.title, c.points,
    { yMax: c.yMax, ySuffix: c.ySuffix, color: c.color, rangeLabel: c.rangeLabel }));
}

// Shared entry point for both granular reports. Produces a valid "nothing
// selected" PDF when no entity resolved.
function renderEntityReport(doc, data, layout, noun) {
  const { left, contentW } = layout;
  const ents = data.entities || [];
  if (!ents.length) {
    doc.addPage();
    const y = doc.page.margins.top;
    doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(data.title, left, y, { width: contentW });
    doc.moveTo(left, doc.y + 4).lineTo(left + 90, doc.y + 4).lineWidth(2).stroke(RED);
    doc.fillColor(MUTED).fontSize(11).font('Helvetica')
      .text(`No ${noun} selected, or no data available for the selected ${noun}(s) in this period.`, left, doc.y + 16, { width: contentW });
    return;
  }
  ents.forEach((e) => renderEntitySection(doc, layout, e));
}

// ── Device Detail — mirror of GET /api/reports/device-detail ──
// Metric keys (frontend DETAIL_METRICS['device-detail']): latency, cpu, mem,
// interfaces, sessions.
const DD_COLORS = { latency: RED, cpu: '#2563eb', mem: '#7c3aed', sessions: '#16a34a', iface: '#2563eb' };
const DD_MAX_IFACES = 4;

async function gatherDeviceDetail(db, params) {
  const q = params || {};
  const siteFilter = resolveSiteFilter(q);
  const runQ = mkRunQ(db, 'device-detail');
  const range = pdfResolveSeriesRange(q);
  const ids = parseIdList(q.device_id, q.device_ids, q.entity_ids, q.ids);
  const metrics = parseMetricList(q.metrics, q.selected_metrics, q._metrics);
  const want = (kk) => !metrics || metrics.includes(kk);
  const dateRange = `${fmtDay(range.from)} to ${fmtDay(range.to)}`;
  const rangeLabel = `Series - ${dateRange}`;

  const entities = [];
  for (const id of ids) {
    const dev = await runQ('device', `
      SELECT id, name, ip_address, site_name, site_id, device_type, device_vendor, snmp_enabled, poll_interval_seconds
      FROM monitored_devices WHERE id = $1`, [id], []);
    const d = dev.rows[0];
    if (!d) continue;
    if (siteFilter && siteFilter.length && !siteFilter.includes(d.site_id)) continue; // RBAC

    const avail = await runQ('avail', `
      SELECT COUNT(*)::int AS total_checks,
             SUM(CASE WHEN status <> 'up' THEN 1 ELSE 0 END)::int AS failed_checks
      FROM ping_results WHERE device_id = $1 AND ts BETWEEN $2 AND $3`, [id, range.from, range.to], [{ total_checks: 0, failed_checks: 0 }]);
    const resp = await runQ('resp', `
      SELECT ROUND(AVG(response_ms)::numeric, 1) AS avg_ms
      FROM ping_results WHERE device_id = $1 AND status = 'up' AND ts BETWEEN $2 AND $3`, [id, range.from, range.to], [{ avg_ms: null }]);
    const alertsCnt = await runQ('alerts', `
      SELECT COUNT(*)::int AS c FROM alerts
      WHERE device_id = $1 AND alert_type <> 'recovery' AND triggered_at BETWEEN $2 AND $3`, [id, range.from, range.to], [{ c: 0 }]);

    const scalar = await runQ('scalar', `
      WITH ping AS (
        SELECT date_bin($2::interval, ts, TIMESTAMPTZ '2000-01-01') AS b,
               ROUND(AVG(response_ms) FILTER (WHERE status = 'up')::numeric, 1) AS latency_ms,
               ROUND(AVG(COALESCE(packet_loss_pct, CASE WHEN status = 'up' THEN 0 ELSE 100 END))::numeric, 1) AS packet_loss_pct
        FROM ping_results WHERE device_id = $1 AND ts BETWEEN $3 AND $4 GROUP BY 1
      ),
      snmp AS (
        SELECT date_bin($2::interval, ts, TIMESTAMPTZ '2000-01-01') AS b,
               ROUND(AVG(value) FILTER (WHERE metric_name = 'cpu_pct')::numeric, 1)           AS cpu_pct,
               ROUND(AVG(value) FILTER (WHERE metric_name = 'mem_pct')::numeric, 1)           AS mem_pct,
               ROUND(AVG(value) FILTER (WHERE metric_name = 'session_count')::numeric, 0)     AS session_count,
               ROUND(AVG(value) FILTER (WHERE metric_name = 'session_util_pct')::numeric, 1)  AS session_util_pct,
               ROUND(AVG(value) FILTER (WHERE metric_name = 'gp_tunnels')::numeric, 0)        AS gp_tunnels
        FROM snmp_results
        WHERE device_id = $1 AND ts BETWEEN $3 AND $4
          AND metric_name IN ('cpu_pct','mem_pct','session_count','session_util_pct','gp_tunnels')
        GROUP BY 1
      )
      SELECT COALESCE(ping.b, snmp.b) AS ts,
             ping.latency_ms, ping.packet_loss_pct,
             snmp.cpu_pct, snmp.mem_pct, snmp.session_count, snmp.session_util_pct, snmp.gp_tunnels
      FROM ping FULL OUTER JOIN snmp ON ping.b = snmp.b
      ORDER BY ts`, [id, range.intervalSql, range.from, range.to], []);

    const ifRows = await runQ('iface', `
      SELECT if_index,
             MAX(if_name) AS if_name,
             date_bin($2::interval, ts, TIMESTAMPTZ '2000-01-01') AS ts,
             ROUND(AVG(value) FILTER (WHERE metric_name = 'if_in_bps' OR metric_name LIKE 'if\\_%\\_in\\_bps')::numeric, 0)        AS in_bps,
             ROUND(AVG(value) FILTER (WHERE metric_name = 'if_out_bps' OR metric_name LIKE 'if\\_%\\_out\\_bps')::numeric, 0)       AS out_bps
      FROM snmp_results
      WHERE device_id = $1 AND ts BETWEEN $3 AND $4
        AND if_index IS NOT NULL
        AND (metric_name = 'if_in_bps' OR metric_name = 'if_out_bps'
             OR metric_name LIKE 'if\\_%\\_in\\_bps' OR metric_name LIKE 'if\\_%\\_out\\_bps')
      GROUP BY if_index, date_bin($2::interval, ts, TIMESTAMPTZ '2000-01-01')
      ORDER BY if_index, ts`, [id, range.intervalSql, range.from, range.to], []);

    const ifMap = new Map();
    for (const row of ifRows.rows) {
      if (!ifMap.has(row.if_index)) ifMap.set(row.if_index, { if_index: row.if_index, if_name: row.if_name, points: [] });
      const e = ifMap.get(row.if_index);
      if (!e.if_name && row.if_name) e.if_name = row.if_name;
      e.points.push({ ts: row.ts, in_bps: row.in_bps == null ? null : Number(row.in_bps) });
    }

    const a0 = avail.rows[0] || { total_checks: 0, failed_checks: 0 };
    const poll = d.poll_interval_seconds || 300;
    const uptime = pct2(a0.failed_checks, a0.total_checks);
    const avgMs = resp.rows[0] && resp.rows[0].avg_ms != null ? Number(resp.rows[0].avg_ms) : null;
    const downtime = round1(a0.failed_checks * poll / 60);

    const scalarRows = scalar.rows;
    const charts = [];
    if (want('latency')) { const pts = seriesPointsCol(scalarRows, 'latency_ms'); if (pts.length) charts.push({ title: 'Latency (ms)', points: pts, yMax: autoYMax(pts), ySuffix: ' ms', color: DD_COLORS.latency, rangeLabel }); }
    if (want('cpu')) { const pts = seriesPointsCol(scalarRows, 'cpu_pct'); if (pts.length) charts.push({ title: 'CPU utilization (%)', points: pts, yMax: 100, ySuffix: '%', color: DD_COLORS.cpu, rangeLabel }); }
    if (want('mem')) { const pts = seriesPointsCol(scalarRows, 'mem_pct'); if (pts.length) charts.push({ title: 'Memory utilization (%)', points: pts, yMax: 100, ySuffix: '%', color: DD_COLORS.mem, rangeLabel }); }
    if (want('sessions')) { const pts = seriesPointsCol(scalarRows, 'session_count'); if (pts.length) charts.push({ title: 'Sessions', points: pts, yMax: autoYMax(pts), ySuffix: '', color: DD_COLORS.sessions, rangeLabel }); }
    if (want('interfaces')) {
      const usable = Array.from(ifMap.values()).filter((f) => f.points.some((pp) => pp.in_bps != null));
      usable.sort((a, b) => b.points.reduce((m, pp) => Math.max(m, pp.in_bps || 0), 0) - a.points.reduce((m, pp) => Math.max(m, pp.in_bps || 0), 0));
      for (const iface of usable.slice(0, DD_MAX_IFACES)) {
        const pts = seriesPointsCol(iface.points, 'in_bps', (v) => Math.round(v / 1e6 * 100) / 100);
        if (pts.length) charts.push({ title: `${iface.if_name || ('Interface ' + iface.if_index)} in (Mbps)`, points: pts, yMax: autoYMax(pts), ySuffix: ' Mb', color: DD_COLORS.iface, rangeLabel });
      }
    }

    const subline = [d.ip_address, d.device_type, d.site_name, d.device_vendor].filter((x) => x != null && x !== '').join(' · ');
    entities.push({
      header: { name: d.name, subline },
      stats: [
        { value: uptime == null ? '—' : `${uptime}%`, label: 'Uptime', color: GREEN },
        { value: avgMs == null ? '—' : `${avgMs} ms`, label: 'Avg Response', color: NAVY },
        { value: `${downtime} min`, label: 'Downtime', color: RED },
        { value: String(alertsCnt.rows[0] ? alertsCnt.rows[0].c : 0), label: 'Alerts', color: YELLOW },
      ],
      charts,
    });
  }

  return {
    title: 'Device Detail',
    dateRange,
    entities,
    summary: [
      { label: 'Devices', value: String(entities.length), color: NAVY },
      { label: 'Metrics', value: metrics ? String(metrics.length) : 'All', color: YELLOW },
      { label: 'Bucket', value: range.bucket, color: GREEN },
    ],
  };
}

function renderDeviceDetail(doc, data, layout) { renderEntityReport(doc, data, layout, 'device'); }

// ── AP Detail — mirror of GET /api/reports/ap-detail/:id ──
// Metric keys (frontend DETAIL_METRICS['ap-detail']): clients, radio_util,
// noise, throughput.
const AP_COLORS = { clients: '#7c3aed', util: YELLOW, noise: '#f97316', throughput: '#2563eb' };

async function gatherApDetail(db, params) {
  const q = params || {};
  const siteFilter = resolveSiteFilter(q);
  const runQ = mkRunQ(db, 'ap-detail');
  const range = pdfResolveSeriesRange(q);
  const ids = parseIdList(q.id, q.ap_id, q.ap_ids, q.ids, q.entity_ids);
  const metrics = parseMetricList(q.metrics, q.selected_metrics, q._metrics);
  const want = (kk) => !metrics || metrics.includes(kk);
  const dateRange = `${fmtDay(range.from)} to ${fmtDay(range.to)}`;
  const rangeLabel = `Series - ${dateRange}`;

  const intervalMin = (PDF_BUCKET_INTERVALS[range.bucket] || { minutes: 60 }).minutes;
  const windowMin = Math.max(1, (Date.parse(range.to) - Date.parse(range.from)) / 60000);
  const expected = Math.max(1, Math.round(windowMin / intervalMin));

  const entities = [];
  for (const id of ids) {
    const apQ = await runQ('ap', `
      SELECT a.id, a.name, a.model, a.mac_address, a.ip_address, a.controller_id,
             c.name AS controller_name, a.site_id, a.site_name,
             a.firmware_version, a.uptime_seconds, a.status, a.radio_2g_channel, a.radio_5g_channel
      FROM wireless_aps a LEFT JOIN wireless_controllers c ON c.id = a.controller_id
      WHERE a.id = $1`, [id], []);
    const ap = apQ.rows[0];
    if (!ap) continue;
    if (siteFilter && siteFilter.length && !siteFilter.includes(ap.site_id)) continue; // RBAC

    const seriesQ = await runQ('series', `
      SELECT date_bin($2::interval, ts, TIMESTAMPTZ '2000-01-01') AS ts,
             ROUND(AVG(clients_total)::numeric, 1)  AS clients_total,
             ROUND(AVG(radio_2g_util)::numeric, 1)  AS radio_2g_util,
             ROUND(AVG(radio_5g_util)::numeric, 1)  AS radio_5g_util,
             ROUND(AVG(noise_floor_2g)::numeric, 1) AS noise_floor_2g,
             ROUND(AVG(noise_floor_5g)::numeric, 1) AS noise_floor_5g,
             ROUND(AVG(throughput_in_bps)::numeric, 0)  AS throughput_in_bps
      FROM wireless_history
      WHERE ap_id = $1 AND ts BETWEEN $3 AND $4
      GROUP BY 1 ORDER BY 1`, [id, range.intervalSql, range.from, range.to], []);
    const disco = await runQ('disco', `
      SELECT COUNT(*)::int AS c FROM wireless_client_events
      WHERE from_ap_id = $1 AND event_type = 'leave' AND ts BETWEEN $2 AND $3`, [id, range.from, range.to], [{ c: 0 }]);

    const seriesRows = seriesQ.rows;
    const sampleCount = seriesRows.length;
    const online = Math.min(sampleCount, expected);
    const uptimePct = expected > 0 ? Math.round((online / expected) * 1000) / 10 : null;
    const downEvents = Math.max(0, expected - online);
    const disconnects = disco.rows[0] ? disco.rows[0].c : 0;

    const charts = [];
    if (want('clients')) { const pts = seriesPointsCol(seriesRows, 'clients_total'); if (pts.length) charts.push({ title: 'Connected clients', points: pts, yMax: autoYMax(pts), ySuffix: '', color: AP_COLORS.clients, rangeLabel }); }
    if (want('radio_util')) {
      const pts = [];
      for (const r of seriesRows) {
        if (r.radio_2g_util == null && r.radio_5g_util == null) continue;
        pts.push({ t: r.ts, v: Math.max(Number(r.radio_2g_util || 0), Number(r.radio_5g_util || 0)) });
      }
      if (pts.length) charts.push({ title: 'Radio utilization (%)', points: pts, yMax: 100, ySuffix: '%', color: AP_COLORS.util, rangeLabel });
    }
    if (want('noise')) {
      // Noise floor is negative dBm; the chart renderer plots [0..yMax], so we
      // chart its magnitude (|dBm|) as a trend indicator.
      const pts = [];
      for (const r of seriesRows) {
        const n = r.noise_floor_5g != null ? r.noise_floor_5g : r.noise_floor_2g;
        if (n == null) continue;
        pts.push({ t: r.ts, v: Math.abs(Number(n)) });
      }
      if (pts.length) charts.push({ title: 'Noise floor (|dBm|)', points: pts, yMax: autoYMax(pts), ySuffix: '', color: AP_COLORS.noise, rangeLabel });
    }
    if (want('throughput')) { const pts = seriesPointsCol(seriesRows, 'throughput_in_bps', (v) => Math.round(v / 1e6 * 100) / 100); if (pts.length) charts.push({ title: 'Throughput in (Mbps)', points: pts, yMax: autoYMax(pts), ySuffix: ' Mb', color: AP_COLORS.throughput, rangeLabel }); }

    const subline = [ap.model, ap.ip_address, ap.controller_name, ap.site_name].filter((x) => x != null && x !== '').join(' · ');
    entities.push({
      header: { name: ap.name, subline },
      stats: [
        { value: uptimePct == null ? '—' : `${uptimePct}%`, label: 'Uptime', color: GREEN },
        { value: String(sampleCount), label: 'Samples', color: NAVY },
        { value: String(downEvents), label: 'Down Events', color: RED },
        { value: String(disconnects), label: 'Disconnects', color: YELLOW },
      ],
      charts,
    });
  }

  return {
    title: 'AP Detail',
    dateRange,
    entities,
    summary: [
      { label: 'Access Points', value: String(entities.length), color: NAVY },
      { label: 'Metrics', value: metrics ? String(metrics.length) : 'All', color: YELLOW },
      { label: 'Bucket', value: range.bucket, color: GREEN },
    ],
  };
}

function renderApDetail(doc, data, layout) { renderEntityReport(doc, data, layout, 'access point'); }

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
  'wireless-overview': { title: 'Wireless Overview', gather: gatherWirelessOverview, render: renderWirelessOverview },
  'wireless-ap-health': { title: 'Wireless AP Health', gather: gatherWirelessApHealth, render: renderWirelessApHealth },
  'wireless-clients': { title: 'Wireless Client', gather: gatherWirelessClients, render: renderWirelessClients },
  'wireless-rf': { title: 'Wireless RF', gather: gatherWirelessRf, render: renderWirelessRf },
  'wireless-capacity': { title: 'Wireless Capacity', gather: gatherWirelessCapacity, render: renderWirelessCapacity },
  'top-worst': { title: 'Top 10 Worst', gather: gatherTopWorst, render: renderTopWorst },
  'alert-analysis': { title: 'Alerts & Anomalies', gather: gatherAlertAnalysis, render: renderAlertAnalysis },
  'device-detail': { title: 'Device Detail', gather: gatherDeviceDetail, render: renderDeviceDetail },
  'ap-detail': { title: 'AP Detail', gather: gatherApDetail, render: renderApDetail },
};
const ALIASES = {
  'executive-summary': 'executive',
  'network': 'network-summary',
  'site': 'site-summary',
  'sla': 'sla-compliance',
  'sla-report': 'sla-compliance',
  'capacity-planning': 'capacity',
  // Wireless aliases — canonical keys mirror the /api/reports/wireless-* endpoints
  // and the frontend TEMPLATES list; these map obvious variants onto them.
  'wireless-client': 'wireless-clients',
  'wireless-clients-report': 'wireless-clients',
  'wireless': 'wireless-overview',
  'wireless-summary': 'wireless-overview',
  'wireless-ap': 'wireless-ap-health',
  'wireless-ap-health-report': 'wireless-ap-health',
  'wireless-rf-health': 'wireless-rf',
  'wireless-capacity-planning': 'wireless-capacity',
  // Aggregate + granular detail aliases (canonical keys mirror the frontend
  // TEMPLATES list + the /api/reports/* endpoints).
  'top-10-worst': 'top-worst',
  'topworst': 'top-worst',
  'worst': 'top-worst',
  'alerts': 'alert-analysis',
  'alerts-analysis': 'alert-analysis',
  'alert-anomalies': 'alert-analysis',
  'alerts-and-anomalies': 'alert-analysis',
  'device': 'device-detail',
  'device-details': 'device-detail',
  'devices-detail': 'device-detail',
  'ap': 'ap-detail',
  'ap-details': 'ap-detail',
  'access-point-detail': 'ap-detail',
  'wireless-ap-detail': 'ap-detail',
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

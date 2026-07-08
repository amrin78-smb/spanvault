'use strict';

/**
 * reportScheduler.js — SpanVault scheduled reports
 *
 * Runs saved reports on a cadence (daily/weekly/monthly) and emails the
 * rendered HTML to the configured recipients. Polls saved_reports.next_run_at
 * every 15 minutes from inside the API process.
 *
 * Plain JavaScript only — no TypeScript syntax (matches api/server.js).
 *
 * Report data is fetched by calling the API's own report endpoints over the
 * loopback interface, so the scheduler reuses the exact same query logic the
 * UI uses (single source of truth) rather than duplicating SQL.
 */

const http = require('http');
const nodemailer = require('nodemailer');
const { generateReportPdf, hasPdfRenderer } = require('./reportsPdf');

const API_PORT = parseInt(process.env.SV_API_PORT || '3009', 10);

// ── Scheduler loop ────────────────────────────────────────────
function startReportScheduler(pool, getSmtpSettings) {
  // Check every 15 minutes for due reports.
  setInterval(() => {
    runDueReports(pool, getSmtpSettings).catch((e) =>
      console.error('[Reports] Scheduler tick failed:', e.message));
  }, 15 * 60 * 1000);
  console.log('[Reports] Scheduler started');
}

async function runDueReports(pool, getSmtpSettings) {
  const now = new Date();
  const due = await pool.query(`
    SELECT * FROM saved_reports
    WHERE schedule IS NOT NULL
      AND schedule <> 'none'
      AND recipients IS NOT NULL
      AND recipients <> ''
      AND (next_run_at IS NULL OR next_run_at <= $1)
  `, [now]);

  for (const report of due.rows) {
    try {
      await runAndEmailReport(pool, report, getSmtpSettings);
      const next = calculateNextRun(report);
      await pool.query(`
        UPDATE saved_reports
        SET last_sent_at = NOW(), next_run_at = $2 WHERE id = $1
      `, [report.id, next]);
      console.log(`[Reports] Sent "${report.name}" (#${report.id}); next run ${next.toISOString()}`);
    } catch (e) {
      console.error(`[Reports] Failed to send "${report.name}" (#${report.id}):`, e.message);
      await pool.query(`
        INSERT INTO report_history (report_id, status, error, recipients)
        VALUES ($1, 'failed', $2, $3)
      `, [report.id, e.message, report.recipients]).catch(() => {});
      // Still advance next_run_at so a persistently-failing report doesn't retry
      // every 15 minutes forever.
      const next = calculateNextRun(report);
      await pool.query(`UPDATE saved_reports SET next_run_at = $2 WHERE id = $1`,
        [report.id, next]).catch(() => {});
    }
  }
  return due.rows.length;
}

// ── Next-run computation ──────────────────────────────────────
function calculateNextRun(report) {
  const now = new Date();
  const next = new Date();
  next.setHours(report.schedule_hour != null ? report.schedule_hour : 7, 0, 0, 0);

  if (report.schedule === 'daily') {
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (report.schedule === 'weekly') {
    const targetDay = report.schedule_day != null ? report.schedule_day : 1; // Monday
    let daysUntil = (targetDay - now.getDay() + 7) % 7;
    if (daysUntil === 0 && next <= now) daysUntil = 7;
    next.setDate(now.getDate() + daysUntil);
  } else if (report.schedule === 'monthly') {
    next.setDate(1);
    if (next <= now) next.setMonth(next.getMonth() + 1);
  } else {
    // Unknown cadence — default to daily so we never return a past time.
    if (next <= now) next.setDate(next.getDate() + 1);
  }
  return next;
}

// ── Run + email one report ────────────────────────────────────
async function runAndEmailReport(pool, report, getSmtpSettings) {
  const data = await fetchReportData(report);
  const html = renderReportHtml(report, data);

  const smtp = await getSmtpSettings();
  if (!smtp || !smtp.host) {
    throw new Error('SMTP not configured');
  }

  const port = parseInt(smtp.port, 10) || 587;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });

  const recipients = String(report.recipients).split(',').map((e) => e.trim()).filter(Boolean);
  const mailOptions = {
    from: smtp.from || smtp.user || 'spanvault@nocvault.com',
    to: recipients,
    subject: `SpanVault Report: ${report.name}`,
    html,
  };

  // device-detail / ap-detail are multi-entity reports whose selected entity ids
  // are NOT persisted in saved_reports, so a scheduled run has no entity to render
  // and the PDF would come out as an empty "No entity selected" page. Until entity
  // ids are persisted, skip the PDF for these and send the HTML-only email instead
  // of attaching a misleading empty PDF.
  const isDetailTemplate = report.template === 'device-detail' || report.template === 'ap-detail';

  // If a pdfkit renderer exists for this template, attach the rich PDF alongside
  // the HTML body. A PDF failure must NEVER break the email — on any error we log
  // and fall back to sending the HTML-only message unchanged.
  if (!isDetailTemplate && hasPdfRenderer(report.template)) {
    try {
      const pdfBuffer = await generateReportPdf(pool, {
        template: report.template,
        params: buildReportParams(report),
        meta: {
          title: report.name,
          company: process.env.SV_BRAND || 'SpanVault',
          generatedBy: 'Scheduled report',
          generatedAt: new Date(),
        },
      });
      mailOptions.attachments = [{
        filename: `${report.template}-${isoDate(new Date())}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }];
    } catch (e) {
      console.error(`[Reports] PDF generation failed for "${report.name}" (#${report.id}); sending HTML-only:`, e.message);
    }
  }

  await transporter.sendMail(mailOptions);

  await pool.query(`
    INSERT INTO report_history
      (report_id, status, recipients, report_data)
    VALUES ($1, 'success', $2, $3)
  `, [report.id, report.recipients, JSON.stringify(data)]);

  return { recipients };
}

// ── Fetch report data via the API's own endpoints (loopback) ──
// Maps a saved report to its endpoint + query string, then GETs it from the
// running API on 127.0.0.1 so the rendered email always matches the UI.
function buildReportUrl(report) {
  const p = new URLSearchParams();
  const range = report.date_range || '30d';
  if (range === 'custom' && report.date_from && report.date_to) {
    p.set('range', 'custom');
    p.set('date_from', isoDate(report.date_from));
    p.set('date_to', isoDate(report.date_to));
  } else {
    p.set('range', range);
  }

  const scopeId = report.scope_id;
  switch (report.template) {
    case 'site-summary':
      if (scopeId) p.set('site_id', String(scopeId));
      if (report.sla_target != null) p.set('sla_target', String(report.sla_target));
      return `/api/reports/site-summary?${p}`;
    case 'device-detail':
      if (scopeId) p.set('device_id', String(scopeId));
      return `/api/reports/device-detail?${p}`;
    case 'sla-compliance':
      if (report.scope_type === 'site' && scopeId) p.set('site_id', String(scopeId));
      if (report.scope_type === 'device' && scopeId) p.set('device_id', String(scopeId));
      if (report.sla_target != null) p.set('sla_target', String(report.sla_target));
      return `/api/reports/sla-compliance?${p}`;
    case 'top-worst':
      if (report.scope_type === 'site' && scopeId) p.set('site_id', String(scopeId));
      p.set('metric', 'uptime');
      p.set('limit', '10');
      return `/api/reports/top-worst?${p}`;
    case 'alert-analysis':
      if (report.scope_type === 'site' && scopeId) p.set('site_id', String(scopeId));
      return `/api/reports/alert-analysis?${p}`;
    case 'capacity':
      if (report.scope_type === 'site' && scopeId) p.set('site_id', String(scopeId));
      return `/api/reports/capacity?${p}`;
    case 'executive':
      return `/api/reports/executive?${p}`;
    // Wireless reports are scoped by an optional controller_id (not site/device),
    // and each maps to its OWN endpoint. Without these explicit cases they fell
    // through to network-summary, so the email body + history stored the wrong data.
    case 'wireless-overview':
    case 'wireless-ap-health':
    case 'wireless-clients':
    case 'wireless-rf':
    case 'wireless-capacity':
      if (report.scope_type === 'controller' && scopeId) p.set('controller_id', String(scopeId));
      return `/api/reports/${report.template}?${p}`;
    case 'network-summary':
    default:
      return `/api/reports/network-summary?${p}`;
  }
}

// Build the plain params object the PDF renderer receives — the same stored
// scope/range/target the run already uses to fetch data (mirrors buildReportUrl).
function buildReportParams(report) {
  const range = report.date_range || '30d';
  const params = { range };
  if (range === 'custom' && report.date_from && report.date_to) {
    params.date_from = isoDate(report.date_from);
    params.date_to = isoDate(report.date_to);
  }

  const scopeId = report.scope_id;
  params.scope_type = report.scope_type;
  params.scope_id = scopeId != null ? scopeId : null;

  switch (report.template) {
    case 'site-summary':
      if (scopeId) params.site_id = scopeId;
      if (report.sla_target != null) params.sla_target = report.sla_target;
      break;
    case 'device-detail':
      if (scopeId) params.device_id = scopeId;
      break;
    case 'sla-compliance':
      if (report.scope_type === 'site' && scopeId) params.site_id = scopeId;
      if (report.scope_type === 'device' && scopeId) params.device_id = scopeId;
      if (report.sla_target != null) params.sla_target = report.sla_target;
      break;
    case 'top-worst':
      if (report.scope_type === 'site' && scopeId) params.site_id = scopeId;
      params.metric = 'uptime';
      params.limit = 10;
      break;
    case 'alert-analysis':
      if (report.scope_type === 'site' && scopeId) params.site_id = scopeId;
      break;
    case 'capacity':
      if (report.scope_type === 'site' && scopeId) params.site_id = scopeId;
      break;
    // Wireless reports carry an optional controller_id scope; mirror buildReportUrl
    // so the PDF renderer receives the same params the data fetch used.
    case 'wireless-overview':
    case 'wireless-ap-health':
    case 'wireless-clients':
    case 'wireless-rf':
    case 'wireless-capacity':
      if (report.scope_type === 'controller' && scopeId) params.controller_id = scopeId;
      break;
    case 'executive':
    case 'network-summary':
    default:
      break;
  }
  return params;
}

// Normalise a DATE column (Date object or 'YYYY-MM-DD' string) to YYYY-MM-DD.
function isoDate(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function fetchReportData(report) {
  const url = buildReportUrl(report);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: API_PORT, path: url, headers: { Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Report endpoint ${url} returned ${res.statusCode}`));
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Report fetch timed out')); });
  });
}

// ── HTML email rendering ──────────────────────────────────────
function renderReportHtml(report, data) {
  const baseUrl = (process.env.SV_PUBLIC_URL || '').replace(/\/+$/, '');
  const manageLine = baseUrl
    ? `Manage scheduled reports at <a href="${baseUrl}/reports">${baseUrl}/reports</a>`
    : 'Manage scheduled reports in SpanVault → Reports.';
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Inter, Arial, sans-serif;
               color: #0f172a; margin: 0; padding: 20px; }
        h1 { color: #C8102E; font-size: 24px; margin: 0; }
        .header { border-bottom: 2px solid #C8102E;
                  padding-bottom: 12px; margin-bottom: 20px; }
        .stat { display: inline-block; margin: 8px 16px 8px 0; }
        .stat-value { font-size: 32px; font-weight: 800; }
        .stat-label { font-size: 12px; color: #64748b;
                      text-transform: uppercase; }
        table { width: 100%; border-collapse: collapse;
                margin: 16px 0; }
        th { background: #f4f6f9; padding: 8px 12px;
             text-align: left; font-size: 11px;
             text-transform: uppercase; }
        td { padding: 8px 12px; border-bottom:
             1px solid #e2e8f0; font-size: 13px; }
        .footer { margin-top: 24px; font-size: 11px;
                  color: #94a3b8; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>SpanVault — ${esc(report.name)}</h1>
        <p style="color:#64748b;margin:4px 0">
          ${esc(report.template)} · Generated ${new Date().toLocaleString()}
        </p>
      </div>
      ${renderDataSection(report.template, data)}
      <div class="footer">
        This report was automatically generated by SpanVault Network Monitoring.<br>
        ${manageLine}
      </div>
    </body>
    </html>
  `;
}

function renderDataSection(template, data) {
  if (!data) return '<p>No data available for this report.</p>';

  switch (template) {
    case 'network-summary':
      return `
        <div>
          <div class="stat">
            <div class="stat-value">${data.totals && data.totals.uptime_pct != null ? data.totals.uptime_pct : '—'}%</div>
            <div class="stat-label">Overall Uptime</div>
          </div>
          <div class="stat">
            <div class="stat-value">${data.totals ? data.totals.devices : 0}</div>
            <div class="stat-label">Total Devices</div>
          </div>
          <div class="stat">
            <div class="stat-value">${data.totals ? data.totals.total_alerts : 0}</div>
            <div class="stat-label">Total Alerts</div>
          </div>
        </div>
        <table>
          <tr><th>Site</th><th>Devices</th><th>Uptime %</th>
              <th>Avg ms</th><th>Alerts</th><th>Grade</th></tr>
          ${(data.sites || []).map((s) => `
            <tr>
              <td>${esc(s.site_name)}</td><td>${s.devices}</td>
              <td>${s.uptime_pct}%</td><td>${s.avg_response_ms != null ? s.avg_response_ms : '—'}ms</td>
              <td>${s.alerts_count}</td><td>${s.grade || '—'}</td>
            </tr>
          `).join('')}
        </table>`;

    case 'sla-compliance':
      return `
        <p>SLA Target: ${data.sla_target}% ·
           ${data.summary ? data.summary.meeting : 0}/${data.summary ? data.summary.total : 0}
           devices meeting SLA</p>
        <table>
          <tr><th>Device</th><th>Site</th><th>Uptime %</th>
              <th>Downtime</th><th>SLA Status</th></tr>
          ${(data.devices || []).map((d) => `
            <tr>
              <td>${esc(d.device_name)}</td><td>${esc(d.site_name)}</td>
              <td>${d.uptime_pct != null ? d.uptime_pct : '—'}%</td>
              <td>${d.downtime_minutes} min</td>
              <td>${d.sla_met ? '✅ Pass' : '❌ Fail'}</td>
            </tr>
          `).join('')}
        </table>`;

    case 'executive':
      return `
        <div class="stat">
          <div class="stat-value">${data.overall_uptime_pct != null ? data.overall_uptime_pct : '—'}%</div>
          <div class="stat-label">Overall Uptime</div>
        </div>
        <div class="stat">
          <div class="stat-value">${data.total_downtime_minutes != null ? data.total_downtime_minutes : 0}</div>
          <div class="stat-label">Downtime (min)</div>
        </div>
        <p style="font-size:15px;font-weight:600">${esc(data.headline || '')}</p>
        <table>
          <tr><th>Site</th><th>Uptime %</th><th>Grade</th><th>Incidents</th></tr>
          ${(data.sites_summary || []).map((s) => `
            <tr><td>${esc(s.site)}</td><td>${s.uptime_pct != null ? s.uptime_pct : '—'}%</td>
                <td>${s.health_grade || '—'}</td><td>${s.incidents}</td></tr>
          `).join('')}
        </table>
        ${(data.recommendations || []).length ? `<h3>Recommendations</h3><ul>${
          data.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}`;

    default:
      return `<pre style="font-size:12px;white-space:pre-wrap">${esc(JSON.stringify(data, null, 2))}</pre>`;
  }
}

// Minimal HTML escaping for interpolated text.
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  startReportScheduler,
  runDueReports,
  runAndEmailReport,
  calculateNextRun,
  fetchReportData,
};

'use strict';

/**
 * pdfCharts.js — reusable trend-chart renderer drawn with pdfkit primitives.
 *
 * No new npm dependency, no headless browser. Draws a utilization/availability
 * over-time chart entirely within a caller-supplied box, safe for portrait reports.
 *
 * Public contract:
 *   function renderTrendChart(doc, opts)
 *   module.exports = { renderTrendChart }
 */

// ---- palette / layout constants ----------------------------------------
var GRID = '#E2E8F0';   // light grey gridlines
var AXIS = '#94A3B8';   // slightly darker baseline / ticks
var MUTED = '#64748B';  // muted label text
var INK = '#1E293B';    // near-black restore color

var GUTTER_L = 34;      // left gutter for y labels
var STRIP_B = 14;       // bottom strip for x date labels
var CAPTION_H = 14;     // caption line height above the plot

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- small helpers ------------------------------------------------------

function toMs(t) {
  if (t instanceof Date) {
    var m = t.getTime();
    return isFinite(m) ? m : NaN;
  }
  if (typeof t === 'number') {
    return isFinite(t) ? t : NaN;
  }
  if (typeof t === 'string') {
    var p = Date.parse(t);
    return isFinite(p) ? p : NaN;
  }
  return NaN;
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// short label like "08 Jun"
function fmtDate(ms) {
  var d = new Date(ms);
  return pad2(d.getDate()) + ' ' + MONTHS[d.getMonth()];
}

// Normalize + validate the incoming series. Returns ascending array of
// { ms, v } with finite values only; drops anything unparseable.
function cleanPoints(points, yMax) {
  if (!Array.isArray(points)) return [];
  var out = [];
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (!p) continue;
    var ms = toMs(p.t);
    var v = typeof p.v === 'number' ? p.v : Number(p.v);
    if (!isFinite(ms) || !isFinite(v)) continue;
    out.push({ ms: ms, v: clamp(v, 0, yMax) });
  }
  // ascending by time (caller says ascending, but be robust)
  out.sort(function (a, b) { return a.ms - b.ms; });
  return out;
}

/**
 * renderTrendChart(doc, opts)
 *
 * opts = {
 *   x, y, width, height,   // box to draw within (PDF points)
 *   points,                // [{ t: ISO|Date, v: number }, ...] ascending; may be [] or 1
 *   rangeLabel,            // caption drawn above the plot
 *   yMax = 100,            // top of y scale
 *   ySuffix = '%',         // appended to y labels
 *   color = '#C8102E'      // line + area color
 * }
 *
 * Never throws; draws only inside the given box.
 */
function renderTrendChart(doc, opts) {
  opts = opts || {};
  var x = +opts.x || 0;
  var y = +opts.y || 0;
  var width = +opts.width || 0;
  var height = +opts.height || 0;
  var yMax = isFinite(+opts.yMax) && +opts.yMax > 0 ? +opts.yMax : 100;
  var ySuffix = opts.ySuffix != null ? String(opts.ySuffix) : '%';
  var color = opts.color || '#C8102E';
  var rangeLabel = opts.rangeLabel != null ? String(opts.rangeLabel) : '';

  if (width <= 0 || height <= 0) return; // nothing sane to draw

  // ---- geometry -------------------------------------------------------
  var plotX = x + GUTTER_L;
  var plotY = y + CAPTION_H;
  var plotW = width - GUTTER_L;
  var plotH = height - CAPTION_H - STRIP_B;

  // Guard against degenerate boxes.
  if (plotW <= 4 || plotH <= 4) return;

  // ---- caption --------------------------------------------------------
  if (rangeLabel) {
    doc.fontSize(9).fillColor(MUTED)
       .text(rangeLabel, x, y, { width: width, align: 'left', lineBreak: false });
  }

  var data = cleanPoints(opts.points, yMax);

  // Map a value [0..yMax] to a y coordinate within the plot area.
  function yAt(v) {
    var frac = clamp(v, 0, yMax) / yMax; // 0 = bottom, 1 = top
    return plotY + plotH - frac * plotH;
  }

  // ---- Y axis: gridlines + labels ------------------------------------
  var yTicks = [0, 25, 50, 75, yMax];
  // de-dupe / keep ascending unique (in case yMax === 75 etc.)
  var seen = {};
  var uniqTicks = [];
  for (var ti = 0; ti < yTicks.length; ti++) {
    var tv = yTicks[ti];
    if (tv > yMax) continue;
    if (seen[tv]) continue;
    seen[tv] = true;
    uniqTicks.push(tv);
  }

  doc.fontSize(7);
  for (var g = 0; g < uniqTicks.length; g++) {
    var val = uniqTicks[g];
    var gy = yAt(val);
    doc.moveTo(plotX, gy).lineTo(plotX + plotW, gy)
       .lineWidth(0.5).strokeColor(GRID).stroke();
    doc.fillColor(MUTED)
       .text(val + ySuffix, x, gy - 3.5, {
         width: GUTTER_L - 5, align: 'right', lineBreak: false
       });
  }

  // ---- baseline (x axis) ---------------------------------------------
  var baseY = yAt(0);
  doc.moveTo(plotX, baseY).lineTo(plotX + plotW, baseY)
     .lineWidth(0.6).strokeColor(AXIS).stroke();

  // ---- empty / single-point case -------------------------------------
  if (data.length < 2) {
    doc.fontSize(9).fillColor(MUTED)
       .text('Not enough history for this range',
             plotX, plotY + plotH / 2 - 5,
             { width: plotW, align: 'center', lineBreak: false });
    doc.fillColor(INK).lineWidth(1); // restore
    return;
  }

  // ---- time -> x mapping ---------------------------------------------
  var t0 = data[0].ms;
  var tN = data[data.length - 1].ms;
  var span = tN - t0;

  function xAt(ms) {
    if (span <= 0) return plotX; // all same instant (shouldn't reach here)
    return plotX + ((ms - t0) / span) * plotW;
  }

  // Precompute pixel coords for the series.
  var pts = [];
  for (var d = 0; d < data.length; d++) {
    pts.push([xAt(data[d].ms), yAt(data[d].v)]);
  }

  // ---- X axis: 3..5 date ticks ---------------------------------------
  var tickCount = 4; // -> 4 labels spread across width
  if (span <= 0) tickCount = 1;
  doc.fontSize(7).fillColor(MUTED);
  var labelY = baseY + 3;
  for (var k = 0; k < tickCount; k++) {
    var frac = tickCount === 1 ? 0 : k / (tickCount - 1);
    var ms = t0 + frac * span;
    var tx = plotX + frac * plotW;
    // small tick mark
    doc.moveTo(tx, baseY).lineTo(tx, baseY + 2)
       .lineWidth(0.5).strokeColor(AXIS).stroke();
    // label, anchored so first is left-aligned, last right-aligned, mid centered
    var lw = 48;
    var align = 'center';
    var lx = tx - lw / 2;
    if (k === 0) { align = 'left'; lx = tx; }
    else if (k === tickCount - 1) { align = 'right'; lx = tx - lw; }
    doc.fillColor(MUTED)
       .text(fmtDate(ms), lx, labelY, { width: lw, align: align, lineBreak: false });
  }

  // ---- AREA fill under the line --------------------------------------
  doc.save();
  doc.moveTo(pts[0][0], baseY);
  doc.lineTo(pts[0][0], pts[0][1]);
  for (var a = 1; a < pts.length; a++) doc.lineTo(pts[a][0], pts[a][1]);
  doc.lineTo(pts[pts.length - 1][0], baseY);
  doc.closePath();
  doc.fillColor(color).opacity(0.13).fill();
  doc.opacity(1);
  doc.restore();

  // ---- LINE through the points ---------------------------------------
  doc.moveTo(pts[0][0], pts[0][1]);
  for (var b = 1; b < pts.length; b++) doc.lineTo(pts[b][0], pts[b][1]);
  doc.lineWidth(1.2).strokeColor(color).stroke();

  // ---- dot on the last point -----------------------------------------
  var last = pts[pts.length - 1];
  doc.circle(last[0], last[1], 2.2).fillColor(color).fill();

  // ---- restore drawing state -----------------------------------------
  doc.opacity(1).fillColor(INK).lineWidth(1).strokeColor(INK);
}

module.exports = { renderTrendChart };

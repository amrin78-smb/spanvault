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
//
// yMin exists so a metric whose natural range is NEGATIVE can be charted at its
// real value. Noise floor is the motivating case: it is negative dBm, and while
// this clamped to [0..yMax] every reading floored to 0, so the PDF had to chart
// |dBm| instead and its axis meant the opposite of the on-screen one (bigger =
// quieter, not louder).
function cleanPoints(points, yMin, yMax) {
  if (!Array.isArray(points)) return [];
  var out = [];
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    if (!p) continue;
    var ms = toMs(p.t);
    var v = typeof p.v === 'number' ? p.v : Number(p.v);
    if (!isFinite(ms) || !isFinite(v)) continue;
    out.push({ ms: ms, v: clamp(v, yMin, yMax) });
  }
  // ascending by time (caller says ascending, but be robust)
  out.sort(function (a, b) { return a.ms - b.ms; });
  return out;
}

// Normalize the caller's series into [{ name, color, data }]. Accepts either the
// legacy single-series form (opts.points + opts.color) or the multi-series form
// (opts.series = [{ name, color, points }]), so every existing caller keeps
// working untouched.
function resolveSeries(opts, yMin, yMax, defColor) {
  var raw = Array.isArray(opts.series) && opts.series.length
    ? opts.series
    : [{ name: opts.name || '', color: defColor, points: opts.points }];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i] || {};
    var data = cleanPoints(s.points, yMin, yMax);
    if (!data.length) continue;          // a band this AP does not report is simply absent
    out.push({ name: s.name == null ? '' : String(s.name), color: s.color || defColor, data: data });
  }
  return out;
}

// "Nice" tick values spanning [yMin..yMax]. The old fixed [0,25,50,75,yMax] set
// only made sense for a 0-100 percentage axis; anything else (clients, Mbps,
// negative dBm) got a misleading or near-empty scale.
function axisTicks(yMin, yMax) {
  var span = yMax - yMin;
  if (!(span > 0)) return [yMin];
  var steps = 4;
  var out = [];
  for (var i = 0; i <= steps; i++) {
    var v = yMin + (span * i) / steps;
    // keep one decimal only when the span is small enough to need it
    out.push(span >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  }
  var seen = {}, uniq = [];
  for (var k = 0; k < out.length; k++) {
    if (seen[out[k]]) continue;
    seen[out[k]] = true;
    uniq.push(out[k]);
  }
  return uniq;
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
  var yMax = isFinite(+opts.yMax) ? +opts.yMax : 100;
  var yMin = isFinite(+opts.yMin) ? +opts.yMin : 0;
  if (yMax <= yMin) yMax = yMin + 1;          // degenerate scale guard
  var ySuffix = opts.ySuffix != null ? String(opts.ySuffix) : '%';
  var color = opts.color || '#C8102E';
  var rangeLabel = opts.rangeLabel != null ? String(opts.rangeLabel) : '';

  if (width <= 0 || height <= 0) return; // nothing sane to draw

  var allSeries = resolveSeries(opts, yMin, yMax, color);
  // Only label the bands when there is more than one — a lone series' name is
  // already the chart title, and a one-entry legend is just noise.
  var showLegend = allSeries.length > 1;
  var legendH = showLegend ? 11 : 0;

  // ---- geometry -------------------------------------------------------
  var plotX = x + GUTTER_L;
  var plotY = y + CAPTION_H + legendH;
  var plotW = width - GUTTER_L;
  var plotH = height - CAPTION_H - legendH - STRIP_B;

  // Guard against degenerate boxes.
  if (plotW <= 4 || plotH <= 4) return;

  // ---- caption --------------------------------------------------------
  if (rangeLabel) {
    doc.fontSize(9).fillColor(MUTED)
       .text(rangeLabel, x, y, { width: width, align: 'left', lineBreak: false });
  }

  // ---- legend (multi-series only) -------------------------------------
  if (showLegend) {
    var lx = plotX;
    var ly = y + CAPTION_H;
    doc.fontSize(7);
    for (var li = 0; li < allSeries.length; li++) {
      var sname = allSeries[li].name || ('Series ' + (li + 1));
      var swW = doc.widthOfString(sname) + 16;
      if (lx + swW > plotX + plotW) break;      // never spill outside the box
      doc.rect(lx, ly + 2, 7, 3).fillColor(allSeries[li].color).fill();
      doc.fillColor(MUTED).text(sname, lx + 10, ly, { lineBreak: false });
      lx += swW;
    }
  }

  // Map a value [yMin..yMax] to a y coordinate within the plot area.
  function yAt(v) {
    var frac = (clamp(v, yMin, yMax) - yMin) / (yMax - yMin); // 0 = bottom, 1 = top
    return plotY + plotH - frac * plotH;
  }

  // ---- Y axis: gridlines + labels ------------------------------------
  var uniqTicks = axisTicks(yMin, yMax);

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
  // Sits at zero when zero is inside the scale, otherwise at the bottom of the
  // plot. For a negative-only metric (noise floor) zero is off-scale, so
  // anchoring to yAt(0) would push the axis and its date labels out of the box.
  var baseY = (yMin <= 0 && yMax >= 0) ? yAt(0) : plotY + plotH;
  doc.moveTo(plotX, baseY).lineTo(plotX + plotW, baseY)
     .lineWidth(0.6).strokeColor(AXIS).stroke();

  // ---- empty / single-point case -------------------------------------
  var longest = 0;
  for (var si = 0; si < allSeries.length; si++) {
    if (allSeries[si].data.length > longest) longest = allSeries[si].data.length;
  }
  if (longest < 2) {
    doc.fontSize(9).fillColor(MUTED)
       .text('Not enough history for this range',
             plotX, plotY + plotH / 2 - 5,
             { width: plotW, align: 'center', lineBreak: false });
    doc.fillColor(INK).lineWidth(1); // restore
    return;
  }

  // ---- time -> x mapping ---------------------------------------------
  // Spans EVERY series, not just the first: two bands can start/stop at
  // different times (an AP whose 5GHz radio reports for only part of the
  // window), and scaling each to its own extent would silently misalign them.
  var t0 = Infinity, tN = -Infinity;
  for (var ti2 = 0; ti2 < allSeries.length; ti2++) {
    var dd = allSeries[ti2].data;
    if (dd[0].ms < t0) t0 = dd[0].ms;
    if (dd[dd.length - 1].ms > tN) tN = dd[dd.length - 1].ms;
  }
  var span = tN - t0;

  function xAt(ms) {
    if (span <= 0) return plotX; // all same instant (shouldn't reach here)
    return plotX + ((ms - t0) / span) * plotW;
  }

  // Precompute pixel coords per series.
  var seriesPts = [];
  for (var sp = 0; sp < allSeries.length; sp++) {
    var arr = [];
    var sd = allSeries[sp].data;
    for (var d = 0; d < sd.length; d++) arr.push([xAt(sd[d].ms), yAt(sd[d].v)]);
    seriesPts.push(arr);
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

  for (var s2 = 0; s2 < seriesPts.length; s2++) {
    var pts = seriesPts[s2];
    var scol = allSeries[s2].color;
    if (pts.length < 2) continue;

    // ---- AREA fill under the line ------------------------------------
    // Single-series only. Two translucent fills stacked would muddy each
    // other's colour and make the smaller band unreadable, so multi-series
    // charts are lines-only (matching how the on-screen multi-band charts
    // read, where the fill is decorative rather than load-bearing).
    if (seriesPts.length === 1) {
      doc.save();
      doc.moveTo(pts[0][0], baseY);
      doc.lineTo(pts[0][0], pts[0][1]);
      for (var a = 1; a < pts.length; a++) doc.lineTo(pts[a][0], pts[a][1]);
      doc.lineTo(pts[pts.length - 1][0], baseY);
      doc.closePath();
      doc.fillColor(scol).opacity(0.13).fill();
      doc.opacity(1);
      doc.restore();
    }

    // ---- LINE through the points -------------------------------------
    doc.moveTo(pts[0][0], pts[0][1]);
    for (var b = 1; b < pts.length; b++) doc.lineTo(pts[b][0], pts[b][1]);
    doc.lineWidth(1.2).strokeColor(scol).stroke();

    // ---- dot on the last point ---------------------------------------
    var last = pts[pts.length - 1];
    doc.circle(last[0], last[1], 2.2).fillColor(scol).fill();
  }

  // ---- restore drawing state -----------------------------------------
  doc.opacity(1).fillColor(INK).lineWidth(1).strokeColor(INK);
}

module.exports = { renderTrendChart };

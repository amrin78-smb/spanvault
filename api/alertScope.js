'use strict';
// Shared alert site-scoping. Lives in its own module ON PURPOSE.
//
// This predicate was reimplemented four separate times across the API, which is
// how a site_admin ended up with a dashboard that contradicted itself. Those
// four were unified — and a FIFTH survived in /api/reports/alert-analysis and
// its independently-written twin in reportsPdf.js, which then disagreed with
// everything else the moment the other four were corrected (report said 27,
// dashboard said 18,115, for the same user and window).
//
// api/reportsPdf.js cannot require api/server.js (server.js requires it), so
// keeping the helper in server.js guaranteed the PDF path would keep its own
// copy. Both now require THIS module. If you need alert site scoping anywhere,
// import it from here; do not write a sixth rendering.

// ── Site-scoping for the polymorphic `alerts` table ────────────────────────
// ONE definition of "an alert belongs to site X", used by every read AND every
// write. `alerts` hangs off ONE of six nullable owner columns (device_id,
// agent_id, service_check_id, wireless_ap_id, wireless_controller_id,
// wireless_client_mac — see .ai-codex/schema.md), so a filter that joins only
// `monitored_devices` scopes device alerts and either DROPS or LEAKS every
// wireless/service alert. That is not a corner case on a real estate: of the
// last 7 days' alerts on the production box, 4,213 of 4,249 hang off an AP and
// only a handful off a device.
//
// THE RULE: an alert belongs to the site of its owner, resolved through the
// chain below IN ORDER — device, AP, service check, controller (the four owner
// tables that carry a site_id at all). The same expression decides what a
// site_admin can SEE and what they can ACKNOWLEDGE/RESOLVE, so the dashboard,
// the Alerts page and the write routes can no longer disagree.
//
// This replaced FOUR mutually inconsistent predicates (1.114.1 and earlier):
// an INNER JOIN monitored_devices on /api/dashboard/summary, a LEFT JOIN
// d.site_id on /api/dashboard/ops-summary, this COALESCE on the
// histogram/noisiest/kpi-trends panels, and a device-OR-service pair on GET
// /api/alerts + the ack/resolve writes. Measured for a site_admin holding
// sites {31,35}: the summary card said 0 active / 0 critical while the
// Noisiest panel beside it listed 20 critical AP alerts, and neither the
// Alerts page nor ack/resolve could touch any of them (26 of 27 active alerts
// hang off wireless_ap_id). All four now report 28 active / 20 critical.
//
// An alert that resolves to NO site (agent-scoped, wireless_client_mac-only,
// or an owner row that has since lost its site) is deliberately INVISIBLE to a
// site-scoped caller and UNWRITABLE by them: `NULL = ANY(...)` evaluates to
// NULL, never TRUE, so it fails CLOSED. It is emphatically NOT promoted to
// "visible to everyone" — that is the other tempting reading, and the one
// /api/dashboard/alert-trend used to take with `OR a.device_id IS NULL`, which
// handed a site_admin every OTHER site's wireless and service alerts. Only an
// unscoped caller (admin/super_admin — getSiteFilter() returns null) sees or
// acts on a site-less alert. 80 of 41,139 production rows are site-less today,
// none of them active.
//
// `agents` is NOT part of the chain (it has no site_id of its own); it is
// still LEFT JOINed by ALERT_OWNER_JOINS because /api/dashboard/noisiest needs
// the agent NAME, not for scoping.
const ALERT_SITE_OWNERS = [
  { key: 'device',     table: 'monitored_devices',    alias: 'd',  fk: 'a.device_id',              cap: null },
  { key: 'ap',         table: 'wireless_aps',         alias: 'wa', fk: 'a.wireless_ap_id',         cap: 'has_wireless' },
  { key: 'service',    table: 'service_checks',       alias: 'sc', fk: 'a.service_check_id',       cap: 'has_service_check_id' },
  { key: 'controller', table: 'wireless_controllers', alias: 'wc', fk: 'a.wireless_controller_id', cap: 'has_wireless' },
];

// The standard owner joins + the aliases they expose, both derived from the one
// list above so a new owner can never be added to the predicate and forgotten
// in the joins (or vice versa).
// CAPS IS REQUIRED EVERYWHERE, AND ITS ABSENCE MUST FAIL NARROW.
// An owner whose column does not exist yet on this DB has to be dropped from
// BOTH the predicate and the joins, together. Two real bugs came from getting
// that wrong: alertSiteScope() omitted caps entirely while the joins were
// unconditional, so (a) three dashboard routes 500 on a pre-migration DB with
// "column a.wireless_ap_id does not exist" where they had previously worked,
// and (b) if getAlertCaps()s probe ever failed it cached all-false for the
// process lifetime - the caps-honouring surfaces (list, writes) went narrow
// while the caps-ignoring dashboard stayed wide, reproducing exactly the
// headline-28 / list-0 / ack-does-nothing split this refactor existed to kill.
// Treating a missing caps as "keep every owner" is what allowed that, so the
// default is now the narrowest chain.
function alertOwnersFor(caps) {
  return ALERT_SITE_OWNERS.filter((o) => !o.cap || !!(caps && caps[o.cap]));
}
function alertOwnerJoins(caps) {
  return `${alertOwnersFor(caps)
    .map((o) => `      LEFT JOIN ${o.table} ${o.alias} ON ${o.alias}.id = ${o.fk}`)
    .join(`
`)}
      LEFT JOIN agents               ag ON ag.id = a.agent_id`;
}
function alertOwnerAliases(caps) {
  return alertOwnersFor(caps).reduce((m, o) => { m[o.key] = o.alias; return m; }, {});
}

// The site an alert resolves to, as a SQL expression over `alerts a`.
//   `aliases` — owner key -> an alias the CALLER'S query already LEFT JOINs.
//               An owner with no alias is resolved by a correlated sub-select
//               instead, so the identical predicate also works in a statement
//               that has no joins to hang a filter on (i.e. an UPDATE).
//   `caps`    — getAlertCaps(); an owner whose column doesn't exist yet on this
//               DB is dropped from the chain. Omit it to assume the full schema
//               (what the dashboard aggregates have always done).
// The two renderings were verified equivalent against the production table:
// both selected exactly 40,772 of 41,139 rows for sites {31,35}, with zero
// row-level disagreements.
function alertSiteExpr(caps, aliases) {
  const parts = ALERT_SITE_OWNERS
    .filter((o) => !o.cap || !caps || caps[o.cap])
    .map((o) => ((aliases && aliases[o.key])
      ? `${aliases[o.key]}.site_id`
      : `(SELECT ${o.alias}_s.site_id FROM ${o.table} ${o.alias}_s WHERE ${o.alias}_s.id = ${o.fk})`));
  return parts.length === 1 ? parts[0] : `COALESCE(${parts.join(', ')})`;
}

// Bare WHERE fragment (no leading AND, no outer parens) for a site-scoped
// caller; null when the caller is unscoped, in which case NO clause is added.
function alertSiteWhere(siteFilter, params, opts) {
  if (!siteFilter || !siteFilter.length) return null;
  params.push(siteFilter);
  const o = opts || {};
  return `${alertSiteExpr(o.caps, o.aliases)} = ANY($${params.length}::int[])`;
}

// Read form for a query that can take the standard owner joins: returns the
// joins to splice in after `alerts a`, plus a ` AND <predicate>` fragment.
// Both are empty strings for an unscoped caller, so the query is byte-identical
// to the pre-RBAC one for an admin.
function alertSiteScope(siteFilter, params, caps) {
  const where = alertSiteWhere(siteFilter, params, { caps, aliases: alertOwnerAliases(caps) });
  return where ? { joins: alertOwnerJoins(caps), where: ` AND ${where}` } : { joins: '', where: '' };
}

module.exports = {
  ALERT_SITE_OWNERS,
  alertOwnersFor,
  alertOwnerJoins,
  alertOwnerAliases,
  alertSiteExpr,
  alertSiteWhere,
  alertSiteScope,
};

'use strict';

/**
 * paloalto.js — Palo Alto Networks PAN-OS (PAN-COMMON-MIB, enterprise 25461).
 *
 * Key metrics: session-table utilisation (%), active session count, and
 * GlobalProtect gateway active tunnels. Dataplane/management CPU on PAN-OS is
 * exposed through the standard HOST-RESOURCES hrProcessorLoad table, which the
 * collector core already polls and emits as cpu_pct.
 */

const U = require('./_util');
const ENT = '1.3.6.1.4.1.25461.2.1.2';

const metrics = [
  { name: 'sess_util',   oid: `${ENT}.3.1.0`, kind: 'scalar', desc: 'panSessionUtilization (%)' },
  { name: 'sess_active', oid: `${ENT}.3.3.0`, kind: 'scalar', desc: 'panSessionActive' },
  // panGPGWUtilizationActiveTunnels — GlobalProtect gateway active tunnels.
  { name: 'gp_tunnels',  oid: `${ENT}.5.1.3.0`, kind: 'scalar', desc: 'panGPGWUtilizationActiveTunnels' },
  { name: 'sess_table_util', oid: '1.3.6.1.4.1.25461.2.1.2.3.3.0', kind: 'scalar', desc: 'panSessionUtilization (%)' },
  { name: 'threat_count', oid: '1.3.6.1.4.1.25461.2.1.2.1.19.5.0', kind: 'scalar', desc: 'panThreatCount' },
  { name: 'disk_usage', oid: '1.3.6.1.4.1.25461.2.1.2.1.19.1.0', kind: 'scalar', desc: 'panDiskUsage (%)' },
  { name: 'gp_gw_util', oid: '1.3.6.1.4.1.25461.2.1.2.1.19.3.0', kind: 'scalar', desc: 'panGPGWUtilization (%)' },
];

function parse(raw) {
  const out = [];
  const util = U.first(raw.sess_util);
  if (util !== null) out.push(U.sample('session_util_pct', util, `${ENT}.3.1.0`));
  const active = U.first(raw.sess_active);
  if (active !== null) out.push(U.sample('session_count', active, `${ENT}.3.3.0`));
  const gp = U.first(raw.gp_tunnels);
  if (gp !== null) out.push(U.sample('gp_tunnels', gp, `${ENT}.5.1.3.0`));
  const sessTableUtil = U.first(raw.sess_table_util);
  if (sessTableUtil !== null) out.push(U.sample('session_table_util_pct', sessTableUtil, '1.3.6.1.4.1.25461.2.1.2.3.3.0'));
  const threatCount = U.first(raw.threat_count);
  if (threatCount !== null) out.push(U.sample('threats_blocked', threatCount, '1.3.6.1.4.1.25461.2.1.2.1.19.5.0'));
  const diskUsage = U.first(raw.disk_usage);
  if (diskUsage !== null) out.push(U.sample('disk_usage_pct', diskUsage, '1.3.6.1.4.1.25461.2.1.2.1.19.1.0'));
  const gpGwUtil = U.first(raw.gp_gw_util);
  if (gpGwUtil !== null) out.push(U.sample('gp_gateway_util_pct', gpGwUtil, '1.3.6.1.4.1.25461.2.1.2.1.19.3.0'));
  return out;
}

module.exports = { name: 'paloalto', metrics, parse };

'use strict';

/**
 * fortinet.js — FortiGate / FortiOS (FORTINET-FORTIGATE-MIB, enterprise 12356).
 *
 * Key metrics: CPU & memory usage, active session count, IPsec VPN tunnels up,
 * and HA system mode. FortiGates report CPU/mem via the vendor MIB rather than
 * the standard HOST-RESOURCES table, so we emit cpu_pct / mem_pct here (these
 * override the core's standard-MIB values for this device — see collector.js).
 */

const U = require('./_util');
const ENT = '1.3.6.1.4.1.12356.101';

const metrics = [
  // fgSystemInfo — scalars (instance .0).
  { name: 'cpu',      oid: `${ENT}.4.1.3.0`, kind: 'scalar', desc: 'fgSysCpuUsage (%)' },
  { name: 'mem',      oid: `${ENT}.4.1.4.0`, kind: 'scalar', desc: 'fgSysMemUsage (%)' },
  { name: 'memcap',   oid: `${ENT}.4.1.5.0`, kind: 'scalar', desc: 'fgSysMemCapacity (KB)' },
  { name: 'sessions', oid: `${ENT}.4.1.8.0`, kind: 'scalar', desc: 'fgSysSesCount' },
  // fgVpn — IPsec tunnels currently up.
  { name: 'vpn_up',   oid: `${ENT}.12.1.1.0`, kind: 'scalar', desc: 'fgVpnTunnelUpCount' },
  // fgHaSystemMode: 1=standalone, 2=active-active, 3=active-passive.
  { name: 'ha_mode',  oid: `${ENT}.13.1.1.0`, kind: 'scalar', desc: 'fgHaSystemMode' },
];

function parse(raw) {
  const out = [];
  const cpu = U.first(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, `${ENT}.4.1.3.0`));
  const mem = U.first(raw.mem);
  if (mem !== null) out.push(U.sample('mem_pct', mem, `${ENT}.4.1.4.0`));
  const sessions = U.first(raw.sessions);
  if (sessions !== null) out.push(U.sample('session_count', sessions, `${ENT}.4.1.8.0`));
  const vpn = U.first(raw.vpn_up);
  if (vpn !== null) out.push(U.sample('vpn_tunnels_up', vpn, `${ENT}.12.1.1.0`));
  const ha = U.first(raw.ha_mode);
  if (ha !== null) out.push(U.sample('ha_mode', ha, `${ENT}.13.1.1.0`));
  return out;
}

module.exports = { name: 'fortinet', metrics, parse };

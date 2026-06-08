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
  // fgVpnTunnelTable — per-tunnel status (1=up).
  { name: 'vpn_tun_status', oid: '1.3.6.1.4.1.12356.101.12.2.2.1.20', kind: 'table', desc: 'fgVpnTunEntStatus (1=up)' },
  // fgHaStatistics — per-member sync status (1=synced).
  { name: 'ha_sync', oid: '1.3.6.1.4.1.12356.101.13.2.1.1.9', kind: 'table', desc: 'fgHaStatsSyncStatus (1=synced)' },
  // fgAntivirus — AV signature database version (string).
  { name: 'av_sig_ver', oid: '1.3.6.1.4.1.12356.101.4.2.1.0', kind: 'scalar', desc: 'fgAVSigVersion (string)' },
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
  // VPN tunnels active — count tunnels whose status is up (1).
  if (raw.vpn_tun_status && raw.vpn_tun_status.length) {
    const upCount = U.countWhere(raw.vpn_tun_status, (n) => n === 1);
    out.push(U.sample('vpn_tunnels_active', upCount, '1.3.6.1.4.1.12356.101.12.2.2.1.20'));
  }
  // HA sync status — 1 only if every member reports synced (1).
  if (raw.ha_sync && raw.ha_sync.length) {
    const syncedRows = U.countWhere(raw.ha_sync, (n) => n === 1);
    const synced = syncedRows === raw.ha_sync.length ? 1 : 0;
    out.push(U.sample('ha_sync_status', synced, '1.3.6.1.4.1.12356.101.13.2.1.1.9'));
  }
  // AV signature version — string metric, stored as-is.
  if (raw.av_sig_ver && raw.av_sig_ver.length) {
    out.push(U.sample('av_signature_version', U.str(raw.av_sig_ver[0].value), '1.3.6.1.4.1.12356.101.4.2.1.0'));
  }
  return out;
}

module.exports = { name: 'fortinet', metrics, parse };

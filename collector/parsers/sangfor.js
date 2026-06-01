'use strict';

/**
 * sangfor.js — Sangfor appliances (IAM / NGAF / SSL VPN, enterprise 35047).
 *
 * Key metrics: CPU & memory usage, connected VPN users, and aggregate
 * throughput. Sangfor's private MIB is not publicly standardised; the OIDs
 * below follow the enterprise 35047 system subtree as deployed on IAM/SSL-VPN
 * models. VERIFY against the specific model's MIB if values look wrong — a
 * device that does not answer these simply yields no vendor samples, and the
 * collector core still provides standard-MIB cpu_pct/mem_pct where available.
 */

const U = require('./_util');
const ENT = '1.3.6.1.4.1.35047';

const metrics = [
  { name: 'cpu',       oid: `${ENT}.1.1.1.0`, kind: 'scalar', desc: 'system CPU usage (%)' },
  { name: 'mem',       oid: `${ENT}.1.1.2.0`, kind: 'scalar', desc: 'system memory usage (%)' },
  { name: 'vpn_users', oid: `${ENT}.1.2.1.0`, kind: 'scalar', desc: 'connected VPN users' },
  { name: 'bw_in',     oid: `${ENT}.1.3.1.0`, kind: 'scalar', desc: 'inbound bandwidth (bps)' },
  { name: 'bw_out',    oid: `${ENT}.1.3.2.0`, kind: 'scalar', desc: 'outbound bandwidth (bps)' },
];

function parse(raw) {
  const out = [];
  const cpu = U.first(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, `${ENT}.1.1.1.0`));
  const mem = U.first(raw.mem);
  if (mem !== null) out.push(U.sample('mem_pct', mem, `${ENT}.1.1.2.0`));
  const users = U.first(raw.vpn_users);
  if (users !== null) out.push(U.sample('vpn_users', users, `${ENT}.1.2.1.0`));
  const bin = U.first(raw.bw_in);
  if (bin !== null) out.push(U.sample('bandwidth_in_bps', bin, `${ENT}.1.3.1.0`));
  const bout = U.first(raw.bw_out);
  if (bout !== null) out.push(U.sample('bandwidth_out_bps', bout, `${ENT}.1.3.2.0`));
  return out;
}

module.exports = { name: 'sangfor', metrics, parse };

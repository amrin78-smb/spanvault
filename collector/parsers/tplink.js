'use strict';

/**
 * tplink.js — TP-Link Omada access points / controllers (enterprise 11863).
 *
 * Key metrics: associated client count and per-SSID traffic. TP-Link's private
 * SNMP MIB coverage varies by Omada firmware; the OIDs below follow the
 * enterprise 11863 wireless subtree. VERIFY against the deployed model's MIB —
 * a device that does not answer simply yields no vendor samples, and standard
 * IF-MIB counters still come from the collector core.
 */

const U = require('./_util');

const ENT = '1.3.6.1.4.1.11863';
// Omada AP wireless subtree (model-dependent).
const CLIENT_COUNT = `${ENT}.6.1.1.1.0`;   // total associated clients
const SSID_NAME    = `${ENT}.6.1.2.1.1.2`; // per-SSID name
const SSID_TRAFFIC = `${ENT}.6.1.2.1.1.5`; // per-SSID total bytes

const metrics = [
  { name: 'clients',     oid: CLIENT_COUNT, kind: 'scalar', desc: 'total associated clients' },
  { name: 'ssid_name',   oid: SSID_NAME,    kind: 'table',  desc: 'per-SSID name' },
  { name: 'ssid_bytes',  oid: SSID_TRAFFIC, kind: 'table',  desc: 'per-SSID total bytes' },
];

function parse(raw) {
  const out = [];
  const clients = U.first(raw.clients);
  if (clients !== null) out.push(U.sample('client_count', clients, CLIENT_COUNT));

  const nameByIdx = new Map((raw.ssid_name || []).map((r) => [U.lastIndex(r.oid), U.str(r.value)]));
  for (const r of raw.ssid_bytes || []) {
    const idx = U.lastIndex(r.oid);
    const v = U.num(r.value);
    if (v !== null) out.push(U.sample('ssid_bytes', v, SSID_TRAFFIC, idx, nameByIdx.get(idx) || `ssid${idx}`));
  }
  return out;
}

module.exports = { name: 'tplink', metrics, parse };

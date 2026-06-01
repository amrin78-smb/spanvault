'use strict';

/**
 * mikrotik.js — MikroTik RouterOS (MIKROTIK-MIB, enterprise 14988).
 *
 * Key metrics: simple-queue throughput (per queue), wireless registered
 * clients, active PPP/PPPoE sessions, and board temperature. CPU is exposed via
 * the standard HOST-RESOURCES hrProcessorLoad table polled by the collector core.
 */

const U = require('./_util');

const MTXR = '1.3.6.1.4.1.14988.1.1';
// mtxrQueueSimpleTable.
const Q_NAME     = `${MTXR}.2.1.1.2`;  // mtxrQueueSimpleName
const Q_BYTES_IN = `${MTXR}.2.1.1.8`;  // mtxrQueueSimpleBytesIn
const Q_BYTES_OUT = `${MTXR}.2.1.1.9`; // mtxrQueueSimpleBytesOut
// mtxrWlRtabTable — wireless registration table (one row per client).
const WL_RTAB = `${MTXR}.1.2.1.1`;     // mtxrWlRtabAddr
// mtxrHl health subtree.
const HL_TEMP = `${MTXR}.3.10.0`;      // mtxrHlTemperature (deci-°C on most boards)
// mtxrPPP active sessions.
const PPP_ACTIVE = `${MTXR}.4.1.0`;    // mtxrPPPActiveSessions

const metrics = [
  { name: 'q_name',   oid: Q_NAME,      kind: 'table',  desc: 'mtxrQueueSimpleName' },
  { name: 'q_in',     oid: Q_BYTES_IN,  kind: 'table',  desc: 'mtxrQueueSimpleBytesIn' },
  { name: 'q_out',    oid: Q_BYTES_OUT, kind: 'table',  desc: 'mtxrQueueSimpleBytesOut' },
  { name: 'wl_rtab',  oid: WL_RTAB,     kind: 'table',  desc: 'mtxrWlRtabAddr (one row/client)' },
  { name: 'temp',     oid: HL_TEMP,     kind: 'scalar', desc: 'mtxrHlTemperature' },
  { name: 'ppp',      oid: PPP_ACTIVE,  kind: 'scalar', desc: 'mtxrPPPActiveSessions' },
];

function parse(raw) {
  const out = [];

  // Wireless clients — count of registration-table rows.
  if (raw.wl_rtab && raw.wl_rtab.length) {
    out.push(U.sample('wireless_clients', raw.wl_rtab.length, WL_RTAB));
  }

  // PPP/PPPoE active sessions.
  const ppp = U.first(raw.ppp);
  if (ppp !== null) out.push(U.sample('pppoe_sessions', ppp, PPP_ACTIVE));

  // Board temperature — RouterOS reports tenths of a degree on most hardware.
  const temp = U.first(raw.temp);
  if (temp !== null) out.push(U.sample('temperature_c', temp > 200 ? temp / 10 : temp, HL_TEMP));

  // Per-queue byte counters, labelled with the queue name.
  const nameByIdx = new Map((raw.q_name || []).map((r) => [U.lastIndex(r.oid), U.str(r.value)]));
  for (const r of raw.q_in || []) {
    const idx = U.lastIndex(r.oid);
    const v = U.num(r.value);
    if (v !== null) out.push(U.sample('queue_bytes_in', v, Q_BYTES_IN, idx, nameByIdx.get(idx) || `queue${idx}`));
  }
  for (const r of raw.q_out || []) {
    const idx = U.lastIndex(r.oid);
    const v = U.num(r.value);
    if (v !== null) out.push(U.sample('queue_bytes_out', v, Q_BYTES_OUT, idx, nameByIdx.get(idx) || `queue${idx}`));
  }

  return out;
}

module.exports = { name: 'mikrotik', metrics, parse };

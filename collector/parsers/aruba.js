'use strict';

/**
 * aruba.js — Aruba Mobility Controller (WLSX-SYSTEMEXT-MIB and WLSX-SWITCH-MIB,
 * enterprise 14823).
 *
 * Key metrics: controller CPU & memory, total access points up, total
 * associated clients, and per-ESSID client counts. PoE-draw on Aruba switches
 * is not in this controller MIB; the wlsxSysExtProcessorLoad scalar provides
 * controller CPU (mapped to cpu_pct).
 */

const U = require('./_util');

const SYSEXT = '1.3.6.1.4.1.14823.2.2.1.2.1';
const CPU = `${SYSEXT}.30.0`; // wlsxSysExtProcessorLoad (%)
const MEM = `${SYSEXT}.31.0`; // wlsxSysExtMemoryUsage (%)

const SWITCH = '1.3.6.1.4.1.14823.2.2.1.1.3';
const AP_COUNT     = `${SWITCH}.1.0`; // wlsxSwitchTotalNumAccessPoints
const CLIENT_COUNT = `${SWITCH}.2.0`; // wlsxSwitchTotalNumStationsAssociated

// WLSX-WLAN-MIB wlsxWlanESSIDEntry: ESSID name + associated station count.
const ESSID_NAME     = '1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1.2';
const ESSID_STATIONS = '1.3.6.1.4.1.14823.2.2.1.5.3.1.10.1.4';

const metrics = [
  { name: 'cpu',        oid: CPU,            kind: 'scalar', desc: 'wlsxSysExtProcessorLoad (%)' },
  { name: 'mem',        oid: MEM,            kind: 'scalar', desc: 'wlsxSysExtMemoryUsage (%)' },
  { name: 'ap_count',   oid: AP_COUNT,       kind: 'scalar', desc: 'wlsxSwitchTotalNumAccessPoints' },
  { name: 'clients',    oid: CLIENT_COUNT,   kind: 'scalar', desc: 'wlsxSwitchTotalNumStationsAssociated' },
  { name: 'essid_name', oid: ESSID_NAME,     kind: 'table',  desc: 'wlsxWlanESSIDEntry ESSID' },
  { name: 'essid_sta',  oid: ESSID_STATIONS, kind: 'table',  desc: 'per-ESSID associated stations' },
];

function parse(raw) {
  const out = [];
  const cpu = U.first(raw.cpu);
  if (cpu !== null) out.push(U.sample('cpu_pct', cpu, CPU));
  const mem = U.first(raw.mem);
  if (mem !== null) out.push(U.sample('mem_pct', mem, MEM));
  const aps = U.first(raw.ap_count);
  if (aps !== null) out.push(U.sample('ap_count', aps, AP_COUNT));
  const clients = U.first(raw.clients);
  if (clients !== null) out.push(U.sample('client_count', clients, CLIENT_COUNT));

  // Per-ESSID client counts, labelled with the ESSID name via if_name.
  const nameByIdx = new Map((raw.essid_name || []).map((r) => [U.lastIndex(r.oid), U.str(r.value)]));
  for (const r of raw.essid_sta || []) {
    const idx = U.lastIndex(r.oid);
    const v = U.num(r.value);
    if (v !== null) out.push(U.sample('ssid_client_count', v, ESSID_STATIONS, idx, nameByIdx.get(idx) || `essid${idx}`));
  }
  return out;
}

module.exports = { name: 'aruba', metrics, parse };

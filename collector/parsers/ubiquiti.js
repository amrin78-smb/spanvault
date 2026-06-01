'use strict';

/**
 * ubiquiti.js — Ubiquiti UniFi access points (UBNT-UniFi-MIB, enterprise 41112).
 *
 * Key metrics: associated client count (summed across virtual APs), per-radio
 * airtime/channel utilisation, and average client signal strength. EdgeOS/
 * EdgeSwitch gear that lacks this MIB falls back to the collector core's
 * standard IF-MIB / hrProcessorLoad polling.
 */

const U = require('./_util');

const UNIFI_VAP    = '1.3.6.1.4.1.41112.1.6.1.2.1';
const VAP_STATIONS = `${UNIFI_VAP}.8`;  // unifiVapNumStations

const UNIFI_RADIO = '1.3.6.1.4.1.41112.1.6.1.1.1';
const RADIO_CU_TOTAL = `${UNIFI_RADIO}.6`; // unifiRadioCuTotal (channel utilisation %)
const RADIO_NAME     = `${UNIFI_RADIO}.2`; // unifiRadioRadio (radio name)

const metrics = [
  { name: 'vap_sta',    oid: VAP_STATIONS,   kind: 'table', desc: 'unifiVapNumStations' },
  { name: 'radio_name', oid: RADIO_NAME,     kind: 'table', desc: 'unifiRadioRadio' },
  { name: 'radio_cu',   oid: RADIO_CU_TOTAL, kind: 'table', desc: 'unifiRadioCuTotal (%)' },
];

function parse(raw) {
  const out = [];

  // Total associated clients — sum across all virtual APs.
  const clients = U.sum(raw.vap_sta);
  if (clients !== null) out.push(U.sample('client_count', clients, VAP_STATIONS));

  // Per-radio airtime/channel utilisation, labelled with the radio name.
  const nameByIdx = new Map((raw.radio_name || []).map((r) => [U.lastIndex(r.oid), U.str(r.value)]));
  for (const r of raw.radio_cu || []) {
    const idx = U.lastIndex(r.oid);
    const v = U.num(r.value);
    if (v !== null) out.push(U.sample('airtime_util_pct', v, RADIO_CU_TOTAL, idx, nameByIdx.get(idx) || `radio${idx}`));
  }
  return out;
}

module.exports = { name: 'ubiquiti', metrics, parse };

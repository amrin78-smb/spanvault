'use strict';

/**
 * forcepoint.js — Forcepoint NGFW (formerly Stonesoft/StoneGate,
 * enterprise 1.3.6.1.4.1.1369).
 *
 * Forcepoint NGFW engines DO expose the standard HOST-RESOURCES MIB (verified:
 * hrProcessorLoad → cpu_pct, hrStorage → mem_pct work), which the collector core
 * already polls — so this parser only needs to identify the vendor (so it's
 * labelled "forcepoint" instead of generic). The firewall-specific metrics live
 * in STONESOFT-NETNODE-/FIREWALL-MIB; their leaf OIDs aren't published, so add
 * them here once verified against an engine (snmpwalk 1.3.6.1.4.1.1369).
 */

const metrics = [];

function parse() {
  return [];
}

module.exports = { name: 'forcepoint', metrics, parse };

'use strict';

/**
 * generic.js — fallback parser for unrecognised vendors.
 *
 * Standard RFC MIBs (HOST-RESOURCES-MIB hrProcessorLoad + hrStorage, and the
 * IF-MIB / ifXTable interface table) are already polled by the collector core
 * on every cycle and written as cpu_pct / mem_pct / if_oper_status / if_*_bps.
 * A generic device therefore needs no vendor-specific OIDs — this parser adds
 * nothing on top of the standard set.
 *
 * It is the parser getParser() returns when detectVendor() cannot match the
 * sysDescr to a known vendor.
 */

// No vendor-specific OIDs — the collector core covers the standard RFC MIBs.
const metrics = [];

function parse(_raw) {
  return [];
}

module.exports = { name: 'generic', metrics, parse };

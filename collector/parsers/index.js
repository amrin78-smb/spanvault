'use strict';

/**
 * SNMP vendor parser registry.
 *
 * - detectVendor(sysDescr) matches a device's sysDescr (.1.3.6.1.2.1.1.1.0)
 *   against known patterns and returns a canonical vendor key.
 * - getParser(vendor) returns the parser module for that key, falling back to
 *   the generic parser for anything unrecognised.
 *
 * Each parser module exports:
 *   {
 *     name: '<vendor key>',
 *     metrics: [ { name, oid, kind: 'scalar' | 'table', desc } ... ],
 *     parse(raw): [ { metric_name, value, oid, if_index, if_name } ... ],
 *   }
 * where `raw` is keyed by each metric definition's `name` and holds the
 * { oid, value } varbinds the collector fetched (GET for scalar, WALK for table).
 */

// sysDescr OID the collector fetches before selecting a parser.
const SYSDESCR_OID = '1.3.6.1.2.1.1.1.0';

const parsers = {
  fortinet:      require('./fortinet'),
  cisco:         require('./cisco'),
  aruba:         require('./aruba'),
  paloalto:      require('./paloalto'),
  sangfor:       require('./sangfor'),
  'hpe-procurve': require('./hpe-procurve'),
  'hpe-comware':  require('./hpe-comware'),
  juniper:       require('./juniper'),
  huawei:        require('./huawei'),
  mikrotik:      require('./mikrotik'),
  ubiquiti:      require('./ubiquiti'),
  dell:          require('./dell'),
  extreme:       require('./extreme'),
  brocade:       require('./brocade'),
  meraki:        require('./meraki'),
  netgear:       require('./netgear'),
  tplink:        require('./tplink'),
  generic:       require('./generic'),
};

/**
 * Ordered match table. ORDER MATTERS — more specific patterns must come first:
 *   - Meraki sysDescr is "Cisco Meraki ..."  → must beat the cisco rule.
 *   - Aruba switches mention HP/Hewlett-Packard → must beat the procurve rule.
 *   - Comware/H3C/3Com gear is often branded HP/HPE → must beat procurve.
 */
const PATTERNS = [
  { vendor: 'meraki',       re: /meraki/i },
  { vendor: 'fortinet',     re: /fortinet|fortigate|forti\s?os/i },
  { vendor: 'paloalto',     re: /palo\s*alto|pan-os/i },
  { vendor: 'sangfor',      re: /sangfor/i },
  { vendor: 'aruba',        re: /aruba/i },
  { vendor: 'hpe-comware',  re: /comware|h3c|3com|hpe?\s+comware/i },
  { vendor: 'hpe-procurve', re: /procurve|hewlett[-\s]?packard|\bhp\b.*switch|\bhp\s+j\d/i },
  { vendor: 'juniper',      re: /juniper|junos/i },
  { vendor: 'huawei',       re: /huawei|\bvrp\b/i },
  { vendor: 'mikrotik',     re: /mikrotik|routeros/i },
  { vendor: 'ubiquiti',     re: /ubiquiti|unifi|edge\s?os|edgeswitch|edgerouter|air\s?os|ubnt/i },
  { vendor: 'dell',         re: /dell|force10|dnos|powerconnect|os10/i },
  { vendor: 'extreme',      re: /extreme|exos|summit\s/i },
  { vendor: 'brocade',      re: /brocade|foundry|fastiron|ironware|\bicx\b/i },
  { vendor: 'netgear',      re: /netgear|prosafe/i },
  { vendor: 'tplink',       re: /tp-?link|omada|tplink/i },
  { vendor: 'cisco',        re: /cisco|nx-os|ios[ -]?xe|catalyst|adaptive security/i },
];

/**
 * Match a sysDescr string to a canonical vendor key. Returns 'generic' when
 * nothing matches (or input is empty).
 */
function detectVendor(sysDescr) {
  const s = sysDescr === null || sysDescr === undefined ? '' : String(sysDescr);
  if (!s) return 'generic';
  for (const p of PATTERNS) {
    if (p.re.test(s)) return p.vendor;
  }
  return 'generic';
}

/**
 * Return the parser module for a vendor key, falling back to generic.
 */
function getParser(vendor) {
  return parsers[vendor] || parsers.generic;
}

module.exports = { SYSDESCR_OID, detectVendor, getParser, parsers };

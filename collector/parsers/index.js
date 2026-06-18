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
  checkpoint:    require('./checkpoint'),
  sonicwall:     require('./sonicwall'),
  forcepoint:    require('./forcepoint'),
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
  { vendor: 'forcepoint',   re: /forcepoint|stonesoft|stonegate|sidewinder/i },
  { vendor: 'sonicwall',    re: /sonicwall|sonic\s?os|sonicos/i },
  { vendor: 'checkpoint',   re: /check\s?point|gaia|svn foundation|\bipso\b/i },
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

// Fallback vendor identification by sysObjectID enterprise number — used only
// when sysDescr is too generic to match (e.g. Check Point Gaia reports a plain
// Linux sysDescr). Keep this conservative: only enterprise numbers that map
// unambiguously to one parser, so it never mis-detects a device sysDescr caught.
const ENTERPRISE_VENDOR = {
  2620: 'checkpoint',
  8741: 'sonicwall',
  1369: 'forcepoint',
};

/**
 * Match a device to a canonical vendor key. Tries sysDescr patterns first, then
 * falls back to the sysObjectID enterprise number. Returns 'generic' when neither
 * identifies the device.
 */
function detectVendor(sysDescr, sysObjectID) {
  const s = sysDescr === null || sysDescr === undefined ? '' : String(sysDescr);
  for (const p of PATTERNS) {
    if (s && p.re.test(s)) return p.vendor;
  }
  const m = String(sysObjectID || '').match(/^\.?1\.3\.6\.1\.4\.1\.(\d+)\b/);
  if (m) {
    const v = ENTERPRISE_VENDOR[parseInt(m[1], 10)];
    if (v) return v;
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

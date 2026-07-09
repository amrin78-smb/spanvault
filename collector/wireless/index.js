'use strict';

// Router for vendor-specific wireless SNMP parser modules.

exports.getWirelessParser = function (vendor) {
  const parsers = {
    aruba: require('./aruba'),
    cisco: require('./cisco'),
    fortinet: require('./fortinet'),
    ruckus: require('./ruckus'),
    mikrotik: require('./mikrotik'),
    hpe: require('./hpe'),
    grandstream: require('./grandstream'),
  };
  return parsers[vendor] || null;
};

// Map a detected SNMP vendor key (from the device vendor parser registry, e.g.
// 'cisco','aruba','fortinet','mikrotik','ubiquiti','tplink','hpe-procurve',
// 'hpe-comware','meraki','huawei') to a wireless parser key.
// Returns null when no wireless parser fits.
exports.wirelessVendorFor = function (deviceVendor) {
  if (!deviceVendor) return null;
  const v = String(deviceVendor).toLowerCase().trim();

  const map = {
    aruba: 'aruba',
    cisco: 'cisco',
    // NOTE: 'meraki' is deliberately NOT mapped. Meraki cloud APs do not
    // implement the AIRESPACE / CISCO-LWAPP MIBs the cisco parser walks, so
    // the old meraki→cisco mapping made every poll silently return 0 APs
    // forever. Returning null makes wirelessCollector fail loudly instead
    // ('no wireless SNMP parser for vendor …'), which is visible and honest.
    fortinet: 'fortinet',
    ruckus: 'ruckus',
    mikrotik: 'mikrotik',
    grandstream: 'grandstream',
    'hpe-procurve': 'hpe',
    'hpe-comware': 'hpe',
    hpe: 'hpe',
  };

  if (map[v]) return map[v];

  // Prefix-based fallback (e.g. 'hpe-anything' -> 'hpe').
  if (v.startsWith('hpe')) return 'hpe';

  // Vendors with no wireless parser: ubiquiti, tplink, huawei, etc.
  return null;
};

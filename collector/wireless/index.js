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
    meraki: 'cisco', // Meraki is Cisco; closest SNMP fit
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

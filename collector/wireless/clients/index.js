'use strict';

// Router for vendor-specific wireless CLIENT parser modules. Each module exports
// async parseClients(session, apMap) where apMap = { byName: Map, byMac: Map }
// of AP name/MAC -> AP row ({ id, name, mac_address }); it returns an array of
// client objects matching the wireless_clients schema (controller_id/vendor are
// added by the collector). Returns null for vendors without a client parser.
exports.getClientParser = function (vendor) {
  const parsers = {
    aruba:    require('./aruba'),
    cisco:    require('./cisco'),
    ruckus:   require('./ruckus'),
    mikrotik: require('./mikrotik'),
    hpe:      require('./hpe'),
  };
  return parsers[vendor] || null;
};

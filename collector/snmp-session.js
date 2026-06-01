'use strict';

/**
 * snmp-session.js — shared net-snmp session + helpers.
 *
 * Used by both the collector (collector.js) and the API (server.js, via
 * discovery.js) so session creation, OID constants, and the walk/get helpers
 * stay identical across discovery and polling. Plain JavaScript only.
 */

const snmp = require('net-snmp');

// Standard MIB OIDs (scalars carry the trailing instance .0).
const OID = {
  sysDescr:        '1.3.6.1.2.1.1.1.0',
  sysName:         '1.3.6.1.2.1.1.5.0',
  sysUpTime:       '1.3.6.1.2.1.1.3.0',
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',   // table: per-processor load %
  hrStorageType:   '1.3.6.1.2.1.25.2.3.1.2',   // table: storage type OID
  hrStorageSize:   '1.3.6.1.2.1.25.2.3.1.5',   // table: total units
  hrStorageUsed:   '1.3.6.1.2.1.25.2.3.1.6',   // table: used units
  ifName:          '1.3.6.1.2.1.31.1.1.1.1',   // ifXTable
  ifHCInOctets:    '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets:   '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed:     '1.3.6.1.2.1.31.1.1.1.15',   // ifXTable: speed in Mbps
  ifAlias:         '1.3.6.1.2.1.31.1.1.1.18',   // ifXTable: admin-configured description
  ifOperStatus:    '1.3.6.1.2.1.2.2.1.8',      // ifTable: 1=up
  ifDescr:         '1.3.6.1.2.1.2.2.1.2',      // fallback name
  ifPhysAddress:   '1.3.6.1.2.1.2.2.1.6',      // ifTable: MAC address
};
const HR_STORAGE_RAM = '1.3.6.1.2.1.25.2.1.2'; // hrStorageRam type

// Build an SNMP session from a device row's stored credentials.
function createSession(device, timeoutMs) {
  const port = device.snmp_port || 161;
  const opts = { port, timeout: timeoutMs || 3000, retries: 1 };
  if (String(device.snmp_version) === '3') {
    opts.version = snmp.Version3;
    const user = {
      name: device.snmp_v3_user || '',
      level: device.snmp_v3_priv_pass
        ? snmp.SecurityLevel.authPriv
        : (device.snmp_v3_auth_pass ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv),
      authProtocol: snmp.AuthProtocols.sha,
      authKey: device.snmp_v3_auth_pass || undefined,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: device.snmp_v3_priv_pass || undefined,
    };
    return snmp.createV3Session(device.ip_address, user, opts);
  }
  opts.version = String(device.snmp_version) === '1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(device.ip_address, device.snmp_community || 'public', opts);
}

// Promisified subtree walk → array of { oid, value } (best-effort, never rejects).
function walk(session, baseOid) {
  return new Promise((resolve) => {
    const out = [];
    try {
      session.subtree(baseOid, 20, (varbinds) => {
        for (const vb of varbinds) {
          if (!snmp.isVarbindError(vb)) out.push({ oid: vb.oid, value: vb.value });
        }
      }, () => resolve(out));
    } catch (_e) {
      resolve(out);
    }
  });
}

// Promisified scalar GET → array of { oid, value } (errors → []).
function get(session, oids) {
  return new Promise((resolve) => {
    try {
      session.get(oids, (err, varbinds) => {
        if (err) return resolve([]);
        const out = [];
        for (const vb of varbinds || []) {
          if (!snmp.isVarbindError(vb)) out.push({ oid: vb.oid, value: vb.value });
        }
        resolve(out);
      });
    } catch (_e) {
      resolve([]);
    }
  });
}

module.exports = { snmp, OID, HR_STORAGE_RAM, createSession, walk, get };

'use strict';

/**
 * topology.js — standalone SNMP topology walker (LLDP + CDP).
 *
 * discoverDevice(device) walks a single SNMP device's LLDP (universal) and, for
 * Cisco gear, CDP neighbor tables and returns the discovered neighbors in a
 * normalised shape:
 *   { protocol, localPort, neighborName, neighborPort, neighborIp? }
 *
 * Used by both the collector (periodic discovery) and the API (on-demand
 * /api/topology/discover). Plain JavaScript only — no TypeScript syntax.
 */

const snmp = require('net-snmp');

// LLDP OID prefixes
const LLDP_REMOTE_SYSNAME    = '1.0.8802.1.1.2.1.4.1.1.9';
const LLDP_REMOTE_PORTDESC   = '1.0.8802.1.1.2.1.4.1.1.8';
const LLDP_REMOTE_MGMT_ADDR  = '1.0.8802.1.1.2.1.4.2.1.3';
const LLDP_LOCAL_PORTDESC    = '1.0.8802.1.1.2.1.7.1.1.4';
const LLDP_REMOTE_SYSDESC    = '1.0.8802.1.1.2.1.4.1.1.10';
const LLDP_REMOTE_CHASSISID      = '1.0.8802.1.1.2.1.4.1.1.5'; // neighbor chassis id (often a MAC)
const LLDP_REMOTE_CHASSIS_SUBTYPE = '1.0.8802.1.1.2.1.4.1.1.4'; // chassis id subtype (4 = macAddress)

// ipNetToMediaTable (ARP) of the FROM device — used to resolve a neighbor's IP
// from its chassis MAC when LLDP doesn't carry a management address.
const IP_NET_TO_MEDIA_PHYS    = '1.3.6.1.2.1.4.22.1.2';        // ipNetToMediaPhysAddress (MAC)
const IP_NET_TO_MEDIA_NETADDR = '1.3.6.1.2.1.4.22.1.3';        // ipNetToMediaNetAddress (IP)

// CDP OID prefixes (Cisco only)
const CDP_NEIGHBOR_DEVICEID  = '1.3.6.1.4.1.9.9.23.1.2.1.1.6';
const CDP_NEIGHBOR_ADDR      = '1.3.6.1.4.1.9.9.23.1.2.1.1.4';
const CDP_NEIGHBOR_PORT      = '1.3.6.1.4.1.9.9.23.1.2.1.1.7';
const CDP_NEIGHBOR_PLATFORM  = '1.3.6.1.4.1.9.9.23.1.2.1.1.8';
const CDP_LOCAL_PORT         = '1.3.6.1.4.1.9.9.23.1.2.1.1.2';

async function walkOid(session, oid) {
  return new Promise((resolve) => {
    const results = {};
    session.subtree(oid, 20,
      (varbinds) => {
        for (const vb of varbinds) {
          if (!snmp.isVarbindError(vb)) {
            results[vb.oid] = vb.value;
          }
        }
      },
      (err) => resolve(err ? {} : results)
    );
  });
}

function createSession(device) {
  const options = { port: device.snmp_port || 161, timeout: 10000, retries: 1 };
  if (device.snmp_version === '3') {
    // SNMPv3 session
    const userOptions = {
      name: device.snmp_v3_user,
      level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha,
      authKey: device.snmp_v3_auth_pass,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: device.snmp_v3_priv_pass,
    };
    return snmp.createV3Session(device.ip_address, userOptions, options);
  }
  const version = device.snmp_version === '1' ?
    snmp.Version1 : snmp.Version2c;
  return snmp.createSession(
    device.ip_address,
    device.snmp_community || 'public',
    { ...options, version }
  );
}

// Normalise a MAC (6-byte SNMP OCTET STRING, or a "aa:bb:.." style string) to
// 12 lowercase hex chars with no separators — the key shape for ARP matching.
function macHex(val) {
  if (Buffer.isBuffer(val) && val.length === 6) {
    return Array.from(val).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (typeof val === 'string') {
    const hex = val.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (hex.length === 12) return hex;
  }
  return null;
}

// Coerce an SNMP IpAddress value (4-byte buffer or dotted string) to "a.b.c.d".
function ipFromBuf(val) {
  if (Buffer.isBuffer(val) && val.length === 4) return Array.from(val).join('.');
  const s = val == null ? '' : val.toString();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s : null;
}

// The IP is also embedded in the ipNetToMedia index suffix (ifIndex.a.b.c.d).
function ipFromArpSuffix(suffix) {
  const p = suffix.split('.');
  if (p.length < 5) return null;
  return p.slice(-4).join('.');
}

// Build a MAC→IP map from the FROM device's ARP table. Correlates
// ipNetToMediaPhysAddress (the MAC) with ipNetToMediaNetAddress (the IP) by
// their shared index suffix; falls back to the IP encoded in the OID index.
function buildArpMap(arpPhys, arpNet) {
  const ipBySuffix = {};
  for (const [oid, val] of Object.entries(arpNet)) {
    const suffix = oid.slice(IP_NET_TO_MEDIA_NETADDR.length + 1);
    ipBySuffix[suffix] = ipFromBuf(val) || ipFromArpSuffix(suffix);
  }
  const macToIp = {};
  for (const [oid, val] of Object.entries(arpPhys)) {
    const suffix = oid.slice(IP_NET_TO_MEDIA_PHYS.length + 1);
    const mac = macHex(val);
    if (!mac) continue;
    const ip = ipBySuffix[suffix] || ipFromArpSuffix(suffix);
    if (ip) macToIp[mac] = ip;
  }
  return macToIp;
}

// Parse the LLDP management-address TLV table into timemark.localport → IPv4.
// The neighbor's IP is encoded in the OID index as:
//   <timemark>.<localPort>.<remIndex>.<addrSubtype>.<addrLen>.<o1>.<o2>.<o3>.<o4>
// addrSubtype 1 = IPv4. Keyed to match the entries map (timemark.localport).
function parseLldpMgmtAddrs(mgmtAddrs) {
  const out = {};
  for (const oid of Object.keys(mgmtAddrs)) {
    const p = oid.slice(LLDP_REMOTE_MGMT_ADDR.length + 1).split('.');
    if (p.length < 9) continue;
    if (p[3] !== '1' || p[4] !== '4') continue; // IPv4 only
    const key = `${p[0]}.${p[1]}`;
    if (!out[key]) out[key] = p.slice(5, 9).join('.');
  }
  return out;
}

async function discoverLldpNeighbors(device) {
  const session = createSession(device);
  const neighbors = [];
  try {
    const [sysnames, portdescs, localports, chassisIds, chassisSubtypes, mgmtAddrs, arpPhys, arpNet] = await Promise.all([
      walkOid(session, LLDP_REMOTE_SYSNAME),
      walkOid(session, LLDP_REMOTE_PORTDESC),
      walkOid(session, LLDP_LOCAL_PORTDESC),
      walkOid(session, LLDP_REMOTE_CHASSISID),
      walkOid(session, LLDP_REMOTE_CHASSIS_SUBTYPE),
      walkOid(session, LLDP_REMOTE_MGMT_ADDR),
      walkOid(session, IP_NET_TO_MEDIA_PHYS),
      walkOid(session, IP_NET_TO_MEDIA_NETADDR),
    ]);

    // ARP MAC→IP map of this (FROM) device — fallback IP resolution.
    const macToIp = buildArpMap(arpPhys, arpNet);
    // Management-address TLV IPs, when the neighbor advertises them.
    const mgmtIpByKey = parseLldpMgmtAddrs(mgmtAddrs);

    // Group by lldpRemTimeMark.lldpRemLocalPortNum.lldpRemIndex
    const entries = {};
    for (const [oid, val] of Object.entries(sysnames)) {
      const parts = oid.split('.');
      const key = parts.slice(-3, -1).join('.');  // timemark.portnum
      const portNum = parts[parts.length - 2];
      if (!entries[key]) entries[key] = { portNum };
      entries[key].neighborName = val.toString();
    }
    for (const [oid, val] of Object.entries(portdescs)) {
      const parts = oid.split('.');
      const key = parts.slice(-3, -1).join('.');
      if (entries[key]) entries[key].neighborPort = val.toString();
    }
    // Chassis id subtype per entry (only subtype 4 = macAddress is a real MAC).
    const chassisSubtypeByKey = {};
    for (const [oid, val] of Object.entries(chassisSubtypes)) {
      const parts = oid.split('.');
      chassisSubtypeByKey[parts.slice(-3, -1).join('.')] = Number(val);
    }
    // Neighbor chassis MAC (lldpRemChassisId) — only when subtype is macAddress.
    for (const [oid, val] of Object.entries(chassisIds)) {
      const parts = oid.split('.');
      const key = parts.slice(-3, -1).join('.');
      if (entries[key] && chassisSubtypeByKey[key] === 4) entries[key].neighborMac = macHex(val);
    }

    // Get local port descriptions
    const localPortMap = {};
    for (const [oid, val] of Object.entries(localports)) {
      const portNum = oid.split('.').pop();
      localPortMap[portNum] = val.toString();
    }

    for (const [key, entry] of Object.entries(entries)) {
      if (entry.neighborName) {
        // Prefer the management-address TLV IP; fall back to the ARP-resolved IP
        // via the neighbor's chassis MAC (HPE/Aruba usually omit the TLV).
        const arpIp = entry.neighborMac ? (macToIp[entry.neighborMac] || null) : null;
        neighbors.push({
          protocol: 'lldp',
          localPort: localPortMap[entry.portNum] || `port${entry.portNum}`,
          neighborName: entry.neighborName,
          neighborPort: entry.neighborPort || '',
          neighborIp: mgmtIpByKey[key] || arpIp || null,
        });
      }
    }
  } catch (e) {
    console.error(`[Topology] LLDP walk error on ${device.name}:`, e.message);
  } finally {
    session.close();
  }
  return neighbors;
}

async function discoverCdpNeighbors(device) {
  // Only for Cisco devices
  const session = createSession(device);
  const neighbors = [];
  try {
    const [deviceIds, addrs, ports, localPorts] = await Promise.all([
      walkOid(session, CDP_NEIGHBOR_DEVICEID),
      walkOid(session, CDP_NEIGHBOR_ADDR),
      walkOid(session, CDP_NEIGHBOR_PORT),
      walkOid(session, CDP_LOCAL_PORT),
    ]);

    const localPortMap = {};
    for (const [oid, val] of Object.entries(localPorts)) {
      const ifIndex = oid.split('.').pop();
      localPortMap[ifIndex] = val.toString();
    }

    for (const [oid, val] of Object.entries(deviceIds)) {
      const parts = oid.split('.');
      const ifIndex = parts[parts.length - 2];
      const devIndex = parts[parts.length - 1];
      const key = `${ifIndex}.${devIndex}`;

      // Find matching addr and port entries
      const addrOid = `${CDP_NEIGHBOR_ADDR}.${key}`;
      const portOid = `${CDP_NEIGHBOR_PORT}.${key}`;

      neighbors.push({
        protocol: 'cdp',
        localPort: localPortMap[ifIndex] || `if${ifIndex}`,
        neighborName: val.toString().replace(/\(.*\)/, '').trim(),
        neighborPort: ports[portOid]?.toString() || '',
        neighborIp: addrs[addrOid] ?
          Array.from(addrs[addrOid]).slice(-4).join('.') : null,
      });
    }
  } catch (e) {
    // CDP not supported — normal for non-Cisco
  } finally {
    session.close();
  }
  return neighbors;
}

async function discoverDevice(device) {
  const results = [];

  // Try LLDP first (universal)
  const lldp = await discoverLldpNeighbors(device);
  results.push(...lldp);

  // Try CDP for Cisco devices
  if (device.device_vendor &&
      device.device_vendor.toLowerCase().includes('cisco')) {
    const cdp = await discoverCdpNeighbors(device);
    // Deduplicate — prefer CDP for Cisco (more data)
    for (const c of cdp) {
      const exists = results.find(r =>
        r.localPort === c.localPort && r.neighborName === c.neighborName);
      if (!exists) results.push(c);
    }
  }

  return results;
}

// ── Neighbor → monitored device matching + persistence ────────────────────────
// Match a discovered neighbor to a monitored device: exact IP first, then by
// name (exact case-insensitive, then either name contains the other). Returns
// the matched device row { id, name, ip_address } or null.
async function matchNeighborDevice(pool, neighbor) {
  if (neighbor.neighborIp) {
    const r = await pool.query(
      `SELECT id, name, ip_address FROM monitored_devices WHERE ip_address = $1 LIMIT 1`,
      [neighbor.neighborIp]
    );
    if (r.rows[0]) return r.rows[0];
  }
  const name = (neighbor.neighborName || '').trim();
  if (name) {
    const r = await pool.query(
      `SELECT id, name, ip_address FROM monitored_devices
        WHERE active = TRUE AND (
          lower(name) = lower($1)
          OR lower(name) LIKE '%' || lower($1) || '%'
          OR lower($1) LIKE '%' || lower(name) || '%'
        )
        ORDER BY (lower(name) = lower($1)) DESC, length(name) ASC
        LIMIT 1`,
      [name]
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

// Upsert all discovered neighbor links for a device (keyed by
// from_device_id + from_port + protocol) and stamp topology_discovered_at.
// Returns the number of links written. `pool` is any pg Pool/Client.
async function storeNeighbors(pool, device, neighbors) {
  let count = 0;
  for (const n of neighbors) {
    // Resolve to_device_id whenever the neighbor matches a monitored device (by
    // IP first, then name). On a re-run this re-resolves via ON CONFLICT, so a
    // neighbor that was unmonitored at first — then added later (e.g. via the
    // "Add to monitoring" flow) — gets linked on the next discovery pass.
    const match = await matchNeighborDevice(pool, n);
    // Backfill to_ip from the matched device when the protocol didn't carry one
    // (LLDP often omits the management address) so the link displays + future
    // IP-based resolution both work.
    const toIp = n.neighborIp || (match && match.ip_address) || null;
    await pool.query(
      `INSERT INTO topology_links
         (from_device_id, from_port, to_device_id, to_ip, to_name, to_port, protocol, discovered_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
       ON CONFLICT (from_device_id, from_port, protocol) DO UPDATE
         SET to_device_id = EXCLUDED.to_device_id,
             to_ip        = EXCLUDED.to_ip,
             to_name      = EXCLUDED.to_name,
             to_port      = EXCLUDED.to_port,
             last_seen_at = NOW()`,
      [device.id, n.localPort || null, match ? match.id : null,
       toIp, n.neighborName || null, n.neighborPort || null, n.protocol || 'lldp']
    );
    count++;
  }
  await pool.query(
    `UPDATE monitored_devices SET topology_discovered_at = NOW() WHERE id = $1`,
    [device.id]
  );
  return count;
}

// Convenience: walk a device then persist its neighbors. Returns link count.
async function discoverAndStore(pool, device) {
  const neighbors = await discoverDevice(device);
  return storeNeighbors(pool, device, neighbors);
}

module.exports = { discoverDevice, matchNeighborDevice, storeNeighbors, discoverAndStore };

'use strict';

/**
 * topology.js — standalone SNMP topology walker (LLDP + CDP).
 *
 * discoverDevice(device) walks a single SNMP device's LLDP (universal) and, for
 * Cisco gear, CDP neighbor tables and returns the discovered neighbors in a
 * normalised shape:
 *   { protocol, localPort, neighborName, neighborPort, neighborIp? }
 * together with a per-protocol OUTCOME, so "this device has no neighbours" is
 * distinguishable from "we could not ask it" — see collector/topologyStatus.js
 * for why that distinction is the whole point.
 *
 * Used by both the collector (periodic discovery) and the API (on-demand
 * /api/topology/discover). Plain JavaScript only — no TypeScript syntax.
 */

const snmp = require('net-snmp');
const ts = require('./topologyStatus');

// LLDP OID prefixes
const LLDP_REMOTE_SYSNAME    = '1.0.8802.1.1.2.1.4.1.1.9';
const LLDP_REMOTE_PORTDESC   = '1.0.8802.1.1.2.1.4.1.1.8';
const LLDP_REMOTE_MGMT_ADDR  = '1.0.8802.1.1.2.1.4.2.1.3';
// ⛔ lldpLocPortDesc lives under lldpLocalSystemData (.3), NOT directly under
// lldpObjects. This was '1.0.8802.1.1.2.1.7.1.1.4' — missing the .3 — and
// 1.0.8802.1.1.2.1.7 does not exist in the LLDP-MIB at all, so the walk always
// came back empty and EVERY link fell through to the `port<N>` fallback below.
// Measured on production before the fix: 66 of 66 LLDP links carried a
// fallback name and 0 carried a real port description, estate-wide, from the
// day the feature shipped. The fallback is why it never looked broken.
const LLDP_LOCAL_PORTDESC    = '1.0.8802.1.1.2.1.3.7.1.4';
// sysName — the CONTROL PROBE. Walking the LLDP table tells us nothing about
// why it was empty; one scalar GET of a MIB-II OID every agent answers
// separates "this device is not talking to us" from "this device says it has
// no neighbours". Without it those two are the same zero rows.
const SYS_NAME               = '1.3.6.1.2.1.1.5.0';
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

/**
 * Walk a subtree, reporting the outcome as well as the rows.
 *
 * ⛔ THIS USED TO RETURN `{}` ON ERROR. A timeout, a refused community, a view
 * that excludes the subtree and a genuinely empty table all produced the same
 * empty object, and every caller read it as "no neighbours". Returning the
 * error alongside the rows is what makes the status in topologyStatus.js
 * possible — and note the rows collected BEFORE an error are kept, because a
 * walk that died half way still tells us about the neighbours it did reach.
 */
async function walkOid(session, oid) {
  return new Promise((resolve) => {
    const rows = {};
    session.subtree(oid, 20,
      (varbinds) => {
        for (const vb of varbinds) {
          if (!snmp.isVarbindError(vb)) {
            rows[vb.oid] = vb.value;
          }
        }
      },
      (err) => resolve({ rows, error: err ? (err.message || String(err)) : null })
    );
  });
}

/** Rows only, for the walks whose failure is not on its own a verdict. */
async function walkRows(session, oid) {
  return (await walkOid(session, oid)).rows;
}

/**
 * Does this SNMP agent answer at all? One GET of sysName.
 * ⛔ Deliberately a DIFFERENT OID TREE from LLDP (MIB-II, not LLDP-MIB): the
 * point is to tell "the agent is dead" apart from "the agent will not give us
 * the LLDP subtree", and a probe inside the subtree under suspicion cannot do
 * that.
 */
async function probeAgent(session) {
  return new Promise((resolve) => {
    try {
      session.get([SYS_NAME], (err, vbs) => {
        if (err) return resolve({ ok: false, error: err.message || String(err) });
        if (!vbs || !vbs.length || snmp.isVarbindError(vbs[0])) {
          return resolve({ ok: false, error: 'SNMP agent returned no value for sysName' });
        }
        resolve({ ok: true, error: null });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
    }
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

/**
 * @returns {Promise<{neighbors:Array, status:string, error:string|null}>}
 */
async function discoverLldpNeighbors(device) {
  const session = createSession(device);
  const neighbors = [];
  let status = ts.NO_DATA;
  let error = null;
  try {
    const [agent, remote, portdescs, localports, chassisIds, chassisSubtypes, mgmtAddrs, arpPhys, arpNet] = await Promise.all([
      probeAgent(session),
      walkOid(session, LLDP_REMOTE_SYSNAME),
      walkRows(session, LLDP_REMOTE_PORTDESC),
      walkRows(session, LLDP_LOCAL_PORTDESC),
      walkRows(session, LLDP_REMOTE_CHASSISID),
      walkRows(session, LLDP_REMOTE_CHASSIS_SUBTYPE),
      walkRows(session, LLDP_REMOTE_MGMT_ADDR),
      walkRows(session, IP_NET_TO_MEDIA_PHYS),
      walkRows(session, IP_NET_TO_MEDIA_NETADDR),
    ]);
    const sysnames = remote.rows;

    // ⛔ THE ONE DECISION THIS FUNCTION EXISTS TO GET RIGHT. Rows win: if the
    // table answered, we have topology regardless of what else hiccuped. With
    // no rows, the control probe decides whether this is the device telling us
    // it has no neighbours or the device not telling us anything.
    if (Object.keys(sysnames).length) {
      status = ts.OK;
      error = remote.error;   // a partial walk — kept, but not a failure
    } else if (!agent.ok) {
      status = ts.UNREACHABLE;
      error = agent.error;
    } else if (remote.error) {
      status = ts.ERROR;
      error = remote.error;
    } else {
      status = ts.NO_DATA;
      // ⛔ PLATFORM-NEUTRAL ON PURPOSE, and it names what we genuinely cannot
      // tell apart. Over SNMP an LLDP table emptied by "LLDP is off", "the
      // neighbour is not advertising" and "this community's view excludes
      // 1.0.8802" are identical. Guessing one would send someone to the wrong
      // box; "check these three" sends them to the right one.
      error = 'The SNMP agent answered but its LLDP neighbour table is empty — '
            + 'LLDP may be disabled on this device or on the switch port facing it, '
            + 'or this community may have no view of the LLDP MIB (1.0.8802.1.1.2).';
    }

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
    status = ts.ERROR;
    error = e.message || String(e);
  } finally {
    session.close();
  }
  return { neighbors, status, error };
}

/**
 * Only called for a Cisco vendor string — see discoverDevice.
 * @returns {Promise<{neighbors:Array, status:string, error:string|null}>}
 */
async function discoverCdpNeighbors(device) {
  const session = createSession(device);
  const neighbors = [];
  let status = ts.NO_DATA;
  let error = null;
  try {
    const [agent, remote, addrs, ports, localPorts] = await Promise.all([
      probeAgent(session),
      walkOid(session, CDP_NEIGHBOR_DEVICEID),
      walkRows(session, CDP_NEIGHBOR_ADDR),
      walkRows(session, CDP_NEIGHBOR_PORT),
      walkRows(session, CDP_LOCAL_PORT),
    ]);
    const deviceIds = remote.rows;
    if (Object.keys(deviceIds).length) {
      status = ts.OK;
      error = remote.error;
    } else if (!agent.ok) {
      status = ts.UNREACHABLE;
      error = agent.error;
    } else if (remote.error) {
      status = ts.ERROR;
      error = remote.error;
    } else {
      status = ts.NO_DATA;
      error = 'The SNMP agent answered but its CDP neighbour table is empty — '
            + 'CDP may be disabled, or this community may have no view of '
            + 'CISCO-CDP-MIB (1.3.6.1.4.1.9.9.23).';
    }

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
    // ⛔ THIS USED TO SWALLOW EVERY ERROR SILENTLY with the comment "CDP not
    // supported — normal for non-Cisco". That was true when the function was
    // called for every device; it is not true now that discoverDevice only
    // calls it for a Cisco vendor string, where a refused CDP walk is a real
    // finding. Non-Cisco is handled as NOT_APPLICABLE before we get here.
    status = ts.ERROR;
    error = e.message || String(e);
  } finally {
    session.close();
  }
  return { neighbors, status, error };
}

/**
 * @returns {Promise<{neighbors:Array, parts:Array, status:string}>}
 */
async function discoverDevice(device) {
  const results = [];

  // Try LLDP first (universal)
  const lldp = await discoverLldpNeighbors(device);
  results.push(...lldp.neighbors);

  // Try CDP for Cisco devices. Anything else is NOT_APPLICABLE — not a zero,
  // not a failure, and it must never move the device's verdict.
  let cdp = { neighbors: [], status: ts.NOT_APPLICABLE, error: null };
  if (ts.cdpApplicable(device)) {
    cdp = await discoverCdpNeighbors(device);
    // Deduplicate — prefer CDP for Cisco (more data)
    for (const c of cdp.neighbors) {
      const exists = results.find(r =>
        r.localPort === c.localPort && r.neighborName === c.neighborName);
      if (!exists) results.push(c);
    }
  }

  const parts = [
    ts.part('lldp', lldp.status, lldp.neighbors.length, lldp.error),
    ts.part('cdp', cdp.status, cdp.neighbors.length, cdp.error),
  ];
  return { neighbors: results, parts, status: ts.collapse(parts) };
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
// from_device_id + from_port + protocol), prune the ones that went away, and
// persist the per-protocol outcome. Returns { links, pruned, status, parts }.
// `pool` is any pg Pool/Client.
//
// @param result {{neighbors:Array, parts:Array, status:string}} from discoverDevice
async function storeNeighbors(pool, device, result) {
  const neighbors = (result && result.neighbors) || [];
  const parts = (result && result.parts) || ts.pendingParts(device);
  // ⛔ THE PASS MARKER COMES FROM THE DATABASE CLOCK, not `new Date()`. The
  // upserts below set last_seen_at = NOW() (the DB's clock) and the prune
  // compares against this value, so taking the marker from the app's clock
  // would make the comparison a race against clock skew — and losing it means
  // deleting links that were just written.
  const t0 = (await pool.query('SELECT NOW() AS t')).rows[0].t;
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

  // ── Prune links that did not come back this pass ───────────────────────────
  // ⛔ ONLY FOR A PROTOCOL THAT RETURNED ROWS (status 'ok'). Pruning on an
  // EMPTY read is the inverted failure: a device whose LLDP went dark for one
  // cycle — or a community whose view was tightened — would have its entire
  // known topology deleted, and the map would go blank with nothing to say
  // why. On 'no_data'/'error'/'unreachable' the last known links are KEPT and
  // topology_status is what tells the operator they may be stale.
  //
  // Per protocol, never estate-wide: an LLDP walk that succeeded says nothing
  // about whether this device's CDP links are still real.
  //
  // This also does the one-off cleanup the lldpLocPortDesc fix above needs.
  // from_port is part of the link's unique key, so a link that was stored as
  // 'port7' and now resolves to its real interface name is a NEW row — without
  // this prune every device would keep a duplicate of every link forever, with
  // the stale copy frozen at its old last_seen_at.
  let pruned = 0;
  for (const pr of parts) {
    if (pr.status !== ts.OK) continue;
    const d = await pool.query(
      `DELETE FROM topology_links
        WHERE from_device_id = $1 AND protocol = $2 AND last_seen_at < $3`,
      // ⛔ `<`, not `<=`. A row written during THIS pass carries a NOW() after
      // t0, so either operator works in practice — but on an exact tie `<=`
      // deletes a link we just stored and `<` keeps a stale one for one more
      // cycle. When a comparison can only be wrong in one of two directions,
      // take the one whose failure is recoverable.
      [device.id, pr.protocol, t0]
    );
    pruned += d.rowCount || 0;
  }

  const status = ts.collapse(parts);
  // ⛔ topology_discovered_at IS STILL STAMPED UNCONDITIONALLY — it means "we
  // last asked at", which is genuinely useful. What changed is that it is no
  // longer the ONLY thing recorded, so it can no longer be mistaken for "we
  // last got an answer at". That mistake is exactly what hid two firewalls
  // reporting nothing for a week. See collector/topologyStatus.js.
  try {
    await pool.query(
      `UPDATE monitored_devices
          SET topology_discovered_at = NOW(),
              topology_status = $2,
              topology_parts  = $3::jsonb,
              topology_error  = $4
        WHERE id = $1`,
      [device.id, status, JSON.stringify(parts), ts.firstError(parts)]
    );
  } catch (e) {
    // An un-migrated DB must not break discovery itself — the links are
    // already written at this point.
    await pool.query(
      `UPDATE monitored_devices SET topology_discovered_at = NOW() WHERE id = $1`,
      [device.id]
    );
  }
  return { links: count, pruned, status, parts };
}

// Convenience: walk a device then persist its neighbors.
// Returns { links, pruned, status, parts }.
async function discoverAndStore(pool, device) {
  const result = await discoverDevice(device);
  return storeNeighbors(pool, device, result);
}

module.exports = {
  discoverDevice, discoverLldpNeighbors, discoverCdpNeighbors,
  matchNeighborDevice, storeNeighbors, discoverAndStore,
};

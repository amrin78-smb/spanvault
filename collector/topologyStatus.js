'use strict';
/**
 * topologyStatus.js — "did neighbour discovery actually work on this device?",
 * answered per protocol.
 *
 * ⛔ THIS EXISTS BECAUSE A FAILED WALK AND AN EMPTY ONE WERE THE SAME THING.
 * `collector/topology.js#walkOid` resolved `{}` on ANY error, and
 * `storeNeighbors` stamped `monitored_devices.topology_discovered_at = NOW()`
 * whether it had stored 40 neighbours or none. So four completely different
 * situations produced one identical result — zero rows and a fresh timestamp:
 *
 *   * the device genuinely has no LLDP neighbours (LLDP switched off on it, or
 *     on the switch ports facing it);
 *   * the SNMP agent did not answer at all (timeout / wrong community);
 *   * the community answered but its VIEW excludes the LLDP subtree; and
 *   * the walk errored part-way through.
 *
 * Found on production 2026-11-18: two Forcepoint firewalls added on 11 Nov had
 * zero links while two older ones had links, and the only thing the UI could
 * say was that all four had been "discovered" that morning. The devices with no
 * links were not even LISTED on the topology page — the Link Table is built
 * from `topology_links`, so a device that discovered nothing is invisible
 * exactly when someone is asking why it found nothing.
 *
 * ⛔ A TIMESTAMP THAT RECORDS THAT WE ASKED IS NOT A RECORD OF AN ANSWER. Same
 * class as LogVault's healthy-collector-with-no-ingest and DDIVault's
 * `poll_status` describing a poll that never runs. The fix is the same shape:
 * name the outcomes, and never let one of them stand in for another.
 */

/** A protocol's outcome. */
const OK             = 'ok';             // the neighbour table answered with rows
const NO_DATA        = 'no_data';        // agent answered, table is empty
const ERROR          = 'error';          // the walk itself failed
const UNREACHABLE    = 'unreachable';    // the SNMP agent did not answer at all
const NOT_APPLICABLE = 'not_applicable'; // this protocol does not apply here
const PENDING        = 'pending';        // never walked yet

const PROTOCOLS = ['lldp', 'cdp'];

/**
 * CDP is Cisco-proprietary, and `discoverDevice` only walks it for a Cisco
 * vendor string. Everywhere else it is NOT_APPLICABLE — not a failure and not a
 * zero. Judging a Forcepoint firewall by whether its CDP table answered is the
 * mistake this whole file is here to stop.
 */
function cdpApplicable(device) {
  const v = device && device.device_vendor;
  return !!v && String(v).toLowerCase().includes('cisco');
}

/**
 * Collapse the applicable parts into one verdict.
 *
 * ⛔ `ok` OUTRANKS `error` HERE — deliberately the OPPOSITE of DDIVault's
 * `api/serverStatus.js`, where any applicable failure wins. The difference is
 * real and must not be "harmonised": DDIVault's capabilities are separate
 * datasets (DHCP scopes and DNS zones), so a failure in one is a hole in the
 * data. LLDP and CDP are two routes to the SAME dataset — this device's
 * neighbours. If LLDP answered with neighbours, a CDP walk that errored on the
 * side has cost us nothing, and reporting the device as failed would send
 * someone to investigate a device whose topology we actually have.
 *
 * `unreachable` still outranks everything: if the agent is not answering, the
 * neighbour list we are holding is simply not current, whatever is in it.
 */
const PRECEDENCE = [UNREACHABLE, OK, ERROR, NO_DATA, PENDING];

function collapse(parts) {
  const live = (parts || []).filter((p) => p && p.status !== NOT_APPLICABLE);
  // No applicable protocol at all should be impossible (LLDP always applies),
  // so say so rather than borrowing one of the real answers.
  if (!live.length) return 'unknown';
  for (const want of PRECEDENCE) {
    if (live.some((p) => p.status === want)) return want;
  }
  return 'unknown';
}

/** One part, normalised and JSON-safe. */
function part(protocol, status, count, error) {
  return {
    protocol,
    status,
    count: Number.isFinite(count) ? count : 0,
    error: error ? String(error) : null,
  };
}

/**
 * The parts for a device that has never been walked. Used so a brand-new device
 * reads `pending` rather than inheriting whichever answer happens to be the
 * column default.
 */
function pendingParts(device) {
  return [
    part('lldp', PENDING, 0, null),
    part('cdp', cdpApplicable(device) ? PENDING : NOT_APPLICABLE, 0, null),
  ];
}

/**
 * Read the stored parts off a `monitored_devices` row.
 *
 * ⛔ Tolerates a NULL / malformed / un-migrated `topology_parts` rather than
 * throwing: this feeds the devices list, and a row written before the column
 * existed must render as "not walked yet", not take the page down.
 */
function storedParts(device) {
  const raw = device && device.topology_parts;
  if (!raw) return pendingParts(device);
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (e) { return pendingParts(device); }
  }
  if (!Array.isArray(arr) || !arr.length) return pendingParts(device);
  return arr
    .filter((p) => p && PROTOCOLS.includes(p.protocol))
    .map((p) => part(p.protocol, p.status || PENDING, Number(p.count), p.error));
}

/**
 * The first error message worth showing for a device, or null.
 * An `ok` part never contributes one — see the precedence note above.
 */
function firstError(parts) {
  const bad = (parts || []).find((p) => p && (p.status === ERROR || p.status === UNREACHABLE) && p.error);
  return bad ? bad.error : null;
}

/** Shape added to an API row so a client never has to re-derive this. */
function describeTopology(device) {
  const parts = storedParts(device);
  const stored = device && device.topology_status;
  // The stored scalar is what the last walk concluded; recollapsing the parts
  // is the fallback for a row written before the column existed.
  const status = stored || collapse(parts);
  const at = device && device.topology_discovered_at;
  return {
    topology_status: status,
    topology_parts: parts,
    topology_error: (device && device.topology_error) || firstError(parts),
    topology_discovered_at: at instanceof Date ? at.toISOString() : (at || null),
  };
}

module.exports = {
  OK, NO_DATA, ERROR, UNREACHABLE, NOT_APPLICABLE, PENDING,
  PROTOCOLS, cdpApplicable, collapse, part, pendingParts, storedParts,
  firstError, describeTopology,
};

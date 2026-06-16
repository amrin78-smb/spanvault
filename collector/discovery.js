'use strict';

/**
 * discovery.js — SNMP sensor discovery + candidate collection.
 *
 * collectCandidates() walks a device once and returns the full set of
 * available sensor candidates (system CPU/memory, per-interface in/out/status,
 * and vendor-specific metrics from the parser registry). The SAME function
 * powers:
 *   - the API discovery endpoint (enumerate what's available + current values)
 *   - the collector's poll cycle (compute values, then filter to enabled keys)
 * so the sensor identity (key + metric_name) is guaranteed consistent.
 *
 * Each candidate carries:
 *   key        — stable sensor_key (e.g. "cpu", "if_3_in", "vpn_tunnels_up")
 *   name       — display name
 *   category   — "system" | "interface" | "vendor"
 *   std_metric — shared metric_name written in backward-compat mode (no sensors)
 *   metric     — unique metric_name saved per sensor + written in selective mode
 *   oid        — OID polled
 *   value      — numeric value (null if unavailable, e.g. bps without a prior sample)
 *   if_index / if_name — interface identity where applicable
 *   unit       — "%", "bps", "count", "°C", "W", "s", "state", or ""
 *
 * Plain JavaScript only — no TypeScript syntax.
 */

const { OID, HR_STORAGE_RAM, createSession, walk, get } = require('./snmp-session');
const { detectVendor, getParser } = require('./parsers');

// ── value coercion ────────────────────────────────────────────
function num(v) {
  if (v === null || v === undefined) return null;
  // Counter64 values (ifHCInOctets / ifHCOutOctets) arrive from net-snmp as an
  // 8-byte big-endian Buffer. Interpreting that as a UTF-8 string yields NaN,
  // which silently dropped every interface bps sample — decode it as a BE
  // unsigned integer instead. (Shorter counter buffers decode the same way.)
  if (Buffer.isBuffer(v)) {
    if (v.length === 0 || v.length > 8) return null;
    let n = 0;
    for (const b of v) n = n * 256 + b;
    return isFinite(n) ? n : null;
  }
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? null : n;
}
function str(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) return v.toString();
  return String(v);
}
function lastIndex(oid) {
  const p = String(oid).split('.');
  return parseInt(p[p.length - 1], 10);
}
function avg(rows) {
  const ns = (rows || []).map((r) => num(r.value)).filter((n) => n !== null);
  if (!ns.length) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

// Format ifHighSpeed (Mbps) as a human-friendly link speed.
function fmtSpeed(mbps) {
  if (!mbps || mbps <= 0) return '';
  if (mbps >= 1000) {
    const g = mbps / 1000;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} Gbps`;
  }
  return `${mbps} Mbps`;
}

// Format ifPhysAddress (OCTET STRING / Buffer) as colon-separated hex MAC.
function fmtMac(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) {
    if (v.length === 0) return '';
    return Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join(':');
  }
  return String(v).trim();
}

// ── labels / units / formatting ───────────────────────────────
const VENDOR_LABELS = {
  cpu_pct: 'CPU Utilization', mem_pct: 'Memory Usage',
  session_count: 'Active Sessions', vpn_tunnels_up: 'Active VPN Tunnels',
  vpn_users: 'VPN Users', ha_mode: 'HA Mode',
  session_util_pct: 'Session Table Utilization', gp_tunnels: 'GlobalProtect Tunnels',
  bandwidth_in_bps: 'Bandwidth In', bandwidth_out_bps: 'Bandwidth Out',
  if_in_errors: 'Interface In Errors', if_out_errors: 'Interface Out Errors',
  temperature_c: 'Temperature', bgp_peers_established: 'BGP Peers Established',
  bgp_peers_total: 'BGP Peers Total', stack_units_total: 'Stack Units',
  stack_units_ok: 'Stack Units OK', poe_power_w: 'PoE Power Draw',
  ap_count: 'Access Points', client_count: 'Wireless Clients',
  ssid_client_count: 'Clients per SSID', airtime_util_pct: 'Airtime Utilization',
  wireless_clients: 'Wireless Clients', pppoe_sessions: 'PPPoE Sessions',
  queue_bytes_in: 'Queue Bytes In', queue_bytes_out: 'Queue Bytes Out',
  uptime_seconds: 'Uptime', ssid_bytes: 'SSID Traffic',
  // Additional vendor sensors (Fortinet / Palo Alto / Cisco).
  vpn_tunnels_active: 'VPN Tunnels Active', ha_sync_status: 'HA Sync Status',
  av_signature_version: 'AV Signature Version',
  session_table_util_pct: 'Session Table Utilization %',
  threats_blocked: 'Threats Blocked (24h)', disk_usage_pct: 'Disk Usage %',
  gp_gateway_util_pct: 'GlobalProtect Gateway Utilization %',
  qos_drop_rate: 'QoS Drop Rate',
};
function humanize(key) {
  if (VENDOR_LABELS[key]) return VENDOR_LABELS[key];
  return String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function unitFor(metric) {
  if (/pct$/.test(metric)) return '%';
  if (/_bps$/.test(metric)) return 'bps';
  if (/bytes/.test(metric)) return 'bytes';
  if (/_w$/.test(metric)) return 'W';
  if (/temperature/.test(metric)) return '°C';
  if (/uptime/.test(metric)) return 's';
  if (/(count|sessions|tunnels|users|peers|clients|units|ap_count)/.test(metric)) return 'count';
  return '';
}
function fmtBps(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(n)} bps`;
}
function fmtValue(value, unit) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  switch (unit) {
    case '%':     return `${Math.round(n)}%`;
    case 'bps':   return fmtBps(n);
    case 'W':     return `${n.toFixed(1)} W`;
    case '°C':    return `${n.toFixed(1)} °C`;
    case 's':     return `${Math.round(n)} s`;
    case 'state': return n === 1 ? 'Up' : 'Down';
    case 'count': return `${Math.round(n)}`;
    default:      return `${n}`;
  }
}
// Human-readable ifOperStatus label (RFC 2863). The stored sensor value stays a
// 0/1 numeric (collector down-detection + graphs depend on that), but the
// discovery modal shows the full operational state here.
function ifOperLabel(n) {
  switch (Number(n)) {
    case 1:  return 'Up';
    case 2:  return 'Down';
    case 3:  return 'Testing';
    case 4:  return 'Unknown';
    case 5:  return 'Dormant';
    default: return 'Down';
  }
}

// ── vendor OID fetch (mirrors collector's metric def kinds) ────
async function fetchVendorRaw(session, parser) {
  const raw = {};
  for (const m of parser.metrics) {
    raw[m.name] = m.kind === 'table' ? await walk(session, m.oid) : await get(session, [m.oid]);
  }
  return raw;
}

/**
 * Walk a device and build all available sensor candidates.
 * @param session  open net-snmp session
 * @param vendor   detected vendor key (selects the parser)
 * @param prev     Map<ifIndex,{inOctets,outOctets,ts}> for bps deltas (mutated)
 * @param now      Date.now() of this collection
 * @param want     optional { cpu, mem, iface, vendor } to skip categories
 */
async function collectCandidates(session, vendor, prev, now, want) {
  want = want || { cpu: true, mem: true, iface: true, vendor: true };
  const candidates = [];

  // System CPU / memory — may also be supplied by the vendor parser below.
  let cpuVal = null, cpuOid = OID.hrProcessorLoad;
  let memVal = null, memOid = OID.hrStorageUsed;

  if (want.cpu) {
    cpuVal = avg(await walk(session, OID.hrProcessorLoad));
  }
  if (want.mem) {
    const [types, sizes, useds] = await Promise.all([
      walk(session, OID.hrStorageType),
      walk(session, OID.hrStorageSize),
      walk(session, OID.hrStorageUsed),
    ]);
    const sizeByIdx = new Map(sizes.map((s) => [lastIndex(s.oid), num(s.value)]));
    const usedByIdx = new Map(useds.map((u) => [lastIndex(u.oid), num(u.value)]));
    for (const t of types) {
      if (String(t.value).indexOf(HR_STORAGE_RAM) !== -1) {
        const idx = lastIndex(t.oid);
        const size = sizeByIdx.get(idx);
        const used = usedByIdx.get(idx);
        if (size > 0 && used !== null && used >= 0) { memVal = (used / size) * 100; break; }
      }
    }
  }

  // Interfaces — oper status + in/out bps (bps needs a prior counter sample).
  if (want.iface) {
    const [names, descrs, aliases, speeds, macs, opers, inOct, outOct] = await Promise.all([
      walk(session, OID.ifName),
      walk(session, OID.ifDescr),
      walk(session, OID.ifAlias),
      walk(session, OID.ifHighSpeed),
      walk(session, OID.ifPhysAddress),
      walk(session, OID.ifOperStatus),
      walk(session, OID.ifHCInOctets),
      walk(session, OID.ifHCOutOctets),
    ]);
    const nameByIdx = new Map(names.map((n) => [lastIndex(n.oid), str(n.value)]));
    const descrByIdx = new Map(descrs.map((d) => [lastIndex(d.oid), str(d.value)]));
    const aliasByIdx = new Map(aliases.map((a) => [lastIndex(a.oid), str(a.value)]));
    const speedByIdx = new Map(speeds.map((s) => [lastIndex(s.oid), num(s.value)]));
    const macByIdx = new Map(macs.map((m) => [lastIndex(m.oid), fmtMac(m.value)]));
    const inByIdx = new Map(inOct.map((o) => [lastIndex(o.oid), num(o.value)]));
    const outByIdx = new Map(outOct.map((o) => [lastIndex(o.oid), num(o.value)]));

    for (const o of opers) {
      const idx = lastIndex(o.oid);
      const ifName = nameByIdx.get(idx) || descrByIdx.get(idx) || `if${idx}`;
      const operRaw = num(o.value);
      const operUp = operRaw === 1 ? 1 : 0;

      // Enrichment from ifXTable: admin description, link speed, MAC.
      const alias = (aliasByIdx.get(idx) || '').trim();
      const descr = (descrByIdx.get(idx) || '').trim();
      const speed = fmtSpeed(speedByIdx.get(idx));
      const mac = macByIdx.get(idx) || '';
      // Show the alias only when it adds info beyond the interface name/descr.
      const showAlias = alias && alias !== ifName && alias !== descr;

      // Full sensor name suffix: " [alias] · speed" (either part optional).
      let suffix = '';
      if (showAlias) suffix += ` [${alias}]`;
      if (speed) suffix += ` · ${speed}`;
      // Modal second-line meta: "alias · speed · mac" (no brackets; each optional).
      const meta = [showAlias ? alias : '', speed, mac].filter(Boolean).join(' · ');

      const mk = (dir, keySfx, stdMetric, metricSfx, oidBase, value, unit) => ({
        key: `if_${idx}_${keySfx}`,
        name: `${ifName} — ${dir}${suffix}`,
        base_name: `${ifName} — ${dir}`,
        meta,
        category: 'interface',
        std_metric: stdMetric, metric: `if_${idx}_${metricSfx}`,
        oid: `${oidBase}.${idx}`, value, if_index: idx, if_name: ifName, unit,
        speed_mbps: speedByIdx.get(idx) || null,
      });

      const statusCand = mk('Status', 'status', 'if_oper_status', 'oper', OID.ifOperStatus, operUp, 'state');
      // Display the full RFC 2863 operational state; stored value stays 0/1.
      statusCand.display_value = ifOperLabel(operRaw);
      candidates.push(statusCand);

      const curIn = inByIdx.get(idx);
      const curOut = outByIdx.get(idx);
      const p = prev ? prev.get(idx) : null;
      let inBps = null, outBps = null;
      if (p && curIn !== null && curOut !== null) {
        const dt = (now - p.ts) / 1000;
        if (dt > 0) {
          const dIn = curIn - p.inOctets;
          const dOut = curOut - p.outOctets;
          if (dIn >= 0) inBps = (dIn * 8) / dt;
          if (dOut >= 0) outBps = (dOut * 8) / dt;
        }
      }
      if (prev && curIn !== null && curOut !== null) {
        prev.set(idx, { inOctets: curIn, outOctets: curOut, ts: now });
      }
      candidates.push(mk('In', 'in', 'if_in_bps', 'in_bps', OID.ifHCInOctets, inBps, 'bps'));
      candidates.push(mk('Out', 'out', 'if_out_bps', 'out_bps', OID.ifHCOutOctets, outBps, 'bps'));
    }
  }

  // Vendor-specific metrics from the parser registry.
  if (want.vendor && vendor) {
    const parser = getParser(vendor);
    if (parser.metrics.length) {
      let vendorSamples = [];
      try {
        vendorSamples = parser.parse(await fetchVendorRaw(session, parser)) || [];
      } catch (_e) { /* best-effort */ }
      for (const s of vendorSamples) {
        // Vendor CPU/mem are more authoritative than the standard MIB — fold in.
        if (!s.if_index && s.metric_name === 'cpu_pct') { cpuVal = num(s.value); cpuOid = s.oid || cpuOid; continue; }
        if (!s.if_index && s.metric_name === 'mem_pct') { memVal = num(s.value); memOid = s.oid || memOid; continue; }
        const suffixed = s.if_index ? `${s.metric_name}_${s.if_index}` : s.metric_name;
        const unit = unitFor(s.metric_name);
        let name = humanize(s.metric_name);
        if (s.if_name) name = `${name} — ${s.if_name}`;
        candidates.push({
          key: suffixed, name, category: 'vendor',
          std_metric: s.metric_name, metric: suffixed,
          oid: s.oid || null, value: s.value === null || s.value === undefined ? null : Number(s.value),
          if_index: s.if_index || null, if_name: s.if_name || null, unit,
        });
      }
    }
  }

  // Prepend system candidates (CPU then memory) when a value is available.
  const system = [];
  if (want.cpu && cpuVal !== null) {
    system.push({
      key: 'cpu', name: 'CPU Utilization', category: 'system',
      std_metric: 'cpu_pct', metric: 'cpu_pct', oid: cpuOid, value: cpuVal,
      if_index: null, if_name: null, unit: '%',
    });
  }
  if (want.mem && memVal !== null) {
    system.push({
      key: 'mem', name: 'Memory Usage', category: 'system',
      std_metric: 'mem_pct', metric: 'mem_pct', oid: memOid, value: memVal,
      if_index: null, if_name: null, unit: '%',
    });
  }
  return system.concat(candidates);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Bound an SNMP operation so an unreachable device can't hang the request.
function withTimeout(promise, ms, onTimeoutValue) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeoutValue), ms); });
  return Promise.race([promise.then((v) => { clearTimeout(timer); return v; }), timeout]);
}

const TIMED_OUT = Symbol('timed_out');

/**
 * Full discovery for the API: detect vendor, two-pass walk (so interface bps
 * have a delta), and return grouped sensors with formatted current values.
 */
async function discoverDevice(device, overallMs) {
  const session = createSession(device, 4000);
  const run = (async () => {
    const idRows = await get(session, [OID.sysDescr, OID.sysName]);
    const byOid = new Map(idRows.map((r) => [r.oid, r.value]));
    const sysDescr = str(byOid.get(OID.sysDescr));
    const sysName = str(byOid.get(OID.sysName));
    if (!sysDescr && !sysName) {
      return { error: 'Timeout — device unreachable or wrong SNMP credentials' };
    }
    const vendor = detectVendor(sysDescr);
    const prev = new Map();
    // First pass primes the interface counters; second pass yields bps rates.
    await collectCandidates(session, vendor, prev, Date.now());
    await sleep(900);
    const cands = await collectCandidates(session, vendor, prev, Date.now());
    const sensors = cands.map((c) => ({
      key: c.key, name: c.name, category: c.category,
      metric_name: c.metric, oid: c.oid,
      current_value: c.display_value !== undefined ? c.display_value : fmtValue(c.value, c.unit),
      unit: c.unit,
      base_name: c.base_name || c.name, meta: c.meta || '',
    }));
    return { vendor, sysDescr, sysName, sensors };
  })();

  try {
    const result = await withTimeout(run, overallMs || 15000, TIMED_OUT);
    if (result === TIMED_OUT) {
      return { error: 'Timeout — device did not respond within the discovery window' };
    }
    return result;
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

/**
 * Lightweight SNMP reachability test: fetch sysDescr + sysName only.
 */
async function snmpTest(device, overallMs) {
  const session = createSession(device, 3000);
  const run = (async () => {
    const rows = await get(session, [OID.sysDescr, OID.sysName]);
    const byOid = new Map(rows.map((r) => [r.oid, r.value]));
    const sysDescr = str(byOid.get(OID.sysDescr));
    const sysName = str(byOid.get(OID.sysName));
    if (!sysDescr && !sysName) {
      return { success: false, message: 'Timeout — device unreachable or wrong community string' };
    }
    return {
      success: true, vendor: detectVendor(sysDescr), sysDescr, sysName,
      message: 'SNMP connection successful',
    };
  })();

  try {
    const result = await withTimeout(run, overallMs || 10000, TIMED_OUT);
    if (result === TIMED_OUT) {
      return { success: false, message: 'Timeout — device unreachable or wrong community string' };
    }
    return result;
  } finally {
    try { session.close(); } catch (_e) { /* ignore */ }
  }
}

module.exports = { collectCandidates, discoverDevice, snmpTest, fmtValue, unitFor };

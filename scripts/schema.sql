-- SpanVault schema (idempotent — safe to re-run)

CREATE TABLE IF NOT EXISTS monitored_devices (
  id                        SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL,
  ip_address                TEXT NOT NULL,
  device_type               TEXT,
  site_id                   INTEGER,
  site_name                 TEXT,
  netvault_device_id        INTEGER,
  snmp_enabled              BOOLEAN NOT NULL DEFAULT FALSE,
  snmp_version              TEXT    NOT NULL DEFAULT '2c',
  snmp_community            TEXT    DEFAULT 'public',
  snmp_port                 INTEGER NOT NULL DEFAULT 161,
  snmp_v3_user              TEXT,
  snmp_v3_auth_pass         TEXT,
  snmp_v3_priv_pass         TEXT,
  poll_interval_seconds     INTEGER NOT NULL DEFAULT 300,
  ping_threshold_ms         INTEGER NOT NULL DEFAULT 500,
  ping_failures_before_down INTEGER NOT NULL DEFAULT 3,
  current_status            TEXT    NOT NULL DEFAULT 'unknown',
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  last_response_ms          NUMERIC,
  last_checked_at           TIMESTAMPTZ,
  last_seen_at              TIMESTAMPTZ,
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Detected SNMP vendor (populated by the collector's vendor parser system).
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS device_vendor TEXT;
-- Columns the reports/dashboard depend on. These also live in the CREATE TABLE
-- above, but CREATE TABLE IF NOT EXISTS is a no-op on a DB whose table predates
-- them — so guard each one idempotently or the executive report (and others)
-- 500 with "column ... does not exist" on an older deployment.
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS site_id               INTEGER;
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS site_name             TEXT;
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS poll_interval_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS active                 BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mdev_ip     ON monitored_devices(ip_address);
CREATE INDEX        IF NOT EXISTS idx_mdev_nvid   ON monitored_devices(netvault_device_id);
CREATE INDEX        IF NOT EXISTS idx_mdev_site   ON monitored_devices(site_id);
CREATE INDEX        IF NOT EXISTS idx_mdev_status ON monitored_devices(current_status);

CREATE TABLE IF NOT EXISTS ping_results (
  id              BIGSERIAL PRIMARY KEY,
  device_id       INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_ms     NUMERIC,
  packet_loss_pct NUMERIC,
  status          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ping_device_ts ON ping_results(device_id, ts DESC);

CREATE TABLE IF NOT EXISTS snmp_results (
  id          BIGSERIAL PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  oid         TEXT,
  metric_name TEXT NOT NULL,
  value       NUMERIC,
  if_index    INTEGER,
  if_name     TEXT
);
CREATE INDEX IF NOT EXISTS idx_snmp_device_metric_ts ON snmp_results(device_id, metric_name, ts DESC);

-- Per-device sensor selection (PRTG-style). Populated by SNMP discovery; the
-- collector polls only enabled sensors when any row exists for a device.
CREATE TABLE IF NOT EXISTS device_sensors (
  id           SERIAL PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  sensor_key   TEXT NOT NULL,      -- unique key e.g. "cpu", "mem", "if_Gi0/0_bps_in"
  sensor_name  TEXT NOT NULL,      -- display name e.g. "GigabitEthernet0/0 — In"
  category     TEXT NOT NULL,      -- "system", "interface", "vendor"
  metric_name  TEXT NOT NULL,      -- matches snmp_results.metric_name
  oid          TEXT,               -- OID being polled
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sensors_key
  ON device_sensors(device_id, sensor_key);

-- Custom user-defined OID sensors. is_custom marks rows created by hand via the
-- API (arbitrary OID); custom_label/custom_unit drive the device-detail graph.
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS is_custom    BOOLEAN DEFAULT FALSE;
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS custom_label TEXT;
ALTER TABLE device_sensors ADD COLUMN IF NOT EXISTS custom_unit  TEXT;

CREATE TABLE IF NOT EXISTS alerts (
  id              SERIAL PRIMARY KEY,
  device_id       INTEGER REFERENCES monitored_devices(id) ON DELETE CASCADE,
  alert_type      TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'warning',
  message         TEXT,
  metric_value    NUMERIC,
  triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_device ON alerts(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_unique
  ON alerts(device_id, alert_type) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS alert_rules (
  id         SERIAL PRIMARY KEY,
  device_id  INTEGER REFERENCES monitored_devices(id) ON DELETE CASCADE,
  metric     TEXT NOT NULL,
  operator   TEXT NOT NULL DEFAULT '>',
  threshold  NUMERIC NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'warning',
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_device ON alert_rules(device_id);

-- ── Multi-level alert rules (global / site / device inheritance) ──────────────
-- scope decides where a rule applies; site_id mirrors the denormalised site
-- grouping on monitored_devices (which is NOT unique, so no FK is possible).
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS scope           TEXT NOT NULL DEFAULT 'global';
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS site_id         INTEGER;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS site_name       TEXT;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS notify_recovery BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS description     TEXT;
-- Some condition types (device_down, interface_down) carry no threshold.
ALTER TABLE alert_rules ALTER COLUMN threshold DROP NOT NULL;
-- Backfill scope for rules created before the scope column existed.
UPDATE alert_rules SET scope = 'device' WHERE device_id IS NOT NULL AND scope = 'global';
CREATE INDEX IF NOT EXISTS idx_alert_rules_scope ON alert_rules(scope, site_id);
-- Supported metrics: device_down, response_time, packet_loss, cpu_pct, mem_pct,
-- interface_down, snmp_no_data, bandwidth_pct.

CREATE TABLE IF NOT EXISTS availability_summary (
  id              SERIAL PRIMARY KEY,
  device_id       INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  uptime_pct      NUMERIC,
  avg_response_ms NUMERIC,
  min_response_ms NUMERIC,
  max_response_ms NUMERIC,
  total_checks    INTEGER NOT NULL DEFAULT 0,
  failed_checks   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_avail_device_date ON availability_summary(device_id, date);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id         SERIAL PRIMARY KEY,
  device_id  INTEGER REFERENCES monitored_devices(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_maint_time ON maintenance_windows(starts_at, ends_at);

-- ── Device dependencies (parent-child) for alert suppression ──────────────────
-- When a parent device is down, alerts for its children are suppressed (the
-- child outage is assumed to be a consequence of the parent's outage).
CREATE TABLE IF NOT EXISTS device_dependencies (
  id               SERIAL PRIMARY KEY,
  child_device_id  INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  parent_device_id INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT no_self_dependency CHECK (child_device_id <> parent_device_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dep_child_parent
  ON device_dependencies(child_device_id, parent_device_id);
CREATE INDEX IF NOT EXISTS idx_dep_parent
  ON device_dependencies(parent_device_id);

-- Alerts can be marked suppressed (resolved because a parent is down).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS suppressed_by INTEGER
  REFERENCES monitored_devices(id) ON DELETE SET NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS suppression_reason TEXT;

-- Devices track their current suppression state for fast UI/collector lookups.
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS
  alert_suppressed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS
  suppressed_by_device_id INTEGER REFERENCES monitored_devices(id) ON DELETE SET NULL;

-- ── Site Gateway model (supersedes manual parent-child dependencies) ──────────
-- Each site may designate one gateway device. When that gateway is down, alerts
-- for every other device at the same site are suppressed (the site is assumed
-- unreachable through its gateway). The device_dependencies table + alert
-- suppression columns above are reused by this logic. site_id matching replaces
-- the parent-child walk.
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS
  is_gateway BOOLEAN NOT NULL DEFAULT FALSE;
-- Only one active gateway per site (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_gateway_per_site
  ON monitored_devices(site_id) WHERE is_gateway = TRUE AND active = TRUE;

-- ── Audit log ─────────────────────────────────────────────────────────────────
-- One row per successful mutating API request: who (verified session user),
-- what (method + path + sanitized body), when, and from where.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_email  TEXT,
  user_role   TEXT,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER,
  detail      JSONB,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

-- ── Notification routing + throttle ───────────────────────────────────────────
-- Route matching alerts to specific email recipients. A NULL match field = "any".
-- When no route matches, the global alert_email_to is used as a fallback.
CREATE TABLE IF NOT EXISTS notification_routes (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  match_severity   TEXT,     -- 'warning' | 'critical' | NULL(any)
  match_site_id    INTEGER,  -- NULL = any site
  match_alert_type TEXT,     -- e.g. 'device_down' | NULL(any)
  email_to         TEXT NOT NULL,   -- comma/space separated recipients
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Throttle re-notification of a flapping alert. device_id/agent_id use 0 to mean
-- "none" so the composite key has no NULLs.
CREATE TABLE IF NOT EXISTS notification_state (
  device_id        INTEGER NOT NULL DEFAULT 0,
  agent_id         INTEGER NOT NULL DEFAULT 0,
  alert_type       TEXT NOT NULL,
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, agent_id, alert_type)
);

-- ── Escalation + on-call (email) ──────────────────────────────────────────────
-- Ordered escalation steps: if an alert stays active+unacknowledged past
-- after_minutes, email that step's recipients (or whoever is on call).
CREATE TABLE IF NOT EXISTS escalation_steps (
  id            SERIAL PRIMARY KEY,
  step_order    INTEGER NOT NULL DEFAULT 1,
  after_minutes INTEGER NOT NULL DEFAULT 15,
  email_to      TEXT,
  use_oncall    BOOLEAN NOT NULL DEFAULT FALSE,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE
);
-- A single on-call rotation: whoever's shift covers "now" is the current on-call.
CREATE TABLE IF NOT EXISTS oncall_shifts (
  id            SERIAL PRIMARY KEY,
  contact_email TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Which escalation steps have already fired for an alert (so each fires once).
CREATE TABLE IF NOT EXISTS alert_escalations (
  alert_id  INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  step_id   INTEGER NOT NULL,
  fired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alert_id, step_id)
);

GRANT ALL PRIVILEGES ON TABLE device_dependencies TO spanvault_user;
GRANT ALL PRIVILEGES ON SEQUENCE device_dependencies_id_seq TO spanvault_user;

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO app_settings (key, value) VALUES
  ('icmp_poll_interval_seconds','300'),
  ('snmp_poll_interval_seconds','300'),
  ('ping_threshold_ms','500'),
  ('ping_failures_before_down','3'),
  ('cpu_threshold_pct','80'),
  ('mem_threshold_pct','85'),
  ('session_util_threshold_pct','90'),
  ('netvault_sync_minutes','30'),
  ('email_alerts_enabled','false'),
  ('smtp_host',''), ('smtp_port','587'), ('smtp_user',''),
  ('smtp_pass',''), ('smtp_from',''), ('alert_email_to','')
ON CONFLICT (key) DO NOTHING;

-- Grant permissions to app user
GRANT ALL PRIVILEGES ON device_sensors TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO spanvault_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO spanvault_user;

-- ══ Distributed polling agents ════════════════════════════════════════════════
-- Remote agents poll devices at sites the SpanVault server cannot reach directly.
-- An agent connects outbound over WebSocket, receives its device config, and
-- ships ping/SNMP results back. The server does all alert evaluation + storage;
-- the agent is "dumb" (poll + ship + buffer offline only).
CREATE TABLE IF NOT EXISTS agents (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  api_key          TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  status           TEXT NOT NULL DEFAULT 'never_connected',
  version          TEXT,
  ip_address       TEXT,
  hostname         TEXT,
  last_seen_at     TIMESTAMPTZ,
  connected_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Revoke an agent without deleting it (and its history): a disabled agent's API
-- key is refused at the WebSocket handshake and any live socket is dropped.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Latest self-reported host health (cpu/mem/disk %, uptimes, buffer/device counts)
-- shipped on each heartbeat.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS health JSONB;

-- Site assignments: every device in an assigned site is polled by this agent.
CREATE TABLE IF NOT EXISTS agent_sites (
  agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  site_id   INTEGER NOT NULL,
  site_name TEXT,
  PRIMARY KEY (agent_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_sites_site ON agent_sites(site_id);

-- Zero-touch discovery: candidates the agent found by sweeping its local subnet
-- (ping + SNMP sysName/sysDescr). Operators adopt these into monitored_devices.
CREATE TABLE IF NOT EXISTS agent_discovered_devices (
  id            SERIAL PRIMARY KEY,
  agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ip_address    TEXT NOT NULL,
  sys_name      TEXT,
  sys_descr     TEXT,
  mac           TEXT,
  vendor        TEXT,
  snmp_ok       BOOLEAN NOT NULL DEFAULT FALSE,
  adopted       BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, ip_address)
);
CREATE INDEX IF NOT EXISTS idx_agent_disc_agent ON agent_discovered_devices(agent_id);

-- Carry the SNMP community/version the agent actually used to fingerprint each
-- candidate, so adopting it preserves working credentials instead of guessing
-- 'public'/'2c'. Without this, a switch discovered with a custom community would
-- be adopted with the wrong community and silently never return SNMP metrics.
ALTER TABLE agent_discovered_devices ADD COLUMN IF NOT EXISTS snmp_community TEXT;
ALTER TABLE agent_discovered_devices ADD COLUMN IF NOT EXISTS snmp_version   TEXT;

-- agent_id on monitored_devices: NULL = polled locally by the collector;
-- non-NULL = polled by the referenced remote agent.
ALTER TABLE monitored_devices ADD COLUMN IF NOT EXISTS
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mdev_agent ON monitored_devices(agent_id);

-- Tag each result with the agent that produced it (NULL = local collector).
ALTER TABLE ping_results ADD COLUMN IF NOT EXISTS
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE snmp_results ADD COLUMN IF NOT EXISTS
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;

-- Agent-level alerts (agent_down) reference the agent, not a device. Placed after
-- the agents table so the forward FK target exists. One active agent_down alert
-- per agent is enforced by the partial unique index below.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_agent_unique
  ON alerts(agent_id, alert_type) WHERE status = 'active' AND agent_id IS NOT NULL;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;

-- ══ Agentless service checks (HTTP/TCP/SSL/DNS) ════════════════════════════════
-- PRTG-style "is this service up" probes. A check runs from the CENTRAL collector
-- when agent_id IS NULL, or from a remote agent when agent_id is set (the agent
-- writes current_status/last_* via the WS handler). The server evaluates alerts
-- for ALL checks from their stored status. Placed after the agents + alerts blocks
-- so the agent_id / service_check_id forward FKs resolve.
CREATE TABLE IF NOT EXISTS service_checks (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,          -- 'http' | 'tcp' | 'ssl' | 'dns'
  target           TEXT NOT NULL,          -- url | host[:port] | hostname
  site_id          INTEGER,
  site_name        TEXT,
  agent_id         INTEGER REFERENCES agents(id) ON DELETE SET NULL,  -- NULL = central
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  params           JSONB,                  -- {port, expect_status, keyword, ssl_warn_days, timeout_ms}
  current_status   TEXT NOT NULL DEFAULT 'unknown',  -- up | down | warning | unknown
  last_response_ms NUMERIC,
  last_detail      TEXT,
  last_checked_at  TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS service_check_results (
  id          BIGSERIAL PRIMARY KEY,
  check_id    INTEGER NOT NULL REFERENCES service_checks(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL,
  response_ms NUMERIC,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_svc_results ON service_check_results(check_id, ts DESC);

-- group_id ties the per-type checks created together for one target; NULL = standalone.
ALTER TABLE service_checks ADD COLUMN IF NOT EXISTS group_id UUID;
CREATE INDEX IF NOT EXISTS idx_svc_group ON service_checks(group_id);
-- Service-level alerts reference the check, not a device.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS service_check_id INTEGER REFERENCES service_checks(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_service_unique
  ON alerts(service_check_id, alert_type) WHERE status = 'active' AND service_check_id IS NOT NULL;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;

-- ══ Interactive map designer ══════════════════════════════════════════════════
-- User-designed network maps: a canvas with positioned device nodes, connection
-- lines between them, and free-floating text labels. Maps can be made public
-- (shared via uuid) for unauthenticated live viewing.
CREATE TABLE IF NOT EXISTS sv_maps (
  id           SERIAL PRIMARY KEY,
  uuid         TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  name         TEXT NOT NULL,
  description  TEXT,
  bg_color     TEXT NOT NULL DEFAULT '#f8fafc',
  bg_image_b64 TEXT,
  canvas_w     INTEGER NOT NULL DEFAULT 1600,
  canvas_h     INTEGER NOT NULL DEFAULT 900,
  is_public    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS map_devices (
  id         SERIAL PRIMARY KEY,
  map_id     INTEGER NOT NULL REFERENCES sv_maps(id) ON DELETE CASCADE,
  device_id  INTEGER REFERENCES monitored_devices(id) ON DELETE CASCADE,
  x          NUMERIC NOT NULL DEFAULT 100,
  y          NUMERIC NOT NULL DEFAULT 100,
  label      TEXT,
  icon_type  TEXT NOT NULL DEFAULT 'circle',
  width      INTEGER NOT NULL DEFAULT 120,
  height     INTEGER NOT NULL DEFAULT 60
);
CREATE INDEX IF NOT EXISTS idx_map_devices_map ON map_devices(map_id);

CREATE TABLE IF NOT EXISTS map_connections (
  id           SERIAL PRIMARY KEY,
  map_id       INTEGER NOT NULL REFERENCES sv_maps(id) ON DELETE CASCADE,
  from_item_id INTEGER NOT NULL REFERENCES map_devices(id) ON DELETE CASCADE,
  to_item_id   INTEGER NOT NULL REFERENCES map_devices(id) ON DELETE CASCADE,
  color        TEXT NOT NULL DEFAULT '#94a3b8',
  line_style   TEXT NOT NULL DEFAULT 'solid',
  label        TEXT
);
CREATE INDEX IF NOT EXISTS idx_map_connections_map ON map_connections(map_id);

CREATE TABLE IF NOT EXISTS map_labels (
  id      SERIAL PRIMARY KEY,
  map_id  INTEGER NOT NULL REFERENCES sv_maps(id) ON DELETE CASCADE,
  x       NUMERIC NOT NULL,
  y       NUMERIC NOT NULL,
  text    TEXT NOT NULL,
  font_size INTEGER NOT NULL DEFAULT 14,
  color   TEXT NOT NULL DEFAULT '#1a2744',
  bold    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_map_labels_map ON map_labels(map_id);

-- Map overhaul: per-node rendering style + stacking order, and free-form
-- decorative elements (shapes/icons like cloud/internet/router that are NOT
-- monitored devices). All additive + idempotent.
ALTER TABLE map_devices ADD COLUMN IF NOT EXISTS z_index    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE map_devices ADD COLUMN IF NOT EXISTS node_style TEXT    NOT NULL DEFAULT 'box';  -- 'box' | 'icon'
ALTER TABLE map_labels  ADD COLUMN IF NOT EXISTS z_index    INTEGER NOT NULL DEFAULT 0;

-- Connection styling: optional directional arrowhead (at the 'to' end) and
-- adjustable stroke thickness. Additive + idempotent; old rows default to a
-- plain 2px line with no arrow.
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS arrow BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS width INTEGER NOT NULL DEFAULT 2;

-- Weathermap: bind a connection to specific device interfaces so the rendered
-- link can be coloured by live utilization (a NOC weathermap). from_if_index /
-- to_if_index are SNMP ifIndex values on the connection's from/to devices;
-- capacity_bps is the link speed used to compute util% (NULL = unknown, colour
-- by oper status only). All additive + idempotent; old rows stay unbound.
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS from_if_index INTEGER;
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS to_if_index   INTEGER;
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS capacity_bps  BIGINT;

-- Connection routing style: 'straight' (default) or 'elbow' (orthogonal/Manhattan).
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS routing TEXT NOT NULL DEFAULT 'straight';

-- Adjustable orthogonal waypoints (bend points) for elbow connections: an array
-- of {x,y} points the user has dragged. NULL/empty = auto-route as before.
-- Additive + idempotent; old rows stay auto-routed.
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS waypoints JSONB;

-- Connection endpoints can be a device OR a decorative shape. from_kind/to_kind
-- says which table from_item_id/to_item_id refers to; the device-only FKs are
-- dropped so a shape id can be stored. (Orphan cleanup is handled in the app on
-- layout save, which rewrites all of a map's devices/shapes/connections.)
ALTER TABLE map_connections DROP CONSTRAINT IF EXISTS map_connections_from_item_id_fkey;
ALTER TABLE map_connections DROP CONSTRAINT IF EXISTS map_connections_to_item_id_fkey;
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS from_kind TEXT NOT NULL DEFAULT 'device';
ALTER TABLE map_connections ADD COLUMN IF NOT EXISTS to_kind   TEXT NOT NULL DEFAULT 'device';

-- Decorative, non-device elements: basic shapes (rect/ellipse/arrow/line/text)
-- and built-in network glyphs (cloud/internet/router/switch/firewall/server/...).
-- The glyph artwork lives in client code; here we only store the kind + geometry
-- + styling, so this table stays tiny. Defined BEFORE the ALTERs below that add
-- its locked/group_id columns, so a fresh install creates the table first.
CREATE TABLE IF NOT EXISTS map_shapes (
  id           SERIAL PRIMARY KEY,
  map_id       INTEGER NOT NULL REFERENCES sv_maps(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                       -- rect|ellipse|line|arrow|text|zone|cloud|internet|wan|router|switch|firewall|server|loadbalancer|ap|database|building
  x            NUMERIC NOT NULL DEFAULT 100,
  y            NUMERIC NOT NULL DEFAULT 100,
  width        NUMERIC NOT NULL DEFAULT 120,
  height       NUMERIC NOT NULL DEFAULT 80,
  fill         TEXT,
  stroke       TEXT,
  stroke_width INTEGER NOT NULL DEFAULT 2,
  text         TEXT,
  font_size    INTEGER NOT NULL DEFAULT 14,
  text_color   TEXT NOT NULL DEFAULT '#1a2744',
  rotation     NUMERIC NOT NULL DEFAULT 0,
  z_index      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_map_shapes_map ON map_shapes(map_id);

-- Locked elements can't be moved/resized in the editor (e.g. background zones).
ALTER TABLE map_devices ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE map_shapes  ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE map_labels  ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Grouping: elements sharing a non-null group_id move/select together. group_id
-- is a client-assigned tag (not a FK); it persists as-is across layout saves.
ALTER TABLE map_devices ADD COLUMN IF NOT EXISTS group_id INTEGER;
ALTER TABLE map_shapes  ADD COLUMN IF NOT EXISTS group_id INTEGER;
ALTER TABLE map_labels  ADD COLUMN IF NOT EXISTS group_id INTEGER;

-- Drill-down: a node can open a child map (campus → building → rack). References
-- another sv_maps row; cleared if that map is deleted.
ALTER TABLE map_devices ADD COLUMN IF NOT EXISTS drill_map_id INTEGER REFERENCES sv_maps(id) ON DELETE SET NULL;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;

-- ══ Intelligence Layer ════════════════════════════════════════════════════════
-- Statistical analytics computed on top of the raw monitoring data
-- (ping_results, snmp_results, alerts). All tables are written by the
-- intelligence engine (api/intelligence.js), which runs on a timer inside the
-- API process. Everything below is idempotent.

-- Computed baselines per device per metric (updated hourly).
CREATE TABLE IF NOT EXISTS device_baselines (
  id          SERIAL PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  metric      TEXT NOT NULL,        -- response_ms, cpu_pct, mem_pct, if_in_bps, etc.
  period_days INTEGER NOT NULL DEFAULT 30,
  mean        NUMERIC,
  stddev      NUMERIC,
  p50         NUMERIC,              -- median
  p95         NUMERIC,              -- 95th percentile
  p99         NUMERIC,              -- 99th percentile
  min_val     NUMERIC,
  max_val     NUMERIC,
  sample_count INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_baseline_device_metric
  ON device_baselines(device_id, metric, period_days);

-- Health scores per device (updated every poll cycle).
CREATE TABLE IF NOT EXISTS device_health_scores (
  id              SERIAL PRIMARY KEY,
  device_id       INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  score           NUMERIC NOT NULL DEFAULT 100,   -- 0-100
  uptime_score    NUMERIC,   -- contribution from uptime
  response_score  NUMERIC,   -- contribution from response time trend
  anomaly_score   NUMERIC,   -- contribution from anomaly frequency
  alert_score     NUMERIC,   -- contribution from alert frequency
  grade           TEXT,      -- A/B/C/D/F
  trend           TEXT,      -- improving/stable/degrading
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_health_device
  ON device_health_scores(device_id);

-- Detected anomalies.
CREATE TABLE IF NOT EXISTS device_anomalies (
  id          SERIAL PRIMARY KEY,
  device_id   INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  metric      TEXT NOT NULL,
  value       NUMERIC NOT NULL,
  baseline_mean   NUMERIC,
  baseline_stddev NUMERIC,
  z_score     NUMERIC NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning',  -- warning/critical
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active'  -- active/resolved
);
CREATE INDEX IF NOT EXISTS idx_anomaly_device ON device_anomalies(device_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_status ON device_anomalies(status);
CREATE INDEX IF NOT EXISTS idx_anomaly_detected ON device_anomalies(detected_at DESC);
-- At most one active anomaly per device/metric (the engine relies on this to
-- avoid piling up duplicate rows on every detection pass).
CREATE UNIQUE INDEX IF NOT EXISTS idx_anomaly_one_active
  ON device_anomalies(device_id, metric) WHERE status = 'active';

-- Detected patterns (recurring issues).
CREATE TABLE IF NOT EXISTS device_patterns (
  id           SERIAL PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  pattern_type TEXT NOT NULL,   -- hourly/daily/weekly
  metric       TEXT NOT NULL,
  description  TEXT NOT NULL,   -- human readable: "High latency every Monday 08:00-09:00"
  hour_of_day  INTEGER,         -- 0-23, null if not hour-specific
  day_of_week  INTEGER,         -- 0-6 (Sun=0), null if not day-specific
  avg_value    NUMERIC,
  baseline_value NUMERIC,
  confidence   NUMERIC,         -- 0-1, how confident we are
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrence_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pattern_device ON device_patterns(device_id);
-- One row per recurring (device, type, metric, hour, day) slot — the engine
-- upserts last_seen_at / occurrence_count against this key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_slot
  ON device_patterns(device_id, pattern_type, metric,
                      COALESCE(hour_of_day, -1), COALESCE(day_of_week, -1));

-- Incidents (correlated alert groups).
CREATE TABLE IF NOT EXISTS incidents (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  root_cause_device_id INTEGER REFERENCES monitored_devices(id) ON DELETE SET NULL,
  affected_count INTEGER NOT NULL DEFAULT 1,
  severity      TEXT NOT NULL DEFAULT 'warning',
  status        TEXT NOT NULL DEFAULT 'active',  -- active/resolved
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  duration_seconds INTEGER,
  summary       TEXT,         -- auto-generated incident summary
  timeline      JSONB         -- array of timeline events
);
CREATE INDEX IF NOT EXISTS idx_incident_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incident_started ON incidents(started_at DESC);

-- Links alerts to incidents.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS incident_id INTEGER
  REFERENCES incidents(id) ON DELETE SET NULL;

-- Optional free-text note captured when an operator acknowledges an alert.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS note TEXT;

-- Smart threshold recommendations.
CREATE TABLE IF NOT EXISTS threshold_recommendations (
  id                SERIAL PRIMARY KEY,
  device_id         INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  metric            TEXT NOT NULL,
  current_threshold NUMERIC,
  recommended_threshold NUMERIC NOT NULL,
  reasoning         TEXT NOT NULL,
  confidence        NUMERIC,       -- 0-1
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_threshold_rec_device_metric
  ON threshold_recommendations(device_id, metric);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;

-- ══ Topology discovery (LLDP / CDP) ═══════════════════════════════════════════
-- Discovered layer-2 neighbor links walked from each SNMP device's LLDP/CDP MIBs
-- by collector/topology.js. A link is keyed by (from_device, from_port, protocol)
-- and refreshed (last_seen_at) on every discovery pass. to_device_id resolves the
-- neighbor when it is itself a monitored device; otherwise to_ip/to_name carry the
-- neighbor identity for display only.
CREATE TABLE IF NOT EXISTS topology_links (
  id              SERIAL PRIMARY KEY,
  from_device_id  INTEGER NOT NULL REFERENCES monitored_devices(id) ON DELETE CASCADE,
  from_port       TEXT,
  from_port_desc  TEXT,
  to_device_id    INTEGER REFERENCES monitored_devices(id) ON DELETE SET NULL,
  to_ip           TEXT,           -- neighbor IP even if not in monitored_devices
  to_name         TEXT,           -- neighbor name even if not monitored
  to_port         TEXT,
  to_port_desc    TEXT,
  protocol        TEXT NOT NULL DEFAULT 'lldp',  -- lldp / cdp
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topo_link_unique
  ON topology_links(from_device_id, from_port, protocol);
CREATE INDEX IF NOT EXISTS idx_topo_from ON topology_links(from_device_id);
CREATE INDEX IF NOT EXISTS idx_topo_to ON topology_links(to_device_id);

ALTER TABLE monitored_devices
  ADD COLUMN IF NOT EXISTS topology_discovered_at TIMESTAMPTZ;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;

-- ══ Wireless visibility (controllers + access points) ═════════════════════════
-- Wireless controllers are polled either via SNMP (snmp_device_id links to a
-- monitored device whose stored SNMP credentials are reused) or via a vendor
-- HTTP API (controller_url + credentials). API credentials are plaintext, same
-- pattern as snmp_community — never logged. status reflects the last poll result.
CREATE TABLE IF NOT EXISTS wireless_controllers (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  vendor          TEXT NOT NULL,  -- aruba/cisco/fortinet/ruckus/mikrotik/hpe/grandstream/ubiquiti/omada
  controller_url  TEXT,           -- for API-based polling
  api_key         TEXT,           -- or username:password base64 for basic auth
  api_username    TEXT,
  api_password    TEXT,
  site_id         INTEGER,
  site_name       TEXT,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
  snmp_device_id  INTEGER REFERENCES monitored_devices(id) ON DELETE SET NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_polled_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Last poll outcome ('ok' / 'error') + error detail, surfaced in the UI.
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS status     TEXT;
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS firmware_version TEXT;
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS licensed_aps INTEGER;
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS ha_mode TEXT;          -- disabled/active/standby/unknown
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS ha_peer_ip TEXT;
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS ha_sync_status TEXT;   -- synced/not-synced/unknown/n-a
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS ap_disconnects_24h INTEGER;  -- from wireless_client_events
-- Manual HA pairing: for platforms (e.g. AOS-8 gateways) that don't expose HA via
-- SNMP, an operator can link two controllers as a pair. Kept separate from the
-- SNMP-derived ha_* columns so polling never overwrites the manual designation.
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS ha_peer_controller_id INTEGER
  REFERENCES wireless_controllers(id) ON DELETE SET NULL;
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS ha_manual_role TEXT;  -- Active / Standby
-- One-time OID capability discovery: { capabilityKey: workingOid, probe_done: true }.
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '{}';
ALTER TABLE wireless_controllers ADD COLUMN IF NOT EXISTS capabilities_probed_at TIMESTAMPTZ;
-- Auto-created SNMP controllers are keyed on their device so they aren't dup'd.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wctl_snmp_device
  ON wireless_controllers(snmp_device_id) WHERE snmp_device_id IS NOT NULL;

-- Access Points
CREATE TABLE IF NOT EXISTS wireless_aps (
  id               SERIAL PRIMARY KEY,
  controller_id    INTEGER REFERENCES wireless_controllers(id) ON DELETE CASCADE,
  monitored_device_id INTEGER REFERENCES monitored_devices(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  mac_address      TEXT,
  model            TEXT,
  ip_address       TEXT,
  site_id          INTEGER,
  site_name        TEXT,
  status           TEXT NOT NULL DEFAULT 'unknown',  -- online/offline/unknown
  radio_2g_channel INTEGER,
  radio_5g_channel INTEGER,
  radio_6g_channel INTEGER,
  radio_2g_util_pct NUMERIC,
  radio_5g_util_pct NUMERIC,
  clients_2g       INTEGER NOT NULL DEFAULT 0,
  clients_5g       INTEGER NOT NULL DEFAULT 0,
  clients_6g       INTEGER NOT NULL DEFAULT 0,
  clients_total    INTEGER NOT NULL DEFAULT 0,
  tx_power_2g      INTEGER,
  tx_power_5g      INTEGER,
  uptime_seconds   BIGINT,
  firmware_version TEXT,
  last_seen_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wap_controller ON wireless_aps(controller_id);
CREATE INDEX IF NOT EXISTS idx_wap_status ON wireless_aps(status);
CREATE INDEX IF NOT EXISTS idx_wap_site ON wireless_aps(site_id);
-- Upsert key: an AP is unique within its controller by name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wap_ctrl_name
  ON wireless_aps(controller_id, name);

-- Wireless-level alerts reference the AP or controller, not a monitored device.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS wireless_ap_id INTEGER
  REFERENCES wireless_aps(id) ON DELETE CASCADE;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS wireless_controller_id INTEGER
  REFERENCES wireless_controllers(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_wap_unique
  ON alerts(wireless_ap_id, alert_type) WHERE status = 'active' AND wireless_ap_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active_wctl_unique
  ON alerts(wireless_controller_id, alert_type) WHERE status = 'active' AND wireless_controller_id IS NOT NULL;

-- Wireless time-series (AP metrics history)
CREATE TABLE IF NOT EXISTS wireless_history (
  id             BIGSERIAL PRIMARY KEY,
  ap_id          INTEGER NOT NULL REFERENCES wireless_aps(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clients_total  INTEGER,
  clients_2g     INTEGER,
  clients_5g     INTEGER,
  radio_2g_util  NUMERIC,
  radio_5g_util  NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_wireless_hist_ap_ts
  ON wireless_history(ap_id, ts DESC);

-- ── Expanded wireless radio metrics (Aruba/Cisco/Ruckus richer SNMP) ─────────
-- Per-band noise floor (negative dBm), frame retry rate (%), rx/tx frame error
-- counters, throughput rate (bps, derived from cumulative byte counters by the
-- collector), serial number and an auth-failure counter. All nullable — old
-- firmware that does not expose an OID stores NULL rather than a misleading 0.
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS noise_floor_2g    INTEGER;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS noise_floor_5g    INTEGER;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS retry_rate_2g     NUMERIC;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS retry_rate_5g     NUMERIC;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS rx_errors_2g      BIGINT;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS tx_errors_2g      BIGINT;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS rx_errors_5g      BIGINT;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS tx_errors_5g      BIGINT;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS throughput_in_bps  BIGINT;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS throughput_out_bps BIGINT;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS serial_number     TEXT;
ALTER TABLE wireless_aps ADD COLUMN IF NOT EXISTS auth_failures     INTEGER DEFAULT 0;

-- Per-SSID statistics (one row per controller + SSID name).
CREATE TABLE IF NOT EXISTS wireless_ssids (
  id              SERIAL PRIMARY KEY,
  controller_id   INTEGER NOT NULL REFERENCES wireless_controllers(id) ON DELETE CASCADE,
  ssid_name       TEXT NOT NULL,
  site_id         INTEGER,
  site_name       TEXT,
  status          TEXT NOT NULL DEFAULT 'up',
  clients_total   INTEGER NOT NULL DEFAULT 0,
  bytes_in        BIGINT DEFAULT 0,
  bytes_out       BIGINT DEFAULT 0,
  auth_successes  INTEGER DEFAULT 0,
  auth_failures   INTEGER DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wireless_ssid_ctrl_name
  ON wireless_ssids(controller_id, ssid_name);
CREATE INDEX IF NOT EXISTS idx_wireless_ssid_ctrl
  ON wireless_ssids(controller_id);

-- Expanded wireless_history with the new time-series metrics.
ALTER TABLE wireless_history ADD COLUMN IF NOT EXISTS noise_floor_2g    INTEGER;
ALTER TABLE wireless_history ADD COLUMN IF NOT EXISTS noise_floor_5g    INTEGER;
ALTER TABLE wireless_history ADD COLUMN IF NOT EXISTS throughput_in_bps BIGINT;
ALTER TABLE wireless_history ADD COLUMN IF NOT EXISTS throughput_out_bps BIGINT;
ALTER TABLE wireless_history ADD COLUMN IF NOT EXISTS auth_failures     INTEGER;
ALTER TABLE wireless_history ADD COLUMN IF NOT EXISTS retry_rate_2g     NUMERIC;
ALTER TABLE wireless_history ADD COLUMN IF NOT EXISTS retry_rate_5g     NUMERIC;

-- ══ Wireless intelligence (computed analytics per poll cycle) ═════════════════
CREATE TABLE IF NOT EXISTS wireless_intelligence (
  id              SERIAL PRIMARY KEY,
  controller_id   INTEGER NOT NULL REFERENCES wireless_controllers(id) ON DELETE CASCADE,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  co_channel_pairs    INTEGER DEFAULT 0,
  interference_score  NUMERIC DEFAULT 0,
  load_balance_score  NUMERIC DEFAULT 0,
  overloaded_aps      INTEGER DEFAULT 0,
  underloaded_aps     INTEGER DEFAULT 0,
  avg_clients_per_ap  NUMERIC DEFAULT 0,
  max_clients_per_ap  INTEGER DEFAULT 0,
  band_2g_pct         NUMERIC DEFAULT 0,
  band_5g_pct         NUMERIC DEFAULT 0,
  band_steering_score NUMERIC DEFAULT 0,
  high_util_ap_count  INTEGER DEFAULT 0,
  critical_util_count INTEGER DEFAULT 0,
  capacity_score      NUMERIC DEFAULT 0,
  overall_score       NUMERIC DEFAULT 0,
  overall_grade       TEXT DEFAULT 'A',
  recommendations     JSONB DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wifi_intel_ctrl
  ON wireless_intelligence(controller_id);
CREATE INDEX IF NOT EXISTS idx_wifi_intel_computed
  ON wireless_intelligence(computed_at DESC);

CREATE TABLE IF NOT EXISTS wireless_ap_intelligence (
  id              SERIAL PRIMARY KEY,
  ap_id           INTEGER NOT NULL REFERENCES wireless_aps(id) ON DELETE CASCADE,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  health_score    NUMERIC DEFAULT 100,
  health_grade    TEXT DEFAULT 'A',
  co_channel_neighbors  INTEGER DEFAULT 0,
  channel_recommendation TEXT,
  load_status     TEXT DEFAULT 'normal',
  load_pct        NUMERIC DEFAULT 0,
  band_ratio_healthy BOOLEAN DEFAULT TRUE,
  issues          JSONB DEFAULT '[]',
  recommendations JSONB DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wifi_ap_intel_ap
  ON wireless_ap_intelligence(ap_id);

-- ══ Wireless client-level troubleshooting (Tier 1) ═══════════════════════════
-- Current client snapshot, upserted every client poll. Clients not seen for
-- 15 minutes are pruned by the collector (only active clients are kept).
CREATE TABLE IF NOT EXISTS wireless_clients (
  id               SERIAL PRIMARY KEY,
  mac_address      TEXT NOT NULL,
  ip_address       TEXT,
  hostname         TEXT,
  controller_id    INTEGER NOT NULL REFERENCES wireless_controllers(id) ON DELETE CASCADE,
  ap_id            INTEGER REFERENCES wireless_aps(id) ON DELETE SET NULL,
  ap_name          TEXT,
  ssid_name        TEXT,
  band             TEXT,           -- '2.4GHz' / '5GHz' / '6GHz'
  channel          INTEGER,
  rssi_dbm         INTEGER,        -- signal strength, negative
  tx_rate_mbps     NUMERIC,
  rx_rate_mbps     NUMERIC,
  connected_since  TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auth_type        TEXT,
  is_problem       BOOLEAN DEFAULT FALSE,   -- TRUE if rssi < -75 or roaming_count > 5
  is_sticky        BOOLEAN DEFAULT FALSE,   -- poor signal but NOT roaming (clings to a far AP)
  roaming_count    INTEGER DEFAULT 0,       -- times roamed in last hour
  vendor           TEXT NOT NULL            -- aruba/cisco/ruckus/mikrotik/hpe
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wclient_ctrl_mac
  ON wireless_clients(controller_id, mac_address);
CREATE INDEX IF NOT EXISTS idx_wclient_ap ON wireless_clients(ap_id);
CREATE INDEX IF NOT EXISTS idx_wclient_rssi ON wireless_clients(rssi_dbm);
CREATE INDEX IF NOT EXISTS idx_wclient_problem
  ON wireless_clients(is_problem) WHERE is_problem = TRUE;
ALTER TABLE wireless_clients ADD COLUMN IF NOT EXISTS is_sticky BOOLEAN DEFAULT FALSE;

-- Rogue/unmanaged APs detected by a controller (from the vendor rogue SNMP table).
-- Refreshed every poll; rows not seen in 24h are pruned by the collector.
CREATE TABLE IF NOT EXISTS wireless_rogue_aps (
  id             SERIAL PRIMARY KEY,
  controller_id  INTEGER NOT NULL REFERENCES wireless_controllers(id) ON DELETE CASCADE,
  bssid          TEXT NOT NULL,            -- rogue radio MAC/BSSID
  ssid           TEXT,
  rssi_dbm       INTEGER,
  channel        INTEGER,
  classification TEXT,                     -- rogue/friendly/malicious/unclassified/interfering
  detecting_ap   TEXT,                     -- managed AP that heard it
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (controller_id, bssid)
);
CREATE INDEX IF NOT EXISTS idx_rogue_ctrl ON wireless_rogue_aps(controller_id);

-- Roaming and auth event history (join/roam/leave/auth_fail/low_signal).
-- Purged after 7 days by the collector.
CREATE TABLE IF NOT EXISTS wireless_client_events (
  id           BIGSERIAL PRIMARY KEY,
  mac_address  TEXT NOT NULL,
  controller_id INTEGER NOT NULL REFERENCES wireless_controllers(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,   -- join/roam/leave/auth_fail/low_signal
  from_ap_id   INTEGER REFERENCES wireless_aps(id) ON DELETE SET NULL,
  from_ap_name TEXT,
  to_ap_id     INTEGER REFERENCES wireless_aps(id) ON DELETE SET NULL,
  to_ap_name   TEXT,
  rssi_dbm     INTEGER,
  ssid_name    TEXT,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wclient_event_mac
  ON wireless_client_events(mac_address, ts DESC);
CREATE INDEX IF NOT EXISTS idx_wclient_event_ctrl
  ON wireless_client_events(controller_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_wclient_event_ts
  ON wireless_client_events(ts DESC);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;

-- ══ Self-healing HA-failover AP de-duplication (one-time, idempotent) ═════════
-- An HA controller pair (e.g. site TUFS controllers 7 & 8) can report the SAME
-- physical AP twice — once per controller — because mac_address/serial_number
-- are NULL, so the upsert key (controller_id, name) cannot collapse the two
-- copies. One row is the live continuous record (recent last_seen_at, full
-- wireless_history); the other is a stale shell left behind by a failover (~1
-- history row, an older last_seen_at, but still status='online'). This block
-- collapses each physical AP back to ONE row, identifying a physical AP by
-- (site_id, name) since the hardware identifiers are NULL.
--
-- For each (site_id, name) group with COUNT(*) > 1 and site_id IS NOT NULL:
-- KEEP the row with the most-recent last_seen_at (tie-break: highest id); the
-- remaining ids are dropped. Every child row that references a dropped id is
-- handled FIRST so the delete cannot fail or silently lose data:
--   * wireless_history.ap_id / wireless_ap_intelligence.ap_id  -> DELETE the
--     dropped shell's rows. Shells carry ~1 history row (negligible), and
--     wireless_ap_intelligence has a UNIQUE(ap_id) so it cannot be repointed.
--   * wireless_client_events.from_ap_id / to_ap_id  -> repoint to the keeper
--     (preserve roam/auth history; both columns are nullable / ON DELETE SET NULL).
--   * wireless_clients.ap_id  -> repoint to the keeper (ephemeral 15-min snapshot,
--     nullable; keeps the live client mapped to the surviving AP).
--   * alerts.wireless_ap_id  -> repoint to the keeper, but first delete any
--     ACTIVE shell alert that would collide with an existing active keeper alert
--     of the same alert_type (partial unique index idx_alerts_active_wap_unique),
--     so the repoint cannot violate it. (alerts.wireless_ap_id is ON DELETE
--     CASCADE, so repointing also avoids losing alert history to the cascade.)
-- Then the shell rows themselves are deleted.
--
-- Fully idempotent: after the first run there are no >1 groups left, so a second
-- run iterates nothing and changes nothing. No UNIQUE constraint/index is added
-- on (site_id, name) by design — the app-level upsert handles prevention, and a
-- DB unique index could make legitimate inserts fail; that is out of scope here.
DO $$
DECLARE
  grp        RECORD;
  keeper_id  INTEGER;
  drop_ids   INTEGER[];
BEGIN
  FOR grp IN
    SELECT site_id, name
    FROM   wireless_aps
    WHERE  site_id IS NOT NULL
    GROUP  BY site_id, name
    HAVING COUNT(*) > 1
  LOOP
    -- Keeper = most-recent last_seen_at, tie-break highest id (NULL last_seen last).
    SELECT id INTO keeper_id
    FROM   wireless_aps
    WHERE  site_id = grp.site_id AND name = grp.name
    ORDER  BY last_seen_at DESC NULLS LAST, id DESC
    LIMIT  1;

    -- Every other row in the group is a duplicate shell to drop.
    SELECT array_agg(id) INTO drop_ids
    FROM   wireless_aps
    WHERE  site_id = grp.site_id AND name = grp.name
      AND  id <> keeper_id;

    -- Negligible per-shell time-series / intelligence: delete it outright.
    DELETE FROM wireless_history         WHERE ap_id = ANY(drop_ids);
    DELETE FROM wireless_ap_intelligence WHERE ap_id = ANY(drop_ids);

    -- Preserve event + live-client linkage by repointing it to the keeper.
    UPDATE wireless_client_events SET from_ap_id = keeper_id WHERE from_ap_id = ANY(drop_ids);
    UPDATE wireless_client_events SET to_ap_id   = keeper_id WHERE to_ap_id   = ANY(drop_ids);
    UPDATE wireless_clients       SET ap_id      = keeper_id WHERE ap_id      = ANY(drop_ids);

    -- Repoint alerts to the keeper, first clearing any active shell alert that
    -- would collide with an active keeper alert of the same type.
    DELETE FROM alerts a
    WHERE  a.wireless_ap_id = ANY(drop_ids)
      AND  a.status = 'active'
      AND  EXISTS (SELECT 1 FROM alerts k
                   WHERE k.wireless_ap_id = keeper_id
                     AND k.alert_type     = a.alert_type
                     AND k.status         = 'active');
    UPDATE alerts SET wireless_ap_id = keeper_id WHERE wireless_ap_id = ANY(drop_ids);

    -- Finally remove the duplicate shell AP rows.
    DELETE FROM wireless_aps WHERE id = ANY(drop_ids);
  END LOOP;
END
$$;

-- ══ Reporting suite ═══════════════════════════════════════════════════════════
-- Saved report configurations (per-user, keyed by created_by). A saved report
-- captures a template + scope + date range so it can be re-run from a chip.
CREATE TABLE IF NOT EXISTS saved_reports (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  template    TEXT NOT NULL,
  scope_type  TEXT NOT NULL DEFAULT 'all',  -- all/site/device/multi
  scope_id    INTEGER,                       -- site_id or device_id
  scope_ids   INTEGER[],                     -- for multi-device
  scope_name  TEXT,                          -- display name
  date_range  TEXT NOT NULL DEFAULT '30d',   -- 24h/7d/30d/90d/custom
  date_from   DATE,
  date_to     DATE,
  sla_target  NUMERIC DEFAULT 99.5,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_saved_reports_created_by ON saved_reports(created_by);

-- ── Scheduled reports (Phase 2) ───────────────────────────────────────────────
-- A saved report can be scheduled to run on a cadence and be emailed to a set of
-- recipients. The report scheduler (api/reportScheduler.js) polls next_run_at.
ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS schedule TEXT,            -- none/daily/weekly/monthly
  ADD COLUMN IF NOT EXISTS schedule_day INTEGER,     -- 0-6 for weekly (0=Sun)
  ADD COLUMN IF NOT EXISTS schedule_hour INTEGER DEFAULT 7,
  ADD COLUMN IF NOT EXISTS recipients TEXT,          -- comma-separated emails
  ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;

-- Audit log of every scheduled-report run (success or failure).
CREATE TABLE IF NOT EXISTS report_history (
  id          SERIAL PRIMARY KEY,
  report_id   INTEGER REFERENCES saved_reports(id) ON DELETE CASCADE,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status      TEXT NOT NULL DEFAULT 'success',  -- success/failed
  error       TEXT,
  recipients  TEXT,
  report_data JSONB
);
CREATE INDEX IF NOT EXISTS idx_report_hist_report
  ON report_history(report_id, run_at DESC);

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO spanvault_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO spanvault_user;

-- ── Hub cross-DB read role ───────────────────────────────────────
-- The Hub reads across all suite DBs via the shared `nocvault_readonly`
-- role. The suite installer grants it SELECT once, but tables added by a
-- future release (or created at runtime as spanvault_user) are never
-- covered by that one-time grant -- and the updater re-applies THIS file
-- (as spanvault_user, the table owner) but not the installer's grant. So a
-- new table becomes invisible to the Hub's cross-DB reads. Re-granting here
-- makes both installer and updater converge, and ALTER DEFAULT PRIVILEGES
-- FOR ROLE spanvault_user auto-covers every future spanvault_user-created
-- table. SELECT-only; no-op on a standalone SpanVault (no role). Mirrors
-- netvault/schema.sql.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocvault_readonly') THEN
        GRANT USAGE ON SCHEMA public TO nocvault_readonly;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO nocvault_readonly;
        ALTER DEFAULT PRIVILEGES FOR ROLE spanvault_user IN SCHEMA public GRANT SELECT ON TABLES TO nocvault_readonly;
    END IF;
END
$$;

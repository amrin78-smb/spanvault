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

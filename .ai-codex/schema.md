# SpanVault DB schema (scripts/schema.sql, 1488 lines, 47 tables)

Idempotent: re-applied automatically on every API startup (`api/server.js`, since
1.25.2) via advisory lock, and again by `installer/Update-SpanVault.ps1`. Every
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is a later-migration column bolted onto
an earlier `CREATE TABLE IF NOT EXISTS` — read column groups as chronological
layers, not a single flat design.

Format: `TableName  id(PK,type) | col(type,constraints) | col — FK -> OtherTable`

## Core monitoring
- `monitored_devices`  id(PK,SERIAL) | name,ip_address(TEXT NOT NULL, UNIQUE) | device_type,site_id,site_name,device_vendor | netvault_device_id — soft-FK to netvault.devices (no real FK, cross-DB) | snmp_enabled,snmp_version,snmp_community,snmp_port,snmp_v3_user,snmp_v3_auth_pass,snmp_v3_priv_pass | poll_interval_seconds,ping_threshold_ms,ping_failures_before_down | current_status,consecutive_failures,last_response_ms,last_checked_at,last_seen_at | active,is_gateway(one per site, partial unique idx),alert_suppressed,suppressed_by_device_id — FK->self | agent_id — FK->agents | topology_discovered_at | created_at,updated_at
- `ping_results`  id(PK,BIGSERIAL) | device_id — FK->monitored_devices CASCADE | ts,response_ms,packet_loss_pct,status | agent_id — FK->agents SET NULL
- `snmp_results`  id(PK,BIGSERIAL) | device_id — FK->monitored_devices CASCADE | ts,oid,metric_name,value,if_index,if_name | agent_id — FK->agents SET NULL
- `device_sensors`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE | sensor_key(UNIQUE w/ device_id),sensor_name,category,metric_name,oid,enabled | is_custom,custom_label,custom_unit

## Alerting
- `alerts`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE (nullable) | alert_type,severity,message,metric_value,triggered_at,acknowledged_at,acknowledged_by,resolved_at,status(1 active per device+type, partial unique idx) | suppressed_by — FK->monitored_devices SET NULL | suppression_reason,note | agent_id — FK->agents CASCADE (1 active per agent+type) | service_check_id — FK->service_checks CASCADE (1 active per svc+type) | wireless_ap_id — FK->wireless_aps CASCADE (1 active per ap+type) | wireless_controller_id — FK->wireless_controllers CASCADE (1 active per ctl+type) | wireless_client_mac(TEXT, 1 active per mac+ctrl+type — NOT an FK, see debt below) | incident_id — FK->incidents SET NULL — **polymorphic-by-nullable-FK: exactly one of device_id/agent_id/service_check_id/wireless_ap_id/wireless_controller_id/wireless_client_mac is meaningful per row depending on alert_type; no CHECK enforces this, code convention only**
- `alert_rules`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE (nullable) | metric,operator,threshold(nullable),severity,enabled,created_at | scope('global'/'site'/'device'/'service'),site_id,site_name,notify_recovery,description | service_check_id — FK->service_checks CASCADE
- `availability_summary`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE | date(UNIQUE w/ device_id),uptime_pct,avg/min/max_response_ms,total_checks,failed_checks
- `maintenance_windows`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE (nullable) | starts_at,ends_at,reason,created_at | service_check_id — FK->service_checks CASCADE (nullable) — CHECK: device_id and service_check_id mutually exclusive (both-NULL = global scope)
- `device_dependencies`  id(PK,SERIAL) | child_device_id,parent_device_id — FK->monitored_devices CASCADE (UNIQUE pair, CHECK no self-dep)
- `audit_log`  id(PK,BIGSERIAL) | ts,user_email,user_role,method,path,status,detail(JSONB),ip
- `notification_routes`  id(PK,SERIAL) | name,match_severity,match_site_id,match_alert_type(all nullable=any),email_to,enabled,created_at
- `notification_state`  PK(device_id,agent_id,alert_type) — device_id/agent_id default 0 meaning "none" (avoids NULL in composite key) | last_notified_at
- `escalation_steps`  id(PK,SERIAL) | step_order,after_minutes,email_to,use_oncall,enabled
- `oncall_shifts`  id(PK,SERIAL) | contact_email,starts_at,ends_at,created_at
- `alert_escalations`  PK(alert_id,step_id) | alert_id — FK->alerts CASCADE | fired_at
- `app_settings`  key(PK,TEXT) | value(TEXT) — freeform key/value incl. wireless alert thresholds (14 keys seeded, see gotchas.md), SMTP config, retention windows

## Distributed polling agents
- `agents`  id(PK,SERIAL) | name,api_key(UNIQUE,default gen_random_uuid()),status,version,ip_address,hostname,last_seen_at,connected_at,created_at,updated_at | disabled | health(JSONB — self-reported cpu/mem/disk/uptime/buffer depth)
- `agent_sites`  PK(agent_id,site_id) | agent_id — FK->agents CASCADE | site_id,site_name — soft-FK to netvault.sites
- `agent_discovered_devices`  id(PK,SERIAL) | agent_id — FK->agents CASCADE | ip_address(UNIQUE w/ agent_id),sys_name,sys_descr,mac,vendor,snmp_ok,adopted,first_seen_at,last_seen_at | snmp_community,snmp_version — carries the working creds found during discovery so adoption doesn't guess public/2c

## Service checks (agentless)
- `service_checks`  id(PK,SERIAL) | name,type('http'|'tcp'|'ssl'|'dns'),target,site_id,site_name | agent_id — FK->agents SET NULL (NULL=central) | interval_seconds,params(JSONB),current_status,last_response_ms,last_detail,last_checked_at,active,created_at,updated_at | group_id(UUID) — ties multi-type checks created together, NULL=standalone
- `service_check_results`  id(PK,BIGSERIAL) | check_id — FK->service_checks CASCADE | ts,status,response_ms,detail

## Interactive map designer
- `sv_maps`  id(PK,SERIAL) | uuid(UNIQUE,default gen_random_uuid()),name,description,bg_color,bg_image_b64,canvas_w,canvas_h,is_public,created_at,updated_at
- `map_devices`  id(PK,SERIAL) | map_id — FK->sv_maps CASCADE | device_id — FK->monitored_devices CASCADE (nullable) | x,y,label,icon_type,width,height | z_index,node_style('box'|'icon') | locked,group_id,drill_map_id — FK->sv_maps SET NULL | service_check_id — FK->service_checks CASCADE — CHECK: device_id and service_check_id mutually exclusive (both-NULL = label-only/empty node, legal)
- `map_connections`  id(PK,SERIAL) | map_id — FK->sv_maps CASCADE | from_item_id,to_item_id(INTEGER, FK DROPPED — see debt below) | color,line_style,label | arrow,width | from_if_index,to_if_index,capacity_bps — weathermap link binding | routing('straight'|'elbow'),waypoints(JSONB) | from_kind,to_kind('device'|'service'|shape kind) — discriminates which table from/to_item_id points into
- `map_labels`  id(PK,SERIAL) | map_id — FK->sv_maps CASCADE | x,y,text,font_size,color,bold | z_index,locked,group_id
- `map_shapes`  id(PK,SERIAL) | map_id — FK->sv_maps CASCADE | kind(rect/ellipse/line/arrow/text/zone/cloud/internet/wan/router/switch/firewall/server/loadbalancer/ap/database/building) | x,y,width,height,fill,stroke,stroke_width,text,font_size,text_color,rotation,z_index | locked,group_id

## Intelligence layer (api/intelligence.js)
- `device_baselines`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE | metric,period_days(UNIQUE w/ device_id+metric) | mean,stddev,p50,p95,p99,min_val,max_val,sample_count,computed_at
- `device_health_scores`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE, nullable, UNIQUE | score,uptime_score,response_score,anomaly_score,alert_score,grade,trend,computed_at | service_check_id — FK->service_checks CASCADE, UNIQUE (WHERE not null) — CHECK: exactly one of device_id/service_check_id set (never both, never neither)
- `device_anomalies`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE | metric,value,baseline_mean,baseline_stddev,z_score,severity,detected_at,resolved_at,status(1 active per device+metric, partial unique idx)
- `device_patterns`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE | pattern_type,metric,description,hour_of_day,day_of_week,avg_value,baseline_value,confidence,detected_at,last_seen_at,occurrence_count — unique slot on (device,type,metric,COALESCE(hour,-1),COALESCE(day,-1))
- `incidents`  id(PK,SERIAL) | title | root_cause_device_id — FK->monitored_devices SET NULL | affected_count,severity,status,started_at,resolved_at,duration_seconds,summary,timeline(JSONB)
- `threshold_recommendations`  id(PK,SERIAL) | device_id — FK->monitored_devices CASCADE | metric(UNIQUE w/ device_id),current_threshold,recommended_threshold,reasoning,confidence,computed_at

## Topology (LLDP/CDP)
- `topology_links`  id(PK,SERIAL) | from_device_id — FK->monitored_devices CASCADE | from_port,from_port_desc | to_device_id — FK->monitored_devices SET NULL (nullable — neighbor may not be monitored) | to_ip,to_name,to_port,to_port_desc | protocol('lldp'/'cdp'),discovered_at,last_seen_at — unique on (from_device_id,from_port,protocol)

## Wireless
- `wireless_controllers`  id(PK,SERIAL) | name,vendor,controller_url | api_key,api_username,api_password [SENSITIVE] | site_id,site_name,poll_interval_seconds | snmp_device_id — FK->monitored_devices SET NULL, UNIQUE (WHERE not null) | active,last_polled_at,status,last_error,model,firmware_version,licensed_aps | ha_mode,ha_peer_ip,ha_sync_status,ap_disconnects_24h | ha_peer_controller_id — FK->self SET NULL, ha_manual_role | capabilities(JSONB),capabilities_probed_at | chassis_temp_c,chassis_temp_status,last_reboot_reason,reported_ap_count,reported_client_count | ha_active_aps,ha_standby_aps,ha_total_aps,ha_active_vap_tunnels,ha_standby_vap_tunnels,ha_total_vap_tunnels,ha_ap_hbt_tunnels | ha_peers(JSONB array) | api_client_id,api_client_secret,api_customer_id,api_refresh_token,api_access_token,api_token_expires_at,api_group_filter [SENSITIVE — Aruba Central OAuth2, refresh_token ROTATES on every use, see gotchas.md] — **only table with a deliberate column-level readonly-role exclusion, see Privilege notes**
- `wireless_aps`  id(PK,SERIAL) | controller_id — FK->wireless_controllers CASCADE | monitored_device_id — FK->monitored_devices SET NULL | name(UNIQUE w/ controller_id),mac_address,model,ip_address,site_id,site_name,status | radio_2g/5g/6g_channel,radio_2g/5g_util_pct,clients_2g/5g/6g/total,tx_power_2g/5g,uptime_seconds,firmware_version,last_seen_at,updated_at | noise_floor_2g/5g,retry_rate_2g/5g,rx/tx_errors_2g/5g,throughput_in/out_bps,serial_number,auth_failures | interference_pct_2g/5g,reboot_count,bootstrap_count | rx/tx_errors_delta_2g/5g | cpu_pct,mem_total,mem_free — RF columns (channel/util/tx_power/noise_floor) are written COALESCE-style, never plain overwrite — see gotchas.md
- `wireless_history`  id(PK,BIGSERIAL) | ap_id — FK->wireless_aps CASCADE | ts,clients_total,clients_2g,clients_5g,radio_2g_util,radio_5g_util | noise_floor_2g/5g,throughput_in/out_bps,auth_failures,retry_rate_2g/5g,interference_pct_2g/5g
- `wireless_ssids`  id(PK,SERIAL) | controller_id — FK->wireless_controllers CASCADE | ssid_name(UNIQUE w/ controller_id),site_id,site_name,status,clients_total,bytes_in,bytes_out,auth_successes,auth_failures,updated_at | encryption_type
- `wireless_intelligence`  id(PK,SERIAL) | controller_id — FK->wireless_controllers CASCADE, UNIQUE | computed_at,co_channel_pairs,interference_score,load_balance_score,overloaded_aps,underloaded_aps,avg/max_clients_per_ap,band_2g/5g_pct,band_steering_score,high_util_ap_count,critical_util_count,capacity_score,overall_score,overall_grade,recommendations(JSONB)
- `wireless_ap_intelligence`  id(PK,SERIAL) | ap_id — FK->wireless_aps CASCADE, UNIQUE | computed_at,health_score,health_grade,co_channel_neighbors,channel_recommendation,load_status,load_pct,band_ratio_healthy,issues(JSONB),recommendations(JSONB)
- `wireless_clients`  id(PK,SERIAL) | mac_address,ip_address,hostname | controller_id — FK->wireless_controllers CASCADE | ap_id — FK->wireless_aps SET NULL | ap_name,ssid_name,band,channel,rssi_dbm,tx_rate_mbps,rx_rate_mbps,connected_since,last_seen_at,auth_type,is_problem,roaming_count,vendor(NOT NULL) — unique on (controller_id,mac_address); **row is hard-deleted after 15min inactivity, gets a NEW id on reconnect — never FK to this table's id from a history/alert table, key off (mac_address,controller_id) instead** | is_sticky | rx_bps,tx_bps [runtime-probed via information_schema before use, see debt below] | rx_bytes_raw,tx_bytes_raw,byte_counter_bits,bw_sampled_at | phy_mode,vlan_id,os_type
- `wireless_client_history`  id(PK,BIGSERIAL) | mac_address(NOT keyed by wireless_clients.id — see above) | controller_id — FK->wireless_controllers CASCADE | ts,rx_bps,tx_bps,rssi_dbm
- `wireless_rogue_aps`  id(PK,SERIAL) | controller_id — FK->wireless_controllers CASCADE | bssid(UNIQUE w/ controller_id),ssid,rssi_dbm,channel,classification,detecting_ap,first_seen_at,last_seen_at
- `wireless_client_events`  id(PK,BIGSERIAL) | mac_address | controller_id — FK->wireless_controllers CASCADE | event_type(join/roam/leave/auth_fail/low_signal) | from_ap_id,to_ap_id — FK->wireless_aps SET NULL | from_ap_name,to_ap_name,rssi_dbm,ssid_name,ts — purged after 7 days by collector
- `wireless_central_events`  id(PK,BIGSERIAL) | controller_id — FK->wireless_controllers CASCADE | central_event_id,dedupe_key(UNIQUE w/ controller_id),ts,device_type,device_mac,serial,hostname,level,type,description,created_at — Aruba Central's native event stream, distinct from wireless_client_events (synthesized locally)
- `wireless_ap_bandwidth_topn`  id(PK,SERIAL) | controller_id — FK->wireless_controllers CASCADE | ap_id — FK->wireless_aps SET NULL | ap_name,serial(UNIQUE w/ controller_id),rx_bytes,tx_bytes,window_start,window_end,updated_at — overwritten each poll, NOT accumulated history

## Reporting
- `saved_reports`  id(PK,SERIAL) | name,template,scope_type('all'/'site'/'device'/'multi'),scope_id,scope_ids(INTEGER[]),scope_name,date_range,date_from,date_to,sla_target,created_by,created_at,last_run_at | schedule,schedule_day,schedule_hour,recipients,last_sent_at,next_run_at
- `report_history`  id(PK,SERIAL) | report_id — FK->saved_reports CASCADE | run_at,status,error,recipients,report_data(JSONB)

## Known schema debt

**RESOLVED 2026-07 — see Privilege notes below for the fix.** `scripts/schema.sql`'s
blanket `GRANT SELECT ON ALL TABLES IN SCHEMA public TO nocvault_readonly` used to
have no column-level exclusion anywhere in this file, contradicting CLAUDE.md's
explicit "never re-run the blanket form" warning about `wireless_controllers`. Live
production was verified safe at the time this was found (a column-level grant had
been applied manually, out-of-band, directly against the server — never written into
this file), but the fix was fragile: the next routine `schema.sql` re-apply (a normal,
automatic part of every deploy) would have silently re-widened it with no error and
no warning, since a table-level `GRANT` unconditionally overrides any earlier
column-level restriction in Postgres. A REVOKE+column-GRANT block now lives directly
in `scripts/schema.sql`, immediately after the blanket grant, so the restriction
re-derives itself every time the file runs instead of depending on someone
remembering a manual step. The **suite installer** (`../netvault/installer/
Install-NocVault-Suite.ps1`) also needed a companion fix — see Privilege notes.

**Wide code-side defensive re-probing of columns/tables that schema.sql already
guarantees.** `getAlertCaps()` (api/server.js ~3397) queries
`information_schema.columns`/`.tables` at runtime for `alerts.note`,
`alerts.incident_id`, `incidents` (table), `alerts.agent_id`,
`alerts.service_check_id`, `alerts.wireless_ap_id` — all of which are
unconditionally added by this same schema.sql. Same pattern for
`wireless_clients.is_sticky`/`rx_bps` (`wcHasSticky()` et al.). This isn't a bug —
it's deliberate defense against a mid-upgrade window where the API process
restarts before the schema-apply step has run — but it means schema.sql and
"columns the code assumes exist" are treated as two independent sources of
truth by convention, not enforced together; a new column added to schema.sql
without an accompanying `information_schema` probe update will simply be
assumed present (fine for a fresh install, riskier for an in-place upgrade
mid-deploy window).

**`alerts` is a wide polymorphic table with no CHECK enforcing exclusivity.**
Six different nullable owner columns (`device_id`, `agent_id`,
`service_check_id`, `wireless_ap_id`, `wireless_controller_id`,
`wireless_client_mac`) — which one is populated depends on `alert_type`, but
nothing in the schema enforces "exactly one" the way `device_health_scores` and
`maintenance_windows` do with an explicit CHECK constraint. Every route that
reads `alerts` must LEFT JOIN all six and handle nulls (see `/api/dashboard/events`
and `/api/alerts` comments about this exact class of bug: an INNER JOIN on
`monitored_devices` silently drops every wireless/service-check alert).

**`map_connections.from_item_id`/`to_item_id` dropped their FK constraints
on purpose.** `DROP CONSTRAINT IF EXISTS map_connections_from/to_item_id_fkey`
turned them into plain untyped integers so a connection endpoint can reference
either `map_devices.id` or `map_shapes.id`, discriminated by the sibling
`from_kind`/`to_kind` columns — orphan cleanup is handled application-side (the
map-layout save rewrites the whole map), not by the database.

**`netvault.devices.ip_address` is `character varying`, not `inet`** (cross-DB,
confirmed 2026-07 against live `information_schema.columns` after a `host()`
cast broke NetVault sync in three places) — `monitored_devices.ip_address` here
is plain `TEXT` deliberately for the same reason; never add a `host()`/`inet`
cast when joining/importing from netvault's `devices` table.

## Privilege notes

- **`spanvault_user`** (app role) gets `GRANT ALL PRIVILEGES` reasserted after
  almost every table block in this file — belt-and-suspenders idempotency, not
  a sign of a narrower role anywhere.
- **`wireless_controllers`** holds five live secret/credential columns
  (`api_key`, `api_password`, `api_client_secret`, `api_refresh_token`,
  `api_access_token`) that must stay excluded from both `claude_readonly` and
  `nocvault_readonly`. FIXED 2026-07: a column-level `GRANT SELECT (...)` listing
  all 42 non-secret columns (enumerated live, not hand-typed from this file) now
  lives directly in `scripts/schema.sql`, immediately after the blanket
  `nocvault_readonly` grant — REVOKE-then-column-GRANT, since a table-level GRANT
  overrides column-level restrictions in Postgres, so the REVOKE must come first
  and the whole block must run LAST among anything touching that role's privileges
  on this table. `api_refresh_token`/`api_access_token` are Aruba Central's OAuth2
  tokens and actively rotate — a new secret-shaped column here needs the same
  treatment (add REVOKE if not already covered, and deliberately leave it OUT of
  the allowlist, never IN).
- **The suite installer's `GrantNocRoRead` helper also needed a companion fix.**
  `../netvault/installer/Install-NocVault-Suite.ps1` calls `GrantNocRoRead
  "spanvault"` — an unconditional blanket `GRANT SELECT ON ALL TABLES` to
  `nocvault_readonly` (never `claude_readonly`) — and it used to run AFTER
  `schema.sql` during a fresh suite install, which meant it silently re-widened
  `wireless_controllers` back to table-wide access on day one of every new
  install, even after the schema.sql fix above shipped. Reordered 2026-07 to run
  BEFORE `schema.sql` instead — whichever grant runs last wins, so schema.sql
  (now running second) always ends with the correct narrow grant. Safe to run
  before any table exists: `GRANT SELECT ON ALL TABLES` on zero tables is a
  no-op, and its `ALTER DEFAULT PRIVILEGES` only auto-grants SELECT on tables
  about to be created, which schema.sql's own later REVOKE still correctly
  narrows regardless of how the grant first landed.
- **New tables need an explicit per-table `GRANT SELECT ... TO claude_readonly,
  nocvault_readonly`** run separately (by `postgres`, over localhost) — this
  file only grants `spanvault_user`. Exception: the `nocvault_readonly` block at
  the bottom of this file already grants it table-wide on every apply, which is
  the actual point of concern for any table holding secrets — see above.
- A table holding any future secret/credential column must repeat the
  `wireless_controllers` column-level-exclusion pattern explicitly wherever that
  grant script lives — a missing column in a readonly diagnostic query is the
  correct fail-closed behavior; a newly-secret column silently becoming
  world-readable via the blanket form is the failure mode to avoid.

<!--
RELEASE PROCESS:
1. Update version in package.json
2. Add new section to CHANGELOG.md:
   ## v1.x.x â€” YYYY-MM-DD
   ### What's New
   - Feature 1
   - Feature 2
3. git add package.json CHANGELOG.md
4. git commit -m "chore: bump version to v1.x.x"
5. git push
6. Users see update available in Settings â†’ Updates
-->

# SpanVault Changelog

## v1.0.1 — 2026-06-08
### What's New
- Test version bump

## v1.0.1 — 2026-06-08
### What's New
- Fix: require 3 consecutive healthy responses before update reload
- Fix: interface panel shows summary only by default
- feat: app versioning with semver
- feat: update notification banner

## v1.0.0 â€” 2026-06-08
### Initial Release
- Multi-vendor network monitoring (ICMP + SNMP)
- 18+ vendor parsers (Fortinet, Palo Alto, Cisco, Aruba, 
  Ruckus, MikroTik, HPE, Juniper, Huawei, Dell, and more)
- Distributed polling agents (Windows)
- Site gateway dependency and alert suppression
- Topology discovery (LLDP/CDP with ARP fallback)
- Wireless visibility (SNMP + controller API)
- Interactive map designer with public sharing
- Intelligence layer (anomaly detection, health scores,
  capacity forecasting, incident correlation)
- Human-language alert messages
- 8 report templates with PDF export
- Scheduled report delivery via email
- Role-based access control (from NetVault SSO)
- License enforcement (trial/grace/active)
- Self-update from Settings UI
- Custom SNMP OID sensors
- 24h sparkline trends on device list
- Additional sensors: Fortinet HA/VPN, Palo Alto sessions,
  Cisco BGP



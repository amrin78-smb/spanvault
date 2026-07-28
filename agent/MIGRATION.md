# This agent has been extracted into the unified NocVault Agent

As of the NocVault suite **Agents Phase 1** (2026-07), the reusable runtime of this agent
(transport / offline buffer / reconnect / heartbeat / health / self-update) was extracted into a
single **unified agent** that lives in the **netvault** repo:

- `netvault/agent/` — the unified NocVault Agent (`core/` + `modules/span/` + entrypoint).
- Design: `netvault/docs/nocvault-agents-architecture.md`, `netvault/docs/nocvault-agents-phase1-plan.md`.

SpanVault's entire edge workload (ping, SNMP plan + legacy, service checks, discovery, config/poll
scheduling) is now the **`span` module** of that unified agent, extracted **byte-for-byte on the
wire** so this server (`api/ws-server.js`) cannot distinguish an old vs new agent.

## This copy is still the LIVE agent (for now)

**Do not delete `spanvault/agent/` yet.** Until **Phase 2** wires the hub (NetVault) to distribute
and enroll the unified agent, this directory remains the agent that:
- SpanVault's server serves at `GET /api/agent/agent.js` (+ `.sha256`) for install/self-update, and
- already-deployed remote hosts run.

## Where to make changes

- **New agent development** goes in `netvault/agent/` (the unified core + `span` module), not here.
- If you must patch the currently-served agent before Phase 2, change it **here** — but keep the
  two in sync (any wire-shape change must land in both, or old/new agents diverge).
- The unified agent deliberately does **not** use this agent's legacy single-file `agent_sha`
  self-update (a multi-file agent can't safely self-overwrite that way); it uses a **signed
  multi-file bundle** updater instead. Full hub-driven distribution is Phase 2.

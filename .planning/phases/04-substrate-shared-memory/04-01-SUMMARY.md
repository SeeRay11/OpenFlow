---
phase: 04-substrate-shared-memory
plan: "01"
subsystem: memory
tags: [agent-substrate, shared-memory, redaction, prompt-injection-guard, mcp, jsonrpc, react]

requires:
  - phase: 01-discovery-engine-port
    provides: "shared/memory.ts wire, decisions D-08/D-09, live Substrate probe in discovery"
  - phase: 03-prompt-uplift
    provides: "Stage seam and card-stages UI that memory plugs into"
provides:
  - "Host module lib/substrate: MCP/JSON-RPC client, scoped read and write, redaction and injection guard, per-run graph id"
  - "Per-card recall before the prompt and remember after the card finishes (engine stages)"
  - "Routes status / read / write / entries / forget"
  - "Card memory chip and inspector text; Memory panel in settings with status, entries and forget"
affects: [06-omp-settings-terminal, 07-integration-migration-removal]

key-files:
  created:
    - packages/flow/lib/substrate/client.ts
    - packages/flow/lib/substrate/memory.ts
    - packages/flow/lib/substrate/guard.ts
    - packages/flow/lib/substrate/routes.ts
    - packages/flow/lib/substrate/index.ts
    - packages/flow/lib/substrate/run-graph.ts
    - packages/flow/lib/substrate/fake-substrate.test-support.ts
    - packages/flow/src/server/memory-client.ts
    - packages/flow/src/ui/memory-panel.tsx
    - packages/flow/src/ui/memory-panel-model.ts
  modified:
    - packages/flow/shared/memory.ts
    - packages/flow/src/server/engine.ts
    - packages/flow/src/server/stages.ts
    - packages/flow/src/ui/card-stages.tsx
    - packages/flow/src/ui/card-stages-model.ts

key-decisions:
  - "D-08: read per project, write per card. The host reads the brief and memory_search (scope repo:<owner/name>, subject prefix openflow/<pipeline>/) before a card; it writes one fact per finished card at openflow/<pipeline>/<run>/<card> (dispatch ordinals -dN), ttl 30d, redacted"
  - "A write counts as stored only when accepted and verified_persisted; other results are reported honestly as unverified, quarantined, denied, conflict or unavailable"
  - "Surface is omp (no openflow surface exists server-side); cards never receive SUBSTRATE_* tokens"
  - "D-09: Substrate has no delete, so Forget writes retraction facts and a local ignore cutoff; the UI states entries lapse on their ttl"
  - "Reads fail open and are visible on the card; memory text is untrusted evidence, quoted and defanged (600 chars per item, 12 lines, 6000 per block) before it enters a prompt"
  - "The Substrate token only travels to https, loopback or the SUBSTRATE_URL origin (security-gate fix)"

patterns-established:
  - "Fail-open reads, honest writes: memory trouble never blocks a card, and the card says so"
  - "Fake Substrate test support (fake-substrate.test-support.ts) for host integration tests"

requirements-completed: [MEM-01, MEM-02, MEM-03, MEM-04]

duration: "~39min for the first landing (13:50-14:29, built with phases 2, 3, 5, 6); hedge-retry and token fixes until 16:31"
completed: 2026-10-19
status: complete
---

# Phase 4: Substrate shared memory Summary

**Cards in a run share project memory through Agent Substrate: one governed fact written per finished card, a redacted and defanged brief read before each next card, and a visible chip, entries list and Forget flow.**

## Performance

- **Duration:** first landing about 39 minutes after the contract (14:29); fixes at 16:13 and 16:31
- **Tasks:** none recorded (direct orchestration)

## Accomplishments

- `read()` fetches the brief and `memory_search` in parallel on every card turn; the block is appended to the prompt by the engine's `recall()`.
- `write()` runs `redact(stripControl(output))` and writes one `fact` per card from `remember()` on done, error or stopped.
- Run B reads what run A's card wrote (tested in `memory.test.ts` and `index.test.ts`).
- Unavailable Substrate shows a `mem unavailable` warning chip and the card runs without memory.
- Live (orchestrator, real Substrate): memory stored with `verified_persisted`, read by a later run and visible in the next card's answer; Forget wrote retraction facts and hid the entry.

## Task Commits

Shared first landing with phases 2, 3, 5, 6:

1. `a153ee993` feat(flow): add omp engine host, stage modules and terminal (SPE-16065)
2. `135dd029e` feat(flow): run cards on the omp engine with uplift, memory and swarm stages (SPE-16065)

Phase 4 follow-ups:

3. `a73f2c165` fix(flow): gate every host route ... Substrate token only travels to https, loopback or SUBSTRATE_URL; memory honours a zero read limit and per-dispatch writes
4. `680ff2e58` fix(flow): store hedged card outputs as todos instead of losing them
5. `3a1c86aea` fix(flow): ... dispatches carry their ordinal to memory
6. `9ffeda884` fix(flow): abort uplift and memory calls when a run is stopped
7. `61ee96d18` fix(flow): ... the Substrate client never follows a redirect

## Files Created/Modified

- `lib/substrate/memory.ts`, `guard.ts`, `client.ts` - scoped read/write, redaction and block builder, transport.
- `lib/substrate/routes.ts`, `index.ts`, `run-graph.ts` - HTTP surface and per-run graph id.
- `src/server/memory-client.ts`, `engine.ts` (`recall`/`remember`/`stage`) - fail-open stage clients.
- `src/ui/card-stages*.ts(x)`, `memory-panel*.ts(x)` - chip, inspector text, settings Memory tab.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

- No PLAN.md; landed in the shared wave commits.
- Hedged outputs were lost: Substrate quarantines hedged text written as a fact. On `quarantine.speculative` the host now re-sends the same text once as a `todo`, which the repo scope accepts; other quarantine reasons are never retried and a refused retry reports the original result (`680ff2e58`).
- Security-gate hardening was added after the wave: token destination restriction, no redirect following, a zero read limit honoured, and per-dispatch writes.
- As D-09 anticipated, Substrate has no delete: Forget is retraction plus a local ignore cutoff, not deletion.

## Issues Encountered

- Hedged card output vanishing from memory (above).
- Memory and uplift calls kept running after Stop until the abort signal was passed to the stage calls (`9ffeda884`).

## User Setup Required

The host reads `SUBSTRATE_URL` and a token (`SUBSTRATE_TOKEN`, `SUBSTRATE_TOKEN_FILE` or `SUBSTRATE_TOKENS_DIR`) from its environment; no secret is stored in `omp-settings.json`. If Substrate is unreachable the card shows memory as unavailable and runs normally.

## Next Phase Readiness

The settings dialog hosts the Memory tab. Verification: `04-VERIFICATION.md` status `passed`, 4/4 truths. Spot-checks: substrate suites 132 pass, UI and client suites 70 pass, engine suite 254 pass, host integration 24 pass, all 0 fail. MEM-01 to MEM-04 SATISFIED.

---
*Phase: 04-substrate-shared-memory*
*Completed: 2026-10-19*

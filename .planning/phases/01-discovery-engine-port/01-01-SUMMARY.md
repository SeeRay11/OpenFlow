---
phase: 01-discovery-engine-port
plan: "01"
subsystem: engine
tags: [omp, rpc, engine-port, contract-suite, fake-engine, discovery, typescript, bun]

requires:
  - phase: none
    provides: "Baseline OpenFlow v1.3 on the OpenCode engine (bun test 1088 pass across 45 files, tsgo clean)"
provides:
  - "Nine evidence reports (1177 lines) under discovery/ with verified omp 18.12.2 RPC, catalog, PTY and Substrate probes"
  - "01-CONTEXT.md locking decisions D-01..D-15"
  - "EngineApi port and engine wire contract (shared/engine.ts) plus stage/settings wires (uplift, memory, swarm, omp, terminal, clarification)"
  - "omp process seam types, binary resolver and host response helpers"
  - "defineEngineContract suite (41 scenarios) and in-memory FakeEngine"
affects: [02-omp-engine-adapter, 03-prompt-uplift, 04-substrate-shared-memory, 05-swarm-per-card, 06-omp-settings-terminal, 07-integration-migration-removal]

key-files:
  created:
    - packages/flow/shared/engine.ts
    - packages/flow/shared/uplift.ts
    - packages/flow/shared/memory.ts
    - packages/flow/shared/swarm.ts
    - packages/flow/shared/omp.ts
    - packages/flow/shared/terminal.ts
    - packages/flow/lib/omp/rpc-types.ts
    - packages/flow/lib/omp/binary.ts
    - packages/flow/lib/host/respond.ts
    - packages/flow/src/server/engine-contract.ts
    - packages/flow/src/server/testing/fake-engine.ts
    - .planning/phases/01-discovery-engine-port/01-CONTEXT.md
    - .planning/phases/01-discovery-engine-port/discovery/01-engine-contract.md
  modified:
    - packages/flow/src/server/engine.ts
    - packages/flow/src/server/client.ts

key-decisions:
  - "D-01: the seam is the existing EngineDeps.api of the browser run engine, now typed EngineApi; omp frames are mapped to the session.next.* / permission.v2.asked / question.v2.asked events so the 3600-line engine suite stays valid"
  - "D-02: one omp --mode rpc-ui child per card session, owned by the host in its own process group; protocol v2 rpc_chunk reassembly mandatory; stdin close is the graceful stop"
  - "D-03: cards run under an isolated omp profile with --no-extensions by default and ULTRATHINK_UPLIFT=0 / AIO_UPLIFT=0 in the card env"
  - "D-05: per-session files live outside the project under <state dir>/omp/<project-hash>/<run>/<node>/"
  - "D-06/D-07: uplift is a host-side call of the ultrathink headless planner; outcomes ok/skipped/failed with no silent fallback"
  - "D-13: OpenCode is removed outright after parity, no flag; vendored upstream packages stay untouched"
  - "D-15: phases 2-6 are file-disjoint slices built against the committed contract; hub files are wired in Phase 7 by single owners"

patterns-established:
  - "Port and test double: engine consumers import only EngineApi; one contract suite runs against FakeEngine and against the real adapter"
  - "Shared wire files in packages/flow/shared/ are the only coupling between browser and host code"

requirements-completed: [ENG-01, ENG-02]

duration: "~27min for discovery and contract (13:23-13:50 commits); FakeEngine and contract suite landed later at 16:33"
completed: 2026-10-19
status: complete
---

# Phase 1: Discovery and engine port Summary

**Evidence-backed CONTEXT (D-01..D-15), an `EngineApi` port with shared wire contracts, and a 41-scenario contract suite that passes against both an in-memory `FakeEngine` and the real Omp host.**

## Performance

- **Duration:** contract and context in about 27 minutes of commits (13:23 to 13:50); the contract suite and `FakeEngine` were added at 16:33
- **Tasks:** no PLAN.md existed, so no task count (see Deviations)
- **Commits:** 6 (listed under Task Commits)

## Accomplishments

- Nine discovery reports (`discovery/01..09-*.md`, 71 to 183 lines each, 1177 lines total) recording live probes: omp 18.12.2 RPC handshake and a 738-model catalog, PTY under Bun and Node, the live Substrate brief, the ultrathink planner contract.
- `01-CONTEXT.md` locked fifteen decisions before any slice was built.
- `shared/engine.ts` (238 lines) defines `EngineApi`, `engineRoutes`, `sessionRoute` and the event names; `src/server/engine.ts` now takes `EngineDeps = { api: EngineApi }`.
- `defineEngineContract` (41 scenarios: health, catalog, prompt/wait/transcript, steps/calls, events, permission/question round-trips, interrupt, release, reuse, malformed create, title, session list) runs against the 647-line `FakeEngine`.

## Task Commits

No per-task commits: the milestone ran as direct orchestration. Commits that belong to this phase:

1. `3e1088ace` docs(planning): scaffold v1.4.0 omp engine milestone (Refs SPE-16069)
2. `c3445cab6` docs(planning): record phase 1 discovery reports (SPE-16062)
3. `cc044ac15` docs(planning): record phase 1 context and locked decisions (SPE-16063)
4. `e7ee52bb9` feat(flow): add omp engine wire contract (SPE-16063)
5. `b3cfdc985` feat(flow): add host response helpers and omp launch contract (SPE-16063)
6. `46b7084e4` test(flow): add FakeEngine and a shared EngineApi contract suite (SPE-16062, SPE-16068)

## Files Created/Modified

- `packages/flow/shared/*.ts` - engine, uplift, memory, swarm, omp, terminal and clarification wires (`shared/clarification.ts` was deleted later in `c9d388905`).
- `packages/flow/lib/omp/rpc-types.ts`, `lib/omp/binary.ts`, `lib/host/respond.ts` - process seam, binary resolver, handler helpers.
- `packages/flow/src/server/engine-contract.ts`, `src/server/testing/fake-engine.ts` - suite and in-memory engine.
- `.planning/phases/01-discovery-engine-port/` - CONTEXT and nine discovery reports.

## Decisions Made

See `key-decisions`. Open items deferred in CONTEXT: deleting vendored upstream packages (needs the user), per-card MCP allowlist parity (later found impossible, see Phase 7), a memory inspect panel (Phase 4 delivered one).

## Deviations from Plan

- **Direct orchestration instead of GSD plans.** No `01-01-PLAN.md` was written; this SUMMARY was added afterwards from the VERIFICATION report, commits and code so the milestone audit can cross-reference requirements.
- **Contract suite and `FakeEngine` came late.** The port types were committed first (`e7ee52bb9`, `b3cfdc985`). The suite and `FakeEngine` were only added at `46b7084e4`, after a QA finding. Until then ENG-02 was open.
- The suite runs the real adapter through the browser client over HTTP to `createHost` with a stub omp (`lib/host/engine-contract.test.ts`), which is how Phase 2 reuses it.

## Issues Encountered

- The stub omp raced the leak scenario: it acknowledged a prompt before reading its script, failing that scenario about three runs in four. `46b7084e4` makes the stub read the script first.
- `FakeEngine` intentionally differs from the real host in places; `785370f5e` made it honour titles and document those differences.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phases 2 to 6 coded against this contract. Verification: `01-VERIFICATION.md` status `passed`, 4/4 truths. Spot-checks: fake leg 50 pass / 0 fail, host leg 43 pass / 0 fail. ENG-01 and ENG-02 SATISFIED.

---
*Phase: 01-discovery-engine-port*
*Completed: 2026-10-19*

---
phase: 02-omp-engine-adapter
plan: "01"
subsystem: engine
tags: [omp, rpc-ui, process-group, sse, session-manager, bun, node-adapter]

requires:
  - phase: 01-discovery-engine-port
    provides: "EngineApi port, engine wire contract, rpc-types, binary resolver, respond helpers, contract suite"
provides:
  - "Host-side omp session manager: one omp --mode rpc-ui process per card session behind /flow/api/engine"
  - "JSON-line RPC client with detached process groups, ready negotiation, rpc_chunk reassembly and SIGTERM-to-SIGKILL group stop"
  - "Frame-to-event mapping, per-session message store (transcript, steps, calls, usage), permission and question round-trips"
  - "Model catalog from omp models with credential-stamp cache; coded checkOmp problems with a fix"
  - "Browser client implementing EngineApi over the engine routes, with sliced waits"
  - "Idle-eviction session cap and 30-day run-state pruning"
affects: [03-prompt-uplift, 04-substrate-shared-memory, 05-swarm-per-card, 06-omp-settings-terminal, 07-integration-migration-removal]

key-files:
  created:
    - packages/flow/lib/omp/rpc.ts
    - packages/flow/lib/omp/session.ts
    - packages/flow/lib/omp/routes.ts
    - packages/flow/lib/omp/launch.ts
    - packages/flow/lib/omp/events.ts
    - packages/flow/lib/omp/frame.ts
    - packages/flow/lib/omp/messages.ts
    - packages/flow/lib/omp/ui-requests.ts
    - packages/flow/lib/omp/models.ts
    - packages/flow/lib/omp/host-tools.ts
    - packages/flow/lib/omp/prune.ts
    - packages/flow/lib/omp/index.ts
    - packages/flow/lib/omp/testing/stub-omp.ts
    - packages/flow/lib/host/index.ts
    - packages/flow/lib/host/node-adapter.ts
    - packages/flow/lib/host/engine-contract.test.ts
  modified:
    - packages/flow/lib/omp/binary.ts
    - packages/flow/src/server/client.ts
    - packages/flow/src/server/engine.ts

key-decisions:
  - "D-02 applied: protocol v2 with rpc_chunk reassembly; the model catalog alone arrives as about 8 chunks"
  - "D-03 applied: isolated --profile openflow, --no-extensions unless opted in, uplift env switches set to 0"
  - "D-04 applied: per-card tool toggles enforced through a generated --config overlay (tools.approval.<tool>: deny); orchestrator dispatch/finish are RPC host tools"
  - "waitForIdle polls in 55 s slices against an overall budget because Bun gave up on a single held request at 300 s"
  - "At the 32-session cap the least recently used idle session is closed and resumes later, instead of failing the create"
  - "Run directories untouched for 30 days are pruned shortly after host start; live sessions, uplift state, loose files and symlinks are never removed"

patterns-established:
  - "The host owns sessions, so a page reload reuses them (CreateSession.reuse)"
  - "Every omp-facing failure is a coded problem carrying a message and a fix"

requirements-completed: [ENG-03, ENG-04, ENG-05]

duration: "~39min for the first landing (13:50-14:29, built with phases 3-6); hardening until 17:10"
completed: 2026-10-19
status: complete
---

# Phase 2: Omp engine adapter Summary

**A host that runs each card as its own `omp --mode rpc-ui` process group behind `/flow/api/engine`, with streaming, cancel that leaves no orphans, permission/question round-trips, usage and transcript, and a browser client that passes the Phase 1 contract suite.**

## Performance

- **Duration:** first landing about 39 minutes after the contract (14:29); race, startup and eviction fixes continued until 17:10
- **Tasks:** none recorded (direct orchestration)

## Accomplishments

- Card output streams from omp frames to the card UI through SSE `events`, `POST prompt` (202), `POST wait`, and `GET transcript/final/steps/calls`.
- Stop sends `abort`, then closes the process group (SIGTERM then SIGKILL plus a process-exit safety net). Live: Stop killed omp within 1.5 s; host SIGTERM killed 6 sessions with no orphans.
- Approval `select` and `ask` dialogs become permission/question events and answer back through `replyPermission`, `replyQuestion`, `rejectQuestion`.
- Missing or too-old omp (`MIN_OMP_VERSION` 18.12.2) yields a visible, actionable message on health, session create and `describe()`.
- The adapter passes `defineEngineContract`: 43 pass / 0 fail over real HTTP against `createHost` with a stub omp.

## Task Commits

The first landing is shared with phases 3-6 (one wave of file-disjoint slices):

1. `a153ee993` feat(flow): add omp engine host, stage modules and terminal (SPE-16063/64/65)
2. `135dd029e` feat(flow): run cards on the omp engine with uplift, memory and swarm stages (SPE-16063/64/65/66)

Phase 2 follow-ups:

3. `f5bffb9f4` fix(flow): re-poll session waits in slices and trim omp notices
4. `27f88e7ba` fix(flow): close omp session races, bound startup and cap live sessions
5. `abb940cef` feat(flow): prune run state older than 30 days
6. `7f54a3453` fix(flow): title sessions by role and task instead of the shared briefing
7. `01cba3b50` fix(flow): evict idle sessions at the cap, claim runs during prune and abort abandoned creates
8. `785370f5e` fix(flow): abort session creation on Stop, key requests by session and note dropped MCP allowlists

## Files Created/Modified

- `lib/omp/rpc.ts`, `session.ts`, `routes.ts`, `launch.ts` - process, session lifecycle (925 lines), HTTP face, launch args.
- `lib/omp/events.ts`, `frame.ts`, `messages.ts`, `ui-requests.ts` - frame mapping, transcript and usage store, permission/question handling.
- `lib/omp/models.ts`, `binary.ts` - catalog and the coded availability check.
- `lib/host/index.ts`, `node-adapter.ts` - composed host for both Bun and the Vite (Node) server.
- `src/server/client.ts` - browser implementation of `EngineApi`.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

- No PLAN.md; the phase was built in the same parallel wave as phases 3 to 6 and landed in two combined commits, so per-phase commit attribution above is by subject and `Refs` trailer, not by exact file ownership.
- Several fixes came from review and security gates after the wave: session start rechecks disposal after every await; sessions register before they start; concurrent reuse shares one start; `ready` and `open_session` have a 60 s deadline; prompt ids are honoured; model ids may not start with a dash; the version probe and card env are filtered (`27f88e7ba`). The 32-session cap first failed creates, then became idle eviction (`01cba3b50`).
- Stop during session creation originally still sent the prompt; `3a1c86aea` and `785370f5e` abort creation on the run's signal and dispose an abandoned create.

## Issues Encountered

- A swarm or long card outlived a single held request (Bun gave up at 300 s); fixed with 55 s wait slices.
- Session-start mount notices from omp cluttered the card; they are dropped and every notice is capped at 240 characters.
- The Sessions panel showed the same briefing text on every row; titles are now built from the card's role and task.
- The leak scenario in the contract suite failed about three runs in four until the stub read its script before acknowledging a prompt.

## User Setup Required

None - requires omp 18.12.2 or newer on PATH (checked and reported by the app).

## Next Phase Readiness

Stage modules (uplift, memory, swarm) hook into the session and the engine's stage seam. Verification: `02-VERIFICATION.md` status `passed`, 5/5 truths. Spot-checks: adapter contract 43 pass, session lifecycle 118 pass, rpc/messages/events 77 pass, routes/ui-requests/binary 47 pass, all 0 fail. Full flow suite 2488 pass / 0 fail / 1 skip at `785370f5e` (orchestrator-measured).

---
*Phase: 02-omp-engine-adapter*
*Completed: 2026-10-19*

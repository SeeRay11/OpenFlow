---
phase: 02-omp-engine-adapter
verified: 2026-10-19T00:00:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 2: Omp Engine Adapter Verification Report

**Phase Goal:** Cards can run on a host-side `omp --mode rpc` session behind the port, with streaming, cancel, permissions, questions, usage and transcript parity.
**Verified:** 2026-10-19
**Status:** passed
**Re-verification:** No — initial verification (no PLAN.md/SUMMARY.md exist; must-haves derived from ROADMAP.md success criteria + ENG-03/ENG-04/ENG-05)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A card run streams omp output into the card UI through `/flow/api/engine` and the browser client | ✓ VERIFIED | `lib/omp/routes.ts` serves `POST prompt` (202), `POST wait`, SSE `events`, `GET transcript/final/steps/calls`; `src/server/client.ts` implements `prompt`, sliced `waitForIdle` (55 s slices), `subscribe`; `src/server/engine.ts:732` subscribes and patches live card state from bus events; adapter contract suite 43 pass; live basic card turn observed |
| 2 | Cancelling a run terminates the omp process tree; no orphan processes remain | ✓ VERIFIED | `session.ts interrupt()` sends `abort` + settles waiters; `stop()` → `proc.close()` → `rpc.ts` detached process-group `SIGTERM→SIGKILL` + process-exit safety net; `rpc.test.ts` group-kill tests (grandchild gone, kill idempotent, crash leaves no orphan); `session.test.ts` interrupt/abort-during-start/dispose tests; live: Stop kills omp within 1.5 s, host SIGTERM killed 6 sessions with no orphans |
| 3 | Permission and question requests round-trip to the user; usage and transcript match the previous experience | ✓ VERIFIED | `lib/omp/ui-requests.ts` handles approval-`select` + `ask` dialogs (reply/reject/cancelAll); routes `permission`/`question`; client `replyPermission/replyQuestion/rejectQuestion`; 20 `ui-requests` tests + session Q&A/cancel-dialog tests + client route tests pass; `messages.ts` store accumulates usage per step, served via `/steps` `/calls` `/final` `/transcript`; live approval + ask round trips observed |
| 4 | Missing omp or a wrong version yields a visible actionable message | ✓ VERIFIED | `lib/omp/binary.ts checkOmp` returns coded problems (`missing`/`spawn`/`version`) each with message + fix; `models.ts requireBinary` throws 503 `omp-unavailable` with joined message+fix on every session create; `GET health` reports `ok:false`; `client.describe()` surfaces the wire sentence; settings dialog reads the same status; `binary.test.ts` + models 502/503 tests + client failure-text tests pass |
| 5 | The adapter passes the Phase 1 contract suite | ✓ VERIFIED | `lib/host/engine-contract.test.ts` runs the shared `defineEngineContract` suite (same suite as `FakeEngine`) against the real adapter — browser client over real HTTP to `createHost` with stub omp: **43 pass / 0 fail** (re-run 2026-10-19, 4.81 s) |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flow/lib/omp/session.ts` | Host-side session manager (one omp process per card) | ✓ VERIFIED | 925 lines, substantive; create/prompt/wait/interrupt/dispose/releaseRun/turns/final/steps/calls all implemented; wired into `lib/omp/index.ts` → `lib/host/index.ts` |
| `packages/flow/lib/omp/rpc.ts` | `omp --mode rpc` process spawn + JSON-line protocol | ✓ VERIFIED | Detached process groups, ready negotiation, command ids, timeouts, graceful shutdown; 33 rpc tests pass incl. group-kill |
| `packages/flow/lib/omp/routes.ts` | `/flow/api/engine` HTTP face | ✓ VERIFIED | health/models/events/sessions/prompt/wait/interrupt/transcript/final/steps/calls/permission/question; 25 routes tests pass |
| `packages/flow/src/server/client.ts` | Browser client over the routes | ✓ VERIFIED | createSession/prompt/waitForIdle/subscribe/replies/transcript/steps/calls/health; client tests pass; consumed by `src/server/engine.ts` |
| `packages/flow/shared/engine.ts` | Wire contract (routes, event shapes, `EngineApi` port) | ✓ VERIFIED | `ENGINE_BASE`, `engineRoutes`, `sessionRoute`, `EngineApi` interface; imported by host, client, engine |
| `packages/flow/lib/omp/binary.ts` | omp discovery + version gate | ✓ VERIFIED | `resolveBinary`/`checkOmp` with actionable problems; shared by launch, models, settings status, terminal |
| `packages/flow/lib/omp/ui-requests.ts` | Approval + ask dialog handling | ✓ VERIFIED | Approval select parsing, multi-question ask, reply/reject/cancelAll; 20 tests pass |
| `packages/flow/lib/omp/messages.ts` | Turn/usage/transcript accumulation | ✓ VERIFIED | Delta assembly, per-step usage, transcript/final/steps/calls reads; messages + events + frame tests pass |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/server/engine.ts` | `src/server/client.ts` | `api.subscribe/prompt/waitForIdle/interrupt/transcript` | WIRED | Engine subscribes to bus, dispatches prompts, interrupts on stop |
| `src/server/client.ts` | `lib/omp/routes.ts` | `POST /flow/api/engine/sessions/*`, SSE `events` | WIRED | Contract suite exercises exactly this path over real HTTP |
| `lib/omp/routes.ts` | `lib/omp/session.ts` | `SessionHost` method calls | WIRED | All session tails delegate to the session host |
| `lib/omp/session.ts` | `lib/omp/rpc.ts` | `SpawnOmp`/`BuildLaunch` | WIRED | `createHost` injects `spawnOmp` + `buildLaunch`; launch tests assert argv |
| `lib/omp/session.ts` | omp process | `abort` command + group kill on close | WIRED | Interrupt path tested; rpc group-kill tests prove tree death |
| Card UI | `checkOmp` status | health route + settings status + `describe()` | WIRED | Health `ok:false`, 503 text, settings dialog, client failure surfacing |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| card turn text | `session.store.transcript()` | omp `assistant_message` delta frames via rpc stdout | Yes — assembled from live frames, not static | ✓ FLOWING |
| step usage | `session.store.steps()` | omp message `usage` records | Yes — per-step tokens served via `/steps` | ✓ FLOWING |
| permission/question | `extension_ui_request` frames | omp `tools/approval.ts` + `ask` tool | Yes — parsed into bus events the UI answers | ✓ FLOWING |
| model catalog | `models.list()` | `omp models` via spawned process | Yes — cached with stamp invalidation | ✓ FLOWING |
| omp availability | `checkOmp()` | `<binary> --version` probe | Yes — version parsed, compared to `MIN_OMP_VERSION` | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Adapter contract (real host + stub omp over HTTP) | `bun test lib/host/engine-contract.test.ts` | 43 pass / 0 fail (4.81 s) | ✓ PASS |
| Session lifecycle (create/prompt/wait/interrupt/dispose/Q&A) | `bun test lib/omp/session.test.ts` | 118 pass / 0 fail | ✓ PASS |
| RPC + messages + events | `bun test lib/omp/rpc.test.ts lib/omp/messages.test.ts lib/omp/events.test.ts` | 77 pass / 0 fail | ✓ PASS |
| Routes + ui-requests + binary | `bun test lib/omp/ui-requests.test.ts lib/omp/binary.test.ts lib/omp/routes.test.ts` | 47 pass / 0 fail | ✓ PASS |

Full flow suite (2488 pass / 0 fail at `785370f5e`, per orchestrator) not re-run: seven verifiers run concurrently; targeted files cover this phase.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| ENG-03 | Host-side `omp --mode rpc` session manager + routes + browser client stream card output; cancel kills the tree with no orphans | ✓ SATISFIED | Truths 1–2 |
| ENG-04 | Permissions, questions, usage, transcript parity | ✓ SATISFIED | Truth 3 |
| ENG-05 | Missing/wrong omp → visible actionable message | ✓ SATISFIED | Truth 4 |

No orphaned requirements: ENG-03/04/05 are the only requirements mapped to Phase 2, and all are covered.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | Stub-marker sweep (`TODO/FIXME/XXX/TBD/PLACEHOLDER/Not implemented`) across `lib/omp/*.ts`, `lib/host/*.ts`, `client.ts`, `shared/engine.ts` | — | None found — clean |

### Human Verification Required

None. All five truths are backed by specific passing tests plus live observations consistent with the code (basic card turn, approval + ask round trips, Stop/cancel kills, SIGTERM with no orphans). No visual-only or external-service-only claims remain unverified.

### Gaps Summary

No gaps. The Omp engine adapter is implemented, wired, tested (285 targeted tests passing across the four runs above), and observed live against real omp 18.12.2. Phase goal achieved.

---
_Verified: 2026-10-19_
_Verifier: Claude (gsd-verifier, Verify2)_

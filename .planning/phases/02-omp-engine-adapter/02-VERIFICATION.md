---
phase: 02-omp-engine-adapter
verified: 2026-10-19T18:03:05Z
status: passed
score: 5/5 must-haves verified
covered_files: [.planning/phases/02-omp-engine-adapter/02-01-SUMMARY.md,
  packages/flow/lib/host/engine-contract.test.ts, packages/flow/lib/host/index.ts, packages/flow/lib/host/node-adapter.ts,
  packages/flow/lib/omp/binary.ts, packages/flow/lib/omp/events.ts, packages/flow/lib/omp/frame.ts, packages/flow/lib/omp/host-tools.ts,
  packages/flow/lib/omp/index.ts, packages/flow/lib/omp/launch.ts, packages/flow/lib/omp/messages.ts, packages/flow/lib/omp/models.ts,
  packages/flow/lib/omp/prune.ts, packages/flow/lib/omp/routes.ts, packages/flow/lib/omp/rpc.ts, packages/flow/lib/omp/session.ts,
  packages/flow/lib/omp/testing/stub-omp.ts, packages/flow/lib/omp/ui-requests.ts, packages/flow/shared/engine.ts,
  packages/flow/src/server/client.ts, packages/flow/src/server/engine-contract.ts, packages/flow/src/server/engine.ts]
covered_digest: "v1:sha256:6c100ac54c297a7ca2a53db34f8a8502ce4fa5a55c9acbe3feb86c479f4913bf"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_verified: 2026-10-19T00:00:00Z
  reason: "Source files changed after the first report (b975f932b, c9d388905, 9491ea496); HEAD 9491ea496"
  changes_reviewed:
    - "shared/engine.ts: EngineApi gains optional releaseRun(runId) (whole-run release); engine-contract.ts drops the now-redundant explicit surface member"
    - "src/server/engine.ts: run finally releases held sessions one by one AND calls api.releaseRun for what the engine never learned of (engine.ts:2487)"
    - "lib/omp/session.ts: fresh (non-resume) starts emit describeLaunch tool-toggle notes as capped flow.notice events"
    - "lib/host/node-adapter.ts: gate hardening (credential-smuggling Host refusal, empty-Host for HTTP/1.0, shared requestUrl for the vite store route)"
  regressions: []
---

# Phase 2: Omp Engine Adapter Verification Report

**Phase Goal:** Cards can run on a host-side `omp --mode rpc` session behind the port, with streaming, cancel, permissions, questions, usage and transcript parity.
**Verified:** 2026-10-19T18:03:05Z
**Status:** passed
**Re-verification:** Yes — re-run against HEAD `9491ea496` after post-report commits; no regressions, `status: passed` retained.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A card run streams omp output into the card UI through `/flow/api/engine` and the browser client | ✓ VERIFIED | `lib/omp/routes.ts` serves `POST prompt` (202), `POST wait`, SSE `events`, `GET transcript/final/steps/calls`; `src/server/client.ts` implements `prompt`, sliced `waitForIdle` (55 s slices), `subscribe`; `src/server/engine.ts:732` subscribes and patches live card state from bus events; adapter contract suite 43 pass; live basic card turn observed |
| 2 | Cancelling a run terminates the omp process tree; no orphan processes remain | ✓ VERIFIED | `session.ts interrupt()` sends `abort` + settles waiters; `stop()` → `proc.close()` → `rpc.ts` detached process-group `SIGTERM→SIGKILL` + process-exit safety net; `rpc.test.ts` group-kill tests (grandchild gone, kill idempotent, crash leaves no orphan); `session.test.ts` interrupt/abort-during-start/dispose tests; run `finally` (`engine.ts:2487`) now also releases held sessions one by one plus `api.releaseRun` for strays; live: Stop kills omp within 1.5 s, host SIGTERM killed 6 sessions with no orphans |
| 3 | Permission and question requests round-trip to the user; usage and transcript match the previous experience | ✓ VERIFIED | `lib/omp/ui-requests.ts` handles approval-`select` + `ask` dialogs (reply/reject/cancelAll); routes `permission`/`question`; client `replyPermission/replyQuestion/rejectQuestion`; 20 `ui-requests` tests + session Q&A/cancel-dialog tests + client route tests pass; `messages.ts` store accumulates usage per step, served via `/steps` `/calls` `/final` `/transcript`; fresh starts additionally surface unenforceable tool toggles as capped `flow.notice`s (`session.ts`, `describeLaunch`); live approval + ask round trips observed |
| 4 | Missing omp or a wrong version yields a visible actionable message | ✓ VERIFIED | `lib/omp/binary.ts checkOmp` returns coded problems (`missing`/`spawn`/`version`) each with message + fix; `models.ts requireBinary` throws 503 `omp-unavailable` with joined message+fix on every session create; `GET health` reports `ok:false`; `client.describe()` surfaces the wire sentence; settings dialog reads the same status; `binary.test.ts` + models 502/503 tests + client failure-text tests pass |
| 5 | The adapter passes the Phase 1 contract suite | ✓ VERIFIED | `lib/host/engine-contract.test.ts` runs the shared `defineEngineContract` suite (same suite as `FakeEngine`) against the real adapter — browser client over real HTTP to `createHost` with stub omp: **43 pass / 0 fail** (re-run 2026-10-19) |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flow/lib/omp/session.ts` | Host-side session manager (one omp process per card) | ✓ VERIFIED | Substantive; create/prompt/wait/interrupt/dispose/releaseRun/turns/final/steps/calls all implemented; wired into `lib/omp/index.ts` → `lib/host/index.ts`; post-report addition (launch-note notices) additive only |
| `packages/flow/lib/omp/rpc.ts` | `omp --mode rpc` process spawn + JSON-line protocol | ✓ VERIFIED | Detached process groups, ready negotiation, command ids, timeouts, graceful shutdown; group-kill tests pass; unchanged since first report |
| `packages/flow/lib/omp/routes.ts` | `/flow/api/engine` HTTP face | ✓ VERIFIED | health/models/events/sessions/prompt/wait/interrupt/transcript/final/steps/calls/permission/question; 25 routes tests pass; unchanged |
| `packages/flow/src/server/client.ts` | Browser client over the routes | ✓ VERIFIED | createSession/prompt/waitForIdle/subscribe/replies/transcript/steps/calls/health + `releaseRun`; consumed by `src/server/engine.ts`; client tests pass |
| `packages/flow/shared/engine.ts` | Wire contract (routes, event shapes, `EngineApi` port) | ✓ VERIFIED | `ENGINE_BASE`, `engineRoutes`, `sessionRoute`, `EngineApi` interface incl. new optional `releaseRun?`; imported by host, client, engine, FakeEngine |
| `packages/flow/lib/omp/binary.ts` | omp discovery + version gate | ✓ VERIFIED | `resolveBinary`/`checkOmp` with actionable problems; shared by launch, models, settings status, terminal; unchanged |
| `packages/flow/lib/omp/ui-requests.ts` | Approval + ask dialog handling | ✓ VERIFIED | Approval select parsing, multi-question ask, reply/reject/cancelAll; 20 tests pass; unchanged |
| `packages/flow/lib/omp/messages.ts` | Turn/usage/transcript accumulation | ✓ VERIFIED | Delta assembly, per-step usage, transcript/final/steps/calls reads; messages + events + frame tests pass; unchanged |
| `packages/flow/lib/host/node-adapter.ts` | Node (vite dev) transport for the host | ✓ VERIFIED | Gate-hardened `requestUrl` (credential-smuggling refusal, empty-Host, shared with vite store route); node-adapter tests pass; contract suite over HTTP still green |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/server/engine.ts` | `src/server/client.ts` | `api.subscribe/prompt/waitForIdle/interrupt/transcript` + `api.releaseRun` in run `finally` | WIRED | Engine subscribes to bus, dispatches prompts, interrupts on stop, releases whole runs at teardown |
| `src/server/client.ts` | `lib/omp/routes.ts` | `POST /flow/api/engine/sessions/*`, `POST runs/release`, SSE `events` | WIRED | Contract suite exercises exactly this path over real HTTP |
| `lib/omp/routes.ts` | `lib/omp/session.ts` | `SessionHost` method calls incl. `releaseRun` | WIRED | All session tails delegate to the session host |
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

### Behavioral Spot-Checks (re-run at HEAD `9491ea496`)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Adapter contract (real host + stub omp over HTTP) + session lifecycle | `bun test lib/host/engine-contract.test.ts lib/omp/session.test.ts` | 164 pass / 0 fail | ✓ PASS |
| Node transport + ui-requests + binary + routes + rpc + messages + events + browser client | `bun test lib/host/node-adapter.test.ts lib/omp/ui-requests.test.ts lib/omp/binary.test.ts lib/omp/routes.test.ts lib/omp/rpc.test.ts lib/omp/messages.test.ts lib/omp/events.test.ts src/server/client.test.ts` | 181 pass / 0 fail | ✓ PASS |
| Engine run teardown (releaseRun finally) | `bun test src/server/engine.test.ts` | 258 pass / 0 fail | ✓ PASS |

Full suite not re-run: seven verifiers run concurrently; targeted files cover this phase.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| ENG-03 | Host-side `omp --mode rpc` session manager + routes + browser client stream card output; cancel kills the tree with no orphans | ✓ SATISFIED | Truths 1–2 (strengthened: whole-run `releaseRun` in `finally`) |
| ENG-04 | Permissions, questions, usage, transcript parity | ✓ SATISFIED | Truth 3 (plus tool-toggle notices surfaced, not silently dropped) |
| ENG-05 | Missing/wrong omp → visible actionable message | ✓ SATISFIED | Truth 4 |

No orphaned requirements: ENG-03/04/05 are the only requirements mapped to Phase 2, and all are covered.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | Stub-marker sweep (`TODO/FIXME/XXX/TBD/PLACEHOLDER/Not implemented`) across `lib/omp/*.ts`, `lib/host/*.ts`, `client.ts`, `shared/engine.ts` | — | None found — clean (re-swept at HEAD) |

### Human Verification Required

None. All five truths are backed by specific passing tests re-run at HEAD plus live observations consistent with the code (basic card turn, approval + ask round trips, Stop/cancel kills, SIGTERM with no orphans). No visual-only or external-service-only claims remain unverified.

### Gaps Summary

No gaps. Post-report changes were reviewed file-by-file: all four touch Phase 2 strictly additively (run-level release safety net, user-visible tool-toggle notices, transport gate hardening, port surface tidy). 603 targeted tests pass at HEAD. Phase goal achieved.

---
_Verified: 2026-10-19T18:03:05Z_
_Verifier: Claude (gsd-verifier, Verify2)_

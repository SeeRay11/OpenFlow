---
phase: 05-swarm-per-card
verified: 2026-10-19T00:00:00Z
status: passed
score: 4/4 must-haves verified
---

# Phase 5: Swarm per card Verification Report

**Phase Goal:** Each card's omp session runs with the agent-swarm omp extension, with swarm progress reflected in card status.
**Verified:** 2026-10-19
**Status:** passed
**Re-verification:** No — initial verification (no PLAN.md/SUMMARY.md exist; must-haves derived from ROADMAP.md Phase 5 success criteria + REQUIREMENTS.md SWM-01..SWM-03 as amended 2026-10-19)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A card session starts with the agent-swarm extension loaded (SC1 / SWM-01) | ✓ VERIFIED | `lib/swarm/launch.ts:buildSwarmLaunch` returns `args: ["-e", <root>/omp]`, `env: {SWARM_DIR, SWARM_ROOT}`, overlay `{task:{maxRecursionDepth:2, isolation:{enabled:false}}}`, `always` system prompt delegating to `a01-orchestrator`; `lib/omp/launch.ts` appends `swarm.args` last and merges overlay; `lib/omp/session.ts` create/start wires `swarm.launch` + `set_subagent_subscription progress` + degraded `flow.notice`. Tests: `lib/swarm/{launch,preflight,index}.test.ts`, `lib/omp/launch.test.ts` ("swarm arguments come last"), `lib/omp/session.test.ts` (swarm groups) — all pass (69 + 28 + 118). Live testimony: delegation to a01-orchestrator, a14-maintenance, a05-backend observed with the live swarm chip. |
| 2 | Card status shows swarm progress and surfaces partial failure with an actionable message (SC2 / SWM-02) | ✓ VERIFIED | `lib/swarm/tracker.ts` feeds every `tool_execution_*`/`subagent_*` frame + `live.json` poll into rows → `flow.swarm.status`; `lib/omp/session.ts:emitSwarm` emits on every frame and `endSwarm` on close; `src/server/engine.ts:752-753` patches runtime `swarm`; `src/ui/card-stages-model.ts:swarmLine` renders counts/pills, `tone: danger` on `failed > 0` or error, `swarm degraded: <error>` text, `settleSwarm` maps open agents to cancelled once the card leaves running. Failure strings are actionable (`<agent> failed: <error>`, degraded preflight carries `fix`, e.g. "Export SWARM_ED25519_KEY."). Tests: `tracker.test.ts`, `card-stages-model.test.ts` (45 pass), `session.test.ts` swarm-end group. Live: swarm chip + partial states observed. |
| 3 | Cancelling a card kills the swarm process tree with no orphans and settles swarm status (SC3 / SWM-03 first half) | ✓ VERIFIED | `lib/omp/session.ts:stop()` bumps generation, `endSwarm` (tracker.dispose → open rows `cancelled`, `active:false`, final `flow.swarm.status` emitted once), `proc.close()`; `lib/omp/rpc.ts` child is `detached` process-group leader, SIGTERM then SIGKILL group sweep + process-exit safety net; `settleSwarm` in UI re-maps stale running/queued to cancelled. Tests: `session.test.ts` process-exit/no-orphan groups (stub spawns `sleep 300` grandchild), dispose-ends-swarm-once. Live testimony: Stop during a swarm run left no process, chip settled to `cancelled`; host SIGTERM killed all 6 live sessions, no orphans. |
| 4 | Failed swarm steps retry within a bounded budget — owned by Agent Swarm's own ladder, no second layer in OpenFlow (SC4 / SWM-03 second half, as amended) | ✓ VERIFIED | Amendment judged HONEST (see below). Ladder is swarm's own contract: `swarm/taskstore.py:47-52` LEGAL_TRANSITIONS (FAILED→RETRY→ESCALATED), `:250-252` (`attempt+1`, `> max_attempts` raises `E_TIMEOUT max_attempts exceeded`); `docs/substrate-leases.md:139` ("FAILED rather than RETRY, because FAILED runs the existing ladder: RETRY behind a fresh claim, bounded by `max_attempts`, then ESCALATED"); `AGENTS.md` documents RETRY/ESCALATED/CANCELLED states, `swarm/retry.py` capped backoff (`SWARM_RETRY_BASE_S/CAP_S`), `MAX_REWORK_LOOPS=2` → ESCALATED. OpenFlow adds no retry layer: no retry/attempt logic in `lib/swarm/*` or card path of `src/server/engine.ts` (its retries are uplift attempts/provider backoff, not swarm lanes). Card shows final state via truth 2/3 wiring. |

**Score:** 4/4 truths verified (0 present-but-unverified, 0 failed)

### Amendment honesty verdict (SWM-03, amended 2026-10-19)

Claim: "the retry half is the swarm's own contract, verified in agent-swarm AGENTS.md and docs/substrate-leases.md; a second layer would multiply cost and loops."
Verdict: **HONEST**. The bounded ladder (`max_attempts` → `E_TIMEOUT`, FAILED → RETRY → ESCALATED) exists in `swarm/taskstore.py` (`:47-52`, `:250-252`) and is described at `docs/substrate-leases.md:139`; `AGENTS.md` corroborates (states incl. RETRY/ESCALATED, `swarm/retry.py`, `MAX_REWORK_LOOPS=2` → ESCALATED, capped backoff vars). `packages/flow` contains no swarm-lane retry loop (grep: `retry\|attempt` in `lib/swarm/*` and the card path is clean), so "adds no second retry layer" is true in code, not just intent.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flow/lib/swarm/launch.ts` | Extension contribution to card launch | ✓ VERIFIED | Substantive (~100 lines); wired by `lib/swarm/index.ts` + `lib/omp/launch.ts`; tested |
| `packages/flow/lib/swarm/preflight.ts` | Can-I-load checks, value-free | ✓ VERIFIED | Six problem codes, 30 s env cache, read-only; tested (9.1K test file) |
| `packages/flow/lib/swarm/tracker.ts` | Frame+live.json → SwarmStatus | ✓ VERIFIED | ~350 lines, bounded scans, dispose-once settle; tested (17.3K test file) |
| `packages/flow/lib/swarm/index.ts` + `routes.ts` | Session host + preflight route | ✓ VERIFIED | `launch`/`tracker`/`handle`, MAX_SESSIONS cap, GET-only read-only route; tested |
| `packages/flow/shared/swarm.ts` | Port types | ✓ VERIFIED | SwarmMode/Status/Tracker/Host, EMPTY_SWARM_COUNTS; imported by engine, session, UI |
| `packages/flow/src/ui/card-stages-model.ts` (swarm section) | Card swarm line | ✓ VERIFIED | `swarmLine`/`settleSwarm`/`swarmVisible`/pills; rendered by `SwarmLine` in `node-card.tsx`; tested |
| `packages/flow/lib/omp/session.ts` (swarm wiring) | Launch/subscription/emit/settle | ✓ VERIFIED | `swarm.launch`, subscription unless off, per-frame emit, `endSwarm` on every close path; tested |
| `packages/flow/src/server/engine.ts:752-753` | `flow.swarm.status` → runtime patch | ✓ VERIFIED | One-line patch, covered by engine tests |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib/swarm/launch.ts` | omp child argv/env | `lib/omp/launch.ts` appends `swarm.args`, merges overlay/env | WIRED | `launch.test.ts` "swarm arguments come last", overlay-merge test |
| `lib/omp/session.ts` | browser card | `flow.swarm.status` → `src/server/engine.ts` patch → `SwarmLine` | WIRED | `events`/`engine`/`card-stages-model` tests + live chip |
| `stop()` | swarm status + process tree | `endSwarm` + group SIGTERM/SIGKILL | WIRED | dispose-once test, no-orphan stub tests, live Stop observation |
| swarm failures | card message | tracker `failure` → status → danger tone/degraded line | WIRED | `tracker.test.ts`, `card-stages-model.test.ts` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| tracker rows | agent states | omp `task`/`subagent_*` frames + `live.json` (`swarm.live.v1`) | ✓ FLOWING | Real frames; corrupt/missing live.json keeps frame state |
| `flow.swarm.status` | SwarmStatus | tracker commit/dispose | ✓ FLOWING | Emitted per frame + once at end |
| card line | counts/pills/error | runtime.swarm via engine patch | ✓ FLOWING | Counts from live rows; failure text from run errors |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| swarm unit tests | `bun test lib/swarm/launch.test.ts lib/swarm/preflight.test.ts lib/swarm/index.test.ts lib/swarm/tracker.test.ts` | 69 pass / 0 fail | ✓ PASS |
| swarm UI model tests | `bun test src/ui/card-stages-model.test.ts` | 45 pass / 0 fail | ✓ PASS |
| omp launch + session (swarm wiring) | `bun test lib/omp/launch.test.ts` (28 pass); `bun test lib/omp/session.test.ts` (118 pass) | 0 fail | ✓ PASS |
| live swarm delegation + Stop settle | orchestrator testimony (real omp 18.12.2, real Substrate/Chrome) | delegation to a01/a14/a05 + gates; Stop → no process, chip `cancelled` | ✓ PASS (testimony; consistent with code paths above) |

Full suite not run (seven verifiers in parallel; per instructions only targeted files).

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| SWM-01 | Card omp session runs with agent-swarm extension | ✓ SATISFIED | Truth 1 |
| SWM-02 | Card status reflects swarm progress incl. partial failure + actionable message | ✓ SATISFIED | Truth 2 |
| SWM-03 (amended) | Cancel kills tree + settles status; retries are swarm's own bounded ladder; no second layer | ✓ SATISFIED | Truths 3+4; amendment honest |

No orphaned requirements: all Phase 5 requirements (SWM-01..03) claimed and satisfied.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | `TODO/FIXME/XXX/TBD/placeholder` grep over `lib/swarm/`, `shared/swarm.ts` | — | No markers found |

### Warnings (non-blocking)

1. **RETRY/ESCALATED labels are not surfaced as such in the card UI.** The tracker reads omp's `task`/subagent frames (`queued/running/completed/failed/cancelled`), not the Task Store states, so a lane the swarm retries or escalates appears as whatever omp reported; no retry/escalation was observed live (also noted in `07-PARITY.md` residual). Per the amended SWM-03 this is out of OpenFlow's scope — the card shows the final lane state — so WARNING, not gap.
2. **Live retry path unobserved.** The bounded ladder is verified in agent-swarm source, not by an OpenFlow test or live run. Acceptable under the amendment (OpenFlow owns no retry code to test); recorded for honesty.

### Human Verification Required

None — automated checks (targeted suites) plus live testimony consistent with the code cover all four truths. The two warnings above are accepted consequences of the amended requirement, not unknowns needing a human.

### Gaps Summary

No gaps. All Phase 5 success criteria and SWM-01..SWM-03 (as amended) are satisfied in code, tests, and consistent live evidence.

---
_Verified: 2026-10-19_
_Verifier: Verify5 (gsd-verifier)_

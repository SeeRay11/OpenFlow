---
phase: 05-swarm-per-card
verified: 2026-10-19T18:02:16Z
status: passed
score: 4/4 must-haves verified
covered_files:
  - .planning/phases/05-swarm-per-card/05-01-SUMMARY.md
  - packages/flow/lib/omp/launch.ts
  - packages/flow/lib/omp/rpc.ts
  - packages/flow/lib/omp/session.ts
  - packages/flow/lib/swarm/index.ts
  - packages/flow/lib/swarm/launch.ts
  - packages/flow/lib/swarm/preflight.ts
  - packages/flow/lib/swarm/routes.ts
  - packages/flow/lib/swarm/tracker.ts
  - packages/flow/shared/swarm.ts
  - packages/flow/src/canvas/node-card.tsx
  - packages/flow/src/server/engine.ts
  - packages/flow/src/ui/card-stages-model.ts
covered_digest: "v3:sha256:392375bebf4d30aac2278f49d23ae3a732c1d9bfc0d6f7d8690905b3d44334ee"
---

# Phase 5: Swarm per card Verification Report

**Phase Goal:** Each card's omp session runs with the agent-swarm omp extension, with swarm progress reflected in card status.
**Verified:** 2026-10-19T18:02:16Z
**Status:** passed
**Re-verification:** Yes — after commits b975f932b, c9d388905, 9491ea496 (HEAD 9491ea496). No PLAN.md exists; must-haves derived from ROADMAP.md Phase 5 success criteria + REQUIREMENTS.md SWM-01..SWM-03 as amended 2026-10-19. `lib/swarm/*` and `shared/swarm.ts` are byte-identical since the initial report; the only diffs in covered files are the launch-input refactor + tool-toggle notices (`session.ts`), the uplift `engine` row + `releaseRun` nested finally (`engine.ts`), and one uplift fact row (`card-stages-model.ts`) — none touches swarm logic. All must-haves re-checked; nothing regressed.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A card session starts with the agent-swarm extension loaded (SC1 / SWM-01) | ✓ VERIFIED | `lib/swarm/launch.ts:buildSwarmLaunch` returns `args: ["-e", <root>/omp]`, `env: {SWARM_DIR, SWARM_ROOT}`, overlay `{task:{maxRecursionDepth:2, isolation:{enabled:false}}}`, `always` system prompt delegating to `a01-orchestrator`; `lib/omp/launch.ts` appends `swarm.args` last and merges overlay; `lib/omp/session.ts` create/start wires `swarm.launch` + `set_subagent_subscription progress` + degraded `flow.notice`. The re-verification diff only repackaged the launch call into an `input` object (identical values) and added `describeLaunch` tool-toggle notices after it — swarm args/env/overlay/subscription lines untouched. Tests re-run at HEAD: `lib/swarm/{launch,preflight,index,tracker}.test.ts` 69 pass, `lib/omp/launch.test.ts` 28 pass ("swarm arguments come last"), `lib/omp/session.test.ts` 121 pass (118 + 3 new launch-notes tests). Live testimony: delegation to a01-orchestrator, a14-maintenance, a05-backend observed with the live swarm chip. |
| 2 | Card status shows swarm progress and surfaces partial failure with an actionable message (SC2 / SWM-02) | ✓ VERIFIED | `lib/swarm/tracker.ts` feeds every `tool_execution_*`/`subagent_*` frame + `live.json` poll into rows → `flow.swarm.status`; `lib/omp/session.ts:emitSwarm` emits on every frame and `endSwarm` on close; `src/server/engine.ts:752-753` patches runtime `swarm` (unchanged by the re-verification diff); `src/ui/card-stages-model.ts:swarmLine` renders counts/pills, `tone: danger` on `failed > 0` or error, `swarm degraded: <error>` text, `settleSwarm` maps open agents to cancelled once the card leaves running (swarm section untouched — the one added line is an uplift `engine` fact). Failure strings are actionable (`<agent> failed: <error>`, degraded preflight carries `fix`, e.g. "Export SWARM_ED25519_KEY."). Tests re-run at HEAD: `tracker.test.ts` (in the 69), `card-stages-model.test.ts` 46 pass. Live: swarm chip + partial states observed. |
| 3 | Cancelling a card kills the swarm process tree with no orphans and settles swarm status (SC3 / SWM-03 first half) | ✓ VERIFIED | `lib/omp/session.ts:stop()` bumps generation, `endSwarm` (tracker.dispose → open rows `cancelled`, `active:false`, final `flow.swarm.status` emitted once), `proc.close()`; `lib/omp/rpc.ts` child is `detached` process-group leader, SIGTERM then SIGKILL group sweep + process-exit safety net (both files' swarm/kill paths untouched by the diff); `settleSwarm` in UI re-maps stale running/queued to cancelled. The new `releaseRun` nested finally in `engine.ts` only returns sessions to the host on run teardown (same release as before, plus whole-run release) — it does not alter per-session stop/settle. Tests re-run at HEAD: `session.test.ts` process-exit/no-orphan groups + dispose-ends-swarm-once, 121 pass. Live testimony: Stop during a swarm run left no process, chip settled to `cancelled`; host SIGTERM killed all 6 live sessions, no orphans. |
| 4 | Failed swarm steps retry within a bounded budget — owned by Agent Swarm's own ladder, no second layer in OpenFlow (SC4 / SWM-03 second half, as amended) | ✓ VERIFIED | Amendment judged HONEST (see below). Ladder is swarm's own contract: `swarm/taskstore.py:47-52` LEGAL_TRANSITIONS (FAILED→RETRY→ESCALATED), `:250-252` (`attempt+1`, `> max_attempts` raises `E_TIMEOUT max_attempts exceeded`); `docs/substrate-leases.md:139` ("FAILED rather than RETRY, because FAILED runs the existing ladder: RETRY behind a fresh claim, bounded by `max_attempts`, then ESCALATED"); `AGENTS.md` documents RETRY/ESCALATED/CANCELLED states, `swarm/retry.py` capped backoff (`SWARM_RETRY_BASE_S/CAP_S`), `MAX_REWORK_LOOPS=2` → ESCALATED. OpenFlow adds no retry layer: no retry/attempt logic in `lib/swarm/*` or card path of `src/server/engine.ts` (its retries are uplift attempts/provider backoff, not swarm lanes) — confirmed again at HEAD. Card shows final state via truth 2/3 wiring. |

**Score:** 4/4 truths verified (0 present-but-unverified, 0 failed)

### Amendment honesty verdict (SWM-03, amended 2026-10-19)

Claim: "the retry half is the swarm's own contract, verified in agent-swarm AGENTS.md and docs/substrate-leases.md; a second layer would multiply cost and loops."
Verdict: **HONEST**. The bounded ladder (`max_attempts` → `E_TIMEOUT`, FAILED → RETRY → ESCALATED) exists in `swarm/taskstore.py` (`:47-52`, `:250-252`) and is described at `docs/substrate-leases.md:139`; `AGENTS.md` corroborates (states incl. RETRY/ESCALATED, `swarm/retry.py`, `MAX_REWORK_LOOPS=2` → ESCALATED, capped backoff vars). `packages/flow` contains no swarm-lane retry loop (grep-clean at HEAD too), so "adds no second retry layer" is true in code, not just intent.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flow/lib/swarm/launch.ts` | Extension contribution to card launch | ✓ VERIFIED | Unchanged since initial report; substantive; wired; tested |
| `packages/flow/lib/swarm/preflight.ts` | Can-I-load checks, value-free | ✓ VERIFIED | Unchanged; six problem codes, 30 s env cache, read-only; tested |
| `packages/flow/lib/swarm/tracker.ts` | Frame+live.json → SwarmStatus | ✓ VERIFIED | Unchanged; bounded scans, dispose-once settle; tested |
| `packages/flow/lib/swarm/index.ts` + `routes.ts` | Session host + preflight route | ✓ VERIFIED | Unchanged; MAX_SESSIONS cap, GET-only read-only route; tested |
| `packages/flow/shared/swarm.ts` | Port types | ✓ VERIFIED | Unchanged; imported by engine, session, UI |
| `packages/flow/src/ui/card-stages-model.ts` (swarm section) | Card swarm line | ✓ VERIFIED | Swarm section unchanged (diff adds one uplift fact only); rendered by `SwarmLine` in `node-card.tsx`; tested |
| `packages/flow/lib/omp/session.ts` (swarm wiring) | Launch/subscription/emit/settle | ✓ VERIFIED | Diff is launch-input repackaging + toggle notices; swarm lines intact; tested (121 pass) |
| `packages/flow/src/server/engine.ts:752-753` | `flow.swarm.status` → runtime patch | ✓ VERIFIED | Patch line unchanged; run-finally change adds `releaseRun`, orthogonal to swarm |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `lib/swarm/launch.ts` | omp child argv/env | `lib/omp/launch.ts` appends `swarm.args`, merges overlay/env | WIRED | Re-confirmed at HEAD; `launch.test.ts` passes |
| `lib/omp/session.ts` | browser card | `flow.swarm.status` → `src/server/engine.ts` patch → `SwarmLine` | WIRED | Re-confirmed; engine patch line unchanged |
| `stop()` | swarm status + process tree | `endSwarm` + group SIGTERM/SIGKILL | WIRED | Re-confirmed; paths untouched |
| swarm failures | card message | tracker `failure` → status → danger tone/degraded line | WIRED | Re-confirmed; section untouched |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| tracker rows | agent states | omp `task`/`subagent_*` frames + `live.json` (`swarm.live.v1`) | ✓ FLOWING | Unchanged code; real frames; corrupt/missing live.json keeps frame state |
| `flow.swarm.status` | SwarmStatus | tracker commit/dispose | ✓ FLOWING | Emitted per frame + once at end |
| card line | counts/pills/error | runtime.swarm via engine patch | ✓ FLOWING | Counts from live rows; failure text from run errors |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| swarm unit tests (HEAD) | `bun test lib/swarm/launch.test.ts lib/swarm/preflight.test.ts lib/swarm/index.test.ts lib/swarm/tracker.test.ts` | 69 pass / 0 fail | ✓ PASS |
| omp session incl. swarm wiring (HEAD) | `bun test lib/omp/session.test.ts` | 121 pass / 0 fail | ✓ PASS |
| swarm UI model + omp launch (HEAD) | `bun test src/ui/card-stages-model.test.ts lib/omp/launch.test.ts` | 74 pass / 0 fail | ✓ PASS |
| live swarm delegation + Stop settle | orchestrator testimony (real omp 18.12.2, real Substrate/Chrome) | delegation to a01/a14/a05 + gates; Stop → no process, chip `cancelled` | ✓ PASS (testimony; consistent with code paths above) |

Full suite not run (seven verifiers in parallel; per instructions only targeted files).

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| SWM-01 | Card omp session runs with agent-swarm extension | ✓ SATISFIED | Truth 1, re-confirmed at HEAD |
| SWM-02 | Card status reflects swarm progress incl. partial failure + actionable message | ✓ SATISFIED | Truth 2, re-confirmed at HEAD |
| SWM-03 (amended) | Cancel kills tree + settles status; retries are swarm's own bounded ladder; no second layer | ✓ SATISFIED | Truths 3+4, re-confirmed at HEAD; amendment honest |

No orphaned requirements: all Phase 5 requirements (SWM-01..03) claimed and satisfied.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | `TODO/FIXME/XXX/TBD/placeholder` grep over `lib/swarm/`, `shared/swarm.ts` | — | No markers found (re-checked at HEAD) |

### Warnings (non-blocking)

1. **RETRY/ESCALATED labels are not surfaced as such in the card UI.** The tracker reads omp's `task`/subagent frames (`queued/running/completed/failed/cancelled`), not the Task Store states, so a lane the swarm retries or escalates appears as whatever omp reported; no retry/escalation was observed live (also noted in `07-PARITY.md` residual). Per the amended SWM-03 this is out of OpenFlow's scope — the card shows the final lane state — so WARNING, not gap.
2. **Live retry path unobserved.** The bounded ladder is verified in agent-swarm source, not by an OpenFlow test or live run. Acceptable under the amendment (OpenFlow owns no retry code to test); recorded for honesty.

### Human Verification Required

None — automated checks (targeted suites re-run at HEAD) plus live testimony consistent with the code cover all four truths. The two warnings above are accepted consequences of the amended requirement, not unknowns needing a human.

### Gaps Summary

No gaps. All Phase 5 success criteria and SWM-01..SWM-03 (as amended) are satisfied in code, tests, and consistent live evidence. The post-report commits (b975f932b, c9d388905, 9491ea496) leave every swarm path intact; the only behavioral addition in covered files is the unenforceable-tool-toggle info notice, which is orthogonal (default-card swarm tests asserting exact notice counts still pass).

---
_Verified: 2026-10-19T18:02:16Z_
_Verifier: Verify5 (gsd-verifier)_

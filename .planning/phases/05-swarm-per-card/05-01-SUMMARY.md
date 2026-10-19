---
phase: 05-swarm-per-card
plan: "01"
subsystem: swarm
tags: [agent-swarm, omp-extension, subagents, preflight, process-tree, react]

requires:
  - phase: 01-discovery-engine-port
    provides: "shared/swarm.ts wire, decision D-10"
  - phase: 02-omp-engine-adapter
    provides: "Session manager, launch arguments, process-group stop"
provides:
  - "Host module lib/swarm: launch contribution (-e <root>/omp), value-free preflight, frame and live.json tracker, GET-only preflight route"
  - "Per-card swarm mode off | auto | always with a visible degrade reason"
  - "flow.swarm.status events from the session to the card's swarm line with counts, pills and failure text"
  - "Swarm status settles on cancel, process exit and failed startup"
affects: [06-omp-settings-terminal, 07-integration-migration-removal]

key-files:
  created:
    - packages/flow/lib/swarm/launch.ts
    - packages/flow/lib/swarm/preflight.ts
    - packages/flow/lib/swarm/tracker.ts
    - packages/flow/lib/swarm/index.ts
    - packages/flow/lib/swarm/routes.ts
    - packages/flow/lib/swarm/testing/
  modified:
    - packages/flow/shared/swarm.ts
    - packages/flow/lib/omp/launch.ts
    - packages/flow/lib/omp/session.ts
    - packages/flow/src/server/engine.ts
    - packages/flow/src/ui/card-stages-model.ts
    - packages/flow/src/canvas/node-card.tsx

key-decisions:
  - "D-10: each card loads agent-swarm's omp extension with -e <root>/omp; default mode auto (the extension's classifier decides), per-card override off|auto|always"
  - "The /swarm command is never used: it writes .claude/swarm-state.json and appends to .planning/STATE.md in the cwd"
  - "Signing is checked by presence only; missing signing, python or root degrades the card to off with a visible reason and a fix such as exporting the signing key"
  - "SWARM_DIR is per card under the state dir; SWARM_AGENT, SWARM_TASK_ID and SWARM_CHILD are never set"
  - "SWM-03 amended 2026-10-19: failed swarm steps retry on Agent Swarm's own bounded ladder (max_attempts, then ESCALATED); OpenFlow adds no second retry layer"
  - "Launch overlay disables task isolation and sets maxRecursionDepth 2; the always mode delegates to a01-orchestrator"

patterns-established:
  - "Trackers settle exactly once: dispose, process exit and failed startup each emit one final status, and the UI never renders a running swarm for a stopped or finished card"

requirements-completed: [SWM-01, SWM-02, SWM-03]

duration: "~39min for the first landing (13:50-14:29, built with phases 2-4, 6); status settling and wait fixes until 15:31"
completed: 2026-10-19
status: complete
---

# Phase 5: Swarm per card Summary

**Each card's omp session loads the Agent Swarm extension, shows live swarm progress and partial failures on the card, and Stop kills the whole process tree and settles the swarm chip; retries are left to the swarm's own bounded ladder.**

## Performance

- **Duration:** first landing about 39 minutes after the contract (14:29); fixes at 14:59 and 15:31
- **Tasks:** none recorded (direct orchestration)

## Accomplishments

- `buildSwarmLaunch` returns `-e <root>/omp`, `SWARM_DIR`/`SWARM_ROOT` env and the config overlay; `lib/omp/launch.ts` appends the swarm args last.
- The tracker folds `tool_execution_*` and `subagent_*` frames plus a `live.json` poll into rows, emitted as `flow.swarm.status`; the card shows counts and pills with a danger tone when a lane failed.
- Stop bumps the session generation, ends the tracker (open rows become `cancelled`) and closes the process group. Live: Stop during a swarm run left no process and the chip read `cancelled`.

## Task Commits

Shared first landing with phases 2, 3, 4, 6:

1. `a153ee993` feat(flow): add omp engine host, stage modules and terminal (SPE-16065)
2. `135dd029e` feat(flow): run cards on the omp engine with uplift, memory and swarm stages (SPE-16065)

Phase 5 follow-ups:

3. `f5bffb9f4` fix(flow): re-poll session waits in slices and trim omp notices (a swarm card outlives one held request)
4. `db04e8702` fix(flow): settle the swarm status when a card session ends
5. `ab74592ec` docs(planning): amend SWM-03 and TRM-01 and add the parity checklist
6. `61ee96d18` fix(flow): ... flaky terminal and swarm tests are deterministic or skipped on Windows

## Files Created/Modified

- `lib/swarm/launch.ts`, `preflight.ts` (six problem codes, 30 s env cache), `tracker.ts`, `index.ts`, `routes.ts`.
- `lib/omp/session.ts` - launch wiring, progress subscription, per-frame emit, `endSwarm` on every close path.
- `src/ui/card-stages-model.ts`, `src/canvas/node-card.tsx` - `swarmLine`, `settleSwarm`, pills.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

- No PLAN.md; built in the shared wave.
- **SWM-03 amended.** The original text required OpenFlow to retry failed swarm steps within a budget. Agent Swarm already owns that ladder (`taskstore.py` LEGAL_TRANSITIONS FAILED to RETRY to ESCALATED, `max_attempts`, capped backoff), so a second layer would multiply cost and loops. REQUIREMENTS.md was amended in `ab74592ec`; the verifier judged the amendment honest.
- After the wave, Stop left the chip reading `running`, which `db04e8702` fixed by emitting one final status on dispose, exit and failed startup.

## Issues Encountered

- A swarm card outlived a single held request (Bun gave up at 300 s), fixed with sliced waits in Phase 2 code.
- Flaky swarm tests were made deterministic or skipped on Windows (`61ee96d18`).
- Residual warnings recorded by verification: the card does not label RETRY or ESCALATED because the tracker reads omp frames, not Task Store states; and the retry ladder is verified in agent-swarm source, not by an OpenFlow test or live run.

## User Setup Required

Agent Swarm must be installed with its signing key, python and root available. When any is missing the card degrades to swarm `off` and says why; nothing is silently skipped.

## Next Phase Readiness

Swarm status feeds the card chips shown in the final UI wiring. Verification: `05-VERIFICATION.md` status `passed`, 4/4 truths. Spot-checks: swarm suites 69 pass, card-stages model 45 pass, launch 28 pass, session 118 pass, all 0 fail. SWM-01 to SWM-03 (as amended) SATISFIED.

---
*Phase: 05-swarm-per-card*
*Completed: 2026-10-19*

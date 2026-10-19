---
phase: 03-prompt-uplift
plan: "01"
subsystem: prompt-uplift
tags: [claude-ultrathink, jev, planner, uplift, host-stage, react, bun]

requires:
  - phase: 01-discovery-engine-port
    provides: "shared/uplift.ts wire, decisions D-06/D-07, host response helpers"
  - phase: 02-omp-engine-adapter
    provides: "Card sessions to send the uplifted task to; engine stage seam"
provides:
  - "Host module lib/uplift: spawns the ultrathink headless planner per card turn with an env allowlist, a pool and abort that kills the process group"
  - "Result interpretation (ok / skipped / failed) and Jev decision parsing"
  - "POST /flow/api/uplift and GET /flow/api/uplift/:run/:node with per-(run,node) persistence"
  - "Engine upliftTask: sends the spec in place of the card task, blocks on failure"
  - "UI: original and uplifted prompt sections, decisions, uplifted chip, failure dialog (Run with original prompt / Retry / Cancel)"
affects: [04-substrate-shared-memory, 06-omp-settings-terminal, 07-integration-migration-removal]

key-files:
  created:
    - packages/flow/lib/uplift/index.ts
    - packages/flow/lib/uplift/planner.ts
    - packages/flow/lib/uplift/result.ts
    - packages/flow/lib/uplift/routes.ts
    - packages/flow/lib/uplift/testing/stub-planner.ts
    - packages/flow/src/server/stages.ts
    - packages/flow/src/ui/uplift-dialog.tsx
    - packages/flow/src/ui/card-stages.tsx
    - packages/flow/src/ui/card-stages-model.ts
  modified:
    - packages/flow/src/server/engine.ts
    - packages/flow/src/graph/prompt.ts
    - packages/flow/src/ui/inspector.tsx
    - packages/flow/shared/uplift.ts

key-decisions:
  - "D-06: uplift is a host-side call of ultrathink's headless planner (bin/run-bun hooks/engine.ts, JSON in/out) with host prime-agent; host omp would return native-unavailable"
  - "D-06: only the card's own task text is uplifted; upstream outputs, attachments and protocol turns never are"
  - "D-07: ok sends the spec XML (never the context markdown); skipped sends the original with a note; failed blocks the card and asks the user, no silent fallback"
  - "A fallback spec (source === fallback) is treated as failed and never sent"
  - "The engine reaches the planner only through EngineDeps.uplift, so tests omit it and prompts go as written"

patterns-established:
  - "Stage seam: engine stages are injected deps adapted to host routes in stages.ts, mockable at the boundary"
  - "Failure dialogs are focus-trapped alertdialogs; Escape cancels and the backdrop is not a dismiss target"

requirements-completed: [UPL-01, UPL-02, UPL-03, UPL-04]

duration: "~39min for the first landing (13:50-14:29, built with phases 2, 4-6); stop and dialog fixes until 16:13"
completed: 2026-10-19
status: complete
---

# Phase 3: Prompt uplift Summary

**Every card task goes through the claude-ultrathink headless planner (with Jev decisions) on the host; the original and uplifted prompts are stored per card, and a failed uplift blocks the card behind an explicit Run-with-original / Retry / Cancel dialog.**

## Performance

- **Duration:** first landing about 39 minutes after the contract (14:29); fixes at 15:27 and 16:13
- **Tasks:** none recorded (direct orchestration)

## Accomplishments

- `upliftTask` in the engine sends `result.uplifted` in place of the original, with decisions carried on `UpliftInfo`.
- Original and uplifted text persist per (run, node) and render as "original prompt" and "uplifted prompt" blocks in the inspector.
- Failure never sends silently: the card goes `failed`, waits on the user, and offers original, retry or cancel (attempt count is `UPLIFT_ATTEMPTS`).
- Live (orchestrator, real planner): uplift applied (about 2 min, 30k-character prompt), Jev skipped a non-new task, and a planner timeout showed the dialog with all three actions.

## Task Commits

Shared first landing with phases 2, 4, 5, 6:

1. `a153ee993` feat(flow): add omp engine host, stage modules and terminal (SPE-16064)
2. `135dd029e` feat(flow): run cards on the omp engine with uplift, memory and swarm stages (SPE-16064)

Phase 3 follow-ups:

3. `9ffeda884` fix(flow): abort uplift and memory calls when a run is stopped
4. `3a1c86aea` fix(flow): stop during session creation, protect gauntlet judges and migrate new fields (uplift dialog last-attempt, repeat keys and late replies)

## Files Created/Modified

- `lib/uplift/planner.ts`, `result.ts`, `routes.ts`, `index.ts` - planner spawn and pool, outcome interpretation, HTTP routes.
- `lib/uplift/testing/stub-planner.ts` - planner stub for tests.
- `src/server/engine.ts`, `src/server/stages.ts` - stage seam and `upliftTask`.
- `src/ui/uplift-dialog.tsx`, `card-stages.tsx`, `card-stages-model.ts`, `inspector.tsx` - dialog, sections, chips.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

- No PLAN.md; built in the shared parallel wave and landed in two combined commits.
- Stop only marked the card stopped while the planner kept running. After a review gate the stage calls carry the run's abort signal, the host kills the planner group on disconnect, and a stopped card never sends its prompt (`9ffeda884`).
- The uplift and settings dialogs needed fixes for their last attempt, repeat keys and late replies (`3a1c86aea`).

## Issues Encountered

- **Planner not killed on Stop** (above): the planner process outlived the stopped card until `9ffeda884`.
- The uplift can take minutes (about 2 min live); a planner timeout lands in the failure dialog rather than sending the original.

## User Setup Required

None in the app. The planner runs `bin/run-bun hooks/engine.ts` from claude-ultrathink with the Claude CLI engine, so both must be present on the host.

## Next Phase Readiness

Memory recall is staged into the same prompt assembly. Verification: `03-VERIFICATION.md` status `passed`, 4/4 truths. Spot-check: `bun test lib/uplift/ src/server/engine.test.ts src/graph/prompt.test.ts src/ui/card-stages-model.test.ts` gave 431 pass / 1 skip / 0 fail. UPL-01 to UPL-04 SATISFIED.

---
*Phase: 03-prompt-uplift*
*Completed: 2026-10-19*

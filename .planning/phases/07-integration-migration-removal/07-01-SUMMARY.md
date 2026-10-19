---
phase: 07-integration-migration-removal
plan: "01"
subsystem: integration
tags: [migration, opencode-removal, route-gate, security, parity, docs, ci, launchers, bun]

requires:
  - phase: 02-omp-engine-adapter
    provides: "Omp host and session manager"
  - phase: 03-prompt-uplift
    provides: "Uplift host module and card stage UI"
  - phase: 04-substrate-shared-memory
    provides: "Substrate memory host module and UI"
  - phase: 05-swarm-per-card
    provides: "Swarm host module and card status"
  - phase: 06-omp-settings-terminal
    provides: "Settings dialog and terminal dock"
provides:
  - "Both hosts (Bun server.ts and the Vite dev server) mount the composed omp host; OpenCode proxy, supervisor, key import, repackage, zen and dispatch MCP server removed with the sdk dependency"
  - "Legacy pipeline, run-log and session migration (src/graph/migrate.ts) with legacy fixtures"
  - "One route gate on every /flow/api request in both hosts (Host, Origin, Sec-Fetch-Site, body content type)"
  - "check:no-opencode gate over fork-owned paths, wired into CI; version 1.4.0"
  - "07-PARITY.md (PARITY: SATISFIED) and 07-INTEGRATION.md (passed, 0 blockers, 8 warnings)"
  - "README, FLOW.md and CHANGELOG 1.4.0 describing the Omp engine"
affects: [milestone audit, release v1.4.0]

key-files:
  created:
    - packages/flow/src/graph/migrate.ts
    - packages/flow/src/graph/__fixtures__/legacy/
    - packages/flow/scripts/check-no-opencode.ts
    - packages/flow/lib/host/gate.ts
    - packages/flow/lib/host/engine-contract.test.ts
    - .planning/phases/07-integration-migration-removal/07-PARITY.md
    - .planning/phases/07-integration-migration-removal/07-INTEGRATION.md
  modified:
    - openflow.ts
    - openflow.sh
    - openflow.ps1
    - packages/flow/server.ts
    - packages/flow/vite.config.ts
    - packages/flow/vite/flow-store.ts
    - packages/flow/lib/store.ts
    - packages/flow/lib/launch.ts
    - packages/flow/src/app.tsx
    - packages/flow/package.json
    - .github/workflows/openflow.yml
    - FLOW.md
    - packages/flow/README.md
    - packages/flow/CHANGELOG.md
    - .planning/REQUIREMENTS.md

key-decisions:
  - "D-13: OpenCode removed outright, no flag; vendored upstream packages (packages/opencode, tui, web, ...) are untouched, deleting them is the user's separate decision"
  - "D-14: legacy pipelines load without crashing; model ids stay as written and are flagged when they cannot exist in the Omp catalog; opencode agent names are dropped with a note; opencode session ids are refused, not resumed"
  - "D-15: hub files (store.ts, server.ts, flow-store.ts, app.tsx, launchers, docs) wired by single owners after the slices"
  - "The route gate covers every case and dot variant of /flow because Vite's connect router matches /flow/api case-insensitively; it mounts ahead of the routers"
  - "Per-card MCP toggles removed: omp has no per-session MCP selection, so every card sees every profile server; CardSpec drops agent.mcp and older pipelines lose it silently"
  - "SWM-03 and TRM-01 amended in REQUIREMENTS.md (honest scope: swarm's own retry ladder; real gate and four-PTY cap)"

patterns-established:
  - "Parity checklist (07-PARITY.md) maps every old engine capability to an Omp equivalent, a dropped item or a named residual risk before removal"
  - "check:no-opencode walks fork-owned surfaces against a reasoned allowlist and is a CI step"

requirements-completed: [MIG-01, MIG-02, MIG-03, QA-01]
requirements-pending: [QA-03]

duration: "~2h44m (14:29 first wiring and removal commits to 17:13 final docs commit)"
completed: 2026-10-19
status: complete
---

# Phase 7: Integration, migration and removal Summary

**OpenCode is gone from the fork-owned tree and both hosts run the composed omp host behind one route gate; legacy pipelines migrate with flagged model ids, parity is documented, and a `check:no-opencode` CI gate keeps it that way.**

## Performance

- **Duration:** about 2h44m from the first wiring commit (14:29) to the last docs commit (17:13); most of it was review-gate fixes
- **Tasks:** none recorded (direct orchestration)
- **Branch totals:** 29 commits on `omp-engine` ahead of `dev`; the wiring commit `135dd029e` alone touches 85 files

## Accomplishments

- `e0893df29` mounted the omp host in `server.ts` and `vite/flow-store.ts`, retargeted MCP and skills to the omp profile and deleted the OpenCode proxy, process supervisor, key import, repackage, zen and the dispatch MCP server plus the sdk dependency (24 files, 769 insertions, 3038 deletions); launchers `openflow.ts/.sh/.ps1` mention `omp`, not `opencode`.
- `src/graph/migrate.ts` (`migratePipeline`, `migrateRunLog`, `legacyModelProblems`, `isLegacySession`) is wired in `app.tsx`; 39 tests with 10 legacy fixtures. Live: a legacy `opencode/...` pipeline loaded with a migration notice and a preflight block.
- `bun run check:no-opencode` reports `clean (22 allowlisted files)`; `git log dev..HEAD` touches no vendored package.
- README, FLOW.md and CHANGELOG `## [1.4.0] - 2026-10-19` describe the engine; ten docs claims were spot-checked against code and all were true.
- Cross-phase integration audit: 8 flows and both layering rules WIRED.

## Task Commits

Wiring and removal:

1. `135dd029e` feat(flow): run cards on the omp engine with uplift, memory and swarm stages (SPE-16066)
2. `e0893df29` refactor(flow): remove the opencode engine from the host and launchers (SPE-16066, 16068)
3. `f5a41a436` chore(flow): drop stale opencode wording, templates and generated config (SPE-16068)
4. `2fdc5ab10` chore(flow): add the no-opencode gate and bump to 1.4.0 (SPE-16068)
5. `a097b752c` docs(flow): describe the omp engine (SPE-16068)

Review-gate fixes that landed in Phase 7 scope:

6. `a73f2c165` fix(flow): gate every host route against cross-site and rebinding requests (SPE-16063/65/66/68)
7. `bf22d48a9` refactor(flow): remove the per-card MCP toggles that did nothing (SPE-16066)
8. `61ee96d18` fix(flow): gate every case and dot variant of the host routes and keep request bodies intact (SPE-16063/65/66)
9. `785370f5e` fix(flow): abort session creation on Stop, key requests by session and note dropped MCP allowlists (SPE-16062/64/66)
10. `ab74592ec` docs(planning): amend SWM-03 and TRM-01 and add the parity checklist (SPE-16068)
11. `2daf46d9f` docs(flow): document the route gate, session limits, state pruning and memory fallback (SPE-16068)

The contract suite and `FakeEngine` (`46b7084e4`) are Phase 1 deliverables that QA-01 relies on.

## Files Created/Modified

See `key-files`. CI (`.github/workflows/openflow.yml`) runs typecheck, `check:no-opencode` and `bun test` on ubuntu and windows.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

- **No PLAN files.** The milestone ran as direct orchestration, so there are no PLAN.md or SUMMARY.md files; these SUMMARYs were written afterwards from VERIFICATION reports, commits and code.
- **Requirement amendments.** SWM-03 (retry owned by Agent Swarm's own ladder) and TRM-01 (real gate and four-PTY cap) were amended on 2026-10-19 rather than implemented as first worded.
- **Contract suite and FakeEngine added late**, after a QA finding, once the adapter existed (`46b7084e4`). QA-01 depends on it.
- **Fixes after three review gates.** The batches at about 16:13, 16:31 and 17:10 respond to review, security and QA findings. They include session races and caps (`27f88e7ba`), the 32-session idle eviction (`01cba3b50`), run-state pruning (`abb940cef`), hedged-output todos (`680ff2e58`) and session titles (`7f54a3453`).
- **Per-card MCP toggles removed** rather than ported (omp cannot select MCP servers per session); an explicit allowlist leaves a migration note (`785370f5e`).

## Issues Encountered

- **Vite dev-host gate bypass (security gate).** Vite's connect router matches `/flow/api` case-insensitively, so case and dot variants slipped past the first route gate. `61ee96d18` gates every path under `/flow` in any case and mounts the gate ahead of the routers; malformed Host headers are refused as 403 and the Substrate client never follows a redirect.
- **Dropped request body (security gate).** The node adapter lost the first body chunk when a handler passed the request on; fixed in the same commit.
- **Planner not killed on Stop**, **stale model catalog after copying logins**, **omp refusing to start without a default model** and the **`ws` test races** are described in phases 3 and 6.
- **Abandoned session creates.** A create whose request aborts before the session is live now disposes it; prune holds a claim across removal (`01cba3b50`).
- Four uncommitted edits under vendored `packages/opencode`, `tui`, `web` are workspace noise, not branch commits; revert before merge.
- Integration warnings (non-blocking, see `07-INTEGRATION.md` W1-W8): an orphan `vite/flow-pty.ts`, unused `describeLaunch` notes, uplift `clarifications`/`engine`/`waves` returned but not carried into `UpliftInfo`, routes without a browser consumer, no single end-to-end composed test, a few unused exports, and a final swarm status after Stop that is derived rather than delivered.

## User Setup Required

None beyond omp 18.12.2 or newer. Existing pipelines migrate on load; unknown model ids are flagged in the walkthrough and preflight.

## Next Phase Readiness

Ready for the milestone audit and merge. **QA-03 is pending**: it is the milestone audit itself and was not run as part of this phase, so it is not in `requirements-completed`. Verification: `07-VERIFICATION.md` status `passed` (all truths except QA-03, `PENDING-AUDIT`); `07-INTEGRATION.md` passed with 0 blockers and 8 warnings. Evidence: migrate and gate 52 pass; adapter, pipeline, config and terminal spot suites 421 pass / 0 fail; integration run 243 pass / 0 fail; orchestrator full suite 2488 pass / 0 fail / 1 skip at `785370f5e`; `bun run typecheck` clean. MIG-01, MIG-02, MIG-03 and QA-01 SATISFIED.

---
*Phase: 07-integration-migration-removal*
*Completed: 2026-10-19*

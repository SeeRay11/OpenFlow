# Roadmap: Autonogrammer

## Milestones

- ✅ **v1.4.0 Omp Engine** - Phases 1-7 (complete 2026-10-19; verified in packages/flow)

## Overview

Milestone v1.4.0 "Omp Engine" swaps the OpenCode engine in `packages/flow` for Omp. Phase 1 grounds the work in evidence and introduces a port so everything downstream depends on `EngineApi`. Phases 2-5 build the Omp adapter, prompt uplift, Substrate memory and per-card swarm behind that port. Phase 6 adds Omp settings and the PTY terminal. Phase 7 wires everything, migrates persisted data, removes OpenCode from fork-owned paths and audits the milestone.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Discovery and engine port** - Evidence-based CONTEXT; EngineApi port types, contract suite and FakeEngine (completed 2026-10-19)
- [x] **Phase 2: Omp engine adapter** - Host-side `omp --mode rpc` session manager, `/flow/api/engine` routes, browser client (completed 2026-10-19)
- [x] **Phase 3: Prompt uplift** - claude-ultrathink planner with persisted original and uplifted prompts (completed 2026-10-19)
- [x] **Phase 4: Substrate shared memory** - Brief read and governed memory write/read across cards of a run (completed 2026-10-19)
- [x] **Phase 5: Swarm per card** - Omp card sessions run with the agent-swarm omp extension (completed 2026-10-19)
- [x] **Phase 6: Omp settings and terminal** - Settings from omp's real options and a PTY terminal bottom dock (completed 2026-10-19)
- [x] **Phase 7: Integration, migration and OpenCode removal** - Wire hubs, migrate data, remove OpenCode, docs, gate, audit (completed 2026-10-19)

## Phase Details

### Phase 1: Discovery and engine port

**Goal**: An evidence-based CONTEXT exists and UI, engine and cards depend on an `EngineApi` port (with contract suite and `FakeEngine`) rather than on omp/substrate/swarm internals.
**Depends on**: Nothing (first phase)
**Requirements**: ENG-01, ENG-02
**Success Criteria** (what must be TRUE):
  1. CONTEXT documents the current engine surface, omp RPC protocol, uplift/substrate/swarm integration points, each backed by file or command evidence.
  2. `EngineApi` port types exist and the engine consumers (UI, pipeline scheduler, cards) import only the port.
  3. A contract suite runs against `FakeEngine` and passes; the same suite is reusable by the Omp adapter.
  4. The uplift host-side placement decision is confirmed or revised with evidence.

**Plans**: TBD

### Phase 2: Omp engine adapter

**Goal**: Cards can run on a host-side `omp --mode rpc` session behind the port, with streaming, cancel, permissions, questions, usage and transcript parity.
**Depends on**: Phase 1
**Requirements**: ENG-03, ENG-04, ENG-05
**Success Criteria** (what must be TRUE):
  1. A card run streams omp output into the card UI through `/flow/api/engine` and the browser client.
  2. Cancelling a run terminates the omp process tree; no orphan processes remain.
  3. Permission and question requests round-trip to the user; usage and transcript match the previous experience.
  4. Missing omp or a wrong version yields a visible actionable message.
  5. The adapter passes the Phase 1 contract suite.

**Plans**: TBD

### Phase 3: Prompt uplift

**Goal**: Every card prompt is uplifted by the claude-ultrathink planner, including Jev decisions, with both prompts persisted and inspectable.
**Depends on**: Phase 2
**Requirements**: UPL-01, UPL-02, UPL-03, UPL-04
**Success Criteria** (what must be TRUE):
  1. Running a card sends the uplifted prompt to omp, including Jev decisions before each card prompt.
  2. The original and uplifted prompts are both retrievable from the card UI after the run.
  3. When uplift fails the card is blocked with a visible message and an explicit "Run with original prompt" action.
  4. Uplift boundary is mockable in tests.

**Plans**: TBD

### Phase 4: Substrate shared memory

**Goal**: Cards in a run share memory via agent-substrate with governed scopes, redaction and visible status.
**Depends on**: Phase 3
**Requirements**: MEM-01, MEM-02, MEM-03, MEM-04
**Success Criteria** (what must be TRUE):
  1. A run reads a Substrate brief with project-read scope before cards start.
  2. A second card run reads context written by an earlier card/run (card-write scope) and the UI shows memory was used.
  3. Written and injected memory is redacted and injection-guarded.
  4. When Substrate is down the UI shows memory unavailable with an actionable message; inspect/clear works as far as Substrate supports.

**Plans**: TBD

### Phase 5: Swarm per card

**Goal**: Each card's omp session runs with the agent-swarm omp extension, with swarm progress reflected in card status.
**Depends on**: Phase 4
**Requirements**: SWM-01, SWM-02, SWM-03
**Success Criteria** (what must be TRUE):
  1. A card session starts with the agent-swarm extension loaded.
  2. Card status shows swarm progress and surfaces partial failure with an actionable message.
  3. Cancelling a card kills the swarm process tree with no orphans.
  4. Failed swarm steps retry within a bounded budget.

**Plans**: TBD

### Phase 6: Omp settings and terminal

**Goal**: Users can configure Omp from the app and run omp interactively in a bottom-docked PTY terminal.
**Depends on**: Phase 2
**Requirements**: CFG-01, CFG-02, CFG-03, TRM-01, TRM-02, TRM-03, QA-02
**Success Criteria** (what must be TRUE):
  1. The settings UI is generated from omp's real options; valid edits save and reset, invalid ones show validation errors.
  2. Settings show effective config plus omp availability and version; a change affects subsequent runs.
  3. The terminal docks at the bottom, is loopback + per-launch-token only, runs omp interactively, and supports resize, copy, paste and scrollback.
  4. After PTY exit a visible message appears and the terminal can be restarted or reopened.
  5. Terminal and settings are fully keyboard accessible.

**Plans**: TBD

### Phase 7: Integration, migration and OpenCode removal

**Goal**: Everything is wired end to end, persisted data migrates, OpenCode is removed from fork-owned code, and the milestone passes audit.
**Depends on**: Phase 5, Phase 6
**Requirements**: MIG-01, MIG-02, MIG-03, QA-01, QA-03
**Success Criteria** (what must be TRUE):
  1. Existing pipelines, runs and settings referencing opencode load without crashing; unknown model ids are flagged.
  2. The parity checklist is satisfied and docs describe the Omp engine.
  3. `check:no-opencode` passes on fork-owned paths (`packages/flow`, root openflow launchers); vendored upstream packages are unchanged.
  4. Tests cover adapter, pipeline stages with mocked boundaries, config validation and terminal lifecycle.
  5. The milestone audit passes.

**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Discovery and engine port | 1/0 | Complete    | 2026-10-19 |
| 2. Omp engine adapter | 1/0 | Complete    | 2026-10-19 |
| 3. Prompt uplift | 1/0 | Complete    | 2026-10-19 |
| 4. Substrate shared memory | 1/0 | Complete    | 2026-10-19 |
| 5. Swarm per card | 1/0 | Complete    | 2026-10-19 |
| 6. Omp settings and terminal | 1/0 | Complete    | 2026-10-19 |
| 7. Integration, migration and OpenCode removal | 1/0 | Complete    | 2026-10-19 |

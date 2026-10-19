# Requirements: OpenFlow v1.4.0 Omp Engine

**Defined:** 2026-10-19
**Core Value:** A card prompt is uplifted, executed by Omp with swarm, and its status/output/result are visible in the card UI, with every failure surfaced and actionable.

## v1.4.0 Requirements

### Engine

- [x] **ENG-01**: `EngineApi` port types and a shared contract suite exist; UI, engine and cards depend on the port, not on omp/substrate/swarm internals.
- [x] **ENG-02**: A `FakeEngine` implements the port and passes the contract suite, so UI and pipeline stages are testable with mocked boundaries.
- [x] **ENG-03**: A host-side `omp --mode rpc` session manager and `/flow/api/engine` routes plus browser client stream card output; cancelling a run terminates the omp process tree with no orphans.
- [x] **ENG-04**: The Omp adapter supports permissions, questions, usage reporting and transcript parity with the previous engine's card experience.
- [x] **ENG-05**: When omp is missing or the wrong version, the card and settings show a visible, actionable message instead of failing silently.

### Prompt Uplift

- [x] **UPL-01**: A card prompt is uplifted by a claude-ultrathink planner (including Jev decisions) before it is sent to omp.
- [x] **UPL-02**: Both the original and the uplifted prompt are persisted and retrievable from the card UI.
- [x] **UPL-03**: If uplift fails, the card is blocked with a visible message and an explicit "Run with original prompt" action; nothing is sent silently.
- [x] **UPL-04**: Uplift is a host-side planner call whose boundary is mockable and whose placement is confirmed by Phase 1 discovery.

### Shared Memory

- [x] **MEM-01**: Each run reads a Substrate brief before cards start, scoped project-read.
- [x] **MEM-02**: Cards write governed memory (card-write scope) that a later card or later run in the same project can read.
- [x] **MEM-03**: Memory content is redacted and guarded against prompt injection before being written or injected.
- [x] **MEM-04**: The card UI shows a visible indicator when memory was used or unavailable; memory can be inspected and cleared as far as Substrate supports.

### Swarm

- [x] **SWM-01**: Each card's omp session runs with the agent-swarm omp extension enabled.
- [x] **SWM-02**: Card status reflects swarm progress, including partial failure with an actionable message.
- [x] **SWM-03**: Cancelling a card kills the full swarm process tree and settles its swarm status; failed swarm steps are retried by Agent Swarm's own bounded ladder (`max_attempts`, then ESCALATED) and the card shows the final state. OpenFlow adds no second retry layer. *(Amended 2026-10-19: the retry half is the swarm's own contract, verified in agent-swarm AGENTS.md and docs/substrate-leases.md; a second layer would multiply cost and loops.)*

### Configuration

- [x] **CFG-01**: Omp settings are generated from omp's real options, with edit, save and reset.
- [x] **CFG-02**: Invalid settings produce validation errors; the UI shows effective config plus omp availability and version.
- [x] **CFG-03**: A saved settings change affects subsequent runs.

### Terminal

- [x] **TRM-01**: A PTY terminal docks at the bottom of the app as one global dock, gated to loopback by a custom header, a same-origin check and a one-shot ticket. *(Amended 2026-10-19: the host keeps at most four PTYs so omp, shell and restarts can coexist; the UI shows one.)*
- [x] **TRM-02**: The user can run omp interactively, resize, copy, paste, scroll back and close the terminal.
- [x] **TRM-03**: After the PTY exits the terminal shows a visible message and can be reopened or restarted.

### Migration and Removal

- [x] **MIG-01**: Existing pipelines, runs and settings referencing opencode load without crashing; model ids are migrated to the Omp catalog and unknown ones are flagged.
- [x] **MIG-02**: No OpenCode references remain in fork-owned code, config, dependencies, UI text or tests (`packages/flow`, root openflow launchers); vendored upstream packages are untouched, enforced by a `check:no-opencode` gate scoped to fork-owned paths.
- [x] **MIG-03**: A parity checklist is satisfied before removal, and docs (README, FLOW.md, changelog) describe the Omp engine.

### Verification

- [x] **QA-01**: Tests cover the adapter, pipeline stages with mocked boundaries, config validation and terminal lifecycle.
- [x] **QA-02**: The terminal and settings UI are fully keyboard accessible.
- [x] **QA-03**: The milestone audit passes against these requirements.

## Out of Scope

| Feature | Reason |
|---------|--------|
| OpenCode fallback flag / silent fallback | OpenCode is removed outright after parity |
| Changes to vendored upstream packages | FLOW.md hard constraint |
| Multiple terminal sessions / remote terminal | Single local session only |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENG-01 | Phase 1 | Complete |
| ENG-02 | Phase 1 | Complete |
| ENG-03 | Phase 2 | Complete |
| ENG-04 | Phase 2 | Complete |
| ENG-05 | Phase 2 | Complete |
| UPL-01 | Phase 3 | Complete |
| UPL-02 | Phase 3 | Complete |
| UPL-03 | Phase 3 | Complete |
| UPL-04 | Phase 3 | Complete |
| MEM-01 | Phase 4 | Complete |
| MEM-02 | Phase 4 | Complete |
| MEM-03 | Phase 4 | Complete |
| MEM-04 | Phase 4 | Complete |
| SWM-01 | Phase 5 | Complete |
| SWM-02 | Phase 5 | Complete |
| SWM-03 | Phase 5 | Complete |
| CFG-01 | Phase 6 | Complete |
| CFG-02 | Phase 6 | Complete |
| CFG-03 | Phase 6 | Complete |
| TRM-01 | Phase 6 | Complete |
| TRM-02 | Phase 6 | Complete |
| TRM-03 | Phase 6 | Complete |
| QA-02 | Phase 6 | Complete |
| MIG-01 | Phase 7 | Complete |
| MIG-02 | Phase 7 | Complete |
| MIG-03 | Phase 7 | Complete |
| QA-01 | Phase 7 | Complete |
| QA-03 | Phase 7 | Complete |

**Coverage:**
- v1.4.0 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0

---
*Requirements defined: 2026-10-19*
*Last updated: 2026-10-19 after milestone v1.4.0 initialization*

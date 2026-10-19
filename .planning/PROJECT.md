# OpenFlow (autonogrammer)

## What This Is

OpenFlow (`packages/flow`) is a node-based visual builder for multi-agent workflows, shipped as a fork-owned package inside a vendored OpenCode monorepo. Each card on the canvas is one full agent session; cards run in pipeline, swarm or orchestration modes. Today the engine behind every card is `opencode serve`; milestone v1.4.0 replaces it with the Omp engine.

## Core Value

A user writes a card prompt and gets it executed by Omp with prompt uplift, shared project memory and agent-swarm execution, with status, output, result and every failure visible in the card UI.

## Current Milestone: v1.4.0 Omp Engine

**Goal:** Replace the OpenCode engine in `packages/flow` with the Omp engine, add prompt uplift (claude-ultrathink), shared memory (agent-substrate), per-card agent-swarm execution, and an Omp settings UI plus PTY terminal; then remove OpenCode coupling from fork-owned code.

**Target features:**
- Engine port (`EngineApi`) with contract suite and `FakeEngine`; Omp adapter behind it (`omp --mode rpc`)
- Prompt uplift planner with persisted original + uplifted prompts
- Substrate-backed shared memory across all cards of a run
- Per-card agent-swarm execution via the agent-swarm omp extension
- Omp settings UI and in-app PTY terminal (bottom dock)
- Migration of persisted pipelines/runs/models and complete OpenCode removal from fork-owned paths

Tracking: Linear nodes SPE-16062..SPE-16069 (n1..n8) under Notion task https://app.notion.com/p/3febc1a0c7ae819ea148eeb0486f8185?pvs=204 (graph `ut-mvf9vsaa-a99417c4`). Package version today: 1.3.0; target 1.4.0.

## Requirements

### Validated

- ✓ Node-based canvas with pipeline / swarm / orchestration modes on the OpenCode engine — v1.0–v1.3.0

### Active

See `.planning/REQUIREMENTS.md` (ENG, UPL, MEM, SWM, CFG, TRM, MIG, QA — 28 requirements).

### Out of Scope

- Modifying any vendored upstream package — FLOW.md hard constraint (fork merges stay clean)
- Scrubbing `opencode` strings in upstream README/docs/source/`sst.config.ts`/`infra` — intentional per FLOW.md
- An OpenCode fallback flag or silent fallback engine — OpenCode is removed outright after parity
- Multiple concurrent terminal sessions or remote terminal access — single local session only

## Context

- Repo rules: read `FLOW.md` and `AGENTS.md` at the repo root first; `packages/flow/README.md` documents endpoints, run instructions and file layout.
- Fork-owned surfaces: `packages/flow`, `.github`, the LICENSE attribution line, `FLOW.md`, and the root OpenFlow launchers (`openflow.sh`, `openflow.ps1`, `openflow.ts`).
- Current architecture: one card = one full `opencode serve` primary session (`src/server/engine.ts`: createSession → prompt → waitForIdle → transcript), nodes run in topological layers via a parallel pool.
- Branch `omp-engine`; default branch of the repo is `dev`.

## Constraints

- **Upstream**: no edits to vendored packages — keeps fork merges clean
- **Boundaries**: UI, engine and cards depend on the `EngineApi` port, never on omp/substrate/swarm internals
- **Security**: terminal bound to loopback with a per-launch token only
- **Process hygiene**: cancel must terminate the whole omp/swarm process tree, no orphans
- **Degradation**: every failure mode (omp missing/wrong version, uplift failing, substrate down, swarm partial failure, PTY exit) surfaces a visible, actionable message

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Remove OpenCode outright after parity (no flag, no silent fallback) | Two engines doubles surface and hides regressions; parity checklist gates removal | — Pending |
| Vendored upstream packages untouched (FLOW.md hard constraint) | Keeps fork merges clean; OpenCode removal applies only to `packages/flow` and root openflow launchers | — Pending |
| Uplift failure blocks the card with an explicit "Run with original prompt" action | No silent degradation; user stays in control of what is sent | — Pending |
| Memory: read per project, write per card; retention per Substrate semantics; inspect/clear as Substrate supports | Later cards see earlier results without cards overwriting each other's scope | — Pending |
| Terminal = global bottom dock, single session, loopback + per-launch token | Smallest safe surface for an in-app shell | — Pending |
| Legacy cards: model ids migrated to the Omp catalog, unknown ones flagged, never crashing | Existing pipelines must load | — Pending |
| Omp driven via `omp --mode rpc` per card session with a hand-rolled JSONL client | Direct control of stream/cancel/permission events; no SDK coupling | — Pending |
| Uplift = host-side planner call (to be confirmed by Phase 1 discovery) | Keeps uplift outside the card session so original/uplifted prompts are both persisted | — Pending |

---
*Last updated: 2026-10-19 after milestone v1.4.0 initialization*

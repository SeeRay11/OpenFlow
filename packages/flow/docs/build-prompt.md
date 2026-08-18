# One-shot build prompt — OpenFlow

> **Historical.** The prompt the package was built from, kept as a record of the
> brief. It is not instructions for the current codebase: several of its facts
> were corrected during the build (see [plan.md](plan.md)).

> Paste everything below the line into Opus 5 (Claude Code) running in the repo
> the OpenFlow repo root.

---

You are building **OpenFlow**, a free open-source visual builder for multi-agent
workflows, inside this repo — a fork of `anomalyco/opencode` (modern OpenCode).
Goal: drag role cards onto a canvas, wire a pipeline (e.g. planner → architect →
coder), save it, and run it with real parallel agents. Profit is not a goal; it is free.

## Rules of engagement

1. **Ground before coding.** Read the files listed under "Read first" and confirm
   every assumption in "Verify these" against the actual code. If a fact here is
   wrong, trust the code and note the correction — do not build on a guess.
2. **Do not modify upstream packages.** All new code lives in a new package
   `packages/flow`. Leave every other package untouched so upstream OpenCode merges
   stay clean. The only permitted outside edit is registering the new package if the
   workspace/turbo config needs it (glob is `packages/*`, so likely automatic).
3. **Build in the phase order below. Each phase has a verify gate — do not advance
   until it passes.** Run the verify check yourself.
4. Ask nothing you can answer from the repo. Report progress per phase with the
   verify result.

## Hard facts (grounded 2026-08-12)

- **Stack:** Bun 1.3.14 + Turbo monorepo. UI framework is **SolidJS, not React**
  (`solid-js` 1.9.10, `vite` 7.1.4, `vite-plugin-solid` — all in root `package.json`
  `catalog`). React Flow does not apply.
- **Workspace:** root `package.json` `workspaces.packages` includes `packages/*`, so
  a new `packages/flow` is picked up automatically. Versions come from the `catalog`.
- **Execution backend already exists — reuse, do not rebuild:**
  - `opencode serve` = headless HTTP server, OpenAPI. Package `packages/server`.
  - Client: `@opencode-ai/sdk-next`, entry `packages/sdk-next/src/index.ts`
    (client factory in `packages/sdk-next/src/opencode.ts`). Read both.
  - Reference client usage: `packages/app/src/` (grep `createOpencodeClient` /
    `sdk-next`) — copy how the existing Solid app connects.
  - Server APIs you will drive:
    - `POST /session/:id/message` — run a node; body accepts `agent`, `model`,
      `system`, `tools`, `parts`. Returns final message.
    - `POST /session/:id/prompt_async` — fire-and-forget (204). Use for parallel fan-out.
    - `GET /event` — SSE bus. First event `server.connected`, then bus events. Use for live node status.
  - Agents: opencode `agent` config — `mode: primary|subagent`, per-agent `model`,
    `prompt`, `tools`, `permission`. A node maps to one agent config.

## Locked design decisions

- **UI home:** new package `packages/flow` (Solid + Vite, depends on `@opencode-ai/sdk-next`).
- **Canvas:** use a SolidJS flow/graph library for nodes/edges/pan/zoom.
  **Verify the exact package name and maturity first** (candidate: `solid-flow`). If
  no adequate Solid flow lib exists, fall back to a hand-rolled SVG canvas using
  `@thisbeyond/solid-dnd` (already used in `packages/app`). Pick one, state which, proceed.
- **Engine v1:** a real DAG executor — topological layering, parallel fan-out of
  independent nodes, pipe upstream node output into downstream node prompt, live
  status from the SSE stream.
- **Execution model:** run each node as its own primary session over the server API
  (not one orchestrator session using the Task tool). Simpler, parallel, observable.

## Data model

Pipeline graph, persisted at `.openflow/pipelines/<name>.json`:
```jsonc
{
  "id": "uuid",
  "name": "feature-build",
  "nodes": [
    { "id": "n1", "role": "planner",
      "agent": { "model": "provider/model-id", "prompt": "...", "tools": {} },
      "position": { "x": 0, "y": 0 } }
  ],
  "edges": [ { "id": "e1", "source": "n1", "target": "n2" } ]
}
```
- Node = one agent invocation. `role` = card label. `agent` = subset of opencode agent config.
- Edge = context flow: upstream node's final output is injected into the downstream
  node's prompt. DAG only — reject cycles on save.
- Also generate an `opencode.json` `agent` block from the graph's nodes.
- Persist each run's log under `.openflow/runs/<runId>.json`.

## Orchestration engine algorithm

1. Validate: DAG (no cycles), all nodes reachable, models resolvable.
2. Topologically layer nodes; a node is ready when all its source nodes are done.
3. Per layer, dispatch every ready node concurrently: create a session, send
   `POST /session/:id/message` (use `prompt_async` for parallel) with the node's
   `agent` + `model`. Prompt = node base prompt + serialized outputs of all upstream nodes.
4. Await the whole layer before starting the next.
5. Subscribe `GET /event` (SSE); map bus events to node state
   `idle | running | done | error`; stream to the canvas.
6. Capture each node's final message; write the run log.
7. Failure policy v1: a node error stops its downstream branch; siblings continue;
   show the error on the node.

## Node canvas (Solid)

- Palette of role cards (planner, architect, coder, reviewer, custom) — drag onto canvas.
- Node card: role name, model selector (populated from the server), prompt editor,
  tool toggles, live status badge.
- Connect output port to input port to create edges.
- Toolbar: Save, Load, Run, Stop.
- Run mode: canvas reflects live per-node SSE status; clicking a node shows its transcript/output.

## Phases (each ends with a verify gate)

- **P0 Baseline** — `bun install`; build the server; run `opencode serve`.
  verify: `GET /global/health` returns `{ healthy: true }`.
- **P1 Scaffold** — create `packages/flow` (Solid + Vite), wire into workspace/turbo,
  add the chosen canvas lib.
  verify: dev server boots; blank canvas with pan/zoom renders.
- **P2 Connect** — sdk-next client module: connect to `opencode serve`, list
  agents/models, open a session, send one message.
  verify: a hardcoded single-node run returns an assistant message in the UI.
- **P3 Canvas editing** — role cards, drag from palette, connect edges, edit
  model/prompt per node; in-memory graph.
  verify: build a 3-node planner→architect→coder graph on screen.
- **P4 Persistence** — save/load graph to `.openflow/pipelines/*.json`; generate
  `opencode.json` agent defs.
  verify: save, reload app, graph restored identically.
- **P5 Engine (sequential)** — topological execution with upstream-output-to-
  downstream-prompt piping; no parallelism yet.
  verify: linear 3-node pipeline runs end to end; coder node receives planner+architect output.
- **P6 Parallel + live status** — `prompt_async` for independent nodes; SSE-driven
  per-node status badges.
  verify: diamond graph (1 planner fans to 2 workers, joins at reviewer) runs both
  workers concurrently; badges update live.
- **P7 Polish** — node errors, run-log viewer, per-node transcript panel, stop/cancel.
  verify: killing a run halts dispatch; a failed node shows an error while siblings finish.

## Read first (before P1)

- `plan.md` (alongside this file) — the full plan.
- `packages/sdk-next/src/index.ts` and `packages/sdk-next/src/opencode.ts` — client API surface.
- `packages/app/src/` — grep `createOpencodeClient` / `sdk-next` for real connection + Solid patterns.
- `packages/server/` — confirm the exact routes and payload shapes above.
- Root `package.json` (`catalog`, `workspaces`) and `turbo.json` — how packages register and get versions.

## Verify these against the code (correct me if wrong)

- Exact Solid flow library that exists and supports custom nodes/pan/zoom (or decide fallback).
- `@opencode-ai/sdk-next` client factory name, session-create call, message-send call, event-subscribe call.
- Exact server route paths and request/response shapes for message, prompt_async, event.
- How to launch/discover `opencode serve` from the Solid app (spawn child vs assume running vs bundle) — pick the simplest that works and state it.

## Non-goals (v1)

Auth/multi-user, cloud hosting, pipeline marketplace, retry/resume/checkpointing,
cyclic graphs, cost-tracking UI. Do not build these.

Deliver working code phase by phase, report each verify result, and end with how to run it.

# OpenFlow — Implementation Plan

> **Historical.** This is the plan the package was built from, kept for the
> reasoning behind the decisions. All eight phases shipped. Where it disagrees
> with the code, the code is right — `solid-flow` was rejected as abandoned, and
> the `/session/*` + `prompt_async` routes were superseded by v2 `/api/*`. See
> [../README.md](../README.md) for what actually exists.

Node-based visual builder for multi-agent workflows, forked from OpenCode
(`anomalyco/opencode`). Drag role cards, wire a pipeline (planner → architect →
coder), save it, run it with parallel agents. Free, open source.

## Locked decisions

| Decision | Choice |
|---|---|
| UI home | **New package `packages/flow`** (Solid + Vite, uses `sdk-next`). Isolates OpenFlow from upstream opencode churn. |
| Canvas tech | **`solid-flow`** (community Solid port of React Flow). Fast path to nodes/edges/pan/zoom. |
| Engine v1 | **Real DAG executor** — parallel branches, node-to-node context piping, live status. |

## What we reuse vs build

**Reuse (no new backend):**
- `packages/server` — `opencode serve`, headless HTTP + OpenAPI. Execution runtime.
- `packages/sdk-next` — TypeScript client to the server.
- Agents/subagents — `agent` config (`mode: primary|subagent`, per-agent `model`,
  `prompt`, `tools`, `permission`). Task tool + `permission.task` globs = orchestration primitive.
- Server APIs already sufficient:
  - `POST /session/:id/message` — run, accepts `agent`, `model`, `system`, `tools`, `parts`.
  - `POST /session/:id/prompt_async` — fire-and-forget, returns 204. Parallel fan-out.
  - `GET /event` — SSE bus. Live node status.

**Build (new):**
- `packages/flow` — Solid app: node canvas + engine + persistence.
  - Node canvas (`solid-flow`): draggable role cards, ports, connections.
  - DAG orchestration engine: graph JSON → execution over server API.
  - Persistence: `.openflow/pipelines/*.json` (graph) + generated `opencode.json` agent defs.

## Data model

**Pipeline graph** (`.openflow/pipelines/<name>.json`):
```jsonc
{
  "id": "uuid",
  "name": "feature-build",
  "nodes": [
    {
      "id": "n1",
      "role": "planner",
      "agent": { "model": "anthropic/claude-...", "prompt": "...", "tools": {...} },
      "position": { "x": 0, "y": 0 }
    }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" }
  ]
}
```
- Node = one agent invocation. `role` = card label. `agent` = opencode agent config subset.
- Edge = context flow. Upstream node output feeds into downstream node prompt.
- No cycles (DAG). Validate on save.

## Orchestration engine (the real product)

Input: pipeline graph. Output: run over `opencode serve`.

1. **Validate** — DAG (no cycles), every node reachable, models resolvable.
2. **Topological layering** — group nodes into levels; nodes with no unmet
   dependency run concurrently.
3. **Execute per level:**
   - For each ready node: create/continue a session, send prompt via
     `POST /session/:id/message` (or `prompt_async` for parallel), with node's
     `agent` + `model`.
   - Prompt assembly: node's base prompt + serialized outputs of all upstream
     (source) nodes as context.
4. **Fan-out** — independent nodes in same level dispatched in parallel; await all before next level.
5. **Status** — subscribe `GET /event` SSE; map bus events to node state
   (`idle | running | done | error`); stream to canvas.
6. **Result capture** — store each node's final message; persist run log under
   `.openflow/runs/<runId>.json`.

Failure policy v1: node error stops its downstream branch, siblings continue.
Surface error on the node. (Retry/resume = later phase.)

## Node canvas (Solid + solid-flow)

- Palette of role cards (planner, architect, coder, reviewer, custom). Drag onto canvas.
- Node card UI: role name, model selector, prompt editor, tool toggles, live status badge.
- Connect output port → input port to form edges.
- Toolbar: Save, Load, Run, Stop.
- Run mode: canvas reflects live SSE status per node; click node = view its output/transcript.

## Phased build

Each phase ends verifiable. Order matters.

- **Phase 0 — Repo + baseline**
  - Confirm build: `bun install`, build server, run `opencode serve`.
  - verify: server responds `GET /global/health` `{ healthy:true }`.
- **Phase 1 — Scaffold `packages/flow`**
  - New Solid+Vite package, wired into workspace + `turbo.json`. Add `solid-flow`.
  - verify: dev server boots, blank canvas with pan/zoom renders.
- **Phase 2 — sdk-next connection**
  - Client module: connect to running `opencode serve`, list agents/models, open a session, send one message.
  - verify: hardcoded single-node run returns an assistant message in UI.
- **Phase 3 — Node model + canvas editing**
  - Role cards, drag from palette, connect edges, edit model/prompt per node. In-memory graph.
  - verify: build a 3-node planner→architect→coder graph on screen.
- **Phase 4 — Persistence**
  - Save/load graph to `.openflow/pipelines/*.json`. Generate `opencode.json` agent defs.
  - verify: save, reload app, graph restored identically.
- **Phase 5 — DAG engine (sequential)**
  - Topological execution, upstream-output-to-downstream-prompt piping. No parallelism yet.
  - verify: linear 3-node pipeline runs end to end; coder node receives planner+architect output.
- **Phase 6 — Parallel fan-out + live status**
  - `prompt_async` for independent nodes; SSE-driven per-node status badges.
  - verify: diamond graph (1 planner fans to 2 workers, joins at reviewer) runs both workers concurrently; badges update live.
- **Phase 7 — Polish**
  - Errors on nodes, run log viewer, per-node transcript panel, stop/cancel.
  - verify: killing a run halts dispatch; failed node shows error, siblings finish.

## Open items to verify before/at Phase 1

- `solid-flow` package name + maturity (pan/zoom/custom-node support). Fallback: hand-rolled SVG + `@thisbeyond/solid-dnd` (already in `app`).
- `sdk-next` exact client API surface (`packages/sdk-next`) — session create, message send, event subscribe signatures.
- How `opencode serve` is launched/discovered from the Solid app (spawn child process vs assume running vs bundle).
- Subagent path vs multi-session path: run each node as its own primary session (simpler, chosen here) vs one orchestrator session using Task tool. v1 = multi-session.

## Non-goals (v1)

- Auth/multi-user, cloud hosting, marketplace of pipelines.
- Retry/resume/checkpointing.
- Cyclic graphs / loops-with-conditions.
- Cost tracking UI.

## Naming / branding

Rebrand touch points later (not v1 blocker): `packages/flow` only. Leave upstream
package names intact to keep merges clean.

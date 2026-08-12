# OpenFlow

Visual builder for multi-agent workflows. Drag role cards onto a canvas, wire a
pipeline (planner → architect → coder), save it, and run it with real parallel
agents on top of a headless `opencode serve`.

Everything lives in this package. No other package in the repo is modified, so
upstream merges stay clean.

## Run it

Two processes. Start the server first:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Then the canvas:

```bash
bun --cwd packages/flow dev
```

Open http://localhost:5174. The header shows `connected` once the UI can reach
the server.

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096` | server the dev proxy forwards to |
| `OPENFLOW_PROJECT` | repo root | project the agents work in, and where `.openflow/` is written |

## How it talks to opencode

The vite dev server proxies `/api`, `/global` and `/event` to `opencode serve`,
so the browser is same-origin with the server — no CORS and no password
plumbing. The client is `createOpencodeClient` from `@opencode-ai/sdk/v2/client`
(the same client `packages/app` uses).

`@opencode-ai/sdk-next` is deliberately *not* used: its `OpenCode.create` builds
`createEmbeddedRoutes()` and runs the server in-process through Effect layers,
which is not something a browser app can do.

Endpoints driven, all v2:

| Call | Endpoint |
|---|---|
| create a node's session | `POST /api/session` |
| send the node prompt | `POST /api/session/{id}/prompt` |
| detect completion | `GET /api/session/active` |
| read the node's answer | `GET /api/session/{id}/message` |
| live status | `GET /api/event` (SSE) |
| stop | `POST /api/session/{id}/interrupt` |
| pickers | `GET /api/agent`, `GET /api/model` |

`POST /api/session/{id}/wait` answers `503 Session wait is not available yet` on
this server build, so idleness is derived from `/api/session/active` plus a
finished assistant turn.

## Engine

One node = one primary session. Nodes are grouped into topological layers;
every node in a layer is dispatched concurrently (`prompt` only admits the input
and schedules the agent loop, so the fan-out is real), then the whole layer is
awaited before the next starts.

1. Validate — DAG, reachable nodes, models resolvable against `GET /api/model`.
2. Layer with Kahn's algorithm.
3. Dispatch each layer concurrently; prompt = role instructions + run task +
   serialized upstream output.
4. Live status from the event bus maps `session.next.*` events onto node badges.
5. Capture each node's final assistant text; write `.openflow/runs/<id>.json`.

Failure policy: a node error stops its downstream branch (`skipped`), siblings
finish, the run ends `error`. Stop interrupts in-flight sessions and dispatches
nothing further.

**Pipe mode** (toolbar): `ancestors` (default) gives a node every upstream node's
output in execution order; `direct` gives only the nodes wired straight into it.

## Files it writes

Under `OPENFLOW_PROJECT`:

```
.openflow/pipelines/<name>.json          the graph
.openflow/runs/<runId>.json              per-run log: prompts, outputs, timings
.openflow/generated/<name>.opencode.json generated agent defs
```

`.openflow/runs/` is disposable — worth adding to `.gitignore` if you keep
pipelines in version control.

**save** writes the pipeline and the generated agent block. **merge agents**
folds that block into the project's `opencode.json` (after writing a `.bak`) and
points every node at its own agent — this is the only way per-node tool
allowlists take effect at runtime, because a session can only select tools
through a named agent. Until you merge, nodes run as the server's default agent
with its default tools.

## Canvas

Hand-rolled: HTML node cards over an SVG edge layer inside one CSS-transformed
viewport, driven by pointer events. `solid-flow` was evaluated and rejected —
last published 2022, three versions, built for Solid 1.5.

- drag a role from the palette onto the canvas, or click it to drop one in
- drag a node header to move it, wheel to zoom, drag empty canvas to pan
- drag the right port onto a left port to connect; cycles are refused
- click an edge to delete it; `Delete` removes the selected node
- click a node to edit role, model, agent, prompt and tools, and to read its
  sent prompt and output

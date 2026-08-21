# OpenFlow

Visual builder for multi-agent workflows. Drag role cards onto a canvas, wire a
pipeline (planner → architect → coder), save it, and run it with real parallel
agents on top of a headless `opencode serve`.

OpenFlow is its own project, built on — and shipped as a fork of —
[opencode](https://github.com/anomalyco/opencode), whose headless engine drives the
agents underneath. Everything OpenFlow-specific lives in this package. No other
package in the repo is modified, so upstream merges stay clean. It is not published
to npm — it is an app, run it from the repo.

> OpenFlow is an independent fork. It is not affiliated with, sponsored by, or
> endorsed by the OpenCode team.

The plan it was built from, and the original build brief, are kept in
[docs/](docs) for the reasoning; the code is the authority where they disagree.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ and [Git](https://git-scm.com).

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` pulls the whole workspace — the OpenCode engine plus this package.
First install is large; it downloads the engine's native deps and runs a
`postinstall` that builds `node-pty`.

## Run it

Two processes. Start the server first:

```bash
bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4096
```

Then the canvas:

```bash
bun run --cwd packages/flow dev
```

Open http://localhost:5174. The header shows `connected` once the UI can reach
the server.

### Built, without vite

`bun run build` emits a static bundle, and a static bundle on its own is a dead
page: the `/flow/api` store and the proxy to `opencode serve` are what make save,
load and run work. `server.ts` serves all three.

```bash
bun run --cwd packages/flow build
bun run --cwd packages/flow start
```

Same URL, same behaviour, no vite.

### Loopback only

`/flow/api` writes pipelines and run logs into the project and merges agents into
its `opencode.json`, and nothing authenticates the caller. On loopback that is
you talking to your own machine; on a real interface it is a remote file-write
hole in whatever repository OpenFlow is pointed at.

So both hosts refuse to serve anything but loopback unless `FLOW_ALLOW_REMOTE=1`
says otherwise — `bun start` exits, and `vite --host` fails to start rather than
coming up with the store quietly exposed. Request bodies are capped at 8 MB on
both.

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096` | server the proxy forwards to |
| `OPENFLOW_PROJECT` | last used, else repo root | project the agents work in, and where `.openflow/` is written |
| `FLOW_PORT` | `5174` | port for `bun start` (dev server is fixed at 5174) |
| `FLOW_HOST` | `127.0.0.1` | interface for `bun start` |
| `FLOW_ALLOW_REMOTE` | unset | `1` allows a non-loopback bind, for both hosts |
| `OPENFLOW_STATE_DIR` | `~/.openflow` | where the remembered folder and pipeline are stored |

### Where it picks up

A full stop and relaunch reopens the folder you were last working in **and the
pipeline you had open in it**, rather than the OpenFlow repo and a blank canvas.

The pipeline is remembered per project — a name only means anything inside the
folder whose `.openflow/pipelines` holds it — and is recorded when you open or
save one. It rides back on `GET /flow/api/context`, so restoring costs no extra
round trip, and it is only reopened if the store still lists it: a pipeline
deleted or renamed outside OpenFlow leaves a blank canvas rather than an error
on every launch.

Folder precedence at boot (`lib/last-session.ts`):

1. **`OPENFLOW_PROJECT`** — including `openflow.ps1 -Project` / `openflow.sh
   --project`. Naming a folder on this launch means it, and a folder picked last
   week must not override it.
2. **the remembered folder**, if it still exists. One that has been moved or
   deleted is dropped, because booting into a missing path fails every
   `/flow/api` route and reads as a broken app rather than a missing folder.
3. **the OpenFlow repo itself.**

Both are recorded host-side in `~/.openflow/state.json` — outside any project,
since they describe the app rather than the repo, and a user might commit or
delete the repo.

## How it talks to opencode

Both hosts proxy `/api`, `/global`, `/event` and `/mcp` to `opencode serve`, so the
browser is same-origin with the server — no CORS and no password plumbing. The
client is `createOpencodeClient` from `@opencode-ai/sdk/v2/client` (the same
client `packages/app` uses).

The store routes live in `lib/store.ts` and are mounted by both the vite plugin
(`vite/flow-store.ts`) and `server.ts`, so dev and built cannot drift into two
different stores.

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
| answer a question the agent asked | `POST /api/session/{id}/question/{req}/reply` (or `/reject`) |
| mcp status and connection | `GET /mcp`, `POST /mcp/{name}/connect`, `POST /mcp/{name}/disconnect` |
| pickers | `GET /api/agent`, `GET /api/model` |
| provider list + stored keys | `GET /api/integration` |
| store a key | `POST /api/integration/{id}/connect/key` |
| remove a key | `DELETE /api/credential/{id}` |

## API keys and models

A fresh install has **no models** — only providers. The **api keys** button
opens opencode's own two-step connect dialog: search the ~184 providers
models.dev knows, pick one, paste its key. Keys go to the integration store the
model catalog reads, so a saved key takes effect immediately — no
`opencode serve` restart, unlike an agent merge. Only then do that provider's
models appear in the model menu, which is opencode's `dialog-select-model`
menu: 284px, search at the top, one heading per provider, `↑`/`↓`, `Enter`,
`Esc`.

A provider counts as connected when a key is stored here **or** one of its
environment variables is really set on the host — `GET /flow/api/env` answers
which of the names asked about are set, never their values. That distinction is
what keeps the free zen models out of a fresh install: `opencode serve` serves
them to a browser that has never seen a key
(`core/src/plugin/provider/opencode.ts`), so a model list alone cannot tell a
provider the user connected from one they did not.

The catalog also lies about what exists. Its `opencode` models come from
models.dev, and on 2026-08-13 it listed 90 while zen served 61 — the other 29
answer a run with `401 Model kimi-k2 is not supported` in about 1.4s. Zen's list
is public, so the host reads it (`lib/zen.ts`, `GET /flow/api/zen-models`,
10-minute cache) and drops the models zen does not serve. When that fetch fails
the answer is `null` and the catalog is left alone — an offline user must not
lose every zen model at once. No other provider can be checked this way: their
`/models` needs the credential, which lives in the opencode server's store and
never reaches OpenFlow.

Three things have to line up before a model runs, and the UI distinguishes them
because they fail in completely different ways:

1. **A credential.** No stored key and no environment variable means the
   provider is locked and contributes no models at all — including zen, whose
   free models the server otherwise hands out to a browser with no key.
2. **A runner for the provider's API.** `core/src/session/runner/model.ts`
   routes exactly three shapes: `@ai-sdk/openai`, `@ai-sdk/anthropic`, and
   `@ai-sdk/openai-compatible` with a base URL. Anything else — `@ai-sdk/groq`,
   `@openrouter/ai-sdk-provider`, `@ai-sdk/google` — fails at dispatch with
   `UnsupportedApiError` no matter how valid the key is. Those models are
   listed as **no runner** and their providers sink to the bottom. On this
   build that is 349 of openrouter's models and all 15 of groq's.
3. **A key that is actually accepted, for a model the account may use.**
   Nothing verifies a key when it is stored, and the catalog advertises models
   an account has no entitlement for. The **test** button beside a node's model
   runs one throwaway session and reports the provider's own answer — a real
   `403 Authorization failed` or `410 ... end of life` beats guessing.

`opencode providers login` writes to `auth.json`, which this server does **not**
read for its catalog. If the CLI already holds keys, the panel offers to import
them; the keys are read and connected by the OpenFlow host, so they are never
served to the browser.

| Store route | Purpose |
|---|---|
| `GET /flow/api/cli-keys` | provider names in the CLI's `auth.json` — names only |
| `POST /flow/api/cli-keys/import` | connect those keys to the running server |
| `GET /flow/api/env?names=A,B` | which of those variables the host has set — names only |
| `GET /flow/api/zen-models` | model ids opencode zen really serves, or `null` if unreadable |

`POST /api/session/{id}/wait` answers `503 Session wait is not available yet` on
this server build, so idleness is derived from `/api/session/active` plus a
finished assistant turn.

## Engine

One node = one primary session. Nodes are grouped into topological layers; the
nodes in a layer are dispatched concurrently (`prompt` only admits the input and
schedules the agent loop, so the fan-out is real), then the whole layer is
awaited before the next starts.

1. Validate — DAG, reachable nodes, models resolvable against `GET /api/model`.
2. Layer with Kahn's algorithm.
3. Dispatch each layer through a pool; prompt = role instructions + run task +
   serialized upstream output.
4. Live status from the event bus maps `session.next.*` events onto node badges.
5. Capture each node's final assistant text; write `.openflow/runs/<id>.json`.

Failure policy: a node error stops its downstream branch (`skipped`), siblings
finish, the run ends `error`. Stop interrupts in-flight sessions and dispatches
nothing further.

**Pipe mode** (toolbar): `ancestors` (default) gives a node every upstream node's
output in execution order; `direct` gives only the nodes wired straight into it.

**Parallel** (toolbar): how many nodes may run at once, 4 by default. Every
concurrent node is another live session against the provider, so a wide layer
run flat out is how a graph earns 429s and a bill nobody sized. The layer barrier
is unaffected — a layer still finishes before the next one starts.

**Timeout** (toolbar): how long a single node may run before the engine gives up
on it, 30 minutes by default. A node whose session never goes idle holds its
whole layer, and everything behind it, for the full wait — worth turning down to
5 minutes when a run should be quick.

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
folds that block into the project's `opencode.json` (backed up first, see below)
and points every node at its own agent — this is the only way per-node tool
allowlists take effect at runtime, because a session can only select tools
through a named agent. Until you merge, nodes run as the server's default agent
with its default tools.

**Restart the server after merging.** `opencode serve` reads a project's
`opencode.json` once and caches it — there is no reload route, and dispose does
not re-read it. Agents merged into a running server stay invisible until it
restarts, so the order is: merge agents, restart `opencode serve`, reload the
page, run. Both the merge button and the run pre-flight check for this and say
so rather than letting a node run under an agent that does not exist.

### Backups of your opencode.json

A merge rewrites the project's `opencode.json`, so it copies the file aside
first:

| file | what it holds |
|---|---|
| `opencode.json.bak` | the config as it was before OpenFlow ever touched it — written once, never overwritten |
| `opencode.json.prev.bak` | the state before the most recent merge |

Two files because one is not enough: `.bak` alone, rewritten on every merge,
would hold an already-merged copy after the second merge and the original would
be gone — quietly, since `opencode.json` is usually gitignored.

### Agent config shape

The generated block uses the config's *input* vocabulary — `prompt`, `permission`,
`model`, `mode` — which the server translates on load into the `system` and
`permissions` that `GET /api/agent` reports back. Emitting the reported form
instead gets both fields silently ignored. Verified against a running server in
both directions.

Each tool toggle is written out explicitly: enabled becomes `"allow"`, disabled
becomes `"deny"`, both landing as `{ action, resource: "*", effect }`. The older
`agent.tools` field is marked `@deprecated Use 'permission' field instead` in the
config schema and can only say allow or deny, so it is not used.

Actions the graph says nothing about — `external_directory` above all — are left
out of the map and keep their default, usually `ask`. Those are answered at
runtime, see below.

Names matter, because an unrecognised one becomes a rule that matches nothing
and silently does nothing:

| toggle | permission action | note |
|---|---|---|
| `read`, `grep`, `glob`, `bash`, `webfetch`, `websearch`, `todowrite`, `skill` | same name | |
| `edit` | `edit` | also covers the `write` and `patch` tools |
| `question` | — | special-cased by the server, produces no rule |

`write`, `patch` and `apply-patch` in older saved graphs are folded onto `edit`,
and a deny anywhere in that group wins.

### Permission prompts during a run

An agent can still hit an action whose effect is `ask` — reading a `.env`,
touching a path outside the project. Nobody is watching a headless pipeline, so
an unanswered request would stall that node until the idle wait gives up half an
hour later. The engine subscribes to `permission.v2.asked` and answers every
request for a session it owns, under the toolbar's **permissions** policy:

- **auto** (default) — replies `once`, approving that single call. Deliberately
  not `always`, which would write the approval into the project's saved
  permissions and outlive the run.
- **ask me** — the request surfaces as a card with allow once / always / reject,
  and the node reports `awaiting permission: <action>` until you answer.

Every decision is recorded on the node and in the run log with the action,
resources, reply and policy — an approval that leaves no trace is how a run
quietly changes something nobody expected. Stopping a run rejects anything still
pending rather than leaving the node waiting on an answer that will never come.

### Questions during a run (human in the loop)

A card can stop and ask you something. That is opencode's builtin `question`
tool, enabled per node by the **question** toggle in the inspector's tool list;
with it off the node runs headless and guesses instead. When an agent calls it,
the engine picks up `question.v2.asked`, parks the node (`asking: <header>`) and
shows a modal with the agent's own options — one answer per question, several
labels when the question allows it, plus a free-text box for an answer the
options did not offer.

Unlike a permission ask there is no auto policy, because an invented answer is
worse than none: the agent treats it as your intent. An unanswered question is
therefore *rejected* rather than guessed, and rejection is bounded by a five
minute timeout so a run left alone still finishes rather than holding the node
for the full idle wait. Every exchange is recorded on the node in the run log.

### Attachments

The run bar takes files, and so does each card (inspector → **files**). Pasting
an image into the task field attaches it too, which is how most screenshots get
there. Files are read into `data:` URLs in the browser and sent inline with the
prompt, so there is no upload endpoint, nothing written to the host, and nothing
left behind after a run — at the cost of size, so anything over 4 MB is refused
with a reason rather than failing later as an opaque request error.

A card only receives a file whose modality its model actually accepts, read from
`capabilities.input` on `GET /api/model`. A text-only model in the middle of a
chain is not sent the image; it is told, in the prompt, which files were withheld
and not to claim it saw them, and the run continues. A card with no pinned model
is sent everything, since nothing can prove its model incapable.

## MCP servers

The **plug** button in the titlebar manages the project's MCP servers. Both
kinds are covered: **local** (a command this machine runs, with environment
variables and an optional working directory) and **remote** (an http/sse url with
headers). They are written to the project's `opencode.json` under `mcp`, so the
opencode CLI and TUI see exactly the same set — OpenFlow owns no parallel config.

The panel shows two things at once on purpose. The rows are what the *config*
says; the tag on each row is what the *running server* reports from `GET /mcp`.
They disagree constantly, because `opencode serve` reads its config once at boot:
a freshly added server reads **not loaded — restart server** until it does.
Connect/disconnect act on the live server only — a way to retry a failed
connection without a restart, not a way to change the config.

Per-node access lives in the inspector: each card gets a checkbox per configured
server. An MCP tool is named `<server>_<tool>` and permission actions match by
wildcard, so the generated agent config carries one rule per server
(`"context7_*": "allow" | "deny"`). A card that has never chosen says nothing at
all, which is what a pipeline authored before this existed asked for — it
inherits whatever the server offers rather than being retroactively locked down.

Values in `opencode.json` are plain text. For a secret, prefer an environment
variable the host already holds.

| Store route | Purpose |
|---|---|
| `GET /flow/api/mcp` | servers configured in the project's opencode.json |
| `PUT /flow/api/mcp/{name}` | add or update one (backs the config up first) |
| `DELETE /flow/api/mcp/{name}` | drop one from the config |

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
- the model field is opencode's model menu — searchable, grouped by provider,
  `↑`/`↓`, `Enter`, `Esc` — and it lists nothing until a provider is connected;
  a search that only matches unconnected providers offers to connect them

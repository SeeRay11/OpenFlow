# PLAN_FIRST.md — Manual-First Usability Specs

**Purpose.** Make OpenFlow usable end-to-end **by a human, by hand, with no external
agent tool** (no Claude, Codex, Cursor). A first-timer should build and run a pipeline
without reading docs or asking an assistant.

**Audience.** The implementing model (Opus 5). Each feature below is self-contained:
Goal → Files → Data → Behavior → Acceptance → Tests → Out of scope. Implement in the
suggested order; each feature ships independently.

**Scope boundary.** All work is inside `packages/flow`. Nothing else in the repo may be
touched (see Global Constraints).

---

## Global Constraints (read once, apply to every feature)

1. **Never modify any upstream package.** Only `packages/flow`, `.github`, LICENSE
   attribution, and repo-root docs are fork-owned. Fork merges must stay clean.
2. **UI matches upstream OpenCode and stays minimal.** No new visual language. Reuse
   existing primitives: menus route through `src/ui/select.tsx` (zero native `<select>`),
   icons come from `src/ui/icons.tsx` (hand-drawn 16px, no icon dependency), tokens from
   `:root` in `src/styles.css`. Do not add affordances alongside existing ones.
3. **Style guide** (`AGENTS.md`): early returns over `else`, `const` over `let`, no
   `any`, no aliased/star imports, inline single-use values, functional array methods,
   avoid `try/catch` where possible. Match surrounding code density and naming.
4. **Tests + typecheck run from `packages/flow`, never repo root** (root guard blocks it):
   `bun test` and `bun run typecheck` (tsgo). Add tests next to the code (`*.test.ts`).
5. **Headless verify.** Browser-pane screenshots fail when hidden. Verify UI via
   `read_page` and `javascript_tool` computed styles. Server on :4096 (~30s to listen),
   canvas on `http://localhost:5174` (IPv6 — `127.0.0.1:5174` refuses). Both from
   `.claude/launch.json`. Running the canvas without `opencode serve` makes every
   `/api/*` call fail and surfaces as a *provider* error, not "server down".
6. **No new runtime dependency.** Everything ships with what `packages/flow` already has
   (SolidJS, its store). No new npm packages.

---

## Shared Conventions

- **Graph model** (`src/graph/types.ts`, do not restructure):
  ```ts
  FlowAgent = { name?: string; model?: string; prompt: string;
                tools?: Record<string,boolean>; mcp?: string[]; attachments?: Attachment[] }
  FlowNode  = { id: string; role: string; agent: FlowAgent; position: { x: number; y: number } }
  FlowEdge  = { id: string; source: string; target: string }
  Pipeline  = { id: string; name: string; nodes: FlowNode[]; edges: FlowEdge[] }
  ```
  `emptyPipeline(name)` is exported from the same file.
- **State** (`src/state.ts`): single `createStore<FlowState>`; mutate only through
  `actions`. `actions.load(pipeline)` replaces the whole graph. `actions.addNode(roleId, pos)`
  appends a node built from a role preset. The in-memory pipeline is **not** persisted to
  `localStorage`; saved pipelines live server-side under `.openflow/pipelines/<name>.json`.
- **Roles** (`src/graph/roles.ts`): built-ins `planner, architect, coder, reviewer, custom`.
  `role(id)`, `roleColor(id)`, `allRoles()`. A node's `role` field stores the **label
  text**, and color is resolved by that text — keep any new role's `id === label`.
- **Store routes** (`packages/flow/lib/store.ts`, mounted by BOTH the vite plugin and
  `server.ts` — add a route in one place only): `GET/PUT/DELETE /flow/api/pipelines/:name`,
  `POST /flow/api/pipelines/:name/agents?merge=1`, `GET /flow/api/context`.
- **A run writes real files.** Per-node tool allowlists only bite after generated agents
  are merged into `opencode.json` AND the node names that agent; otherwise a node runs as
  the default `build` agent with `write/edit/bash`. Restart `opencode serve` after any
  merge (config is cached per project).

---

## F1 — Template Pipelines

**Goal.** A first-timer picks a ready-made pipeline and runs it, with zero wiring.

**Files.**
- New: `src/graph/templates.ts` — the template catalog + a builder.
- Edit: `src/ui/palette.tsx` — a "templates" section above "roles".
- Edit: `src/state.ts` only if a helper is needed to load a template (prefer reusing
  `actions.load`).

**Data.**
```ts
// src/graph/templates.ts
export type Template = { id: string; name: string; description: string; build(): Pipeline }
export const TEMPLATES: Template[]  // 3–4 entries
```
Ship these templates, all built from existing built-in roles:
1. `solo-coder` — one `coder` node. "Make one change to your project."
2. `plan-and-code` — `planner` → `coder`. "Plan first, then implement."
3. `plan-code-review` — `planner` → `coder` → `reviewer`. "The full loop."
4. `research-write` — `planner` → `custom` (writer prompt). "Draft a document."

`build()` returns a complete `Pipeline` with fresh node ids (reuse the id scheme
`actions.addNode` already uses), sensible `position` values laid out left-to-right with
horizontal spacing ~300px, and `edges` wired source→target. Each node's `agent` is the
role preset (`role(id).agent`) plus the default model applied per **F3** if one is set.

**Behavior.**
- Palette shows a "templates" `panel-section` above the roles section. Each template is a
  row (reuse `role-card` styling or a sibling `template-card` class matching it): name +
  one-line description, click to load.
- Clicking a template calls `actions.load(template.build())`, replacing the current graph.
- If the current graph is non-empty, confirm via the existing `window.confirm` pattern
  ("Replace the current pipeline?") — the same guard the skills-panel delete uses. No new
  modal component.

**Acceptance.**
- [ ] Fresh canvas → click `plan-code-review` → 3 nodes appear wired planner→coder→reviewer,
      no overlaps, all visible without panning.
- [ ] Loading a template over a non-empty graph asks for confirm; cancel leaves the graph
      untouched.
- [ ] Loaded template passes `layer()` validation (F4) — no cycle, no orphan edges.
- [ ] No native `<select>`, no new dependency, palette still shows roles + graph sections.

**Tests.** `src/graph/templates.test.ts`: every `TEMPLATES[i].build()` returns a pipeline
where (a) `layer()` is `ok`, (b) every edge's source/target exists in nodes, (c) node ids
are unique.

**Out of scope.** Saving templates to the server, user-authored templates (custom roles
already cover reuse).

---

## F2 — First-Run Walkthrough (empty-state)

**Goal.** The blank canvas tells a new user exactly what to do, in order, and each step
self-completes as they do it.

**Files.**
- Edit: `src/app.tsx` — render a walkthrough overlay when the canvas is empty and the
  walkthrough hasn't been dismissed.
- Edit: `src/styles.css` — overlay styles using existing tokens only.
- Reuse: the `.canvas-empty` element already layered over the canvas.

**Critical constraint.** `.canvas-empty` is `inset: 0` over the whole canvas and **must
keep `pointer-events: none`** or palette drag-to-create and panning die silently. The
walkthrough content sits *inside* it and must re-enable `pointer-events: auto` only on the
actual interactive elements (buttons), never the full-bleed container.

**Data.**
- `localStorage` key `openflow.walkthroughDone.v1` = `"1"` once dismissed.
- Steps derive their done-state from live app state, not stored flags:
  1. **Add a provider key** — done when at least one provider is unlocked (the same signal
     the providers panel reads at boot). Action button opens the providers panel
     (`setShowProviders(true)`).
  2. **Add a node** — done when `state.pipeline.nodes.length > 0`. Hint points at the
     palette / templates.
  3. **Connect nodes** — done when `edges.length > 0` (auto-satisfied by a template or a
     single-node pipeline; mark done when nodes ≥ 1 and either edges ≥ 1 or nodes === 1).
  4. **Run** — points at the Run button.

**Behavior.**
- Show the walkthrough only when `nodes.length === 0` AND `openflow.walkthroughDone.v1`
  is unset. It disappears as soon as the canvas has a node (step 2 done) and does not
  reappear once dismissed.
- A "Skip" link sets the localStorage flag and hides it.
- Each step shows a done check when its derived condition is true.
- Styling matches OpenCode surfaces (same panel/`hint` classes, Inter 13px). No confetti,
  no animation beyond what upstream uses.

**Acceptance.**
- [ ] Fresh browser (cleared `localStorage`) → walkthrough visible on empty canvas.
- [ ] Unlocking a provider ticks step 1 without reload.
- [ ] Dropping a node hides the walkthrough; reloading with a node present keeps it hidden.
- [ ] Skip persists across reloads.
- [ ] Palette drag-to-create and canvas panning still work while the walkthrough shows
      (verifies `pointer-events` is correct).

**Tests.** Logic that decides step-done and visibility must be a pure exported function
(e.g. `walkthroughState({ unlockedProviders, nodes, edges })`) unit-tested in
`src/app.test.ts` or a small `src/ui/walkthrough.test.ts`. Do not test DOM.

**Out of scope.** Multi-page tour, tooltips on individual controls (that's F8).

---

## F3 — Per-Node Default Model

**Goal.** A freshly dropped node is runnable immediately, without opening the model
picker — using a model the user has actually unlocked.

**Why a preference, not a hardcoded model.** Model ids change and are provider-gated. A
role cannot safely hardcode `model`, because that provider may be locked. Instead the app
holds one **default model preference**, set once, applied to every new node.

**Files.**
- New: small module `src/graph/default-model.ts` (signal + localStorage), or fold into
  `src/graph/roles.ts` if it reads cleaner — keep it near role/agent construction.
- Edit: `src/state.ts` `addNode` — apply the default when the role preset has no `model`.
- Edit: `src/graph/templates.ts` (F1) — apply the same default in `build()`.
- Edit: `src/ui/model-picker.tsx` **or** the providers panel — a "set as default" affordance
  and a way to see the current default. Reuse existing menu/row styling.

**Data.**
```ts
// localStorage key
"openflow.defaultModel.v1"  // value: "providerID/modelID" or absent
export const defaultModel: () => string | undefined
export function setDefaultModel(id: string | undefined): void
```

**Behavior.**
- When `addNode` builds a node and the role preset's `agent.model` is empty, set
  `agent.model = defaultModel()` **only if** that model is currently in the unlocked model
  list (from the boot model fetch). If it isn't available, leave `model` empty (F4 will
  flag it).
- First-run: if no default is set and exactly one unlocked model exists, offer it as the
  default in the walkthrough; otherwise the user sets it from the picker.
- Changing the default does not rewrite existing nodes.

**Acceptance.**
- [ ] With a default set to an unlocked model, dropping a `coder` node yields a node whose
      model equals the default (verify via `read_page`/inspector).
- [ ] With the default pointing at a now-locked model, a new node has empty model and F4
      flags it — no crash.
- [ ] Existing nodes are unchanged when the default changes.

**Tests.** `src/graph/default-model.test.ts`: get/set round-trips through localStorage;
`addNode` applies default only when the model is in a supplied "available" set (pass the
set in; do not touch `globalThis`).

**Out of scope.** Per-role default models, auto-selecting a free model without user
consent (surface it, let them pick).

---

## F4 — Pre-Run Validation

**Goal.** Before a run starts, tell the user exactly what's missing in one place, in plain
language — never let a misconfigured graph fail silently mid-run.

**Files.**
- Edit: `src/graph/validate.ts` — add a `preflight(pipeline, ctx)` that returns structured
  problems. Keep the existing `layer()` and `wouldCycle()` intact and reuse `layer()`.
- Edit: `src/app.tsx` `run()` — call `preflight` first; if it has blocking problems, show
  them and do not start the run.
- Edit: `src/styles.css` — a banner/list style using existing tokens (reuse `.hint` /
  status colors; error uses the same `data-state="bad"` red as the statusbar dot).

**Data.**
```ts
export type Preflight = { blocking: Problem[]; warnings: Problem[] }
export type Problem = { nodeId?: string; kind: string; message: string }
export function preflight(pipeline: Pipeline, ctx: {
  unlockedModels: Set<string>   // "providerID/modelID" the user can actually run
}): Preflight
```
Checks (reuse `layer()` for the structural ones):
- **blocking**: no nodes; cycle; edge with unknown source/target; self-loop; a node whose
  resolved model is empty **and** has no agent `name` (nothing to run it on); a node whose
  model is set but not in `unlockedModels`.
- **warnings**: a node with `edit`/`bash` tools enabled but no restricted agent name yet
  (may write real files as default `build` agent — tie wording to the known hazard); an
  isolated node with no edges in a multi-node graph.

**Behavior.**
- `run()` computes `preflight`; if `blocking.length > 0`, render the list (each item links
  to its node by selecting it) and abort before any session is created.
- Warnings render but do not block; the user can still Run.
- Messages are human-readable and name the fix ("Node ‘coder’ has no model — pick one or
  set a default"), not internal error codes.

**Acceptance.**
- [ ] Empty graph → Run shows "pipeline has no nodes", no session created.
- [ ] Node with a locked model → blocking problem naming that node; Run aborts.
- [ ] `planner→coder→reviewer` all with unlocked models → `preflight` returns no blocking,
      run proceeds.
- [ ] A `coder` node with `bash:true` and no restricted agent → warning shown, Run still allowed.

**Tests.** `src/graph/validate.test.ts` (extend): table of pipelines → expected
`blocking`/`warnings` kinds. Pure function, pass `ctx` explicitly — no network, no globals.

**Out of scope.** Auto-fixing problems; provider key entry (link to the panel instead).

---

## F5 — Export / Import Pipeline as File

**Goal.** A user can save a pipeline to a `.json` file and load one back, to share or back
up without understanding `.openflow/` internals.

**Files.**
- Edit: `src/app.tsx` — an Export and an Import control near the existing pipeline picker
  (`empty="No saved pipelines yet."` row). Reuse existing icon-buttons from `icons.tsx`.
- Reuse: the browser `Blob`/`<a download>` for export and a hidden `<input type=file>` for
  import — no server route, no new dependency.

**Data.** The file is exactly the `Pipeline` JSON already used by
`PUT /flow/api/pipelines/:name` (`{ id, name, nodes, edges }`). No wrapper envelope, so an
exported file is also a valid server pipeline file.

**Behavior.**
- **Export**: serialize `state.pipeline` (pretty-printed) and trigger a download named
  `<pipeline-name>.json`.
- **Import**: read the chosen file, `JSON.parse`, validate shape with a guard
  (`isPipeline(x)`: has string `id`/`name`, arrays `nodes`/`edges` with the right field
  types), then `actions.load(parsed)`. On a bad file show the existing `notice` toast
  ("Not a valid OpenFlow pipeline"), never throw.
- Importing over a non-empty graph uses the same confirm guard as F1.

**Acceptance.**
- [ ] Export produces a file that re-imports to an identical graph (round-trip equality on
      `nodes`/`edges`/`name`).
- [ ] Importing a hand-edited valid file loads it.
- [ ] Importing a truncated/invalid JSON file shows a notice and leaves the graph unchanged.
- [ ] Exported file loads as-is when dropped into `.openflow/pipelines/` (same schema).

**Tests.** `src/graph/pipeline-io.test.ts` (or extend `state.test.ts`): `isPipeline` accepts
a good object and rejects each malformed variant (missing name, nodes not array, edge
missing target). Keep the guard a pure exported function.

**Out of scope.** Drag-and-drop file import, versioned/migrating file formats.

---

## F6 — Single Cross-Platform Launcher

**Goal.** One command starts both processes (`opencode serve` on :4096 and the canvas on
:5174), waits until the engine is actually listening, and prints the URL — so a non-dev
never juggles two terminals.

**Current state.** `openflow.ps1` exists at repo root (Windows-only, ~6KB). `.claude/launch.json`
defines the two processes. `packages/flow` scripts: `dev` = `vite`, `build` = `vite build`,
`start` = `bun server.ts`. The exact serve argv already lives in
`packages/flow/lib/opencode-process.ts` `serveCommand(...)`:
`["bun","run","--cwd","packages/opencode","--conditions=browser","src/index.ts","serve","--port",port]`
with `cwd` = repo root. `healthy(url, timeout)` in the same file polls the engine.

**Constraint decision — do NOT edit the root `package.json`.** The upstream root manifest is
off-limits beyond the fork changes already made. Ship the launcher as a standalone root script
invoked directly (`bun openflow.ts`), not as a `scripts` entry. Root-level `openflow.*` files
are fork-owned (like the existing `openflow.ps1`).

**Files.**
- New: `openflow.ts` (repo root) — the cross-platform launcher (Bun).
- Edit: `openflow.ps1` (repo root) — reduce to a thin shim that runs `bun openflow.ts`
  (keep it so existing Windows muscle memory works), or delete if the shim adds nothing.
- Reuse: `healthy` from `packages/flow/lib/opencode-process.ts` for the readiness check.
  Import it — do not reimplement.

**Behavior.**
1. Resolve config: port 4096 for serve, 5174 for the canvas, repo root as cwd. Honor
   `OPENCODE_SERVER_URL` and `OPENFLOW_PROJECT` from the environment and pass them through to
   the children unchanged.
2. **Port-aware start (matches the "check before starting your own" rule).** Before spawning
   the engine, `healthy("http://127.0.0.1:4096")`. If it already answers, do not spawn a
   second one — reuse it (log "engine already running on :4096"). Same idea for :5174: if it
   is already serving, skip spawning the canvas.
3. Spawn each needed process with `Bun.spawn`, `cwd` = repo root, inheriting env. The serve
   argv is the one above; the canvas argv is `["bun","--cwd","packages/flow","dev"]`.
4. Stream both children's stdout/stderr to the console, each line prefixed (`[engine]` /
   `[canvas]`) so a first-timer can see what is happening.
5. Poll `healthy` on :4096 until it returns true (engine takes ~30s) or a timeout (~90s)
   elapses; on timeout, print a clear message and exit non-zero. Only after the engine is
   healthy, print the canvas URL prominently: `→ Open http://localhost:5174`. Optionally open
   the browser (`start` on win32, `open` on darwin, `xdg-open` on linux) — best-effort, never
   fatal if it fails.
6. **Lifecycle.** On `SIGINT`/`SIGTERM`, kill both children and their trees, then exit. On
   Windows a `bun run …` child execs a grandchild that actually holds the port, so kill the
   tree (`taskkill /pid <pid> /T /F`), mirroring the existing teardown in
   `opencode-process.ts`; on POSIX kill the process group. If either child exits on its own,
   tear the other down and exit with the same code.

**Acceptance.**
- [ ] `bun openflow.ts` from a clean repo starts both, waits for the engine, prints the URL,
      and `http://localhost:5174` loads a working canvas (provider panel populated, not the
      "provider failure" false alarm that means the engine is down).
- [ ] Running it again while :4096 is already served does **not** spawn a second engine (log
      says it reused the running one).
- [ ] `Ctrl-C` leaves no `bun`/`opencode` process holding :4096 or :5174 (verify with
      `netstat`).
- [ ] `OPENFLOW_PROJECT=<dir> bun openflow.ts` makes agent writes land in `<dir>` (the env
      var reaches the flow host).

**Tests.** Pure helpers only — do not spawn real servers in a unit test. Extract the argv/URL
resolution into a testable function (e.g. `launchPlan({ env, repo })` returning
`{ engine: {argv, skip}, canvas: {argv, skip}, canvasUrl }`) and test it in
`openflow.test.ts` (or `packages/flow/lib/launch.test.ts` if the helper lands under `lib`):
env overrides win, default ports, `skip` toggles from an injected `healthy` stub. No real I/O.

**Out of scope.** Packaging a binary, a system service/daemon, auto-installing Bun.

---

## F7 — Free-Model Prominence

**Goal.** On a fresh install with no API key, the model picker makes it obvious there are
**free, keyless** models to run right now, so "just try it" costs nothing and needs no signup.

**Grounded facts.**
- The `opencode` provider (zen) is always `unlocked: true` — `opencode serve` hands its models
  to a browser that has never seen a key (`src/server/providers.ts`, the `unlocked: true` row).
- Zen's real served list (free tier included) is read live by `packages/flow/lib/zen.ts`
  `zenModels()`; its free models carry a `-free` suffix in their id (e.g.
  `nemotron-3.5-lightning-free`). Do **not** hardcode one id — treat the `-free` suffix as the
  marker, centralized in one place.
- `ModelOption` has a `runnable` flag (false → "no runner" tag). The picker groups models by
  provider (`groupMatches`) and already hides locked providers.

**Files.**
- Edit: `src/server/providers.ts` — add `isFreeModel(option)` and `freeModels(rows)` plus a
  `suggestedFreeDefault(rows)`.
- Edit: `src/ui/model-picker.tsx` — a pinned "Free — no key needed" group at the top when the
  search query is empty, and a `free` tag on those rows.
- Edit: `src/styles.css` only if the existing `oc-tag` needs a variant color (prefer reusing
  `oc-tag` as-is).
- Consumed by **F3** (`suggestedFreeDefault` becomes the walkthrough's offered default) and
  **F2** (walkthrough copy: "or run a free model, no key needed").

**Data.**
```ts
// src/server/providers.ts
const FREE_SUFFIX = "-free"                       // zen's free-tier marker, one place
export function isFreeModel(option: ModelOption): boolean
  // provider is "opencode", runnable === true, id ends with FREE_SUFFIX
export function freeModels(rows: ProviderRow[]): ModelOption[]        // runnable free zen models
export function suggestedFreeDefault(rows: ProviderRow[]): string | undefined
  // "opencode/<id>" of the first runnable free model, or undefined
```

**Behavior.**
- Picker, empty query: render a first group titled "Free — no key needed" containing
  `freeModels(rows)`, each row tagged `<span class="oc-tag">free</span>`. Below it, the normal
  provider groups as today (the free models may also appear under their provider group — that
  is fine; the pinned group is the discovery aid).
- With a search query, drop the pinned group and fall back to the existing `searchModels`
  behavior unchanged.
- Never invent a free model when none is served (`freeModels` empty → no pinned group, no
  crash). Respect `zenModels()` returning `undefined` (unreadable list) by leaving the catalog
  alone, exactly as the server already does.

**Acceptance.**
- [ ] Fresh install, no keys → opening any node's model picker shows the "Free — no key needed"
      group at top with at least one runnable model tagged `free`.
- [ ] Selecting a free model sets the node's model to `opencode/<id>` and a run against it
      actually streams (use a known-good free model live).
- [ ] Typing a search term hides the pinned group and searches normally.
- [ ] When zen is unreachable, the picker still opens and shows whatever was cached, no error.

**Tests.** `src/server/providers.test.ts` (extend): `isFreeModel` accepts an opencode runnable
`*-free` option and rejects (a) non-opencode providers, (b) non-runnable, (c) ids without the
suffix; `freeModels`/`suggestedFreeDefault` over a fixture `ProviderRow[]`. Pure, no network.

**Out of scope.** Curating which free model is "best", rate-limit handling, per-model quality
labels.

---

## F8 — Tooltips on Every Affordance

**Goal.** A first-timer can hover any control and learn what it does — especially the tool
checkboxes, which decide whether a node can write/edit/run and are the source of the
real-file-write hazard.

**Grounded inventory (already have a `title`, leave them):** palette `role-card`
("add a {label} node") and its edit/delete icons; node `port-in` ("input"); node `port-out`
("drag to an input port to connect"); the inspector model **test** button.

**Missing `title` — add them:**
- **Tool checkboxes** (`src/ui/inspector.tsx`, `.tool-check` labels rendering `{tool}`) — the
  highest-value gap. Each needs a plain-language description.
- **Node status badge** (`src/canvas/node-card.tsx`, `.badge` with `data-status`) → the status
  word plus a hint (e.g. "running — this card's session is active").
- **Node header** (`.node-header`) → "drag to move this card".
- **Node model line** (`.node-line` showing `model || "default model"`) → "runs on the agent's
  own default when blank".
- **Statusbar dot** (`src/app.tsx`, `.statusbar-dot`) → the current status string.
- **Inspector field labels** (`role`, `model`, `agent`, `prompt`) → one-line descriptions.

**Files.**
- New: a small `TOOL_HELP` map. Co-locate it with wherever the inspector's tool list constant
  is defined (import that list; do not duplicate it). If no shared constant exists, create one
  and have both the map and the inspector consume it.
- Edit: `src/ui/inspector.tsx`, `src/canvas/node-card.tsx`, `src/app.tsx` — add `title`
  attributes only.

**Data.**
```ts
export const TOOL_HELP: Record<string, string> = {
  read:  "Read files in the project",
  grep:  "Search file contents",
  glob:  "Find files by name pattern",
  edit:  "Modify existing files",
  write: "Create new files",
  bash:  "Run shell commands",
  // …one entry per tool the inspector lists
}
```

**Behavior.**
- Use the **native `title` attribute** everywhere — no custom tooltip component, no library,
  no positioning code. This matches the minimal-UI directive (upstream uses `title`), adds no
  dependency, and cannot break layout.
- Each `.tool-check` label gets `title={TOOL_HELP[tool]}`. Tools without an entry fall back to
  the tool name (never render `undefined`).
- Tooltip text is a short, plain sentence naming the effect, not internal jargon.

**Acceptance.**
- [ ] `read_page` shows a non-empty `title` on every tool checkbox, the node badge, node
      header, node model line, and statusbar dot.
- [ ] Every tool the inspector renders has a `TOOL_HELP` entry (no fallback-to-name in the
      default set).
- [ ] No layout shift and no new dependency; still zero native `<select>`.

**Tests.** `src/ui/tool-help.test.ts`: assert `TOOL_HELP` has an entry for every tool in the
inspector's tool list (import both; the map's keys must be a superset). Pure.

**Out of scope.** Rich/animated tooltips, keyboard-triggered help, a help center.

---

## Suggested Order

Two tracks; do the core track first.

- **Core (onboarding):** `F4` (pure, testable, unblocks safe runs) → `F7` (free-model helpers
  feed the default) → `F3` (default model, consumes F7) → `F1` (templates, biggest UX win) →
  `F2` (walkthrough, ties them together) → `F5` (export/import, independent).
- **Polish (independent, any time):** `F6` (launcher) and `F8` (tooltips) touch disjoint files
  and can land in parallel with the core track.

## Definition of Done (every feature)

1. `bun test` and `bun run typecheck` pass from `packages/flow`.
2. New logic has a unit test that exercises real behavior (no mocks, no `globalThis`).
3. Verified live in the canvas at `http://localhost:5174` with `opencode serve` up, using
   `read_page` / `javascript_tool` (screenshots unavailable when the pane is hidden).
4. Nothing outside `packages/flow` changed; no new dependency in `package.json`.
5. Any correction that would apply to future work is added to `FLOW.md` as a "when X, do Y"
   rule.

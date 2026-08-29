# FLOW.md — working rules for OpenFlow

OpenFlow is a node-based visual builder for multi-agent workflows. It lives entirely in
`packages/flow`. Everything else in this repo is a vendored fork of OpenCode.

`AGENTS.md` (upstream) still governs code style, branch names, commit format, and the
general testing/typecheck rules. This file covers what is specific to OpenFlow and is not
derivable from the code.

## The one hard constraint

**Do not modify any upstream package.** Fork merges must stay clean. Fork-owned surfaces
are `packages/flow`, `.github`, the LICENSE attribution line, and this file. `bun.lock`
gains only the workspace entry.

Corollary: **do not scrub the hundreds of `opencode` string references** in the upstream
README, docs, source, `sst.config.ts`, or `infra`. They are intentional. Scrubbing them
fights the no-upstream-modification design.

Read `packages/flow/README.md` before touching the code — endpoints, run instructions,
file layout, and API-key/model behavior are documented there rather than re-derived.

## Architecture, settled

- **One card = one full `opencode serve` primary session.** `src/server/engine.ts` per
  node: `createSession({agent, model})` → `prompt` → `waitForIdle` → `transcript`. Nodes
  run in topological layers via a parallel pool.
- **A canvas has a mode, and modes do not nest.** `Pipeline.mode` is `pipeline` (absent, and
  what every canvas saved before modes existed reads as), `swarm`, or `orchestration`. It is
  a property of the *document*, not of a run — it is persisted, exported, and undoable,
  because it changes what an existing graph does. Everything about running one session
  (`runNode`) is shared across modes; only the **scheduler** differs — which nodes run, in
  what order, and what their prompts carry. A mode with no scheduler refuses in two places
  that must stay in step: `shapeProblems` in `graph/validate.ts` (the message the user sees)
  and a throw at the top of `start()` (the engine is callable without preflight, and running
  a swarm's graph through the pipeline scheduler would spend real money on an answer nobody
  designed). `modeOf()` normalises anything unrecognised to `pipeline`; `isPipeline()`
  rejects it outright, because a file asking for rules this build lacks should not import.
- **A swarm is a node list, not a wiring.** Every non-`synthesizer` card is a peer of every
  other; `Pipeline.edges` is never read, so a cycle left behind by a pipeline is harmless and
  leftover edges only warn. `swarmShape()` in `graph/swarm.ts` is the one place that splits
  the canvas, by the card's **role text** — designating the decider is renaming a card, not
  setting a hidden flag. The canvas draws the mesh from `meshPairs()` and refuses to start a
  link, because an edge the user dragged would be one the run never reads.
- **Swarm rounds are barriers, and the peer snapshot is taken on the boundary.** Round R
  reads a frozen copy of round R−1 (`said = new Map(outputs)` before the pool is dispatched).
  Snapshotting per card instead would let a peer early in the pool be read by a peer later in
  the *same* round, so the debate would depend on scheduling order. A peer keeps **one
  session** across every round — `runTurn(..., reuse)` — so it remembers its own reasoning and
  the provider can cache the prefix; that is why round 1 carries the briefing and the task and
  later rounds carry only the peers. Attachments ride the first turn only. A peer that failed
  is dropped rather than retried: a new session in round 3 would answer with no memory of
  rounds 1 and 2 while every peer around it has both, and the synthesizer is told who is
  missing so it does not write a confident verdict over the hole.
- **An orchestration is a tree, and the tree is the recursion.** One root (the card nothing
  points at), every other card owed to exactly one parent. A card with children of its own is
  an orchestrator for its subtree and runs the identical loop one level down — so "subagents
  deploy subagents" is bounded by the graph the user drew, and every session is a card that is
  visible, priced and re-runnable. A diamond is refused because the second dispatch would
  re-prompt a session still working on the first orchestrator's task. There is deliberately no
  "no root" or "unreachable card" check: in a DAG something always has nothing pointing at it,
  and everything is downstream of some root, so those cases surface as a cycle or a second root.
- **The orchestrator speaks through a fenced ` ```openflow ` block** — `{dispatch:[{card,task}]}`
  or `{final}` — parsed by `graph/dispatch.ts`. The **last** block wins, because a model often
  quotes the protocol before using it. A malformed block is handed back **once** with the exact
  reason; a second failure fails the card, since every ask is a paid turn. A card id outside the
  orchestrator's own children is refused, and so is the same card twice in one batch — one card
  is one session, and two assignments would race it.
- **A card that ignores its spent budget is stopped, not re-asked.** When the budget runs out
  the orchestrator gets one forced-answer turn; if it dispatches anyway the node fails. Without
  that check the loop never ends. A leaf goes through `runSubagent` and is never shown the
  protocol; a subtree orchestrator gets `subOrchestratorPrompt` (orchestrator briefing *and* an
  assignment), because briefing it as a leaf and then parsing it for a control block is a
  guaranteed failure. A re-dispatched card is prompted into its existing session with
  `reassignPrompt`, which says the old assignment is over — otherwise it reads the new task as
  more detail on the old one. After an orchestration run, cards nobody dispatched are marked
  `skipped`, not left `queued`.
- Cost is the standing hazard of both new modes. A swarm is `agents × rounds + 1` sessions; an
  orchestration is `1 + Σ(children × dispatches)` per level, and preflight warns with the actual
  number past a dozen. `MAX_ROUNDS`, `MAX_DEPTH` and `MAX_DISPATCHES` exist for that reason and
  `roundsOf()` / `depthOf()` / `dispatchesOf()` clamp, so a hand-edited file cannot talk the
  engine into an unbounded run.
- **OpenFlow has no agent loop of its own.** The harness is identical to the OpenCode CLI
  harness, so a card inherits OpenCode's tools, permission ruleset, and subagents. Subagents
  work but are OpenCode-native and invisible to OpenFlow, which only sees the final
  transcript. OpenFlow injects no skills and adds no Claude-Code skill/MCP layer inside a card.
- The canvas is hand-rolled — HTML node cards over an SVG edge layer in one CSS-transformed
  viewport. `solid-flow` is abandoned (last publish 2022, Solid 1.5); do not reach for it.
- `@opencode-ai/sdk-next` is **not** an HTTP client — it embeds a server in-process via
  Effect. Browser code uses `createOpencodeClient` from `@opencode-ai/sdk/v2/client`.
- Use v2 `/api/*` routes. The older `/session/*` + `prompt_async` routes are superseded.
- Store routes (`/flow/api/*`) live in `lib/store.ts` and are mounted by **both** hosts
  (the vite plugin and `server.ts`) so dev and built output cannot drift. Add new routes in
  one place only.

## Running and verifying

- `opencode serve` on **:4096**, canvas dev server on **:5174**. Both start from
  `.claude/launch.json` (`opencode-server`, `openflow`).
- :5174 binds `localhost`/IPv6 — `127.0.0.1:5174` refuses the connection. Use
  `http://localhost:5174`.
- `opencode serve` takes ~30s to listen. Early `/api/*` proxy calls fail; reload rather
  than debug it.
- **Running the canvas without `opencode serve` is the number-one false alarm.** Every
  `/api/*` call dies and the symptom surfaces as a *provider* failure (empty provider panel,
  failing key import), not an obvious "server down". The dev proxy now answers 502 naming the
  missing server.
- Another session may already hold :4096 or :5174. Check `netstat` before starting your own.
- From `packages/flow`: `bun test` and `bun run typecheck` (tsgo). Tests cannot run from the
  repo root.

### Verification in a hidden browser pane

`computer{action:"screenshot"}` and `left_click_drag` need a composited pane and error when
it is hidden. `file://` also fails. Verify via `read_page` and `javascript_tool` computed
styles instead. Working headless techniques:

- Wire ports by dispatching `PointerEvent` down/move/up with `clientX/Y` from `.port-out`
  to `.port-in`.
- Select a node by dispatching pointerdown/up/click on `.node` (adds `.selected`).
- The model picker is a portal `.oc-menu` with `input[placeholder="Search models…"]`; set
  the value through the native setter plus an `input` event, then click the matching leaf.
- Inspector fields drive fine via `form_input` on their refs.
- A bare `fetch('/api/agent')` reports the **server-cwd** project's agents. Add header
  `x-opencode-directory: <OPENFLOW_PROJECT>` to see the merged pipeline agents.

## Hazard: test runs write real files

Per-node tool allowlists only take effect after the generated agents are merged into the
project `opencode.json` **and** the node names that agent. Otherwise nodes run as the server
default `build` agent with `write`/`edit`/`bash`. A verification run once took its task
literally and edited `packages/cli`.

Before any run that could write: give it a restricted agent, and set `OPENFLOW_PROJECT` to
the target repo.

The mechanism, measured 2026-08-26: **a session's location is the engine's cwd, never
`OPENFLOW_PROJECT`.** `supervisorFor` spawns `opencode serve` with `cwd: input.repo` — the
OpenFlow checkout (`packages/opencode` when run from source) — so every session records that
directory, and the merged project agents are simply not there at drain time. `AgentV2.select`
does not fail on an unknown id; it returns `{ id, info: undefined }`, and the runner then reads
`agent.info?.system` and `agent.info?.permissions` as undefined. A session created with the
agent name `this-agent-does-not-exist-xyz` answered normally — no node system prompt, default
tool set. `x-opencode-directory` only steers the *reads* (`/api/agent`, `/api/model`), not the
drain. Anything that must reach a run — an agent, a permission ruleset, a provider override —
therefore belongs in the global config or in the engine's own cwd, not in the target project.

**Skills written through `PUT /flow/api/skills/:name` are subject to the same trap.** The file
lands in `<project>/.openflow/skills/<name>/SKILL.md` and the path is registered in the project
`opencode.json` — both correct, and both at a location no run ever reads. Measured 2026-08-26:
after a restart, `GET /api/skill` did not list the new skill, with or without
`x-opencode-directory`; copying the same folder to `~/.config/opencode/skills/<name>/` made it
appear immediately and every provider then used it. Until the engine is spawned in the project,
a skill that must reach a card has to be global.

## Design directive (standing)

**The entire OpenFlow UI matches upstream OpenCode, and stays minimal.** Copy from upstream
components rather than approximating them, and do not add extra affordances alongside them.

- Model and provider UI mirrors `packages/app/src/components/dialog-select-model.tsx` and
  `dialog-connect-provider.tsx`. A fresh install shows **no models, only providers** — pick a
  provider, enter a key, then its models exist.
- Tokens are copied verbatim from `packages/ui/src/v2/styles/theme.css` and `colors.css` into
  `:root` in `src/styles.css`, because the flow page loads no upstream stylesheet and
  `@opencode-ai/ui` stays out of the dep tree. Inter 13px / weight 440 / tracking -0.04px;
  mono only for code, ids, and paths. Fonts are copied into `packages/flow/public/fonts/`.
- Chrome is titlebar 40px / runbar 44px / statusbar 28px around a three-column `main`.
- Native `<select>` cannot be styled into OpenCode's popover. Every menu routes through
  `src/ui/select.tsx` (controlled; `value=""` for action menus). Zero native selects survive.
- Icons are the hand-drawn 16px set in `src/ui/icons.tsx`. No icon dependency.
- Five role colors are OpenCode's own dark agent solids: planner `#f799c6`, architect
  `#9e99f7`, coder `#c3d4fd`, reviewer `#b8e9c1`, custom `#f7e5b5`. Two are OpenFlow's own,
  because opencode has no agent for either job: `synthesizer` `#8fd4e8` reads a swarm and
  decides, `orchestrator` `#f7c48b` hands work to cards it can see. Cyan and amber are the
  hues the five leave free. Add a color here only for a role opencode genuinely has no
  counterpart for, and say so where it sits.

## CSS and interaction traps

Check these first when the UI misbehaves — each one cost a debugging session.

- `.canvas-empty` is `inset: 0` over the whole canvas. It **must** keep
  `pointer-events: none`, or palette drag-to-create and panning die silently.
- A global `:focus-visible { box-shadow: … }` *replaces* elevation. `.btn` and `.node` have
  to restate both or they flatten on focus.
- The Delete/Backspace guard matches with `closest("input, textarea, select,
  [contenteditable], .oc-picker, .oc-backdrop")`, never by `tagName` — with native selects
  gone, a tag-name test lets Backspace delete the selected node from inside a menu.
- A popover-owning row must never sit in an `overflow` container; it clips the menu.
- `.field` on a `<textarea>` outranks the bare `textarea` rule (0,1,0 vs 0,0,1) and clamps
  it to 28px.
- Menus that skip the search row must focus the list explicitly, or arrow/Enter/Escape reach
  no listener. Pick rows with `keys().includes(active())`, never truthiness — `""` is a real
  option ("(server default)", "Agent default").
- `<Show when={sig()}>{(entry) => <Comp prop={entry()} />}</Show>` — the callback form gives
  an accessor, not a value.
- When overlaying the empty canvas (the first-run walkthrough, any hint layer), the full-bleed
  container must keep `pointer-events: none` and re-enable it only on the buttons — the same
  rule as `.canvas-empty` — or drag-to-create and panning die. The walkthrough is a `position:
  fixed` layer in `src/ui/walkthrough.tsx` following this exactly.

## Sessions come from opencode, not from OpenFlow

The sessions sidebar (`src/ui/sessions-panel.tsx`) reads `GET /api/session` — the rows of
OpenCode's drizzle sqlite `session` table in `opencode.db`. **Never open that file
directly.** `opencode serve` owns the handle; a second writer from `server.ts` or the vite
plugin is a corruption path, and it would drag `@opencode-ai/core` into a browser dep tree
that only carries `@opencode-ai/sdk`. The HTTP route *is* the drizzle system.

Two shapes that surprise, both learned the hard way:

- **`?search=` matches the session title and nothing else.** No node ever sets a title, so
  every OpenFlow session is auto-named `New session - <iso>`; `search=coder` answers zero
  for a project holding ten coder sessions, and the fields that identify a node — its
  generated agent, its model — are unsearchable server-side. When filtering a session list
  by anything a user would actually type, fetch a page and match client-side
  (`matches()` in `src/server/sessions.ts`).
- **User and assistant messages are not shaped alike.** A user message carries its prompt
  in a top-level `text` and has **no `content` array at all**; an assistant message carries
  `content` parts. Reading only `content` silently drops every prompt and renders replies
  to nothing. `transcriptTurns()` reads both, and its tests pin both.

## Config and cost gotchas

- **`opencode serve` caches config per project and never re-reads it.** Restart the server
  after merging agents, adding skills, or editing `opencode.json`.
- `skills` in `opencode.json` is an **object** (`{ paths: [...] }`), not an array.
  `registerSkillSource` also repairs a bare array left by older builds.
- `slug()` in `lib/store.ts` does **not** lowercase — it only strips path separators and
  collapses spaces. Skill display name and folder legitimately differ in case; `readSkill`
  returns both `name` (frontmatter, what the agent sees) and `folder` (what the API addresses).
- This vendored server build reports `cost: 0`, so spend is computed client-side in
  `src/server/usage.ts` from models.dev per-1M tiers. **An unpriced model must never render
  as zero** — show it as unknown.
- Permissions set to `auto` reply `once` to every ask.
- **The repackage lives in the app, not in a hand-edited file.** `lib/repackage.ts` holds
  upstream's profile table (id to base URL) and writes the override into the *global*
  `opencode.json`; `GET/POST /flow/api/repackage` drive it and the provider panel offers it
  as a banner on any connected provider from that table. Only ids in the table are accepted,
  so no request can name an arbitrary npm package. The write follows the file's own dialect:
  one v1 key anywhere (`plugin`, `agent`, `provider`, ...) makes opencode migrate the whole
  file, where `providers` is never read — so a v1 file gets `provider.<id> = {npm, api}` and a
  v2 file gets `providers.<id>.api = {type, package, url}`. Config is read once at boot, so the
  panel restarts the engine after writing. The manual equivalent below still applies to a host
  OpenFlow does not own.
- **A provider whose models the runner cannot route is fixed by repackaging it, in the *global*
  config.** The v2 runner routes three API packages only (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
  `@ai-sdk/openai-compatible` + url); everything else — OpenRouter's `@openrouter/ai-sdk-provider`,
  `@ai-sdk/groq` — throws `UnsupportedApiError` at dispatch, which the panel renders as
  `no runnable models` and a run reports as "the session never started executing". For an
  OpenAI-compatible endpoint, override the provider's package in
  `~/.config/opencode/opencode.json`:
  `"provider": { "openrouter": { "npm": "@ai-sdk/openai-compatible", "api": "https://openrouter.ai/api/v1" } }`,
  and groq the same with `https://api.groq.com/openai/v1`. Both URLs are upstream's own, from
  `packages/llm/src/providers/openai-compatible-profile.ts` — that table already classes
  openrouter, groq, cerebras, deepseek, fireworks, togetherai, xai, baseten and deepinfra as
  OpenAI-compatible, so it is the list to copy from when a new provider needs this.
  Provider-level is enough — every model of that provider inherits the new package; no per-model
  map. Stored credentials still resolve, because the provider id is unchanged.
  **Project-level config does not work for this.** A session's location is the *engine's* cwd
  (`packages/opencode`), not `OPENFLOW_PROJECT`, so the target project's `opencode.json` reaches
  the catalog reads the browser makes with `x-opencode-directory` but never the drain that runs
  the model. Global config applies to both. Restart the engine after editing either.
  Cost of the swap: the OpenRouter plugin keys off the old package, so its `HTTP-Referer`/`X-Title`
  headers and its disabling of the broken `gpt-5-chat` aliases stop applying.
- **`runnable()` mirrors that profile table by provider id**, so the panel counts an `openrouter`
  or `groq` model as usable whatever its package says. That anticipates the upstream fallback
  (anomalyco/opencode#45424) which this fork's vendored core does not have yet: against an engine
  without it *and* without the config override above, those models read as runnable and still fail
  to dispatch. Drop the id list from `COMPATIBLE_PROVIDERS` if that PR is rejected.
- `bun test` has **no `localStorage`** (it is a browser global). When persisting a preference
  the browser stores there — custom roles, the default-model preference (`graph/default-model.ts`),
  the walkthrough-dismissed flag — make a Solid signal the source of truth and treat
  localStorage as best-effort persistence wrapped in `try/catch`. Then signal-backed get/set
  round-trips in tests while storage silently no-ops, so no test needs a `globalThis` polyfill.
- Pre-run validation lives in `preflight(pipeline, { unlockedModels })` in `graph/validate.ts`
  (reuses `layer()` for structural checks). `run()` calls it before any session is created:
  blocking problems abort, warnings render but let the run proceed.

## Codebase tooling (graphify, context-mode)

Generic routing for both tools lives in the global `~/.claude/CLAUDE.md`. Only the
OpenFlow-specific facts belong here.

- **graphify scope is `packages/flow/src`, never `graphify .`.** The rest of the repo is a
  vendored OpenCode fork — indexing it buries the flow signal and (in the installed 0.8.45
  CLI) aborts demanding an LLM key for thousands of doc/image files. Build with `graphify
  extract packages/flow/src`. The graph lands in `packages/flow/src/graphify-out/`
  (git-ignored via `packages/flow/.gitignore`), **not** at repo root.
- **Verify the graph is the real one before trusting a query.** The live graph is
  `packages/flow/src/graphify-out/`. Any empty `graphify-out/` elsewhere (a stray root dir has
  appeared before) trips the "graph exists → query it first" rule while holding nothing —
  target the flow path explicitly.
- **context-mode captures that run tests or typecheck must `cd packages/flow` first**
  (the `do-not-run-tests-from-root` guard). Host shell is PowerShell.

## When a rule is missing

If a correction here would apply to future work, add it to this file rather than leaving it
in a session. Vague dissatisfaction is not a rule — write the rule as "when X, do Y".

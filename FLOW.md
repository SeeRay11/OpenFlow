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
- Role colors are OpenCode's five dark agent solids: planner `#f799c6`, architect `#9e99f7`,
  coder `#c3d4fd`, reviewer `#b8e9c1`, custom `#f7e5b5`.

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

## When a rule is missing

If a correction here would apply to future work, add it to this file rather than leaving it
in a session. Vague dissatisfaction is not a rule — write the rule as "when X, do Y".

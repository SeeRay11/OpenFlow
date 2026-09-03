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
- **Peers with nothing to tell them apart only warn.** The swarm briefing *orders* every agent
  to disagree explicitly, because the measured failure of round 2 is everyone restating whoever
  sounded most certain — but that assumes there is something real to disagree about. Same role,
  same model and same instructions leaves no axis, so the mandate gets satisfied the only way
  left: manufactured objections about phrasing, from cards whose errors are correlated anyway.
  `identical-peers` in `graph/validate.ts` groups peers on all three fields — a different model
  or different role instructions is a real reason to disagree, and warning about those would
  train the user to ignore the warning. It warns rather than blocks because N identical drafts
  judged by a synthesizer is best-of-N sampling, which is a real way to run a swarm — but only
  at `rounds: 1`, where no peer text is quoted and the cards cannot reject each other, which is
  why the message names that as the fix.
- **A swarm peer that can write files is warned about, and told not to.** Every peer in a round
  runs at once, in the one working directory this fork has, with no lock on anything — so two
  peers given the same task write the same file and the later one wins silently. Orchestration at
  least reports that afterwards (`graph/collisions.ts`); a swarm cannot, because its output is the
  synthesizer's *message* and the synthesizer never reads the disk — the verdict would describe a
  file the last writer replaced. `swarm-writers` in `graph/validate.ts` names every peer whose
  `edit` or `bash` is not switched **off**: an unlisted tool inherits the default agent's allow
  (`permissionBlock` writes rules only for tools the map names), so `{ read: true }` is a writer.
  The synthesizer is exempt — it runs alone, after the rounds. It warns rather than blocks because
  a peer that only *reads and runs* the repo is legitimate and the toggle cannot tell the two
  apart; the briefing carries the other half ("Do not write files"), which costs nothing. Work
  that has to land on disk belongs in orchestration, and the message says so.
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
- **A gauntlet is an orchestration that stops on a bar instead of a count.** `Pipeline.gauntlet`
  is a toggle on orchestration, not a fourth mode: same tree, same dispatch protocol, same
  scheduler. Present means on (`gauntletOf()` returns nothing for any other mode, so settings
  left in a file a user switched back cannot reach a scheduler with no critics in it). What
  changes: the dispatch budget is replaced by `GAUNTLET_DISPATCHES` and the real bounds become
  **spend, wall clock, and stall**, all three live at once, first to fire wins. Stall is
  measured out here rather than asked of the model — the same batch (same cards, same task
  text) dispatched N times running is what no progress looks like from outside. The
  **unpriced-model check comes first**: this build prices client-side, so a model the catalog
  does not quote makes the spend cap unmeasurable, and an unenforceable cap on a run designed
  to go for hours is the one failure nobody would notice until the bill arrived — it stops the
  run rather than warning.
  **Critics are opencode's own `reviewer` role**, read off the role text like a swarm reads its
  synthesizer, so designating one is renaming a card. A critic gets a **new session for every
  verdict** (`nodeSession.delete` before dispatch): a critic that has watched the work improve
  grades the improvement, not the work, which is the exact failure a separate critic exists to
  prevent. It costs the cached prefix and re-sends the reference files every round; that is the
  price of the method, not a bug to optimise away.
  **A critic that changed the work has no verdict.** Its `edit`/`write`/`patch` asks are refused
  in `answer` (and `bash` deliberately is not — refusing it was measured to break the critic's
  own verification), so what a critic can still change the tree with is a shell line, and after
  every batch the engine reads its bash calls through `writesOf`. Any write — `sed -i`, an
  install, a `git checkout` — turns the verdict into a card error naming the paths, the result
  the orchestrator reads becomes that error, and `judged` stays empty, so the run cannot end on
  it. Discarding after the fact rather than refusing the call keeps `bun test` and `bun run
  build` available; the briefing tells the critic that a tree which does not run as it was left
  is the verdict, not a blocker to clear first.
  **A critics-only batch runs one critic at a time.** Critics judge by running the work — build,
  tests, dev server — in the one working directory, so two at once race `dist/`, the port and
  `node_modules` and each grades the other's half-built output. Only a critics-only batch fills
  `judged`, so it is the one batch that must see a tree holding still; `orchestrate` drops the
  pool limit to 1 for it. A mixed batch keeps the full pool — it judges nothing anyway. The cost
  is wall clock, which `maxMinutes` already bounds, and the briefing tells the orchestrator so it
  batches critics only when each has a different part to judge.
  Two things the briefing must keep saying, both measured in the run this pattern comes from:
  the critic inspects the **real output**, never the builder's summary, and **coupled work goes
  to one builder in sequence** — fanning lighting, tone and sky out to cards that cannot see
  each other made the result worse, not better. A missing bar **warns rather than blocks**,
  because "make the orchestrator establish one first" is a real way to run this; a missing
  critic blocks in both places that must stay in step (`shapeProblems` and the `start()` throw).
  **A gauntlet cannot end on an unjudged answer.** A `final` sent while no critic has judged the
  state the builders left is refused once (`judgeFirstPrompt`); a second one **fails the card**.
  Accepting it was measured doing real harm: with every critic dispatch rate limited, an
  orchestrator nominated a *builder* as the independent inspector and wrote a PASS on all seven
  bar lines, and the engine took it. `judged` is filled only from a critics-only batch, so the
  builder's opinion never counted — the refusal policy let the answer through anyway. Both
  endings stop the burn; only one tells the truth about what the run produced, and the error
  says which case it was: `every critic dispatched failed (...)` when critics were sent and none
  came back, `answered twice without sending the work to a critic` when none was ever sent.
  **A 429 is "not now", not "this card is finished"** — `runTurn` re-sends a rate-limited turn
  into the same session three times, waiting 20s, 40s, 80s. A gauntlet pays for this more than
  any other mode: the critic gets a session it has never used before on every verdict, which is
  exactly the traffic shape a per-model limit punishes, and it is the one card the run cannot
  route around.
  **A card's spend is the sum of every session it has held.** `reconcile` merges a session's
  steps into the node's map rather than replacing it, keyed by message id so sessions add up
  without double-counting. Replacing meant a re-dispatched card's earlier spend left the run
  total — measured, a critic's own cost fell from $0.0204 to $0.0023 across a re-dispatch — so
  `maxSpend`, the headline bound of a mode built to run for hours, was compared against a number
  drifting below what had been spent.
  No vision: a critic reads source, runs builds, runs tests, hits the dev server. Visual A/B
  waits for MCP to reach v2 sessions — though a card with `bash` can drive a headless browser
  and capture the artifact itself, which is how the runtime lines of a bar have actually been
  judged here.
- **An interrupted run is picked up, not started again.** The engine runs *in the page*, so a
  reload, a crash or a closed tab ends a run with nothing alive to write `done`, `error` or
  `stopped` — while the sessions are still on the server and still addressable. `RunOptions.sessions`
  maps a node id to the session it was working in and is seeded before anything dispatches, so
  the card's first turn is prompted into that session; `interruptedNote()` tells it once, on
  that turn only, that the run around it stopped and nothing it produced was discarded, because
  a card given no account of the silence re-answers what it already answered. A card in both
  `resume` and `sessions` keeps its output and never runs — reopening a finished card only
  bills. The UI finds the case itself: a run still marked `running` on disk for this canvas,
  with nothing live, is one the page abandoned. **The carried session id must be written to the
  run log** (`patch(node.id, { sessionID })`), because the create path that normally writes it
  is skipped — without it a resumed run reports cards with no session while they answer in one,
  and the *next* interruption has nothing left to carry.
- **No MCP tool can reach a card in this fork, so the dispatch tool is parked.** Proven
  2026-08-29, after it looked like a config bug for a long time. OpenFlow drives
  `client.v2.session.*`, so a card runs through the v2 session runner, and that runner has
  never been wired to MCP — its own spec comment says so, unticked, at
  `packages/core/src/session/runner/llm.ts`: *"[ ] Resolve policy-filtered built-in, MCP,
  plugin, and structured-output tool definitions."* MCP tools are converted and registered in
  exactly one place, the **v1** session path (`packages/opencode/src/session/tools.ts`), which
  OpenFlow does not use. The v2 registry (`packages/core/src/tool/`) holds read, grep, glob,
  bash, edit, write, question, skill, todowrite, webfetch, websearch, apply-patch — and
  nothing puts MCP beside them, so any `<server>_<tool>` comes back `Unknown tool` from
  `core/src/tool/registry.ts` however the config is written.
  **`GET /mcp` answering `connected` is the trap**: the MCP *service* spawns the process and
  completes the handshake perfectly well: it just never contributes a tool definition to a v2
  session. Do not read that status as "the tool works". Fixing this here is not an option —
  it means editing `packages/core`. It needs an upstream change, or a fork that stops being
  fork-clean.
  `MCP_REACHES_SESSIONS` in `graph/dispatch.ts` is the single switch: `false` parks the
  channel (the engine skips the history scan, the runbar hides the install banner, and the
  orchestrator briefing teaches only the fenced block). Flipping it to `true` is the whole of
  turning it back on. **Do not name the tools in a prompt while it is parked** — measured, the
  card calls one, is told `Unknown tool`, and only then writes the block, which costs a paid
  turn on every single run.
- **The tool channel itself is built, tested, and correct** — `mcp/dispatch.ts` (a hand-rolled
  stdio MCP server; no dependency, since `bun.lock` gains only the workspace entry),
  `fromToolCall`, `sessionCalls`, and `lib/dispatch-tool.ts` writing the **global** config.
  Keep these working. The reason it is a tool at all is measured: a text-only protocol lost
  three ways — a model sent the JSON with no fence, a model emitted the block and then kept
  calling tools so the block was no longer in the message read, and a strong model tried to
  *call* `dispatch` because that is what the schema in front of it looks like.
  Two traps worth keeping, both found by running it: the call is read from the **message
  history**, and that scan must **not** be bounded at the newest user message — a tool
  *result* comes back as a user-type message, so the scan would stop before reaching the call
  that produced it; consumed call ids are what separate this turn from the last. And the MCP
  command must be an **absolute path to bun**, never the bare word, because opencode spawns a
  local MCP server without a shell and Windows does not apply PATHEXT; `process.execPath` is
  not enough either, since the vite dev host runs under node, so `bunPath()` searches PATH.
- **The orchestrator also speaks a fenced ` ```openflow ` block** — `{dispatch:[{card,task}]}`
  or `{final}` — parsed by `graph/dispatch.ts`. The **last** block wins, because a model often
  quotes the protocol before using it. A malformed block is handed back **once** with the exact
  reason; a second failure fails the card, since every ask is a paid turn. A card id outside the
  orchestrator's own children is refused, and so is the same card twice in one batch — one card
  is one session, and two assignments would race it. An assignment may carry `files`, the paths
  the orchestrator expects that card to write; two assignments in one batch declaring the same
  path (compared through `normalizePath`, so spelling does not hide one) are refused the same
  way, **before** the batch runs — the one moment a collision is free to fix, where the
  after-the-fact note in `graph/collisions.ts` can only report the loss. It is optional because
  most assignments write nothing and a mandatory field is filled with guesses; an undeclared
  overlap still surfaces through the post-batch check.
- **A card that ignores its spent budget is stopped, not re-asked.** When the budget runs out
  the orchestrator gets one forced-answer turn; if it dispatches anyway the node fails. Without
  that check the loop never ends. A leaf goes through `runSubagent` and is never shown the
  protocol; a subtree orchestrator gets `subOrchestratorPrompt` (orchestrator briefing *and* an
  assignment), because briefing it as a leaf and then parsing it for a control block is a
  guaranteed failure. A re-dispatched card is prompted into its existing session with
  `reassignPrompt`, which says the old assignment is over — otherwise it reads the new task as
  more detail on the old one. After an orchestration run, cards nobody dispatched are marked
  `skipped`, not left `queued`.
- **Two cards in one batch writing one file is reported, not prevented.** Nothing in this fork
  locks a file and the pool runs a batch at once, so the later write wins and the card whose work
  went under still reports success — the orchestrator would then build on an answer describing a
  file that no longer says that. `graph/collisions.ts` reads each dispatched card's writes off
  the tool calls the activity stream already keeps (`write`, `edit`, `apply_patch`; a failed call
  is not a write), attributes a subtree's writes to the card that was **dispatched** rather than
  the leaf that held the pen, and `collisionNote` tells the orchestrator before it decides
  anything. It reports rather than reverts: the engine cannot know which of the two writes was
  the one worth keeping, and a card told to undo the right half spends a round making the work
  worse. Scope is **one batch** — the same file across two batches is ordinary iteration, and the
  orchestrator ordered those itself. `bash` is read as far as a shell line can honestly be read
  and no further: `shellWrites` knows redirects, `tee`, `sed -i`, `mv`/`cp` destinations, `rm`,
  `touch`, package installs (`package.json` + `node_modules`) and the git commands that rewrite
  the working tree (`checkout`, `stash`, `reset`, ... recorded as `TREE`, which collides with
  every file any other card wrote). Everything it returns is marked **probable** — `cat > a.ts`
  and `cat > "$OUT"` look alike to it — and the note says which cards are there on a guess. What
  it cannot read (a build script, a program writing on its own account, a heredoc into an
  interpreter, a path relative to an earlier `cd`) is simply absent, which is why the note still
  calls the list a floor on a shell-capable card. Do not grow the parser toward a real shell:
  every construct it half-understands is a collision it reports wrongly in both directions. The
  prevention half is a briefing line — one file, one card — and the optional `files` declaration
  on a dispatch, because a batch that never overlaps costs nothing to fix.
- Cost is the standing hazard of both new modes. A swarm is `agents × rounds + 1` sessions; an
  orchestration is `1 + Σ(children × dispatches)` per level, and preflight warns with the actual
  number past a dozen. `MAX_ROUNDS`, `MAX_DEPTH` and `MAX_DISPATCHES` exist for that reason and
  `roundsOf()` / `depthOf()` / `dispatchesOf()` clamp, so a hand-edited file cannot talk the
  engine into an unbounded run.
- **An orchestration batch gets a working copy per card, when the canvas asks for it.**
  `Pipeline.isolate` is a toggle on orchestration, read through `isolationOf` — a property of the
  *document*, like `mode` and `gauntlet`, because it changes where an existing graph's writes
  land, so it is persisted, exported and undoable. **Absent means off**, which is every canvas
  saved before it existed: turning somebody's cards loose in separate trees is not a change to
  make because they upgraded. The flag survives a mode switch so switching back does not lose
  it, and does nothing while the canvas is not an orchestration.
  This is the prevention half of the rule above, and it is reachable because a session created
  with `location: { directory }` runs its tools *there* — measured 2026-09-03, against the
  older note in "Hazard: test runs write real files", which is about config resolution rather
  than cwd. `lib/worktree.ts` opens one `git worktree` per dispatched card that can write,
  branched from `git stash create` so the user's **uncommitted** work is in it — `HEAD` would
  hand every card a tree unlike the one on screen. Trees live in the OS temp dir, never inside
  the repo, and `node_modules` is linked in, because a critic that cannot run the tests judges
  nothing; that link is a real hole in the isolation and the reason installs still collide.
  Merging back is `git apply`, not `git merge`: the project's tree is usually dirty and merge
  refuses to run over that. Every apply is **`--check` first** — `--3way` resolves more, but
  when it fails it writes conflict markers into a file the user may have open and leaves it
  staged, turning a report into damage. So a patch that will not apply changes nothing, and
  the path is left alone and named. The whole diff is tried before the per-file retry, so one
  bad path does not cost a card its eleven good ones. What conflicts reaches the orchestrator
  through `mergeNote`, which must keep saying three things it otherwise infers wrongly: the
  file on disk is whichever card merged **first**, the losing card's *other* files did land,
  and re-dispatching the same task verbatim will conflict identically.
  Only cards that can write are isolated, and only batches of more than one — a lone card
  cannot collide with itself and a checkout is wall clock a gauntlet pays every round. A card
  keeps its tree for the whole run because a session's location is fixed at creation, so a
  re-dispatch opens nothing; it must still **merge**, or cleanup would delete that work.
  Cleanup runs in `finally`, since an aborted run leaves the most trees behind.
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
it is hidden. `file://` also fails. Worse than either, **`computer{action:"left_click"}` can
report success and do nothing** — measured on the Run button, twice, with no console error,
while `button.click()` through `javascript_tool` started the run immediately. A silent Run
button reads as "preflight blocked it", so the next twenty minutes go into the wrong place;
drive controls through `javascript_tool` and confirm the state changed rather than trusting
the click's result. Verify via `read_page` and `javascript_tool` computed styles instead.
Working headless techniques:

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

**That is about config, not about cwd — corrected 2026-09-03.** `session.create` takes
`location: { directory }`, and a session created with one **runs its tools there**: a card
given a `git worktree` path ran `bash` in that worktree, not in `packages/opencode`. So the
paragraph above still holds for *which config a drain reads* — that is resolved from the
engine's own cwd — but it is not true that a session's working directory cannot be steered.
Per-card isolation is built on exactly that (see below).

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

## Selection is a list, and the canvas gestures follow from that

- **`state.selection` is an ordered list of card ids; the last one is the primary.** There is
  no `state.selected` any more. The inspector shows the primary card's values — with several
  selected somebody's have to be shown, and the last card pointed at is the one the user was
  looking at — and every field edit fans out over the whole list through
  `updateSelected` / `updateSelectedAgent` / `toggleSelectedTool`. Renaming a multi-selection
  renames every card in it, which in swarm mode is how the synthesizer is designated: role text
  is the flag, so a bulk rename can take the decider with it.
- **Left drag on the canvas draws the marquee, so panning is the middle button or Alt+left.**
  A rectangle and a pan are the same gesture and one had to give the plain drag up; the
  rectangle is the one a card can be caught by. The `.canvas` cursor is `default` rather than
  `grab` for the same reason.
- **The marquee hit-tests client rects off the DOM, not positions.** A card's height depends on
  what it is showing (activity, error, output preview), and a client rect is already in the
  zoomed, panned frame the box is drawn in. That is what `data-node-id` on `.node` is for, and
  why `.marquee` is `position: fixed` outside the viewport transform.
- **A press on a card that is already selected does not collapse the selection**, or dragging a
  group by one of its cards would drop the rest before the drag started. Dragging any selected
  card moves the whole selection; Ctrl/Cmd toggles one card, Shift takes `pathThrough` — the
  chain that feeds the card plus everything it feeds, deliberately not the weakly connected
  component, since a sibling branch off a shared parent is not on this card's path.
- **Deleting a selection is one snapshot, not one per card.** Four cards deleted was one action
  to the user, and four undos to get them back would also empty the bounded history of
  everything before it.

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

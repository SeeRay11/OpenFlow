# FLOW.md — working rules for OpenFlow

OpenFlow is a node-based visual builder for multi-agent workflows. It lives entirely in
`packages/flow`. Everything else in this repo is a vendored fork of OpenCode.

`AGENTS.md` (upstream) still governs code style, branch names, commit format, and the
general testing/typecheck rules. This file covers what is specific to OpenFlow and is not
derivable from the code.

## The one hard constraint

**Do not modify any upstream package.** Fork merges must stay clean. Fork-owned surfaces
are `packages/flow`, the root launchers (`openflow.ts`, `openflow.sh`, `openflow.ps1`),
`.claude/launch.json`, the shipped templates in `.openflow/pipelines`, `.github` (only its
`workflows/openflow.yml` is the fork's; the rest is upstream CI and stays as it is), the LICENSE
attribution line, and this file. `bun.lock` gains only the workspace entry. From `packages/flow`,
`bun run check:no-opencode` fails when a fork-owned surface still mentions the removed engine;
`scripts/check-no-opencode.ts` lists the few paths allowed to (history, migration code and
fixtures, upstream CI).

Corollary: **do not scrub the hundreds of `opencode` string references** in the upstream
README, docs, source, `sst.config.ts`, or `infra`. They are intentional. Scrubbing them
fights the no-upstream-modification design.

Read `packages/flow/README.md` before touching the code — routes, run instructions,
file layout, and login/model behavior are documented there rather than re-derived.

## Architecture, settled

- **One card = one omp session = one `omp --mode rpc-ui` process.** `src/server/engine.ts` per
  node: `createSession({card, model, …})` → `prompt` → `waitForIdle` → `transcript`, each a call
  to the host's `/flow/api/engine/*` routes (see "Omp engine" below). The engine itself runs in
  the page. Nodes run in topological layers via a parallel pool.
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
  **Critics are the `reviewer` role**, read off the role text like a swarm reads its
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
  route around. **A 502, a dropped socket and a `fetch failed` say the same thing**, and
  `transient()` retries them on a budget of their own — separate from the rate-limit budget, so
  a card being throttled and a card whose connection keeps dropping do not spend each other's.
  The terminal list stays narrow on purpose: a 401, a 404 from a model id that does not exist,
  an `UnsupportedApiError` — re-sending those buys three waits and the identical error. The
  engine's **own** refusals are never transient, because they are conclusions rather than
  transport. And a **lost session is replaced, not re-sent into** (`sessionLost`): every turn
  prompted into a handle the server has forgotten fails identically, so the id is dropped, a new
  session is opened on the next attempt, and only the model's memory of the turn is lost — a
  card's prompt is rebuilt from the graph, never from the session.
  **A card's spend is the sum of every session it has held.** `reconcile` merges a session's
  steps into the node's map rather than replacing it, keyed by message id so sessions add up
  without double-counting. Replacing meant a re-dispatched card's earlier spend left the run
  total — measured, a critic's own cost fell from $0.0204 to $0.0023 across a re-dispatch — so
  `maxSpend`, the headline bound of a mode built to run for hours, was compared against a number
  drifting below what had been spent.
  No vision: a critic reads source, runs builds, runs tests, hits the dev server. Visual A/B
  has no built-in tool — though a card with `bash` can drive a headless browser
  and capture the artifact itself, which is how the runtime lines of a bar have actually been
  judged here.
- **A run that nobody is watching says when it ended.** Every mode here is meant to be left
  alone — a gauntlet is bounded in hours and spend rather than turns — and the ending that most
  needs reporting (a card failed, a cap fired) is exactly the one the canvas cannot report to
  somebody who walked away. `src/alerts.ts` sends it on two channels, **both off by default and
  both the user's own decision**, because an ending posted to a URL is data leaving the machine.
  The desktop notification is **skipped while the page has focus** — watching the canvas is
  already being told — and the webhook fires either way, since whoever reads it is not the person
  in front of this tab. Permission is asked from the click that switches alerts on (a prompt
  needs a gesture); a browser that refuses does **not** switch the setting back off, because the
  webhook works without any permission and a user who just denied notifications wants it more,
  not less. A bad webhook URL is named in the dialog rather than dropped silently: believing you
  have alerts and having none is worse than having none. `announce()` never throws and is never
  awaited into the run's own result — failing to report an ending must not be what turns a
  finished run into a failed one. The preference is signal-backed with localStorage best-effort,
  the same shape as `graph/default-model.ts`, so `bun test` needs no storage polyfill.
- **An interrupted run is picked up, not started again.** The engine runs *in the page*, so a
  reload, a crash or a closed tab ends a run with nothing alive to write `done`, `error` or
  `stopped` — while the sessions are still held by the host and still addressable. `RunOptions.sessions`
  maps a node id to the session it was working in and is seeded before anything dispatches, so
  the card's first turn is prompted into that session; `interruptedNote()` tells it once, on
  that turn only, that the run around it stopped and nothing it produced was discarded, because
  a card given no account of the silence re-answers what it already answered. A card in both
  `resume` and `sessions` keeps its output and never runs — reopening a finished card only
  bills. The UI finds the case itself: the newest `running` log for the pipeline whose `updatedAt`
  is older than `RESUME_STALE_MS` (5 min) is one the page abandoned (`abandoned()` in
  `src/server/runs.ts`; the offer re-evaluates on a 30 s tick, `RESUME_CLOCK_INTERVAL`). Every
  run-log write stamps `updatedAt` and a 30 s heartbeat
  (`DEFAULT_HEARTBEAT_EVERY`) keeps it moving, so a run another tab is writing is never offered; a
  failing save raises the "run log not saved" notice once and re-arms after a save succeeds
  (`saveFailing`), not every 30 s. The tick (and the tab becoming visible) re-reads the run list, only
  while idle with no folder picker open and the tab visible, and `offerable()` never offers Resume from
  a list older than the 5-minute window (`runsReadAt`). A resumed run writes its OWN log first
  (carrying the session ids, before the model-catalog wait). It writes the old log `stopped` with
  `resumedBy` (`superseded()`) and releases the sessions in `spare` ONLY after the model check passes
  ("Past the point where this run could end before it began"); an unknown model (e.g. a partial
  catalog after a host restart) ends the new run at once, hands the carried sessions back untouched
  (`held.delete`) and leaves the old run resumable. If the first write fails the interrupted log stays
  resumable and `closeLater` makes the first later write that works close it. The replacement
  already holds the finished cards' outputs (`done`, `reused`) and the carried
  ids when first saved, orchestrated runs too. Carried ids for cards no longer in the pipeline, and
  sessions of cards that already finished, go to `spare` and are released after that check (they would hold
  the project lock); a carried session the host reports lost starts as a FRESH card (`build = opening`,
  no `interruptedNote` wrapper). The Resume button is disabled from the click until the run started
  (`resuming`). **The carried session id must be written to the
  run log** (`patch(node.id, { sessionID })`), because the create path that normally writes it
  is skipped — without it a resumed run reports cards with no session while they answer in one,
  and the *next* interruption has nothing left to carry. A card is briefed only once the host accepted
  the prompt that carried its briefing (`briefed` is set after `api.prompt`; `holding()`): a fresh card
  whose first prompt is refused through every retry and is re-dispatched gets the full briefing (orchestrator
  roster and rules, critic bar) and the run attachments again, and `toldScratch` follows the same rule; the
  scratch note is re-sent to a replacement session (`abandon()` clears both, as does a lost session).
  Only a carried session replaced after the host reports it lost switches to `build = opening`.
- **Resume never merges, removes or releases the interrupted run's isolated worktrees.** Merging
  them is the user's call, because git state in a worktree cannot be assumed. `RunLog.isolation` (`{ trees:
  [{ card, directory, branch }] }`; informational, no `base`, absent on old logs; an old log's `base` is
  tolerated and ignored) lists the worktrees the run opened that are not cleaned up yet. `save()` writes it
  from `[...abandoned, ...opened.values()]`; it is saved with `await` right after the trees open, before
  any card runs in them; the end-of-run cleanup clears it unless the cleanup request itself was rejected
  (`cleanupWorktrees` swallows git failures, so a clean answer clears them). `resumeRun` passes the
  interrupted log's `isolation` as `RunOptions.abandoned = { trees }` (no run id). After the
  replacement log is saved, the new log's `isolation` is seeded with the
  abandoned trees and ONE error notice (`abandonedNote` in `src/graph/worktree.ts`) says they **may**
  hold work not merged into the project: at most 20 listed plus the true count of the rest, every path
  double-quoted in `git -C "<dir>" status` and `git -C "<dir>" diff`; the user checks, merges or
  discards. (Trees of batches already merged stay listed until the run ends, hence "may".) A carried
  card that had a tree gets `movedNote` in its resumed first prompt: the working directory is now the
  project folder, edits it made before the interruption **may** still be only in the old copy (path
  named only when it has no space, else "the old isolated copy named in the notice"), it checks the
  project files before relying on them, redoes any that are missing there, and does not edit the old
  copy. **Run logs are untrusted input** — read back from a file in the project, with the same trust
  model as the pipelines in it (no provenance check; a repository you open can already define
  prompts). `loggedTrees` ignores `isolation` entries whose `directory` is not a plain absolute path
  (`SAFE_DIRECTORY`: posix `/…` or `X:\…`, only `[A-Za-z0-9 _.@+:~\\/-]`, at most 200 characters) or
  whose `branch` is not `SAFE_BRANCH` (`openflow/[A-Za-z0-9_./-]+`), keeps at most 50 entries, and
  flattens control and invisible/format characters (U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF)
  via `plainText`; the app refuses a log whose own `id` differs from the id it was opened under
  (case-insensitive, list ids are lower-cased file names), uses a saved `output` only if it is a string
  of at most `MAX_RESUMED_OUTPUT` (1,000,000) characters, carries a `sessionID` only if it is a
  non-empty string of at most 200 characters without control characters, and refuses a log without a
  `nodes` array. `abandoned()` / `interrupted()` in `src/server/runs.ts`: a log whose `updatedAt` or
  `started` is more than `CLOCK_SKEW_MS` (5 min) in the future is `implausible()`, counts as
  abandoned, and sorts below every plausible log (still offered when it is the only one).
  `lib/worktree.ts`: a tree directory that no longer holds a worktree (including one recreated
  empty) is skipped and reported as `empty` (the `.git`-entry guard keeps `git add -A` from running in a
  parent repository), one failing tree never stops the others, and `cleanupWorktrees` is safe for a
  tree that is already gone; the engine does not call merge or cleanup at resume.
- **The orchestrator's decision is a tool call first and a fenced block second.** The host
  registers `openflow_dispatch` and `openflow_finish` as omp RPC host tools for a card that
  orchestrates (`lib/omp/host-tools.ts`, `CardSpec.dispatch`). They execute nothing: the engine
  reads the calls back through `EngineApi.sessionCalls` (`GET …/sessions/:id/calls`, newest
  first), and `fromToolCall` in `graph/dispatch.ts` turns one into the same assignments the
  fenced block would give, so the two channels cannot disagree about what a valid dispatch is.
  `MCP_REACHES_SESSIONS` in `graph/dispatch.ts` is the single switch the briefing, the engine and
  the runbar read; it is `true`. Its name is from the era when the channel was an MCP server — it
  now means "the host answers the dispatch tools", not "MCP servers reach cards". The tool names
  are `DISPATCH_TOOL` / `FINISH_TOOL`, and `lib/omp/host-tools.test.ts` asserts the host registers
  the same two; `lib/` does not import from `src/`, which is why the names are duplicated.
- **Why it is a tool at all** — measured: a text-only protocol lost three ways. A model sent the
  JSON with no fence, a model emitted the block and then kept calling tools so the block was no
  longer in the message read, and a strong model tried to *call* `dispatch` because that is what
  the schema in front of it looks like. One trap worth keeping: the engine remembers which call
  ids it has consumed, per card (`consumed` in `engine.ts`) — that is what separates this turn's
  call from the last turn's, and without it an old call is re-read as a fresh decision.
- **The orchestrator also speaks a fenced ` ```openflow ` block** — `{dispatch:[{card,task}]}`
  or `{final}` — parsed by `graph/dispatch.ts`. The **last** block wins, because a model often
  quotes the protocol before using it. A malformed block is handed back with the exact reason,
  up to `PROTOCOL_RETRIES` (3) times, and then fails the card, since every ask is a paid turn. A card id outside the
  orchestrator's own children is refused, and so is the same card twice in one batch — one card
  is one session, and two assignments would race it. An assignment may carry `files`, the paths
  the orchestrator expects that card to write; two assignments in one batch declaring the same
  path (compared through `normalizePath`, so spelling does not hide one) are refused the same
  way, **before** the batch runs — the one moment a collision is free to fix, where the
  after-the-fact note in `graph/collisions.ts` can only report the loss. It is optional because
  most assignments write nothing and a mandatory field is filled with guesses; an undeclared
  overlap still surfaces through the post-batch check.
- **A verified run ends on a critic's verdict, in any mode.** `Pipeline.verify` is a document
  property like `mode`, `gauntlet` and `isolate` — absent means off, so no canvas saved before it
  existed starts spending a session it did not ask for — read through `verifyOf`, and it carries
  only an optional `bar`. There is no verifier id in it: the critic is picked by **role text**, the
  way a swarm picks its synthesizer and a gauntlet picks its critics, so designating one is
  renaming a card and a stored id cannot drift out of step with the canvas. `verifyRun()` runs
  after the scheduler and knows nothing about which one ran — only what the run produced, which is
  the cards nothing reads: a pipeline's terminal layer, a swarm's synthesizer, an orchestration's
  root. It is skipped when a card already failed, because that run has already told the truth about
  itself and a verdict confirming it is the one nobody needs.
  Three rules are carried over from the gauntlet, each because dropping it was measured to break
  the method there: a **new session** per verdict (in a pipeline the reviewer card has usually just
  run, and a critic that watched the work appear grades the appearing), **one critic at a time**
  (judging means running the build in the one working directory this fork has), and **inspect the
  real output, never the summary** — the run's answer is shown to the verifier as a *claim*, and
  the briefing says so twice. The first card to withhold a pass ends the pass; paying the rest to
  agree changes nothing.
  A verdict is one marker line, `VERDICT: PASS` or `VERDICT: FAIL`, parsed by `graph/verdict.ts`,
  **not** the ` ```openflow ` block: that block is a control instruction with a schema, taught over
  paragraphs to a card whose job is dispatching, and asking a critic writing prose for JSON buys a
  parse failure on the one turn that matters. Last marker wins, for the same reason the last
  dispatch block does. A message with **no** marker is `unreadable`, which fails the run — a
  glowing review with no line is an unanswered question, and reading it as a pass would rebuild the
  bug verification exists to kill. It is re-asked once for the line alone first, since the critic
  has already done the looking. The card's own answer is **put back** afterwards and the verdict
  goes on `RunLog.verdict`: in a pipeline the reviewer's message was read by the cards downstream
  during the run, and the log is the only record of what they were given. A gauntlet ignores the
  setting entirely (`verifyOf` returns nothing) and preflight says so, because its loop already
  cannot finish without a verdict and a second opinion there would have no owner.
- **A card is `done` when its session goes idle, so what it did is checked separately.** Idle is
  all "finished" has ever meant here — the host's `POST /flow/api/engine/sessions/:id/wait`
  long-polls until omp reports the session settled (`WaitResult`; `aborted` is never success) — and a model
  that replies "I'll start on that" and calls nothing satisfies it in one turn. Two checks stand
  between that and `done`, both in `runTurn` so every mode gets them. **No text and no writes
  fails the card**: there is nothing to pass downstream and nothing to have built, and a blank
  input makes the next card answer about nothing. An orchestrator is exempt — a turn that ended on
  a tool call and said nothing is normal for one, and `parseDispatch` has a re-ask written for
  exactly it, so failing here would take a run down over a turn that only needed the block; no
  other card has anything that can re-ask it. **No writes from a card that was expected to write**
  appends `noWritesNote` to its own answer, because the orchestrator reads the output and nothing
  else. Expected means the dispatch declared `files` (the orchestrator's own claim, and the engine's
  only expectation that did not come from a default) or `edit === true` — the box the user ticked,
  deliberately *not* `swarm-writers`' reading, where an unlisted tool counts as allowed: right for a
  hazard warning, useless as intent, since it makes almost every card a writer and a note on almost
  every card is a note nobody reads. Swarm peers and gauntlet critics are exempt, both being cards
  told not to write. It notes rather than fails because a card given `edit` that finds nothing to
  change is legitimate and no signal separates it from one describing work it never did. A card
  that wrote but said nothing answers with `silentWriterNote` — the paths it touched — rather than
  a blank.
- **An orchestrator cannot answer for a run it dispatched nothing into.** A `final` from a card
  with children and `spent === 0` is refused once with `dispatchFirstPrompt`; a second one fails
  the card. Until 2026-09-03 it was accepted, and it is the cheapest way a run has to look
  finished while nothing happened: every card the user drew marked `skipped`, one model's turn as
  the output, the canvas green in seconds. Nothing about that reads as a failure, which is why it
  was reported from outside the project rather than caught by a check inside it. The gauntlet's
  `unjudged()` refusal is the same rule one level narrower — nobody *qualified* judged, rather
  than nobody worked — and it is tested first, because "send the work to a critic" is more useful
  than "dispatch somebody" to a card that has both problems. The second answer fails rather than
  being accepted for the reason the gauntlet learned in its own case: an answer let through on the
  second ask goes into the log indistinguishable from a real run's, and reporting success is the
  entire cost of this bug. A card with no children never reaches the check — it is not an
  orchestrator, and blocking it would deadlock the level above.
- **A verdict reached without running anything says so.** Measured on this fork's first gauntlet:
  with the deliverable a black screen and every script failing to parse, the critic opened *"the
  bar is better — the single largest gap is the ground plane position"*. It had read the source
  and critiqued what it read, which is all a card without eyes can do unless it runs something.
  The engine cannot supply the eyes and has no idea how an arbitrary project boots, so it does
  not guess: what it can see is whether the critic made **any** `bash` call in its turn, and
  `unverifiedNote()` tells the orchestrator when it did not. A note rather than a failure, for
  the same reason `noWritesNote` is one — a critic reviewing prose or a diff has nothing to run.
- **A card that can run a shell is given somewhere to put what is not the work.** The write
  refusal is **soft**: it stops the write tools, not the shell, and a redirect writes a file —
  measured, a file named `0` holding an orchestrator's grep output was left sitting in the
  deliverable. Refusing `bash` was already tried and broke the critic's own verification, so
  instead `lib/scratch.ts` makes a directory per run outside the project and every shell-capable
  card is told about it **once**, on the turn that opens its session. It cannot be enforced and
  does not pretend to be: what it removes is the *reason* to redirect into the project, since a
  card investigating something has to put the output somewhere and the only somewhere it had
  been given was the folder holding the deliverable. Deleted with the run's recording, alongside
  its checkpoints. **A write into it is never "the critic changed the work"**: `exceptUnder` drops
  it before the discard check, because discarding a verdict for obeying the briefing was measured
  on the first live run. A Windows path in an unquoted shell line arrives with its backslashes
  eaten, which is why that spelling is matched on the flattened prefix.
- **A card that ignores its spent budget is stopped, not re-asked.** When the budget runs out
  the orchestrator gets one forced-answer turn; if it dispatches anyway the node fails. Without
  that check the loop never ends. A leaf goes through `runSubagent` and is never shown the
  protocol; a subtree orchestrator gets `subOrchestratorPrompt` (orchestrator briefing *and* an
  assignment), because briefing it as a leaf and then parsing it for a control block is a
  guaranteed failure. A re-dispatched card is prompted into its existing session with
  `reassignPrompt`, which says the old assignment is over — otherwise it reads the new task as
  more detail on the old one. After an orchestration run, cards nobody dispatched are marked
  `skipped`, not left `queued`.
- **Every round is committed, and nothing is restored automatically.** `lib/checkpoint.ts`
  commits the working tree after each dispatch batch under `refs/openflow/<run>/round-<n>`, and
  the ref lands on the round in the ledger. A gauntlet ends on whatever round a bound stopped it
  in, and that round is not reliably its best — a builder given one more turn than the work
  needed will use it, and the critic that would have caught that is the card the run stopped
  short of asking. `RunLog.best` names the **last round a critic passed**; nothing weaker
  qualifies, because a round nobody judged has not been judged and preferring "more lines" or
  "fewer failures" would be the engine inventing a bar when a bar exists and a card was paid to
  apply it. The UI says so only when the run did not end on that round, and says it as the `git
  restore --source <ref> --worktree .` the user can run.
  **The commit is built through a temporary index** (`GIT_INDEX_FILE` + `add -A` + `write-tree`
  + `commit-tree`), not `git stash create`: stash omits untracked files, and new files are most
  of what a builder produces, so a checkpoint missing them would restore the edits without the
  new modules. The user's index, `HEAD` and working tree are untouched — the only visible change
  is the new ref. **Restoring is deliberately not automatic**: the project's tree is usually
  dirty and often open in an editor, and an engine that rewrites it because a number moved is a
  worse failure than the one it is fixing — the same rule the merge path follows in refusing
  `--3way`. Checkpoints are dropped when the **run's recording is deleted or pruned**, never
  when the run ends: outliving the run is the whole point of taking one.
- **A round is recorded, and the record is what "no progress" is measured against.**
  `graph/ledger.ts` writes one `LedgerRound` per dispatch batch — the cards, whether each came
  back, a critic's verdict, the lines the batch moved, the files two cards both wrote — onto
  `RunLog.rounds`, and `ledgerNote` rides the next dispatch prompt. It exists because two
  failures shared one cause: an orchestrator re-dispatching an approach a critic already
  rejected (the cards' answers are in the prompt; the *outcome* of the round was not), and a
  stall check that compared consecutive batches as **strings**, so a task reworded by one word
  read as fresh work and a run could hand out the same job for as long as it kept renaming it.
  **So progress is never read off the task text.** `progressed()` consults only evidence outside
  the model's control: the tree moved (lines in either direction), a different set of cards ran,
  a card that was failing came back or one that was working stopped, or a verdict changed —
  including a critic judging for the first time. `exhausted()` now takes `stalledRounds()` in
  place of the string counter, and a round of pure investigation counts as no progress on
  purpose: three of those in a row is a run going in circles, and the orchestrator is asked to
  answer rather than killed, so a card with something to say still says it.
  The note is **facts and no instruction** — the engine does not know which approach was right,
  and "do not try X again" is wrong the moment X was rejected for a reason since fixed. Six
  rounds are shown and older ones counted, because this is paid for in every prompt. Only a
  **critic's** answer is read as a verdict; every card's first line is a status report, and
  quoting a builder's would put an opinion in the ledger nobody asked for. Line counts are the
  card's total *less what it had before the batch* — a card dispatched three times would
  otherwise report its whole history as the work of every round it appeared in.
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
- **What a card changed is measured off git, never asked of the card.** `RunNodeLog.diff` is
  lines added and removed, and it exists because prose is the one thing a card can always
  produce whether or not it did the work — the same failure `runTurn`'s wrote-nothing checks
  answer from the other side. `lib/diffstat.ts` reads the tree (`git diff --numstat HEAD`, plus
  untracked files counted line by line, since a new source file is in no diff at all);
  `graph/diff.ts` holds the pure arithmetic, which is why `deltaOf` lives there and not beside
  the git calls — the engine runs in the browser and cannot import `lib`.
  **The measurement boundary is a batch, never a card.** Cards in a layer, a round or a dispatch
  batch run at once in one working directory, so the only moment the tree can be read and mean
  anything is a boundary where nothing is running; `measured()` in `engine.ts` wraps all three
  schedulers through one `around` hook. Splitting that delta back out per card reuses the
  collision check's own file lists: a file exactly one card wrote is that card's, exactly. A file
  two cards wrote is **neither** card's — reported on both with `shared` naming the other,
  because a figure labelled as the pair's is worth having and silently handing all of it to one
  of them is the invention this measurement exists to avoid. A file nobody claimed (build output,
  a program writing on its own account) is left off every card rather than given to whoever
  happened to be running.
  An **isolated** card is the one case needing no attribution at all: it had a tree to itself, so
  `MergeReport.stats` counts its own branch against the shared base — taken **before** the apply,
  since a card whose every path conflicts still did the work. Those cards are skipped by the
  snapshot path, or the merge's own writes would be credited to whoever shared the tree with it.
  **Absent means unmeasured, and must never render as zero** — a project that is not a
  repository, a host with no route, a run recorded before this existed. Same rule as an unpriced
  model, and `diffLabel` renders `±0` only for a real measurement that came back empty.
- Cost is the standing hazard of both new modes. A swarm is `agents × rounds + 1` sessions; an
  orchestration is `1 + Σ(children × dispatches)` per level, and preflight warns with the actual
  number past a dozen. `MAX_ROUNDS`, `MAX_DEPTH` and `MAX_DISPATCHES` exist for that reason and
  `roundsOf()` / `depthOf()` / `dispatchesOf()` clamp, so a hand-edited file cannot talk the
  engine into an unbounded run.
- **A router in a dispatching seat is warned about, and only there.** `routed-orchestrator` in
  `graph/validate.ts` fires on any card with children whose model is `openrouter/auto`,
  `openrouter/free`, or a `:free` variant. Measured on the `orchestrated build` template with
  every card free-routed: the orchestrator called a tool named `openflow` (`Unknown tool` — MCP
  reaches no card here), ended its turn on that call so there was no message and no control
  block, was re-asked, then answered `final` with the whole deliverable inline; its three
  subagents never ran and reported `skipped`, which is the only part the user sees. Every other
  seat can be weak and still be useful — this one emits a schema every turn, and a router means
  "which model failed the protocol" is not knowable afterwards. It is a fixed list, not a
  cheap-model heuristic: a small model the user picked by name is their decision, and warning
  about that would train them to ignore the warning. It warns rather than blocks because trying
  the canvas out on a free router is legitimate. Two corollaries when one of these runs fails:
  **the orchestrator's own account of it is not evidence** (this one reported being "confused
  with agent ids and names" — no card id was ever rejected, and the one dispatch it did emit was
  accepted), and the run log's `events` are, in `<project>/.openflow/runs/`.
- **An orchestration batch gets a working copy per card, when the canvas asks for it.**
  `Pipeline.isolate` is a toggle on orchestration, read through `isolationOf` — a property of the
  *document*, like `mode` and `gauntlet`, because it changes where an existing graph's writes
  land, so it is persisted, exported and undoable. **Absent means off**, which is every canvas
  saved before it existed: turning somebody's cards loose in separate trees is not a change to
  make because they upgraded. The flag survives a mode switch so switching back does not lose
  it, and does nothing while the canvas is not an orchestration.
  This is the prevention half of the rule above, and it is reachable because a card's omp
  process is started with `--cwd` set to the session's `directory` and runs its tools *there* —
  measured 2026-09-03. `lib/worktree.ts` opens one `git worktree` per dispatched card that can write,
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
- **OpenFlow has no agent loop of its own.** A card is an omp process, so it inherits omp's tools,
  approval modes and subagents. Subagents (agent-swarm's specialists among them) are omp-native:
  OpenFlow sees the card's final transcript and, for a swarm, a status derived from omp's
  subagent frames — not the subagents' own transcripts. OpenFlow injects no skills; skills and
  MCP servers come from the omp profile.
- The canvas is hand-rolled — HTML node cards over an SVG edge layer in one CSS-transformed
  viewport. `solid-flow` is abandoned (last publish 2022, Solid 1.5); do not reach for it.
- The browser never talks to omp. It calls the host's `/flow/api/engine/*` routes
  (`shared/engine.ts` is the wire, `src/server/client.ts` the browser client); there is no
  other engine server and no SDK.
- Store routes (`/flow/api/*`) live in `lib/store.ts` and are mounted by **both** hosts
  (the vite plugin and `server.ts`) so dev and built output cannot drift. Add new routes in
  one place only.

## Omp engine

The architecture invariants of the engine that replaced the earlier one. The facts below were
established by live runs against real omp 18.12.2 and the real Agent Substrate; the code is the
authority where this and it disagree.

- **Host module map.** `lib/host` (`createHost`) composes `lib/omp` (the engine host: one omp
  process per card, the RPC core `rpc.ts`, the launch builder `launch.ts`, the model catalog, the
  frame-to-event mapper, UI requests, host tools), `lib/omp-config` (the settings store, status,
  `omp config`, providers, login import), `lib/uplift`, `lib/substrate`, `lib/swarm` and
  `lib/terminal`. It returns one `handle` — terminal, omp-config, engine, uplift, substrate, swarm,
  tried in that order — plus `gate`, `profileDir()` and an idempotent `dispose()`. Both hosts
  (`server.ts` and `vite/flow-store.ts`) build one `createHost`, run `host.gate` on every
  `/flow/api` request first, give `host.handle` first refusal after it, and mount `handleFlow`
  (the store) last. A new host route goes in a module, never in either host.
- **The wire.** `shared/engine.ts` is the engine wire: the routes under `/flow/api/engine`, the
  event names, `CardSpec`, and `EngineApi`, the port `src/server/engine.ts` depends on.
  `src/server/client.ts` implements it in the browser and `engine.test.ts` doubles it, so the long
  engine suite stays valid. The host maps omp frames onto the event names the engine and
  `activity.ts` already read (`session.next.*`, `permission.v2.asked`, `question.v2.asked`,
  `session.created`), plus `flow.swarm.status` and `flow.notice`. The stage and settings wires are
  `shared/{omp,uplift,memory,swarm,terminal}.ts`. Change a wire in `shared/` first;
  host and browser both import it.
- **Process model.** One `omp --mode rpc-ui` per card session, owned by the host, leading its own
  process group (so tool shells and MCP servers die with it). The RPC core speaks JSONL over stdio
  with protocol v2 `rpc_chunk` reassembly — mandatory, the model catalog alone arrives as about
  eight chunks. Closing stdin is the graceful stop; the group is SIGTERMed and SIGKILLed on cancel,
  and swept again when the host exits. A live session with no frames, no prompt and no HTTP
  activity for 30 minutes is closed and stays resumable from its session directory
  (`CreateSession.reuse`), which is also how a page reload keeps a run's sessions. At most 32
  processes run or start at once; at the cap the least recently used idle session is closed (409
  `too-many-sessions` only when all 32 are busy). Startup (`ready`, `open_session`) has a
  60 s deadline (`lib/omp/ready.ts`: 502 `omp-not-ready`, process group killed). Dispose, release
  and Stop are honoured while a session is still starting, so no process is orphaned; Stop during a
  hanging start ends at once (`EngineApi.createSession(input, signal?)`), a create whose request
  aborts before the session is live disposes it, and the
  engine checks for a Stop right after `createSession` so a stopped card never sends its prompt.
  The browser's `waitForIdle` long-polls in 55 s slices. The catalog, the provider list and the
  status check each start a short-lived omp (with `--model a`, `PROBE_MODEL`: omp aborts at startup
  without a default model, and any pattern that matches the catalog starts it) and cache the
  answer; the first two also key their cache on a credential stamp (mtime and size of the
  profile's `agent.db` and its WAL), so a `/login` typed in the terminal is noticed.
- **Stage order.** For a card turn of kind `task`, `stage()` in `src/server/engine.ts` runs Prompt
  Uplift first, then the memory read, then the send; `raw:` at the start of a task and
  `agent.uplift === false` skip both. A failed uplift never falls back silently: the card parks
  and the user chooses (run the original, retry, cancel). The memory read fails open and shows on
  the card; `memory.readLimit` 0 skips it. The memory write happens after the card settles and is never awaited by the card.
  A sub-agent dispatched more than once writes once per dispatch (subject suffix `-d<n>` for
  n > 1, the first dispatch unchanged); Forget, which retracts by prefix, covers the suffixed subjects.
  Protocol turns (verdict, force-final, dispatch result, reassign) are never uplifted, and neither
  are upstream outputs or attachments — only the card's own task text.
- **Isolation decisions.** Cards, the catalog and the terminal run under the omp profile
  `openflow`, so OpenFlow never reads or writes the user's default profile (the one exception is the
  user-initiated login copy, `omp auth export` into `omp --profile … auth import -`, in memory
  only). Cards start with `--no-extensions` unless `loadUserExtensions` is on. A card's environment
  is an allowlist (`lib/omp/env.ts`): deny rules beat allow rules, so `SUBSTRATE_*`, `SWARM_*`,
  `ULTRATHINK_*`, `AIO_*`, `*_TOKEN` and `*_SECRET` reach a card only when the launch builder hands
  them over in `extra` — which it does for the swarm signing key (by name from the host env, only
  when the card's swarm is on; see the residual risk below), `OPENFLOW_RUN`, `OPENFLOW_CARD`,
  `ULTRATHINK_UPLIFT=0` and `AIO_UPLIFT=0`. **No secret goes to a card through argv, a file or
  `omp-settings.json`** (the swarm key's environment value is the one residual below); the
  Substrate token is read by the host and never given to a card. The host sends that token only
  to https, loopback, or the origin `SUBSTRATE_URL` names (`tokenAllowed` in
  `lib/substrate/client.ts`); otherwise memory reads as unavailable with a sentence and nothing
  is sent, and the settings store warns about plain http to a non-loopback host. Per-card files live outside the project, under
  `<state>/omp/<12 hex of sha1(realpath(project))>/<run>/<card>/`. Tool toggles are enforced with a
  `tools.approval.<tool>: deny` overlay passed as `--config`, not `--tools`: probed against the
  real binary, `--tools` shrinks the active set to the named tools, so an extension's tool
  disappears unless it is listed, while a deny leaves everything else alone. The card's own denies
  are merged last so no other overlay can switch a disabled tool back on. In a gauntlet,
  `cardSpec` sets `edit: false` for the critics and the root, so they launch with `edit`, `write`
  and `ast_edit` denied; `bash` stays as authored. Writes to `<profile>/mcp.json` keep the file's
  existing mode (0600 for a new one) and its `.bak` is 0600.
- **Residual risk: the swarm signing key is readable by a swarm card.** The agent-swarm extension
  signs assignments in-process, so a card whose swarm is on gets `SWARM_ED25519_KEY` /
  `SWARM_SIGNING_KEY` by value in its environment, and its shell tool can read it. Cards without
  swarm never get it. `SWARM_ED25519_KEY_FILE` passes only a path. Do not run a swarm card on a task
  whose output you would not trust with that key.
- **Every card sees every MCP server; there is no per-card allowlist.** Omp has no per-session MCP
  selection and no settings-overlay switch for it. A card reads the profile's `mcp.json` and also
  the MCP files in its working directory (`.mcp.json`, `.omp/mcp.json`; omp's
  `mcp.enableProjectConfig`; verified live, even in an isolated profile). Their tools appear as
  `mcp__<server>_<tool>` and are reached through the `xd://` devices, not the tool list.
  `CardSpec.mcp` is gone, the inspector shows one sentence and a manage
  button, and `agent.mcp` in an older pipeline is dropped by `migrateAgent`
  (`src/graph/migrate.ts`) when it loads; an explicit list leaves a note naming the card.
- **A host route gate exists, and it is one gate.** `lib/host/gate.ts` runs before every handler on
  both hosts, so a new route is covered without doing anything. It matches every path under `/flow`
  in any case (`/FLOW/API/x`, `/flow/api./x`: connect matches its mount prefix case-insensitively and
  lets a dot follow it), a malformed `Host` is 403 `forbidden-host`, and the Vite plugin mounts it
  with no route prefix ahead of the routers. The node adapter keeps the request body when a handler
  passes the request on. Do not add a route that bypasses
  `host.gate`, and do not add a second copy of its rules.
- **At most 32 omp sessions run or start at once** (`DEFAULT_MAX_LIVE` in `lib/omp/session.ts`).
  `admit()` runs synchronously before every spawn. At the cap it closes the least recently used idle
  session (files kept, resumes on its next prompt); with every session busy the create fails with
  409 `too-many-sessions`, 409 on purpose because the engine retries 429 and 5xx. Anything that
  spawns a card session counts against it; the short-lived
  probes (catalog, provider list, status) are not sessions.
- **A session is registered before it starts, and disposal is rechecked after every await.**
  `lib/omp/session.ts` puts the session in its map with no await between making it and
  registering it, so `releaseRun`, dispose, close and the limit all see a session that is still
  starting; the startup steps then check `cancelled()` after each await and throw `closed` if it was
  disposed meanwhile. Keep that shape in any new startup step: an await without a recheck is how a
  process gets orphaned.
- **Run state is pruned.** About 15 s after the host starts, `pruneState` (`lib/omp/prune.ts`)
  deletes `<OPENFLOW_STATE_DIR or ~/.openflow>/omp/<12 hex>/<runId>/` when nothing under it has been
  written for `STATE_RETENTION_DAYS` (30). It claims the run directory (`claim`) before its last
  check and holds the claim across removal, and a create for that run waits for it. It never touches
  a run the host holds (`sessions.holds`, which counts creates in flight), a run whose log in
  `<project>/.openflow/runs/.index.json` is still `running` (it can be resumed), loose files or
  symlinks. In `uplift/` it removes only `results/` and `sessions/` `.json` and `.xml` files older
  than 30 days (files only, symlinks never followed). The stored uplift result's `attempt` stays the
  card's attempt counter on purpose. Pruned sessions leave the list and cannot be resumed.
  `POST /runs/prune` is a different thing: it removes only `.openflow/runs` logs.
- **Resume finds a session by id across the whole state root.** `lib/omp/session.ts` scans the
  newest 2,000 run directories by mtime and, of those, the newest 4,000 card directories, and adopts
  the session; only its FILES stay in their original state directory, the new run id is kept for new
  work. The NEW request applies (model, permissions, swarm, tools, run and working directory: the
  engine decides where a resumed card works). `reuse` of a session still LIVE in a different, still
  existing directory stops it (files kept) and relaunches it in the new run's directory; released while
  it is being stopped, the reuse is 404 and spawns nothing, and if the old directory vanishes while
  stopping it relaunches without a notice. The same directory is not restarted, but the session now
  belongs to the resuming run (`session.request` and the saved metadata follow the new request): releasing
  the new run disposes it and releasing the old run no longer does. A gone old directory is
  untouched with no notice. Overlapping `reuse` calls of one session are served one at a time (a
  per-session queue); a prompt that arrives during a resume waits for it, and `begin` refuses to start
  a live session again, so a session never has two processes. This is the safety
  net for logs that recorded no trees: the held info notice (`carriedNotice`) reads "Work it did there
  before then may not have been merged into this run. Inspect it with: git -C "<dir>" status" only when
  the directory is absolute, at most 200 characters and made only of `[A-Za-z0-9 _.@+:~\\/-]`;
  otherwise "…It worked in its previous working directory." with no command and no path. It is
  delivered at the first accepted prompt and persisted in `.openflow-session.json` as `carried` until
  then (`session.carried`).
  A restart/trimmed-record revive resumes in the saved directory and gets no notice.
  `.openflow-session.json` stores the saved
  create request (`request`) so a disk-only session resumes as launched. Using a session touches its
  run directory's mtime (at most once a second per run) so recent use ranks newest. A carried session
  the host cannot find makes the engine clear its attach and start the card fresh, once.
- **Session files and history.** `.openflow-session.json` and `.openflow-turns.json` (last 200 turns,
  each clipped to 32 KiB, read back up to 16 MiB) are written atomically — temp file and rename, mode
  0600, serialised per file. `GET …/transcript` reads the saved turns for a session the host no
  longer holds, and only for a session of the CURRENT project (`inProject`: its state directory is under
  the current state root; another project's sessions are not listed and are 404 by id until that project
  is current again); `final`, `steps` and `calls` answer 404 once it is released (`find()` throws for a
  disposed session). `CreateSession.transient: true` (boolean, else 400; with `reuse` also 400) writes
  neither file, is never listed or resumable, and its node directory (plus the run directory when this
  create made it and it is empty) is removed on dispose, release, failed start, exit or idle reap; the
  browser's model test sends it, and `FakeEngine` behaves the same. A session with no
  readable history is not listed. The table keeps at most 64 idle or lost records (`KEPT_RECORDS`),
  dropping the least recently active, never one with a turn in flight or a dialog waiting; `prompt`
  on a session with no record resumes it from its files; a session disposed on purpose is 404.
- **Shutdown is a closed gate, and every child is tracked.** After `close()` a create or reuse is
  409 `session-closed` and spawns nothing (a create whose body fails, bad JSON or oversized, is
  answered with that failure or the 409; the body promise is settled so nothing is left unhandled);
  a terminal create is 409 `disposed`; a late SSE
  subscriber gets a closed stream; the model catalog, provider probe and `omp config`/`omp auth`
  runs are 503 `host-closed` (`lib/host/lifecycle.ts`). The catalog, provider probe, `omp config` and
  `omp auth` runs, swarm preflight probes and every `omp --version` probe are tracked flights:
  `dispose` kills their process groups and waits, capped at 10 s. Start-up notices (tool-toggle
  notes, swarm degradation) are emitted when the first prompt is accepted, once, and not on a resume.
- **The event stream survives a drop.** The browser re-subscribes by itself while a run is active
  (`keepSubscribed` in `src/server/stream.ts`, 250 ms doubling to 8 s). After a gap the
  host sends `{"type":"flow.stream.reset"}` to EVERY subscriber that attaches within 60 s after a gap
  (`GAP_WINDOW_MS` in `lib/omp/routes.ts`: events published to nobody, or a client dropped for
  backpressure), after `: connected` and before the replayed asks; none otherwise. It then replays every
  still-pending `permission.v2.asked` / `question.v2.asked` (`sessions.pending()`) to every new subscriber. One
  event larger than the whole queue is replaced by a `flow.notice`, and tool-call arguments and raw
  results are capped (`lib/omp/events.ts`). Dialogs are keyed `sessionID:requestID` (`requestKey` in
  `src/state.ts`); the engine's `answered` / `asked` sets de-duplicate only while the request is pending
  and drop the key once the reply is handed back, so a session resumed after a reap, whose request counter
  restarted, is asked and answered again.
- **A project switch is refused while any engine session is open.** `POST /project` answers 409
  `project-busy` while ANY session is live (idle between turns included) or starting, a create is in
  flight (counted from the first line of `create()`, i.e. from `POST /sessions` arriving, body still
  being read; a body that has not arrived within 10 s, `bodyDeadlineMs` in the engine host deps, is 408
  `request-timeout` and releases the in-flight count), or an uplift planner runs (`projectLocked` =
  `engine.working() || uplift.active()`); reaped, lost and disposed sessions do not count, and the lock
  is re-checked right before the switch is applied. The body carries `sessions` (`engine.holders()`:
  every live or starting id; empty when only a planner or a create holds it). The UI
  (`switchFreeing` in `src/server/project.ts`) asks "N open card session(s) in the current project. Stop
  them and switch?" when ids are named and on yes deletes each and
  retries once; with none it shows the host's sentence. The picker and the Runs menu are disabled while
  a run is active, Run and Resume while the picker is open, and the page re-checks before asking the
  host and switches the host back if it moved first. The page hands the project it read at run start
  to the engine, so cards without a worktree and the uplift cwd stay in that project. Terminals are
  per project and kind in the
  browser, and the host records the spawn project on each PTY (`PtyInfo.project`): a ticket or attach
  from another project is 409 `project-mismatch`, nothing is killed. Terminal cleanup sweeps the whole
  process group, SIGHUP then SIGKILL after the grace, even when the leader already exited. Custom
  roles are per project (`.openflow/roles.json`); a role created while they load is merged in when the
  read finishes (project roles first, local win on the same id, `mergeRoles`) and then saved, and if the
  read fails nothing is written to the project and a notice says the change stays in the tab; edits
  made before the read are kept under a SEPARATE browser key per project
  (`openflow.customRolesPending.v1:<project path>`, never the migration source; other projects never
  read or push it; a project switch leaves it in place; an edit before the project is known is
  reported as not persisted), reported as unsynced and merged in when hydration succeeds; a hydration
  that finishes after a switch cannot write into the next project. A role deleted while the read is
  pending stays deleted: when the read returns the stored copy is removed too and the id is dropped from
  the pending key. The old browser copy is migrated once per browser
  (`openflow.customRolesMigrated.v1`) and nothing is written to a project's file before it was read.
- **Memory records are scoped and bounded.** Forget cutoffs in `<state>/memory-ignore.json` are keyed
  `<scope>|<prefix>` (for example `repo:acme/widgets|openflow/demo/`); a legacy key (starts with
  `openflow/`, no `|`) matches EVERY scope, since hiding too much is the safe failure, and new Forgets
  always write scoped keys. A failed write does not poison later Forgets (`ignoreChain` is re-armed
  after a failure; the caller still gets the error), a read error other than ENOENT throws so the
  write aborts, and a corrupt file is moved aside as `.corrupt-<ts>`. `memorySubject` in
  `shared/memory.ts` bounds each segment (pipeline 64, run 48, card 48) and ends a long or cleaned
  segment in a stable hash of the raw name, so `Review: A`, `review a` and `Review-A` never share a
  namespace; a clean short name is byte-identical, and there is no fixed 200-character cut.
- **MCP and skill names are exact.** Existing names are listed, edited and deleted as written; only
  names the app invents are slugged. A name is one safe segment, and an MCP name a usable JSON key (not
  empty, not `__proto__`, no control characters, at most 128). Saving a server disabled removes it from
  `enabledServers`; deleting removes it from both lists; DELETE of a missing name is 404
  `{ removed: false }`, which the UI's `removal()` treats as a result. `PUT` accepts an add-only
  boolean `create` (non-boolean is 400, never written to `mcp.json` or `SKILL.md`): with `create: true`
  an exact key/folder that exists, or a colliding slug, is 409 `{ code: "name-taken" }` and nothing
  is written; without it the save edits in place. The panels send `create: true` only for a new name or a
  move to a different folder (`skillTarget`, `mcpTarget` in `src/server/skills.ts`): a rename that
  slugs to the entry's own folder saves in place; for MCP, case is part of the key (`Docs` ≠ `docs`)
  while text the host reduces to the stored key (`my server` for `my-server`) is an edit. (Editing
  without renaming addresses a skill by its folder, so a folder `my-skill` with
  frontmatter name `My Skill` is not 409; a legacy skill, from the old `.openflow/skills` folder, saves under
  its own name without `create` as a plain migration, and under any other name sends `create` and is 409
  `name-taken` when the profile holds it); a skill create claims the folder with a non-recursive
  `mkdir` (concurrent creates: one 200, the rest 409; a failed `SKILL.md` write removes the empty
  folder), and the panels keep the editor open on a 409. The PUT answer's
  `name` is the stored key.
- **A blank model cannot run, and the app is what says so.** `preflight` blocks `no-model` ("pick a
  model for this node"); the default model only applies to cards added afterwards, and the canvas
  shows `no model`. The host does not refuse a model-less session: `buildLaunch` omits `--model`
  and omp uses its own default. `accepts(undefined, …)` is false, so a card whose model is not in the catalog gets no attachments.
- **Stale answers lose.** The sessions panel, run list, host probe, pipeline list and project connect
  take the newest call only (`src/server/latest.ts`); `save()` marks a pipeline saved only if it did
  not change while the PUT ran; the model test uses its own run id and releases it.
- **Session titles.** The engine sends `CreateSession.title` (`cardTitle` in `src/server/card-spec.ts`:
  `<role> · <first line of the task>`); the host stores it in the session's meta file. A session
  without one is titled from its first prompt.
- **Memory quarantine.** Substrate quarantines hedged text written as a `fact`
  (`quarantine.speculative`). `lib/substrate/memory.ts` re-sends the same text once as `kind: todo`
  (the repo scope accepts todo; handoff is denied there) under a `:todo` idempotency key, and the
  card line says it was stored as a todo because the output was hedged. Secret and PII
  quarantines are never retried.
- **Substrate never follows a redirect.** The client sends `redirect: "manual"` and treats any 3xx
  as a failure, so the bearer token cannot be forwarded by a redirect.
- **Environment API keys reach cards.** Any `*_API_KEY` in OpenFlow's environment is passed to every
  card (omp needs the provider's), never to the terminal. Keep unrelated service keys out of the
  environment OpenFlow runs in, or use the profile's stored logins (Copy logins).
- **Changing the engine port: use the contract suite.** `src/server/engine-contract.ts` is one
  shared suite of 40 scenarios for `EngineApi`. It runs against `FakeEngine`
  (`src/server/testing/fake-engine.ts`, via `src/server/engine-contract.test.ts`) and against the
  real browser client over HTTP to the real host wired to the stub omp
  (`lib/host/engine-contract.test.ts`). A change to `shared/engine.ts` or to either side of the wire
  is safe when both runs pass; add a scenario there rather than a one-off test on one side.
  `FakeEngine` is not the host: the header of `fake-engine.ts` lists its intentional differences
  (no session cap or eviction, no startup deadline, no idle reap or resume, a prompt to a busy
  session is a 409 where the host queues it, a lost session is disposed where the host keeps a
  `lost` record, and looser create validation and title cleaning). A test that needs one of those
  belongs to the host's own tests, and none is to be closed in the double.
- **Tool toggles omp cannot enforce.** `webfetch` has no omp equivalent (omp reads URLs through
  `read`), so a card with it off gets a one-time info notice at session start saying so
  (`describeLaunch` notes, emitted as `flow.notice` by `lib/omp/session.ts`). `skill` is enforced
  with `--no-skills`; every other toggle is a deny entry in the card overlay.
- **Engine teardown cannot leave a session live.** A run's `finally` in `src/server/engine.ts`
  releases every session it holds and also calls `releaseRun(runId)` best effort, so a lost create
  response or a failed per-session release does not strand one.
- **Shutdown.** Ctrl+C (SIGINT) and SIGTERM on the Vite dev server dispose the host — every omp
  session and PTY — before exit (`vite/flow-store.ts`); verified live, the session process is gone
  within about 5 s. `server.ts` does the same.
- **The host gate and the terminal gate.** Every HTTP request under `/flow` in both hosts — engine,
  settings, uplift, memory, swarm, store routes, SSE — passes `lib/host/gate.ts` first. A raw
  request target under `/flow` containing `.`/`..`/`%2e` segments, a backslash (`%5c`), NUL
  (`%00`) or `;` is refused with 400 `forbidden-path` (`rawPathRefusal`) before routing, and the
  Vite store middleware takes the same normalised path the gate decided on. Then `apiRefusal`: a
  loopback `Host` (unless `FLOW_ALLOW_REMOTE=1`; a missing or credentialed Host is refused on Vite
  as on Bun), a same-origin `Origin` (`null` is
  refused), `Sec-Fetch-Site` `same-origin` or `none`, and `application/json` for any body. A refusal
  is a 403 with `forbidden-host`, `forbidden-origin` or `forbidden-content-type`. A request with no
  `Origin` or `Sec-Fetch-*` (curl, scripts) passes: only a browser is being fenced. This is what
  stops a cross-site "simple" POST or a DNS-rebound name from running agents. The dev server sets
  `server.cors: false` (no CORS headers, no preflight answers). The standalone server runs with
  `development: false`, answers malformed paths with 400, and never returns a stack page: a throw is
  500 `{ "error": "internal error" }` (the handler lives in `server-app.ts`). The terminal keeps a
  stricter policy on top: every route needs the `x-openflow-pty: 1` header (a custom header forces a
  CORS preflight this host never answers), an `Origin` equal to the loopback `Host`, and — for the
  WebSocket — a one-shot ticket (60 seconds). The browser sends only a `kind` (`omp` or `shell`);
  argv, cwd and env are host-derived, and the env is the card allowlist without `*_API_KEY` keys. It
  is off when `FLOW_ALLOW_REMOTE=1`. The terminal policy is `lib/terminal/policy.ts`, a table-driven
  test.
- **Bun/Node dual runtime.** `server.ts` runs under Bun; the vite dev plugin runs under Node.
  Everything in `lib/` and `shared/` runs in both, so it uses `node:` APIs only — no `Bun.*` and no
  `bun:` imports — and `Promise.withResolvers()` rather than an executor. What genuinely differs is
  chosen once, in one file per runtime: the PTY (`lib/terminal/pty-bun.ts` uses Bun's own, because
  `@lydell/node-pty` fails under Bun; `pty-node.ts` uses `@lydell/node-pty` and must stay
  strippable by Node — no enums, no extensionless value imports) and the WebSocket upgrade
  (`ws-bun.ts`; `ws-node.ts`, whose `attachDevUpgrade` the Vite plugin mounts). `shared/` imports nothing from `lib/`, `src/` or a runtime, and
  `lib/` does not import `src/`; the engine runs in the browser and cannot import `lib/`.
- **State that tests touch.** A test that reaches OpenFlow's own state sets `OPENFLOW_STATE_DIR`
  to a temp directory before the module loads; the alternative writes a developer's real
  `~/.openflow/state.json`. The tests that run a real omp use a throwaway `HOME` and profile.
- **Windows and macOS are unverified.** Suites that need a real PTY, process groups or a
  `#!/bin/sh` wrapper are skipped on Windows (`skipIf(process.platform === "win32")`), so the
  Windows CI leg runs only the cross-platform tests. PTY and process-group behaviour on Windows
  and macOS has not been exercised in practice; do not assume it.
- **CI.** `.github/workflows/openflow.yml` runs typecheck, `bun run check:no-opencode` and
  `bun test` on Ubuntu and Windows.

## The post-run coach

`graph/coach.ts` reads a finished `RunLog` and the pipeline and returns at most three `Finding`s,
shown as a dismissable strip under the runbar (`ui/coach-strip.tsx`). It audits the *run* — how far
its verdict can be trusted — where a critic judges the *work*.

- **No model, ever.** Deterministic code over the record. An LLM coach would be one more thing that
  can hallucinate, and the run log already carries what it needs.
- **A finding states an observation and one fix, never an opinion of a model.** "The critic made no
  shell call that succeeded" is evidence; "the critic is weak" is not, and would age badly.
- **Missing evidence is silence.** `RunNodeLog.ranShell` absent means unknown, not `false` — same rule
  as an unmeasured diff or an unpriced model. A detector must also check the claim applies: a prose
  bar gives a critic nothing to run, so `unearned-pass` fires only on a `commandShaped` bar.
- **Facts the engine already knows are recorded at run time, not re-derived.** `events` is a capped
  tail, so a detector rereading it can miss calls. Persist a small optional field instead.
- **A stopped run is not a failed one.** `never-dispatched` skips `status: "stopped"`.
- **A rule working is not a failure.** `tool-failures` skips critics and orchestrators: the engine
  refuses them write tools on purpose, so "that card could not write" would blame the wrong thing.
  Measured on the first live run (2026-10-18), where it fired on both.
- **Known gap:** `unearned-pass` counts every critic with `ranShell === false`, including one that
  returned FAIL while another passed; narrowing needs the per-round verdicts in `rounds[].cards`.
- Dismissal is in-memory, keyed `runId:findingId`. Adding a detector means a fire / no-fire /
  missing-evidence test in `coach.test.ts`.

## The eval corpus

Six fixed canvases in `src/graph/corpus.ts`, run the same way each release, because three of
this project's goals — runs for hours, does not degrade, no quality-costing bugs — are claims
about behaviour over time and nothing measured any of them. Read `packages/flow/evals/README.md`
before running one.

- **Two halves, priced very differently.** The **free** half is a test: every case still passes
  preflight raising exactly the warnings it declares, which catches a change to `validate.ts`
  making a legal shape illegal or an illegal one legal. The **paid** half is a person opening
  each canvas, giving it the fixed task, and pressing Run.
- **There is deliberately no script that drives the models.** A harness that re-implemented the
  run would be measuring itself, and `RunLog` already carries every number needed — status,
  verdict, wall clock, spend, rounds, per-card lines. `evals/score.ts` reads run logs into a
  scorecard and compares two of them; it never dispatches anything.
- **The cases are the shipped templates**, with a document toggle turned on for the mode
  variants — that is how a user reaches those modes, so a regression in a shape nobody builds is
  worth less than one in the first thing they click.
- **One pinned model for every card** (`EVAL_MODEL`). A corpus whose cards drifted onto whatever
  they defaulted to would be measuring the models. It is also why no case runs on a free router:
  "which model produced this number" has to stay answerable.
- **What counts as a regression is narrow on purpose.** Status and verdict are not judgement
  calls. Cost, clock and rounds only count past a tenth or one whole unit, whichever is larger,
  because a gauntlet costing 3% more is a tokeniser and flagging it every release trains the
  reader to skip the column. **Lines changed are reported with no direction claimed** — more
  lines is not better work and fewer is not tighter work, and claiming otherwise would be this
  file inventing a bar when the bar belongs to the canvas.

## Running and verifying

- The canvas dev server is on **:5174**, started from `.claude/launch.json` (`openflow`). It
  hosts everything — the store and the modules that drive omp — so there is no second server to
  start.
- :5174 binds `localhost`/IPv6 — `127.0.0.1:5174` refuses the connection. Use
  `http://localhost:5174`.
- omp takes about two seconds to be ready and a few more to answer the model catalog, so the first
  model read after boot is slow; the host caches it for ten minutes. Reload rather than debug it.
- **Running without a usable omp is the number-one false alarm.** A missing or too-old omp
  surfaces as whatever was being done — an empty model menu, a card that errors at once, a failed
  model read — not as an obvious "omp is missing". Check the statusbar (`connected · omp
  <version>`) and the Status tab of Omp settings (`GET /flow/api/omp/status`) before debugging
  anything else.
- Another session may already hold :5174. Check `netstat` before starting your own.
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
- **A `window.confirm` guard reads as "cancel" in a hidden pane**, so anything behind one
  silently does nothing — measured 2026-09-07 driving the Open menu: the row was clicked, the
  menu closed, the notice never appeared and the canvas never switched, three times in a row,
  with no error anywhere. Stub `window.confirm = () => true` before driving any control that
  might sit behind an unsaved-changes prompt, and assert the state actually changed
  (`.titlebar-name`'s value here) rather than trusting the click.
- **Menu rows are `button.oc-item[data-key="…"]`, and clicking the inner `span.oc-item-label`
  does nothing.** Select on the `[data-key]` button itself; a text search that lands on the
  label finds the row and clicks the wrong element.

## Hazard: test runs write real files

A card whose node says nothing about tools runs with every tool omp has — `edit` and `bash`
included — in the project folder. `preflight` warns (`unrestricted-write`) but does not block. A
verification run once took its task literally and edited `packages/cli`.

Before any run that could write: give every card the tool toggles it needs (the launch spec carries
a tool list only when the card declares one), and set `OPENFLOW_PROJECT` to the target repo.

**Where a card runs is the project, or its own worktree.** The host starts each omp process with
`--cwd` set to the session's `directory`: `OPENFLOW_PROJECT` by default, a card's `git worktree`
when isolation gave it one (see the orchestration rules above). Which config the card reads is
omp's rule for the profile and directory OpenFlow passes (`--profile`, plus a per-card `--config`
overlay); the project's own files are not a place to put card permissions.

**Skills and MCP servers are written to the omp profile**, not the project
(`<profile>/skills/<name>/SKILL.md`, `<profile>/mcp.json`), and omp reads them when a card's
session starts. A change applies to the next session, not to one already running, and the routes
answer 409 until omp has reported the profile's directory.

## Design directive (standing)

**The entire OpenFlow UI matches upstream OpenCode, and stays minimal.** Copy from upstream
components rather than approximating them, and do not add extra affordances alongside them.

- Model UI mirrors `packages/app/src/components/dialog-select-model.tsx`. A fresh install shows
  **no models** until the OpenFlow omp profile has a login — log in (Omp settings, or `/login`
  in the terminal), then its models exist.
- Tokens are copied verbatim from `packages/ui/src/v2/styles/theme.css` and `colors.css` into
  `:root` in `src/styles.css`, because the flow page loads no upstream stylesheet and the vendored
  UI package stays out of the dep tree. Inter 13px / weight 440 / tracking -0.04px;
  mono only for code, ids, and paths. Fonts are copied into `packages/flow/public/fonts/`.
- Chrome is titlebar 40px / runbar 44px / statusbar 28px around a three-column `main`.
- Native `<select>` cannot be styled into the upstream popover. Every menu routes through
  `src/ui/select.tsx` (controlled; `value=""` for action menus). Zero native selects survive.
- Icons are the hand-drawn 16px set in `src/ui/icons.tsx`. No icon dependency.
- Five role colors are upstream's own dark agent solids: planner `#f799c6`, architect
  `#9e99f7`, coder `#c3d4fd`, reviewer `#b8e9c1`, custom `#f7e5b5`. Two are OpenFlow's own,
  because upstream has no agent for either job: `synthesizer` `#8fd4e8` reads a swarm and
  decides, `orchestrator` `#f7c48b` hands work to cards it can see. Cyan and amber are the
  hues the five leave free. Add a color here only for a role upstream genuinely has no
  counterpart for, and say so where it sits.

## Selection is a list, and the canvas gestures follow from that

- **`state.selection` is an ordered list of card ids; the last one is the primary.** There is
  no `state.selected` any more. The inspector shows the primary card's values — with several
  selected somebody's have to be shown, and the last card pointed at is the one the user was
  looking at — and every field edit fans out over the whole list through
  `updateSelected` / `updateSelectedAgent` / `toggleSelectedTool`. Renaming a multi-selection
  renames every card in it, which in swarm mode is how the synthesizer is designated: role text
  is the flag, so a bulk rename can take the decider with it.
- **Plain left drag on the canvas pans; Shift+left drag draws the marquee.** A rectangle and a
  pan are the same gesture and one has to take the modifier — panning is the one reached
  constantly, so the rectangle took it (measured: with the marquee on the plain drag, moving
  around the canvas by mouse was gone). Middle button and Alt+left still pan, and the `.canvas`
  cursor is `grab` again. Adding to a selection with the marquee is therefore Ctrl/Cmd only;
  Shift on a *card* is still `pathThrough`, since that press never reaches the surface. The
  plain press also clears the selection explicitly — that used to fall out of the marquee's
  no-drag case.
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

## Sessions come from the host

The sessions sidebar (`src/ui/sessions-panel.tsx`) lists `GET /flow/api/engine/sessions` — rows
the host builds from its live sessions and from the per-card state it keeps under
`<state>/omp/<project>/<run>/<card>/` (`.openflow-session.json` and `.openflow-turns.json` beside each
session directory).
**Never read or write those directories from the browser or from a second writer**: the host owns
the processes and rewrites that file as a session changes, and a session in use is not a file to
open.

Filter client-side over a fetched page, by anything a user would actually type — title, card key,
model and id (`matches()` in `src/server/sessions.ts`). A row's title is omp's own, else the first
line of the card's prompt, else the card key, so a blank title is still worth listing: it is
usually the session that just started.

## Config and cost gotchas

- `slug()` in `lib/store.ts` **lowercases**, drops everything but letters, numbers, `-`, `_`, space
  and `.`, and turns spaces into `-`. Lowercasing is load-bearing: NTFS and APFS fold case, so
  `Alpha.json` and `alpha.json` are one file, and leaving case in only hid the collision. Unicode
  letters survive, so a non-Latin name does not collapse onto `untitled`. A skill's display name
  (frontmatter, what the agent sees) and its folder legitimately differ in case; `readSkill`
  returns both `name` and `folder` (what the API addresses).
- Spend is computed client-side in `src/server/usage.ts` from the per-1M-token prices in omp's
  model catalog. **An unpriced model must never render as zero** — show it as unknown.
- Permissions set to `auto` start the card in `--approval-mode yolo`, so omp never asks. `ask me`
  surfaces each request; `always` approves the subject for that card's session when omp offers
  the option, and is allow-once otherwise.
- `omp-settings.json` holds no secrets by construction: paths, flags, numbers and a URL, and a
  URL with credentials in it is refused. Secrets enter through the terminal's `/login` or the
  host environment, never through an OpenFlow route.
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

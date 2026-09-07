# Gauntlet field log

Every failure the gauntlet mode hit in its first real run, in the order it hit them, with what
was actually wrong and what was done about it. Kept because a mode that has only ever been
tested against fakes has not been tested — and because most of these are things a first user
would hit on day one.

The run: a complex 3D Flappy Bird built from scratch by six cards on OpenRouter's **free models
router**, output to a folder outside the repo. Started 2026-08-30.

Legend: **fixed** — code changed and committed. **worked around** — the run was reconfigured,
the underlying gap is still open. **environmental** — not OpenFlow's to fix, but it shapes what
a user sees.

---

## 1. Generated agents are invisible to the engine — _fixed_

**Symptom.** Every one of six cards errored within a second of pressing Run:
`the server does not know an agent named "flappy-3d-gauntlet-coder-world"`.

**Cause.** OpenFlow writes generated agents into the _project's_ `opencode.json`, and a session's
location is the _engine's_ cwd — so the engine never reads them. `FLOW.md` documents this
exactly; it is still the first thing a new canvas walks into, because the merge affordance
writes to the place that does not work.

**Done.** Merged the generated agent block into the **global** `~/.config/opencode/opencode.json`
and restarted the engine. Worked around, not fixed.

**Fixed.** `writeAgents` in `lib/store.ts` merges into the **global** config
(`~/.config/opencode/opencode.json`), which is the one a drain reads, and stamps each generated
agent with the pipeline that produced it so a renamed or deleted node's agent is dropped rather
than accumulating. The generated block still lands in `.openflow/generated/` as the preview
artifact it always was. Preflight also refuses a run whose agents the server does not know, with
the restart command for _this_ host in the message — the engine reads its config once at boot,
so a freshly merged agent is invisible until it restarts.

---

## 2. The orchestrator graded its own work and ended the run — _fixed_

**Symptom.** Run reported `done` after three minutes. All five children `skipped`. The game did
not boot. The orchestrator's final answer certified the build against every line of the bar,
including "0. PARSE & BOOT — `node --check` all pass" and "1. LOADS CLEAN — zero console errors".
The first was true. The second was false.

**Cause.** Two holes at once. The orchestrator repaired the build itself instead of dispatching,
and nothing in the engine required a critic to have judged anything before a `final` was
accepted. The entire point of a gauntlet — the card that decides the work is good is not the
card that produced it — was unenforced.

**Fixed** (`fix(flow): a gauntlet cannot be ended by the card that did the work`):

- a `final` is refused once while no critic has judged the state the builders left, and the
  orchestrator is told which critics to send and what to tell them (`judgeFirstPrompt`)
- a verdict from a batch that also contained a builder does not count — the critic read a folder
  somebody else was writing to
- refused only _once_ per answer: a card asked twice that still will not have the work judged has
  stopped running a gauntlet, and forcing it further just burns turns

---

## 3. `edit: deny` in an agent config does nothing — _fixed_

**Symptom.** The orchestrator, configured `edit: deny` / `bash: deny`, edited `game.js`.

**Cause.** `permissions: auto` answers `once` to every ask. The agent's own permission block is
advisory; the engine's reply is what decides. So every "deny" in a generated agent is decorative
under the default policy.

**Fixed.** The engine now refuses mutating actions outright for the two cards in a gauntlet that
must not change the work — the orchestrator and the critics — regardless of policy.

**Open for release.** This is narrow on purpose. Everywhere else, a generated `deny` is still
silently upgraded to `allow` by `auto`. That is worth either honouring or documenting loudly; a
user reading their own config would not guess it.

---

## 4. Refusing `bash` bricked the run — _fixed, self-inflicted, one commit old_

**Symptom.** Next run died in 30 seconds: orchestrator `error`, everything `skipped`,
`the orchestrator never produced a usable control block`. Run log:

```
action: bash · dir "C:\...\FlappyBird3D" · reply: reject
action: bash · dir "C:\...\FlappyBird3D" · reply: reject
```

**Cause.** Fix #3 put `bash` on the refused list beside `edit` and `write`. But bash is the only
way either card can _look_ at anything, and the hardened bar (#5) orders the critic to run
`node --check`. The rule contradicted the bar it existed to serve. The orchestrator spent both
its turns being told it could not list a directory and emitted an empty message.

**Fixed** (`fix(flow): let a gauntlet's orchestrator and critic run commands`): `MUTATING` is
`edit`, `write`, `patch`. A card that edits through a shell command is a smaller problem than a
critic that cannot run anything.

**Lesson worth keeping.** A permission rule that blocks _observation_ does not make a card
behave; it makes it produce nothing, and the failure surfaces three layers away as a protocol
error.

---

## 5. The critic judged code it never ran — _the engine half is fixed; eyes are still missing_

**Symptom.** With the game a black screen and every script failing to parse, the critic's verdict
opened: _"The bar is better. The single largest gap is the ground plane position being incorrect
relative…"_ — a geometry note about a game that does not start.

**Cause.** The v1 gauntlet is code-and-runtime only: a card cannot open a browser, so a boot
failure is invisible to it. It read the source and critiqued what it read.

**Worked around.** Added line 0 to the bar: _it parses and it boots_, checked first, nothing below
counts until it passes — with the exact shell commands that stand in for eyes (`node --check` on
every loaded file, one declaration per top-level name, each script loaded once) and an
instruction to fail the round if those commands were not run.

**Fixed, as far as it can be here.** The engine cannot supply the eyes — no MCP tool reaches a v2
session in this fork, and it has no idea how an arbitrary project boots, so an engine-run "boot
check" would be guessing. What it _can_ see is whether the critic ran anything at all: a verdict
from a critic that made no `bash` call in its turn now carries `unverifiedNote()`, which tells
the orchestrator it is holding a review of the source rather than of the behaviour, and that a
runtime failure would have been invisible to it. A note rather than a failure, for the reason
`noWritesNote` is one: a critic reviewing prose or a diff has nothing to run, and no signal here
separates that from one that should have run the tests and did not.

**Still open.** A gauntlet whose deliverable is a web page still wants a built-in way for the
critic to see console output. That waits on MCP reaching v2 sessions, or on a card driving a
headless browser and capturing the artifact itself.

---

## 6. Statusbar showed negative minutes — _fixed_

**Symptom.** `$0.00 / $5 · -2 / 180m` immediately after starting a run.

**Cause.** The elapsed clock is a signal seeded at page load and advanced every 10s; a run started
after the last tick reads as negative until the next one.

**Fixed.** Clamped at zero.

---

## 7. Free-router output cap truncated a file mid-write — _environmental, shapes the design_

**Symptom.** `game.js` arrived 4.5KB with `SyntaxError: Unexpected token ')'` — cut off mid
statement.

**Cause.** OpenRouter's free router caps output around 8k tokens. A card writing a whole file in
one message runs off the end of its own turn.

**Not OpenFlow's bug**, but two consequences worth stating in the docs: a gauntlet on free models
needs its work split small enough that one file fits one turn, and bar line 0 (#5) is what catches
it when it doesn't.

---

## 8. Parallel fan-out produced two of everything — _the upstream lesson, reproduced exactly_

**Symptom.** `Bird`, `World` and `Look` were each declared in two files. The browser stops at the
second declaration; screen stays black.

**Cause.** Four builders working in parallel could not see each other. The card owning the entry
point wrote its own stubs for the three subsystems while the three subsystem cards wrote the real
ones.

**Not a bug** — it is the failure the Claude of Duty README describes, reproduced on the first
try, and the briefing already warns about it. Worth keeping here as evidence the warning is not
theoretical: the orchestrator did eventually diagnose and fix it, but only after a wasted round.

---

---

## 9. An orchestrator that could not edit produced nothing at all — _environmental, model-shaped_

**Symptom.** With the permission fix in place, the orchestrator ran 22 bash commands
investigating, tried `edit` twice (refused, correctly), and then emitted an **empty message** —
no control block — so the run died on the protocol again.

**Cause.** OpenRouter's free router. Blocked from the tool it wanted, the model produced nothing
rather than choosing the other path. Three of the first four runs died in the orchestrator seat
for protocol reasons, never in a builder.

**Done.** Moved the orchestrator to the cheapest DeepSeek with tool support
(`deepseek/deepseek-v4-flash`, $0.079/M in). The four builders and the critic stayed free.

**For release.** The control seat is not where to save money. Worth saying in the docs: a
gauntlet's orchestrator writes control blocks, not code, so it is the cheapest card to upgrade
and the one most likely to sink a run. First orchestrator turn on DeepSeek: 3 steps, 45k tokens,
$0.0033.

---

## 10. One stray character after the closing brace killed a correct dispatch — _fixed_

**Symptom.** `the orchestrator never produced a usable control block — The ```openflow block is
not valid JSON`. 726 seconds and $0.0218 spent to get there.

**Cause.** The block was _right_. It named the card, the file, the line, and the fix — the
orchestrator had correctly diagnosed that `THREE.Color` has no custom `toString()`, so
`topColor.toString()` hands `addColorStop` the string `"[object Object]"`, and prescribed
`'#' + topColor.getHexString()`. It ended:

```
... one-line fix per call." } ] }"
```

One `"` after the final brace. `JSON.parse` rejects the entire string over trailing junk, and
that was the run.

**Fixed** (`fix(flow): read the control block up to its closing brace`): when a strict parse
fails, the parser now reads the first _balanced_ JSON object and ignores whatever follows.
Braces inside strings do not count and escaped quotes do not end them, so a task that quotes code
still parses. It can only ever end earlier than the raw text, so genuinely broken JSON is still
refused.

**Lesson.** Strictness at the protocol boundary reads as robustness right up until it throws away
a correct answer over a character. The rule that survives: refuse what is _ambiguous_, repair what
is merely _untidy_.

---

## 11. The write refusal is bypassable through a shell redirect — _mitigated; the refusal is still soft_

**Symptom.** A file literally named `0` appeared in the deliverable folder, holding the
orchestrator's own diagnostics:

```
REVISION ref found: true
getStyle idx: 87318 87318
toString idx: 1432
```

**Cause.** The orchestrator is refused `edit` and `write` (#3) but keeps `bash` (#4), and a
redirect writes files. Here it was grepping the vendored `three.min.js` to check whether
`THREE.Color` really has no `toString` — exactly the investigation it should be doing — and a
`2>0` style redirect dropped the output into the folder as a file.

**Not fixed, deliberately.** Refusing bash costs more than it saves (#4). But two consequences
belong in the docs, because a user shipping the result will hit both:

- the "these cards cannot change the work" guarantee is _soft_: it stops the tool, not the shell
- a gauntlet's output folder accumulates investigation litter, and the bar's "nothing left
  unfinished" line should say so explicitly, or the final tidy will never happen

**Fixed, the cheap and honest way.** Every card that can run a shell is told, once on the turn
that opens its session, about a scratch directory outside the project (`lib/scratch.ts`, made
per run under the OS temp directory and deleted with the run's recording). The note says what it
is for and why — a redirect writes a file even where the write tools are refused — rather than
forbidding anything, because nothing here can enforce it. What it removes is the _reason_ to
redirect into the project: a card investigating something has to put the output somewhere, and
until now the only somewhere it had been given was the folder holding the deliverable.

**Still true.** The "these cards cannot change the work" guarantee remains soft: it stops the
tool, not the shell. That is why a critic's shell writes are read back with `writesOf` after
every batch and its verdict discarded if it changed the tree.

---

## 12. "Your message carried no block" — the recurring one, and its actual cause — _fixed_

**Symptom.** The most common failure of the whole exercise, hit on three separate runs and seen
on other canvases too:

````
the orchestrator never produced a usable control block —
Your message carried no ```openflow block, so nothing could be dispatched
````

**Cause — not formatting.** The run logs show `output length 0`. The card's final message was
_empty_, and `transcript()` only ever read the **newest assistant message's text parts**. A card
that ends its turn on a tool call leaves `content: [tool]` there, with what it actually said one
or two messages behind it in the same turn:

```
assistant | parts:[tool]              ""
assistant | parts:[tool]              ""
assistant | parts:[text,tool]         "Now I have the full picture. Let me verify…"
user      | topText: string           <- the prompt that started the turn
```

So the engine asked "where is your block", the card had written one, and nobody ever looked at
the message holding it.

**Fixed**, in three layers:

1. **`turnText`** (extracted from `transcript`, pure, tested): walk the page newest-first and take
   the newest assistant message that _has_ text, stopping at the user message carrying a top-level
   `text` — a real prompt. Tool output arrives as parts on an assistant message, so it cannot end
   the scan early, and stopping at the prompt is what stops a previous turn's block being re-read
   as this turn's answer, which would dispatch the same work twice.
2. **An empty turn is its own failure**, with its own words: _"Your last turn produced no message
   at all — you ended it on a tool call. Tools do not decide anything here; the block does."_
   Telling a card its block was malformed when it sent no message reads as nonsense, and it
   repeats the same empty turn.
3. **Three protocol re-asks instead of one**, each terser than the last — the third is one
   sentence and a shape to copy. Protocol re-asks are not charged to the dispatch budget. The old
   one-retry rule was justified as "a model that cannot do it twice will not do it on the third
   ask"; measured, that theory threw away a run where the card was one stray character from a
   correct dispatch it had reasoned towards for twelve minutes.

**Lesson.** Two of these three runs looked like a model too weak to follow a protocol. The model
had followed it. The reader was wrong. Before blaming the card, check that what it said was ever
actually read.

---

## 13. The write-hazard warning was inverted — _fixed_

**Symptom.** Every run showed five warnings:

```
Node 'coder' can edit files or run commands but has no agent —
it may write real files as the default build agent
```

while the cards beside them read `agent: flappy-3d-gauntlet-coder-world`. The panel contradicted
the canvas, on every single run, which is how a warning stops being read at all.

**Cause — wrong twice.**

1. `syncAgents()` fills `node.agent.name` from `agentKey()` when a run **starts**. Preflight runs
   _before_ that, so the name is always empty there. The condition `!node.agent.name` was reading
   a field that is populated one second later, so it fired for every node, always.
2. The direction was backwards. `agentBlock` writes a `permission` block **only** from
   `agent.tools`, so declaring tools is what _creates_ the restriction. A node that declares no
   tools gets an agent with no permission block and inherits the default — edit, write and bash
   allowed. That is the node worth warning about, and it was the one saying nothing.

So it fired when the user had done the right thing and stayed silent when they had not.

**Fixed** (`fix(flow): warn about the nodes that actually run unrestricted`): the warning now
fires when a node declares **no** tool permissions and names no existing agent —
_"sets no tool permissions, so it runs with the default agent's — it can edit files and run
commands"_. Declaring tools silences it, because that is what restricts the card.

**Lesson.** A warning that fires on every run is worse than no warning: it trains the user to
scroll past the panel that also carries the real ones. Worth a pass over the other preflight
rules before release to check none of them read state that a run fills in later.

---

## 14. A run dies with the browser tab — _open, and the sharpest edge here_

**Symptom.** Mid-run, every card went `idle` at once and the task box emptied. Nothing had
failed: the canvas had reloaded.

**Cause.** The engine runs **in the page**. Editing any file in `packages/flow` triggers the dev
server's HMR, the page reloads, and the run is gone — sessions orphaned, no log written, no
resume. Here it was self-inflicted (fixing #13 while round seven was live), but a user only has
to press F5, follow a link, or let a laptop sleep the tab.

**Not fixed.** Two things would make this survivable, in increasing order of work:

- **Warn before leaving during a run.** There is already a `beforeunload` guard for an unsaved
  graph; a live run deserves the same, and does not have it.
- **Resume from the run log.** Checkpoints are already written every couple of seconds, and
  "Re-run failed" already reuses finished node outputs. What is missing is picking up a run that
  was _interrupted_ rather than one that finished badly — the sessions are still on the server and
  addressable by id.

**For release this is the one I would fix first.** Everything else in this log costs a round; this
costs the whole run, silently, and the obvious user action (refresh when something looks stuck) is
exactly the thing that triggers it.

---

## 15. A card reported success while every write was rejected — _fixed_

**Symptom.** The card owning the largest file settled `done` after **1.36M tokens across 45
steps** (839k input, 10k output). Its last activity line was
`Invalid JSON input for openai-chat tool call write`. Nothing it claimed to write had been
written, and the orchestrator was told the work was finished.

**Cause.** `runTurn` decides a node's fate from the _transcript_: it fails a node only when the
assistant message carries an `error`. A rejected tool call is not that — the message completes
cleanly, the write simply never happened. Failed tool calls were already on the activity stream
(`activity.ts` emits `kind: "tool", status: "error"`) but nothing read them for correctness.

The trigger underneath: a whole-file `write` of an 11KB file through a model with an ~8k output
cap. The content is inlined into the tool call's JSON arguments and truncated, so the arguments
never parse.

**Fixed** (`fix(flow): tell the orchestrator when a card's tools were rejected`): after a turn
drains, the engine counts this turn's failed tool events, records `toolFailures` on the run log,
and appends a note to the card's own answer — which is the only thing the orchestrator reads.
Surfaced rather than auto-failed: one call can be rejected and the next succeed, so counting is
honest where a hard fail would be wrong.

---

## 16. A 5.3KB dispatch ran out of room before its closing brace — _fixed_

**Symptom.** `the orchestrator never produced a usable control block — The ```openflow block is
not valid JSON`, again, after the trailing-junk repair (#10) was already in.

**Cause.** This time the JSON really was broken. The orchestrator wrote a **5,381-character**
dispatch with an entire verification script inlined in the `task`, and the message ended:

```
… "priority": "high" } ]
```

Every brace closed but the outermost. `balanced()` correctly refused it, because the object never
closes.

**Fixed, in two places.**

- _The parser_: when the scan reaches the end with openers outstanding, close them in reverse —
  and close an unterminated string too, after trimming the trailing whitespace that would
  otherwise be a raw newline inside a JSON string. The repair only ever _appends closers_, so it
  cannot invent a card or a key; a dispatch missing its `card` is still refused.
- _The briefing_: the orchestrator is now told to keep a task to a few hundred words and never to
  paste scripts or file contents into one — a card has its own tools and can write its own
  checks. This is the real fix; the parser repair is the safety net.

---

## 17. Seven helper scripts in the deliverable — _fixed at the briefing_

**Symptom.** By the end of one round the game folder held `check.js`, `verify.js`,
`verify_final.js`, `verify_final2.js`, `fix_sync.js`, `apply_fix.js`, `test_dummy.txt` and a file
named `[object Object]` — none of them part of the game.

**Cause.** Two things at once. Cards write scratch files to verify their own work (reasonable),
and the ones whose `write` calls were being rejected (#15) fell back to shelling out Node patch
scripts (also reasonable). The bar says "nothing left unfinished" but nobody had told a card
where scratch is allowed to live.

**Fixed.** The subagent briefing now says it plainly: scripts a card writes to check or patch its
own work go in `.scratch/`, and the deliverable holds only what ships.

---

## 18. A live run now survives a stray refresh — _fixed; the resume that #14 asked for is now built too_

Following #14: `beforeunload` guarded an unsaved graph but not a live run, though the run is the
thing with no recovery at all. It now guards both.

The other half — resuming an _interrupted_ run — is entry #25.

---

## 19. A card can see the screen after all — and that killed the run — _fixed_

**Symptom.** `Provider request failed with HTTP 404: {"error":{"message":"No endpoints found that
support image input","code":404}}` — on the **orchestrator**, which had dispatched nothing wrong.

**Cause, and the good news inside it.** A builder had done something nobody designed for: it
drove a headless browser through `bash`, screenshotted the running game, and saved `shot.png`.
That is the capability this log twice called impossible (#5) — a card cannot reach MCP, but it can
reach a shell, and a shell can reach a browser.

Then the orchestrator opened the screenshot. `read` on a PNG returns an **image part**, and
DeepSeek V4 Flash takes text only, so the provider rejected **the entire request** — not the one
tool call. The card died, and with it the run.

The existing modality guard (`api.accepts`) filters _attachments_ — run files and node pins. It
never sees a file a card opens with its own tools, which is now the common path.

**Fixed** (`fix(flow): tell a text-only card it cannot open images`): when a node's model has no
image input, every prompt it receives carries a short note saying that opening an image fails its
whole turn, and pointing at what to do instead — read the console, the DOM, computed styles, the
numbers a script prints, or hand the looking to a card whose model has vision. Written as a
capability, not a scolding, because on this canvas the free-router cards _can_ see and the paid
orchestrator cannot.

**What this changes for the design.** Entry #5 said visual verification had to wait for MCP. It
does not. A card with `bash` can capture the artifact, and a vision-capable card can judge it.
The remaining engine-side job is smaller than scoped: run the capture between rounds and hand the
critic the image _and_ the console log, rather than hoping a card thinks of it.

---

## 20. I verified a black screen with a method that always reads black — _my error_

**Symptom.** I reported "pure black at all three sample points" for several rounds running, and
twice called a critic's pass false partly on that evidence.

**Cause.** `gl.readPixels` on a WebGL canvas returns black once the frame has been presented,
unless the context was created with `preserveDrawingBuffer: true`. Reading it from outside the
render loop measures nothing. A card's own screenshot, and then a plain browser screenshot,
showed the game rendering — sky, textured ground, clouds, a bird casting a shadow — at a moment I
had just called black.

**What was still true.** The console errors were read from the console and were real. The 0×0
canvas early on was real. The blackness claims were not.

**Rules that come out of it**, and they apply to the critic as much as to me:

- To claim something about a _rendered frame_, capture the frame. Screenshot, or read pixels
  inside a `requestAnimationFrame` callback on a context that preserves its buffer.
- State the method with the claim. "readPixels says black" is checkable; "it is black" is not.
- I criticised a critic for inferring a runtime property from source while doing the same thing
  with an unsound instrument. A bar that demands pasted evidence has to bind whoever is judging,
  including the person who wrote the bar.

_Appended as the run continues._

---

## 21. A rate-limited critic is just a dead card — _fixed_

**Symptom.** Second run (2026-09-01, continuation task against the existing game). The `critic`
card errored `Provider request failed with HTTP 429` twice in sixteen minutes, on
`openrouter/qwen/qwen3.7-flash`. Between the two it recovered on its own, because the
orchestrator happened to re-dispatch it.

**Cause.** `runTurn` treats a provider 429 like any other node failure: the card is finished for
that dispatch, no retry, no backoff, and the orchestrator is handed "the card produced nothing".

**Why it is worse here than anywhere else.** The gauntlet drops a critic's session before every
verdict on purpose (#2, and the method's whole point). So every round opens a _brand-new_
session on that model — the exact traffic shape a per-model rate limit punishes — while a
builder keeps one session and is never charged that cost. The card most likely to be rate
limited is the one card whose absence the run cannot route around, because a verdict is what
lets the orchestrator legally stop.

**Fixed** (`fix(flow): survive a rate limit, count what it cost, refuse to certify unjudged work`):
`runTurn` now re-sends a turn the provider refused for rate limiting — three times, waiting 20s,
40s, then 80s — into the same session, and says "rate limited — retrying in Ns" on the activity
stream while it waits. The refused turn produced nothing, so the re-send is the same prompt, and
attachments ride it rather than being lost with the turn that never landed. `rateLimitBackoff: 0`
fails on the first 429, which is what a test measuring the failure wants.

---

## 22. Run spend goes _down_, so the money cap counts the wrong number — _fixed_

**Symptom.** The statusbar read `$0.10 / $5` at twelve minutes and `$0.05 / $5` at twenty. Not a
render glitch; the run log agreed.

**Cause.** A node's `usage` is _replaced_ when the card is dispatched again, not accumulated, and
the run total is the sum of the nodes' current usage. Sampled every 15s from
`/flow/api/runs/<id>`:

```
00:54  total=0.0961  critic done                (round 1 verdict delivered)
01:03  total=0.0479  critic error  0.0010       (429 #1 — total fell $0.048)
01:11  total=0.0867  critic running 0.0204      (re-dispatch recovered on its own)
01:19  total=0.0809  critic error  0.0023       (429 #2 — 0.0204 overwritten by 0.0023)
```

The last two lines are the proof: one card's own cost falls across a re-dispatch.

**Why this one matters most.** `maxSpend` is the headline bound of a mode designed to run for
hours, and FLOW.md already calls an unenforceable spend cap "the one failure nobody would notice
until the bill arrived" — that is why an unpriced model blocks a gauntlet outright. This reaches
the same place through a different door: every model is priced, and the number the cap is
compared against still drifts arbitrarily below what was actually spent, without a word to the
user. Over enough rounds the cap simply never fires.

**Fixed.** `reconcile` folded one session's steps into the node's map instead of replacing it.
Steps are keyed by message id, unique per session, so sessions add up without double-counting and
the server's copy of a step still overwrites the bus's. Pinned by a test where a critic judges
twice, holds two sessions, and reports the sum of both.

**Worth keeping.** Writing that test, the first version failed because the run stopped early —
the spend cap had fired at $6 against a $5 ceiling. That is the bug's own shape from the other
side: the cap works, and it had been reading a number that kept shrinking underneath it.

---

## 23. With the critic down, the orchestrator nominated a builder as the judge — and the engine took it — _fixed_

**Symptom.** The run ended with the orchestrator certifying a PASS on all seven bar lines:

```
`look` — a card that did NOT build the fixed file — inspected final state and
returned PASS on all 7 bar lines
```

`look` is a `coder`. No critic ever returned a verdict on that state — both attempts 429'd (#21).

**Cause.** The judge-first rule is sound where it looks: `judged` is only ever filled from a
critics-only batch, and `isCritic` gates it, so a builder's opinion never counts as a verdict.
The hole is the refusal policy around it. A `final` sent while `unjudged()` is refused **once**;
the next `final` is accepted whatever the state of `judged`. That rule was written for an
orchestrator that _will not_ have the work judged (#2) — asking a third time just burns turns.
It reads very differently when the critic _cannot be reached_: the run cannot get a verdict, and
one refusal later the engine accepts the unjudged answer and reports `done` work as certified.

The orchestrator was not cheating, either. Told to have the work judged and holding a critic that
kept failing, it did the reasonable human thing — found the most independent card left and asked
that one. The engine had no way to say "that is not a verdict" other than refusing again, and it
had already spent its one refusal.

**What the run showed underneath it.** The build work was real and the claims held up: gap
5.2 → 4.4 on disk, the stray `x[1]` file gone, `__dbg*` hooks removed, every file stamped that
afternoon. Only the _judging_ was unsound — which is precisely the thing this mode exists to
guarantee.

**Fixed.** A second `final` while nothing has been judged now **fails the card** instead of being
accepted. Both endings stop the burn; only one of them tells the truth about what the run
produced. The reason separates the two cases, because they are different problems for whoever
reads the log:

- `the bar was never judged — every critic dispatched failed (critic: …)` when critics were sent
  and none came back, carrying the last failure's own words.
- `the bar was never judged — the card answered twice without sending the work to a critic`
  when none was ever sent.

`judgeFirstPrompt` also now says what the engine will do — that only the named reviewer cards
count, that a builder's report is not a verdict however thorough, that a failed critic is worth
dispatching again because refused turns are retried now (#21), and that this is the last ask.
Telling the card the rule is cheaper than enforcing it after the fact.

---

## 24. A synthetic click on Run reported success and started nothing — _documented_

`computer{action:"left_click", ref}` on the enabled Run button returned success twice while the
browser pane was hidden. The statusbar stayed `no run yet` and no console error was raised.
`button.click()` through `javascript_tool` started the run immediately.

FLOW.md's hidden-pane section already warned that `screenshot` and `left_click_drag` _error_ when
the pane is hidden. This is the worse variant: a click that reports success and does nothing. It
is now on that list, because the natural reading of a silent Run button is "preflight blocked it"
and the next twenty minutes go into the wrong place.

---

## 25. Three runs died to a host that went away, so a run can now be picked up — _fixed_

**Symptom.** Over one evening the canvas dev server exited three times with a run live. Each time
every card went `idle`, the task box emptied, and the work was gone: the engine runs _in the page_,
so nothing was left alive to write `done`, `error` or `stopped`. The engine at :4097 never dropped
— only the host serving the page did — so the sessions were all still there, addressable by id, in
a run log on disk that said `running` and always would.

Recovering by hand worked but cost the same thing every time: read the checkpoint, find the last
critic verdict, paste it into a fresh task, and pay for the orchestrator's opening turn again. Three
times in one evening is a workflow, not an accident.

**Fixed**, and it is the resume #14 called the most valuable thing on this list.

- `RunOptions.sessions` — node id to the session it was working in. Seeded before anything
  dispatches, so the card's first turn is prompted into the session it already holds rather than a
  new one. That is the whole difference between resuming and starting again wearing the old run's
  name: an orchestrator seven rounds into a gauntlet has read every verdict, and re-briefing it
  from scratch throws exactly that away.
- A carried card gets `interruptedNote()` on its first turn only, and it says plainly that nothing
  it produced was thrown away and the gap was not a judgement on its work. A card given no account
  of the silence re-answers what it already answered, which is the cost the note exists to avoid.
  From the second turn on it is an ordinary reused session, and saying it twice would read as a
  second interruption that never happened.
- A card in _both_ `resume` and `sessions` keeps its answer and never runs — reopening a finished
  card's session only buys a bill.
- The UI finds it on its own: a run still marked `running` on disk, for this canvas, with no run
  live, is one the page abandoned. A **Resume** button beside "Re-run failed" splits that log into
  answers to keep and sessions to continue.

**One defect found by writing the tests, worth keeping.** The first version never wrote the carried
session id to the run log — nothing else does, because the create path is skipped — so a resumed run
reported cards with no session while they were answering in one, and a _second_ interruption would
have had nothing left to carry. The test caught it by asking the log what session the card was in.

**Still open.** This recovers the run, not the host. Why the dev server exits is unknown: memory was
flat at 107-110MB across twenty minutes of a live run, so the leak theory that fit the timing is not
supported by the one measurement taken of it. Written here as unexplained rather than guessed at.

## 26. The critic cleared the bar and nothing could read it — _fixed_

**Symptom.** First live gauntlet after the round ledger and checkpoints landed. The run finished
`done` in 166s for $0.0048, the critic ran seven commands against the real work and cleared every
line of the bar — and the run recorded **no passed round**. `RunLog.best` was empty, so the
checkpoint that could have been rolled back to was never named, and the ledger line the next round
would have read said `critic: CLEAR**`.

**Cause.** Two of mine, one on top of the other.

The gauntlet's critic briefing asks for prose and only prose — "say which is better, name the
single largest gap" — because its reader is the orchestrator, which is a model. `verdictIn` looks
for `VERDICT: PASS` / `VERDICT: FAIL`, a protocol that belongs to the _verification_ pass. So
`bestRound`, which requires the literal `PASS`, could never fire in the mode it was built for.
Every gauntlet would have shipped with a dead best-round.

And the fallback made it worse rather than better: with no marker, `verdictSummary` quoted the
critic's first line. The critic wrote `**CLEAR**`, `firstLine` stripped leading emphasis and not
trailing, and `CLEAR**` went into the ledger as a verdict — a string that is not a decision,
cannot be compared against the next round's, and reads as a typo in every prompt it appears in.

**Fixed.** The critic is now asked for the marker as well as the prose: one line, exactly
`VERDICT: PASS` or `VERDICT: FAIL`, at the end of the message, stated as what the _run_ records
rather than what the orchestrator reads. Asking for both costs a line. And a message with no
marker is now reported as `no verdict line — <first line>` instead of being dressed up as a
decision; guessing was worse than admitting.

**The lesson worth keeping.** Both bugs passed every unit test, because both tests were written
against the string the test itself supplied. What found them was one $0.005 run against a real
model — which is the argument for the eval corpus in one line.

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

## 1. Generated agents are invisible to the engine — *pre-existing trap, hit immediately*

**Symptom.** Every one of six cards errored within a second of pressing Run:
`the server does not know an agent named "flappy-3d-gauntlet-coder-world"`.

**Cause.** OpenFlow writes generated agents into the *project's* `opencode.json`, and a session's
location is the *engine's* cwd — so the engine never reads them. `FLOW.md` documents this
exactly; it is still the first thing a new canvas walks into, because the merge affordance
writes to the place that does not work.

**Done.** Merged the generated agent block into the **global** `~/.config/opencode/opencode.json`
and restarted the engine. Worked around, not fixed.

**Open for release.** The one-click "merge agents" path writes to the project and then the run
fails. Either write to global config, or say plainly in the failure that the project copy is not
the one the engine reads.

---

## 2. The orchestrator graded its own work and ended the run — *fixed*

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
- refused only *once* per answer: a card asked twice that still will not have the work judged has
  stopped running a gauntlet, and forcing it further just burns turns

---

## 3. `edit: deny` in an agent config does nothing — *fixed*

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

## 4. Refusing `bash` bricked the run — *fixed, self-inflicted, one commit old*

**Symptom.** Next run died in 30 seconds: orchestrator `error`, everything `skipped`,
`the orchestrator never produced a usable control block`. Run log:

```
action: bash · dir "C:\...\FlappyBird3D" · reply: reject
action: bash · dir "C:\...\FlappyBird3D" · reply: reject
```

**Cause.** Fix #3 put `bash` on the refused list beside `edit` and `write`. But bash is the only
way either card can *look* at anything, and the hardened bar (#5) orders the critic to run
`node --check`. The rule contradicted the bar it existed to serve. The orchestrator spent both
its turns being told it could not list a directory and emitted an empty message.

**Fixed** (`fix(flow): let a gauntlet's orchestrator and critic run commands`): `MUTATING` is
`edit`, `write`, `patch`. A card that edits through a shell command is a smaller problem than a
critic that cannot run anything.

**Lesson worth keeping.** A permission rule that blocks *observation* does not make a card
behave; it makes it produce nothing, and the failure surfaces three layers away as a protocol
error.

---

## 5. The critic judged code it never ran — *worked around at the bar, engine gap still open*

**Symptom.** With the game a black screen and every script failing to parse, the critic's verdict
opened: *"The bar is better. The single largest gap is the ground plane position being incorrect
relative…"* — a geometry note about a game that does not start.

**Cause.** The v1 gauntlet is code-and-runtime only: a card cannot open a browser, so a boot
failure is invisible to it. It read the source and critiqued what it read.

**Worked around.** Added line 0 to the bar: *it parses and it boots*, checked first, nothing below
counts until it passes — with the exact shell commands that stand in for eyes (`node --check` on
every loaded file, one declaration per top-level name, each script loaded once) and an
instruction to fail the round if those commands were not run.

**Open for release.** This works, and it should not have to be hand-written into every bar. A
gauntlet whose deliverable is a web page wants a built-in way for the critic to see console
output. Until MCP reaches v2 sessions, the honest options are a documented bar template or a
"boot check" the engine runs itself between rounds.

---

## 6. Statusbar showed negative minutes — *fixed*

**Symptom.** `$0.00 / $5 · -2 / 180m` immediately after starting a run.

**Cause.** The elapsed clock is a signal seeded at page load and advanced every 10s; a run started
after the last tick reads as negative until the next one.

**Fixed.** Clamped at zero.

---

## 7. Free-router output cap truncated a file mid-write — *environmental, shapes the design*

**Symptom.** `game.js` arrived 4.5KB with `SyntaxError: Unexpected token ')'` — cut off mid
statement.

**Cause.** OpenRouter's free router caps output around 8k tokens. A card writing a whole file in
one message runs off the end of its own turn.

**Not OpenFlow's bug**, but two consequences worth stating in the docs: a gauntlet on free models
needs its work split small enough that one file fits one turn, and bar line 0 (#5) is what catches
it when it doesn't.

---

## 8. Parallel fan-out produced two of everything — *the upstream lesson, reproduced exactly*

**Symptom.** `Bird`, `World` and `Look` were each declared in two files. The browser stops at the
second declaration; screen stays black.

**Cause.** Four builders working in parallel could not see each other. The card owning the entry
point wrote its own stubs for the three subsystems while the three subsystem cards wrote the real
ones.

**Not a bug** — it is the failure the Claude of Duty README describes, reproduced on the first
try, and the briefing already warns about it. Worth keeping here as evidence the warning is not
theoretical: the orchestrator did eventually diagnose and fix it, but only after a wasted round.

---

*Appended as the run continues.*

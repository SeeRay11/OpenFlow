**Evidence base:** read-only. No model, Substrate or Linear calls were made. No secret values are quoted. One of my own file greps showed `OPENROUTER_API_KEY` in `~/.bashrc`; the value is not repeated here and is worth moving out of that file.

## A. Headless call contract
- **Command:** `bin/run-bun hooks/engine.ts`, which runs `bun --no-env-file hooks/engine.ts` (`bin/run-bun:44-50`). There is no argv. The jsonPlanner entry is declared in `ultrathink.discovery.json` (`interfaces.jsonPlanner`: `transport json-stdin-stdout`, `responseType PlanResponse`). It always exits 0 (`hooks/engine.ts:77-85`).
- **stdin request:** one JSON object (`hooks/engine.ts:14-40`, `PlanRequest` at `src/host/plan.ts:32-46`):
  `{host?, session_id, prompt, cwd, parent_session_id?, platform?, transcript_path?, model?, provider?}`
  - Aliases accepted: `sessionId`, `userPrompt`, `user_prompt`, `text`, `workspaceRoot`.
  - Only string fields are read. Non-JSON or empty stdin gives `{}`, which skips as `empty`.
- **Host identification:**
  - `host` must be one of `claude-code|grok-build|hermes|muse|omp|prime-agent` (`src/host/types.ts:7`). The file header says only hermes and prime-agent, but the code accepts all six.
  - A non-empty unknown host (e.g. `"openflow"`) returns `skipped:"unsupported-host"` with `modelResolution` set (`plan.ts:127-147`).
  - An absent host falls back to `ULTRATHINK_HOST` if set, otherwise `detectHost`. `detectHost` ends at `claude-code` (`src/host/detect.ts:17-27`).
- **Trap:** `host:"omp"` through this entry returns `skipped:"native-unavailable"`. Omp planning under `auto` needs an in-process model selector (`src/host/engine.ts:339-360`; `docs/how-to/choose-engine.md:183`). Use `host:"prime-agent"` (or `hermes`, or `claude-code`). Prime-agent is the host the docs describe the entry for. For all three, auto resolves to the Claude CLI (`HOST_DEFAULT_ENGINES`, `engine.ts:148-155`).
- **Engine for a non-Omp host:**
  - It runs `claude -p --tools "" --setting-sources "" --no-session-persistence --strict-mcp-config --output-format json --system-prompt <sys> [--model <m>]`.
  - The user text goes on stdin. The environment gets `ULTRATHINK_CHILD=1` and `MAX_THINKING_TOKENS=0` unless `claude.thinking` is set (`src/claude/complete.ts:34-84`, `engine.ts:294-318`).
  - It uses whatever login the `claude` CLI has. This machine has `claude.model:"claude-sonnet-5-5"`.
  - With no login or a failed call, each stage throws and falls back. The result is a `fallback` spec (`src/uplift/run.ts:41-45`) and `engineError` is recorded. The call does not fail and the exit code stays 0.
  - To pin the route, set `think.engine:"claude"` or control `engine:"claude"`.
- **stdout:** one line, `PlanResponse` (`plan.ts:48-63`):
  ```
  {context:string, specPath?, statePath?, graphId?, skipped?, carrierPath?, summary?, view?:PlanView, modelResolution?}
  ```
  - `PlanView` is at `src/host/view.ts:13-48`: `{root, source:"llm"|"fallback", engine?, goal, graphId, elapsedMs, nodes[], waves[][], clarifications[], tracking?}`.
  - On any skip: `{context:"", skipped:<reason>}`. Reasons seen: `child-or-disabled`, `parent-session`, `cron`, `empty`, `precheck-skip|passthrough` (e.g. a `raw:` prompt), `ultrathink-command`, `jev-skip`, `uplift-failed`, `aborted`, `engine-error`, `subagent`, `unsupported-host`, `native-unavailable`.
- **Telling success from fallback:** there is no top-level `source`.
  - Success is `context !== ""`, no `skipped`, and `view.source==="llm"`.
  - On fallback, `view.source==="fallback"`, `graphId` is absent (`hook.ts:707-710` builds the track plan only for non-fallback results), and `context` starts with `## Planning degraded` (`output.ts:365-381`).
  - Partial degradation: `degraded[]` in the session JSON (`state.ts` `SessionRecord.degraded`, e.g. `["fill:n3"]`) and a `## Planning degraded` notice.
  - A real failure sample is in `~/.omp/agent/ultrathink/last.json`: `engineError:"omp-native completion failed (provider error)"`, `degraded:["fill:n3","fill:n5"]`.
- **Timeouts:**
  - Config: `claude.callTimeoutMs` and `claude.budgetMs`, both default 0 (unbounded). `decisions.timeoutMs` defaults to 3000.
  - Budget expiry delivers the partial plan. If the spec itself did not finish, the prompt goes through unplanned (`docs/how-to/reduce-cost-and-latency.md`).
  - The caller must enforce a wall clock. Hermes uses `min(540, cap-15)` s, requires at least 90 s, and SIGKILLs the process group (`hosts/hermes/bridge.py:52-56,385-405`). Spawn with `detached`/`setsid` and kill the group.
- **Environment knobs:**
  - `ULTRATHINK_UPLIFT=0` skips everything. `ULTRATHINK_CHILD=1` skips as well.
  - `ULTRATHINK_TRACK=0`, `ULTRATHINK_SHIP=0`, `ULTRATHINK_DECISIONS=0`, `ULTRATHINK_HINDSIGHT=0`, `ULTRATHINK_RAGFLOW=0`, `ULTRATHINK_TEACH=0`.
  - `ULTRATHINK_STATE_DIR` (ignored if it points into a `.planning` path), `ULTRATHINK_HOST`, `ULTRATHINK_DEBUG=1` (stderr), `SUBSTRATE_URL|TOKEN|DISABLED|TIMEOUT_MS`.
  - `ULTRATHINK_PROGRESS_FD=<n≥3>` makes the planner write JSONL `ProgressEvent`s to that fd, never stdout (`src/host/progress.ts:46-58`). The event types are `begin|stage|graph|node|track|issue|end`. This gives a live card progress bar. Spawning it needs an extra stdio pipe at fd 3 [INFERENCE: Bun/Node stdio arrays].
- **State written:** `<stateDir>/sessions/<sid>.json` (the `SessionRecord`), `<sid>.xml` (the spec), `last.json`, and `last-plan.json` (carrier).
  - `stateDir` is `ULTRATHINK_STATE_DIR`, else the host's default (`src/host/paths.ts`). For prime-agent that is `~/.prime/agent/ultrathink`; for omp, `~/.omp/agent/ultrathink`.
  - `last.json` and `last-plan.json` are singletons per state dir, so concurrent cards overwrite them. Read the per-session files only.
  - A repeat `session_id` overwrites its record, and the previous clarifications carry into the next plan.

## B. Jev
- **What it is:** a TypeSafe decision model reached through OpenRouter (`/api/alpha/decisions`) or the Vercel AI Gateway. It returns a probability P for one yes/no question, never text (`docs/how-to/use-jev-decisions.md`).
- **Decision points** (`src/decisions/types.ts:12`): `plan`, `ship`, `knowledge`, `blocking`, `teachable`, `skillworthy`.
  - **plan** is the gate. It skips when P < `planSkipBelow` (0.2) (`src/claude/plan-gate.ts:34-47`). It is bypassed for skill invocations, `/commands` and `uplift:`.
  - **blocking** (≥ 0.5) promotes a clarification to blocking. **knowledge** (≥ 0.8) keeps a Greptile-settled answer.
  - The other three are the ship, teachable and skillworthy points; they do not touch card planning.
- **Runs automatically:** yes, inside `planPrompt → runPromptSubmit` (`hook.ts:454-489`, passing `decisionsDeps:{env}` at `plan.ts:233`).
  - `decisions.enabled` is ignored. The only off switch is `ULTRATHINK_DECISIONS=0`.
  - With no key it behaves as off.
- **Keys:** the stored key wins (`mcp-credentials.json`, via `ULTRATHINK_MCP_STORE` or `$XDG_CONFIG_HOME/ultrathink`). Otherwise `OPENROUTER_API_KEY` (openrouter) or `AI_GATEWAY_API_KEY` (vercel) (`decisions/gate.ts:26-34`). `decisions.provider:"auto"` prefers vercel, then openrouter.
- **Observing it:**
  - On a Jev skip: `{context:"", skipped:"jev-skip", summary:"Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it"}`. The summary exists only when `claude.echo` is true. No record is written.
  - On a plan: `Decisions · plan 0.97 · blocking 1/3 promoted` appears in the summary (`output.ts:204`). Full `DecisionRecord[]` goes in `session.json.decisions`. Each record has `{point, p, threshold, action, model, latencyMs, attempts, cost?, error?}`.
  - With `ULTRATHINK_DEBUG=1`, stderr gets one line per decision.
- **This machine:**
  - `~/.config/ultrathink/config.json` has `decisions.provider:"openrouter"`. `~/.claude/ultrathink.json` does not exist.
  - `OPENROUTER_API_KEY` is set in the environment, so Jev is live.
  - `last.json` shows three `blocking` records on model `typesafe/jev-1.14-20261014`.
  - Other relevant non-secret keys:
    - `notion.dataSourceUrl` and `linear.team` are set.
    - `substrate.url` is `http://127.0.0.1:7410`.
    - `ship.enabled:true` with `autoMerge`.
    - `hindsight.enabled`, `ragflow.enabled`, `teach.enabled` (capture `auto`, autoPromote).
    - `hitl.knowledgeBase:true`.
    - `claude.model` is `claude-sonnet-5-5`.
    - `swarm.autoRun:true`.
  - `control.json` is `{skipOnce:false}`.
  - The ultrathink omp plugin v0.3.0 is enabled in `~/.omp/plugins/omp-plugins.lock.json:8-11`.

## C. Omp host path
- **Registration:** `package.json` has `omp.extensions:["./src/host/omp.ts"]` (lines 32-37).
- **`before_agent_start`** (`omp.ts:1607-1686`):
  - It plans in-process with `planPrompt({host:"omp"})` and a native selector. The selector uses `ctx.model` through `completeSimple`, with no CLI and no extra login (`omp.ts:403-495`).
  - It races the flight for `raceMs=25_000`, inside Omp's 30 s handler cap. On a win it returns `{message:planMessage(ctx)}` with `display:true`.
  - On a loss it returns a `pending` message and later calls `pi.sendMessage(..., {deliverAs:"aside"})` (`omp.ts:1472`).
  - `maxRunMs` is 600 s.
  - The user's prompt is not rewritten; the plan is an added custom message.
- **Under `omp --mode rpc`:**
  - Extensions run with `hasUI` true unless `--no-ui` is passed (`omp://rpc.md:28`). The TUI widgets, the status bar and plan cards mount only when `ctx.mode==="tui"` (`omp.ts:1118,1218`). In RPC the plan reaches the host only as custom-message events.
  - A session with no UI and no session file counts as a subagent and is never planned (`omp.ts:521-529`). So `--no-ui --no-session` disables planning silently.
- **HITL:**
  - The context's addendum tells the agent to call `AskUserQuestion` (`hitl/format.ts:71-74`). Omp's tool is `ask`, which RPC exposes as `extension_ui_request{method:"ask"}`.
  - Only Hermes gets renamed wording (`questionTool:"clarify"`), so it will not be renamed for Omp [INFERENCE: whether the model maps the two names].
  - Answers are not folded back, because that hook (`hooks/answers.ts`) is Claude-only.
  - Questions are structured in `session.json.clarifications[]`: `{id, question, header, why, options[], default, blocking, answer?}` (`hitl/types.ts`). The host can render and answer them itself.

## D. Recommendation: A (host-side planner call)
**Why A:**
1. Plan-only and explicit failure UX are possible. On `skipped` or `view.source==="fallback"` the host decides whether to run the original prompt. Under B, Omp has already started the turn with a "pending, only investigate" note, and the plan arrives mid-run as an aside.
2. B plans on the card's own model, with no thinking-level control. A uses the Claude CLI, so planning is independent of what the card runs.
3. The uplifted prompt is inspectable (`specPath`, `view`) and can be stored on the card.
4. B is already in effect for any `omp` child, because the plugin is enabled globally. It carries hazards here:
   - `swarm.autoRun:true` plus a prompt starting with an SDLC verb (`fix`, `build`, `add`, `write`, `set`, …) spawns a detached AgentSwarm lane. That lane owns the request and suppresses planning (`omp.ts:1572-1600`, `teams.ts:194-208`).
   - Tracker rows get created in Linear and Notion for every prompt.
   - `teach`, `hindsight` and `ship` fire.
5. Changes needed in claude-ultrathink: none. Everything is controllable by env plus control state plus config.

**Neutralising the global plugin under A:**
- Set `ULTRATHINK_UPLIFT=0` in the omp child's env. This blocks planning, but `maybeAutoRun` only checks `swarm.autoRun`, not that variable.
- An XML prompt never matches `isSdlcPrompt` (first word starts with `<`), so no lane spawns.
- Also run the child with a card config (`XDG_CONFIG_HOME`) that sets `swarm.autoRun:false`.

## E. Consuming the uplift result
- **What is in the output:**
  - `context` is markdown: `## Prompt Uplift` header, then `Specification file: <path>`, `Planning model:`, optional degraded notice, optional `## Agent Substrate brief`, lessons and docs, the spec XML (CHANGE_PROMPT etc.), a GoT addendum, `Workflow waves:`, Clarifications (HITL) and `## Ultrathink tracking`.
  - The tracking section tells the agent to invoke the skills `ultrathink-plan` and `ultrathink-kickoff` (`carrier.ts:18`, `output.ts:455-470`). Cards will not have those skills. Control `trackEnabled:false` swaps in `TRACKING_OFF_NOTE`; `ULTRATHINK_TRACK=0` alone does not (`commands.ts:95-107`).
  - `<sid>.xml` holds the full spec. Observed layout (`~/.omp/agent/ultrathink/sessions/01a15446-…xml`):
    - A root tag, one of BUILD/FIX/RESEARCH/CHANGE/UPLIFTED_PROMPT, containing `<ORIGINAL>` (verbatim user text), `SYSTEM_ROLE`, `CONTEXT`, `SCOPE`, `CONSTRAINTS`, `ACCEPTANCE_CRITERIA`, `OUT_OF_SCOPE` and `ASSUMPTIONS` (`src/uplift/fallback.ts` shows the fallback shape).
    - `<GRAPH_OF_THOUGHT>` with `GOAL`, `NODE id kind title` (each with `QUESTION`, `DEPENDS_ON`, `RATIONALE` of 5-8 steps, `CONCLUSION`) and `WORKFLOW/WAVE`.
    - `<ISSUES>` only when tracked, and `<CLARIFICATIONS>`.
- **Recommended omp prompt:**
  - Send the spec XML (`<sid>.xml`, or `session.json.result.xml` plus the injected clarifications) as the prompt. That is "an XML prompt" in omp's terms: agent-swarm's omp hook (`omp/src/hooks.ts:51-52`) classifies it by its `<ORIGINAL>` text, and the ultrathink extension skips it.
  - Optionally prefix one line saying the Graph of Thought is guidance. Do not send `context` raw: it carries the kickoff and skill instructions and the Hermes-style tracking text.
  - Keep the original in the card record, so you can offer "run original" on a skip or fallback. Also store `specPath` and `graphId`.
- **Avoiding double planning:**
  - `decideUplift` skips prompts whose root tag is a ROOT_TAGS member, `uplifted` or `ultrathink` (`detect.ts:5-46`), and prompts referencing `graph ut-<id>-<8hex>` (`detect.ts:14,49-51`).
  - `raw:` bypasses planning; `uplift:` forces it. Slash commands and trivial replies (`ok`, `yes`, `thanks`, …) are skipped.
  - Swarm children: the omp extension skips subagent sessions, and the lane XML or `graph ut-…` reference is skipped. Set `ULTRATHINK_UPLIFT=0` on every omp child so a card's lanes cannot re-plan.

## F. Cost bounds
- **Calls per plan:** 8-11 (1 spec + 1 graph + N node fills with N between `minNodes`=5 and `maxNodes`=8 + 1 HITL). `think` off gives 2. `think` and `hitl` both off give 1. With `claude.concurrency:3` fills run 3 at a time. The Jev calls are extra and cost about $0.00003 each.
- **Bounds:**
  - `think.maxNodes` (≥ minNodes; cannot exceed 8; lower `minNodes` first to go below 5).
  - `hitl.enabled:false` and `hitl.maxQuestions`.
  - `uplift.maxChars` (default 20000) gives a fallback spec above that size.
  - `claude.callTimeoutMs`, `claude.budgetMs`.
  - `claude.model`.
  - `decisions.points:["plan"]`, or `ULTRATHINK_DECISIONS=0`.
- **Per-card opt-out:** prefix `raw:`, or skip the call from the host. Jev's `plan` gate also skips chatter.
- **Per-invocation without touching global config:**
  - Control state in a per-flow `ULTRATHINK_STATE_DIR/control.json`. Fields: `enabled`, `thinkEnabled`, `hitlEnabled`, `trackEnabled`, `engine`, `skipOnce` (`state.ts:23-31`). The state dir also isolates sessions.
  - A card config via `XDG_CONFIG_HOME=<tmp>` holding `<tmp>/ultrathink/config.json` (`config.ts:784`), for `maxNodes`, timeouts and `swarm.autoRun`. Pair it with `ULTRATHINK_MCP_STORE=<real store>` so stored credentials still resolve (`mcp/store.ts:44-47`). `CLAUDE_CONFIG_DIR` also moves `~/.claude/ultrathink.json`, but the `claude` child inherits it too, so avoid it.
  - A `<cwd>/.claude/ultrathink.json` project file also works as a repository-controlled layer, which restricts consent keys (`config.ts:745-773`). Writing it into the user's repo is not recommended.
  - Env flags.
- The options for passing a config object (`PlanOptions.config`, `stateDir`, `control`) are in-process only (`plan.ts:65-87`). The JSON entry cannot take them.

## G. Substrate overlap
Inside the planner (`src/substrate/brief.ts`):
- **Brief:** `POST <url>/brief` with `{repo, branch, graph_id, surface}` and `Authorization: Bearer $SUBSTRATE_TOKEN`. The text response is inserted verbatim as `## Agent Substrate brief` ahead of the spec. Timeout 1.5 s (`SUBSTRATE_TIMEOUT_MS`).
- **Event:** after a non-fallback plan with a persisted record and a non-`unknown` session id, `POST <url>/events` with `{kind:"note", summary:"ultrathink planned graph <id> (N nodes)", surface:<host>, session_id:"<sid>:<graphId>", graph_id, repo, branch, payload:{ultrathink:"plan", nodes, host, skill?}}` (`hook.ts:374-412,857-868`). No prompt text is sent.
- **URL:** `SUBSTRATE_URL` wins over `substrate.url`. `SUBSTRATE_DISABLED=1` turns both off. Both fail open.
- **To avoid duplication:** OpenFlow should not re-emit a plan-created note. It should add its own card and run events (start, end, result) and read briefs for non-plan contexts. Note `surface` will read `prime-agent`, or whatever host is claimed, unless substrate tolerates it [INFERENCE]. Use the same `session_id` as the card's Omp session so the trail joins.

## H. Risks
1. **The global ultrathink omp plugin** double-plans, auto-spawns swarm lanes (this machine has `swarm.autoRun:true`), creates tracker rows and runs teach, unless neutralised in the omp child. See D and E.
2. **Tracker side effects through A:** this machine's config creates Linear and Notion rows for every card prompt, and `ship`, `hindsight`, `ragflow` and `teach` also fire. Set `control.trackEnabled:false`, `ULTRATHINK_SHIP=0`, `ULTRATHINK_HINDSIGHT=0`, `ULTRATHINK_RAGFLOW=0` and `ULTRATHINK_TEACH=0` for cards.
3. **Wrong host:** `host:"omp"` gives `native-unavailable`; an unknown host gives `unsupported-host`.
4. **Unbounded runtime:** the defaults are 0 for `claude.callTimeoutMs` and `claude.budgetMs`, so the host must kill the process group at its own deadline.
5. **Singleton carriers:** `last.json` and `last-plan.json` are overwritten across concurrent cards. A repeat `session_id` overwrites that session's record.
6. **Quoted tool name:** the HITL text names `AskUserQuestion`, not Omp's `ask`. Prefer rendering `clarifications[]` in OpenFlow UI.
7. **Misleading success flag:** `source` appears only in `view.source`, so a caller that checks only `context !== ""` treats fallback as success.
8. **Large output:** the response can exceed 128 KiB, so read stdout to EOF.
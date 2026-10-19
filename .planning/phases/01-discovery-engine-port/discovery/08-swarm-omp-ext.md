**A. Launch recipe** (read-only investigation; I had no shell, so nothing was executed, and omp CLI flags are taken from omp docs, not `--help`)

Two separate Swarm execution paths exist. Only the first fits a card.
1. In-session: the extension is loaded into the card's omp, and `/swarm` plans, then dispatches A01 via the `task` tool (omp/src/commands.ts:237-299).
2. `scripts/swarm_run.py --runtime omp`: a headless runner that spawns `omp -p --mode json --no-title -e <ROOT>/omp --cwd <repo> --approval-mode write --tools … --append-system-prompt $SWARM_DIR/agents/<slug>.md --max-time Ns`, prompt on stdin (swarm_run.py:439-443). That is a different process model; it is not what a card runs.

Card argv (inference from the docs below):
`omp --mode rpc --no-ui -e /root/src/repos/agent-swarm/omp --config <per-card-overlay.yml> [--cwd <card dir>]`

- **Loading.** `-e <dir>` loads `omp/package.json` `omp.extensions: ["./src/index.ts"]`. omp discovers task agents from `<extension-root>/agents` for explicit `-e` roots (omp://task-agent-discovery.md:154-155). So `omp/agents/a01…a15.md` is found with no install. The skills, tools and `.mcp.json` of an `-e` package are also discovered (omp://extensions doc, line 102). `-e` is loaded in addition to any project `extensions:` list (this is where `--no-extensions` becomes relevant).
- **Installed-workspace alternative.** `build_agents.py --install-workspace <ws> [--runtimes omp]` merges the package realpath into `<ws>/.omp/config.yml`, but only the cwd's project config is read. It also refuses a workspace equal to `$HOME` or inside `~/.omp`, and writes `.mcp.json` plus env files (_install_omp.py:5-8, AGENTS.md:150). **Do not use it per card.** Use `-e`.
- **Runtime root.** `swarmRoot()` uses `SWARM_ROOT` if `<it>/scripts/orch_plan.py` exists, else the package's repo (bridge.ts:56-61). Because `-e` points at the checkout's `omp/`, no env var is needed. Set `SWARM_ROOT=<checkout>` only for a relocated package. `ULTRATHINK_SWARM_ROOT` appears nowhere in agent-swarm (grep of omp/src, swarm/, scripts/ found no match). Verify it is not a claude-ultrathink-side variable.
- **python3.** Required. Every tool and `/swarm` spawns `python3 <root>/scripts/<x>.py … --json` with `cwd=<root>` (bridge.ts:117-128). The scripts are stdlib-only. Ed25519 needs the `cryptography` package, otherwise the key fails to load and signing fails closed (envelope.py:169-176). `bun` is needed only for the TS twins and `bun test`.
- **State dir.** `SWARM_DIR` (made absolute), else `<git toplevel of cwd>/.swarm`, else `<cwd>/.swarm` (paths.ts:15-19). For a card in a git worktree this is that worktree's own `.swarm`. To get one Task Store per workflow run, set `SWARM_DIR=<run dir>/swarm/<cardId>` (or one per run), outside the worktree, with an absolute path.
- **Per-session config without touching user config.** `--config <file>` is a repeatable overlay for the run (omp://cli-reference.md:78). Precedence is flags > `--config` > project > global (omp://approval-mode.md:166). Overlay content:
  ```yaml
  task:
    maxRecursionDepth: 2   # default; 3 only if A01 is itself spawned by a subagent. Never negative.
  ```
  Isolation must be off, because isolated worktrees would split the Task Store (AGENTS.md:152). Current key is `task.isolation.enabled: false` (omp://settings.md:1037-1038; the legacy `mode: none` is migrated). RPC mode already pins neutral protocol defaults for task isolation/execution, and explicit config or `--config` stays authoritative (omp://rpc.md:30). Setting `enabled: false` in the overlay anyway is cheap and explicit. Depth 2 is correct for main → A01 → specialists. Specialists never get `task`.
- **Signing env, set in the card process env.** One of:
  - `SWARM_ED25519_KEY_FILE=<absolute path>` (preferred; python reads it only outside agent sessions, envelope.py:177-186)
  - `SWARM_ED25519_KEY`
  - `SWARM_SIGNING_KEY` (HMAC)
  - Optionally `SWARM_REQUIRE_KEY=1`.

  The orchestration tools run inside the card's omp process, so they need these. The headless runner strips them from children (swarm_run.py:107-110), but the in-session path does not.
- **Absent keys: fail-closed.** `/swarm` calls `orch_plan`, which raises E-POLICY from `signing_config_error()` (orch_plan.py:312-315). `/swarm` then refuses with "dispatch refused: canonical orch_plan did not authenticate an execution assignment" unless `execution_assignment_verified === true` (commands.ts:75-78, 277-278). `SWARM_ALLOW_INSECURE_DEV_KEY=1` is the only unsigned path. **Never set it.** The `agent-swarm-omp-signing-preflight` skill says missing signing blocks OMP specialist dispatch entirely, that there is no advisory fallback for OMP, and that no key file may be read or generated.
- **Disk writes into the cwd or repo.**
  - `<SWARM_DIR>/` holds tasks.db, plans/, assignments/, results/, verdicts/, events.jsonl, live.json, swarm-state.json and a `.gitignore` containing `*` (bridge.ts:99-104). It is self-ignoring but still creates a directory in the worktree unless `SWARM_DIR` is moved.
  - **Pollution (`/swarm` only):** it runs `get_swarm_state_store(root=ctx.cwd)`, which writes **`<cwd>/.claude/swarm-state.json`**, not ignored (state_store.py:85-91, 134-135). It also appends `swarm: …` lines to **`<cwd>/.planning/STATE.md` if that file exists** (state_store.py:154-161). `swarm_plan`, the tool, does not do this; only the `/swarm` command does.
  - The extension never writes `.omp/`; the installer does.
  - Specialists with a worktree-based plan create branches `swarm/<prefix>/<id>` and worktrees (AGENTS.md:33).
  - The guard hard-blocks writes to `.swarm/` and `.omp/` by raw write/edit in swarm sessions.

**B. Triggers and defaults**
- **HOOK-01** (hooks.ts:117-141) runs in `before_agent_start`, only for a top-level session with no agent. It is skipped when `SWARM_CHILD=1` or `SWARM_AGENT` is non-empty. It only appends a hint to `systemPrompt`: it never forces or blocks. The hint tells the model to run `/swarm <brief>` or call `task` with `agent: "a01-orchestrator"`.
- **Classifier** `classifyPrompt` (hooks.ts:38-44). It returns false for:
  - empty text
  - a leading `/`
  - a leading `<system-reminder`
  - the `[agent-swarm:dispatch]` marker
  - any of `/uplift`, `/think`, `explain only`, `/all-in-one:`
  - text ending in `?`, a leading question word, or typo/rename

  Otherwise it is true when the text matches `\b(build|implement|add|create|fix|refactor|migrate|deploy|release|ship|write tests?|set up|setup|integrate|scaffold|upgrade|orchestrate)\b`. `/gsd-autonomous` is a special case with its own hint.
- **Uplift XML.** `classifiedText` extracts the unescaped `<ORIGINAL>…</ORIGINAL>` only if the prompt starts with a root tag matching `BUILD_PROMPT|FIX_PROMPT|RESEARCH_PROMPT|CHANGE_PROMPT|UPLIFTED_PROMPT|uplifted|ultrathink` (hooks.ts:50-51, 74-95). Otherwise the whole XML is classified, and the SDLC regex will almost certainly match words in the template. [INFERENCE] Confirm the roots claude-ultrathink actually emits, or OpenFlow's wrapper will cause the hint on nearly every card prompt.
- **Explicit trigger via RPC.** Send `{type:"prompt", message:"/swarm <brief> --pattern=feature|hotfix|dependency|parallel --risk=low|medium|high"}`. Defaults are feature/medium. The syntax uses `=`, not a space (commands.ts:22-35).
  - It refuses if not top-level or in plan mode.
  - `ack` returns on admission, and `prompt_result` arrives after the handler returns.
  - With `ctx.hasUI` false (`--no-ui`), the handler holds until A01's turn ends: `SWARM_DISPATCH_HOLD_MS` unset means unbounded (commands.ts:216-221). Set a cap such as 30 min.
  - The correlation id is a uuid5 of (pattern, risk, brief), so an identical brief reuses the plan.
- **Recommended default: `off` for ordinary cards.** Do not load `-e` at all, so there is no hook, no hint, no pollution, and no signing need. Use `auto` (load the extension, leave HOOK-01 alone) only for cards flagged "swarm-capable". Use `always` (OpenFlow rewrites the card prompt into `/swarm <ORIGINAL>`, skipping the classifier) only for orchestrator or implement cards with a configured signer. **Per-card override** is a card field `swarm: off|auto|always` mapped to:
  - `off`: omit `-e`. (Alternative: `SWARM_CHILD=1` suppresses the hook, but it also makes python treat the process as an agent session and skip signing, which breaks `/swarm`.)
  - `auto`: `-e` only.
  - `always`: `-e` plus the first prompt `/swarm …`.

**C. Conflicts: which sessions the rules bind**
`inSwarm()` (guard.ts:66-69) is true when:
- the session's `session_init.agent` is one of the 15 slugs (A01 and specialists spawned via `task`), or
- the session is top-level and env `SWARM_AGENT` or `SWARM_TASK_ID` is non-empty.

So a card top-level session without those env vars is **not** a swarm session. HOOK-02 (bash rules), the MCP block and the eval block do not apply to it. A01 and the specialists it spawns in-process are swarm sessions. They share `process.env`, and env is consulted only if there is no session_init. **OpenFlow must not set `SWARM_AGENT` or `SWARM_TASK_ID` on a card process**: doing so puts the card itself under the guard and disables HOOK-01.

Rules that apply everywhere, including a card's top level:
- HOOK-04: A01 without `task` can only yield BLOCKED/depth (guard.ts:107-110).
- HOOK-03: `swarm_transition` and `swarm_ingest` are A01-only.
- `swarm_assignment` is A01-only and refuses in plan mode.

Inside swarm sessions (A01 and specialists):
- `eval` is blocked.
- Writes to `xd://run_code` or `xd://debug` are blocked.
- **Any `mcp__*` tool is blocked** (guard.ts:125-127) except the substrate API allowlist, and only when `SWARM_SUBSTRATE_AGENT === the calling agent`, `SUBSTRATE_TOKEN` is set and `SUBSTRATE_DISABLED != 1` (guard.ts:97-104). That marker is set only by `swarm_run.py` for one agent per process. So in-session specialists effectively **cannot use the substrate MCP** or the OpenFlow dispatch/finish MCP tools. The card's top level (non-swarm) can.
- Bash rules (HOOK-02) cover: writes to `.swarm`/`.omp`, gate scripts, `rm -rf` of protected paths, nested `claude`/`grok`/`omp -p`, `git push --force`, `git reset --hard`, `git clean -f`, destructive branch deletes, shell/interpreter stdin, the `a11`/`a12`-scoped prod, release and publish rules (including pushes to protected branches and tags, `gh pr merge`), and DDL for A07.

Plain bun, git (non-forced, non-protected), tests, build and lint commands are not matched by the rule ids I enumerated (guard.ts:2100-2484). I did not run any sample commands, so confirm against the rule list for the card's specific commands.

For orchestrator cards: keep the OpenFlow dispatch/finish tools on the top-level card session, which is not guarded. Do not expect A01 or specialists to call them.

**D. Progress schema**
- `<SWARM_DIR>/live.json` is `swarm.live.v1` (swarm/schemas/swarm.live.v1.json).
  - Top level: `schema, correlation_id, seq, updated_wall, producer ("scheduler"|"derived"), pid, producer_updated, swarm, runs[≤64]`.
  - `swarm`: `state, elapsed_s, max_parallel, effective_parallel, running, queued, waiting, completed, failed, cancelled, timed_out, stalled, degraded`.
  - Each run: `run_id (<task>.a<N>), task_id, agent, state ∈ waiting|queued|starting|running|handing_off|completed|failed|cancelled|timed_out, attempt, elapsed_s, state_elapsed_s, since_activity_s, stalled, activity, tool_calls, last_tool, parent, handover_in/out, error`.
  - It is rewritten atomically, at most 1/s. Older than 3× `SWARM_HEARTBEAT_S` (30 s) means stale. `elapsed_s` is producer-monotonic; extrapolate with your own clock.
  - In-session runs have no scheduler process. `TaskStore.transition` triggers a **derived** snapshot, so it is coarse (task states, little activity). Rich activity exists only with `swarm_run.py`.
- `<SWARM_DIR>/events.jsonl` is `swarm.event.v1`: `{ts, type, source, correlation_id, task_id, payload, msg_id}`. Types: `swarm.run.{queued,started,state,activity,heartbeat,stalled,finished,handover}`, `swarm.scheduler.tick`, `swarm.degraded`, `swarm.tool.call`.
  - `swarm.run.finished.payload.outcome` is `completed|failed|cancelled|timed_out`.
- Other files: `results/<tid>.a<N>.md` (headless runner output), `plans/<corr>.json`, `latest_correlation`, `tasks.db` (state machine), `cancel/<corr>` flag.
- Use **SWARM_DIR per card** (or per run if you want a joined view). A shared Task Store across cards would also share `latest_correlation`.
- Mapping to a card status line:
  - queued = `swarm.queued + waiting`
  - running = `swarm.running`, with per-agent rows from `runs[].agent / activity / last_tool`
  - done = `completed`
  - failed = `failed + timed_out`
  - cancelled = `cancelled`
  - stalled = `stalled`
  - Staleness: treat `now − updated_wall` greater than 30 s with no live process as stale.
  - Task states in tasks.db: CREATED…DONE, BLOCKED, FAILED, RETRY, CHANGES_REQUESTED, ESCALATED, CANCELLED.
- omp-side events over RPC:
  - Send `{type:"set_subagent_subscription", level:"progress"|"events"}`; default is off (omp://rpc.md:156, 998-1003).
  - Frames: `subagent_lifecycle`, `subagent_progress`, `subagent_event`. Commands: `get_subagents`, `get_subagent_messages`, `cancel_subagent`, `steer_subagent`.
  - A01's in-flight `task` call surfaces specialists one level deep as `inflightTaskDetails` in A01's progress frame (this is what the bar uses; AGENTS.md "Swarm bar").
  - I did not find exact frame field names in rpc.md (grep returned nothing; they are schema-listed around lines 1586-1593). Read the schema before parsing them.

**E. Cancel and cleanup**
- RPC `abort` stops the session's turn. The session's `session_shutdown` handler group-kills in-flight python children: SIGTERM, then SIGKILL after 3 s (bridge.ts:131-136; index.ts shutdown). Bridge python children are `detached`, with their own process groups.
- A `swarm_run.py` runner (not in the card path) handles SIGINT/SIGTERM/SIGHUP and `--swarm-timeout`: it writes `<swarm_dir>/cancel/<corr>`, waits `min(SWARM_CANCEL_GRACE_S, SWARM_SHUTDOWN_BUDGET_S−8)` (7 s by default), then SIGTERMs the session groups, SIGKILL after 5 s, exit 128+signal (AGENTS.md; runbook:185).
- In-session specialists are in-process `task` children: `cancel_subagent` plus `abort` end them. Closing stdin makes omp drain commands, dispose the session and exit 0 (omp://rpc.md:33). Prefer `abort`, then close stdin, then SIGTERM to omp, then SIGKILL as the last resort.
- Orphan risks:
  - A SIGKILL of omp bypasses `session_shutdown`, leaving detached python bridge children that live up to their 600 s default timeout.
  - SIGTERM to a bare PID, not the group, leaves them.
  - Tasks left IN_PROGRESS after a kill stay leased in tasks.db and are retried only by a later run.
- Recommendation: spawn each card's omp in its own process group and kill the group.

**F. Substrate identity**
- The swarm tee/lease code (swarm/substrate_tee.py, substrate_lease.py) is fail-open. With no `SUBSTRATE_URL` or `SUBSTRATE_DISABLED=1`, nothing is sent.
- Runner sessions get exactly their own agent's token from `${XDG_CONFIG_HOME:-~/.config}/agent-swarm/agents/<sha256(workspace realpath)[:16]>/<slug>.env` (dir 0700, file 0600, exactly `SUBSTRATE_TOKEN=<token>`). The child env drops every `SUBSTRATE_TOKEN*` and `SUBSTRATE_OPERATOR_TOKENS` (workspace.py:47-50, 408-418). The `substrate` MCP entry lives in `<ws>/.mcp.json`.
- `--install-workspace <ws> --runtimes omp` needs `SUBSTRATE_TOKEN_<SURFACE>` per agent in the installer env. It exits 2 with nothing written if any is missing or if the env dir is inside any git checkout.
- **OpenFlow must NOT:**
  - hand the card its own `SUBSTRATE_TOKEN` or the operator token as if it were A01's. In-session python tools (bridge env = `process.env`, bridge.ts:117) and `substrate_client._token()` fall back to `SUBSTRATE_TOKEN` (substrate_client.py:61-67). Swarm run-log events would then be attributed to the card's identity, not the agent surfaces; the tee docs say a token not belonging to the attributed agent is misattributed or refused (substrate_tee.py:423-426).
  - set `SUBSTRATE_TOKEN_<SURFACE>` vars in a card env.
  - install into `$HOME`, `~/.omp` or per-card throwaway worktrees.
- Card identity: the card's top-level omp holds the card's own substrate identity (an OpenFlow-level surface). Only in-session A01/specialists run under the swarm identities, and as stated in C they cannot call MCP in-session. To get per-agent substrate identity, the swarm needs the headless runner path (`swarm_run.py --runtime omp`), where each session has its own token and `SWARM_SUBSTRATE_AGENT=<slug>`. Decide whether the card uses `/swarm` in-session or launches `swarm_run.py` as a child.
- Env files are readable by every process of the same OS user, so identities are attributable but not unforgeable (substrate-workspace.md:138-145).

**G. Required changes in agent-swarm**: none required. Flag only:
1. `/swarm` writes `<cwd>/.claude/swarm-state.json` and appends to `<cwd>/.planning/STATE.md`, with no opt-out. This pollutes a card worktree. Workaround: drive `swarm_plan` and `task` yourself instead of `/swarm`, or accept the pollution.
2. The in-session path has no per-run `SWARM_DIR` isolation mechanism beyond the env var; this is workable.

I recommend no change inside agent-swarm.

**H. Risks**
1. **Signing key in the card env.** In-session specialists share `process.env`. Prefer `SWARM_ED25519_KEY_FILE` (an absolute path) over a raw key. Verify `SWARM_SIGNER_DENY_PATHS` and the guard's signer-file read rules cover the path (guard.ts:2128-2148). A raw `SWARM_ED25519_KEY` would be visible to bash children.
2. HOOK-01 will fire on most uplifted prompts if the XML root tags differ from the allowlist.
3. With `--no-ui` the `/swarm` hold is unbounded, so set `SWARM_DISPATCH_HOLD_MS`.
4. `-e` plus the project's own `.omp/config.yml` `extensions:` can load the package twice. AGENTS.md says never add both `.omp/extensions/` and a symlink. Use `--no-extensions` plus explicit `-e` for determinism.
5. The shell guard is regex-based; it can over-block (it blocks `git push` to protected branches for a12 only) and has a known evasion residual (guard.ts:211-212).
6. Plan mode in the card makes `/swarm` and most tools refuse.
7. Unverified: the exact RPC frame field names for subagent events, and omp's `--no-ui` / `-e` behaviour in v18.12.2 beyond the docs.
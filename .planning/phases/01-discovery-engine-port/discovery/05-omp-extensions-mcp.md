Method: `read`/`grep` on omp:// docs only. I had no shell, so `omp --help`, `omp plugin --help` and `omp config --help` were NOT run. Flags below come from omp://cli-reference.md. Tool results truncated some pages, so anything I could not see is marked [INFERENCE].

## A. Extension loading under `--mode rpc`
- **Per-session load:** `omp --mode rpc -e <path>` or `--extension <path>`, repeatable (cli-reference.md:154).
  - `-e` accepts a `.ts/.js/.mjs/.cjs` file or a directory (extension-loading.md:~100-140).
  - A directory resolves in this order: `package.json#omp.extensions` (legacy `pi.extensions`), then `index.ts`, then `index.js`, then a one-level scan.
  - Paths are resolved against cwd, with `~` and `file://` supported.
- **Ambient extensions:** `--no-extensions` turns off ambient discovery (`<cwd>/.omp/extensions`, `~/.omp/agent/extensions`, settings `extensions:`, installed plugins). Explicit `-e` still loads (extension-loading.md:~190). Use it for deterministic cards.
- **Strict alternative:** `--trusted-extension <absolute-file>` is an exact allowlist. It cannot be combined with `-e`, and a load failure aborts startup (extension-loading.md:~200).
- **Module shape:** the module exports `default function (pi: ExtensionAPI)`, which may be async. `pi.zod` is available for schemas (extensions.md quick start).
  - The factory is Bun-imported, so TS works with no build step.
  - Imports of `@oh-my-pi/pi-coding-agent` types resolve through compat shims.
- **Load-time constraint:** calling `pi.sendMessage` and similar during the factory throws `ExtensionRuntimeNotInitializedError`. Only register there.
- **Failure behavior:**
  - Import errors, a non-function export, or a throwing factory are captured per path as `{path, error}`. The other extensions and the session still start (extension-loading.md:~290-300).
  - A failed factory's provider registrations are rolled back.
  - The exact "Failed to load extension" string was not found in the docs. Whether it reaches RPC stdout or only stderr is unverified. [INFERENCE]
  - Runtime handler errors are emitted as RPC `{type:"extension_error", extensionPath, event, error}` (rpc.md:89).
  - A `--trusted-extension` failure aborts startup.
- **What runs under rpc:**
  - **Context:** `ctx.mode` is `"rpc"`. `ctx.hasUI` is true for `--mode rpc` and false with `--no-ui` (extensions.md:346,1047-1067).
  - **UI calls:** `select`/`confirm`/`input`/`editor` round-trip as `extension_ui_request` frames. `notify`, `setStatus` and `setWidget` are fire-and-forget. `custom` and `onTerminalInput` are unsupported. With `--no-ui`, dialogs resolve to defaults. Use `--mode rpc --no-ui` for unattended cards.
  - **Event hooks fire normally:** `input`, `before_agent_start`, `context`, `tool_call`, `tool_result`, `assistant_message`, `turn_*`, `agent_*`, `session_*`, `before_subagent_spawn`.
  - **`input`:** the RPC `prompt`, `steer`, `follow_up` and `abort_and_prompt` commands carry `source: "rpc"` (extensions.md:~522). It runs at ingress, before slash-command interpretation.
  - **`before_agent_start`:** it fires per prompt, or per dequeued steer/follow-up batch. It can override the system prompt or append custom messages (extensions.md:501-512). Handlers must tolerate re-entry, with up to 3 attempts.
  - **`tool_call` guards:** return `{block:true, reason}`. Handler error or timeout fails closed (default 30 s, `extensionHandlers.toolCallTimeoutMs`). They can also return `additionalContext`.
  - **Slash commands:** `pi.registerCommand("name", {handler})` is invoked by sending `prompt` with message `/name args`. An extension command is acknowledged on admission with no model turn. The response carries `data.agentInvoked:false` if it finishes locally, otherwise a `prompt_result` frame follows (rpc.md:119-120, 315, 329).
  - **Command discovery:** an `available_commands_update` frame is emitted at startup (rpc.md:90). Pi's `get_commands` is not served.
- **Prompt Uplift:** the host can uplift text before it sends the RPC `prompt`. Alternatively an `input` handler can transform text in-process (returns replace `text` and `images`, extensions.md:524). Host-side uplift is simpler and keeps Jev decisions in one place. [INFERENCE: recommendation]

## B. Custom tools vs MCP
Three mechanisms, ranked.

1. **RECOMMENDED: RPC host tools (`set_host_tools`).** No extension and no MCP server are needed. `dispatch`/`finish` execute in the OpenFlow host, which already owns the child process.
   - Send once after `ready`:
     `{"id":"t1","type":"set_host_tools","tools":[{"name":"dispatch","label":"Dispatch","description":"…","parameters":{<JSON Schema object>}},{"name":"finish",…}]}`
   - The response is `{"toolNames":["dispatch","finish"]}` (rpc.md:735-775). Tools are registered before the next model call, and new non-hidden tools are auto-enabled.
   - Calls arrive on stdout as `{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_…","toolName":"dispatch","arguments":…}`. The `arguments` field name is [INFERENCE]; rpc.md:1314-1324 is partly truncated, so check it.
   - The host answers on stdin with `{"type":"host_tool_result","id":"host_1","result":{"content":[{"type":"text","text":"…"}]}}`.
     - Streaming progress: `host_tool_update` with `partialResult`.
     - Errors: top-level `isError:true`.
     - Cancellation: the host receives `host_tool_cancel {targetId}` (rpc.md:1305-1358).
   - Tool names are unique and must not collide with a non-host tool.
   - `loadMode` defaults to `"discoverable"` for non-essential names. With `tools.xdev` they may be mounted under `xd://`; set `loadMode:"essential"` so they stay top-level (rpc.md:~771; custom-tools.md:173).
   - Name them plainly (`dispatch`, `finish`).
   - In message history they appear as ordinary `toolCall` content blocks. The stream shows `tool_execution_start/update/end` events, and `message_update` carries `toolcall` deltas (rpc.md:830, 872).
   - `set_host_tools` can be re-sent mid-session to swap per-card tool sets.
   - Caveat: host tools are registered after startup, so confirm they pass a `--tools` allowlist (see C).

2. **Extension tool (`pi.registerTool`) shipped in packages/flow and loaded via `-e`.**
   - Template (extensions.md:~690):
     `pi.registerTool({name, label, description, parameters: z.object(...), async execute(toolCallId, params, signal, onUpdate, ctx){ return {content:[{type:"text",text}], details:{...}} }})`
   - Throwing means `isError` in the tool result.
   - Optional fields: `hidden`, `defaultInactive`, `loadMode`, `strict`, `approval` (default `"exec"`).
   - The module is in-process with omp, so it still needs a channel back to the OpenFlow host.
     - `pi.exec` and `fetch` are available.
     - The extension could call a host HTTP endpoint.
     - That is more moving parts than option 1.
   - Restricted subagent children do not admit extension tools, which is fine for orchestrator cards.
   - Use this only if you want the tool logic to travel with omp, or want `tool_call` guards beside it.

3. **MCP stdio server.**
   - Per-session options:
     - `.omp/mcp.json` or `.mcp.json` in the cwd (writes into the worktree).
     - `~/.omp/agent/mcp.json`, or a `--profile` copy at `~/.omp/profiles/<name>/agent/mcp.json`.
   - Key shape: `{"mcpServers":{"flow":{"type":"stdio","command":"bun","args":["…"],"env":{…}}},"disabledServers":[…],"enabledServers":[…]}` (mcp-config.md:67-100).
   - **`--config <file>` is a settings overlay, not an MCP config.**
     - It is YAML (`config.yml` style), repeatable, and a hard error if invalid (config-usage.md:177, 297-308).
     - The settings listed there are `mcp.enableProjectConfig` (and `disabledServers`/`enabledServers` in the user mcp.json). I found no evidence that an overlay can carry `mcpServers`.
   - Other per-run vectors:
     - `--plugin-dir <dir>` (an Agent Plugin with `plugin.json` plus root `mcp.json`, mcp-config.md:44 and plugin-manager-installer-plumbing.md:212).
     - OMP extension packages passed via `-e <dir>`. Sibling capability roots stay eligible (extension-loading.md:~180). Whether that includes `mcp.json` is [INFERENCE].
     - Neither was verified for `--plugin-dir` MCP.
   - Tool naming: `mcp__<server>_<tool>`, lowercased, sanitized, hash-capped at 64 characters (mcp-runtime-lifecycle.md:141-143).
     - It may be mounted under `xd://` rather than top-level (:145).
     - The model sees long names such as `mcp__flow_dispatch`.
   - Headless startup is racy: print mode waits for tool handshakes (`OMP_MCP_TIMEOUT_MS`, default 30 s). Whether RPC waits is unverified. `OMP_MCP_REQUIRE_READY=1` exists.
   - It needs a separate process per card.
   - **MCP discovery is skipped when tool names are restricted** (mcp-runtime-lifecycle.md:36; sdk.md:310-312). That is the SDK `restrictToolNames` option, not necessarily CLI `--tools`.

**Recommendation:** use host tools for `dispatch`/`finish`. Use `-e packages/flow/…/omp-card-ext.ts` only if you also need hooks (a bash guard, `before_agent_start` context from agent-substrate). Avoid MCP for orchestration tools. MCP is only worth it for substrate/swarm servers that already exist as MCP, and it is per-cwd or per-profile config, not per-run.

## C. Role and tools mapping
- **Role prompt:** `--system-prompt <text|file>` replaces the default coding prompt (cli-reference.md:167). `--append-system-prompt <text|file>` appends (:169). `--system-prompt-template <path>` is a Handlebars template and is mutually exclusive with `--system-prompt`.
  - Role prompts normally want `--append-system-prompt`. That keeps omp's tool guidance.
  - Replacing the prompt drops it. A replaced prompt may also drop MCP/skill guidance.
- **Tool toggles:** `--tools read,grep,glob,edit,write,bash,task,…` is a comma allowlist (default all). `--no-tools` disables all built-ins, `--no-lsp`, `--no-pty`.
  - Built-in names confirmed in custom-tools.md:171: `read, write, bash, edit, glob, find, eval, task, wait, learn, manage_skill, context_notes, new_context`. Also seen: `grep`, `ast_edit`, `web_search`, `ask`, `recall`/`reflect`/`memory_edit` (memory backends).
  - `--tools` validates names against the fully discovered registry, including custom tools. Unknown names and unavailable built-ins give distinct errors (custom-tools.md:174).
  - **Verify:** when `--tools` is set, does it keep host and extension tools active, and does it trigger the restricted-session behavior that drops MCP/extensions/LSP (sdk.md:310)? Not determinable from the docs. [INFERENCE: probe with one `set_host_tools` call plus `--tools read`.]
  - The runtime auto-appends `write` for device mounts or deferrable tools unless restricted (resolve-tool-runtime.md:47-49).
- **Subagents:**
  - Omit `task` from `--tools` to forbid spawning.
  - The recursion cap is `task.maxRecursionDepth` (default 2; negative disables). Set 0 or 1 via `--config card.yml` (tools/task.md:175).
  - Also available: `task.maxConcurrency` (default 32), `task.maxRuntimeMs`, `task.agentIdleTtlMs`.
  - The `before_subagent_spawn` hook can block or reroute spawns.
- **Skills:** `--no-skills` disables discovery. `--skills <globs>` filters. Use `--no-skills` unless the role needs them.
- **Rules:** `--no-rules`. Context files have no CLI off-switch. Disable them via settings `disabledProviders`, or `disabledExtensions: ["context-file:project:AGENTS.md"]` (context-files.md:308; extension-loading.md:~215). Whether `disabledProviders` is the exact key name is [INFERENCE]; context-files.md:306 mentions it.
- **AGENTS.md from a worktree cwd:**
  - Discovery walks from cwd up to the repo root. Native `.omp/AGENTS.md` comes from the nearest non-empty `.omp/`, and other providers (AGENTS.md, CLAUDE.md) are read per depth.
  - The worktree is a checkout, so the target repo's AGENTS.md/FLOW.md-style files are injected into every card's context. Disable them per card if the role prompt must be exclusive.
  - A linked worktree does not see the primary checkout's copies (context-files.md:309).
  - The user-level `~/.omp/agent/AGENTS.md` also loads unless isolated by `--profile`.
- **Memory:** RPC pins neutral defaults, including memory off, for settings declaring a `protocolDefault`. Explicit config still wins (rpc.md:~35). `memory.backend` defaults to `off` (memory.md:117, 176). Cards need no flag, but set `memory.backend: off` in a `--config` overlay to be safe against a user-level `local`/`mnemopi`/`hindsight` backend.
- **Other flags worth pinning:** `--no-title` (RPC already sets `PI_NO_TITLE=1`), `--approval-mode yolo` or `--auto-approve` (unattended; otherwise tools wait for approval requests), `--model`, `--thinking`, `--max-time`.
  - `ask` is registered only when a prompt surface exists. With `--no-ui` it throws, which is good for unattended cards.
  - Fallback: if the host does not answer `extension_ui_request`, dialogs hang.

## D. Subagent visibility
- Forwarding is off by default. Send `{"type":"set_subagent_subscription","level":"off"|"progress"|"events"}` (rpc.md:156, 998-1002).
  - `progress`: `subagent_lifecycle` and `subagent_progress` frames.
  - `events`: also full `subagent_event` frames, with full `message_update` snapshots; the `set_event_filter` delta projection does not apply to them (rpc.md:878).
  - The exact frame fields are not in the pages I could read. [INFERENCE] The lifecycle statuses include `"aborted"` (rpc.md:1022).
- `get_subagents` returns a registry snapshot sorted by index and id; entries are `running|idle|parked|aborted` (tools/task.md:Source).
- `get_subagent_messages {subagentId | sessionFile, fromByte}` returns `{sessionFile, fromByte, nextByte, reset, entries, messages}`. This is incremental transcript tailing (rpc.md:1006-1015).
- `cancel_subagent {subagentId}` returns `{cancelled:bool}`. `steer_subagent {subagentId, message}` runs the message through the subagent's `prompt()`.
- The parent `task` tool result carries `details.progress[]` and an `async: {state, jobId}` field. Results arrive as async-result injections (tools/task.md:74-76).
- **Verdict:** yes, the host can show subagent progress as a tree. Set `progress` or `events`, and call `get_subagents` for hydration after reconnect.

## E. Sessions and isolation
- **Persistence:** `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl` (session.md:42). Subagent transcripts and artifacts live in a sibling directory named after the session (confirmed on disk under `/root/.omp/agent/sessions/-src-repos-autonogrammer/<ts>_<id>/…`). Terminal breadcrumbs go to `~/.omp/agent/terminal-sessions/`.
- **Controls:**
  - `--no-session` is ephemeral. It cannot combine with `--continue/--resume/--restore/--fork`.
  - `--session-dir <dir>` (or env `PI_CODING_AGENT_SESSION_DIR`) relocates storage.
  - `--profile <name>` or `OMP_PROFILE` gives an isolated user base `~/.omp/profiles/<name>/agent` (config, extensions, skills, MCP, rules, AGENTS.md, sessions, `agent.db`; config-usage.md:76-88).
    - It is not isolated from project `.omp/` and `.claude/` in the cwd, nor from `~/.claude`/`~/.codex`/`~/.gemini`.
    - `PI_CODING_AGENT_DIR` is ignored for named profiles.
    - A new profile has no credentials. Log in again, or provide `OPENROUTER_API_KEY` and similar via env.
- **Recommendation for OpenFlow cards:**
  - Use a dedicated profile such as `--profile openflow`, with the settings overlay and the OpenFlow credentials in it.
  - Use `--session-dir <flowdata>/omp-sessions/<runId>` (or `--no-session` for throwaway cards). Keep persistence if resume or the `get_subagent_messages` transcripts matter. Subagent output artifacts are written under the session artifact directory, and `agent://` needs them.
  - Pin `--cwd <worktree>` and `--no-extensions -e <flow-ext>`, `--no-skills`, `--no-rules`.
  - Pass a `--config card.yml` overlay.
  - `--session-id` or resume specifics were not investigated.

## F. Risks
1. **Unknown interplay of `--tools` with host tools.** It is unverified whether `--tools` makes the session "restricted". Restricted sessions drop MCP, extensions and LSP (sdk.md:310). Probe it first.
2. **`--no-extensions` plus `-e`.** The sibling capability roots of the `-e` package remain eligible. A package dir named by `-e` can pull in sibling `hooks/tools/mcp.json`. Use `--trusted-extension` plus a single file for a strict guarantee, but then siblings are excluded and `-e` cannot be combined.
3. **`tool_call` timeout and fail-closed.** A slow guard (30 s default) blocks the tool.
4. **Approval stalls.** Without `--yolo` or `--approval-mode`, tool calls can request approval, and under `--no-ui` this may default-deny. Choose the mode explicitly.
5. **`--system-prompt` replaces everything.** Orchestrator cards lose the omp tool and skills guidance. Prefer `--append-system-prompt`.
6. **Stdout framing.** Frames cap at 1 MiB. Negotiate protocol v2 (`negotiate_protocol`) to avoid truncation of big tool outputs or messages (rpc.md:~60-80). The host must handle `rpc_chunk`.
7. **Subagent `set_event_filter`.** It does not filter `subagent_event` frames, which can be large.
8. **Sticky ambient context.** The user-level `~/.omp/agent/*` (AGENTS.md, memory, skills, MCP) leak into cards unless a profile is used. Project `.omp`/`.claude` in the worktree still apply.
9. **Prompt cache and title.** RPC disables auto-title. `PI_NO_PTY=1` is set only by `rpc-ui`, so for plain `rpc`, bash PTY use may need `--no-pty`.
10. **Per-session MCP is not cleanly available.** `--config` cannot carry MCP servers, as far as the docs show. Do not design around it.
11. **MCP browser filter.** Browser-like MCP servers are silently dropped when the native browser prelude is on.
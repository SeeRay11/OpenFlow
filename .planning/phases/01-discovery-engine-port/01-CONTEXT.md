# Phase 1: Discovery and engine port - Context

**Gathered:** 2026-10-19
**Status:** Decisions locked; contract committed; build wave dispatched

<domain>
## Phase Boundary

Replace OpenFlow's OpenCode engine (`opencode serve`, driven by `packages/flow/src/server/client.ts`) with the Omp engine, and wire Prompt Uplift (claude-ultrathink + Jev), shared memory (agent-substrate), per-card Agent Swarm, an Omp settings surface and an in-app PTY terminal around it. Phase 1 produces the evidence (nine discovery reports) and the contract every later slice codes against: `packages/flow/shared/*.ts`, `lib/omp/rpc-types.ts`, `lib/omp/binary.ts`, `lib/host/respond.ts`.

Out of scope for the milestone: modifying vendored upstream packages (FLOW.md hard constraint), a second engine, remote or multi-user terminals, cloud sync of memory.
</domain>

<decisions>
## Implementation Decisions

### Engine boundary
- **D-01:** The seam is the existing `EngineDeps.api` of the browser run engine, now typed `EngineApi` (`shared/engine.ts`). `engine.ts` keeps scheduling; everything omp-shaped sits behind `/flow/api/engine` in the host (`lib/omp`). The host maps omp frames onto the `session.next.*`, `permission.v2.asked`, `question.v2.asked`, `session.created` events the engine and `activity.ts` already read, so the 3600-line engine suite stays valid.
- **D-02:** One `omp --mode rpc-ui` child per card session, owned by the host in its own process group; `--no-ui` for the auto permission policy; protocol v2 with `rpc_chunk` reassembly is mandatory (the model catalog alone arrives as ~8 chunks). Closing stdin is the graceful stop; the group is SIGTERM/SIGKILLed on cancel and on host exit. Sessions survive a page reload because the host owns them (`CreateSession.reuse`).
- **D-03:** Cards run under an isolated omp profile (`--profile openflow`, configurable) with `--no-extensions` unless the user opts in; card env carries `ULTRATHINK_UPLIFT=0` and `AIO_UPLIFT=0` so the user's global plugins cannot double-plan or spawn detached swarm lanes (`swarm.autoRun` is true on this machine).
- **D-04:** Per-card tool toggles are enforced with a generated `--config` overlay (`tools.approval.<tool>: deny`), not `--tools`, unless the launch slice's probe proves `--tools` keeps extensions and host tools working. Orchestrator `dispatch`/`finish` are RPC host tools (`set_host_tools`) named `openflow_dispatch`/`openflow_finish`; `MCP_REACHES_SESSIONS` becomes true.
- **D-05:** Per-session files live outside the project: `<OPENFLOW_STATE_DIR|~/.openflow>/omp/<project-hash>/<run>/<node>/` (role prompt, overlay, session dir, swarm task store).

### Prompt Uplift
- **D-06:** Uplift is a host-side call of ultrathink's headless planner (`bin/run-bun hooks/engine.ts`, JSON in/out) with `host: "prime-agent"` and the Claude CLI engine; `host: "omp"` returns `native-unavailable`. Jev decisions run automatically inside the planner when a key is present. Only the card's own task text is uplifted; upstream outputs, attachments and protocol turns are never uplifted.
- **D-07:** Outcomes: `ok` sends the spec XML (never the `context` markdown); `skipped` (Jev judged it not new work, etc.) sends the original with a note; `failed` blocks the card and asks the user (Run with original prompt / Retry uplift / Cancel card). No silent fallback. Original and uplifted text are both persisted on the card and in the run log.

### Shared memory (Agent Substrate)
- **D-08:** Read per project, write per card: the host reads the brief and `memory_search` (`repo:<owner/name>`, subject prefix `openflow/<pipeline>/`) before a card, and writes one `fact` per finished card (`openflow/<pipeline>/<run>/<card>`, ttl 30d, redacted, `stored` only when `accepted` and `verified_persisted`). Surface is `omp` (no `openflow` surface exists server-side). Cards never receive SUBSTRATE_* tokens.
- **D-09:** Substrate has no delete. "Forget" writes retraction facts and keeps a local ignore list; the UI states that entries lapse on their ttl. Reads fail open and are visible on the card; memory text is untrusted evidence and is quoted/defanged before it enters a prompt.

### Agent Swarm
- **D-10:** Each card loads agent-swarm's omp extension with `-e <root>/omp`; default mode `auto` (the extension's own classifier decides), per-card override `off|auto|always`. The `/swarm` command is never used (it writes `.claude/swarm-state.json` and appends to `.planning/STATE.md` in the cwd). Signing is checked by presence only; missing signing/python/root degrades the card to `off` with a visible reason. `SWARM_DIR` is per card under the state dir; `SWARM_AGENT`/`SWARM_TASK_ID`/`SWARM_CHILD` are never set.

### Configuration and terminal
- **D-11:** OpenFlow settings live in `<state dir>/omp-settings.json` (no secrets); omp's own options are read and written through `omp config list|get|set|reset --json` so omp validates them. Secrets (provider keys) are entered in the terminal (`/login`) or env, never through OpenFlow HTTP.
- **D-12:** The terminal is a global bottom dock, one `@lydell/node-pty` implementation for both hosts (vite dev runs under Node, `server.ts` under Bun), ghostty-web in the browser, `ws` for the vite upgrade. Gate: `x-openflow-pty` header + loopback Origin/Host + one-shot ticket; off when `FLOW_ALLOW_REMOTE=1`; env allowlist without API keys or substrate/swarm secrets.

### Removal and migration
- **D-13:** OpenCode is removed outright after parity, no flag. Scope: everything OpenFlow owns (`packages/flow`, root `openflow.*` launchers, docs). Vendored upstream packages stay untouched (FLOW.md); deleting them is a separate user decision. A `check:no-opencode` gate is scoped to the fork-owned paths.
- **D-14:** Legacy pipelines load without crashing: model ids stay as written and are flagged when they cannot exist in the Omp catalog (zen/`opencode/*`); opencode agent names are dropped with a note; opencode session ids cannot be resumed and are refused, not attempted.

### Build structure
- **D-15:** Phase 2-6 slices are file-disjoint units built in parallel against the committed contract; the hubs (`engine.ts` stage edits are a slice, but `lib/store.ts`, `server.ts`, `vite/flow-store.ts`, `src/app.tsx`, `src/styles.css`, launchers, docs) are wired and cleaned in Phase 7 by single owners.

### Claude's Discretion
Internal module structure inside each slice, test fixtures, and the exact wording of user-facing problem messages (they must be actionable and name the fix).
</decisions>

<specifics>
## Specific Ideas

- The user's words: Omp runs; prompts go in each Card; each Card goes through Prompt Uplift (claude-ultrathink, Jev logic); Agent Substrate brings it together as shared memory across the workflow; each Card uses Agent Swarm under the hood in Omp; Omp is configurable in the app; the app can bring up a terminal.
- The substrate brief for SeeRay11/OpenFlow already carries this session's ultrathink plan event, so the live substrate is reachable and the two-run demonstration can be checked against it read-only first.
</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Rules
- `FLOW.md`, `AGENTS.md` (repo root) - fork constraints and style.
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md` - milestone v1.4.0.

### Contract (committed in Phase 1)
- `packages/flow/shared/engine.ts` - engine wire, `EngineApi`, event names, routes.
- `packages/flow/shared/{uplift,memory,swarm,omp,terminal,clarification}.ts` - stage and settings wires.
- `packages/flow/lib/omp/rpc-types.ts`, `lib/omp/binary.ts`, `lib/host/respond.ts` - process seam, binary resolver, handler helpers.

### Evidence
- `.planning/phases/01-discovery-engine-port/discovery/01-engine-contract.md` ... `09-terminal-pty.md` - nine reports with verified probes (omp 18.12.2 RPC handshake, 738-model catalog, PTY under Bun and Node, live substrate brief).
</canonical_refs>

<code_context>
## Existing Code Insights

- `packages/flow/src/server/engine.ts` (2265 lines) runs in the browser; `EngineDeps.api` (line ~254) is the injectable seam; `runTurn` (~871) is the single choke point for every send; prompt assembly ~948, `api.prompt` ~955.
- `packages/flow/lib/store.ts` (63 KB) is the host hub: `handleFlow` route table, agents merge into `opencode.json`, MCP/skills/cli-keys/repackage/zen/dispatch-tool/server restart routes; both hosts (`server.ts`, `vite/flow-store.ts`) proxy `/api /global /event /mcp` to `opencode serve`.
- `src/app.tsx` (1834 lines) mounts the panels; providers/engine-dialog/mcp/skills panels are opencode-specific; a bottom dock already exists (`ActivityDrawer`).
- Baseline before the milestone: `bun test` 1088 pass / 0 fail across 45 files; `tsgo --noEmit` clean.
</code_context>

<deferred>
## Deferred Ideas

- Deleting the vendored upstream packages (`packages/opencode`, `core`, `server`, `sdk`, ...): FLOW.md forbids touching them; needs the user's decision.
- Per-card MCP allowlist parity if omp has no per-session MCP selection (the launch slice records the limit).
- A memory inspect/clear panel beyond the settings dialog's status (Phase 7 decides the surface).
</deferred>

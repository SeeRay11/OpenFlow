# Changelog

All notable changes to OpenFlow are recorded here. OpenFlow lives in `packages/flow`;
the rest of the repo is a vendored OpenCode fork and is not covered by this file.

## [1.4.0] - 2026-10-19

- Run cards on Omp instead of OpenCode. Every card session is its own
  `omp --mode rpc-ui` process under an isolated `openflow` profile, with its own
  tool toggles, approval mode and environment allowlist. omp 18.12.2 or newer is now
  required, on `PATH` or at a path set in the app.
- Add Prompt Uplift to every task card: claude-ultrathink rewrites the card's own
  task into a spec before it runs, and Jev leaves a clear task alone. A failed
  uplift stops the card and asks — run with the original prompt, retry, or cancel —
  instead of sending anything silently. It can be turned off for every card, for one
  task with a `raw:` prefix, or for one card in a saved pipeline.
- Add shared memory through Agent Substrate: a card reads the project's memory
  before it runs and writes its outcome when it finishes. Memory has a retention
  setting, a repository override, and a Forget that retracts entries (Substrate
  cannot delete). A card never receives a Substrate token, and the host sends it
  only to https, loopback, or the address `SUBSTRATE_URL` names. A sub-agent
  dispatched more than once writes one entry per dispatch, and 0 *Most memories per
  card* skips the read.
- Add Agent Swarm to cards: off, auto or always, with a preflight that degrades a
  card to off and says why, and a status line on the card once it delegates. A card
  whose swarm is on receives the signing key by value in its environment, where its
  shell can read it; `SWARM_ED25519_KEY_FILE` passes only a path.
- Add the Omp settings dialog: status and problems, how cards are started, shared
  memory, and omp's own options. **Copy logins from your default profile** brings
  existing logins into the OpenFlow profile; secrets are only ever entered in the
  terminal or the environment.
- Add a terminal dock (``Ctrl+` ``): omp or your shell in the project folder, gated
  to loopback and off under `FLOW_ALLOW_REMOTE=1`.
- Move MCP servers and skills into the omp profile. Omp has no per-session MCP
  selection, so every card sees every server in the profile's `mcp.json` and in the
  MCP files of its working directory. The per-card checkboxes are gone, and a saved
  pipeline's `agent.mcp` is dropped silently when it loads.
- Serve the orchestrator's `openflow_dispatch` and `openflow_finish` as omp host
  tools, with the fenced block kept as the fallback.
- Store hedged memory output as a todo: Substrate quarantines hedged text written
  as a fact, so the host sends it once more as a todo and the card says so. Secret
  and personal-data quarantines are not retried.
- Prune old run state: about 15 seconds after the host starts, run directories
  under `omp/` that nothing has written to for 30 days are deleted, and their
  sessions leave the Sessions list. Runs the host holds are never touched.
- Title sessions `<role> · <first line of the card's task>`.
- Add a shared 40-scenario contract suite for the engine port, run against an
  in-memory fake and against the real client and host.
- Gate every request under `/flow` on both hosts, in any letter case and with a
  trailing dot (`/FLOW/API/x`, `/flow/api./x`): a loopback `Host` (a malformed,
  missing or credentialed one is refused), a same-origin `Origin` and
  `Sec-Fetch-Site`, and `application/json` bodies. A refusal is a 403
  (`forbidden-host`, `forbidden-origin`, `forbidden-content-type`). A request path
  with `.`/`..`/`%2e` segments, a backslash, NUL or `;` is refused with 400
  `forbidden-path`. This stops another web page, or a DNS-rebound name, from
  starting agents through your browser; curl and scripts are unaffected. The dev
  server sends no CORS headers, and the standalone server never returns a stack
  page (a failure is a 500 `internal error`).
- Limit omp sessions: at most 32 at once. At the cap the least recently used idle
  session is closed to make room; only when all 32 are busy does the create fail
  (409 `too-many-sessions`). A 60 second
  startup deadline (502 `omp-not-ready`), and a Stop or dispose while a session is
  starting leaves no process behind and never sends the prompt; Stop during a hanging
  omp start ends at once.
- Close every omp session and terminal on Ctrl+C or SIGTERM of the Vite dev server,
  and release a run's sessions as a whole when it ends, so a lost create response
  cannot strand one.
- Tell a card with `webfetch` off that omp cannot enforce it, show the planner
  engine in the inspector's uplift section, and remove the planner clarifying
  questions setting (an old settings file that still has it loads fine).
- Launch a gauntlet's critics and root orchestrator with the edit tools denied; the
  shell stays available.
- Keep the mode of `mcp.json` when MCP servers are saved (0600 for a new file), and
  write its `.bak` 0600.
- Refresh the model catalog and provider list when the profile's logins change, so
  a `/login` in the terminal shows up without a restart.
- Never follow a Substrate redirect, so the token cannot be forwarded.
- Leave a note naming the card when an older pipeline's explicit `agent.mcp` list is
  dropped on load.
- Say plainly that every `*_API_KEY` in OpenFlow's environment reaches cards.
- Reconnect the event stream by itself while a run is active. After a drop the host
  sends `flow.stream.reset` and replays the permissions and questions still
  waiting, to the new subscriber only, so an open dialog survives. Dialogs are keyed
  by session and request id.
- Resume a card's session from any run directory of the state root, as it was
  launched, with the new run's model, permissions, swarm and tool toggles. A session
  the host cannot find starts the card fresh, once.
- Keep readable history for finished sessions (`.openflow-turns.json`, last 200
  turns) and list only sessions whose history can be opened. Session records are
  written atomically with mode 0600.
- Treat host shutdown as a closed gate: a create or resume answers 409
  `session-closed`, a terminal create 409 `disposed`, and the catalog, provider and
  `omp config`/`omp auth` runs 503 `host-closed`. Every probe and CLI run is killed
  with its process group on dispose.
- Refuse to switch project while work is bound to it (409 `project-busy`), keep a
  run in the project it started in, scope terminals and custom roles to the project
  (409 `project-mismatch` for a terminal from another project), and sweep a
  terminal's whole process group on close.
- Prune skips runs whose log is still `running` and removes the uplift planner's
  results and session records older than 30 days.
- Scope Forget to the repository, bound each part of a memory subject and end a long
  or cleaned name in a stable hash so differently spelled names never share a
  namespace, and keep a corrupt `memory-ignore.json` aside instead of failing.
- Address existing MCP server and skill names exactly as written, drop a disabled or
  deleted server from `enabledServers`/`disabledServers`, and answer 404 when
  deleting a name that does not exist.
- Stamp every run-log write with `updatedAt` and keep it fresh with a heartbeat, so
  Resume is offered only for a run abandoned for more than five minutes; the resumed
  run closes the old log as `stopped`.
- Block a card with no model at preflight (there is no default fallback) and send
  attachments to no card whose model the catalog does not list.
- Open pipelines and run logs saved by the earlier build: model ids stay as written
  and are flagged when omp cannot run them, agent names are dropped with a note, and
  sessions from the earlier build are read-only. The shipped templates no longer pin
  a model.
- Add `bun run check:no-opencode`, which fails when a fork-owned file still mentions
  the removed engine outside a short, reasoned allowlist. CI runs it.
- Remove the OpenCode engine and everything that served it: `opencode serve`
  startup and management, the restart button, the api keys and provider panels,
  repackaging, the zen model list, key import from the CLI, merging agents into
  `opencode.json`, the launcher flags `-s`/`--server-port` and `-m`/`--manage`, the
  variables `OPENCODE_SERVER_URL`, `FLOW_MANAGE_SERVER`, `OPENCODE_SERVE_COMMAND`,
  `OPENCODE_AUTH_CONTENT` and `FLOW_PROXY_TIMEOUT`, the `/api`, `/global`, `/event`
  and `/mcp` proxy, and the `/flow/api` routes `cli-keys`, `repackage`, `zen-models`,
  `dispatch-tool` and `server`.

## [1.3.0] - 2026-10-18

- Add the post-run coach: a dismissable strip under the runbar that reads a finished
  run's own record and says how far to trust it — a pass from a critic that ran no
  command against a command-shaped bar, an orchestrator that never dispatched, and
  cards whose tool calls were rejected. Deterministic, no model, at most three findings.
- Record on the run log whether a critic's judging turn made a shell call that
  succeeded.
- Stop throwing away a critic's verdict for writing into the run's scratch directory,
  the place it was told to put its output.
- Clear a card's earlier error when a later dispatch of it succeeds.

## [1.2.2] - 2026-09-07

- Add the eval corpus: six fixed canvases run the same way each release, a scorer
  that reads run logs into a scorecard, and the first recorded baseline.
- Gauntlet and every long run: commit the working tree after each round under a
  ref, record what each round produced, and measure stalling off that record
  rather than off the task text.
- Survive a provider blip mid-run, and announce when a run ends on a channel the
  user turned on.
- Count the lines each card changed, measured off git rather than asked of the
  card.
- A card is done when it did the work, not when it stopped talking.
- Give every card in a batch its own working copy when the canvas asks for it.
- Warn when a dispatching card runs on a routed model.
- Make the Runs menu usable: legible rows, delete, prune, search.
- Select many cards at once on the canvas; the plain canvas drag pans again.
- Stop blaming a stale engine for a project that is not a git repository — offer
  `git init` instead.
- Track only the shipped templates under `.openflow`.

## [1.2.1] - 2026-09-01

- Keep swarm and orchestration cards out of each other's files: a batch is refused
  before it runs when two assignments declare the same path, and a post-batch
  collision report tells the orchestrator when cards wrote over each other.
- Warn about swarm peers with nothing to disagree about, and about peers that can
  write files.
- Pick up a run the browser tab abandoned instead of starting it over.
- Gauntlet: survive rate limits, count what they cost, and refuse to certify
  unjudged work.

## [1.2.0] - 2026-08-29

- Run a canvas as a swarm: parallel peers debate over rounds, and a synthesizer
  card writes the verdict.
- Run a canvas as an orchestration: an orchestrator dispatches work to child cards,
  recursively, bounded by the tree you draw.

## [1.1.2] - 2026-08-29

- Brief every card on the pipeline it runs in.
- Repackage OpenAI-compatible providers from the panel.

## [1.1.1] - 2026-08-24

- Maintenance release.

## [1.1.0] - 2026-08-21

- Run flow's CI checks on GitHub-hosted runners.

## [1.0.0] - 2026-08-17

- First release.

[1.2.2]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.2
[1.2.1]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.1
[1.2.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.2.0
[1.1.2]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.2
[1.1.1]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.1
[1.1.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.1.0
[1.0.0]: https://github.com/SeeRay11/OpenFlow/releases/tag/v1.0.0

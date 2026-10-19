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
  cannot delete). A card never receives a Substrate token.
- Add Agent Swarm to cards: off, auto or always, with a preflight that degrades a
  card to off and says why, and a status line on the card once it delegates.
- Add the Omp settings dialog: status and problems, how cards are started, shared
  memory, and omp's own options. **Copy logins from your default profile** brings
  existing logins into the OpenFlow profile; secrets are only ever entered in the
  terminal or the environment.
- Add a terminal dock (``Ctrl+` ``): omp or your shell in the project folder, gated
  to loopback and off under `FLOW_ALLOW_REMOTE=1`.
- Move MCP servers and skills into the omp profile. Omp has no per-session MCP
  selection, so every card sees every configured server.
- Serve the orchestrator's `openflow_dispatch` and `openflow_finish` as omp host
  tools, with the fenced block kept as the fallback.
- Open pipelines and run logs saved by the earlier build: model ids stay as written
  and are flagged when omp cannot run them, agent names are dropped with a note, and
  sessions from the earlier build are read-only. The shipped templates no longer pin
  a model.
- Add `bun run check:no-opencode`, which fails when a fork-owned file still mentions
  the removed engine outside a short, reasoned allowlist.
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

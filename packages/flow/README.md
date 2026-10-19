# OpenFlow

Visual builder for multi-agent workflows. Drag role cards onto a canvas, wire a
pipeline (planner → architect → coder), save it, and run it with real parallel
agents on top of [Omp](#omp-engine-and-requirements), one omp process per card.

A canvas runs in one of three [modes](#modes): a **pipeline** in dependency order,
a **swarm** of peers arguing over rounds until a synthesizer decides, or an
**orchestration** where one card hands work to cards it can see. An orchestration
can be run as a **gauntlet** — builders looped against fresh-context critics until
the work clears a bar you wrote, bounded by money, wall clock and stall. When a run
ends, a [coach](#after-a-run-the-coach) strip says how far to trust what it reported.

Around every card the host adds [Prompt Uplift](#prompt-uplift) (the task is
rewritten into a spec before it runs), [shared memory](#shared-memory-with-agent-substrate)
(what one card learned is there for the next), and [Agent Swarm](#agent-swarm-in-cards).
[Omp settings](#omp-settings) configure all of it from the app, and a
[terminal](#terminal) opens in the bottom dock.

OpenFlow is its own project, shipped as a fork of an upstream agent codebase whose
engine it no longer runs. Everything OpenFlow-specific lives in this package. No
other package in the repo is modified, so upstream merges stay clean. It is not
published to npm — it is an app, run it from the repo.

> OpenFlow is an independent fork. It is not affiliated with, sponsored by, or
> endorsed by the team behind the upstream project.

The plan it was built from, and the original build brief, are kept in
[docs/](docs) as history. They describe the earlier engine; this file and
[FLOW.md](../../FLOW.md) describe how it works now, and the code is the
authority where any of them disagree.

## Community

Questions, workflows, and feedback: [r/OpenFlowAI](https://www.reddit.com/r/OpenFlowAI/).

Changelog: [CHANGELOG.md](CHANGELOG.md), tagged on the
[releases page](https://github.com/SeeRay11/OpenFlow/releases).

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+, [Git](https://git-scm.com), and
[Omp](#omp-engine-and-requirements) 18.12.2 or newer on your `PATH`.

```bash
git clone https://github.com/SeeRay11/OpenFlow.git
cd OpenFlow
bun install
```

`bun install` pulls the whole workspace, so the first install is large. It runs a
`postinstall` (`packages/core/script/fix-node-pty.ts`) that marks the prebuilt
`node-pty` `spawn-helper` binaries of the vendored packages executable. It builds
nothing, and it returns immediately on Windows. Install omp separately — see
[Omp engine and requirements](#omp-engine-and-requirements).

## Stop anything already running

The canvas binds **5174**. A previous run still holding it is the usual reason
the canvas does not start: both hosts refuse to move to another port and print
what to do. `netstat -ano | findstr :5174` (Windows) or `lsof -i :5174` names the
owner.

`bun openflow.ts` already reuses a canvas that answers and frees a port a dead run
left bound, so a manual kill is only needed when you want a genuinely fresh
canvas. Omp processes need no cleanup: the canvas host starts them in their own
process groups and closes every one when it exits normally (Ctrl+C, a service
stop).

```powershell
Get-NetTCPConnection -LocalPort 5174 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { taskkill /pid $_ /T /F }
```

```bash
lsof -t -i :5174 | xargs kill -9
```

Both no-op when nothing is listening. Both kill whatever holds the port, so
confirm the owner first if you run something else there.

## Run it

OpenFlow is one process: the canvas. Its host starts Omp itself, one `omp` per
card session. The launcher at the repo root checks which omp it will find,
starts the canvas, and opens the browser:

```bash
bun openflow.ts
```

The launcher prints `omp <version>`, or a warning with the fix when omp is
missing or too old. It starts either way: the app opens and its
[Omp settings](#omp-settings) say what is wrong.

`openflow.ps1` and `openflow.sh` are shims over that same file: they hold no
launcher logic, they only translate their platform's flags into the environment
variables `openflow.ts` reads (`lib/launch.ts` resolves the plan for all three).

```powershell
.\openflow.ps1 -Project C:\code\my-app
```

```bash
./openflow.sh -p ~/code/my-app
```

On Windows, PowerShell refuses unsigned local scripts by default, so the shim can
fail with *"openflow.ps1 cannot be loaded because running scripts is disabled on
this system"*; `bun openflow.ts` is not a script PowerShell has to be talked into
running. `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` and
`Unblock-File .\openflow.ps1` are the fix if you want the shim.

| PowerShell | shell | environment | what it does |
|---|---|---|---|
| `-Project <dir>` | `-p`, `--project <dir>` | `OPENFLOW_PROJECT` | repo the agents read and write |
| `-Built` | `-b`, `--built` | `OPENFLOW_BUILT=1` | build and serve `dist/` instead of running vite |
| `-Help` | `-h`, `--help` | — | print the flag list |
| — | — | `OPENFLOW_DRY_RUN=1` | print the resolved plan and start nothing |

A port left bound by a dead run is freed before starting; a canvas that is
already serving is reused rather than started twice.

By hand it is one command:

```bash
bun run --cwd packages/flow dev
```

Open http://localhost:5174 — the dev server binds the `localhost` name, so
`127.0.0.1:5174` refuses the connection. The statusbar shows
`connected · omp <version>` once the UI can reach the host and omp answers.

### Built, without vite

`bun run build` emits a static bundle, and a static bundle on its own is a dead
page: the `/flow/api` store and the host modules that drive Omp (engine, uplift,
memory, swarm, settings, terminal) are what make save, load and run work.
`server.ts` serves all of them.

```bash
bun run --cwd packages/flow start
```

Same URL, same behaviour, no vite. `start` rebuilds before it serves, so it
cannot open an old bundle — `dist/` is not checked against source, and serving a
stale one is otherwise silent. `serve` skips the build for when you have just
run `build` yourself; that is what the launcher's `-Built` uses.

### Loopback only

`/flow/api` writes pipelines and run logs into the project, starts omp processes
that can edit that project and run commands in it, and nothing authenticates the
caller. On loopback that is you talking to your own machine; on a real interface
it is remote code execution in whatever repository OpenFlow is pointed at.

Both hosts refuse to serve anything but loopback unless `FLOW_ALLOW_REMOTE=1`
says otherwise — `bun start` exits, and `vite --host` fails to start rather than
coming up exposed. Request bodies are capped at 8 MB on both.

Every HTTP request under `/flow` (the API, the store and the event stream, in any
letter case, and with a trailing dot such as `/flow/api./x`) also passes one gate
(`lib/host/gate.ts`) before any handler runs, on both hosts:

- the `Host` must be `localhost`, `127.0.0.1` or `[::1]`, and a malformed `Host` is
  refused too (skipped with `FLOW_ALLOW_REMOTE=1`);
- an `Origin`, when sent, must be the page this host serves, and `null` is
  refused;
- `Sec-Fetch-Site`, when sent, must be `same-origin` or `none`;
- a request with a body must be `application/json`.

Before any of that, a request target under `/flow` that contains a `.` or `..`
segment (also as `%2e`), a backslash (`%5c`), a NUL (`%00`) or a `;` is refused
with 400 `forbidden-path`, on both hosts. After it, a refusal is a 403 with the
code `forbidden-host`, `forbidden-origin` or
`forbidden-content-type`. This stops another web page, or a DNS-rebound name,
from starting agents through your browser. A request with no `Origin` or
`Sec-Fetch-*` headers (curl, a script) passes, since only a browser sends those.
With `FLOW_ALLOW_REMOTE=1` the [terminal](#terminal) is switched off, but the rest
of the API is reachable by anyone who can reach the port, so set it only on a
network you trust.

The dev server sets `server.cors: false`, so it sends no CORS headers and answers
no preflight. The standalone server (`server.ts`, logic in `server-app.ts`) runs
with `development: false`, answers a malformed path with 400, and never returns a
stack page: a failure is a 500 with `{ "error": "internal error" }` and the cause
goes to stderr. A missing or credentialed `Host` is refused on both servers.
Ctrl+C and SIGTERM on either server close every omp session and terminal before
it exits.

Environment overrides. Setting one differs per shell — `VAR=1 bun openflow.ts` on
bash/zsh/Git Bash/WSL, `$env:VAR=1; bun openflow.ts` on PowerShell,
`set VAR=1 && bun openflow.ts` on cmd, `env VAR=1 bun openflow.ts` on fish. These
are read by the canvas host unless the table says otherwise:

| Variable | Default | Meaning |
|---|---|---|
| `OPENFLOW_PROJECT` | last used, else repo root | project the agents work in, and where `.openflow/` is written |
| `OPENFLOW_STATE_DIR` | `~/.openflow` | where OpenFlow keeps its own state: the remembered folder and pipeline, `omp-settings.json`, `memory-ignore.json`, and every card's session files |
| `FLOW_PORT` | `5174` | port for `bun start` (dev server is fixed at 5174) |
| `FLOW_HOST` | `127.0.0.1` | interface for `bun start` |
| `FLOW_ALLOW_REMOTE` | unset | exactly `1` allows a non-loopback bind, for both hosts, and turns the terminal off — `true` and `yes` do not count |
| `OPENFLOW_BUILT` | unset | launcher only: build the bundle and serve it through `server.ts` instead of vite |
| `OPENFLOW_DRY_RUN` | unset | launcher only: print the resolved plan and start nothing |
| `ULTRATHINK_ROOT` | unset | claude-ultrathink checkout for [Prompt Uplift](#prompt-uplift), when the setting is empty |
| `SUBSTRATE_URL` | unset | Agent Substrate address for [shared memory](#shared-memory-with-agent-substrate), when the setting is empty |
| `SUBSTRATE_TOKEN`, `SUBSTRATE_TOKEN_FILE`, `SUBSTRATE_TOKENS_DIR` | unset | the Substrate token, in that order; `SUBSTRATE_TOKENS_DIR` defaults to `/etc/substrate/tokens` |
| `SWARM_ROOT`, `ULTRATHINK_SWARM_ROOT` | unset | agent-swarm checkout for [Agent Swarm](#agent-swarm-in-cards), when the setting is empty |
| `SWARM_ED25519_KEY_FILE`, `SWARM_ED25519_KEY`, `SWARM_SIGNING_KEY` | unset | the swarm's assignment-signing key; the only variables of these families a card receives, and only when its swarm is on — `SWARM_ED25519_KEY` and `SWARM_SIGNING_KEY` by value, see [Agent Swarm](#agent-swarm-in-cards) |
| `*_API_KEY` (for example `OPENROUTER_API_KEY`) | unset | provider keys; passed to every card, never to the terminal |
| `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` | unset | also read by the planner's Jev decisions, when one is set |

The Substrate and swarm variables are read by the host and never given to a card
(see [what is isolated](#omp-engine-and-requirements)). A value saved in Omp
settings wins over its variable, and the Cards tab says which one each value
comes from.

### Where it picks up

A full stop and relaunch reopens the folder you were last working in **and the
pipeline you had open in it**, rather than the OpenFlow repo and a blank canvas.

The pipeline is remembered per project — a name only means anything inside the
folder whose `.openflow/pipelines` holds it — and is recorded when you open or
save one. It rides back on `GET /flow/api/context`, so restoring costs no extra
round trip, and it is only reopened if the store still lists it: a pipeline
deleted or renamed outside OpenFlow leaves a blank canvas rather than an error
on every launch.

Folder precedence at boot (`lib/last-session.ts`):

1. **`OPENFLOW_PROJECT`** — including `openflow.ps1 -Project` / `openflow.sh
   --project`. Naming a folder on this launch means it, and a folder picked last
   week must not override it.
2. **the remembered folder**, if it still exists. One that has been moved or
   deleted is dropped, because booting into a missing path fails every
   `/flow/api` route and reads as a broken app rather than a missing folder.
3. **the OpenFlow repo itself.**

Both are recorded host-side in `~/.openflow/state.json` — outside any project,
since they describe the app rather than the repo, and a user might commit or
delete the repo.

**Switching project.** The folder picker (and the Runs menu) is disabled while a
run is active, and the run keeps the project it started in: cards without a
worktree, and the uplift planner's working directory, stay in that project even
if the page is switched. Run and Resume are disabled while the picker is open, and
the page checks again that no run is active before it asks the host to switch (if
the host moved first, the page switches it back). `POST /flow/api/project` answers
409 `project-busy` while any engine session is live (an idle one between turns
included) or starting, a session create is in flight (from the moment the request
arrives, while its body is still being read; a body that has not arrived within 10
seconds is answered 408 `request-timeout` and stops counting), or an uplift planner is
running. Reaped, lost and disposed sessions do not count. It checks again right
before applying the switch. The 409 body carries `sessions`, the ids of every live
or starting session (empty when only a planner or a create holds it). With ids,
the page asks "N open card session(s) in the current project. Stop them and
switch?" and, on yes, deletes each session and retries once; with none it shows
only the host's sentence. Terminals belong to a project too (see
[Terminal](#terminal)), and so do custom roles: opening a project replaces the
roles with that project's own `.openflow/roles.json`. A role created while the
project's roles are still loading is merged into them when the read finishes
(project roles first, yours after; yours win on the same id) and then saved to the
project. If the project's roles cannot be read, nothing is written to the project
and a notice says the change stays in the tab. Edits made before the project's
roles are read are kept under a separate browser key for that project
(`openflow.customRolesPending.v1:<project path>`; never the migration source),
reported as unsynced and merged in when the read succeeds. Other projects never
read or push it, a project switch leaves it in place, and an edit made before the
project is known is reported as not persisted. A read that finishes after a switch
cannot write into the next project.
Roles saved in this
browser before that are copied once per browser (`openflow.customRolesMigrated.v1`),
and nothing is
written to a project's `roles.json` before it has been read successfully.

## Omp engine and requirements

Cards run on Omp, the Oh-My-Pi coding agent. The canvas host starts one
`omp --mode rpc-ui` process per card session and drives it over omp's RPC
protocol. OpenFlow has no agent loop of its own: a card has omp's tools, omp's
model providers, and — when you turn them on — omp's extensions.

**Requirements**

- **omp 18.12.2 or newer** (`MIN_OMP_VERSION` in `shared/omp.ts`), on `PATH` or at
  the absolute path set as **Binary** in [Omp settings](#omp-settings). Install it
  with `bun add -g @oh-my-pi/pi-coding-agent`, update it with `omp update`. The
  host runs `omp --version` to check, and caches the answer for 30 seconds.
- **A login** in the OpenFlow profile — see [First run](#first-run).
- Optional, each only for its own feature: the `claude` CLI logged in and a
  claude-ultrathink checkout for Prompt Uplift; a reachable Agent Substrate and
  its token for shared memory; an agent-swarm checkout, `python3` with
  `cryptography`, and a signing key for Agent Swarm. Without one of them the card
  still runs; each section below says what you see instead.

**What is isolated**

- **A separate profile.** Cards, the model catalog and the terminal run under the
  omp profile `openflow` (`--profile`): its own logins, config, MCP servers,
  skills and sessions. OpenFlow never reads or rewrites your default profile. The
  one exception is the **Copy logins** button, which copies logins out of it when
  you ask.
- **`--no-extensions`.** Cards do not load the extensions and plugins installed
  in your omp, unless you tick *Load my omp extensions and plugins in cards*. A
  card whose swarm is on loads agent-swarm's extension explicitly.
- **An environment allowlist.** A card's environment is built from a short list
  of host variables (`PATH`, `HOME`, locale, proxy and certificate variables,
  `XDG_*`, `PI_*`, `OMP_*`, `BUN_*`, `NODE_*`, `GIT_*`, and provider `*_API_KEY`
  keys), not copied from the host. Everything starting `SUBSTRATE_`, `SWARM_`,
  `ULTRATHINK_` or `AIO_`, and everything ending `_TOKEN` or `_SECRET`, is
  dropped. The one exception is the Agent Swarm signing key, passed through by
  name to a card whose swarm is on. Its value is then in that card's environment
  (see [Agent Swarm](#agent-swarm-in-cards)). **Every `*_API_KEY` variable in the
  environment OpenFlow runs in reaches every card**, because omp needs the
  provider's key. Keep unrelated service keys out of that environment, or leave
  provider keys out of it and use the profile's stored logins (**Copy logins**).
- **No double planning.** Every card gets `ULTRATHINK_UPLIFT=0` and
  `AIO_UPLIFT=0`, so a plugin of yours cannot plan a task that Prompt Uplift
  already handled, or start detached swarm lanes of their own.
- **Files outside the project.** A card's role prompt, config overlay, session
  files and swarm task store live under the state directory, never in your
  repository.

## First run

The `openflow` profile starts empty, so a fresh install has no logins and the
model menu is empty. Open **Omp settings** (the sliders button in the titlebar).
Its Status tab says what is missing: omp not found, omp too old, or *The openflow
profile has no credentials.* For the last one there are two ways out:

- **Copy logins from your default profile.** If you already use omp, this button
  — shown on the Status tab beside that problem — asks for confirmation, then
  copies the API keys and logins stored in your default profile into the OpenFlow
  profile. Nothing is removed from the default profile. The logins pass between
  the two omp commands in memory only: they are never put in a file, a log or an
  answer to the browser.
- **`/login` in the terminal.** Open the [terminal](#terminal) with `` Ctrl+` ``, keep
  the `omp` tab, and type `/login`. That omp runs under the OpenFlow profile, so
  the login lands there.
  The first time a new isolated profile opens omp in the terminal, omp runs its
  own setup wizard; press `Ctrl+C` to skip it.

Then open a card's model menu: the models of every provider you logged in to are
listed. The menu can make a model the default for cards added afterwards; a card
that already has no model keeps none.

## How the host drives Omp

The browser never talks to omp. The engine that schedules a run lives in the
page and calls the host's `/flow/api/engine/*` routes; `shared/engine.ts` is that
wire and `src/server/client.ts` is the browser side of it. The host
(`lib/host` composes `lib/omp`, `lib/omp-config`, `lib/uplift`, `lib/substrate`,
`lib/swarm` and `lib/terminal`) turns those calls into omp processes, and maps
omp's frames back onto the events the engine reads. Both hosts mount the same
code — the vite plugin (`vite/flow-store.ts`) and `server.ts` — so dev and built
cannot drift.

One card session is one `omp --mode rpc-ui` process, in its own process group, in
the card's working directory. It is started with the card's role prompt
(`--append-system-prompt`), a per-card config overlay (`--config`), the profile
(`--profile`), `--no-extensions` unless you opted in, `--approval-mode yolo` for
the auto [permission policy](#permissions-during-a-run) or the *Manual approval
mode* setting for ask-me, `--max-time` from *Longest card session* (480 minutes by
default), and a session directory of its own. Closing its stdin is the graceful
stop; the group is signalled if it does not exit. A session nobody has touched for
30 minutes is closed and stays resumable from its session directory, and a page
reload does not end a run's sessions, because the host owns them.

A session keeps two small files beside its session directory, both written
atomically with mode 0600: `.openflow-session.json` (what it is, including the
request it was created with, so a session that exists only on disk resumes as it
was launched) and `.openflow-turns.json` (the last 200 turns, each cut to 32 KiB).
The host keeps at most 64 idle or lost session records in memory, dropping the
least recently active first and never one with a turn running or a dialog waiting;
a prompt to a session it no longer holds resumes it from its files. A session
disposed on purpose answers 404.

**Resume.** A card carried over from an earlier run is found by its session id
across every run directory of the state root (the newest 2,000 run directories,
then the newest 4,000 card directories) and re-attached; only its session files
stay in their original state directory. The new run id is kept for new work. The
new request applies: model, permissions, swarm mode, tool toggles, run and working
directory follow the run that is asking now, and the engine decides where a
resumed card works. A process that is already live keeps the settings and directory
it was launched with until it is next resumed; if it is live in a different working
directory that still exists, the host stops it (its files stay) and relaunches it
in the new run's directory. If the session is released while it is being stopped,
the resume answers 404 and spawns nothing; if the old directory disappears
meanwhile, it relaunches without a notice. If the old directory is gone to begin
with, the host leaves the session alone. For a log that recorded no isolated
worktrees (see [Resuming an interrupted run](#resuming-an-interrupted-run)) the
host holds one info notice until the first accepted prompt: "Work it did there
before then may not have been merged into this run. Inspect it with: git -C
"<dir>" status". The command and path appear only when the directory is absolute,
at most 200 characters, and made only of letters, digits, space and `_ . @ + : ~ \
/ -`; otherwise the notice says "It worked in its previous working directory."
with no command and no path. The
notice is kept in `.openflow-session.json` as `carried` until it is delivered, so
an interruption before the first prompt does not lose it. Overlapping resumes of
one session are served one at a time, and a prompt that arrives during a resume
waits for it, so a session never has two processes. A session revived after
a restart resumes in its saved directory and gets no notice.
Using a session touches its run directory (at most once a second), so recently
used runs rank newest. If the host cannot find the session (pruned, or deleted),
the card starts fresh, once.

At most 32 omp card sessions run at once. At the limit the least recently used
idle session is closed to make room (it keeps its files and resumes on its next
prompt); only when all 32 are busy does the create fail, with 409
`too-many-sessions` (409 on purpose: the engine retries 429 and 5xx, and waiting
does not clear a full host). A fresh omp has 60 seconds to become ready and open
its session, else the start fails with 502 `omp-not-ready` and the process is killed.
Disposing a session, releasing a run, or pressing Stop while a session is still
starting closes it, and Stop during a hanging omp start ends at once: no process
is left behind, and a card stopped while its session opens never has its prompt
sent. A create whose request aborts before the session is live disposes it. The
browser waits on a turn in slices of
55 seconds, re-polling until the card settles or its timeout passes.

**Event stream.** While a run is active the browser reconnects to
`/flow/api/engine/events` by itself, waiting 250 ms and doubling up to 8 s. When
events went out while nobody was attached, or a client was dropped for falling
behind, every subscriber that attaches within 60 seconds after that gap gets
`{"type":"flow.stream.reset"}` (after the connection comment and before the
replayed dialogs); outside that window it gets none. Every new subscriber is then
sent each
permission and question that is still waiting, so an
open dialog survives a reconnect. A single event larger than the whole queue is
replaced by a notice, and tool-call arguments and raw results are capped. Start-up
notices (a tool toggle omp cannot enforce, a swarm that degraded to off) are sent
once, when the card's first prompt is accepted, and not again on a resume.

**Shutdown.** After `dispose` the host is a closed gate: creating or resuming a
session answers 409 `session-closed` and spawns nothing (a create whose body is bad
JSON or oversized during shutdown is answered with that failure or the 409, never
left unhandled), a terminal create answers
409 `disposed`, a late event-stream subscriber gets a stream that is already
closed, and the model catalog, provider probe and `omp config`/`omp auth` runs
answer 503 `host-closed`. Every probe and CLI run the host started, including the
`omp --version` checks, is killed with its process group and waited for, for at
most 10 seconds.

| Call | Route |
|---|---|
| is the host up, and omp usable | `GET /flow/api/engine/health` |
| the model catalog | `GET /flow/api/engine/models` |
| live events (SSE) | `GET /flow/api/engine/events` |
| open a card's session | `POST /flow/api/engine/sessions` |
| list sessions, newest first | `GET /flow/api/engine/sessions` |
| which sessions are executing | `GET /flow/api/engine/sessions/active` |
| send the card's prompt | `POST /flow/api/engine/sessions/{id}/prompt` |
| wait until it settles | `POST /flow/api/engine/sessions/{id}/wait` |
| stop | `POST /flow/api/engine/sessions/{id}/interrupt` |
| answer a permission request | `POST /flow/api/engine/sessions/{id}/permission/{requestID}` |
| answer a question the agent asked | `POST /flow/api/engine/sessions/{id}/question/{requestID}` (or `/reject`) |
| read back | `GET /flow/api/engine/sessions/{id}/transcript`, `/final`, `/steps`, `/calls` |
| close one session / every session of a run | `DELETE /flow/api/engine/sessions/{id}` / `POST /flow/api/engine/runs/release` |

`/transcript` also answers for a session the host no longer holds, from
`.openflow-turns.json`; `/final`, `/steps` and `/calls` answer 404 once a session
is released.

The store routes (`lib/store.ts`) are separate: pipelines, run logs, roles, MCP
servers, skills, folders, checkpoints and worktrees. Both hosts mount them too, so
dev and built cannot drift into two different stores.

## Models and logins

Omp holds the provider logins; OpenFlow stores none. The model menu is the
catalog omp reports for the OpenFlow profile (the host asks omp once and caches
the answer for ten minutes; the cache, and the provider list's, is dropped when
the profile's `agent.db` changes, so a `/login` in the terminal shows up without a
restart), grouped by provider and searchable. A provider
without a login contributes no models.

- **Giving the profile a login:** the *Copy logins* button or `/login` in the
  terminal, see [First run](#first-run). A provider key in the host's
  environment (`*_API_KEY`) also reaches every card; the terminal never gets one.
- **Whether a login works** is only known when something is sent. The **test**
  button beside a card's model runs one throwaway session (under its own run id,
  created with `transient: true` and released afterwards, so it is never listed
  and leaves no files) and reports the
  provider's own answer — a real `403 Authorization failed` beats guessing.
- **Prices** come from the catalog's per-million-token costs. A model the catalog
  quotes no price for is *unpriced*, never free: its tokens are shown and its
  money is not.
- **A card with no model cannot run.** The app's preflight blocks it (*pick a model
  for this node*) and the canvas shows `no model` on the card; there is no fallback
  to a default model. The host does not refuse it: given a session with no model it
  launches omp without `--model`, which uses omp's own default. A retired or unknown
  model id fails preflight before a session is created.

## Omp settings

The sliders button in the titlebar opens **Omp settings**. A banner about omp
being missing offers the same dialog. It has four tabs:

- **Status** — the omp binary, its version, the profile, the profile's config
  directory and how many providers are logged in, plus every problem with the one
  thing that fixes it. This is where **Copy logins from your default profile**
  lives. It also shows whether shared memory is reachable and whether the swarm
  can run.
- **Cards** — how every card's omp session is started: binary, profile, whether to
  load your own extensions, manual approval mode, longest card session, and the
  Prompt Uplift, Shared memory and Agent swarm settings described below. Below the
  form, *What cards use today* says for each value an environment variable can
  stand in for (binary, profile, claude-ultrathink, agent-swarm, Substrate URL)
  whether it is set here, comes from a named variable, or is the default — names
  of variables only, never their values. **Save**, **Discard changes** and **Reset
  to defaults** (confirmed) live at the bottom.
- **Memory** — Substrate status (on or off, reachable, surface, project, how long
  memories are kept), the entries remembered for the pipeline that is open, and
  **Forget this pipeline's memory**. Open the dialog from a pipeline to browse or
  forget its entries.
- **Omp options** — omp's own configuration, read and written through
  `omp config list|get|set|reset` against the OpenFlow profile, so omp validates
  every value. It is searchable by key, description or category and grouped by
  omp's own headings. Booleans, numbers, choices and strings are edited in place;
  lists and maps are shown read-only with an **Open terminal** button; a
  credential shows as *set* and is never revealed. **Reset** puts an option back
  to omp's default.

Settings are stored in `<state>/omp-settings.json` (`~/.openflow` by default; see
`OPENFLOW_STATE_DIR`), written atomically with mode 600. The file holds no secrets
by construction: every field is a path, a flag, a number or a URL, and a Substrate
URL with a username or password in it is refused. A file that cannot be read is
moved to `omp-settings.json.bad` and the defaults are used, and the dialog says
so.

**Secrets never go through the app.** A provider login is entered in the terminal
(`/login`) or copied with the button; a Substrate token and a swarm signing key
come from the host's environment. A saved change applies to the next card that
starts, not to one already running.

| Setting | Default | Notes |
|---|---|---|
| Binary | omp from `PATH` | absolute path of an executable |
| Profile | `openflow` | 1–32 lowercase letters, digits, `-` or `_`; empty uses omp's default profile |
| Load my omp extensions and plugins in cards | off | off runs cards with `--no-extensions` |
| Manual approval mode | ask before writes and commands | or *ask before everything*; used when a run's permissions are *ask me* |
| Longest card session | 480 minutes | 1 to 1440 |
| Uplift each card's task before it runs | on | see [Prompt Uplift](#prompt-uplift) |
| Planner time limit | 240000 ms | 10000 to 1800000 |
| claude-ultrathink location | omp's plugin directory | a directory containing `bin/run-bun` |
| Share memory across the cards of a run | on | see [shared memory](#shared-memory-with-agent-substrate) |
| Keep memories | 30 days | for this graph, 30 days, or permanently |
| Most memories per card | 8 | 0 to 50; 0 skips the read, and the card says so |
| Repository scope | from the project's git remote | `owner/name` |
| Substrate URL | none | `http(s)://`, no credentials; plain http to a non-loopback host gets a warning |
| Swarm | auto | off, auto, or always; see [Agent Swarm](#agent-swarm-in-cards) |
| agent-swarm location | none | a directory containing `omp/package.json` |

## Prompt Uplift

Every task card has its task rewritten into a specification before it runs. The
host calls claude-ultrathink's headless planner (`bin/run-bun hooks/engine.ts`,
JSON in and JSON out) with the Claude CLI as its engine. **Jev**, the planner's
decision logic, decides whether the task needs it: a clear, self-contained task is
left alone (the card shows `skipped (Jev)`, reason `jev-skip`), a vague one is
rewritten into a spec. Jev reads `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY` from
the host's environment when one is set.

Only the card's own task text is uplifted. The output of upstream cards,
attachments, and protocol turns (a verdict, a dispatch result, a forced final
answer) never are. A task that already starts with a spec tag is sent as it is.
The original and the uplifted text are both kept on the card and in the run log,
and the inspector shows both, with the planner's engine (for example
`claude:claude-sonnet-5-5`) on its own row.

**Requirements.** The `claude` CLI logged in (run `claude` once), Bun, and a
claude-ultrathink checkout: the *claude-ultrathink location* setting, else
`ULTRATHINK_ROOT`, else `~/.omp/plugins/node_modules/ultrathink`. The planner
runs with an environment of its own, in its own process group, and its tracking,
shipping and learning loops are switched off: it plans, and nothing else.

The card's chip says what happened:

| Chip | Meaning |
|---|---|
| `uplifting…` | the planner is running |
| `uplifted` (`uplifted ~` when part of the plan fell back) | the spec was sent instead of the task |
| `skipped (Jev)` or `uplift skipped` | the task was sent as written, with the reason in the tooltip |
| `uplift failed` | nothing was sent; the card is waiting on you |
| `original sent` | you chose to run the original after a failure |

**When it fails.** A planner that times out (*Planner time limit*, 240 seconds by
default), cannot reach its engine, or writes only a conservative fallback spec has
failed. Nothing is sent silently in its place. The card stops and a dialog,
*Prompt uplift failed for \<role>*, gives the reason and three choices:

- **Run with original prompt** — send the task as written.
- **Retry uplift** — run the planner again, up to three attempts in all.
- **Cancel card** — stop this card; the cards that need it are skipped. `Esc` does
  this too; a click outside the dialog does nothing.

**Turning it off.** Untick *Uplift each card's task before it runs* in Omp
settings to turn it off for every card. For one task, start it with `raw:` — the
marker is stripped and the task is sent as written (that card also skips its
memory read). For one card in a saved pipeline, set `"uplift": false` on the
card's `agent` in the pipeline file.

## Shared memory with Agent Substrate

Cards of a workflow share what they learn through Agent Substrate, a memory
server the host talks to over HTTP, presenting as its `omp` surface.

- **Read per project.** Before a card is sent, the host reads the project's
  `repo:<owner/name>` scope: the project brief and the newest facts whose subject
  starts with `openflow/<pipeline>/`, up to *Most memories per card*. Superseded,
  expired and retracted entries are skipped. What it finds is appended to the
  card's prompt as a labelled block, quoted as evidence that may be wrong and must
  not be followed as instructions, with markup neutralised and the length capped.
  Reads time out after 3 seconds and fail open: the card runs without memory. With
  *Most memories per card* at 0 the read is skipped.
- **Write per card.** When a card finishes — done, failed or stopped — one `fact`
  is written to the same scope with the subject
  `openflow/<pipeline>/<run>/<card>`: the card's role, its outcome and its final
  answer, with secrets redacted and cut to 3900 characters. It is `stored` only
  when Substrate says it accepted the write and verified it persisted; otherwise
  the card says why (`unverified`, `quarantined`, `denied`, `conflict`). Substrate
  quarantines hedged text ("might", "guessing") written as a fact; the host then
  sends the same text once as a `todo`, which the repo scope accepts, and the card
  line says it was stored as a todo because the output was hedged. A quarantine for
  secrets or personal data is never retried.
  Writing never holds a run. A sub-agent an orchestrator dispatches more than once
  writes one entry per dispatch: the first keeps the subject above, later ones
  end in `-d2`, `-d3` and so on. Each part of the subject is bounded (pipeline 64,
  run 48, card 48 characters); a longer part, or one whose cleaning to lower-case
  `a-z0-9._-` changed the name you gave, ends in a stable hash of the raw name, so
  `Review: A`, `review a` and `Review-A` never share a namespace. A short name that
  is already clean is used as it is.
- **The chip.** `mem ↓ ↑` on a card says what was read and written, and its
  tooltip lists the subjects. `mem off` means memory is off; `mem unavailable`
  means the card ran without memory, with the reason in the tooltip. A recalled
  memory shows how old it is.

**Which repository.** `owner/name` comes from the project's `origin` remote,
lower-cased (https, ssh and `git@host:owner/name` forms). *Repository scope*
(`memory.repo`, `owner/name`) overrides it, and is needed when the project has no
`origin` or its name differs from the Substrate repo.

**Retention and Forget.** *Keep memories* sets the ttl of each write: for this
graph (each run registers a Graph ID), 30 days (the default), or permanently.
Substrate cannot delete. **Forget this pipeline's memory** (Omp settings → Memory)
writes a retraction marker for each entry and records them in
`<state>/memory-ignore.json`, so no card reads them again from this host; the
entries stay in Substrate until their ttl lapses, and the dialog says so. The
records are scoped to the repository (`<scope>|<prefix>`, for example
`repo:acme/widgets|openflow/demo/`), so forgetting in one repository hides nothing
in another. A key from a build before that (it starts with `openflow/` and has no
`|`) matches every repository, because hiding too much is the safe failure; new
Forgets always write scoped keys. A Forget that reached Substrate keeps its
retraction markers. If
Substrate is unreachable, the host still ignores the entries locally but no marker is
written, and it says that too. Forget covers the `-d<n>` subjects as well. A
failed write does not break later Forgets, and an unreadable file other than a
missing one stops the write; a corrupt file is moved aside as
`memory-ignore.json.corrupt-<time>`.

**What the host reads.** The Substrate address is the *Substrate URL* setting, else
`SUBSTRATE_URL`; there is no default. The token is `SUBSTRATE_TOKEN`, else the
first line of the file named by `SUBSTRATE_TOKEN_FILE`, else
`<SUBSTRATE_TOKENS_DIR or /etc/substrate/tokens>/omp`. The `omp` surface needs a
`fact` grant on the repository scope. Only the host talks to Substrate: a card's
environment never contains a `SUBSTRATE_*` variable or any `*_TOKEN`. Untick
*Share memory across the cards of a run* to turn it off.

**Where the token goes.** The host sends it only to an `https://` URL, to a
loopback host, or to the exact address `SUBSTRATE_URL` names in the environment.
For any other URL (a saved `http://` address on another machine) it sends nothing,
memory is reported unavailable with a sentence saying why, and Omp settings shows
a warning. Use `https://`, or set `SUBSTRATE_URL` to that address to trust it.

The Substrate client never follows a redirect: any 3xx answer is a failure and the
card runs without memory, so the token cannot be forwarded anywhere. Set the
Substrate URL to the final address.

## Agent Swarm in cards

*Agent Swarm* here is agent-swarm's omp extension, loaded into a card's own omp
session. It is not the canvas's `swarm` [mode](#modes), which schedules several
cards against each other.

| Swarm | What the card gets |
|---|---|
| `off` | the extension is not loaded; the card runs plain |
| `auto` (default) | the extension is loaded and its own classifier decides whether a prompt is software-delivery work and, if so, adds a hint to delegate |
| `always` | the extension is loaded and the card's system prompt tells it to hand software-delivery work to `a01-orchestrator` through the `task` tool, and to answer questions and trivial lookups itself |

The mode is the *Swarm* setting in Omp settings → Cards. A saved pipeline can
override it: `swarm` on a card's `agent`, or `defaultSwarm` on the pipeline; there
is no control for either in the canvas yet. OpenFlow never uses the extension's
`/swarm` command, which writes `.claude/swarm-state.json` and appends to
`.planning/STATE.md` in the working directory.

**Preflight.** Before a card whose swarm is `auto` or `always` starts, the host
checks that the swarm can run, without reading any secret: an agent-swarm
checkout (the *agent-swarm location* setting, else `SWARM_ROOT`, else
`ULTRATHINK_SWARM_ROOT`) holding `omp/package.json` and `scripts/orch_plan.py`;
`python3` that runs; Python that can import `cryptography`; a signing key; and a
task-store directory it can create under the state directory. If any check
fails the card runs with its swarm **off** and says so — *swarm is off for this
card* followed by what is wrong and the fix. The Status tab shows the same check
as *ready* or *degraded*. The same check answers
`GET /flow/api/swarm/preflight?mode=off|auto|always`.

**What needs a signing key.** agent-swarm signs every assignment it hands a
specialist with an Ed25519 key, and refuses to dispatch without one. Provide it in
the host's environment as `SWARM_ED25519_KEY_FILE` (a path), `SWARM_ED25519_KEY` or
`SWARM_SIGNING_KEY`, or in `agent-swarm/signing-key.hex` under `$XDG_CONFIG_HOME`
(`~/.config` by default), and restart. The unsigned development key is never
offered.

**The key is visible to the card.** The agent-swarm extension signs assignments
inside the card's own omp process, so a card whose swarm is on receives
`SWARM_ED25519_KEY` or `SWARM_SIGNING_KEY` **by value** in its environment, and
its shell tool can read it. Cards without swarm never receive it. To keep the
value out of the environment, use `SWARM_ED25519_KEY_FILE`: only the path is
passed, and the file stays readable to your user. In either case the value is
never put in a command line, a file OpenFlow writes, or `omp-settings.json`.

**The status chip.** Once a card delegates, or its swarm degrades, a line appears
on the card — `swarm 2 running · 1 done`, with a pill per specialist and its last
activity in the tooltip. It is red when a lane failed or the swarm degraded
(`swarm degraded: <reason>`). A loaded extension that has not delegated shows
nothing on the card; the inspector says so. Each card has its own task store
under the state directory, and its swarm is limited to two levels of delegation
(card, then `a01-orchestrator`, then specialists).

## Terminal

The terminal button in the titlebar, or `` Ctrl+` ``, opens a terminal in a dock along
the bottom of the window. It runs in the project folder, and you switch between
two kinds:

- **`omp`** — omp itself, under the OpenFlow profile. This is where you `/login`,
  run `omp` commands, and edit the lists and maps that Omp options shows
  read-only.
- **`shell`** — your login shell (`$SHELL` when it is listed in `/etc/shells`,
  else `/bin/sh`; `%ComSpec%` on Windows).

It is for the things the app deliberately does not do for you: logging in,
inspecting why a card failed, and running a command against the same project the
cards work on. The host keeps up to four sessions, replays the last 2 MiB of
output when you reconnect, kills a session nobody has been attached to for ten
minutes, and keeps the last few exited ones so the dock can offer *Restart*.
Everything typed in the dock goes to the terminal — `Esc` included — except
`` Ctrl+` ``, which returns to the dock's own controls; `Ctrl+Shift+C` copies the
selection. The dock and a card's activity drawer share the bottom of the window,
so opening one closes the other.

Terminal sessions belong to a project and a kind: switching project replaces the
dock, and the host records the project each terminal was started in
(`PtyInfo.project`). A ticket or attach for a terminal started in another project
answers 409 `project-mismatch`; nothing is killed, and switching back allows it
again. A terminal create after the host has shut down answers 409 `disposed`.
Closing, disposing or exiting sweeps the whole process group — SIGHUP, then SIGKILL
after the grace period, even when the shell itself already exited — so a background
child that ignores SIGHUP does not survive.

**The terminal is code execution as you**, so it is gated three ways. Every
request must carry the `x-openflow-pty` header, which a web page on another origin
cannot send without a CORS preflight this host never answers. Its `Origin` must
equal the loopback `Host` it was sent to. And the WebSocket is opened with a
one-shot ticket that expires after 60 seconds. The browser sends only a kind —
never a command, a directory or an environment — and the host decides all three.
The shell's environment is the same allowlist as a card's, without provider
`*_API_KEY` keys and without any Substrate, swarm or `*_TOKEN` variable.

With `FLOW_ALLOW_REMOTE=1` the terminal is **disabled**: its routes answer 403
(`terminal-disabled`). The same host code serves both runtimes: `server.ts` runs under
Bun and spawns the PTY with Bun's own, the vite dev server runs under Node and
uses `@lydell/node-pty` and `ws` for the WebSocket upgrade. The browser draws the
terminal with ghostty-web.

## Engine

One node = one card session = one omp process. Nodes are grouped into
topological layers; the nodes in a layer are dispatched concurrently, each in its
own process, so the fan-out is real, then the whole layer is awaited before the
next starts.

1. Validate — DAG, reachable nodes, models resolvable against the omp catalog.
2. Layer with Kahn's algorithm.
3. Dispatch each layer through a pool. For every card the task is first
   [uplifted](#prompt-uplift), then [shared memory](#shared-memory-with-agent-substrate)
   is read; the prompt is pipeline briefing + role instructions + task (the spec
   when uplift ran) + serialized upstream output + the memory block, if any.
4. Live status: the host maps omp's frames onto the events the engine reads, and
   they drive the node badges.
5. Capture each node's final assistant text; write `.openflow/runs/<id>.json`; write
   the finished card to shared memory.

### The pipeline briefing

A card is an ordinary omp session and knows nothing about the graph it
sits in, so `pipelineBriefing()` in `src/graph/prompt.ts` prepends a map to every
prompt: what OpenFlow is, every card in the pipeline with its execution layer and
its wiring (`role (id) · receives: … · feeds: …`), which one the card is, and who
reads its output next. Cards are named by the same `role (id)` label the
`# Upstream output` headers use, so one card can refer to another by name and be
understood — a planner told to "hand this to the architect" otherwise has never
heard of an architect.

The handoff rules ride along with the map: do your role's part and stop, do not
redo upstream work, state assumptions rather than asking (nothing is
interactive), and write for the next card rather than for a human — unless
nothing runs after you, in which case the output is the run's answer. That is
what keeps a planner from implementing the change a downstream coder owns.

The run log is checkpointed as the run progresses rather than written once at the
end, so closing the tab halfway through leaves a log of the nodes that finished
instead of nothing at all.

Failure policy: a node error stops its downstream branch (`skipped`), siblings
finish, the run ends `error`. Stop interrupts in-flight sessions and dispatches
nothing further.

**Pipe mode** (toolbar): `ancestors` (default) gives a node every upstream node's
output in execution order; `direct` gives only the nodes wired straight into it.

**Parallel** (toolbar): how many nodes may run at once, 4 by default. Every
concurrent node is another live session against the provider, so a wide layer
run flat out is how a graph earns 429s and a bill nobody sized. The layer barrier
is unaffected — a layer still finishes before the next one starts.

**Timeout** (toolbar): how long a single node may run before the engine gives up
on it, 30 minutes by default. A node whose session never goes idle holds its
whole layer, and everything behind it, for the full wait — worth turning down to
5 minutes when a run should be quick.

## Modes

A canvas has a **mode**, and it belongs to the document rather than to a run: it
is saved, exported and undoable, because switching it changes what the same graph
does. Modes do not nest. Everything about running one session is shared — same
briefing machinery, same permission handling, same live status, same run log —
and only the **scheduler** differs: which cards run, in what order, and what
their prompts carry.

`pipeline` is the default, and what every canvas saved before modes existed reads
as. A mode this build has no scheduler for is refused twice over, in preflight and
again inside the engine, because the engine is callable without preflight and
running a swarm's graph through the pipeline scheduler would spend real money
producing an answer nobody designed.

### Swarm

Every non-synthesizer card is a peer of every other, and `edges` are never read —
a swarm is a node list, not a wiring. The canvas draws the mesh itself and refuses
to start a link, since an edge you dragged would be one the run ignores.

Round 1 gives every agent the same run task; round R re-prompts each agent with
every peer's round R−1 answer. The snapshot is taken **on the round boundary**, so
a peer dispatched early cannot be read by a peer dispatched later in the same
round — otherwise the debate would depend on pool scheduling order. Each peer keeps
**one session** across all rounds, so it remembers its own reasoning and the
provider can cache the prefix; that is why round 1 carries the briefing and later
rounds carry only what changed.

One `synthesizer` card reads the final round and writes the verdict. It is added
when you switch to swarm, it can be deleted, and preflight blocks a swarm without
one. A peer that fails is dropped rather than retried — a new session in round 3
would answer with no memory of rounds 1 and 2 while every peer around it has both —
and the synthesizer is told who is missing, so it does not write a confident
verdict over the hole.

**Rounds** (toolbar): 3 by default, 6 at most. A swarm costs `agents × rounds + 1`
sessions, so rounds multiplies the whole bill: four agents at six rounds is 25
sessions.

### Orchestration

The graph is a **tree**. One root — the card nothing points at — and every other
card owed to exactly one parent. A card with children of its own orchestrates its
subtree through the identical loop one level down, so "subagents deploying
subagents" is bounded by the graph you drew, and every session is a card you can
see, price and re-run. A diamond is refused: the second dispatch would re-prompt a
session still working on the first parent's task.

The orchestrator drives the loop with a tool call: `openflow_dispatch` hands work
to cards it can see, `openflow_finish` ends the run with the answer. Both are
omp RPC host tools that the host registers for the orchestrator's session; they
execute nothing, the engine reads the calls back. If a card cannot call them, it
can end its message with a fenced block holding
`{ "dispatch": [ { "card": "coder", "task": "what to do" } ] }`, or
`{ "final": "the answer" }` when it is done. The **last** call or block in the
message wins, because a model often quotes the protocol before using it. A
malformed one is handed back with the exact reason and re-asked up to three
times, each ask terser than the last; protocol re-asks are not charged to the
dispatch budget, because they buy nothing and the alternative is throwing away
the run. A card id outside the orchestrator's own children is refused, and so is
the same card twice in one batch — one card is one session, and two assignments
would race it.

Leaf cards never see the protocol: they are briefed as subagents, and their final
message is handed back to the parent. Cards nobody dispatched end the run
`skipped` rather than `queued`.

**Depth** (toolbar): 2 by default, 4 at most. **Dispatches** (toolbar): 3 per
orchestrator by default, 6 at most — without a cap, "that was not quite right, try
again" is an unbounded loop that reads as progress the whole way down. An
orchestration costs `1 + Σ(children × dispatches)` sessions per level, and
preflight prints the number before you spend it.

### Gauntlet

A toggle on orchestration, not a fourth mode: same tree, same protocol, same
scheduler. What changes is how it stops — **a written bar instead of a count.**
Builders work, critics judge the result against the bar, and the loop runs until
the work clears it or a bound fires.

The pattern is Matt Shumer's "Claude of Duty" run, and its two lessons are built
in: without a concrete bar a critic invents arbitrary standards and burns tokens,
and **coupled work belongs to one builder in sequence** — fanning lighting, tone
and sky out to cards that could not see each other made the result worse.

**Critics are cards with the `reviewer` role**, read off the role text the same way
a swarm finds its synthesizer, so designating one is renaming a card. A critic gets
a **new session for every verdict**: one that has watched the work improve grades
the improvement rather than the work, which is the exact failure a separate critic
exists to prevent. It costs the cached prefix every round — the price of the
method, not a bug to optimise away.

**The card that assigned the work cannot decide the work is done.** A `final` sent
while no critic has judged the current state is refused once, with instructions on
who to send and what to tell them; a second one **fails the run**. Only a
critics-only batch counts as a verdict — a critic dispatched alongside a builder
judged a folder somebody else was writing to. Both endings stop the burn; only one
tells the truth about what the run produced, and the error says which case it was:
`every critic dispatched failed` when critics were sent and none came back, or
`answered twice without sending the work to a critic` when none was ever sent.

Bounds, all live at once, first to fire wins:

- **Spend** — $5 by default, $500 at most. Priced client-side from the model
  prices omp's catalog reports, and a card's cost is the sum of every session it
  has held.
- **Wall clock** — 60 minutes by default, 12 hours at most.
- **Stall** — the same batch (same cards, same task text) dispatched 3 rounds
  running. Measured out here rather than asked of the model, because that is what
  no progress looks like from outside.

A model the catalog cannot price **blocks the run** rather than warning: an
unenforceable spend cap on something designed to run for hours is the one failure
nobody notices until the bill arrives. A missing bar only warns — "make the
orchestrator establish one first" is a real way to work. A missing critic blocks.

A turn the provider refuses for rate limiting is re-sent into the same session
three times, waiting 20s, 40s, then 80s. A gauntlet earns 429s more than any other
mode, because its critic opens a brand-new session on every verdict and is the one
card the run cannot route around.

No vision: a critic reads source, runs builds and tests, and hits a dev server. A
card with `bash` can drive a headless browser and capture the artifact itself,
which is how the runtime lines of a bar have actually been judged here.

The `reviewer` preset ships with `bash` switched off. A critic whose bar is made of
commands needs it on, or it cannot run any of them. In a gauntlet the critics and
the root orchestrator are launched with the edit tools (`edit`, `write`,
`ast_edit`) denied whatever their toggles say; the shell stays available. A
critic's shell output belongs in the run's scratch directory, which
it is told about, and a write there is not counted as changing the work.

### Resuming an interrupted run

The engine runs **in the page**, so a reload, a crash or a closed tab ends a run
with nothing alive to write `done`, `error` or `stopped` — while the sessions
themselves are still held by the host and still addressable. A live run is guarded by
`beforeunload`, and whatever gets past that is recoverable: the newest run log for
this pipeline still marked `running`, whose `updatedAt` is more than five minutes
old, is one the page abandoned, and **Resume** appears beside Run. Every 30 seconds,
and when the tab becomes visible again, the page re-reads the run list (only while
idle, with no folder picker open and the tab visible), so a run abandoned a few
minutes ago shows Resume without another refresh, and Resume is never offered from
a list older than the five-minute window. Every write of a
run log stamps `updatedAt`, and a 30-second heartbeat keeps it fresh through a long
quiet turn, so a run another tab is still writing is not offered. A run log that
cannot be saved raises the "run log not saved" notice once, and again only after a
save has got through. A resumed run writes its own log first, before the
model-catalog wait, already holding the finished cards' outputs and the carried
session ids, and only then marks the interrupted log `stopped` with `resumedBy`
naming the new run. If that first write fails, the interrupted run stays resumable
and is closed by the first later write that succeeds; the notice says so.

Resuming splits that run log in two. Cards that finished keep their answers and
never run again — reopening a finished card's session only bills. Cards that were
still working are prompted back into the sessions they already hold, which is the
difference between resuming and starting over wearing the old run's name: an
orchestrator seven rounds into a gauntlet remembers every verdict it has read. A
carried card is told once, on its first turn only, that the run around it stopped
and that nothing it produced was discarded — a card given no account of the
silence re-answers what it already answered. A carried session the host reports
lost starts as a fresh card: the full prompt, with no "same session" or
"interrupted" wrapper, and orchestrators and subagents get their briefing again.
A carried id for a card that is no longer in the pipeline is skipped, and the
sessions of cards that already finished are released when the resume starts, so
they do not hold the project lock. The Resume button is disabled from the click
until the run has started, so a tab cannot resume twice.

**Isolated work is never touched by Resume.** When a run uses isolated working
copies, its log has an optional `isolation: { trees: [{ card, directory, branch }]
}`. It is informational: it lists the worktrees the run opened that are not
cleaned up yet, is saved (awaited) right after they are opened, before any card
runs in them, and is cleared at the end of the run unless the cleanup request
itself was rejected (the cleanup swallows git failures, so a clean answer clears
them). Old logs have no such field, and an old log that carries a `base` is
tolerated and the field ignored. Resuming does not merge, remove or release any of
those worktrees. After the replacement log is saved and the interrupted log is
closed, the new log's `isolation` is seeded with the same trees (so a further
Resume lists them again) and one error-level notice says the interrupted run left
isolated copies that may hold work not merged into the project. It lists at most 20
of them and says how many more the log named; each shows the card, directory and
branch, and every path is double-quoted in `git -C "<dir>" status` and
`git -C "<dir>" diff`. Check each one before relying on it; you merge or discard
it. A carried card that had an isolated copy is told in its first resumed prompt
that its working directory is now the project folder, that edits it made before
the interruption may still be only in the old isolated copy (the path is named only
when it has no space, otherwise "the old isolated copy named in the notice"), that
it should check the project files before relying on them, redo any that are missing
there, and not edit the old copy. Cards without a tree behave as before.

**Run logs are untrusted input.** A run log is a file inside the project, and
Resume reads it back, so it shares the trust model of the pipelines in the
project: a repository you open can already define prompts, and there is no
provenance check. Resume therefore ignores `isolation` entries whose `directory` is
not a plain absolute path (posix `/…` or `X:\…`, only letters, digits, space and
`_ . @ + : ~ \ / -`, at most 200 characters) or whose `branch` is not
`openflow/` followed by letters, digits and `_ . / -`; keeps at most 50 entries
(the notice shows 20 and the true total); flattens control and invisible or format
characters, including U+200B–200F, U+202A–202E, U+2060–206F and U+FEFF; refuses a
log whose own `id` differs from the id it was opened under (compared
case-insensitively); uses a card's saved `output` only if it is a string of at most
1,000,000 characters; carries a `sessionID` only if it is a non-empty string of at
most 200 characters without control characters; and refuses a log with no `nodes`
array. A log whose `updatedAt` or `started` is more than five minutes in the
future is treated as abandoned and ranks below every plausible log when the run to
offer is chosen (it is still offered if it is the only one).

**Re-run failed** is the neighbouring, narrower tool: it reuses the outputs of
everything that finished and re-runs only what did not, in fresh sessions.

### After a run: the coach

When a run ends, a strip under the run bar can list up to three findings about how
far to trust it. Each says what the run's own record shows and one thing to do about
it. Dismiss one with its close button; reopening a past run from **Runs** shows its
findings again, and a run with nothing to say shows no strip at all.

The coach is not a model. It is deterministic code over the run log, so it costs
nothing and gives the same answer every time. It audits the *run* — a critic judges
the *work*.

- **A pass that was not earned.** The run recorded a pass, but the critic's judging
  turn made no shell call that succeeded, against a bar that names commands (a
  backticked command, "exits 0", "0 failures"). A prose-only bar never triggers it,
  since there is nothing to run. Fix: add "if you cannot run a check, the verdict
  is FAIL" to the bar, or add a second critic.
- **An orchestrator that never dispatched.** Every card below it is recorded
  `skipped` and no round was recorded, so it answered without handing out any work.
  Fix: put a stronger model in that seat, or re-run. A run you stopped is not
  reported.
- **Cards whose tool calls were rejected.** A card that could not write settles
  `done` with its edits missing. Orchestrators and critics are not reported: their
  write tools are refused on purpose.

A finding appears only when the record has the evidence. Runs saved before 1.3.0 do
not record whether a critic ran a command, so they never raise the first one.

## Files it writes

Under `OPENFLOW_PROJECT`:

```
.openflow/pipelines/<name>.json          the graph
.openflow/runs/<runId>.json              per-run log: prompts, outputs, timings
.openflow/roles.json                     roles you added on this machine
```

Under the state directory (`OPENFLOW_STATE_DIR`, default `~/.openflow`), outside
any project:

```
state.json                               the remembered folder and pipeline
omp-settings.json                        Omp settings
memory-ignore.json                       what Forget told this host to ignore
omp/<project>/<run>/<card>/              one card's role.md, overlay.yml, session/ and swarm/,
                                         plus .openflow-session.json and .openflow-turns.json
```

`.openflow/runs/` is disposable — worth adding to `.gitignore` if you keep
pipelines in version control.

**save** writes the pipeline. Saving under a name a
*different* pipeline already holds is refused rather than silently overwriting —
every new pipeline is born `untitled`, so that used to be a reliable way to
destroy the last one. The refusal offers both ways out: rename this one, or save
again to replace the other. A pipeline is marked saved only if it did not change
while the save was in flight; edits made meanwhile keep it unsaved and the notice
says so.

Nothing is merged into an engine config and nothing needs a restart: a card is
launched from its own spec, so an edited card simply starts a fresh omp process
with the new spec. The card session files under `omp/` are kept after a run so it
can be resumed. They live under `omp/<project>/`; about 15 seconds after the host
starts it deletes every run directory there that nothing has written to for 30 days
(`STATE_RETENTION_DAYS`). A run the host still holds, a run whose log under
`.openflow/runs` is still `running` (it can be resumed), loose files and symlinks
are never touched. Inside `uplift/` only the planner's `results/` and `sessions/`
`.json` and `.xml` files older than 30 days are removed (files only, never through
a symlink); the rest of `uplift/` stays. A pruned run's sessions leave the Sessions
list and cannot be resumed. This is separate from `POST /flow/api/runs/prune`,
which only removes `.openflow/runs` logs.

### How a card is launched

The card's prompt becomes its role file (`--append-system-prompt`). The tool
toggles in the inspector become a per-card config overlay that denies the matching
omp tools, and a deny wins in every approval mode:

| toggle | omp tools denied when it is off |
|---|---|
| `read`, `grep`, `glob` | the tool of the same name |
| `edit` | `edit`, `write` and `ast_edit` — `write`, `patch` and `apply-patch` in older saved graphs fold onto it, and a deny anywhere in that group wins |
| `bash` | `bash` and `eval` |
| `websearch` | `web_search` |
| `todowrite` | `todo` |
| `question` | `ask` |
| `skill` | omp starts with `--no-skills` |
| `webfetch` | none: omp reads URLs with its `read` tool, which cannot be separated from file reads, so it stays on. A card with this toggle off gets a one-time info notice at session start saying so |

A card whose node says nothing about tools runs with every tool omp has,
`edit` and `bash` included, and preflight warns about it. An orchestrator also
gets `openflow_dispatch` and `openflow_finish`, as described under
[Orchestration](#orchestration).

### Permissions during a run

A tool call can need approval. The toolbar's **permissions** policy decides who
gives it:

- **auto** (default) — the card starts with `--approval-mode yolo`: omp does not
  ask, and every tool call is approved. What a card can do is limited only by its
  tool toggles.
- **ask me** — the card starts with the *Manual approval mode* setting (*ask
  before writes and commands*, or *ask before everything*) and each request
  surfaces on the bar with **allow once**, **always** and **reject**; the node
  reports `awaiting permission: <action>` until you answer. **always** approves
  that subject for the rest of this card's session when omp offers the option,
  and is the same as allow once when it does not. Nothing is saved beyond the
  session.

Every decision is recorded on the node and in the run log with the action,
resources, reply and policy — an approval that leaves no trace is how a run
quietly changes something nobody expected. Stopping a run rejects anything still
pending rather than leaving the node waiting on an answer that will never come.
Permission and question dialogs are keyed by session and request id together, so two
sessions that reuse the same request id cannot overwrite each other.

### Questions during a run (human in the loop)

A card can stop and ask you something. That is omp's `ask` tool, enabled per node
by the **question** toggle in the inspector's tool list; with it off the node
runs headless and guesses instead. When an agent calls it, the host forwards the
request, the engine parks the node (`asking: <header>`) and shows a modal with the
agent's own options — one answer per question, several labels when the question
allows it, plus a free-text box for an answer the options did not offer.

Unlike a permission ask there is no auto policy, because an invented answer is
worse than none: the agent treats it as your intent. An unanswered question is
therefore *rejected* rather than guessed, and rejection is bounded by a five
minute timeout so a run left alone still finishes rather than holding the node
for the full idle wait. Every exchange is recorded on the node in the run log.

### Attachments

The run bar takes files, and so does each card (inspector → **files**). Pasting
an image into the task field attaches it too, which is how most screenshots get
there. Files are read into `data:` URLs in the browser and sent inline with the
prompt, so there is no upload endpoint, nothing written to the host, and nothing
left behind after a run — at the cost of size, so anything over 4 MB is refused
with a reason rather than failing later as an opaque request error.

A card only receives a file whose modality its model actually accepts, read from
`capabilities.input` in omp's model catalog. A text-only model in the middle of a
chain is not sent the image; it is told, in the prompt, which files were withheld
and not to claim it saw them, and the run continues. A card whose model the
catalog does not list is sent no files, since nothing can show it accepts them.

## MCP servers and skills

MCP servers and skills live in the OpenFlow omp profile, not in the project: the
profile's `mcp.json` and `skills/` directory, under the config directory the
Status tab of Omp settings shows (`omp config path`). The profile is isolated, so
servers and skills in your default profile do not carry over; add them here. Omp
also reads MCP files in a card's working directory (`.mcp.json`,
`.omp/mcp.json`; omp's `mcp.enableProjectConfig` option), so a server a project
declares there reaches its cards as well (verified: even under the isolated
profile). The tools of those servers appear as `mcp__<server>_<tool>` and are
reached through omp's `xd://` devices rather than appearing in the card's tool list.

The **plug** button in the titlebar manages the MCP servers. Both kinds are
covered: **local** (a command this machine runs, with environment variables and
an optional working directory) and **remote** (an http/sse url with headers). The
panel lists and rewrites the profile's `mcp.json`, so the omp CLI and TUI under
that profile see exactly the same set — OpenFlow owns no parallel config. Entries
the form does not own are kept as they were. The file keeps its existing mode (a
new one is created 0600), and `mcp.json.bak` (mode 0600) holds the file as
it was before OpenFlow first rewrote it (written once, never overwritten). Omp
connects to the servers itself when a card's session starts, so there is no live
status to show: a saved change applies to the next card session, not to one
already running.

**Every card sees every server.** Omp has no per-session MCP selection, so there is
no per-card choice: the inspector shows one sentence saying so and a **manage**
button. Older pipelines that carry `agent.mcp` lose it on load; an explicit list
leaves a note naming the card. A
card that must not reach a server needs that server removed from the profile (or
disabled in `mcp.json`) and from the project's MCP files.

The **skills** button authors skills: each is a `SKILL.md` under the profile's
`skills/<name>/`, which omp loads when a card's session starts. Skills authored
by earlier builds under `.openflow/skills` are still listed, flagged `legacy`, and
move to the profile when you save them. A card with its **skill** toggle off
starts with `--no-skills`.

Existing server and skill names are addressed exactly as they are written: a name
with `.`, `:` or upper case is listed, edited and deleted as it stands, and only
names the app makes up itself are slugged. A name must be one safe path segment (no
separator, no `..`, no NUL, not hidden); an MCP server name must also be a usable
JSON key (not empty, not `__proto__`, no control characters, at most 128
characters). Saving a server as disabled removes it from `enabledServers`, and
deleting one removes it from both `enabledServers` and `disabledServers`.
`PUT /mcp/{name}` and `PUT /skills/{name}` accept an add-only boolean `create`
(a non-boolean is 400, and it is never written to `mcp.json` or `SKILL.md`). With
`create: true`, an exact name that already exists, or a slug that collides with
one, answers 409 `{ "code": "name-taken" }` and writes nothing; without it the
save edits in place. The panels send `create: true` only for New and for a real
rename; editing a skill without renaming addresses it by its folder name, so a
folder `my-skill` whose frontmatter name is `My Skill` is not refused. A skill
create claims the folder with a non-recursive `mkdir`, so of several concurrent
creates of one name exactly one succeeds and the rest get 409 `name-taken`, and a
failed `SKILL.md` write after claiming removes the empty folder. The panels keep
the editor open with the
host's sentence on a 409. The answer to a save
carries the name actually stored, and the app shows that name. Deleting a name that
does not exist answers 404 `{ "removed": false }`, which the app treats as a
result rather than a failure, so renaming an entry still works.

Values in `mcp.json` are plain text. For a secret, prefer an environment variable
the host already holds.

| Store route | Purpose |
|---|---|
| `GET /flow/api/mcp` | servers in the profile's `mcp.json` |
| `PUT /flow/api/mcp/{name}` | add or update one (backs the file up first) |
| `DELETE /flow/api/mcp/{name}` | drop one |
| `GET /flow/api/skills`, `GET /flow/api/skills/{name}` | list and read |
| `PUT /flow/api/skills/{name}`, `DELETE /flow/api/skills/{name}` | write or delete a skill in the profile |

The MCP routes, and writing or deleting a skill, answer 409 until omp has
reported the profile's directory — open Omp settings if you see that.

## Sessions

The history icon in the titlebar opens a column on the left listing the card
sessions the host holds for the current project, newest first, with a search box
over them. Click one to read its turns; `←` goes back to the list. Sessions are per
project: those of another project are not listed and answer 404 by id until that
project is current again. A session created with `transient: true` (the model test)
is never listed, writes no session or turns file, and cannot be resumed (combining
`transient` with `reuse` is 400). Its node directory, and the run directory when
that create made it and it is empty, is removed when it ends: on dispose, release,
a failed start, exit or idle reap.

These are not a history OpenFlow keeps separately. Every node is one omp session,
its files are under `omp/<project>/<run>/<card>/` in the state directory, and
this reads them back through `GET /flow/api/engine/sessions`. Only sessions
OpenFlow's cards started are listed; what you run in the terminal is not. Nothing
in the panel writes: it lists and it reads.

The column is closed by default and remembered per browser, because a 240px
sidebar is cheap on a wide screen and not on a laptop — collapsed, the canvas
gets the full width back.

A row is labelled `<role> · <first line of the card's task>`, which the engine
sends when it opens the session (`CreateSession.title`) and the host stores in the
session's meta file. A session created before that shows the first line of its
prompt, and the card key (`plan-and-code-coder-…`) when there is neither. The
search matches title, card key, model and id. The list includes sessions the host no
longer holds, as long as their saved history can be read; a session with none is not
listed, since opening it would fail. Slow answers never overwrite newer ones: the
list and the open session show the result of the latest request only.

## Migrating older pipelines

Pipelines and run logs saved by the earlier build open without crashing. They are
migrated in memory when they load — the file on disk changes only when you save —
and the notice that says what was loaded adds *from an earlier build*, with every
detail on hover:

- **Model ids stay as written** and are flagged when they cannot exist in the
  omp catalog: ids that are not a `provider/id` pair, and ids from the earlier
  engine's bundled free-tier provider. Preflight reports them for each card
  (*pick an Omp model*), and the card does not run until you pick one.
- **Agent names are dropped.** Omp has no agents by name, so a card that named
  one runs on its own prompt, and the note says which card.
- **Session ids from the earlier build cannot be resumed.** Their runs can be
  read; **Resume** starts those cards fresh and says so.
- **Unknown fields are kept as written** and their names listed, never their
  values.

The first migration that has something to report stamps the document so the notes
are not repeated every time you open it. Agent definitions the earlier build
merged into a project's engine config, and that config's MCP servers, providers
and keys, are not read any more: re-add the servers and skills in the profile
([MCP servers and skills](#mcp-servers-and-skills)), log in again ([First
run](#first-run)), and pick a model per card. The shipped templates pin no model,
for the same reason.

## Troubleshooting

| You see | Cause | Do |
|---|---|---|
| a banner says *omp is not available*, or the Status tab says *omp is not on PATH* | omp is not installed, or not where the setting points | `bun add -g @oh-my-pi/pi-coding-agent`, or set **Binary** in Omp settings |
| *omp X is older than the 18.12.2 OpenFlow needs* | an old omp | `omp update`, then run again |
| *`omp --version` did not answer* | the binary starts but fails | run it in the terminal to see why, or point **Binary** at a working one |
| *The openflow profile has no credentials*, and an empty model menu | the profile has no login | **Copy logins from your default profile**, or `/login` in the terminal |
| *None of the profile's authenticated providers can serve models* | the logins are there but the providers are not available | `/login` for an available provider in the terminal |
| *Could not read the profile's providers* | the profile name is wrong, or omp failed | check **Profile**, or run omp in the terminal |
| a model fails at the first token, or the **test** button reports an error | the key is not accepted, or the account may not use that model | read the provider's own text in the message; pick another model |
| `port 5174 is already in use` | another canvas, or a stale one | open http://localhost:5174, or run `bun openflow.ts` to free it |
| *Prompt uplift failed for …* | the planner timed out, `claude` is not logged in, Bun is missing, or claude-ultrathink was not found | the dialog gives the reason: run `claude` once, raise **Planner time limit**, set **claude-ultrathink location** — or **Run with original prompt** |
| `mem unavailable` on a card | no Substrate URL or token, no `origin` remote, or Substrate unreachable | the tooltip gives the sentence: set **Substrate URL** / `SUBSTRATE_URL`, the token variable, or **Repository scope** |
| *swarm is off for this card* | the swarm preflight failed | the notice says what and how to fix it: agent-swarm path, `python3`, `cryptography`, a signing key |
| the terminal says it is disabled | `FLOW_ALLOW_REMOTE=1` is set | unset it; the terminal is never available on a non-loopback host |
| *omp profile directory unknown* from the MCP or skills panel | omp has not reported its config directory yet | open Omp settings and fix what the Status tab lists |
| a run says the host did not answer | the canvas host is not running, or crashed | start it with `bun openflow.ts` |
| 409 `project-busy` when picking a folder | a run, a session start or an uplift planner is still working in the current project | stop the run or wait for it to end, then switch |
| 409 `project-mismatch` on a terminal | that terminal was started in another project | open that project again, or start a new terminal |
| 409 `session-closed` or `disposed`, 503 `host-closed` | the host is shutting down | restart it with `bun openflow.ts` |
| 408 `request-timeout` creating a session | the request body did not arrive within 10 seconds | retry; check what sits between the page and the host |

## Canvas

Hand-rolled: HTML node cards over an SVG edge layer inside one CSS-transformed
viewport, driven by pointer events. `solid-flow` was evaluated and rejected —
last published 2022, three versions, built for Solid 1.5.

- drag a role from the palette onto the canvas, or click it to drop one in
- drag a node header to move it, wheel to zoom, drag empty canvas to pan
- drag the right port onto a left port to connect; cycles are refused
- click an edge to delete it; `Delete` removes the selected node, and `Ctrl`/`Cmd`
  `+Z` puts it back
- click a node to edit role, model, agent, prompt and tools, and to read its
  sent prompt and output
- the model field is a searchable menu of the models omp reports, grouped by
  provider, `↑`/`↓`, `Enter`, `Esc` — it lists nothing until the OpenFlow profile
  has a login, and its last row, **Manage models in Omp settings**, opens the dialog

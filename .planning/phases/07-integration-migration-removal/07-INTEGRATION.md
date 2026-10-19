---
phase: 07-integration-migration-removal
document: cross-phase integration audit
milestone: v1.4.0 Omp Engine
verified: 2026-10-19
head: 2daf46d9f
status: passed
blockers: 0
warnings: 8
---

# Phase 7 - Cross-phase integration audit (milestone v1.4.0)

Stance: every connection was assumed broken until a read of both ends (and, where one existed, a test) showed the link.
Every file:line below is under `packages/flow/` unless it starts with `openflow.ts`. Lines are at HEAD `2daf46d9f`.

## Verdict

**passed - 0 BLOCKERs, 8 WARNINGs.** All 8 flows and both layering rules resolve to WIRED. No export a flow needs is orphaned, and no hop dead-ends.
The WARNINGs are dead or half-consumed surfaces, one untested wiring and one unverified signal path. None breaks a requirement or a success criterion.

Evidence gathered in this audit (not testimony):

- Read of every hop below at both ends.
- Layering greps (section 2) and a throw-away import-graph and unused-export scan over `lib src shared vite` (script deleted afterwards).
- `bun test lib/host/index.test.ts lib/host/engine-contract.test.ts lib/host/gate.test.ts src/graph/migrate.test.ts src/server/stages.test.ts`: **243 pass, 0 fail**, 5.6 s.
- `OPENFLOW_DRY_RUN=1 bun openflow.ts` (dev and `OPENFLOW_BUILT=1`) printed `omp 18.12.2` and the expected `bun --cwd packages/flow dev` / `build` + `serve` plans.
- A scratch experiment (deleted): `Bun.spawn(["bun","--cwd",dir,"dev"])` then `process.kill(-pid)` fails with ESRCH (the child is not a group leader), the fallback `process.kill(pid,"SIGTERM")` runs, and `bun run` forwards SIGTERM to the script child. So the launcher's `killTree` (`openflow.ts:82-95`) does reach vite or `server.ts`.

Where a truth rests only on the orchestrator's live run, it is marked **[live]**: present and wired in code, behaviour attested live.

## 1. Provides / consumes map (phases 1 to 7)

| From | Provides | Consumed by | Status |
|---|---|---|---|
| P1 | `EngineApi` port, `ENGINE_BASE`/`engineRoutes` (`shared/engine.ts:17,189,222`) | `src/server/engine.ts` (`EngineDeps.api`, `:340-348`), `src/server/client.ts` (implements), `lib/omp/routes.ts` (serves), `src/server/testing/fake-engine.ts` | WIRED |
| P1 | contract suite `src/server/engine-contract.ts` | `src/server/engine-contract.test.ts` (FakeEngine), `lib/host/engine-contract.test.ts` (client over real HTTP against `createHost` + stub omp) | WIRED (tests only, by design) |
| P2 | `createEngineHost` (`lib/omp/index.ts:22`) | `lib/host/index.ts:52` | WIRED |
| P2 | `buildLaunch` (`lib/omp/launch.ts:82`), `spawnOmp` (`lib/omp/rpc.ts`) | `lib/host/index.ts:49,52`, `lib/omp/session.ts:495,508`, `lib/omp/models.ts`, `lib/omp-config/providers.ts` (probes) | WIRED |
| P3 | `createUplift` (`lib/uplift/index.ts:45`), `UPLIFT_ROUTE` | `lib/host/index.ts:55`; `src/server/stages.ts:56`; `engine.ts` `upliftTask` `:993` | WIRED |
| P4 | `createSubstrate` (`lib/substrate/index.ts:34`), `MEMORY_ROUTES` | `lib/host/index.ts:56`; `stages.ts:65,73`; `engine.ts` `recall` `:1096`, `remember` `:1146` (callers `:1615,1638,1656,2284,2439`); `memory-client.ts` -> `memory-panel.tsx`, `omp-settings.tsx:5` | WIRED |
| P5 | `createSwarmHost` (`lib/swarm/index.ts:41`) | `lib/host/index.ts:50`; passed to `createEngineHost` as `swarm` and read at `session.ts:494,515` | WIRED |
| P6 | `createOmpConfig` (`lib/omp-config/index.ts:41`), `createTerminal` (`lib/terminal/index.ts:62`) | `lib/host/index.ts:49,57` | WIRED |
| P6 | UI: `OmpSettingsDialog`, `TerminalDock` | `src/app.tsx:1523,1530` | WIRED |
| P7 | `createHost` (`lib/host/index.ts:44`) | `server.ts:35`, `vite/flow-store.ts:28` (both hosts) | WIRED |
| P7 | `migratePipeline`/`migrateRunLog`/`legacyModelProblems`/`isLegacySession` (`src/graph/migrate.ts:92-145`) | `src/app.tsx:226,231,745,786` | WIRED |
| P7 | `launchPlan` (`lib/launch.ts`), `checkOmp`, `DEFAULT_OMP_SETTINGS` | `openflow.ts:20-22,156` | WIRED |

Shared contracts (`shared/*.ts`): every one has both a `lib/` and a `src/` consumer except `shared/clarification.ts`, which has a `lib/` producer only (W3). `shared/` imports nothing from `src/` or `lib/`.

## 2. Layering rules

- **No `src/` file imports `lib/`: VERIFIED.** `grep -E "(from|import\()\s*['\"][^'\"]*(\.\./)+lib/"` over `src shared` returns nothing. `src` has no `node:*` import and no `bun:*` import except `src/server/engine-contract.ts:1`, which only tests and `testing/fake-engine.ts` (type import) reach, so it is not in the app bundle.
- **No `lib/` runtime file imports `src/`: VERIFIED.** The only hits are `lib/diffstat.test.ts:7`, `lib/omp/host-tools.test.ts:2`, `lib/omp/session.test.ts:7` and `lib/host/engine-contract.test.ts:8,30,31`, all tests. `lib/swarm/testing/fixtures.ts:33` mentions `./src/index.ts` only as a string in a fixture. No `@/` alias is used under `lib shared vite`.
- Entry points reach `lib/` legitimately: `server.ts:3-10`, `vite/flow-store.ts:2-6`, `vite.config.ts:4`, `openflow.ts:20-22`.

## 3. End-to-end flows

### Flow 1 - run a one-card pipeline: WIRED (every hop read; chain composition is [live], see W5)

| # | Hop | Evidence |
|---|---|---|
| 1 | UI Run click | `src/app.tsx:1336` -> `run()` `:764`; `probe()` `:300` (host and omp health), `preflight(...)` `:783` (+ legacy-model warnings `:786`), `actions.setRunning(true)`, `start(...)` `:794` |
| 2 | Engine deps | `src/server/engine.ts:338-348`: `live = { api (client.ts), uplift: stages.uplift, memory: stages.memory, saveRun: store.saveRun, ... }`; `start()` `:411` |
| 3 | Stage order per card | `runNode` -> `runTurn` `:1613` -> `stage()` `:977` called at `:1273` (task turns only; protocol turns are strings and cannot reach it, `:1267-1269`): **uplift** `upliftTask` `:993` then **memory read** `recall` `:1096`; only then `api.createSession` `:1287` (a cancelled uplift never costs a process, `:1285`), `api.prompt` `:1320`, `api.waitForIdle` `:1324`, `api.transcript` `:1329`, node `done` patch, **memory write** `remember` `:1615` (def `:1146`, fire-and-forget, tracked), `abandon` `:1616` -> `release` `:936`; `save()` `:703` -> `deps.saveRun` |
| 4 | Stage clients | `src/server/stages.ts:54-75` POST `UPLIFT_ROUTE`, `MEMORY_ROUTES.read|write`; never reject (uplift -> `failed`, memory -> `unavailable`) so the engine's fail-open rules apply |
| 5 | Browser client | `src/server/client.ts:138` `call()` (sets `content-type: application/json` when a body exists), `createSession :212`, `prompt :236`, `waitForIdle :284` (55 s long-poll slices), `subscribe :387` |
| 6 | Host gate | `server.ts:84-87` and `vite/flow-store.ts:45`: `host.gate` runs first on every `/flow` request; `lib/host/gate.ts:68,71,111` (Host loopback, Origin == Host, Sec-Fetch-Site, JSON content type). Client headers satisfy it (all four fetch helpers set `application/json`; `app.tsx:594`, `store.ts:6`, `omp-config.ts:69`, `memory-client.ts:43`, `terminal-frames.ts:68`) |
| 7 | Host routing | `lib/host/index.ts:72-82`: terminal, omp-config, engine, uplift, substrate, swarm handlers in turn; `lib/omp/routes.ts:243` -> `session.ts:747 create` -> `:722 launch` -> `:650 beginFor` -> `:475 start` |
| 8 | Launch | `session.ts:490` reads settings from disk on every start, `:491` `requireBinary`, `:494` swarm launch, `:495` `buildLaunch` (`launch.ts:93-115`: `--mode rpc-ui`, `--profile`, `--no-extensions` unless opted in, `--approval-mode`, `--max-time`, `--config` overlay, `swarm.args`; env `ULTRATHINK_UPLIFT=0`, `AIO_UPLIFT=0` at `:139-140`), `:508` `deps.spawn` = `spawnOmp` (detached group, `rpc.ts:105`) |
| 9 | Frames to events | `session.ts:417 onFrame`: `store.observe`, `ui.handle` (permission and question requests), `hostTools.handle`, else `mapper.map(frame)` -> `options.emit` -> `bus.publish` `routes.ts:77` -> SSE `routes.ts:232` |
| 10 | Events to engine | `engine.ts:731-735` `api.subscribe(...)`: `activity.consume(event)` then per-type `switch` `:752-790` (`flow.swarm.status`, `flow.session.lost`, `session.next.step.*`, tool, text, `permission.v2.asked`, `question.v2.asked`). Every event type the host emits (`events.ts`, `ui-requests.ts`, `session.ts`) is consumed by `activity.ts` or the engine switch (checked by diffing the two literal sets). `session.next.step.ended` token shape (`events.ts:160-170`) matches `engine.ts:763-775` |
| 11 | Activity to UI | `createActivity({owner: sessions.get, emit})` `engine.ts:569-575` -> `hooks.onNodeEvent` -> `app.tsx:805 actions.pushEvent` -> `state.ts:503` -> `activity-drawer.tsx:28`, `node-card.tsx:31` |
| 12 | Node patches to UI | `patch()` `engine.ts:640` -> `hooks.onNode` -> `app.tsx:803` (`originalPrompt` taken from `uplift.original`) -> chips `node-card.tsx:107,108,121`, inspector `inspector.tsx:216-218` |
| 13 | Run log | `save()` `:703-714` writes `node.events` tail + whole `log`; `src/server/store.ts:141` PUT `/flow/api/runs/:id` -> `lib/store.ts:359-381` writes the document verbatim, so `uplift`, `memory`, `swarm`, `prompt` persist; `openRun` `app.tsx:968-990` restores them into the runtime |

Host-side stage legs: uplift `lib/uplift/routes.ts:55-58` -> `index.ts:59-101` (settings read per call, planner `bin/run-bun hooks/engine.ts`, `host: "prime-agent"`, detached group `planner.ts:160-170`) -> `result.ts` -> `UpliftResult`; memory `lib/substrate/routes.ts:62-89` -> `memory.ts` read `:288`, write `:408` (settings per call).
Failure leg: `engine.ts:1058-1086` -> `onUpliftFailure` -> `app.tsx` `askUpliftFailure` -> `UpliftFailureDialog` (`app.tsx:1567`) -> `Run with original prompt` / `Retry uplift` / `Cancel card`; Stop rejects the dialog (`app.tsx:891`).
Break point: none. Tests: `lib/host/index.test.ts:323` (scripted turn streams and reads back), `:363` (manual approval), `:385` (ask), `:406` (host tools), `:460` (memory written by run 1 is read by run 2), `:423` (uplift answers). Live: basic turn, approval, `ask`, dispatch/finish, resume via `reuse`, uplift skipped / applied / failed dialog, memory store/read/forget **[live]**.

### Flow 2 - Stop: WIRED

1. `app.tsx:1364` Stop button -> `stop()` `:888`: `rejectPermissions`, `rejectQuestions`, `rejectUpliftFailures` (a card parked on the uplift dialog is cancelled), `current.stop()`.
2. `engine.ts:2500-2503`: `controller.abort()`, then `api.interrupt` for every active session. The one `AbortSignal` is threaded through every outside wait:
   - uplift and memory fetches (`stages.ts:24-35` pass `signal`), raced with `stopped.promise` (`engine.ts:482-483`, `:1002`, `:1099`);
   - `createSession` (`engine.ts:1287-1300`, signal as 2nd arg);
   - `waitForIdle` via `turnWait` (`:1228`);
   - permission and question waits.
3. **Planner group:** the aborted fetch becomes `request.signal` (Bun natively; vite via `lib/host/node-adapter.ts:65-67`, `res.once("close")` -> `abort()`) -> `uplift/routes.ts:58` -> `index.ts:97` -> `pool.run(spec, signal)` -> `planner.ts` `onAbort` -> `process.kill(-pid, SIGTERM)` then SIGKILL after `killGraceMs` (`:183-191`); the leader's `exit` sweeps the group (`:237`). Test: `lib/host/index.test.ts:439` (aborting the request kills the planner group).
4. **omp tree, in flight create:** `routes.ts:243` passes `request.signal` -> `session.ts:650 beginFor` `abandon()` stops the half-started session (`:581 stop`).
5. **omp tree, live session:** host `interrupt` `session.ts:838` (`ui.cancelAll`, `{type:"abort"}`, waiters released as aborted). The turn unwinds with `StopError`; the run's `finally` (`engine.ts:2482`) releases every held session -> `client.release` `:344` DELETE -> `session.ts:848 dispose` -> `:581 stop` -> `proc.close()` -> `rpc.ts:214-236` SIGTERM then SIGKILL of the process group `-pid`; plus the exit-time net `rpc.ts:51-53`. Release calls are tracked and awaited with a grace (`engine.ts:2483-2488`).
6. Swarm tracker: `stop()` -> `endSwarm` `:392` -> `tracker.dispose()` marks open agents `cancelled` (`tracker.ts:337-353`).
Break point: none. Live: Stop during uplift (planner group 0 processes after 3 s), during a session (omp gone in 1.5 s), during swarm; host SIGTERM with 6 sessions leaves no orphans **[live]**.

### Flow 3 - Settings change -> next session: WIRED

`omp-settings.tsx:334` `omp.saveSettings(patch)` -> `src/server/omp-config.ts:86` PUT `OMP_ROUTES.settings` -> `lib/omp-config/routes.ts:70-78` -> `settings.ts:264 update` (merge, `validateSettings`, atomic write, `notify()` -> `resetOmpCheck`, providers/status caches reset `omp-config/index.ts:51-54`) -> 422 + `errors[]` shown in the form. Consumers read the file on every use, no cache: `settings.ts:259 load` -> `omp-config/index.ts:56` `settings()` -> `session.ts:490` -> `buildLaunch` (`launch.ts:100-108`: `manualApproval`, `maxSessionMinutes`, `profile`, `loadUserExtensions`), `uplift/index.ts:64`, `substrate/memory.ts:288,408`, `swarm`. Per-row omp options go through `omp config set|reset` (`omp-settings.tsx:425,429`). After a change the dialog calls `props.onChanged` (`:368,416`) -> `app.tsx:1537` -> `reconnect()` `:356` (health + `refreshProviders`). Test: `lib/host/index.test.ts:592` (a saved `maxSessionMinutes` is on the next session's `--max-time`). Sessions already live (reused across turns) keep the launch they started with; the requirement is "subsequent runs" (CFG-03).

### Flow 4 - Copy logins -> stamp -> catalog -> picker: WIRED

`omp-settings.tsx:269` `omp.importAuth()` -> `omp-config.ts:96` POST `OMP_ROUTES.authImport` -> `omp-config/routes.ts:83-95`: `auth.copy` (`auth.ts` export from the default profile, import on stdin into the configured profile; credentials never in argv, logs or errors) -> `resetOmpCheck`, `providers.reset()`, `loginsChanged()` -> `host/index.ts:54` `omp.loginsChanged(engine.resetModels)` -> `models.reset` (`lib/omp/index.ts:36`). Independently, both caches are keyed on `binary|profile|credentialStamp` (`models.ts:127-130`, `providers.ts` `list`), and the stamp (`lib/omp/stamp.ts`) is fed by `omp-config/index.ts:60-64` and read by `engine.stamp` (`host/index.ts:52`), so a login done in the terminal also invalidates without any event. UI: on success `omp-settings.tsx:272` `props.onChanged` (even if the dialog was closed meanwhile) -> `app.tsx:356 reconnect` -> `refreshProviders` `:543` (`api.models()` `:549`, `omp.providers()` `:558`) -> `setProviders` `:559` -> `unlockedModels()` `:277`/`setAvailableModels` `:562` -> model picker and preflight `locked-model` (`validate.ts:91`). Tests: `lib/host/index.test.ts:290,305`. First-run copy of 12 logins into an isolated profile through the UI **[live]**.

### Flow 5 - Terminal: WIRED (vite wiring W1)

Dock `terminal-dock.tsx:213` POST ticket (header `x-openflow-pty: 1`, JSON) -> `lib/terminal/routes.ts` `terminalRoutes` (`httpRefusal` header + Origin + loopback, `core.plan(kind)` -> `host/index.ts:57-70` omp argv = resolved binary + `--profile`; or login shell) -> `TerminalHost.create` (`host.ts`) -> `{id, ticket, wsPath}`; `terminal-dock.tsx:238` `new WebSocket(socketUrl(...))`:
- **Bun / `server.ts`:** `host.gate` `:86` -> `terminal.fetch` `:90` (`ws-bun.ts` `ptySocketId`, `terminal.upgrade` = `terminalUpgrade` `routes.ts:93`: `upgradeRefusal` `policy.ts:39`, session exists, one-shot ticket consumed) -> `Bun.serve` `websocket: terminal.websocket` `:116` -> `host.attach` (`host.ts:175`: replay from cursor, `{cursor}` control, live output); PTY backend `pty-bun.ts` (`Bun.spawn({terminal})`).
- **Node / vite:** `vite/flow-store.ts:34` `attachNodeUpgrade(http, host.terminal)` (same `host.terminal` instance the `/flow` handler issued the ticket from) -> `ws-node.ts:21-61` -> same `terminal.upgrade` -> `ws`; PTY backend `pty-node.ts` (`@lydell/node-pty`, dynamic import; selected by `"Bun" in globalThis`, `terminal/index.ts:60`). `http2` servers are skipped (`"updateSettings" in http`).
- **Exit:** `host.ts:258 #exited` -> `sink.control({exit})` + close 1000 -> `terminal-dock.tsx:256` `dispatch exit` -> `terminal-session.ts` phase `exited` -> "Exited N" strip + Restart.
- **Restart:** `terminal-dock.tsx:277 restart()` DELETE `PTY_ROUTES.session(old)` (header set) -> `routes.ts` `core.host.kill` + `tickets.revoke` -> `begin(kind, true)` -> new ticket + socket. Exited sessions do not count toward the 4-PTY cap (`host.ts:136`, live sessions only).
- Teardown: `host.dispose` -> `terminal.dispose` (`host/index.ts:89`); PTY group SIGHUP then SIGKILL; process hooks `host.ts:327-341`.
Tests: `lib/host/index.test.ts:488,494,585` (header refusal, omp terminal output over a real WebSocket on Bun, own gate), `lib/terminal/ws-node.test.ts`. Live: open, type, Ctrl+C, `/exit`, `Exited 0`, restart, close on both `bun server.ts` and vite **[live]**.

### Flow 6 - Legacy data -> migrate.ts -> preflight messages: WIRED

Every document entry point goes through the migration: boot reopen `app.tsx:379`, import `:635`, load `:651` -> `readPipeline` `:225` -> `migratePipeline` (`migrate.ts:96`; drops `agent.name`, drops explicit MCP allowlists with a note, keeps unknown model ids, stamps `migratedFromOpencode`) -> `isPipeline` -> `actions.load` + banner `migrationSummary` `:214`; runs: `openRun` `:968` and `resumeRun` `:736` -> `loadRun` `:230` -> `migrateRunLog` `migrate.ts:117`; `ses_*` sessions are excluded from `sessions` and the card starts fresh with a message (`app.tsx:745`, `isLegacySession` `migrate.ts:92`). On Run: `legacyModelProblems` (`migrate.ts:145`, `app.tsx:786`) is prepended to `preflight` warnings, and `preflight` blocks a model no logged-in provider can run (`validate.ts:91`, `locked-model`), so the message names the legacy cause first. `start()` itself fails any card naming a model absent from the live catalog before dispatching (`engine.ts:2381-2406`, `unknownModels` `:2613`). Fixtures: `src/graph/__fixtures__/legacy/*` consumed by `migrate.test.ts` (passed in this audit). `check:no-opencode` (`scripts/check-no-opencode.ts`) is wired in `package.json` and `.github/workflows/openflow.yml`; remaining mentions are allowlisted with reasons (`:26-41`) and an unused allowlist entry fails the gate. Live: legacy `opencode/...` pipeline loads with notice and a preflight block **[live]**.

### Flow 7 - Swarm: WIRED

Card spec -> `card-spec.ts:70` `swarmOf` (`agent.swarm`, else `pipeline.defaultSwarm`, else host default) -> `engine.ts:1298` `createSession({swarm})` -> `session.ts` `parseCreate` validates against `SWARM_MODES` -> `start` `:493` -> `swarm.launch` `:494` (`lib/swarm/index.ts:48`: `createPreflight` + `buildSwarmLaunch`, `swarm/launch.ts` returns `args: ["-e", <root>/omp]`, `env SWARM_DIR/SWARM_ROOT`, task-depth overlay, `always` prompt) -> `buildLaunch` appends `swarm.args` (`launch.ts:115`), merges the overlay, forwards only signing keys by name (`:44,121-131`) -> omp spawned with the extension. A degraded swarm emits a `flow.notice` naming the fix (`session.ts:544-553`). `session.ts:515` `swarm.tracker`; every frame `onFrame :417` -> `tracker.observe` -> `emitSwarm :386` -> `flow.swarm.status`; `maintain()` polls `live.json`; engine `:752` patches `node.swarm` -> `node-card.tsx:121` `SwarmLine`, inspector `SwarmSection`, drawer. Settle: session end/stop -> `endSwarm :392` -> `tracker.dispose()` (`tracker.ts:337`, open agents -> `cancelled`) emits the final status once; and `settleSwarm` (`card-stages-model.ts:318`) derives cancelled for any non-running card at display time, which matters because Stop aborts the engine's event subscription before the host's final status can arrive (`engine.ts:2501` runs before the release at `:2482`; see W7). Retry: Agent Swarm's own ladder, no second OpenFlow layer (SWM-03 as amended). Tests: `lib/swarm/launch.test.ts:58`, `lib/swarm/index.test.ts:41`, `lib/omp/launch.test.ts:125`, `lib/omp/session.test.ts:263`, `lib/swarm/tracker.test.ts`, `card-stages-model.test.ts` (settle). Live: delegation to a01-orchestrator / a14 / a05 / QA gates with the chip, chip `cancelled` after Stop **[live]**.

### Flow 8 - Launcher -> server or vite -> host: WIRED

`openflow.sh`/`.ps1` only set env vars and `exec bun openflow.ts` -> `launchPlan` (`lib/launch.ts`) -> `bun --cwd packages/flow dev` (vite; `vite.config.ts:26` `flowStore`) or `OPENFLOW_BUILT=1`: `build` then `bun run --cwd packages/flow serve` (`server.ts`). Both create the host with `createHost({project: () => paths.project, allowRemote})` (`server.ts:35`, `flow-store.ts:28`), mount `gate` first, then `host.handle`, then the store (`server.ts:84-112`, `flow-store.ts:45-51`), and pass `profileDir: host.profileDir` into `handleFlow`. Shutdown: `server.ts:54-57` (SIGINT, SIGTERM, `exit`); vite: `flow-store.ts:35-39` (`http close`, `exit`) plus vite's own SIGTERM listener (`closeServerAndExit`, vite 7.1.4 `dep-C6pp_iVS.js:28508`). The launcher prints the omp version or a warning without failing (`openflow.ts` `ompPreflight`). `.claude/launch.json` and CI (`openflow.yml`: typecheck, `check:no-opencode`, tests on ubuntu and windows) use the same commands.

## 4. Requirements integration map

| Req | Integration path | Status |
|---|---|---|
| ENG-01 | `shared/engine.ts` port -> `engine.ts` deps (`:340`), `client.ts`, `fake-engine.ts`; no `src` import of `lib` | WIRED |
| ENG-02 | `fake-engine.ts` + `engine-contract.test.ts`; same suite over HTTP `lib/host/engine-contract.test.ts` (passed) | WIRED |
| ENG-03 | flow 1 + flow 2; no orphan: `rpc.ts` group kill + exit net | WIRED |
| ENG-04 | permission/question: `engine.ts:752-790` -> `answer`/`inquire` -> `client.replyPermission/replyQuestion` -> `session.ts` `ui.reply*`; usage `step.ended` -> `reprice`; transcript `/final` | WIRED (tests `index.test.ts:363,385`; live) |
| ENG-05 | `requireBinary` 503 text (`models.ts`) -> `client.describe` -> `app.tsx` `probe`/`ompMessage` + `setShowOmp`; `server.ts:59-64`, `openflow.ts` | WIRED |
| UPL-01 | `stage()` before `createSession`; Jev via planner; `decisions` shown `card-stages.tsx:112` | WIRED |
| UPL-02 | `UpliftInfo.original/uplifted` + `node.prompt` persisted (flow 1 hop 13), shown `card-stages.tsx:94`, restored by `openRun` | WIRED (the `GET /flow/api/uplift/:run/:node` route has no browser consumer, W4) |
| UPL-03 | `engine.ts:1058-1086` + dialog + Stop path | WIRED |
| UPL-04 | `EngineDeps.uplift` seam + `stages.ts`; `stub-planner.ts` | WIRED |
| MEM-01 | `recall` before session; `memory.ts:288` brief + search | WIRED |
| MEM-02 | `remember` -> `memory.ts:408`; test `index.test.ts:460` | WIRED |
| MEM-03 | `lib/substrate/guard.ts` redact + defang on write and on the injected block | WIRED (unit tests; not re-run) |
| MEM-04 | `MemoryChip`/`MemorySection`; `memory-client.ts` status/entries/forget -> `MemoryPanel` (`omp-settings.tsx:943`) | WIRED |
| SWM-01 | flow 7 | WIRED |
| SWM-02 | flow 7 (`flow.swarm.status`, degrade notice, `error`) | WIRED |
| SWM-03 | `tracker.dispose` + `rpc.ts` group kill + `settleSwarm` | WIRED |
| CFG-01/02/03 | flow 3; options generated from `omp config list --json` (`omp-config/config.ts`), validation 422 -> form | WIRED |
| TRM-01/02/03 | flow 5 | WIRED (a11y: QA-02 not traced here; keyboard walk is **[live]**) |
| MIG-01 | flow 6 (pipelines, runs, sessions, models). "Settings referencing opencode": the retired launch variable is asserted inert (`lib/launch.test.ts`); no persisted settings file of the old engine exists in this build to migrate | WIRED |
| MIG-02 | `check:no-opencode` in `package.json`, CI; allowlist | WIRED |
| MIG-03 | docs + `07-PARITY.md` (not re-audited here) | out of scope of this audit |
| QA-01 | adapter (`lib/omp/*.test.ts`), stages (`engine.test.ts`, `stages.test.ts`), config, terminal tests exist | WIRED |
| QA-03 | this document + the milestone auditor | n/a |

Requirements with no cross-phase wiring: none; MIG-03/QA-03 are documentation and process.

## 5. Gap list

No BLOCKERs. Smallest fix for each WARNING:

- **W1 (WARNING) `vite/flow-pty.ts` is an orphan runtime module.** Only `lib/terminal/ws-node.test.ts:8,79,231` imports it. The dev host does the same thing inline (`vite/flow-store.ts:33-38`), so the vite upgrade wiring that actually ships (the `"updateSettings" in http` guard, the shared `host.terminal` instance, detach on close) has no automated test; `ws-node.test.ts` tests the orphan instead. `lib/terminal/index.ts:5` and `ws-node.ts:11` still name `flowPty` as the dev-host mount. Fix: delete `vite/flow-pty.ts`, point `ws-node.test.ts` at `flowStore` (or at `attachNodeUpgrade` directly), fix the two comments.
- **W2 (WARNING) `describeLaunch` (`lib/omp/launch.ts:70`) is never called by production code** (only `launch.test.ts:312-326`). Its notes ("webfetch is off but ... stays enabled", unknown tool toggles) are never emitted as `flow.notice`, so an unenforceable toggle is silent at run time. `README.md:930` documents the `webfetch` case. Related: `LaunchInput.overlay` (`rpc-types.ts:106`) is never supplied. Fix: emit `describeLaunch(...).notes` as a `flow.notice` in `session.ts` `start`, or delete the function and the `overlay` hook.
- **W3 (WARNING) Uplift output that is produced and dropped.** The host returns `clarifications`, `engine` and `waves` (`shared/uplift.ts:62-70`, `result.ts:221-234`), but `engine.ts:1026-1037` copies none of them into `UpliftInfo`, so `shared/clarification.ts` has no `src/` consumer and `UpliftInfo.engine` (`shared/uplift.ts:84`) is never set. With the setting `uplift.hitl` on (`omp-settings-model.ts:79`, `planner.ts:151`) the planner spends an extra model call whose questions go nowhere. Fix: render or persist them, or drop `hitl` and the fields.
- **W4 (WARNING) Host routes without a browser consumer:** `POST /flow/api/engine/runs/release` (`client.ts:349` `releaseRun` has no caller), `GET /flow/api/engine/sessions/active` (`routes.ts:234`), `GET /flow/api/uplift/:run/:node` (`uplift/routes.ts:60-75`). Tests use them. Consequence: a run abandoned by closing the tab is reclaimed only by the idle reaper (`session.ts` `maintain`) or `--max-time`, not by a whole-run release. Fix: call `releaseRun(log.id)` from the run's `finally`, or remove the unused routes.
- **W5 (WARNING) The full chain is not composed in any one automated test.** Engine (`engine.test.ts`), stages (`stages.test.ts` against a fake host), client + host + stub omp (`lib/host/engine-contract.test.ts`, `index.test.ts`) and UI each pass against mocks or fakes of their neighbours; `engine.start` with the real `client` and `stages` against `createHost` + stub omp + stub planner + fake Substrate does not exist. Shared types guard the shapes (typecheck is clean) and the orchestrator's live run covers the composition. Fix: one `bun:test` driving `start()` with `live`-style deps pointed at `lib/host/index.test.ts`'s server for a single card.
- **W6 (WARNING, low) Unused exports left by the cutover:** `src/state.ts` `runNodeLogs`, `src/ui/icons.tsx` `IconKey`, `src/graph/orchestration.ts` `ORCHESTRATOR_ROLE`, `lib/substrate/live-check.ts` (an operator script documented only in its own header; not in `package.json`, README or FLOW.md). Fix: delete or document in the README.
- **W7 (WARNING, low) Final swarm status after Stop is derived, not delivered.** `stop()` aborts the engine's event subscription (`engine.ts:2501`) before the run's `finally` releases the sessions (`:2482`), so the host's final `flow.swarm.status` (agents `cancelled`) cannot reach the engine; the saved run log keeps the last streamed status (`active: true`, `running > 0`). The display is still correct everywhere because `settleSwarm` (`card-stages-model.ts:318`) settles by card status (unit-tested). Fix, if the log must be self-consistent: apply the same settle when `save()` serialises a non-running node.
- **W8 (UNCERTAIN, low) Ctrl+C typed directly into a vite dev terminal.** Vite installs only a SIGTERM listener (`dep-C6pp_iVS.js:2924`, none for SIGINT); the module net `process.once("exit")` (`rpc.ts:51`, `flow-store.ts:39`) does not run when Node dies on an unhandled SIGINT, and omp children lead their own groups so the terminal's SIGINT does not reach them. They are expected to end when their stdin pipe closes (`rpc.ts` header), but that was not exercised; only SIGTERM (launcher, service stop) is evidenced. Fix: add `process.once("SIGINT", ...)` calling `host.dispose()` in `flow-store.ts`, as `server.ts:55` does.

Documented limitations, not gaps: no canvas control for `agent.swarm`, `defaultSwarm` or `agent.uplift` (`README.md:561-564`; `raw:` prefix covers a single task); `planner.ts` has no exit-time SIGKILL net, only SIGTERM from `lifetime.abort()` via the `exit` hook (a planner ignoring SIGTERM on a hard exit would outlive the host; the SIGTERM/SIGINT paths await `host.dispose()` and do SIGKILL after grace).

## 6. Not re-verified here

The full suite, typecheck and `check:no-opencode` results quoted in the brief; MEM-03 guard internals; MIG-03 docs and the parity checklist; keyboard accessibility (QA-02); everything marked **[live]**.

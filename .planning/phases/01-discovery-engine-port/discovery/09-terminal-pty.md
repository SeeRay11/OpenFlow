## A. Upstream precedent (all copy-by-reading; flow must not import upstream packages)
- PTY abstraction: `packages/core/src/pty/pty.ts` defines `Opts{name,cols,rows,cwd,env}` and `Proc{pid,onData(l)->Disp,onExit(l)->{exitCode,signal},write(string),resize(cols,rows),kill(sig?)}`. Two backends behind it: `pty.node.ts` imports `@lydell/node-pty` (win32 adds `useConptyDll`), and `pty.bun.ts` imports `bun-pty@0.4.8`. Upstream picks per runtime. Both packages are already in bun.lock (`@lydell/node-pty` lock:1824, `bun-pty` lock:3278).
- Session service `packages/core/src/pty.ts`:
  - Spawn: `env = {...process.env, ...input.env, TERM:"xterm-256color", OPENCODE_TERMINAL:"1"}`. Upstream does NOT allowlist the env. Login shells get `-l`.
  - Scrollback: `BUFFER_LIMIT = 2MiB` string ring with a monotonic `bufferCursor`/`cursor`. `EXITED_LIMIT = 25` retained exited sessions.
  - `attach(id,{cursor,onData,onEnd})` returns `{replay,cursor,write,activate,detach}`. Live chunks queue in `pending` until `activate()`, so replay and live output stay ordered. A cursor of -1 means "tail only".
  - Cleanup: `teardown()` disposes listeners and `process.kill()` when running. A layer finalizer tears down every session. Upstream never kills the process group explicitly.
- Wire protocol `core/src/pty/protocol.ts`:
  - Server to client: raw UTF-8 text frames. Replay is chunked at 64 KiB (`REPLAY_CHUNK`). After replay comes ONE binary control frame, `0x00` followed by JSON `{cursor}`. The client checks `bytes[0]===0` (`packages/app/.../terminal.tsx:649`).
  - Client to server: text or binary frames that are plain keystrokes. Invalid UTF-8 is dropped (`decodeInput`). There is NO in-band resize; resize goes over HTTP `pty.update {size}`.
  - Close codes: 1000 on exit, 4404 for not found or exited.
- Auth (`packages/server/src/handlers/pty.ts`, `core/src/pty/ticket.ts`):
  - `connectToken` requires the custom header `PTY_CONNECT_TOKEN_HEADER` (forces a CORS preflight) AND `isAllowedRequestOrigin(origin, host, cors)`. It then issues a UUID ticket with a 60s TTL, scoped to ptyID, directory and workspace.
  - `connect` consumes the ticket atomically (`Cache.invalidateWhen`, one use) and re-checks Origin, answering 403 on failure.
  - Auth middleware lets `?ticket=` URLs through, so the socket never needs basic-auth credentials in the URL.
- Client (`packages/app/src/components/terminal.tsx`):
  - Ghostty is loaded lazily and once: `import("ghostty-web")` then `Ghostty.load()`.
  - `new Terminal({scrollback:10_000, fontSize:14, cursorBlink, ghostty})`, plus `FitAddon` (`fit.observeResize()`) and a local `SerializeAddon` for restore.
  - Resize is debounced to 100 ms (`scheduleSize`) and pushed over HTTP.
  - `attachCustomKeyEventHandler`: Ctrl+Shift+C does `execCommand("copy")`. A handler that returns true means the key is consumed by the host and not sent to the pty; only the toggle keybind (`ctrl+\``) is released.
  - Copy/paste go through DOM clipboard events. Links open on Ctrl/Shift/Meta-click.
  - `binaryType="arraybuffer"`. Reconnect uses a `retry` with backoff (`tries`, `reconn`) and a `cursor` resume. Close code 1000 means no retry. `onCleanup` closes with 1000.
  - `terminalWriter` (utils) batches writes.

## B. Runtime and PTY probe results (run_code, Bun 1.4.0, node v26.3.0 at /usr/bin/node; a second node v24.18.0 is on PATH inside spawned shells)
- `packages/flow` scripts: `dev`=`vite`, `serve`=`bun server.ts`, `start`=`vite build && bun server.ts`. Vite's bin has `#!/usr/bin/env node` (checked in vite@7.1.4). There is no `[run] bun=true` in root bunfig.toml (it only has `[install]` with `exact=true` and a `[test]` root guard). So `bun run dev` executes vite and every vite plugin under NODE, while `server.ts` runs under BUN. The PTY layer must therefore work in both.
- `Bun.spawn(argv,{terminal:{cols,rows,data(t,chunk)}})` WORKS on Bun 1.4.0:
  - `/bin/sh -c 'stty size; echo hello-pty; exit 7'` gave exit 7 and output `"30 100\r\nhello-pty\r\n"`.
  - `proc.terminal` methods: `write, resize, close, closed, setRawMode, ref, unref, controlFlags/inputFlags/localFlags/outputFlags`. Write then `resize(120,40)` took effect (`stty size` went 24 80 to 40 120).
  - The child is a session leader: pid == pgid == sid (3123052). After `kill('SIGTERM')` the shell and its backgrounded `sleep` grandchild were both dead 100 ms later (session hangup). `process.kill(-pid)` after that returned ESRCH, meaning no leftovers.
  - It is Bun-only, so it is NOT usable inside vite under node.
- `@lydell/node-pty@1.2.0-beta.12` is installed under `node_modules/.bun`. The install was mid-flight: the main package's `lib` was not yet linked, so I loaded the platform package `@lydell/node-pty-linux-x64/lib/index.js` (prebuild `prebuilds/linux-x64/pty.node`). Spawning `/bin/sh -c 'stty size; echo hi-node-pty; exit 3'` succeeded in BOTH runtimes: `bun 1.4.0` and `node v24.18.0` both returned `exitCode 3` and `"20 90\r\nhi-node-pty\r\n"`. **One implementation, `@lydell/node-pty`, covers both hosts.**
- Bare `import('node-pty')` fails ("Failed to load native module: pty.node"), and bare `@lydell/node-pty` and `bun-pty` did not resolve from /tmp. That is expected, since they are workspace-local, not global.
- ghostty-web@0.3.0 (git `anomalyco/ghostty-web#83c0a07`) and `bun-pty@0.4.8` (has `librust_pty.so`) are also present in the store. `omp` resolves at `/root/.local/share/reflex/bun/bin/omp` (pkg `@oh-my-pi/pi-coding-agent` 18.12.2, `bin.omp = dist/cli.js`).
- Caveat: upstream's `packages/core/script/fix-node-pty.ts` chmods `node_modules/node-pty/prebuilds/*/spawn-helper`. That path is not `@lydell`, and linux-x64 ships only `pty.node`. [INFERENCE] macOS prebuilds may need a spawn-helper chmod; the repo's postinstall handles the existing install, and flow adds nothing new.

## C. WebSocket and security design
Shared core `lib/terminal.ts` (new, flow-owned, no HTTP): `TerminalHost` holds `Map<id,Session>` and has `create(kind,{cols,rows})`, `attach(id,sink,cursor)`, `write`, `resize`, `kill`, `dispose()`. `Session` holds the `Proc` (node-pty), a 2 MiB ring buffer plus cursor (copy the upstream scheme), and exit info. Two thin transports:
1. server.ts (Bun): in `Bun.serve({... websocket:{open,message,close}})`, `fetch(request, server)` handles `GET /flow/pty/<id>/ws` with `server.upgrade(request,{data:{id}})`. Currently there is no `websocket` handler, `idleTimeout:0` is already set, and the new routes come before `statics()`. The `/flow/api` path starts with `/flow/`, so the new `/flow/pty/*` routes do not collide with PROXIED (`/api,/global,/event,/mcp`).
2. vite plugin (`vite/flow-pty.ts`, node): `server.httpServer.on('upgrade', (req,sock,head) => ...)` handles only `/flow/pty/` URLs and hands them to `new WebSocketServer({noServer:true}).handleUpgrade`. Vite's own HMR socket (protocol `vite-hmr`) is untouched. Note `proxy.ws:false` in vite.config.ts, so no proxy competes for upgrades. This needs the `ws` package (8.21.0 is in the lock; vite itself uses it, but bun's isolated store means flow cannot resolve a transitive; it must be declared). Alternative with no dependency: hand-roll RFC6455 framing (as `mcp/dispatch.ts` hand-rolls MCP). Not recommended.

Security (loopback only is already enforced by `remoteBindRefusal`, called in server.ts and in flow-store `configureServer`; if `FLOW_ALLOW_REMOTE=1` the terminal MUST be disabled unless a separate explicit opt-in is set):
- Per-launch token: `crypto.randomUUID()` generated at host start, never printed, held in memory. The browser obtains it from `POST /flow/api/pty/ticket`. That route requires a custom header `x-openflow-pty: 1` (forces CORS preflight, which this host never answers) AND an allowed Origin/Host.
- Origin check: allow only `Origin` equal to `http(s)://{Host header}` where Host is loopback (`localhost`, `127.0.0.1`, `[::1]` with the bound port). Reject a missing Origin on the WS upgrade (browsers always send it; this blocks cross-site WebSocket hijack and DNS-rebinding, because the Host must also be a loopback name).
- Ticket: one-shot, 30–60s TTL, bound to session id; consumed atomically at upgrade (copy `PtyTicket` semantics with a plain `Map`). WS URL: `ws://host/flow/pty/<id>/ws?ticket=...&cursor=N`.
- Create/kill/list use the same header+Origin gate, so a page on another origin cannot spawn a process.
- Framing (extend the upstream protocol, which has no resize):
  - server to client: text frame = raw output. Binary frame starting `0x00` + JSON = control: `{cursor}` after replay, `{exit:{code,signal}}`.
  - client to server: text = keystrokes. Binary frame `0x00` + JSON `{t:"resize",cols,rows}`. Clamp cols to 20..500 and rows to 5..200; ignore anything unparseable.
  - Close codes: 1000 normal, 4404 gone/exited, 4403 auth failure.
  - Backpressure: Bun `ws.send` returns -1 when backpressured and `ws` exposes `bufferedAmount`. If the sink is over about 1 MiB pending, drop live frames and rely on the ring buffer and `cursor` resume, or pause the pty with node-pty's `pause()/resume()`.

## D. Emulator recommendation: ghostty-web
- It is already in the lock (packages/app, `83c0a07`, v0.3.0). `@xterm/*` is NOT in bun.lock (grep found none), so xterm would be a new lock resolution and would violate "bun.lock gains only the workspace entry".
- WASM loading: `dist/ghostty-web.js` `Ghostty.load()` embeds the wasm as a `data:application/wasm;base64,...` URL (ghostty-web.js:51). No vite plugin or asset config is needed, and it works the same under `vite dev`, the built `dist/` and `server.ts` statics, with no extra file served. `ghostty-vt.wasm` is also exported as `./ghostty-vt.wasm` and used only as a fallback (`./ghostty-vt.wasm`, `/ghostty-vt.wasm`). flow's index.html has no CSP (grep), so no `wasm-unsafe-eval` or `connect-src data:` issue now; add them if a CSP is introduced.
- Use dynamic `import("ghostty-web")` so the ~400 KB wasm base64 stays in a separate lazy chunk (the upstream pattern: module-level promise, reset on failure).
- Fit/resize: `FitAddon.fit()` plus `observeResize()` (debounced), then send `{t:"resize"}` over the WS (100 ms debounce as upstream). Copy: `term.getSelection()` on copy events, plus Ctrl+Shift+C. Paste: DOM paste event into the hidden textarea. Scrollback: `scrollback:10_000` client-side plus the server ring replay on reconnect.
- Esc: ghostty-web delivers all keys to the pty unless `attachCustomKeyEventHandler` returns true. flow's ActivityDrawer registers `window keydown` Escape (activity-drawer.tsx:42-46) and would race with the terminal, so call `stopPropagation` while the terminal is focused. Document a leave-focus key, e.g. Ctrl+\` (upstream's toggle), implemented via the handler returning true and then blurring the terminal textarea. Show it in the dock header.
- a11y: canvas-rendered (CanvasRenderer), so the grid is not exposed to screen readers. Only a hidden textarea receives input. Mitigations: `role="region"` + `aria-label="Terminal"`, a visible leave-focus hint, and the exit status mirrored in a DOM `aria-live` line. State this limitation in the docs.
- Layout: `ActivityDrawer` is a bottom `section.activity` (styles.css:2771) toggled in app.tsx:1574; the chrome is titlebar/runbar/statusbar around a three-column main. [INFERENCE] The terminal fits as a second bottom dock/modal using the same `--v2-*` tokens and the drag-grip pattern (`activity-grip`, `MIN/MAX_HEIGHT`). Terminal colors should come from the `:root` `--v2` tokens read via `getComputedStyle`.

## E. Dependency impact
- `packages/flow/package.json` dependencies gain exactly: `"@lydell/node-pty": "catalog:"` (already in root catalog line 95, resolves to 1.2.0-beta.12), `"ghostty-web": "github:anomalyco/ghostty-web#83c0a07b8628b748aed073b232cb4b52a6ca11c1"` (the same spec string as packages/app, lock:69), and `"ws": "8.21.0"` (only if the vite plugin uses `ws`; the lock has a `ws@8.21.0` package at line 5594 and a spec at 678). Optionally devDependency `@types/ws` (the lock has 8.18.1 at 2986).
- bunfig `exact=true` means no caret ranges. All three resolutions are already in the lock, so the change to bun.lock is limited to the `"packages/flow"` workspace block (lock:494-509) gaining those entries, with no new package records. This satisfies FLOW.md:12-14. Verify with `bun install --frozen-lockfile` after editing: expect it to fail until the lock block is updated, then `bun install` (not frozen) and check `git diff bun.lock` shows only the flow block.
- Existing drift to note: lock flow block says `"version": "1.2.1"` while package.json says `1.3.0`, so the lock is already stale on version; a regenerated lock will touch that line.
- No upstream package imports are needed.

## F. Spawn policy
- Browser sends only `{kind:"omp"|"shell", cols, rows}`. Never argv, cwd or env from the browser.
- `omp`: argv from the resolved binary (setting `ompPath`, else `Bun.which("omp")`; resolve to an absolute path at create time and 404 if missing), no extra args (or an allowlisted subcommand enum later). `shell`: `process.env.SHELL` if it is an absolute executable listed in `/etc/shells`, else `/bin/sh`, with `-l`.
- cwd = the resolved project dir (`paths.project`); `realpath` it and refuse if missing.
- env allowlist: `HOME, USER, LOGNAME, PATH, SHELL, LANG, LC_*, TERM=xterm-256color, COLORTERM=truecolor, XDG_*, TMPDIR, PI_*/OMP_*` (verify omp's exact var names from `omp://` docs), plus the provider keys the user has intentionally configured for omp. Do NOT pass the whole `process.env`; it carries `SUBSTRATE_TOKEN`, `SWARM_ED25519_KEY`, `OPENROUTER_API_KEY` and others. Upstream does pass everything, so this is a deliberate departure.
- Lifecycle: surface `{exit:{code,signal}}` as a control frame and keep the exited session (ring buffer retained, cap about 5) so the UI can show "exited 1 — Restart"; Restart = new create. Kill: `proc.kill("SIGHUP")`, then after 2s `process.kill(-pid,"SIGKILL")` (node-pty makes the child a session leader via forkpty, so pgid==pid [INFERENCE for node-pty; verified for Bun.spawn terminal]). Reuse `opencode-process.ts`'s `process.kill(-pid,"SIGTERM")` with child fallback (lines ~108-114). Host exit: on `SIGINT/SIGTERM/exit` (server.ts) and on vite `httpServer.on("close")` (same pattern as flow-store.ts:49), call `TerminalHost.dispose()`. WS close detaches only; the session survives for reconnect with a cursor, with an idle reaper (e.g. 10 min with no client) killing it.
- Limits: max 4 live sessions, input frame cap 64 KiB, ring buffer 2 MiB, resize clamps as above.

## G. Test plan (`bun test`, deterministic, no model calls)
- Unit-test `TerminalHost` with an injectable `spawn` (the `Proc` interface), plus one real-PTY integration file using stub scripts written to a tmp dir:
  - echo stub: `read x; echo got:$x; stty size; exit 3` gives data, exit code 3 and the `{exit}` frame.
  - resize: write, `resize(120,40)`, assert `stty size` equals `40 120`.
  - restart: after exit, `create` again gives a new id and pid.
  - no-orphans: stub spawns `sleep 300 &` and prints its pid; after `kill`/`dispose`, poll `process.kill(pid,0)` for ESRCH (with a 3s bound); also assert the parent pid is dead.
  - ring buffer: emit more than 2 MiB, assert replay from a cursor equals the tail and `cursor` is monotonic.
  - policy: unknown `kind`, oversize cols/rows, bad ticket, wrong Origin, reused ticket, and the missing-header case all fail. Test the HTTP/WS adapters with `Bun.serve` on port 0 and the real `WebSocket` client; vite adapter gets one test with `ws` against an `http.createServer`.
- Use `await exited` promises instead of sleeps; pass absolute stub paths; mirror existing `lib/opencode-process.test.ts` style. Note `bun test` has no `localStorage`/DOM, so keep the client component out of unit tests (test the pure framing helpers).

## H. Risks
1. Dual-runtime: under vite the host runs on node, so node-pty plus `ws` are mandatory there while server.ts could use Bun natives. Keeping a single `@lydell/node-pty` path avoids two backends, but node-pty's native `pty.node` must load on the user's platform (macOS spawn-helper exec bit; Windows needs `useConptyDll`, as in `pty.node.ts`). `postinstall` fix-node-pty targets `node_modules/node-pty`, not `@lydell`.
2. The terminal is arbitrary code execution as the user. Security rests on loopback bind + Origin + one-shot ticket + header gate, so it must be off when `FLOW_ALLOW_REMOTE=1` unless separately enabled. DNS rebinding is covered only if the Host header is validated.
3. The lock is already version-drifted (1.2.1 vs 1.3.0), and installs were still in progress, so I could not run the real `bun install --frozen-lockfile` check or the real vite+ws upgrade; both are unverified.
4. ghostty-web is a git dependency at a pinned SHA (not on npm), ~400 KB inline wasm in the lazy chunk, canvas-only rendering (a11y), and the window-level Escape handler in ActivityDrawer conflicts with terminal input.
5. Sessions that outlive the WS (reconnect support) can leak processes if the reaper or the host-exit hook fails; the vite `close` event only fires on a clean shutdown (Ctrl+C), not SIGKILL, so also add an `exit` listener.
6. The `omp` binary env: stripping env may break omp's provider auth; the allowlist needs omp's actual variable list [unverified here].
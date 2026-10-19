---
phase: 06-omp-settings-terminal
plan: "01"
subsystem: settings-terminal
tags: [omp-config, settings, pty, terminal, ghostty-web, node-pty, websocket, accessibility, react]

requires:
  - phase: 01-discovery-engine-port
    provides: "shared/omp.ts and shared/terminal.ts wires, decisions D-11/D-12"
  - phase: 02-omp-engine-adapter
    provides: "omp binary check, launch builder, model catalog"
affects: [07-integration-migration-removal]
provides:
  - "lib/omp-config: OpenFlow settings store (omp-settings.json) plus omp options read and written through omp config list|get|set|reset"
  - "Settings dialog with Options and Status tabs, validation errors, effective config, omp availability and version"
  - "Copy logins action: omp auth export from the default profile piped into omp auth import for the OpenFlow profile"
  - "lib/terminal: PTY host, loopback gate, one-shot tickets, WebSocket transports for Bun and Node"
  - "Global bottom terminal dock (Ctrl+backtick) with omp and shell kinds, resize, copy, paste, 10k scrollback, exit strip and Restart"
  - "Keyboard accessibility for the settings dialog and the dock"
key-files:
  created:
    - packages/flow/lib/omp-config/config.ts
    - packages/flow/lib/omp-config/settings.ts
    - packages/flow/lib/omp-config/routes.ts
    - packages/flow/lib/omp-config/status.ts
    - packages/flow/lib/omp-config/auth.ts
    - packages/flow/lib/omp-config/providers.ts
    - packages/flow/lib/terminal/host.ts
    - packages/flow/lib/terminal/policy.ts
    - packages/flow/lib/terminal/routes.ts
    - packages/flow/lib/terminal/pty-bun.ts
    - packages/flow/lib/terminal/pty-node.ts
    - packages/flow/lib/terminal/ws-bun.ts
    - packages/flow/lib/terminal/ws-node.ts
    - packages/flow/src/ui/omp-settings.tsx
    - packages/flow/src/ui/omp-settings-model.ts
    - packages/flow/src/ui/terminal-dock.tsx
    - packages/flow/src/ui/terminal-session.ts
    - packages/flow/src/ui/terminal-frames.ts
  modified:
    - packages/flow/lib/omp/launch.ts
    - packages/flow/lib/omp/binary.ts
    - packages/flow/src/app.tsx

key-decisions:
  - "D-11: OpenFlow settings live in <state dir>/omp-settings.json with no secrets; omp's own options go through omp config so omp validates them; provider keys are entered in the terminal (/login) or env, never through OpenFlow HTTP"
  - "D-12: one global bottom dock; gate is the x-openflow-pty header, loopback Origin and Host, and a one-shot ticket bound to the session; off when FLOW_ALLOW_REMOTE=1; env allowlist excludes API keys and substrate/swarm secrets; ghostty-web in the browser"
  - "TRM-01 amended 2026-10-19: the host keeps at most four PTYs so omp, shell and restarts can coexist; the UI shows one dock"
  - "Copy logins is one confirmed action that pipes the two omp auth commands; nothing is written to disk or echoed"
  - "The model catalog and provider list are keyed on a credential stamp so logins changed by Copy logins or the terminal show up at once"

patterns-established:
  - "Settings are generated from omp's real listing (categories and enum choices), not a hand-copied schema"
  - "Terminal spawn plan (argv, cwd, env) is always derived by the host; the browser sends only a kind"

requirements-completed: [CFG-01, CFG-02, CFG-03, TRM-01, TRM-02, TRM-03, QA-02]

duration: "~39min for the first landing (13:50-14:29, built with phases 2-5); login, catalog and test-race fixes until 17:10"
completed: 2026-10-19
status: complete
---

# Phase 6: Omp settings and terminal Summary

**An in-app settings dialog generated from omp's own options plus a loopback-gated PTY terminal dock (omp or shell), both keyboard accessible, with a one-click copy of omp logins into the OpenFlow profile.**

## Performance

- **Duration:** first landing about 39 minutes after the contract (14:29); fixes from 14:59 to 17:10
- **Tasks:** none recorded (direct orchestration)

## Accomplishments

- Options tab reads `omp config list`, edits through `config set` and `reset`, and returns 422 `{errors:[{path,message}]}` for invalid values; `focusFirstInvalid` moves focus to the first error.
- Status tab shows effective configuration and omp availability and version; a saved change resets the status cache and the next launch reads it (`launch.ts` builds argv from settings).
- Terminal dock: resize grip, ghostty-web emulator, copy and paste handlers, 10,000-line scrollback; `Exited <code>` strip with Restart; closing the dock detaches while sessions live on.
- Accessibility: focus trap and return, ARIA tabs, Escape steps back one level, live regions, Ctrl+backtick leaves the PTY for the dock controls.

## Task Commits

Shared first landing with phases 2 to 5:

1. `a153ee993` feat(flow): add omp engine host, stage modules and terminal (SPE-16064/65)
2. `135dd029e` feat(flow): ... card/inspector/settings/terminal/memory UI (SPE-16064/65/66)

Phase 6 follow-ups:

3. `26c087f08` feat(flow): copy omp logins into the openflow profile (SPE-16064)
4. `71a0d4eb5` fix(flow): make first run work on a profile with no logins (SPE-16064/66)
5. `a73f2c165` fix(flow): gate every host route against cross-site and rebinding requests (SPE-16063/65/66/68)
6. `61ee96d18` fix(flow): ... flaky terminal and swarm tests are deterministic or skipped on Windows
7. `ab74592ec` docs(planning): amend SWM-03 and TRM-01 and add the parity checklist

## Files Created/Modified

- `lib/omp-config/` - `config.ts` (omp listing, set, reset), `settings.ts` (validation, effective sources), `routes.ts`, `status.ts`, `auth.ts` (copy logins), `providers.ts`.
- `lib/terminal/` - `host.ts`, `policy.ts`, `routes.ts`, PTY backends and WebSocket transports; `vite/flow-pty.ts` mounted the upgrade under Vite until it was deleted in `b975f932b`.
- `src/ui/omp-settings*.ts(x)`, `terminal-*.ts(x)`, `src/app.tsx` - dialog, dock and wiring.

## Decisions Made

See `key-decisions`.

## Deviations from Plan

- No PLAN.md; built in the shared wave.
- **TRM-01 amended.** The text now names the real gate (custom header, same-origin check, one-shot ticket) and the host's cap of four PTYs so omp, shell and restarts can coexist while the UI shows one dock; the verifier checked both. REQUIREMENTS.md was amended in `ab74592ec`.
- **PTY implementation differs from D-12.** D-12 specified one `@lydell/node-pty` implementation for both hosts. Under Bun that backend failed (the shell was hung up about 10 ms after spawn), so `pty-bun.ts` uses `Bun.spawn({ terminal })` and `pty-node.ts` uses `@lydell/node-pty`, selected by `"Bun" in globalThis`. `ws-bun.ts` and `ws-node.ts` are the matching transports.
- The route gate was widened to every `/flow/api` route in both hosts after the security gate (see Phase 7); the terminal ticket and header remain on top.

## Issues Encountered

- **Stale model catalog after Copy logins.** Logins changed outside the catalog cache did not appear; the catalog and provider list are now keyed on a credential stamp, and the app refetches models when the terminal or settings close (`71a0d4eb5`).
- **omp refused to start without a default model** on a fresh profile with no logins; probe processes now pass `--model`, the walkthrough shows a loading state, and preflight tells the user to log in in Omp settings.
- **`ws` test races.** The terminal WebSocket tests and swarm tests were flaky; they were made deterministic, with POSIX-only suites skipped on Windows (`a73f2c165`, `61ee96d18`).

## User Setup Required

Provider keys are entered in the terminal (`/login`), by Copy logins from the default omp profile, or by environment. OpenFlow never takes a key over HTTP.

## Next Phase Readiness

The dock and dialog are mounted in `src/app.tsx` by Phase 7 wiring. Verification: `06-VERIFICATION.md` status `passed`, 5/5 truths. Spot-checks: 241 pass (unit suites) and 65 pass (transport, host and config routes), 0 fail. CFG-01 to CFG-03, TRM-01 (amended), TRM-02, TRM-03 and QA-02 SATISFIED; QA-02 rests on code plus a live keyboard walk.

---
*Phase: 06-omp-settings-terminal*
*Completed: 2026-10-19*

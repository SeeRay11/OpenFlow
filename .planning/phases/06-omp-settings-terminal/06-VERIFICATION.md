---
phase: 06-omp-settings-terminal
verified: 2026-10-19T18:01:40Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - .planning/phases/06-omp-settings-terminal/06-01-SUMMARY.md
  - packages/flow/lib/omp-config/config.ts
  - packages/flow/lib/omp-config/routes.ts
  - packages/flow/lib/omp-config/settings.ts
  - packages/flow/lib/omp/binary.ts
  - packages/flow/lib/omp/launch.ts
  - packages/flow/lib/terminal/host.ts
  - packages/flow/lib/terminal/index.ts
  - packages/flow/lib/terminal/policy.ts
  - packages/flow/lib/terminal/routes.ts
  - packages/flow/lib/terminal/ws-node.ts
  - packages/flow/shared/terminal.ts
  - packages/flow/src/app.tsx
  - packages/flow/src/ui/omp-settings-model.ts
  - packages/flow/src/ui/omp-settings.tsx
  - packages/flow/src/ui/terminal-dock.tsx
  - packages/flow/src/ui/terminal-frames.ts
  - packages/flow/src/ui/terminal-session.ts
covered_digest: "v1:sha256:7940870c2f452a9c935a719640b1bea5d47491820466ecb7424545542a85fb59"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 5/5
  previous_verified: 2026-10-19T00:00:00Z
  previous_head: 785370f5e
  current_head: 9491ea496
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 6: Omp Settings and Terminal Verification Report

**Phase Goal:** Users can configure Omp from the app and run omp interactively in a bottom-docked PTY terminal.
**Verified:** 2026-10-19T18:01:40Z (re-verification at HEAD `9491ea496`; initial report at `785370f5e`)
**Status:** passed
**Re-verification:** Yes — after gate-hardening commits `b975f932b`, `c9d388905`, `9491ea496`; no regressions found.

## Re-verification Scope

`git diff 785370f5e..HEAD --stat` for this phase's files touched exactly six files:

- `packages/flow/lib/omp-config/settings.ts` (+11/−2): added `withoutRetired` — a saved `uplift.hitl` key from earlier builds is stripped before merge so old settings files load as if it were absent. No truth regressed; this strengthens CFG-01 forward-compat (old files still load, unknown-key warning path unchanged). New tests in `settings.test.ts` (+20 lines) cover it.
- `packages/flow/src/ui/omp-settings-model.ts` (−6): removed the `uplift.hitl` field definition ("Let the planner ask clarifying questions"). Consistent with the `c9d388905` removal of the planner-questions setting; no dangling `uplift.hitl` reference remains outside the migration shim (grep verified).
- `packages/flow/lib/terminal/ws-node.ts` (+17/−1): added `attachDevUpgrade` for the vite dev host (handles HTTP/2 and middleware-mode servers, wires `onClose`); replaces deleted `vite/flow-pty.ts`. Terminal policy, ticket gate, and browser client untouched. New tests in `ws-node.test.ts` cover the attach paths.
- `packages/flow/lib/terminal/index.ts` (comment-only): doc comment updated to name `attachDevUpgrade` instead of `flowPty`.
- `packages/flow/lib/omp-config/settings.test.ts`, `packages/flow/lib/terminal/ws-node.test.ts`: new coverage only.

All other phase-6 files are byte-identical to the initial verification. The notable cross-cutting changes (raw-path refusal, vite store path, CORS off, standalone `server-app.ts`, `EngineApi.releaseRun`, session-cap eviction, run-state prune, MCP toggle removal) touch engine/host/vite wiring outside this phase's must-haves; none alter the settings↔runs or terminal data paths verified below. Re-ran all phase-6 test files on the current tree: **255 pass / 0 fail** (was 241 across 7 files; +14 from the new settings/ws-node tests).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Settings UI is generated from omp's real options; valid edits save and reset, invalid ones show validation errors (SC1; CFG-01, CFG-02) | ✓ VERIFIED | `lib/omp-config/config.ts`: `createConfig` reads/writes through real `omp` binary (`createRun` spawns `omp config ...`, `parseListing` parses omp's text listing for categories + enum choices, `toEntry` builds entries); `set`/`reset` per-key routes in `lib/omp-config/routes.ts` (`PUT config/:key`, `POST config/:key/reset`, 422 with `{errors:[{path,message}]}` via `ValidationFailure`). OpenFlow's own settings in `lib/omp-config/settings.ts`: `merge` rejects unknown keys/wrong types, `validateSettings` enforces rules, `createSettingsStore.update` returns 422 on invalid; `withoutRetired` strips the retired `uplift.hitl` key before merge (re-verified, no dangling refs). UI `omp-settings.tsx` "Omp options" tab renders entries from server data with per-field errors, `focusFirstInvalid` moves focus to first error. Tests: `settings.test.ts`, `config.test.ts`, `routes.test.ts`, `omp-settings-model.test.ts` — pass on current tree (255-file run). |
| 2 | Settings show effective config plus omp availability and version; a saved change affects subsequent runs (SC2; CFG-02, CFG-03) | ✓ VERIFIED | `lib/omp-config/routes.ts`: `GET OMP_ROUTES.status` returns checker status + warnings; `effectiveSources` in `settings.ts` computes effective config lines shown by `effectiveLines` in UI status tab (`omp-settings.tsx` status summary + problems list). Availability/version via `lib/omp/binary.ts` `checkOmp`/`resolveBinary` (missing binary → 503 "omp was not found...", wrong version → actionable fix text; status cache reset by `resetOmpCheck()` after settings change and after Copy logins). Runs affected: `lib/omp/launch.ts` builds argv from `input.settings` (`manualApproval`, `maxSessionMinutes`, `profile`, `loadUserExtensions`, `binary` via `resolveBinary`). Unchanged since initial report. Live testimony consistent: omp options listing (557 options) with real `omp config set`/reset (2.2 s each). |
| 3 | Terminal docks at bottom, loopback + per-launch-token only, runs omp interactively, supports resize/copy/paste/scrollback (SC3; TRM-01, TRM-02) | ✓ VERIFIED | `src/ui/terminal-dock.tsx`: bottom-dock `<section role="region" aria-label="Terminal">` with resize grip (MIN/MAX/DEFAULT height), ghostty-web emulator with `scrollback: 10_000`, copy handler (Ctrl+Shift+C + copy event), paste handler, `onResize → encodeResize` sent over socket. Security: `lib/terminal/policy.ts` `httpRefusal` (custom `PTY_HEADER` required, loopback-only, same-origin) + `upgradeRefusal` (Origin + Host) + one-shot `TicketStore` (bound to session id, expiring); `spawnPlan` argv/cwd/env always host-derived, env allowlisted (`terminalEnv`), shell resolved via `/etc/shells`. Cap: `shared/terminal.ts` `PTY_LIMITS.maxSessions = 4` enforced in `host.ts` (`at most 4 terminals can run at once`, 429) — matches amended TRM-01 (one global dock UI, up to four host PTYs). Dev-host wiring moved from deleted `vite/flow-pty.ts` to `attachDevUpgrade` in `ws-node.ts` (re-verified; policy path identical, new tests pass). Wired into app: `src/app.tsx` `terminalOpen` signal + `<TerminalDock open={...}>`. Tests: `terminal.test.ts`, `policy.test.ts`, `host.test.ts`, `ws-bun/node.test.ts` pass on current tree. Live testimony consistent: terminal dock in real Chrome (open, type, Ctrl+C, `/exit`), loopback gate 403s, 150 KB same-origin PUT intact. |
| 4 | After PTY exit a visible message appears; terminal can be restarted/reopened (SC4; TRM-03) | ✓ VERIFIED | `terminal-session.ts`: `exit` event → phase `exited`; `statusText` yields `Exited ${code}` / `Exited (${signal})` / `Session ended`; `actionLabel` yields `Restart` for `exited`. `terminal-dock.tsx`: `strip()` shows `.terminal-strip` with status text + action button for `exited`/`disconnected`; `restart()` re-issues ticket and reconnects; closing dock detaches (sessions outlive in `remembered` per kind), reopening reattaches. Host keeps exited sessions briefly (`exitedKept`) then reaps. Unchanged since initial report. Tests: `terminal-session.test.ts`, `terminal-frames.test.ts` pass. Live testimony consistent: `/exit` → `Exited 0` with Restart button, restart, close, 10-min idle reap. |
| 5 | Terminal and settings are fully keyboard accessible (SC5; QA-02) | ✓ VERIFIED | Settings: modal dialog (`omp-settings.tsx`) — focus moves in on open, returns to opener on close, Tab cycles via `trapTarget` + FOCUSABLE query, Escape steps back one level (comment documented + `escapeStep`), ARIA tabs (`role="tablist"`, `role="tab"`, `aria-selected`), arrow/Home/End handling per testimony, per-field `aria-invalid`/`aria-describedby`, `focusFirstInvalid` on save errors, `role="alert"`/`role="status"` live regions. The removed `uplift.hitl` toggle was a standard field; its removal changes no keyboard machinery. Terminal: Ctrl+` leaves PTY for dock controls (custom key handler blurs terminal, focuses kind switch; header hint documents it), kind buttons `aria-pressed` in `role="group"`, status `role="status" aria-live="polite"`, region named, all buttons real `<button>`s. Unchanged since initial report. Live testimony consistent: keyboard-only walk of settings dialog, Ctrl+` toggles terminal. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flow/lib/omp-config/settings.ts` | OpenFlow omp settings store + validation | ✓ VERIFIED | Exists, substantive, wired (routes, binary check, launch); +`withoutRetired` migration shim re-verified |
| `packages/flow/lib/omp-config/config.ts` | Real `omp config` surface via binary | ✓ VERIFIED | Exists, substantive, wired (routes → UI options tab); unchanged |
| `packages/flow/lib/omp-config/routes.ts` | Settings/config HTTP surface | ✓ VERIFIED | Exists, substantive, wired to host; unchanged |
| `packages/flow/lib/terminal/host.ts` | PTY session management | ✓ VERIFIED | Exists, substantive, wired (routes + ws transports); 4-session cap enforced; unchanged |
| `packages/flow/lib/terminal/policy.ts` | Ticket/gate/spawn policy | ✓ VERIFIED | Exists, substantive, wired; unchanged |
| `packages/flow/lib/terminal/routes.ts` | PTY ticket/list/delete HTTP + upgrade | ✓ VERIFIED | Exists, substantive, wired; unchanged |
| `packages/flow/lib/terminal/ws-node.ts` | Node/WS transport + dev attach | ✓ VERIFIED | Exists, substantive, wired; +`attachDevUpgrade` re-verified with new tests |
| `packages/flow/lib/terminal/index.ts` | Terminal module wiring docs | ✓ VERIFIED | Comment-only update; accurate |
| `packages/flow/shared/terminal.ts` | PTY limits + protocol constants | ✓ VERIFIED | Exists (`PTY_LIMITS.maxSessions = 4`), substantive, wired; unchanged |
| `packages/flow/src/ui/omp-settings.tsx` | Settings dialog | ✓ VERIFIED | Exists (955 lines), substantive, wired; unchanged |
| `packages/flow/src/ui/omp-settings-model.ts` | Dialog model (tabs/fields/validation) | ✓ VERIFIED | `uplift.hitl` field removed, consistent with setting retirement; no dangling refs |
| `packages/flow/src/ui/terminal-dock.tsx` | Bottom dock PTY UI | ✓ VERIFIED | Exists (395 lines), substantive, wired (`app.tsx` renders it); unchanged |
| `packages/flow/src/ui/terminal-session.ts` | Session state machine | ✓ VERIFIED | Exists, substantive, wired; unchanged |
| `packages/flow/src/ui/terminal-frames.ts` | WS frame codec + headers | ✓ VERIFIED | Exists, substantive, wired; unchanged |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| omp-settings.tsx options tab | `lib/omp-config/config.ts` via routes | fetch `omp config` set/reset per key | WIRED | `src/server/omp-config` client → host routes → `parts.config.set/reset` (spawns real omp); unchanged |
| settings save | subsequent card runs | `launch.ts` reads `input.settings` | WIRED | binary/profile/approval/session-minutes/extensions flow into omp argv; `resetOmpCheck` invalidates status cache; unchanged |
| terminal-dock.tsx | `lib/terminal` host via WS | one-shot ticket + `ptyHeaders` + `encodeResize`/frames | WIRED | `ticketInit` → `POST ticket` → `terminalUpgrade` → socket; dev transport now via `attachDevUpgrade`, same policy path |
| app.tsx | TerminalDock | `terminalOpen` signal | WIRED | `app.tsx:245,423,1135-1140,1523-1524`; unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| omp-settings options tab | config entries | real `omp config` listing via `createRun` + `parseListing` | Yes — 557 real options observed live | ✓ FLOWING |
| omp-settings status tab | availability/version/effective | `checkOmp` (spawns binary) + `effectiveSources` | Yes | ✓ FLOWING |
| terminal-dock surface | PTY bytes | real PTY process via host + ring replay | Yes — live type/Ctrl+C/`/exit` observed | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase-6 unit tests (current tree) | `bun test lib/terminal/terminal.test.ts lib/terminal/policy.test.ts lib/terminal/ws-node.test.ts lib/omp-config/settings.test.ts lib/omp-config/config.test.ts src/ui/omp-settings-model.test.ts src/ui/terminal-session.test.ts src/ui/terminal-frames.test.ts` | 255 pass / 0 fail | ✓ PASS |

Full suite not run (seven verifiers in parallel; orchestrator measured 2488 pass / 0 fail / 1 skip at `785370f5e`).

### Probe Execution

No phase-declared probes; conventional `scripts/*/tests/probe-*.sh` not applicable (not a migration/tooling phase). Skipped.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| CFG-01 | ROADMAP Phase 6 | Settings generated from omp's real options, edit/save/reset | ✓ SATISFIED | config.ts real listing + set/reset; routes; UI options tab; retired-key shim keeps old files loadable |
| CFG-02 | ROADMAP Phase 6 | Invalid → validation errors; effective config + availability/version shown | ✓ SATISFIED | validateSettings/merge errors → 422 → field errors + focusFirstInvalid; status tab + effective lines |
| CFG-03 | ROADMAP Phase 6 | Saved change affects subsequent runs | ✓ SATISFIED | launch.ts consumes settings; status cache reset on change |
| TRM-01 (amended) | ROADMAP Phase 6 | One global bottom dock; loopback + custom header + same-origin + one-shot ticket; ≤4 host PTYs | ✓ SATISFIED | policy gates + TicketStore + maxSessions=4 + single dock in app.tsx; dev attach preserves gates |
| TRM-02 | ROADMAP Phase 6 | Interactive omp, resize, copy, paste, scrollback, close | ✓ SATISFIED | ghostty emulator, resize/grip/onResize, copy/paste handlers, scrollback 10k, close detaches |
| TRM-03 | ROADMAP Phase 6 | Visible exit message; reopen/restart | ✓ SATISFIED | Exited strip + Restart; sessions outlive dock close |
| QA-02 | ROADMAP Phase 6 | Terminal + settings keyboard accessible | ✓ SATISFIED | Focus trap/ARIA tabs/Escape/Ctrl+` /live regions (code + live keyboard walk testimony) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | Grep for TBD/FIXME/XXX/TODO/PLACEHOLDER/Not implemented in phase-6 files returned zero hits; no dangling `uplift.hitl` or `flow-pty` references | — | None |

### Human Verification Required

None — all truths verified by code + passing tests on the current tree + live testimony consistent with the code.

### Gaps Summary

No gaps. Re-verification at HEAD `9491ea496` confirms all five success criteria still hold: the six changed files contain only the retired-setting migration, the removed planner-questions field, and the dev-host transport rewire (same policy path, new tests) plus comment/test updates. Nothing regressed.

---
_Verified: 2026-10-19T18:01:40Z_
_Verifier: Claude (gsd-verifier, Verify6)_

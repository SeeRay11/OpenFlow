---
phase: 06-omp-settings-terminal
verified: 2026-10-19T00:00:00Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - packages/flow/lib/omp-config/settings.ts
  - packages/flow/lib/omp-config/config.ts
  - packages/flow/lib/omp-config/routes.ts
  - packages/flow/lib/omp/binary.ts
  - packages/flow/lib/omp/launch.ts
  - packages/flow/lib/terminal/host.ts
  - packages/flow/lib/terminal/policy.ts
  - packages/flow/lib/terminal/routes.ts
  - packages/flow/shared/terminal.ts
  - packages/flow/src/ui/omp-settings.tsx
  - packages/flow/src/ui/omp-settings-model.ts
  - packages/flow/src/ui/terminal-dock.tsx
  - packages/flow/src/ui/terminal-session.ts
  - packages/flow/src/ui/terminal-frames.ts
  - packages/flow/src/app.tsx
covered_digest: "v1:unavailable-no-fingerprint-tool"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 6: Omp Settings and Terminal Verification Report

**Phase Goal:** Users can configure Omp from the app and run omp interactively in a bottom-docked PTY terminal.
**Verified:** 2026-10-19
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Settings UI is generated from omp's real options; valid edits save and reset, invalid ones show validation errors (SC1; CFG-01, CFG-02) | ✓ VERIFIED | `lib/omp-config/config.ts`: `createConfig` reads/writes through real `omp` binary (`createRun` spawns `omp config ...`, `parseListing` parses omp's text listing for categories + enum choices, `toEntry` builds entries); `set`/`reset` per-key routes in `lib/omp-config/routes.ts` (`PUT config/:key`, `POST config/:key/reset`, 422 with `{errors:[{path,message}]}` via `ValidationFailure`). OpenFlow's own settings in `lib/omp-config/settings.ts`: `merge` rejects unknown keys/wrong types, `validateSettings` enforces rules, `createSettingsStore.update` returns 422 on invalid. UI `omp-settings.tsx` "Omp options" tab renders entries from server data with per-field errors, `focusFirstInvalid` moves focus to first error. Tests: `settings.test.ts`, `config.test.ts`, `routes.test.ts`, `omp-settings-model.test.ts` — 241 pass across 7 phase-6 files (this run). |
| 2 | Settings show effective config plus omp availability and version; a saved change affects subsequent runs (SC2; CFG-02, CFG-03) | ✓ VERIFIED | `lib/omp-config/routes.ts`: `GET OMP_ROUTES.status` returns checker status + warnings; `effectiveSources` in `settings.ts` computes effective config lines shown by `effectiveLines` in UI status tab (`omp-settings.tsx` status summary + problems list). Availability/version via `lib/omp/binary.ts` `checkOmp`/`resolveBinary` (missing binary → 503 "omp was not found...", wrong version → actionable fix text; status cache reset by `resetOmpCheck()` after settings change and after Copy logins). Runs affected: `lib/omp/launch.ts` builds argv from `input.settings` (`manualApproval`, `maxSessionMinutes`, `profile`, `loadUserExtensions`, `binary` via `resolveBinary`). Live testimony consistent: omp options listing (557 options) with real `omp config set`/reset (2.2 s each). |
| 3 | Terminal docks at bottom, loopback + per-launch-token only, runs omp interactively, supports resize/copy/paste/scrollback (SC3; TRM-01, TRM-02) | ✓ VERIFIED | `src/ui/terminal-dock.tsx`: bottom-dock `<section role="region" aria-label="Terminal">` with resize grip (`terminal-grip`, MIN/MAX/DEFAULT height), ghostty-web emulator with `scrollback: 10_000`, copy handler (Ctrl+Shift+C + copy event), paste handler, `onResize → encodeResize` sent over socket. Security: `lib/terminal/policy.ts` `httpRefusal` (custom `PTY_HEADER` required, loopback-only, same-origin) + `upgradeRefusal` (Origin + Host) + one-shot `TicketStore` (bound to session id, expiring); `spawnPlan` argv/cwd/env always host-derived, env allowlisted (`terminalEnv`), shell resolved via `/etc/shells`. Cap: `shared/terminal.ts` `PTY_LIMITS.maxSessions = 4` enforced in `host.ts` (`at most 4 terminals can run at once`, 429) — matches amended TRM-01 (one global dock UI, up to four host PTYs). Wired into app: `src/app.tsx` `terminalOpen` signal + `<TerminalDock open={...}>`. Tests: `terminal.test.ts`, `policy.test.ts`, `host.test.ts`, `ws-bun/node.test.ts` pass. Live testimony consistent: terminal dock in real Chrome (open, type, Ctrl+C, `/exit`), loopback gate 403s, 150 KB same-origin PUT intact. |
| 4 | After PTY exit a visible message appears; terminal can be restarted/reopened (SC4; TRM-03) | ✓ VERIFIED | `terminal-session.ts`: `exit` event → phase `exited`; `statusText` yields `Exited ${code}` / `Exited (${signal})` / `Session ended`; `actionLabel` yields `Restart` for `exited`. `terminal-dock.tsx`: `strip()` shows `.terminal-strip` with status text + action button for `exited`/`disconnected`; `restart()` re-issues ticket and reconnects; closing dock detaches (sessions outlive in `remembered` per kind), reopening reattaches. Host keeps exited sessions briefly (`exitedKept`) then reaps. Tests: `terminal-session.test.ts`, `terminal-frames.test.ts` pass. Live testimony consistent: `/exit` → `Exited 0` with Restart button, restart, close, 10-min idle reap. |
| 5 | Terminal and settings are fully keyboard accessible (SC5; QA-02) | ✓ VERIFIED | Settings: modal dialog (`omp-settings.tsx`) — focus moves in on open, returns to opener on close, Tab cycles via `trapTarget` + FOCUSABLE query, Escape steps back one level (comment documented + `escapeStep`), ARIA tabs (`role="tablist"`, `role="tab"`, `aria-selected`), arrow/Home/End handling per testimony, per-field `aria-invalid`/`aria-describedby`, `focusFirstInvalid` on save errors, `role="alert"`/`role="status"` live regions. Terminal: Ctrl+` leaves PTY for dock controls (custom key handler blurs terminal, focuses kind switch; header hint documents it), kind buttons `aria-pressed` in `role="group"`, status `role="status" aria-live="polite"`, region named, all buttons real `<button>`s. Live testimony consistent: keyboard-only walk of settings dialog, Ctrl+` toggles terminal. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flow/lib/omp-config/settings.ts` | OpenFlow omp settings store + validation | ✓ VERIFIED | Exists (~290 lines), substantive, wired (routes, binary check, launch) |
| `packages/flow/lib/omp-config/config.ts` | Real `omp config` surface via binary | ✓ VERIFIED | Exists (~300 lines), substantive, wired (routes → UI options tab) |
| `packages/flow/lib/omp-config/routes.ts` | Settings/config HTTP surface | ✓ VERIFIED | Exists, substantive (status/settings/reset/authImport/providers/config set+reset), wired to host |
| `packages/flow/lib/terminal/host.ts` | PTY session management | ✓ VERIFIED | Exists, substantive, wired (routes + ws transports); 4-session cap enforced |
| `packages/flow/lib/terminal/policy.ts` | Ticket/gate/spawn policy | ✓ VERIFIED | Exists, substantive, wired (routes.ts + transports call `terminalUpgrade`) |
| `packages/flow/lib/terminal/routes.ts` | PTY ticket/list/delete HTTP + upgrade | ✓ VERIFIED | Exists, substantive, wired |
| `packages/flow/shared/terminal.ts` | PTY limits + protocol constants | ✓ VERIFIED | Exists (`PTY_LIMITS.maxSessions = 4`), substantive, wired |
| `packages/flow/src/ui/omp-settings.tsx` | Settings dialog | ✓ VERIFIED | Exists (955 lines), substantive, wired (fetches status/settings/config/providers) |
| `packages/flow/src/ui/omp-settings-model.ts` | Dialog model (tabs/fields/validation) | ✓ VERIFIED | Exists, substantive, wired |
| `packages/flow/src/ui/terminal-dock.tsx` | Bottom dock PTY UI | ✓ VERIFIED | Exists (395 lines), substantive, wired (`app.tsx` renders it) |
| `packages/flow/src/ui/terminal-session.ts` | Session state machine | ✓ VERIFIED | Exists, substantive, wired (dock reduces over it) |
| `packages/flow/src/ui/terminal-frames.ts` | WS frame codec + headers | ✓ VERIFIED | Exists, substantive, wired |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| omp-settings.tsx options tab | `lib/omp-config/config.ts` via routes | fetch `omp config` set/reset per key | WIRED | `src/server/omp-config` client → host routes → `parts.config.set/reset` (spawns real omp) |
| settings save | subsequent card runs | `launch.ts` reads `input.settings` | WIRED | binary/profile/approval/session-minutes/extensions flow into omp argv; `resetOmpCheck` invalidates status cache |
| terminal-dock.tsx | `lib/terminal` host via WS | one-shot ticket + `ptyHeaders` + `encodeResize`/frames | WIRED | `ticketInit` → `POST ticket` → `terminalUpgrade` → socket; resize/copy/paste handlers present |
| app.tsx | TerminalDock | `terminalOpen` signal | WIRED | `app.tsx:245,423,1135-1140,1523-1524` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| omp-settings options tab | config entries | real `omp config` listing via `createRun` + `parseListing` | Yes — 557 real options observed live | ✓ FLOWING |
| omp-settings status tab | availability/version/effective | `checkOmp` (spawns binary) + `effectiveSources` | Yes | ✓ FLOWING |
| terminal-dock surface | PTY bytes | real PTY process via host + ring replay | Yes — live type/Ctrl+C/`/exit` observed | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase-6 unit tests | `bun test lib/terminal/terminal.test.ts lib/terminal/policy.test.ts lib/omp-config/settings.test.ts lib/omp-config/config.test.ts src/ui/omp-settings-model.test.ts src/ui/terminal-session.test.ts src/ui/terminal-frames.test.ts` | 241 pass / 0 fail | ✓ PASS |
| Terminal transport + host + config routes tests | `bun test lib/terminal/ws-bun.test.ts lib/terminal/ws-node.test.ts lib/terminal/host.test.ts lib/omp-config/routes.test.ts` | 65 pass / 0 fail | ✓ PASS |

Full suite not run (seven verifiers in parallel; orchestrator measured 2488 pass / 0 fail / 1 skip at `785370f5e`).

### Probe Execution

No phase-declared probes; conventional `scripts/*/tests/probe-*.sh` not applicable (not a migration/tooling phase). Skipped.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| CFG-01 | ROADMAP Phase 6 | Settings generated from omp's real options, edit/save/reset | ✓ SATISFIED | config.ts real listing + set/reset; routes; UI options tab |
| CFG-02 | ROADMAP Phase 6 | Invalid → validation errors; effective config + availability/version shown | ✓ SATISFIED | validateSettings/merge errors → 422 → field errors + focusFirstInvalid; status tab + effective lines |
| CFG-03 | ROADMAP Phase 6 | Saved change affects subsequent runs | ✓ SATISFIED | launch.ts consumes settings; status cache reset on change |
| TRM-01 (amended) | ROADMAP Phase 6 | One global bottom dock; loopback + custom header + same-origin + one-shot ticket; ≤4 host PTYs | ✓ SATISFIED | policy gates + TicketStore + maxSessions=4 + single dock in app.tsx |
| TRM-02 | ROADMAP Phase 6 | Interactive omp, resize, copy, paste, scrollback, close | ✓ SATISFIED | ghostty emulator, resize/grip/onResize, copy/paste handlers, scrollback 10k, close detaches |
| TRM-03 | ROADMAP Phase 6 | Visible exit message; reopen/restart | ✓ SATISFIED | Exited strip + Restart; sessions outlive dock close |
| QA-02 | ROADMAP Phase 6 | Terminal + settings keyboard accessible | ✓ SATISFIED | Focus trap/ARIA tabs/Escape/Ctrl+` /live regions (code + live keyboard walk testimony) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | Grep for TBD/FIXME/XXX/TODO/PLACEHOLDER/Not implemented in 5 phase-6 files returned zero hits | — | None |

### Human Verification Required

None — all truths verified by code + passing tests + live testimony consistent with the code.

### Gaps Summary

No gaps. All five success criteria hold in the codebase: settings are driven by omp's real option surface with validation and effective/availability display wired into subsequent runs, and the terminal is a secured single bottom dock (loopback + header + origin + one-shot ticket, ≤4 host PTYs) with interactive use, resize/copy/paste/scrollback, exit-restart, and keyboard access.

---
_Verified: 2026-10-19_
_Verifier: Claude (gsd-verifier, Verify6)_

# Autonogrammer upgrade notes

Fetched 2026-10-20.

## Phase gate

Recorded milestone: `.planning` v1.4.0 Omp Engine, phases 1–7, each marked complete on 2026-10-19 in `.planning/ROADMAP.md` and `.planning/STATE.md`.

Verified in this tree, not invented:

- Engine port and Omp adapter: `packages/flow/lib/omp`, `packages/flow/lib/host/index.ts` (`omp` session per card).
- Prompt uplift: `packages/flow/lib/uplift`.
- Agent Substrate memory: `packages/flow/lib/substrate`.
- Swarm per card: `packages/flow/lib/swarm`.
- Settings and PTY terminal: `packages/flow/lib/omp-config`, `packages/flow/lib/terminal`.
- Graph fan-out already persisted as `{ id, source, target }[]` in `packages/flow/src/graph/types.ts`. `layer()` in `validate.ts` rejects a missing target and a cycle. Pipeline join is the existing layer barrier (`runPipeline` in `src/server/engine.ts`): a layer finishes before the next starts. No new barrier was added.
- The parent monorepo `.planning` (Voice stream) is a different project and was not treated as this milestone.

Nothing in that milestone was unfinished. Autonogrammer work started after this check.

## External contracts

- Rivet AgentOS, 2026-10-20, no version number on the pages: persistence, filesystem, embedded, quickstart-embedded, compiler toolchain. Package inspected on npm: `@rivet-dev/agentos-core` 0.4.1. Durable root is `database.type = sqlite_file` plus `rootFilesystem.plugin.id = chunked_sqlite`. Default memory root is discarded on dispose. Guest commands are `wasm32-wasip1`. Processes and terminals do not survive recreation. This checkout does not depend on the native package; a card boot calls `AgentOs.create` and, if the import fails, that card is `failed` and siblings stay mounted.
- Tauri CLI latest seen: 2.12.3, which supports Linux, macOS, Windows, Android, and iOS. This repo ships a Tauri 2 config under `packages/flow/src-tauri` for desktop. The web UI is the Vite build, not a Tauri target. Android and iOS projects were not generated because this host has no Android SDK or Xcode. Headless Linux is `bun packages/flow/server.ts` (no window). The app terminal is the existing loopback PTY; web and mobile show card session output and do not get a host PTY.
- Greptile design page names Anybody, DM Sans, and Space Mono. Anybody and DM Sans are vendored as OFL woff2 files. Terminal text stays monospace. Space Mono is not the body face.
- License: `terra-slate-rose-berry/LICENSE` is the Autonogrammer General License 3.0 (`LicenseRef-AGL-3.0`), not the GNU AGPL. This repo vendors that text with the covered product set to Autonogrammer and the copyright line `swcstudiospace / Spectrum Web Co`. Legal entity in the terms remains Spectrum Web Co LLC.

## Deviations

- Card terminal inside the AgentOS guest is the session transcript and activity drawer. The fetched embedded docs show filesystem read/write and dispose, not a PTY attach, so no guest PTY API was invented. Restart keeps the sqlite files and starts a new VM. The previous Omp transcript remains only if the existing session store still has that session id.
- `host_dir` mounts are not used. Cross-card data stays on Agent Substrate.
- Plugin enablement for Omp's own extensions remains `loadUserExtensions` in `shared/omp.ts`. Extra per-card plugin bindings live in `$AUTONOGRAMMER_DATA_DIR/plugins.json`, not in pipeline JSON.

# Tauri 2 shell

Desktop targets declared for Tauri 2.12 (Linux deb, macOS app, Windows msi/nsis). `bundle.active` is false until icons are added and `cargo tauri build` is run on that OS.

Android and iOS are supported by Tauri 2 but the native projects are not generated here (no Android SDK, no Xcode).

The browser build is Vite (`bun run dev` / `bun run build` in `packages/flow`), not a Tauri target.

Headless Linux does not open this window. Run `bun packages/flow/server.ts`.

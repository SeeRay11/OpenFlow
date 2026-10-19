/**
 * The in-app terminal host (Linear SPE-16065). `createTerminal` is what the
 * wiring step mounts: `handle` next to the other `/flow/api` modules, and one
 * transport for the WebSocket — `bunWebSocket(terminal)` in `server.ts`, or
 * `flowPty(terminal)` (`vite/flow-pty.ts`) in the dev host — both on the SAME
 * instance, since the tickets `handle` issues are the ones the upgrade consumes.
 * Pass `allowRemote: process.env.FLOW_ALLOW_REMOTE === "1"` and call `dispose()` on
 * host shutdown (the module also hooks process exit and SIGINT/SIGTERM itself).
 *
 * Platforms: Linux is exercised (both backends, process-group kill). macOS uses the
 * same POSIX paths; node-pty's prebuilt `spawn-helper` needs its exec bit, which a
 * normal install keeps. Windows is NOT exercised: there is no process group to
 * signal (the child alone is killed), the shell is `%ComSpec%`, the env allowlist
 * carries the variables a process needs to start, and node-pty runs ConPTY. Under
 * Bun the terminal is `Bun.spawn`'s own PTY; whether it exists on Windows was not checked.
 */
import { randomUUID } from "node:crypto"
import type { HostHandler } from "../host/respond"
import { TerminalHost } from "./host"
import type { HostTuning, PtySpawn } from "./host"
import { TicketStore, spawnPlan } from "./policy"
import { spawnBunPty } from "./pty-bun"
import { spawnNodePty } from "./pty-node"
import { terminalRoutes, terminalUpgrade } from "./routes"
import type { PtyUpgrade, TerminalCore } from "./routes"

export type { HostTuning, PtyConnection, PtyProcess, PtySink, PtySpawn, PtySpawnOptions } from "./host"
export type { PtyUpgrade } from "./routes"
export { TerminalHost } from "./host"

export type TerminalDeps = {
  /** The project directory: where every terminal starts. Resolved (realpath) at each spawn. */
  project(): string
  /** What the child's environment is filtered from. Default `process.env`. */
  env?: NodeJS.ProcessEnv
  /** The omp command line (argv[0] is the binary), `--profile` included. Injected by the wiring step. */
  omp(): Promise<{ argv: string[] } | { error: string }>
  /** FLOW_ALLOW_REMOTE=1: the terminal is disabled entirely. */
  allowRemote?: boolean
  /** Test seam; default is the runtime's own PTY (`defaultSpawn`). */
  spawn?: PtySpawn
  /** Per-launch secret that signs upgrade tickets. Default: random. Never logged. */
  token?: string
  /** Test seam for limits and timers (idle reaper, kill grace, ...). */
  tuning?: Partial<HostTuning>
  /** Test seam for `/etc/shells`. */
  shells?: string[]
}

export type TerminalModule = {
  /** `POST /flow/api/pty/ticket`, `GET /flow/api/pty`, `DELETE /flow/api/pty/<id>`; all gated. */
  handle: HostHandler
  /** Policy half of a `/flow/pty/<id>/ws` upgrade; the transport supplies the socket as a `PtySink`. */
  upgrade(request: Request, id: string): PtyUpgrade
  /** Kills every session's process group and waits. Idempotent. */
  dispose(): Promise<void>
}

/** Bun (`server.ts`) gets `Bun.spawn`'s terminal, Node (vite) gets node-pty: `pty-bun.ts` explains why node-pty cannot run under Bun. */
export const defaultSpawn: PtySpawn = "Bun" in globalThis ? spawnBunPty : spawnNodePty

export function createTerminal(deps: TerminalDeps): TerminalModule {
  const env = deps.env ?? process.env
  const core: TerminalCore = {
    host: new TerminalHost(deps.spawn ?? defaultSpawn, deps.tuning),
    tickets: new TicketStore(deps.token ?? randomUUID()),
    enabled: !deps.allowRemote,
    plan: (kind) => spawnPlan(kind, { project: deps.project, env, omp: deps.omp, shells: deps.shells }),
  }
  return {
    handle: terminalRoutes(core),
    upgrade: (request, id) => terminalUpgrade(core, request, id),
    dispose: () => core.host.dispose(),
  }
}

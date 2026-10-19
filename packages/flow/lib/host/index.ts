import { checkOmp } from "../omp/binary"
import { createOmpConfig } from "../omp-config"
import { createEngineHost } from "../omp"
import { buildLaunch } from "../omp/launch"
import { spawnOmp } from "../omp/rpc"
import { createSubstrate } from "../substrate"
import { createSwarmHost } from "../swarm"
import { createTerminal, type TerminalModule } from "../terminal"
import { createUplift } from "../uplift"
import { createGate } from "./gate"
import { createLifecycle } from "./lifecycle"
import { stateDir, stateRoot } from "./paths"
import { guarded, type HostHandler } from "./respond"

export type HostOptions = {
  /** The live project folder; read on every use because the canvas can switch it. */
  project(): string
  env?: NodeJS.ProcessEnv
  /** FLOW_ALLOW_REMOTE=1: the host is reachable from other machines, so the terminal is off. */
  allowRemote: boolean
}

export type Host = {
  /**
   * The Host / Origin / Sec-Fetch-Site / Content-Type gate for every `/flow` request (case and dot variants included), the store routes
   * and the SSE stream included. Mount it first on each server: a `Response` is a refusal, `undefined` lets the request on.
   */
  gate: HostHandler
  /** Every `/flow/api` module that is not the store; `undefined` means the request is not one of theirs. */
  handle: HostHandler
  /** The same instance `handle` serves tickets for: hand it to `bunWebSocket` / `attachNodeUpgrade`. */
  terminal: TerminalModule
  /** The omp profile's config directory (where `mcp.json` and skills live), once omp has reported it. */
  profileDir(): Promise<string | undefined>
  /**
   * True while the host has work bound to the project it started in: a create in flight, an engine session starting, running a turn or waiting on a dialog, or a planner
   * running. `POST /project` refuses to switch while it is true (the store's `projectLocked`). Idle live sessions and reaped ones do not count.
   */
  projectLocked(): boolean
  /** Ids of the engine sessions that hold the lock (starting, turn in flight, dialog waiting): what the user can stop. Empty when only a planner or a create in flight holds it. */
  projectHolders(): string[]
  /** Closes every omp process, planner, probe and shell, and refuses new work. Idempotent. */
  dispose(): Promise<void>
}

/**
 * Composes the host modules of the Omp engine behind one handler and one
 * dispose. Ordering matters only for speed: terminal and omp-config paths are
 * disjoint from the engine's, so each request reaches its module after at most
 * a handful of path comparisons.
 */
export function createHost(options: HostOptions): Host {
  const env = options.env ?? process.env
  const project = options.project
  const root = () => stateRoot(project(), env)

  // The terminal's `omp --version` probe: the engine, omp-config and swarm modules each own the probes and CLI runs of their own.
  const life = createLifecycle("the host")
  const omp = createOmpConfig({ stateDir: () => stateDir(env), env, spawn: spawnOmp, launch: buildLaunch })
  const settings = omp.settings
  const swarm = createSwarmHost({ settings, env })
  const engine = createEngineHost({ project, stateRoot: root, settings, spawn: spawnOmp, launch: buildLaunch, swarm, env, stamp: omp.stamp })
  // Copy logins rewrites the profile's logins, so the catalog it cached is stale; the stamp would notice too.
  omp.loginsChanged(engine.resetModels)
  const uplift = createUplift({ project, stateRoot: root, settings, env })
  const substrate = createSubstrate({ project, settings, env })
  const terminal = createTerminal({
    project,
    env,
    allowRemote: options.allowRemote,
    async omp() {
      const current = await settings()
      const status = await checkOmp(current, env, life)
      if (status.available && status.binary) {
        return { argv: [status.binary, ...(current.profile ? ["--profile", current.profile] : [])] }
      }
      const problem = status.problems[0]
      return { error: problem ? `${problem.message}${problem.fix ? ` ${problem.fix}` : ""}` : "omp is not available." }
    },
  })

  const modules = [terminal.handle, omp.handle, engine.handle, uplift.handle, substrate.handle, swarm.handle]
  let disposed: Promise<void> | undefined

  return {
    gate: createGate(options.allowRemote),
    handle: guarded(async (request) => {
      for (const module of modules) {
        const response = await module(request)
        if (response) return response
      }
      return undefined
    }),
    terminal,
    async profileDir() {
      return (await omp.status()).configDir
    },
    projectLocked: () => engine.working() || uplift.active(),
    projectHolders: engine.holders,
    dispose() {
      disposed ??= Promise.all([engine.dispose(), uplift.dispose(), substrate.dispose(), terminal.dispose(), omp.dispose(), swarm.dispose(), life.dispose()]).then(() => undefined)
      return disposed
    },
  }
}

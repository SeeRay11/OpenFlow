import { checkOmp } from "../omp/binary"
import { createOmpConfig } from "../omp-config"
import { createEngineHost } from "../omp"
import { buildLaunch } from "../omp/launch"
import { spawnOmp } from "../omp/rpc"
import { createSubstrate } from "../substrate"
import { createSwarmHost } from "../swarm"
import { createTerminal, type TerminalModule } from "../terminal"
import { createUplift } from "../uplift"
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
  /** Every `/flow/api` module that is not the store; `undefined` means the request is not one of theirs. */
  handle: HostHandler
  /** The same instance `handle` serves tickets for: hand it to `bunWebSocket` / `attachNodeUpgrade`. */
  terminal: TerminalModule
  /** The omp profile's config directory (where `mcp.json` and skills live), once omp has reported it. */
  profileDir(): Promise<string | undefined>
  /** Closes every omp process, planner and shell. Idempotent. */
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

  const omp = createOmpConfig({ stateDir: () => stateDir(env), env, spawn: spawnOmp, launch: buildLaunch })
  const settings = omp.settings
  const swarm = createSwarmHost({ settings, env })
  const engine = createEngineHost({ project, stateRoot: root, settings, spawn: spawnOmp, launch: buildLaunch, swarm, env })
  const uplift = createUplift({ project, stateRoot: root, settings, env })
  const substrate = createSubstrate({ project, settings, env })
  const terminal = createTerminal({
    project,
    env,
    allowRemote: options.allowRemote,
    async omp() {
      const current = await settings()
      const status = await checkOmp(current, env)
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
    dispose() {
      disposed ??= Promise.all([engine.dispose(), uplift.dispose(), substrate.dispose(), terminal.dispose()]).then(() => undefined)
      return disposed
    },
  }
}

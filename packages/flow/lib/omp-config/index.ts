import type { OmpSettings, OmpStatus } from "../../shared/omp"
import type { HostHandler } from "../host/respond"
import { resolveBinary } from "../omp/binary"
import type { BuildLaunch, SpawnOmp } from "../omp/rpc-types"
import { credentialStamp } from "../omp/stamp"
import { createAuth } from "./auth"
import { createConfig, createRun, RUN_TIMEOUT_MS, type Run } from "./config"
import { createProviders } from "./providers"
import { createRoutes } from "./routes"
import { createSettingsStore } from "./settings"
import { createStatusChecker } from "./status"

export type OmpConfigDeps = {
  /** `OPENFLOW_STATE_DIR` or `~/.openflow`; read on every use, so tests and the host can move it. */
  stateDir(): string
  env?: NodeJS.ProcessEnv
  spawn: SpawnOmp
  launch: BuildLaunch
  /** Test seam: runs the omp CLI to completion. The default spawns it with a deadline. */
  run?: Run
  /** Deadline of the default runner, in milliseconds. Defaults to 30 s. */
  runTimeoutMs?: number
}

export type OmpConfigModule = {
  handle: HostHandler
  /** The saved settings with defaults filled in; what the launch builder, uplift, memory and swarm read. */
  settings(): Promise<OmpSettings>
  status(): Promise<OmpStatus>
  /** Fires after settings are saved or reset. Returns the unsubscribe function. */
  changed(listener: () => void): () => void
  /** Fires after Copy logins succeeded. Returns the unsubscribe function. */
  loginsChanged(listener: () => void): () => void
  /**
   * The current profile's credential stamp (see `omp/stamp.ts`): changes when a login, a logout or an
   * `auth import` rewrites the profile's `agent.db`. Cheap; safe to call from inside a provider read.
   */
  stamp(): Promise<string>
}

export function createOmpConfig(deps: OmpConfigDeps): OmpConfigModule {
  const env = deps.env ?? process.env
  const run: Run = deps.run ?? createRun(deps.runTimeoutMs ?? RUN_TIMEOUT_MS)
  const store = createSettingsStore({ stateDir: deps.stateDir, env })
  const providers = createProviders({ env, spawn: deps.spawn, launch: deps.launch, stamp })
  const checker = createStatusChecker({ run, env, providers })
  const config = createConfig({ run, env })
  const auth = createAuth({ run, env })

  // A different binary or profile has different credentials and a different config directory.
  store.changed(() => {
    providers.reset()
    checker.reset()
  })

  const settings = async () => (await store.load()).settings

  // Reads the config directory the status check already caches and never calls `status()`, so the
  // provider list can use it for its own cache key without recursing into itself.
  async function stamp(): Promise<string> {
    const current = await settings()
    const binary = resolveBinary(current, env)
    return credentialStamp(binary ? await checker.configDir(current, binary) : undefined)
  }

  const loginListeners = new Set<() => void>()

  return {
    handle: createRoutes({
      store,
      checker,
      config,
      providers,
      auth,
      env,
      loginsChanged() {
        for (const listener of loginListeners) listener()
      },
    }),
    settings,
    status: async () => checker.status(await settings()),
    changed: store.changed,
    loginsChanged(listener) {
      loginListeners.add(listener)
      return () => loginListeners.delete(listener)
    },
    stamp,
  }
}

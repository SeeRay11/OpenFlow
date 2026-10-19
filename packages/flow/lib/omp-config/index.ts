import type { OmpSettings, OmpStatus } from "../../shared/omp"
import type { HostHandler } from "../host/respond"
import type { BuildLaunch, SpawnOmp } from "../omp/rpc-types"
import { createConfig, defaultRun, type Run } from "./config"
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
  /** Test seam: runs the omp CLI to completion. The default is `execFile` with a timeout. */
  run?: (binary: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>
}

export type OmpConfigModule = {
  handle: HostHandler
  /** The saved settings with defaults filled in; what the launch builder, uplift, memory and swarm read. */
  settings(): Promise<OmpSettings>
  status(): Promise<OmpStatus>
  /** Fires after settings are saved or reset. Returns the unsubscribe function. */
  changed(listener: () => void): () => void
}

export function createOmpConfig(deps: OmpConfigDeps): OmpConfigModule {
  const env = deps.env ?? process.env
  const run: Run = deps.run ?? defaultRun
  const store = createSettingsStore({ stateDir: deps.stateDir, env })
  const providers = createProviders({ env, spawn: deps.spawn, launch: deps.launch })
  const checker = createStatusChecker({ run, env, providers })
  const config = createConfig({ run, env })

  // A different binary or profile has different credentials and a different config directory.
  store.changed(() => {
    providers.reset()
    checker.reset()
  })

  const settings = async () => (await store.load()).settings

  return {
    handle: createRoutes({ store, checker, config, providers, env }),
    settings,
    status: async () => checker.status(await settings()),
    changed: store.changed,
  }
}

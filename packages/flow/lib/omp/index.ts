import { guarded, type HostHandler } from "../host/respond"
import { createModelCatalog } from "./models"
import { createEventBus, createRoutes } from "./routes"
import { createSessionHost, type EngineHostDeps } from "./session"

export type { EngineHostDeps } from "./session"

export type EngineHost = {
  /** Every route in `shared/engine.ts`; any other path answers `undefined`. */
  handle: HostHandler
  /** Closes every omp process and ends every event stream. */
  dispose(): Promise<void>
  /** Sessions with a process attached right now. */
  live(): number
  /** Forgets the cached model catalog: the profile's logins changed. */
  resetModels(): void
}

export function createEngineHost(deps: EngineHostDeps): EngineHost {
  const bus = createEventBus()
  const sessions = createSessionHost(deps, { emit: bus.publish })
  const models = createModelCatalog(deps, { readyTimeoutMs: deps.readyTimeoutMs })
  const routes = createRoutes({ settings: deps.settings, env: deps.env, sessions, models, bus })
  return {
    handle: guarded(routes),
    live: () => sessions.live(),
    resetModels: models.reset,
    async dispose() {
      bus.close()
      await sessions.close()
    },
  }
}

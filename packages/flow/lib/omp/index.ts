import { guarded, type HostHandler } from "../host/respond"
import { createModelCatalog } from "./models"
import { createEventBus, createRoutes } from "./routes"
import { pruneState, type PruneResult } from "./prune"
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
  /** Settles once the startup prune of old run state has finished (or the host was disposed first); it never rejects. */
  pruned: Promise<PruneResult>
}

export function createEngineHost(deps: EngineHostDeps): EngineHost {
  const bus = createEventBus()
  const sessions = createSessionHost(deps, { emit: bus.publish })
  const models = createModelCatalog(deps, { readyTimeoutMs: deps.readyTimeoutMs })
  const routes = createRoutes({ settings: deps.settings, env: deps.env, sessions, models, bus })
  const pruned = Promise.withResolvers<PruneResult>()
  const pruneTimer = setTimeout(() => {
    // `pruneState` never throws; a failure is only counted in the result.
    void pruneState({ root: deps.stateRoot(), maxAgeMs: deps.prune?.maxAgeMs, now: deps.prune?.now, isLive: sessions.holds }).then(pruned.resolve)
  }, deps.prune?.delayMs ?? 15_000)
  pruneTimer.unref?.()
  return {
    handle: guarded(routes),
    live: () => sessions.live(),
    resetModels: models.reset,
    pruned: pruned.promise,
    async dispose() {
      clearTimeout(pruneTimer)
      pruned.resolve({ removed: [], errors: 0 })
      bus.close()
      await sessions.close()
    },
  }
}

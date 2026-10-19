import path from "node:path"
import { createLifecycle } from "../host/lifecycle"
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
  /**
   * True while an omp process is live or starting, a create is in flight or a turn is running: work bound to the project it was started in.
   * Idle sessions waiting to be resumed hold no process and do not count.
   */
  working(): boolean
  /** Forgets the cached model catalog: the profile's logins changed. */
  resetModels(): void
  /** Settles once the startup prune of old run state has finished (or the host was disposed first); it never rejects. */
  pruned: Promise<PruneResult>
}

export function createEngineHost(deps: EngineHostDeps): EngineHost {
  // Everything of this host that spawns a short-lived omp (the catalog read, the `--version` probes) runs in this lifecycle.
  const life = createLifecycle("the engine host")
  // The bus is built first because the session host emits through it; `sessions` is only read when a stream attaches, after both exist.
  const bus = createEventBus({ replay: () => sessions.pending() })
  const sessions = createSessionHost(deps, { emit: bus.publish, life })
  const models = createModelCatalog(deps, { readyTimeoutMs: deps.readyTimeoutMs, life })
  const routes = createRoutes({ settings: deps.settings, env: deps.env, sessions, models, bus, life })
  const pruned = Promise.withResolvers<PruneResult>()
  const pruneTimer = setTimeout(() => {
    // `pruneState` never throws; a failure is only counted in the result.
    void pruneState({
      root: deps.stateRoot(),
      maxAgeMs: deps.prune?.maxAgeMs,
      now: deps.prune?.now,
      claim: sessions.claim,
      runLogs: path.join(deps.project(), ".openflow", "runs"),
    }).then(pruned.resolve)
  }, deps.prune?.delayMs ?? 15_000)
  pruneTimer.unref?.()
  return {
    handle: guarded(routes),
    live: () => sessions.live(),
    working: () => sessions.working(),
    resetModels: models.reset,
    pruned: pruned.promise,
    async dispose() {
      clearTimeout(pruneTimer)
      pruned.resolve({ removed: [], errors: 0 })
      bus.close()
      await Promise.all([life.dispose(), sessions.close()])
    },
  }
}

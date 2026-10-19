import os from "node:os"
import path from "node:path"
import type { OmpSettings } from "../../shared/omp"
import { SWARM_MODES, SWARM_ROUTES } from "../../shared/swarm"
import { guarded, HttpError, json, type HostHandler } from "../host/respond"
import type { Preflight } from "./preflight"

export type SwarmRouteDeps = {
  settings(): Promise<OmpSettings>
  env: NodeJS.ProcessEnv
  preflight: Preflight
}

/** `GET /flow/api/swarm/preflight?mode=auto|always|off`: can a card run with that mode. Read-only: creates nothing. */
export function swarmRoutes(deps: SwarmRouteDeps): HostHandler {
  return guarded(async (request) => {
    const url = new URL(request.url)
    if (url.pathname !== SWARM_ROUTES.preflight) return undefined
    if (request.method !== "GET") throw new HttpError(405, "method not allowed", "method")

    const settings = await deps.settings()
    const asked = url.searchParams.get("mode") ?? settings.swarm.mode
    const requested = SWARM_MODES.find((mode) => mode === asked)
    if (!requested) throw new HttpError(400, `mode must be one of ${SWARM_MODES.join(", ")}`, "bad-mode")

    const stateDir = deps.env.OPENFLOW_STATE_DIR || path.join(os.homedir(), ".openflow")
    return json(200, await deps.preflight({ requested, settings, env: deps.env, stateDir }))
  })
}

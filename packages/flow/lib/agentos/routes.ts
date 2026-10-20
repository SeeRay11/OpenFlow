import { AGENTOS_ROUTES, type AgentOsCardView } from "../../shared/agentos"
import { guarded, HttpError, json, readJson, type HostHandler } from "../host/respond"
import { createVolumes, loadAgentOsFactory, type AgentOsFactory } from "./volumes"

type Volumes = ReturnType<typeof createVolumes>

export function agentOsRoutes(volumes: Volumes): HostHandler {
  return guarded(async (request) => {
    const url = new URL(request.url)
    if (url.pathname === AGENTOS_ROUTES.list) {
      if (request.method !== "GET") throw new HttpError(405, "method not allowed", "method")
      return json(200, { cards: volumes.list() })
    }
    if (!url.pathname.startsWith(`${AGENTOS_ROUTES.cards}/`)) return undefined
    const [cardId, action] = url.pathname.slice(AGENTOS_ROUTES.cards.length + 1).split("/")
    if (!cardId) throw new HttpError(400, "card id is required", "card")
    if (request.method === "GET" && !action) return json(200, volumes.view(decodeURIComponent(cardId)))
    if (request.method !== "POST" || !action) throw new HttpError(405, "method not allowed", "method")
    const id = decodeURIComponent(cardId)
    let body: AgentOsCardView
    if (action === "start") body = await volumes.start(id)
    else if (action === "stop") body = await volumes.stop(id)
    else if (action === "restart") body = await volumes.restart(id)
    else if (action === "destroy") {
      const payload = await readJson<{ confirm?: boolean }>(request)
      if (payload?.confirm !== true) throw new HttpError(400, "deleting a card volume requires confirm: true", "confirm")
      body = await volumes.destroy(id, true)
    } else if (action === "write") {
      const payload = await readJson<{ path?: string; text?: string }>(request)
      if (!payload.path || payload.path.includes("..") || payload.path.includes("\0")) {
        throw new HttpError(400, "path must stay inside the guest filesystem", "path")
      }
      await volumes.writeFile(id, payload.path, String(payload.text ?? ""))
      body = volumes.view(id)
    } else if (action === "read") {
      const payload = await readJson<{ path?: string }>(request)
      if (!payload.path) throw new HttpError(400, "path is required", "path")
      const text = await volumes.readFile(id, payload.path)
      return json(200, { ...volumes.view(id), text })
    } else throw new HttpError(404, "not found", "not-found")
    return json(body.phase === "failed" ? 409 : 200, body)
  })
}

export function createAgentOsModule(options: { env?: NodeJS.ProcessEnv; factory?: AgentOsFactory }) {
  let factory = options.factory
  const volumes = createVolumes({
    env: options.env,
    factory: {
      async create(spec) {
        factory ??= await loadAgentOsFactory()
        return factory.create(spec)
      },
    },
  })
  return { handle: agentOsRoutes(volumes), volumes, dispose: () => volumes.dispose() }
}

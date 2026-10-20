import fs from "node:fs/promises"
import path from "node:path"
import { HARNESS_ROUTES, type PluginBinding } from "../../shared/harness"
import { dataDir } from "../agentos/paths"
import { guarded, HttpError, json, readJson, type HostHandler } from "../host/respond"
import { readGsdHealth } from "./gsd"
import { cardsBlockedByPlugins, validatePlugins } from "./plugins"
import { redactSecrets, writeSecrets } from "./secrets"

async function loadPlugins(env: NodeJS.ProcessEnv): Promise<PluginBinding[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataDir(env), "plugins.json"), "utf8")) as unknown
    const result = validatePlugins(parsed)
    return result.ok ? result.plugins : []
  } catch {
    return []
  }
}

export function createHarnessModule(options: { env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env
  const handle: HostHandler = guarded(async (request) => {
    const url = new URL(request.url)
    if (url.pathname === HARNESS_ROUTES.health && request.method === "GET") return json(200, { gsdCore: await readGsdHealth(env) })
    if (url.pathname === HARNESS_ROUTES.plugins && request.method === "GET") return json(200, { plugins: await loadPlugins(env) })
    if (url.pathname === HARNESS_ROUTES.plugins && request.method === "PUT") {
      const body = await readJson<{ plugins?: unknown; required?: { cardId: string; pluginId: string }[] }>(request)
      const result = validatePlugins(body.plugins)
      if (!result.ok) return json(400, { error: "plugin config is invalid", fields: result.fields })
      const file = path.join(dataDir(env), "plugins.json")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify(result.plugins))
      const blocked = cardsBlockedByPlugins(result.plugins, body.required ?? [])
      return json(blocked.length ? 409 : 200, { plugins: result.plugins, blocked })
    }
    if (url.pathname === HARNESS_ROUTES.secrets && request.method === "PUT") {
      const body = await readJson<Record<string, unknown>>(request)
      const { clean, secrets } = redactSecrets(body)
      if (Object.keys(secrets).length) await writeSecrets(secrets, env)
      return json(200, { stored: Object.keys(secrets).length, workflow: clean })
    }
    if (url.pathname === HARNESS_ROUTES.health || url.pathname === HARNESS_ROUTES.plugins || url.pathname === HARNESS_ROUTES.secrets) {
      throw new HttpError(405, "method not allowed", "method")
    }
    return undefined
  })
  return { handle, dispose: async () => undefined }
}

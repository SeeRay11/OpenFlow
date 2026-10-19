import { OMP_ROUTES, type OmpStatusView } from "../../shared/omp"
import { fail, guarded, HttpError, json, readJson, type HostHandler } from "../host/respond"
import { resolveBinary } from "../omp/binary"
import { ValidationFailure, firstLine, type Config } from "./config"
import type { Providers } from "./providers"
import { isRecord, type SettingsStore } from "./settings"
import type { StatusChecker } from "./status"

export type RouteParts = {
  store: SettingsStore
  checker: StatusChecker
  config: Config
  providers: Providers
  env: NodeJS.ProcessEnv
}

function methodNotAllowed(allowed: string): Response {
  const response = fail(405, "method not allowed", "method")
  response.headers.set("allow", allowed)
  return response
}

function decodeKey(segment: string): string {
  try {
    const key = decodeURIComponent(segment)
    if (key) return key
  } catch {
    // Falls through to the 400 below.
  }
  throw new HttpError(400, "the setting key is missing or malformed", "bad-request")
}

/**
 * HTTP surface of the Omp settings dialog. 400: the request is not what the
 * route accepts (not JSON, missing `value`); 404: omp has no such setting; 422:
 * the value is refused, with `{ errors: [{ path, message }] }` for the form;
 * 503: omp itself is not available.
 */
export function createRoutes(parts: RouteParts): HostHandler {
  async function configRoute(request: Request, rest: string[]): Promise<Response> {
    const key = decodeKey(rest[0] ?? "")
    const { settings } = await parts.store.load()
    if (rest.length === 1) {
      if (request.method !== "PUT") return methodNotAllowed("PUT")
      const body = await readJson(request)
      if (!isRecord(body) || !("value" in body)) throw new HttpError(400, "expected { value }", "bad-request")
      return json(200, { entry: await parts.config.set(settings, key, body.value) })
    }
    if (rest.length === 2 && rest[1] === "reset") {
      if (request.method !== "POST") return methodNotAllowed("POST")
      return json(200, { entry: await parts.config.reset(settings, key) })
    }
    throw new HttpError(404, "not found", "not-found")
  }

  const handler: HostHandler = async (request) => {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "")

    if (pathname === OMP_ROUTES.status) {
      if (request.method !== "GET") return methodNotAllowed("GET")
      const loaded = await parts.store.load()
      const status = await parts.checker.status(loaded.settings)
      return json(200, { ...status, warnings: loaded.warnings } satisfies OmpStatusView)
    }

    if (pathname === OMP_ROUTES.settings) {
      if (request.method === "GET") return json(200, await parts.store.view())
      if (request.method !== "PUT") return methodNotAllowed("GET, PUT")
      const result = await parts.store.update(await readJson(request))
      if (!result.ok) return json(422, { error: "settings were not saved", code: "invalid", errors: result.errors })
      return json(200, result.view)
    }

    if (pathname === OMP_ROUTES.settingsReset) {
      if (request.method !== "POST") return methodNotAllowed("POST")
      return json(200, await parts.store.reset())
    }

    if (pathname === OMP_ROUTES.providers) {
      if (request.method !== "GET") return methodNotAllowed("GET")
      const { settings } = await parts.store.load()
      const binary = resolveBinary(settings, parts.env)
      if (!binary) throw new HttpError(503, "omp was not found; set its path in Omp settings", "omp-unavailable")
      try {
        return json(200, { providers: await parts.providers.list(settings, binary) })
      } catch (error) {
        const reason = firstLine(error instanceof Error ? error.message : String(error))
        throw new HttpError(502, `could not list providers: ${reason}`, "omp-failed")
      }
    }

    if (pathname === OMP_ROUTES.config) {
      if (request.method !== "GET") return methodNotAllowed("GET")
      const { settings } = await parts.store.load()
      return json(200, { entries: await parts.config.list(settings) })
    }

    if (pathname.startsWith(`${OMP_ROUTES.config}/`)) {
      try {
        return await configRoute(request, pathname.slice(OMP_ROUTES.config.length + 1).split("/"))
      } catch (error) {
        if (error instanceof ValidationFailure)
          return json(422, { error: error.message, code: error.code, errors: error.errors })
        throw error
      }
    }
    return undefined
  }
  return guarded(handler)
}

import path from "node:path"
import { UPLIFT_ROUTE, type UpliftRequest, type UpliftResult } from "../../shared/uplift"
import { fail, guarded, HttpError, json, readJson, type HostHandler } from "../host/respond"
import { isRecord } from "./result"

const MAX_ID_CHARS = 256
const MAX_TIMEOUT_MS = 3_600_000

export type UpliftRoutesApi = {
  run(request: UpliftRequest, signal?: AbortSignal): Promise<UpliftResult>
  read(runId: string, nodeId: string): Promise<UpliftResult | undefined>
}

function badRequest(message: string): never {
  throw new HttpError(400, message, "bad-request")
}

function identifier(value: unknown, name: string) {
  if (typeof value !== "string" || !value || value.length > MAX_ID_CHARS) badRequest(`${name} must be a non-empty string of at most ${MAX_ID_CHARS} characters`)
  return value
}

function parseRequest(body: unknown): UpliftRequest {
  if (!isRecord(body)) badRequest("request body must be a JSON object")
  const fields = body
  if (typeof fields.original !== "string") badRequest("original must be a string")
  const request: UpliftRequest = {
    runId: identifier(fields.runId, "runId"),
    nodeId: identifier(fields.nodeId, "nodeId"),
    original: fields.original,
  }
  if (fields.role !== undefined) {
    if (typeof fields.role !== "string") badRequest("role must be a string")
    request.role = fields.role
  }
  if (fields.cwd !== undefined) {
    if (typeof fields.cwd !== "string" || !path.isAbsolute(fields.cwd)) badRequest("cwd must be an absolute path")
    request.cwd = fields.cwd
  }
  if (fields.timeoutMs !== undefined) {
    const ms = fields.timeoutMs
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMEOUT_MS) badRequest(`timeoutMs must be a number between 1 and ${MAX_TIMEOUT_MS}`)
    request.timeoutMs = ms
  }
  return request
}

/**
 * Every planner outcome — failed and skipped included — is a 200: the engine
 * reads `status`, and a planner that could not plan is not a server fault.
 */
export function createRoutes(api: UpliftRoutesApi): HostHandler {
  return guarded(async (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname === UPLIFT_ROUTE) {
      if (request.method !== "POST") return fail(405, "use POST", "method-not-allowed")
      // The engine aborting the fetch (card cancelled) stops the planner group.
      return json(200, await api.run(parseRequest(await readJson(request)), request.signal))
    }
    if (!pathname.startsWith(`${UPLIFT_ROUTE}/`)) return undefined

    const parts = pathname.slice(UPLIFT_ROUTE.length + 1).split("/")
    if (parts.length !== 2) return fail(404, "not found", "not-found")
    if (request.method !== "GET") return fail(405, "use GET", "method-not-allowed")
    let runId: string
    let nodeId: string
    try {
      runId = decodeURIComponent(parts[0]!)
      nodeId = decodeURIComponent(parts[1]!)
    } catch {
      return fail(400, "run and node ids must be valid URL segments", "bad-request")
    }
    if (!runId || !nodeId || runId.length > MAX_ID_CHARS || nodeId.length > MAX_ID_CHARS) return fail(400, "run and node ids are required", "bad-request")
    const stored = await api.read(runId, nodeId)
    return stored ? json(200, stored) : fail(404, "no uplift result for this card", "not-found")
  })
}

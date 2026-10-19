/** HTTP surface of shared memory: `MEMORY_ROUTES` in `shared/memory.ts`. `undefined` means "not mine". */
import type { MemoryForgetRequest, MemoryReadRequest, MemoryWriteRequest } from "../../shared/memory"
import { MEMORY_ROUTES } from "../../shared/memory"
import type { HostHandler } from "../host/respond"
import { guarded, HttpError, json, readJson } from "../host/respond"
import type { MemoryModule } from "./memory"

const WRITE_BODY_LIMIT = 4 * 1_048_576
const OUTCOMES: Record<string, true> = { done: true, error: true, stopped: true }
const ROUTE_METHODS: Record<string, string> = {
  [MEMORY_ROUTES.status]: "GET",
  [MEMORY_ROUTES.read]: "POST",
  [MEMORY_ROUTES.write]: "POST",
  [MEMORY_ROUTES.entries]: "GET",
  [MEMORY_ROUTES.forget]: "POST",
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new HttpError(400, "request body must be a JSON object", "bad-request")
}

function text(body: Record<string, unknown>, key: string, required: boolean, max = 200): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `\`${key}\` is required`, "bad-request")
    return undefined
  }
  if (typeof value !== "string" || (required && value.trim() === "") || value.length > max) {
    throw new HttpError(400, `\`${key}\` must be a string of at most ${max} characters`, "bad-request")
  }
  return value
}

function count(value: unknown, key: string, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) {
    throw new HttpError(400, `\`${key}\` must be an integer between 1 and ${max}`, "bad-request")
  }
  return number
}

export function createRoutes(memory: MemoryModule): HostHandler {
  return guarded(async (request) => {
    const url = new URL(request.url)
    const method = ROUTE_METHODS[url.pathname]
    if (!method) return undefined
    if (request.method !== method) {
      return new Response(JSON.stringify({ error: `use ${method}`, code: "method" }), {
        status: 405,
        headers: { allow: method, "content-type": "application/json; charset=utf-8" },
      })
    }
    if (url.pathname === MEMORY_ROUTES.status) return json(200, await memory.status())
    if (url.pathname === MEMORY_ROUTES.entries) {
      const pipeline = url.searchParams.get("pipeline")
      if (!pipeline || pipeline.length > 200) throw new HttpError(400, "`pipeline` is required", "bad-request")
      const run = url.searchParams.get("run") || undefined
      return json(200, await memory.entries({ pipeline, runId: run, limit: count(url.searchParams.get("limit"), "limit", 200) }))
    }
    if (url.pathname === MEMORY_ROUTES.read) {
      const body = object(await readJson(request))
      const input: MemoryReadRequest = {
        runId: text(body, "runId", true) as string,
        nodeId: text(body, "nodeId", true) as string,
        pipeline: text(body, "pipeline", true) as string,
        role: text(body, "role", false),
        query: (text(body, "query", false, 1_048_576) ?? "").slice(0, 1500),
        limit: count(body.limit, "limit", 50),
      }
      return json(200, await memory.read(input))
    }
    if (url.pathname === MEMORY_ROUTES.write) {
      const body = object(await readJson(request, WRITE_BODY_LIMIT))
      if (typeof body.outcome !== "string" || !Object.hasOwn(OUTCOMES, body.outcome)) {
        throw new HttpError(400, "`outcome` must be done, error or stopped", "bad-request")
      }
      const input: MemoryWriteRequest = {
        runId: text(body, "runId", true) as string,
        nodeId: text(body, "nodeId", true) as string,
        pipeline: text(body, "pipeline", true) as string,
        role: text(body, "role", true) as string,
        outcome: body.outcome as MemoryWriteRequest["outcome"],
        output: text(body, "output", false, WRITE_BODY_LIMIT) ?? "",
        dispatch: count(body.dispatch, "dispatch", 1000),
      }
      return json(200, await memory.write(input))
    }
    const body = object(await readJson(request))
    const input: MemoryForgetRequest = { pipeline: text(body, "pipeline", true) as string, runId: text(body, "runId", false) }
    return json(200, await memory.forget(input))
  })
}

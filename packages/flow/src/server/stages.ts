import { MEMORY_ROUTES } from "../../shared/memory"
import type { MemoryReadRequest, MemoryReadResult, MemoryWriteRequest, MemoryWriteResult } from "../../shared/memory"
import { UPLIFT_ROUTE } from "../../shared/uplift"
import type { UpliftRequest, UpliftResult } from "../../shared/uplift"
import { describe } from "./client"

/**
 * The engine's two stage deps (`EngineDeps.uplift` / `EngineDeps.memory`) as
 * browser fetch clients of the host. Neither ever rejects: the engine already
 * knows what a failed uplift (ask the user) and an unavailable memory (run
 * without it, say so on the card) mean, so a dead host is reported in those
 * terms rather than as an exception the engine would have to classify.
 */

const HOST_FIX = "start it with `bun openflow.ts` (or check the Omp settings) and retry"

/** Resolves the parsed body of a 2xx answer, or throws the sentence the caller should show. */
async function post<T>(origin: string, path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`the OpenFlow host did not answer (${describe(error)}): ${HOST_FIX}`)
  }
  const text = await response.text().catch(() => "")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON: an HTML error page from a proxy, or a truncated body.
  }
  if (!response.ok) throw new Error(`the OpenFlow host refused the request: ${describe(parsed, response)}; ${HOST_FIX}`)
  // Every result type of these routes carries a `status`; a body without one is not the host's.
  if (!parsed || typeof parsed !== "object" || !("status" in parsed) || typeof parsed.status !== "string") {
    throw new Error(`the OpenFlow host answered with something that is not a stage result; ${HOST_FIX}`)
  }
  // Shape checked above; the route's own type is the host's contract.
  return parsed as T
}

/** `origin` is empty in the browser, where the page's own origin serves `/flow/api/*`; tests pass a loopback URL. */
export function createStages(origin = "") {
  async function uplift(request: UpliftRequest): Promise<UpliftResult> {
    const started = Date.now()
    try {
      return await post<UpliftResult>(origin, UPLIFT_ROUTE, request)
    } catch (error) {
      return { status: "failed", reason: describe(error), original: request.original, elapsedMs: Date.now() - started }
    }
  }

  async function read(request: MemoryReadRequest): Promise<MemoryReadResult> {
    const started = Date.now()
    try {
      return await post<MemoryReadResult>(origin, MEMORY_ROUTES.read, request)
    } catch (error) {
      return { status: "unavailable", block: "", items: [], scopes: [], error: describe(error), elapsedMs: Date.now() - started }
    }
  }

  async function write(request: MemoryWriteRequest): Promise<MemoryWriteResult> {
    try {
      return await post<MemoryWriteResult>(origin, MEMORY_ROUTES.write, request)
    } catch (error) {
      return { status: "unavailable", error: describe(error) }
    }
  }

  return { uplift, memory: { read, write } }
}

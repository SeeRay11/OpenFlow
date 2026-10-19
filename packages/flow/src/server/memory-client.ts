import {
  MEMORY_ROUTES,
  type MemoryEntriesResult,
  type MemoryForgetRequest,
  type MemoryForgetResult,
  type MemoryStatus,
} from "../../shared/memory"

/**
 * Browser client for the read-side `MEMORY_ROUTES` (status, entries, forget).
 * Every call resolves to a result instead of throwing: the memory panel renders
 * each outcome in place, and "the host did not answer" must read differently from
 * "Substrate is unreachable", which the host reports inside a 200 body.
 */
export type ClientResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type MemoryClientOptions = {
  /** Origin prefix; empty in the browser, `http://127.0.0.1:<port>` in tests. */
  base?: string
  fetch?: Fetcher
}

export type MemoryClient = {
  status(): Promise<ClientResult<MemoryStatus>>
  entries(query: { pipeline: string; runId?: string; limit?: number }): Promise<ClientResult<MemoryEntriesResult>>
  forget(request: MemoryForgetRequest): Promise<ClientResult<MemoryForgetResult>>
}

const NO_ANSWER = "The OpenFlow host did not answer. Check that OpenFlow is still running, then refresh."

/** The one transport for the memory panel and the settings dialog's swarm check: JSON in, a result out. */
export async function requestJson<T>(
  doFetch: Fetcher,
  url: string,
  init?: { method: string; body?: unknown },
): Promise<ClientResult<T>> {
  let response: Response
  try {
    response = await doFetch(url, {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    return { ok: false, error: NO_ANSWER }
  }
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const reason =
      typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `The request failed (${response.status}).`
    return { ok: false, error: reason }
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, error: `The OpenFlow host sent an unreadable answer (${response.status}).` }
  }
  // The host is this app's own server: its 2xx bodies are the types in shared/.
  return { ok: true, value: payload as T }
}

export function createMemoryClient(options: MemoryClientOptions = {}): MemoryClient {
  const base = options.base ?? ""
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))

  return {
    status: () => requestJson<MemoryStatus>(doFetch, `${base}${MEMORY_ROUTES.status}`),
    entries(query) {
      const params = new URLSearchParams({ pipeline: query.pipeline })
      if (query.runId) params.set("run", query.runId)
      if (query.limit !== undefined) params.set("limit", String(query.limit))
      return requestJson<MemoryEntriesResult>(doFetch, `${base}${MEMORY_ROUTES.entries}?${params}`)
    },
    forget: (request) => requestJson<MemoryForgetResult>(doFetch, `${base}${MEMORY_ROUTES.forget}`, { method: "POST", body: request }),
  }
}

/** The browser's client: same-origin, global fetch. */
export const memory = createMemoryClient()

/**
 * A hand-rolled Agent Substrate client, presenting as surface `omp` (there is no
 * `openflow` surface server-side). REST for brief / memory / events, the stateless
 * MCP endpoint for `memory_search` and `graph_register`, which have no REST route.
 *
 * Every failure is a typed `SubstrateFailure`, never a throw: callers decide
 * whether to fail open (reads) or report (writes). The token lives only in the
 * `Authorization` header of the request; no result, message or status carries it.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { loopbackHost } from "../host/gate"

export const SURFACE = "omp"
export const READ_TIMEOUT_MS = 3000
export const WRITE_TIMEOUT_MS = 5000

export type SubstrateFailure = {
  ok: false
  kind: "unreachable" | "timeout" | "unauthorized" | "rejected" | "unavailable" | "protocol"
  status?: number
  /** One sentence, safe to show: names host:port, never a credential. */
  message: string
}

export type SubstrateResult<T> = { ok: true; value: T } | SubstrateFailure

export type SubstrateEntry = {
  id: string
  scope: string
  kind: string
  subject: string
  text: string
  created: string
  supersededBy?: string
  expired: boolean
  needsReverification: boolean
}

export type MemorySearchArgs = {
  scope?: string
  subjectPrefix?: string
  query?: string
  limit?: number
  before?: string
  beforeId?: string
}

export type MemorySearchPage = {
  entries: SubstrateEntry[]
  next?: { before: string; beforeId: string }
  degraded: boolean
}

export type Brief = { text: string; etag?: string; state: "complete" | "degraded" | "snapshot" }

export type MemoryWriteReply =
  | { ok: true; outcome: "accepted"; verified: boolean; entryId?: string; truncated: boolean; deduplicated: boolean }
  | { ok: true; outcome: "conflict" | "quarantined" | "denied"; reason: string; remedy?: string }
  | SubstrateFailure

export type SubstrateClient = {
  /** Host and port only. */
  hostPort: string
  healthz(): Promise<SubstrateResult<{ problems: string[] }>>
  brief(args: { repo?: string; branch?: string; graph_id?: string }): Promise<SubstrateResult<Brief>>
  memorySearch(args: MemorySearchArgs): Promise<SubstrateResult<MemorySearchPage>>
  memoryWrite(body: Record<string, unknown>): Promise<MemoryWriteReply>
  eventsEmit(body: Record<string, unknown>): Promise<SubstrateResult<{ id?: string }>>
  graphRegister(args: {
    graph_id: string
    repo?: string
    branch?: string
    nodes: Array<{ node_id: string; state: "started" }>
  }): Promise<SubstrateResult<unknown>>
}

export type TokenSource = "env" | "file" | "tokens-dir"

/**
 * The order the server's own clients use: `SUBSTRATE_TOKEN`, the first line of
 * `SUBSTRATE_TOKEN_FILE`, then `<SUBSTRATE_TOKENS_DIR or /etc/substrate/tokens>/omp`.
 */
export async function resolveToken(env: NodeJS.ProcessEnv): Promise<{ token: string; source: TokenSource } | undefined> {
  const direct = env.SUBSTRATE_TOKEN?.trim()
  if (direct) return { token: direct, source: "env" }
  const firstLine = async (path: string) => {
    const text = await readFile(path, "utf8").catch(() => "")
    return text.split("\n")[0]?.trim() ?? ""
  }
  if (env.SUBSTRATE_TOKEN_FILE) {
    const token = await firstLine(env.SUBSTRATE_TOKEN_FILE)
    if (token) return { token, source: "file" }
  }
  const token = await firstLine(join(env.SUBSTRATE_TOKENS_DIR || "/etc/substrate/tokens", SURFACE))
  return token ? { token, source: "tokens-dir" } : undefined
}

/**
 * Whether the omp token may be sent to `url`: it is https, its host is loopback, or its origin is the
 * one `SUBSTRATE_URL` names in the environment (the operator's own choice). The settings file can name
 * any URL, so without this a saved `http://elsewhere` would receive the bearer token in clear text.
 */
export function tokenAllowed(url: URL, env: NodeJS.ProcessEnv): boolean {
  if (url.protocol === "https:" || loopbackHost(url.host)) return true
  const named = env.SUBSTRATE_URL ? parseBaseUrl(env.SUBSTRATE_URL) : undefined
  return named?.origin === url.origin
}

/** One sentence for a URL the token is withheld from; names the host, never a credential. */
export function untrustedMessage(url: URL): string {
  return `Substrate at ${url.host} is plain http on a non-loopback host, so the omp token is not sent there. Use an https:// URL in the Omp settings, or set SUBSTRATE_URL to this address in the environment to trust it.`
}

/** `http(s)` base URL without a trailing slash, or undefined when it is not one. */
export function parseBaseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function toEntry(raw: unknown): SubstrateEntry | undefined {
  const item = record(raw)
  if (!item) return undefined
  const id = str(item.id)
  const text = str(item.text)
  if (id === undefined || text === undefined) return undefined
  return {
    id,
    scope: str(item.scope) ?? "",
    kind: str(item.kind) ?? "fact",
    subject: str(item.subject) ?? "",
    text,
    created: str(item.created) ?? "",
    supersededBy: str(item.superseded_by),
    expired: item.expired === true,
    needsReverification: item.needs_reverification === true,
  }
}

/** A short, secret-free rendering of a server-supplied reason. */
function clip(text: string | undefined, limit = 200): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, limit)
}

/** The JSON-RPC reply of the stateless MCP endpoint: plain JSON or an SSE `message` event. */
function parseRpc(body: string, id: number): Record<string, unknown> | undefined {
  const trimmed = body.trim()
  const candidates = trimmed.startsWith("{") ? [trimmed] : []
  if (candidates.length === 0) {
    for (const block of trimmed.split(/\n\n+/)) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (data) candidates.push(data)
    }
  }
  const parsed = candidates.flatMap((text) => {
    try {
      const value = record(JSON.parse(text))
      return value ? [value] : []
    } catch {
      return []
    }
  })
  return parsed.find((message) => message.id === id) ?? parsed.at(-1)
}

export function createClient(options: { url: URL; token: string; fetch: typeof fetch; env?: NodeJS.ProcessEnv }): SubstrateClient {
  const base = `${options.url.protocol}//${options.url.host}`
  const hostPort = options.url.host
  const trusted = tokenAllowed(options.url, options.env ?? process.env)
  let rpcId = 0

  async function send(
    path: string,
    init: { method: string; body?: unknown; auth: boolean; headers?: Record<string, string> },
    timeoutMs: number,
  ): Promise<{ ok: true; response: Response } | SubstrateFailure> {
    // The token never leaves for a URL that is not https, loopback or the one the environment names.
    if (init.auth && !trusted) return { ok: false, kind: "unavailable", message: untrustedMessage(options.url) }
    const headers: Record<string, string> = { ...init.headers }
    if (init.auth) headers.authorization = `Bearer ${options.token}`
    if (init.body !== undefined) headers["content-type"] = "application/json"
    try {
      const response = await options.fetch(`${base}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { ok: true, response }
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return { ok: false, kind: "timeout", message: `Substrate at ${hostPort} did not answer within ${timeoutMs / 1000}s.` }
      }
      return { ok: false, kind: "unreachable", message: `Substrate at ${hostPort} is unreachable.` }
    }
  }

  async function readBody(response: Response): Promise<string> {
    return response.text().catch(() => "")
  }

  /** Maps a non-success status to the failure it means; undefined when `status` is a success. */
  function statusFailure(status: number, body: string): SubstrateFailure | undefined {
    if (status >= 200 && status < 300) return undefined
    if (status === 401) {
      return { ok: false, kind: "unauthorized", status, message: `Substrate at ${hostPort} rejected the omp token (401); check SUBSTRATE_TOKEN.` }
    }
    const reason = clip(record(safeJson(body))?.error as string | undefined)
    if (status >= 500) {
      return { ok: false, kind: "unavailable", status, message: `Substrate at ${hostPort} is failing (${status})${reason ? `: ${reason}` : ""}.` }
    }
    return { ok: false, kind: "rejected", status, message: `Substrate at ${hostPort} refused the request (${status})${reason ? `: ${reason}` : ""}.` }
  }

  async function tool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<SubstrateResult<unknown>> {
    rpcId += 1
    const id = rpcId
    const sent = await send(
      "/mcp",
      {
        method: "POST",
        auth: true,
        headers: { accept: "application/json, text/event-stream" },
        body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      },
      timeoutMs,
    )
    if (!sent.ok) return sent
    const text = await readBody(sent.response)
    const failure = statusFailure(sent.response.status, text)
    if (failure) return failure
    const message = parseRpc(text, id)
    if (!message) return { ok: false, kind: "protocol", message: `Substrate at ${hostPort} answered ${name} with something that is not JSON-RPC.` }
    const rpcError = record(message.error)
    if (rpcError) return { ok: false, kind: "protocol", message: `Substrate refused ${name}: ${clip(str(rpcError.message))}.` }
    const result = record(message.result)
    const content = Array.isArray(result?.content) ? record(result.content[0]) : undefined
    const payload = str(content?.text) ?? ""
    if (result?.isError === true) {
      const reason = clip(str(record(safeJson(payload))?.error) ?? payload)
      return { ok: false, kind: "rejected", message: `Substrate refused ${name}: ${reason}.` }
    }
    return { ok: true, value: safeJson(payload) ?? payload }
  }

  return {
    hostPort,

    async healthz() {
      const sent = await send("/healthz", { method: "GET", auth: false }, READ_TIMEOUT_MS)
      if (!sent.ok) return sent
      const text = await readBody(sent.response)
      const failure = statusFailure(sent.response.status, text)
      if (failure) return failure
      const body = record(safeJson(text))
      const problems: string[] = []
      if (body?.index === false) problems.push("the Substrate index is down: memory cannot be read or written")
      const planes = record(body?.planes) ?? {}
      for (const [name, plane] of Object.entries(planes)) {
        if (record(plane)?.ok === false) problems.push(`the Substrate ${name} plane is degraded`)
      }
      return { ok: true, value: { problems } }
    },

    async brief(args) {
      const sent = await send("/brief", { method: "POST", auth: true, body: { ...args, surface: SURFACE } }, READ_TIMEOUT_MS)
      if (!sent.ok) return sent
      const text = await readBody(sent.response)
      const failure = statusFailure(sent.response.status, text)
      if (failure) return failure
      const header = sent.response.headers.get("x-substrate-brief")
      const state = header === "complete" || header === "snapshot" ? header : "degraded"
      return { ok: true, value: { text, etag: sent.response.headers.get("etag") ?? undefined, state } }
    },

    async memorySearch(args) {
      const argument: Record<string, unknown> = {}
      if (args.scope) argument.scope = args.scope
      if (args.subjectPrefix) argument.subject_prefix = args.subjectPrefix
      if (args.query) argument.query = args.query
      if (args.limit) argument.limit = Math.min(100, Math.max(1, args.limit))
      if (args.before) argument.before = args.before
      if (args.beforeId) argument.before_id = args.beforeId
      const reply = await tool("memory_search", argument, READ_TIMEOUT_MS)
      if (!reply.ok) return reply
      const body = record(reply.value)
      if (!body || !Array.isArray(body.entries)) {
        return { ok: false, kind: "protocol", message: `Substrate at ${hostPort} answered memory_search with an unexpected shape.` }
      }
      const entries = body.entries.flatMap((raw) => {
        const entry = toEntry(raw)
        return entry ? [entry] : []
      })
      const next = record(body.next)
      const before = str(next?.before)
      const beforeId = str(next?.before_id)
      return {
        ok: true,
        value: { entries, next: before && beforeId ? { before, beforeId } : undefined, degraded: body.degraded === true },
      }
    },

    async memoryWrite(body) {
      const sent = await send("/memory", { method: "POST", auth: true, body }, WRITE_TIMEOUT_MS)
      if (!sent.ok) return sent
      const text = await readBody(sent.response)
      const status = sent.response.status
      const reply = record(safeJson(text)) ?? {}
      if (status === 200 || status === 202) {
        return {
          ok: true,
          outcome: "accepted",
          verified: status === 200 && reply.verified_persisted === true,
          entryId: str(record(reply.entry)?.id),
          truncated: reply.truncated === true,
          deduplicated: reply.deduplicated === true,
        }
      }
      const outcome = status === 409 ? "conflict" : status === 422 ? "quarantined" : status === 403 ? "denied" : undefined
      if (outcome) {
        return { ok: true, outcome, reason: clip(str(reply.reason)), remedy: clip(str(reply.remedy)) || undefined }
      }
      return statusFailure(status, text) ?? { ok: false, kind: "protocol", message: `Substrate at ${hostPort} answered the write with ${status}.` }
    },

    async eventsEmit(body) {
      const sent = await send("/events", { method: "POST", auth: true, body: { ...body, surface: SURFACE } }, WRITE_TIMEOUT_MS)
      if (!sent.ok) return sent
      const text = await readBody(sent.response)
      const failure = statusFailure(sent.response.status, text)
      if (failure) return failure
      return { ok: true, value: { id: str(record(safeJson(text))?.id) } }
    },

    graphRegister(args) {
      return tool("graph_register", { ...args, status: "started" }, WRITE_TIMEOUT_MS)
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

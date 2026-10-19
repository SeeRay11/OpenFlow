/**
 * A real HTTP server (port 0) that speaks the slice of Agent Substrate OpenFlow uses:
 * `/healthz`, `/brief`, `/mcp` (initialize, tools/list, tools/call memory_search and
 * graph_register, replied as SSE), `/memory` and `/events`, over a real in-memory
 * memory store, with scripted failures. Shapes follow agent-substrate's server.ts / mcp.ts.
 * Tests only: it accepts exactly one bearer token and records every call.
 */

export type FakeEntry = {
  id: string
  scope: string
  kind: string
  subject: string
  text: string
  writer: string
  created: string
  version: number
  ttl: string
  graph_id?: string
  session_id?: string
  idempotency_key?: string
  superseded_by?: string
  expired?: boolean
  needs_reverification?: boolean
}

export type FakeCall = { method: string; path: string; authorized: boolean; body?: unknown; tool?: string; accept?: string | null }

/**
 * What the next `/memory` request does instead of the default accept-and-verify. Like the real Substrate, a
 * `fact` whose text hedges ("guessing", "might") is quarantined as `quarantine.speculative` without a script;
 * the same text as a `todo` is accepted. `pass` takes a slot in the queue and does nothing else.
 */
export type WriteScript = "pass" | "unverified" | "conflict" | "quarantine" | "denied" | "down"

export type FakeSubstrate = {
  url: string
  token: string
  entries: FakeEntry[]
  graphs: Map<string, { repo?: string; branch?: string; nodes: string[]; registrations: number }>
  /** The fake clock (real time plus `advance`), to hand to the module under test as `now`. */
  now(): number
  events: Array<Record<string, unknown>>
  calls: FakeCall[]
  /** One scripted behaviour is consumed per request of that kind; defaults apply once the queue is empty. */
  script: {
    write: WriteScript[]
    search: Array<"down" | "degraded" | "error">
    brief: Array<"down" | "degraded">
    events: Array<"down">
    register: Array<"error">
  }
  index: boolean
  planes: Record<string, { ok: boolean }>
  /** Moves the fake clock forward, so ages are testable without sleeping. */
  advance(ms: number): void
  seed(entry: Partial<FakeEntry> & Pick<FakeEntry, "scope" | "kind" | "text">): FakeEntry
  stop(): Promise<void>
}

type Json = Record<string, unknown>

const HEDGED = /\b(guessing|might)\b/i

export function startFakeSubstrate(options: { token?: string } = {}): FakeSubstrate {
  const token = options.token ?? "dummy-omp-token-0123456789abcdef"
  let offset = 0
  let counter = 0
  const byKey = new Map<string, { fingerprint: string; entry: FakeEntry }>()
  const state: FakeSubstrate = {
    url: "",
    token,
    entries: [],
    graphs: new Map(),
    events: [],
    calls: [],
    script: { write: [], search: [], brief: [], events: [], register: [] },
    index: true,
    planes: { greptime: { ok: true }, index: { ok: true }, hindsight: { ok: true } },
    now: () => Date.now() + offset,
    advance(ms) {
      offset += ms
    },
    seed(partial) {
      counter += 1
      const entry: FakeEntry = {
        id: `mem-${String(counter).padStart(6, "0")}`,
        subject: "",
        writer: "omp",
        created: new Date(Date.now() + offset).toISOString(),
        version: 1,
        ttl: "30d",
        ...partial,
      }
      state.entries.push(entry)
      return entry
    },
    stop: async () => {
      await server.stop(true)
    },
  }

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

  function brief(body: Json): Response {
    const mode = state.script.brief.shift()
    if (mode === "down") return reply(503, { error: "index unavailable" })
    const repo = typeof body.repo === "string" ? body.repo.toLowerCase() : ""
    const live = state.entries.filter((entry) => entry.scope === `repo:${repo}` && !entry.superseded_by)
    const section = (title: string, kind: string) => {
      const rows = live.filter((entry) => entry.kind === kind).slice(0, 4)
      return rows.length === 0 ? [] : ["", title, ...rows.map((entry) => `- ${entry.text} (omp, agent-claimed)`)]
    }
    const lines = [`## Substrate brief: ${repo} @ ${String(body.branch ?? "")}`, ...section("Decisions in force", "decision"), ...section("Warnings", "warning")]
    return new Response(lines.join("\n"), {
      headers: { "content-type": "text/markdown", etag: '"fake"', "x-substrate-brief": mode === "degraded" ? "degraded" : "complete" },
    })
  }

  function search(args: Json): Json {
    const prefix = typeof args.subject_prefix === "string" ? args.subject_prefix.toLowerCase() : undefined
    const words = typeof args.query === "string" ? args.query.toLowerCase().split(/\s+/).filter(Boolean) : []
    const limit = typeof args.limit === "number" ? args.limit : 10
    const paged = prefix !== undefined || args.before !== undefined
    let rows = state.entries
      .filter((entry) => !entry.superseded_by)
      .filter((entry) => args.scope === undefined || entry.scope === args.scope)
      .filter((entry) => prefix === undefined || entry.subject.startsWith(prefix))
      .filter((entry) => words.every((word) => entry.text.toLowerCase().includes(word)))
      .sort((a, b) => (a.created === b.created ? b.id.localeCompare(a.id) : b.created.localeCompare(a.created)))
    if (typeof args.before === "string") {
      const before = args.before
      const beforeId = typeof args.before_id === "string" ? args.before_id : undefined
      rows = rows.filter((entry) => entry.created < before || (entry.created === before && beforeId !== undefined && entry.id < beforeId))
    }
    const page = rows.slice(0, limit)
    if (!paged) return { entries: page, derived: [], degraded: false }
    const last = page.at(-1)
    return { entries: page, next: page.length === limit && rows.length > limit && last ? { before: last.created, before_id: last.id } : null }
  }

  function mcp(body: Json, accept: string | null): Response {
    const wrap = (result: unknown) => {
      const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result })
      return new Response(`event: message\ndata: ${message}\n\n`, { headers: { "content-type": "text/event-stream" } })
    }
    const text = (value: unknown, isError = false) => wrap({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) })
    if (!accept?.includes("application/json") || !accept.includes("text/event-stream")) return reply(406, { error: "Not Acceptable" })
    if (body.method === "initialize") return wrap({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-substrate", version: "0" } })
    if (body.method === "tools/list") return wrap({ tools: [{ name: "memory_search" }, { name: "graph_register" }] })
    const params = (body.params ?? {}) as Json
    const args = (params.arguments ?? {}) as Json
    if (body.method !== "tools/call") return reply(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } })
    if (params.name === "memory_search") {
      const mode = state.script.search.shift()
      if (mode === "down") return reply(503, { error: "index unavailable" })
      if (mode === "error") return text({ error: "memory_search needs `query`, or `subject_prefix`" }, true)
      const result = search(args)
      return text(mode === "degraded" ? { ...result, degraded: true, reason: "recall-timeout" } : result)
    }
    if (params.name === "graph_register") {
      if (state.script.register.shift() === "error") return text({ error: "graph registry unavailable" }, true)
      const graphId = String(args.graph_id)
      const known = state.graphs.get(graphId)
      const nodes = ((args.nodes ?? []) as Array<{ node_id: string }>).map((node) => node.node_id)
      state.graphs.set(graphId, {
        repo: args.repo as string | undefined,
        branch: args.branch as string | undefined,
        nodes,
        registrations: (known?.registrations ?? 0) + 1,
      })
      return text({ graph_id: graphId, nodes: nodes.length })
    }
    return reply(200, { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } })
  }

  function write(body: Json): Response {
    const mode = state.script.write.shift()
    if (mode === "down") return reply(503, { outcome: "denied", reason: "store.unavailable", remedy: "retry later", verified_persisted: false })
    if (mode === "conflict") return reply(409, { outcome: "conflict", reason: "version.required", remedy: "pass expected_version", verified_persisted: false })
    if (mode === "quarantine") return reply(422, { outcome: "quarantined", reason: "secret", remedy: "remove the secret", verified_persisted: false })
    if (mode === "denied") return reply(403, { outcome: "denied", reason: "grant.missing", remedy: "ask an operator for a grant", verified_persisted: false })
    if (body.kind === "fact" && HEDGED.test(String(body.text ?? ""))) {
      return reply(422, { outcome: "quarantined", reason: "quarantine.speculative", remedy: "Record it as kind=todo or kind=handoff", verified_persisted: false })
    }
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key : undefined
    const fingerprint = JSON.stringify([body.scope, body.kind, body.subject, body.text])
    const known = key ? byKey.get(key) : undefined
    if (known) {
      if (known.fingerprint !== fingerprint) return reply(409, { outcome: "conflict", reason: "idempotency.reused", verified_persisted: false })
      if (mode === "unverified") return reply(202, { outcome: "accepted", verified_persisted: false, deduplicated: true, entry: { id: known.entry.id } })
      return reply(200, { outcome: "accepted", verified_persisted: true, deduplicated: true, entry: { id: known.entry.id } })
    }
    const text = String(body.text ?? "")
    const entry = state.seed({
      scope: String(body.scope),
      kind: String(body.kind),
      subject: String(body.subject ?? "").toLowerCase(),
      text: text.slice(0, 4000),
      ttl: String(body.ttl ?? "permanent"),
      graph_id: body.graph_id as string | undefined,
      session_id: body.session_id as string | undefined,
      idempotency_key: key,
    })
    if (key) byKey.set(key, { fingerprint, entry })
    const truncated = text.length > 4000
    if (mode === "unverified") return reply(202, { outcome: "accepted", verified_persisted: false, entry: { id: entry.id }, truncated })
    return reply(200, { outcome: "accepted", verified_persisted: true, entry: { id: entry.id }, truncated })
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      const raw = request.method === "POST" ? await request.text() : ""
      const body = raw ? (JSON.parse(raw) as Json) : undefined
      const authorized = request.headers.get("authorization") === `Bearer ${token}`
      const params = (body?.params ?? {}) as Json
      state.calls.push({ method: request.method, path, authorized, body, tool: path === "/mcp" ? (params.name as string | undefined) : undefined, accept: request.headers.get("accept") })
      if (path === "/healthz") return reply(200, { index: state.index, appendOnly: true, planes: state.planes })
      if (!authorized) return reply(401, { error: "unauthorized" })
      if (request.method !== "POST" || !body) return reply(404, { error: "not found" })
      if (path === "/brief") return brief(body)
      if (path === "/mcp") return mcp(body, request.headers.get("accept"))
      if (path === "/memory") return write(body)
      if (path === "/events") {
        if (state.script.events.shift() === "down") return reply(503, { stored: false, error: "ledger unavailable" })
        if (body.surface !== "omp") return reply(400, { error: `unknown surface: ${String(body.surface)}` })
        state.events.push(body)
        return reply(202, { id: `evt-${state.events.length}`, stored: true })
      }
      return reply(404, { error: "not found" })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  return state
}

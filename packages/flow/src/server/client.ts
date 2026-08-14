import { createOpencodeClient, type AgentV2Info, type ModelRef, type ModelV2Info } from "@opencode-ai/sdk/v2/client"

export type FlowContext = {
  project: string
  pipelines: string
  runs: string
  generated: string
}

export type OpencodeClient = ReturnType<typeof createOpencodeClient>

let context: FlowContext | undefined
let client: OpencodeClient | undefined

/**
 * The vite dev server proxies `/api`, `/global` and `/event` to the running
 * `opencode serve`, so the browser talks to the same origin and no CORS or
 * password plumbing is needed.
 */
export async function connect() {
  if (client && context) return { client, context }
  const response = await fetch("/flow/api/context")
  if (!response.ok) throw new Error(`flow store unavailable (${response.status})`)
  context = (await response.json()) as FlowContext
  client = createOpencodeClient({ baseUrl: window.location.origin, directory: context.project })
  return { client, context }
}

export function project() {
  if (!context) throw new Error("not connected")
  return context.project
}

function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error) throw new Error(describe(result.error, result.response))
  if (result.response && !result.response.ok) throw new Error(describe(undefined, result.response))
  if (result.data === undefined) throw new Error("empty response")
  return result.data
}

/**
 * Turns whatever the client produced into a line a user can act on.
 *
 * The generated client hands back the *parsed body* on the result-tuple path,
 * so a failure with no body — the dev proxy's answer when `opencode serve` is
 * down — arrives as `{}` and used to render as the literal string `{}`. The
 * status is the only fact left in that case, so it is carried separately and
 * used whenever the body says nothing.
 */
export function describe(error: unknown, response?: Response): string {
  const status =
    response && !response.ok
      ? `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
      : undefined
  const text = reason(error)
  if (text && status) return `${text} (${status})`
  return text ?? status ?? "unknown error"
}

function reason(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error || undefined
  if (error instanceof Error) return error.message || undefined
  const record = error as Record<string, any>
  if (typeof record.message === "string" && record.message) return record.message
  if (typeof record.data?.message === "string" && record.data.message) return record.data.message
  if (typeof record._tag === "string" && record._tag) return record._tag
  const json = JSON.stringify(error)
  return json && json !== "{}" && json !== "[]" ? json : undefined
}

export async function health() {
  const { client } = await connect()
  const result = await client.v2.health.get()
  return unwrap<any>(result as any)
}

export async function agents(): Promise<AgentV2Info[]> {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.agent.list()) as any)
  return (body.data ?? body) as AgentV2Info[]
}

export async function models(): Promise<ModelV2Info[]> {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.model.list()) as any)
  return (body.data ?? body) as ModelV2Info[]
}

/**
 * One provider the server knows about, with whatever credentials it currently
 * holds for it.
 *
 * The catalog carries all ~184 models.dev providers whether or not they are
 * usable; `connections` is what decides. A provider with no connection and no
 * environment variable contributes no models to `models()`, which is why an
 * un-keyed OpenFlow only ever sees the free zen models.
 */
export type Integration = {
  id: string
  name: string
  methods: Array<{ type: string; names?: string[] }>
  connections: Array<{ type: string; id: string; label?: string }>
}

export async function integrations(): Promise<Integration[]> {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.integration.list()) as any)
  return (body.data ?? body) as Integration[]
}

/**
 * Stores an API key for a provider and makes its models selectable.
 *
 * The catalog picks the credential up immediately — no `opencode serve`
 * restart, unlike a config merge. The key is NOT verified here: the server
 * stores whatever it is given, so a typo surfaces later as a 401 at run time.
 * Use `testModel` to find that out now instead.
 */
export async function connectKey(integrationID: string, key: string, label?: string) {
  const { client } = await connect()
  const result = (await client.v2.integration.connect.key({ integrationID, key, label })) as any
  if (result.error) throw new Error(describe(result.error))
  return true
}

export async function removeCredential(credentialID: string) {
  const { client } = await connect()
  const result = (await client.v2.credential.remove({ credentialID })) as any
  if (result.error) throw new Error(describe(result.error))
  return true
}

export type ModelTest = { ok: boolean; error?: string; ms: number }

/**
 * Proves a model actually answers, by running one throwaway session against it.
 *
 * A stored key and a listed model are both necessary and neither is
 * sufficient: the catalog advertises models an account may not be entitled to
 * (`north-mini-code-free` answers `HTTP 401 Model ... is not supported`), and
 * a mistyped key looks identical until something is sent. This spends a few
 * tokens on purpose.
 */
export async function testModel(model: string, options: { timeout?: number } = {}): Promise<ModelTest> {
  const started = Date.now()
  try {
    const session = await createSession({ model })
    await prompt(session.id, "Reply with the single word: ok")
    await waitForIdle(session.id, { timeout: options.timeout ?? 60_000, interval: 500 })
    const result = await transcript(session.id)
    if (result.error) return { ok: false, error: result.error, ms: Date.now() - started }
    if (!result.text) return { ok: false, error: "the model returned no text", ms: Date.now() - started }
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: describe(error), ms: Date.now() - started }
  }
}

export function parseModel(value?: string): ModelRef | undefined {
  if (!value) return undefined
  const index = value.indexOf("/")
  if (index < 1) return undefined
  return { providerID: value.slice(0, index), id: value.slice(index + 1) }
}

export function formatModel(model?: ModelRef) {
  return model ? `${model.providerID}/${model.id}` : ""
}

export async function createSession(input: { agent?: string; model?: string }) {
  const { client, context } = await connect()
  const body = unwrap<any>(
    (await client.v2.session.create({
      agent: input.agent || undefined,
      model: parseModel(input.model),
      location: { directory: context.project },
    })) as any,
  )
  const session = body.data ?? body
  return session as { id: string }
}

export async function prompt(sessionID: string, text: string) {
  const { client } = await connect()
  return unwrap<any>((await client.v2.session.prompt({ sessionID, prompt: { text } })) as any)
}

/** Session IDs whose agent loop is currently executing on the server. */
export async function activeSessions(): Promise<Set<string>> {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.session.active()) as any)
  return new Set(Object.keys(body.data ?? body ?? {}))
}

/**
 * Resolves when the session's agent loop goes idle.
 *
 * `POST /api/session/:id/wait` answers 503 "Session wait is not available yet"
 * on this server build, so idleness is derived from `/api/session/active`
 * (which lists executing sessions) plus a finished assistant turn.
 */
export async function waitForIdle(
  sessionID: string,
  options: { signal?: AbortSignal; interval?: number; timeout?: number } = {},
) {
  const interval = options.interval ?? 750
  const timeout = options.timeout ?? 30 * 60_000
  const started = Date.now()
  let sawActive = false

  while (true) {
    if (options.signal?.aborted) return
    await new Promise((resolve) => setTimeout(resolve, interval))
    if (options.signal?.aborted) return

    const active = await activeSessions().catch(() => undefined)
    if (active?.has(sessionID)) {
      sawActive = true
      continue
    }

    const finished = await lastAssistant(sessionID)
    if (finished && (finished.finish || finished.error)) return
    // The loop may not have been admitted yet; give it a grace window.
    if (!sawActive && Date.now() - started < 20_000) continue
    if (Date.now() - started > timeout) throw new Error("timed out waiting for the session to finish")
    if (active === undefined) continue
    if (!sawActive) throw new Error("the session never started executing — check the model and provider auth")
    return
  }
}

async function lastAssistant(sessionID: string) {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.session.messages({ sessionID, order: "desc", limit: 10 })) as any)
  return (body.data ?? []).find((message: any) => message.type === "assistant")
}

export type PermissionReply = "once" | "always" | "reject"

/**
 * Answers a pending permission request.
 *
 * "once" approves just this call; "always" writes the approval into the
 * project's saved-permission store, which outlives the run.
 */
export async function replyPermission(sessionID: string, requestID: string, reply: PermissionReply) {
  const { client } = await connect()
  const result = (await client.v2.session.permission.reply({ sessionID, requestID, reply })) as any
  if (result.error) throw new Error(describe(result.error))
  return result.data
}

export async function interrupt(sessionID: string) {
  const { client } = await connect()
  await client.v2.session.interrupt({ sessionID }).catch(() => undefined)
}

export type Transcript = { text: string; error?: string }

/** Final assistant turn of a session: concatenated text parts plus any error. */
export async function transcript(sessionID: string): Promise<Transcript> {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.session.messages({ sessionID, order: "desc", limit: 30 })) as any)
  const messages: any[] = body.data ?? []
  const assistant = messages.find((message) => message.type === "assistant")
  if (!assistant) return { text: "" }
  const text = (assistant.content ?? [])
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n")
    .trim()
  return { text, error: assistant.error ? describe(assistant.error) : undefined }
}

export type BusEvent = { type: string; data?: Record<string, any> }

/**
 * Subscribes to the global event bus. Resolves when the stream ends or the
 * signal aborts — the SSE client reconnects on error, so the abort has to be
 * raced rather than awaited, otherwise this never settles.
 */
export async function subscribe(onEvent: (event: BusEvent) => void, signal: AbortSignal) {
  const { client } = await connect()
  const result: any = await client.v2.event.subscribe({ signal, sseMaxRetryAttempts: 0 } as any)
  const consume = (async () => {
    for await (const event of result.stream) {
      if (signal.aborted) return
      if (event && typeof event === "object" && "type" in event) onEvent(event as BusEvent)
    }
  })()
  await Promise.race([consume, aborted(signal)])
}

function aborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

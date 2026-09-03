import { createOpencodeClient, type AgentV2Info, type ModelRef, type ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { Attachment, StepUsage } from "../graph/types"
import { sessionRows, transcriptTurns, type SessionRow, type Turn } from "./sessions"

export type { Attachment }
export type { SessionRow, Turn }

export type FlowContext = {
  project: string
  pipelines: string
  runs: string
  generated: string
  /** Pipeline that was open in this project last time, if any. */
  pipeline?: string
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

/**
 * Drops the cached client and context so the next call to `connect()` rereads
 * `/flow/api/context` and rebuilds the client against whatever project is
 * live there. Used after switching the project — every session created
 * before this still points at the old directory, but nothing new does.
 */
export function disconnect() {
  client = undefined
  context = undefined
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
  // Both hosts answer a proxy failure with `message`, but `error` is the key
  // the `/flow/api` store uses and the one the built host used to emit. Reading
  // it too means a host drifting back to it renders a sentence, not a JSON blob.
  if (typeof record.error === "string" && record.error) return record.error
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

/**
 * `directory` places the session somewhere other than the project — a card's
 * own git worktree. Measured 2026-09-03: a session created with that location
 * ran its `bash` tool there rather than in the engine's cwd, which is what
 * makes per-card isolation possible at all. It is fixed for the life of the
 * session, so a card re-dispatched into the session it already holds cannot be
 * moved to a different tree.
 */
export async function createSession(input: { agent?: string; model?: string; directory?: string }) {
  const { client, context } = await connect()
  const body = unwrap<any>(
    (await client.v2.session.create({
      agent: input.agent || undefined,
      model: parseModel(input.model),
      location: { directory: input.directory || context.project },
    })) as any,
  )
  const session = body.data ?? body
  return session as { id: string }
}

/** One page of history — enough that the sidebar filter has everything to match. */
const SESSION_PAGE = 200

/**
 * The sessions `opencode serve` holds for this project, newest first.
 *
 * These are the rows of the drizzle-backed `session` table in `opencode.db`,
 * the same ones the CLI and TUI list: a node's session is created through the
 * server, so it is already there and OpenFlow keeps no second store.
 *
 * `search` is deliberately *not* forwarded to the endpoint. The server matches
 * it against the session title only, and an OpenFlow node never sets a title —
 * every one of them is auto-named "New session - <iso>". So `search=coder`
 * answers zero for a project holding ten coder sessions, while the fields that
 * actually identify a node (its generated agent, its model) are unsearchable.
 * Filtering a page here matches what the user can see; see `matches()`.
 */
export async function sessions(limit = SESSION_PAGE): Promise<SessionRow[]> {
  const { client, context } = await connect()
  const body = unwrap<any>(
    (await client.v2.session.list({ directory: context.project, order: "desc", limit })) as any,
  )
  return sessionRows(body.data ?? [])
}

/** A session's readable turns, oldest first, for the sidebar's detail view. */
export async function sessionTranscript(sessionID: string, limit = 100): Promise<Turn[]> {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.session.messages({ sessionID, order: "asc", limit })) as any)
  return transcriptTurns(body.data ?? [])
}

/**
 * Sends the prompt, with any attachments as `files`.
 *
 * The server reads the mime type straight off a `data:` URL and passes the URL
 * through to the model as media, so a data URL is the whole transport — nothing
 * is written to disk and no upload endpoint is involved. Attachments are only
 * ever passed for a model that accepts that modality; see `accepts()`.
 */
export async function prompt(sessionID: string, text: string, files: Attachment[] = []) {
  const { client } = await connect()
  const attachments = files.map((file) => ({ uri: file.url, name: file.name }))
  return unwrap<any>(
    (await client.v2.session.prompt({
      sessionID,
      prompt: { text, ...(attachments.length ? { files: attachments } : {}) },
    })) as any,
  )
}

/**
 * Whether a model can take this attachment as input.
 *
 * `capabilities.input` is the model's input modality list ("text", "image",
 * "pdf", …). A model without the modality is not sent the file at all — the
 * request would either error or, worse, silently drop it — so the engine
 * substitutes a text note naming what was withheld and the chain keeps going.
 */
export function accepts(model: ModelV2Info | undefined, mime: string) {
  if (!model) return false
  const modalities = new Set(model.capabilities?.input ?? [])
  if (mime.startsWith("image/")) return modalities.has("image")
  if (mime === "application/pdf") return modalities.has("pdf")
  if (mime.startsWith("audio/")) return modalities.has("audio")
  if (mime.startsWith("video/")) return modalities.has("video")
  // Text-ish files ride along as text, which every model takes.
  return true
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

export type QuestionOption = { label: string; description: string }
export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

/**
 * Answers a question the agent asked through its `question` tool.
 *
 * Answers are positional — one array of chosen labels per question, in the
 * order they were asked — and a custom answer is just a label the options did
 * not contain.
 */
export async function replyQuestion(sessionID: string, requestID: string, answers: string[][]) {
  const { client } = await connect()
  const result = (await client.v2.session.question.reply({
    sessionID,
    requestID,
    questionV2Reply: { answers },
  })) as any
  if (result.error) throw new Error(describe(result.error))
  return result.data
}

/** Declines to answer. The agent is told nobody answered and continues on its own. */
export async function rejectQuestion(sessionID: string, requestID: string) {
  const { client } = await connect()
  const result = (await client.v2.session.question.reject({ sessionID, requestID })) as any
  if (result.error) throw new Error(describe(result.error))
  return result.data
}

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

/**
 * Live connection state of every MCP server the running server knows about.
 *
 * This is the server's view, not the config's: a server added to
 * `opencode.json` after `opencode serve` booted is absent here until it
 * restarts, which is the single most confusing thing about MCP config and the
 * reason the panel prints both lists.
 */
export async function mcpStatus(): Promise<Record<string, McpStatus>> {
  const { client } = await connect()
  const body = unwrap<any>((await client.mcp.status({})) as any)
  return (body?.data ?? body ?? {}) as Record<string, McpStatus>
}

export async function mcpConnect(name: string) {
  const { client } = await connect()
  const result = (await client.mcp.connect({ name })) as any
  if (result.error) throw new Error(describe(result.error))
  return result.data
}

export async function mcpDisconnect(name: string) {
  const { client } = await connect()
  const result = (await client.mcp.disconnect({ name })) as any
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

  const found = turnText(messages)
  if (!found) return { text: "" }
  return { text: found.text, error: found.error ? describe(found.error) : undefined }
}

/**
 * What a card said on its most recent turn, from the message page newest first.
 *
 * A turn is a *run* of assistant messages and only some of them carry text: a
 * card that ends on a tool call leaves `content: [tool]` as its newest message,
 * with what it actually said one or two messages behind it. Reading only the
 * newest returns "" for those turns — measured, that is what killed three
 * orchestration runs with "your message carried no block" while the block sat
 * in the same turn, two messages back.
 *
 * The scan stops at a user message carrying a top-level `text`, which is what a
 * real prompt looks like. Tool output arrives as parts on an assistant message
 * rather than as a prompt, so it cannot end the scan early — and stopping at the
 * prompt is what keeps a *previous* turn's block from being read as this turn's
 * answer, which would dispatch the same work twice.
 *
 * Errors belong to the newest message whether or not it said anything: a turn
 * that failed after speaking is still a failed turn.
 */
export function turnText(messages: any[]) {
  let newest: any
  for (const message of messages) {
    if (message.type === "user" && typeof message.text === "string" && message.text.trim()) break
    if (message.type !== "assistant") continue
    newest ??= message
    const text = (message.content ?? [])
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n")
      .trim()
    if (text) return { text, error: newest.error }
  }
  return newest ? { text: "", error: newest.error } : undefined
}

export type ToolCall = { id: string; name: string; input: unknown }

/**
 * Tool calls the session made, newest first, each with the id opencode gave it.
 *
 * The id is what lets the caller tell this turn's calls from earlier ones. An
 * earlier attempt bounded the scan at the most recent user message instead, and
 * it silently returned nothing: a tool *result* comes back as a user-type
 * message, so the scan stopped before it ever reached the assistant message
 * holding the call. Measured — the card called the tool correctly and the
 * engine read its text anyway.
 *
 * Read from the message history rather than the event bus for the same reason
 * usage is: the bus is best-effort and reconnects, while this is what the
 * server persisted. It is also why the orchestrator's decision is read here
 * rather than from `transcript` — a card that dispatches and then writes a
 * to-do list has the call sitting under later parts, and `transcript` only ever
 * returns the newest assistant message's *text*.
 *
 * One page is enough: the caller wants the decision this turn ended on, not the
 * history of every turn before it.
 */
export async function sessionCalls(sessionID: string, limit = 30): Promise<ToolCall[]> {
  const { client } = await connect()
  const body = unwrap<any>((await client.v2.session.messages({ sessionID, order: "desc", limit })) as any)
  const calls: ToolCall[] = []
  for (const message of (body.data ?? []) as any[]) {
    if (message.type !== "assistant") continue
    // Messages arrive newest-first but parts within one are in the order they
    // happened, so they are walked backwards to keep the whole list newest-first.
    for (const part of [...((message.content ?? []) as any[])].reverse()) {
      if (part.type !== "tool" || typeof part.name !== "string" || typeof part.id !== "string") continue
      calls.push({ id: part.id, name: part.name, input: part.state?.input })
    }
  }
  return calls
}

/**
 * Every settled assistant step in a session, with the tokens the provider
 * reported for it.
 *
 * This is the authoritative usage record: the event bus can drop events (it is
 * subscribed best-effort and reconnects), while the message history is what the
 * server persisted. The whole history is paged through — a session that
 * compacted or ran fifty tool steps has far more than one page of messages, and
 * a short read would silently under-report the bill.
 *
 * Steps with no `tokens` are skipped rather than counted as zero: a step that
 * failed before the provider returned usage may still have been billed, and
 * inventing a zero for it would state a total we cannot prove.
 */
export async function sessionSteps(sessionID: string): Promise<StepUsage[]> {
  const { client } = await connect()
  const steps: StepUsage[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page += 1) {
    const body = unwrap<any>(
      (await client.v2.session.messages({
        sessionID,
        limit: 200,
        ...(cursor ? { cursor } : { order: "asc" }),
      })) as any,
    )
    const messages: any[] = body.data ?? []
    for (const message of messages) {
      if (message.type !== "assistant" || !message.tokens) continue
      if (seen.has(message.id)) continue
      seen.add(message.id)
      steps.push({
        messageID: message.id,
        model: formatModel(message.model),
        tokens: {
          input: message.tokens.input ?? 0,
          output: message.tokens.output ?? 0,
          reasoning: message.tokens.reasoning ?? 0,
          cacheRead: message.tokens.cache?.read ?? 0,
          cacheWrite: message.tokens.cache?.write ?? 0,
        },
      })
    }
    cursor = messages.length === 200 ? body.cursor?.next : undefined
    if (!cursor) break
  }
  return steps
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

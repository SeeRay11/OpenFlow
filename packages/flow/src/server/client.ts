import type { Attachment } from "../graph/types"
import { engineRoutes, sessionRoute } from "../../shared/engine"
import type {
  BusEvent,
  CreateSession,
  HealthInfo,
  ModelInfo,
  PermissionReply,
  PromptFile,
  PromptRequest,
  QuestionInfo,
  SessionRow,
  ToolCall,
  Transcript,
  Turn,
  WaitRequest,
  WaitResult,
  WireStep,
} from "../../shared/engine"

export type { Attachment }
export type {
  BusEvent,
  HealthInfo,
  ModelInfo,
  PermissionReply,
  QuestionInfo,
  SessionRow,
  ToolCall,
  Transcript,
  Turn,
  WireStep,
}

export type FlowContext = {
  project: string
  pipelines: string
  runs: string
  generated: string
  /** Pipeline that was open in this project last time, if any. */
  pipeline?: string
}

export type ModelRef = { providerID: string; id: string }

let context: FlowContext | undefined
/**
 * Prefix of every request. Empty in the browser, where the page's own origin
 * serves `/flow/api/*`; tests point it at a loopback server, since a relative
 * URL means nothing outside a page.
 */
let origin = ""

export function setOrigin(value: string) {
  origin = value
  context = undefined
}

export async function connect() {
  if (context) return { context }
  const response = await fetch(`${origin}/flow/api/context`)
  if (!response.ok) throw new Error(`flow store unavailable (${response.status})`)
  context = (await response.json()) as FlowContext
  return { context }
}

export function project() {
  if (!context) throw new Error("not connected")
  return context.project
}

/**
 * Drops the cached context so the next call to `connect()` rereads
 * `/flow/api/context` and sees whatever project is live there. Used after
 * switching the project — every session created before this still points at
 * the old directory, but nothing new does.
 */
export function disconnect() {
  context = undefined
}

/**
 * Turns whatever a failure produced into a line a user can act on.
 *
 * A body can be empty: the dev proxy answers `{}` or nothing when the host is
 * down, and that used to render as the literal string `{}`. The status is the
 * only fact left in that case, so it is carried separately and used whenever
 * the body says nothing. The engine wire's own bodies are `{ error }`
 * (`EngineError`); provider failures keep their `HTTP 429 …` wording in that
 * text because the engine classifies retries by regex on it.
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
  // `error` is the key `EngineError` and the `/flow/api` store answer with; a
  // host drifting to another shape should still render a sentence, not a blob.
  if (typeof record.error === "string" && record.error) return record.error
  if (typeof record._tag === "string" && record._tag) return record._tag
  const json = JSON.stringify(error)
  return json && json !== "{}" && json !== "[]" ? json : undefined
}

/** A non-2xx answer: the wire's own text, status appended, and the status itself for callers that branch on it. */
class HttpError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function failure(response: Response) {
  const text = await response.text().catch(() => "")
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON (an HTML error page from a proxy): the status is all there is.
  }
  return new HttpError(describe(body, response), response.status)
}

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  if (!response.ok) throw await failure(response)
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function health() {
  return call<HealthInfo>(engineRoutes.health)
}

export async function models(): Promise<ModelInfo[]> {
  return call<ModelInfo[]>(engineRoutes.models)
}

export type ModelTest = { ok: boolean; error?: string; ms: number }

/**
 * Proves a model actually answers, by running one throwaway session against it.
 *
 * A listed model and stored credentials are both necessary and neither is
 * sufficient: a catalog advertises models an account may not be entitled to,
 * and a mistyped key looks identical until something is sent. This spends a few
 * tokens on purpose.
 */
export async function testModel(model: string, options: { timeout?: number } = {}): Promise<ModelTest> {
  const started = Date.now()
  let sessionID: string | undefined
  try {
    const session = await createSession({
      runId: "model-test",
      nodeId: "model-test",
      card: { key: "openflow-model-test", role: "model test" },
      model,
      permissions: "auto",
    })
    sessionID = session.id
    await prompt(session.id, "Reply with the single word ok.")
    await waitForIdle(session.id, { timeout: options.timeout ?? 60_000 })
    const result = await transcript(session.id)
    if (result.error) return { ok: false, error: result.error, ms: Date.now() - started }
    if (!result.text) return { ok: false, error: "the model returned no text", ms: Date.now() - started }
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: describe(error), ms: Date.now() - started }
  } finally {
    if (sessionID) await release(sessionID)
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
 * The host launches an Omp process for the card (`input.directory` is its
 * worktree, fixed for the session's life) or, with `input.reuse`, re-attaches to
 * one an earlier run left open.
 */
export async function createSession(input: CreateSession): Promise<{ id: string }> {
  return call<{ id: string }>(engineRoutes.sessions, { method: "POST", body: input })
}

/** One page of history — enough that the sidebar filter has everything to match. */
const SESSION_PAGE = 200

/** The sessions the host holds, newest first. The filtering happens in the page: see `matches()`. */
export async function sessions(limit = SESSION_PAGE): Promise<SessionRow[]> {
  return call<SessionRow[]>(`${engineRoutes.sessions}?limit=${limit}`)
}

/** A session's readable turns, oldest first, for the sidebar's detail view. */
export async function sessionTranscript(sessionID: string, limit = 100): Promise<Turn[]> {
  return call<Turn[]>(`${sessionRoute(sessionID, "/transcript")}?limit=${limit}`)
}

/**
 * Sends the prompt, with any attachments as `files`.
 *
 * A `data:` URL is the whole transport: nothing is written to disk and no
 * upload endpoint is involved. Attachments are only ever passed for a model
 * that accepts that modality; see `accepts()`.
 */
export async function prompt(sessionID: string, text: string, files: PromptFile[] = []) {
  const body: PromptRequest = { text }
  if (files.length) body.files = files.map((file) => ({ name: file.name, url: file.url, mime: file.mime }))
  return call<unknown>(sessionRoute(sessionID, "/prompt"), { method: "POST", body })
}

/**
 * Whether a model can take this attachment as input.
 *
 * `capabilities.input` is the model's input modality list ("text", "image",
 * "pdf", …). A model without the modality is not sent the file at all — the
 * request would either error or, worse, silently drop it — so the engine
 * substitutes a text note naming what was withheld and the chain keeps going.
 */
export function accepts(model: ModelInfo | undefined, mime: string) {
  if (!model) return false
  const modalities = new Set(model.capabilities?.input ?? [])
  if (mime.startsWith("image/")) return modalities.has("image")
  if (mime === "application/pdf") return modalities.has("pdf")
  if (mime.startsWith("audio/")) return modalities.has("audio")
  if (mime.startsWith("video/")) return modalities.has("video")
  // Text-ish files ride along as text, which every model takes.
  return true
}

/**
 * The longest one `/wait` request is held open. No request lives for minutes:
 * browsers, proxies and tunnels drop a response that sends no bytes for that
 * long, and Bun's `fetch` was observed abandoning a 300 s response, leaving the
 * caller hung after the host had already settled the session.
 */
const WAIT_SLICE_MS = 55_000

/**
 * Resolves when the host reports the session settled — a long-poll re-issued in
 * slices of `options.slice` (default 55 s), so there is no polling interval;
 * `options.interval` is accepted for the engine's call sites and ignored.
 *
 * `options.timeout` is the overall budget: each request asks for the lesser of
 * a slice and what is left, a `timeout` answer from the host means the session
 * is still running and the next slice is asked for, and only a passed deadline
 * throws. Without a timeout it waits until idle, abort, `missing` or `error`.
 *
 * An abort of `options.signal` ends the request and returns silently, the same
 * as an `aborted` result that the caller asked for. An `aborted` result nobody
 * asked for (something else interrupted the session) is an error: the engine
 * must not read it as a finished answer.
 */
export async function waitForIdle(
  sessionID: string,
  options: { signal?: AbortSignal; interval?: number; timeout?: number; slice?: number } = {},
) {
  const slice = options.slice ?? WAIT_SLICE_MS
  const deadline = options.timeout === undefined ? Infinity : Date.now() + options.timeout
  while (!options.signal?.aborted) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("timed out waiting for the session to finish")
    const body: WaitRequest = { timeoutMs: Math.min(slice, remaining) }
    let result: WaitResult
    try {
      result = await call<WaitResult>(sessionRoute(sessionID, "/wait"), { method: "POST", body, signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted) return
      throw error
    }
    if (result.status === "missing") throw new Error(`session not found: ${sessionID}`)
    if (result.status === "timeout") continue
    if (result.result === "error") throw new Error(result.error || "the session failed")
    if (result.result === "aborted") {
      if (options.signal?.aborted) return
      throw new Error("the session was interrupted")
    }
    return
  }
}

/** Answers a pending permission request (`permission.v2.asked`). */
export async function replyPermission(sessionID: string, requestID: string, reply: PermissionReply) {
  return call<unknown>(sessionRoute(sessionID, `/permission/${encodeURIComponent(requestID)}`), {
    method: "POST",
    body: { reply },
  })
}

/**
 * Answers a question the agent asked through omp's `ask` tool.
 *
 * `answers` has one entry per question, each the labels chosen — or the typed
 * text for a custom answer.
 */
export async function replyQuestion(sessionID: string, requestID: string, answers: string[][]) {
  return call<unknown>(sessionRoute(sessionID, `/question/${encodeURIComponent(requestID)}`), {
    method: "POST",
    body: { answers },
  })
}

/** Declines to answer. The agent is told nobody answered and continues on its own. */
export async function rejectQuestion(sessionID: string, requestID: string) {
  return call<unknown>(sessionRoute(sessionID, `/question/${encodeURIComponent(requestID)}/reject`), { method: "POST" })
}

/** Stops the turn in flight. Never throws: an interrupt that cannot be delivered has nothing left to stop. */
export async function interrupt(sessionID: string) {
  await call<unknown>(sessionRoute(sessionID, "/interrupt"), { method: "POST" }).catch(() => undefined)
}

/** Disposes a session the engine abandons. Best effort: a session already gone is the goal state. */
export async function release(sessionID: string) {
  await call<unknown>(sessionRoute(sessionID), { method: "DELETE" }).catch(() => undefined)
}

/** Disposes every session of a run that finished or was abandoned. Best effort. */
export async function releaseRun(runId: string) {
  await call<unknown>(engineRoutes.releaseRun, { method: "POST", body: { runId } }).catch(() => undefined)
}

/** Final assistant turn of a session: the joined text parts plus any error, already described. */
export async function transcript(sessionID: string): Promise<Transcript> {
  return call<Transcript>(sessionRoute(sessionID, "/final"))
}

/**
 * Tool calls the session made, newest first, each with the id omp gave it.
 *
 * The id is what lets the caller tell this turn's calls from earlier ones.
 * Read from the host's persisted history rather than the event bus, which is
 * best-effort and has no replay.
 */
export async function sessionCalls(sessionID: string, limit = 30): Promise<ToolCall[]> {
  return call<ToolCall[]>(`${sessionRoute(sessionID, "/calls")}?limit=${limit}`)
}

/**
 * Every settled assistant step in a session, with the tokens the provider
 * billed for it. Read from the host rather than summed from bus events, for the
 * same reason as `sessionCalls`.
 */
export async function sessionSteps(sessionID: string): Promise<WireStep[]> {
  return call<WireStep[]>(sessionRoute(sessionID, "/steps"))
}

/**
 * Subscribes to the event stream. Resolves when the stream ends or the signal
 * aborts; a dropped connection rejects instead of reconnecting, because there
 * is no replay and the engine re-reads authoritative state itself after a gap.
 *
 * SSE framing: events are `data:` lines ended by a blank line, `:` lines are
 * keep-alive comments, and any of CRLF / LF / CR ends a line — including when a
 * chunk boundary falls between the CR and the LF.
 */
export async function subscribe(onEvent: (event: BusEvent) => void, signal: AbortSignal) {
  if (signal.aborted) return
  try {
    const response = await fetch(`${origin}${engineRoutes.events}`, { headers: { accept: "text/event-stream" }, signal })
    if (!response.ok) throw await failure(response)
    if (!response.body) throw new Error("the event stream has no body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let data: string[] = []

    const line = (text: string) => {
      if (text === "") {
        const joined = data.join("\n")
        data = []
        if (!joined) return
        let event: unknown
        try {
          event = JSON.parse(joined)
        } catch {
          // A frame the host did not finish writing is not an event.
          return
        }
        if (event && typeof event === "object" && typeof (event as BusEvent).type === "string") onEvent(event as BusEvent)
        return
      }
      if (!text.startsWith("data:")) return
      data.push(text.slice(text.startsWith("data: ") ? 6 : 5))
    }

    while (true) {
      const chunk = await reader.read()
      if (signal.aborted) return
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let start = 0
      for (const match of buffer.matchAll(/\r\n|\r|\n/g)) {
        // A CR at the very end may be the first half of a CRLF split across chunks.
        if (match[0] === "\r" && match.index + 1 === buffer.length && !chunk.done) break
        line(buffer.slice(start, match.index))
        start = match.index + match[0].length
      }
      buffer = buffer.slice(start)
      if (chunk.done) return
    }
  } catch (error) {
    if (signal.aborted) return
    throw error
  }
}

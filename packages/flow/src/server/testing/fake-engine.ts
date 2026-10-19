import type {
  BusEvent,
  CreateSession,
  ModelInfo,
  SessionRow,
  ToolCall,
  Transcript,
  Turn,
  WaitResult,
  WireStep,
} from "../../../shared/engine"
import type { SwarmStatus } from "../../../shared/swarm"
import { accepts, describe } from "../client"
import type { EngineSurface } from "../engine-contract"
import type { ContractDriver, Decision, PermissionAsk, QuestionAsk, StartupHold, StepScript, ToolScript, TurnScript } from "./engine-script"
import { DEFAULT_USAGE } from "./engine-script"

/**
 * An in-memory engine behind `EngineApi`, for tests of the run engine and of
 * anything built on it. It behaves like the Omp host reached through
 * `src/server/client.ts` — the shared contract suite (`engine-contract.ts`)
 * runs against both — but nothing is spawned, nothing is timed unless a
 * script says so, and every answer is deterministic.
 *
 * What a session does is decided by its `driver`:
 *  - `driver.next(id, turn)` queues the turn that session's next prompt plays;
 *    `answer`, `callTool`, `askPermission`, `askQuestion`, `fail` and `hang` are
 *    one-turn shorthands for it;
 *  - `driver.script(turn)` is the turn every prompt plays when nothing is
 *    queued for its session (default: answer `options.answer`);
 *  - a turn that asks, or hangs, stays open until the engine answers it, or
 *    `driver.release(id)` / `engine.interrupt(id)` ends it.
 *
 * The bus carries the vocabulary the real host emits (`shared/engine.ts`
 * documents it). `driver.notice`, `driver.swarm` and `driver.lose` emit the
 * events no turn produces on its own.
 *
 * Every call the engine makes is recorded in `recorded`, successful or not,
 * with the arguments it passed.
 *
 * Known, intentional differences from the real host (`lib/omp/`). The contract
 * suite does not cover them, and none is to be closed here: a test that needs
 * one of these behaviours belongs to the host's own tests, not to this double.
 *  - No session cap: the host refuses a 33rd live session, this accepts any number.
 *  - No startup deadline: a start the host would fail with `omp-not-ready` after
 *    its deadline never fails here (`driver.holdStartup` holds one open instead).
 *  - No idle reap and no resume: the host closes a session idle for 30 minutes
 *    and re-attaches it from disk on `reuse`; here a session lives until disposed.
 *  - A prompt to a busy session is a 409 here; the host queues it as a follow-up
 *    and accepts it.
 *  - A lost session (`driver.lose`) is disposed: every read, `reuse` and `prompt`
 *    answers 404. The host keeps a `lost` record that reads from memory, resumes
 *    on `reuse` from disk, and refuses only `prompt`.
 *  - Create validation covers what the engine can send (ids, card key, model
 *    shape, permissions mode); the host's `parseCreate` also checks the
 *    directory (absolute, exists), `card.tools`, `swarm`, `reuse` and the title's type.
 *  - A given title is whitespace-collapsed only; the host also strips control
 *    characters and caps its length.
 */

/** How long after a gap every stream that attaches hears `flow.stream.reset`. */
export const DEFAULT_GAP_WINDOW_MS = 60_000

/** The token the fake's one "process" puts in front of every request id it publishes, as the host does per launched process. */
const PROCESS_EPOCH = "ep1"

export type FakeEngineOptions = {
  /** The catalog `models()` answers. Default: two text-and-image models. */
  models?: ModelInfo[]
  /** What a turn answers when nothing is scripted. Default `"done"`. */
  answer?: string
  /** `health().omp.version`. */
  version?: string
  /** The wall clock the stream-gap window is judged on. Default `Date.now`; a test moves its own. */
  clock?: () => number
  /** How long after a gap a new stream is told events were lost. Default 60 s, as on the host. */
  gapWindowMs?: number
}

export type Recorded = { method: string; sessionID?: string; args: unknown[] }

/** A request that is open: the agent is waiting for the engine's answer. */
export type OpenRequest = { kind: "permission" | "question"; sessionID: string; id: string }

export interface FakeDriver extends ContractDriver {
  /** The turn prompts play when nothing is queued for their session. */
  script(turn: TurnScript): void
  /** Queues a turn for the session's next prompt; queued turns play in order. */
  next(sessionID: string, turn: TurnScript): void
  /** The session's next prompt is answered with `text`. */
  answer(sessionID: string, text: string): void
  /** The next prompt makes `call`, then answers `then` (default "done"). */
  callTool(sessionID: string, call: ToolScript, then?: string): void
  /** The next prompt asks for permission, then answers `then` once it is granted or refused. */
  askPermission(sessionID: string, ask: Omit<PermissionAsk, "kind">, then?: string): void
  /** The next prompt asks a question, then answers `then`. */
  askQuestion(sessionID: string, ask: Omit<QuestionAsk, "kind">, then?: string): void
  /** The next prompt ends in a provider error. `status` is part of the text, as the engine classifies retries by it. */
  fail(sessionID: string, message: string, status?: number): void
  /** The next prompt starts and never finishes on its own: `release` or an interrupt ends it. */
  hang(sessionID: string): void
  /** Lets a hung turn carry on to its end. */
  release(sessionID: string): void
  /** Emits `flow.notice` now. */
  notice(sessionID: string | undefined, level: "info" | "error", message: string): void
  /** Emits `flow.swarm.status` now. */
  swarm(sessionID: string, status: SwarmStatus): void
  /** The process behind the session died: emits `flow.session.lost` and the session reads as missing from then on. */
  lose(sessionID: string, reason: string): void
  /** What the agent was told for `requestID`; `undefined` while open. */
  decision(requestID: string): Promise<Decision | undefined>
  /** The requests still waiting for an answer. */
  open(sessionID?: string): OpenRequest[]
  /** Ids of the sessions that are not disposed. */
  live(): string[]
  /** Ends every open event stream as a dropped connection does: `subscribe` rejects with `error`. */
  dropStreams(error?: Error): void
  /** Holds every create that starts from now on, before its session exists, until the returned hold is released. */
  holdStartup(): StartupHold
}

export interface FakeEngine extends EngineSurface {
  driver: FakeDriver
  /** Every engine call so far, in order. */
  readonly recorded: readonly Recorded[]
  recordedOf(method: string): Recorded[]
  /** Disposes every session and ends every stream. Idempotent. */
  close(): Promise<void>
}

const MODEL_SHAPE = /^[A-Za-z0-9][^/\s]*\/\S+$/
const TITLE_LIMIT = 80
const WAIT_SLICE_MS = 55_000
const EPOCH = 1_700_000_000_000

/** Ends the wait at once, with the abort reason, when `signal` aborts first: what a dropped request does to a pending create. */
function abandonable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort))
}

export const FAKE_MODELS: ModelInfo[] = [
  { providerID: "fake", id: "model-0", name: "Fake 0", capabilities: { input: ["text", "image"] } },
  { providerID: "fake", id: "model-1", name: "Fake 1", capabilities: { input: ["text"] } },
]

/** A failure with the HTTP status the real host would have answered, which `src/server/engine.ts` branches on. */
class FakeHttpError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** The text the engine's retry classification reads: the status stays in the message. */
function providerError(message: string, status?: number): string {
  if (/^Provider request failed/i.test(message)) return message
  return status === undefined ? `Provider request failed: ${message}` : `Provider request failed with HTTP ${status}: ${message}`
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat
}

type Run = {
  turn: TurnScript
  aborted: boolean
  /** Ends sleeps and asks when the turn is interrupted or its session disposed. */
  stop: PromiseWithResolvers<void>
  /** Ends a `hang`. */
  release: PromiseWithResolvers<void>
}

type Open = { kind: "permission" | "question"; settle(decision: Decision): void; count: number; asked: BusEvent }

type Waiter = { resolve(result: WaitResult): void }

type Session = {
  id: string
  input: CreateSession
  created: number
  updated: number
  title?: string
  state: "live" | "disposed"
  run?: Run
  /** How the latest turn ended; absent before the first. */
  outcome?: { result: "completed" | "aborted" | "error"; error?: string }
  steps: WireStep[]
  /** Oldest first; reads answer newest first. */
  calls: ToolCall[]
  turns: Turn[]
  final: Transcript
  open: Map<string, Open>
  waiters: Set<Waiter>
  queue: TurnScript[]
  messages: number
}

export function createFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const catalog = options.models ?? FAKE_MODELS
  const wall = options.clock ?? Date.now
  const gapWindow = options.gapWindowMs ?? DEFAULT_GAP_WINDOW_MS
  const sessions = new Map<string, Session>()
  /** Disposed sessions, kept as the host keeps them on disk: listed as history, readable nowhere else. */
  const history = new Map<string, Session>()
  const subscribers = new Set<{ onEvent(event: BusEvent): void; end: PromiseWithResolvers<void> }>()
  const decisions = new Map<string, Decision>()
  const recorded: Recorded[] = []
  const state: {
    clock: number
    sequence: number
    fallback: TurnScript
    closed: boolean
    /** When events last went to nobody, or a stream was dropped. */
    gapAt: number | undefined
    /** The startup `driver.holdStartup` is holding: creates wait on `open` and announce themselves on `reached`. */
    hold?: { reached: PromiseWithResolvers<void>; open: PromiseWithResolvers<void> }
  } = {
    clock: EPOCH,
    sequence: 0,
    fallback: { steps: [{ text: options.answer ?? "done" }] },
    closed: false,
    gapAt: undefined,
  }

  /** Logical time: every reading is later than the last, so ordering never depends on how fast a test runs. */
  const now = () => state.clock++

  function record(method: string, sessionID: string | undefined, ...args: unknown[]) {
    recorded.push({ method, ...(sessionID === undefined ? {} : { sessionID }), args })
  }

  function emit(type: string, data: Record<string, unknown>) {
    const sessionID = data.sessionID
    const session = typeof sessionID === "string" ? sessions.get(sessionID) : undefined
    if (session) session.updated = now()
    const event: BusEvent = { type, data }
    if (!subscribers.size) state.gapAt = wall()
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.onEvent(event)
      } catch {
        // A listener that throws must not stop the others, as one broken SSE consumer cannot stop the bus.
      }
    }
  }

  function find(id: string): Session {
    const session = sessions.get(id)
    if (!session) throw new FakeHttpError(`session not found: ${id}`, 404)
    return session
  }

  function settle(session: Session, result: WaitResult) {
    for (const waiter of [...session.waiters]) {
      session.waiters.delete(waiter)
      waiter.resolve(result)
    }
  }

  function idleResult(session: Session): WaitResult {
    const outcome = session.outcome ?? { result: "completed" as const }
    return { status: "idle", result: outcome.result, ...(outcome.error ? { error: outcome.error } : {}) }
  }

  /** Cancels the open requests, telling the agent so: what `interrupt` and a disposed session do. */
  function withdraw(session: Session) {
    for (const [id, entry] of [...session.open]) {
      session.open.delete(id)
      entry.settle({ kind: "cancelled" })
    }
  }

  function end(session: Session, how: "idle" | "gone") {
    const run = session.run
    if (!run) return
    run.aborted = true
    run.stop.resolve()
    withdraw(session)
    session.run = undefined
    if (how === "idle") {
      session.outcome = { result: "aborted" }
      settle(session, { status: "idle", result: "aborted" })
    }
  }

  function dispose(session: Session) {
    if (session.state === "disposed") return
    end(session, "gone")
    session.state = "disposed"
    session.queue = []
    settle(session, { status: "missing" })
    sessions.delete(session.id)
    if (!session.input.transient) history.set(session.id, session)
  }

  function modelOf(session: Session) {
    const text = session.input.model ?? `${catalog[0]?.providerID ?? "fake"}/${catalog[0]?.id ?? "model"}`
    const slash = text.indexOf("/")
    return { providerID: text.slice(0, slash), id: text.slice(slash + 1), text }
  }

  /** Sleeps unless the turn is stopped first. */
  async function sleep(run: Run, ms: number) {
    const timer = Promise.withResolvers<void>()
    const handle = setTimeout(timer.resolve, ms)
    await Promise.race([timer.promise, run.stop.promise])
    clearTimeout(handle)
  }

  async function ask(session: Session, run: Run, request: PermissionAsk | QuestionAsk) {
    const answered = Promise.withResolvers<void>()
    // What the host does: the id it publishes carries the launched process's token, so the agent's own counter cannot collide across restarts.
    const published = `${PROCESS_EPOCH}.${request.id}`
    const asked: BusEvent =
      request.kind === "permission"
        ? { type: "permission.v2.asked", data: { id: published, sessionID: session.id, action: request.action, resources: [request.resource] } }
        : {
            type: "question.v2.asked",
            data: {
              id: published,
              sessionID: session.id,
              questions: [{ question: request.question, header: request.header, options: request.options.map((label) => ({ label, description: "" })), multiple: false, custom: true }],
            },
          }
    session.open.set(published, {
      kind: request.kind,
      count: request.kind === "question" ? 1 : 0,
      asked,
      settle(decision) {
        decisions.set(request.id, decision)
        answered.resolve()
      },
    })
    emit(asked.type, asked.data ?? {})
    await Promise.race([answered.promise, run.stop.promise])
  }

  /** One assistant message, in the order the host emits it. Returns false when the turn was stopped part-way. */
  async function step(session: Session, run: Run, script: StepScript): Promise<boolean> {
    const messageID = `${session.id}-m${++session.messages}`
    const model = modelOf(session)
    const textID = `${messageID}:0`
    emit("session.next.step.started", { sessionID: session.id, assistantMessageID: messageID, model: { providerID: model.providerID, id: model.id }, agent: session.input.card.key })
    if (script.notice) emit("flow.notice", { sessionID: session.id, level: script.notice.level, message: script.notice.message })
    if (script.text) {
      emit("session.next.text.started", { sessionID: session.id, textID })
      emit("session.next.text.delta", { sessionID: session.id, textID, delta: script.text })
    }
    if (script.ask) await ask(session, run, script.ask)
    if (!run.aborted && script.delayMs) await sleep(run, script.delayMs)
    if (!run.aborted && script.hang) await Promise.race([run.release.promise, run.stop.promise])
    if (run.aborted) return false

    const tools = script.tools ?? []
    if (script.text) emit("session.next.text.ended", { sessionID: session.id, textID, text: script.text })
    for (const tool of tools) {
      emit("session.next.tool.input.started", { sessionID: session.id, callID: tool.id, name: tool.name })
      session.calls.push({ id: tool.id, name: tool.name, input: tool.input })
    }
    const usage = script.usage ?? DEFAULT_USAGE
    emit("session.next.step.ended", {
      sessionID: session.id,
      assistantMessageID: messageID,
      tokens: { input: usage.input, output: usage.output, reasoning: 0, cache: { read: usage.cacheRead, write: usage.cacheWrite } },
    })
    session.steps.push({ messageID, model: model.text, tokens: { input: usage.input, output: usage.output, reasoning: 0, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } })
    if (script.text) session.turns.push({ role: "assistant", text: script.text })
    session.final = { text: script.text ?? "" }
    for (const tool of tools) {
      emit("session.next.tool.called", { sessionID: session.id, callID: tool.id, tool: tool.name, input: tool.input })
      emit("session.next.tool.success", { sessionID: session.id, callID: tool.id, content: [{ type: "text", text: tool.output }] })
    }
    return true
  }

  /** The assistant message a provider error ends the turn with. */
  function failure(session: Session, error: NonNullable<TurnScript["error"]>) {
    const messageID = `${session.id}-m${++session.messages}`
    const model = modelOf(session)
    const text = providerError(error.message, error.status)
    emit("session.next.step.started", { sessionID: session.id, assistantMessageID: messageID, model: { providerID: model.providerID, id: model.id }, agent: session.input.card.key })
    emit("session.next.step.failed", { sessionID: session.id, assistantMessageID: messageID, error: text })
    emit("session.next.step.ended", { sessionID: session.id, assistantMessageID: messageID, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    session.steps.push({ messageID, model: model.text, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    session.final = { text: "", error: text }
    return text
  }

  async function play(session: Session, run: Run) {
    // The ack goes first, as the host answers a prompt before its events arrive.
    await Promise.resolve()
    for (const script of run.turn.steps) {
      if (run.aborted) return
      if (!(await step(session, run, script))) return
    }
    if (run.aborted) return
    const error = run.turn.error ? failure(session, run.turn.error) : undefined
    session.run = undefined
    session.outcome = error === undefined ? { result: "completed" } : { result: "error", error }
    settle(session, idleResult(session))
  }

  async function poll(id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const session = sessions.get(id)
    if (!session) return { status: "missing" }
    session.updated = now()
    if (!session.run) return idleResult(session)
    if (signal?.aborted) return { status: "timeout" }
    const parked = Promise.withResolvers<WaitResult>()
    const waiter: Waiter = {
      resolve(result) {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        parked.resolve(result)
      },
    }
    const timer = setTimeout(() => {
      session.waiters.delete(waiter)
      waiter.resolve({ status: "timeout" })
    }, timeoutMs)
    const onAbort = () => {
      session.waiters.delete(waiter)
      waiter.resolve({ status: "timeout" })
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    session.waiters.add(waiter)
    return parked.promise
  }

  function take(session: Session, id: string, kind: Open["kind"], what: string): Open {
    const entry = session.open.get(id)
    if (!entry || entry.kind !== kind) throw new FakeHttpError(`${what} request not found or already answered: ${id}`, 404)
    return entry
  }

  function rowOf(session: Session): SessionRow {
    return {
      id: session.id,
      title: session.title ?? session.input.card.key,
      agent: session.input.card.key,
      model: session.input.model,
      created: session.created,
      updated: session.updated,
    }
  }

  function validate(input: CreateSession) {
    if (typeof input?.runId !== "string" || !input.runId) throw new FakeHttpError("runId must be a non-empty string", 400)
    if (typeof input.nodeId !== "string" || !input.nodeId) throw new FakeHttpError("nodeId must be a non-empty string", 400)
    if (typeof input.card?.key !== "string" || !input.card.key) throw new FakeHttpError("card.key must be a non-empty string", 400)
    if (input.model !== undefined && !MODEL_SHAPE.test(input.model)) throw new FakeHttpError("model must look like provider/id", 400)
    if (input.permissions !== undefined && input.permissions !== "auto" && input.permissions !== "manual") throw new FakeHttpError('permissions must be "auto" or "manual"', 400)
    if (input.transient !== undefined && typeof input.transient !== "boolean") throw new FakeHttpError("transient must be a boolean", 400)
    if (input.transient === true && input.reuse !== undefined) throw new FakeHttpError("a transient session cannot be reused", 400)
  }

  const driver: FakeDriver = {
    script(turn) {
      state.fallback = turn
    },
    next(sessionID, turn) {
      find(sessionID).queue.push(turn)
    },
    answer(sessionID, text) {
      driver.next(sessionID, { steps: [{ text }] })
    },
    callTool(sessionID, call, then = "done") {
      driver.next(sessionID, { steps: [{ tools: [call] }, { text: then }] })
    },
    askPermission(sessionID, request, then = "done") {
      driver.next(sessionID, { steps: [{ text: then, ask: { kind: "permission", ...request } }] })
    },
    askQuestion(sessionID, request, then = "done") {
      driver.next(sessionID, { steps: [{ text: then, ask: { kind: "question", ...request } }] })
    },
    fail(sessionID, message, status) {
      driver.next(sessionID, { steps: [], error: { message, ...(status === undefined ? {} : { status }) } })
    },
    hang(sessionID) {
      driver.next(sessionID, { steps: [{ text: "", hang: true }] })
    },
    holdStartup() {
      const hold = { reached: Promise.withResolvers<void>(), open: Promise.withResolvers<void>() }
      state.hold = hold
      return {
        reached: () => hold.reached.promise,
        release() {
          if (state.hold === hold) state.hold = undefined
          hold.open.resolve()
        },
      }
    },
    release(sessionID) {
      sessions.get(sessionID)?.run?.release.resolve()
    },
    notice(sessionID, level, message) {
      emit("flow.notice", { ...(sessionID === undefined ? {} : { sessionID }), level, message })
    },
    swarm(sessionID, status) {
      emit("flow.swarm.status", { sessionID, status })
    },
    lose(sessionID, reason) {
      const session = find(sessionID)
      emit("flow.session.lost", { sessionID, reason })
      dispose(session)
    },
    async decision(requestID) {
      return decisions.get(requestID)
    },
    open(sessionID) {
      return [...sessions.values()]
        .filter((session) => sessionID === undefined || session.id === sessionID)
        .flatMap((session) => [...session.open].map(([id, entry]) => ({ kind: entry.kind, sessionID: session.id, id })))
    },
    live() {
      return [...sessions.keys()]
    },
    dropStreams(error = new Error("the event stream was dropped")) {
      state.gapAt = wall()
      for (const subscriber of [...subscribers]) {
        subscribers.delete(subscriber)
        subscriber.end.reject(error)
      }
    },
  }

  const engine: FakeEngine = {
    driver,
    recorded,
    recordedOf: (method) => recorded.filter((entry) => entry.method === method),
    accepts,
    describe,

    async close() {
      if (state.closed) return
      state.closed = true
      for (const session of [...sessions.values()]) dispose(session)
      for (const subscriber of [...subscribers]) {
        subscribers.delete(subscriber)
        subscriber.end.resolve()
      }
    },

    async subscribe(onEvent, signal) {
      record("subscribe", undefined)
      if (signal.aborted || state.closed) return
      const subscriber = { onEvent, end: Promise.withResolvers<void>() }
      subscribers.add(subscriber)
      // What the host does: every subscriber that attaches within the window after a gap (events published to nobody, or a client dropped) is told that events were lost, ahead of the replayed requests.
      if (state.gapAt !== undefined && wall() - state.gapAt < gapWindow) onEvent({ type: "flow.stream.reset" })
      for (const session of sessions.values()) for (const entry of session.open.values()) onEvent(entry.asked)
      signal.addEventListener(
        "abort",
        () => {
          subscribers.delete(subscriber)
          subscriber.end.resolve()
        },
        { once: true },
      )
      return subscriber.end.promise
    },

    async createSession(input, signal) {
      record("createSession", undefined, input)
      validate(input)
      signal?.throwIfAborted()
      if (input.reuse) return { id: find(input.reuse).id }
      const hold = state.hold
      if (hold) {
        hold.reached.resolve()
        await abandonable(hold.open.promise, signal)
      }
      // One card, one session at a time: the replaced session is gone.
      for (const other of [...sessions.values()]) {
        if (other.input.runId === input.runId && other.input.nodeId === input.nodeId) dispose(other)
      }
      const id = `fake-${++state.sequence}`
      const created = now()
      sessions.set(id, {
        id,
        input,
        created,
        updated: created,
        title: input.title?.replace(/\s+/g, " ").trim() || undefined,
        state: "live",
        steps: [],
        calls: [],
        turns: [],
        final: { text: "" },
        open: new Map(),
        waiters: new Set(),
        queue: [],
        messages: 0,
      })
      return { id }
    },

    async prompt(sessionID, text, files) {
      record("prompt", sessionID, text, files ?? [])
      const session = find(sessionID)
      if (session.run) throw new FakeHttpError(`session ${sessionID} is already running a turn`, 409)
      session.updated = now()
      session.title ??= oneLine(text) || undefined
      session.turns.push({ role: "user", text })
      const run: Run = { turn: session.queue.shift() ?? state.fallback, aborted: false, stop: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      session.run = run
      session.outcome = undefined
      void play(session, run)
      return { accepted: true }
    },

    async waitForIdle(sessionID, options = {}) {
      record("waitForIdle", sessionID, options)
      const slice = options.slice ?? WAIT_SLICE_MS
      const deadline = options.timeout === undefined ? Infinity : Date.now() + options.timeout
      while (!options.signal?.aborted) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error("timed out waiting for the session to finish")
        const result = await poll(sessionID, Math.min(slice, remaining), options.signal)
        if (result.status === "missing") throw new Error(`session not found: ${sessionID}`)
        if (result.status === "timeout") continue
        if (result.result === "error") throw new Error(result.error || "the session failed")
        if (result.result === "aborted") {
          if (options.signal?.aborted) return
          throw new Error("the session was interrupted")
        }
        return
      }
    },

    async transcript(sessionID) {
      record("transcript", sessionID)
      return { ...find(sessionID).final }
    },

    async sessionTranscript(sessionID, limit = 100) {
      record("sessionTranscript", sessionID, limit)
      const turns = find(sessionID).turns.filter((turn) => turn.text)
      return turns.slice(Math.max(0, turns.length - limit)).map((turn) => ({ ...turn }))
    },

    async sessionSteps(sessionID) {
      record("sessionSteps", sessionID)
      return find(sessionID).steps.map((entry) => ({ ...entry, tokens: { ...entry.tokens } }))
    },

    async sessionCalls(sessionID, limit = 30) {
      record("sessionCalls", sessionID, limit)
      return [...find(sessionID).calls].reverse().slice(0, limit)
    },

    async interrupt(sessionID) {
      record("interrupt", sessionID)
      const session = sessions.get(sessionID)
      if (!session) return
      session.updated = now()
      // As the host: callers parked in a wait are released as aborted.
      if (session.run) end(session, "idle")
    },

    async release(sessionID) {
      record("release", sessionID)
      const session = sessions.get(sessionID)
      if (session) dispose(session)
    },

    async releaseRun(runId) {
      record("releaseRun", undefined, runId)
      for (const session of [...sessions.values()]) {
        if (session.input.runId === runId) dispose(session)
      }
    },

    async replyPermission(sessionID, requestID, reply) {
      record("replyPermission", sessionID, requestID, reply)
      const session = find(sessionID)
      const entry = take(session, requestID, "permission", "permission")
      session.open.delete(requestID)
      entry.settle({ kind: "permission", reply })
      return { ok: true }
    },

    async replyQuestion(sessionID, requestID, answers) {
      record("replyQuestion", sessionID, requestID, answers)
      const session = find(sessionID)
      const entry = take(session, requestID, "question", "question")
      if (answers.length !== entry.count) throw new FakeHttpError(`expected ${entry.count} answers (one list per question), got ${answers.length}`, 400)
      session.open.delete(requestID)
      entry.settle({ kind: "question", answers })
      return { ok: true }
    },

    async rejectQuestion(sessionID, requestID) {
      record("rejectQuestion", sessionID, requestID)
      const session = find(sessionID)
      const entry = take(session, requestID, "question", "question")
      session.open.delete(requestID)
      entry.settle({ kind: "cancelled" })
      return { ok: true }
    },

    async models() {
      record("models", undefined)
      return catalog.map((model) => ({ ...model }))
    },

    async health() {
      record("health", undefined)
      return { ok: true, omp: { available: true, version: options.version ?? "fake" }, sessions: { live: sessions.size } }
    },

    async sessions(limit = 200) {
      record("sessions", undefined, limit)
      // A transient session is never listed, live or not: nothing of it is kept.
      const rows = [...sessions.values(), ...[...history.values()].filter((session) => !sessions.has(session.id))]
        .filter((session) => !session.input.transient)
        .map(rowOf)
      return rows.sort((a, b) => b.updated - a.updated).slice(0, limit)
    },

    async active() {
      record("active", undefined)
      return [...sessions.values()].filter((session) => session.run).map((session) => session.id)
    },
  }
  return engine
}

import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type {
  BusEvent,
  CardSpec,
  PermissionReply,
  PromptRequest,
  SessionRow,
  ToolCall,
  Transcript,
  Turn,
  WaitRequest,
  WaitResult,
  WireStep,
} from "../../shared/engine"
import type { OmpSettings } from "../../shared/omp"
import { SWARM_MODES, type SwarmHost, type SwarmMode, type SwarmTracker } from "../../shared/swarm"
import { HttpError } from "../host/respond"
import { createEventMapper, type EventMapper } from "./events"
import { createHostTools, hostToolsCommand, type HostTools } from "./host-tools"
import { asNumber, asRecord, asString, createMessageStore, providerError, type MessageStore } from "./messages"
import { requireBinary } from "./models"
import type { BuildLaunch, OmpExit, OmpProcess, SpawnOmp } from "./rpc-types"
import type { CredentialStamp } from "./stamp"
import { createUiRequests, type UiRequests } from "./ui-requests"

/**
 * One Omp process per card session, owned by the host.
 *
 * A session is `live` (a process is attached), `idle` (reaped after
 * `idleReapMs` without activity; the next prompt resumes it from its session
 * directory), or `lost` (the process died; kept only so the engine can still
 * read usage and the transcript after the failure). Deleting a session or
 * releasing its run removes the record; the session directory on disk stays,
 * which is what `CreateSession.reuse` resumes from.
 */

export type EngineHostDeps = {
  project(): string
  stateRoot(): string
  settings(): Promise<OmpSettings>
  spawn: SpawnOmp
  launch: BuildLaunch
  swarm?: SwarmHost
  env?: NodeJS.ProcessEnv
  /** The profile's credential stamp; the model catalog re-reads when it changes. */
  stamp?: CredentialStamp
  /** A live session with no frames, no prompt in flight and no HTTP activity for this long is closed (and stays resumable). Default 30 minutes. */
  idleReapMs?: number
}

export type SessionHostOptions = {
  emit(event: BusEvent): void
  /** How often the swarm trackers are polled and idle sessions reaped. Default 5 s. */
  tickMs?: number
}

export interface SessionHost {
  create(body: unknown): Promise<{ id: string }>
  prompt(id: string, request: PromptRequest): Promise<void>
  wait(id: string, request: WaitRequest, signal?: AbortSignal): Promise<WaitResult>
  /** Never fails: an unknown session or a dead process is simply nothing to interrupt. */
  interrupt(id: string): Promise<void>
  dispose(id: string): Promise<void>
  releaseRun(runId: string): Promise<number>
  replyPermission(id: string, requestID: string, reply: PermissionReply): void
  replyQuestion(id: string, requestID: string, answers: string[][]): void
  rejectQuestion(id: string, requestID: string): void
  turns(id: string, limit: number): Promise<Turn[]>
  final(id: string): Promise<Transcript>
  steps(id: string): Promise<WireStep[]>
  calls(id: string, limit: number): Promise<ToolCall[]>
  active(): string[]
  list(limit: number): Promise<SessionRow[]>
  live(): number
  /** One tick: poll swarm trackers, reap idle sessions. Runs on a timer; exposed so tests need no clock. */
  maintain(now?: number): Promise<void>
  /** Closes every process and stops the timer. */
  close(): Promise<void>
}

/** The directory omp keeps a card's session files in, under the card's state directory. The launch builder passes the same path as `--session-dir`. */
export const SESSION_SUBDIR = "session"

const META_FILE = ".openflow-session.json"
const DEFAULT_IDLE_REAP_MS = 30 * 60_000
const DEFAULT_TICK_MS = 5_000
const DEFAULT_WAIT_MS = 30 * 60_000
const ADMISSION_TIMEOUT_MS = 120_000
const OPEN_TIMEOUT_MS = 60_000
const ABORT_TIMEOUT_MS = 15_000
const FILE_INLINE_LIMIT = 200 * 1024
const TITLE_LIMIT = 80
/** Dead and idle records kept for reads after the fact. */
const KEPT_RECORDS = 64
const MODEL_SHAPE = /^[^/\s]+\/\S+$/

type CreateRequest = {
  runId: string
  nodeId: string
  card: CardSpec
  model?: string
  directory: string
  permissions: "auto" | "manual"
  swarm?: SwarmMode
  reuse?: string
}

type PromptOutcome = { status: "completed" | "aborted" | "error"; error?: string }

type Waiter = { resolve(result: WaitResult): void }

type Meta = { id: string; runId: string; nodeId: string; key: string; model?: string; title?: string; created: number; updated: number }

type Session = {
  id: string
  request: CreateRequest
  stateDir: string
  state: "live" | "idle" | "lost" | "disposed"
  /** Bumped on every spawn; frames and exits from an older process are ignored. */
  generation: number
  proc?: OmpProcess
  epoch: string
  store: MessageStore
  mapper: EventMapper
  ui: UiRequests
  hostTools: HostTools
  tracker?: SwarmTracker
  swarmMode: SwarmMode
  unsubscribe?: () => void
  /** The latest prompt of ours: its command id and, once omp reports it, its outcome. */
  last?: { id: string; result?: PromptOutcome }
  /** Every prompt command id we issued: a `prompt_result` of an earlier, superseded prompt is not the answer. */
  issued: Set<string>
  /** Nothing can wake the session: omp's `session_settled`. */
  settled: boolean
  waiters: Set<Waiter>
  lastActivity: number
  created: number
  title?: string
  /** Resumed from disk: its history has not streamed through this host. */
  resumed: boolean
  starting?: Promise<void>
  promptCount: number
}

function bad(message: string): HttpError {
  return new HttpError(400, message, "bad-request")
}

function notFound(id: string): HttpError {
  return new HttpError(404, `session not found: ${id}`, "session-not-found")
}

/** One path segment from an arbitrary id: never `..`, never a separator; a hash keeps two different ids apart once sanitised. */
export function safeSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80) || "_"
  if (clean === value) return clean
  return `${clean}-${createHash("sha1").update(value).digest("hex").slice(0, 6)}`
}

function stateDirFor(root: string, runId: string, nodeId: string): string {
  return path.join(root, safeSegment(runId), safeSegment(nodeId))
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function lastLine(text: string | undefined): string | undefined {
  return text?.trim().split("\n").filter((line) => line.trim()).at(-1)?.trim().slice(0, 300)
}

/** What a failed spawn or command says, without a stack or environment value. */
function startupMessage(error: unknown): string {
  const rpc = asRecord(asRecord(error)?.rpc)
  const detail = asString(rpc?.message) ?? lastLine(error instanceof Error ? error.message : undefined)
  return `omp failed to start${detail ? `: ${detail}` : ""}`
}

async function parseCreate(body: unknown, project: string): Promise<CreateRequest> {
  const input = asRecord(body)
  if (!input) throw bad("request body must be a JSON object")
  const runId = asString(input.runId)
  const nodeId = asString(input.nodeId)
  if (!runId) throw bad("runId must be a non-empty string")
  if (!nodeId) throw bad("nodeId must be a non-empty string")

  const card = asRecord(input.card)
  if (!card || !asString(card.key)) throw bad("card.key must be a non-empty string")
  if (card.role !== undefined && typeof card.role !== "string") throw bad("card.role must be a string")
  if (card.prompt !== undefined && typeof card.prompt !== "string") throw bad("card.prompt must be a string")
  if (card.dispatch !== undefined && typeof card.dispatch !== "boolean") throw bad("card.dispatch must be a boolean")
  if (card.mcp !== undefined && !(Array.isArray(card.mcp) && card.mcp.every((name) => typeof name === "string"))) throw bad("card.mcp must be a list of strings")
  const tools = card.tools === undefined ? undefined : asRecord(card.tools)
  if (card.tools !== undefined && (!tools || !Object.values(tools).every((value) => typeof value === "boolean"))) throw bad("card.tools must map tool names to booleans")

  const model = input.model
  if (model !== undefined && (typeof model !== "string" || !MODEL_SHAPE.test(model))) throw bad("model must look like provider/id")

  const permissions = input.permissions ?? "auto"
  if (permissions !== "auto" && permissions !== "manual") throw bad('permissions must be "auto" or "manual"')

  const swarm = input.swarm
  if (swarm !== undefined && !SWARM_MODES.includes(swarm as SwarmMode)) throw bad(`swarm must be one of ${SWARM_MODES.join(", ")}`)

  if (input.reuse !== undefined && typeof input.reuse !== "string") throw bad("reuse must be a session id")

  const directory = input.directory === undefined ? project : input.directory
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw bad("directory must be an absolute path")
  const stat = await fs.stat(directory).catch(() => undefined)
  if (!stat?.isDirectory()) throw bad(`directory does not exist: ${directory}`)

  return {
    runId,
    nodeId,
    card: { ...(card as CardSpec), key: card.key as string, role: (card.role as string | undefined) ?? "" },
    model: model as string | undefined,
    directory,
    permissions,
    swarm: swarm as SwarmMode | undefined,
    reuse: input.reuse as string | undefined,
  }
}

/** ---------------------------------------------------------------- prompts */

type PromptBody = { message: string; images: Array<{ type: "image"; data: string; mimeType: string }> }

const DATA_URL = /^data:([^,;]*)((?:;[^,;]*)*),([\s\S]*)$/

/**
 * Images ride as omp `ImageContent`; text files are inlined under an
 * `## Attached files` heading; anything else gets a one-line note, so the model
 * is never told about a file it cannot see without being told why.
 */
export function buildPrompt(request: PromptRequest): PromptBody {
  if (typeof request?.text !== "string") throw bad("text must be a string")
  if (request.files !== undefined && !Array.isArray(request.files)) throw bad("files must be a list")
  const images: PromptBody["images"] = []
  const blocks: string[] = []
  for (const file of request.files ?? []) {
    if (!file || typeof file.name !== "string" || typeof file.url !== "string") throw bad("each file needs a name and a url")
    const name = file.name.replace(/\s+/g, " ").trim() || "file"
    const match = DATA_URL.exec(file.url)
    if (!match) {
      blocks.push(`- ${name}: not inlined (not a data: URL)`)
      continue
    }
    const mime = file.mime || match[1] || "application/octet-stream"
    const bytes = match[2]?.includes(";base64") ? Buffer.from(match[3] ?? "", "base64") : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8")
    // SVG is text to a model; providers reject it as an image.
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: mime })
      continue
    }
    if (bytes.length > FILE_INLINE_LIMIT) {
      blocks.push(`- ${name} (${mime}, ${bytes.length} bytes): not inlined (larger than ${FILE_INLINE_LIMIT / 1024} KiB)`)
      continue
    }
    let text: string | undefined
    if (!bytes.includes(0)) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        text = undefined
      }
    }
    if (text === undefined) {
      blocks.push(`- ${name} (${mime}, ${bytes.length} bytes): not inlined (binary)`)
      continue
    }
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
    const fence = "`".repeat(longest + 1)
    blocks.push(`### ${name}\n${fence}\n${text}\n${fence}`)
  }
  const message = blocks.length ? `${request.text}\n\n## Attached files\n\n${blocks.join("\n\n")}` : request.text
  return { message, images }
}

/** ----------------------------------------------------------------- host */

export function createSessionHost(deps: EngineHostDeps, options: SessionHostOptions): SessionHost {
  const sessions = new Map<string, Session>()
  /** In-flight metadata writes; teardown awaits them so none lands after a directory is removed. */
  const writes = new Set<Promise<void>>()
  const idleReapMs = deps.idleReapMs ?? DEFAULT_IDLE_REAP_MS
  const env = () => deps.env ?? process.env

  function busy(session: Session): boolean {
    return session.last !== undefined && !(session.last.result && session.settled)
  }

  function outcome(session: Session): WaitResult | undefined {
    if (!session.last) return { status: "idle", result: "completed" }
    if (!session.last.result || !session.settled) return undefined
    const { status, error } = session.last.result
    return { status: "idle", result: status, ...(error ? { error } : {}) }
  }

  function settleWaiters(session: Session, forced?: WaitResult) {
    for (const waiter of [...session.waiters]) {
      const result = forced ?? outcome(session)
      if (!result) continue
      session.waiters.delete(waiter)
      waiter.resolve(result)
    }
  }

  function metaOf(session: Session): Meta {
    return {
      id: session.id,
      runId: session.request.runId,
      nodeId: session.request.nodeId,
      key: session.request.card.key,
      model: session.request.model,
      title: session.title,
      created: session.created,
      updated: Date.now(),
    }
  }

  async function writeMeta(session: Session) {
    await fs.mkdir(session.stateDir, { recursive: true })
    await fs.writeFile(path.join(session.stateDir, META_FILE), JSON.stringify(metaOf(session)), { mode: 0o600 })
  }

  /** Listing and resume metadata only: a failed write costs a fresh session on reuse, never a failed turn. */
  function saveMeta(session: Session) {
    const write: Promise<void> = writeMeta(session)
      .catch(() => undefined)
      .finally(() => writes.delete(write))
    writes.add(write)
  }

  async function readMeta(dir: string): Promise<Meta | undefined> {
    const text = await fs.readFile(path.join(dir, META_FILE), "utf8").catch(() => undefined)
    if (!text) return undefined
    try {
      const meta = asRecord(JSON.parse(text))
      const id = asString(meta?.id)
      if (!meta || !id) return undefined
      return {
        id,
        runId: asString(meta.runId) ?? "",
        nodeId: asString(meta.nodeId) ?? "",
        key: asString(meta.key) ?? "",
        model: asString(meta.model),
        title: asString(meta.title),
        created: asNumber(meta.created) ?? 0,
        updated: asNumber(meta.updated) ?? 0,
      }
    } catch {
      return undefined
    }
  }

  function emitSwarm(session: Session, status: unknown) {
    if (!status) return
    options.emit({ type: "flow.swarm.status", data: { sessionID: session.id, status } })
  }

  function onPromptResult(session: Session, frame: Record<string, unknown>) {
    const last = session.last
    const id = asString(frame.id)
    if (!last) return
    // A result of a prompt we have since followed up is not the answer being waited on.
    // An id we never issued (the core assigned its own) is taken as the latest prompt's.
    if (id && session.issued.has(id) && id !== last.id) return
    const status = asString(frame.status)
    if (status !== "completed" && status !== "aborted" && status !== "error") return
    let error: string | undefined
    if (status === "error") {
      const detail = asRecord(frame.error)
      error = providerError(asString(detail?.message) ?? "unknown error", asNumber(detail?.httpStatus) ?? session.store.latestErrorStatus())
    }
    last.result = { status, ...(error ? { error } : {}) }
    if (frame.sessionSettled === true || frame.agentInvoked === false) session.settled = true
    saveMeta(session)
  }

  function onFrame(session: Session, generation: number, frame: { type: string; [key: string]: unknown }) {
    if (session.generation !== generation || session.state === "disposed") return
    session.lastActivity = Date.now()
    if (frame.type === "agent_start") session.settled = false
    else if (frame.type === "prompt_result") onPromptResult(session, frame)
    else if (frame.type === "session_settled") session.settled = true

    session.store.observe(frame, session.epoch)
    if (!session.ui.handle(frame) && !session.hostTools.handle(frame)) for (const event of session.mapper.map(frame)) options.emit(event)
    emitSwarm(session, session.tracker?.observe(frame))
    if (frame.type === "prompt_result" || frame.type === "session_settled") settleWaiters(session)
  }

  function onExit(session: Session, generation: number, exit: OmpExit) {
    // Closed on purpose (reaped, disposed, replaced): not a loss.
    if (session.generation !== generation || session.state !== "live") return
    session.state = "lost"
    session.proc = undefined
    session.unsubscribe?.()
    session.ui.cancelAll()
    session.tracker?.dispose()
    session.tracker = undefined
    settleWaiters(session, { status: "missing" })
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`
    const tail = lastLine(exit.stderrTail)
    options.emit({ type: "flow.session.lost", data: { sessionID: session.id, reason: `omp exited (${how})${tail ? `: ${tail}` : ""}` } })
    trimRecords()
  }

  function trimRecords() {
    const kept = [...sessions.values()].filter((session) => session.state === "lost" || session.state === "idle")
    for (const session of kept.slice(0, Math.max(0, kept.length - KEPT_RECORDS))) sessions.delete(session.id)
  }

  /**
   * Spawns the process and brings it to a usable state. `resume` binds it to
   * the session already on disk and fails with 404 when there is none. Any
   * failure closes the process.
   */
  async function start(session: Session, resume: boolean) {
    const settings = await deps.settings()
    const binary = await requireBinary(settings, env())
    const request = session.request
    const mode = request.swarm ?? settings.swarm.mode
    const swarm = await deps.swarm?.launch({ settings, mode, runId: request.runId, nodeId: request.nodeId, stateDir: session.stateDir, env: env() })
    const spec = deps.launch({
      settings,
      binary,
      session: { runId: request.runId, nodeId: request.nodeId, card: request.card, model: request.model, directory: request.directory, permissions: request.permissions },
      stateDir: session.stateDir,
      ...(swarm ? { swarm } : {}),
      env: env(),
    })
    const sessionDir = path.join(session.stateDir, SESSION_SUBDIR)
    await fs.mkdir(sessionDir, { recursive: true })

    const generation = session.generation + 1
    session.generation = generation
    session.epoch = randomBytes(2).toString("hex")
    session.swarmMode = swarm?.effective ?? "off"
    const proc = deps.spawn(spec)
    const send = (frame: Record<string, unknown>) => proc.send(frame)
    session.mapper = createEventMapper({ sessionID: session.id, epoch: session.epoch, agent: request.card.key, model: request.model })
    session.ui = createUiRequests({ sessionID: session.id, send, emit: options.emit })
    session.hostTools = createHostTools({ send })
    session.tracker?.dispose()
    session.tracker = deps.swarm?.tracker({ mode: session.swarmMode, stateDir: session.stateDir })
    session.unsubscribe = proc.onFrame((frame) => onFrame(session, generation, frame))
    try {
      await proc.ready
      if (resume) {
        const opened = asRecord(await proc.command({ type: "open_session", sessionDir }, { timeoutMs: OPEN_TIMEOUT_MS }))
        if (!opened || opened.cancelled === true || opened.resumed !== true) throw notFound(session.id)
      }
      await proc.command({ type: "set_ask_dialog", enabled: true })
      await proc.command({ type: "set_event_filter", events: null, messageUpdates: "delta" })
      if (session.swarmMode !== "off") await proc.command({ type: "set_subagent_subscription", level: "progress" })
      if (request.card.dispatch) await proc.command(hostToolsCommand())
    } catch (error) {
      session.unsubscribe?.()
      session.tracker?.dispose()
      session.tracker = undefined
      await proc.close().catch(() => undefined)
      throw error instanceof HttpError ? error : new HttpError(502, startupMessage(error), "omp-start-failed")
    }
    session.proc = proc
    session.state = "live"
    session.resumed = resume
    session.last = undefined
    session.issued.clear()
    session.settled = true
    session.lastActivity = Date.now()
    void proc.exited.then((exit) => onExit(session, generation, exit))
    if (swarm && mode !== "off" && swarm.effective === "off" && swarm.preflight.problems.length)
      options.emit({
        type: "flow.notice",
        data: {
          sessionID: session.id,
          level: "info",
          message: `swarm is off for this card: ${swarm.preflight.problems.map((problem) => (problem.fix ? `${problem.message} ${problem.fix}` : problem.message)).join(" ")}`,
        },
      })
  }

  function makeSession(id: string, request: CreateRequest, stateDir: string): Session {
    return {
      id,
      request,
      stateDir,
      state: "idle",
      generation: 0,
      epoch: "",
      store: createMessageStore(),
      mapper: createEventMapper({ sessionID: id, epoch: "", agent: request.card.key }),
      ui: createUiRequests({ sessionID: id, send: () => undefined, emit: options.emit }),
      hostTools: createHostTools({ send: () => undefined }),
      swarmMode: "off",
      issued: new Set(),
      settled: true,
      waiters: new Set(),
      lastActivity: Date.now(),
      created: Date.now(),
      resumed: false,
      promptCount: 0,
    }
  }

  /** Detaches and gracefully stops the process; resolves once it is gone. Called once per process: the handle is cleared first. */
  async function stop(session: Session, state: Session["state"]) {
    const proc = session.proc
    session.state = state
    session.proc = undefined
    session.unsubscribe?.()
    session.unsubscribe = undefined
    session.ui.cancelAll()
    session.tracker?.dispose()
    session.tracker = undefined
    settleWaiters(session, { status: "missing" })
    await proc?.close().catch(() => undefined)
    await Promise.all(writes)
  }

  /** Respawns an idle (reaped) session; one flight at a time. */
  function resume(session: Session): Promise<void> {
    session.starting ??= start(session, true).finally(() => {
      session.starting = undefined
    })
    return session.starting
  }

  function find(id: string): Session {
    const session = sessions.get(id)
    if (!session || session.state === "disposed") throw notFound(id)
    return session
  }

  /** The process, resuming a reaped session on the way. */
  async function attach(id: string): Promise<{ session: Session; proc: OmpProcess }> {
    const session = find(id)
    if (session.state === "idle") await resume(session).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) sessions.delete(id)
      throw error
    })
    if (session.starting) await session.starting
    if (!session.proc) throw notFound(id)
    session.lastActivity = Date.now()
    return { session, proc: session.proc }
  }

  async function withHistory(session: Session) {
    if (!session.resumed || !session.proc || busy(session)) return
    await session.store.loadHistory(session.proc).catch(() => false)
  }

  async function reuse(request: CreateRequest, stateDir: string): Promise<{ id: string }> {
    const id = request.reuse as string
    const existing = sessions.get(id)
    if (existing && existing.state === "live") return { id }
    if (existing && (existing.state === "idle" || existing.state === "lost")) {
      await resume(existing).catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 404) sessions.delete(id)
        throw error
      })
      return { id }
    }
    const meta = await readMeta(stateDir)
    if (!meta || meta.id !== id) throw notFound(id)
    const session = makeSession(id, request, stateDir)
    session.created = meta.created || session.created
    session.title = meta.title
    await start(session, true)
    sessions.set(id, session)
    return { id }
  }

  const timer = setInterval(() => void maintain(), options.tickMs ?? DEFAULT_TICK_MS)
  timer.unref?.()

  async function maintain(now = Date.now()) {
    const live = [...sessions.values()].filter((session) => session.state === "live")
    await Promise.all(
      live.map(async (session) => {
        const status = await session.tracker?.poll?.().catch(() => undefined)
        emitSwarm(session, status)
        if (session.state !== "live" || busy(session) || session.ui.pending() > 0) return
        if (now - session.lastActivity < idleReapMs) return
        await stop(session, "idle")
        trimRecords()
      }),
    )
  }

  function ofRow(session: Session): SessionRow {
    return {
      id: session.id,
      title: session.title ?? (oneLine(session.store.firstUserText() ?? "", TITLE_LIMIT) || session.request.card.key),
      agent: session.request.card.key,
      model: session.request.model,
      created: session.created,
      updated: session.lastActivity,
    }
  }

  async function persisted(): Promise<Meta[]> {
    const root = deps.stateRoot()
    const found: Meta[] = []
    const runs = await fs.readdir(root).catch(() => [] as string[])
    for (const run of runs) {
      const nodes = await fs.readdir(path.join(root, run)).catch(() => [] as string[])
      for (const node of nodes) {
        const meta = await readMeta(path.join(root, run, node))
        if (meta) found.push(meta)
      }
    }
    return found
  }

  return {
    async create(body) {
      const request = await parseCreate(body, deps.project())
      const stateDir = stateDirFor(deps.stateRoot(), request.runId, request.nodeId)
      if (request.reuse) return reuse(request, stateDir)
      // One card, one session at a time: a replaced critic session must not still hold the session directory.
      for (const other of [...sessions.values()]) {
        if (other.request.runId !== request.runId || other.request.nodeId !== request.nodeId) continue
        sessions.delete(other.id)
        await stop(other, "disposed")
      }
      const session = makeSession(`s_${randomBytes(6).toString("hex")}`, request, stateDir)
      await fs.mkdir(stateDir, { recursive: true })
      await start(session, false)
      sessions.set(session.id, session)
      await writeMeta(session).catch(() => undefined)
      return { id: session.id }
    },

    async prompt(id, request) {
      const body = buildPrompt(request)
      const { session, proc } = await attach(id)
      const previous = { last: session.last, settled: session.settled }
      const followUp = busy(session)
      const commandId = `p_${session.epoch}_${++session.promptCount}`
      session.issued.add(commandId)
      session.last = { id: commandId }
      session.settled = false
      if (!session.title) {
        session.title = oneLine(request.text, TITLE_LIMIT) || undefined
        if (session.title) saveMeta(session)
      }
      try {
        const data = asRecord(
          await proc.command(
            { type: "prompt", id: commandId, message: body.message, ...(body.images.length ? { images: body.images } : {}), ...(followUp ? { streamingBehavior: "followUp" } : {}) },
            { timeoutMs: ADMISSION_TIMEOUT_MS },
          ),
        )
        // A local slash command: no agent turn, no `prompt_result` will follow.
        if (data?.agentInvoked === false && session.last?.id === commandId) {
          session.last.result ??= { status: "completed" }
          session.settled = true
          settleWaiters(session)
        }
      } catch (error) {
        if (session.last?.id === commandId && !session.last.result) {
          session.last = previous.last
          session.settled = previous.settled
        }
        if (session.state !== "live") throw notFound(id)
        throw new HttpError(502, asString(asRecord(asRecord(error)?.rpc)?.message) ?? (error instanceof Error ? error.message : "prompt was refused"), "prompt-failed")
      }
    },

    wait(id, request, signal) {
      const session = sessions.get(id)
      if (!session || session.state === "disposed" || session.state === "lost") return Promise.resolve({ status: "missing" })
      session.lastActivity = Date.now()
      const ready = outcome(session)
      if (ready) return Promise.resolve(ready)
      const timeoutMs = typeof request?.timeoutMs === "number" && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_WAIT_MS
      const { promise, resolve } = Promise.withResolvers<WaitResult>()
      const waiter: Waiter = {
        resolve(result) {
          clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
          resolve(result)
        },
      }
      const finish = () => {
        session.waiters.delete(waiter)
        waiter.resolve({ status: "timeout" })
      }
      const timer = setTimeout(finish, timeoutMs)
      const onAbort = () => finish()
      signal?.addEventListener("abort", onAbort, { once: true })
      session.waiters.add(waiter)
      return promise
    },

    async interrupt(id) {
      const session = sessions.get(id)
      if (!session?.proc) return
      session.lastActivity = Date.now()
      session.ui.cancelAll()
      await session.proc.command({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS }).catch(() => undefined)
      // The prompt's own `prompt_result` (aborted) still arrives and fills in `last`; callers parked in `wait` are released now.
      settleWaiters(session, { status: "idle", result: "aborted" })
    },

    async dispose(id) {
      const session = sessions.get(id)
      if (!session) return
      sessions.delete(id)
      await stop(session, "disposed")
    },

    async releaseRun(runId) {
      const doomed = [...sessions.values()].filter((session) => session.request.runId === runId)
      for (const session of doomed) sessions.delete(session.id)
      await Promise.all(doomed.map((session) => stop(session, "disposed")))
      return doomed.length
    },

    replyPermission(id, requestID, reply) {
      find(id).ui.replyPermission(requestID, reply)
    },
    replyQuestion(id, requestID, answers) {
      find(id).ui.replyQuestion(requestID, answers)
    },
    rejectQuestion(id, requestID) {
      find(id).ui.rejectQuestion(requestID)
    },

    async turns(id, limit) {
      const session = find(id)
      await withHistory(session)
      return session.store.turns(limit)
    },

    async final(id) {
      const session = find(id)
      await withHistory(session)
      const transcript = session.store.transcript()
      const failure = session.last?.result?.status === "error" ? session.last.result.error : undefined
      return transcript.error || !failure ? transcript : { ...transcript, error: failure }
    },

    async steps(id) {
      const session = find(id)
      await withHistory(session)
      return session.store.steps()
    },

    async calls(id, limit) {
      const session = find(id)
      await withHistory(session)
      return session.store.calls(limit)
    },

    active() {
      return [...sessions.values()].filter((session) => session.state === "live" && busy(session)).map((session) => session.id)
    },

    async list(limit) {
      const rows = [...sessions.values()].filter((session) => session.state !== "disposed").map(ofRow)
      const known = new Set(rows.map((row) => row.id))
      for (const meta of await persisted()) {
        if (known.has(meta.id)) continue
        rows.push({ id: meta.id, title: meta.title ?? meta.key, agent: meta.key, model: meta.model, created: meta.created, updated: meta.updated })
      }
      return rows.sort((a, b) => b.updated - a.updated).slice(0, limit)
    },

    live() {
      return [...sessions.values()].filter((session) => session.state === "live").length
    },

    maintain,

    async close() {
      clearInterval(timer)
      const all = [...sessions.values()]
      sessions.clear()
      await Promise.all(all.map((session) => stop(session, "disposed")))
    },
  }
}

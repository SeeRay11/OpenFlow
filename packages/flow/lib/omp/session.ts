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
import type { Lifecycle } from "../host/lifecycle"
import { HttpError } from "../host/respond"
import { capText, stripControl } from "../substrate/guard"
import { createEventMapper, type EventMapper } from "./events"
import { createHostTools, hostToolsCommand, type HostTools } from "./host-tools"
import { describeLaunch } from "./launch"
import { asNumber, asRecord, asString, createMessageStore, NOTICE_LIMIT, providerError, type MessageStore } from "./messages"
import { requireBinary } from "./models"
import { READY_TIMEOUT_MS, withDeadline } from "./ready"
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
  /** Most omp processes running (or starting) at once. A create beyond it closes the least recently used idle session to make room; when every one is busy it is a 409 `too-many-sessions`. Default 32. */
  maxLive?: number
  /** How long a new omp may take to become ready (and to open a saved session) before it is killed. Default 60 s. */
  readyTimeoutMs?: number
  /** The startup prune of old run state; `delayMs` after the host is created. */
  prune?: {
    /** Default 15 s. */
    delayMs?: number
    /** Default `STATE_RETENTION_DAYS`. */
    maxAgeMs?: number
    now?: () => number
  }
  /** Persisted sessions are searched among the newest run directories and, of those, the newest card directories, up to these bounds. Default 2000 runs, 4000 cards. */
  scan?: { runs?: number; nodes?: number }
  /** The clock the run-directory touch is throttled by. Default `Date.now`. */
  now?: () => number
}

export type SessionHostOptions = {
  emit(event: BusEvent): void
  /** How often the swarm trackers are polled and idle sessions reaped. Default 5 s. */
  tickMs?: number
  /** The lifecycle the `--version` probe of a start runs in (see `checkOmp`); the owner disposes it. */
  life?: Lifecycle
}

export interface SessionHost {
  /** `signal` is the request's: aborted before the session is live, the start is torn down (process closed, record dropped) and the call rejects. */
  create(body: unknown, signal?: AbortSignal): Promise<{ id: string }>
  prompt(id: string, request: PromptRequest): Promise<void>
  wait(id: string, request: WaitRequest, signal?: AbortSignal): Promise<WaitResult>
  /** Never fails: an unknown session or a dead process is simply nothing to interrupt. */
  interrupt(id: string): Promise<void>
  dispose(id: string): Promise<void>
  releaseRun(runId: string): Promise<number>
  /** True while the host holds a session (live, idle or lost) or a start for this run directory name (`safeSegment(runId)`): its state must not be pruned. */
  holds(runDir: string): boolean
  /** Takes a run directory for its removal by the prune: undefined when `holds` says it is in use, else a release. A create for the run waits until released. */
  claim(runDir: string): (() => void) | undefined
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
  /** True while work is bound to the project it started in: a create in flight (from its first line), or any session starting or live, idle ones included. Reaped, lost and disposed sessions do not count. */
  working(): boolean
  /** Ids of every engine session behind `working()`: starting, or live (running, idle between turns, or waiting on a dialog); empty when only a create in flight holds it. */
  holders(): string[]
  /** The `permission.v2.asked` and `question.v2.asked` events of every dialog still waiting for an answer, as first raised: replayed to an event stream that attaches later. */
  pending(): BusEvent[]
  /** One tick: poll swarm trackers, reap idle sessions. Runs on a timer; exposed so tests need no clock. */
  maintain(now?: number): Promise<void>
  /** Closes every process and stops the timer. */
  close(): Promise<void>
}

/** The directory omp keeps a card's session files in, under the card's state directory. The launch builder passes the same path as `--session-dir`. */
export const SESSION_SUBDIR = "session"

const META_FILE = ".openflow-session.json"
/** The conversation as the Sessions panel shows it, next to the metadata: what a finished session answers `turns` from once its process is gone. */
const TURNS_FILE = ".openflow-turns.json"
/** The newest turns a session keeps on disk, each clipped, so the file stays small however long the conversation ran. */
const SAVED_TURNS = 200
const SAVED_TURN_TEXT = 32 * 1024
/** A turns file larger than this is not read: it was not written by this host. */
const TURNS_FILE_LIMIT = 16 * 1024 * 1024
/** Run and node directories looked at when a persisted session is searched by id or listed. */
const SCAN_RUNS = 2_000
const SCAN_NODES = 4_000
/** Directories statted at once when the newest are picked. */
const SCAN_STAT_BATCH = 64
const DEFAULT_IDLE_REAP_MS = 30 * 60_000
const DEFAULT_TICK_MS = 5_000
const DEFAULT_WAIT_MS = 30 * 60_000
const ADMISSION_TIMEOUT_MS = 120_000
const DEFAULT_MAX_LIVE = 32
const ABORT_TIMEOUT_MS = 15_000
const FILE_INLINE_LIMIT = 200 * 1024
const TITLE_LIMIT = 80
/** The longest title a caller may name for its own session. */
const GIVEN_TITLE_LIMIT = 120
/** Dead and idle records kept for reads after the fact. */
const KEPT_RECORDS = 64
/** Ids remembered as disposed on purpose; the oldest are forgotten past this. */
const KEPT_RETIRED = 4096
/** A run directory is touched at most this often. */
const TOUCH_INTERVAL_MS = 1000
/** Run directories whose last touch is remembered. */
const KEPT_TOUCHES = 1024
/** `provider/id`, the provider starting with a letter or digit so the value can never be read as a flag. */
const MODEL_SHAPE = /^[A-Za-z0-9][^/\s]*\/\S+$/

type CreateRequest = {
  runId: string
  nodeId: string
  card: CardSpec
  model?: string
  directory: string
  permissions: "auto" | "manual"
  swarm?: SwarmMode
  reuse?: string
  /** A throwaway session (the model test): nothing of it is kept; no metadata or turns file, never listed, not resumable, its state directory removed when it ends. */
  transient?: boolean
  /** Cleaned and clipped; absent keeps the first-prompt fallback. */
  title?: string
}

type PromptOutcome = { status: "completed" | "aborted" | "error"; error?: string }

type Waiter = { resolve(result: WaitResult): void }

type Meta = {
  id: string
  runId: string
  nodeId: string
  key: string
  model?: string
  title?: string
  created: number
  updated: number
  /** The create request the session was last started with, so a session that is only on disk resumes as it was launched. Absent in files written before this existed. */
  request?: Record<string, unknown>
}

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
  /** The process of a start still in flight, so teardown can stop it before it is attached. */
  spawning?: OmpProcess
  promptCount: number
  /** Directory ids the session's files were first written under: an adopted session keeps them in its metadata when it works for a newer run. */
  home: { runId: string; nodeId: string }
  /** A process has been attached at least once (or the session came from disk): there is a conversation worth saving. */
  opened: boolean
  /** The turns on disk when a session was adopted: they precede what streams through this host until the store has paged the whole history in. */
  base?: Turn[]
  /** Start-up notices held until the browser knows this session's id (its first accepted prompt). */
  held: BusEvent[]
  /** The latest metadata write: writes of one session are chained so an older snapshot never lands after a newer one. */
  saving?: Promise<void>
  /** The directory a resumed session did its earlier work in, from its saved request, until its resume reads it. */
  previousDirectory?: string
  /** An earlier working directory that still exists and differs from the new one: the next start says so once. */
  carried?: string
  /** This host created the state directory for a transient session: it is removed when the session ends. */
  scratch?: boolean
  /** This host also created the run directory above a transient session's state directory. */
  scratchRun?: boolean
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

/** A title out of free text: control characters out, one line, clipped. The one a caller names and the one taken from the first prompt are cleaned alike. */
function cleanTitle(text: string, limit: number): string {
  return capText(stripControl(text).replace(/\s+/g, " ").trim(), limit).text
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
  const tools = card.tools === undefined ? undefined : asRecord(card.tools)
  if (card.tools !== undefined && (!tools || !Object.values(tools).every((value) => typeof value === "boolean"))) throw bad("card.tools must map tool names to booleans")

  const model = input.model
  if (model !== undefined && (typeof model !== "string" || !MODEL_SHAPE.test(model))) throw bad("model must look like provider/id")

  const permissions = input.permissions ?? "auto"
  if (permissions !== "auto" && permissions !== "manual") throw bad('permissions must be "auto" or "manual"')

  const swarm = input.swarm
  if (swarm !== undefined && !SWARM_MODES.includes(swarm as SwarmMode)) throw bad(`swarm must be one of ${SWARM_MODES.join(", ")}`)

  if (input.reuse !== undefined && typeof input.reuse !== "string") throw bad("reuse must be a session id")
  if (input.title !== undefined && typeof input.title !== "string") throw bad("title must be a string")
  const title = cleanTitle(input.title ?? "", GIVEN_TITLE_LIMIT)

  if (input.transient !== undefined && typeof input.transient !== "boolean") throw bad("transient must be a boolean")
  if (input.transient === true && input.reuse !== undefined) throw bad("a transient session cannot be reused")

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
    ...(input.transient === true ? { transient: true } : {}),
    ...(title ? { title } : {}),
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
  /** The tail of the writes to each file: writes to one file run one after another. */
  const fileWrites = new Map<string, Promise<void>>()
  /** When each run directory was last touched, so a streaming session does not touch it on every save. */
  const touched = new Map<string, number>()
  /** Ids disposed on purpose (DELETE, release, replaced): a prompt for one is a 404, not a resume from the files left behind. */
  const retired = new Set<string>()
  /** Run directories with a create in flight, counted: the directory exists before the session is registered. */
  const claims = new Map<string, number>()
  /** Run directories the prune is removing: a create for one waits for its removal to end. */
  const prunes = new Map<string, PromiseWithResolvers<void>>()
  const idleReapMs = deps.idleReapMs ?? DEFAULT_IDLE_REAP_MS
  const maxLive = deps.maxLive ?? DEFAULT_MAX_LIVE
  const env = () => deps.env ?? process.env
  /** Set by `close()`: from then on nothing starts, whichever await a create or a resume is parked in. */
  let closing = false
  /** Creates in flight, counted from their first line (before the request is parsed), so `working()` covers a create for its whole life. */
  let creating = 0

  function busy(session: Session): boolean {
    return session.last !== undefined && !(session.last.result && session.settled)
  }

  function outcome(session: Session): WaitResult | undefined {
    if (!session.last) return { status: "idle", result: "completed" }
    if (!session.last.result || !session.settled) return undefined
    const result = session.last.result
    return { status: "idle", result: result.status, ...(result.error ? { error: result.error } : {}) }
  }

  function settleWaiters(session: Session, forced?: WaitResult) {
    for (const waiter of [...session.waiters]) {
      const result = forced ?? outcome(session)
      if (!result) continue
      session.waiters.delete(waiter)
      waiter.resolve(result)
    }
  }

  /** The conversation: an adopted session's earlier turns (until the store paged the whole history in), then what streamed through this host. */
  function currentTurns(session: Session, max: number): Turn[] {
    const live = session.store.turns(max)
    return session.base && !session.store.loaded() ? [...session.base, ...live].slice(-max) : live
  }

  /** The conversation as it is kept on disk: the newest turns, each clipped. */
  function savedTurns(session: Session): Turn[] {
    return currentTurns(session, SAVED_TURNS).map((turn) => ({ role: turn.role, text: capText(turn.text, SAVED_TURN_TEXT).text }))
  }

  /** Writes `text` beside `file` and renames it into place: a reader (or a crash) never leaves half a file. Writes to one file are serialised, so an older snapshot never lands after a newer one. */
  function writeAtomic(file: string, text: string): Promise<void> {
    const write = (fileWrites.get(file) ?? Promise.resolve()).then(async () => {
      const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`
      try {
        await fs.writeFile(temp, text, { mode: 0o600 })
        await fs.rename(temp, file)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    })
    const tail = write.catch(() => undefined)
    fileWrites.set(file, tail)
    void tail.then(() => {
      if (fileWrites.get(file) === tail) fileWrites.delete(file)
    })
    return write
  }

  async function writeMeta(session: Session) {
    if (session.request.transient) return
    await fs.mkdir(session.stateDir, { recursive: true, mode: 0o700 })
    // The turns first: a listed session always has the history it is opened with.
    await writeAtomic(path.join(session.stateDir, TURNS_FILE), JSON.stringify(savedTurns(session)))
    const meta: Meta = {
      id: session.id,
      runId: session.home.runId,
      nodeId: session.home.nodeId,
      key: session.request.card.key,
      model: session.request.model,
      title: session.title,
      created: session.created,
      updated: Date.now(),
      request: { ...session.request, reuse: undefined },
    }
    await writeAtomic(path.join(session.stateDir, META_FILE), JSON.stringify(meta))
    await touchRun(session.stateDir)
  }

  /**
   * Moves the owning run directory's modification time to now, at most once a second per directory: the newest-first scan ranks run directories by it, so a session in
   * an old run that is in use again must not look old. Best effort: a directory that is gone or not ours to touch is ignored.
   */
  function touchRun(stateDir: string): Promise<void> {
    const runDir = path.dirname(stateDir)
    const at = (deps.now ?? Date.now)()
    const last = touched.get(runDir)
    if (last !== undefined && at - last < TOUCH_INTERVAL_MS) return Promise.resolve()
    touched.delete(runDir)
    touched.set(runDir, at)
    if (touched.size > KEPT_TOUCHES) touched.delete(touched.keys().next().value as string)
    const when = new Date()
    return fs.utimes(runDir, when, when).catch(() => undefined)
  }

  /** Listing, resume and history metadata only: a failed write costs a fresh session on reuse, never a failed turn. */
  function saveMeta(session: Session) {
    const write: Promise<void> = (session.saving ?? Promise.resolve())
      .then(() => writeMeta(session))
      .catch(() => undefined)
      .finally(() => {
        writes.delete(write)
        if (session.saving === write) session.saving = undefined
      })
    session.saving = write
    writes.add(write)
  }

  /** The turns file of a session directory: undefined when it is missing, too large or not what this host writes. */
  async function readTurns(dir: string): Promise<Turn[] | undefined> {
    const file = path.join(dir, TURNS_FILE)
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.size > TURNS_FILE_LIMIT) return undefined
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) return undefined
    try {
      const raw: unknown = JSON.parse(text)
      if (!Array.isArray(raw)) return undefined
      const turns: Turn[] = []
      for (const entry of raw) {
        const turn = asRecord(entry)
        const body = asString(turn?.text)
        if ((turn?.role === "user" || turn?.role === "assistant") && body !== undefined) turns.push({ role: turn.role, text: body })
      }
      return turns
    } catch {
      return undefined
    }
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
        request: asRecord(meta.request),
      }
    } catch {
      return undefined
    }
  }

  function emitSwarm(session: Session, status: unknown) {
    if (!status) return
    options.emit({ type: "flow.swarm.status", data: { sessionID: session.id, status } })
  }

  /** Detaches the tracker and tells the browser how the swarm ended; the status goes out once, before the session's own end notice. */
  function endSwarm(session: Session) {
    const tracker = session.tracker
    session.tracker = undefined
    emitSwarm(session, tracker?.dispose())
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
    if (frame.type === "prompt_result") onPromptResult(session, frame)
    if (frame.type === "session_settled") session.settled = true

    session.store.observe(frame, session.epoch)
    if (!session.ui.handle(frame) && !session.hostTools.handle(frame)) for (const event of session.mapper.map(frame)) options.emit(event)
    emitSwarm(session, session.tracker?.observe(frame))
    if (frame.type === "prompt_result" || frame.type === "session_settled") settleWaiters(session)
  }

  function onExit(session: Session, generation: number, exit: OmpExit) {
    // Closed on purpose (reaped, disposed, replaced): not a loss.
    if (session.generation !== generation || session.state !== "live") return
    session.state = "lost"
    saveMeta(session)
    session.proc = undefined
    session.unsubscribe?.()
    session.ui.cancelAll()
    endSwarm(session)
    settleWaiters(session, { status: "missing" })
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`
    const tail = lastLine(exit.stderrTail)
    options.emit({ type: "flow.session.lost", data: { sessionID: session.id, reason: `omp exited (${how})${tail ? `: ${tail}` : ""}` } })
    // Nothing of a transient session is kept: a lost one has nothing to resume.
    if (session.request.transient) {
      sessions.delete(session.id)
      void stop(session, "disposed")
    }
    trimRecords()
  }

  /** Dead and idle records beyond the limit go, least recently active first. A record with a dialog waiting or a turn in flight is a card still using it: it stays. */
  function trimRecords() {
    const kept = [...sessions.values()].filter((session) => (session.state === "lost" || session.state === "idle") && !session.starting && !busy(session) && session.ui.pending() === 0)
    kept.sort((a, b) => a.lastActivity - b.lastActivity)
    for (const session of kept.slice(0, Math.max(0, kept.length - KEPT_RECORDS))) sessions.delete(session.id)
  }

  function closed(session: Session): HttpError {
    return new HttpError(409, `session ${session.id} was closed while it was starting`, "session-closed")
  }

  /**
   * Every spawn passes here, synchronously, before it starts: processes still starting count, so a burst cannot overshoot the limit.
   * At the limit the least recently used evictable session is closed (it keeps its files and resumes on its next prompt, like a reaped one); the
   * state change is immediate, so a second spawn passing here does not pick it again, and the returned promise settles once its process is gone.
   * With every session busy, starting or waiting on a dialog the create is refused. The status is 409, not 429: the engine retries a failure whose
   * text says 429 as a provider rate limit, and a full host does not clear by waiting.
   */
  function admit(session: Session): Promise<void> | undefined {
    const running = [...sessions.values()].filter((other) => other !== session && (other.state === "live" || other.starting !== undefined))
    if (running.length < maxLive) return undefined
    const idle = running.filter((other) => other.state === "live" && other.starting === undefined && !busy(other) && other.ui.pending() === 0)
    const victim = idle.reduce<Session | undefined>((oldest, other) => (!oldest || other.lastActivity < oldest.lastActivity ? other : oldest), undefined)
    if (!victim) throw new HttpError(409, `all ${running.length} omp sessions are busy (the limit is ${maxLive}); wait for a card to finish or stop a run, then try again.`, "too-many-sessions")
    return stop(victim, "idle").then(trimRecords)
  }

  /**
   * Spawns the process and brings it to a usable state. `resume` binds it to
   * the session already on disk and fails with 404 when there is none. Any
   * failure closes the process.
   */
  async function start(session: Session, resume: boolean) {
    const evicting = admit(session)
    const generation = session.generation + 1
    session.generation = generation
    /** Disposed, released or closed since this start began: whatever it has built is to be torn down, never attached. */
    const cancelled = () => session.generation !== generation || session.state === "disposed"
    /** Every await of the start goes through here, so none can attach a process to a session that is gone. */
    const step = async <T>(work: Promise<T>): Promise<T> => {
      const value = await work
      if (cancelled()) throw closed(session)
      return value
    }
    const readyMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS

    await step(Promise.resolve(evicting))
    const settings = await step(deps.settings())
    const binary = await step(requireBinary(settings, env(), options.life))
    const request = session.request
    const mode = request.swarm ?? settings.swarm.mode
    const swarm = await step(Promise.resolve(deps.swarm?.launch({ settings, mode, runId: request.runId, nodeId: request.nodeId, stateDir: session.stateDir, env: env() })))
    const input = {
      settings,
      binary,
      session: { runId: request.runId, nodeId: request.nodeId, card: request.card, model: request.model, directory: request.directory, permissions: request.permissions },
      stateDir: session.stateDir,
      ...(swarm ? { swarm } : {}),
      env: env(),
    }
    const spec = deps.launch(input)
    const sessionDir = path.join(session.stateDir, SESSION_SUBDIR)
    await step(fs.mkdir(sessionDir, { recursive: true, mode: 0o700 }))

    session.epoch = randomBytes(2).toString("hex")
    session.swarmMode = swarm?.effective ?? "off"
    const proc = deps.spawn(spec)
    session.spawning = proc
    const send = (frame: Record<string, unknown>) => proc.send(frame)
    session.mapper = createEventMapper({ sessionID: session.id, epoch: session.epoch, agent: request.card.key, model: request.model })
    session.ui = createUiRequests({ sessionID: session.id, send, emit: options.emit })
    session.hostTools = createHostTools({ send })
    endSwarm(session)
    session.tracker = deps.swarm?.tracker({ mode: session.swarmMode, stateDir: session.stateDir })
    const unsubscribe = proc.onFrame((frame) => onFrame(session, generation, frame))
    session.unsubscribe = unsubscribe
    try {
      await step(withDeadline(proc, proc.ready, readyMs))
      if (resume) {
        const opened = asRecord(await step(withDeadline(proc, proc.command({ type: "open_session", sessionDir }, { timeoutMs: 0 }), readyMs)))
        if (!opened || opened.cancelled === true || opened.resumed !== true) throw notFound(session.id)
      }
      await step(proc.command({ type: "set_ask_dialog", enabled: true }))
      await step(proc.command({ type: "set_event_filter", events: null, messageUpdates: "delta" }))
      if (session.swarmMode !== "off") await step(proc.command({ type: "set_subagent_subscription", level: "progress" }))
      if (request.card.dispatch) await step(proc.command(hostToolsCommand()))
    } catch (error) {
      unsubscribe()
      endSwarm(session)
      if (session.spawning === proc) session.spawning = undefined
      await proc.close().catch(() => undefined)
      if (cancelled()) throw closed(session)
      throw error instanceof HttpError ? error : new HttpError(502, startupMessage(error), "omp-start-failed")
    }
    session.spawning = undefined
    session.proc = proc
    session.state = "live"
    session.opened = true
    session.resumed = resume
    session.last = undefined
    session.issued.clear()
    session.settled = true
    session.lastActivity = Date.now()
    void proc.exited.then((exit) => onExit(session, generation, exit))
    // The browser learns the session id from the create response, after this returns, and drops a notice for an id it does not know: the
    // notices wait for the first accepted prompt. A resumed start has said the card's notes already; they are about the card, not the process.
    const notices = resume ? [] : describeLaunch(input).notes.map((note) => capText(stripControl(note), NOTICE_LIMIT).text)
    if (resume && session.carried) {
      notices.push(`This card resumed after an interruption. Work it did before then, in ${session.carried}, was not merged into this run.`)
      session.carried = undefined
    }
    if (swarm && mode !== "off" && swarm.effective === "off" && swarm.preflight.problems.length)
      notices.push(`swarm is off for this card: ${swarm.preflight.problems.map((problem) => (problem.fix ? `${problem.message} ${problem.fix}` : problem.message)).join(" ")}`)
    for (const message of notices)
      if (!session.held.some((held) => held.data?.message === message))
        session.held.push({ type: "flow.notice", data: { sessionID: session.id, level: "info", message } })
  }

  function makeSession(id: string, request: CreateRequest, stateDir: string): Session {
    return {
      id,
      request,
      stateDir,
      title: request.title,
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
      home: { runId: request.runId, nodeId: request.nodeId },
      opened: false,
      held: [],
    }
  }

  /** Detaches and gracefully stops the process; resolves once it is gone. Called once per process: the handle is cleared first. */
  async function stop(session: Session, requested: Session["state"]) {
    // Nothing of a transient session is kept, so there is nothing to resume: reaping or evicting it ends it.
    const state = session.request.transient && requested === "idle" ? "disposed" : requested
    if (state !== requested) sessions.delete(session.id)
    // A session that is still starting has no `proc` yet: its spawning process is the one to close.
    const proc = session.proc ?? session.spawning
    // What a person can still read of this conversation once the process is gone; a start that never became live has none.
    if (session.opened) saveMeta(session)
    if (state === "disposed") {
      session.held = []
      retired.add(session.id)
      if (retired.size > KEPT_RETIRED) retired.delete(retired.values().next().value as string)
    }
    session.state = state
    // Whatever start is in flight sees the change after its current await and winds itself down.
    session.generation++
    session.proc = undefined
    session.spawning = undefined
    session.unsubscribe?.()
    session.unsubscribe = undefined
    session.ui.cancelAll()
    endSwarm(session)
    settleWaiters(session, { status: "missing" })
    await proc?.close().catch(() => undefined)
    await session.starting?.catch(() => undefined)
    await Promise.all(writes)
    if (state === "disposed") await scrub(session)
  }

  /** Removes the state directory of a transient session this host created (best effort, never anything else). */
  async function scrub(session: Session) {
    if (!session.scratch) return
    session.scratch = false
    await fs.rm(session.stateDir, { recursive: true, force: true }).catch(() => undefined)
    if (!session.scratchRun) return
    session.scratchRun = false
    // The run directory this create made, once it is empty: never recursive, so a sibling card's files (or a session another create put there since) keep it.
    await fs.rmdir(path.dirname(session.stateDir)).catch(() => undefined)
  }

  /** Spawns the process of an idle, lost or new session; every caller during one start shares its flight. */
  function begin(session: Session, resume: boolean): Promise<void> {
    if (closing) return Promise.reject(hostClosed())
    session.starting ??= start(session, resume).finally(() => {
      session.starting = undefined
    })
    return session.starting
  }

  /** A session belongs to the current project iff its state directory is under the current state root: after a project switch the others are neither listed nor readable until their project is current again. */
  function inProject(session: Session): boolean {
    const root = path.resolve(deps.stateRoot())
    const dir = path.resolve(session.stateDir)
    return dir === root || dir.startsWith(root + path.sep)
  }

  function find(id: string): Session {
    const session = sessions.get(id)
    if (!session || session.state === "disposed" || !inProject(session)) throw notFound(id)
    return session
  }

  /** The process, resuming a reaped session on the way. */
  async function attach(id: string): Promise<{ session: Session; proc: OmpProcess }> {
    if (!sessions.has(id)) await revive(id)
    const session = find(id)
    if (session.state === "idle") await begin(session, true).catch((error: unknown) => {
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

  /** Where a persisted session lives: the directory `hint` when it holds it, else the first one under the state root (any run) whose metadata names it. Bounded, so a huge state root costs a miss, not a stall. */
  async function locate(id: string, hint?: string): Promise<{ meta: Meta; dir: string } | undefined> {
    if (hint) {
      const meta = await readMeta(hint)
      if (meta?.id === id) return { meta, dir: hint }
    }
    let match: { meta: Meta; dir: string } | undefined
    await scan((found) => {
      if (found.meta.id === id) match = found
      return match !== undefined
    })
    return match
  }

  /**
   * The session `request.reuse` names: the one in memory, else the one the metadata on disk describes. It may have been written under another run (Resume after a stop or a restart
   * comes with a new run id): the session works from the directory its files are in, which is where omp's `--session-dir` points, and for the new run's id.
   */
  async function adopt(request: CreateRequest, stateDir: string): Promise<Session> {
    const id = request.reuse as string
    const found = await locate(id, stateDir)
    if (!found) throw notFound(id)
    const base = (await readTurns(found.dir)) ?? []
    // The directory the session's earlier work was done in, from its saved request: only a notice about it is kept, the process starts where the new request says.
    const original = asString(found.meta.request?.directory)
    // Read again right before registering: the run may have been pruned while the history was read.
    const meta = await readMeta(found.dir)
    if (!meta || meta.id !== id) throw notFound(id)
    // Nothing below awaits: the checks and the registration are one step, so a prune that claims the run afterwards finds the session holding it.
    if (closing) throw hostClosed()
    // A concurrent reuse of the same id may have registered it while the metadata was read: one session, one process.
    const known = sessions.get(id)
    if (known) return known
    if (prunes.has(path.basename(path.dirname(found.dir)))) throw notFound(id)
    const session = makeSession(id, request, found.dir)
    session.previousDirectory = original
    session.home = { runId: meta.runId || request.runId, nodeId: meta.nodeId || request.nodeId }
    session.created = meta.created || session.created
    session.title = meta.title
    session.base = base
    session.opened = true
    sessions.set(id, session)
    return session
  }

  /**
   * `begin` for a create: when `signal` aborts before the session is live the start is torn down and the record dropped (a saved session stays on disk), and the call rejects with the abort.
   * Once the session is live an abort changes nothing.
   */
  async function beginFor(session: Session, resume: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const abandon = () => {
      if (session.state === "live") return
      if (sessions.get(session.id) === session) sessions.delete(session.id)
      void stop(session, "disposed")
    }
    signal?.addEventListener("abort", abandon, { once: true })
    try {
      await begin(session, resume)
    } catch (error) {
      throw signal?.aborted ? signal.reason : error
    } finally {
      signal?.removeEventListener("abort", abandon)
    }
  }

  async function reuse(request: CreateRequest, stateDir: string, signal?: AbortSignal): Promise<{ id: string }> {
    if (closing) throw hostClosed()
    const id = request.reuse as string
    retired.delete(id)
    const held = sessions.get(id)
    const known = held && inProject(held) ? held : undefined
    const session = known ?? (await adopt(request, stateDir))
    void touchRun(session.stateDir)
    // The directory the session's earlier work was done in: the one it was last launched with, or the one its saved request names.
    const previous = known ? known.request.directory : session.previousDirectory
    // A live process keeps the settings (and the working directory) it was launched with until it is next resumed.
    if (session.state === "live") return { id }
    // Resumed for this request, not the one it was first created with: its model, permissions, swarm mode, tools, run and working directory follow the new body (and `releaseRun` and `holds`
    // match the new run). The engine decides where a resumed card works; only the session's own files stay where they were (its id and state directory).
    session.request = request
    session.previousDirectory = undefined
    if (previous && previous !== request.directory && (await fs.stat(previous).then((stat) => stat.isDirectory(), () => false))) session.carried = previous
    await beginFor(session, true, signal).catch((error: unknown) => {
      // A record this call created, or one omp cannot resume, is not kept.
      if ((known === undefined || (error instanceof HttpError && error.status === 404)) && sessions.get(id) === session) sessions.delete(id)
      throw error
    })
    return { id }
  }

  /**
   * A session this host holds no record of (the record was trimmed, or the host restarted) but whose files are on disk: resumed the way a reuse would, from the request saved
   * beside them. One disposed on purpose, or with no files, is the usual 404.
   */
  async function revive(id: string) {
    if (retired.has(id)) throw notFound(id)
    const found = await locate(id)
    if (!found) throw notFound(id)
    const saved = found.meta.request ?? { runId: found.meta.runId, nodeId: found.meta.nodeId, card: { key: found.meta.key }, model: found.meta.model }
    const project = deps.project()
    const parse = (directory: unknown) => parseCreate({ ...saved, directory, reuse: id }, project)
    // A directory that is gone (a removed worktree) falls back to the project.
    const request = await parse(saved.directory)
      .catch(() => parse(undefined))
      .catch(() => undefined)
    if (!request) throw notFound(id)
    await reuse(request, found.dir)
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
      title: session.title ?? (cleanTitle(session.store.firstUserText() ?? "", TITLE_LIMIT) || session.request.card.key),
      agent: session.request.card.key,
      model: session.request.model,
      created: session.created,
      updated: session.lastActivity,
    }
  }

  type Found = { meta: Meta; dir: string }

  /** The paths, newest modification first. Stats run in bounded parallel batches; a path that cannot be read sorts last. */
  async function newestFirst(targets: string[]): Promise<string[]> {
    const stamped: Array<{ target: string; at: number }> = []
    for (let from = 0; from < targets.length; from += SCAN_STAT_BATCH) {
      const batch = targets.slice(from, from + SCAN_STAT_BATCH)
      stamped.push(...(await Promise.all(batch.map(async (target) => ({ target, at: await fs.stat(target).then((stat) => stat.mtimeMs, () => 0) })))))
    }
    return stamped.sort((a, b) => b.at - a.at).map((entry) => entry.target)
  }

  /**
   * The persisted session directories under the state root (any run), newest first and bounded: the newest run directories by modification time, and of their card directories the newest overall.
   * Old directories can never crowd out a recent conversation, however many there are. `visit` returns true to stop.
   */
  async function scan(visit: (found: Found) => boolean): Promise<void> {
    const root = deps.stateRoot()
    const names = await fs.readdir(root).catch(() => [] as string[])
    const runs = (await newestFirst(names.map((name) => path.join(root, name)))).slice(0, deps.scan?.runs ?? SCAN_RUNS)
    const cards: string[] = []
    for (const run of runs) for (const node of await fs.readdir(run).catch(() => [] as string[])) cards.push(path.join(run, node))
    for (const dir of (await newestFirst(cards)).slice(0, deps.scan?.nodes ?? SCAN_NODES)) {
      const meta = await readMeta(dir)
      if (meta && visit({ meta, dir })) return
    }
  }

  function hostClosed(): HttpError {
    return new HttpError(409, "the engine host is shutting down", "session-closed")
  }

  async function launch(request: CreateRequest, stateDir: string, signal?: AbortSignal): Promise<{ id: string }> {
    if (request.reuse) return reuse(request, stateDir, signal)
    const existed = request.transient ? await fs.stat(stateDir).then(() => true, () => false) : true
    const runExisted = request.transient ? await fs.stat(path.dirname(stateDir)).then(() => true, () => false) : true
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
    if (closing) throw hostClosed()
    // One card, one session at a time: a replaced critic session must not still hold the session directory.
    let inherited = false
    let inheritedRun = false
    for (const other of [...sessions.values()]) {
      if (other.request.runId !== request.runId || other.request.nodeId !== request.nodeId) continue
      inherited ||= other.scratch === true
      inheritedRun ||= other.scratchRun === true
      sessions.delete(other.id)
      await stop(other, "disposed")
    }
    if (closing) throw hostClosed()
    // Registered before it starts, with no await in between, so releaseRun, dispose and close see it and the limit counts it.
    const session = makeSession(`s_${randomBytes(6).toString("hex")}`, request, stateDir)
    session.scratch = request.transient === true && (!existed || inherited)
    session.scratchRun = request.transient === true && (!runExisted || inheritedRun)
    sessions.set(session.id, session)
    await beginFor(session, false, signal).catch(async (error: unknown) => {
      if (sessions.get(session.id) === session) sessions.delete(session.id)
      await scrub(session)
      throw error
    })
    if (session.state === "live") await writeMeta(session).catch(() => undefined)
    return { id: session.id }
  }

  /** Every engine session that pins the project: starting, or live (running a turn, waiting on a dialog or idle between turns). */
  function holders(): string[] {
    return [...sessions.values()].filter((session) => session.starting !== undefined || session.state === "live").map((session) => session.id)
  }

  function holds(runDir: string): boolean {
    // An adopted session works for a newer run but lives in the directory of the run that wrote it: both are in use.
    return (
      claims.has(runDir) ||
      [...sessions.values()].some((session) => session.state !== "disposed" && (safeSegment(session.request.runId) === runDir || path.basename(path.dirname(session.stateDir)) === runDir))
    )
  }

  return {
    async create(body, signal) {
      // Counted from the very first line, before any await: parsing and the wait for a prune are part of the create, and a project switch must not slip in between.
      creating++
      try {
        if (closing) throw hostClosed()
        // One project and one state root for the whole create: the canvas can switch folders while it awaits, and a card's directory and its state belong to the same one.
        const project = deps.project()
        const root = deps.stateRoot()
        const request = await parseCreate(body, project)
        if (closing) throw hostClosed()
        const runDir = safeSegment(request.runId)
        // A prune removing this run's directory finishes first: this create starts fresh, never into files being deleted.
        while (prunes.has(runDir)) await prunes.get(runDir)?.promise
        if (closing) throw hostClosed()
        signal?.throwIfAborted()
        claims.set(runDir, (claims.get(runDir) ?? 0) + 1)
        try {
          return await launch(request, path.join(root, runDir, safeSegment(request.nodeId)), signal)
        } finally {
          const left = (claims.get(runDir) ?? 1) - 1
          if (left > 0) claims.set(runDir, left)
          if (left === 0) claims.delete(runDir)
        }
      } finally {
        creating--
      }
    },

    holds,

    claim(runDir) {
      if (holds(runDir) || prunes.has(runDir)) return undefined
      const pruning = Promise.withResolvers<void>()
      prunes.set(runDir, pruning)
      return () => {
        prunes.delete(runDir)
        pruning.resolve()
      }
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
        session.title = cleanTitle(request.text, TITLE_LIMIT) || undefined
        if (session.title) saveMeta(session)
      }
      try {
        const data = asRecord(
          await proc.command(
            { type: "prompt", id: commandId, message: body.message, ...(body.images.length ? { images: body.images } : {}), ...(followUp ? { streamingBehavior: "followUp" } : {}) },
            { timeoutMs: ADMISSION_TIMEOUT_MS },
          ),
        )
        // The browser knows the session id by now: what the start had to say goes out, once.
        for (const event of session.held.splice(0)) options.emit(event)
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
      if (!session || session.state === "disposed" || session.state === "lost" || !inProject(session)) return Promise.resolve({ status: "missing" })
      session.lastActivity = Date.now()
      const ready = outcome(session)
      if (ready) return Promise.resolve(ready)
      if (signal?.aborted) return Promise.resolve({ status: "timeout" })
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
      const session = sessions.get(id)
      if (session && session.state !== "disposed" && !inProject(session)) throw notFound(id)
      if (!session || session.state === "disposed") {
        // A session this host no longer holds (finished, released, or from before a restart): its saved conversation, read from its directory. No process is started for it.
        const found = await locate(id)
        const saved = found ? await readTurns(found.dir) : undefined
        if (!saved) throw notFound(id)
        return saved.slice(-limit)
      }
      await withHistory(session)
      return currentTurns(session, limit)
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
      const rows = [...sessions.values()].filter((session) => session.state !== "disposed" && !session.request.transient && inProject(session)).map(ofRow)
      const known = new Set(rows.map((row) => row.id))
      const found: Found[] = []
      await scan((candidate) => {
        if (!known.has(candidate.meta.id)) found.push(candidate)
        return false
      })
      // Newest first, and only sessions whose history can be opened: a row that answers 404 when clicked is not a row.
      found.sort((a, b) => b.meta.updated - a.meta.updated)
      const target = rows.length + limit
      for (const { meta, dir } of found) {
        if (rows.length >= target) break
        if (known.has(meta.id) || !(await fs.stat(path.join(dir, TURNS_FILE)).then((stat) => stat.isFile(), () => false))) continue
        known.add(meta.id)
        rows.push({ id: meta.id, title: meta.title ?? meta.key, agent: meta.key, model: meta.model, created: meta.created, updated: meta.updated })
      }
      return rows.sort((a, b) => b.updated - a.updated).slice(0, limit)
    },

    live() {
      return [...sessions.values()].filter((session) => session.state === "live").length
    },

    working() {
      return creating > 0 || holders().length > 0
    },

    holders,

    pending() {
      return [...sessions.values()].flatMap((session) => (session.state === "disposed" ? [] : session.ui.asked()))
    },

    maintain,

    async close() {
      closing = true
      clearInterval(timer)
      const all = [...sessions.values()]
      sessions.clear()
      await Promise.all(all.map((session) => stop(session, "disposed")))
    },
  }
}

/**
 * Shared project memory: what a card reads before it starts, what it writes when
 * it finishes, and the honest "forget".
 *
 * Scope policy lives in `shared/memory.ts`: read per project (`repo:<owner/name>`),
 * write per card (subject `openflow/<pipeline>/<run>/<card>`). Reads fail open and
 * say so; writes are `stored` only when Substrate says `accepted` AND
 * `verified_persisted`. Substrate cannot delete: forget writes `<subject>/retracted`
 * facts and keeps a local ignore list that `read` honours.
 */
import { execFile } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import type { OmpSettings } from "../../shared/omp"
import type {
  MemoryEntriesResult,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryItem,
  MemoryReadRequest,
  MemoryReadResult,
  MemoryStatus,
  MemoryWriteRequest,
  MemoryWriteResult,
} from "../../shared/memory"
import { memorySubject, memorySubjectPrefix } from "../../shared/memory"
import type { MemoryWriteReply, SubstrateClient, SubstrateEntry, SubstrateFailure, SubstrateResult } from "./client"
import { createClient, parseBaseUrl, resolveToken, tokenAllowed, untrustedMessage } from "./client"
import type { BlockEntry } from "./guard"
import { buildBlock, capText, preview, redact, stripControl } from "./guard"
import type { GraphContext, RunGraphs } from "./run-graph"

const runCommand = promisify(execFile)

const SLUG = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const RETRACTED = "/retracted"
const WRITE_TEXT_LIMIT = 3900
const FORGET_BATCH = 8
/** The reason Substrate gives when it quarantines hedged text written as a fact. */
const SPECULATIVE = "quarantine.speculative"
const DAY_MS = 86_400_000

export type SubstrateDeps = {
  project(): string
  settings(): Promise<OmpSettings>
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => number
}

export type MemoryModule = {
  status(): Promise<MemoryStatus>
  read(request: MemoryReadRequest): Promise<MemoryReadResult>
  write(request: MemoryWriteRequest): Promise<MemoryWriteResult>
  forget(request: MemoryForgetRequest): Promise<MemoryForgetResult>
  entries(request: { pipeline: string; runId?: string; limit?: number }): Promise<MemoryEntriesResult>
  graphId(runId: string): string
  dispose(): Promise<void>
}

/**
 * `owner/name` of a git remote URL, lower-cased: https (credentials ignored), ssh://,
 * scp-style `git@host:owner/name`, with or without `.git`. Sub-groups keep the last two segments.
 */
export function parseRemoteSlug(remote: string): string | undefined {
  const segments = remotePath(remote.trim())?.split("/").filter(Boolean)
  if (!segments || segments.length < 2) return undefined
  const slug = segments
    .slice(-2)
    .join("/")
    .replace(/\.git$/i, "")
    .toLowerCase()
  return SLUG.test(slug) ? slug : undefined
}

/** The path part of a remote: a URL's pathname, or what follows the `:` of an scp-style `git@host:owner/name`. */
function remotePath(text: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return /^(?:[^@/\s]+@)?[^/:\s]+:(.+)$/.exec(text)?.[1]
  try {
    return new URL(text).pathname
  } catch {
    return undefined
  }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand("git", args, { cwd, timeout: 2000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

function parseSubject(subject: string): { run?: string; card?: string } {
  const parts = subject.split("/")
  if (parts.length !== 4 || parts[0] !== "openflow") return {}
  return { run: parts[2], card: parts[3] }
}

function ageOf(created: string, now: number): number | undefined {
  const time = Date.parse(created)
  return Number.isNaN(time) ? undefined : Math.max(0, Math.floor((now - time) / DAY_MS))
}

/** Decisions and warnings out of the brief's markdown (`Decisions in force` / `Warnings` sections). */
function briefLines(text: string): Array<{ kind: "decision" | "warning"; text: string }> {
  const found: Array<{ kind: "decision" | "warning"; text: string }> = []
  let kind: "decision" | "warning" | undefined
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "Decisions in force") {
      kind = "decision"
      continue
    }
    if (line === "Warnings") {
      kind = "warning"
      continue
    }
    if (kind && line.startsWith("- ")) {
      found.push({ kind, text: line.slice(2) })
      continue
    }
    kind = undefined
  }
  return found
}

function describe(failure: SubstrateFailure, effect: string): string {
  if (failure.kind === "unauthorized") return failure.message
  return `${failure.message} ${effect}`.trim()
}

export function createMemory(deps: SubstrateDeps & { runGraphs: RunGraphs }): MemoryModule {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const inflight = new Set<Promise<unknown>>()
  let disposed = false
  let repoCache: { project: string; slug: string } | undefined
  let ignoreChain: Promise<void> = Promise.resolve()

  function track<T>(work: Promise<T>): Promise<T> {
    inflight.add(work)
    const done = () => inflight.delete(work)
    work.then(done, done)
    return work
  }

  const ignorePath = () => join(env.OPENFLOW_STATE_DIR || join(homedir(), ".openflow"), "memory-ignore.json")

  /**
   * The forget list. A missing file is an empty list; a file that does not parse
   * is moved aside (`.corrupt-<ts>`) and starts fresh, so one bad byte neither
   * wipes the list on the next write nor is lost; any other error throws, so a
   * write never lands over a file that was merely unreadable for a moment.
   */
  async function readCutoffs(repair = false): Promise<Record<string, number>> {
    const path = ignorePath()
    const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (raw === undefined) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (!("cutoffs" in parsed)) return {}
        const cutoffs = parsed.cutoffs
        if (cutoffs && typeof cutoffs === "object" && !Array.isArray(cutoffs)) {
          return Object.fromEntries(Object.entries(cutoffs).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
        }
      }
    } catch {
      // falls through to the corrupt-file handling
    }
    if (repair) await rename(path, `${path}.corrupt-${now()}`)
    return {}
  }

  /** Records a forget for one scope. Keys without a scope (written before cutoffs were scoped) are kept in the file but match nothing. */
  function addCutoff(scope: string, prefix: string, at: number): Promise<void> {
    const next = ignoreChain.then(async () => {
      const path = ignorePath()
      const cutoffs = await readCutoffs(true)
      const key = `${scope}|${prefix}`
      cutoffs[key] = Math.max(cutoffs[key] ?? 0, at)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, cutoffs }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, path)
    })
    // The chain must outlive one failed write; the caller still gets that failure from `next`.
    ignoreChain = next.catch(() => undefined)
    return next
  }

  /** Records a forget locally; the message when the ignore list could not be updated, undefined when it was. */
  async function hide(scope: string, prefix: string, at: number): Promise<string | undefined> {
    try {
      await addCutoff(scope, prefix, at)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Whether a forget on this host hides the entry: only cutoffs recorded for this very scope count (keys are `<scope>|<prefix>`). */
  function ignored(entry: SubstrateEntry, scope: string, cutoffs: Record<string, number>): boolean {
    const created = Date.parse(entry.created)
    const head = `${scope}|`
    return Object.entries(cutoffs).some(([key, at]) => key.startsWith(head) && entry.subject.startsWith(key.slice(head.length)) && !(created > at))
  }

  async function derivedRepo(project: string): Promise<string | undefined> {
    if (repoCache?.project === project) return repoCache.slug
    const remote = await git(project, ["remote", "get-url", "origin"])
    const slug = remote ? parseRemoteSlug(remote) : undefined
    if (slug) repoCache = { project, slug }
    return slug
  }

  type Resolved = { url?: URL; token?: string; repo?: string; problems: string[]; blocked: boolean }

  async function resolve(settings: OmpSettings): Promise<Resolved> {
    const problems: string[] = []
    const raw = settings.substrate.url.trim() || env.SUBSTRATE_URL?.trim() || ""
    const url = raw ? parseBaseUrl(raw) : undefined
    if (!raw) problems.push("No Substrate URL: set substrate.url in the Omp settings or SUBSTRATE_URL.")
    if (raw && !url) problems.push("The Substrate URL is not an http(s) URL: fix substrate.url in the Omp settings or SUBSTRATE_URL.")
    // The token is not even read for a URL it may not be sent to.
    const blocked = url !== undefined && !tokenAllowed(url, env)
    if (url && blocked) problems.push(untrustedMessage(url))
    const token = blocked ? undefined : await resolveToken(env)
    if (!token && !blocked) {
      problems.push(
        `No Substrate token: set SUBSTRATE_TOKEN or SUBSTRATE_TOKEN_FILE, or put the omp token in ${env.SUBSTRATE_TOKENS_DIR || "/etc/substrate/tokens"}/omp.`,
      )
    }
    const override = settings.memory.repo.trim().toLowerCase()
    const valid = SLUG.test(override)
    if (override && !valid) problems.push(`The memory repo "${override}" is not owner/name: fix memory.repo in the Omp settings.`)
    const repo = !override ? await derivedRepo(deps.project()) : valid ? override : undefined
    if (!override && !repo) {
      problems.push("The project has no git remote `origin` to name the repo for memory: set memory.repo to owner/name in the Omp settings.")
    }
    return { url, token: token?.token, repo, problems, blocked }
  }

  type Connection = { client: SubstrateClient; repo: string; scope: string; context: GraphContext }

  async function connect(settings: OmpSettings): Promise<Connection | { error: string; repo?: string }> {
    if (disposed) return { error: "Shared memory is shut down." }
    const resolved = await resolve(settings)
    if (!resolved.url || !resolved.token || !resolved.repo) {
      return { error: resolved.problems[0] ?? "Shared memory is not configured.", repo: resolved.repo }
    }
    const client = createClient({ url: resolved.url, token: resolved.token, fetch: deps.fetch ?? fetch, env })
    const branch = await git(deps.project(), ["rev-parse", "--abbrev-ref", "HEAD"])
    const context: GraphContext = { client, repo: resolved.repo, branch: branch === "HEAD" ? undefined : branch }
    return { client, repo: resolved.repo, scope: `repo:${resolved.repo}`, context }
  }

  /** Newest-first entries under a subject prefix, following `next` up to `max`; a later page failing keeps what came. */
  async function list(
    client: SubstrateClient,
    scope: string,
    prefix: string,
    max: number,
  ): Promise<SubstrateResult<{ entries: SubstrateEntry[]; degraded: boolean }>> {
    const entries: SubstrateEntry[] = []
    let degraded = false
    let cursor: { before: string; beforeId: string } | undefined
    while (entries.length < max) {
      const page = await client.memorySearch({
        scope,
        subjectPrefix: prefix,
        limit: Math.min(100, max - entries.length),
        before: cursor?.before,
        beforeId: cursor?.beforeId,
      })
      if (!page.ok) return entries.length === 0 ? page : { ok: true, value: { entries, degraded: true } }
      entries.push(...page.value.entries)
      degraded ||= page.value.degraded
      cursor = page.value.next
      if (!cursor) break
    }
    return { ok: true, value: { entries, degraded } }
  }

  function markedSubjects(entries: SubstrateEntry[]): Set<string> {
    return new Set(entries.filter((entry) => entry.subject.endsWith(RETRACTED)).map((entry) => entry.subject.slice(0, -RETRACTED.length)))
  }

  function toItem(entry: SubstrateEntry, at: number): MemoryItem {
    const parsed = parseSubject(entry.subject)
    return {
      id: entry.id,
      scope: entry.scope,
      kind: entry.kind,
      subject: entry.subject,
      preview: preview(entry.text),
      ageDays: ageOf(entry.created, at),
      origin: "search",
      run: parsed.run,
      card: parsed.card,
    }
  }

  const retention = (ttl: OmpSettings["memory"]["ttl"]): MemoryStatus["retention"] => ({
    ttl,
    deletable: false,
    note: `Substrate cannot delete entries: they lapse on their ${ttl} ttl. Forget hides a run's entries from OpenFlow and writes a retraction marker; the data stays in Substrate until it lapses.`,
  })

  async function read(request: MemoryReadRequest): Promise<MemoryReadResult> {
    const started = now()
    const elapsed = () => now() - started
    const settings = await deps.settings()
    if (!settings.memory.enabled) return { status: "disabled", block: "", items: [], scopes: [], elapsedMs: elapsed() }
    if (settings.memory.readLimit === 0) {
      return {
        status: "disabled",
        block: "",
        items: [],
        scopes: [],
        error: "Memory reads are off because memory.readLimit is 0 in the Omp settings; raise it to let cards read shared memory.",
        elapsedMs: elapsed(),
      }
    }
    const connection = await connect(settings)
    if ("error" in connection) {
      return { status: "unavailable", block: "", items: [], scopes: [], briefState: "absent", error: connection.error, elapsedMs: elapsed() }
    }
    const { client, scope, context } = connection
    const limit = request.limit ?? settings.memory.readLimit
    const prefix = memorySubjectPrefix(request.pipeline)
    const graphId = deps.runGraphs.graphId(request.runId)
    // The recall query (`request.query`) is not sent: Substrate ANDs every word of a full-text query,
    // so a task description would match nothing. The newest entries under the pipeline prefix are the recall.
    const [brief, search] = await track(
      Promise.all([
        client.brief({ repo: context.repo, branch: context.branch, graph_id: graphId }),
        list(client, scope, prefix, Math.min(100, Math.max(limit * 4, 24))),
        deps.runGraphs.begin(context, request),
      ]),
    )
    if (!brief.ok && !search.ok) {
      return {
        status: "unavailable",
        block: "",
        items: [],
        scopes: [scope],
        briefState: "absent",
        error: describe(search, "The card runs without shared memory."),
        elapsedMs: elapsed(),
      }
    }
    const at = now()
    const cutoffs = await readCutoffs().catch(() => ({}))
    const found = search.ok ? search.value.entries : []
    const marked = markedSubjects(found)
    const visible = found
      .filter(
        (entry) =>
          entry.subject.startsWith(prefix) &&
          !entry.supersededBy &&
          !entry.expired &&
          !entry.subject.endsWith(RETRACTED) &&
          !marked.has(entry.subject) &&
          !ignored(entry, scope, cutoffs),
      )
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
    const briefed = brief.ok ? briefLines(brief.value.text) : []
    const briefTake = Math.min(briefed.length, Math.floor(limit / 2))
    const searchTake = Math.min(visible.length, limit - briefTake)
    const extraBrief = Math.min(briefed.length - briefTake, limit - briefTake - searchTake)
    const candidates: Array<{ item: MemoryItem; entry: BlockEntry }> = [
      ...briefed.slice(0, briefTake + extraBrief).map((line, index) => {
        const subject = `brief/${line.kind}`
        return {
          item: { id: `brief-${line.kind}-${index}`, scope, kind: line.kind, subject, preview: preview(line.text), origin: "brief" as const },
          entry: { scope, subject, text: line.text },
        }
      }),
      ...visible.slice(0, searchTake).map((entry) => ({
        item: toItem(entry, at),
        entry: {
          scope: entry.scope,
          subject: entry.subject,
          text: entry.text,
          ageDays: ageOf(entry.created, at),
          note: entry.needsReverification ? "needs re-verification" : undefined,
        },
      })),
    ]
    const briefState = brief.ok ? brief.value.state : "absent"
    const { block, included } = buildBlock(candidates.map((candidate) => candidate.entry))
    if (included === 0) return { status: "empty", block: "", items: [], scopes: [scope], briefState, elapsedMs: elapsed() }
    return { status: "ok", block, items: candidates.slice(0, included).map((candidate) => candidate.item), scopes: [scope], briefState, elapsedMs: elapsed() }
  }

  function writeResult(reply: MemoryWriteReply, base: MemoryWriteResult): MemoryWriteResult {
    if (!reply.ok) {
      const status = reply.kind === "unauthorized" ? "denied" : "unavailable"
      return { ...base, status, error: describe(reply, "The card's outcome was not stored.") }
    }
    if (reply.outcome === "accepted") {
      const truncated = base.truncated || reply.truncated
      if (reply.verified) return { ...base, status: "stored", entryId: reply.entryId, truncated }
      return {
        ...base,
        status: "unverified",
        entryId: reply.entryId,
        truncated,
        error: "Substrate accepted the write but could not confirm it was persisted, so it may not be readable yet; re-run the card to retry.",
      }
    }
    const reason = reply.reason ? ` (${reply.reason})` : ""
    const remedy = reply.remedy ? ` ${reply.remedy}` : ""
    if (reply.outcome === "quarantined") {
      return {
        ...base,
        status: "quarantined",
        error: `Substrate quarantined this outcome${reason} and stored nothing.${remedy || " Remove secrets, personal data or speculative wording from the output and re-run."}`,
      }
    }
    if (reply.outcome === "denied") {
      return { ...base, status: "denied", error: `Substrate denied the write${reason}: the omp surface needs a fact grant on this repo scope.${remedy}` }
    }
    return {
      ...base,
      status: "conflict",
      error: `Substrate reported a conflict${reason}.${remedy || " An entry with this key already exists with different content."}`,
    }
  }

  async function write(request: MemoryWriteRequest): Promise<MemoryWriteResult> {
    const settings = await deps.settings()
    if (!settings.memory.enabled) return { status: "disabled" }
    const connection = await connect(settings)
    if ("error" in connection) return { status: "unavailable", error: connection.error }
    const { client, scope, context } = connection
    // A sub-agent dispatched again writes again: the ordinal keeps its subject and idempotency key apart from the first
    // answer's (the first dispatch keeps the bare ones, so entries written before this existed still match).
    const dispatch = request.dispatch !== undefined && Number.isInteger(request.dispatch) && request.dispatch > 1 ? request.dispatch : 1
    const subject = memorySubject(request.pipeline, request.runId, request.nodeId, dispatch)
    const base: MemoryWriteResult = { status: "skipped", scope, subject }
    return track(
      (async () => {
        const output = redact(stripControl(request.output)).trim()
        if (!output) {
          await deps.runGraphs.end(context, request)
          return { ...base, error: "The card produced no output, so nothing was written." }
        }
        const role = stripControl(request.role).replace(/[[\]\s]+/g, " ").trim().slice(0, 60)
        const body = capText(`[${role}] ${request.outcome}: ${output}`, WRITE_TEXT_LIMIT)
        await deps.runGraphs.register(context, request.runId, request.nodeId)
        const payload = {
          scope,
          kind: "fact",
          subject,
          text: body.text,
          ttl: settings.memory.ttl,
          graph_id: deps.runGraphs.graphId(request.runId),
          session_id: `openflow-${request.runId}-${request.nodeId}`,
          idempotency_key: `openflow:${request.runId}:${request.nodeId}${dispatch > 1 ? `:${dispatch}` : ""}`,
        }
        let reply = await client.memoryWrite(payload)
        // 202 means accepted but not read back; the same key makes the retry exactly-once.
        if (reply.ok && reply.outcome === "accepted" && !reply.verified) reply = await client.memoryWrite(payload)
        let result = writeResult(reply, { ...base, truncated: body.truncated })
        // Hedged text ("guessing", "might") is quarantined as a fact but accepted as a todo; every other quarantine
        // (secrets, personal data) stays quarantined. A refused todo reports the original quarantine, not its own.
        if (reply.ok && reply.outcome === "quarantined" && reply.reason === SPECULATIVE) {
          const todo = { ...payload, kind: "todo", idempotency_key: `${payload.idempotency_key}:todo` }
          let retry = await client.memoryWrite(todo)
          if (retry.ok && retry.outcome === "accepted" && !retry.verified) retry = await client.memoryWrite(todo)
          const stored = writeResult(retry, { ...base, truncated: body.truncated })
          if (stored.status === "stored" || stored.status === "unverified") result = { ...stored, kind: "todo" }
        }
        await deps.runGraphs.end(context, request)
        return result
      })(),
    )
  }

  async function forget(request: MemoryForgetRequest): Promise<MemoryForgetResult> {
    const settings = await deps.settings()
    if (!settings.memory.enabled) return { status: "disabled", retracted: 0 }
    const prefix = memorySubjectPrefix(request.pipeline, request.runId)
    const connection = await connect(settings)
    if ("error" in connection) {
      // Without a repo there is no scope to ignore the entries under, so nothing is hidden.
      if (!connection.repo) return { status: "unavailable", retracted: 0, error: `${connection.error} No retraction marker was written.` }
      const unrecorded = await hide(`repo:${connection.repo}`, prefix, now())
      return {
        status: "unavailable",
        retracted: 0,
        error: unrecorded
          ? `${connection.error} No retraction marker was written, and the ignore list could not be updated (${unrecorded}).`
          : `${connection.error} This host will ignore those entries, but no retraction marker was written.`,
      }
    }
    const { client, scope } = connection
    const listing = await track(list(client, scope, prefix, 500))
    if (!listing.ok) {
      const unrecorded = await hide(scope, prefix, now())
      return {
        status: "unavailable",
        retracted: 0,
        error: (unrecorded
          ? `${describe(listing, "")} No retraction marker was written, and the ignore list could not be updated (${unrecorded}).`
          : `${describe(listing, "")} This host will ignore those entries, but no retraction marker was written.`
        ).replace(/\s+/g, " "),
      }
    }
    const entries = listing.value.entries
    const unrecorded = await hide(scope, prefix, Math.max(now(), ...entries.map((entry) => Date.parse(entry.created) || 0)))
    const marked = markedSubjects(entries)
    const subjects = [...new Set(entries.map((entry) => entry.subject))].filter((subject) => !subject.endsWith(RETRACTED))
    const pending = subjects.filter((subject) => !marked.has(subject))
    let failed = 0
    for (let index = 0; index < pending.length; index += FORGET_BATCH) {
      const replies = await track(
        Promise.all(
          pending.slice(index, index + FORGET_BATCH).map((subject) =>
            client.memoryWrite({
              scope,
              kind: "fact",
              subject: `${subject}${RETRACTED}`,
              text: `Retracted by OpenFlow forget: ignore the entry ${subject}.`,
              ttl: settings.memory.ttl,
              idempotency_key: `openflow-forget:${subject}`,
            }),
          ),
        ),
      )
      failed += replies.filter((reply) => !reply.ok || reply.outcome !== "accepted").length
    }
    const errors = [
      ...(unrecorded ? [`The ignore list could not be updated (${unrecorded}), so these entries may still show on this host.`] : []),
      ...(failed === 0
        ? []
        : [`${failed} retraction marker${failed === 1 ? "" : "s"} could not be written to Substrate; those entries are ignored on this host only.`]),
    ]
    if (errors.length === 0) return { status: "retracted", retracted: subjects.length }
    return { status: "retracted", retracted: subjects.length, error: errors.join(" ") }
  }

  async function entries(request: { pipeline: string; runId?: string; limit?: number }): Promise<MemoryEntriesResult> {
    const settings = await deps.settings()
    if (!settings.memory.enabled) return { status: "disabled", items: [] }
    const connection = await connect(settings)
    if ("error" in connection) return { status: "unavailable", items: [], error: connection.error }
    const listing = await track(list(connection.client, connection.scope, memorySubjectPrefix(request.pipeline, request.runId), request.limit ?? 50))
    if (!listing.ok) return { status: "unavailable", items: [], error: describe(listing, "") }
    const at = now()
    const cutoffs = await readCutoffs().catch(() => ({}))
    const marked = markedSubjects(listing.value.entries)
    const items = listing.value.entries.map((entry) => ({
      ...toItem(entry, at),
      retracted: entry.subject.endsWith(RETRACTED) || marked.has(entry.subject) || ignored(entry, connection.scope, cutoffs),
    }))
    return { status: items.length === 0 ? "empty" : "ok", items }
  }

  async function status(): Promise<MemoryStatus> {
    const settings = await deps.settings()
    const resolved = await resolve(settings)
    const base = {
      enabled: settings.memory.enabled,
      reachable: false,
      url: resolved.url?.host,
      surface: "omp" as const,
      project: resolved.repo ?? "",
      retention: retention(settings.memory.ttl),
    }
    if (!settings.memory.enabled) return { ...base, problems: [] }
    const problems = [...resolved.problems]
    const health =
      resolved.url && !resolved.blocked
        ? await createClient({ url: resolved.url, token: resolved.token ?? "", fetch: deps.fetch ?? fetch, env }).healthz()
        : undefined
    if (health) problems.push(...(health.ok ? health.value.problems : [health.message]))
    return { ...base, reachable: health?.ok === true, problems }
  }

  return {
    status,
    read,
    write,
    forget,
    entries,
    graphId: (runId) => deps.runGraphs.graphId(runId),
    async dispose() {
      disposed = true
      await Promise.allSettled([...inflight])
      // Never rejects: addCutoff keeps the chain alive past a failed write.
      await ignoreChain
    },
  }
}

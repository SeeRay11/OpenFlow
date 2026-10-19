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
  MemoryEntryRow,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryItem,
  MemoryReadRequest,
  MemoryReadResult,
  MemoryStatus,
  MemoryWriteRequest,
  MemoryWriteResult,
} from "../../shared/memory"
import { memorySubject } from "../../shared/memory"
import type { MemoryWriteReply, SubstrateClient, SubstrateEntry, SubstrateFailure, SubstrateResult } from "./client"
import { createClient, parseBaseUrl, resolveToken } from "./client"
import type { BlockEntry } from "./guard"
import { buildBlock, capText, preview, redact, stripControl } from "./guard"
import type { GraphContext, RunGraphs } from "./run-graph"

const runCommand = promisify(execFile)

const SLUG = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const RETRACTED = "/retracted"
const WRITE_TEXT_LIMIT = 3900
const QUERY_LIMIT = 1500
const FORGET_BATCH = 8
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
  const text = remote.trim()
  let path: string | undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      path = new URL(text).pathname
    } catch {
      return undefined
    }
  } else {
    path = /^(?:[^@/\s]+@)?[^/:\s]+:(.+)$/.exec(text)?.[1]
  }
  const segments = path?.split("/").filter(Boolean)
  if (!segments || segments.length < 2) return undefined
  const slug = segments
    .slice(-2)
    .join("/")
    .replace(/\.git$/i, "")
    .toLowerCase()
  return SLUG.test(slug) ? slug : undefined
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand("git", args, { cwd, timeout: 2000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/** `<runPrefix>` / `<pipelinePrefix>` of the subject convention, with the trailing slash. */
function subjectPrefix(pipeline: string, run?: string): string {
  if (run === undefined) return memorySubject(pipeline, "x", "x").slice(0, -"x/x".length)
  return memorySubject(pipeline, run, "x").slice(0, -1)
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
    if (line === "Decisions in force") kind = "decision"
    else if (line === "Warnings") kind = "warning"
    else if (kind && line.startsWith("- ")) found.push({ kind, text: line.slice(2) })
    else kind = undefined
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

  async function readCutoffs(): Promise<Record<string, number>> {
    try {
      const parsed = JSON.parse(await readFile(ignorePath(), "utf8")) as { cutoffs?: Record<string, number> }
      return parsed.cutoffs ?? {}
    } catch {
      return {}
    }
  }

  function addCutoff(prefix: string, at: number): Promise<void> {
    ignoreChain = ignoreChain.then(async () => {
      const path = ignorePath()
      const cutoffs = await readCutoffs()
      cutoffs[prefix] = Math.max(cutoffs[prefix] ?? 0, at)
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, cutoffs }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, path)
    })
    return ignoreChain
  }

  function ignored(entry: SubstrateEntry, cutoffs: Record<string, number>): boolean {
    const created = Date.parse(entry.created)
    return Object.entries(cutoffs).some(([prefix, at]) => entry.subject.startsWith(prefix) && !(created > at))
  }

  async function derivedRepo(project: string): Promise<string | undefined> {
    if (repoCache?.project === project) return repoCache.slug
    const remote = await git(project, ["remote", "get-url", "origin"])
    const slug = remote ? parseRemoteSlug(remote) : undefined
    if (slug) repoCache = { project, slug }
    return slug
  }

  type Resolved = { url?: URL; token?: string; repo?: string; problems: string[] }

  async function resolve(settings: OmpSettings): Promise<Resolved> {
    const problems: string[] = []
    const raw = settings.substrate.url.trim() || env.SUBSTRATE_URL?.trim() || ""
    const url = raw ? parseBaseUrl(raw) : undefined
    if (!raw) problems.push("No Substrate URL: set substrate.url in the Omp settings or SUBSTRATE_URL.")
    else if (!url) problems.push("The Substrate URL is not an http(s) URL: fix substrate.url in the Omp settings or SUBSTRATE_URL.")
    const token = await resolveToken(env)
    if (!token) {
      problems.push(
        `No Substrate token: set SUBSTRATE_TOKEN or SUBSTRATE_TOKEN_FILE, or put the omp token in ${env.SUBSTRATE_TOKENS_DIR || "/etc/substrate/tokens"}/omp.`,
      )
    }
    let repo: string | undefined
    const override = settings.memory.repo.trim().toLowerCase()
    if (override) {
      repo = SLUG.test(override) ? override : undefined
      if (!repo) problems.push(`The memory repo "${override}" is not owner/name: fix memory.repo in the Omp settings.`)
    } else {
      repo = await derivedRepo(deps.project())
      if (!repo) {
        problems.push("The project has no git remote `origin` to name the repo for memory: set memory.repo to owner/name in the Omp settings.")
      }
    }
    return { url, token: token?.token, repo, problems }
  }

  type Connection = { client: SubstrateClient; repo: string; scope: string; context: GraphContext }

  async function connect(settings: OmpSettings): Promise<Connection | { error: string }> {
    if (disposed) return { error: "Shared memory is shut down." }
    const resolved = await resolve(settings)
    if (!resolved.url || !resolved.token || !resolved.repo) return { error: resolved.problems[0] ?? "Shared memory is not configured." }
    const client = createClient({ url: resolved.url, token: resolved.token, fetch: deps.fetch ?? fetch })
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
    const connection = await connect(settings)
    if ("error" in connection) {
      return { status: "unavailable", block: "", items: [], scopes: [], briefState: "absent", error: connection.error, elapsedMs: elapsed() }
    }
    const { client, scope, context } = connection
    const limit = Math.max(1, request.limit ?? settings.memory.readLimit)
    const prefix = subjectPrefix(request.pipeline)
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
    const cutoffs = await readCutoffs()
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
          !ignored(entry, cutoffs),
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
    const subject = memorySubject(request.pipeline, request.runId, request.nodeId)
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
          idempotency_key: `openflow:${request.runId}:${request.nodeId}`,
        }
        let reply = await client.memoryWrite(payload)
        // 202 means accepted but not read back; the same key makes the retry exactly-once.
        if (reply.ok && reply.outcome === "accepted" && !reply.verified) reply = await client.memoryWrite(payload)
        const result = writeResult(reply, { ...base, truncated: body.truncated })
        await deps.runGraphs.end(context, request)
        return result
      })(),
    )
  }

  async function forget(request: MemoryForgetRequest): Promise<MemoryForgetResult> {
    const settings = await deps.settings()
    if (!settings.memory.enabled) return { status: "disabled", retracted: 0 }
    const prefix = subjectPrefix(request.pipeline, request.runId)
    const connection = await connect(settings)
    if ("error" in connection) {
      await addCutoff(prefix, now())
      return { status: "unavailable", retracted: 0, error: `${connection.error} This host will ignore those entries, but no retraction marker was written.` }
    }
    const { client, scope } = connection
    const listing = await track(list(client, scope, prefix, 500))
    if (!listing.ok) {
      await addCutoff(prefix, now())
      return {
        status: "unavailable",
        retracted: 0,
        error: `${describe(listing, "")} This host will ignore those entries, but no retraction marker was written.`.replace(/\s+/g, " "),
      }
    }
    const entries = listing.value.entries
    await addCutoff(prefix, Math.max(now(), ...entries.map((entry) => Date.parse(entry.created) || 0)))
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
              subject: `${subject}${RETRACTED}`.slice(0, 200),
              text: `Retracted by OpenFlow forget: ignore the entry ${subject}.`,
              ttl: settings.memory.ttl,
              idempotency_key: `openflow-forget:${subject}`,
            }),
          ),
        ),
      )
      failed += replies.filter((reply) => !reply.ok || reply.outcome !== "accepted").length
    }
    if (failed === 0) return { status: "retracted", retracted: subjects.length }
    return {
      status: "retracted",
      retracted: subjects.length,
      error: `${failed} retraction marker${failed === 1 ? "" : "s"} could not be written to Substrate; those entries are ignored on this host only.`,
    }
  }

  async function entries(request: { pipeline: string; runId?: string; limit?: number }): Promise<MemoryEntriesResult> {
    const settings = await deps.settings()
    if (!settings.memory.enabled) return { status: "disabled", items: [] }
    const connection = await connect(settings)
    if ("error" in connection) return { status: "unavailable", items: [], error: connection.error }
    const listing = await track(list(connection.client, connection.scope, subjectPrefix(request.pipeline, request.runId), request.limit ?? 50))
    if (!listing.ok) return { status: "unavailable", items: [], error: describe(listing, "") }
    const at = now()
    const cutoffs = await readCutoffs()
    const marked = markedSubjects(listing.value.entries)
    const items = listing.value.entries.map((entry) => ({
      ...toItem(entry, at),
      retracted: entry.subject.endsWith(RETRACTED) || marked.has(entry.subject) || ignored(entry, cutoffs),
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
    let reachable = false
    if (resolved.url) {
      const health = await createClient({ url: resolved.url, token: resolved.token ?? "", fetch: deps.fetch ?? fetch }).healthz()
      if (health.ok) {
        reachable = true
        problems.push(...health.value.problems)
      } else problems.push(health.message)
    }
    return { ...base, reachable, problems }
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
      await ignoreChain
    },
  }
}

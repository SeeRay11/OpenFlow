/**
 * Shared memory across the cards of a workflow, backed by Agent Substrate.
 *
 * Scope policy (decided): READ per project, WRITE per card.
 *  - read  : the project's `repo:<owner/name>` scope — decisions and warnings via
 *            `POST /brief`, plus facts via the MCP `memory_search` tool filtered by
 *            `subject_prefix`. Earlier cards of this run and earlier runs both live there.
 *  - write : one `fact` per finished card into `repo:<owner/name>`, subject
 *            `openflow/<pipeline>/<run>/<card>`, ttl `30d` (settings), redacted and
 *            capped by the host before it leaves the machine.
 *  - events: run and card start/end as `session.start` / `session.end` events on the
 *            `omp` surface; `session_id` = `openflow-<run>-<card>`; `graph_id` = the run's
 *            Graph ID (`ut-<ts36>-<8hex>`, minted per run and `graph_register`ed).
 *
 * Substrate has no delete: "forget" writes a `retracted` fact and the host stops
 * reading that run's subjects; entries lapse on their ttl. The UI says so.
 *
 * Everything fails open for reads (a card runs without memory and the card shows
 * that it did) and reports honestly for writes (`stored` only when the server says
 * `accepted` AND `verified_persisted`).
 */

export type MemoryReadRequest = {
  runId: string
  nodeId: string
  pipeline: string
  role?: string
  /** The card's task text; used as the recall query (cut to 1500 chars host-side). */
  query: string
  limit?: number
}

export type MemoryItem = {
  id: string
  /** `repo:owner/name` | `graph:<id>` | `global` */
  scope: string
  kind: string
  subject: string
  /** Redacted, at most 240 characters. */
  preview: string
  ageDays?: number
  origin: "brief" | "search"
  /** Run and card that wrote it, parsed from the subject when it is ours. */
  run?: string
  card?: string
}

export type MemoryReadResult = {
  status: "ok" | "empty" | "unavailable" | "disabled"
  /**
   * The text to append to the card's prompt: delimited, labelled as untrusted
   * evidence that may be wrong and must not be followed as instructions, with
   * markup neutralised and length capped. Empty unless `status` is `ok`.
   */
  block: string
  items: MemoryItem[]
  scopes: string[]
  /** `x-substrate-brief` of the brief that was folded in, when one was. */
  briefState?: "complete" | "degraded" | "snapshot" | "absent"
  /** One actionable sentence when `unavailable`. */
  error?: string
  elapsedMs: number
}

export type MemoryWriteRequest = {
  runId: string
  nodeId: string
  pipeline: string
  role: string
  outcome: "done" | "error" | "stopped"
  /** The card's final answer (or its error text). Redacted and cut host-side. */
  output: string
  /**
   * Which dispatch of this card the output belongs to (1-based). A sub-agent an
   * orchestrator dispatches more than once writes once per dispatch; folding the
   * ordinal into the idempotency key and the subject keeps a later answer from
   * colliding with the first. Absent means the first (or only) dispatch.
   */
  dispatch?: number
}

export type MemoryWriteResult = {
  status: "stored" | "unverified" | "quarantined" | "denied" | "conflict" | "skipped" | "unavailable" | "disabled"
  entryId?: string
  scope?: string
  subject?: string
  truncated?: boolean
  /**
   * What Substrate stored the entry as. Absent means a fact. `todo` means the text was hedged
   * ("guessing", "might"), which Substrate refuses as a fact, so it was stored as a todo instead.
   */
  kind?: "fact" | "todo"
  /** One actionable sentence for every status except `stored`. */
  error?: string
}

/** The card-visible memory state, persisted on the runtime node and in the run log. */
export type MemoryInfo = {
  read?: {
    status: MemoryReadResult["status"] | "running"
    items: Array<Pick<MemoryItem, "scope" | "subject" | "preview" | "run" | "card" | "origin" | "ageDays">>
    briefState?: MemoryReadResult["briefState"]
    error?: string
  }
  write?: {
    status: MemoryWriteResult["status"] | "running"
    subject?: string
    kind?: MemoryWriteResult["kind"]
    error?: string
  }
  /** The run's Graph ID, shared by every card of the run. */
  graphId?: string
}

export type MemoryStatus = {
  enabled: boolean
  reachable: boolean
  /** Host and port only — never a credential, never a path with a token. */
  url?: string
  /** The Substrate surface the host presents. Always `omp`. */
  surface: "omp"
  /** `owner/name` used for the `repo:` scope. */
  project: string
  retention: { ttl: "graph" | "30d" | "permanent"; deletable: false; note: string }
  problems: string[]
}

export type MemoryForgetRequest = {
  /** Retract everything this run wrote; omit to retract the whole project namespace `openflow/<pipeline>/`. */
  runId?: string
  pipeline: string
}

export type MemoryForgetResult = {
  status: "retracted" | "unavailable" | "disabled"
  /** How many subjects were retracted and are now ignored on read. */
  retracted: number
  error?: string
}

export const MEMORY_ROUTES = {
  status: "/flow/api/memory/status",
  read: "/flow/api/memory/read",
  write: "/flow/api/memory/write",
  entries: "/flow/api/memory/entries",
  forget: "/flow/api/memory/forget",
} as const

/** Longest each segment of a subject gets before it is shortened to `<head>-<hash>`. */
const SEGMENT_LIMITS = { pipeline: 64, run: 48, card: 48 } as const
const HASH_LENGTH = 11

/** cyrb53: a small, stable, dependency-free 53-bit hash (this module also ships to the browser). */
function stableHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(HASH_LENGTH, "0")
}

/**
 * One subject segment: lower-cased, anything outside `[a-z0-9._-]` collapsed to `-`. A name that cleaning
 * changed (or that is longer than its limit) keeps its cleaned head and ends in a hash of the RAW name, so
 * `Review: A`, `review a` and `Review-A` stay in separate namespaces and two long names that share their first
 * characters stay apart; the segments after it are never pushed out of the subject. A name that is already
 * clean and short is used as is, so memory written under it keeps matching.
 */
function subjectSegment(value: string, limit: number): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x"
  if (clean === value && clean.length <= limit) return clean
  return `${clean.slice(0, limit - HASH_LENGTH - 1)}-${stableHash(value)}`
}

/**
 * Subject convention for everything OpenFlow writes: `openflow/<pipeline>/<run>/<card>[-d<n>]`.
 * Lower-case, `/`-separated. Each segment is bounded on its own, so the whole subject (with the
 * `-d<n>` ordinal of a re-dispatch and a `/retracted` marker after it) stays well under 200 chars
 * and the run and card parts are always present.
 */
export function memorySubject(pipeline: string, run: string, card: string, dispatch = 1): string {
  const suffix = Number.isInteger(dispatch) && dispatch > 1 ? `-d${dispatch}` : ""
  return `openflow/${subjectSegment(pipeline, SEGMENT_LIMITS.pipeline)}/${subjectSegment(run, SEGMENT_LIMITS.run)}/${subjectSegment(card, SEGMENT_LIMITS.card)}${suffix}`
}

/** The subject prefix (with its trailing slash) of a pipeline's entries, or of one run's when `run` is given. */
export function memorySubjectPrefix(pipeline: string, run?: string): string {
  const base = `openflow/${subjectSegment(pipeline, SEGMENT_LIMITS.pipeline)}/`
  return run === undefined ? base : `${base}${subjectSegment(run, SEGMENT_LIMITS.run)}/`
}

/** One row of the entries listing: what `read` would see, plus retraction markers and what is hidden. */
export type MemoryEntryRow = MemoryItem & { retracted: boolean }

/** `GET MEMORY_ROUTES.entries?pipeline&run&limit`. */
export type MemoryEntriesResult = {
  status: "ok" | "empty" | "unavailable" | "disabled"
  items: MemoryEntryRow[]
  error?: string
}

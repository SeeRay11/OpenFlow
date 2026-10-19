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
}

export type MemoryWriteResult = {
  status: "stored" | "unverified" | "quarantined" | "denied" | "conflict" | "skipped" | "unavailable" | "disabled"
  entryId?: string
  scope?: string
  subject?: string
  truncated?: boolean
  /** One actionable sentence for every status except `stored`. */
  error?: string
}

/** The card-visible memory state, persisted on the runtime node and in the run log. */
export type MemoryInfo = {
  read?: {
    status: MemoryReadResult["status"] | "running"
    items: Array<Pick<MemoryItem, "scope" | "subject" | "preview" | "run" | "card" | "origin">>
    briefState?: MemoryReadResult["briefState"]
    error?: string
  }
  write?: {
    status: MemoryWriteResult["status"] | "running"
    subject?: string
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

/** Subject convention for everything OpenFlow writes. Lower-case, `/`-separated, at most 200 chars. */
export function memorySubject(pipeline: string, run: string, card: string): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x"
  return `openflow/${clean(pipeline)}/${clean(run)}/${clean(card)}`.slice(0, 200)
}

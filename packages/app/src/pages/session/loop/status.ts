import type { SessionStatus } from "@opencode-ai/sdk/v2"

export type LoopSessionState = "working" | "needs_input" | "retry" | "compacting" | "completed" | "unknown"

export type LoopStatus = {
  state: LoopSessionState
  attempt?: number
}

/**
 * The event shape this module maps from. Deliberately structural: tests and
 * the controller can feed any object carrying `type`, `properties.sessionID`
 * and the few fields read below, without importing the full event union.
 * `text`/`textID`/`timestamp` carry `session.next.text.ended` payloads for the
 * NEXT-MOVE queue (Stufe 2); the status mapping ignores them.
 */
export type LoopEventLike = {
  type: string
  properties: {
    sessionID?: string
    status?: SessionStatus
    attempt?: number
    text?: string
    textID?: string
    timestamp?: number
  }
}

const COMPLETED_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.next.step.ended",
  "session.next.step.failed",
])

/**
 * Maps a single session event to a loop status. Returns undefined for events
 * that carry no status signal (they must not overwrite a folded status).
 */
export function mapEventToStatus(event: LoopEventLike): LoopStatus | undefined {
  const type = event.type
  if (type === "session.status") {
    const status = event.properties.status
    if (!status) return undefined
    if (status.type === "busy") return { state: "working" }
    if (status.type === "retry") return { state: "retry", attempt: status.attempt }
    return { state: "completed" }
  }
  if (type === "session.next.retried") return { state: "retry", attempt: event.properties.attempt }
  if (type === "session.execution.started" || type === "session.next.step.started") return { state: "working" }
  if (COMPLETED_EVENTS.has(type)) return { state: "completed" }
  if (type === "permission.asked" || type === "question.asked") return { state: "needs_input" }
  if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") {
    return { state: "working" }
  }
  return undefined
}

export type DeriveSessionStatusInput = {
  permissionPending?: boolean
  questionPending?: boolean
  eventStatus?: LoopStatus
  storeStatus?: SessionStatus
  timeCompacting?: number
  now?: number
}

/**
 * Derives the displayed status for one session.
 *
 * Priority: pending permission/question wins (needs_input), then a live
 * event status that still means activity (needs_input/working/retry), then a
 * fresh compaction stamp (compacting), then any other folded event status,
 * then the sync-store session_status entry, then unknown. `completed` is only
 * ever derived from a real store idle entry or a completion event — absence of
 * a store entry never fakes idle.
 */
export function deriveSessionStatus(input: DeriveSessionStatusInput): LoopStatus {
  if (input.permissionPending || input.questionPending) return { state: "needs_input" }
  const event = input.eventStatus
  if (event?.state === "needs_input" || event?.state === "working" || event?.state === "retry") return event
  if (compactingIsFresh(input.timeCompacting, input.now ?? Date.now())) return { state: "compacting" }
  if (event) return event
  const store = input.storeStatus
  if (store?.type === "busy") return { state: "working" }
  if (store?.type === "retry") return { state: "retry", attempt: store.attempt }
  if (store?.type === "idle") return { state: "completed" }
  return { state: "unknown" }
}

/** Unknown sessions updated within this window count as still working. */
export const UNKNOWN_FRESH_WINDOW_MS = 60_000

/** A session whose `time.compacting` stamp is younger than this is compacting. */
export const COMPACTING_FRESH_WINDOW_MS = 120_000

/**
 * Weak signal for compacting sessions (spec E7): the server stamps
 * `time.compacting` while a compaction runs; anything older than the window
 * is stale and no longer counts.
 */
export function compactingIsFresh(timeCompacting: number | undefined, now: number): boolean {
  if (timeCompacting === undefined) return false
  return now - timeCompacting < COMPACTING_FRESH_WINDOW_MS
}

/**
 * Weak signal for unknown sessions: a session whose `time.updated` is younger
 * than the window is treated as live (grouped with working); anything older
 * settles as completed.
 */
export function unknownIsFresh(timeUpdated: number | undefined, now: number): boolean {
  if (timeUpdated === undefined) return false
  return now - timeUpdated < UNKNOWN_FRESH_WINDOW_MS
}

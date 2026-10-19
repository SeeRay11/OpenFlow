import { PTY_CLOSE } from "../../shared/terminal"
import type { PtyKind } from "../../shared/terminal"

/**
 * The dock's connection logic as a pure reducer, so reconnect, resume and the
 * wording of every state are tested without a DOM or a socket. The component
 * only turns I/O results into events and renders the state.
 */

export type SessionPhase = "idle" | "loading" | "connected" | "exited" | "disconnected" | "error"

export type SessionProblem = { message: string; code?: string }

export type SessionState = {
  phase: SessionPhase
  kind: PtyKind
  /** The host's session id once a ticket was granted; kept across reconnects. */
  id?: string
  /** UTF-16 units of output received: where a reconnect resumes. */
  cursor: number
  /** Consecutive failed (re)connects; 0 once a socket opens. */
  attempt: number
  exit?: { code: number | null; signal: string | null }
  error?: SessionProblem
  /** Delay before the next automatic reconnect; undefined when automatic retry has stopped. */
  retryInMs?: number
}

export type SessionEvent =
  /** Start connecting. With `id`: resume that session. Without: create a new one (restart, or a different kind). */
  | { type: "begin"; kind: PtyKind; id?: string }
  | { type: "ticket"; id: string }
  | { type: "open" }
  | { type: "output"; length: number }
  | { type: "cursor"; cursor: number }
  | { type: "exit"; exit: { code: number | null; signal: string | null } }
  | { type: "closed"; code: number }
  /** A ticket request failed: `network` when the host could not be reached at all. */
  | { type: "failed"; problem: SessionProblem; status?: number; network?: boolean }
  /** An automatic retry whose timer fired, or the user's Reconnect. */
  | { type: "retry"; manual?: boolean }

/** After this many failed reconnects in a row the dock stops retrying and offers a button. */
export const MAX_ATTEMPTS = 8
const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 8000

export function initialState(kind: PtyKind): SessionState {
  return { phase: "idle", kind, cursor: 0, attempt: 0 }
}

/** 250 ms, 500, 1 s, 2 s, 4 s, then 8 s. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt))
}

function disconnected(state: SessionState): SessionState {
  const attempt = state.attempt + 1
  return {
    ...state,
    phase: "disconnected",
    attempt,
    error: undefined,
    retryInMs: attempt > MAX_ATTEMPTS ? undefined : backoffMs(attempt - 1),
  }
}

export function reduce(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "begin":
      return {
        phase: "loading",
        kind: event.kind,
        id: event.id,
        cursor: event.id !== undefined && event.id === state.id ? state.cursor : 0,
        attempt: 0,
      }
    case "ticket":
      return { ...state, id: event.id }
    case "open":
      return { ...state, phase: "connected", attempt: 0, error: undefined, retryInMs: undefined }
    case "output":
      return { ...state, cursor: state.cursor + event.length }
    case "cursor":
      return { ...state, cursor: event.cursor }
    case "exit":
      return { ...state, phase: "exited", exit: event.exit, error: undefined, retryInMs: undefined }
    case "closed":
      // The host closes 1000 only after an exit frame, so a 1000 with the phase
      // still live means the exit frame was lost: reconnecting reports it.
      if (state.phase === "exited" || state.phase === "error" || state.phase === "idle" || state.phase === "disconnected") return state
      if (event.code === PTY_CLOSE.gone) return { ...state, phase: "exited", exit: undefined, retryInMs: undefined }
      return disconnected(state)
    case "failed":
      // A session the host no longer knows is over, not unreachable.
      if (event.status === 404 && event.problem.code === "gone") return { ...state, phase: "exited", exit: undefined, retryInMs: undefined }
      if (event.network && state.id !== undefined) return disconnected(state)
      return { ...state, phase: "error", error: event.problem, retryInMs: undefined }
    case "retry":
      return { ...state, phase: "loading", attempt: event.manual ? 0 : state.attempt, retryInMs: undefined }
  }
}

/** The button the current state offers, if any. */
export function actionLabel(state: SessionState): "Restart" | "Reconnect" | "Try again" | undefined {
  if (state.phase === "exited") return "Restart"
  if (state.phase === "disconnected") return "Reconnect"
  if (state.phase === "error") return "Try again"
  return undefined
}

/** The text mirrored into the `aria-live` status line. */
export function statusText(state: SessionState): string {
  switch (state.phase) {
    case "idle":
      return "Terminal closed"
    case "loading":
      return state.id === undefined ? "Starting terminal…" : state.attempt > 0 ? "Reconnecting…" : "Connecting…"
    case "connected":
      return "Connected"
    case "exited": {
      const exit = state.exit
      if (!exit) return "Session ended"
      if (exit.signal) return `Exited (${exit.signal})`
      return exit.code === null ? "Exited" : `Exited ${exit.code}`
    }
    case "disconnected":
      return state.retryInMs === undefined
        ? "Disconnected"
        : `Disconnected, retrying in ${Math.max(1, Math.ceil(state.retryInMs / 1000))}s`
    case "error":
      return `Error: ${state.error?.message ?? "the terminal could not start"}`
  }
}

/** The one failure the dock links to settings for: omp is not installed or not new enough. */
export function needsOmpSettings(state: SessionState): boolean {
  return state.phase === "error" && state.error?.code === "omp-unavailable"
}

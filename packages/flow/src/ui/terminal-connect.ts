import type { PtyKind, PtyTicket } from "../../shared/terminal"
import { readProblem } from "./terminal-frames"

/**
 * The dock's asynchronous sequencing, free of DOM and sockets: which session
 * a project remembers, how a ticket reply is accepted only while its attempt
 * is still the current one, and how concurrent emulator loads share one run.
 */

/**
 * Sessions outlive the dock: closing it detaches, opening it attaches again.
 * Keyed by project as well as kind, because a shell or omp session is rooted in
 * the directory it started in: after switching projects, the other project's
 * session must never be reattached.
 */
export function createRemembered() {
  const sessions = new Map<string, string>()
  const key = (project: string, kind: PtyKind) => `${kind}\0${project}`
  return {
    get: (project: string, kind: PtyKind) => sessions.get(key(project, kind)),
    set: (project: string, kind: PtyKind, id: string) => void sessions.set(key(project, kind), id),
    forget: (project: string, kind: PtyKind) => void sessions.delete(key(project, kind)),
  }
}

export type TicketOutcome =
  | { type: "granted"; ticket: PtyTicket }
  | { type: "failed"; status: number; message: string; code?: string }
  | { type: "network" }
  /** The attempt was superseded; `ticket` is a reply that still arrived and was not used. */
  | { type: "stale"; ticket?: PtyTicket }

/**
 * Runs one ticket request and checks `current()` after every await, so a reply
 * to a request the user has since abandoned (kind switch, restart, close)
 * changes nothing. A superseded success hands its ticket back so the caller can
 * dispose a session the stale attempt created.
 */
export async function requestTicket(send: () => Promise<Response>, current: () => boolean): Promise<TicketOutcome> {
  try {
    const response = await send()
    if (!current()) return { type: "stale" }
    if (!response.ok) {
      const problem = await readProblem(response)
      if (!current()) return { type: "stale" }
      return { type: "failed", status: problem.status, message: problem.message, code: problem.code }
    }
    const ticket = (await response.json()) as PtyTicket
    if (!current()) return { type: "stale", ticket }
    return { type: "granted", ticket }
  } catch {
    return current() ? { type: "network" } : { type: "stale" }
  }
}

/** One run of `init` at a time: callers arriving while it runs share its promise; a settled run (either way) lets the next call start again. */
export function singleFlight<T>(init: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => {
    pending ??= init().finally(() => {
      pending = undefined
    })
    return pending
  }
}

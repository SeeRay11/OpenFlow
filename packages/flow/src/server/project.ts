import { ProjectBusyError, type FlowPaths } from "./store"

/** What the page says when it will not switch project itself, because a run of this page is going. */
export const PROJECT_BUSY = "a run is in progress — stop it or wait for it to end before switching project"

/** The question put to the user when the host names cards still holding the project (left by a closed tab, say). */
export function lockQuestion(sessions: string[]) {
  return `${sessions.length} open card session(s) in the current project. Stop them and switch?`
}

/**
 * What to do with a refused switch. The host answers `project-busy` with the
 * ids of the sessions holding the lock: with some named, the user can free the
 * project by stopping them; with none, there is nothing to offer and the host's
 * own sentence is all there is to show. `undefined` is any other failure.
 */
export function onLock(error: unknown) {
  if (!(error instanceof ProjectBusyError)) return undefined
  if (error.sessions.length) return { action: "ask" as const, sessions: error.sessions, question: lockQuestion(error.sessions) }
  return { action: "show" as const, text: error.message }
}

/**
 * Switches the host's project, offering to stop the cards that hold it.
 *
 * `attempt` is the switch itself, `confirm` the user's yes or no and `release`
 * deletes one session. A busy project with named sessions is retried exactly
 * once, after the user said yes and every named session was released; on no
 * nothing happens and `undefined` comes back. Every other refusal is rethrown
 * for the caller to show, the second one included.
 */
export async function switchFreeing(
  attempt: () => Promise<FlowPaths>,
  io: { confirm: (question: string) => boolean; release: (sessionID: string) => Promise<unknown> },
) {
  try {
    return await attempt()
  } catch (error) {
    const lock = onLock(error)
    if (lock?.action !== "ask") throw error
    if (!io.confirm(lock.question)) return undefined
    await Promise.all(lock.sessions.map((id) => io.release(id)))
    return await attempt()
  }
}

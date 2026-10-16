import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { buildSessionTree, type SessionTree, type SessionTreeNode } from "@/pages/session/loop/tree"
import {
  deriveSessionStatus,
  mapEventToStatus,
  unknownIsFresh,
  type LoopEventLike,
  type LoopStatus,
} from "@/pages/session/loop/status"

export type SessionLoopDeps = {
  rootID: Accessor<string | undefined>
  sessions: Accessor<Session[]>
  statusOf: (id: string) => SessionStatus | undefined
  permissionCount: (id: string) => number
  questionCount: (id: string) => number
  subscribe: (handler: (event: LoopEventLike) => void) => () => void
  fetchSessions: () => Promise<Session[]>
  remember: (session: Session) => void
  now?: Accessor<number>
}

const emptyTree: SessionTree = { nodes: [], total: 0, truncated: false }

/**
 * Reactive loop controller for the session hierarchy tab. All external
 * accessors are injected so tests can drive it against a fake store without
 * mounting the app's context providers.
 */
export function createSessionLoopController(deps: SessionLoopDeps) {
  const [eventStatuses, setEventStatuses] = createStore<Record<string, LoopStatus>>({})
  const [ready, setReady] = createSignal(false)
  const [fetchError, setFetchError] = createSignal(false)

  const handleEvent = (event: LoopEventLike) => {
    if (!event.properties.sessionID) return
    const mapped = mapEventToStatus(event)
    // reconcile: a new status replaces the old one outright — a stale
    // `attempt` from a previous retry must not survive into the next state.
    if (mapped) setEventStatuses(event.properties.sessionID, reconcile(mapped))
  }

  // Subscriptions and the directory-wide fallback fetch read the injected
  // deps synchronously, which close over the directory-scoped SDK client —
  // tracking them here re-runs the round when the directory or server changes.
  // Each round cleans up its own subscription via onCleanup.
  let round = 0
  createEffect(() => {
    const current = ++round
    const unsubscribe = deps.subscribe(handleEvent)
    setReady(false)
    setFetchError(false)
    const refresh: Promise<void> = deps
      .fetchSessions()
      .then((sessions) => {
        for (const session of sessions) deps.remember(session)
      })
      .catch(() => {
        if (current === round) setFetchError(true)
      })
      .finally(() => {
        if (current === round) setReady(true)
      })
    onCleanup(() => {
      unsubscribe()
      void refresh
    })
  })

  const tree = createMemo(() => {
    const rootID = deps.rootID()
    if (!rootID) return emptyTree
    return buildSessionTree({ rootID, sessions: deps.sessions() })
  })

  const now = deps.now ?? (() => Date.now())

  const statuses = createMemo(() => {
    const result: Record<string, LoopStatus> = {}
    for (const node of tree().nodes) {
      result[node.session.id] = deriveSessionStatus({
        permissionPending: deps.permissionCount(node.session.id) > 0,
        questionPending: deps.questionCount(node.session.id) > 0,
        eventStatus: eventStatuses[node.session.id],
        storeStatus: deps.statusOf(node.session.id),
        timeCompacting: node.session.time.compacting,
        now: now(),
      })
    }
    return result
  })

  const groups = createMemo(() => {
    const needsInput: SessionTreeNode[] = []
    const working: SessionTreeNode[] = []
    const completed: SessionTreeNode[] = []
    for (const node of tree().nodes) {
      const status = statuses()[node.session.id] ?? { state: "unknown" as const }
      if (status.state === "needs_input") needsInput.push(node)
      else if (
        status.state === "working" ||
        status.state === "retry" ||
        status.state === "compacting"
      )
        working.push(node)
      else if (status.state === "completed") completed.push(node)
      else if (unknownIsFresh(node.session.time.updated, now())) working.push(node)
      else completed.push(node)
    }
    return { needsInput, working, completed }
  })

  return { tree, statuses, groups, ready, fetchError }
}

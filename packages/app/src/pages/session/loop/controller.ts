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
import { parseNextMoveSuggestion } from "@/pages/session/loop/nextMove"

export type SessionLoopDeps = {
  rootID: Accessor<string | undefined>
  sessions: Accessor<Session[]>
  statusOf: (id: string) => SessionStatus | undefined
  permissionCount: (id: string) => number
  questionCount: (id: string) => number
  subscribe: (handler: (event: LoopEventLike) => void) => () => void
  fetchSessions: () => Promise<Session[]>
  remember: (session: Session) => void
  /**
   * Backfill source (Stufe 2): the latest assistant text of a session plus a
   * key identifying that text (message ID). Null = no assistant message;
   * reject/throw = fetch failure (retry on the next effect run).
   */
  lastAssistantText: (sessionID: string) => Promise<{ text: string; textKey: string; at?: number } | null>
  now?: Accessor<number>
}

const emptyTree: SessionTree = { nodes: [], total: 0, truncated: false }

/** Live text-end event of the fork naming space (v2 union: session.next.text.ended). */
const TEXT_ENDED_EVENT = "session.next.text.ended"

/** Cap for displayed NEXT-MOVE cards (spec E4), mirrors the Stufe-1 tree cap style. */
export const NEXT_MOVES_MAX = 10

/** Backfill only the newest completed sessions (spec §2: neueste 10 completed). */
export const NEXT_MOVES_BACKFILL = 10

/**
 * Structural message shape for the backfill picker: what
 * `client.session.messages` returns (`{info, parts}`), narrowed to the fields
 * read here — tests feed plain objects without the SDK union.
 */
export type NextMoveMessageLike = {
  info: { id: string; role?: string; time?: { created?: number } }
  parts: Array<{ type?: string; text?: string }>
}

/**
 * E9: messages are returned oldest-first — pick the LAST assistant message by
 * `time.created` (sorting keeps this correct regardless of API order), then
 * join its text parts. textKey = message ID (dedup, spec E3).
 */
export function pickLastAssistantText(items: NextMoveMessageLike[]): {
  text: string
  textKey: string
  at?: number
} | null {
  const assistants = items
    .filter((item) => item.info?.role === "assistant")
    .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
  const last = assistants[assistants.length - 1]
  if (!last) return null
  const text = last.parts
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
  return { text, textKey: last.info.id, at: last.info.time?.created }
}

export type NextMoveEntry = {
  schritt: string
  textKey: string
  /** Completion time in ms (event timestamp / message time). */
  at: number
  /** Set by consume() — the card stays hidden until a newer textKey arrives. */
  consumed?: boolean
}

/** Display card: the cache entry plus the session it belongs to. */
export type NextMoveCard = NextMoveEntry & { sessionID: string }

/**
 * Reactive loop controller for the session hierarchy tab. All external
 * accessors are injected so tests can drive it against a fake store without
 * mounting the app's context providers.
 */
export function createSessionLoopController(deps: SessionLoopDeps) {
  const [eventStatuses, setEventStatuses] = createStore<Record<string, LoopStatus>>({})
  const [ready, setReady] = createSignal(false)
  const [fetchError, setFetchError] = createSignal(false)
  // NEXT-MOVE queue (Stufe 2): one entry per session (spec E5). textKeys
  // remembers the last seen text per session even when it carried no
  // suggestion, so a repeated identical text never re-shows (spec E3).
  const [nextMoveEntries, setNextMoveEntries] = createStore<Record<string, NextMoveEntry>>({})
  const textKeys = new Map<string, string>()
  const backfillInFlight = new Set<string>()

  const recordNextMove = (sessionID: string, textKey: string, text: string, at?: number) => {
    if (textKeys.get(sessionID) === textKey) return
    textKeys.set(sessionID, textKey)
    const parsed = parseNextMoveSuggestion(text)
    if (!parsed) {
      // gone: a newer text without a (Mensch)-line replaces the old card
      // (spec state machine suggested → gone); consuming stays untouched
      // because replacing the entry drops the consumed flag either way.
      if (nextMoveEntries[sessionID]) setNextMoveEntries(sessionID, undefined!)
      return
    }
    // suggested: replacing the entry must drop a consumed flag — a fresh
    // suggestion may surface again (consumed → gone → suggested). reconcile
    // replaces instead of merging, so the old consumed flag cannot survive.
    setNextMoveEntries(sessionID, reconcile({ schritt: parsed.schritt, textKey, at: at ?? deps.now?.() ?? Date.now() }))
  }

  const handleEvent = (event: LoopEventLike) => {
    if (!event.properties.sessionID) return
    if (event.type === TEXT_ENDED_EVENT) {
      const textID = event.properties.textID ?? (event.properties.timestamp !== undefined ? `t:${event.properties.timestamp}` : undefined)
      if (textID) recordNextMove(event.properties.sessionID, textID, event.properties.text ?? "", event.properties.timestamp)
      return
    }
    const mapped = mapEventToStatus(event)
    // reconcile: a new status replaces the old one outright — a stale
    // `attempt` from a previous retry must not survive into the next state.
    if (mapped) setEventStatuses(event.properties.sessionID, reconcile(mapped))
  }

  const backfillNextMove = async (sessionID: string) => {
    if (textKeys.has(sessionID) || backfillInFlight.has(sessionID)) return
    backfillInFlight.add(sessionID)
    try {
      const found = await deps.lastAssistantText(sessionID)
      // No assistant message: remember an empty key so the effect does not
      // refetch this session on every run; a live event can still override.
      if (!found) {
        textKeys.set(sessionID, `empty:${sessionID}`)
        return
      }
      recordNextMove(sessionID, found.textKey, found.text, found.at)
    } catch {
      // Fetch failure: stay silent, the next effect run retries.
    } finally {
      backfillInFlight.delete(sessionID)
    }
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

  // Backfill (spec §2b): only the newest completed sessions, only sessions
  // whose text was never seen — recordNextMove dedups via textKeys.
  // "Newest" is by session time (updated, else created) — the tree order is
  // structural and does not reflect recency.
  const sessionTime = (node: SessionTreeNode) =>
    node.session.time.updated || node.session.time.created
  createEffect(() => {
    if (!ready()) return
    const newest = [...groups().completed]
      .sort((a, b) => sessionTime(b) - sessionTime(a))
      .slice(0, NEXT_MOVES_BACKFILL)
    for (const node of newest) {
      void backfillNextMove(node.session.id)
    }
  })

  const nextMoves = createMemo(() => {
    // Visibility follows the group assignment (E7): cards show for completed
    // and needs_input sessions — the same unknown-fresh-vs-stale resolution
    // as groups(); working/retry/compacting/unknown-fresh stay hidden.
    const shown = new Set<string>()
    for (const node of groups().completed) shown.add(node.session.id)
    for (const node of groups().needsInput) shown.add(node.session.id)
    const list: NextMoveCard[] = []
    for (const node of tree().nodes) {
      const entry = nextMoveEntries[node.session.id]
      if (!entry || entry.consumed) continue
      if (!shown.has(node.session.id)) continue
      list.push({ ...entry, sessionID: node.session.id })
    }
    return list.sort((a, b) => b.at - a.at).slice(0, NEXT_MOVES_MAX)
  })

  /** Consume a card (user applied it): hidden until a newer textKey arrives. */
  const consumeNextMove = (sessionID: string) => {
    if (nextMoveEntries[sessionID]) setNextMoveEntries(sessionID, "consumed", true)
  }

  return { tree, statuses, groups, nextMoves, consumeNextMove, ready, fetchError }
}

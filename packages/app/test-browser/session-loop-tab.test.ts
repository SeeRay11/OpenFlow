import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { createSessionLoopController, type SessionLoopDeps } from "@/pages/session/loop/controller"
import { UNKNOWN_FRESH_WINDOW_MS } from "@/pages/session/loop/status"

const session = (id: string, parentID?: string, created = 0): Session => ({
  id,
  slug: id,
  projectID: "p1",
  directory: "/dir",
  title: `Title ${id}`,
  version: "1",
  parentID,
  time: { created, updated: created },
})

const NOW = 10_000_000

type Fixture = {
  deps: SessionLoopDeps
  store: { sessions: Session[]; status: Record<string, Session["version"]> }
  permissions: Record<string, number>
  questions: Record<string, number>
  events: { fired: Array<{ type: string; sessionID?: string; properties?: Record<string, unknown> }> }
  fetched: Session[]
}

// Fake sync store in the shape the controller consumes: sessions/status read
// from a mutable record, events collected until a test fires them through the
// dispatch function the subscribe() contract hands back.
function createFixture(initial: Session[] = []): Fixture {
  const sessions = [...initial]
  const status: Record<string, never> = {}
  const permissions: Record<string, number> = {}
  const questions: Record<string, number> = {}
  const handlers = new Set<(event: never) => void>()
  const fetched: Session[] = []

  const fixture: Fixture = {
    fetched,
    store: { sessions, status },
    permissions,
    questions,
    events: {
      fired: [],
    },
    deps: {
      rootID: () => "root",
      sessions: () => sessions,
      statusOf: (id) => status[id],
      permissionCount: (id) => permissions[id] ?? 0,
      questionCount: (id) => questions[id] ?? 0,
      subscribe: (handler) => {
        handlers.add(handler as never)
        return () => handlers.delete(handler as never)
      },
      fetchSessions: () => {
        fetched.push(...sessions)
        return Promise.resolve(sessions)
      },
      remember: () => {},
      now: () => NOW,
    },
  }

  // The dispatch helper lives beside the fixture: emit() mimics the emitter
  // feeding one v2 event at a time.
  ;(fixture as Fixture & { emit: (type: string, properties: Record<string, unknown>) => void }).emit = (
    type,
    properties,
  ) => {
    fixture.events.fired.push({ type, ...properties })
    for (const handler of handlers) {
      handler({ type, properties } as never)
    }
  }

  return fixture
}

const emit = (fixture: Fixture, type: string, properties: Record<string, unknown> = {}) => {
  ;(fixture as Fixture & { emit: (type: string, properties: Record<string, unknown>) => void }).emit(
    type,
    { sessionID: "c1", ...properties },
  )
}

const flush = async () => {
  // One macrotask: drains every pending microtask, including the whole
  // fetch → then → catch → finally chain of the controller's refresh round.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("createSessionLoopController", () => {
  // T-04: mocked store, real controller — the full grouping pipeline.
  test("T-04: builds groups from store + events and refreshes via fetchSessions", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([
        session("root"),
        session("c1", "root", 100),
        session("c2", "root", 200),
        session("c3", "root", 300),
      ])
      fixture.store.status["c1"] = { type: "busy" } as never
      fixture.store.status["c2"] = { type: "idle" } as never
      // c3: no store entry, but updated just now → fresh-unknown → working.
      fixture.store.sessions[3].time.updated = NOW - 1000

      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // Fallback fetch remembered every session.
      expect(fixture.fetched.map((s) => s.id)).toEqual(["root", "c1", "c2", "c3"])

      expect(controller.tree().total).toBe(4)
      // Root has no store entry and a stale update → settled as completed.
      // Group order follows the DFS walk: children newest-first.
      expect(controller.groups().working.map((n) => n.session.id)).toEqual(["c3", "c1"])
      expect(controller.groups().completed.map((n) => n.session.id)).toEqual(["root", "c2"])
      expect(controller.groups().needsInput).toEqual([])

      dispose()
    })
  })

  test("T-04: event fold overrides store, permission pending wins, reply resumes", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      fixture.store.status["c1"] = { type: "idle" } as never

      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // Store said idle, but the run just started → working.
      emit(fixture, "session.execution.started")
      expect(controller.statuses()["c1"]).toEqual({ state: "working" })

      // Permission asked → needs_input, outranking everything.
      emit(fixture, "permission.asked")
      expect(controller.statuses()["c1"]).toEqual({ state: "needs_input" })
      expect(controller.groups().needsInput.map((n) => n.session.id)).toEqual(["c1"])

      // Replied → working again.
      emit(fixture, "permission.replied")
      expect(controller.statuses()["c1"]).toEqual({ state: "working" })

      // Retry event carries the attempt through to the status.
      emit(fixture, "session.next.retried", { attempt: 3 })
      expect(controller.statuses()["c1"]).toEqual({ state: "retry", attempt: 3 })

      // Completion settles the session.
      emit(fixture, "session.next.step.ended")
      expect(controller.statuses()["c1"]).toEqual({ state: "completed" })

      dispose()
    })
  })

  test("T-04: question pending outranks working state; stale unknown completes", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([
        session("root"),
        session("c1", "root", 100),
        session("c2", "root", 200),
      ])
      fixture.store.sessions[1].time.updated = NOW - 10 * UNKNOWN_FRESH_WINDOW_MS
      fixture.store.sessions[2].time.updated = NOW - 100

      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // c1: no store entry, stale update → completed group. c2: fresh → working.
      expect(controller.groups().completed.map((n) => n.session.id)).toEqual(["root", "c1"])
      expect(controller.groups().working.map((n) => n.session.id)).toEqual(["c2"])

      // Question pending flips c2 to needs_input despite the working signal.
      // The plain fixture object is not reactive, so the invalidating event
      // that accompanies a real store write is fired as well.
      fixture.questions["c2"] = 1
      emit(fixture, "session.status", { sessionID: "c2", status: { type: "busy" } })
      expect(controller.groups().needsInput.map((n) => n.session.id)).toEqual(["c2"])

      dispose()
    })
  })

  test("T-04: truncated cluster keeps total counting", async () => {
    await createRoot(async (dispose) => {
      const many = [session("root"), ...Array.from({ length: 59 }, (_, i) => session(`c${i}`, "root", i + 1))]
      const fixture = createFixture(many)

      const controller = createSessionLoopController(fixture.deps)
      await flush()

      expect(controller.tree().nodes.length).toBe(50)
      expect(controller.tree().total).toBe(60)
      expect(controller.tree().truncated).toBe(true)

      dispose()
    })
  })

  // E5: the store drops a session row (session.deleted apply) → the node and
  // its count vanish from the tree. The fixture's deps are overridden with a
  // reactive sessions accessor, mirroring the solid-store read in production.
  test("E5: store delete removes the session's node from the tree", async () => {
    await createRoot(async (dispose) => {
      const [sessions, setSessions] = createSignal<Session[]>([
        session("root"),
        session("c1", "root", 100),
        session("c2", "root", 200),
      ])
      const fixture = createFixture([])
      const deps: SessionLoopDeps = { ...fixture.deps, sessions: () => sessions() }

      const controller = createSessionLoopController(deps)
      await flush()

      expect(controller.ready()).toBe(true)
      expect(controller.tree().total).toBe(3)
      expect(controller.tree().nodes.map((n) => n.session.id)).toEqual(["root", "c2", "c1"])

      setSessions((list) => list.filter((s) => s.id !== "c2"))

      expect(controller.tree().total).toBe(2)
      expect(controller.tree().nodes.map((n) => n.session.id)).toEqual(["root", "c1"])

      dispose()
    })
  })

  // Fallback-fetch failure must surface as fetchError (with ready set), not
  // silently mimic the empty state.
  test("fallback fetch failure sets fetchError while staying ready", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      const deps: SessionLoopDeps = {
        ...fixture.deps,
        fetchSessions: () => Promise.reject(new Error("network down")),
      }

      const controller = createSessionLoopController(deps)
      await flush()

      expect(controller.ready()).toBe(true)
      expect(controller.fetchError()).toBe(true)

      dispose()
    })
  })
})

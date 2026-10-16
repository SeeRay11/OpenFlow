import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { createSessionLoopController, type SessionLoopDeps } from "@/pages/session/loop/controller"
import { nextMoveHref } from "@/pages/session/loop/href"
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

// Vertragszeilen-Beispiele (R14): letzte (Mensch)-Zeile gewinnt, dharma-Fußzeile wird abgezogen.
const MENSCH =
  "\n\nNEXT MOVE (Mensch): PR mergen, nachdem Thomas ihn sich angesehen hat.\n\n⎯⎯ gpt-oss-20b · fast · nvidia ⎯⎯"
const MENSCH_ALT = "\n\nNEXT MOVE (Mensch): Abstimmen mit dem Security-Team, danach mergen."
const KEIN_VERTRAG = "Alle Schritte abgeschlossen, nichts weiter offen.\n\n⎯⎯ gpt-oss-20b · fast · nvidia ⎯⎯"

type LastText = { text: string; textKey: string; at?: number } | null

type Fixture = {
  deps: SessionLoopDeps
  store: { sessions: Session[]; status: Record<string, Session["version"]> }
  permissions: Record<string, number>
  questions: Record<string, number>
  events: { fired: Array<{ type: string; sessionID?: string; properties?: Record<string, unknown> }> }
  fetched: Session[]
  lastTexts: Record<string, LastText>
  lastTextCalls: string[]
  setFailLastText: (v: boolean) => void
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
  const lastTexts: Record<string, LastText> = {}
  const lastTextCalls: string[] = []
  let failLastText = false

  const fixture: Fixture = {
    fetched,
    store: { sessions, status },
    permissions,
    questions,
    events: {
      fired: [],
    },
    lastTexts,
    lastTextCalls,
    setFailLastText: (v) => {
      failLastText = v
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
      lastAssistantText: (sessionID) => {
        lastTextCalls.push(sessionID)
        if (failLastText) return Promise.reject(new Error("down"))
        return Promise.resolve(lastTexts[sessionID] ?? null)
      },
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

  // ---- Stufe 2: NEXT moves (T-03 cache/dedup, T-04 backfill, E4/E5/E7/E9) ----

  test("T-03: shows a card for a (Mensch) line; identical textKey never resurrects a consumed card", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      fixture.store.status["c1"] = { type: "idle" } as never
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      emit(fixture, "session.next.text.ended", { textID: "msg_1", timestamp: 5_000, text: `Arbeit fertig.${MENSCH}` })
      expect(controller.nextMoves().map((c) => c.sessionID)).toEqual(["c1"])
      expect(controller.nextMoves()[0]!.schritt).toBe("PR mergen, nachdem Thomas ihn sich angesehen hat.")
      expect(controller.nextMoves()[0]!.at).toBe(5_000)

      emit(fixture, "session.next.text.ended", { textID: "msg_1", timestamp: 5_000, text: `Arbeit fertig.${MENSCH}` })
      expect(controller.nextMoves().length).toBe(1)

      controller.consumeNextMove("c1")
      expect(controller.nextMoves()).toEqual([])
      emit(fixture, "session.next.text.ended", { textID: "msg_1", timestamp: 5_000, text: `Arbeit fertig.${MENSCH}` })
      expect(controller.nextMoves()).toEqual([])
      dispose()
    })
  })

  test("T-03: a newer text without a contract line clears the card (gone)", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      emit(fixture, "session.next.text.ended", { textID: "msg_1", timestamp: 5_000, text: `fertig.${MENSCH}` })
      expect(controller.nextMoves().length).toBe(1)

      emit(fixture, "session.next.text.ended", { textID: "msg_2", timestamp: 6_000, text: KEIN_VERTRAG })
      expect(controller.nextMoves()).toEqual([])
      dispose()
    })
  })

  test("T-03: the LAST (Mensch) line wins (E5); a fresh textKey replaces the step and re-surfaces after consume", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      const doppelt = `Erster Entwurf.\n\nNEXT MOVE (Mensch): PR mergen, nachdem Thomas ihn sich angesehen hat.${MENSCH_ALT}`
      emit(fixture, "session.next.text.ended", { textID: "msg_1", timestamp: 5_000, text: doppelt })
      expect(controller.nextMoves()[0]!.schritt).toBe("Abstimmen mit dem Security-Team, danach mergen.")

      controller.consumeNextMove("c1")
      emit(fixture, "session.next.text.ended", { textID: "msg_2", timestamp: 6_000, text: `neu${MENSCH}` })
      expect(controller.nextMoves().length).toBe(1)
      expect(controller.nextMoves()[0]!.textKey).toBe("msg_2")
      expect(controller.nextMoves()[0]!.schritt).toBe("PR mergen, nachdem Thomas ihn sich angesehen hat.")
      dispose()
    })
  })

  test("T-03: events without textID/timestamp are ignored", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      emit(fixture, "session.next.text.ended", { text: `x${MENSCH}` })
      expect(controller.nextMoves()).toEqual([])
      dispose()
    })
  })

  test("T-04: backfills only the newest completed sessions and caps the cards (E4)", async () => {
    await createRoot(async (dispose) => {
      const kids = Array.from({ length: 12 }, (_, i) => session(`c${i + 1}`, "root", i + 1))
      const fixture = createFixture([session("root"), ...kids])
      fixture.lastTexts["root"] = { text: `Root done.${MENSCH}`, textKey: "m_root", at: 0 }
      for (let i = 1; i <= 12; i++) {
        fixture.lastTexts[`c${i}`] = { text: `Done ${i}.${MENSCH}`, textKey: `m_${i}`, at: i * 1000 }
      }
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // Backfill picks the newest sessions by session time (updated == created
      // in this fixture): c12…c3. root (time 0) and the two oldest children
      // stay out — structural DFS order no longer decides the cap.
      expect(fixture.lastTextCalls.length).toBe(10)
      expect(fixture.lastTextCalls).toContain("c12")
      expect(new Set(fixture.lastTextCalls).has("root")).toBe(false)
      expect(new Set(fixture.lastTextCalls).has("c1")).toBe(false)
      expect(new Set(fixture.lastTextCalls).has("c2")).toBe(false)

      expect(controller.nextMoves().length).toBe(10)
      expect(controller.nextMoves()[0]).toMatchObject({ sessionID: "c12", at: 12_000 })
      expect(controller.nextMoves()[8]).toMatchObject({ sessionID: "c4", at: 4_000 })
      expect(controller.nextMoves()[9]).toMatchObject({ sessionID: "c3", at: 3_000 })

      // Display cap (E4): 12 live cards resolve to the newest 10 by completion time.
      for (let i = 1; i <= 12; i++) {
        emit(fixture, "session.next.text.ended", { sessionID: `c${i}`, textID: `live_${i}`, timestamp: 20_000 + i, text: `live ${i}.${MENSCH}` })
      }
      expect(controller.nextMoves().length).toBe(10)
      expect(controller.nextMoves()[0]).toMatchObject({ sessionID: "c12", at: 20_012 })
      expect(controller.nextMoves()[9]).toMatchObject({ sessionID: "c3", at: 20_003 })
      dispose()
    })
  })

  test("T-04: hides the card while working, shows it once completed (E7)", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      fixture.store.status["c1"] = { type: "busy" } as never
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // Busy sessions are not backfilled; the settled root is (and yields no card).
      expect(fixture.lastTextCalls).toEqual(["root"])
      emit(fixture, "session.next.text.ended", { textID: "msg_1", timestamp: 5_000, text: `x${MENSCH}` })
      expect(controller.nextMoves()).toEqual([])

      emit(fixture, "session.execution.succeeded")
      expect(controller.nextMoves().map((c) => c.sessionID)).toEqual(["c1"])
      dispose()
    })
  })

  test("T-04: unknown-fresh hides the card until the session settles; needs_input still shows it (E7)", async () => {
    await createRoot(async (dispose) => {
      const kids = [session("c1", "root", 100), session("c2", "root", 200)]
      kids[1].time.updated = NOW
      const fixture = createFixture([session("root"), ...kids])
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // c2 is fresh-unknown → hidden despite a live suggestion.
      emit(fixture, "session.next.text.ended", { sessionID: "c2", textID: "msg_2", timestamp: 5_000, text: `x${MENSCH}` })
      expect(controller.nextMoves()).toEqual([])

      emit(fixture, "session.execution.succeeded", { sessionID: "c2" })
      expect(controller.nextMoves().map((c) => c.sessionID)).toEqual(["c2"])

      // needs_input is not an activity state — the card stays visible.
      emit(fixture, "permission.asked", { sessionID: "c1" })
      emit(fixture, "session.next.text.ended", { sessionID: "c1", textID: "msg_1", timestamp: 6_000, text: `y${MENSCH_ALT}` })
      expect(controller.nextMoves().map((c) => c.sessionID)).toEqual(["c1", "c2"])
      dispose()
    })
  })

  test("T-04: no assistant text — one fetch, no card, no refetch on later rounds (E9)", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // Newest-first by session time: c1 (100) before root (0).
      expect(fixture.lastTextCalls).toEqual(["c1", "root"])
      emit(fixture, "session.execution.succeeded", { sessionID: "c1" })
      await flush()
      // The empty key suppresses the refetch; a live event can still override.
      expect(fixture.lastTextCalls).toEqual(["c1", "root"])
      expect(controller.nextMoves()).toEqual([])
      dispose()
    })
  })

  test("T-04: backfill fetch failure stays silent and retries on the next round", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100)])
      fixture.setFailLastText(true)
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      // Newest-first by session time: c1 (100) before root (0).
      expect(fixture.lastTextCalls).toEqual(["c1", "root"])
      expect(controller.nextMoves()).toEqual([])

      fixture.setFailLastText(false)
      fixture.lastTexts["c1"] = { text: `x${MENSCH}`, textKey: "m_1", at: 1234 }
      emit(fixture, "session.execution.succeeded", { sessionID: "c1" })
      await flush()
      // Both sessions failed on the first pass, so both retry on the next round.
      expect(fixture.lastTextCalls).toEqual(["c1", "root", "c1", "root"])
      expect(controller.nextMoves().map((c) => c.sessionID)).toEqual(["c1"])
      dispose()
    })
  })

  test("T-04: cards are per session (E5) — consuming one leaves the others", async () => {
    await createRoot(async (dispose) => {
      const fixture = createFixture([session("root"), session("c1", "root", 100), session("c2", "root", 200)])
      fixture.lastTexts["c1"] = { text: `x${MENSCH}`, textKey: "m_1", at: 1000 }
      fixture.lastTexts["c2"] = { text: `y${MENSCH_ALT}`, textKey: "m_2", at: 2000 }
      const controller = createSessionLoopController(fixture.deps)
      await flush()

      expect(controller.nextMoves().map((c) => c.sessionID)).toEqual(["c2", "c1"])
      controller.consumeNextMove("c2")
      expect(controller.nextMoves().map((c) => c.sessionID)).toEqual(["c1"])
      dispose()
    })
  })
})

// T-05 (section + action): the component itself cannot be mounted in this
// suite — bun transforms solid TSX as React JSX ("React is not defined"), so
// no DOM rendering is possible here. The section renders straight from
// controller.nextMoves(), whose card data (session/step/time, E7 hiding,
// E4 cap) the tests above drive through mock store + events; the [Apply]
// action is the pure href builder verified below.
describe("T-05: next-move section and [Apply] action", () => {
  test("[Apply] builds the prefill href on the session root route (no session ID, no auto-send)", () => {
    const schritt = "PR mergen, nachdem Thomas ihn sich angesehen hat."
    const prompt = encodeURIComponent(schritt)

    const href = nextMoveHref({ schritt, directory: "/dir" })
    expect(href).toBe(`/${base64Encode("/dir")}/session?prompt=${prompt}`)
  })

  test("[Apply] href targets the root route the composer consumes (no ID segment)", () => {
    const href = nextMoveHref({ schritt: "x", directory: "/dir" })
    expect(href).not.toMatch(/\/session\//)
    expect(href.endsWith("/session?prompt=x")).toBe(true)
  })

  test("[Apply] survives steps that carry query-looking characters", () => {
    const schritt = "Run `bun test --grep 'a&b=c'` and check ?prompt= handling"
    const href = nextMoveHref({ schritt, directory: "/dir" })
    expect(href.endsWith(`?prompt=${encodeURIComponent(schritt)}`)).toBe(true)
  })
})

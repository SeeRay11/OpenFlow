import { describe, expect, test } from "bun:test"
import {
  UNKNOWN_FRESH_WINDOW_MS,
  deriveSessionStatus,
  mapEventToStatus,
  unknownIsFresh,
  type LoopEventLike,
} from "./status"

const event = (type: string, properties: LoopEventLike["properties"] = {}): LoopEventLike => ({
  type,
  properties: { sessionID: "s1", ...properties },
})

describe("mapEventToStatus", () => {
  test("maps session.status busy/retry/idle", () => {
    expect(mapEventToStatus(event("session.status", { status: { type: "busy" } }))).toEqual({ state: "working" })
    expect(
      mapEventToStatus(event("session.status", { status: { type: "retry", attempt: 3, message: "x", next: 1 } })),
    ).toEqual({ state: "retry", attempt: 3 })
    expect(mapEventToStatus(event("session.status", { status: { type: "idle" } }))).toEqual({ state: "completed" })
    expect(mapEventToStatus(event("session.status"))).toBeUndefined()
  })

  test("maps retry, execution and step events", () => {
    // Not part of the v2 event union and not emitted by the fork server —
    // retry reaches this tab via session.status/session.next.retried instead.
    expect(mapEventToStatus(event("session.retry.scheduled", { attempt: 2 }))).toBeUndefined()
    expect(mapEventToStatus(event("session.next.retried", { attempt: 5 }))).toEqual({ state: "retry", attempt: 5 })
    expect(mapEventToStatus(event("session.execution.started"))).toEqual({ state: "working" })
    expect(mapEventToStatus(event("session.next.step.started"))).toEqual({ state: "working" })
    for (const type of [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.idle",
      "session.next.step.ended",
      "session.next.step.failed",
    ]) {
      expect(mapEventToStatus(event(type))).toEqual({ state: "completed" })
    }
  })

  test("maps permission and question events", () => {
    expect(mapEventToStatus(event("permission.asked"))).toEqual({ state: "needs_input" })
    expect(mapEventToStatus(event("question.asked"))).toEqual({ state: "needs_input" })
    expect(mapEventToStatus(event("permission.replied"))).toEqual({ state: "working" })
    expect(mapEventToStatus(event("question.replied"))).toEqual({ state: "working" })
    expect(mapEventToStatus(event("question.rejected"))).toEqual({ state: "working" })
  })

  test("returns undefined for unrelated events", () => {
    expect(mapEventToStatus(event("session.updated"))).toBeUndefined()
    expect(mapEventToStatus(event("message.updated"))).toBeUndefined()
  })
})

describe("deriveSessionStatus", () => {
  // T-02: a live sequence — run starts, permission blocks, reply resumes,
  // run finishes. Each stage must reflect the expected state.
  test("T-02: busy → asked → replied → succeeded sequence", () => {
    const working = deriveSessionStatus({ eventStatus: mapEventToStatus(event("session.status", { status: { type: "busy" } }))! })
    expect(working.state).toBe("working")

    const asked = deriveSessionStatus({
      permissionPending: true,
      eventStatus: mapEventToStatus(event("permission.asked"))!,
    })
    expect(asked.state).toBe("needs_input")

    const replied = deriveSessionStatus({
      permissionPending: false,
      eventStatus: mapEventToStatus(event("permission.replied"))!,
    })
    expect(replied.state).toBe("working")

    const done = deriveSessionStatus({
      eventStatus: mapEventToStatus(event("session.execution.succeeded"))!,
    })
    expect(done.state).toBe("completed")
  })

  test("T-02: empty inputs derive unknown — no fake idle", () => {
    expect(deriveSessionStatus({})).toEqual({ state: "unknown" })
    expect(deriveSessionStatus({ storeStatus: undefined })).toEqual({ state: "unknown" })
  })

  test("pending question outranks a folded event status", () => {
    expect(
      deriveSessionStatus({
        questionPending: true,
        eventStatus: { state: "working" },
        storeStatus: { type: "busy" },
      }).state,
    ).toBe("needs_input")
  })

  test("event status outranks store status", () => {
    expect(
      deriveSessionStatus({ eventStatus: { state: "working" }, storeStatus: { type: "idle" } }).state,
    ).toBe("working")
  })

  test("store status fallback maps busy/retry/idle with attempt", () => {
    expect(deriveSessionStatus({ storeStatus: { type: "busy" } })).toEqual({ state: "working" })
    expect(deriveSessionStatus({ storeStatus: { type: "retry", attempt: 4, message: "x", next: 1 } })).toEqual({
      state: "retry",
      attempt: 4,
    })
    expect(deriveSessionStatus({ storeStatus: { type: "idle" } })).toEqual({ state: "completed" })
  })
})

describe("unknownIsFresh", () => {
  test("counts sessions updated inside the window as fresh", () => {
    const now = 1_000_000
    expect(unknownIsFresh(now - UNKNOWN_FRESH_WINDOW_MS + 1, now)).toBe(true)
    expect(unknownIsFresh(now - UNKNOWN_FRESH_WINDOW_MS, now)).toBe(false)
    expect(unknownIsFresh(now - 10 * UNKNOWN_FRESH_WINDOW_MS, now)).toBe(false)
    expect(unknownIsFresh(undefined, now)).toBe(false)
  })
})

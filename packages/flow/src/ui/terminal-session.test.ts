import { describe, expect, test } from "bun:test"
import { PTY_CLOSE } from "../../shared/terminal"
import { MAX_ATTEMPTS, actionLabel, backoffMs, initialState, needsOmpSettings, reduce, statusText } from "./terminal-session"
import type { SessionEvent, SessionState } from "./terminal-session"

const run = (events: SessionEvent[], from: SessionState = initialState("omp")) => events.reduce(reduce, from)

const connected = () => run([{ type: "begin", kind: "omp" }, { type: "ticket", id: "s1" }, { type: "open" }])

describe("the happy path", () => {
  test("idle -> loading (create) -> ticket -> open -> output advances the cursor", () => {
    expect(initialState("shell")).toMatchObject({ phase: "idle", kind: "shell", cursor: 0 })
    const loading = run([{ type: "begin", kind: "omp" }])
    expect(loading).toMatchObject({ phase: "loading", id: undefined, cursor: 0, attempt: 0 })
    expect(statusText(loading)).toBe("Starting terminal…")

    const live = run([{ type: "ticket", id: "s1" }, { type: "open" }, { type: "output", length: 10 }, { type: "output", length: 5 }], loading)
    expect(live).toMatchObject({ phase: "connected", id: "s1", cursor: 15 })
    expect(statusText(live)).toBe("Connected")
  })

  test("the server's cursor frame replaces the local count", () => {
    const live = run([{ type: "output", length: 100 }, { type: "cursor", cursor: 96 }], connected())
    expect(live.cursor).toBe(96)
  })
})

describe("reconnect", () => {
  test("a dropped socket retries with backoff and resumes from the cursor, then the attempt count resets", () => {
    let state = run([{ type: "output", length: 500 }], connected())
    const delays: (number | undefined)[] = []
    for (let i = 0; i < 4; i++) {
      state = reduce(state, { type: "closed", code: 1006 })
      expect(state).toMatchObject({ phase: "disconnected", id: "s1", cursor: 500 })
      delays.push(state.retryInMs)
      state = reduce(state, { type: "retry" })
      expect(state.phase).toBe("loading")
      expect(statusText(state)).toBe("Reconnecting…")
    }
    expect(delays).toEqual([250, 500, 1000, 2000])

    state = run([{ type: "ticket", id: "s1" }, { type: "open" }], state)
    expect(state).toMatchObject({ phase: "connected", attempt: 0, cursor: 500 })
  })

  test("backoff caps at 8 s and automatic retry stops after MAX_ATTEMPTS, leaving a manual Reconnect", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000, 8000])
    let state = connected()
    for (let i = 0; i < MAX_ATTEMPTS; i++) state = reduce(reduce(state, { type: "closed", code: 1006 }), { type: "retry" })
    expect(state.retryInMs).toBeUndefined()
    state = reduce(state, { type: "closed", code: 1006 })
    expect(state).toMatchObject({ phase: "disconnected", retryInMs: undefined })
    expect(statusText(state)).toBe("Disconnected")
    expect(actionLabel(state)).toBe("Reconnect")

    state = reduce(state, { type: "retry", manual: true })
    expect(state).toMatchObject({ phase: "loading", attempt: 0, id: "s1" })
  })

  test("a slow-consumer close (1013) is just another reconnect", () => {
    expect(reduce(connected(), { type: "closed", code: 1013 })).toMatchObject({ phase: "disconnected", retryInMs: 250 })
  })

  test("the status line counts the retry in whole seconds", () => {
    const state = run([{ type: "closed", code: 1006 }, { type: "retry" }, { type: "closed", code: 1006 }, { type: "retry" }, { type: "closed", code: 1006 }], connected())
    expect(statusText(state)).toBe("Disconnected, retrying in 1s")
    expect(statusText(reduce(connected(), { type: "closed", code: 1006 }))).toBe("Disconnected, retrying in 1s")
  })

  test("a network failure asking for a ticket on a known session retries; on a new one it is an error", () => {
    const retrying = reduce(connected(), { type: "failed", problem: { message: "offline" }, network: true })
    expect(retrying).toMatchObject({ phase: "disconnected", retryInMs: 250 })

    const creating = run([{ type: "begin", kind: "omp" }, { type: "failed", problem: { message: "offline" }, network: true }])
    expect(creating).toMatchObject({ phase: "error", error: { message: "offline" } })
    expect(actionLabel(creating)).toBe("Try again")
  })

  test("a close while already disconnected, exited or failed changes nothing", () => {
    const down = reduce(connected(), { type: "closed", code: 1006 })
    expect(reduce(down, { type: "closed", code: 1006 })).toBe(down)
    const exited = run([{ type: "exit", exit: { code: 0, signal: null } }], connected())
    expect(reduce(exited, { type: "closed", code: PTY_CLOSE.normal })).toBe(exited)
    const failed = run([{ type: "begin", kind: "omp" }, { type: "failed", problem: { message: "no" }, status: 409 }])
    expect(reduce(failed, { type: "closed", code: 1006 })).toBe(failed)
  })
})

describe("exit", () => {
  test("an exit frame ends the session, names the code, and offers Restart", () => {
    const state = run([{ type: "exit", exit: { code: 1, signal: null } }, { type: "closed", code: PTY_CLOSE.normal }], connected())
    expect(state).toMatchObject({ phase: "exited", exit: { code: 1, signal: null } })
    expect(statusText(state)).toBe("Exited 1")
    expect(actionLabel(state)).toBe("Restart")
  })

  test("a signal wins over the code in the wording; no info at all still reads sensibly", () => {
    expect(statusText(run([{ type: "exit", exit: { code: 0, signal: "SIGHUP" } }], connected()))).toBe("Exited (SIGHUP)")
    expect(statusText(run([{ type: "exit", exit: { code: null, signal: null } }], connected()))).toBe("Exited")
    expect(statusText(reduce(connected(), { type: "closed", code: PTY_CLOSE.gone }))).toBe("Session ended")
  })

  test("restart is a begin without an id: a new session, cursor and exit cleared", () => {
    const exited = run([{ type: "output", length: 900 }, { type: "exit", exit: { code: 2, signal: null } }], connected())
    const again = reduce(exited, { type: "begin", kind: "omp" })
    expect(again).toEqual({ phase: "loading", kind: "omp", id: undefined, cursor: 0, attempt: 0 })
  })

  test("switching kind starts clean; resuming the same id keeps the cursor, another id does not", () => {
    const live = run([{ type: "output", length: 40 }], connected())
    expect(reduce(live, { type: "begin", kind: "shell" })).toMatchObject({ kind: "shell", id: undefined, cursor: 0 })
    expect(reduce(live, { type: "begin", kind: "omp", id: "s1" }).cursor).toBe(40)
    expect(reduce(live, { type: "begin", kind: "omp", id: "other" }).cursor).toBe(0)
  })

  test("a session the host forgot is over, not unreachable", () => {
    const state = reduce(connected(), { type: "failed", status: 404, problem: { message: "no such terminal", code: "gone" } })
    expect(state).toMatchObject({ phase: "exited", exit: undefined })
    expect(statusText(state)).toBe("Session ended")
  })
})

describe("errors", () => {
  test("a spawn failure carries the server's message verbatim", () => {
    const state = run([
      { type: "begin", kind: "omp" },
      { type: "failed", status: 500, problem: { message: "could not start the terminal: File not found: omp", code: "spawn-failed" } },
    ])
    expect(state.phase).toBe("error")
    expect(statusText(state)).toBe("Error: could not start the terminal: File not found: omp")
    expect(needsOmpSettings(state)).toBe(false)
  })

  test("omp missing links to settings and nothing else does", () => {
    const state = run([
      { type: "begin", kind: "omp" },
      { type: "failed", status: 409, problem: { message: "omp is not installed", code: "omp-unavailable" } },
    ])
    expect(needsOmpSettings(state)).toBe(true)
    expect(statusText(state)).toBe("Error: omp is not installed")
    expect(needsOmpSettings(connected())).toBe(false)
    expect(needsOmpSettings(run([{ type: "begin", kind: "omp" }, { type: "failed", status: 403, problem: { message: "no", code: "bad-origin" } }]))).toBe(false)
  })

  test("try again from an error is a fresh begin", () => {
    const failed = run([{ type: "begin", kind: "omp" }, { type: "failed", problem: { message: "x" }, status: 500 }])
    const again = reduce(failed, { type: "begin", kind: "omp" })
    expect(again.phase).toBe("loading")
    expect(again.error).toBeUndefined()
  })

  test("idle, loading and connected offer no button", () => {
    expect(actionLabel(initialState("omp"))).toBeUndefined()
    expect(actionLabel(reduce(initialState("omp"), { type: "begin", kind: "omp" }))).toBeUndefined()
    expect(actionLabel(connected())).toBeUndefined()
    expect(statusText(initialState("omp"))).toBe("Terminal closed")
  })
})

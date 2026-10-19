import { describe, expect, test } from "bun:test"
import type { BusEvent } from "../../shared/engine"
import { keepSubscribed } from "./stream"

/** A subscribe whose every attempt is scripted: deliver these events, then fail, end, or stay open until abort. */
function script(attempts: { events?: BusEvent[]; end?: "reject" | "resolve" | "open" }[]) {
  let calls = 0
  const subscribe = async (onEvent: (event: BusEvent) => void, signal: AbortSignal) => {
    const attempt = attempts[calls++] ?? { end: "open" }
    for (const event of attempt.events ?? []) onEvent(event)
    if (attempt.end === "reject") throw new Error("connection closed")
    if (attempt.end === "resolve" || signal.aborted) return
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
  }
  return { subscribe, calls: () => calls }
}

/** Records each delay and returns at once; `after` runs on the n-th wait (1-based), e.g. to abort. */
function waits(after: (count: number) => void = () => {}) {
  const delays: number[] = []
  return {
    delays,
    wait: async (ms: number) => {
      delays.push(ms)
      after(delays.length)
    },
  }
}

const event = (type: string): BusEvent => ({ type })

describe("keepSubscribed", () => {
  test("re-subscribes after a rejection and after a clean end, delivering every stream's events", async () => {
    const controller = new AbortController()
    const source = script([{ events: [event("a")], end: "reject" }, { events: [event("b")], end: "resolve" }, { events: [event("c")] }])
    const seen: string[] = []
    const timer = waits()

    await keepSubscribed(
      source.subscribe,
      (e) => {
        seen.push(e.type)
        if (e.type === "c") controller.abort()
      },
      controller.signal,
      { base: 10, cap: 100, wait: timer.wait },
    )

    expect(seen).toEqual(["a", "b", "c"])
    expect(source.calls()).toBe(3)
  })

  test("the delay doubles while attempts fail, stops at the cap, and starts over after an event", async () => {
    const controller = new AbortController()
    const source = script([
      { end: "reject" },
      { end: "reject" },
      { end: "reject" },
      { end: "reject" },
      { end: "reject" },
      { events: [event("alive")], end: "reject" },
      { end: "reject" },
    ])
    const timer = waits((count) => count === 7 && controller.abort())

    await keepSubscribed(source.subscribe, () => {}, controller.signal, { base: 10, cap: 50, wait: timer.wait })

    expect(timer.delays).toEqual([10, 20, 40, 50, 50, 10, 20])
  })

  test("an abort during the delay ends the loop without another attempt", async () => {
    const controller = new AbortController()
    const source = script([{ end: "reject" }])
    const timer = waits(() => controller.abort())

    await keepSubscribed(source.subscribe, () => {}, controller.signal, { base: 10, cap: 50, wait: timer.wait })

    expect(source.calls()).toBe(1)
  })

  test("an already aborted signal never subscribes", async () => {
    const controller = new AbortController()
    controller.abort()
    const source = script([{ end: "reject" }])

    await keepSubscribed(source.subscribe, () => {}, controller.signal)

    expect(source.calls()).toBe(0)
  })

  test("the real timer is cut short by the abort", async () => {
    const controller = new AbortController()
    const source = script([{ end: "reject" }])
    const done = keepSubscribed(source.subscribe, () => {}, controller.signal, { base: 60_000, cap: 60_000 })
    await Promise.resolve()
    controller.abort()

    await done

    expect(source.calls()).toBe(1)
  })
})

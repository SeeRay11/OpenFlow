import { describe, expect, test } from "bun:test"
import { latest } from "./latest"

describe("latest", () => {
  test("only the newest call is current", () => {
    const calls = latest()
    const first = calls.begin()
    expect(first()).toBe(true)
    const second = calls.begin()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  test("an older answer arriving last does not overwrite a newer one", async () => {
    const calls = latest()
    let shown = ""
    const slow = Promise.withResolvers<string>()
    const read = async (answer: Promise<string>) => {
      const current = calls.begin()
      const value = await answer
      if (current()) shown = value
    }
    const older = read(slow.promise)
    await read(Promise.resolve("new"))
    slow.resolve("old")
    await older

    expect(shown).toBe("new")
  })

  test("cancel makes a call in flight stale without starting another", () => {
    const calls = latest()
    const call = calls.begin()
    calls.cancel()
    expect(call()).toBe(false)
    expect(calls.begin()()).toBe(true)
  })
})

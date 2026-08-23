import { afterEach, describe, expect, test } from "bun:test"
import { parseZenModels, resetZenCache, zenModels } from "./zen"

const real = globalThis.fetch

function stub(handler: () => Promise<Response> | Response) {
  globalThis.fetch = (() => Promise.resolve(handler())) as unknown as typeof fetch
}

function list(ids: string[]) {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  globalThis.fetch = real
  resetZenCache()
})

describe("parseZenModels", () => {
  test("reads the OpenAI-shaped list", () => {
    expect(parseZenModels({ object: "list", data: [{ id: "gpt-5" }, { id: "kimi-k3" }] })).toEqual(["gpt-5", "kimi-k3"])
  })

  test("ignores entries without a usable id rather than yielding empty strings", () => {
    expect(parseZenModels({ data: [{ id: "gpt-5" }, {}, { id: 7 }, { id: "" }, null] })).toEqual(["gpt-5"])
  })

  test("keeps zen's paid ids alongside the free ones", () => {
    // The list answers "does zen still serve this", nothing more. Both halves
    // have to survive: the free ids so a keyless install can run something, the
    // paid ids so a stored zen key still reaches what it paid for. Deciding
    // which is which is `isFreeModel`'s job, not the list's.
    expect(parseZenModels({ data: [{ id: "claude-opus-5" }, { id: "nemotron-3.5-lightning-free" }] })).toEqual([
      "claude-opus-5",
      "nemotron-3.5-lightning-free",
    ])
  })

  test("anything that is not a list reads as no answer at all", () => {
    expect(parseZenModels({})).toEqual([])
    expect(parseZenModels({ data: "nope" })).toEqual([])
    expect(parseZenModels(undefined)).toEqual([])
  })
})

describe("zenModels", () => {
  test("returns what zen serves", async () => {
    stub(() => list(["gpt-5", "claude-opus-5"]))
    expect(await zenModels()).toEqual(["gpt-5", "claude-opus-5"])
  })

  test("caches, then re-reads once the window has passed", async () => {
    let calls = 0
    stub(() => {
      calls += 1
      return list([`model-${calls}`])
    })
    const first = await zenModels({ now: 0 })
    expect(await zenModels({ now: 60_000 })).toEqual(first)
    expect(calls).toBe(1)
    expect(await zenModels({ now: 11 * 60_000 })).toEqual(["model-2"])
  })

  test("a network failure answers undefined, never an empty list", async () => {
    // Undefined leaves the catalog alone; an empty list would delete every zen
    // model from the picker the moment opencode.ai is unreachable.
    stub(() => {
      throw new Error("offline")
    })
    expect(await zenModels()).toBeUndefined()
  })

  test("an error status answers undefined too", async () => {
    stub(() => new Response("nope", { status: 503 }))
    expect(await zenModels()).toBeUndefined()
  })

  test("a failure after a good read keeps serving the last known list", async () => {
    stub(() => list(["gpt-5"]))
    await zenModels({ now: 0 })
    stub(() => {
      throw new Error("offline")
    })
    expect(await zenModels({ now: 11 * 60_000 })).toEqual(["gpt-5"])
  })

  test("an empty list is treated as no answer — zen always serves something", async () => {
    stub(() => list([]))
    expect(await zenModels()).toBeUndefined()
  })
})

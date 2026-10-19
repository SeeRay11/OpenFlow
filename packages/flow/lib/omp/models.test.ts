import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { HttpError } from "../host/respond"
import { buildLaunch, PROBE_MODEL } from "./launch"
import { createModelCatalog, toModelInfo } from "./models"
import { createHarness, rpcError, type Harness } from "./testing/fake-process"

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.cleanup()
})

const SONNET = { id: "claude-sonnet-5-5", name: "Claude Sonnet", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
const FREE = { id: "free-1", name: "Free", provider: "openrouter", reasoning: false, input: ["text"], contextWindow: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }

function catalog(options: { ttlMs?: number } = {}) {
  return createModelCatalog(h.deps, options)
}

describe("mapping", () => {
  test("provider, id, name, reasoning, context window, modalities and per-million cost", () => {
    expect(toModelInfo(SONNET)).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet",
      reasoning: true,
      contextWindow: 1_000_000,
      capabilities: { input: ["text", "image"] },
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
    })
  })

  test("an all-zero cost is unpriced, never free: the field is absent", () => {
    const info = toModelInfo(FREE)
    expect(info).toBeDefined()
    expect("cost" in (info as object)).toBe(false)
  })

  test("entries without a provider or id are dropped", () => {
    expect(toModelInfo({ id: "x" })).toBeUndefined()
    expect(toModelInfo({ provider: "p" })).toBeUndefined()
    expect(toModelInfo("nope")).toBeUndefined()
  })
})

// The harness' omp is a `#!/bin/sh` script the catalog executes for its version probe; Windows cannot run that.
describe.skipIf(process.platform === "win32")("catalog", () => {
  test("reads get_available_models from a throwaway process in a temp directory, then closes it and removes the directory", async () => {
    h.fake.setup((proc) => proc.on("get_available_models", { models: [SONNET, FREE, SONNET] }))
    const models = await catalog().list()
    expect(models.map((model) => `${model.providerID}/${model.id}`)).toEqual(["anthropic/claude-sonnet-5-5", "openrouter/free-1"])
    expect(h.fake.procs).toHaveLength(1)
    expect(h.fake.procs[0]?.closeCalls).toBe(1)
    expect(h.fake.procs[0]?.of("get_available_models")).toHaveLength(1)
    const input = h.launches[0]
    expect(input?.session.runId).toBe("models")
    expect(await fs.stat(input?.session.directory as string).catch(() => undefined)).toBeUndefined()
  })

  test("the catalog process launches with --model set to the probe model, so omp starts on a profile with no default model", async () => {
    h.fake.setup((proc) => proc.on("get_available_models", { models: [SONNET] }))
    await catalog().list()
    const input = h.launches[0]
    expect(input?.session.model).toBe(PROBE_MODEL)
    const argv = buildLaunch(input as NonNullable<typeof input>).argv
    expect(argv[argv.indexOf("--model") + 1]).toBe(PROBE_MODEL)
  })

  test("concurrent callers share one flight; later callers hit the cache", async () => {
    const release = Promise.withResolvers<void>()
    const asked = Promise.withResolvers<void>()
    h.fake.setup((proc) =>
      proc.on("get_available_models", async () => {
        asked.resolve()
        await release.promise
        return { models: [SONNET] }
      }),
    )
    const models = catalog()
    const first = models.list()
    const second = models.list()
    await asked.promise
    release.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(await models.list()).toBe(a)
    expect(h.fake.procs).toHaveLength(1)
  })

  test("dispose kills the omp process of a read in flight, the caller gets a 503, and later lists are refused without a spawn", async () => {
    const asked = Promise.withResolvers<void>()
    h.fake.setup((proc) =>
      proc.on("get_available_models", async () => {
        asked.resolve()
        await proc.exited
        throw rpcError("get_available_models", "omp exited before answering")
      }),
    )
    const models = catalog()
    const reading = models.list().then(
      () => undefined,
      (error: unknown) => error,
    )
    await asked.promise
    await models.dispose()

    expect(h.fake.procs[0]?.killCalls).toBe(1)
    expect(await reading).toMatchObject({ status: 503 })
    const later = await models.list().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(later).toMatchObject({ status: 503 })
    expect(h.fake.procs).toHaveLength(1)
  })

  test("the cache expires", async () => {
    h.fake.setup((proc) => proc.on("get_available_models", { models: [SONNET] }))
    const models = catalog({ ttlMs: 0 })
    await models.list()
    await models.list()
    expect(h.fake.procs).toHaveLength(2)
    expect(h.fake.procs.every((proc) => proc.closeCalls === 1)).toBe(true)
  })

  test("a changed credential stamp re-reads the catalog; an unchanged one is served from the cache", async () => {
    h.fake.setup((proc) => proc.on("get_available_models", { models: [SONNET] }))
    let stamp = "1:10|"
    const models = createModelCatalog({ ...h.deps, stamp: async () => stamp })
    await models.list()
    await models.list()
    expect(h.fake.procs).toHaveLength(1)
    stamp = "2:20|"
    await models.list()
    expect(h.fake.procs).toHaveLength(2)
    await models.list()
    expect(h.fake.procs).toHaveLength(2)
  })

  test("a stamp that throws counts as an empty stamp", async () => {
    h.fake.setup((proc) => proc.on("get_available_models", { models: [SONNET] }))
    let broken = true
    const models = createModelCatalog({
      ...h.deps,
      async stamp() {
        if (broken) throw new Error("no profile directory")
        return ""
      },
    })
    await models.list()
    await models.list()
    expect(h.fake.procs).toHaveLength(1)
    // Empty and thrown are the same key: the answer cached under one is served under the other.
    broken = false
    await models.list()
    expect(h.fake.procs).toHaveLength(1)
  })

  test("reset forgets the cached answer even when the stamp is unchanged, and drops a read already in flight", async () => {
    const release = Promise.withResolvers<void>()
    const asked = Promise.withResolvers<void>()
    h.fake.setup((proc, index) =>
      proc.on("get_available_models", async () => {
        if (index === 0) {
          asked.resolve()
          await release.promise
        }
        return { models: [SONNET] }
      }),
    )
    const models = createModelCatalog({ ...h.deps, stamp: async () => "same" })
    const stale = models.list()
    await asked.promise
    models.reset()
    release.resolve()
    await stale
    // The flight that started before the reset was not cached.
    await models.list()
    expect(h.fake.procs).toHaveLength(2)
    await models.list()
    expect(h.fake.procs).toHaveLength(2)
    models.reset()
    await models.list()
    expect(h.fake.procs).toHaveLength(3)
  })

  test("a failure is a 502 with actionable text, closes the process, and is never cached", async () => {
    h.fake.setup((proc, index) =>
      proc.on("get_available_models", () => {
        if (index === 0) throw rpcError("get_available_models", "provider discovery timed out")
        return { models: [SONNET] }
      }),
    )
    const models = catalog()
    const error = await models.list().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(502)
    expect((error as HttpError).message).toContain("provider discovery timed out")
    expect((error as HttpError).message).toContain("omp models")
    expect(h.fake.procs[0]?.closeCalls).toBe(1)
    expect(await models.list()).toHaveLength(1)
    expect(h.fake.procs).toHaveLength(2)
  })

  test("a process that never becomes ready is a 502 naming its stderr", async () => {
    h.fake.next({ readyFails: "boom: bad profile" })
    const error = await catalog().list().catch((caught: unknown) => caught)
    expect((error as HttpError).status).toBe(502)
    expect((error as HttpError).message).toContain("bad profile")
  })

  test("a process that hangs before ready is killed and answered as 502 omp-not-ready, and the next read is not wedged behind it", async () => {
    h.fake.next({ holdReady: true })
    const models = createModelCatalog(h.deps, { readyTimeoutMs: 20 })
    const error = await models.list().catch((caught: unknown) => caught)
    expect((error as HttpError).status).toBe(502)
    expect((error as HttpError).code).toBe("omp-not-ready")
    expect(h.fake.procs[0]?.exitedNow).toBe(true)
    h.fake.setup((proc) => proc.on("get_available_models", { models: [SONNET] }))
    expect(await models.list()).toHaveLength(1)
    expect(h.fake.procs).toHaveLength(2)
  })

  test("an omp that is not installed is a 503 omp-unavailable and spawns nothing", async () => {
    const missing = await createHarness({ binary: false })
    try {
      const error = await createModelCatalog(missing.deps).list().catch((caught: unknown) => caught)
      expect((error as HttpError).status).toBe(503)
      expect((error as HttpError).code).toBe("omp-unavailable")
      expect(missing.fake.procs).toHaveLength(0)
    } finally {
      await missing.cleanup()
    }
  })
})

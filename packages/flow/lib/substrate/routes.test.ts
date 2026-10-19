import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MemoryReadResult, MemoryStatus, MemoryWriteResult } from "../../shared/memory"
import { MEMORY_ROUTES } from "../../shared/memory"
import { DEFAULT_OMP_SETTINGS } from "../../shared/omp"
import { createSubstrate, type SubstrateModule } from "./index"
import type { FakeSubstrate } from "./testing/fake-substrate"
import { startFakeSubstrate } from "./testing/fake-substrate"

let dir: string
let fake: FakeSubstrate
let substrate: SubstrateModule

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flow-substrate-routes-"))
  fake = startFakeSubstrate()
  substrate = createSubstrate({
    project: () => dir,
    settings: async () => ({
      ...DEFAULT_OMP_SETTINGS,
      memory: { ...DEFAULT_OMP_SETTINGS.memory, repo: "acme/widgets" },
      substrate: { url: fake.url },
    }),
    env: { SUBSTRATE_TOKEN: fake.token, OPENFLOW_STATE_DIR: join(dir, "state") },
    now: fake.now,
  })
})

afterEach(async () => {
  await substrate.dispose()
  await fake.stop()
  await rm(dir, { recursive: true, force: true })
})

function call(path: string, init?: { method?: string; body?: unknown }): Promise<Response | undefined> {
  return substrate.handle(
    new Request(`http://flow.test${path}`, {
      method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  )
}

const card = { runId: "run-a", nodeId: "x", pipeline: "demo" }

describe("routes", () => {
  test("anything else is not ours", async () => {
    expect(await call("/flow/api/other")).toBeUndefined()
    expect(await call("/flow/api/memory")).toBeUndefined()
  })

  test("GET status", async () => {
    const response = await call(MEMORY_ROUTES.status)
    expect(response?.status).toBe(200)
    const status = (await response?.json()) as MemoryStatus
    expect(status).toMatchObject({ enabled: true, reachable: true, surface: "omp", project: "acme/widgets" })
  })

  test("the wrong method is a 405 naming the right one", async () => {
    const response = await call(MEMORY_ROUTES.read)
    expect(response?.status).toBe(405)
    expect(response?.headers.get("allow")).toBe("POST")
  })

  test("write -> read -> entries -> forget -> entries round trip over HTTP", async () => {
    const written = await call(MEMORY_ROUTES.write, { body: { ...card, role: "coder", outcome: "done", output: "cache is in src/cache.ts" } })
    expect((await written?.json()) as MemoryWriteResult).toMatchObject({ status: "stored", subject: "openflow/demo/run-a/x" })

    const readResponse = await call(MEMORY_ROUTES.read, { body: { runId: "run-b", nodeId: "y", pipeline: "demo", query: "do the thing", limit: 5 } })
    const read = (await readResponse?.json()) as MemoryReadResult
    expect(read.status).toBe("ok")
    expect(read.block).toContain("src/cache.ts")

    const listed = (await (await call(`${MEMORY_ROUTES.entries}?pipeline=demo&run=run-a&limit=10`))?.json()) as { items: Array<{ retracted: boolean }> }
    expect(listed.items.map((item) => item.retracted)).toEqual([false])

    const forgotten = await call(MEMORY_ROUTES.forget, { body: { pipeline: "demo", runId: "run-a" } })
    expect(await forgotten?.json()).toEqual({ status: "retracted", retracted: 1 })

    const after = (await (await call(`${MEMORY_ROUTES.entries}?pipeline=demo&run=run-a`))?.json()) as { items: Array<{ subject: string; retracted: boolean }> }
    expect(after.items.every((item) => item.retracted)).toBe(true)
    expect(after.items.map((item) => item.subject)).toContain("openflow/demo/run-a/x/retracted")
  })

  const bad: Array<[string, string, unknown]> = [
    ["read without a run", MEMORY_ROUTES.read, { nodeId: "x", pipeline: "demo", query: "q" }],
    ["read with a bad limit", MEMORY_ROUTES.read, { ...card, query: "q", limit: 0 }],
    ["write with an unknown outcome", MEMORY_ROUTES.write, { ...card, role: "r", outcome: "constructor", output: "o" }],
    ["write without a role", MEMORY_ROUTES.write, { ...card, outcome: "done", output: "o" }],
    ["forget without a pipeline", MEMORY_ROUTES.forget, { runId: "run-a" }],
    ["a body that is not an object", MEMORY_ROUTES.forget, [1, 2]],
  ]
  for (const [name, path, body] of bad) {
    test(`400 for ${name}`, async () => {
      const response = await call(path, { body })
      expect(response?.status).toBe(400)
      expect(((await response?.json()) as { code: string }).code).toBe("bad-request")
    })
  }

  test("entries needs a pipeline; invalid JSON is a 400", async () => {
    expect((await call(MEMORY_ROUTES.entries))?.status).toBe(400)
    const response = await substrate.handle(new Request(`http://flow.test${MEMORY_ROUTES.read}`, { method: "POST", body: "{nope" }))
    expect(response?.status).toBe(400)
  })

  test("a down Substrate is a 200 with an honest status, never a 500", async () => {
    await fake.stop()
    const response = await call(MEMORY_ROUTES.read, { body: { ...card, query: "q" } })
    expect(response?.status).toBe(200)
    expect(((await response?.json()) as MemoryReadResult).status).toBe("unavailable")
    fake = startFakeSubstrate()
  })
})

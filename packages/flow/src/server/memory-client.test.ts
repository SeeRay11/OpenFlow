import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Server } from "bun"
import { MEMORY_ROUTES, type MemoryStatus } from "../../shared/memory"
import { createMemoryClient, requestJson, type MemoryClient } from "./memory-client"

type Seen = { method: string; path: string; search: string; body: unknown }

let seen: Seen[]
let reply: (request: Request, path: string) => Response
let server: Server<undefined>
let client: MemoryClient

const status: MemoryStatus = {
  enabled: true,
  reachable: true,
  url: "127.0.0.1:8787",
  surface: "omp",
  project: "swcstudio/flow",
  retention: { ttl: "30d", deletable: false, note: "Substrate cannot delete entries." },
  problems: [],
}

beforeEach(() => {
  seen = []
  reply = () => Response.json({})
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const text = await request.text()
      seen.push({ method: request.method, path: url.pathname, search: url.search, body: text ? JSON.parse(text) : undefined })
      return reply(request, url.pathname)
    },
  })
  client = createMemoryClient({ base: `http://127.0.0.1:${server.port}` })
})

afterEach(async () => {
  await server.stop(true)
})

describe("memory client", () => {
  test("status GETs the status route and returns the body as sent", async () => {
    reply = () => Response.json(status)
    const result = await client.status()
    expect(result).toEqual({ ok: true, value: status })
    expect(seen).toEqual([{ method: "GET", path: MEMORY_ROUTES.status, search: "", body: undefined }])
  })

  test("entries sends the pipeline, and run and limit only when given", async () => {
    reply = () => Response.json({ status: "empty", items: [] })
    await client.entries({ pipeline: "my pipeline/1" })
    await client.entries({ pipeline: "p", runId: "run-9", limit: 25 })
    expect(seen.map((entry) => `${entry.method} ${entry.path}${entry.search}`)).toEqual([
      `GET ${MEMORY_ROUTES.entries}?pipeline=my+pipeline%2F1`,
      `GET ${MEMORY_ROUTES.entries}?pipeline=p&run=run-9&limit=25`,
    ])
  })

  test("entries returns rows with their retraction markers", async () => {
    const row = { id: "e1", scope: "repo:swcstudio/flow", kind: "fact", subject: "openflow/p/r/c", preview: "done", origin: "search", retracted: true }
    reply = () => Response.json({ status: "ok", items: [row] })
    const result = await client.entries({ pipeline: "p" })
    expect(result.ok && result.value.items[0]).toEqual(row as never)
  })

  test("forget POSTs the request as JSON and returns the count", async () => {
    reply = () => Response.json({ status: "retracted", retracted: 3 })
    const result = await client.forget({ pipeline: "p", runId: "r" })
    expect(result).toEqual({ ok: true, value: { status: "retracted", retracted: 3 } })
    expect(seen).toEqual([{ method: "POST", path: MEMORY_ROUTES.forget, search: "", body: { pipeline: "p", runId: "r" } }])
  })

  test("an error body's message is passed on, without the status noise", async () => {
    reply = () => Response.json({ error: "`pipeline` is required", code: "bad-request" }, { status: 400 })
    expect(await client.entries({ pipeline: "" })).toEqual({ ok: false, error: "`pipeline` is required" })
  })

  test("a non-JSON failure falls back to the status code", async () => {
    reply = () => new Response("<html>bad gateway</html>", { status: 502 })
    expect(await client.status()).toEqual({ ok: false, error: "The request failed (502)." })
  })

  test("a 200 that is not a JSON object is a failure, not a value", async () => {
    reply = () => new Response("nope", { status: 200 })
    const result = await client.status()
    expect(result.ok).toBe(false)
  })

  test("a host that is down resolves instead of throwing, with an actionable sentence", async () => {
    await server.stop(true)
    const result = await client.status()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain("did not answer")
    expect(!result.ok && result.error).toContain("refresh")
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({}) })
  })

  test("a fetch that rejects is the same failure", async () => {
    const result = await requestJson(() => Promise.reject(new Error("socket hang up")), "http://x/y")
    expect(result).toEqual({
      ok: false,
      error: "The OpenFlow host did not answer. Check that OpenFlow is still running, then refresh.",
    })
  })
})

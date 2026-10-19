import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { store } from "./store"

/**
 * The store is the browser's client of `/flow/api`, so it fetches relative
 * URLs. Outside a page those mean nothing: the fetch is pointed at a real
 * loopback server instead, which records what it was asked.
 */
type Seen = { method: string; path: string; type: string | null; body: string }
const seen: Seen[] = []
let respond: (path: string) => Response = () => Response.json({})

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    seen.push({
      method: request.method,
      path: url.pathname + url.search,
      type: request.headers.get("content-type"),
      body: await request.text(),
    })
    return respond(url.pathname)
  },
})

const realFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${server.url.origin}${input}` : input, init)) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await server.stop(true)
})

async function last<T>(call: Promise<T>) {
  const result = await call
  return { result, request: seen[seen.length - 1] }
}

describe("store requests", () => {
  test("a GET carries no body and no content type", async () => {
    respond = () => Response.json([{ name: "build", nodes: 2, updated: 1 }])
    const { result, request } = await last(store.pipelines())
    expect(result).toEqual([{ name: "build", nodes: 2, updated: 1 }])
    expect(request).toMatchObject({ method: "GET", path: "/flow/api/pipelines", type: null, body: "" })
  })

  test("a write sends JSON with a content type", async () => {
    respond = () => Response.json({ saved: true })
    const { request } = await last(store.saveRoles([{ id: "coder" }]))
    expect(request).toMatchObject({ method: "PUT", path: "/flow/api/roles", type: "application/json" })
    expect(JSON.parse(request.body)).toEqual([{ id: "coder" }])
  })

  test("names are encoded into the path", async () => {
    respond = () => Response.json({})
    const { request } = await last(store.deletePipeline("my plan/v2"))
    expect(request).toMatchObject({ method: "DELETE", path: "/flow/api/pipelines/my%20plan%2Fv2" })
  })

  test("a failure surfaces the host's own message", async () => {
    respond = () => Response.json({ error: "no project open" }, { status: 409 })
    await expect(store.runs()).rejects.toThrow("no project open")
  })

  test("a failure without a readable body names the call and status", async () => {
    respond = () => new Response("<html>", { status: 502 })
    await expect(store.runs()).rejects.toThrow("GET /runs failed (502)")
  })
})

describe("store routes of the Omp profile", () => {
  test("mcp servers are saved and removed by name", async () => {
    respond = () => Response.json({ name: "docs", path: "mcp.json" })
    const saved = await last(store.saveMcpServer({ name: "docs", type: "remote", enabled: true, url: "https://mcp.example/sse" }))
    expect(saved.request).toMatchObject({ method: "PUT", path: "/flow/api/mcp/docs" })
    expect(JSON.parse(saved.request.body)).toMatchObject({ type: "remote", url: "https://mcp.example/sse" })

    const removed = await last(store.deleteMcpServer("docs"))
    expect(removed.request).toMatchObject({ method: "DELETE", path: "/flow/api/mcp/docs" })
  })

  test("a skill listing keeps the legacy flag the host puts on old entries", async () => {
    respond = () =>
      Response.json([
        { name: "summarize", updated: 2 },
        { name: "old-skill", updated: 1, legacy: true },
      ])
    const { result } = await last(store.skills())
    expect(result.map((entry) => entry.legacy)).toEqual([undefined, true])
  })
})

describe("store worktrees and checkpoints", () => {
  test("opening worktrees posts the run and its cards", async () => {
    respond = () => Response.json({ enabled: false, reason: "not a git repository" })
    const { result, request } = await last(store.openWorktrees("run-1", ["n1", "n2"]))
    expect(result).toEqual({ enabled: false, reason: "not a git repository" })
    expect(request).toMatchObject({ method: "POST", path: "/flow/api/worktrees" })
    expect(JSON.parse(request.body)).toEqual({ run: "run-1", cards: ["n1", "n2"] })
  })

  test("a checkpoint posts the run and round, and may answer null", async () => {
    respond = () => Response.json(null)
    const { result, request } = await last(store.checkpoint("run-1", 3))
    expect(result).toBeNull()
    expect(JSON.parse(request.body)).toEqual({ run: "run-1", round: 3 })
  })

  test("browse puts the folder in the query string, encoded", async () => {
    respond = () => Response.json({ path: null, parent: null, entries: [] })
    const { request } = await last(store.browse("/tmp/a b"))
    expect(request.path).toBe("/flow/api/browse?path=%2Ftmp%2Fa%20b")
  })
})

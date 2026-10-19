import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { ProjectBusyError, store } from "./store"

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

  test("an edit overwrites by default; a new or renamed entry asks the host to refuse a name already taken", async () => {
    respond = () => Response.json({ name: "docs", path: "mcp.json" })
    const server = { name: "docs", type: "remote", enabled: true, url: "https://mcp.example/sse" } as const
    const edit = await last(store.saveMcpServer(server))
    expect("create" in JSON.parse(edit.request.body)).toBe(false)
    const fresh = await last(store.saveMcpServer(server, true))
    expect(JSON.parse(fresh.request.body)).toMatchObject({ create: true, url: "https://mcp.example/sse" })

    respond = () => Response.json({ name: "notes", path: "SKILL.md" })
    const skill = { name: "notes", description: "d", content: "c" }
    expect("create" in JSON.parse((await last(store.saveSkill(skill))).request.body)).toBe(false)
    expect(JSON.parse((await last(store.saveSkill(skill, true))).request.body)).toMatchObject({ create: true, name: "notes" })
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

  test("deleting something already gone is a result, for mcp servers and skills alike", async () => {
    respond = (path) => Response.json({ name: path.split("/").pop(), removed: false, error: "not found: nothing was removed" }, { status: 404 })
    expect(await store.deleteMcpServer("ghost")).toMatchObject({ name: "ghost", removed: false })
    expect(await store.deleteSkill("ghost")).toMatchObject({ name: "ghost", removed: false })
  })

  test("any other failed delete still throws the host's sentence", async () => {
    respond = () => Response.json({ error: "invalid skill name" }, { status: 400 })
    await expect(store.deleteSkill("../x")).rejects.toThrow("invalid skill name")
    // A 404 that says nothing about `removed` is a wrong route, not a missing server.
    respond = () => Response.json({ error: "no such route" }, { status: 404 })
    await expect(store.deleteMcpServer("x")).rejects.toThrow("no such route")
  })

  test("a save refused for a name collision carries the host's sentence", async () => {
    respond = () => Response.json({ error: 'mcp server "a-b" already exists', code: "name-taken" }, { status: 409 })
    await expect(store.saveMcpServer({ name: "a.b", type: "remote", enabled: true, url: "https://x" })).rejects.toThrow("already exists")
  })
})

describe("store project switch", () => {
  test("a busy refusal carries the cards that hold the project", async () => {
    respond = () => Response.json({ error: "a run is still active", code: "project-busy", sessions: ["s1", 7, "s2"] }, { status: 409 })
    const failure = await store.setProject("/b").catch((error: unknown) => error)
    if (!(failure instanceof ProjectBusyError)) throw new Error("expected a ProjectBusyError")
    expect(failure.sessions).toEqual(["s1", "s2"])
    expect(failure.message).toBe("a run is still active")
  })

  test("any other refusal is a plain error", async () => {
    respond = () => Response.json({ error: "not a directory" }, { status: 400 })
    const failure = await store.setProject("/b").catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(ProjectBusyError)
    expect(failure).toMatchObject({ message: "not a directory" })
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

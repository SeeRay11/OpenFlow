import { describe, expect, test } from "bun:test"
import { CUSTOM_LOCAL_ID, LOCAL_LIMIT, declare, declared, discover, normalizeUrl, runtimeFor, undeclare } from "./local"

const ollama = runtimeFor("local-ollama")!

describe("declare", () => {
  test("writes a v2 provider with tools on, a limit, and a zero price row", () => {
    const value = declare({ $schema: "x" }, ollama, ["llama3.2", "qwen3"])
    const entry = value.providers["local-ollama"]
    expect(entry.api).toEqual({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://localhost:11434/v1" })
    expect(Object.keys(entry.models)).toEqual(["llama3.2", "qwen3"])
    expect(entry.models.qwen3.capabilities.tools).toBe(true)
    expect(entry.models.qwen3.limit).toEqual(LOCAL_LIMIT)
    expect(entry.models.qwen3.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    expect(value.provider).toBeUndefined()
  })

  // One v1 key sends the whole file through the v1 migration, where
  // `providers` is never read.
  test("follows a v1 file's dialect", () => {
    const value = declare({ plugin: ["./p.js"] }, ollama, ["llama3.2"])
    const entry = value.provider["local-ollama"]
    expect(entry.npm).toBe("@ai-sdk/openai-compatible")
    expect(entry.api).toBe("http://localhost:11434/v1")
    expect(entry.models["llama3.2"].tool_call).toBe(true)
    expect(entry.models["llama3.2"].cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
    expect(value.providers).toBeUndefined()
  })

  test("drops models the server no longer lists, keeps edits on the ones it does, and never keeps a price", () => {
    const before = declare({}, ollama, ["old", "kept"])
    before.providers["local-ollama"].models.kept.limit = { context: 131_072, output: 8_192 }
    before.providers["local-ollama"].models.kept.cost = [{ input: 9, output: 9, cache: { read: 0, write: 0 } }]
    const after = declare(before, ollama, ["kept"])
    expect(Object.keys(after.providers["local-ollama"].models)).toEqual(["kept"])
    expect(after.providers["local-ollama"].models.kept.limit.context).toBe(131_072)
    expect(after.providers["local-ollama"].models.kept.cost[0].input).toBe(0)
  })

  test("undeclare removes it from either dialect and leaves the rest", () => {
    const v2 = undeclare(declare({ providers: { openai: {} } }, ollama, ["m"]), "local-ollama")
    expect(v2.providers).toEqual({ openai: {} })
    const v1 = undeclare(declare({ plugin: [] }, ollama, ["m"]), "local-ollama")
    expect(v1.provider).toEqual({})
  })

  test("declared reads back what was written, and nothing that is not local", () => {
    const value = declare({ providers: { openrouter: { api: { url: "https://x" } } } }, ollama, ["m"])
    expect(declared(value)).toEqual([{ id: "local-ollama", url: "http://localhost:11434/v1", models: ["m"] }])
  })
})

describe("runtimeFor", () => {
  test("accepts the fixed ids, with or without an address override", () => {
    expect(runtimeFor("local-lmstudio")?.url).toBe("http://localhost:1234/v1")
    expect(runtimeFor("local-ollama", "http://box:11434/v1/")?.url).toBe("http://box:11434/v1")
  })

  test("a custom server needs an http(s) address, and no other id is accepted", () => {
    expect(runtimeFor(CUSTOM_LOCAL_ID)).toBeUndefined()
    expect(runtimeFor(CUSTOM_LOCAL_ID, "file:///etc")).toBeUndefined()
    expect(runtimeFor(CUSTOM_LOCAL_ID, "http://localhost:8000/v1")?.url).toBe("http://localhost:8000/v1")
    expect(runtimeFor("openrouter", "http://localhost:8000/v1")).toBeUndefined()
  })

  test("normalizeUrl rejects what is not a url", () => {
    expect(normalizeUrl("not a url")).toBeUndefined()
    expect(normalizeUrl(42)).toBeUndefined()
  })
})

describe("discover", () => {
  test("reads model ids off an OpenAI-compatible listing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ object: "list", data: [{ id: "qwen3" }, { id: "llama3.2" }, { id: "qwen3" }] }),
    })
    const found = await discover(`http://localhost:${server.port}/v1`)
    server.stop(true)
    expect(found).toEqual({ running: true, models: ["llama3.2", "qwen3"] })
  })

  test("a server that is not there is reported as not running, not thrown", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") })
    const port = server.port
    server.stop(true)
    expect(await discover(`http://localhost:${port}/v1`)).toEqual({ running: false, models: [] })
  })

  test("an error status is running, with the reason", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 404 }) })
    const found = await discover(`http://localhost:${server.port}/v1`)
    server.stop(true)
    expect(found.running).toBe(true)
    expect(found.error).toContain("404")
  })
})

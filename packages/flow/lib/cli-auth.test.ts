import { describe, expect, test } from "bun:test"
import path from "node:path"
import { cliAuthPath, importCliKeys, parseCliKeys } from "./cli-auth"

describe("cliAuthPath", () => {
  test("follows XDG_DATA_HOME when it is set", () => {
    expect(cliAuthPath({ XDG_DATA_HOME: "/data" }, "/home/x")).toBe(path.join("/data", "opencode", "auth.json"))
  })

  test("falls back to ~/.local/share, which is where the CLI writes on every platform", () => {
    expect(cliAuthPath({}, "/home/x")).toBe(path.join("/home/x", ".local", "share", "opencode", "auth.json"))
  })
})

describe("parseCliKeys", () => {
  test("takes api keys and skips oauth entries, which connect/key cannot accept", () => {
    const raw = JSON.stringify({
      groq: { type: "api", key: "gsk_1" },
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
      openrouter: { type: "api", key: "sk-or-1" },
    })
    expect(parseCliKeys(raw)).toEqual([
      { providerID: "groq", key: "gsk_1" },
      { providerID: "openrouter", key: "sk-or-1" },
    ])
  })

  test("drops empty keys and malformed entries instead of storing junk", () => {
    const raw = JSON.stringify({ a: { type: "api", key: "" }, b: { type: "api" }, c: "nope", d: null })
    expect(parseCliKeys(raw)).toEqual([])
  })

  test("normalises the trailing slash the CLI tolerates in provider names", () => {
    expect(parseCliKeys(JSON.stringify({ "groq/": { type: "api", key: "k" } }))).toEqual([
      { providerID: "groq", key: "k" },
    ])
  })

  test("unparseable auth.json yields nothing rather than throwing at the host", () => {
    expect(parseCliKeys("{not json")).toEqual([])
  })
})

describe("importCliKeys", () => {
  const keys = [
    { providerID: "groq", key: "gsk_1" },
    { providerID: "openrouter", key: "sk-or-1" },
  ]

  test("posts each key to the integration connect route", async () => {
    const calls: Array<{ url: string; body: any }> = []
    const results = await importCliKeys({
      upstream: "http://127.0.0.1:4096",
      keys,
      fetchImpl: (async (url: any, init: any) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) })
        return new Response(null, { status: 204 })
      }) as any,
    })
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4096/api/integration/groq/connect/key",
      "http://127.0.0.1:4096/api/integration/openrouter/connect/key",
    ])
    expect(calls[0].body).toEqual({ key: "gsk_1", label: "opencode cli" })
    expect(results.every((result) => result.ok)).toBe(true)
  })

  test("only imports the providers asked for", async () => {
    const seen: string[] = []
    await importCliKeys({
      upstream: "http://127.0.0.1:4096",
      keys,
      only: ["openrouter"],
      fetchImpl: (async (url: any) => {
        seen.push(String(url))
        return new Response(null, { status: 204 })
      }) as any,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("/openrouter/")
  })

  test("reports a failing provider without abandoning the rest", async () => {
    const results = await importCliKeys({
      upstream: "http://127.0.0.1:4096",
      keys,
      fetchImpl: (async (url: any) =>
        String(url).includes("groq")
          ? new Response("no such integration", { status: 404 })
          : new Response(null, { status: 204 })) as any,
    })
    expect(results[0]).toMatchObject({ providerID: "groq", ok: false })
    expect(results[0].error).toContain("404")
    expect(results[1]).toEqual({ providerID: "openrouter", ok: true })
  })

  test("a transport failure is a per-provider error, not a thrown import", async () => {
    const results = await importCliKeys({
      upstream: "http://127.0.0.1:4096",
      keys: [keys[0]],
      fetchImpl: (async () => {
        throw new Error("connection refused")
      }) as any,
    })
    expect(results).toEqual([{ providerID: "groq", ok: false, error: "connection refused" }])
  })
})

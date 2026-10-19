import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { createClient, parseBaseUrl, resolveToken, tokenAllowed } from "./client"
import type { FakeSubstrate } from "./fake-substrate.test-support"
import { startFakeSubstrate } from "./fake-substrate.test-support"

let dir: string
let fake: FakeSubstrate

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flow-substrate-client-"))
  fake = startFakeSubstrate()
})

afterEach(async () => {
  await fake.stop()
  await rm(dir, { recursive: true, force: true })
})

function client(token = fake.token, url = fake.url) {
  const base = parseBaseUrl(url)
  if (!base) throw new Error("bad url")
  return createClient({ url: base, token, fetch })
}

describe("resolveToken", () => {
  test("order: SUBSTRATE_TOKEN, then the first line of SUBSTRATE_TOKEN_FILE, then <tokens dir>/omp", async () => {
    const file = join(dir, "token-file")
    await writeFile(file, "from-file-token\nsecond line ignored\n")
    await mkdir(join(dir, "tokens"))
    await writeFile(join(dir, "tokens", "omp"), "from-dir-token\n")
    const env = { SUBSTRATE_TOKEN: "from-env-token", SUBSTRATE_TOKEN_FILE: file, SUBSTRATE_TOKENS_DIR: join(dir, "tokens") }
    expect(await resolveToken(env)).toEqual({ token: "from-env-token", source: "env" })
    expect(await resolveToken({ ...env, SUBSTRATE_TOKEN: "" })).toEqual({ token: "from-file-token", source: "file" })
    expect(await resolveToken({ ...env, SUBSTRATE_TOKEN: undefined, SUBSTRATE_TOKEN_FILE: join(dir, "missing") })).toEqual({
      token: "from-dir-token",
      source: "tokens-dir",
    })
  })

  test("an empty or missing source falls through, and nothing found is undefined", async () => {
    await writeFile(join(dir, "empty"), "\n")
    expect(await resolveToken({ SUBSTRATE_TOKEN_FILE: join(dir, "empty"), SUBSTRATE_TOKENS_DIR: join(dir, "none") })).toBeUndefined()
  })
})

describe("parseBaseUrl", () => {
  test("accepts http(s) only", () => {
    expect(parseBaseUrl("http://127.0.0.1:7410/")?.host).toBe("127.0.0.1:7410")
    expect(parseBaseUrl("ftp://x")).toBeUndefined()
    expect(parseBaseUrl("not a url")).toBeUndefined()
  })
})

describe("tokenAllowed", () => {
  const allowed = (url: string, env: NodeJS.ProcessEnv = {}) => {
    const parsed = parseBaseUrl(url)
    if (!parsed) throw new Error("bad url")
    return tokenAllowed(parsed, env)
  }

  test.each([
    ["https://substrate.example", true],
    ["https://substrate.example:8443", true],
    ["http://localhost:8080", true],
    ["http://127.0.0.1:8080", true],
    ["http://[::1]:8080", true],
    ["http://substrate.example:8080", false],
    ["http://10.0.0.5:8080", false],
    ["http://localhost.evil.example:8080", false],
    ["http://127.0.0.1.evil.example", false],
    ["http://0.0.0.0:8080", false],
  ])("%s with an empty environment", (url, expected) => expect(allowed(url)).toBe(expected))

  test("plain http to another host is trusted only when SUBSTRATE_URL names the same origin", () => {
    const env = { SUBSTRATE_URL: "http://substrate.example:8080" }
    expect(allowed("http://substrate.example:8080", env)).toBe(true)
    expect(allowed("http://substrate.example:8080/some/path", env)).toBe(true)
    expect(allowed("http://substrate.example:9090", env)).toBe(false)
    expect(allowed("http://substrate.example", env)).toBe(false)
    expect(allowed("http://other.example:8080", env)).toBe(false)
    expect(allowed("https://substrate.example:8080", { SUBSTRATE_URL: "http://other.example" })).toBe(true)
    expect(allowed("http://substrate.example:8080", { SUBSTRATE_URL: "not a url" })).toBe(false)
    expect(allowed("http://substrate.example:8080", { SUBSTRATE_URL: "" })).toBe(false)
  })
})

describe("client", () => {
  test("an untrusted URL never sees the token: authenticated calls fail without a request, healthz still goes out bare", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const recorder = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ index: true }), { status: 200 })
    }) as typeof fetch
    const url = parseBaseUrl("http://substrate.example:8080")
    if (!url) throw new Error("bad url")
    const untrusted = createClient({ url, token: fake.token, fetch: recorder, env: {} })

    const brief = await untrusted.brief({ repo: "acme/widgets" })
    expect(brief).toMatchObject({ ok: false, kind: "unavailable" })
    expect(JSON.stringify(brief)).not.toContain(fake.token)
    expect(brief.ok ? "" : brief.message).toContain("substrate.example:8080")
    expect(await untrusted.memorySearch({ scope: "repo:acme/widgets" })).toMatchObject({ ok: false, kind: "unavailable" })
    expect(seen).toEqual([])

    expect((await untrusted.healthz()).ok).toBe(true)
    expect(seen).toEqual([{ url: "http://substrate.example:8080/healthz", authorization: null }])

    // The environment's own choice, and https, do carry it.
    seen.length = 0
    const trusted = createClient({ url, token: fake.token, fetch: recorder, env: { SUBSTRATE_URL: "http://substrate.example:8080" } })
    await trusted.brief({ repo: "acme/widgets" })
    expect(seen.map((call) => call.authorization)).toEqual([`Bearer ${fake.token}`])
  })

  test("healthz is open and reports degraded planes", async () => {
    fake.planes.hindsight = { ok: false }
    const health = await client("wrong-token").healthz()
    expect(health).toEqual({ ok: true, value: { problems: ["the Substrate hindsight plane is degraded"] } })
    expect(fake.calls[0]?.authorized).toBe(false)
  })

  test("brief reads the state header and sends the omp surface", async () => {
    fake.script.brief.push("degraded")
    const brief = await client().brief({ repo: "a/b", branch: "main", graph_id: "ut-x-00000000" })
    expect(brief.ok && brief.value.state).toBe("degraded")
    expect(brief.ok && brief.value.etag).toBe('"fake"')
    expect((fake.calls.at(-1)?.body as Record<string, unknown>).surface).toBe("omp")
  })

  test("memory_search goes over MCP with the required Accept header and an SSE reply", async () => {
    fake.seed({ scope: "repo:a/b", kind: "fact", subject: "openflow/p/r/c", text: "hello world" })
    const page = await client().memorySearch({ scope: "repo:a/b", subjectPrefix: "openflow/p/", limit: 5 })
    expect(page.ok && page.value.entries.map((entry) => entry.text)).toEqual(["hello world"])
    const call = fake.calls.at(-1)
    expect(call?.path).toBe("/mcp")
    expect(call?.tool).toBe("memory_search")
    expect(call?.accept).toBe("application/json, text/event-stream")
  })

  test("an isError tool result becomes a rejected failure with the reason", async () => {
    fake.script.search.push("error")
    const page = await client().memorySearch({ scope: "repo:a/b", subjectPrefix: "x" })
    expect(page).toMatchObject({ ok: false, kind: "rejected" })
    expect(page.ok === false && page.message).toContain("memory_search needs")
  })

  test("a wrong token is `unauthorized` and the message never contains it", async () => {
    const bad = "wrong-token-should-not-appear-0000"
    const page = await client(bad).memorySearch({ scope: "repo:a/b", subjectPrefix: "x" })
    expect(page).toMatchObject({ ok: false, kind: "unauthorized", status: 401 })
    expect(JSON.stringify(page)).not.toContain(bad)
  })

  test("a refused connection is `unreachable` and names host:port only", async () => {
    const result = await client(fake.token, "http://127.0.0.1:1").brief({ repo: "a/b" })
    expect(result).toMatchObject({ ok: false, kind: "unreachable" })
    expect(result.ok === false && result.message).toContain("127.0.0.1:1")
    expect(JSON.stringify(result)).not.toContain(fake.token)
  })

  test("a 5xx from /events is `unavailable`", async () => {
    fake.script.events.push("down")
    expect(await client().eventsEmit({ kind: "note", summary: "x" })).toMatchObject({ ok: false, kind: "unavailable", status: 503 })
  })

  test("write replies map to typed outcomes", async () => {
    const body = { scope: "repo:a/b", kind: "fact", subject: "s", text: "t", idempotency_key: "k" }
    fake.script.write.push("conflict", "quarantine", "denied", "down", "unverified")
    expect(await client().memoryWrite(body)).toMatchObject({ ok: true, outcome: "conflict", reason: "version.required", remedy: "pass expected_version" })
    expect(await client().memoryWrite(body)).toMatchObject({ ok: true, outcome: "quarantined", reason: "secret" })
    expect(await client().memoryWrite(body)).toMatchObject({ ok: true, outcome: "denied", reason: "grant.missing" })
    expect(await client().memoryWrite(body)).toMatchObject({ ok: false, kind: "unavailable", status: 503 })
    expect(await client().memoryWrite(body)).toMatchObject({ ok: true, outcome: "accepted", verified: false })
    expect(await client().memoryWrite({ ...body, idempotency_key: "k2" })).toMatchObject({ ok: true, outcome: "accepted", verified: true })
  })

  test("a redirect is a failure, never followed, and the token goes nowhere else", async () => {
    const requests: Array<{ path: string; authorization: string | undefined }> = []
    const server = createServer((req, res) => {
      requests.push({ path: req.url ?? "", authorization: req.headers.authorization })
      if (req.url === "/brief") {
        res.statusCode = 307
        res.setHeader("location", "/elsewhere")
      }
      res.end("{}")
    })
    const listening = Promise.withResolvers<void>()
    server.listen(0, "127.0.0.1", () => listening.resolve())
    await listening.promise
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const brief = await client(fake.token, url).brief({ repo: "acme/widgets" })
      expect(brief).toMatchObject({ ok: false, kind: "rejected", status: 307 })
      expect(JSON.stringify(brief)).not.toContain(fake.token)
      expect(requests.map((request) => request.path)).toEqual(["/brief"])
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  test("graph_register goes over MCP", async () => {
    const result = await client().graphRegister({ graph_id: "ut-x-00000000", repo: "a/b", nodes: [{ node_id: "n", state: "started" }] })
    expect(result.ok).toBe(true)
    expect(fake.graphs.get("ut-x-00000000")?.nodes).toEqual(["n"])
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient, parseBaseUrl, resolveToken } from "./client"
import type { FakeSubstrate } from "./testing/fake-substrate"
import { startFakeSubstrate } from "./testing/fake-substrate"

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

describe("client", () => {
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

  test("graph_register goes over MCP", async () => {
    const result = await client().graphRegister({ graph_id: "ut-x-00000000", repo: "a/b", nodes: [{ node_id: "n", state: "started" }] })
    expect(result.ok).toBe(true)
    expect(fake.graphs.get("ut-x-00000000")?.nodes).toEqual(["n"])
  })
})

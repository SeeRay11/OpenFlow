import { afterEach, describe, expect, test } from "bun:test"
import { MEMORY_ROUTES } from "../../shared/memory"
import type { MemoryReadRequest, MemoryReadResult, MemoryWriteRequest, MemoryWriteResult } from "../../shared/memory"
import { UPLIFT_ROUTE } from "../../shared/uplift"
import type { UpliftRequest, UpliftResult } from "../../shared/uplift"
import { createStages } from "./stages"

const uplift: UpliftRequest = { runId: "r1", nodeId: "n1", role: "coder", original: "fix the bug" }
const read: MemoryReadRequest = { runId: "r1", nodeId: "n1", pipeline: "demo", query: "fix the bug" }
const write: MemoryWriteRequest = { runId: "r1", nodeId: "n1", pipeline: "demo", role: "coder", outcome: "done", output: "ok" }

type Seen = { path: string; method: string; type: string | null; body: unknown }

let servers: Bun.Server<undefined>[] = []

/** A loopback host whose every answer is `answer(path)`. */
function host(answer: (path: string) => Response) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      seen.push({ path, method: request.method, type: request.headers.get("content-type"), body: await request.json().catch(() => undefined) })
      return answer(path)
    },
  })
  servers.push(server)
  return { seen, stages: createStages(`http://127.0.0.1:${server.port}`), server }
}

afterEach(async () => {
  for (const server of servers) await server.stop(true)
  servers = []
})

describe("uplift", () => {
  test("posts the request and returns the host's answer untouched", async () => {
    const answer = { status: "ok", original: "fix the bug", uplifted: "<BUILD_PROMPT/>", elapsedMs: 12 } satisfies UpliftResult
    const { seen, stages } = host(() => Response.json(answer))

    expect(await stages.uplift(uplift)).toEqual(answer)
    expect(seen).toEqual([{ path: UPLIFT_ROUTE, method: "POST", type: "application/json", body: uplift }])
  })

  test("a skipped answer is passed through, not turned into a failure", async () => {
    const { stages } = host(() => Response.json({ status: "skipped", original: "x", reason: "disabled", elapsedMs: 1 }))
    expect((await stages.uplift(uplift)).status).toBe("skipped")
  })

  test("a 4xx answer becomes a failed result carrying the host's sentence and the fix", async () => {
    const { stages } = host(() => Response.json({ error: "original is required", code: "bad-request" }, { status: 400 }))
    const result = await stages.uplift(uplift)

    expect(result.status).toBe("failed")
    expect(result.original).toBe("fix the bug")
    expect(result.reason).toContain("original is required")
    expect(result.reason).toContain("HTTP 400")
    expect(result.reason).toContain("bun openflow.ts")
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  test("a 5xx answer with an HTML body still names the status", async () => {
    const { stages } = host(() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }))
    const result = await stages.uplift(uplift)

    expect(result.status).toBe("failed")
    expect(result.reason).toContain("HTTP 502")
  })

  test("a host that is down is a failed result, never a throw", async () => {
    const { server } = host(() => Response.json({}))
    const down = createStages(`http://127.0.0.1:${server.port}`)
    await server.stop(true)
    const result = await down.uplift(uplift)

    expect(result.status).toBe("failed")
    expect(result.original).toBe("fix the bug")
    expect(result.reason).toContain("did not answer")
    expect(result.reason).toContain("bun openflow.ts")
  })

  test("a 200 answer that is not a stage result is a failed result", async () => {
    for (const body of ["not json", "null", "[1]", "{}"]) {
      const { stages } = host(() => new Response(body, { status: 200 }))
      const result = await stages.uplift(uplift)
      expect(result.status).toBe("failed")
      expect(result.reason).toContain("not a stage result")
    }
  })
})

describe("memory read", () => {
  test("returns the host's answer", async () => {
    const answer = { status: "ok", block: "<memory/>", items: [], scopes: ["repo:a/b"], elapsedMs: 3 } satisfies MemoryReadResult
    const { seen, stages } = host(() => Response.json(answer))

    expect(await stages.memory.read(read)).toEqual(answer)
    expect(seen[0]).toMatchObject({ path: MEMORY_ROUTES.read, method: "POST", body: read })
  })

  test("an error answer is unavailable with an empty block", async () => {
    const { stages } = host(() => Response.json({ error: "substrate is off" }, { status: 503 }))
    const result = await stages.memory.read(read)

    expect(result).toMatchObject({ status: "unavailable", block: "", items: [], scopes: [] })
    expect(result.error).toContain("substrate is off")
    expect(result.error).toContain("HTTP 503")
  })

  test("a host that is down is unavailable, never a throw", async () => {
    const { server } = host(() => Response.json({}))
    const down = createStages(`http://127.0.0.1:${server.port}`)
    await server.stop(true)
    const result = await down.memory.read(read)

    expect(result).toMatchObject({ status: "unavailable", block: "", items: [], scopes: [] })
    expect(result.error).toContain("did not answer")
  })

  test("malformed JSON is unavailable", async () => {
    const { stages } = host(() => new Response("{oops", { status: 200 }))
    expect((await stages.memory.read(read)).status).toBe("unavailable")
  })
})

describe("memory write", () => {
  test("returns the host's answer", async () => {
    const answer = { status: "stored", subject: "openflow/demo/r1/n1" } satisfies MemoryWriteResult
    const { seen, stages } = host(() => Response.json(answer))

    expect(await stages.memory.write(write)).toEqual(answer)
    expect(seen[0]).toMatchObject({ path: MEMORY_ROUTES.write, method: "POST", body: write })
  })

  test("an error answer is unavailable", async () => {
    const { stages } = host(() => Response.json({ error: "denied by policy" }, { status: 403 }))
    const result = await stages.memory.write(write)

    expect(result.status).toBe("unavailable")
    expect(result.error).toContain("denied by policy")
  })

  test("a host that is down is unavailable, never a throw", async () => {
    const { server } = host(() => Response.json({}))
    const down = createStages(`http://127.0.0.1:${server.port}`)
    await server.stop(true)

    expect(await down.memory.write(write)).toMatchObject({ status: "unavailable" })
  })

  test("malformed JSON is unavailable", async () => {
    const { stages } = host(() => new Response("", { status: 200 }))
    expect((await stages.memory.write(write)).status).toBe("unavailable")
  })
})

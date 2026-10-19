import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { UPLIFT_ROUTE, type UpliftResult } from "../../shared/uplift"
import type { UpliftModule } from "./index"
import { alive, createHarness, until, type Harness } from "./testing/stub-planner"

/**
 * The routes are exercised over a real HTTP server on port 0, the way the
 * engine reaches them, with the stub planner behind them.
 */

const harnesses: Harness[] = []
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

async function setup() {
  const harness = await createHarness()
  harnesses.push(harness)
  return harness
}

function serve(uplift: UpliftModule) {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => (await uplift.handle(request)) ?? new Response("unclaimed", { status: 418 }),
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

function post(base: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${base}${UPLIFT_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  })
}

describe("POST", () => {
  test("answers 200 with the result of a plan, and GET returns the same thing", async () => {
    const harness = await setup()
    const base = serve(harness.create())

    const response = await post(base, { runId: "run1", nodeId: "n1", role: "builder", original: "@ok build it" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const result = (await response.json()) as UpliftResult
    expect(result.status).toBe("ok")
    expect(result.uplifted).toContain("<ORIGINAL>@ok build it</ORIGINAL>")

    const stored = await fetch(`${base}${UPLIFT_ROUTE}/run1/n1`)
    expect(stored.status).toBe(200)
    expect(await stored.json()).toEqual(result)
  })

  test("answers 200 for every planner outcome: skipped and failed are not server errors", async () => {
    const harness = await setup()
    const base = serve(harness.create())

    const skipped = await post(base, { runId: "run1", nodeId: "n1", original: "@jev-skip hi" })
    expect(skipped.status).toBe(200)
    expect(await skipped.json()).toMatchObject({ status: "skipped" })

    const crashed = await post(base, { runId: "run1", nodeId: "n2", original: "@crash x" })
    expect(crashed.status).toBe(200)
    expect(await crashed.json()).toMatchObject({ status: "failed" })

    harness.settings.uplift.root = path.join(harness.root, "missing")
    const missing = await post(base, { runId: "run1", nodeId: "n3", original: "@ok x" })
    expect(missing.status).toBe(200)
    expect(await missing.json()).toMatchObject({ reason: expect.stringContaining("claude-ultrathink") })
  })

  test("a timeoutMs in the request is the wall clock", async () => {
    const harness = await setup()
    const base = serve(harness.create())
    const result = (await (await post(base, { runId: "run1", nodeId: "n1", original: "@hang x", timeoutMs: 400 })).json()) as UpliftResult
    expect(result.reason).toBe("planner timed out after 0.4 s")
  })

  test("an aborted request stops the planner and its whole group", async () => {
    const harness = await setup()
    const base = serve(harness.create())
    const controller = new AbortController()
    const pending = post(base, { runId: "run1", nodeId: "n1", original: "@hang x" }, { signal: controller.signal })
    await until(async () => harness.pids("openflow-run1-n1-1").then(() => true, () => false))
    const pids = await harness.pids("openflow-run1-n1-1")

    controller.abort()
    await expect(pending).rejects.toThrow()
    await until(async () => !(await alive(pids.leader)) && !(await alive(pids.helper)))
  })

  test.each([
    ["not JSON", "{nope", 400],
    ["null", "null", 400],
    ["an array", "[]", 400],
    ["no original", { runId: "r", nodeId: "n" }, 400],
    ["a numeric original", { runId: "r", nodeId: "n", original: 5 }, 400],
    ["no runId", { nodeId: "n", original: "x" }, 400],
    ["an empty nodeId", { runId: "r", nodeId: "", original: "x" }, 400],
    ["a numeric runId", { runId: 7, nodeId: "n", original: "x" }, 400],
    ["an overlong runId", { runId: "r".repeat(257), nodeId: "n", original: "x" }, 400],
    ["a relative cwd", { runId: "r", nodeId: "n", original: "x", cwd: "rel" }, 400],
    ["a numeric role", { runId: "r", nodeId: "n", original: "x", role: 1 }, 400],
    ["a negative timeout", { runId: "r", nodeId: "n", original: "x", timeoutMs: -5 }, 400],
    ["a string timeout", { runId: "r", nodeId: "n", original: "x", timeoutMs: "10" }, 400],
    ["a body over 1 MiB", { runId: "r", nodeId: "n", original: "x".repeat(1_100_000) }, 413],
  ])("refuses %s with %i and no planner starts", async (_name, body, status) => {
    const harness = await setup()
    const base = serve(harness.create())
    const response = await post(base, body)
    expect(response.status).toBe(status)
    expect(await response.json()).toHaveProperty("error")
    await expect(fs.stat(harness.stateDir)).rejects.toThrow()
  })

  test("only POST on the collection route", async () => {
    const harness = await setup()
    const base = serve(harness.create())
    expect((await fetch(`${base}${UPLIFT_ROUTE}`)).status).toBe(405)
  })
})

describe("GET", () => {
  test("404 when the card has no result", async () => {
    const harness = await setup()
    const base = serve(harness.create())
    const response = await fetch(`${base}${UPLIFT_ROUTE}/run1/n1`)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: "not-found" })
  })

  test("keeps the last result per card, and survives a host restart", async () => {
    const harness = await setup()
    const first = harness.create()
    const base = serve(first)
    await post(base, { runId: "run1", nodeId: "n1", original: "@jev-skip first" })
    await post(base, { runId: "run1", nodeId: "n1", original: "@ok second" })
    await post(base, { runId: "run1", nodeId: "n2", original: "@ok other card" })
    await first.dispose()

    const restarted = serve(harness.create())
    const last = (await (await fetch(`${restarted}${UPLIFT_ROUTE}/run1/n1`)).json()) as UpliftResult
    expect(last.status).toBe("ok")
    expect(last.original).toBe("@ok second")
    expect(await (await fetch(`${restarted}${UPLIFT_ROUTE}/run1/n2`)).json()).toMatchObject({ original: "@ok other card" })

    // The count continues: the new process never reuses a session id.
    const again = (await (await post(restarted, { runId: "run1", nodeId: "n1", original: "@ok third" })).json()) as UpliftResult
    expect(again.specPath).toBe(path.join(harness.stateDir, "sessions", "openflow-run1-n1-3.xml"))
  })

  test("ids are URL segments: encoded ids work, and ids cannot name files", async () => {
    const harness = await setup()
    const base = serve(harness.create())
    await post(base, { runId: "run 1/x", nodeId: "../n", original: "@ok x" })

    const found = await fetch(`${base}${UPLIFT_ROUTE}/${encodeURIComponent("run 1/x")}/${encodeURIComponent("../n")}`)
    expect(found.status).toBe(200)
    expect(await fs.readdir(harness.stateRoot)).toEqual(["uplift"])
    expect(await fs.readdir(path.join(harness.stateDir, "results"))).toHaveLength(1)
    expect((await fetch(`${base}${UPLIFT_ROUTE}/run%201%2Fx/other`)).status).toBe(404)
  })

  test("bad paths and methods", async () => {
    const harness = await setup()
    const uplift = harness.create()
    const base = serve(uplift)
    expect((await fetch(`${base}${UPLIFT_ROUTE}/run1`)).status).toBe(404)
    expect((await fetch(`${base}${UPLIFT_ROUTE}/run1/n1/extra`)).status).toBe(404)
    expect((await fetch(`${base}${UPLIFT_ROUTE}/%E0%A4%A/n1`)).status).toBe(400)
    expect((await fetch(`${base}${UPLIFT_ROUTE}/run1/n1`, { method: "DELETE" })).status).toBe(405)
    expect((await fetch(`${base}${UPLIFT_ROUTE}//n1`)).status).toBe(400)
  })

  test("paths that are not the uplift route are left for the next handler", async () => {
    const harness = await setup()
    const uplift = harness.create()
    expect(await uplift.handle(new Request("http://localhost/flow/api/engine/x"))).toBeUndefined()
    expect(await uplift.handle(new Request("http://localhost/flow/api/upliftx"))).toBeUndefined()
  })
})

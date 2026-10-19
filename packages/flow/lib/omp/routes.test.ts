import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { ENGINE_BASE, engineRoutes, sessionRoute, type BusEvent } from "../../shared/engine"
import { createEngineHost, type EngineHost } from "./index"
import { createEventBus } from "./routes"
import { assistantMessage, createHarness, frames, type FakeProcess, type Harness } from "./testing/fake-process"

// These create sessions through the harness' `#!/bin/sh` omp, which Windows cannot execute.
const hosted = describe.skipIf(process.platform === "win32")

let h: Harness
let engine: EngineHost

beforeEach(async () => {
  h = await createHarness()
  h.fake.setup((proc) => {
    proc.on("open_session", { cancelled: false, resumed: true })
    proc.on("get_available_models", { models: [{ id: "m1", provider: "p", name: "M1", input: ["text"], reasoning: false, contextWindow: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] })
  })
  engine = createEngineHost(h.deps)
})

afterEach(async () => {
  await engine.dispose()
  await h.cleanup()
})

const BODY = { runId: "run1", nodeId: "n1", card: { key: "card-1", role: "Builder" }, model: "anthropic/claude-test" }

async function call(path: string, init: { method?: string; body?: unknown; raw?: string } = {}) {
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  const request = new Request(`http://flow.test${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
  })
  const response = await engine.handle(request)
  if (!response) return undefined
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers }
}

async function create(body: Record<string, unknown> = BODY) {
  const response = await call(engineRoutes.sessions, { body })
  const proc = h.fake.procs.at(-1) as FakeProcess
  return { id: response?.body.id as string, proc, response }
}

/** The id the browser is given for omp's own request id: read from the replay a stream gets when it attaches, as a real client would. */
async function publicId(raw: string): Promise<string> {
  const response = await engine.handle(new Request(`http://flow.test${engineRoutes.events}`))
  const reader = response?.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const decoder = new TextDecoder()
  const pattern = new RegExp(`"id":"([A-Za-z0-9_-]{6}\\.${raw})"`)
  let text = ""
  try {
    for (;;) {
      const match = pattern.exec(text)
      if (match) return match[1] as string
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`no asked event for ${raw}`)
      text += decoder.decode(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
}
describe("routing", () => {
  test("paths outside the engine base are not ours", async () => {
    expect(await call("/flow/api/context")).toBeUndefined()
    expect(await call("/other")).toBeUndefined()
    expect(await call(`${ENGINE_BASE}-not`)).toBeUndefined()
  })

  test("unknown paths under the base are not ours either", async () => {
    expect(await call(`${ENGINE_BASE}/nothing`)).toBeUndefined()
    expect(await call(`${ENGINE_BASE}/sessions/s_1/bogus`)).toBeUndefined()
  })

  test("a known path with the wrong method is a 405", async () => {
    expect((await call(engineRoutes.health, { method: "POST", body: {} }))?.status).toBe(405)
    expect((await call(engineRoutes.models, { method: "DELETE" }))?.status).toBe(405)
    expect((await call(engineRoutes.sessions, { method: "PUT", body: {} }))?.status).toBe(405)
    expect((await call(sessionRoute("s_1", "/prompt"), { method: "GET" }))?.status).toBe(405)
    expect((await call(sessionRoute("s_1", "/final"), { method: "POST", body: {} }))?.status).toBe(405)
    expect((await call(sessionRoute("s_1"), { method: "GET" }))?.status).toBe(405)
  })

  test("a body that is not JSON is a 400", async () => {
    const response = await call(engineRoutes.sessions, { raw: "{nope" })
    expect(response?.status).toBe(400)
    expect(response?.body.error).toContain("not valid JSON")
  })
})

hosted("bare reads", () => {
  test("health", async () => {
    const response = await call(engineRoutes.health)
    expect(response?.status).toBe(200)
    expect(response?.body).toEqual({ ok: true, omp: { available: true, version: "99.0.0" }, sessions: { live: 0 } })
    await create()
    expect((await call(engineRoutes.health))?.body.sessions.live).toBe(1)
  })

  test("health says so when omp is missing, without failing", async () => {
    const missing = await createHarness({ binary: false })
    const other = createEngineHost(missing.deps)
    try {
      const response = await other.handle(new Request(`http://flow.test${engineRoutes.health}`))
      expect(await response?.json()).toEqual({ ok: false, omp: { available: false }, sessions: { live: 0 } })
    } finally {
      await other.dispose()
      await missing.cleanup()
    }
  })

  test("models is a bare ModelInfo array", async () => {
    const response = await call(engineRoutes.models)
    expect(response?.status).toBe(200)
    expect(response?.body).toEqual([{ providerID: "p", id: "m1", name: "M1", reasoning: false, contextWindow: 1000, capabilities: { input: ["text"] }, cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] }])
  })

  test("models: omp unavailable is a 503 with a code, a catalog failure a 502", async () => {
    const missing = await createHarness({ binary: false })
    const other = createEngineHost(missing.deps)
    try {
      const response = await other.handle(new Request(`http://flow.test${engineRoutes.models}`))
      expect(response?.status).toBe(503)
      expect((await response?.json()).code).toBe("omp-unavailable")
    } finally {
      await other.dispose()
      await missing.cleanup()
    }
    h.fake.setup((proc) =>
      proc.on("get_available_models", () => {
        throw new Error("discovery failed")
      }),
    )
    expect((await call(engineRoutes.models))?.status).toBe(502)
  })

  test("active, sessions, transcript, final, steps, calls", async () => {
    expect((await call(engineRoutes.active))?.body).toEqual([])
    const { id, proc } = await create()
    await call(sessionRoute(id, "/prompt"), { body: { text: "go" } })
    expect((await call(engineRoutes.active))?.body).toEqual([id])
    proc.emit(frames.userMessage("u1", "go"))
    proc.emit(frames.messageEnd("m1", assistantMessage({ texts: ["answer"], tools: [{ id: "c1", name: "bash", arguments: { command: "ls" } }] })))
    expect((await call(sessionRoute(id, "/transcript")))?.body).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "answer" },
    ])
    expect((await call(sessionRoute(id, "/transcript?limit=1")))?.body).toEqual([{ role: "assistant", text: "answer" }])
    expect((await call(sessionRoute(id, "/final")))?.body).toEqual({ text: "answer" })
    expect((await call(sessionRoute(id, "/steps")))?.body).toHaveLength(1)
    expect((await call(sessionRoute(id, "/calls?limit=5")))?.body).toEqual([{ id: "c1", name: "bash", input: { command: "ls" } }])
    const rows = (await call(engineRoutes.sessions))?.body
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, title: "go", agent: "card-1", model: "anthropic/claude-test" })
  })

  test("a bad limit is a 400; a missing session is a 404 EngineError", async () => {
    const { id } = await create()
    expect((await call(sessionRoute(id, "/calls?limit=zero")))?.status).toBe(400)
    expect((await call(sessionRoute(id, "/calls?limit=0")))?.status).toBe(400)
    const missing = await call(sessionRoute("s_nope", "/final"))
    expect(missing?.status).toBe(404)
    expect(missing?.body).toEqual({ error: "session not found: s_nope", code: "session-not-found" })
  })
})

hosted("writes", () => {
  test("create answers {id}; a bad body is a 400 EngineError; unavailable omp is a 503", async () => {
    const ok = await create()
    expect(ok.response?.status).toBe(200)
    expect(Object.keys(ok.response?.body)).toEqual(["id"])
    const bad = await call(engineRoutes.sessions, { body: { runId: "r" } })
    expect(bad?.status).toBe(400)
    expect(typeof bad?.body.error).toBe("string")
    const missing = await createHarness({ binary: false })
    const other = createEngineHost(missing.deps)
    try {
      const response = await other.handle(new Request(`http://flow.test${engineRoutes.sessions}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) }))
      expect(response?.status).toBe(503)
      expect(await response?.json()).toMatchObject({ code: "omp-unavailable" })
    } finally {
      await other.dispose()
      await missing.cleanup()
    }
  })

  test("prompt is a 202 {accepted:true}; a bad body is a 400; an unknown session a 404", async () => {
    const { id, proc } = await create()
    const accepted = await call(sessionRoute(id, "/prompt"), { body: { text: "go", files: [{ name: "a.txt", url: "data:text/plain,hi" }] } })
    expect(accepted).toMatchObject({ status: 202, body: { accepted: true } })
    expect(proc.of("prompt")[0]?.message).toContain("## Attached files")
    expect((await call(sessionRoute(id, "/prompt"), { body: { text: 4 } }))?.status).toBe(400)
    expect((await call(sessionRoute(id, "/prompt"), { body: [] }))?.status).toBe(400)
    expect((await call(sessionRoute("s_nope", "/prompt"), { body: { text: "x" } }))?.status).toBe(404)
  })

  test("wait answers a WaitResult", async () => {
    const { id, proc } = await create()
    await call(sessionRoute(id, "/prompt"), { body: { text: "go" } })
    expect((await call(sessionRoute(id, "/wait"), { body: { timeoutMs: 1 } }))?.body).toEqual({ status: "timeout" })
    const waiting = call(sessionRoute(id, "/wait"), { body: {} })
    proc.emit(frames.promptResult(String(proc.of("prompt")[0]?.id), "completed"))
    proc.emit(frames.settled())
    expect((await waiting)?.body).toEqual({ status: "idle", result: "completed" })
    expect((await call(sessionRoute("s_nope", "/wait"), { body: {} }))?.body).toEqual({ status: "missing" })
    expect((await call(sessionRoute(id, "/wait"), { body: { timeoutMs: -1 } }))?.status).toBe(400)
  })

  test("permission replies: once, always, reject; bad reply 400; unknown request 404; omp gets its own id", async () => {
    const { id, proc } = await create()
    proc.emit(frames.approval("r1", "Allow tool: bash"))
    const request = await publicId("r1")
    expect((await call(sessionRoute(id, `/permission/${request}`), { body: { reply: "maybe" } }))?.status).toBe(400)
    expect((await call(sessionRoute(id, `/permission/${request}`), { body: { reply: "once" } }))?.status).toBe(200)
    expect(proc.sent).toEqual([{ type: "extension_ui_response", id: "r1", value: "Approve" }])
    const again = await call(sessionRoute(id, `/permission/${request}`), { body: { reply: "once" } })
    expect(again?.status).toBe(404)
    expect(typeof again?.body.error).toBe("string")
    expect((await call(sessionRoute("s_nope", `/permission/${request}`), { body: { reply: "once" } }))?.status).toBe(404)
  })

  test("omp's own id is not an id the browser can answer with, and nothing reaches omp for it", async () => {
    const { id, proc } = await create()
    proc.emit(frames.approval("r1", "Allow tool: bash"))
    expect((await call(sessionRoute(id, "/permission/r1"), { body: { reply: "once" } }))?.status).toBe(404)
    expect(proc.sent).toEqual([])
  })

  test("question answers and rejection", async () => {
    const { id, proc } = await create()
    proc.emit({ type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "a", question: "?", options: [{ label: "x" }] }] })
    const q1 = await publicId("q1")
    expect((await call(sessionRoute(id, `/question/${q1}`), { body: { answers: "x" } }))?.status).toBe(400)
    expect((await call(sessionRoute(id, `/question/${q1}`), { body: { answers: [["x"], ["y"]] } }))?.status).toBe(400)
    expect((await call(sessionRoute(id, `/question/${q1}`), { body: { answers: [["x"]] } }))?.status).toBe(200)
    proc.emit({ type: "extension_ui_request", id: "q2", method: "ask", questions: [{ id: "a", question: "?", options: [] }] })
    const q2 = await publicId("q2")
    expect((await call(sessionRoute(id, `/question/${q2}/reject`), { method: "POST" }))?.status).toBe(200)
    expect((await call(sessionRoute(id, `/question/${q2}/reject`), { method: "POST" }))?.status).toBe(404)
  })

  test("interrupt, delete and release are idempotent 200s", async () => {
    const { id, proc } = await create()
    expect((await call(sessionRoute(id, "/interrupt"), { method: "POST" }))?.status).toBe(200)
    expect(proc.of("abort")).toHaveLength(1)
    expect((await call(sessionRoute("s_nope", "/interrupt"), { method: "POST" }))?.status).toBe(200)
    expect((await call(sessionRoute(id), { method: "DELETE" }))?.status).toBe(200)
    expect((await call(sessionRoute(id), { method: "DELETE" }))?.status).toBe(200)
    expect(proc.closeCalls).toBe(1)

    const a = await create({ ...BODY, runId: "r2", nodeId: "1" })
    const b = await create({ ...BODY, runId: "r2", nodeId: "2" })
    expect((await call(engineRoutes.releaseRun, { body: { runId: "r2" } }))?.body).toEqual({ released: 2 })
    expect([a.proc.closeCalls, b.proc.closeCalls]).toEqual([1, 1])
    expect((await call(engineRoutes.releaseRun, { body: {} }))?.status).toBe(400)
  })

  test("errors never carry stack traces", async () => {
    h.deps.launch = () => {
      throw new Error("launch exploded")
    }
    const response = await call(engineRoutes.sessions, { body: BODY })
    expect(response?.status).toBe(500)
    expect(Object.keys(response?.body).sort()).toEqual(["code", "error"])
    expect(JSON.stringify(response?.body)).not.toContain(" at ")
  })
})

hosted("a create is counted from the route", () => {
  test("while its body is still being read the engine is already working, and not once the create has failed", async () => {
    const chunks = new TransformStream<Uint8Array>()
    const request = new Request(`http://flow.test${engineRoutes.sessions}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunks.readable,
      // A streamed request body must say so.
      duplex: "half",
    } as RequestInit)
    expect(engine.working()).toBe(false)
    const handling = engine.handle(request)
    expect(engine.working()).toBe(true)
    const writer = chunks.writable.getWriter()
    await writer.write(new TextEncoder().encode("{not json"))
    await writer.close()
    expect((await handling)?.status).toBe(400)
    expect(engine.working()).toBe(false)
  })
})

hosted("a create body that fails while the host is shutting down", () => {
  test.each([
    ["not JSON", "{nope", 400],
    ["oversized", JSON.stringify({ pad: "x".repeat(2_000_000) }), 413],
  ])("%s is answered with its own status and leaves no unhandled rejection", async (_name, raw, status) => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", record)
    try {
      await engine.dispose()
      const response = await engine.handle(
        new Request(`http://flow.test${engineRoutes.sessions}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw }),
      )
      // The shutdown is reported first; the body's own failure is settled, not orphaned. Either way, a clean JSON error and nothing unhandled.
      expect([status, 409]).toContain(response?.status as number)
      // Unhandled rejections surface on a later turn of the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      process.off("unhandledRejection", record)
    }
    expect(unhandled).toEqual([])
  })
})

hosted("a create whose body never arrives", () => {
  test("is answered 408 after the deadline and no longer holds the project", async () => {
    const short = createEngineHost({ ...h.deps, bodyDeadlineMs: 30 })
    try {
      const chunks = new TransformStream<Uint8Array>()
      const request = new Request(`http://flow.test${engineRoutes.sessions}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunks.readable,
        duplex: "half",
      } as RequestInit)
      const handling = short.handle(request)
      expect(short.working()).toBe(true)
      const response = await handling
      expect(response?.status).toBe(408)
      expect(await response?.json()).toMatchObject({ code: "request-timeout" })
      expect(short.working()).toBe(false)
    } finally {
      await short.dispose()
    }
  })
})

describe("event bus", () => {
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string, seen = { value: "" }) {
    const decoder = new TextDecoder()
    while (!seen.value.includes(text)) {
      const chunk = await reader.read()
      if (chunk.done) break
      seen.value += decoder.decode(chunk.value)
    }
    return seen.value
  }

  test("every subscriber gets every event as data: <json>, after a flushing comment", async () => {
    const bus = createEventBus()
    const a = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const b = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const event: BusEvent = { type: "session.next.text.delta", data: { sessionID: "s_1", textID: "t", delta: "hi" } }
    bus.publish(event)
    for (const reader of [a, b]) {
      const text = await readUntil(reader, "\n\ndata:")
      expect(text.startsWith(": connected\n\n")).toBe(true)
      expect(await readUntil(reader, `data: ${JSON.stringify(event)}\n\n`, { value: text })).toContain(`data: ${JSON.stringify(event)}\n\n`)
    }
    expect(bus.clients()).toBe(2)
    bus.close()
  })

  test("the response is an event stream", () => {
    const bus = createEventBus()
    const response = bus.subscribe()
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-store")
    bus.close()
  })

  test("pings keep the stream alive and stop when nobody listens", async () => {
    // A real 5 ms interval: the ping timer is the behaviour under test.
    const bus = createEventBus({ pingMs: 5 })
    const reader = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    expect(await readUntil(reader, ": ping\n\n")).toContain(": ping\n\n")
    await reader.cancel()
    expect(bus.clients()).toBe(0)
  })

  test("cancelling or aborting unsubscribes", async () => {
    const bus = createEventBus()
    const controller = new AbortController()
    bus.subscribe(controller.signal)
    const second = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    expect(bus.clients()).toBe(2)
    controller.abort()
    expect(bus.clients()).toBe(1)
    await second.cancel()
    expect(bus.clients()).toBe(0)
    bus.publish({ type: "x" })
  })

  test("a client whose queue passes the limit is dropped and the others are not", async () => {
    const bus = createEventBus({ maxQueueBytes: 1024, pingMs: 60_000 })
    const slow = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const fast = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const big: BusEvent = { type: "big", data: { text: "x".repeat(600) } }
    for (let index = 0; index < 4; index++) {
      bus.publish(big)
      await readUntil(fast, `"big"`, { value: "" })
    }
    expect(bus.clients()).toBe(1)
    // The dropped stream still delivers what was queued, then ends.
    let total = 0
    for (;;) {
      const chunk = await slow.read()
      if (chunk.done) break
      total += chunk.value.byteLength
    }
    expect(total).toBeGreaterThan(0)
    bus.close()
  })

  test("a bus that never had a gap sends no reset, and two tabs after one overflow drop each get exactly one", async () => {
    let clock = 1_000_000
    const bus = createEventBus({ maxQueueBytes: 1024, pingMs: 60_000, now: () => clock })
    const healthy = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    expect(await readUntil(healthy, ": connected\n\n")).not.toContain("flow.stream.reset")
    bus.subscribe()
    for (let index = 0; index < 4; index++) bus.publish({ type: "big", data: { text: "x".repeat(600) } })
    expect(bus.clients()).toBe(0)

    clock += 5_000
    const first = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const second = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    bus.publish({ type: "marker" })
    for (const tab of [first, second]) {
      const text = await readUntil(tab, `"marker"`)
      expect(text.split("flow.stream.reset")).toHaveLength(2)
    }
    bus.close()
  })

  test("a subscriber attaching after the window has passed, with no later gap, gets no reset", async () => {
    let clock = 1_000_000
    const bus = createEventBus({ pingMs: 60_000, now: () => clock })
    bus.publish({ type: "lost" })
    clock += 61_000
    const late = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    bus.publish({ type: "marker" })
    expect(await readUntil(late, `"marker"`)).not.toContain("flow.stream.reset")
    bus.close()
  })

  test("events published while nobody was attached are a gap: a subscriber within the window gets the reset before the replayed asks", async () => {
    let clock = 1_000_000
    const asked: BusEvent = { type: "permission.v2.asked", data: { id: "r1", sessionID: "s_1", action: "bash", resources: [] } }
    const bus = createEventBus({ pingMs: 60_000, replay: () => [asked], now: () => clock })
    bus.publish({ type: "lost" })
    clock += 30_000
    const next = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const text = await readUntil(next, JSON.stringify(asked))
    expect(text.indexOf(": connected")).toBeLessThan(text.indexOf("flow.stream.reset"))
    expect(text.indexOf("flow.stream.reset")).toBeLessThan(text.indexOf(JSON.stringify(asked)))
    bus.close()
  })

  test("a stream asked for after close is already closed and registers nothing", async () => {
    const bus = createEventBus({ pingMs: 60_000 })
    bus.close()
    const response = bus.subscribe()
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(bus.clients()).toBe(0)
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    expect((await reader.read()).done).toBe(true)
    expect(bus.clients()).toBe(0)
  })

  test("one event larger than the whole queue is replaced by a notice and drops nobody", async () => {
    const bus = createEventBus({ maxQueueBytes: 2048, pingMs: 60_000 })
    const reader = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    await readUntil(reader, ": connected\n\n")
    bus.publish({ type: "session.next.tool.called", data: { sessionID: "s_1", input: { text: "x".repeat(10_000) } } })
    expect(bus.clients()).toBe(1)
    const text = await readUntil(reader, "flow.notice", { value: "" })
    expect(text).toContain('"sessionID":"s_1"')
    expect(text).not.toContain("xxxxxxxx")
    bus.publish({ type: "later" })
    expect(await readUntil(reader, `"later"`, { value: "" })).toContain(`"later"`)
    bus.close()
  })

  test("a subscriber that attaches after a drop is told, first, that it missed events, then gets the replay, and only it does", async () => {
    const asked: BusEvent = { type: "permission.v2.asked", data: { id: "r1", sessionID: "s_1", action: "bash", resources: [] } }
    const bus = createEventBus({ maxQueueBytes: 1024, pingMs: 60_000, replay: () => [asked] })
    const first = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    // Before any drop nobody has missed anything: no reset marker, the replay alone.
    const opening = await readUntil(first, JSON.stringify(asked))
    expect(opening).not.toContain("flow.stream.reset")
    bus.subscribe()
    for (let index = 0; index < 4; index++) bus.publish({ type: "big", data: { text: "x".repeat(600) } })
    expect(bus.clients()).toBe(0)

    const next = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const other = bus.subscribe().body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const text = await readUntil(next, JSON.stringify(asked))
    expect(text.indexOf("flow.stream.reset")).toBeGreaterThan(text.indexOf(": connected"))
    expect(text.indexOf("flow.stream.reset")).toBeLessThan(text.indexOf(JSON.stringify(asked)))
    expect(text.split(JSON.stringify(asked))).toHaveLength(2)
    // A live event is not a replay: the subscriber that is already attached does not see the old ask again.
    bus.publish({ type: "later" })
    const after = await readUntil(next, `"later"`, { value: "" })
    expect(after).not.toContain("permission.v2.asked")
    await other.cancel()
    bus.close()
  })

  test.skipIf(process.platform === "win32")("pending approvals and questions reach a stream that attaches after a slow one was dropped: once each, none already answered", async () => {
    const attach = async () => {
      const response = await engine.handle(new Request(`http://flow.test${engineRoutes.events}`))
      return response?.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    }
    const { id, proc } = await create()
    await attach()
    proc.emit(frames.approval("r1", "Allow tool: bash\ncommand: ls"))
    proc.emit(frames.approval("r2", "Allow tool: edit\npath: a.ts"))
    proc.emit({ type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "k", question: "Which?", options: [{ label: "A" }, { label: "B" }], multi: false }] })
    // The attached stream never reads: a few megabytes of output pass its limit and it is dropped.
    proc.emit(frames.messageStart("msg-1"))
    for (let index = 0; index < 5; index++) proc.emit(frames.textDelta("msg-1", 0, "x".repeat(1024 * 1024)))
    expect((await call(sessionRoute(id, `/permission/${await publicId("r1")}`), { body: { reply: "once" } }))?.status).toBe(200)

    const reader = await attach()
    const text = await readUntil(reader, "question.v2.asked")
    expect(text).toContain("flow.stream.reset")
    expect(text.match(/permission\.v2\.asked/g)).toHaveLength(1)
    expect(text).toMatch(/"id":"[A-Za-z0-9_-]{6}\.r2"/)
    expect(text).not.toMatch(/"id":"[A-Za-z0-9_-]{6}\.r1"/)
    expect(text.match(/question\.v2\.asked/g)).toHaveLength(1)
    await reader.cancel()
  })

  test.skipIf(process.platform === "win32")("end to end over a real socket: events from a session reach an SSE client, and aborting it is clean", async () => {
    const server = Bun.serve({ port: 0, fetch: async (request) => (await engine.handle(request)) ?? new Response("not ours", { status: 404 }) })
    const origin = `http://127.0.0.1:${server.port}`
    const controller = new AbortController()
    try {
      const stream = await fetch(`${origin}${engineRoutes.events}`, { signal: controller.signal })
      expect(stream.status).toBe(200)
      expect(stream.headers.get("content-type")).toContain("text/event-stream")
      const reader = stream.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>

      const created = await fetch(`${origin}${engineRoutes.sessions}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) })
      const { id } = (await created.json()) as { id: string }
      const proc = h.fake.procs.at(-1) as FakeProcess
      proc.emit(frames.messageStart("msg-1"))
      const text = await readUntil(reader, "session.next.step.started")
      const line = text.split("\n").find((entry) => entry.startsWith("data: ") && entry.includes("step.started"))
      expect(JSON.parse((line as string).slice(6))).toMatchObject({ type: "session.next.step.started", data: { sessionID: id } })

      const final = await fetch(`${origin}${sessionRoute(id, "/final")}`)
      expect(await final.json()).toEqual({ text: "" })
      controller.abort()
    } finally {
      await server.stop(true)
    }
  })
})

describe("startup prune", () => {
  async function runDir(name: string, when: Date) {
    const state = path.join(h.stateRoot, name, "n1")
    await fs.mkdir(state, { recursive: true })
    await fs.writeFile(path.join(state, "role.md"), "x")
    for (const target of [path.join(state, "role.md"), state, path.dirname(state)]) await fs.utimes(target, when, when)
  }

  test("removes expired runs once, shortly after the host is created, and reports what it did", async () => {
    const now = Date.now()
    await runDir("expired", new Date(now - 45 * 24 * 60 * 60 * 1000))
    await runDir("fresh", new Date(now - 24 * 60 * 60 * 1000))
    const pruning = createEngineHost({ ...h.deps, prune: { delayMs: 0, now: () => now } })
    try {
      expect(await pruning.pruned).toEqual({ removed: ["expired"], errors: 0 })
      expect(existsSync(path.join(h.stateRoot, "expired"))).toBe(false)
      expect(existsSync(path.join(h.stateRoot, "fresh", "n1", "role.md"))).toBe(true)
    } finally {
      await pruning.dispose()
    }
  })

  test("a failing prune never reaches the caller: it is counted", async () => {
    // The state root is a file: it cannot be read as a directory.
    await fs.writeFile(h.stateRoot, "not a directory")
    const pruning = createEngineHost({ ...h.deps, prune: { delayMs: 0 } })
    try {
      expect((await pruning.pruned).errors).toBe(1)
    } finally {
      await pruning.dispose()
    }
  })

  test("disposing before the delay cancels it", async () => {
    await runDir("expired", new Date(0))
    const pruning = createEngineHost({ ...h.deps, prune: { delayMs: 60_000 } })
    await pruning.dispose()
    expect(await pruning.pruned).toEqual({ removed: [], errors: 0 })
    expect(existsSync(path.join(h.stateRoot, "expired"))).toBe(true)
  })
})

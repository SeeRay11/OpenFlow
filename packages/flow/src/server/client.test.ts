import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { BusEvent, WaitResult } from "../../shared/engine"
import { ENGINE_BASE } from "../../shared/engine"
import {
  accepts,
  connect,
  createSession,
  disconnect,
  formatModel,
  health,
  interrupt,
  models,
  parseModel,
  project,
  prompt,
  rejectQuestion,
  release,
  releaseRun,
  replyPermission,
  replyQuestion,
  sessionCalls,
  sessionSteps,
  sessionTranscript,
  sessions,
  setOrigin,
  subscribe,
  testModel,
  transcript,
  waitForIdle,
} from "./client"

/** The run id a recorded request body carries, or "" when it names none. */
const runIdOf = (body: unknown) => (body && typeof body === "object" && "runId" in body ? String(body.runId) : "")

type Seen = { method: string; path: string; search: string; body: unknown }

const seen: Seen[] = []
/** What `/wait` answers per session id; anything else is "missing". */
const waits = new Map<string, WaitResult>()
/** Answers consumed one per `/wait` request before `waits` applies, for sessions that settle after a few slices. */
const waitQueue = new Map<string, WaitResult[]>()
/** Run when a `/wait` request arrives, before the host answers; receives the `timeoutMs` it asked for. */
let onWait: ((timeoutMs: number) => void) | undefined
/** The project `/context` answers with, and what runs before it answers: a slow host. */
let contextProject = "/tmp/project"
let onContext: (() => Promise<void>) | undefined
/** Transcript per session id for `/final`. */
const finals = new Map<string, { text: string; error?: string }>()
/** What the `events` route writes, chunk by chunk, then closes (or holds open when `hold`). */
let eventChunks: string[] = []
let hold = false
let streamCancelled = Promise.withResolvers<void>()
let waitAborted = Promise.withResolvers<void>()
let waitHeld = Promise.withResolvers<void>()
let createHeld = Promise.withResolvers<void>()
let createAborted = Promise.withResolvers<void>()

function reply(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const text = await request.text()
    const body = text ? JSON.parse(text) : undefined
    seen.push({ method: request.method, path: url.pathname, search: url.search, body })

    if (url.pathname === "/flow/api/context") {
      const project = contextProject
      await onContext?.()
      return reply(200, { project, pipelines: "/tmp/p", runs: "/tmp/r", generated: "/tmp/g" })
    }
    if (url.pathname === `${ENGINE_BASE}/health`) {
      return reply(200, { ok: true, omp: { available: true, version: "18.12.2" }, sessions: { live: 0 } })
    }
    if (url.pathname === `${ENGINE_BASE}/models`) {
      return reply(200, [{ providerID: "anthropic", id: "claude-opus-5", capabilities: { input: ["text", "image"] } }])
    }
    if (url.pathname === `${ENGINE_BASE}/events`) {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of eventChunks) controller.enqueue(encoder.encode(chunk))
            if (!hold) controller.close()
          },
          cancel() {
            streamCancelled.resolve()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === `${ENGINE_BASE}/runs/release`) return reply(200, { released: 1 })
    if (url.pathname === `${ENGINE_BASE}/sessions` && request.method === "POST") {
      if (body.model === "openai/hangs") {
        // A host still starting omp: the answer comes only when the caller gives up.
        createHeld.resolve()
        const pending = Promise.withResolvers<Response>()
        request.signal.addEventListener(
          "abort",
          () => {
            createAborted.resolve()
            pending.resolve(reply(499, { error: "client closed request" }))
          },
          { once: true },
        )
        return pending.promise
      }
      if (body.model === "openrouter/rate-limited") {
        return reply(429, { error: "Provider request failed with HTTP 429 Too Many Requests: slow down" })
      }
      return reply(200, { id: body.model === "openai/gpt-broken" ? "ses_broken" : "ses_1" })
    }
    if (url.pathname === `${ENGINE_BASE}/sessions`) {
      return reply(200, [{ id: "ses_1", title: "coder", created: 1, updated: 2 }])
    }

    const match = /^\/flow\/api\/engine\/sessions\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!match) return reply(404, { error: "no such route" })
    const id = decodeURIComponent(match[1])
    const tail = match[2] ?? ""

    if (tail === "" && request.method === "DELETE") return reply(200, { released: id })
    if (tail === "/prompt") return reply(200, { accepted: true })
    if (tail === "/wait") {
      onWait?.(body.timeoutMs)
      if (id === "hang") {
        waitHeld.resolve()
        const held = Promise.withResolvers<Response>()
        request.signal.addEventListener(
          "abort",
          () => {
            waitAborted.resolve()
            held.resolve(reply(499, { error: "client closed request" }))
          },
          { once: true },
        )
        return held.promise
      }
      if (id === "running") {
        // Real delay on purpose: the client's deadline is the wall clock, so the host must hold the request
        // for the slice it was asked for, as the real host does, before saying the session is still running.
        await Bun.sleep(body.timeoutMs)
        return reply(200, { status: "timeout" })
      }
      const queued = waitQueue.get(id)?.shift()
      return reply(200, queued ?? waits.get(id) ?? { status: "missing" })
    }
    if (tail === "/interrupt") return id === "broken" ? reply(500, { error: "boom" }) : reply(200, {})
    if (tail === "/final" && id === "gone") return reply(404, { error: "session not found: gone" })
    if (tail === "/final") return reply(200, finals.get(id) ?? { text: "" })
    if (tail === "/transcript") return reply(200, [{ role: "user", text: "hello" }])
    if (tail === "/steps") {
      return reply(200, [{ messageID: "m1", model: "anthropic/claude-opus-5", tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }])
    }
    if (tail === "/calls") return reply(200, [{ id: "c1", name: "bash", input: { command: "ls" } }])
    if (tail === "/permission/withdrawn") return reply(404, { error: "permission request not found or already answered: withdrawn" })
    if (tail.startsWith("/permission/") || tail.startsWith("/question/")) return reply(200, { ok: true })
    return reply(404, { error: `session not found: ${id}` })
  },
})

beforeAll(() => setOrigin(server.url.origin))
afterAll(async () => {
  setOrigin("")
  await server.stop(true)
})
beforeEach(() => {
  seen.length = 0
  waits.clear()
  waitQueue.clear()
  onWait = undefined
  contextProject = "/tmp/project"
  onContext = undefined
  finals.clear()
  eventChunks = []
  hold = false
  streamCancelled = Promise.withResolvers<void>()
  waitAborted = Promise.withResolvers<void>()
  waitHeld = Promise.withResolvers<void>()
  createHeld = Promise.withResolvers<void>()
  createAborted = Promise.withResolvers<void>()
})

describe("models", () => {
  test("parseModel splits on the first slash, keeping nested ids whole", () => {
    expect(parseModel("openrouter/anthropic/claude-opus-5")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-opus-5",
    })
    expect(parseModel("claude")).toBeUndefined()
    expect(parseModel("/claude")).toBeUndefined()
    expect(parseModel(undefined)).toBeUndefined()
  })

  test("formatModel inverts parseModel", () => {
    expect(formatModel(parseModel("openai/gpt-5"))).toBe("openai/gpt-5")
    expect(formatModel(undefined)).toBe("")
  })

  test("accepts reads the input modalities and lets text-ish files through", () => {
    const info = { providerID: "anthropic", id: "x", capabilities: { input: ["text", "image"] } }
    expect(accepts(info, "image/png")).toBe(true)
    expect(accepts(info, "application/pdf")).toBe(false)
    expect(accepts(info, "audio/wav")).toBe(false)
    expect(accepts(info, "text/markdown")).toBe(true)
    expect(accepts(undefined, "image/png")).toBe(false)
  })
})

describe("context and catalog over the wire", () => {
  test("connect caches the context, disconnect drops it", async () => {
    expect(() => project()).toThrow("not connected")
    const first = await connect()
    expect(first.context.project).toBe("/tmp/project")
    expect(project()).toBe("/tmp/project")
    await connect()
    expect(seen.filter((entry) => entry.path === "/flow/api/context")).toHaveLength(1)
    disconnect()
    expect(() => project()).toThrow("not connected")
  })

  test("a connect that was in flight across a disconnect does not cache the old project", async () => {
    const held = Promise.withResolvers<void>()
    const arrived = Promise.withResolvers<void>()
    contextProject = "/tmp/old"
    onContext = async () => {
      arrived.resolve()
      await held.promise
    }
    const slow = connect()
    await arrived.promise
    // The user switched project while the old answer was still on its way.
    disconnect()
    contextProject = "/tmp/new"
    onContext = undefined
    held.resolve()
    expect((await slow).context.project).toBe("/tmp/new")
    expect(project()).toBe("/tmp/new")
  })

  test("health, models, sessions and a transcript read their routes", async () => {
    expect((await health()).omp.version).toBe("18.12.2")
    expect((await models())[0].id).toBe("claude-opus-5")
    expect((await sessions(5))[0].title).toBe("coder")
    expect(seen.at(-1)?.search).toBe("?limit=5")
    expect(await sessionTranscript("ses_1", 7)).toEqual([{ role: "user", text: "hello" }])
    expect(seen.at(-1)?.path).toBe(`${ENGINE_BASE}/sessions/ses_1/transcript`)
    expect(seen.at(-1)?.search).toBe("?limit=7")
  })

  test("steps, calls and the final transcript come back as the wire shapes", async () => {
    expect((await sessionSteps("ses_1"))[0].messageID).toBe("m1")
    expect(await sessionCalls("ses_1", 3)).toEqual([{ id: "c1", name: "bash", input: { command: "ls" } }])
    expect(seen.at(-1)?.search).toBe("?limit=3")
    finals.set("ses_1", { text: "done" })
    expect(await transcript("ses_1")).toEqual({ text: "done" })
  })
})

describe("sessions", () => {
  test("createSession posts the spec and returns the id", async () => {
    const spec = { runId: "r1", nodeId: "n1", card: { key: "coder-n1", role: "coder" }, model: "anthropic/claude-opus-5" }
    expect(await createSession(spec)).toEqual({ id: "ses_1" })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `${ENGINE_BASE}/sessions`, body: spec })
  })

  test("a provider failure keeps its status wording so the engine can classify it", async () => {
    const failure = await createSession({
      runId: "r1",
      nodeId: "n1",
      card: { key: "k", role: "r" },
      model: "openrouter/rate-limited",
    }).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ status: 429 })
    // The engine classifies retries by regex on this status wording.
    expect((failure as Error).message).toMatch(/HTTP 429/)
  })

  test("an abort of a create in flight drops the request and rejects with the abort, not a host answer", async () => {
    const controller = new AbortController()
    const pending = createSession({ runId: "r1", nodeId: "n1", card: { key: "k", role: "r" }, model: "openai/hangs" }, controller.signal).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    await createHeld.promise
    controller.abort()
    const error = await pending
    await createAborted.promise
    expect((error as Error).name).toBe("AbortError")
    expect(error).not.toHaveProperty("status")
  })

  test("a failed route surfaces the wire's own sentence with the status", async () => {
    const failure = await transcript("gone").catch((error: Error) => error)
    expect(failure).toMatchObject({ status: 404 })
    expect((failure as Error).message).toContain("404")
  })

  test("prompt sends text, and only the file fields the wire defines", async () => {
    await prompt("ses_1", "hi", [{ name: "a.png", url: "data:image/png;base64,AA==", mime: "image/png" }])
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: `${ENGINE_BASE}/sessions/ses_1/prompt`,
      body: { text: "hi", files: [{ name: "a.png", url: "data:image/png;base64,AA==", mime: "image/png" }] },
    })
    await prompt("ses_1", "plain")
    expect(seen.at(-1)?.body).toEqual({ text: "plain" })
  })

  test("permission and question answers go to their routes, ids encoded", async () => {
    await replyPermission("ses_1", "per/1", "always")
    expect(seen.at(-1)).toMatchObject({ path: `${ENGINE_BASE}/sessions/ses_1/permission/per%2F1`, body: { reply: "always" } })
    await replyQuestion("ses_1", "q1", [["yes"]])
    expect(seen.at(-1)).toMatchObject({ path: `${ENGINE_BASE}/sessions/ses_1/question/q1`, body: { answers: [["yes"]] } })
    await rejectQuestion("ses_1", "q1")
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `${ENGINE_BASE}/sessions/ses_1/question/q1/reject` })
  })

  test("a reply to a request the host no longer has fails with the HTTP status, for callers that treat 404 as already gone", async () => {
    const error = await replyPermission("ses_1", "withdrawn", "once").then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ status: 404 })
  })

  test("interrupt never throws, release disposes, releaseRun names the run", async () => {
    await interrupt("broken")
    await interrupt("ses_1")
    await release("ses_1")
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: `${ENGINE_BASE}/sessions/ses_1` })
    await releaseRun("r1")
    expect(seen.at(-1)).toMatchObject({ path: `${ENGINE_BASE}/runs/release`, body: { runId: "r1" } })
  })
})

describe("waitForIdle", () => {
  test("a completed settle resolves and forwards the timeout", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    await waitForIdle("ses_1", { timeout: 1234, interval: 500 })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `${ENGINE_BASE}/sessions/ses_1/wait`, body: { timeoutMs: 1234 } })
  })

  test("an error result throws the host's text", async () => {
    const text = "the host's own failure text"
    waits.set("ses_1", { status: "idle", result: "error", error: text })
    await expect(waitForIdle("ses_1")).rejects.toThrow(text)
  })

  test("an abort nobody asked for is an error, one the caller asked for is silent", async () => {
    waits.set("ses_1", { status: "idle", result: "aborted" })
    await expect(waitForIdle("ses_1")).rejects.toThrow("the session was interrupted")
    const controller = new AbortController()
    controller.abort()
    await waitForIdle("ses_1", { signal: controller.signal })
  })

  test("a result that aborts while the caller's signal fires is silent", async () => {
    waits.set("ses_1", { status: "idle", result: "aborted" })
    const controller = new AbortController()
    const pending = waitForIdle("ses_1", { signal: controller.signal })
    controller.abort()
    await pending
  })

  test("missing throws its sentence, with or without a budget", async () => {
    await expect(waitForIdle("ses_2")).rejects.toThrow("ses_2")
    await expect(waitForIdle("ses_2", { timeout: 1000, slice: 10 })).rejects.toThrow("ses_2")
  })

  test("a session that is missing or failed after some slices still maps to its sentence", async () => {
    waitQueue.set("ses_1", [{ status: "timeout" }, { status: "missing" }])
    await expect(waitForIdle("ses_1", { timeout: 1000, slice: 10 })).rejects.toThrow("ses_1")
    const text = "the host's own failure text"
    waitQueue.set("ses_1", [{ status: "timeout" }, { status: "idle", result: "error", error: text }])
    await expect(waitForIdle("ses_1", { timeout: 1000, slice: 10 })).rejects.toThrow(text)
  })

  test("re-polls in slices until the session settles, never holding a request longer than a slice", async () => {
    waitQueue.set("ses_1", [{ status: "timeout" }, { status: "timeout" }, { status: "idle", result: "completed" }])
    const asked: number[] = []
    onWait = (timeoutMs) => asked.push(timeoutMs)
    await waitForIdle("ses_1", { timeout: 5000, slice: 50 })
    expect(asked).toHaveLength(3)
    expect(asked.every((timeoutMs) => timeoutMs <= 50)).toBe(true)
  })

  test("with no budget it loops until the session settles, asking a slice each time", async () => {
    waitQueue.set("ses_1", [{ status: "timeout" }, { status: "idle", result: "completed" }])
    await waitForIdle("ses_1", { slice: 25 })
    expect(seen.map((entry) => entry.body)).toEqual([{ timeoutMs: 25 }, { timeoutMs: 25 }])
  })

  test("a session that never settles times out only after the overall budget, asking for no more than what is left", async () => {
    const timeout = 120
    const asked: number[] = []
    onWait = (timeoutMs) => asked.push(timeoutMs)
    const started = Date.now()
    await expect(waitForIdle("running", { timeout, slice: 40 })).rejects.toThrow("timed out waiting for the session to finish")
    expect(Date.now() - started).toBeGreaterThanOrEqual(timeout)
    expect(asked.length).toBeGreaterThan(1)
    expect(asked.every((timeoutMs) => timeoutMs <= 40)).toBe(true)
    // Each request is held for what it asked, so the asks can never add up to more than the budget.
    expect(asked.reduce((total, timeoutMs) => total + timeoutMs, 0)).toBeLessThanOrEqual(timeout)
  })

  test("an abort between slices returns silently and stops polling", async () => {
    waitQueue.set("ses_1", [{ status: "timeout" }, { status: "timeout" }, { status: "timeout" }])
    const controller = new AbortController()
    onWait = () => controller.abort()
    await waitForIdle("ses_1", { timeout: 5000, slice: 10, signal: controller.signal })
    expect(seen).toHaveLength(1)
  })

  test("aborting the signal ends a long-poll the host is still holding", async () => {
    const controller = new AbortController()
    const pending = waitForIdle("hang", { signal: controller.signal })
    // The request is in flight once the host has seen it.
    await waitHeld.promise
    controller.abort()
    await pending
    await waitAborted.promise
  })
})

describe("subscribe", () => {
  function collect() {
    const events: BusEvent[] = []
    return { events, onEvent: (event: BusEvent) => events.push(event) }
  }

  test("parses events across chunk boundaries, CRLF and comments, then resolves at stream end", async () => {
    eventChunks = [
      ': ping\n\ndata: {"type":"a","data":{"sessionID":"s1"}}\r',
      '\n\r\n: ping\r\n\r\ndata: {"ty',
      'pe":"b","data":{"x":1}}\n\ndata:{"type":"c"}\n\n',
      // multi-line data joins with a newline, so this is one JSON document
      'data: {"type":"d",\ndata: "data":{"y":2}}\n\n',
      "data: not json\n\n",
      'data: {"nope":true}\n\n',
      // never terminated by a blank line: discarded, not delivered
      'data: {"type":"unterminated"}\n',
    ]
    const { events, onEvent } = collect()
    await subscribe(onEvent, new AbortController().signal)
    expect(events.map((event) => event.type)).toEqual(["a", "b", "c", "d"])
    expect(events[0].data).toEqual({ sessionID: "s1" })
    expect(events[1].data).toEqual({ x: 1 })
    expect(events[3].data).toEqual({ y: 2 })
  })

  test("a CR ending a chunk waits for its LF instead of ending the line twice", async () => {
    eventChunks = ['data: {"type":"a"}\r', '\n\r\ndata: {"type":"b"}\r\n\r\n']
    const { events, onEvent } = collect()
    await subscribe(onEvent, new AbortController().signal)
    expect(events.map((event) => event.type)).toEqual(["a", "b"])
  })

  test("a CRLF split across chunks does not end the event early", async () => {
    // Read naively, the bare CR ends the first data line and the LF then reads as a blank line,
    // delivering `{"type":"a",` alone. Held back, both lines belong to one event.
    eventChunks = ['data: {"type":"a",\r', '\ndata: "data":{"x":1}}\r\n\r\n']
    const { events, onEvent } = collect()
    await subscribe(onEvent, new AbortController().signal)
    expect(events).toEqual([{ type: "a", data: { x: 1 } }])
  })

  test("resolves when the signal aborts while the stream is held open, and closes the stream", async () => {
    hold = true
    eventChunks = ['data: {"type":"first"}\n\n']
    const controller = new AbortController()
    const first = Promise.withResolvers<void>()
    const subscribed = subscribe(() => first.resolve(), controller.signal)
    await first.promise
    controller.abort()
    await subscribed
    await streamCancelled.promise
  })

  test("an already-aborted signal never opens the stream", async () => {
    const controller = new AbortController()
    controller.abort()
    await subscribe(() => {}, controller.signal)
    expect(seen.some((entry) => entry.path === `${ENGINE_BASE}/events`)).toBe(false)
  })
})

describe("testModel", () => {
  test("a model that answers is ok, and the throwaway session is released", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    finals.set("ses_1", { text: "ok" })
    const result = await testModel("anthropic/claude-opus-5")
    expect(result.ok).toBe(true)
    const create = seen.find((entry) => entry.method === "POST" && entry.path === `${ENGINE_BASE}/sessions`)
    expect(runIdOf(create?.body)).toStartWith("model-test-")
    expect(create?.body).toMatchObject({
      card: { key: "openflow-model-test" },
      model: "anthropic/claude-opus-5",
    })
    expect(seen.find((entry) => entry.path.endsWith("/prompt"))?.body).toEqual({ text: "Reply with the single word ok." })
    expect(seen.find((entry) => entry.method === "DELETE")).toMatchObject({ path: `${ENGINE_BASE}/sessions/ses_1` })
    expect(seen.at(-1)?.path).toBe(`${ENGINE_BASE}/runs/release`)
  })

  test("a provider error in the transcript is the failure, and the session is still released", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    finals.set("ses_1", { text: "", error: "HTTP 401 Unauthorized" })
    const result = await testModel("openai/gpt-5")
    expect(result).toMatchObject({ ok: false, error: "HTTP 401 Unauthorized" })
    expect(seen.some((entry) => entry.method === "DELETE")).toBe(true)
  })

  test("an empty answer is not ok", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    expect(await testModel("openai/gpt-5")).toMatchObject({ ok: false, error: "the model returned no text" })
  })

  test("a session that cannot be created reports the host's error and releases nothing", async () => {
    const result = await testModel("openrouter/rate-limited")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/HTTP 429/)
    expect(seen.some((entry) => entry.method === "DELETE")).toBe(false)
  })

  test("every test opens its own run, and gives it back", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    finals.set("ses_1", { text: "ok" })
    await Promise.all([testModel("anthropic/claude-opus-5"), testModel("openai/gpt-5")])
    const runs = seen
      .filter((entry) => entry.method === "POST" && entry.path === `${ENGINE_BASE}/sessions`)
      .map((entry) => runIdOf(entry.body))
    expect(runs).toHaveLength(2)
    expect(new Set(runs).size).toBe(2)
    const released = seen.filter((entry) => entry.path === `${ENGINE_BASE}/runs/release`).map((entry) => runIdOf(entry.body))
    expect(released.toSorted()).toEqual(runs.toSorted())
  })
})

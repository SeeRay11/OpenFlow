import { afterAll, beforeAll, beforeEach, describe as suite, expect, test } from "bun:test"
import type { BusEvent, EngineApi, WaitResult } from "../../shared/engine"
import { ENGINE_BASE } from "../../shared/engine"
import * as client from "./client"

const { accepts, describe, formatModel, parseModel } = client

/** Compile-time proof that the module is a complete `EngineApi`. */
export const engineApi = client satisfies EngineApi

type Seen = { method: string; path: string; search: string; body: unknown }

const seen: Seen[] = []
/** What `/wait` answers per session id; anything else is "missing". */
const waits = new Map<string, WaitResult>()
/** Transcript per session id for `/final`. */
const finals = new Map<string, { text: string; error?: string }>()
/** What the `events` route writes, chunk by chunk, then closes (or holds open when `hold`). */
let eventChunks: string[] = []
let hold = false
let streamCancelled = Promise.withResolvers<void>()
let waitAborted = Promise.withResolvers<void>()
let waitHeld = Promise.withResolvers<void>()

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
      return reply(200, { project: "/tmp/project", pipelines: "/tmp/p", runs: "/tmp/r", generated: "/tmp/g" })
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
      return reply(200, waits.get(id) ?? { status: "missing" })
    }
    if (tail === "/interrupt") return id === "broken" ? reply(500, { error: "boom" }) : reply(200, {})
    if (tail === "/final" && id === "gone") return reply(404, { error: "session not found: gone" })
    if (tail === "/final") return reply(200, finals.get(id) ?? { text: "" })
    if (tail === "/transcript") return reply(200, [{ role: "user", text: "hello" }])
    if (tail === "/steps") {
      return reply(200, [{ messageID: "m1", model: "anthropic/claude-opus-5", tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }])
    }
    if (tail === "/calls") return reply(200, [{ id: "c1", name: "bash", input: { command: "ls" } }])
    if (tail.startsWith("/permission/") || tail.startsWith("/question/")) return reply(200, { ok: true })
    return reply(404, { error: `session not found: ${id}` })
  },
})

beforeAll(() => client.setOrigin(server.url.origin))
afterAll(async () => {
  client.setOrigin("")
  await server.stop(true)
})
beforeEach(() => {
  seen.length = 0
  waits.clear()
  finals.clear()
  eventChunks = []
  hold = false
  streamCancelled = Promise.withResolvers<void>()
  waitAborted = Promise.withResolvers<void>()
  waitHeld = Promise.withResolvers<void>()
})

suite("describe", () => {
  test("prefers a message field over the raw body", () => {
    expect(describe({ message: "Model claude-opus-5 is not supported" })).toBe("Model claude-opus-5 is not supported")
  })

  test("reads a message nested under data", () => {
    expect(describe({ data: { message: "no such agent" } })).toBe("no such agent")
  })

  test("reads the error field of an engine wire body", () => {
    expect(describe({ error: "session not found: ses_9" })).toBe("session not found: ses_9")
  })

  test("prefers message over error when a body carries both", () => {
    expect(describe({ message: "engine is down", error: "engine is down" })).toBe("engine is down")
  })

  test("ignores a non-string error field rather than printing [object Object]", () => {
    expect(describe({ error: { code: 500 } })).toBe('{"error":{"code":500}}')
  })

  test("an empty body renders as the status, never as {}", () => {
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
    expect(describe({}, response)).toBe("HTTP 502 Bad Gateway")
    expect(describe(undefined, response)).toBe("HTTP 502 Bad Gateway")
  })

  test("appends the status to a body that does say something", () => {
    const response = new Response(null, { status: 503, statusText: "Service Unavailable" })
    expect(describe({ error: "omp is not installed" }, response)).toBe("omp is not installed (HTTP 503 Service Unavailable)")
  })

  test("a successful response adds nothing", () => {
    expect(describe(new Error("boom"), new Response(null, { status: 200 }))).toBe("boom")
  })

  test("falls back to the _tag, then to unknown", () => {
    expect(describe({ _tag: "ProviderAuthError" })).toBe("ProviderAuthError")
    expect(describe(undefined)).toBe("unknown error")
  })
})

suite("models", () => {
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

suite("context and catalog over the wire", () => {
  test("connect caches the context, disconnect drops it", async () => {
    expect(() => client.project()).toThrow("not connected")
    const first = await client.connect()
    expect(first.context.project).toBe("/tmp/project")
    expect(client.project()).toBe("/tmp/project")
    await client.connect()
    expect(seen.filter((entry) => entry.path === "/flow/api/context")).toHaveLength(1)
    client.disconnect()
    expect(() => client.project()).toThrow("not connected")
  })

  test("health, models, sessions and a transcript read their routes", async () => {
    expect((await client.health()).omp.version).toBe("18.12.2")
    expect((await client.models())[0].id).toBe("claude-opus-5")
    expect((await client.sessions(5))[0].title).toBe("coder")
    expect(seen.at(-1)?.search).toBe("?limit=5")
    expect(await client.sessionTranscript("ses_1", 7)).toEqual([{ role: "user", text: "hello" }])
    expect(seen.at(-1)?.path).toBe(`${ENGINE_BASE}/sessions/ses_1/transcript`)
    expect(seen.at(-1)?.search).toBe("?limit=7")
  })

  test("steps, calls and the final transcript come back as the wire shapes", async () => {
    expect((await client.sessionSteps("ses_1"))[0].messageID).toBe("m1")
    expect(await client.sessionCalls("ses_1", 3)).toEqual([{ id: "c1", name: "bash", input: { command: "ls" } }])
    expect(seen.at(-1)?.search).toBe("?limit=3")
    finals.set("ses_1", { text: "done" })
    expect(await client.transcript("ses_1")).toEqual({ text: "done" })
  })
})

suite("sessions", () => {
  test("createSession posts the spec and returns the id", async () => {
    const spec = { runId: "r1", nodeId: "n1", card: { key: "coder-n1", role: "coder" }, model: "anthropic/claude-opus-5" }
    expect(await client.createSession(spec)).toEqual({ id: "ses_1" })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `${ENGINE_BASE}/sessions`, body: spec })
  })

  test("a provider failure keeps its status wording so the engine can classify it", async () => {
    const failure = await client
      .createSession({ runId: "r1", nodeId: "n1", card: { key: "k", role: "r" }, model: "openrouter/rate-limited" })
      .catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/HTTP 429 Too Many Requests: slow down/)
  })

  test("a failed route surfaces the wire's own sentence with the status", async () => {
    const failure = await client.transcript("gone").catch((error: Error) => error)
    expect((failure as Error).message).toBe("session not found: gone (HTTP 404 Not Found)")
  })

  test("prompt sends text, and only the file fields the wire defines", async () => {
    await client.prompt("ses_1", "hi", [{ name: "a.png", url: "data:image/png;base64,AA==", mime: "image/png" }])
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: `${ENGINE_BASE}/sessions/ses_1/prompt`,
      body: { text: "hi", files: [{ name: "a.png", url: "data:image/png;base64,AA==", mime: "image/png" }] },
    })
    await client.prompt("ses_1", "plain")
    expect(seen.at(-1)?.body).toEqual({ text: "plain" })
  })

  test("permission and question answers go to their routes, ids encoded", async () => {
    await client.replyPermission("ses_1", "per/1", "always")
    expect(seen.at(-1)).toMatchObject({ path: `${ENGINE_BASE}/sessions/ses_1/permission/per%2F1`, body: { reply: "always" } })
    await client.replyQuestion("ses_1", "q1", [["yes"]])
    expect(seen.at(-1)).toMatchObject({ path: `${ENGINE_BASE}/sessions/ses_1/question/q1`, body: { answers: [["yes"]] } })
    await client.rejectQuestion("ses_1", "q1")
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `${ENGINE_BASE}/sessions/ses_1/question/q1/reject` })
  })

  test("interrupt never throws, release disposes, releaseRun names the run", async () => {
    await client.interrupt("broken")
    await client.interrupt("ses_1")
    await client.release("ses_1")
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: `${ENGINE_BASE}/sessions/ses_1` })
    await client.releaseRun("r1")
    expect(seen.at(-1)).toMatchObject({ path: `${ENGINE_BASE}/runs/release`, body: { runId: "r1" } })
  })
})

suite("waitForIdle", () => {
  test("a completed settle resolves and forwards the timeout", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    await client.waitForIdle("ses_1", { timeout: 1234, interval: 500 })
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `${ENGINE_BASE}/sessions/ses_1/wait`, body: { timeoutMs: 1234 } })
  })

  test("an error result throws the host's text", async () => {
    waits.set("ses_1", { status: "idle", result: "error", error: "Provider request failed with HTTP 401 Unauthorized" })
    await expect(client.waitForIdle("ses_1")).rejects.toThrow("Provider request failed with HTTP 401 Unauthorized")
  })

  test("an abort nobody asked for is an error, one the caller asked for is silent", async () => {
    waits.set("ses_1", { status: "idle", result: "aborted" })
    await expect(client.waitForIdle("ses_1")).rejects.toThrow("the session was interrupted")
    const controller = new AbortController()
    controller.abort()
    await client.waitForIdle("ses_1", { signal: controller.signal })
  })

  test("a result that aborts while the caller's signal fires is silent", async () => {
    waits.set("ses_1", { status: "idle", result: "aborted" })
    const controller = new AbortController()
    const pending = client.waitForIdle("ses_1", { signal: controller.signal })
    controller.abort()
    await pending
  })

  test("timeout and missing throw their sentences", async () => {
    waits.set("ses_1", { status: "timeout" })
    await expect(client.waitForIdle("ses_1")).rejects.toThrow("timed out waiting for the session to finish")
    await expect(client.waitForIdle("ses_2")).rejects.toThrow("session not found: ses_2")
  })

  test("aborting the signal ends a long-poll the host is still holding", async () => {
    const controller = new AbortController()
    const pending = client.waitForIdle("hang", { signal: controller.signal })
    // The request is in flight once the host has seen it.
    await waitHeld.promise
    controller.abort()
    await pending
    await waitAborted.promise
  })
})

suite("subscribe", () => {
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
    await client.subscribe(onEvent, new AbortController().signal)
    expect(events.map((event) => event.type)).toEqual(["a", "b", "c", "d"])
    expect(events[0].data).toEqual({ sessionID: "s1" })
    expect(events[1].data).toEqual({ x: 1 })
    expect(events[3].data).toEqual({ y: 2 })
  })

  test("a CR ending a chunk waits for its LF instead of ending the line twice", async () => {
    eventChunks = ['data: {"type":"a"}\r', '\n\r\ndata: {"type":"b"}\r\n\r\n']
    const { events, onEvent } = collect()
    await client.subscribe(onEvent, new AbortController().signal)
    expect(events.map((event) => event.type)).toEqual(["a", "b"])
  })

  test("a CRLF split across chunks does not end the event early", async () => {
    // Read naively, the bare CR ends the first data line and the LF then reads as a blank line,
    // delivering `{"type":"a",` alone. Held back, both lines belong to one event.
    eventChunks = ['data: {"type":"a",\r', '\ndata: "data":{"x":1}}\r\n\r\n']
    const { events, onEvent } = collect()
    await client.subscribe(onEvent, new AbortController().signal)
    expect(events).toEqual([{ type: "a", data: { x: 1 } }])
  })

  test("resolves when the signal aborts while the stream is held open, and closes the stream", async () => {
    hold = true
    eventChunks = ['data: {"type":"first"}\n\n']
    const controller = new AbortController()
    const first = Promise.withResolvers<void>()
    const subscribed = client.subscribe(() => first.resolve(), controller.signal)
    await first.promise
    controller.abort()
    await subscribed
    await streamCancelled.promise
  })

  test("an already-aborted signal never opens the stream", async () => {
    const controller = new AbortController()
    controller.abort()
    await client.subscribe(() => {}, controller.signal)
    expect(seen.some((entry) => entry.path === `${ENGINE_BASE}/events`)).toBe(false)
  })
})

suite("testModel", () => {
  test("a model that answers is ok, and the throwaway session is released", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    finals.set("ses_1", { text: "ok" })
    const result = await client.testModel("anthropic/claude-opus-5")
    expect(result.ok).toBe(true)
    const create = seen.find((entry) => entry.method === "POST" && entry.path === `${ENGINE_BASE}/sessions`)
    expect(create?.body).toMatchObject({
      runId: "model-test",
      card: { key: "openflow-model-test" },
      model: "anthropic/claude-opus-5",
    })
    expect(seen.find((entry) => entry.path.endsWith("/prompt"))?.body).toEqual({ text: "Reply with the single word ok." })
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: `${ENGINE_BASE}/sessions/ses_1` })
  })

  test("a provider error in the transcript is the failure, and the session is still released", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    finals.set("ses_1", { text: "", error: "HTTP 401 Unauthorized" })
    const result = await client.testModel("openai/gpt-5")
    expect(result).toMatchObject({ ok: false, error: "HTTP 401 Unauthorized" })
    expect(seen.at(-1)?.method).toBe("DELETE")
  })

  test("an empty answer is not ok", async () => {
    waits.set("ses_1", { status: "idle", result: "completed" })
    expect(await client.testModel("openai/gpt-5")).toMatchObject({ ok: false, error: "the model returned no text" })
  })

  test("a session that cannot be created reports the host's error and releases nothing", async () => {
    const result = await client.testModel("openrouter/rate-limited")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/HTTP 429/)
    expect(seen.some((entry) => entry.method === "DELETE")).toBe(false)
  })
})

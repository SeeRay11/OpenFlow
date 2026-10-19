import { afterEach, describe, expect, test } from "bun:test"
import { createServer, request as httpRequest, type Server } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { createGate } from "./gate"
import { nodeMiddleware } from "./node-adapter"
import { json, type HostHandler } from "./respond"

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    const closing = Promise.withResolvers<void>()
    server.close(() => closing.resolve())
    await closing.promise
  }
})

/** A connect-style chain: the adapter, then a fallthrough that answers 418 and records what it could still read. */
async function start(handler: HostHandler) {
  const fell: Array<{ url: string; body: string }> = []
  /** One entry per response, settled when its connection side has closed. */
  const closed: Array<Promise<void>> = []
  const middleware = nodeMiddleware(handler)
  const server = createServer((req, res) => {
    const done = Promise.withResolvers<void>()
    closed.push(done.promise)
    // Registered before the adapter's own listener, so it is settled only after the adapter has had its say on the same event.
    res.once("close", () => done.resolve())
    middleware(req, res, () => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        fell.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") })
        res.statusCode = 418
        res.end("next")
      })
    })
  })
  servers.push(server)
  const listening = Promise.withResolvers<void>()
  server.listen(0, "127.0.0.1", () => listening.resolve())
  await listening.promise
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fell, closed }
}

describe("request", () => {
  test("carries method, url, query, headers and a JSON body to the handler", async () => {
    const seen: unknown[] = []
    const { base } = await start(async (request) => {
      seen.push({ method: request.method, url: new URL(request.url).pathname + new URL(request.url).search, header: request.headers.get("x-probe"), body: await request.json() })
      return json(201, { ok: true })
    })
    const response = await fetch(`${base}/flow/api/x?a=1`, { method: "POST", headers: { "x-probe": "yes", "content-type": "application/json" }, body: JSON.stringify({ n: 1 }) })
    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({ ok: true })
    expect(seen).toEqual([{ method: "POST", url: "/flow/api/x?a=1", header: "yes", body: { n: 1 } }])
  })

  test("GET and HEAD have no body", async () => {
    const { base } = await start(async (request) => json(200, { body: request.body === null }))
    expect(await (await fetch(`${base}/a`)).json()).toEqual({ body: true })
  })

  test("multi-valued response headers survive", async () => {
    const { base } = await start(async () => {
      const response = json(200, {})
      response.headers.append("set-cookie", "a=1")
      response.headers.append("set-cookie", "b=2")
      return response
    })
    expect((await fetch(`${base}/a`)).headers.getSetCookie()).toEqual(["a=1", "b=2"])
  })
})

describe("fall through", () => {
  test("undefined calls next, and a body nobody read is still there for the next middleware", async () => {
    const { base, fell } = await start(async () => undefined)
    const response = await fetch(`${base}/flow/api/pipelines/x`, { method: "POST", body: JSON.stringify({ name: "kept" }) })
    expect(response.status).toBe(418)
    expect(await response.text()).toBe("next")
    expect(fell).toEqual([{ url: "/flow/api/pipelines/x", body: '{"name":"kept"}' }])
  })
})

describe("fall through keeps the whole body", () => {
  /** Several writes of one body, so the node stream carries more than one chunk. */
  function send(base: string, chunks: Buffer[]) {
    const done = Promise.withResolvers<number>()
    const url = new URL(`${base}/flow/api/pipelines/x`)
    const outgoing = httpRequest(url, { method: "PUT", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (response) => {
      response.resume()
      response.once("end", () => done.resolve(response.statusCode ?? 0))
    })
    outgoing.on("error", done.reject)
    void (async () => {
      for (const chunk of chunks) {
        const flushed = Promise.withResolvers<void>()
        outgoing.write(chunk, () => flushed.resolve())
        await flushed.promise
      }
      outgoing.end()
    })()
    return done.promise
  }

  test("a handler that answers undefined after looking at headers leaves the next middleware the complete multi-chunk body", async () => {
    const seen: string[] = []
    const { base, fell } = await start(async (request) => {
      seen.push(request.headers.get("content-type") ?? "")
      return undefined
    })
    const payload = JSON.stringify({ nodes: Array.from({ length: 4000 }, (_, index) => ({ id: `n${index}`, prompt: "x".repeat(40) })) })
    expect(payload.length).toBeGreaterThan(200_000)
    const bytes = Buffer.from(payload)
    const chunks: Buffer[] = []
    for (let at = 0; at < bytes.length; at += 40_000) chunks.push(bytes.subarray(at, at + 40_000))
    expect(await send(base, chunks)).toBe(418)
    expect(seen).toEqual(["application/json"])
    expect(fell).toHaveLength(1)
    expect(fell[0].body.length).toBe(payload.length)
    expect(fell[0].body).toBe(payload)
  })
})

describe("a Host that is not a valid URL authority", () => {
  /** A raw HTTP/1.1 exchange: fetch and node's own client refuse to send these Host values. */
  async function raw(base: string, host: string | undefined, version = "1.1") {
    const port = Number(new URL(base).port)
    const socket = connect(port, "127.0.0.1")
    const closed = Promise.withResolvers<string>()
    let text = ""
    socket.on("data", (data) => (text += data.toString("utf8")))
    socket.on("close", () => closed.resolve(text))
    socket.on("error", () => closed.resolve(text))
    socket.write(`GET /flow/api/omp/settings HTTP/${version}\r\n${host === undefined ? "" : `Host: ${host}\r\n`}Connection: close\r\n\r\n`)
    return closed.promise
  }

  test.each(["localhost@evil.example", "localhost:5174@evil.example", "evil.example#localhost", "localhost:99999", "localhost%00.evil.example"])(
    "%s answers a JSON 403 forbidden-host through the gate",
    async (host) => {
      const { base, fell } = await start(createGate(false))
      const text = await raw(base, host)
      expect(text).toStartWith("HTTP/1.1 403")
      expect(text).toContain("application/json")
      expect(text).toContain('"code":"forbidden-host"')
      expect(fell).toEqual([])
    },
  )

  // HTTP/1.0 may omit Host. The adapter used to invent `localhost` for it, so the gate passed it on this host and refused it on Bun.
  test("a request without any Host header is a JSON 403 forbidden-host", async () => {
    const { base, fell } = await start(createGate(false))
    const text = await raw(base, undefined, "1.0")
    expect(text).toStartWith("HTTP/1.1 403")
    expect(text).toContain('"code":"forbidden-host"')
    expect(fell).toEqual([])
  })
})

describe("streaming", () => {
  test("every chunk reaches the client as written, before the stream ends", async () => {
    const gate = Promise.withResolvers<void>()
    const { base } = await start(async () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("data: one\n\n"))
            await gate.promise
            controller.enqueue(encoder.encode("data: two\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const response = await fetch(`${base}/events`)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n")
    gate.resolve()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe("data: two\n\n")
    expect((await reader.read()).done).toBe(true)
  })

  test("a client that leaves aborts the request signal and cancels the body", async () => {
    const aborted = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const { base } = await start(async (request) => {
      request.signal.addEventListener("abort", () => aborted.resolve())
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(encoder.encode(": ping\n\n")),
          cancel: () => cancelled.resolve(),
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    const controller = new AbortController()
    const response = await fetch(`${base}/events`, { signal: controller.signal })
    await response.body!.getReader().read()
    controller.abort()
    await Promise.all([aborted.promise, cancelled.promise])
  })

  test("a client that leaves while the handler is still working aborts the request signal", async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const aborted = Promise.withResolvers<void>()
    const { base } = await start((request) => {
      request.signal.addEventListener("abort", () => aborted.resolve())
      entered.resolve(request.signal)
      return Promise.withResolvers<Response | undefined>().promise
    })
    const controller = new AbortController()
    const pending = fetch(`${base}/slow`, { method: "POST", body: "{}", signal: controller.signal }).catch(() => undefined)
    const signal = await entered.promise
    expect(signal.aborted).toBe(false)
    controller.abort()
    await aborted.promise
    await pending
    expect(signal.aborted).toBe(true)
  })

  test("a response that finishes normally never aborts the request signal", async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const { base, closed } = await start(async (request) => {
      entered.resolve(request.signal)
      return json(200, { ok: true })
    })
    const response = await fetch(`${base}/quick`, { headers: { connection: "close" } })
    expect(await response.json()).toEqual({ ok: true })
    // Wait for the server to see the connection go, which is where a wrong `close` listener would abort.
    await Promise.all(closed)
    expect((await entered.promise).aborted).toBe(false)
  })
})

describe("limits and failures", () => {
  test("a declared body over 8 MiB is a 413 and never reaches the handler", async () => {
    let called = false
    const { base } = await start(async () => {
      called = true
      return json(200, {})
    })
    const response = await fetch(`${base}/a`, { method: "POST", body: new Uint8Array(8 * 1024 * 1024 + 1) })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: "too-large" })
    expect(called).toBe(false)
  })

  test("a streamed body that grows past 8 MiB is a 413 too", async () => {
    const { base } = await start(async (request) => {
      await request.arrayBuffer().catch(() => undefined)
      return json(200, { read: true })
    })
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const response = await fetch(`${base}/a`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ === 9) return controller.close()
          controller.enqueue(chunk)
        },
      }),
      // @ts-expect-error Bun and Node need this for a streamed request body
      duplex: "half",
    })
    expect(response.status).toBe(413)
  })

  test("a throwing handler is a 500 without internals", async () => {
    const { base } = await start(async () => {
      throw new Error("secret detail at /home/user/x.ts:1")
    })
    const response = await fetch(`${base}/a`)
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: "internal error", code: "internal" })
    expect(text).not.toContain("secret")
  })

  test("a stream that fails after headers ends the connection instead of hanging", async () => {
    const { base } = await start(async () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("partial"))
            controller.error(new Error("boom"))
          },
        }),
      )
    })
    const text = await fetch(`${base}/a`).then((response) => response.text()).catch(() => "closed")
    expect(["closed", "partial"]).toContain(text)
  })
})

/** How the vite plugin mounts the gate: first, in front of routes (the store's) that the adapter itself never serves. */
describe("the gate in front of the dev middleware chain", () => {
  const gate = createGate(false)
  const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" }

  test("a cross-site simple POST is a 403 and the store route behind it never sees it", async () => {
    const { base, fell } = await start(gate)
    const response = await fetch(`${base}/flow/api/project`, { method: "POST", headers: evil, body: JSON.stringify({ path: "/tmp" }) })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "forbidden-origin" })
    expect(fell).toEqual([])
  })

  test("a rebound Host is a 403 on a GET", async () => {
    const { base, fell } = await start(gate)
    const response = await fetch(`${base}/flow/api/omp/settings`, { headers: { host: "evil.example" } })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "forbidden-host" })
    expect(fell).toEqual([])
  })

  test("a same-origin JSON request passes untouched, with its body still readable by the next middleware", async () => {
    const { base, fell } = await start(gate)
    const response = await fetch(`${base}/flow/api/project`, {
      method: "POST",
      headers: { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp" }),
    })
    expect(response.status).toBe(418)
    expect(fell).toEqual([{ url: "/flow/api/project", body: '{"path":"/tmp"}' }])
  })

  test("a header-less caller and a path outside /flow/api pass", async () => {
    const { base, fell } = await start(gate)
    expect((await fetch(`${base}/flow/api/env?names=HOME`)).status).toBe(418)
    expect((await fetch(`${base}/index.html`, { headers: { origin: "https://evil.example" } })).status).toBe(418)
    expect(fell.map((entry) => entry.url)).toEqual(["/flow/api/env?names=HOME", "/index.html"])
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { nodeMiddleware } from "./node-adapter"
import { json, type HostHandler } from "./respond"

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** A connect-style chain: the adapter, then a fallthrough that answers 418 and records what it could still read. */
async function start(handler: HostHandler) {
  const fell: Array<{ url: string; body: string }> = []
  const middleware = nodeMiddleware(handler)
  const server = createServer((req, res) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fell }
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

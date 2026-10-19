import type { IncomingMessage, ServerResponse } from "node:http"
import type { HostHandler } from "./respond"

/**
 * Mounts a Web-standard `HostHandler` on a connect-style server (the vite dev
 * server), so `lib/host` modules are written once for both hosts.
 *
 * `undefined` from the handler means "not mine": `next()` runs and the request
 * is untouched, which is why the request body is a lazy stream — a node stream
 * that something has already started reading cannot be read again by the
 * middleware that follows.
 */

/** What connect (and so vite) hands a middleware: the node request plus the url as first received, before any `use(path)` strip. */
type ConnectRequest = IncomingMessage & { originalUrl?: string }

/** The same ceiling `server.ts` and the store routes apply to a request body. */
const MAX_BODY = 8 * 1024 * 1024

const TOO_LARGE = JSON.stringify({ error: "request body too large", code: "too-large" })
const INTERNAL = JSON.stringify({ error: "internal error", code: "internal" })

function sendJson(res: ServerResponse, status: number, body: string) {
  if (res.headersSent) return void res.destroy()
  res.statusCode = status
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.setHeader("cache-control", "no-store")
  res.end(body)
}

/**
 * The absolute URL of the request as first received. A Host that does not form a URL (`localhost:99999`, a NUL
 * byte) must not throw: the base falls back to `localhost`, the raw header still travels in `headers`, and the
 * gate answers 403 for it.
 */
function requestUrl(req: ConnectRequest) {
  // `//x` would parse as a protocol-relative URL naming host `x`, hiding the real path from the gate.
  const target = (req.originalUrl ?? req.url ?? "/").replace(/^\/{2,}/, "/")
  try {
    return new URL(target, `http://${req.headers.host ?? "localhost"}`)
  } catch {
    return new URL(target, "http://localhost")
  }
}

export function nodeMiddleware(handler: HostHandler): (req: ConnectRequest, res: ServerResponse, next: () => void) => void {
  return (req, res, next) => {
    void serve(handler, req, res, next).catch(() => sendJson(res, 500, INTERNAL))
  }
}

async function serve(handler: HostHandler, req: ConnectRequest, res: ServerResponse, next: () => void) {
  const method = req.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  if (hasBody && Number(req.headers["content-length"] ?? 0) > MAX_BODY) return sendJson(res, 413, TOO_LARGE)

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }

  const abort = new AbortController()
  // `close` also fires after a normal finish, when there is nothing left to abort.
  res.once("close", () => {
    if (!res.writableFinished) abort.abort()
  })

  let size = 0
  let exceeded = false
  let iterator: AsyncIterator<Buffer | string> | undefined
  const body = hasBody
    ? new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            iterator ??= req[Symbol.asyncIterator]()
            const chunk = await iterator.next()
            if (chunk.done) return controller.close()
            const bytes = typeof chunk.value === "string" ? Buffer.from(chunk.value) : chunk.value
            size += bytes.length
            if (size > MAX_BODY) {
              exceeded = true
              return controller.error(new Error("request body too large"))
            }
            controller.enqueue(bytes)
          },
          cancel: () => void iterator?.return?.(),
        },
        // The default high-water mark of 1 makes the constructor pull the first chunk before any handler
        // asks for it. A handler that answers `undefined` and calls `next()` would then leave the next
        // middleware a body without its first chunk. 0 keeps the node stream untouched until a read.
        { highWaterMark: 0 },
      )
    : undefined

  const url = requestUrl(req)
  const request = new Request(url, { method, headers, signal: abort.signal, ...(body ? { body, duplex: "half" } : {}) })

  const response = await handler(request)
  if (exceeded) return sendJson(res, 413, TOO_LARGE)
  if (!response) return next()

  res.statusCode = response.status
  for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value)
  const cookies = response.headers.getSetCookie()
  if (cookies.length) res.setHeader("set-cookie", cookies)
  res.flushHeaders()

  if (!response.body) return void res.end()
  const reader = response.body.getReader()
  res.once("close", () => void reader.cancel().catch(() => undefined))
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done || res.destroyed) break
    if (res.write(chunk.value)) continue
    // Backpressure, but a client that left never drains: wait for either.
    const settled = Promise.withResolvers<void>()
    const done = () => {
      res.off("drain", done)
      res.off("close", done)
      settled.resolve()
    }
    res.once("drain", done)
    res.once("close", done)
    await settled.promise
  }
  res.end()
}

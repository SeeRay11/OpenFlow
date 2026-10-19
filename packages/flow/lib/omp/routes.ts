import { ENGINE_BASE, engineRoutes, type BusEvent, type HealthInfo, type PermissionReply, type PromptFile } from "../../shared/engine"
import type { OmpSettings } from "../../shared/omp"
import { HttpError, fail, json, readJson, type HostHandler } from "../host/respond"
import type { Lifecycle } from "../host/lifecycle"
import { checkOmp } from "./binary"
import { asRecord, asString } from "./messages"
import type { ModelCatalog } from "./models"
import type { SessionHost } from "./session"

/**
 * The HTTP face of the engine host: `shared/engine.ts` routes over a
 * `SessionHost`, a `ModelCatalog` and one SSE stream. Answers are bare (arrays
 * are arrays, not envelopes) because the browser client reads them that way.
 */

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
}

const PING_MS = 15_000
/** A client this far behind is gone or stuck; it is dropped and reconnects (there is no replay anyway). */
const MAX_QUEUE_BYTES = 4 * 1024 * 1024
/** Prompts carry attachments as data URLs. */
const PROMPT_BODY_LIMIT = 64 * 1024 * 1024
const BODY_DEADLINE_MS = 10_000
const DEFAULT_LIST_LIMIT = 100
const MAX_LIMIT = 1000

/** A subscriber attaching this long after a gap in the stream is still told it may have missed events. */
const GAP_WINDOW_MS = 60_000

/* --------------------------------------------------------------------- bus */

export type EventBusOptions = {
  pingMs?: number
  maxQueueBytes?: number
  /** The clock the gap window is measured by. Default `Date.now`. */
  now?: () => number
  /** Events a subscriber missed that must not be lost (the dialogs still waiting for an answer): sent to each new subscriber, and only to it, when it attaches. */
  replay?(): BusEvent[]
}

export interface EventBus {
  /** Every session's events go to every subscriber. */
  publish(event: BusEvent): void
  /** A `text/event-stream` response; the subscription ends when the request aborts or the stream is cancelled. */
  subscribe(signal?: AbortSignal): Response
  clients(): number
  /** Ends every stream and refuses later subscribers with a stream that is already closed. */
  close(): void
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const encoder = new TextEncoder()
  const pingMs = options.pingMs ?? PING_MS
  const maxQueueBytes = options.maxQueueBytes ?? MAX_QUEUE_BYTES
  const now = options.now ?? Date.now
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let pinger: ReturnType<typeof setInterval> | undefined
  /** When events last went out that a subscriber did not receive (none was attached, or one was dropped for falling behind); subscribers attaching within `GAP_WINDOW_MS` of it are told. */
  let gapAt: number | undefined
  /** Set by `close()`: a client attaching later gets a closed stream, never a registration and a ping timer on a host that is gone. */
  let closed = false

  function drop(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!clients.delete(controller)) return
    try {
      controller.close()
    } catch {
      // Already closed by a cancel racing this drop.
    }
    if (!clients.size && pinger) {
      clearInterval(pinger)
      pinger = undefined
    }
  }

  function send(chunk: Uint8Array) {
    for (const controller of [...clients]) {
      try {
        controller.enqueue(chunk)
      } catch {
        gapAt = now()
        drop(controller)
        continue
      }
      if (controller.desiredSize !== null && controller.desiredSize < 0) {
        gapAt = now()
        drop(controller)
      }
    }
  }

  return {
    publish(event) {
      if (!clients.size) {
        gapAt = now()
        return
      }
      let chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
      // The queue drops a client on the chunk that overflows it. One event larger than the whole queue never reaches anyone, so say so instead of dropping every client for it.
      if (chunk.byteLength > maxQueueBytes) {
        const note = { type: "flow.notice", data: { sessionID: event.data?.sessionID, level: "error", message: `an ${event.type} event of ${chunk.byteLength} bytes was too large to deliver` } }
        chunk = encoder.encode(`data: ${JSON.stringify(note)}\n\n`)
      }
      send(chunk)
    },

    subscribe(signal) {
      if (closed) return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), { headers: SSE_HEADERS })
      let mine: ReadableStreamDefaultController<Uint8Array> | undefined
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            mine = controller
            clients.add(controller)
            // Flushes the headers: a fetch does not resolve until the first byte.
            controller.enqueue(encoder.encode(": connected\n\n"))
            // Every subscriber attaching within the window after a gap is told, not only the first: two tabs reconnecting after one drop both need to resynchronise.
            if (gapAt !== undefined && now() - gapAt <= GAP_WINDOW_MS) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "flow.stream.reset" })}\n\n`))
            for (const event of options.replay?.() ?? []) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            pinger ??= setInterval(() => send(encoder.encode(": ping\n\n")), pingMs)
            pinger.unref?.()
          },
          cancel() {
            if (mine) drop(mine)
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: maxQueueBytes }),
      )
      signal?.addEventListener("abort", () => mine && drop(mine), { once: true })
      return new Response(stream, { headers: SSE_HEADERS })
    },

    clients() {
      return clients.size
    },

    close() {
      closed = true
      for (const controller of [...clients]) drop(controller)
    },
  }
}

/* ------------------------------------------------------------------ routes */

export type RoutesDeps = {
  settings(): Promise<OmpSettings>
  env?: NodeJS.ProcessEnv
  sessions: SessionHost
  models: ModelCatalog
  bus: EventBus
  /** The lifecycle the health probe's `omp --version` runs in. */
  life?: Lifecycle
  /** How long the body of a create may take to arrive before the request is answered 408 and its count released. Default 10 s. */
  bodyDeadlineMs?: number
}

/** The body of a create is a few kilobytes: one that has not arrived after this long is a stalled connection, and must not hold the project. */
function withDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new HttpError(408, "the request body did not arrive in time", "request-timeout")), ms)
  expired.promise.catch(() => undefined)
  return Promise.race([read, expired.promise]).finally(() => clearTimeout(timer))
}

function limitOf(url: URL, fallback: number): number {
  const raw = url.searchParams.get("limit")
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new HttpError(400, "limit must be a positive integer", "bad-request")
  return Math.min(value, MAX_LIMIT)
}

function methodNotAllowed(): Response {
  return fail(405, "method not allowed", "method-not-allowed")
}

const REPLIES: readonly string[] = ["once", "always", "reject"]

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, "malformed path segment", "bad-request")
  }
}

export function createRoutes(deps: RoutesDeps): HostHandler {
  async function health(): Promise<Response> {
    const status = await checkOmp(await deps.settings(), deps.env ?? process.env, deps.life)
    const body: HealthInfo = {
      ok: status.available,
      omp: { available: status.available, ...(status.version ? { version: status.version } : {}) },
      sessions: { live: deps.sessions.live() },
    }
    return json(200, body)
  }

  async function session(request: Request, url: URL, id: string, tail: string[]): Promise<Response | undefined> {
    const method = request.method
    const [action, requestID, extra] = tail
    if (action === undefined) {
      if (method !== "DELETE") return methodNotAllowed()
      await deps.sessions.dispose(id)
      return json(200, { ok: true })
    }

    switch (action) {
      case "prompt": {
        if (method !== "POST") return methodNotAllowed()
        const body = asRecord(await readJson(request, PROMPT_BODY_LIMIT))
        if (!body) throw new HttpError(400, "request body must be a JSON object", "bad-request")
        await deps.sessions.prompt(id, { text: body.text as string, files: body.files as PromptFile[] | undefined })
        return json(202, { accepted: true })
      }
      case "wait": {
        if (method !== "POST") return methodNotAllowed()
        const body = asRecord(await readJson(request))
        const timeoutMs = body?.timeoutMs
        if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !(timeoutMs > 0))) throw new HttpError(400, "timeoutMs must be a positive number", "bad-request")
        return json(200, await deps.sessions.wait(id, { timeoutMs }, request.signal))
      }
      case "interrupt":
        if (method !== "POST") return methodNotAllowed()
        await deps.sessions.interrupt(id)
        return json(200, { ok: true })
      case "transcript":
        if (method !== "GET") return methodNotAllowed()
        return json(200, await deps.sessions.turns(id, limitOf(url, 50)))
      case "final":
        if (method !== "GET") return methodNotAllowed()
        return json(200, await deps.sessions.final(id))
      case "steps":
        if (method !== "GET") return methodNotAllowed()
        return json(200, await deps.sessions.steps(id))
      case "calls":
        if (method !== "GET") return methodNotAllowed()
        return json(200, await deps.sessions.calls(id, limitOf(url, 30)))
      case "permission": {
        if (method !== "POST" || !requestID || extra !== undefined) return methodNotAllowed()
        const reply = asString(asRecord(await readJson(request))?.reply)
        if (!reply || !REPLIES.includes(reply)) throw new HttpError(400, 'reply must be "once", "always" or "reject"', "bad-request")
        deps.sessions.replyPermission(id, requestID, reply as PermissionReply)
        return json(200, { ok: true })
      }
      case "question": {
        if (method !== "POST" || !requestID) return methodNotAllowed()
        if (extra === "reject") {
          deps.sessions.rejectQuestion(id, requestID)
          return json(200, { ok: true })
        }
        if (extra !== undefined) return undefined
        const raw = asRecord(await readJson(request))?.answers
        if (!Array.isArray(raw) || !raw.every((entry) => Array.isArray(entry) && entry.every((label) => typeof label === "string")))
          throw new HttpError(400, "answers must be a list of string lists, one per question", "bad-request")
        const answers = raw as string[][]
        deps.sessions.replyQuestion(id, requestID, answers)
        return json(200, { ok: true })
      }
    }
    return undefined
  }

  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname !== ENGINE_BASE && !url.pathname.startsWith(`${ENGINE_BASE}/`)) return undefined
    const method = request.method

    switch (url.pathname) {
      case engineRoutes.health:
        return method === "GET" ? health() : methodNotAllowed()
      case engineRoutes.models:
        return method === "GET" ? json(200, await deps.models.list()) : methodNotAllowed()
      case engineRoutes.events:
        return method === "GET" ? deps.bus.subscribe(request.signal) : methodNotAllowed()
      case engineRoutes.active:
        return method === "GET" ? json(200, deps.sessions.active()) : methodNotAllowed()
      case engineRoutes.releaseRun: {
        if (method !== "POST") return methodNotAllowed()
        const runId = asString(asRecord(await readJson(request))?.runId)
        if (!runId) throw new HttpError(400, "runId must be a non-empty string", "bad-request")
        return json(200, { released: await deps.sessions.releaseRun(runId) })
      }
      case engineRoutes.sessions: {
        // The body is handed over still pending: the create is counted from the route, so a project switch cannot land while it is being read. A body that stalls is given up on after the deadline.
        if (method === "POST") return json(200, await deps.sessions.create(withDeadline(readJson(request), deps.bodyDeadlineMs ?? BODY_DEADLINE_MS), request.signal))
        if (method === "GET") return json(200, await deps.sessions.list(limitOf(url, DEFAULT_LIST_LIMIT)))
        return methodNotAllowed()
      }
    }

    const prefix = `${engineRoutes.sessions}/`
    if (!url.pathname.startsWith(prefix)) return undefined
    const [raw, ...tail] = url.pathname.slice(prefix.length).split("/")
    if (!raw) return undefined
    return session(request, url, decode(raw), tail.map(decode))
  }
}

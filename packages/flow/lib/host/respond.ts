/**
 * What every host module (`lib/omp`, `lib/uplift`, `lib/substrate`, `lib/swarm`,
 * `lib/omp-config`, `lib/terminal`) shares: one handler type and the JSON
 * helpers around Web-standard `Request` / `Response`.
 *
 * Web-standard on purpose: Bun's `Bun.serve` takes these directly, and the vite
 * dev plugin adapts them from Node's `IncomingMessage` / `ServerResponse` once
 * (`lib/host`), so a module is written once for both hosts.
 */

/** `undefined` means "not mine": the composer tries the next handler. */
export type HostHandler = (request: Request) => Promise<Response | undefined>

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }

export class HttpError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** The `EngineError` shape: `{ error, code? }`. */
export function fail(status: number, error: string, code?: string): Response {
  return json(status, code ? { error, code } : { error })
}

/** Parses a JSON body; refuses anything over `limit` bytes (default 1 MiB) or that is not JSON. */
export async function readJson<T = unknown>(request: Request, limit = 1_048_576): Promise<T> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new HttpError(413, "request body too large", "too-large")
  const text = await request.text()
  if (text.length > limit) throw new HttpError(413, "request body too large", "too-large")
  try {
    return JSON.parse(text || "null") as T
  } catch {
    throw new HttpError(400, "request body is not valid JSON", "bad-json")
  }
}

/**
 * Turns a thrown `HttpError` into its JSON answer and anything else into a 500
 * that names the failure without a stack or an environment value.
 */
export function guarded(handler: HostHandler): HostHandler {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message, error.code)
      return fail(500, error instanceof Error ? error.message : "internal error", "internal")
    }
  }
}

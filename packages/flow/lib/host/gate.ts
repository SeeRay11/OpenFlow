import { fail, isJsonContentType, type HostHandler } from "./respond"

/**
 * The one gate in front of every `/flow/**` HTTP request: engine, settings,
 * uplift, memory, swarm, the store routes and the SSE stream. Without it any web
 * page the user visits can POST `text/plain` JSON at a loopback port (a "simple"
 * request, no preflight), and a DNS-rebound name can read the answers.
 *
 * Requests that carry no browser headers at all (curl, scripts, the eval tooling)
 * pass the Origin and Sec-Fetch rules: only a browser sends those, and a browser
 * is the thing being fenced. The terminal keeps its own, stricter policy
 * (`lib/terminal/policy.ts`: a custom header and a one-shot ticket) on top.
 */

export type Refusal = { status: number; error: string; code: string }

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i

/** A Host header that names this machine. Anything else is DNS rebinding or a LAN client. */
export function loopbackHost(host: string | null): host is string {
  if (host === null) return false
  const match = LOOPBACK_HOST.exec(host)
  if (!match) return false
  return match[2] === undefined || Number(match[2].slice(1)) <= 65535
}

/** `Origin` must be exactly the page that served us: `http(s)://<the Host it was sent to>`. */
export function sameOrigin(origin: string | null, host: string) {
  if (!origin) return false
  const lower = host.toLowerCase()
  const given = origin.toLowerCase()
  return given === `http://${lower}` || given === `https://${lower}`
}

/** The URL's pathname, or `undefined` when the URL does not parse (a malformed Host makes the server build such a URL). */
function pathnameOf(url: string) {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

/** The Host the client addressed; a request without one falls back to the URL's, and an unparseable URL has no host (never loopback). */
export function hostOf(request: Request) {
  const header = request.headers.get("host")
  if (header !== null) return header
  try {
    return new URL(request.url).host
  } catch {
    return ""
  }
}

/** Whether the request declares a body: a non-zero length or a chunked transfer. */
function carriesBody(headers: Headers) {
  if (headers.has("transfer-encoding")) return true
  const length = headers.get("content-length")
  return length !== null && Number(length) !== 0
}

/**
 * What the gate covers: everything under `/flow`. Deliberately broader than any router: connect (vite)
 * matches a mount prefix case-insensitively and lets a `.` follow it, so `/FLOW/api/x` and `/flow/api./x`
 * reach handlers that a strict `/flow/api/` test would never have gated. Every host, store and terminal
 * route lives under `/flow`, so over-matching only ever adds a check.
 */
const GATED = /^\/flow(?:[/.]|$)/i

/** The refusal for one request, or `undefined` when it may proceed. Pure: no I/O, no state. */
export function apiRefusal(request: Request, allowRemote: boolean): Refusal | undefined {
  const host = hostOf(request)
  if (!allowRemote && !loopbackHost(host)) {
    return {
      status: 403,
      error: "OpenFlow only answers requests addressed to localhost, 127.0.0.1 or [::1]. Open it from one of those, or start it with FLOW_ALLOW_REMOTE=1.",
      code: "forbidden-host",
    }
  }
  const origin = request.headers.get("origin")
  if (origin !== null && !sameOrigin(origin, host)) {
    return {
      status: 403,
      error: "Cross-origin request refused: only the page this OpenFlow host serves may call its API.",
      code: "forbidden-origin",
    }
  }
  const site = request.headers.get("sec-fetch-site")
  if (site !== null && site !== "same-origin" && site !== "none") {
    return {
      status: 403,
      error: "Cross-site request refused: only the page this OpenFlow host serves may call its API.",
      code: "forbidden-origin",
    }
  }
  if (carriesBody(request.headers) && !isJsonContentType(request.headers.get("content-type"))) {
    return {
      status: 403,
      error: "Request bodies must be sent with the content type application/json.",
      code: "forbidden-content-type",
    }
  }
  return undefined
}

/**
 * The gate as a `HostHandler`: a 403 JSON answer for a refused `/flow`
 * request, `undefined` (let it through) for everything else, so it composes in
 * front of any handler chain on either host.
 */
export function createGate(allowRemote: boolean): HostHandler {
  return async (request) => {
    const pathname = pathnameOf(request.url)
    if (pathname === undefined) return fail(403, "The Host header of this request is malformed.", "forbidden-host")
    if (!GATED.test(pathname)) return undefined
    const refusal = apiRefusal(request, allowRemote)
    if (!refusal) return undefined
    return fail(refusal.status, refusal.error, refusal.code)
  }
}

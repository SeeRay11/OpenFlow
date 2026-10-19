import { PTY_CLOSE, PTY_ROUTES } from "../../shared/terminal"
import type { PtyKind, PtyTicket } from "../../shared/terminal"
import { HttpError, fail, guarded, json, readJson } from "../host/respond"
import type { HostHandler } from "../host/respond"
import type { PtyConnection, PtySink, TerminalHost } from "./host"
import { PlanError, TicketStore, httpRefusal, parseTicketRequest, upgradeRefusal } from "./policy"
import type { SpawnPlan } from "./policy"

/**
 * The terminal's HTTP surface and the policy half of a WebSocket upgrade. Both
 * transports (`ws-bun.ts`, `ws-node.ts`) call `upgrade` below, so ticket, Origin
 * and Host checks exist once.
 */

export type TerminalCore = {
  host: TerminalHost
  tickets: TicketStore
  /** False while FLOW_ALLOW_REMOTE=1: the terminal answers nothing. */
  enabled: boolean
  /** The current project, as `spawnPlan` names it. A session attaches only while it is the one it was spawned in. */
  project(): string
  plan(kind: PtyKind): Promise<SpawnPlan>
}

export type PtyUpgrade = { ok: true; attach(sink: PtySink): PtyConnection } | { ok: false; status: number }

const BODY_LIMIT = 4096

/** `POST ticket`, `GET list`, `DELETE session`: every one gated, none reachable cross-origin. */
export function terminalRoutes(core: TerminalCore): HostHandler {
  return guarded(async (request) => {
    const pathname = new URL(request.url).pathname
    const isSession = pathname.startsWith(`${PTY_ROUTES.list}/`) && pathname !== PTY_ROUTES.ticket
    if (pathname !== PTY_ROUTES.ticket && pathname !== PTY_ROUTES.list && !isSession) return undefined

    const refusal = httpRefusal(request, core.enabled)
    if (refusal) return fail(refusal.status, refusal.error, refusal.code)

    if (pathname === PTY_ROUTES.list) {
      if (request.method !== "GET") return fail(405, "method not allowed", "method")
      return json(200, core.host.list())
    }

    if (pathname === PTY_ROUTES.ticket) {
      if (request.method !== "POST") return fail(405, "method not allowed", "method")
      return ticket(core, await readJson(request, BODY_LIMIT))
    }

    if (request.method !== "DELETE") return fail(405, "method not allowed", "method")
    let id: string
    try {
      id = decodeURIComponent(pathname.slice(PTY_ROUTES.list.length + 1))
    } catch {
      return fail(400, "bad session id", "bad-request")
    }
    if (!core.host.kill(id)) return fail(404, "no such terminal", "gone")
    core.tickets.revoke(id)
    return new Response(null, { status: 204 })
  })
}

async function ticket(core: TerminalCore, body: unknown): Promise<Response> {
  const parsed = parseTicketRequest(body)
  if (typeof parsed === "string") return fail(400, parsed, "bad-request")

  if (parsed.id !== undefined) {
    const info = core.host.info(parsed.id)
    if (!info) return fail(404, "no such terminal", "gone")
    if (info.project !== core.project()) return fail(409, "that terminal belongs to another project: open that project again to use it", "project-mismatch")
    return json(200, issue(core, info.id, info.kind))
  }

  const kind = parsed.create.kind
  let plan: SpawnPlan
  try {
    plan = await core.plan(kind)
  } catch (error) {
    if (error instanceof PlanError) throw new HttpError(error.status, error.message, error.code)
    throw error
  }
  const info = await core.host.create(kind, plan, parsed.create)
  return json(200, issue(core, info.id, kind))
}

function issue(core: TerminalCore, id: string, kind: PtyKind): PtyTicket {
  const { ticket, expiresAt } = core.tickets.issue(id)
  return { id, ticket, kind, expiresAt, wsPath: PTY_ROUTES.ws(id) }
}

/**
 * Decides whether `request` may open a socket to session `id`: Origin + Host,
 * the session exists, and the one-shot ticket in `?ticket=` is valid (consumed
 * here, before anything is upgraded). `?cursor=N` is where replay resumes; absent
 * replays the retained scrollback, -1 none.
 */
export function terminalUpgrade(core: TerminalCore, request: Request, id: string): PtyUpgrade {
  const refusal = upgradeRefusal(request, core.enabled)
  if (refusal) return { ok: false, status: refusal.status }
  if (request.method !== "GET") return { ok: false, status: 405 }
  const url = new URL(request.url)
  const info = core.host.info(id)
  if (!info) return { ok: false, status: 404 }
  if (info.project !== core.project()) return { ok: false, status: 409 }
  if (!core.tickets.consume(url.searchParams.get("ticket"), id)) return { ok: false, status: 403 }
  const raw = url.searchParams.get("cursor")
  const cursor = raw === null || raw === "" ? undefined : Number(raw)
  return {
    ok: true,
    attach: (sink) => {
      const connection = core.host.attach(id, sink, cursor !== undefined && Number.isFinite(cursor) ? cursor : undefined)
      if (connection) return connection
      sink.close(PTY_CLOSE.gone, "no such terminal")
      return { message() {}, detach() {} }
    },
  }
}

const WS_PATH = /^\/flow\/pty\/([^/]+)\/ws$/

/** The session id a `/flow/pty/<id>/ws` path names; undefined for any other path, which is how a transport leaves everything else alone. */
export function ptySocketId(pathname: string): string | undefined {
  const match = WS_PATH.exec(pathname)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return undefined
  }
}

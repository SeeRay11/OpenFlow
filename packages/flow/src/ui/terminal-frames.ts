import { PTY_CONTROL, PTY_HEADER, clampSize } from "../../shared/terminal"
import type { PtyClientControl, PtyServerControl, PtyTicket, PtyTicketRequest } from "../../shared/terminal"

/**
 * The browser's half of the terminal wire format (the host's half is
 * `lib/terminal/policy.ts`). Pure, so `bun test` covers it without a DOM.
 */

export type ServerFrame =
  | { kind: "output"; text: string }
  | { kind: "control"; control: PtyServerControl }
  | { kind: "ignored" }

const decoder = new TextDecoder()

function isExit(value: unknown): value is { code: number | null; signal: string | null } {
  if (typeof value !== "object" || value === null) return false
  const exit = value as { code?: unknown; signal?: unknown }
  return (exit.code === null || typeof exit.code === "number") && (exit.signal === null || typeof exit.signal === "string")
}

/** A WebSocket message: text is terminal output, binary `0x00` + JSON is a control frame, anything else is ignored. */
export function decodeServerFrame(data: unknown): ServerFrame {
  if (typeof data === "string") return { kind: "output", text: data }
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined
  if (!bytes || bytes[0] !== PTY_CONTROL) return { kind: "ignored" }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(1)))
  } catch {
    return { kind: "ignored" }
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "ignored" }
  const frame = parsed as { cursor?: unknown; exit?: unknown }
  if (typeof frame.cursor === "number" && Number.isFinite(frame.cursor)) return { kind: "control", control: { cursor: frame.cursor } }
  if (isExit(frame.exit)) return { kind: "control", control: { exit: frame.exit } }
  return { kind: "ignored" }
}

/** `0x00` + `{t:"resize"}`, clamped the way the host will clamp it anyway. */
export function encodeResize(cols: number, rows: number): Uint8Array {
  const size = clampSize(cols, rows)
  const control: PtyClientControl = { t: "resize", cols: size.cols, rows: size.rows }
  const json = new TextEncoder().encode(JSON.stringify(control))
  const out = new Uint8Array(json.length + 1)
  out[0] = PTY_CONTROL
  out.set(json, 1)
  return out
}

/**
 * Where to open the socket. Cursor 0 omits `cursor` so a brand-new attach
 * replays the whole retained scrollback (output printed before the socket
 * opened); later reconnects resume exactly where the client stopped.
 */
export function socketUrl(page: { protocol: string; host: string }, granted: Pick<PtyTicket, "wsPath" | "ticket">, cursor: number): string {
  const scheme = page.protocol === "https:" ? "wss:" : "ws:"
  const query = `ticket=${encodeURIComponent(granted.ticket)}${cursor > 0 ? `&cursor=${Math.trunc(cursor)}` : ""}`
  return `${scheme}//${page.host}${granted.wsPath}?${query}`
}

/** The custom header is what makes a cross-origin page unable to call these routes at all. */
export const ptyHeaders = { [PTY_HEADER]: "1" }

export function ticketInit(request: PtyTicketRequest): RequestInit {
  return {
    method: "POST",
    headers: { ...ptyHeaders, "content-type": "application/json" },
    body: JSON.stringify(request),
  }
}

export type FetchProblem = { message: string; code?: string; status: number }

/** The `{error, code?}` body every host module answers with; anything else becomes a generic message. */
export async function readProblem(response: Response): Promise<FetchProblem> {
  let body: { error?: unknown; code?: unknown } = {}
  try {
    body = (await response.json()) as typeof body
  } catch {}
  return {
    status: response.status,
    message: typeof body.error === "string" && body.error ? body.error : `the host answered ${response.status}`,
    code: typeof body.code === "string" ? body.code : undefined,
  }
}

/**
 * The in-app terminal: a PTY the host spawns and the browser drives over a
 * WebSocket. Host: `lib/terminal`. Client: `src/ui/terminal-dock.tsx`.
 *
 * Loopback only, and a PTY is code execution as the user, so every route is
 * gated three ways: the request must carry `x-openflow-pty: 1` (a custom header
 * forces a CORS preflight this host never answers), its Origin must equal the
 * loopback Host it was sent to, and the WebSocket is opened with a one-shot
 * ticket that expires. With `FLOW_ALLOW_REMOTE=1` the terminal is off.
 *
 * The browser never sends argv, cwd or env — only a `kind`.
 *
 * WebSocket framing (extends the upstream PTY protocol, which has no resize):
 *   server -> client  text frame            raw terminal output
 *                     binary 0x00 + JSON    `PtyServerControl`
 *   client -> server  text frame            keystrokes (<= `inputFrameBytes`)
 *                     binary 0x00 + JSON    `PtyClientControl`
 */

export type PtyKind = "omp" | "shell"

export const PTY_HEADER = "x-openflow-pty"

export type PtyCreate = { kind: PtyKind; cols: number; rows: number }

/** Attach to a live or exited session by `id`, or create one. Exactly one of the two. */
export type PtyTicketRequest = { id: string; create?: undefined } | { id?: undefined; create: PtyCreate }

export type PtyTicket = {
  id: string
  ticket: string
  kind: PtyKind
  /** Epoch ms. */
  expiresAt: number
  /** Path to open: `/flow/pty/<id>/ws`; the client appends `?ticket=…&cursor=…`. */
  wsPath: string
}

export type PtyInfo = {
  id: string
  kind: PtyKind
  pid?: number
  state: "running" | "exited"
  exit?: { code: number | null; signal: string | null }
  cols: number
  rows: number
  createdAt: number
}

export type PtyServerControl = { cursor: number } | { exit: { code: number | null; signal: string | null } }
export type PtyClientControl = { t: "resize"; cols: number; rows: number }

/** First byte of a binary control frame. */
export const PTY_CONTROL = 0x00

export const PTY_CLOSE = { normal: 1000, gone: 4404, auth: 4403 } as const

export const PTY_LIMITS = {
  maxSessions: 4,
  /** Server-side scrollback ring, replayed on reconnect from a cursor. */
  ringBytes: 2 * 1024 * 1024,
  inputFrameBytes: 64 * 1024,
  minCols: 20,
  maxCols: 500,
  minRows: 5,
  maxRows: 200,
  ticketTtlMs: 60_000,
  /** A running session nobody is attached to is killed after this long. */
  idleReapMs: 10 * 60_000,
  /** Exited sessions kept so the dock can show "exited 1 — Restart". */
  exitedKept: 5,
} as const

export const PTY_ROUTES = {
  ticket: "/flow/api/pty/ticket",
  list: "/flow/api/pty",
  /** DELETE `/flow/api/pty/<id>` kills and forgets a session. */
  session: (id: string) => `/flow/api/pty/${encodeURIComponent(id)}`,
  ws: (id: string) => `/flow/pty/${encodeURIComponent(id)}/ws`,
} as const

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Number.isFinite(cols) ? Math.min(PTY_LIMITS.maxCols, Math.max(PTY_LIMITS.minCols, Math.trunc(cols))) : PTY_LIMITS.minCols,
    rows: Number.isFinite(rows) ? Math.min(PTY_LIMITS.maxRows, Math.max(PTY_LIMITS.minRows, Math.trunc(rows))) : PTY_LIMITS.minRows,
  }
}

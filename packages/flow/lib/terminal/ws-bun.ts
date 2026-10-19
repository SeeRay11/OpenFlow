import type { ServerWebSocket, WebSocketHandler } from "bun"
import { PTY_LIMITS } from "../../shared/terminal"
import type { PtyConnection, PtySink, TerminalModule } from "./index"
import { encodeControl } from "./policy"
import { ptySocketId } from "./routes"

/**
 * The `Bun.serve` transport. All policy (Origin, Host, ticket, framing,
 * backpressure) is in the module; this only adapts a `ServerWebSocket` to a
 * `PtySink`.
 *
 * Wiring: call `fetch(request, server)` first in `Bun.serve`'s `fetch` and pass
 * `websocket` through. `fetch` answers `false` for a path that is not
 * `/flow/pty/<id>/ws` (keep routing), `true` once the socket is upgraded (return
 * `undefined` from `fetch`), or the refusal `Response`.
 */

export type PtySocketData = { attach(sink: PtySink): PtyConnection; connection?: PtyConnection }
export type PtySocket = ServerWebSocket<PtySocketData>

export type BunUpgrader = { upgrade(request: Request, options: { data: PtySocketData }): boolean }

export function bunWebSocket(terminal: TerminalModule): {
  fetch(request: Request, server: BunUpgrader): Response | boolean
  websocket: WebSocketHandler<PtySocketData>
} {
  return {
    fetch(request, server) {
      const id = ptySocketId(new URL(request.url).pathname)
      if (id === undefined) return false
      const result = terminal.upgrade(request, id)
      if (!result.ok) return new Response(null, { status: result.status })
      if (server.upgrade(request, { data: { attach: result.attach } })) return true
      return new Response("expected a WebSocket upgrade", { status: 426 })
    },
    websocket: {
      // Keystrokes are capped at inputFrameBytes by the module; this stops the
      // socket from buffering anything bigger before the module ever sees it.
      maxPayloadLength: PTY_LIMITS.inputFrameBytes,
      open(ws) {
        ws.data.connection = ws.data.attach({
          text: (data) => void ws.send(data),
          control: (frame) => void ws.send(encodeControl(frame)),
          close: (code, reason) => ws.close(code, reason),
          buffered: () => ws.getBufferedAmount(),
        })
      },
      message(ws, message) {
        ws.data.connection?.message(typeof message === "string" ? message : new Uint8Array(message))
      },
      close(ws) {
        ws.data.connection?.detach()
      },
    },
  }
}

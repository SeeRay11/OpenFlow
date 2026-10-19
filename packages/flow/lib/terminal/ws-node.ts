import { STATUS_CODES } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer } from "ws"
import { PTY_LIMITS } from "../../shared/terminal"
import type { TerminalModule } from "./index"
import { encodeControl } from "./policy"
import { ptySocketId } from "./routes"

/**
 * The Node transport, for the vite dev host (`vite/flow-pty.ts`) and any plain
 * `http.Server`. Policy is the module's; this converts the upgrade into a Web
 * `Request`, accepts the socket with `ws` (noServer) and adapts it to a sink.
 *
 * Only `/flow/pty/<id>/ws` is touched. Every other upgrade — vite's own HMR
 * socket above all — is left to whoever else listens.
 */
export function attachNodeUpgrade(server: Server, terminal: TerminalModule): () => void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: PTY_LIMITS.inputFrameBytes })

  const onUpgrade = (message: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = message.url ?? "/"
    let request: Request
    let id: string | undefined
    try {
      const url = new URL(target, `http://${message.headers.host ?? "invalid"}`)
      id = ptySocketId(url.pathname)
      if (id === undefined) return
      const headers = new Headers()
      for (const [name, value] of Object.entries(message.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
      }
      request = new Request(url, { method: message.method, headers })
    } catch {
      refuse(socket, 400)
      return
    }

    const result = terminal.upgrade(request, id)
    if (!result.ok) {
      refuse(socket, result.status)
      return
    }
    sockets.handleUpgrade(message, socket, head, (ws) => {
      const connection = result.attach({
        text: (data) => ws.send(data),
        control: (frame) => ws.send(encodeControl(frame), { binary: true }),
        close: (code, reason) => ws.close(code, reason),
        buffered: () => ws.bufferedAmount,
      })
      ws.on("message", (data, binary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
        connection.message(binary ? new Uint8Array(bytes) : bytes.toString("utf8"))
      })
      ws.on("close", () => connection.detach())
      // A reset socket also emits close; the error itself carries nothing to act on.
      ws.on("error", () => {})
    })
  }

  server.on("upgrade", onUpgrade)
  return () => {
    server.off("upgrade", onUpgrade)
    sockets.close()
  }
}

function refuse(socket: Duplex, status: number) {
  socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

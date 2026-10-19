import type { Plugin, ViteDevServer } from "vite"
import type { TerminalModule } from "../lib/terminal"
import { attachNodeUpgrade } from "../lib/terminal/ws-node"

/**
 * The terminal's WebSocket transport on the vite dev server.
 *
 * Only the upgrade lives here. `terminal.handle` (ticket / list / kill) is a
 * Web-standard `HostHandler` that the host composer mounts next to the other
 * `/flow/api` modules, and it MUST be the same `terminal` instance passed here:
 * the tickets it issues are the ones the upgrade consumes.
 *
 * Vite's HMR socket is a different upgrade (`vite-hmr` protocol) on the same
 * server; `attachNodeUpgrade` only answers `/flow/pty/<id>/ws`.
 */
export function flowPty(terminal: TerminalModule): Plugin {
  return {
    name: "openflow-pty",
    configureServer(server: ViteDevServer) {
      const http = server.httpServer
      // Vite hands out an HTTP/2 server when https is on and no proxy is set. It never emits 'upgrade'
      // (WebSockets ride extended CONNECT there), so there is nothing to attach to.
      if (!http || "updateSettings" in http) return
      const detach = attachNodeUpgrade(http, terminal)
      // Ctrl+C on vite must not orphan a shell this host spawned. A hard kill
      // skips 'close'; the module's own process 'exit' hook covers that.
      http.on("close", () => {
        detach()
        void terminal.dispose()
      })
    },
  }
}

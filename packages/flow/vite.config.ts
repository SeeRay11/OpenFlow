import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { resolveProject } from "./lib/last-session"
import { flowStore } from "./vite/flow-store"

// The opencode server OpenFlow drives. Start it with `opencode serve`.
const server = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"

// The project OpenFlow orchestrates: where `.openflow/` lives and where agent
// sessions run. OPENFLOW_PROJECT wins, then the folder last switched to in the
// UI, then the repo root two levels up from packages/flow.
const project = resolveProject(fileURLToPath(new URL("../../", import.meta.url)))

/**
 * How long a proxied request may hang before the dev server gives up.
 *
 * Restarting `opencode serve` is the case this exists for: a pooled keep-alive
 * connection to the process that just died never answers and never errors, so
 * without a bound the canvas waits forever on a request that can only fail.
 * SSE keeps its own config below — a stream is *meant* to stay open.
 */
const PROXY_TIMEOUT = Number(process.env.FLOW_PROXY_TIMEOUT ?? 30_000)

const proxy = {
  target: server,
  changeOrigin: true,
  ws: false,
  timeout: PROXY_TIMEOUT,
  proxyTimeout: PROXY_TIMEOUT,
  /**
   * Say why the upstream call failed instead of letting http-proxy answer a
   * bare 500 with an empty body.
   *
   * `opencode serve` not running is the single most common way OpenFlow
   * breaks, and an empty 500 reaches the browser as `cannot reach opencode
   * serve: {}` — the SDK has no body to build a message from. A JSON body with
   * a `message` field is what every error path here already knows how to read.
   */
  configure: (instance: any) => {
    instance.on("error", (error: NodeJS.ErrnoException, _request: any, socket: any) => {
      const reason =
        error.code === "ECONNREFUSED" || error.code === "ECONNRESET"
          ? `cannot reach opencode serve at ${server} — start it with \`opencode serve --port ${new URL(server).port || 80}\``
          : `opencode serve request failed: ${error.message}`
      // On an upgrade/socket error there is no ServerResponse to write to.
      if (!socket || typeof socket.writeHead !== "function") return socket?.destroy?.()
      if (socket.headersSent) return socket.end()
      socket.writeHead(502, { "content-type": "application/json" })
      socket.end(JSON.stringify({ message: reason }))
    })
  },
}

export default defineConfig({
  plugins: [solid(), flowStore({ project, upstream: server })],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": proxy,
      "/global": proxy,
      // SSE streams must not be buffered or timed out.
      "/event": { ...proxy, timeout: 0, proxyTimeout: 0 },
      // MCP routes are the one instance API not served under /api.
      "/mcp": proxy,
    },
  },
  build: {
    target: "esnext",
  },
})

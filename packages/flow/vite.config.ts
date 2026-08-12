import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { flowStore } from "./vite/flow-store"

// The opencode server OpenFlow drives. Start it with `opencode serve`.
const server = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"

// The project OpenFlow orchestrates: where `.openflow/` lives and where agent
// sessions run. Defaults to the repo root two levels up from packages/flow.
const project = process.env.OPENFLOW_PROJECT ?? fileURLToPath(new URL("../../", import.meta.url))

const proxy = {
  target: server,
  changeOrigin: true,
  ws: false,
  // SSE streams must not be buffered or timed out by the dev proxy.
  timeout: 0,
  proxyTimeout: 0,
}

export default defineConfig({
  plugins: [solid(), flowStore({ project })],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": proxy,
      "/global": proxy,
      "/event": proxy,
    },
  },
  build: {
    target: "esnext",
  },
})

import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { resolveProject } from "./lib/last-session"
import { flowStore } from "./vite/flow-store"
import { portInUse } from "./vite/port-in-use"

/**
 * The canvas port. Fixed, and `strictPort` below keeps it that way — every
 * README and the launcher name this one URL.
 *
 * The dev server binds the *name* `localhost`, so `http://127.0.0.1:5174`
 * refuses the connection even while the server is up. Print the working URL.
 */
const PORT = 5174
const CANVAS_URL = `http://localhost:${PORT}`

// The project OpenFlow orchestrates: where `.openflow/` lives and where agent
// sessions run. OPENFLOW_PROJECT wins, then the folder last switched to in the
// UI, then the repo root two levels up from packages/flow.
const project = resolveProject(fileURLToPath(new URL("../../", import.meta.url)))

export default defineConfig({
  plugins: [
    solid(),
    flowStore({ project }),
    {
      // `strictPort` makes vite exit on a held port with a bare EADDRINUSE
      // stack and nothing else — no browser ever opens, so the terminal is the
      // only place a fix can be offered. Registered in `configureServer`, which
      // runs before vite attaches its own listener, so this prints first.
      name: "openflow-port-in-use",
      configureServer(dev) {
        dev.httpServer?.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EADDRINUSE") return
          console.error(`\n${portInUse(PORT, CANVAS_URL)}\n`)
        })
      },
    },
  ],
  server: {
    port: PORT,
    strictPort: true,
    // The canvas and its API are one origin; nothing here needs CORS. Vite 7's default answers any localhost
    // origin, and with its static middleware that let a page on another local port read `.html` files off disk.
    // `server.fs.strict` stays at its default (true).
    cors: false,
  },
  build: {
    target: "esnext",
  },
})

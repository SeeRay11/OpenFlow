import type { Connect, Plugin, ViteDevServer } from "vite"
import { remoteBindRefusal } from "../lib/guard"
import { createHost } from "../lib/host"
import { nodeMiddleware } from "../lib/host/node-adapter"
import { flowPaths, handleFlow } from "../lib/store"
import { attachNodeUpgrade } from "../lib/terminal/ws-node"

/**
 * Mounts OpenFlow's persistence and its host modules on the vite dev server.
 *
 * The routes themselves live in `lib/store.ts` (the store) and `lib/host`
 * (engine, uplift, memory, swarm, Omp settings, terminal), both shared with the
 * standalone server, so `bun dev` and a built deployment cannot drift into two
 * different hosts.
 */
export function flowStore(options: { project: string }): Plugin {
  const paths = flowPaths(options.project)

  return {
    name: "openflow-store",
    configureServer(server: ViteDevServer) {
      // `vite --host` would otherwise put an unauthenticated file-writing API
      // on the network. Fail closed: no dev server rather than a quiet hole.
      const refusal = remoteBindRefusal({ host: server.config.server.host, project: paths.project })
      if (refusal) throw new Error(refusal)

      // `paths.project` is the live object `lib/store.ts` mutates when the canvas switches folders.
      const host = createHost({ project: () => paths.project, allowRemote: process.env.FLOW_ALLOW_REMOTE === "1" })

      // Ctrl+C on vite must not orphan an omp process, planner or shell. A hard
      // kill skips 'close'; the modules' own process hooks cover that.
      // Vite hands out an HTTP/2 server when https is on and no proxy is set; it never emits 'upgrade'.
      const http = server.httpServer
      const detach = http && !("updateSettings" in http) ? attachNodeUpgrade(http, host.terminal) : undefined
      http?.on("close", () => {
        detach?.()
        void host.dispose()
      })
      process.once("exit", () => void host.dispose())

      // First: every `/flow` request, the store's routes and the SSE stream included, passes the
      // Host/Origin gate before any handler. Vite's own CORS default lets any localhost origin through.
      // No route prefix on purpose: connect matches a prefix case-insensitively and tolerates a `.` after it,
      // so the gate must see the original URL and decide by its own, broader pattern (`lib/host/gate.ts`).
      server.middlewares.use(nodeMiddleware(host.gate))

      // Before the store: the host owns `/flow/api/{engine,omp,uplift,memory,swarm,pty}`
      // and answers `undefined` for everything else, which falls through.
      server.middlewares.use("/flow", nodeMiddleware(host.handle))

      server.middlewares.use("/flow/api", async (req, res, next) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost")
          const result = await handleFlow(paths, {
            method: req.method ?? "GET",
            path: url.pathname,
            search: url.searchParams,
            json: () => read(req),
            profileDir: host.profileDir,
          })
          if (!result) return next()
          json(res, result.status, result.body)
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      })
    },
  }
}

function json(res: any, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

async function read(req: Connect.IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // A pipeline is a few kilobytes of JSON; anything past this is a mistake or
    // an attempt to make the dev server eat memory.
    if (size > MAX_BODY) throw new Error("request body too large")
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

const MAX_BODY = 8 * 1024 * 1024

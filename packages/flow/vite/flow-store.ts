import type { Connect, Plugin, ViteDevServer } from "vite"
import { remoteBindRefusal } from "../lib/guard"
import { createHost } from "../lib/host"
import { rawPathRefusal } from "../lib/host/gate"
import { nodeMiddleware, requestUrl } from "../lib/host/node-adapter"
import { flowPaths, handleFlow } from "../lib/store"
import { attachDevUpgrade } from "../lib/terminal/ws-node"

const STORE_PREFIX = "/flow/api"

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
  let shutdown: (() => Promise<void>) | undefined

  return {
    name: "openflow-store",
    configureServer(server: ViteDevServer) {
      // `vite --host` would otherwise put an unauthenticated file-writing API
      // on the network. Fail closed: no dev server rather than a quiet hole.
      const refusal = remoteBindRefusal({ host: server.config.server.host, project: paths.project })
      if (refusal) throw new Error(refusal)

      // `paths.project` is the live object `lib/store.ts` mutates when the canvas switches folders.
      const created = createHost({ project: () => paths.project, allowRemote: process.env.FLOW_ALLOW_REMOTE === "1" })

      // Ctrl+C on vite must not orphan an omp process, planner or shell: omp sessions and PTYs are detached
      // process groups, so nothing kills them with the parent. Vite itself only handles SIGTERM (it closes the
      // server, which reaches `closeBundle` and the 'close' below); a bare SIGINT would end node with no 'exit'
      // event at all, so it is handled here. `once`: a second Ctrl+C gets the default and ends the process.
      const onExit = () => void created.dispose()
      const onInterrupt = () => void created.dispose().finally(() => process.exit(130))
      process.once("exit", onExit)
      process.once("SIGINT", onInterrupt)
      shutdown = () => {
        process.off("exit", onExit)
        process.off("SIGINT", onInterrupt)
        return created.dispose()
      }
      attachDevUpgrade(server.httpServer, created.terminal, () => void shutdown?.())

      // First: a `/flow` target spelled so that two parsers read two paths (`/flow/api/../..`, `%2e%2e`, a
      // backslash, `;`) is refused outright. Connect has already seen the raw line; every later middleware sees
      // a normalised one.
      server.middlewares.use((req, res, next) => {
        const refusal = rawPathRefusal(req.originalUrl ?? req.url ?? "/")
        if (!refusal) return next()
        json(res, refusal.status, { error: refusal.error, code: refusal.code })
      })

      // Then: every `/flow` request, the store's routes and the SSE stream included, passes the
      // Host/Origin gate before any handler. Vite's own CORS default lets any localhost origin through.
      // No route prefix on purpose: connect matches a prefix case-insensitively and tolerates a `.` after it,
      // so the gate must see the original URL and decide by its own, broader pattern (`lib/host/gate.ts`).
      server.middlewares.use(nodeMiddleware(created.gate))

      // Before the store: the host owns `/flow/api/{engine,omp,uplift,memory,swarm,pty}`
      // and answers `undefined` for everything else, which falls through.
      server.middlewares.use("/flow", nodeMiddleware(created.handle))

      // The store takes its path from the very value the gate decided on (`requestUrl`), and only when that
      // normalised path is exactly the store's: a mount prefix would let connect re-parse the leftovers.
      server.middlewares.use(async (req, res, next) => {
        const url = requestUrl(req)
        if (url.pathname !== STORE_PREFIX && !url.pathname.startsWith(`${STORE_PREFIX}/`)) return next()
        try {
          const result = await handleFlow(paths, {
            method: req.method ?? "GET",
            path: url.pathname,
            search: url.searchParams,
            json: () => read(req),
            profileDir: created.profileDir,
            projectLocked: created.projectLocked,
          })
          if (!result) return next()
          json(res, result.status, result.body)
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      })
    },
    // Awaited by `server.close()`, which is what vite's SIGTERM handler runs before it exits.
    async closeBundle() {
      await shutdown?.()
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

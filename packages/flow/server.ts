import path from "node:path"
import { fileURLToPath } from "node:url"
import { remoteBindRefusal } from "./lib/guard"
import { createHost } from "./lib/host"
import { resolveProject } from "./lib/last-session"
import { flowPaths, handleFlow } from "./lib/store"
import type { OmpStatusView } from "./shared/omp"
import { bunWebSocket } from "./lib/terminal/ws-bun"
// Shared with the vite dev host so both explain a held port the same way.
import { portInUse } from "./vite/port-in-use"

/**
 * Serves a built OpenFlow (`bun run build`) without vite.
 *
 * The dev server provides three things the static bundle cannot: the
 * `/flow/api` store, the host modules that drive Omp (engine, uplift, memory,
 * swarm, settings, terminal) and an SSE path that is never buffered. Without
 * them a built `dist/` is a dead page — every save, load and run 404s. This is
 * the same things, standing on their own.
 */
const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, "dist")

// OPENFLOW_PROJECT wins, then the folder last switched to in the UI, then
// this repo. See `lib/last-session.ts`.
const project = resolveProject(path.resolve(root, "../../"))
const port = Number(process.env.FLOW_PORT ?? 5174)
const hostname = process.env.FLOW_HOST ?? "127.0.0.1"

const paths = flowPaths(project)
const MAX_BODY = 8 * 1024 * 1024

// `paths.project` is the live object `lib/store.ts` mutates when the canvas
// switches folders, so the host follows the switch without a restart.
const host = createHost({ project: () => paths.project, allowRemote: process.env.FLOW_ALLOW_REMOTE === "1" })
const terminal = bunWebSocket(host.terminal)

if (!(await Bun.file(path.join(dist, "index.html")).exists())) {
  console.error(`no build found at ${dist}\nrun: bun run --cwd packages/flow build`)
  process.exit(1)
}

const refusal = remoteBindRefusal({ host: hostname, project: paths.project })
if (refusal) {
  console.error(refusal)
  process.exit(1)
}

const server = listen()

// Ctrl+C or a service stop must not orphan an omp process, planner or shell the
// host spawned. `exit` covers every other way out; the modules also reap their
// own children, so this is the orderly path, not the only one.
const stop = () => void host.dispose().finally(() => process.exit(0))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
process.once("exit", () => void host.dispose())

const omp = await host.handle(new Request(`http://${hostname}/flow/api/omp/status`))
const status = (await omp?.json()) as OmpStatusView | undefined
const problem = status?.problems[0]
const ompLine = status?.available
  ? status.version
  : `not found: ${problem ? `${problem.message} ${problem.fix ?? ""}`.trim() : "omp is not available"}`

console.log(`openflow    http://${hostname}:${server.port}`)
console.log(`project     ${paths.project}`)
console.log(`omp         ${ompLine}`)

/**
 * Binds the canvas port, or says what is holding it.
 *
 * `Bun.serve` throws on a taken port, and an unhandled throw here is a raw
 * stack in a terminal the user may not even be looking at — no page ever
 * loads, so nothing else can carry the explanation. The port is deliberately
 * not slid to a free one: the READMEs document this URL.
 */
function listen() {
  try {
    return Bun.serve({
      port,
      hostname,
      idleTimeout: 0, // SSE streams outlive any request timeout
      async fetch(request, serving) {
        // Every `/flow/api` request, store and SSE included, passes the Host/Origin gate before any handler (and before a body is read).
        const refused = await host.gate(request)
        if (refused) return refused

        // The terminal's WebSocket upgrade must be decided before anything reads the request.
        const upgraded = terminal.fetch(request, serving)
        if (upgraded instanceof Response) return upgraded
        if (upgraded) return undefined

        const hosted = await host.handle(request)
        if (hosted) return hosted

        const url = new URL(request.url)
        if (url.pathname === "/flow/api" || url.pathname.startsWith("/flow/api/")) {
          try {
            const result = await handleFlow(paths, {
              method: request.method,
              path: url.pathname,
              search: url.searchParams,
              json: () => body(request),
              profileDir: host.profileDir,
            })
            if (result) return Response.json(result.body, { status: result.status })
            return Response.json({ error: "not found" }, { status: 404 })
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
          }
        }

        return statics(url)
      },
      websocket: terminal.websocket,
    })
  } catch (error) {
    // Bun reports the code on some builds and only the sentence on others.
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" && !/in use/i.test(String(error))) throw error
    console.error(portInUse(port, `http://${hostname}:${port}`))
    return process.exit(1)
  }
}

async function body(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > MAX_BODY) throw new Error("request body too large")
  const text = await request.text()
  if (text.length > MAX_BODY) throw new Error("request body too large")
  if (!text) return {}
  return JSON.parse(text)
}

/**
 * Serves the built bundle, falling back to index.html so a deep link still
 * boots the app. Requests are resolved inside `dist` and refused if they
 * escape it.
 *
 * index.html is served `no-store`. Vite hashes asset filenames, so the assets
 * may be cached forever, but index.html is the pointer to them — cached under
 * the browser's own heuristic it pins the tab to the previous build's chunks,
 * and the app opens at an old version no rebuild can dislodge.
 */
async function statics(url: URL) {
  const requested = path.join(dist, decodeURIComponent(url.pathname))
  const resolved = path.resolve(requested)
  if (resolved !== dist && !resolved.startsWith(dist + path.sep)) {
    return new Response("not found", { status: 404 })
  }
  const file = Bun.file(resolved)
  if (url.pathname !== "/" && (await file.exists())) {
    const hashed = resolved.startsWith(path.join(dist, "assets") + path.sep)
    return new Response(file, {
      headers: { "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" },
    })
  }
  return new Response(Bun.file(path.join(dist, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}

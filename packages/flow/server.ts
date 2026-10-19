import path from "node:path"
import { fileURLToPath } from "node:url"
import { remoteBindRefusal } from "./lib/guard"
import { createHost } from "./lib/host"
import { resolveProject } from "./lib/last-session"
import { flowPaths } from "./lib/store"
import type { OmpStatusView } from "./shared/omp"
import { bunWebSocket } from "./lib/terminal/ws-bun"
import { createApp } from "./server-app"
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
      // Never Bun's development error page (an HTML stack trace with source paths): `createApp` answers its own failures.
      development: false,
      idleTimeout: 0, // SSE streams outlive any request timeout
      fetch: createApp({ host, terminal, paths, dist }),
      websocket: terminal.websocket,
    })
  } catch (error) {
    // Bun reports the code on some builds and only the sentence on others.
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" && !/in use/i.test(String(error))) throw error
    console.error(portInUse(port, `http://${hostname}:${port}`))
    return process.exit(1)
  }
}

import { existsSync } from "node:fs"
import path from "node:path"
import type { Connect, Plugin, ViteDevServer } from "vite"
import { remoteBindRefusal } from "../lib/guard"
import { serveCommand, supervisorFor, type Supervisor } from "../lib/opencode-process"
import { flowPaths, handleFlow } from "../lib/store"

/**
 * Mounts OpenFlow's persistence on the vite dev server.
 *
 * The routes themselves live in `lib/store.ts` and are shared with the
 * standalone server, so `bun dev` and a built deployment cannot drift into two
 * different stores.
 */
export function flowStore(options: { project: string; upstream?: string; repo?: string }): Plugin {
  const paths = flowPaths(options.project)
  const upstream = options.upstream ?? process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"
  const repo = options.repo ?? path.resolve(process.cwd(), "../../")

  /**
   * The engine's process, when FLOW_MANAGE_SERVER=1 asks this host to own it.
   * Resolved lazily and once: vite calls `configureServer` synchronously, and
   * deciding ownership means asking the port whether an engine is already
   * there. See `lib/opencode-process.ts`.
   */
  let engine: Promise<Supervisor> | undefined
  const supervisor = () =>
    (engine ??= supervisorFor(
      serveCommand({
        repo,
        url: upstream,
        hasSource: existsSync(path.join(repo, "packages", "opencode", "src", "index.ts")),
      }),
      process.env,
      (line) => console.log(`[openflow] opencode ${line}`),
    ).then(async (made) => {
      // A managed engine is started with the dev server, the same way the
      // standalone host does it, so `bun dev` alone is enough to run OpenFlow.
      await made.ensure().catch((error) => console.error(`[openflow] ${error?.message ?? error}`))
      return made
    }))

  return {
    name: "openflow-store",
    configureServer(server: ViteDevServer) {
      // `vite --host` would otherwise put an unauthenticated file-writing API
      // on the network. Fail closed: no dev server rather than a quiet hole.
      const refusal = remoteBindRefusal({ host: server.config.server.host, project: paths.project })
      if (refusal) throw new Error(refusal)

      // Ctrl+C on vite must not orphan an engine this host spawned.
      server.httpServer?.on("close", () => void engine?.then((made) => made.stop()))

      server.middlewares.use("/flow/api", async (req, res, next) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost")
          const result = await handleFlow(paths, {
            method: req.method ?? "GET",
            path: url.pathname,
            search: url.searchParams,
            json: () => read(req),
            upstream,
            serve: await supervisor(),
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

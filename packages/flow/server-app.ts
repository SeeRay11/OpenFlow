import path from "node:path"
import type { Host } from "./lib/host"
import { handleFlow, type FlowPaths } from "./lib/store"
import type { BunUpgrader } from "./lib/terminal/ws-bun"

/**
 * The request handler of the standalone server (`server.ts`), apart from the listening socket so that a test can
 * put it on a port of its own. Order matters and is the vite dev host's too: the Host/Origin gate first, the
 * terminal's WebSocket upgrade before anything reads the request, the host modules, the store, then the built
 * bundle.
 *
 * Nothing thrown in here may reach `Bun.serve`: its own handling of a throw is an error page (a stack trace
 * in development mode). A plain JSON answer is built here instead, and the cause goes to stderr only.
 */

const MAX_BODY = 8 * 1024 * 1024

export type AppOptions = {
  host: Host
  terminal: { fetch(request: Request, server: BunUpgrader): Response | boolean }
  /** The live store paths; `lib/store.ts` mutates `project` when the canvas switches folders. */
  paths: FlowPaths
  /** The built bundle (`bun run build`). */
  dist: string
}

export function createApp(options: AppOptions): (request: Request, serving: BunUpgrader) => Promise<Response | undefined> {
  return async (request, serving) => {
    try {
      // Every `/flow` request, store and SSE included, passes the Host/Origin gate before any handler (and before a body is read).
      const refused = await options.host.gate(request)
      if (refused) return refused

      // The terminal's WebSocket upgrade must be decided before anything reads the request.
      const upgraded = options.terminal.fetch(request, serving)
      if (upgraded instanceof Response) return upgraded
      if (upgraded) return undefined

      const hosted = await options.host.handle(request)
      if (hosted) return hosted

      const url = new URL(request.url)
      if (url.pathname === "/flow/api" || url.pathname.startsWith("/flow/api/")) {
        try {
          const result = await handleFlow(options.paths, {
            method: request.method,
            path: url.pathname,
            search: url.searchParams,
            json: () => body(request),
            profileDir: options.host.profileDir,
            projectLocked: options.host.projectLocked,
            projectHolders: options.host.projectHolders,
          })
          if (result) return Response.json(result.body, { status: result.status })
          return Response.json({ error: "not found" }, { status: 404 })
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      }

      return await statics(options.dist, url)
    } catch (error) {
      console.error(error)
      return Response.json({ error: "internal error" }, { status: 500 })
    }
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
 * escape it; a path that is not valid percent-encoding, or that names a NUL,
 * is a 400 rather than an exception.
 *
 * index.html is served `no-store`. Vite hashes asset filenames, so the assets
 * may be cached forever, but index.html is the pointer to them — cached under
 * the browser's own heuristic it pins the tab to the previous build's chunks,
 * and the app opens at an old version no rebuild can dislodge.
 */
async function statics(dist: string, url: URL) {
  const decoded = decodePath(url.pathname)
  if (decoded === undefined) return new Response("bad request", { status: 400 })
  const resolved = path.resolve(path.join(dist, decoded))
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

function decodePath(pathname: string) {
  try {
    const decoded = decodeURIComponent(pathname)
    return decoded.includes("\0") ? undefined : decoded
  } catch {
    return undefined
  }
}

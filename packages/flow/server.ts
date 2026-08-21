import path from "node:path"
import { fileURLToPath } from "node:url"
import { remoteBindRefusal } from "./lib/guard"
import { resolveProject } from "./lib/last-project"
import { flowPaths, handleFlow } from "./lib/store"

/**
 * Serves a built OpenFlow (`bun run build`) without vite.
 *
 * The dev server provides three things the static bundle cannot: the
 * `/flow/api` store, a proxy to `opencode serve` that keeps the browser
 * same-origin, and an SSE path that is never buffered. Without them a built
 * `dist/` is a dead page — every save, load and run 404s. This is the same
 * three things, standing on their own.
 */
const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, "dist")

const upstream = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"
// OPENFLOW_PROJECT wins, then the folder last switched to in the UI, then
// this repo. See `lib/last-project.ts`.
const project = resolveProject(path.resolve(root, "../../"))
const port = Number(process.env.FLOW_PORT ?? 5174)
const hostname = process.env.FLOW_HOST ?? "127.0.0.1"

const paths = flowPaths(project)

/** Paths that belong to `opencode serve` rather than to this app. */
const PROXIED = ["/api", "/global", "/event", "/mcp"]
const MAX_BODY = 8 * 1024 * 1024

if (!(await Bun.file(path.join(dist, "index.html")).exists())) {
  console.error(`no build found at ${dist}\nrun: bun run --cwd packages/flow build`)
  process.exit(1)
}

const refusal = remoteBindRefusal({ host: hostname, project: paths.project })
if (refusal) {
  console.error(refusal)
  process.exit(1)
}

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 0, // SSE streams outlive any request timeout
  async fetch(request) {
    const url = new URL(request.url)

    if (PROXIED.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
      return proxy(request, url)
    }

    if (url.pathname === "/flow/api" || url.pathname.startsWith("/flow/api/")) {
      try {
        const result = await handleFlow(paths, {
          method: request.method,
          path: url.pathname,
          search: url.searchParams,
          json: () => body(request),
          upstream,
        })
        if (result) return Response.json(result.body, { status: result.status })
        return Response.json({ error: "not found" }, { status: 404 })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
      }
    }

    return statics(url)
  },
})

console.log(`openflow    http://${hostname}:${server.port}`)
console.log(`opencode    ${upstream}`)
console.log(`project     ${paths.project}`)

/** Forwards a request to `opencode serve`, streaming the response back untouched. */
async function proxy(request: Request, url: URL) {
  const headers = new Headers(request.headers)
  headers.delete("host")
  try {
    return await fetch(new URL(url.pathname + url.search, upstream), {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      redirect: "manual",
      // Required by Bun and undici whenever a request carries a stream body.
      duplex: "half",
    } as RequestInit)
  } catch (error) {
    return Response.json(
      { error: `cannot reach opencode serve at ${upstream}: ${error instanceof Error ? error.message : error}` },
      { status: 502 },
    )
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
 */
async function statics(url: URL) {
  const requested = path.join(dist, decodeURIComponent(url.pathname))
  const resolved = path.resolve(requested)
  if (resolved !== dist && !resolved.startsWith(dist + path.sep)) {
    return new Response("not found", { status: 404 })
  }
  const file = Bun.file(resolved)
  if (url.pathname !== "/" && (await file.exists())) return new Response(file)
  return new Response(Bun.file(path.join(dist, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { remoteBindRefusal } from "./lib/guard"
import { serveCommand, supervisorFor } from "./lib/opencode-process"
import { resolveProject } from "./lib/last-session"
import { flowPaths, handleFlow } from "./lib/store"
// Shared with the vite dev host so both explain a held port the same way.
import { portInUse } from "./vite/port-in-use"

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
// this repo. See `lib/last-session.ts`.
const project = resolveProject(path.resolve(root, "../../"))
const port = Number(process.env.FLOW_PORT ?? 5174)
const hostname = process.env.FLOW_HOST ?? "127.0.0.1"

const paths = flowPaths(project)

// The repo this checkout lives in — where the engine can be run from source.
const repo = path.resolve(root, "../../")
/**
 * Who owns `opencode serve`.
 *
 * With FLOW_MANAGE_SERVER=1 this host spawns it and the canvas can restart it,
 * which is what makes a merged agent, a new skill or an MCP change take effect
 * without leaving the app. Without it — the default — nothing is spawned and
 * the restart route reports the command instead. See `lib/opencode-process.ts`.
 */
const engine = await supervisorFor(
  serveCommand({
    repo,
    url: upstream,
    hasSource: existsSync(path.join(repo, "packages", "opencode", "src", "index.ts")),
  }),
  process.env,
  (line) => console.log(`opencode    ${line}`),
)

/** Paths that belong to `opencode serve` rather than to this app. */
const PROXIED = ["/api", "/global", "/event", "/mcp"]
/** Paths that stream and are meant to stay open — never given a deadline. */
const STREAMED = ["/event"]
/**
 * How long a proxied request may hang before this host gives up on it.
 *
 * Restarting the engine is what makes this necessary: a keep-alive connection
 * to the process that just died is never answered and never refused, so an
 * unbounded request hangs the canvas on a call that can only fail. 504 with a
 * reason is the honest answer.
 */
const PROXY_TIMEOUT = Number(process.env.FLOW_PROXY_TIMEOUT ?? 30_000)
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

const server = listen()

// Bring the engine up before announcing the canvas, so the first page load
// never talks to a server that is not there yet. Unmanaged hosts no-op here.
const boot = await engine.ensure().catch((error) => {
  console.error(`opencode    could not start the engine: ${error instanceof Error ? error.message : error}`)
  return undefined
})
if (boot?.managed) {
  const stop = () => {
    void engine.stop().finally(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

console.log(`openflow    http://${hostname}:${server.port}`)
console.log(`opencode    ${upstream}`)
console.log(`project     ${paths.project}`)

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
              serve: engine,
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
  } catch (error) {
    // Bun reports the code on some builds and only the sentence on others.
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" && !/in use/i.test(String(error))) throw error
    console.error(portInUse(port, `http://${hostname}:${port}`))
    return process.exit(1)
  }
}

/** Forwards a request to `opencode serve`, streaming the response back untouched. */
async function proxy(request: Request, url: URL) {
  const headers = new Headers(request.headers)
  headers.delete("host")
  const streamed = STREAMED.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
  const deadline = streamed ? undefined : AbortSignal.timeout(PROXY_TIMEOUT)
  const signal = deadline ? AbortSignal.any([request.signal, deadline]) : request.signal
  try {
    return relay(
      await fetch(new URL(url.pathname + url.search, upstream), {
        method: request.method,
        headers,
        body: request.body,
        signal,
        redirect: "manual",
        // Required by Bun and undici whenever a request carries a stream body.
        duplex: "half",
      } as RequestInit),
    )
  } catch (error) {
    // A GET that timed out is almost always a keep-alive socket to an engine
    // that has been restarted underneath it. One retry on a fresh connection
    // is the difference between a working canvas and a dead one; anything with
    // a body is left alone, because a retry there could repeat a side effect.
    if (deadline?.aborted && request.method === "GET") {
      const retry = new Headers(headers)
      retry.set("connection", "close")
      const answer = await fetch(new URL(url.pathname + url.search, upstream), {
        method: "GET",
        headers: retry,
        signal: AbortSignal.timeout(PROXY_TIMEOUT),
        redirect: "manual",
      }).catch(() => undefined)
      if (answer) return relay(answer)
    }
    // `message`, not `error`: this body is read by the SDK client in the
    // browser, whose `describe()` renders `message` as a sentence and anything
    // else as raw JSON. The dev proxy answers the same key — the two hosts
    // must not drift, or the same failure reads differently in each.
    if (deadline?.aborted) {
      return Response.json(
        {
          message: `opencode serve at ${upstream} did not answer within ${PROXY_TIMEOUT / 1000}s — it may have been restarted; retry`,
        },
        { status: 504 },
      )
    }
    return Response.json(
      { message: `cannot reach opencode serve at ${upstream}: ${error instanceof Error ? error.message : error}` },
      { status: 502 },
    )
  }
}

/**
 * Hands an upstream response back to the browser.
 *
 * `fetch` transparently decompresses, so the body reaching us is plain text
 * while the upstream headers still claim `content-encoding: gzip` and a
 * compressed `content-length`. Forwarding those verbatim makes the browser try
 * to gunzip plaintext — `ERR_CONTENT_DECODING_FAILED`, and on a large body
 * (the ~600-model catalog) a request that simply never settles. The engine's
 * own answer is kept; only the two headers that no longer describe this body
 * are dropped.
 */
function relay(response: Response) {
  if (!response.headers.has("content-encoding")) return response
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
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

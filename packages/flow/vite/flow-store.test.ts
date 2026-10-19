import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer as createHttpServer, type Server } from "node:http"
import { connect, type AddressInfo } from "node:net"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { resetOmpCheck } from "../lib/omp/binary"
import { alive, until } from "../lib/uplift/testing/stub-planner"
import { flowStore } from "./flow-store"

/**
 * The real vite middleware chain (connect inside vite, `flowStore` mounted by `configureServer`) behind a
 * plain `node:http` server. Connect's own routing is the thing under test here: it matches a mount prefix
 * case-insensitively and lets a `.` follow it, which a unit test of the gate alone cannot show.
 */

let scratch: string
let stateDir: string
let previousState: string | undefined
let vite: ViteDevServer | undefined
let http: Server | undefined

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-store-"))
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-state-"))
  previousState = process.env.OPENFLOW_STATE_DIR
  // `rememberPipeline` writes the last-session file into the state directory.
  process.env.OPENFLOW_STATE_DIR = stateDir
})

afterEach(async () => {
  if (http) {
    http.closeAllConnections()
    const closing = Promise.withResolvers<void>()
    http.close(() => closing.resolve())
    await closing.promise
  }
  await vite?.close()
  http = undefined
  vite = undefined
  if (previousState === undefined) delete process.env.OPENFLOW_STATE_DIR
  else process.env.OPENFLOW_STATE_DIR = previousState
  await fs.rm(scratch, { recursive: true, force: true })
  await fs.rm(stateDir, { recursive: true, force: true })
})

async function start() {
  vite = await createServer({
    configFile: false,
    root: scratch,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    plugins: [flowStore({ project: scratch })],
  })
  const middlewares = vite.middlewares
  http = createHttpServer((req, res) => middlewares(req, res))
  const listening = Promise.withResolvers<void>()
  http.listen(0, "127.0.0.1", () => listening.resolve())
  await listening.promise
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`
}

const PIPELINE = { id: "p1", nodes: Array.from({ length: 400 }, (_, index) => ({ id: `n${index}`, data: { prompt: "x".repeat(300), nested: { deep: [index] } } })) }
const file = () => path.join(scratch, ".openflow", "pipelines", "x.json")

// `/flow/api` as connect would match it, plus the variants that fooled a strict prefix test.
const VARIANTS = ["/flow/api", "/FLOW/api", "/Flow/Api", "/FLOW/API", "/flow/api.", "/flow/API."]

describe("the gate on the vite dev host", () => {
  test.each(VARIANTS)("a cross-origin PUT to %s/pipelines/x is a 403 and writes nothing", async (prefix) => {
    const base = await start()
    const response = await fetch(`${base}${prefix}/pipelines/x`, {
      method: "PUT",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      body: JSON.stringify(PIPELINE),
    })
    expect(response.status).toBe(403)
    expect(await fs.stat(file()).catch(() => undefined)).toBeUndefined()
  })

  test.each(VARIANTS)("a cross-origin DELETE of %s/pipelines/x leaves the pipeline in place", async (prefix) => {
    const base = await start()
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), JSON.stringify({ id: "keep" }))
    const response = await fetch(`${base}${prefix}/pipelines/x`, {
      method: "DELETE",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    })
    expect(response.status).toBe(403)
    expect(await fs.readFile(file(), "utf8")).toBe(JSON.stringify({ id: "keep" }))
  })

  test("a same-origin JSON PUT reaches the store and the whole nested body is on disk", async () => {
    const base = await start()
    const response = await fetch(`${base}/flow/api/pipelines/x`, {
      method: "PUT",
      headers: { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(PIPELINE),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(await fs.readFile(file(), "utf8"))).toEqual(PIPELINE)
  })

  test("a same-origin request on a case variant passes the gate instead of being refused", async () => {
    const base = await start()
    const response = await fetch(`${base}/FLOW/api/pipelines/x`, {
      method: "PUT",
      headers: { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ id: "p2" }),
    })
    expect(response.status).not.toBe(403)
  })

  test("paths outside /flow are not the gate's business", async () => {
    const base = await start()
    const response = await fetch(`${base}/assets/x.js`, { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })
    expect(response.status).toBe(404)
  })
})

/**
 * A raw HTTP/1.x exchange: fetch and node's own client normalise `..` and refuse odd Host values, a client that
 * writes the request line itself does neither.
 */
async function raw(base: string, request: { method?: string; target: string; version?: string; host?: string | null; headers?: Record<string, string> }) {
  const url = new URL(base)
  const socket = connect(Number(url.port), url.hostname)
  const chunks: Buffer[] = []
  const closed = Promise.withResolvers<void>()
  socket.on("data", (chunk: Buffer) => chunks.push(chunk))
  socket.on("close", () => closed.resolve())
  socket.on("error", () => closed.resolve())
  const lines = [`${request.method ?? "GET"} ${request.target} HTTP/${request.version ?? "1.1"}`]
  // `host: null` sends no Host header at all.
  const host = request.host === undefined ? url.host : request.host
  if (host !== null) lines.push(`host: ${host}`)
  for (const [name, value] of Object.entries({ connection: "close", ...request.headers })) lines.push(`${name}: ${value}`)
  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  await closed.promise
  const text = Buffer.concat(chunks).toString("utf8")
  return { status: Number(/^HTTP\/1\.\d (\d{3})/.exec(text)?.[1]), text }
}

// Spellings that the gate (looking at the normalised original URL) and the store (re-parsing what connect left
// after stripping its mount) used to read differently: all of them reach `/pipelines/x` once normalised.
const AMBIGUOUS_TARGETS = [
  "/flow/api/../../pipelines/x",
  "/flow/api/%2e%2e/%2e%2e/pipelines/x",
  "/flow/api/.%2e/.%2e/pipelines/x",
  "/flow/api/%2E%2E/%2E%2E/pipelines/x",
  "/FLOW/api/../../pipelines/x",
  "/flow/api./../../pipelines/x",
  "/flow/api\\..\\..\\pipelines\\x",
  "/flow%00/api/pipelines/x",
  "/flow/api/pipelines/x;a=b",
]

describe("raw request lines on the vite dev host", () => {
  async function kept() {
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), JSON.stringify({ id: "keep" }))
  }
  const intact = async () => expect(await fs.readFile(file(), "utf8")).toBe(JSON.stringify({ id: "keep" }))

  test.each(AMBIGUOUS_TARGETS)("a cross-origin DELETE of %s is refused and the pipeline stays", async (target) => {
    const base = await start()
    await kept()
    const response = await raw(base, { method: "DELETE", target, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })
    expect([400, 403]).toContain(response.status)
    await intact()
  })

  test.each(AMBIGUOUS_TARGETS)("a same-origin DELETE of %s is refused too: the gate does not guess which route was meant", async (target) => {
    const base = await start()
    await kept()
    const response = await raw(base, { method: "DELETE", target, headers: { origin: base, "sec-fetch-site": "same-origin" } })
    expect(response.status).toBe(400)
    expect(response.text).toContain("forbidden-path")
    await intact()
  })

  test("a plain same-origin DELETE written as a raw line still deletes", async () => {
    const base = await start()
    await kept()
    const response = await raw(base, { method: "DELETE", target: "/flow/api/pipelines/x", headers: { origin: base, "sec-fetch-site": "same-origin" } })
    expect(response.status).toBe(200)
    expect(await fs.stat(file()).catch(() => undefined)).toBeUndefined()
  })

  test("a path outside /flow that merely contains dot segments is not refused", async () => {
    const base = await start()
    expect((await raw(base, { target: "/assets/../x.js" })).status).toBe(404)
  })

  test("a protocol-relative target cannot hide /flow/api from the gate", async () => {
    const base = await start()
    await kept()
    const refused = await raw(base, { method: "DELETE", target: "//flow/api/pipelines/x", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })
    expect(refused.status).toBe(403)
    await intact()
  })

  test("an HTTP/1.0 request without a Host header is a 403 forbidden-host, as on Bun", async () => {
    const base = await start()
    const response = await raw(base, { target: "/flow/api/context", version: "1.0", host: null })
    expect(response.status).toBe(403)
    expect(response.text).toContain("forbidden-host")
  })

  // Vite's own host check may answer first for some of these; either way a 403, never the 500 a throwing `new Request` gave.
  test.each(["localhost:5174@evil.example", "evil.example#localhost", "localhost:99999"])("Host: %s is a 403, not a server error", async (host) => {
    const base = await start()
    const response = await raw(base, { target: "/flow/api/context", host })
    expect(response.status).toBe(403)
  })
})

// The omp stand-in is a `#!/bin/sh` script and the probe is a POSIX process group: nothing here runs on Windows.
describe.skipIf(process.platform === "win32")("the host's children under the vite dev server", () => {
  test("closing the server leaves no omp probe running, and the request that was waiting on it is answered", async () => {
    // `omp --version` answers; anything else (the catalog read's rpc process) records its pid and hangs.
    const bin = path.join(stateDir, "bin")
    const pids = path.join(stateDir, "probe.pid")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "omp"), `#!/bin/sh\ncase " $* " in *" --version "*) echo "omp/18.12.2"; exit 0;; esac\necho $$ >> "${pids}"\nexec sleep 300\n`, { mode: 0o755 })
    const previous = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`
    resetOmpCheck()
    try {
      const base = await start()
      const reading = fetch(`${base}/flow/api/engine/models`).then((response) => response.status)
      await until(() => fs.readFile(pids, "utf8").then((text) => text.endsWith("\n"), () => false))
      const pid = Number((await fs.readFile(pids, "utf8")).trim().split("\n")[0])
      expect(await alive(pid)).toBe(true)

      await vite?.close()

      expect(await alive(pid)).toBe(false)
      expect(await reading).toBe(503)
    } finally {
      process.env.PATH = previous
      resetOmpCheck()
    }
  })

  test("a project switch is refused while a card's session is live, naming it, and allowed once it is stopped", async () => {
    const bin = path.join(stateDir, "bin")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(stateDir, "script.json"), "[]")
    const stub = path.join(import.meta.dir, "..", "lib", "omp", "testing", "stub-omp.ts")
    await fs.writeFile(
      path.join(bin, "omp"),
      `#!/bin/sh\ncase " $* " in *" --version "*) echo "omp/18.12.2"; exit 0;; esac\nexport STUB_OMP_SCRIPT="${path.join(stateDir, "script.json")}"\nexec "${process.execPath}" "${stub}" "$@"\n`,
      { mode: 0o755 },
    )
    const previous = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`
    resetOmpCheck()
    try {
      const base = await start()
      const send = (route: string, method: string, body?: unknown) =>
        fetch(`${base}${route}`, {
          method,
          headers: { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "flow-elsewhere-"))
      try {
        const created = await send("/flow/api/engine/sessions", "POST", { runId: "run-1", nodeId: "n1", card: { key: "card-1", role: "Builder" }, directory: scratch })
        expect(created.status).toBe(200)
        const { id } = (await created.json()) as { id: string }

        // Any live session pins the project, idle between turns included, and the refusal names it so the user can stop it.
        const idle = await send("/flow/api/project", "POST", { path: elsewhere })
        expect(idle.status).toBe(409)
        expect(await idle.json()).toMatchObject({ code: "project-busy", sessions: [id] })

        // The stub holds a turn open until it is aborted.
        await fs.writeFile(path.join(stateDir, "script.json"), JSON.stringify([{ hang: true }]))
        expect((await send(`/flow/api/engine/sessions/${id}/prompt`, "POST", { text: "go" })).status).toBeLessThan(300)

        const refused = await send("/flow/api/project", "POST", { path: elsewhere })
        expect(refused.status).toBe(409)
        expect(await refused.json()).toMatchObject({ code: "project-busy", sessions: [id] })

        expect((await send(`/flow/api/engine/sessions/${id}`, "DELETE")).status).toBe(200)
        expect((await send("/flow/api/project", "POST", { path: elsewhere })).status).toBe(200)
      } finally {
        await fs.rm(elsewhere, { recursive: true, force: true })
      }
    } finally {
      process.env.PATH = previous
      resetOmpCheck()
    }
  })
})

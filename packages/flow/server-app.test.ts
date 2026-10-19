import type { Server } from "bun"
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { connect } from "node:net"
import os from "node:os"
import path from "node:path"
import { createHost, type Host } from "./lib/host"
import { flowPaths } from "./lib/store"
import { bunWebSocket, type PtySocketData } from "./lib/terminal/ws-bun"
import { createApp } from "./server-app"

/**
 * The standalone server's request handler on a real `Bun.serve` (port 0, development mode off as in `server.ts`).
 * Raw sockets throughout: fetch refuses to send, or silently rewrites, the malformed paths under test.
 */

let dir: string
let dist: string
let project: string
let host: Host
let server: Server<PtySocketData>
let failing: Server<PtySocketData>
let base: string
let failingBase: string
const pipeline = () => path.join(project, ".openflow", "pipelines", "x.json")

beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "flow-app-")))
  dist = path.join(dir, "dist")
  project = path.join(dir, "project")
  mkdirSync(path.join(dist, "assets"), { recursive: true })
  mkdirSync(project)
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>openflow</title>")
  writeFileSync(path.join(dist, "assets", "app-1.js"), "export {}")
  writeFileSync(path.join(dir, "secret.html"), "<title>outside dist</title>")

  host = createHost({ project: () => project, allowRemote: false, env: { PATH: process.env.PATH, HOME: dir, OPENFLOW_STATE_DIR: path.join(dir, "state") } })
  const terminal = bunWebSocket(host.terminal)
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", development: false, fetch: createApp({ host, terminal, paths: flowPaths(project), dist }), websocket: terminal.websocket })
  base = `http://127.0.0.1:${server.port}`

  // A host whose gate throws: the one place nothing inside `createApp` catches on its own.
  const broken = { ...host, gate: async () => Promise.reject(new Error("secret detail at /home/user/x.ts:1")) } satisfies Host
  failing = Bun.serve({ port: 0, hostname: "127.0.0.1", development: false, fetch: createApp({ host: broken, terminal, paths: flowPaths(project), dist }), websocket: terminal.websocket })
  failingBase = `http://127.0.0.1:${failing.port}`
})

afterAll(async () => {
  await host.dispose()
  await server.stop(true)
  await failing.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

/** One raw HTTP/1.1 exchange. */
async function raw(origin: string, request: { method?: string; target: string; headers?: Record<string, string> }) {
  const url = new URL(origin)
  const socket = connect(Number(url.port), url.hostname)
  const chunks: Buffer[] = []
  const closed = Promise.withResolvers<void>()
  socket.on("data", (chunk: Buffer) => chunks.push(chunk))
  socket.on("close", () => closed.resolve())
  socket.on("error", () => closed.resolve())
  const lines = [`${request.method ?? "GET"} ${request.target} HTTP/1.1`]
  for (const [name, value] of Object.entries({ host: url.host, connection: "close", ...request.headers })) lines.push(`${name}: ${value}`)
  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  await closed.promise
  const text = Buffer.concat(chunks).toString("utf8")
  const [head = "", ...rest] = text.split("\r\n\r\n")
  return { status: Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1]), head: head.toLowerCase(), body: rest.join("\r\n\r\n") }
}

describe("a malformed static path", () => {
  test.each(["/%zz", "/%", "/%e0%a4%a", "/flow%00/api/x", "/a%00b", "/assets/%zz.js"])("%s is a short 400 or 404, never an HTML stack page", async (target) => {
    const response = await raw(base, { target })
    expect([400, 404]).toContain(response.status)
    expect(response.head).not.toContain("text/html")
    expect(response.body.length).toBeLessThan(400)
    expect(response.body).not.toMatch(/\.ts:\d+|<html|stack/i)
  })

  test("a well-formed path still serves the bundle: index.html at the root and on a deep link, assets with a long cache", async () => {
    const root = await raw(base, { target: "/" })
    expect(root.status).toBe(200)
    expect(root.body).toContain("<title>openflow</title>")
    expect(root.head).toContain("no-store")
    const deep = await raw(base, { target: "/some/canvas/route" })
    expect(deep.status).toBe(200)
    expect(deep.body).toContain("<title>openflow</title>")
    const asset = await raw(base, { target: "/assets/app-1.js" })
    expect(asset.status).toBe(200)
    expect(asset.head).toContain("immutable")
    // Percent-encoding that decodes to a legal name is still that name.
    expect((await raw(base, { target: "/assets/app%2D1.js" })).body).toBe("export {}")
  })

  test.each(["/..%2fsecret.html", "/%2e%2e/secret.html", "/assets/..%2f..%2fsecret.html"])("%s cannot leave dist", async (target) => {
    const response = await raw(base, { target })
    expect(response.body).not.toContain("outside dist")
  })
})

describe("the store through the gate", () => {
  const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site" }

  test.each(["/flow/api/../../pipelines/x", "/flow/api/%2e%2e/%2e%2e/pipelines/x", "/FLOW/api/../../pipelines/x", "/flow/api./../../pipelines/x", "/flow/api/pipelines/x;a=b", "/flow\\api\\pipelines\\x"])(
    "a cross-origin DELETE of %s leaves the pipeline in place",
    async (target) => {
      mkdirSync(path.dirname(pipeline()), { recursive: true })
      writeFileSync(pipeline(), JSON.stringify({ id: "keep" }))
      await raw(base, { method: "DELETE", target, headers: evil })
      expect(readFileSync(pipeline(), "utf8")).toBe(JSON.stringify({ id: "keep" }))
    },
  )

  test("a same-origin DELETE of the plain path still deletes", async () => {
    mkdirSync(path.dirname(pipeline()), { recursive: true })
    writeFileSync(pipeline(), JSON.stringify({ id: "gone" }))
    const response = await raw(base, { method: "DELETE", target: "/flow/api/pipelines/x", headers: { origin: base, "sec-fetch-site": "same-origin" } })
    expect(response.status).toBe(200)
    expect(existsSync(pipeline())).toBe(false)
  })

  test("a cross-origin request to the plain path is the gate's 403", async () => {
    const response = await raw(base, { method: "DELETE", target: "/flow/api/pipelines/x", headers: evil })
    expect(response.status).toBe(403)
  })

  test("a NUL or a parameter in a /flow path is the gate's 400 forbidden-path", async () => {
    for (const target of ["/flow%00/api/x", "/flow/api/pipelines/x;a=b"]) {
      const response = await raw(base, { target })
      expect(response.status).toBe(400)
      expect(response.body).toContain("forbidden-path")
    }
  })

  test("a project switch is refused with 409 project-busy while the host reports live work, and the project stays", async () => {
    const terminal = bunWebSocket(host.terminal)
    const paths = flowPaths(project)
    const busy = { ...host, projectLocked: () => true } satisfies Host
    const locked = Bun.serve({ port: 0, hostname: "127.0.0.1", development: false, fetch: createApp({ host: busy, terminal, paths, dist }), websocket: terminal.websocket })
    try {
      const origin = `http://127.0.0.1:${locked.port}`
      const elsewhere = path.join(dir, "elsewhere")
      mkdirSync(elsewhere, { recursive: true })
      const response = await fetch(`${origin}/flow/api/project`, {
        method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ path: elsewhere }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: "project-busy" })
      expect(paths.project).toBe(project)
    } finally {
      await locked.stop(true)
    }
  })
})

describe("an unexpected throw", () => {
  test("is a 500 JSON { error } with no stack and no internals, and nothing HTML", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      const response = await raw(failingBase, { target: "/flow/api/anything" })
      expect(response.status).toBe(500)
      expect(response.head).toContain("application/json")
      expect(JSON.parse(response.body)).toEqual({ error: "internal error" })
      expect(response.body).not.toContain("secret")
      // The cause is kept for the operator.
      expect(log).toHaveBeenCalledTimes(1)
    } finally {
      log.mockRestore()
    }
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer as createHttpServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer, type ViteDevServer } from "vite"
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

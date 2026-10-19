import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { createServer, type ViteDevServer } from "vite"

/**
 * The project's own `vite.config.ts` on a real dev server (port 0 in place of the fixed canvas port, no watcher,
 * no HMR socket). What is under test is the configuration `bun dev` actually runs with.
 */

setDefaultTimeout(30_000)

const packageRoot = path.join(import.meta.dir, "..")
const saved = { project: process.env.OPENFLOW_PROJECT, state: process.env.OPENFLOW_STATE_DIR }
let scratch: string
let dev: ViteDevServer | undefined

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-dev-"))
  process.env.OPENFLOW_PROJECT = scratch
  process.env.OPENFLOW_STATE_DIR = path.join(scratch, "state")
})

afterEach(async () => {
  await dev?.close()
  dev = undefined
  for (const [key, value] of [["OPENFLOW_PROJECT", saved.project], ["OPENFLOW_STATE_DIR", saved.state]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

async function start() {
  dev = await createServer({
    root: packageRoot,
    configFile: path.join(packageRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { port: 0, strictPort: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  await dev.listen()
  return `http://localhost:${(dev.httpServer!.address() as AddressInfo).port}`
}

describe("CORS on the dev server", () => {
  test("the config turns it off", async () => {
    await start()
    expect(dev!.config.server.cors).toBe(false)
  })

  test("a page on another origin gets no Access-Control-Allow-Origin, so it cannot read a response", async () => {
    const base = await start()
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:9999", "https://evil.example"]) {
      const response = await fetch(`${base}/index.html`, { headers: { origin } })
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    }
  })

  test("a preflight from another origin is not answered as an allowed 204", async () => {
    const base = await start()
    const response = await fetch(`${base}/index.html`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
    })
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("access-control-allow-methods")).toBeNull()
  })

  test("the file system fence is left on", async () => {
    await start()
    expect(dev!.config.server.fs.strict).toBe(true)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSupervisor, healthy, serveCommand, supervisorFor, unmanaged, type Supervisor } from "./opencode-process"

/**
 * The supervisor is what makes the canvas's "restart the engine" button real,
 * so the tests run an actual child process rather than a mock: the parts that
 * break are process-tree kills and port hand-off, and neither shows up against
 * a fake.
 *
 * The stand-in engine is a one-file Bun server that answers `/api/health` and
 * writes its own boot count, so a restart is provable — a new process, not a
 * survivor.
 */

const started: Supervisor[] = []
const scratch: string[] = []

afterEach(async () => {
  for (const supervisor of started.splice(0)) await supervisor.stop().catch(() => undefined)
  for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function fakeEngine(port: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-engine-"))
  scratch.push(dir)
  const marker = path.join(dir, "boots.txt")
  const script = path.join(dir, "engine.ts")
  await fs.writeFile(
    script,
    `
import fs from "node:fs"
fs.appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\n")
Bun.serve({ port: ${port}, fetch: (request) => new URL(request.url).pathname === "/api/health"
  ? Response.json({ ok: true })
  : new Response("no", { status: 404 }) })
`,
  )
  return {
    dir,
    script,
    url: `http://127.0.0.1:${port}`,
    async boots() {
      const raw = await fs.readFile(marker, "utf8").catch(() => "")
      return raw.split("\n").filter(Boolean)
    },
  }
}

/** A port nothing is listening on, found by binding and releasing one. */
async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = server.port!
  server.stop(true)
  return port
}

describe("serveCommand", () => {
  test("runs the engine from source inside the repo", () => {
    const spec = serveCommand({ repo: "/repo", url: "http://127.0.0.1:4096", hasSource: true, env: {} })
    expect(spec.command).toContain("packages/opencode")
    expect(spec.command.at(-1)).toBe("4096")
    expect(spec.cwd).toBe("/repo")
  })

  test("falls back to the packaged binary outside it", () => {
    const spec = serveCommand({ repo: "/anywhere", url: "http://127.0.0.1:4097", hasSource: false, env: {} })
    expect(spec.command).toEqual(["opencode", "serve", "--port", "4097"])
  })

  test("an explicit command wins, and is split into argv rather than shelled out", () => {
    const spec = serveCommand({
      repo: "/repo",
      url: "http://127.0.0.1:4096",
      hasSource: true,
      env: { OPENCODE_SERVE_COMMAND: "my-opencode serve --port 9999" },
    })
    expect(spec.command).toEqual(["my-opencode", "serve", "--port", "9999"])
  })
})

describe("ownership", () => {
  test("does not manage the engine unless asked", async () => {
    const supervisor = await supervisorFor(
      { command: ["opencode", "serve"], cwd: process.cwd(), url: "http://127.0.0.1:1" },
      {},
    )
    const status = await supervisor.status()
    expect(status.managed).toBe(false)
    expect(status.reason).toContain("FLOW_MANAGE_SERVER")
  })

  test("refuses to adopt an engine that is already serving the port", async () => {
    const port = await freePort()
    const engine = await fakeEngine(port)
    const owner = createSupervisor({ command: ["bun", engine.script], cwd: engine.dir, url: engine.url })
    started.push(owner)
    await owner.ensure()

    const second = await supervisorFor({ command: ["bun", engine.script], cwd: engine.dir, url: engine.url }, {
      FLOW_MANAGE_SERVER: "1",
    })
    const status = await second.status()
    expect(status.managed).toBe(false)
    expect(status.reason).toContain("already serving")
    // …and it will not try: a second engine on one port is the failure mode
    // this whole check exists to prevent.
    expect(second.restart()).rejects.toThrow(/does not own/)
  })

  test("an unmanaged supervisor hands back the command instead of restarting", async () => {
    const supervisor = unmanaged({ command: ["opencode", "serve", "--port", "4096"], cwd: ".", url: "http://127.0.0.1:1" }, "not ours")
    expect((await supervisor.status()).command).toBe("opencode serve --port 4096")
    expect(supervisor.restart()).rejects.toThrow(/opencode serve --port 4096/)
  })
})

describe("restart", () => {
  test("replaces the process and comes back answering", async () => {
    const port = await freePort()
    const engine = await fakeEngine(port)
    const supervisor = createSupervisor({ command: ["bun", engine.script], cwd: engine.dir, url: engine.url })
    started.push(supervisor)

    const first = await supervisor.ensure()
    expect(first.running).toBe(true)
    expect(await engine.boots()).toHaveLength(1)

    const second = await supervisor.restart()
    expect(second.running).toBe(true)
    expect(second.managed).toBe(true)
    // A new boot, not the old process still holding the port.
    const boots = await engine.boots()
    expect(boots).toHaveLength(2)
    expect(boots[0]).not.toBe(boots[1])
    expect(await healthy(engine.url)).toBe(true)
  }, 60_000)

  test("stopping leaves the port free", async () => {
    const port = await freePort()
    const engine = await fakeEngine(port)
    const supervisor = createSupervisor({ command: ["bun", engine.script], cwd: engine.dir, url: engine.url })
    started.push(supervisor)

    await supervisor.ensure()
    await supervisor.stop()
    expect(await healthy(engine.url)).toBe(false)
  }, 60_000)

  test("a command that cannot start fails fast instead of hanging", async () => {
    const port = await freePort()
    const supervisor = createSupervisor({
      command: ["bun", "--this-flag-does-not-exist"],
      cwd: process.cwd(),
      url: `http://127.0.0.1:${port}`,
    })
    started.push(supervisor)
    expect(supervisor.ensure()).rejects.toThrow()
  }, 30_000)
})

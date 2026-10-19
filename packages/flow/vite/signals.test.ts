import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { engineRoutes } from "../shared/engine"
import { OMP_ROUTES } from "../shared/omp"
import { alive, goneWithin } from "../lib/terminal/test-harness"

/**
 * `vite` itself, as `bun run dev` starts it, with an omp session open: Ctrl+C (SIGINT) and a stop (SIGTERM) must
 * take the omp process with them. omp sessions are detached process groups, so nothing but the plugin's own
 * shutdown reaches them when vite goes. The stub keeps running after its stdin closes, standing in for an omp that is
 * mid-turn ("finish accepted work"), so only the host's escalation ends it: EOF, a grace period of 5 s, then SIGTERM.
 */

setDefaultTimeout(30_000)

// POSIX process groups and a `/bin/sh` wrapper standing in for omp.
const suite = describe.skipIf(process.platform === "win32")

const packageRoot = path.join(import.meta.dir, "..")
const STUB_OMP = path.join(packageRoot, "lib", "omp", "testing", "stub-omp.ts")
const VITE = path.join(packageRoot, "node_modules", "vite", "bin", "vite.js")

let dir: string
let pidFile: string
let vite: Bun.Subprocess | undefined

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "flow-signal-")))
  pidFile = path.join(dir, "pids")
  writeFileSync(pidFile, "")
})

afterEach(() => {
  // A failing run must not leave a stub that ignores EOF behind.
  for (const pid of pids()) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }
  vite?.kill("SIGKILL")
  vite = undefined
  rmSync(dir, { recursive: true, force: true })
})

const pids = () => readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number)

async function freePort() {
  const probe = createServer()
  const listening = Promise.withResolvers<void>()
  probe.listen(0, "127.0.0.1", () => listening.resolve())
  await listening.promise
  const port = (probe.address() as { port: number }).port
  const closed = Promise.withResolvers<void>()
  probe.close(() => closed.resolve())
  await closed.promise
  return port
}

/** Starts vite on a free port and resolves with its URL once it says it is listening. */
async function start() {
  const project = path.join(dir, "project")
  mkdirSync(project)
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0)

  const wrapper = path.join(dir, "omp")
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in *" --version "*) echo "omp/18.12.2"; exit 0;; esac',
      `case " $* " in *" config path "*) echo "${dir}/profile"; exit 0;; esac`,
      `echo $$ >> "${pidFile}"`,
      "export STUB_OMP_IGNORE_EOF=1",
      `exec "${process.execPath}" "${STUB_OMP}" "$@"`,
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)

  const port = await freePort()
  const child = Bun.spawn(["node", VITE, "--port", String(port), "--strictPort"], {
    cwd: packageRoot,
    env: { PATH: process.env.PATH, HOME: dir, OPENFLOW_PROJECT: project, OPENFLOW_STATE_DIR: path.join(dir, "state") },
    stdout: "pipe",
    stderr: "pipe",
  })
  vite = child

  const reader = child.stdout.getReader()
  let output = ""
  while (!/Local:/.test(output)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`vite exited before listening: ${output}`)
    output += new TextDecoder().decode(chunk.value)
  }
  reader.releaseLock()
  return { base: `http://localhost:${port}`, project }
}

async function openSession(base: string, project: string) {
  const saved = await fetch(`${base}${OMP_ROUTES.settings}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ binary: path.join(dir, "omp"), swarm: { mode: "off" } }),
  })
  expect(saved.status).toBe(200)
  const response = await fetch(`${base}${engineRoutes.sessions}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: "run-1", nodeId: "n", card: { key: "card-n", role: "Builder" }, model: "stub/model-0", directory: project, permissions: "auto", swarm: "off" }),
  })
  expect(response.status).toBe(200)
}

suite("stopping the vite dev server with an omp session open", () => {
  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("%s ends vite and the omp process (exit code %d)", async (signal, code) => {
    const dev = await start()
    await openSession(dev.base, dev.project)
    const omp = pids()[0]!
    expect(omp).toBeGreaterThan(0)
    expect(alive(omp)).toBe(true)

    vite!.kill(signal)
    // The real deadline: the grace period (5 s) plus a margin. A wall-clock bound is the point here, there is no event to await for "too slow".
    const deadline = Promise.withResolvers<"timeout">()
    const timer = setTimeout(() => deadline.resolve("timeout"), 12_000)
    const exited = await Promise.race([vite!.exited, deadline.promise])
    clearTimeout(timer)
    expect(exited).toBe(code)
    expect(await goneWithin(omp, 2000)).toBe(true)
  })
})

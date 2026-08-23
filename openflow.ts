#!/usr/bin/env bun
/**
 * OpenFlow launcher — one command, both processes.
 *
 * Starts `opencode serve` (the engine, :4096) and the canvas (:5174), waits
 * until the engine actually answers, then prints the URL — so a non-dev never
 * juggles two terminals. Ports already serving are reused, not double-started.
 *
 *   bun openflow.ts
 *   OPENFLOW_PROJECT=/path/to/app bun openflow.ts   # agents edit that repo
 *   OPENCODE_SERVER_URL=http://127.0.0.1:4097 bun openflow.ts
 *
 * argv/URL resolution lives in `packages/flow/lib/launch.ts` (unit-tested);
 * this file only spawns, streams, waits, and tears down.
 */
import { launchPlan } from "./packages/flow/lib/launch"
import { healthy } from "./packages/flow/lib/opencode-process"

const repo = import.meta.dir
const ENGINE_TIMEOUT = 90_000
const POLL = 500

const children: Bun.Subprocess[] = []
let quitting = false

/** Something answers this URL at all — enough to know a port is taken. */
async function reachable(url: string) {
  return await fetch(url, { signal: AbortSignal.timeout(2_000) })
    .then(() => true)
    .catch(() => false)
}

function line(prefix: string, text: string) {
  for (const part of text.split(/\r?\n/)) if (part) console.log(`[${prefix}] ${part}`)
}

async function pipe(stream: ReadableStream<Uint8Array> | number | undefined, prefix: string) {
  if (!stream || typeof stream === "number") return
  const decoder = new TextDecoder()
  for await (const chunk of stream) line(prefix, decoder.decode(chunk))
}

/**
 * Frees a port left bound by a dead or orphaned previous run — the case a
 * health/reachability probe can't see: the socket is held but nothing
 * answers HTTP yet (or ever again), so `skip` comes back false and the child
 * we spawn next fails to bind. Only called right before spawning a child
 * whose probe already said "not up", so a genuinely live sibling session
 * (probe says healthy) is never touched.
 */
function freePort(port: string) {
  if (process.platform === "win32") {
    const { stdout } = Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe" })
    const pids = new Set(
      stdout
        .toString()
        .split(/\r?\n/)
        .filter((line) => line.includes(`:${port}`) && line.includes("LISTENING"))
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid): pid is string => !!pid && pid !== "0"),
    )
    for (const pid of pids) Bun.spawnSync(["taskkill", "/pid", pid, "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    return
  }
  const { stdout } = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`], { stdout: "pipe" })
  for (const pid of stdout.toString().split(/\r?\n/).filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGKILL")
    } catch {
      // already gone
    }
  }
}

/**
 * Kills a child and everything it spawned. `bun run …` execs a grandchild that
 * actually holds the port, so on Windows the whole tree has to go (`taskkill
 * /T`); on POSIX a group signal reaches the tree.
 */
function killTree(pid: number) {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // already gone
    }
  }
}

function teardown(code: number) {
  if (quitting) return
  quitting = true
  for (const child of children) if (child.pid && child.exitCode === null) killTree(child.pid)
  process.exit(code)
}

/** If a child dies on its own, take the other down with the same code. */
function watch(child: Bun.Subprocess, name: string) {
  void child.exited.then((code) => {
    if (quitting) return
    line(name, `exited (${code})`)
    teardown(typeof code === "number" && code ? code : 0)
  })
}

function spawnChild(argv: string[], name: string) {
  const child = Bun.spawn(argv, { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" })
  children.push(child)
  void pipe(child.stdout, name)
  void pipe(child.stderr, name)
  watch(child, name)
  return child
}

function openBrowser(url: string) {
  const argv =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url]
  try {
    Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" })
  } catch {
    // best-effort — the URL is printed regardless
  }
}

async function main() {
  process.on("SIGINT", () => teardown(0))
  process.on("SIGTERM", () => teardown(0))

  const plan = await launchPlan({
    env: process.env,
    repo,
    // engine readiness is a real health check; the canvas has no /api/health.
    probe: (url) => (url.includes("5174") ? reachable(url) : healthy(url)),
  })

  if (plan.engine.skip) console.log(`engine already running on ${plan.engineUrl} — reusing it`)
  else {
    freePort(new URL(plan.engineUrl).port || "4096")
    console.log(`starting engine: ${plan.engine.argv.join(" ")}`)
    spawnChild(plan.engine.argv, "engine")
  }

  const deadline = Date.now() + ENGINE_TIMEOUT
  let ready = plan.engine.skip
  while (!ready && Date.now() < deadline) {
    if (await healthy(plan.engineUrl)) {
      ready = true
      break
    }
    await Bun.sleep(POLL)
  }
  if (!ready) {
    console.error(`engine did not answer ${plan.engineUrl} within ${ENGINE_TIMEOUT / 1000}s`)
    return teardown(1)
  }
  console.log(`engine ready on ${plan.engineUrl}`)

  if (plan.canvas.skip) console.log(`canvas already serving ${plan.canvasUrl} — reusing it`)
  else {
    freePort(new URL(plan.canvasUrl).port || "5174")
    console.log(`starting canvas: ${plan.canvas.argv.join(" ")}`)
    spawnChild(plan.canvas.argv, "canvas")
  }

  console.log(`\n→ Open ${plan.canvasUrl}\n`)
  openBrowser(plan.canvasUrl)
}

void main()

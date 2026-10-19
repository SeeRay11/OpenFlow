import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { OmpSettings } from "../../shared/omp"

/**
 * Running claude-ultrathink's headless planner (`bin/run-bun hooks/engine.ts`):
 * where it lives, what environment it gets, and a bounded pool of process
 * groups that are always killed as a unit.
 *
 * Runs under both hosts (Bun and the Node vite plugin), so `node:` APIs only.
 */

const STDERR_KEEP = 2048
/** The planner prints one JSON line; a runaway child must not fill the host's memory. */
const STDOUT_LIMIT = 16 * 1024 * 1024
export const KILL_GRACE_MS = 5_000

/** Names the `claude` CLI, Jev and the planner itself need. Everything else is dropped. */
const ENV_EXACT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TERM",
  "TMPDIR",
  "BUN",
  "BUN_INSTALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CONFIG_DIR",
  // Presence passthrough: Jev reads these itself; this module never looks at the values.
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ULTRATHINK_MCP_STORE",
  "ULTRATHINK_DECISIONS",
]
const ENV_PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_CODE_"]
const SUBSTRATE_PASSTHROUGH = ["SUBSTRATE_TOKEN", "SUBSTRATE_TIMEOUT_MS", "SUBSTRATE_DISABLED"]

export type PlannerSpec = {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written to the child's stdin, then stdin is closed. */
  stdin: string
  /** Wall clock from the moment the child starts; queue wait does not count. */
  timeoutMs: number
}

export type PlannerExit = {
  stdout: string
  /** The last 2 KiB. */
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** The caller's signal or `dispose()` ended it (possibly before it started). */
  aborted: boolean
  /** stdout went past the limit and the group was killed. */
  truncated: boolean
  /** The process could not be spawned at all. */
  spawnError?: string
}

export type PlannerPool = {
  run(spec: PlannerSpec, signal?: AbortSignal): Promise<PlannerExit>
  dispose(): Promise<void>
}

export type Located = { root: string } | { reason: string }

/**
 * An explicitly configured root wins even when it is wrong: falling through to
 * another checkout would run a different planner than the one the user named.
 */
export async function locate(settings: OmpSettings, env: NodeJS.ProcessEnv): Promise<Located> {
  const configured = settings.uplift.root.trim()
  const fromEnv = env.ULTRATHINK_ROOT?.trim() ?? ""
  const source = configured ? "the claude-ultrathink path in Omp settings" : fromEnv ? "ULTRATHINK_ROOT" : ""
  const home = env.HOME?.trim() || os.homedir()
  const root = configured || fromEnv || path.join(home, ".omp", "plugins", "node_modules", "ultrathink")
  const hint = "set the claude-ultrathink path in Omp settings"

  if (!path.isAbsolute(root)) return { reason: `${source} must be an absolute path: ${hint}` }
  for (const file of ["bin/run-bun", "hooks/engine.ts"]) {
    const found = await fs.stat(path.join(root, file)).then((stat) => stat.isFile(), () => false)
    if (found) continue
    if (source) return { reason: `${source} (${root}) is not a claude-ultrathink checkout, ${file} is missing: ${hint}` }
    return { reason: `claude-ultrathink was not found in omp's plugin directory (${root}): ${hint}` }
  }
  return { root }
}

/** Planner environment: the allowlist plus the per-card overrides. Never carries a value this module cannot name. */
export function plannerEnv(base: NodeJS.ProcessEnv, settings: OmpSettings, stateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (ENV_EXACT.includes(name) || ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) env[name] = value
  }

  // Tracking, shipping and the learning loops write to Linear, Notion and the
  // user's own memory: none of that belongs to a card's prompt uplift.
  env.ULTRATHINK_STATE_DIR = stateDir
  env.ULTRATHINK_TRACK = "0"
  env.ULTRATHINK_SHIP = "0"
  env.ULTRATHINK_HINDSIGHT = "0"
  env.ULTRATHINK_RAGFLOW = "0"
  env.ULTRATHINK_TEACH = "0"

  if (!settings.memory.enabled) {
    env.SUBSTRATE_DISABLED = "1"
    return env
  }
  const url = settings.substrate.url.trim() || base.SUBSTRATE_URL
  if (url) env.SUBSTRATE_URL = url
  for (const name of SUBSTRATE_PASSTHROUGH) {
    const value = base[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** Write-then-rename: a reader (the planner, a GET) never sees a half-written file. */
export async function writeAtomic(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(temp, text, { mode: 0o600 })
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
}

/** The per-run control the planner reads from `<stateDir>/control.json` before it plans. */
export async function writeControl(stateDir: string, settings: OmpSettings) {
  const control = { enabled: true, thinkEnabled: true, hitlEnabled: settings.uplift.hitl, trackEnabled: false }
  await writeAtomic(path.join(stateDir, "control.json"), `${JSON.stringify(control, null, 2)}\n`)
}

/** What a run that was cancelled before it started resolves to. */
const CANCELLED: PlannerExit = { stdout: "", stderr: "", code: null, signal: null, timedOut: false, aborted: true, truncated: false }

function execute(spec: PlannerSpec, signal: AbortSignal, graceMs: number): Promise<PlannerExit> {
  if (signal.aborted) return Promise.resolve(CANCELLED)
  const done = Promise.withResolvers<PlannerExit>()
  const [command, ...args] = spec.argv
  const posix = process.platform !== "win32"
  const child = spawn(command!, args, {
    cwd: spec.cwd,
    env: spec.env,
    // Own process group: the planner starts `claude` and Bun children, and a
    // timeout that only killed the leader would leave them running.
    detached: posix,
    stdio: ["pipe", "pipe", "pipe"],
  })

  const chunks: Buffer[] = []
  let size = 0
  let stderr = ""
  let timedOut = false
  let aborted = false
  let truncated = false
  let settled = false
  let killTimer: ReturnType<typeof setTimeout> | undefined

  const signalGroup = (name: NodeJS.Signals) => {
    try {
      if (posix && child.pid) process.kill(-child.pid, name)
      else child.kill(name)
    } catch {
      // The group is already gone.
    }
  }
  const terminate = () => {
    signalGroup("SIGTERM")
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), graceMs)
  }
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, spec.timeoutMs)
  const onAbort = () => {
    aborted = true
    terminate()
  }
  signal.addEventListener("abort", onAbort, { once: true })

  const settle = (exit: Omit<PlannerExit, "stdout" | "stderr" | "timedOut" | "aborted" | "truncated">) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(killTimer)
    signal.removeEventListener("abort", onAbort)
    done.resolve({ ...exit, stdout: Buffer.concat(chunks).toString("utf8"), stderr, timedOut, aborted, truncated })
  }

  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length
    if (size > STDOUT_LIMIT) {
      if (!truncated) {
        truncated = true
        terminate()
      }
      return
    }
    chunks.push(chunk)
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP)
  })
  // The child may exit without reading stdin.
  child.stdin.on("error", () => undefined)
  child.stdin.end(spec.stdin)

  child.on("error", (error) => {
    if (child.pid) return
    settle({ code: null, signal: null, spawnError: error.message })
  })
  // Whatever the leader left behind (a `claude` still talking, a hung helper)
  // would otherwise hold stdout open and outlive the card.
  child.on("exit", () => signalGroup("SIGKILL"))
  child.on("close", (code, killedBy) => settle({ code, signal: killedBy }))
  return done.promise
}

export function createPlannerPool(options: { maxConcurrent: number; killGraceMs: number }): PlannerPool {
  const lifetime = new AbortController()
  const waiting: Array<{ grant: () => void; leave: () => void }> = []
  const inflight = new Set<Promise<PlannerExit>>()
  let running = 0

  async function acquire(signal: AbortSignal) {
    if (running < options.maxConcurrent) {
      running++
      return true
    }
    const slot = Promise.withResolvers<boolean>()
    const waiter = {
      grant: () => slot.resolve(true),
      leave: () => {
        const index = waiting.indexOf(waiter)
        if (index < 0) return
        waiting.splice(index, 1)
        slot.resolve(false)
      },
    }
    waiting.push(waiter)
    signal.addEventListener("abort", waiter.leave, { once: true })
    const granted = await slot.promise
    signal.removeEventListener("abort", waiter.leave)
    return granted
  }

  function release() {
    // The slot passes straight to the next waiter, so `running` only drops when nobody waits.
    const next = waiting.shift()
    if (next) next.grant()
    else running--
  }

  return {
    run(spec, signal) {
      const merged = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const flight = (async () => {
        if (merged.aborted || !(await acquire(merged))) return CANCELLED
        try {
          return await execute(spec, merged, options.killGraceMs)
        } finally {
          release()
        }
      })()
      inflight.add(flight)
      void flight.finally(() => inflight.delete(flight))
      return flight
    },
    async dispose() {
      lifetime.abort()
      await Promise.allSettled(inflight)
    },
  }
}

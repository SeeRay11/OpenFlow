import { spawn, type ChildProcess } from "node:child_process"

/**
 * Owns the `opencode serve` process, so the canvas can restart it.
 *
 * The server reads a project's config, agents, skills and MCP servers **once,
 * at boot**. Everything OpenFlow writes — a merged agent block, a new skill, an
 * MCP entry — is therefore invisible until the engine is restarted, and every
 * one of those flows currently ends in a note telling the user to go and do it
 * in a terminal. There is no shutdown route on the server (checked: nothing
 * under `packages/server/src/handlers`), so the only thing that can restart it
 * is whoever holds the process handle. That is this.
 *
 * Ownership is opt-in and never assumed: a host that did not spawn the engine
 * reports `managed: false` and the UI falls back to showing the command. The
 * one thing this must never do is start a second engine on a port that already
 * has one — see `supervisorFor`.
 */

export type ServeCommand = {
  /** argv, already split. Never a shell string — nothing here goes through a shell. */
  command: string[]
  cwd: string
  /** Base URL the engine is expected to answer on, e.g. `http://127.0.0.1:4096`. */
  url: string
}

export type ServeStatus = {
  /** True only when this process spawned the engine and can restart it. */
  managed: boolean
  /** True when the engine answers `/api/health`. */
  running: boolean
  url: string
  /** Printable form of the command, for the unmanaged fallback in the UI. */
  command: string
  /**
   * Directory the command has to run from — the from-source command is relative
   * (`--cwd packages/opencode`), so the UI prints `cd <cwd>` above it rather than
   * guessing a checkout name. Optional only because stand-in statuses in tests
   * predate it; both supervisors always set it.
   */
  cwd?: string
  pid?: number
  startedAt?: number
  /** Why the last start or restart failed, if it did. */
  error?: string
  /** Why this host is not managing the engine, when it is not. */
  reason?: string
}

export type Supervisor = {
  status: () => Promise<ServeStatus>
  /** Starts the engine if this host owns it and it is not already up. */
  ensure: () => Promise<ServeStatus>
  restart: () => Promise<ServeStatus>
  stop: () => Promise<void>
}

const START_TIMEOUT = 90_000
const STOP_TIMEOUT = 15_000
const POLL = 400

/**
 * Whether the engine answers.
 *
 * Bounded on purpose: a probe against a process that has just been killed can
 * land on a pooled connection that never answers and never errors, and an
 * unbounded probe would hang the restart it is supposed to be supervising.
 * `connection: close` keeps each probe on its own socket for the same reason.
 */
export async function healthy(url: string, timeout = 5_000) {
  return await fetch(new URL("/api/health", url), {
    signal: AbortSignal.timeout(timeout),
    headers: { connection: "close" },
  })
    .then((response) => response.ok)
    .catch(() => false)
}

function printable(command: string[]) {
  return command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Kills the engine and everything it spawned.
 *
 * `bun run …` execs a child that is the process actually holding the port, so
 * killing only the direct child leaves the port occupied and the next start
 * fails with EADDRINUSE. POSIX gets its own process group (`detached: true`)
 * and a group signal; Windows gets `taskkill /T`, which is the only reliable
 * way to take a tree there.
 */
async function killTree(child: ChildProcess) {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
      killer.on("exit", () => resolve())
      killer.on("error", () => resolve())
    })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {}
  }
}

/**
 * A supervisor that owns nothing.
 *
 * The honest answer for a host that proxies to an engine somebody else
 * started — the launcher script, another terminal, a preview manager. It still
 * reports whether the engine is up and what command would start it, which is
 * everything the UI's fallback needs.
 */
export function unmanaged(spec: ServeCommand, reason: string): Supervisor {
  const status = async (): Promise<ServeStatus> => ({
    managed: false,
    running: await healthy(spec.url),
    url: spec.url,
    command: printable(spec.command),
    cwd: spec.cwd,
    reason,
  })
  return {
    status,
    ensure: status,
    async restart() {
      throw new Error(
        `this OpenFlow host does not own \`opencode serve\` (${reason}) — restart it where it was started, with: ${printable(spec.command)}`,
      )
    },
    async stop() {},
  }
}

export function createSupervisor(spec: ServeCommand, log: (line: string) => void = () => {}): Supervisor {
  let child: ChildProcess | undefined
  let startedAt: number | undefined
  let lastError: string | undefined
  /** Serialises start/stop so two clicks cannot race into two engines. */
  let queue: Promise<unknown> = Promise.resolve()

  function serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  async function status(): Promise<ServeStatus> {
    return {
      managed: true,
      running: await healthy(spec.url),
      url: spec.url,
      command: printable(spec.command),
      cwd: spec.cwd,
      pid: child?.pid,
      startedAt,
      error: lastError,
    }
  }

  async function spawnEngine() {
    lastError = undefined
    const [file, ...args] = spec.command
    const next = spawn(file, args, {
      cwd: spec.cwd,
      env: process.env,
      stdio: "inherit",
      // POSIX: own process group, so `killTree` can take the whole thing.
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    child = next
    startedAt = Date.now()
    next.on("error", (error) => {
      lastError = error.message
    })
    next.on("exit", (code, signal) => {
      if (child === next) child = undefined
      if (code && code !== 0) lastError = `engine exited with code ${code}${signal ? ` (${signal})` : ""}`
    })

    const deadline = Date.now() + START_TIMEOUT
    while (Date.now() < deadline) {
      if (await healthy(spec.url)) return
      // A crash during boot must fail now rather than after the full timeout —
      // a bad command or a busy port is the usual cause and both are instant.
      if (next.exitCode !== null || next.signalCode !== null) {
        throw new Error(lastError ?? `engine exited during startup (code ${next.exitCode})`)
      }
      await wait(POLL)
    }
    throw new Error(`engine did not answer ${spec.url}/api/health within ${START_TIMEOUT / 1000}s`)
  }

  async function stopEngine() {
    const current = child
    if (!current) return
    await killTree(current)
    const deadline = Date.now() + STOP_TIMEOUT
    // Wait for the port to actually go quiet: respawning while the old process
    // still holds it is how a restart turns into a dead engine.
    while (Date.now() < deadline) {
      if (current.exitCode !== null || current.signalCode !== null) {
        if (!(await healthy(spec.url))) break
      }
      await wait(POLL)
    }
    if (child === current) child = undefined
  }

  return {
    status,
    ensure: () =>
      serialise(async () => {
        if (child && (await healthy(spec.url))) return status()
        if (!child && (await healthy(spec.url))) {
          // Something else is already serving this port. Never start a second.
          throw new Error(`something is already serving ${spec.url} — not starting a second engine`)
        }
        log(`starting engine: ${printable(spec.command)}`)
        await spawnEngine()
        return status()
      }),
    restart: () =>
      serialise(async () => {
        log("restarting engine")
        await stopEngine()
        if (await healthy(spec.url)) {
          throw new Error(
            `${spec.url} is still answering after the engine was stopped — something else owns that port`,
          )
        }
        await spawnEngine()
        log("engine restarted")
        return status()
      }),
    stop: () => serialise(stopEngine),
  }
}

/**
 * Picks a supervisor for this host.
 *
 * Management is opt-in (`FLOW_MANAGE_SERVER=1`) because the shipped launchers
 * and most people start the engine themselves, and adopting a process we did
 * not spawn is not something a browser click should be able to do. Even when
 * asked, an engine already answering the port is left alone: the button then
 * reports the command instead of restarting a process it has no handle on.
 */
export async function supervisorFor(
  spec: ServeCommand,
  env: Record<string, string | undefined> = process.env,
  log?: (line: string) => void,
): Promise<Supervisor> {
  if (env.FLOW_MANAGE_SERVER !== "1") {
    return unmanaged(spec, "it was started outside OpenFlow — set FLOW_MANAGE_SERVER=1 to let OpenFlow own it")
  }
  if (await healthy(spec.url)) {
    return unmanaged(spec, `an engine was already serving ${spec.url} before this host started`)
  }
  return createSupervisor(spec, log)
}

/**
 * The command that starts the engine for this checkout.
 *
 * Inside the repo the engine is run from source, the same way the launcher
 * scripts and `.claude/launch.json` do it. Anywhere else the packaged `opencode`
 * binary on PATH is the only thing that could work. `OPENCODE_SERVE_COMMAND`
 * overrides both — space-separated argv, no shell.
 */
export function serveCommand(input: {
  repo: string
  url: string
  hasSource: boolean
  env?: Record<string, string | undefined>
}): ServeCommand {
  const env = input.env ?? process.env
  const port = new URL(input.url).port || "4096"
  const override = env.OPENCODE_SERVE_COMMAND?.trim()
  if (override) return { command: override.split(/\s+/), cwd: input.repo, url: input.url }
  if (input.hasSource) {
    return {
      command: ["bun", "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "serve", "--port", port],
      cwd: input.repo,
      url: input.url,
    }
  }
  return { command: ["opencode", "serve", "--port", port], cwd: input.repo, url: input.url }
}

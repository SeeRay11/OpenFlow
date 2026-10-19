import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ChunkAssembler, JsonlDecoder } from "./frame"
import type { LaunchSpec, OmpExit, OmpFrame, OmpProcess, OmpRpcError, RpcErrorInfo } from "./rpc-types"

/**
 * The Omp RPC core: one `omp --mode rpc-ui` child, driven over JSONL stdio.
 *
 * Lifecycle the callers rely on:
 *  - the child leads its own process group (`detached`), so tool shells, MCP
 *    servers and background jobs it spawns die with it: the group is swept with
 *    SIGKILL the moment the leader exits, and again by a process-exit safety net;
 *  - stdout is drained to EOF even after stdin closed (omp exits only once its
 *    stdout is read), stderr only keeps a bounded tail;
 *  - nothing is ever left pending: a command settles on response, timeout,
 *    abort or process exit.
 *
 * Runs under Bun and Node alike, so `node:` APIs only.
 */

const STDERR_TAIL_CHARS = 8 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
/** After the process exits, stdout may still hold frames; a grandchild that inherited the pipe must not hold `exited` hostage. */
const STDOUT_DRAIN_MS = 2_000

/** Process-group leaders that have not exited yet: the safety net's work list. */
const live = new Set<number>()
let safetyNetInstalled = false

function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL", child?: ChildProcess) {
  if (process.platform === "win32") {
    // No process groups: taskkill walks the tree. Synchronous so it also finishes inside an `exit` handler.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    // ESRCH: the group is already gone, which is the goal.
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    try {
      child?.kill(signal)
    } catch {}
  }
}

function installSafetyNet() {
  if (safetyNetInstalled) return
  safetyNetInstalled = true
  process.once("exit", () => {
    for (const pid of live) signalGroup(pid, "SIGKILL")
  })
}

/** An `Error` carrying `.rpc`: what every failed command rejects with. */
export function rpcError(command: string, message: string, code?: string): OmpRpcError {
  const rpc: RpcErrorInfo = code === undefined ? { command, message } : { command, message, code }
  return Object.assign(new Error(message), { name: "OmpRpcError", rpc })
}

type Pending = {
  command: string
  box: PromiseWithResolvers<unknown>
  timer: NodeJS.Timeout | undefined
  detach: () => void
}

class RpcProcess implements OmpProcess {
  readonly ready: Promise<{ protocolVersion: number }>
  readonly exited: Promise<OmpExit>

  private readonly readyBox = Promise.withResolvers<{ protocolVersion: number }>()
  private readonly exitBox = Promise.withResolvers<OmpExit>()
  private readonly listeners = new Set<(frame: OmpFrame) => void>()
  private readonly pending = new Map<string, Pending>()
  private readonly decoder = new JsonlDecoder()
  private assembler = new ChunkAssembler()
  private readonly child: ChildProcess | undefined
  private stderrTail = ""
  private sequence = 0
  private started = false
  private finished = false
  private stdoutEnded = false
  private exitStatus: { code: number | null; signal: string | null } | undefined
  private drainTimer: NodeJS.Timeout | undefined
  private closing: Promise<void> | undefined

  constructor(spec: LaunchSpec) {
    this.ready = this.readyBox.promise
    this.exited = this.exitBox.promise
    // Whoever awaits `ready` gets the rejection; this only keeps an unobserved one from crashing the host.
    this.ready.catch(() => {})

    try {
      for (const file of spec.files) {
        mkdirSync(path.dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.content, { mode: 0o600 })
        // `mode` only applies to files this call creates.
        chmodSync(file.path, 0o600)
      }
      this.child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      this.appendStderr(error instanceof Error ? error.message : String(error))
      this.finish(null, null)
      return
    }

    const child = this.child
    const stdout = child.stdout
    const stderr = child.stderr
    const stdin = child.stdin
    if (!stdout || !stderr || !stdin) {
      this.appendStderr("omp was spawned without stdio pipes")
      this.finish(null, null)
      return
    }
    if (child.pid !== undefined) {
      installSafetyNet()
      live.add(child.pid)
    }

    stdin.on("error", () => {})
    stderr.setEncoding("utf8")
    stderr.on("data", (text: string) => this.appendStderr(text))
    stdout.on("data", (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) this.handle(frame)
    })
    stdout.on("end", () => {
      for (const frame of this.decoder.flush()) this.handle(frame)
      this.assembler.reset()
      this.stdoutEnded = true
      if (this.exitStatus) this.finish(this.exitStatus.code, this.exitStatus.signal)
    })
    child.on("error", (error) => {
      // `error` also reports failed kills; only a spawn that never produced a pid ends the process.
      if (child.pid !== undefined) return
      this.appendStderr(error.message)
      this.finish(null, null)
    })
    child.on("exit", (code, signal) => {
      this.exitStatus = { code, signal }
      if (child.pid !== undefined) {
        live.delete(child.pid)
        // Whatever the leader left running belongs to a session that no longer exists.
        if (process.platform !== "win32") signalGroup(child.pid, "SIGKILL")
      }
      if (this.stdoutEnded) {
        this.finish(code, signal)
        return
      }
      this.drainTimer = setTimeout(() => this.finish(code, signal), STDOUT_DRAIN_MS)
    })
  }

  get pid() {
    return this.child?.pid
  }

  command<T = unknown>(
    command: { type: string } & Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const name = command.type
    const box = Promise.withResolvers<unknown>()
    // The response `data` is whatever omp sent; `T` is the caller's claim about it, as with `fetch().json()`.
    const result = box.promise as Promise<T>
    if (this.finished || this.exitStatus) {
      box.reject(rpcError(name, `omp has exited; ${name} was not sent`, "exited"))
      return result
    }
    if (options.signal?.aborted) {
      box.reject(rpcError(name, `${name} aborted`, "aborted"))
      return result
    }

    const id = `c${++this.sequence}`
    const signal = options.signal
    const onAbort = () => this.reject(id, rpcError(name, `${name} aborted`, "aborted"))
    signal?.addEventListener("abort", onAbort, { once: true })
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => this.reject(id, rpcError(name, `${name} timed out after ${timeoutMs} ms`, "timeout")), timeoutMs)
        : undefined
    this.pending.set(id, { command: name, box, timer, detach: () => signal?.removeEventListener("abort", onAbort) })

    if (!this.write({ ...command, id })) this.reject(id, rpcError(name, `omp stdin is closed; ${name} was not sent`, "closed"))
    return result
  }

  onFrame(listener: (frame: OmpFrame) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  send(frame: Record<string, unknown>) {
    this.write(frame)
  }

  close(options: { graceMs?: number; killMs?: number } = {}) {
    this.closing ??= this.shutdown(options.graceMs ?? 5_000, options.killMs ?? 5_000)
    return this.closing
  }

  kill() {
    const pid = this.child?.pid
    if (pid === undefined || this.exitStatus) return
    signalGroup(pid, "SIGKILL", this.child)
  }

  private async shutdown(graceMs: number, killMs: number) {
    const pid = this.child?.pid
    if (!this.child || pid === undefined || this.finished) {
      await this.exited
      return
    }
    // EOF is omp's graceful stop: it finishes accepted work, disposes the session and exits 0.
    this.child.stdin?.end()
    if (await this.exitsWithin(graceMs)) return
    signalGroup(pid, "SIGTERM", this.child)
    if (await this.exitsWithin(killMs)) return
    signalGroup(pid, "SIGKILL", this.child)
    await this.exited
  }

  private async exitsWithin(ms: number) {
    const timeout = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => timeout.resolve(false), ms)
    try {
      return await Promise.race([this.exited.then(() => true), timeout.promise])
    } finally {
      clearTimeout(timer)
    }
  }

  private write(frame: Record<string, unknown>) {
    const stdin = this.child?.stdin
    if (!stdin || !stdin.writable || stdin.writableEnded) return false
    stdin.write(`${JSON.stringify(frame)}\n`)
    return true
  }

  private appendStderr(text: string) {
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS)
  }

  private handle(frame: OmpFrame) {
    if (frame.type !== "rpc_chunk") {
      this.dispatch(frame)
      return
    }
    const result = this.assembler.push(frame)
    if (!result) return
    if ("error" in result) {
      this.dispatch({ type: "parse_error", line: "", reason: result.error })
      return
    }
    this.dispatch(result.frame)
  }

  private dispatch(frame: OmpFrame) {
    if (frame.type === "response") {
      this.respond(frame)
      return
    }
    this.emit(frame)
    if (frame.type === "ready") this.begin(frame)
  }

  private respond(frame: OmpFrame) {
    const entry = typeof frame.id === "string" ? this.take(frame.id) : undefined
    // A response nobody waits for any more (timed out, aborted) or one without an id (omp's `parse` failure): nothing to settle.
    if (!entry) return
    if (frame.success === false) {
      const message = typeof frame.error === "string" ? frame.error : `${entry.command} failed`
      entry.box.reject(rpcError(entry.command, message, typeof frame.code === "string" ? frame.code : undefined))
      return
    }
    entry.box.resolve(frame.data)
  }

  private begin(ready: OmpFrame) {
    if (this.started) return
    this.started = true
    if (typeof ready.maxReassembledFrameBytes === "number") {
      this.assembler = new ChunkAssembler({ maxReassembledFrameBytes: ready.maxReassembledFrameBytes })
    }
    const versions = ready.supportedProtocolVersions
    if (!Array.isArray(versions) || !versions.includes(2)) {
      // Without v2, a frame over 1 MiB is elided or fails; the session layer decides what that means.
      this.emit({ type: "flow_protocol_v1" })
      this.readyBox.resolve({ protocolVersion: 1 })
      return
    }
    this.command<{ protocolVersion?: number } | undefined>({ type: "negotiate_protocol", protocolVersion: 2 }).then(
      (data) => this.readyBox.resolve({ protocolVersion: data?.protocolVersion ?? 2 }),
      (error) => this.readyBox.reject(error),
    )
  }

  private emit(frame: OmpFrame) {
    for (const listener of [...this.listeners]) {
      // One subscriber's bug must neither starve the others nor kill the reader.
      try {
        listener(frame)
      } catch {}
    }
  }

  private take(id: string) {
    const entry = this.pending.get(id)
    if (!entry) return undefined
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.detach()
    return entry
  }

  private reject(id: string, error: OmpRpcError) {
    this.take(id)?.box.reject(error)
  }

  private finish(code: number | null, signal: string | null) {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.drainTimer)
    const stderrTail = this.stderrTail.trimEnd()
    const status = signal ? ` (signal ${signal})` : code === null ? "" : ` (code ${code})`
    const lastLine = stderrTail.split("\n").at(-1)?.trim()
    // First, so the caller of `ready` sees the stderr line rather than the failed negotiation behind it.
    this.readyBox.reject(new Error(`omp exited before it was ready${status}${lastLine ? `: ${lastLine}` : ""}`))
    for (const id of [...this.pending.keys()]) {
      this.reject(id, rpcError(this.pending.get(id)?.command ?? "unknown", `omp exited before the command completed${status}`, "exited"))
    }
    this.child?.stdout?.destroy()
    this.child?.stderr?.destroy()
    this.exitBox.resolve({ code, signal, stderrTail })
  }
}

/**
 * Writes `spec.files`, spawns the child and returns its handle immediately.
 * Never throws: a file or spawn failure comes back as a process whose `ready`
 * rejects and whose `exited` resolves with the failure as its stderr tail.
 */
export function spawnOmp(spec: LaunchSpec): OmpProcess {
  return new RpcProcess(spec)
}

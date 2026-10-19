import { constants } from "node:os"
import { PTY_CLOSE, PTY_LIMITS, clampSize } from "../../shared/terminal"
import type { PtyInfo, PtyKind, PtyServerControl } from "../../shared/terminal"
import { HttpError } from "../host/respond"
import { Ring } from "./ring"
import { decodeClientFrame } from "./policy"
import type { SpawnPlan } from "./policy"

/**
 * The sessions: real PTYs, their scrollback, who is attached, and — above all —
 * making sure none outlives the host. No HTTP in here; `routes.ts` and the two
 * WebSocket transports sit on top.
 */

/** node-pty reports a signal as a number and Bun as a name; a signalled child has no exit code under Bun. */
export type PtyExit = { exitCode: number | null; signal?: number | string | null }

export type PtyProcess = {
  pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: PtyExit) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type PtySpawnOptions = { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess | Promise<PtyProcess>

/** One attached client, as the host sees it. The transports adapt a socket to this. */
export type PtySink = {
  text(data: string): void
  control(frame: PtyServerControl): void
  close(code: number, reason: string): void
  /** Bytes queued for the client and not yet flushed. */
  buffered(): number
}

export type PtyConnection = {
  /** One inbound WebSocket message: keystrokes or a control frame. */
  message(data: string | Uint8Array): void
  detach(): void
}

export type HostTuning = {
  maxSessions: number
  ringBytes: number
  exitedKept: number
  idleReapMs: number
  /** SIGHUP, then SIGKILL of the whole group this long after. */
  killGraceMs: number
  /** A sink with more than this queued is closed so it resumes from its cursor. */
  slowSinkBytes: number
}

const DEFAULTS: HostTuning = {
  maxSessions: PTY_LIMITS.maxSessions,
  ringBytes: PTY_LIMITS.ringBytes,
  exitedKept: PTY_LIMITS.exitedKept,
  idleReapMs: PTY_LIMITS.idleReapMs,
  killGraceMs: 2000,
  slowSinkBytes: 1024 * 1024,
}

/** Replay goes out in frames of this size, like upstream. */
const REPLAY_CHUNK = 64 * 1024

type Session = {
  info: PtyInfo
  proc: PtyProcess
  ring: Ring
  sinks: Set<PtySink>
  idle?: NodeJS.Timeout
  reaper?: NodeJS.Timeout
  done: PromiseWithResolvers<PtyInfo>
  subscriptions: { dispose(): void }[]
  /** Set once the group sweep (SIGHUP, then SIGKILL after the grace) is scheduled; resolves when it has run. */
  reaped?: PromiseWithResolvers<void>
}

function signalName(signal: number | string | null | undefined): string | null {
  if (typeof signal === "string") return signal
  if (!signal) return null
  for (const [name, value] of Object.entries(constants.signals)) if (value === signal) return name
  return String(signal)
}

/**
 * Signals the child's whole process group. node-pty's forkpty makes the child a
 * session leader, so its pgid is its pid and `-pid` reaches every backgrounded
 * grandchild. Falls back to the child alone (Windows has no groups). Pids that
 * could be a group of someone else (<= 1) are never signalled.
 */
function signalGroup(proc: PtyProcess, signal: "SIGHUP" | "SIGKILL", leaderGone = false) {
  if (!Number.isInteger(proc.pid) || proc.pid <= 1) return
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal)
      return
    } catch {}
  }
  // A leader that already exited has no pid worth signalling: it may belong to someone else by now.
  if (leaderGone) return
  try {
    proc.kill(signal)
  } catch {}
}

/** True while any member of the child's process group lives (the group id outlives the leader). */
function groupAlive(proc: PtyProcess) {
  if (!Number.isInteger(proc.pid) || proc.pid <= 1 || process.platform === "win32") return false
  try {
    process.kill(-proc.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export class TerminalHost {
  readonly #spawn: PtySpawn
  readonly #tuning: HostTuning
  readonly #sessions = new Map<string, Session>()
  /** Killed and forgotten, but possibly still dying: `dispose` waits for these too. */
  readonly #dying = new Set<Session>()
  #reserved = 0
  #disposed = false
  /** Creates awaiting their spawn: `dispose` waits for them so none leaves a live PTY behind. */
  readonly #starting = new Set<Promise<void>>()
  #hooks: { event: string; listener: () => void }[] = []

  constructor(spawn: PtySpawn, tuning: Partial<HostTuning> = {}) {
    this.#spawn = spawn
    this.#tuning = { ...DEFAULTS, ...tuning }
  }

  list(): PtyInfo[] {
    return [...this.#sessions.values()].map((session) => ({ ...session.info }))
  }

  info(id: string): PtyInfo | undefined {
    const session = this.#sessions.get(id)
    return session ? { ...session.info } : undefined
  }

  /** Resolves with the final info once the session's process has exited. */
  whenExited(id: string): Promise<PtyInfo> | undefined {
    return this.#sessions.get(id)?.done.promise
  }

  async create(kind: PtyKind, plan: SpawnPlan, size: { cols: number; rows: number }): Promise<PtyInfo> {
    if (this.#disposed) throw new HttpError(409, "the terminal host is shutting down", "disposed")
    const live = [...this.#sessions.values()].filter((session) => session.info.state === "running").length
    if (live + this.#reserved >= this.#tuning.maxSessions) {
      throw new HttpError(429, `at most ${this.#tuning.maxSessions} terminals can run at once`, "limit")
    }
    const { cols, rows } = clampSize(size.cols, size.rows)
    this.#reserved += 1
    const starting = Promise.withResolvers<void>()
    this.#starting.add(starting.promise)
    let proc: PtyProcess
    try {
      proc = await this.#spawn(plan.file, plan.args, { name: "xterm-256color", cols, rows, cwd: plan.cwd, env: plan.env })
    } catch (error) {
      throw new HttpError(500, `could not start the terminal: ${error instanceof Error ? error.message : "spawn failed"}`, "spawn-failed")
    } finally {
      this.#reserved -= 1
      this.#starting.delete(starting.promise)
      starting.resolve()
    }
    if (this.#disposed) {
      // Disposed while the spawn was in flight: nothing may outlive the host, and nobody holds this process yet.
      signalGroup(proc, "SIGKILL")
      throw new HttpError(409, "the terminal host is shutting down", "disposed")
    }
    this.#install()
    const info: PtyInfo = { id: crypto.randomUUID(), kind, pid: proc.pid, state: "running", cols, rows, createdAt: Date.now() }
    const session: Session = {
      info,
      proc,
      ring: new Ring(this.#tuning.ringBytes),
      sinks: new Set(),
      done: Promise.withResolvers<PtyInfo>(),
      subscriptions: [],
    }
    this.#sessions.set(info.id, session)
    session.subscriptions.push(
      proc.onData((chunk) => this.#output(session, chunk)),
      proc.onExit((event) => this.#exited(session, event)),
    )
    this.#watch(session)
    return { ...info }
  }

  /**
   * Replays what the client missed (from `cursor`; none for -1, all retained for
   * undefined), then a `{cursor}` control frame, then live output. An exited
   * session replays, reports its exit and closes. Replay and live output stay
   * ordered because nothing awaits between them.
   */
  attach(id: string, sink: PtySink, cursor?: number): PtyConnection | undefined {
    const session = this.#sessions.get(id)
    if (!session) return undefined
    const replay = session.ring.from(cursor)
    for (let at = 0; at < replay.text.length; ) {
      let end = Math.min(replay.text.length, at + REPLAY_CHUNK)
      // Never cut a surrogate pair across frames: each frame is UTF-8 on its own.
      if (end < replay.text.length && replay.text.charCodeAt(end - 1) >= 0xd800 && replay.text.charCodeAt(end - 1) <= 0xdbff) end += 1
      sink.text(replay.text.slice(at, end))
      at = end
    }
    sink.control({ cursor: replay.cursor })
    if (session.info.state === "exited") {
      sink.control({ exit: session.info.exit! })
      sink.close(PTY_CLOSE.normal, "exited")
      return { message() {}, detach() {} }
    }
    session.sinks.add(sink)
    clearTimeout(session.idle)
    return {
      message: (data) => {
        const frame = decodeClientFrame(data)
        if (!frame || session.info.state !== "running") return
        try {
          if ("input" in frame) {
            session.proc.write(frame.input)
            return
          }
          session.proc.resize(frame.resize.cols, frame.resize.rows)
          session.info.cols = frame.resize.cols
          session.info.rows = frame.resize.rows
        } catch {}
      },
      detach: () => {
        if (!session.sinks.delete(sink)) return
        this.#watch(session)
      },
    }
  }

  /** Kills the process group (if running) and forgets the session. False when there is no such session. */
  kill(id: string): boolean {
    const session = this.#sessions.get(id)
    if (!session) return false
    this.#sessions.delete(id)
    this.#terminate(session)
    return true
  }

  /**
   * Kills everything and waits for it to be gone. Idempotent; after it the host
   * creates nothing. Safe to call from a vite `close` and again from the wiring.
   */
  async dispose(): Promise<void> {
    this.#disposed = true
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    for (const session of sessions) this.#terminate(session)
    const bound = Promise.withResolvers<void>()
    const giveUp = setTimeout(bound.resolve, this.#tuning.killGraceMs + 3000)
    const settled = [...this.#starting, ...[...this.#dying].flatMap((session) => [session.done.promise, session.reaped!.promise])]
    await Promise.race([Promise.all(settled), bound.promise])
    clearTimeout(giveUp)
    this.#uninstall()
  }

  #output(session: Session, chunk: string) {
    session.ring.push(chunk)
    for (const sink of session.sinks) {
      try {
        // Backpressure: a client that cannot keep up is closed rather than fed
        // out of order or buffered without bound; it reconnects from its cursor.
        if (sink.buffered() > this.#tuning.slowSinkBytes) {
          session.sinks.delete(sink)
          sink.close(1013, "slow consumer")
          continue
        }
        sink.text(chunk)
      } catch {
        session.sinks.delete(sink)
      }
    }
  }

  #exited(session: Session, event: PtyExit) {
    if (session.info.state === "exited") return
    session.info.state = "exited"
    session.info.exit = { code: event.exitCode, signal: signalName(event.signal) }
    clearTimeout(session.idle)
    for (const subscription of session.subscriptions) subscription.dispose()
    for (const sink of session.sinks) {
      try {
        sink.control({ exit: session.info.exit })
        sink.close(PTY_CLOSE.normal, "exited")
      } catch {}
    }
    session.sinks.clear()
    session.done.resolve({ ...session.info })
    // The leader is gone; whatever it left in the group still gets the sweep (SIGHUP, grace, SIGKILL).
    if (groupAlive(session.proc)) this.#reap(session)
    else if (session.reaped) this.#finish(session)
    this.#trim()
  }

  /** Oldest exited sessions fall off so a long-lived host does not accumulate rings. */
  #trim() {
    const exited = [...this.#sessions.values()].filter((session) => session.info.state === "exited")
    for (const session of exited.slice(0, Math.max(0, exited.length - this.#tuning.exitedKept))) {
      this.#sessions.delete(session.info.id)
    }
  }

  /** Starts the idle clock for a running session nobody is attached to. */
  #watch(session: Session) {
    clearTimeout(session.idle)
    if (session.info.state !== "running" || session.sinks.size > 0) return
    session.idle = setTimeout(() => {
      if (session.sinks.size === 0 && this.#sessions.get(session.info.id) === session) this.kill(session.info.id)
    }, this.#tuning.idleReapMs)
    session.idle.unref?.()
  }

  /**
   * SIGHUP the group, then SIGKILL it after the grace period even if the leader
   * is already gone: a backgrounded grandchild that ignored the hangup is the
   * orphan this exists to prevent.
   */
  #terminate(session: Session) {
    clearTimeout(session.idle)
    for (const sink of session.sinks) {
      try {
        sink.close(PTY_CLOSE.gone, "session closed")
      } catch {}
    }
    session.sinks.clear()
    if (session.info.state === "exited" && !groupAlive(session.proc)) return
    this.#reap(session)
  }

  /**
   * Schedules the group sweep once: SIGHUP now, SIGKILL when the grace ends. It
   * is deliberately independent of the leader: the group id outlives a leader
   * that exited on the hangup while a child that ignored it keeps running.
   */
  #reap(session: Session) {
    if (session.reaped) return
    session.reaped = Promise.withResolvers<void>()
    this.#dying.add(session)
    signalGroup(session.proc, "SIGHUP", session.info.state === "exited")
    session.reaper = setTimeout(() => this.#finish(session), this.#tuning.killGraceMs)
    session.reaper.unref?.()
  }

  /** Ends the sweep: SIGKILL whatever is left of the group, whether or not the leader is still alive. */
  #finish(session: Session) {
    clearTimeout(session.reaper)
    signalGroup(session.proc, "SIGKILL", session.info.state === "exited")
    this.#dying.delete(session)
    session.reaped?.resolve()
  }

  /** Synchronous last resort for process exit: nothing can wait there. */
  #sweep = () => {
    for (const session of [...this.#sessions.values(), ...this.#dying]) {
      if (session.info.state === "running" || this.#dying.has(session)) signalGroup(session.proc, "SIGKILL", session.info.state === "exited")
    }
  }

  /**
   * Host-exit hooks, installed with the first session and removed at dispose.
   * A signal listener replaces the default "terminate", so when ours is the only
   * one the signal is re-raised after the sweep to keep Ctrl+C meaning Ctrl+C.
   */
  #install() {
    if (this.#hooks.length > 0) return
    const hook = (event: string, listener: () => void) => {
      process.on(event, listener)
      this.#hooks.push({ event, listener })
    }
    hook("exit", this.#sweep)
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const listener = () => {
        this.#sweep()
        process.off(signal, listener)
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
      }
      hook(signal, listener)
    }
  }

  #uninstall() {
    for (const { event, listener } of this.#hooks) process.off(event, listener)
    this.#hooks = []
  }
}

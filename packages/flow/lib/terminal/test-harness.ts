import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PtyServerControl } from "../../shared/terminal"
import type { PtySink } from "./host"
import type { SpawnPlan } from "./policy"

/**
 * Shared by the terminal's tests only: stub scripts in a tmp dir (run by a real
 * `/bin/sh` on a real PTY), a sink that records what a client would receive, and
 * the one bounded poll that exists because a grandchild's death is not an event.
 */

const dirs: string[] = []

export async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-pty-"))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]!
}

export async function cleanScratch() {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
}

/** A plan that runs `body` as a `/bin/sh` script in `dir`, with a minimal env. */
export async function stub(dir: string, body: string, name = "stub.sh"): Promise<SpawnPlan> {
  const file = path.join(dir, name)
  await fs.writeFile(file, body)
  return { file: "/bin/sh", args: [file], cwd: dir, project: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color" } }
}

export type Collector = PtySink & {
  // (text/control/close/buffered come from PtySink)
  output: string
  controls: PtyServerControl[]
  closed: { code: number; reason: string } | undefined
  /** Bytes the sink claims are queued; tests raise it to exercise backpressure. */
  queued: number
  /** Resolves once `predicate` holds, checked after every event; rejects on timeout so a hang names itself. */
  until(predicate: () => boolean, label: string, ms?: number): Promise<void>
  /** Where a reconnecting client resumes: the last `{cursor}` plus the text received since. */
  resume(): number
}

export function collector(): Collector {
  const waiting: { predicate: () => boolean; resolve: () => void }[] = []
  let sinceCursor = 0
  let base = 0
  const notify = () => {
    for (const entry of [...waiting]) {
      if (!entry.predicate()) continue
      waiting.splice(waiting.indexOf(entry), 1)
      entry.resolve()
    }
  }
  const self: Collector = {
    output: "",
    controls: [],
    closed: undefined,
    queued: 0,
    text(data) {
      self.output += data
      sinceCursor += data.length
      notify()
    },
    control(frame) {
      self.controls.push(frame)
      if ("cursor" in frame) {
        base = frame.cursor
        sinceCursor = 0
      }
      notify()
    },
    close(code, reason) {
      self.closed = { code, reason }
      notify()
    },
    buffered: () => self.queued,
    resume: () => base + sinceCursor,
    until(predicate, label, ms = 8000) {
      if (predicate()) return Promise.resolve()
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}; output so far: ${JSON.stringify(self.output.slice(-400))}`)), ms)
      waiting.push({ predicate, resolve: () => (clearTimeout(timer), resolve()) })
      return promise
    },
  }
  return self
}

/** The `{cursor}` frame a client gets right after replay. */
export function firstCursor(sink: Collector): number {
  for (const frame of sink.controls) if ("cursor" in frame) return frame.cursor
  throw new Error("no cursor frame received")
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Polls until `pid` is gone. Bounded: a non-child's exit raises no event to await. */
export async function goneWithin(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await Bun.sleep(20)
  }
  return !alive(pid)
}

/** A WebSocket client's receive side decoded the way the dock decodes it. */
export function decodeControl(bytes: Uint8Array): PtyServerControl {
  return JSON.parse(Buffer.from(bytes.subarray(1)).toString("utf8")) as PtyServerControl
}

export function resizeFrame(cols: number, rows: number): Uint8Array {
  return Uint8Array.from([0, ...Buffer.from(JSON.stringify({ t: "resize", cols, rows }))])
}

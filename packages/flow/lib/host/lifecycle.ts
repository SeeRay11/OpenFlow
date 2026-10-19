import type { ChildProcess } from "node:child_process"
import { HttpError } from "./respond"

/**
 * Teardown for a host module that spawns short-lived children (a probe, a CLI
 * call, a catalog read): a closed flag, the set of work in flight, and a
 * `dispose` that stops what is running and waits for it. Without it a child
 * outlives `dispose()` (the model catalog alone allows 60 s) and, under vite,
 * the next `configureServer` builds a second host beside the first.
 *
 * Runs under Bun and Node: `node:` APIs only.
 */

/** How long `dispose` waits for stopped work to be gone and settled: shutdown must never hang on a flight that ignores its kill. */
const SETTLE_MS = 10_000

export type Flight = {
  /**
   * Registers how to stop what this flight has started. `dispose` awaits what `stop` returns: return the child's exit to have it wait
   * for the process to be gone. Called at once when the lifecycle is already closed.
   */
  onClose(stop: () => unknown): void
}

export type Lifecycle = {
  readonly closed: boolean
  /** Throws the 503 every route can show as is, once the lifecycle is closed. */
  assertOpen(): void
  /** Runs `work` as a tracked flight; rejects with the 503 without starting it when closed. */
  run<T>(work: (flight: Flight) => Promise<T>): Promise<T>
  /** Closes, stops every flight in progress and waits for them to settle. Idempotent. */
  dispose(): Promise<void>
}

type Entry = { stops: Array<() => unknown>; settled: Promise<void> }

async function invoke(stop: () => unknown) {
  try {
    await stop()
  } catch {
    // Already gone.
  }
}

/** SIGKILL to the child's process group on POSIX (it must have been spawned detached), else to the child. */
export function killTree(child: ChildProcess) {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL")
      return
    } catch {
      // The group is already gone; fall back to the child itself.
    }
  }
  child.kill("SIGKILL")
}

export function createLifecycle(name: string): Lifecycle {
  const flights = new Set<Entry>()
  let closed = false
  let disposed: Promise<void> | undefined

  function assertOpen() {
    if (closed) throw new HttpError(503, `${name} is shutting down`, "host-closed")
  }

  return {
    get closed() {
      return closed
    },
    assertOpen,
    async run(work) {
      assertOpen()
      const entry: Entry = { stops: [], settled: Promise.resolve() }
      const flight: Flight = {
        onClose(stop) {
          if (closed) void invoke(stop)
          else entry.stops.push(stop)
        },
      }
      const promise = work(flight)
      entry.settled = promise.then(
        () => undefined,
        () => undefined,
      )
      flights.add(entry)
      try {
        return await promise
      } finally {
        flights.delete(entry)
      }
    },
    dispose() {
      closed = true
      disposed ??= (async () => {
        const all = [...flights]
        const gone = Promise.all(all.flatMap((entry) => entry.stops.map(invoke))).then(() => Promise.all(all.map((entry) => entry.settled)))
        const cap = Promise.withResolvers<void>()
        const timer = setTimeout(cap.resolve, SETTLE_MS)
        try {
          await Promise.race([gone, cap.promise])
        } finally {
          clearTimeout(timer)
        }
      })()
      return disposed
    },
  }
}

import type { PtyExit, PtyProcess, PtySpawn } from "./host"

/**
 * The PTY backend under Bun (`server.ts`), where `@lydell/node-pty` cannot be
 * used: its master fd is wrapped in a `net.Socket` that Bun reads without
 * polling, so the first read with no data ready fails with EAGAIN, the socket
 * closes, and the kernel hangs the child up — measured as a shell killed with
 * SIGHUP ~10 ms after spawn. `Bun.spawn({ terminal })` is Bun's own PTY: the
 * child is a session leader (pgid == pid, as with forkpty), so the host's
 * group kill works unchanged.
 *
 * Selected in `index.ts` by `"Bun" in globalThis`; under Node (the vite dev
 * host) `pty-node.ts` is used instead.
 */

/** How long after the leader exits we wait for the pty to reach EOF before reporting the exit anyway: a backgrounded grandchild can hold the slave open indefinitely. */
const DRAIN_MS = 250

export const spawnBunPty: PtySpawn = (file, args, options) => {
  const decoder = new TextDecoder()
  const dataListeners: ((data: string) => void)[] = []
  const exitListeners: ((event: PtyExit) => void)[] = []
  // Output that lands before the host has subscribed is held, not dropped.
  const early: string[] = []
  // Bun types `signalCode` as a number but reports the name at runtime; the host's `signalName` accepts either.
  let exit: PtyExit | undefined
  let reported = false
  let drained = false

  const report = () => {
    if (reported || !exit) return
    reported = true
    for (const listener of exitListeners) listener(exit)
    try {
      proc.terminal?.close()
    } catch {}
  }

  const proc = Bun.spawn([file, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      data(_terminal, chunk) {
        const text = decoder.decode(chunk, { stream: true })
        if (!text) return
        if (dataListeners.length === 0) early.push(text)
        for (const listener of dataListeners) listener(text)
      },
      exit() {
        drained = true
        report()
      },
    },
    onExit(_subprocess, exitCode, signalCode) {
      exit = { exitCode, signal: signalCode }
      if (drained) {
        report()
        return
      }
      setTimeout(report, DRAIN_MS).unref?.()
    },
  })

  const terminal = proc.terminal
  if (!terminal) throw new Error("this Bun build has no pseudo-terminal support")

  return {
    pid: proc.pid,
    onData(listener) {
      dataListeners.push(listener)
      for (const text of early.splice(0)) listener(text)
      return { dispose: () => void dataListeners.splice(dataListeners.indexOf(listener), 1) }
    },
    onExit(listener) {
      exitListeners.push(listener)
      return { dispose: () => void exitListeners.splice(exitListeners.indexOf(listener), 1) }
    },
    write: (data) => void terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: (signal) => proc.kill(signal as NodeJS.Signals | undefined),
  } satisfies PtyProcess
}

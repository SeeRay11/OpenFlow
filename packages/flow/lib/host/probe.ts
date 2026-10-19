import { spawn } from "node:child_process"
import { killTree, type Flight } from "./lifecycle"

/** A probe prints a version or nothing: past this the rest of its output is dropped. */
const OUTPUT_LIMIT = 64 * 1024

export type ProbeResult = { code: number | null; stdout: string }

/**
 * Runs a short-lived probe (`omp --version`, `python3 -c ...`) to completion with a deadline. It leads its own process group on POSIX, so the
 * deadline and a `flight` stop (the owner's `dispose`) kill a wrapper script's children with it. Rejects when the command cannot be started or
 * was killed; a command that ran and exited non-zero resolves with its code.
 *
 * Runs under Bun and Node: `node:` APIs only.
 */
export function runProbe(command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; flight?: Flight }): Promise<ProbeResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ProbeResult>()
  const child = spawn(command, args, { env: options.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
  let stdout = ""
  let settled = false
  const exited = Promise.withResolvers<void>()
  const timer = setTimeout(() => killTree(child), options.timeoutMs)
  // A stop by the owner waits for the process to be gone.
  options.flight?.onClose(() => {
    killTree(child)
    return exited.promise
  })
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk
  })
  child.on("error", (error) => {
    exited.resolve()
    if (settled) return
    settled = true
    clearTimeout(timer)
    reject(error)
  })
  child.on("close", (code, signal) => {
    exited.resolve()
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (code === null) reject(new Error(`${command} stopped on ${signal ?? "a signal"}`))
    else resolve({ code, stdout })
  })
  return promise
}

import type { PtySpawn } from "./host"

/**
 * The PTY backend under Node (the vite dev host): `@lydell/node-pty`, imported
 * dynamically on purpose. It is a platform-specific native addon, so a missing
 * prebuild must fail the first spawn with a message instead of breaking every
 * module that imports this file. macOS needs the prebuild's `spawn-helper`
 * executable and Windows uses ConPTY; neither is exercised here.
 *
 * Keep this file free of anything Node cannot strip-and-run (no enums, no
 * extensionless value imports): a test loads it in a real `node` process.
 */
export const spawnNodePty: PtySpawn = async (file, args, options) => {
  const pty = await import("@lydell/node-pty")
  const proc = pty.spawn(file, args, { ...options, ...(process.platform === "win32" ? { useConptyDll: true } : {}) })
  return {
    pid: proc.pid,
    onData: (listener) => proc.onData(listener),
    onExit: (listener) => proc.onExit(listener),
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: (signal) => proc.kill(signal),
  }
}

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** Same rule as `lib/last-session.ts`: OpenFlow's own state lives outside any project. */
export function stateDir(env: NodeJS.ProcessEnv = process.env) {
  return env.OPENFLOW_STATE_DIR || path.join(os.homedir(), ".openflow")
}

/**
 * Where one project's omp session state (cards, uplift, memory) lives:
 * `<stateDir>/omp/<12 hex of sha1(realpath(project))>`. Keyed by the real path
 * so a symlinked checkout and its target share state; a project that is gone
 * falls back to the resolved path rather than failing a read.
 */
export function stateRoot(project: string, env: NodeJS.ProcessEnv = process.env) {
  const resolved = path.resolve(project)
  let real = resolved
  try {
    real = realpathSync(resolved)
  } catch {
    // The folder may not exist yet; its resolved path is still a stable key.
  }
  return path.join(stateDir(env), "omp", createHash("sha1").update(real).digest("hex").slice(0, 12))
}

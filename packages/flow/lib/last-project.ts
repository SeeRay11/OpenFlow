import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * The project folder OpenFlow was last pointed at, remembered across restarts.
 *
 * Switching folders is a live, in-memory mutation of the shared `FlowPaths`
 * (see `setProjectPath` in `./store.ts`), which is what makes it take effect
 * with no server restart — and also what made it evaporate when the process
 * ended. A user who picked their repo once had to pick it again on every
 * launch, and the folder every card writes into is not something to re-choose
 * by memory.
 *
 * State lives outside the project on purpose: it describes the app, not the
 * repo, so it must not land in a folder the user might commit or delete.
 */
function stateDir() {
  return process.env.OPENFLOW_STATE_DIR || path.join(os.homedir(), ".openflow")
}

/**
 * Read per call rather than captured at import, so a test that points
 * `OPENFLOW_STATE_DIR` at a temp directory cannot be defeated by import order —
 * the alternative writes a developer's real `~/.openflow/state.json` from a
 * test run.
 */
export function statePath() {
  return path.join(stateDir(), "state.json")
}

/**
 * Records `project` as the folder to reopen next time.
 *
 * Deliberately best-effort: a read-only home directory is a reason to lose the
 * convenience, never a reason to fail the folder switch the user just asked
 * for.
 */
export function rememberProject(project: string) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify({ project: path.resolve(project) }, null, 2) + "\n")
    return true
  } catch {
    return false
  }
}

/** The remembered folder, or undefined when there is none or it is unreadable. */
export function recallProject(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"))
    const project = typeof parsed?.project === "string" ? parsed.project.trim() : ""
    return project || undefined
  } catch {
    return undefined
  }
}

/**
 * Which folder a host should boot into.
 *
 * Precedence is explicit instruction, then memory, then the fallback:
 *
 * 1. `OPENFLOW_PROJECT` — set by `openflow.ps1 -Project` / `openflow.sh
 *    --project`. Someone naming a folder on this launch means it, and it would
 *    be obtuse to override that with a folder they picked last week.
 * 2. the remembered folder, if it still exists. A folder that has since been
 *    moved or deleted is dropped rather than booting the app pointed at a path
 *    that is not there — every `/flow/api` route would fail in a way that reads
 *    as a broken app.
 * 3. `fallback` — the OpenFlow repo itself.
 */
export function resolveProject(fallback: string, env = process.env.OPENFLOW_PROJECT) {
  const named = env?.trim()
  if (named) return path.resolve(named)

  const remembered = recallProject()
  if (remembered && isDirectory(remembered)) return path.resolve(remembered)

  return path.resolve(fallback)
}

function isDirectory(target: string) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

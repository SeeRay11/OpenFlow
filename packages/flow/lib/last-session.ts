import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Where OpenFlow was left off: the project folder, and the pipeline that was
 * open in it.
 *
 * Both were live, in-memory state — a folder switch mutates the shared
 * `FlowPaths` (see `setProjectPath` in `./store.ts`), and the pipeline lived
 * only in the browser's store — which is what makes them take effect with no
 * server restart, and also what made them evaporate when the process ended.
 *
 * The pipeline is remembered *per project*, not globally: a name is only
 * meaningful inside the folder whose `.openflow/pipelines` holds it, and
 * carrying "feature-build" across a folder switch would try to open a pipeline
 * the new project has never heard of.
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
  return write((state) => ({ ...state, project: path.resolve(project) }))
}

/** The remembered folder, or undefined when there is none or it is unreadable. */
export function recallProject(): string | undefined {
  const project = read().project
  return typeof project === "string" && project.trim() ? project.trim() : undefined
}

/**
 * Records the pipeline open in `project`. An empty name forgets it, which is
 * what deleting the pipeline that was open has to do — otherwise the next
 * launch tries to open a file that is gone.
 */
export function rememberPipeline(project: string, name: string) {
  const key = path.resolve(project)
  return write((state) => {
    const pipelines: Record<string, string> = { ...(state.pipelines ?? {}) }
    if (name) pipelines[key] = name
    else delete pipelines[key]
    return { ...state, pipelines }
  })
}

/** The pipeline last open in `project`, if any. */
export function recallPipeline(project: string): string | undefined {
  const name = read().pipelines?.[path.resolve(project)]
  return typeof name === "string" && name.trim() ? name.trim() : undefined
}

type State = { project?: string; pipelines?: Record<string, string> }

/**
 * The state file, or `{}` when there is none.
 *
 * A file that will not parse is moved aside rather than read as empty. `read`
 * feeds `write`, so returning `{}` for a damaged file made the very next
 * remember persist that `{}` over it — one unparseable byte and every project's
 * remembered pipeline was gone. `.corrupt` keeps it where a user can look at
 * it.
 */
function read(): State {
  const file = statePath()
  if (!fs.existsSync(file)) return {}
  const parsed = parseState(file)
  if (parsed) return parsed
  quietly(() => fs.renameSync(file, `${file}.corrupt`))
  return {}
}

function parseState(file: string): State | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"))
    return value && typeof value === "object" ? (value as State) : undefined
  } catch {
    return undefined
  }
}

/**
 * Read-modify-write, so remembering a pipeline never drops the folder (or the
 * other way round) — the two are written by different routes at different
 * times.
 *
 * The new state lands on a temp file beside the real one and is renamed over
 * it, which is atomic within a directory on NTFS and on POSIX: a crash mid-save
 * then leaves the previous state rather than a truncated file, which `read`
 * cannot tell from "nothing was ever remembered".
 *
 * Deliberately best-effort: a read-only home directory is a reason to lose the
 * convenience, never a reason to fail the thing the user actually asked for.
 */
function write(update: (state: State) => State) {
  const file = statePath()
  const temp = `${file}.${process.pid.toString(36)}.tmp`
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify(update(read()), null, 2) + "\n")
    fs.renameSync(temp, file)
    return true
  } catch {
    quietly(() => fs.rmSync(temp, { force: true }))
    return false
  }
}

function quietly(work: () => void) {
  try {
    work()
  } catch {}
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

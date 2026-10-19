import fs from "node:fs/promises"
import path from "node:path"
import { asRecord, asString } from "./messages"
import { safeSegment } from "./session"

/** A run's state directory is kept for this long after the last write under it. */
export const STATE_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** The one directory of the state root that is not a run (the uplift planner's state). */
const UPLIFT_DIR = "uplift"
/** What the planner and the host write under it: stored results and the planner's per-session records. Anything else there is the planner's own. */
const UPLIFT_SUBDIRS = ["results", "sessions"]
const UPLIFT_FILE = /\.(json|xml)$/
/** The file the run listing keeps next to the logs (`lib/store.ts`). */
const RUNS_INDEX = ".index.json"

export type PruneOptions = {
  /** The project's state root: `<state>/omp/<hash>`. Run directories are its direct children. */
  root: string
  /** A run whose newest file is older than this goes. Default `STATE_RETENTION_DAYS`. */
  maxAgeMs?: number
  /** The clock. Default `Date.now`. */
  now?: () => number
  /**
   * Takes a run directory name (`safeSegment(runId)`) for its removal: undefined while the host holds a session or a start for it (it is never removed), else a release the
   * prune calls once the removal ends. While taken, the host makes a create for that run wait, so nothing starts into files being deleted.
   */
  claim(runDir: string): (() => void) | undefined
  /**
   * The project's run logs (`<project>/.openflow/runs`). A run whose log is still `running` is what the Resume button offers, so its state directory is kept
   * whatever its age. Read from the listing's index, best effort: an unreadable index keeps nothing extra.
   */
  runLogs?: string
}

export type PruneResult = {
  /** Names of the run directories removed. */
  removed: string[]
  /** Run directories (or the root itself) that could not be inspected or removed. */
  errors: number
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function lstatIfPresent(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

async function readdirIfPresent(dir: string) {
  try {
    return await fs.readdir(dir)
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

/** Newest mtime of `target` and everything under it. Symlinks count by their own mtime and are never entered; an unreadable entry throws rather than make the tree look older. */
async function newestIn(target: string): Promise<number> {
  const own = await lstatIfPresent(target)
  if (!own) return 0
  let newest = own.mtimeMs
  if (!own.isDirectory()) return newest
  for (const entry of await readdirIfPresent(target)) newest = Math.max(newest, await newestIn(path.join(target, entry)))
  return newest
}

/** What the host writes: a run directory holds only node directories. Anything else in it is somebody else's. */
async function onlyNodeDirectories(dir: string): Promise<boolean> {
  for (const entry of await readdirIfPresent(dir)) {
    const stat = await lstatIfPresent(path.join(dir, entry))
    if (stat && !stat.isDirectory()) return false
  }
  return true
}

/**
 * Lower-cased names of the run directories that belong to a run still marked `running`: the index names the logs (their file name is the lower-cased run id), and
 * each log names the real id the directory was made from (`safeSegment(log.id)`). Never throws.
 */
async function runningRuns(runLogs: string | undefined): Promise<Set<string>> {
  const keep = new Set<string>()
  if (!runLogs) return keep
  let index: unknown
  try {
    index = JSON.parse(await fs.readFile(path.join(runLogs, RUNS_INDEX), "utf8"))
  } catch {
    return keep
  }
  if (!Array.isArray(index)) return keep
  for (const row of index) {
    const entry = asRecord(row)
    const id = asString(entry?.id)
    if (!id || entry?.status !== "running" || path.basename(id) !== id) continue
    keep.add(id.toLowerCase())
    try {
      const log = asRecord(JSON.parse(await fs.readFile(path.join(runLogs, `${id}.json`), "utf8")))
      const runId = asString(log?.id)
      if (runId) keep.add(safeSegment(runId).toLowerCase())
    } catch {
      // The listing's id is still kept.
    }
  }
  return keep
}

async function pruneUpliftFile(file: string, cutoff: number, claim: PruneOptions["claim"]): Promise<void> {
  const stat = await lstatIfPresent(file)
  // lstat: a symlink is neither a file nor ours, and the removal never follows one.
  if (!stat?.isFile() || stat.mtimeMs >= cutoff) return
  // `results/<run>~<node>~<hash>.json` belongs to a run: one the host still holds keeps its result.
  const name = path.basename(file)
  const release = name.includes("~") ? claim(name.split("~")[0]) : () => undefined
  if (!release) return
  try {
    await fs.rm(file, { force: true })
  } finally {
    release()
  }
}

/** The uplift planner's results and session records older than the cutoff: files only, in directories that are real directories directly under the state root. Returns how many failed. */
async function pruneUplift(root: string, cutoff: number, claim: PruneOptions["claim"]): Promise<number> {
  let errors = 0
  const base = path.join(root, UPLIFT_DIR)
  for (const sub of UPLIFT_SUBDIRS) {
    try {
      const dir = path.join(base, sub)
      const stat = await lstatIfPresent(dir)
      if (!stat?.isDirectory()) continue
      const real = await fs.realpath(dir)
      if (real !== dir) continue
      for (const name of await readdirIfPresent(dir)) {
        if (!UPLIFT_FILE.test(name)) continue
        try {
          await pruneUpliftFile(path.join(dir, name), cutoff, claim)
        } catch {
          errors++
        }
      }
    } catch {
      errors++
    }
  }
  return errors
}

async function pruneRun(root: string, name: string, cutoff: number, claim: PruneOptions["claim"], running: Set<string>): Promise<boolean> {
  // The names the host writes: `<safeSegment(runId)>`. Dotfiles, `uplift` and anything else are not runs.
  if (name.startsWith(".") || name === UPLIFT_DIR || name !== safeSegment(name)) return false
  // An interrupted run is resumed from these files.
  if (running.has(name.toLowerCase())) return false
  const dir = path.join(root, name)
  const stat = await lstatIfPresent(dir)
  // lstat: a symlink at the root is neither a directory nor ours.
  if (!stat?.isDirectory()) return false
  if (!(await onlyNodeDirectories(dir))) return false
  if ((await newestIn(dir)) >= cutoff) return false
  const release = claim(name)
  if (!release) return false
  try {
    // A session may have started and ended during the scan above; what it wrote shows now, and no create can start until the claim is released.
    if ((await newestIn(dir)) >= cutoff) return false
    const real = await fs.realpath(dir).catch((error: unknown) => {
      if (missing(error)) return undefined
      throw error
    })
    if (!real) return false
    if (real !== dir || path.dirname(real) !== root) return false
    await fs.rm(real, { recursive: true, force: true })
    return true
  } finally {
    release()
  }
}

/**
 * Removes the run directories under a project's state root that nothing has
 * written to for `maxAgeMs`: the omp session files, overlay, role file and swarm
 * directory of every card in them, and the uplift planner's results and session
 * records of that age (files only). Skips a run the host holds, a run whose log is
 * still `running` (it can be resumed), dotfiles, files, symlinks and any run
 * directory holding something other than node directories. Never throws: a
 * failure on one run is counted and the next run is still considered. Safe next to
 * new sessions: a run is claimed from the host before its last check and held
 * across the removal, so a create for it waits and a run with a create in flight
 * is skipped.
 */
export async function pruneState(options: PruneOptions): Promise<PruneResult> {
  const result: PruneResult = { removed: [], errors: 0 }
  const now = options.now ?? Date.now
  const cutoff = now() - (options.maxAgeMs ?? STATE_RETENTION_DAYS * DAY_MS)
  try {
    const root = await fs.realpath(options.root).catch((error: unknown) => {
      if (missing(error)) return undefined
      throw error
    })
    if (!root) return result
    const running = await runningRuns(options.runLogs)
    for (const name of await readdirIfPresent(root)) {
      try {
        if (await pruneRun(root, name, cutoff, options.claim, running)) result.removed.push(name)
      } catch {
        result.errors++
      }
    }
    result.errors += await pruneUplift(root, cutoff, options.claim)
  } catch {
    result.errors++
  }
  return result
}

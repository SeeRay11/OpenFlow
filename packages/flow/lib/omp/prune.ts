import fs from "node:fs/promises"
import path from "node:path"
import { safeSegment } from "./session"

/** A run's state directory is kept for this long after the last write under it. */
export const STATE_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** The one directory of the state root that is not a run (the uplift planner's state). */
const UPLIFT_DIR = "uplift"

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

async function pruneRun(root: string, name: string, cutoff: number, claim: PruneOptions["claim"]): Promise<boolean> {
  // The names the host writes: `<safeSegment(runId)>`. Dotfiles, `uplift` and anything else are not runs.
  if (name.startsWith(".") || name === UPLIFT_DIR || name !== safeSegment(name)) return false
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
 * directory of every card in them. Skips a run the host holds, the `uplift`
 * directory, dotfiles, files, symlinks and any run directory holding something
 * other than node directories. Never throws: a failure on one run is counted
 * and the next run is still considered. Safe next to new sessions: a run is
 * claimed from the host before its last check and held across the removal, so
 * a create for it waits and a run with a create in flight is skipped.
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
    for (const name of await readdirIfPresent(root)) {
      try {
        if (await pruneRun(root, name, cutoff, options.claim)) result.removed.push(name)
      } catch {
        result.errors++
      }
    }
  } catch {
    result.errors++
  }
  return result
}

import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * How many lines a run changed, measured off the working tree rather than
 * asked of the model.
 *
 * A card reports what it did in prose, and prose is the one thing a card is
 * always able to produce whether or not it did the work — the whole reason
 * `runTurn` stopped settling `done` on an idle session. Lines added and
 * removed are the opposite kind of evidence: they exist on disk, they are the
 * same number whoever reads them, and they are already what a reviewer looks
 * at first.
 *
 * Git is the only thing here that can produce them. That means a project which
 * is not a repository measures nothing at all — reported as unknown, never as
 * zero, for the same reason an unpriced model is never rendered as free.
 */

/** One file's line delta. `binary` files have counts git will not give, and carry none. */
export type FileStat = { path: string; added: number; removed: number; binary?: boolean }

async function git(cwd: string, args: string[]) {
  return run("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
}

/**
 * `git --numstat` output, parsed.
 *
 * Binary files are printed as `-\t-\t<path>`, and a rename as
 * `<added>\t<removed>\t<old> => <new>` (or with a shared prefix in braces,
 * which `-z` would avoid but only by making every caller read NUL-separated
 * records). Both are kept rather than dropped: a card that renamed a file did
 * change it, and a run reporting no files while the tree moved would be the
 * misleading half of "measured, not asked".
 */
export function parseNumstat(stdout: string): FileStat[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [added, removed, ...rest] = line.split("\t")
      const file = rest.join("\t")
      if (!file) return []
      const binary = added === "-" || removed === "-"
      return [
        {
          path: renamedTo(file),
          added: binary ? 0 : Number(added) || 0,
          removed: binary ? 0 : Number(removed) || 0,
          ...(binary ? { binary: true } : {}),
        },
      ]
    })
}

/** `src/{a => b}/x.ts` and `a.ts => b.ts` both name the file as it exists now. */
function renamedTo(file: string) {
  const braced = file.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\//g, "/")
  const plain = file.split(" => ")
  return plain.length === 2 ? plain[1] : file
}

/**
 * Everything the working tree currently has that `HEAD` does not.
 *
 * Two sources, because git only volunteers one of them. `diff HEAD` covers
 * every tracked file, staged or not. Untracked files are not in any diff at
 * all, and they are most of what a card that writes new source produces — so
 * they are counted directly, every line an addition, which is exactly what
 * they would become on the commit that adds them.
 *
 * The snapshot is a measurement of a moment, and only becomes a card's work
 * when subtracted from another one taken before it ran (`deltaOf` in
 * `src/graph/diff.ts`, where the arithmetic is pure and the engine can run it).
 * Returns
 * undefined when the directory is not a repository: nothing here can be
 * measured then, and an empty snapshot would subtract to a confident zero.
 */
export async function treeStat(dir: string): Promise<FileStat[] | undefined> {
  const tracked = await git(dir, ["diff", "--numstat", "HEAD"])
    .then(({ stdout }) => parseNumstat(stdout))
    .catch(() => undefined)
  if (!tracked) return undefined
  const others = await git(dir, ["ls-files", "--others", "--exclude-standard"])
    .then(({ stdout }) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .catch(() => [] as string[])
  const untracked = await Promise.all(others.map((file) => countLines(dir, file)))
  return [...tracked, ...untracked.filter((entry): entry is FileStat => !!entry)]
}

/**
 * An untracked file's lines.
 *
 * Capped, and a file over the cap is recorded as binary — present, changed,
 * with no line count — rather than read into memory. A card that drops a
 * 40MB fixture into the tree should not cost the measurement more than the
 * write cost.
 */
const MAX_COUNTED = 2 * 1024 * 1024

async function countLines(dir: string, file: string): Promise<FileStat | undefined> {
  const full = path.join(dir, file)
  const size = await fs
    .stat(full)
    .then((entry) => (entry.isFile() ? entry.size : -1))
    .catch(() => -1)
  if (size < 0) return undefined
  if (size > MAX_COUNTED) return { path: file, added: 0, removed: 0, binary: true }
  const text = await fs.readFile(full, "utf8").catch(() => undefined)
  if (text === undefined) return { path: file, added: 0, removed: 0, binary: true }
  if (!text.length) return { path: file, added: 0, removed: 0 }
  // A trailing newline ends the last line rather than starting another, which
  // is how git counts it too.
  return { path: file, added: text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length, removed: 0 }
}

/** The line counts a worktree's card produced, straight from its own branch. */
export async function treeDiff(directory: string, base: string): Promise<FileStat[] | undefined> {
  return git(directory, ["diff", "--numstat", base, "HEAD"])
    .then(({ stdout }) => parseNumstat(stdout))
    .catch(() => undefined)
}

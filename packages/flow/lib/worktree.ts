import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * A working copy per card, so a batch cannot overwrite itself.
 *
 * Nothing in this fork locks a file, and an orchestrator dispatches a batch at
 * once: two cards told to touch the same file both succeed, the later write
 * wins, and the card whose work went under still reports success.
 * `graph/collisions.ts` can only say so afterwards, because by then there is
 * one tree and one version of the file in it.
 *
 * Giving each card its own `git worktree` is what turns that into something
 * recoverable: both writes exist, on their own branch, and the merge back is
 * where the two are reconciled — a conflict there is a question the
 * orchestrator can be asked, rather than work that is simply gone.
 *
 * This is reachable because a v2 session records its own location: measured
 * 2026-09-03, a session created with `location: { directory: <worktree> }` ran
 * its `bash` tool in that worktree and not in the engine's cwd. FLOW.md's older
 * note that a session's location is always the engine's cwd describes which
 * *config* a drain reads, not where its tools run.
 */

/** Where a run's trees live: outside the project, so the repo gains no untracked directories. */
export function worktreeRoot(runID: string) {
  return path.join(os.tmpdir(), "openflow-worktrees", slugID(runID))
}

/** Branch names are namespaced so a run's leftovers are always recognisable as ours. */
function branchName(runID: string, card: string) {
  return `openflow/${slugID(runID)}/${slugID(card)}`
}

function slugID(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)
}

async function git(cwd: string, args: string[]) {
  return run("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
}

/** Whether this directory is inside a git working tree — the one precondition for any of this. */
export async function isRepo(dir: string) {
  return git(dir, ["rev-parse", "--is-inside-work-tree"])
    .then(({ stdout }) => stdout.trim() === "true")
    .catch(() => false)
}

/**
 * A commit holding everything the project currently has, committed or not.
 *
 * `git worktree add` branches from a commit, and the obvious commit — `HEAD` —
 * is the wrong one: a user with uncommitted work would hand every card a tree
 * that does not contain it, and the cards would edit files that look nothing
 * like the ones on screen. `git stash create` writes exactly this commit and
 * does **not** touch the working tree or the stash list, which is what makes it
 * usable here. It prints nothing when the tree is clean, and then `HEAD` is
 * genuinely the right base.
 *
 * Untracked files are not in it. `stash create` has no `--include-untracked`,
 * and a card is given the repo as git understands it.
 */
export async function baseCommit(dir: string) {
  const stashed = await git(dir, ["stash", "create"]).then(({ stdout }) => stdout.trim()).catch(() => "")
  if (stashed) return stashed
  return git(dir, ["rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim())
}

export type OpenedTree = { card: string; directory: string; branch: string }
export type OpenResult =
  | { enabled: true; base: string; trees: OpenedTree[] }
  | { enabled: false; reason: string }

/**
 * One worktree per card, all branched from the same base.
 *
 * A card already holding a tree from an earlier batch keeps it: a session's
 * location is fixed when the session is created, and a re-dispatched card is
 * deliberately prompted into the session it already has, so moving its
 * directory underneath it would point the run at a tree the model cannot see.
 *
 * `node_modules` is linked rather than copied. A fresh worktree has none, and a
 * card that runs the project's tests — which is most of what a gauntlet critic
 * does — would otherwise install from scratch or simply fail. The link makes
 * that one directory shared again, which is a real hole in the isolation and
 * the reason installs stay a collision worth reporting.
 */
export async function openWorktrees(project: string, runID: string, cards: string[]): Promise<OpenResult> {
  if (!(await isRepo(project))) return { enabled: false, reason: "the project is not a git repository" }
  const base = await baseCommit(project).catch(() => "")
  if (!base) return { enabled: false, reason: "the project has no commits to branch a worktree from" }

  const root = worktreeRoot(runID)
  await fs.mkdir(root, { recursive: true })
  const trees: OpenedTree[] = []
  for (const card of cards) {
    const directory = path.join(root, slugID(card))
    const branch = branchName(runID, card)
    // Already open from an earlier batch — the card's session is pointed at it.
    if (await fs.stat(directory).then(() => true).catch(() => false)) {
      trees.push({ card, directory, branch })
      continue
    }
    // `-B` so a leftover branch from an interrupted run is reused rather than
    // failing the whole batch on a name that is ours anyway.
    const added = await git(project, ["worktree", "add", "--detach", directory, base])
      .then(() => git(directory, ["checkout", "-B", branch]))
      .then(() => true)
      .catch(() => false)
    if (!added) continue
    await linkModules(project, directory)
    trees.push({ card, directory, branch })
  }
  if (!trees.length) return { enabled: false, reason: "no worktree could be created" }
  return { enabled: true, base, trees }
}

/** Best-effort: a project without `node_modules`, or a host that refuses links, just runs without it. */
async function linkModules(project: string, directory: string) {
  const source = path.join(project, "node_modules")
  if (!(await fs.stat(source).then((s) => s.isDirectory()).catch(() => false))) return
  await fs
    .symlink(source, path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir")
    .catch(() => {})
}

export type MergeReport = {
  /** Cards whose work landed in the project's working tree. */
  merged: string[]
  /** Cards that changed nothing — a reader, or one that only ran commands. */
  empty: string[]
  /** Paths that could not be applied over what is already there, by card. */
  conflicts: { card: string; paths: string[] }[]
}

/**
 * Folds each card's work back into the project's working tree.
 *
 * A plain `git merge` is not available: the project's tree is usually dirty —
 * that is the whole reason `baseCommit` exists — and merge refuses to run over
 * uncommitted changes. So each card's diff against the shared base is applied
 * instead.
 *
 * Every apply is a `--check` first. `--3way` would resolve more patches, but it
 * needs the index and, when it cannot resolve one, it writes conflict markers
 * into the file and leaves it staged — turning a report into damage to a file
 * the user may have open. Checking first means a patch that will not apply
 * changes nothing at all, which is what makes "left untouched and named" true
 * rather than aspirational. The cost is the patches a three-way merge would
 * have salvaged; those are reported as conflicts instead.
 *
 * The whole diff is tried first, and only if that fails is it retried file by
 * file. That ordering matters: a single failing path must not cost a card the
 * eleven files that were fine, and applying per-file from the start would lose
 * the atomicity for the common case where everything applies. What still does
 * not apply is left **untouched** and named in the report, and nothing another
 * card wrote is reverted to make room.
 */
export async function mergeWorktrees(project: string, trees: OpenedTree[], base: string): Promise<MergeReport> {
  const report: MergeReport = { merged: [], empty: [], conflicts: [] }
  for (const tree of trees) {
    const changed = await commitTree(tree.directory)
    if (!changed) {
      report.empty.push(tree.card)
      continue
    }
    const patch = await git(tree.directory, ["diff", "--binary", base, "HEAD"]).then(({ stdout }) => stdout).catch(() => "")
    if (!patch.trim()) {
      report.empty.push(tree.card)
      continue
    }
    if (await apply(project, patch)) {
      report.merged.push(tree.card)
      continue
    }
    const paths = await changedPaths(tree.directory, base)
    const failed: string[] = []
    for (const file of paths) {
      const single = await git(tree.directory, ["diff", "--binary", base, "HEAD", "--", file])
        .then(({ stdout }) => stdout)
        .catch(() => "")
      if (!single.trim()) continue
      if (!(await apply(project, single))) failed.push(file)
    }
    if (failed.length === paths.length) report.conflicts.push({ card: tree.card, paths: failed })
    else {
      report.merged.push(tree.card)
      if (failed.length) report.conflicts.push({ card: tree.card, paths: failed })
    }
  }
  return report
}

/** Commits everything the card left behind, so its work is one reviewable diff. Returns false for a card that changed nothing. */
async function commitTree(directory: string) {
  await git(directory, ["add", "-A"]).catch(() => {})
  const staged = await git(directory, ["diff", "--cached", "--name-only"]).then(({ stdout }) => stdout.trim()).catch(() => "")
  if (!staged) return false
  // Identity is set on the command rather than the repo: the user's own
  // `user.name` may be unset globally, and a worktree commit must not be the
  // thing that fails a run.
  await git(directory, [
    "-c",
    "user.email=openflow@localhost",
    "-c",
    "user.name=OpenFlow",
    "commit",
    "--no-verify",
    "-qm",
    "openflow card work",
  ]).catch(() => {})
  return true
}

async function changedPaths(directory: string, base: string) {
  return git(directory, ["diff", "--name-only", base, "HEAD"])
    .then(({ stdout }) => stdout.split("\n").map((line) => line.trim()).filter(Boolean))
    .catch(() => [] as string[])
}

/** Checked before it is run, so a patch that will not apply leaves the tree exactly as it was. */
async function apply(project: string, patch: string) {
  const file = path.join(os.tmpdir(), `openflow-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.diff`)
  await fs.writeFile(file, patch, "utf8")
  const ok = await git(project, ["apply", "--check", "--whitespace=nowarn", file])
    .then(() => git(project, ["apply", "--whitespace=nowarn", file]))
    .then(() => true)
    .catch(() => false)
  await fs.rm(file).catch(() => {})
  return ok
}

/**
 * Removes a run's trees and the branches behind them.
 *
 * Deliberately keeps nothing: the work is already in the project's working tree
 * (or named in a conflict report the orchestrator was given), and a stack of
 * `openflow/*` branches nobody reads is just litter in the user's repository.
 */
export async function cleanupWorktrees(project: string, runID: string, trees: OpenedTree[]) {
  for (const tree of trees) {
    await git(project, ["worktree", "remove", "--force", tree.directory]).catch(() => {})
    await git(project, ["branch", "-D", tree.branch]).catch(() => {})
  }
  await git(project, ["worktree", "prune"]).catch(() => {})
  await fs.rm(worktreeRoot(runID), { recursive: true, force: true }).catch(() => {})
}

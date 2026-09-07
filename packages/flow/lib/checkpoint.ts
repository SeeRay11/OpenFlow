import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * A commit of the working tree after every round, so a run that gets worse can
 * be got back from.
 *
 * A gauntlet ends on whatever its last round left, and its last round is not
 * reliably its best one: a builder given one more turn than the work needed
 * will spend it, and the critic that was going to catch that is the card the
 * run stops to ask. Before this there was no way back — the rounds overwrote
 * each other in one working directory and only the final state survived.
 *
 * What this does *not* do is restore anything by itself. The project's tree is
 * usually dirty and often open in an editor, and an engine that rewrites it
 * because a number went down is a worse failure than the one it is fixing. So
 * each round is committed and left under a ref, and moving the tree back is a
 * `git` command the user runs when they have looked at it — the same rule the
 * merge path follows in refusing `--3way`.
 */

/** Where a run's rounds live. Namespaced so a repository's own refs are never touched. */
export function checkpointRef(runID: string, round: number) {
  return `refs/openflow/${slug(runID)}/round-${round}`
}

function slug(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return run("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: env ?? process.env })
}

/**
 * Commits everything the working tree currently holds, without touching it.
 *
 * `git stash create` is the obvious tool and the wrong one here: it does not
 * include untracked files, and new files are most of what a builder produces —
 * a checkpoint missing them would restore to a tree with the edits and none of
 * the new modules. So the commit is built through a **temporary index**:
 * `add -A` against `GIT_INDEX_FILE` stages the whole tree (still honouring
 * `.gitignore`), `write-tree` turns that into a tree object, and `commit-tree`
 * makes a commit with the current `HEAD` as its parent. The user's own index,
 * `HEAD`, and working tree are all untouched — nothing here is a state change
 * anybody can see except the new ref.
 *
 * Returns the commit, or undefined when there is nothing to commit against: a
 * directory that is not a repository, or one with no commits yet.
 */
export async function checkpoint(project: string, runID: string, round: number) {
  const head = await git(project, ["rev-parse", "HEAD"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "")
  if (!head) return undefined

  const index = path.join(os.tmpdir(), `openflow-index-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  const commit = await git(project, ["add", "-A"], env)
    .then(() => git(project, ["write-tree"], env))
    .then(({ stdout }) =>
      git(
        project,
        [
          "-c",
          "user.email=openflow@localhost",
          "-c",
          "user.name=OpenFlow",
          "commit-tree",
          stdout.trim(),
          "-p",
          head,
          "-m",
          `openflow ${runID} round ${round}`,
        ],
        env,
      ),
    )
    .then(({ stdout }) => stdout.trim())
    .catch(() => "")
  await fs.rm(index, { force: true }).catch(() => {})
  if (!commit) return undefined

  const ref = checkpointRef(runID, round)
  const written = await git(project, ["update-ref", ref, commit])
    .then(() => true)
    .catch(() => false)
  // The commit exists either way; without the ref it is unreachable and will be
  // collected, so a checkpoint that could not be anchored is not offered as one.
  return written ? { ref, commit } : undefined
}

/**
 * Drops a run's checkpoints.
 *
 * Called when the run's recording is deleted, not when the run ends: the whole
 * value of a checkpoint is that it outlives the run that made it. Deleting the
 * log is the moment the user has said they are finished with that run, and
 * leaving a repository full of `refs/openflow/*` nobody can name any more is
 * litter of exactly the kind `cleanupWorktrees` exists to avoid.
 */
export async function dropCheckpoints(project: string, runID: string) {
  const prefix = `refs/openflow/${slug(runID)}/`
  const refs = await git(project, ["for-each-ref", "--format=%(refname)", prefix])
    .then(({ stdout }) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .catch(() => [] as string[])
  for (const ref of refs) await git(project, ["update-ref", "-d", ref]).catch(() => {})
  return refs.length
}

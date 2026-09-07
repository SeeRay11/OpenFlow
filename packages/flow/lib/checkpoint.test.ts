import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { checkpoint, checkpointRef, dropCheckpoints } from "./checkpoint"

const exec = promisify(execFile)

/**
 * Checkpoints are git objects, so these run against a real repository. The
 * assertions that matter are about what the user's tree looks like afterwards,
 * which a mock could not tell us anything about.
 */

let dir: string
const runID = "run-checkpoint"

async function git(args: string[], cwd = dir) {
  return exec("git", args, { cwd, windowsHide: true })
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-cp-"))
  await git(["init", "-q"])
  await git(["config", "user.email", "t@t"])
  await git(["config", "user.name", "t"])
  await git(["config", "core.autocrlf", "false"])
  await fs.writeFile(path.join(dir, "a.txt"), "one\n")
  await git(["add", "-A"])
  await git(["commit", "-qm", "init"])
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe("checkpoint", () => {
  test("captures edited and untracked files alike", async () => {
    // `git stash create` would have missed `new.ts` entirely, and new files are
    // most of what a builder produces.
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n")
    await fs.writeFile(path.join(dir, "new.ts"), "export const x = 1\n")
    const made = await checkpoint(dir, runID, 1)

    expect(made?.ref).toBe(checkpointRef(runID, 1))
    const listed = (await git(["ls-tree", "-r", "--name-only", made!.commit])).stdout.split("\n").map((l) => l.trim())
    expect(listed).toContain("a.txt")
    expect(listed).toContain("new.ts")
  })

  test("leaves the working tree, the index and HEAD exactly as they were", async () => {
    // The whole point: this runs mid-run, in a directory the user may have open.
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n")
    await fs.writeFile(path.join(dir, "new.ts"), "x\n")
    const headBefore = (await git(["rev-parse", "HEAD"])).stdout.trim()
    const statusBefore = (await git(["status", "--porcelain"])).stdout

    await checkpoint(dir, runID, 1)

    expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore)
    expect((await git(["status", "--porcelain"])).stdout).toBe(statusBefore)
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("one\ntwo\n")
  })

  test("an ignored file stays out of it", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), "junk/\n")
    await fs.mkdir(path.join(dir, "junk"))
    await fs.writeFile(path.join(dir, "junk", "big.bin"), "x")
    const made = await checkpoint(dir, runID, 1)

    expect((await git(["ls-tree", "-r", "--name-only", made!.commit])).stdout).not.toContain("big.bin")
  })

  test("a round can be read back and restored by hand", async () => {
    // The recovery this exists for, done the way a user would do it: the engine
    // never moves the tree itself.
    await fs.writeFile(path.join(dir, "a.txt"), "the good version\n")
    const good = await checkpoint(dir, runID, 1)
    await fs.writeFile(path.join(dir, "a.txt"), "the round that made it worse\n")
    await checkpoint(dir, runID, 2)

    await git(["restore", "--source", good!.ref, "--worktree", "a.txt"])
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("the good version\n")
  })

  test("consecutive rounds get their own refs", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "two\n")
    const first = await checkpoint(dir, runID, 1)
    await fs.writeFile(path.join(dir, "a.txt"), "three\n")
    const second = await checkpoint(dir, runID, 2)

    expect(first!.commit).not.toBe(second!.commit)
    expect(
      (await git(["for-each-ref", "--format=%(refname)", `refs/openflow/${runID}/`])).stdout.trim().split("\n"),
    ).toHaveLength(2)
  })

  test("a directory that is not a repository checkpoints nothing", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-plain-"))
    expect(await checkpoint(plain, runID, 1)).toBeUndefined()
    await fs.rm(plain, { recursive: true, force: true })
  })
})

describe("dropCheckpoints", () => {
  test("removes this run's refs and nothing else", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "two\n")
    await checkpoint(dir, runID, 1)
    await checkpoint(dir, "another-run", 1)

    expect(await dropCheckpoints(dir, runID)).toBe(1)
    const left = (await git(["for-each-ref", "--format=%(refname)", "refs/openflow/"])).stdout.trim()
    expect(left).toContain("another-run")
    expect(left).not.toContain(`${runID}/`)
  })
})

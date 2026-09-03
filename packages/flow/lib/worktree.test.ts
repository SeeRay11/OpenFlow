import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { baseCommit, cleanupWorktrees, isRepo, mergeWorktrees, openWorktrees, worktreeRoot } from "./worktree"

const run = promisify(execFile)

/**
 * Worktrees are git's behaviour, not ours, so these run against real
 * repositories in a temp directory. Mocking git here would only assert that the
 * arguments were spelled the way the test spells them.
 */

let dir: string
let runID: string

async function git(args: string[], cwd = dir) {
  return run("git", args, { cwd, windowsHide: true })
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-wt-"))
  runID = `run-${Math.random().toString(36).slice(2)}`
  await git(["init", "-q"])
  await git(["config", "user.email", "t@t"])
  await git(["config", "user.name", "t"])
  // The assertions compare file contents byte for byte, and a checkout that
  // rewrites line endings would fail them for a reason that has nothing to do
  // with worktrees.
  await git(["config", "core.autocrlf", "false"])
  await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n")
  await fs.writeFile(path.join(dir, "b.txt"), "beta\n")
  await git(["add", "-A"])
  await git(["commit", "-qm", "init"])
})

afterEach(async () => {
  await fs.rm(worktreeRoot(runID), { recursive: true, force: true }).catch(() => {})
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

const read = (file: string, root = dir) => fs.readFile(path.join(root, file), "utf8")

async function open(cards: string[]) {
  const result = await openWorktrees(dir, runID, cards)
  if (!result.enabled) throw new Error(result.reason)
  return result
}

describe("isRepo", () => {
  test("a plain directory is not one", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-plain-"))
    expect(await isRepo(plain)).toBe(false)
    await fs.rm(plain, { recursive: true, force: true })
  })

  test("the repository is", async () => {
    expect(await isRepo(dir)).toBe(true)
  })
})

describe("baseCommit", () => {
  // A user with uncommitted work would otherwise hand every card a tree that
  // does not contain it, and they would edit files unlike the ones on screen.
  test("carries uncommitted work, without touching the tree or the stash list", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\nEDITED\nthree\n")
    const base = await baseCommit(dir)

    expect(await read("a.txt")).toContain("EDITED")
    expect((await git(["stash", "list"])).stdout.trim()).toBe("")
    const inBase = (await git(["show", `${base}:a.txt`])).stdout
    expect(inBase).toContain("EDITED")
  })

  test("a clean tree bases on HEAD", async () => {
    expect(await baseCommit(dir)).toBe((await git(["rev-parse", "HEAD"])).stdout.trim())
  })
})

describe("openWorktrees", () => {
  test("refuses a directory that is not a repository, rather than half-working", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-plain-"))
    const result = await openWorktrees(plain, runID, ["a"])
    expect(result).toEqual({ enabled: false, reason: "the project is not a git repository" })
    await fs.rm(plain, { recursive: true, force: true })
  })

  test("gives every card its own tree, each holding the project's files", async () => {
    const opened = await open(["coder", "tester"])
    expect(opened.trees.map((tree) => tree.card)).toEqual(["coder", "tester"])
    for (const tree of opened.trees) expect(await read("a.txt", tree.directory)).toBe("one\ntwo\nthree\n")
    expect(opened.trees[0]!.directory).not.toBe(opened.trees[1]!.directory)
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  test("the trees carry uncommitted work from the project", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\nEDITED\nthree\n")
    const opened = await open(["coder"])
    expect(await read("a.txt", opened.trees[0]!.directory)).toContain("EDITED")
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  // A session's location is fixed when the session is created, and a
  // re-dispatched card is prompted into the session it already holds.
  test("a card opened again keeps the tree its session is pointed at", async () => {
    const first = await open(["coder"])
    await fs.writeFile(path.join(first.trees[0]!.directory, "scratch.txt"), "mid-run\n")
    const second = await open(["coder"])
    expect(second.trees[0]!.directory).toBe(first.trees[0]!.directory)
    expect(await read("scratch.txt", second.trees[0]!.directory)).toBe("mid-run\n")
    await cleanupWorktrees(dir, runID, second.trees)
  })

  test("nothing is created inside the project", async () => {
    const opened = await open(["coder"])
    expect(await fs.readdir(dir)).toEqual([".git", "a.txt", "b.txt"])
    await cleanupWorktrees(dir, runID, opened.trees)
  })
})

describe("mergeWorktrees", () => {
  test("a card's edits land in the project's working tree", async () => {
    const opened = await open(["coder"])
    await fs.writeFile(path.join(opened.trees[0]!.directory, "a.txt"), "one\nCODER\nthree\n")

    const report = await mergeWorktrees(dir, opened.trees, opened.base)
    expect(report.merged).toEqual(["coder"])
    expect(report.conflicts).toEqual([])
    expect(await read("a.txt")).toBe("one\nCODER\nthree\n")
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  test("a new file the card wrote comes with it", async () => {
    const opened = await open(["coder"])
    await fs.writeFile(path.join(opened.trees[0]!.directory, "new.txt"), "fresh\n")

    await mergeWorktrees(dir, opened.trees, opened.base)
    expect(await read("new.txt")).toBe("fresh\n")
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  // The whole point: today the later write wins and the earlier card still
  // reports success. Both edits exist here, and neither is silently dropped.
  test("two cards editing different files both land", async () => {
    const opened = await open(["coder", "tester"])
    await fs.writeFile(path.join(opened.trees[0]!.directory, "a.txt"), "one\nCODER\nthree\n")
    await fs.writeFile(path.join(opened.trees[1]!.directory, "b.txt"), "TESTER\n")

    const report = await mergeWorktrees(dir, opened.trees, opened.base)
    expect(report.merged.sort()).toEqual(["coder", "tester"])
    expect(await read("a.txt")).toContain("CODER")
    expect(await read("b.txt")).toBe("TESTER\n")
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  test("two cards editing the same region conflict rather than one overwriting the other", async () => {
    const opened = await open(["coder", "tester"])
    await fs.writeFile(path.join(opened.trees[0]!.directory, "a.txt"), "one\nCODER\nthree\n")
    await fs.writeFile(path.join(opened.trees[1]!.directory, "a.txt"), "one\nTESTER\nthree\n")

    const report = await mergeWorktrees(dir, opened.trees, opened.base)
    expect(report.merged).toEqual(["coder"])
    expect(report.conflicts).toEqual([{ card: "tester", paths: ["a.txt"] }])
    // The first card's work is intact and the second's is not written over it.
    expect(await read("a.txt")).toBe("one\nCODER\nthree\n")
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  // A single failing path must not cost a card the files that were fine.
  test("a card's clean files land even when one path conflicts", async () => {
    const opened = await open(["coder", "tester"])
    await fs.writeFile(path.join(opened.trees[0]!.directory, "a.txt"), "one\nCODER\nthree\n")
    await fs.writeFile(path.join(opened.trees[1]!.directory, "a.txt"), "one\nTESTER\nthree\n")
    await fs.writeFile(path.join(opened.trees[1]!.directory, "only-mine.txt"), "kept\n")

    const report = await mergeWorktrees(dir, opened.trees, opened.base)
    expect(report.merged.sort()).toEqual(["coder", "tester"])
    expect(report.conflicts).toEqual([{ card: "tester", paths: ["a.txt"] }])
    expect(await read("only-mine.txt")).toBe("kept\n")
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  test("a card that changed nothing is reported as empty, not as merged", async () => {
    const opened = await open(["reader"])
    const report = await mergeWorktrees(dir, opened.trees, opened.base)
    expect(report).toEqual({ merged: [], empty: ["reader"], conflicts: [] })
    await cleanupWorktrees(dir, runID, opened.trees)
  })

  test("nothing another card wrote is reverted to make room", async () => {
    const opened = await open(["coder"])
    await fs.writeFile(path.join(opened.trees[0]!.directory, "a.txt"), "one\nCODER\nthree\n")
    // Something outside the run edits a file no card touched.
    await fs.writeFile(path.join(dir, "b.txt"), "USER EDIT\n")

    await mergeWorktrees(dir, opened.trees, opened.base)
    expect(await read("b.txt")).toBe("USER EDIT\n")
    await cleanupWorktrees(dir, runID, opened.trees)
  })
})

describe("cleanupWorktrees", () => {
  test("removes the trees and the branches behind them", async () => {
    const opened = await open(["coder", "tester"])
    await cleanupWorktrees(dir, runID, opened.trees)

    expect(await fs.stat(worktreeRoot(runID)).then(() => true).catch(() => false)).toBe(false)
    const branches = (await git(["branch", "--list", "openflow/*"])).stdout.trim()
    expect(branches).toBe("")
    const worktrees = (await git(["worktree", "list"])).stdout.trim().split("\n")
    expect(worktrees).toHaveLength(1)
  })

  test("merged work survives the cleanup — it is in the project, not in the branch", async () => {
    const opened = await open(["coder"])
    await fs.writeFile(path.join(opened.trees[0]!.directory, "a.txt"), "one\nCODER\nthree\n")
    await mergeWorktrees(dir, opened.trees, opened.base)
    await cleanupWorktrees(dir, runID, opened.trees)
    expect(await read("a.txt")).toBe("one\nCODER\nthree\n")
  })
})

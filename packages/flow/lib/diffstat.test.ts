import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { deltaOf } from "../src/graph/diff"
import { parseNumstat, treeDiff, treeStat } from "./diffstat"

const run = promisify(execFile)

/**
 * Line counts are git's arithmetic, so the tree half of this runs against a
 * real repository. Asserting against a mocked `git` would only prove the
 * arguments were spelled the way the test spells them.
 */

let dir: string

async function git(args: string[], cwd = dir) {
  return run("git", args, { cwd, windowsHide: true })
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-diffstat-"))
  await git(["init", "-q"])
  await git(["config", "user.email", "t@t"])
  await git(["config", "user.name", "t"])
  await git(["config", "core.autocrlf", "false"])
  await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n")
  await git(["add", "-A"])
  await git(["commit", "-qm", "init"])
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe("parseNumstat", () => {
  test("reads counts and keeps binary files without inventing one", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n")).toEqual([
      { path: "src/a.ts", added: 3, removed: 1 },
      { path: "logo.png", added: 0, removed: 0, binary: true },
    ])
  })

  test("a rename is named by where the file ended up", () => {
    expect(parseNumstat("1\t0\told.ts => new.ts\n2\t2\tsrc/{a => b}/x.ts\n").map((entry) => entry.path)).toEqual([
      "new.ts",
      "src/b/x.ts",
    ])
  })

  test("blank output is no files, not a parse failure", () => {
    expect(parseNumstat("\n  \n")).toEqual([])
  })
})

describe("treeStat", () => {
  test("counts tracked edits and untracked files alike", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n")
    await fs.writeFile(path.join(dir, "new.ts"), "a\nb\n")
    const stat = await treeStat(dir)
    expect(stat).toEqual(
      expect.arrayContaining([
        { path: "a.txt", added: 1, removed: 0 },
        { path: "new.ts", added: 2, removed: 0 },
      ]),
    )
  })

  test("a clean tree measures nothing", async () => {
    expect(await treeStat(dir)).toEqual([])
  })

  test("a directory that is not a repository measures nothing knowable", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-plain-"))
    expect(await treeStat(plain)).toBeUndefined()
    await fs.rm(plain, { recursive: true, force: true })
  })
})

describe("deltaOf, against a real tree", () => {
  test("two snapshots around real work name what moved", async () => {
    const before = (await treeStat(dir))!
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n")
    await fs.writeFile(path.join(dir, "added.ts"), "x\ny\nz\n")
    const delta = deltaOf(before, (await treeStat(dir))!)
    expect(delta).toEqual(
      expect.arrayContaining([
        { path: "a.txt", added: 0, removed: 1 },
        { path: "added.ts", added: 3, removed: 0 },
      ]),
    )
  })
})

describe("treeDiff", () => {
  test("reads a branch's own work against the base it started from", async () => {
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim()
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n")
    await git(["add", "-A"])
    await git(["commit", "-qm", "work"])
    expect(await treeDiff(dir, base)).toEqual([{ path: "a.txt", added: 2, removed: 0 }])
  })
})

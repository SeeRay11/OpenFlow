import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { utimesSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pruneState, STATE_RETENTION_DAYS } from "./prune"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

let dir: string
let root: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-prune-"))
  root = path.join(dir, "state")
  await fs.mkdir(root)
})

afterEach(() => fs.rm(dir, { recursive: true, force: true }))

/** A run directory shaped like the host's, every file and directory last written `ageDays` before `NOW`. */
async function run(name: string, ageDays: number, nodes = ["n1"]) {
  const when = new Date(NOW - ageDays * DAY)
  for (const node of nodes) {
    const state = path.join(root, name, node)
    await fs.mkdir(path.join(state, "session"), { recursive: true })
    await fs.mkdir(path.join(state, "swarm"), { recursive: true })
    for (const file of ["session/a.jsonl", "overlay.yml", "role.md", ".openflow-session.json", "swarm/live.json"]) {
      await fs.writeFile(path.join(state, file), "x")
      await fs.utimes(path.join(state, file), when, when)
    }
    for (const sub of ["session", "swarm", ""]) await fs.utimes(path.join(state, sub), when, when)
  }
  await fs.utimes(path.join(root, name), when, when)
}

/** A host that holds nothing. */
const free = () => () => undefined

async function exists(target: string) {
  return fs.lstat(target).then(
    () => true,
    () => false,
  )
}

describe("pruneState", () => {
  test("removes an old run with every card's state and keeps a recent one", async () => {
    await run("old", STATE_RETENTION_DAYS + 5, ["n1", "n2"])
    await run("recent", STATE_RETENTION_DAYS - 5)
    const result = await pruneState({ root, now: () => NOW, claim: free })
    expect(result).toEqual({ removed: ["old"], errors: 0 })
    expect(await exists(path.join(root, "old"))).toBe(false)
    expect(await exists(path.join(root, "recent", "n1", "session", "a.jsonl"))).toBe(true)
  })

  test("one recent file anywhere in a run keeps all of it", async () => {
    await run("mixed", STATE_RETENTION_DAYS + 10, ["n1", "n2"])
    const fresh = path.join(root, "mixed", "n2", "session", "late.jsonl")
    await fs.writeFile(fresh, "x")
    const when = new Date(NOW - DAY)
    await fs.utimes(fresh, when, when)
    expect(await pruneState({ root, now: () => NOW, claim: free })).toEqual({ removed: [], errors: 0 })
    expect(await exists(path.join(root, "mixed", "n1", "role.md"))).toBe(true)
  })

  test("the age limit is injectable", async () => {
    await run("a", 3)
    expect((await pruneState({ root, now: () => NOW, maxAgeMs: 2 * DAY, claim: free })).removed).toEqual(["a"])
  })

  test("a run the host holds is kept even when old, and claimed by its directory name", async () => {
    await run("held", STATE_RETENTION_DAYS + 90)
    await run("gone", STATE_RETENTION_DAYS + 90)
    const asked: string[] = []
    const result = await pruneState({
      root,
      now: () => NOW,
      claim(name) {
        asked.push(name)
        return name === "held" ? undefined : () => undefined
      },
    })
    expect(result.removed).toEqual(["gone"])
    expect(asked).toContain("held")
    expect(await exists(path.join(root, "held", "n1", "role.md"))).toBe(true)
  })

  test("a recent run is never claimed", async () => {
    await run("recent", STATE_RETENTION_DAYS - 5)
    const asked: string[] = []
    await pruneState({
      root,
      now: () => NOW,
      claim(name) {
        asked.push(name)
        return () => undefined
      },
    })
    expect(asked).toEqual([])
  })

  test("what a session wrote between the scan and the claim keeps the run", async () => {
    await run("late", STATE_RETENTION_DAYS + 90)
    const result = await pruneState({
      root,
      now: () => NOW,
      claim(name) {
        // A create that started, wrote its files and ended after the scan, before the claim.
        const late = path.join(root, name, "n1", "session", "turn.jsonl")
        writeFileSync(late, "x")
        utimesSync(late, new Date(NOW), new Date(NOW))
        return () => undefined
      },
    })
    expect(result.removed).toEqual([])
    expect(await exists(path.join(root, "late", "n1", "role.md"))).toBe(true)
  })

  test("the claim is held until the removal ended, and released when a removal fails", async () => {
    await run("old", STATE_RETENTION_DAYS + 5)
    await run("stuck", STATE_RETENTION_DAYS + 5)
    const removing = Promise.withResolvers<void>()
    const removal = Promise.withResolvers<void>()
    const real = fs.rm
    let held = 0
    const spy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (!String(target).endsWith("old")) throw new Error("disk says no")
      removing.resolve()
      await removal.promise
      return real(target, options)
    })
    try {
      const pruning = pruneState({
        root,
        now: () => NOW,
        claim() {
          held++
          return () => void held--
        },
      })
      await removing.promise
      // The removal is under way: its claim is still taken.
      expect(held).toBe(1)
      removal.resolve()
      // Both runs were tried (in the filesystem's order): one removed, one failed, and the failing one's claim was released too.
      expect(await pruning).toEqual({ removed: ["old"], errors: 1 })
      expect(held).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  test("files, the uplift directory, dotfiles and directories the host would not name are never touched", async () => {
    const old = new Date(NOW - 100 * DAY)
    await fs.mkdir(path.join(root, "uplift"))
    await fs.writeFile(path.join(root, "uplift", "pids.json"), "x")
    await fs.writeFile(path.join(root, "notes.txt"), "x")
    await fs.mkdir(path.join(root, ".hidden", "n"), { recursive: true })
    await fs.mkdir(path.join(root, "not a run!", "n"), { recursive: true })
    for (const entry of ["uplift/pids.json", "uplift", "notes.txt", ".hidden/n", ".hidden", "not a run!/n", "not a run!"]) await fs.utimes(path.join(root, entry), old, old)
    expect(await pruneState({ root, now: () => NOW, claim: free })).toEqual({ removed: [], errors: 0 })
    for (const entry of ["uplift/pids.json", "notes.txt", ".hidden/n", "not a run!/n"]) expect(await exists(path.join(root, entry))).toBe(true)
  })

  test("a run directory holding anything but node directories is not ours", async () => {
    await run("odd", STATE_RETENTION_DAYS + 50)
    const stray = path.join(root, "odd", "README")
    const old = new Date(NOW - 100 * DAY)
    await fs.writeFile(stray, "x")
    await fs.utimes(stray, old, old)
    expect(await pruneState({ root, now: () => NOW, claim: free })).toEqual({ removed: [], errors: 0 })
    expect(await exists(stray)).toBe(true)
  })

  test("a missing root is nothing to do", async () => {
    expect(await pruneState({ root: path.join(dir, "nope"), now: () => NOW, claim: free })).toEqual({ removed: [], errors: 0 })
  })

  // Creating a symlink needs a privilege Windows does not grant by default.
  describe.skipIf(process.platform === "win32")("symlinks", () => {
    async function outside() {
      const target = path.join(dir, "outside")
      const old = new Date(NOW - 400 * DAY)
      await fs.mkdir(path.join(target, "n1"), { recursive: true })
      await fs.writeFile(path.join(target, "n1", "precious.txt"), "keep")
      for (const entry of ["n1/precious.txt", "n1", ""]) await fs.utimes(path.join(target, entry), old, old)
      return target
    }

    test("a link at the root, named like a run, is neither followed nor removed", async () => {
      const target = await outside()
      await fs.symlink(target, path.join(root, "linked"))
      expect(await pruneState({ root, now: () => NOW, claim: free })).toEqual({ removed: [], errors: 0 })
      expect(await fs.readFile(path.join(target, "n1", "precious.txt"), "utf8")).toBe("keep")
      expect((await fs.lstat(path.join(root, "linked"))).isSymbolicLink()).toBe(true)
    })

    test("a link as a card directory marks the run as not ours", async () => {
      const target = await outside()
      await run("holder", STATE_RETENTION_DAYS + 50)
      await fs.symlink(target, path.join(root, "holder", "escape"))
      expect(await pruneState({ root, now: () => NOW, claim: free })).toEqual({ removed: [], errors: 0 })
      expect(await fs.readFile(path.join(target, "n1", "precious.txt"), "utf8")).toBe("keep")
    })

    test("a link deeper in an expired run is removed as a link, its target survives", async () => {
      const target = await outside()
      await run("deep", STATE_RETENTION_DAYS + 50)
      await fs.symlink(target, path.join(root, "deep", "n1", "session", "elsewhere"))
      const old = new Date(NOW - 100 * DAY)
      await fs.lutimes(path.join(root, "deep", "n1", "session", "elsewhere"), old, old)
      await fs.utimes(path.join(root, "deep", "n1", "session"), old, old)
      const result = await pruneState({ root, now: () => NOW, claim: free })
      expect(result.removed).toEqual(["deep"])
      expect(await exists(path.join(root, "deep"))).toBe(false)
      expect(await fs.readFile(path.join(target, "n1", "precious.txt"), "utf8")).toBe("keep")
    })

    test("a root that is itself a link is resolved once; runs inside it are pruned, nothing outside the real root is", async () => {
      await run("old", STATE_RETENTION_DAYS + 5)
      const via = path.join(dir, "via")
      await fs.symlink(root, via)
      expect((await pruneState({ root: via, now: () => NOW, claim: free })).removed).toEqual(["old"])
    })
  })

  test("pruning while sessions are being created neither throws nor touches the new runs", async () => {
    await run("old", STATE_RETENTION_DAYS + 5)
    const created = Array.from({ length: 20 }, async (_, index) => {
      const state = path.join(root, `fresh-${index}`, "n1")
      await fs.mkdir(state, { recursive: true })
      await fs.writeFile(path.join(state, "role.md"), "x")
    })
    const [result] = await Promise.all([pruneState({ root, claim: free }), ...created])
    expect(result).toEqual({ removed: ["old"], errors: 0 })
    for (let index = 0; index < 20; index++) expect(await exists(path.join(root, `fresh-${index}`, "n1", "role.md"))).toBe(true)
  })

  test("a run that vanishes while it is scanned is not an error", async () => {
    await run("a", STATE_RETENTION_DAYS + 5, ["n1", "n2", "n3"])
    const [result] = await Promise.all([pruneState({ root, now: () => NOW, claim: free }), fs.rm(path.join(root, "a"), { recursive: true, force: true })])
    expect(result?.errors).toBe(0)
    expect(await exists(path.join(root, "a"))).toBe(false)
  })
})

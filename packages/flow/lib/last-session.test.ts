import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as mod from "./last-session"

/**
 * The remembered folder decides where every card writes on the next launch, so
 * the precedence rules are tested rather than assumed. `OPENFLOW_STATE_DIR`
 * redirects the state file into a temp directory — without it these tests would
 * overwrite the developer's own remembered folder.
 */

let dir: string
let project: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-state-"))
  project = path.join(dir, "repo")
  await fs.mkdir(project)
  process.env.OPENFLOW_STATE_DIR = path.join(dir, "state")
})

afterEach(async () => {
  delete process.env.OPENFLOW_STATE_DIR
  await fs.rm(dir, { recursive: true, force: true })
})

describe("remember and recall", () => {
  test("round-trips the folder, creating the state directory", () => {
    expect(mod.rememberProject(project)).toBe(true)
    expect(mod.recallProject()).toBe(path.resolve(project))
  })

  test("recalls nothing before anything was remembered", () => {
    expect(mod.recallProject()).toBeUndefined()
  })

  test("survives a state file that is not valid json", async () => {
    mod.rememberProject(project)
    await fs.writeFile(mod.statePath(), "{ not json")
    expect(mod.recallProject()).toBeUndefined()
  })

  test("moves a state file it cannot parse aside instead of writing over it", async () => {
    // `read` feeds `write`, so answering `{}` for a damaged file meant the very
    // next remember persisted that `{}` — one bad byte and every project's
    // remembered pipeline was gone, with nothing left to look at.
    mod.rememberProject(project)
    await fs.writeFile(mod.statePath(), "{ not json")

    mod.rememberPipeline(project, "feature-build")

    expect(await fs.readFile(`${mod.statePath()}.corrupt`, "utf8")).toBe("{ not json")
    expect(mod.recallPipeline(project)).toBe("feature-build")
  })

  test("writes through a temp file and leaves nothing behind", async () => {
    // A truncated state.json reads exactly like "nothing was ever remembered",
    // so the new state lands beside the old one and is renamed over it.
    mod.rememberProject(project)
    expect(await fs.readdir(path.dirname(mod.statePath()))).toEqual(["state.json"])
  })

  test("keeps only the newest folder", async () => {
    const other = path.join(dir, "other")
    await fs.mkdir(other)
    mod.rememberProject(project)
    mod.rememberProject(other)
    expect(mod.recallProject()).toBe(path.resolve(other))
  })
})

describe("resolveProject", () => {
  test("reopens the remembered folder", () => {
    mod.rememberProject(project)
    expect(mod.resolveProject(dir, undefined)).toBe(path.resolve(project))
  })

  test("an explicitly named folder wins over memory", () => {
    // Someone passing --project on this launch means it; a folder picked last
    // week must not override it.
    mod.rememberProject(project)
    expect(mod.resolveProject(dir, dir)).toBe(path.resolve(dir))
  })

  test("ignores a blank environment variable", () => {
    mod.rememberProject(project)
    expect(mod.resolveProject(dir, "   ")).toBe(path.resolve(project))
  })

  test("falls back when the remembered folder is gone", async () => {
    mod.rememberProject(project)
    await fs.rm(project, { recursive: true })
    // Booting into a path that no longer exists fails every /flow/api route,
    // which reads as a broken app rather than a missing folder.
    expect(mod.resolveProject(dir, undefined)).toBe(path.resolve(dir))
  })

  test("falls back when nothing was ever remembered", () => {
    expect(mod.resolveProject(dir, undefined)).toBe(path.resolve(dir))
  })
})

describe("remembered pipeline", () => {
  test("is scoped to a project, so a folder switch does not carry it", () => {
    const other = path.join(dir, "other")
    mod.rememberPipeline(project, "feature-build")
    mod.rememberPipeline(other, "docs-pass")

    expect(mod.recallPipeline(project)).toBe("feature-build")
    expect(mod.recallPipeline(other)).toBe("docs-pass")
    expect(mod.recallPipeline(path.join(dir, "never-opened"))).toBeUndefined()
  })

  test("an empty name forgets it", () => {
    mod.rememberPipeline(project, "feature-build")
    mod.rememberPipeline(project, "")
    expect(mod.recallPipeline(project)).toBeUndefined()
  })

  test("does not clobber the remembered folder, or the reverse", () => {
    // The two are written by different routes at different times, so the
    // read-modify-write is the whole point.
    mod.rememberProject(project)
    mod.rememberPipeline(project, "feature-build")
    expect(mod.recallProject()).toBe(path.resolve(project))

    mod.rememberProject(dir)
    expect(mod.recallPipeline(project)).toBe("feature-build")
  })
})

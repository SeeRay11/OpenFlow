import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as mod from "./last-project"

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

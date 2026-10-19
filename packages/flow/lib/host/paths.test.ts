import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { stateDir, stateRoot } from "./paths"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "flow-paths-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("stateDir", () => {
  test("OPENFLOW_STATE_DIR wins", () => {
    expect(stateDir({ OPENFLOW_STATE_DIR: "/somewhere" })).toBe("/somewhere")
  })

  test("defaults to ~/.openflow", () => {
    expect(stateDir({})).toBe(path.join(os.homedir(), ".openflow"))
    expect(stateDir({ OPENFLOW_STATE_DIR: "" })).toBe(path.join(os.homedir(), ".openflow"))
  })
})

describe("stateRoot", () => {
  const env = { OPENFLOW_STATE_DIR: "/state" }

  test("is <stateDir>/omp/<sha1(realpath)[0,12]>", () => {
    const project = path.join(dir, "project")
    mkdirSync(project)
    const expected = createHash("sha1").update(realpathSync(project)).digest("hex").slice(0, 12)
    expect(stateRoot(project, env)).toBe(path.join("/state", "omp", expected))
  })

  test("a symlink and its target share a root", () => {
    const project = path.join(dir, "project")
    const link = path.join(dir, "link")
    mkdirSync(project)
    symlinkSync(project, link)
    expect(stateRoot(link, env)).toBe(stateRoot(project, env))
  })

  test("different projects differ, and a missing folder still has a stable root", () => {
    const missing = path.join(dir, "nope")
    expect(stateRoot(missing, env)).toBe(stateRoot(missing, env))
    expect(stateRoot(missing, env)).not.toBe(stateRoot(dir, env))
  })
})

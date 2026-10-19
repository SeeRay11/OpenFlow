import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { SwarmPreflight } from "../../shared/swarm"
import { buildSwarmLaunch } from "./launch"
import { DUMMY_KEYS, fakeRoot, tmpdir } from "./testing/fixtures"

let dir: string
let root: string

beforeEach(() => {
  dir = tmpdir()
  root = fakeRoot(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const ok = (effective: "auto" | "always", checkout: string): SwarmPreflight => ({ ok: true, effective, requested: effective, problems: [], root: checkout })

describe("buildSwarmLaunch", () => {
  test("off contributes nothing but still names the (uncreated) store", () => {
    const state = path.join(dir, "session")
    const preflight: SwarmPreflight = { ok: true, effective: "off", requested: "off", problems: [] }
    expect(buildSwarmLaunch({ preflight, stateDir: state })).toEqual({
      effective: "off",
      args: [],
      env: {},
      overlay: {},
      systemPrompt: "",
      stateDir: path.join(state, "swarm"),
      preflight,
    })
    expect(fs.existsSync(state)).toBe(false)
  })

  test("a degraded request keeps its problems and contributes nothing", () => {
    const preflight: SwarmPreflight = {
      ok: false,
      effective: "off",
      requested: "always",
      problems: [{ code: "no-signing-key", message: "m", fix: "f" }],
      root,
    }
    const launch = buildSwarmLaunch({ preflight, stateDir: path.join(dir, "s") })
    expect(launch.args).toEqual([])
    expect(launch.env).toEqual({})
    expect(launch.systemPrompt).toBe("")
    expect(launch.preflight).toBe(preflight)
  })

  test("auto: -e <root>/omp, SWARM_DIR outside the worktree, isolation off, no prompt", () => {
    const state = path.join(dir, "session")
    const launch = buildSwarmLaunch({ preflight: ok("auto", root), stateDir: state })
    expect(launch).toEqual({
      effective: "auto",
      args: ["-e", path.join(root, "omp")],
      env: { SWARM_DIR: path.join(state, "swarm"), SWARM_ROOT: root },
      overlay: { task: { maxRecursionDepth: 2, isolation: { enabled: false } } },
      systemPrompt: "",
      stateDir: path.join(state, "swarm"),
      preflight: ok("auto", root),
    })
    // POSIX permission bits only.
    if (!(process.platform === "win32")) expect(fs.statSync(path.join(state, "swarm")).mode & 0o777).toBe(0o700)
  })

  test("always adds a system prompt that routes through the task tool and never through /swarm", () => {
    const launch = buildSwarmLaunch({ preflight: ok("always", root), stateDir: path.join(dir, "session") })
    expect(launch.effective).toBe("always")
    expect(launch.systemPrompt).toContain("a01-orchestrator")
    expect(launch.systemPrompt).toContain("`task` tool")
    expect(launch.systemPrompt).toContain("Do not use the `/swarm` command")
    expect(launch.systemPrompt).not.toMatch(/\/swarm </)
    expect(launch.args).toEqual(["-e", path.join(root, "omp")])
  })

  test("a relative state dir is made absolute", () => {
    const previous = process.cwd()
    process.chdir(dir)
    try {
      const launch = buildSwarmLaunch({ preflight: ok("auto", root), stateDir: "rel-session" })
      expect(path.isAbsolute(launch.env.SWARM_DIR!)).toBe(true)
      expect(launch.env.SWARM_DIR).toBe(path.join(fs.realpathSync(dir), "rel-session", "swarm"))
    } finally {
      process.chdir(previous)
    }
  })

  test("never puts the card under the guard and never carries a key", () => {
    const launch = buildSwarmLaunch({ preflight: ok("always", root), stateDir: path.join(dir, "session") })
    for (const name of ["SWARM_AGENT", "SWARM_TASK_ID", "SWARM_CHILD", "SWARM_ED25519_KEY", "SWARM_ED25519_KEY_FILE", "SWARM_SIGNING_KEY", "SWARM_ALLOW_INSECURE_DEV_KEY"]) {
      expect(launch.env).not.toHaveProperty(name)
    }
    const text = JSON.stringify(launch)
    for (const value of Object.values(DUMMY_KEYS)) expect(text).not.toContain(value)
  })

  test("a store that cannot be created degrades to off with a bad-state-dir problem", () => {
    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "")
    const launch = buildSwarmLaunch({ preflight: ok("auto", root), stateDir: path.join(blocker, "session") })
    expect(launch.effective).toBe("off")
    expect(launch.args).toEqual([])
    expect(launch.preflight.ok).toBe(false)
    expect(launch.preflight.effective).toBe("off")
    expect(launch.preflight.problems.map((problem) => problem.code)).toEqual(["bad-state-dir"])
  })
})

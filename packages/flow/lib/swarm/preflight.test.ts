import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { alive, until } from "../uplift/testing/stub-planner"
import { configuredRoot, createPreflight } from "./preflight"
import { DUMMY_KEYS, fakePython, fakeRoot, hostEnv, settings, tmpdir } from "./testing/fixtures"

let dir: string
let root: string
let python: string

beforeEach(() => {
  dir = tmpdir()
  root = fakeRoot(dir)
  python = fakePython(dir, { runs: true, crypto: true })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const good = () => hostEnv({ SWARM_ED25519_KEY: DUMMY_KEYS.SWARM_ED25519_KEY })

describe("preflight", () => {
  test("off is always ok, even with nothing configured", async () => {
    const result = await createPreflight({ python: "/nonexistent/python3" })({ requested: "off", settings: settings(), env: hostEnv() })
    expect(result).toEqual({ ok: true, effective: "off", requested: "off", problems: [] })
  })

  test("root comes from settings, then SWARM_ROOT, then ULTRATHINK_SWARM_ROOT", () => {
    const env = hostEnv({ SWARM_ROOT: "/from/swarm-root", ULTRATHINK_SWARM_ROOT: "/from/ultrathink" })
    expect(configuredRoot(settings("/from/settings"), env)).toBe("/from/settings")
    expect(configuredRoot(settings(), env)).toBe("/from/swarm-root")
    expect(configuredRoot(settings("  "), hostEnv({ ULTRATHINK_SWARM_ROOT: "/from/ultrathink" }))).toBe("/from/ultrathink")
    expect(configuredRoot(settings(), hostEnv())).toBeUndefined()
  })

  test("python that does not exist at all: no-python", async () => {
    const result = await createPreflight({ python: path.join(dir, "nope") })({ requested: "always", settings: settings(root), env: good() })
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-python"])
  })

  test("every problem is actionable and several are reported together", async () => {
    const result = await createPreflight({ python: path.join(dir, "nope") })({ requested: "auto", settings: settings(), env: hostEnv() })
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-root", "no-python", "no-signing-key"])
    for (const problem of result.problems) expect(problem.fix?.length).toBeGreaterThan(10)
  })
})

// The python stand-in (`fakePython`) is a `#!/bin/sh` script: it cannot be spawned on Windows.
const posix = describe.skipIf(process.platform === "win32")

posix("preflight with a python stand-in", () => {
  test.each(["auto", "always"] as const)("%s with everything in place keeps the requested mode", async (mode) => {
    const result = await createPreflight({ python })({ requested: mode, settings: settings(root), env: good() })
    expect(result).toEqual({ ok: true, effective: mode, requested: mode, problems: [], root })
  })

  test("no checkout configured: no-root, degraded to off", async () => {
    const result = await createPreflight({ python })({ requested: "auto", settings: settings(), env: good() })
    expect(result.ok).toBe(false)
    expect(result.effective).toBe("off")
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-root"])
    expect(result.root).toBeUndefined()
  })

  test("a directory that is not a checkout: bad-root", async () => {
    const empty = path.join(dir, "empty")
    fs.mkdirSync(empty)
    const result = await createPreflight({ python })({ requested: "auto", settings: settings(empty), env: good() })
    expect(result.problems.map((problem) => problem.code)).toEqual(["bad-root"])
    expect(result.root).toBe(empty)
  })

  test("a checkout missing scripts/orch_plan.py is a bad-root", async () => {
    fs.rmSync(path.join(root, "scripts", "orch_plan.py"))
    const result = await createPreflight({ python })({ requested: "auto", settings: settings(root), env: good() })
    expect(result.problems.map((problem) => problem.code)).toEqual(["bad-root"])
  })

  test("the checkout can come from SWARM_ROOT alone", async () => {
    const result = await createPreflight({ python })({ requested: "auto", settings: settings(), env: { ...good(), SWARM_ROOT: root } })
    expect(result.ok).toBe(true)
    expect(result.root).toBe(root)
  })

  test("python that does not run: no-python, and no crypto verdict from a missing interpreter", async () => {
    const broken = fakePython(dir, { runs: false, crypto: false })
    const result = await createPreflight({ python: broken })({ requested: "auto", settings: settings(root), env: good() })
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-python"])
    expect(result.effective).toBe("off")
  })

  test("python without cryptography: no-crypto", async () => {
    const bare = fakePython(path.join(dir), { runs: true, crypto: false })
    const result = await createPreflight({ python: bare })({ requested: "auto", settings: settings(root), env: good() })
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-crypto"])
  })

  test("no signing configured: no-signing-key", async () => {
    const result = await createPreflight({ python })({ requested: "always", settings: settings(root), env: hostEnv() })
    expect(result.ok).toBe(false)
    expect(result.effective).toBe("off")
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-signing-key"])
  })

  test("SWARM_SIGNING_KEY alone counts as signing", async () => {
    const env = hostEnv({ SWARM_SIGNING_KEY: DUMMY_KEYS.SWARM_SIGNING_KEY })
    expect((await createPreflight({ python })({ requested: "auto", settings: settings(root), env })).ok).toBe(true)
  })

  test("SWARM_ED25519_KEY_FILE counts when the file exists, and its contents are never read", async () => {
    const file = path.join(dir, "key.hex")
    fs.writeFileSync(file, DUMMY_KEYS.SWARM_ED25519_KEY, { mode: 0o000 })
    const ok = await createPreflight({ python })({ requested: "auto", settings: settings(root), env: hostEnv({ SWARM_ED25519_KEY_FILE: file }) })
    expect(ok.ok).toBe(true)

    const missing = hostEnv({ SWARM_ED25519_KEY_FILE: path.join(dir, "absent.hex") })
    const result = await createPreflight({ python })({ requested: "auto", settings: settings(root), env: missing })
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-signing-key"])
  })

  test("the conventional key file under XDG_CONFIG_HOME counts", async () => {
    const config = path.join(dir, "xdg")
    fs.mkdirSync(path.join(config, "agent-swarm"), { recursive: true })
    fs.writeFileSync(path.join(config, "agent-swarm", "signing-key.hex"), "x")
    const env = hostEnv({ XDG_CONFIG_HOME: config })
    expect((await createPreflight({ python })({ requested: "auto", settings: settings(root), env })).ok).toBe(true)
  })

  test("the unsigned development key is never a way out", async () => {
    const env = hostEnv({ SWARM_ALLOW_INSECURE_DEV_KEY: "1" })
    const result = await createPreflight({ python })({ requested: "auto", settings: settings(root), env })
    expect(result.problems.map((problem) => problem.code)).toEqual(["no-signing-key"])
    expect(JSON.stringify(result)).not.toContain("INSECURE")
  })

  test("key values never appear in a result", async () => {
    const env = hostEnv({ ...DUMMY_KEYS, SWARM_ED25519_KEY_FILE: path.join(dir, "absent.hex") })
    const broken = fakePython(dir, { runs: false, crypto: false })
    for (const candidate of [python, broken]) {
      const result = await createPreflight({ python: candidate })({ requested: "auto", settings: settings(root), env })
      const text = JSON.stringify(result)
      for (const value of Object.values(DUMMY_KEYS)) expect(text).not.toContain(value)
    }
  })

  test("state directory: creatable passes without being created; under a file fails", async () => {
    const fresh = path.join(dir, "state", "session-1")
    const preflight = createPreflight({ python })
    const ok = await preflight({ requested: "auto", settings: settings(root), env: good(), stateDir: fresh })
    expect(ok.ok).toBe(true)
    expect(fs.existsSync(path.join(dir, "state"))).toBe(false)

    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "")
    const bad = await preflight({ requested: "auto", settings: settings(root), env: good(), stateDir: path.join(blocker, "session") })
    expect(bad.problems.map((problem) => problem.code)).toEqual(["bad-state-dir"])
    expect(bad.effective).toBe("off")
  })

  test("environment checks are cached for 30 s per (root, signing sources), then redone", async () => {
    const log = path.join(dir, "runs.log")
    const counted = fakePython(dir, { runs: true, crypto: true, log })
    let clock = 1_000
    const preflight = createPreflight({ python: counted, now: () => clock })
    const runs = () => fs.readFileSync(log, "utf8").trim().split("\n").length

    await preflight({ requested: "auto", settings: settings(root), env: good() })
    expect(runs()).toBe(2)
    clock += 29_000
    await preflight({ requested: "always", settings: settings(root), env: good() })
    expect(runs()).toBe(2)

    // a different signing source is a different key
    await preflight({ requested: "auto", settings: settings(root), env: hostEnv({ SWARM_SIGNING_KEY: DUMMY_KEYS.SWARM_SIGNING_KEY }) })
    expect(runs()).toBe(4)

    clock += 2_000
    await preflight({ requested: "auto", settings: settings(root), env: good() })
    expect(runs()).toBe(6)
  })
})

posix("preflight dispose", () => {
  /** A python whose probe hangs: it records its pid, then waits far longer than any test. */
  function hungPython() {
    const script = path.join(dir, "hung-python")
    const pids = path.join(dir, "hung.pid")
    fs.writeFileSync(script, `#!/bin/sh\necho $$ > "${pids}"\nexec sleep 300\n`)
    fs.chmodSync(script, 0o755)
    return { script, pids }
  }

  test("dispose kills the probe in flight and the check answers 503 instead of a missing interpreter", async () => {
    const { script, pids } = hungPython()
    const preflight = createPreflight({ python: script })
    const checking = preflight({ requested: "always", settings: settings(root), env: good() }).then(
      () => undefined,
      (error: unknown) => error,
    )
    await until(() => fs.existsSync(pids) && fs.readFileSync(pids, "utf8").endsWith("\n"))
    const pid = Number(fs.readFileSync(pids, "utf8"))
    expect(await alive(pid)).toBe(true)

    await preflight.dispose()

    expect(await alive(pid)).toBe(false)
    expect(await checking).toMatchObject({ status: 503 })
  })

  test("a disposed preflight refuses new checks, off included, and runs no probe", async () => {
    const log = path.join(dir, "runs.log")
    const counted = fakePython(dir, { runs: true, crypto: true, log })
    const preflight = createPreflight({ python: counted })
    await preflight.dispose()
    for (const requested of ["auto", "off"] as const) {
      expect(await preflight({ requested, settings: settings(root), env: good() }).then(() => undefined, (error: unknown) => error)).toMatchObject({ status: 503 })
    }
    expect(fs.existsSync(log)).toBe(false)
  })
})

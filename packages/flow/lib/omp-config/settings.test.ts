import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS, type OmpSettings } from "../../shared/omp"
import { SETTINGS_FILE, createSettingsStore, effectiveSources, validateSettings } from "./settings"

let root: string
let stateDir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "omp-settings-"))
  stateDir = path.join(root, "state")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const store = (env: NodeJS.ProcessEnv = {}) => createSettingsStore({ stateDir: () => stateDir, env })
const settingsFile = () => path.join(stateDir, SETTINGS_FILE)

function withSettings(patch: (settings: OmpSettings) => void): OmpSettings {
  const settings = structuredClone(DEFAULT_OMP_SETTINGS)
  patch(settings)
  return settings
}

describe("substrate.url warning", () => {
  const warnings = async (url: string, env: NodeJS.ProcessEnv = {}) => {
    const saved = await store(env).update({ substrate: { url } })
    if (!saved.ok) throw new Error("the url was refused")
    return saved.view.warnings
  }

  test("plain http to a non-loopback host is saved with a warning, not refused, and the warning stays on a later read", async () => {
    const saved = await warnings("http://substrate.example:8080")
    expect(saved).toHaveLength(1)
    expect(saved[0]).toContain("substrate.example:8080")
    expect(saved[0]).toContain("https")
    expect((await store().view()).warnings).toEqual(saved)
    expect((await store().load()).warnings).toEqual(saved)
  })

  test.each(["https://substrate.example", "http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080", ""])("%j draws no warning", async (url) => {
    expect(await warnings(url)).toEqual([])
  })

  test("SUBSTRATE_URL naming the same origin makes it a deliberate choice: no warning", async () => {
    expect(await warnings("http://substrate.example:8080", { SUBSTRATE_URL: "http://substrate.example:8080" })).toEqual([])
    expect(await warnings("http://substrate.example:8080", { SUBSTRATE_URL: "http://other.example:8080" })).toHaveLength(1)
  })
})

describe("load", () => {
  test("returns the defaults and creates nothing when there is no file", async () => {
    expect((await store().load()).settings).toEqual(DEFAULT_OMP_SETTINGS)
    await expect(stat(stateDir)).rejects.toThrow()
  })

  test("deep-merges a partial file over the defaults", async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(settingsFile(), JSON.stringify({ profile: "work", uplift: { timeoutMs: 60_000 } }))
    const { settings, warnings } = await store().load()
    expect(settings.profile).toBe("work")
    expect(settings.uplift).toEqual({ ...DEFAULT_OMP_SETTINGS.uplift, timeoutMs: 60_000 })
    expect(settings.memory).toEqual(DEFAULT_OMP_SETTINGS.memory)
    expect(warnings).toEqual([])
  })

  test("keeps the readable part of a file with unknown keys or wrong types, and says so", async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(settingsFile(), JSON.stringify({ profile: "work", maxSessionMinutes: "soon", future: true }))
    const { settings, warnings } = await store().load()
    expect(settings.profile).toBe("work")
    expect(settings.maxSessionMinutes).toBe(DEFAULT_OMP_SETTINGS.maxSessionMinutes)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("maxSessionMinutes")
    expect(warnings[0]).toContain("future")
  })

  test("moves a corrupt file aside, uses the defaults and keeps warning until the next save", async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(settingsFile(), "{ not json")
    const instance = store()
    const first = await instance.load()
    expect(first.settings).toEqual(DEFAULT_OMP_SETTINGS)
    expect(first.warnings[0]).toContain(`${SETTINGS_FILE}.bad`)
    expect(await readFile(`${settingsFile()}.bad`, "utf8")).toBe("{ not json")
    await expect(stat(settingsFile())).rejects.toThrow()
    // The file is gone, so only the instance remembers; a second read still warns.
    expect((await instance.load()).warnings).toHaveLength(1)
    const saved = await instance.update({ profile: "later" })
    expect(saved.ok && saved.view.warnings).toEqual([])
  })

  test("treats a JSON value that is not an object as corrupt", async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(settingsFile(), "[1,2]")
    const { warnings } = await store().load()
    expect(warnings).toHaveLength(1)
    expect((await stat(`${settingsFile()}.bad`)).isFile()).toBe(true)
  })
})

describe("update", () => {
  // POSIX permission bits only.
  test.skipIf(process.platform === "win32")("saves the merged result at mode 0600 and leaves no temp file", async () => {
    const result = await store().update({ profile: "work", memory: { readLimit: 3 } })
    expect(result.ok).toBe(true)
    const onDisk = JSON.parse(await readFile(settingsFile(), "utf8")) as OmpSettings
    expect(onDisk.profile).toBe("work")
    expect(onDisk.memory).toEqual({ ...DEFAULT_OMP_SETTINGS.memory, readLimit: 3 })
    expect(onDisk.uplift).toEqual(DEFAULT_OMP_SETTINGS.uplift)
    expect((await stat(settingsFile())).mode & 0o777).toBe(0o600)
    expect(await readdir(stateDir)).toEqual([SETTINGS_FILE])
  })

  test("a second patch keeps the first", async () => {
    const instance = store()
    await instance.update({ profile: "work" })
    await instance.update({ maxSessionMinutes: 60 })
    const { settings } = await instance.load()
    expect(settings.profile).toBe("work")
    expect(settings.maxSessionMinutes).toBe(60)
  })

  test("an invalid patch changes nothing on disk", async () => {
    const instance = store()
    await instance.update({ profile: "work" })
    const before = await readFile(settingsFile(), "utf8")
    const result = await instance.update({ maxSessionMinutes: 0 })
    expect(result).toEqual({ ok: false, errors: [expect.objectContaining({ path: "maxSessionMinutes" })] })
    expect(await readFile(settingsFile(), "utf8")).toBe(before)
  })

  test("rejects unknown keys, wrong types and a non-object body by path", async () => {
    const instance = store()
    const unknown = await instance.update({ nope: 1, uplift: { nope: true, hitl: "yes" }, memory: 5 })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.errors.map((error) => error.path).sort()).toEqual(["memory", "nope", "uplift.hitl", "uplift.nope"])
    const array = await instance.update([1])
    expect(array.ok).toBe(false)
  })

  test("serialises concurrent patches so none is lost", async () => {
    const instance = store()
    await Promise.all([
      instance.update({ profile: "one" }),
      instance.update({ maxSessionMinutes: 10 }),
      instance.update({ memory: { readLimit: 1 } }),
      instance.update({ uplift: { hitl: true } }),
    ])
    const { settings } = await instance.load()
    expect(settings.profile).toBe("one")
    expect(settings.maxSessionMinutes).toBe(10)
    expect(settings.memory.readLimit).toBe(1)
    expect(settings.uplift.hitl).toBe(true)
  })

  test("notifies listeners after a save, not after a refusal, and stops after unsubscribe", async () => {
    const instance = store()
    let calls = 0
    const stop = instance.changed(() => {
      calls++
    })
    instance.changed(() => {
      throw new Error("a broken subscriber")
    })
    await instance.update({ profile: "work" })
    expect(calls).toBe(1)
    await instance.update({ profile: "BAD NAME" })
    expect(calls).toBe(1)
    stop()
    await instance.update({ profile: "other" })
    expect(calls).toBe(1)
  })
})

describe("reset", () => {
  test("restores the defaults on disk and notifies", async () => {
    const instance = store()
    let calls = 0
    instance.changed(() => {
      calls++
    })
    await instance.update({ profile: "work", swarm: { mode: "off" } })
    const view = await instance.reset()
    expect(view.settings).toEqual(DEFAULT_OMP_SETTINGS)
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toEqual(DEFAULT_OMP_SETTINGS)
    expect(calls).toBe(2)
  })
})

describe("validateSettings", () => {
  let binary: string
  let ultrathink: string
  let swarm: string

  beforeEach(async () => {
    binary = path.join(root, "omp")
    await writeFile(binary, "#!/bin/sh\n")
    await chmod(binary, 0o755)
    ultrathink = path.join(root, "ultrathink")
    await mkdir(path.join(ultrathink, "bin"), { recursive: true })
    await writeFile(path.join(ultrathink, "bin", "run-bun"), "")
    swarm = path.join(root, "swarm")
    await mkdir(path.join(swarm, "omp"), { recursive: true })
    await writeFile(path.join(swarm, "omp", "package.json"), "{}")
  })

  const errorsFor = (patch: (settings: OmpSettings) => void) => validateSettings(withSettings(patch)).map((error) => error.path)

  test("the defaults are valid", () => {
    expect(validateSettings(DEFAULT_OMP_SETTINGS)).toEqual([])
  })

  test("accepts real checkouts and an executable binary", () => {
    expect(
      errorsFor((settings) => {
        settings.binary = binary
        settings.uplift.root = ultrathink
        settings.swarm.root = swarm
        settings.substrate.url = "http://127.0.0.1:8787"
        settings.memory.repo = "swcstudio/autonogrammer"
      }),
    ).toEqual([])
  })

  const table: Array<[string, (settings: OmpSettings) => void, string]> = [
    ["relative binary", (settings) => void (settings.binary = "bin/omp"), "binary"],
    ["binary with a .. segment", (settings) => void (settings.binary = "/usr/../bin/omp"), "binary"],
    ["binary with a NUL byte", (settings) => void (settings.binary = "/usr/bin/omp\u0000x"), "binary"],
    ["missing binary", (settings) => void (settings.binary = "/nonexistent/omp"), "binary"],
    ["directory as binary", (settings) => void (settings.binary = os.tmpdir()), "binary"],
    ["uppercase profile", (settings) => void (settings.profile = "Work"), "profile"],
    ["profile with a slash", (settings) => void (settings.profile = "a/b"), "profile"],
    ["profile starting with a dash", (settings) => void (settings.profile = "-x"), "profile"],
    ["33-character profile", (settings) => void (settings.profile = "a".repeat(33)), "profile"],
    ["approval mode", (settings) => void (settings.manualApproval = "yolo" as never), "manualApproval"],
    ["zero minutes", (settings) => void (settings.maxSessionMinutes = 0), "maxSessionMinutes"],
    ["1441 minutes", (settings) => void (settings.maxSessionMinutes = 1441), "maxSessionMinutes"],
    ["fractional minutes", (settings) => void (settings.maxSessionMinutes = 1.5), "maxSessionMinutes"],
    ["uplift timeout too short", (settings) => void (settings.uplift.timeoutMs = 9_999), "uplift.timeoutMs"],
    ["uplift timeout too long", (settings) => void (settings.uplift.timeoutMs = 1_800_001), "uplift.timeoutMs"],
    ["uplift root without bin/run-bun", (settings) => void (settings.uplift.root = root), "uplift.root"],
    ["relative uplift root", (settings) => void (settings.uplift.root = "ultrathink"), "uplift.root"],
    ["swarm root without omp/package.json", (settings) => void (settings.swarm.root = root), "swarm.root"],
    ["swarm root with ..", (settings) => void (settings.swarm.root = `${swarm}/../swarm`), "swarm.root"],
    ["swarm mode", (settings) => void (settings.swarm.mode = "sometimes" as never), "swarm.mode"],
    ["ttl", (settings) => void (settings.memory.ttl = "1y" as never), "memory.ttl"],
    ["negative read limit", (settings) => void (settings.memory.readLimit = -1), "memory.readLimit"],
    ["read limit 51", (settings) => void (settings.memory.readLimit = 51), "memory.readLimit"],
    ["repo without owner", (settings) => void (settings.memory.repo = "autonogrammer"), "memory.repo"],
    ["substrate url with credentials", (settings) => void (settings.substrate.url = "http://user:pass@host:8787"), "substrate.url"],
    ["substrate url with a username only", (settings) => void (settings.substrate.url = "https://token@host"), "substrate.url"],
    ["substrate url scheme", (settings) => void (settings.substrate.url = "file:///etc/passwd"), "substrate.url"],
    ["substrate url garbage", (settings) => void (settings.substrate.url = "not a url"), "substrate.url"],
  ]

  test.each(table)("rejects %s", (_name, mutate, field) => {
    expect(errorsFor(mutate)).toEqual([field])
  })

  test("never repeats a rejected URL's credentials in the message", () => {
    const [error] = validateSettings(withSettings((settings) => void (settings.substrate.url = "http://user:hunter2@host")))
    expect(error?.message).not.toContain("hunter2")
  })
})

describe("effectiveSources", () => {
  test("names the environment variable that stands in for an empty setting, never its value", () => {
    const sources = effectiveSources(DEFAULT_OMP_SETTINGS, {
      SUBSTRATE_URL: "http://secret-host",
      ULTRATHINK_SWARM_ROOT: "/x",
      OMP_PROFILE: "",
    })
    expect(sources["substrate.url"]).toEqual({ from: "env", env: "SUBSTRATE_URL" })
    expect(sources["swarm.root"]).toEqual({ from: "env", env: "ULTRATHINK_SWARM_ROOT" })
    expect(sources["uplift.root"]).toEqual({ from: "default" })
    expect(JSON.stringify(sources)).not.toContain("secret-host")
  })

  test("a value in the settings wins over the environment", () => {
    const settings = withSettings((value) => void (value.swarm.root = "/swarm"))
    expect(effectiveSources(settings, { SWARM_ROOT: "/other" })["swarm.root"]).toEqual({ from: "settings" })
  })

  test("the view carries the effective sources", async () => {
    const view = await store({ SUBSTRATE_URL: "http://x" }).view()
    expect(view.effective["substrate.url"]).toEqual({ from: "env", env: "SUBSTRATE_URL" })
  })
})

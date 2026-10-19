import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS, type OmpSettings } from "../../shared/omp"
import { HttpError } from "../host/respond"
import { ValidationFailure, childEnv, createConfig, defaultRun, firstLine, isSensitiveKey, parseListing, toEntry, type Run } from "./config"
import { resolveBinary } from "../omp/binary"
import { installFakeOmp } from "./fake-omp"

const LISTING = `Settings:

[appearance]
  theme.dark = dark-lavender (string)
  symbolPreset = nerd (unicode|nerd|ascii)
  statusLine.preset = default (default|minimal|compact|full|nerd|ascii|custom)
  colorBlindMode = false (boolean)

[internal]
  auth.broker.token = ******** (string)
  auth.broker.url = (not set) (string)
  enabledProviders = [] (array)
  modelRoles = {} (record)
  note = see docs (really) (string)
  compaction.thresholdPercent = -1 (number)
`

describe("parseListing", () => {
  const meta = parseListing(LISTING)

  test("assigns every row to the heading above it", () => {
    expect(meta.get("theme.dark")).toEqual({ type: "string", group: "appearance" })
    expect(meta.get("auth.broker.token")?.group).toBe("internal")
    expect(meta.size).toBe(10)
  })

  test("reads enum choices from the parenthesis", () => {
    expect(meta.get("symbolPreset")).toEqual({ type: "enum", group: "appearance", options: ["unicode", "nerd", "ascii"] })
    expect(meta.get("statusLine.preset")?.options).toHaveLength(7)
  })

  test("reads the type name for scalars, collections and unset values", () => {
    expect(meta.get("colorBlindMode")?.type).toBe("boolean")
    expect(meta.get("enabledProviders")?.type).toBe("array")
    expect(meta.get("modelRoles")?.type).toBe("record")
    expect(meta.get("compaction.thresholdPercent")?.type).toBe("number")
    expect(meta.get("auth.broker.url")?.type).toBe("string")
  })

  test("takes only the last parenthesis as the type", () => {
    expect(meta.get("note")).toEqual({ type: "string", group: "internal" })
  })

  test("ignores lines it does not understand instead of failing", () => {
    expect(parseListing("garbage\n  x = y\n[]\n").size).toBe(0)
    expect(parseListing("").size).toBe(0)
  })
})

describe("isSensitiveKey / toEntry", () => {
  test("flags credential-looking names", () => {
    for (const key of ["auth.broker.token", "searxng.basicPassword", "mnemopi.llmApiKey", "hindsight.apiToken", "images.urls.credentials"])
      expect(isSensitiveKey(key)).toBe(true)
    for (const key of ["theme.dark", "tools.approvalMode", "compaction.reserveTokens", "share.redactSecrets"])
      expect(isSensitiveKey(key)).toBe(false)
  })

  test("a redacted entry carries no value and is not editable", () => {
    const entry = toEntry("anything", { type: "string", description: "d", redacted: true, value: "hunter2" }, undefined)
    expect(entry).toMatchObject({ redacted: true, editable: false })
    expect(JSON.stringify(entry)).not.toContain("hunter2")
  })

  test("a credential-named entry is never echoed even when omp did not flag it", () => {
    const entry = toEntry("x.apiKey", { type: "string", value: "hunter2" }, undefined)
    expect(entry.redacted).toBe(true)
    expect(entry.value).toBeUndefined()
    expect(JSON.stringify(entry)).not.toContain("hunter2")
  })

  test("an unset credential is not 'set'", () => {
    const entry = toEntry("auth.broker.token", { type: "string", description: "" }, undefined)
    expect(entry.redacted).toBeUndefined()
    expect(entry.editable).toBe(false)
  })

  test("arrays and records are read-only; scalars editable", () => {
    expect(toEntry("a", { type: "array", value: [] }, undefined).editable).toBe(false)
    expect(toEntry("a", { type: "record", value: {} }, undefined).editable).toBe(false)
    expect(toEntry("a", { type: "boolean", value: true }, undefined)).toMatchObject({ editable: true, value: true })
  })

  test("falls back to the text listing's type, and to string for an unknown shape", () => {
    expect(toEntry("a", { description: "x" }, { type: "number" }).type).toBe("number")
    expect(toEntry("a", { type: "mystery" }, undefined).type).toBe("string")
    expect(toEntry("a", 7, undefined).type).toBe("string")
  })

  test("enum options come only from the listing", () => {
    expect(toEntry("a", { type: "enum", value: "x" }, { type: "enum", options: ["x", "y"], group: "g" })).toMatchObject({
      options: ["x", "y"],
      group: "g",
    })
    expect(toEntry("a", { type: "enum", value: "x" }, undefined).options).toBeUndefined()
  })
})

describe("firstLine / childEnv", () => {
  test("firstLine drops the Error prefix, blank lines and the rest", () => {
    expect(firstLine("\nError: Invalid value: x. Valid values: a, b\n\nRun `omp config list`")).toBe("Invalid value: x. Valid values: a, b")
    expect(firstLine("")).toBe("omp failed")
  })

  test("childEnv passes what omp needs to find its profile and nothing secret", () => {
    const env = childEnv({
      PATH: "/bin",
      HOME: "/home/u",
      PI_CODING_AGENT_DIR: "/x",
      SUBSTRATE_TOKEN: "dummy",
      SWARM_ED25519_KEY: "dummy",
      OPENROUTER_API_KEY: "dummy",
      ANTHROPIC_API_KEY: "dummy",
    })
    expect(Object.keys(env).sort()).toEqual(["HOME", "NO_COLOR", "PATH", "PI_CODING_AGENT_DIR", "TERM"])
  })
})

// The listing parser is otherwise tested against a hand-written fixture; this is the one place it meets omp's own output.
// Skipped when omp is not installed. HOME is a throwaway directory and the profile a made-up one, so the developer's profile is never read or written.
describe("against the installed omp", () => {
  const binary = resolveBinary({ binary: "" })
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "omp-config-real-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test.skipIf(!binary)(
    "`omp config list --json` and the text listing parse into complete, typed entries with options for enums",
    async () => {
      const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }
      const settings = { ...structuredClone(DEFAULT_OMP_SETTINGS), binary: binary ?? "", profile: "openflow-probe" }
      const entries = await createConfig({ run: defaultRun, env }).list(settings)
      expect(entries.length).toBeGreaterThan(100)

      const types = ["boolean", "number", "enum", "string", "array", "record"]
      for (const entry of entries) {
        expect(entry.key).not.toBe("")
        expect(types).toContain(entry.type)
      }
      // Enums are only recognisable from the text listing: the production parser must have found some, with choices.
      expect(entries.some((entry) => entry.type === "enum" && (entry.options?.length ?? 0) > 1)).toBe(true)
      // omp has been seen to print its text listing only partway when the machine is busy, so the parser is checked against
      // the first complete one of a few: every setting the JSON listing names must have a row.
      const missing = async () => {
        const text = await defaultRun(binary ?? "", ["--profile", "openflow-probe", "config", "list"], childEnv(env))
        const meta = parseListing(text.stdout)
        return entries.filter((entry) => !meta.has(entry.key)).map((entry) => entry.key)
      }
      let left = await missing()
      for (let attempt = 1; attempt < 5 && left.length > 0; attempt++) left = await missing()
      expect(left).toEqual([])
      // Credential-named settings come back without a value.
      for (const entry of entries.filter((candidate) => isSensitiveKey(candidate.key))) {
        expect(entry.value).toBeUndefined()
        expect(entry.editable).toBe(false)
      }
    },
    60_000,
  )
})

// The fake omp is a `#!` script and the suite spawns it as a process group: POSIX only.
describe.skipIf(process.platform === "win32")("against a real executable", () => {
  let dir: string
  let binary: string
  let settings: OmpSettings
  const env = { PATH: process.env.PATH, HOME: "/home/u", SUBSTRATE_TOKEN: "dummy-token", ANTHROPIC_API_KEY: "dummy-key" }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "omp-config-"))
    binary = await installFakeOmp(dir)
    settings = { ...structuredClone(DEFAULT_OMP_SETTINGS), binary }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const config = () => createConfig({ run: defaultRun, env })
  const calls = async () =>
    (await readFile(path.join(dir, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; leaked: string[] })

  test("lists entries with groups, enum options and editability", async () => {
    const entries = await config().list(settings)
    const by = Object.fromEntries(entries.map((entry) => [entry.key, entry]))
    expect(entries).toHaveLength(7)
    expect(by.symbolPreset).toMatchObject({ type: "enum", group: "appearance", options: ["unicode", "nerd", "ascii"], value: "unicode", editable: true })
    expect(by.colorBlindMode).toMatchObject({ type: "boolean", value: false })
    expect(by.enabledProviders).toMatchObject({ editable: false, group: "internal" })
    expect(by.modelRoles?.editable).toBe(false)
    expect(by["auth.broker.token"]).toMatchObject({ editable: false })
    expect(by["auth.broker.token"]?.redacted).toBeUndefined()
  })

  test("puts --profile before the subcommand, omits it for the default profile, and never leaks host secrets", async () => {
    await config().list({ ...settings, profile: "openflow" })
    await config().list({ ...settings, profile: "" })
    const seen = await calls()
    expect(seen.every((call) => call.leaked.length === 0)).toBe(true)
    const withProfile = seen.filter((call) => call.argv[0] === "--profile")
    expect(withProfile.length).toBeGreaterThan(0)
    expect(withProfile.every((call) => call.argv[1] === "openflow" && call.argv[2] === "config")).toBe(true)
    expect(seen.some((call) => call.argv[0] === "config")).toBe(true)
  })

  test("a set credential is shown as set and its value never appears", async () => {
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ "auth.broker.token": "sekrit-dummy" }))
    const entries = await config().list(settings)
    const token = entries.find((entry) => entry.key === "auth.broker.token")
    expect(token).toMatchObject({ redacted: true, editable: false })
    expect(JSON.stringify(entries)).not.toContain("sekrit-dummy")
  })

  test("sets an enum through argv with `--`, then re-reads it", async () => {
    const entry = await config().set(settings, "symbolPreset", "ascii")
    expect(entry).toMatchObject({ key: "symbolPreset", value: "ascii", options: ["unicode", "nerd", "ascii"] })
    const set = (await calls()).find((call) => call.argv.includes("set"))
    expect(set?.argv).toEqual(["--profile", "openflow", "config", "set", "symbolPreset", "--", "ascii"])
  })

  test("sets a negative number without it being read as a flag", async () => {
    const entry = await config().set(settings, "compaction.thresholdPercent", -5)
    expect(entry.value).toBe(-5)
  })

  test("sets a boolean and a string with a leading dash", async () => {
    expect((await config().set(settings, "colorBlindMode", true)).value).toBe(true)
    expect((await config().set(settings, "theme.dark", "-x -y")).value).toBe("-x -y")
  })

  test("resets a key to its default", async () => {
    await config().set(settings, "theme.dark", "mine")
    expect((await config().reset(settings, "theme.dark")).value).toBe("titanium")
  })

  const refused: Array<[string, string, unknown, string]> = [
    ["an enum value omp does not list", "symbolPreset", "braille", "must be one of unicode, nerd, ascii"],
    ["a string for a boolean", "colorBlindMode", "true", "expected true or false"],
    ["a string for a number", "compaction.thresholdPercent", "5", "expected a number"],
    ["NaN for a number", "compaction.thresholdPercent", Number.NaN, "expected a number"],
    ["a number for a string", "theme.dark", 5, "expected text"],
    ["NUL in a string", "theme.dark", "a\u0000b", "NUL"],
    ["an array entry", "enabledProviders", ["x"], "terminal"],
    ["a record entry", "modelRoles", {}, "terminal"],
    ["a credential", "auth.broker.token", "sekrit-dummy", "credential"],
  ]

  test.each(refused)("refuses %s with 422 before omp is asked to set anything", async (_name, key, value, message) => {
    const failure = await config().set(settings, key, value).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ValidationFailure)
    expect((failure as ValidationFailure).status).toBe(422)
    expect((failure as ValidationFailure).errors[0]?.path).toBe("value")
    expect((failure as ValidationFailure).message).toContain(message)
    expect((failure as ValidationFailure).message).not.toContain("sekrit-dummy")
    expect((await calls()).some((call) => call.argv.includes("set"))).toBe(false)
  })

  test("an unknown key is a 404 for set and reset", async () => {
    for (const run of [() => config().set(settings, "nope.key", 1), () => config().reset(settings, "nope.key")]) {
      const failure = await run().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(HttpError)
      expect((failure as HttpError).status).toBe(404)
    }
  })

  test("the text listing is read once per binary and again when the binary changes", async () => {
    const instance = config()
    await instance.list(settings)
    await instance.list(settings)
    const textListings = async () => (await calls()).filter((call) => call.argv.at(-1) === "list").length
    expect(await textListings()).toBe(1)
    const later = new Date(Date.now() + 60_000)
    await utimes(binary, later, later)
    await instance.list(settings)
    expect(await textListings()).toBe(2)
  })

  test("a missing binary is a 503", async () => {
    const failure = await config().list({ ...settings, binary: path.join(dir, "gone") }).catch((error: unknown) => error)
    expect((failure as HttpError).status).toBe(503)
  })
})

describe("with a fake runner", () => {
  const settings: OmpSettings = { ...structuredClone(DEFAULT_OMP_SETTINGS), binary: process.execPath }
  const listing = JSON.stringify({ "theme.dark": { type: "string", description: "", value: "x" } })
  const text = "[appearance]\n  theme.dark = x (string)\n"

  function runner(overrides: (args: string[]) => { code: number; stdout?: string; stderr?: string } | undefined): Run {
    return async (_binary, args) => {
      const custom = overrides(args)
      if (custom) return { code: custom.code, stdout: custom.stdout ?? "", stderr: custom.stderr ?? "" }
      if (args.includes("--json")) return { code: 0, stdout: listing, stderr: "" }
      return { code: 0, stdout: text, stderr: "" }
    }
  }

  test("a text listing cut short is not kept: groups and enum choices return, and a key past the cut can still be set", async () => {
    const json = JSON.stringify({
      "theme.dark": { type: "string", description: "", value: "x" },
      symbolPreset: { type: "enum", description: "", value: "nerd" },
    })
    const full = "[appearance]\n  theme.dark = x (string)\n  symbolPreset = nerd (unicode|nerd|ascii)\n"
    const cut = "[appearance]\n  theme.dark = x (string)\n"
    const texts = [cut]
    const sets: string[][] = []
    const run: Run = async (_binary, args) => {
      if (args.includes("--json")) return { code: 0, stdout: json, stderr: "" }
      if (args.includes("set")) {
        sets.push(args)
        return { code: 0, stdout: "", stderr: "" }
      }
      return { code: 0, stdout: texts.shift() ?? full, stderr: "" }
    }
    const config = createConfig({ env: { PATH: process.env.PATH }, run })

    const listed = await config.list(settings)
    expect(listed.find((entry) => entry.key === "symbolPreset")).toMatchObject({ type: "enum", group: "appearance", options: ["unicode", "nerd", "ascii"] })
    await config.set(settings, "symbolPreset", "ascii")
    expect(sets).toHaveLength(1)
  })

  test("omp rejecting a value is a 422 carrying its first line, never the value echoed on stdout", async () => {
    const config = createConfig({
      env: { PATH: process.env.PATH },
      run: runner((args) =>
        args.includes("set") ? { code: 1, stdout: "[ok] Set theme.dark = sekrit-dummy", stderr: "Error: Invalid value\nRun omp config list\n" } : undefined,
      ),
    })
    const failure = await config.set(settings, "theme.dark", "sekrit-dummy").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ValidationFailure)
    expect((failure as ValidationFailure).message).toBe("Invalid value")
  })

  test("a listing that is not JSON is a 502", async () => {
    const config = createConfig({ env: {}, run: runner((args) => (args.includes("--json") ? { code: 0, stdout: "<html>" } : undefined)) })
    const failure = await config.list(settings).catch((error: unknown) => error)
    expect((failure as HttpError).status).toBe(502)
  })

  test("a listing that is not an object is a 502", async () => {
    const config = createConfig({ env: {}, run: runner((args) => (args.includes("--json") ? { code: 0, stdout: "[]" } : undefined)) })
    const failure = await config.list(settings).catch((error: unknown) => error)
    expect((failure as HttpError).status).toBe(502)
  })

  test("a failing omp is a 502 with its first stderr line", async () => {
    const config = createConfig({ env: {}, run: runner((args) => (args.includes("--json") ? { code: 2, stderr: "boom\nmore" } : undefined)) })
    const failure = await config.list(settings).catch((error: unknown) => error)
    expect(failure).toMatchObject({ status: 502, message: "boom" })
  })

  test("a runner that cannot start omp is a 503", async () => {
    const config = createConfig({
      env: {},
      run: async () => {
        throw new Error("spawn ENOENT")
      },
    })
    const failure = await config.list(settings).catch((error: unknown) => error)
    expect(failure).toMatchObject({ status: 503, code: "omp-unavailable" })
  })

  test("degrades to no options and no group when the text listing is unreadable", async () => {
    const config = createConfig({ env: {}, run: runner((args) => (args.includes("--json") ? undefined : { code: 0, stdout: "???" })) })
    const [entry] = await config.list(settings)
    expect(entry).toMatchObject({ key: "theme.dark", type: "string", value: "x" })
    expect(entry?.group).toBeUndefined()
  })
})

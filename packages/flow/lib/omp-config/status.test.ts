import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS, MIN_OMP_VERSION, type OmpProviderRow, type OmpSettings } from "../../shared/omp"
import { resetOmpCheck } from "../omp/binary"
import { defaultRun, type Run } from "./config"
import { installFakeOmp } from "./fake-omp"
import type { Providers } from "./providers"
import { createStatusChecker } from "./status"

let dir: string

beforeEach(async () => {
  resetOmpCheck()
  dir = await mkdtemp(path.join(os.tmpdir(), "omp-status-"))
})

afterEach(async () => {
  resetOmpCheck()
  await rm(dir, { recursive: true, force: true })
})

const env = { PATH: process.env.PATH }

function providersOf(rows: OmpProviderRow[] | Error): Providers & { calls: number } {
  const fake = {
    calls: 0,
    async list() {
      fake.calls++
      if (rows instanceof Error) throw rows
      return rows
    },
    reset() {},
  }
  return fake
}

const row = (id: string, authenticated: boolean, available = true): OmpProviderRow => ({ id, name: id, available, authenticated })

async function settingsFor(version = "18.12.2"): Promise<OmpSettings> {
  return { ...structuredClone(DEFAULT_OMP_SETTINGS), binary: await installFakeOmp(dir, version) }
}

describe("createStatusChecker", () => {
  test("a healthy profile reports binary, version, config dir and provider counts with no problems", async () => {
    const providers = providersOf([row("anthropic", true), row("zai", false)])
    const status = await createStatusChecker({ run: defaultRun, env, providers }).status(await settingsFor())
    expect(status).toMatchObject({
      available: true,
      version: "18.12.2",
      minVersion: MIN_OMP_VERSION,
      profile: "openflow",
      configDir: path.join(dir, "profiles", "openflow", "agent"),
      providers: { authenticated: 1, total: 2 },
      problems: [],
    })
    expect(status.binary).toContain("omp")
  })

  test("a missing binary stops at the binary: no profile or provider probing", async () => {
    const providers = providersOf([])
    const status = await createStatusChecker({ run: defaultRun, env, providers }).status({
      ...structuredClone(DEFAULT_OMP_SETTINGS),
      binary: path.join(dir, "absent"),
    })
    expect(status.available).toBe(false)
    expect(status.problems.map((problem) => problem.code)).toEqual(["missing"])
    expect(providers.calls).toBe(0)
  })

  test("an old omp is reported as a version problem and not probed further", async () => {
    const providers = providersOf([])
    const status = await createStatusChecker({ run: defaultRun, env, providers }).status(await settingsFor("18.0.0"))
    expect(status.problems.map((problem) => problem.code)).toEqual(["version"])
    expect(status.problems[0]?.message).toContain("18.0.0")
    expect(providers.calls).toBe(0)
  })

  test("a profile with no authenticated provider says so and points at /login", async () => {
    const status = await createStatusChecker({ run: defaultRun, env, providers: providersOf([row("anthropic", false)]) }).status(
      await settingsFor(),
    )
    expect(status.available).toBe(true)
    expect(status.providers).toEqual({ authenticated: 0, total: 1 })
    expect(status.problems).toHaveLength(1)
    expect(status.problems[0]).toMatchObject({ code: "no-credentials" })
    expect(status.problems[0]?.message).toContain("openflow")
    expect(status.problems[0]?.fix).toContain("Copy logins")
    expect(status.problems[0]?.fix).toContain("/login")
  })

  test("names the default profile when none is configured", async () => {
    const status = await createStatusChecker({ run: defaultRun, env, providers: providersOf([]) }).status({
      ...(await settingsFor()),
      profile: "",
    })
    expect(status.problems[0]?.message).toContain("default profile")
    expect(status.configDir).toBe(path.join(dir, "profiles", "default", "agent"))
  })

  test("authenticated providers that cannot serve models are a no-models problem", async () => {
    const status = await createStatusChecker({ run: defaultRun, env, providers: providersOf([row("a", true, false)]) }).status(
      await settingsFor(),
    )
    expect(status.problems.map((problem) => problem.code)).toEqual(["no-models"])
  })

  test("a provider query that fails is a profile problem carrying only the first line of the error", async () => {
    const status = await createStatusChecker({ run: defaultRun, env, providers: providersOf(new Error("omp exited with 1\nstack...")) }).status(
      await settingsFor(),
    )
    expect(status.providers).toBeUndefined()
    expect(status.problems[0]).toMatchObject({ code: "profile" })
    expect(status.problems[0]?.message).toContain("omp exited with 1")
    expect(status.problems[0]?.message).not.toContain("stack")
  })

  test("a profile whose config path cannot be read is a profile problem", async () => {
    const run: Run = async (binary, args, runEnv) =>
      args.at(-1) === "path" ? { code: 1, stdout: "", stderr: "no" } : defaultRun(binary, args, runEnv)
    const status = await createStatusChecker({ run, env, providers: providersOf([row("a", true)]) }).status(await settingsFor())
    expect(status.configDir).toBeUndefined()
    expect(status.problems.map((problem) => problem.code)).toEqual(["profile"])
  })

  test("the config dir is read once per binary and profile until reset", async () => {
    let paths = 0
    const run: Run = async (binary, args, runEnv) => {
      if (args.at(-1) === "path") paths++
      return defaultRun(binary, args, runEnv)
    }
    const checker = createStatusChecker({ run, env, providers: providersOf([row("a", true)]) })
    const settings = await settingsFor()
    await checker.status(settings)
    await checker.status(settings)
    expect(paths).toBe(1)
    checker.reset()
    await checker.status(settings)
    expect(paths).toBe(2)
  })
})

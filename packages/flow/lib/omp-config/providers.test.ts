import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { stat } from "node:fs/promises"
import { DEFAULT_OMP_SETTINGS, type OmpSettings } from "../../shared/omp"
import { buildLaunch, PROBE_MODEL } from "../omp/launch"
import type { BuildLaunch, LaunchInput, LaunchSpec, OmpProcess, SpawnOmp } from "../omp/rpc-types"
import { createProviders, parseProviders } from "./providers"

afterEach(() => {
  setSystemTime()
})

const settings: OmpSettings = structuredClone(DEFAULT_OMP_SETTINGS)

type Harness = {
  spawns: number
  closes: number
  inputs: LaunchInput[]
  commands: Array<{ type: string }>
  spawn: SpawnOmp
  launch: BuildLaunch
}

/** A process that answers `get_login_providers` once `release()` is called (immediately when never held). */
function harness(options: { answer?: () => Promise<unknown>; env?: NodeJS.ProcessEnv } = {}): Harness {
  const state: Harness = {
    spawns: 0,
    closes: 0,
    inputs: [],
    commands: [],
    launch: (input) => {
      state.inputs.push(input)
      return { argv: [input.binary], env: {}, cwd: input.session.directory, files: [] } satisfies LaunchSpec
    },
    spawn: () => {
      state.spawns++
      const proc: Partial<OmpProcess> = {
        ready: Promise.resolve({ protocolVersion: 2 }),
        async command(command) {
          state.commands.push(command)
          return (await (options.answer?.() ??
            Promise.resolve({
              providers: [
                { id: "anthropic", name: "Anthropic", available: true, authenticated: true, label: "me@example.com", detail: "acct" },
                { id: "zai", name: "Z.AI", available: true, authenticated: false },
              ],
            }))) as never
        },
        async close() {
          state.closes++
        },
      }
      return proc as OmpProcess
    },
  }
  return state
}

describe("parseProviders", () => {
  test("keeps only the four known fields", () => {
    expect(parseProviders({ providers: [{ id: "a", name: "A", available: true, authenticated: false, email: "x@y.z", label: "x" }] })).toEqual([
      { id: "a", name: "A", available: true, authenticated: false },
    ])
  })

  test("drops rows without an id, defaults the name to the id and booleans to false", () => {
    expect(parseProviders({ providers: [{ name: "no id" }, null, { id: "b", available: "yes" }] })).toEqual([
      { id: "b", name: "b", available: false, authenticated: false },
    ])
  })

  test("refuses an answer with no providers list", () => {
    expect(() => parseProviders({})).toThrow("providers list")
    expect(() => parseProviders(null)).toThrow("providers list")
  })
})

describe("createProviders", () => {
  test("asks omp through a throwaway session and returns rows without account labels", async () => {
    const h = harness()
    const rows = await createProviders({ env: {}, spawn: h.spawn, launch: h.launch }).list(settings, "/usr/bin/omp")
    expect(rows).toEqual([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "zai", name: "Z.AI", available: true, authenticated: false },
    ])
    expect(JSON.stringify(rows)).not.toContain("example.com")
    expect(h.commands).toEqual([{ type: "get_login_providers" }])
    expect(h.closes).toBe(1)
  })

  test("launches with the configured settings and binary, and removes its scratch directory", async () => {
    const h = harness()
    await createProviders({ env: { PATH: "/bin" }, spawn: h.spawn, launch: h.launch }).list({ ...settings, profile: "work" }, "/opt/omp")
    const [input] = h.inputs
    expect(input?.binary).toBe("/opt/omp")
    expect(input?.settings.profile).toBe("work")
    expect(input?.env).toEqual({ PATH: "/bin" })
    expect(input?.session.permissions).toBe("auto")
    await expect(stat(input!.stateDir)).rejects.toThrow()
  })

  test("launches with --model set to the probe model, so omp starts on a profile with no default model", async () => {
    const h = harness()
    await createProviders({ env: { PATH: "/bin" }, spawn: h.spawn, launch: h.launch }).list(settings, "/opt/omp")
    const [input] = h.inputs
    expect(input?.session.model).toBe(PROBE_MODEL)
    const argv = buildLaunch(input as NonNullable<typeof input>).argv
    expect(argv[argv.indexOf("--model") + 1]).toBe(PROBE_MODEL)
  })

  test("serves the cache for 60 seconds, then asks again", async () => {
    const h = harness()
    const providers = createProviders({ env: {}, spawn: h.spawn, launch: h.launch })
    await providers.list(settings, "/opt/omp")
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(1)
    setSystemTime(new Date(Date.now() + 61_000))
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(2)
  })

  test("a different profile or binary is a different question; reset forgets the answer", async () => {
    const h = harness()
    const providers = createProviders({ env: {}, spawn: h.spawn, launch: h.launch })
    await providers.list(settings, "/opt/omp")
    await providers.list({ ...settings, profile: "other" }, "/opt/omp")
    await providers.list(settings, "/opt/other-omp")
    expect(h.spawns).toBe(3)
    providers.reset()
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(4)
  })

  test("a changed credential stamp asks omp again; an unchanged one is served from the cache", async () => {
    const h = harness()
    let stamp = "1:10|"
    const providers = createProviders({ env: {}, spawn: h.spawn, launch: h.launch, stamp: async () => stamp })
    await providers.list(settings, "/opt/omp")
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(1)
    stamp = "2:20|"
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(2)
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(2)
  })

  test("a stamp that throws counts as an empty stamp", async () => {
    const h = harness()
    let broken = true
    const providers = createProviders({
      env: {},
      spawn: h.spawn,
      launch: h.launch,
      async stamp() {
        if (broken) throw new Error("no profile directory")
        return ""
      },
    })
    await providers.list(settings, "/opt/omp")
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(1)
    broken = false
    await providers.list(settings, "/opt/omp")
    expect(h.spawns).toBe(1)
  })

  test("concurrent callers share one process", async () => {
    const gate = Promise.withResolvers<unknown>()
    const h = harness({ answer: () => gate.promise })
    const providers = createProviders({ env: {}, spawn: h.spawn, launch: h.launch })
    const both = Promise.all([providers.list(settings, "/opt/omp"), providers.list(settings, "/opt/omp")])
    gate.resolve({ providers: [{ id: "a", name: "A", available: true, authenticated: true }] })
    const [first, second] = await both
    expect(first).toBe(second)
    expect(h.spawns).toBe(1)
  })

  test("a failure closes the process, is not cached, and the next call tries again", async () => {
    let fail = true
    const h = harness({
      answer: async () => {
        if (fail) throw new Error("omp exited")
        return { providers: [{ id: "a", name: "A", available: true, authenticated: true }] }
      },
    })
    const providers = createProviders({ env: {}, spawn: h.spawn, launch: h.launch })
    await expect(providers.list(settings, "/opt/omp")).rejects.toThrow("omp exited")
    expect(h.closes).toBe(1)
    fail = false
    expect(await providers.list(settings, "/opt/omp")).toHaveLength(1)
    expect(h.spawns).toBe(2)
    expect(h.closes).toBe(2)
  })

  test("dispose kills the process of a probe in flight, the caller gets a 503, and later lists spawn nothing", async () => {
    const stuck = Promise.withResolvers<never>()
    const asked = Promise.withResolvers<void>()
    let kills = 0
    let spawns = 0
    const exited = Promise.withResolvers<void>()
    const providers = createProviders({
      env: {},
      launch: harness().launch,
      spawn: () => {
        spawns++
        return {
          ready: Promise.resolve({ protocolVersion: 2 }),
          exited: exited.promise as never,
          async command() {
            asked.resolve()
            return stuck.promise
          },
          kill() {
            kills++
            stuck.reject(new Error("omp was killed"))
            exited.resolve()
          },
          async close() {},
        } as Partial<OmpProcess> as OmpProcess
      },
    })
    const probing = providers.list(settings, "/opt/omp").then(
      () => undefined,
      (error: unknown) => error,
    )
    await asked.promise
    await providers.dispose()

    expect(kills).toBe(1)
    expect(await probing).toBeInstanceOf(Error)
    const later = await providers.list(settings, "/opt/omp").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(later).toMatchObject({ status: 503 })
    expect(spawns).toBe(1)
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_OMP_SETTINGS, OMP_ROUTES, type OmpConfigEntry, type OmpProviderRow, type OmpSettingsView, type OmpStatusView } from "../../shared/omp"
import { resetOmpCheck } from "../omp/binary"
import type { LaunchSpec, OmpProcess } from "../omp/rpc-types"
import { installFakeOmp } from "./fake-omp"
import { createOmpConfig, type OmpConfigModule } from "./index"

let dir: string
let stateDir: string
let module: OmpConfigModule
let server: ReturnType<typeof Bun.serve>
let spawns: number
let providerError: string | undefined

beforeEach(async () => {
  resetOmpCheck()
  dir = await mkdtemp(path.join(os.tmpdir(), "omp-routes-"))
  stateDir = path.join(dir, "state")
  await installFakeOmp(path.join(dir, "bin"))
  spawns = 0
  providerError = undefined
  module = createOmpConfig({
    stateDir: () => stateDir,
    env: { PATH: path.join(dir, "bin") },
    launch: (input) => ({ argv: [input.binary], env: {}, cwd: input.session.directory, files: [] }) satisfies LaunchSpec,
    spawn: () => {
      spawns++
      return {
        ready: Promise.resolve({ protocolVersion: 2 }),
        async command() {
          if (providerError) throw new Error(providerError)
          return {
            providers: [
              { id: "anthropic", name: "Anthropic", available: true, authenticated: true, label: "me@example.com" },
              { id: "zai", name: "Z.AI", available: true, authenticated: false },
            ],
          } as never
        },
        async close() {},
      } as Partial<OmpProcess> as OmpProcess
    },
  })
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      return (await module.handle(request)) ?? new Response("unhandled", { status: 418 })
    },
  })
})

afterEach(async () => {
  await server.stop(true)
  resetOmpCheck()
  await rm(dir, { recursive: true, force: true })
})

const call = (route: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${route}`, init)
const send = (route: string, method: string, body?: unknown) =>
  call(route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
const configRoute = (key: string) => `${OMP_ROUTES.config}/${encodeURIComponent(key)}`

describe("settings routes", () => {
  test("GET returns the defaults and where empty values would come from, creating no file", async () => {
    const response = await call(OMP_ROUTES.settings)
    expect(response.status).toBe(200)
    const view = (await response.json()) as OmpSettingsView
    expect(view.settings).toEqual(DEFAULT_OMP_SETTINGS)
    expect(view.warnings).toEqual([])
    expect(view.effective.binary).toEqual({ from: "default" })
    await expect(stat(stateDir)).rejects.toThrow()
  })

  test("PUT merges a patch, persists it, and notifies listeners", async () => {
    let notified = 0
    module.changed(() => {
      notified++
    })
    const response = await send(OMP_ROUTES.settings, "PUT", { profile: "work", memory: { readLimit: 2 } })
    expect(response.status).toBe(200)
    const view = (await response.json()) as OmpSettingsView
    expect(view.settings.profile).toBe("work")
    expect(view.settings.memory.readLimit).toBe(2)
    expect(view.settings.memory.ttl).toBe(DEFAULT_OMP_SETTINGS.memory.ttl)
    expect(notified).toBe(1)
    expect(JSON.parse(await readFile(path.join(stateDir, "omp-settings.json"), "utf8")).profile).toBe("work")
    expect((await module.settings()).profile).toBe("work")
  })

  test("PUT answers 422 with dotted paths for every invalid field and saves nothing", async () => {
    const response = await send(OMP_ROUTES.settings, "PUT", {
      maxSessionMinutes: 0,
      uplift: { timeoutMs: 5 },
      substrate: { url: "http://u:p@host" },
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { errors: Array<{ path: string; message: string }> }
    expect(body.errors.map((error) => error.path).sort()).toEqual(["maxSessionMinutes", "substrate.url", "uplift.timeoutMs"])
    await expect(stat(path.join(stateDir, "omp-settings.json"))).rejects.toThrow()
  })

  test("PUT answers 400 for a body that is not JSON", async () => {
    const response = await call(OMP_ROUTES.settings, { method: "PUT", headers: { "content-type": "application/json" }, body: "{nope" })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe("bad-json")
  })

  test("PUT refuses a body that is not declared application/json, and saves nothing", async () => {
    const response = await call(OMP_ROUTES.settings, { method: "PUT", headers: { "content-type": "text/plain" }, body: JSON.stringify({ maxSessionMinutes: 5 }) })
    expect(response.status).toBe(403)
    const body: { code: string } = await response.json()
    expect(body.code).toBe("forbidden-content-type")
    await expect(stat(path.join(stateDir, "omp-settings.json"))).rejects.toThrow()
  })

  test("PUT answers 422 for JSON that is not an object", async () => {
    expect((await send(OMP_ROUTES.settings, "PUT", [1])).status).toBe(422)
  })

  test("POST settingsReset restores the defaults", async () => {
    await send(OMP_ROUTES.settings, "PUT", { profile: "work" })
    const response = await send(OMP_ROUTES.settingsReset, "POST")
    expect(response.status).toBe(200)
    expect(((await response.json()) as OmpSettingsView).settings).toEqual(DEFAULT_OMP_SETTINGS)
  })

  test("a corrupt file is reported as a warning in settings and status", async () => {
    await send(OMP_ROUTES.settings, "PUT", { profile: "work" })
    await Bun.write(path.join(stateDir, "omp-settings.json"), "{ nope")
    const view = (await (await call(OMP_ROUTES.settings)).json()) as OmpSettingsView
    expect(view.warnings[0]).toContain("omp-settings.json.bad")
    const status = (await (await call(OMP_ROUTES.status)).json()) as OmpStatusView
    expect(status.warnings).toHaveLength(1)
  })

  test("methods a route does not take are 405 with an Allow header", async () => {
    const response = await send(OMP_ROUTES.settingsReset, "GET")
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    expect((await send(OMP_ROUTES.settings, "DELETE")).status).toBe(405)
  })

  test("paths that are not this module's are left to the next handler", async () => {
    expect(await module.handle(new Request("http://x/flow/api/other"))).toBeUndefined()
    expect((await call("/flow/api/other")).status).toBe(418)
  })
})

// These run the fake omp (a `#!` script) for real: POSIX only.
describe.skipIf(process.platform === "win32")("status route", () => {
  test("reports the binary found on PATH, its config dir and provider counts", async () => {
    const response = await call(OMP_ROUTES.status)
    expect(response.status).toBe(200)
    const status = (await response.json()) as OmpStatusView
    expect(status).toMatchObject({
      available: true,
      version: "18.12.2",
      profile: "openflow",
      configDir: path.join(dir, "bin", "profiles", "openflow", "agent"),
      providers: { authenticated: 1, total: 2 },
      problems: [],
      warnings: [],
    })
    expect(JSON.stringify(status)).not.toContain("example.com")
    expect(await module.status()).toMatchObject({ available: true })
  })

  test("a binary setting that stops resolving becomes a missing problem once settings change", async () => {
    const put = await send(OMP_ROUTES.settings, "PUT", { binary: path.join(dir, "bin", "omp") })
    expect(put.status).toBe(200)
    await rm(path.join(dir, "bin", "omp"))
    const status = (await (await call(OMP_ROUTES.status)).json()) as OmpStatusView
    expect(status.available).toBe(false)
    expect(status.problems[0]?.code).toBe("missing")
  })

  test("saving settings drops the cached provider answer", async () => {
    await call(OMP_ROUTES.status)
    await call(OMP_ROUTES.status)
    expect(spawns).toBe(1)
    await send(OMP_ROUTES.settings, "PUT", { profile: "other" })
    await call(OMP_ROUTES.status)
    expect(spawns).toBe(2)
  })
})

describe.skipIf(process.platform === "win32")("config routes", () => {
  test("GET lists omp's entries with groups and enum options", async () => {
    const response = await call(OMP_ROUTES.config)
    expect(response.status).toBe(200)
    const { entries } = (await response.json()) as { entries: OmpConfigEntry[] }
    expect(entries.find((entry) => entry.key === "symbolPreset")).toMatchObject({
      group: "appearance",
      options: ["unicode", "nerd", "ascii"],
      editable: true,
    })
  })

  test("PUT /<key> sets through omp and answers the re-read entry", async () => {
    const response = await send(configRoute("symbolPreset"), "PUT", { value: "nerd" })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { entry: OmpConfigEntry }).entry).toMatchObject({ key: "symbolPreset", value: "nerd" })
  })

  test("PUT accepts a dotted key whose segments contain no slash", async () => {
    const response = await send(configRoute("compaction.thresholdPercent"), "PUT", { value: 10 })
    expect(((await response.json()) as { entry: OmpConfigEntry }).entry.value).toBe(10)
  })

  test("PUT answers 422 with a value error for a bad enum, a list and a credential", async () => {
    for (const [key, value] of [
      ["symbolPreset", "braille"],
      ["enabledProviders", []],
      ["auth.broker.token", "sekrit-dummy"],
    ] as const) {
      const response = await send(configRoute(key), "PUT", { value })
      expect(response.status).toBe(422)
      const body = (await response.json()) as { errors: Array<{ path: string; message: string }> }
      expect(body.errors[0]?.path).toBe("value")
      expect(JSON.stringify(body)).not.toContain("sekrit-dummy")
    }
  })

  test("PUT answers 400 when the body has no value, and 404 for a key omp does not have", async () => {
    expect((await send(configRoute("symbolPreset"), "PUT", { nope: 1 })).status).toBe(400)
    expect((await send(configRoute("symbolPreset"), "PUT", "x")).status).toBe(400)
    const unknown = await send(configRoute("no.such.key"), "PUT", { value: 1 })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { code: string }).code).toBe("unknown-key")
  })

  test("a malformed percent-escape in the key is a 400", async () => {
    expect((await send(`${OMP_ROUTES.config}/%E0%A4%A`, "PUT", { value: 1 })).status).toBe(400)
  })

  test("POST /<key>/reset restores omp's default", async () => {
    await send(configRoute("theme.dark"), "PUT", { value: "mine" })
    const response = await send(`${configRoute("theme.dark")}/reset`, "POST")
    expect(response.status).toBe(200)
    expect(((await response.json()) as { entry: OmpConfigEntry }).entry.value).toBe("titanium")
  })

  test("wrong methods and unknown sub-paths", async () => {
    expect((await call(configRoute("theme.dark"))).status).toBe(405)
    expect((await call(`${configRoute("theme.dark")}/reset`)).status).toBe(405)
    expect((await send(`${configRoute("theme.dark")}/other`, "POST")).status).toBe(404)
  })

  test("omp missing is a 503 on every config route", async () => {
    await send(OMP_ROUTES.settings, "PUT", { binary: path.join(dir, "bin", "omp") })
    await rm(path.join(dir, "bin", "omp"))
    expect((await call(OMP_ROUTES.config)).status).toBe(503)
    expect((await send(configRoute("theme.dark"), "PUT", { value: "x" })).status).toBe(503)
  })
})

describe.skipIf(process.platform === "win32")("providers route", () => {
  test("lists rows without account labels", async () => {
    const response = await call(OMP_ROUTES.providers)
    expect(response.status).toBe(200)
    const { providers } = (await response.json()) as { providers: OmpProviderRow[] }
    expect(providers).toEqual([
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "zai", name: "Z.AI", available: true, authenticated: false },
    ])
  })

  test("a failing omp session is a 502", async () => {
    providerError = "omp exited"
    const response = await call(OMP_ROUTES.providers)
    expect(response.status).toBe(502)
    expect(((await response.json()) as { error: string }).error).toContain("omp exited")
  })
})

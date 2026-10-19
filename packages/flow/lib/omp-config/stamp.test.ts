import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OMP_ROUTES } from "../../shared/omp"
import { resetOmpCheck } from "../omp/binary"
import { buildLaunch } from "../omp/launch"
import type { OmpProcess, SpawnOmp } from "../omp/rpc-types"
import { credentialStamp, readStamp } from "../omp/stamp"
import { installFakeOmp } from "./fake-omp"
import { createOmpConfig } from "./index"

let dir: string
let profileDir: string

beforeEach(async () => {
  resetOmpCheck()
  dir = await mkdtemp(path.join(os.tmpdir(), "omp-stamp-"))
  // Where the fake omp's `config path` points for the default settings' profile.
  profileDir = path.join(dir, "profiles", "openflow", "agent")
  await mkdir(profileDir, { recursive: true })
})

afterEach(async () => {
  resetOmpCheck()
  await rm(dir, { recursive: true, force: true })
})

describe("credentialStamp", () => {
  test("no directory or no files is an empty stamp; each file contributes its own part", async () => {
    expect(await credentialStamp(undefined)).toBe("")
    expect(await credentialStamp(path.join(dir, "missing"))).toBe("|")
    expect(await credentialStamp(profileDir)).toBe("|")

    await writeFile(path.join(profileDir, "agent.db"), "abc")
    const db = await credentialStamp(profileDir)
    expect(db).toMatch(/^[\d.]+:3\|$/)

    await writeFile(path.join(profileDir, "agent.db-wal"), "wxyz")
    const both = await credentialStamp(profileDir)
    expect(both).toMatch(/^[\d.]+:3\|[\d.]+:4$/)
    expect(both).not.toBe(db)
  })

  test("a rewrite changes the stamp through size or mtime alone", async () => {
    const file = path.join(profileDir, "agent.db")
    await writeFile(file, "abc")
    const first = await credentialStamp(profileDir)
    await writeFile(file, "abcd")
    const grown = await credentialStamp(profileDir)
    expect(grown).not.toBe(first)
    await utimes(file, new Date(1_000_000), new Date(1_000_000))
    expect(await credentialStamp(profileDir)).not.toBe(grown)
  })

  test("readStamp is the empty stamp when none is wired or the stamp throws", async () => {
    expect(await readStamp(undefined)).toBe("")
    expect(
      await readStamp(async () => {
        throw new Error("boom")
      }),
    ).toBe("")
    expect(
      await readStamp(() => {
        throw new Error("sync boom")
      }),
    ).toBe("")
    expect(await readStamp(async () => "x")).toBe("x")
  })
})

describe("the omp-config module's stamp", () => {
  async function start() {
    await installFakeOmp(dir)
    let spawns = 0
    const spawn: SpawnOmp = () => {
      spawns++
      return {
        ready: Promise.resolve({ protocolVersion: 2 }),
        async command() {
          return { providers: [{ id: "anthropic", name: "Anthropic", available: true, authenticated: true }] } as never
        },
        async close() {},
      } as Partial<OmpProcess> as OmpProcess
    }
    const module = createOmpConfig({ stateDir: () => path.join(dir, "state"), env: { PATH: dir }, spawn, launch: buildLaunch })
    return { module, spawns: () => spawns }
  }

  const configPathCalls = async () =>
    (await readFile(path.join(dir, "calls.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"path"')).length

  test("follows the profile's agent.db and does not ask omp for the directory twice", async () => {
    const { module } = await start()
    const empty = await module.stamp()
    expect(empty).toBe("|")
    await writeFile(path.join(profileDir, "agent.db"), "login")
    const stamped = await module.stamp()
    expect(stamped).not.toBe(empty)
    expect(await module.stamp()).toBe(stamped)
    expect(await configPathCalls()).toBe(1)
  })

  test("the provider list stamps itself without calling back into status: no deadlock, one config path lookup", async () => {
    const { module, spawns } = await start()
    // status -> providers.list -> stamp -> config directory (cached) never settles if the stamp calls status(); the test timeout fails it.
    const status = await module.status()
    expect(status.providers).toEqual({ authenticated: 1, total: 1 })
    expect(status.configDir).toBe(profileDir)
    expect(spawns()).toBe(1)

    // Concurrent status checks and stamps share the lookup and one provider process.
    await Promise.all([module.status(), module.status(), module.stamp(), module.stamp()])
    expect(spawns()).toBe(1)
    expect(await configPathCalls()).toBe(1)
  })

  test("a login that rewrites agent.db makes the next status ask omp for the providers again", async () => {
    const { module, spawns } = await start()
    await module.status()
    await module.status()
    expect(spawns()).toBe(1)
    await writeFile(path.join(profileDir, "agent.db"), "login from the terminal")
    await module.status()
    expect(spawns()).toBe(2)
    await module.status()
    expect(spawns()).toBe(2)
  })

  test("an omp that cannot be found stamps empty without spawning anything", async () => {
    const missing = createOmpConfig({
      stateDir: () => path.join(dir, "state-2"),
      env: { PATH: path.join(dir, "no-omp-here") },
      spawn: () => {
        throw new Error("never spawned")
      },
      launch: buildLaunch,
    })
    expect(await missing.stamp()).toBe("")
  })

  test("Copy logins tells loginsChanged listeners; a refused copy does not", async () => {
    const { module } = await start()
    await writeFile(path.join(dir, "credentials.json"), JSON.stringify({ version: 1, credentials: [{ provider: "zai", credential: { type: "api_key", key: "k" } }] }))
    let notified = 0
    const stop = module.loginsChanged(() => {
      notified++
    })
    const post = () => module.handle(new Request(`http://flow.test${OMP_ROUTES.authImport}`, { method: "POST" }))

    await writeFile(path.join(dir, "fail-export"), "on")
    expect((await post())?.status).toBe(400)
    expect(notified).toBe(0)

    await rm(path.join(dir, "fail-export"))
    expect((await post())?.status).toBe(200)
    expect(notified).toBe(1)

    stop()
    expect((await post())?.status).toBe(200)
    expect(notified).toBe(1)
  })
})

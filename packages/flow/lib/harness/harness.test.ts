import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHarnessModule } from "./routes"
import { cardsBlockedByPlugins, validatePlugins } from "./plugins"
import { readGsdHealth } from "./gsd"
import { secretsPath } from "./secrets"

describe("harness", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  test("gsd-core health reads a version file and reports a missing install", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-gsd-"))
    dirs.push(dir)
    const file = path.join(dir, "VERSION")
    await fs.writeFile(file, "1.16.0\n")
    expect(await readGsdHealth({ GSD_CORE_VERSION_FILE: file })).toMatchObject({ installed: true, version: "1.16.0", health: "ok" })
    expect(await readGsdHealth({ GSD_CORE_VERSION_FILE: path.join(dir, "missing") })).toMatchObject({ installed: false, health: "missing" })
  })

  test("a bad plugin config is a field error and only blocks the card that requires it", () => {
    const bad = validatePlugins([{ id: "ok", enabled: true, config: { apiKey: "nope" } }])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.fields[0]?.path).toBe("plugins.0.config.apiKey")
    const good = validatePlugins([
      { id: "swarm", enabled: false, config: { rounds: 1 } },
      { id: "ultrathink", enabled: true, cardId: "other", config: {} },
    ])
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(cardsBlockedByPlugins(good.plugins, [
      { cardId: "card-a", pluginId: "swarm" },
      { cardId: "card-b", pluginId: "ultrathink" },
    ]).map((row) => row.cardId)).toEqual(["card-a", "card-b"])
  })

  test("secrets are written outside workflow JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-sec-"))
    dirs.push(dir)
    const env = { AUTONOGRAMMER_DATA_DIR: dir }
    const response = await createHarnessModule({ env }).handle(
      new Request("http://127.0.0.1/flow/api/harness/secrets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "card", token: "super-secret", nested: { api_key: "k" } }),
      }),
    )
    expect(response?.status).toBe(200)
    const body = (await response!.json()) as { workflow: { token?: string; nested: { api_key?: string } } }
    expect(body.workflow.token).toBeUndefined()
    expect(body.workflow.nested.api_key).toBeUndefined()
    const stored = JSON.parse(await fs.readFile(secretsPath(env), "utf8")) as Record<string, string>
    expect(stored.token).toBe("super-secret")
    expect(stored["nested.api_key"]).toBe("k")
    expect((await fs.stat(secretsPath(env))).mode & 0o777).toBe(0o600)
  })
})

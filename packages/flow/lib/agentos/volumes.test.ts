import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { durableCreateOptions } from "../../shared/agentos"
import { cardVolumePath } from "./paths"
import { agentOsRoutes } from "./routes"
import { createVolumes, type AgentOsFactory, type AgentOsVm } from "./volumes"

function factory(): AgentOsFactory & { disks: Map<string, Map<string, Uint8Array>> } {
  const disks = new Map<string, Map<string, Uint8Array>>()
  return {
    disks,
    async create(options): Promise<AgentOsVm> {
      const disk = disks.get(options.database.path) ?? new Map()
      disks.set(options.database.path, disk)
      return {
        filesystem: {
          async writeFile(file, data) {
            disk.set(file, typeof data === "string" ? new TextEncoder().encode(data) : data)
          },
          async readFile(file) {
            const found = disk.get(file)
            if (!found) throw new Error(`missing ${file}`)
            return found
          },
        },
        async dispose() {},
      }
    },
  }
}

describe("agentos volumes", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  test("one sqlite path per card survives restart and is not readable from another card", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-os-"))
    dirs.push(dir)
    const env = { ...process.env, AUTONOGRAMMER_DATA_DIR: dir }
    const fake = factory()
    const volumes = createVolumes({ env, factory: fake })
    const a = await volumes.start("card-a")
    const b = await volumes.start("card-b")
    expect(a.volume).toBe(cardVolumePath("card-a", env))
    expect(b.volume).not.toBe(a.volume)
    expect(durableCreateOptions(a.volume).rootFilesystem.plugin.id).toBe("chunked_sqlite")
    await volumes.writeFile("card-a", "/home/agentos/note.txt", "only-a")
    await expect(volumes.readFile("card-b", "/home/agentos/note.txt")).rejects.toThrow(/missing/)
    await volumes.restart("card-a")
    expect(await volumes.readFile("card-a", "/home/agentos/note.txt")).toBe("only-a")
    await expect(volumes.destroy("card-a", false)).rejects.toThrow(/confirm/)
    await volumes.destroy("card-a", true)
    await expect(fs.stat(a.volume)).rejects.toThrow()
    expect(volumes.view("card-b").mounted).toBe(true)
  })

  test("a boot failure marks that card failed and leaves the sibling mounted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-os-"))
    dirs.push(dir)
    let calls = 0
    const base = factory()
    const volumes = createVolumes({
      env: { AUTONOGRAMMER_DATA_DIR: dir },
      factory: {
        async create(options) {
          calls += 1
          if (calls === 1) throw new Error("sidecar missing")
          return base.create(options)
        },
      },
    })
    const failed = await volumes.start("card-a")
    const ok = await volumes.start("card-b")
    expect(failed.phase).toBe("failed")
    expect(failed.error).toMatch(/sidecar missing/)
    expect(ok.phase).toBe("mounted")
  })

  test("routes refuse a destroy without confirm", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ag-os-"))
    dirs.push(dir)
    const volumes = createVolumes({ env: { AUTONOGRAMMER_DATA_DIR: dir }, factory: factory() })
    await volumes.start("card-a")
    const refused = await agentOsRoutes(volumes)(
      new Request("http://127.0.0.1/flow/api/agentos/cards/card-a/destroy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: false }),
      }),
    )
    expect(refused?.status).toBe(400)
    expect(volumes.view("card-a").mounted).toBe(true)
  })

  test("rejects a card id that escapes the data directory", () => {
    expect(() => cardVolumePath("../etc/passwd", { AUTONOGRAMMER_DATA_DIR: "/tmp/ag" })).toThrow(/card id/)
  })
})

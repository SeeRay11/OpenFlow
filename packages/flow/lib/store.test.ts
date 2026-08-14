import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { backupConfig, flowPaths, handleFlow, slug, type FlowPaths } from "./store"

/**
 * This is the surface that writes to a user's real repository — pipelines, run
 * logs, and a merge into their opencode.json — so it is tested against a real
 * temporary directory rather than a mocked filesystem.
 */

let dir: string
let paths: FlowPaths

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-store-"))
  paths = flowPaths(dir)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const read = (file: string) => fs.readFile(file, "utf8")

function call(method: string, route: string, options: { body?: unknown; search?: string } = {}) {
  return handleFlow(paths, {
    method,
    path: route,
    search: new URLSearchParams(options.search ?? ""),
    json: async () => options.body ?? {},
  })
}

const graph = { id: "p1", name: "feature-build", nodes: [{ id: "n1" }], edges: [] }

describe("slug", () => {
  test("cannot climb out of its directory", () => {
    expect(slug("../../etc/passwd")).toBe("etcpasswd")
    expect(slug("..\\..\\windows\\system32")).toBe("windowssystem32")
    expect(slug("/absolute/path")).toBe("absolutepath")
  })

  test("keeps ordinary names readable", () => {
    expect(slug("feature-build")).toBe("feature-build")
    expect(slug("my pipeline")).toBe("my-pipeline")
    expect(slug("v1.2")).toBe("v1.2")
  })

  test("falls back rather than producing an empty name", () => {
    expect(slug("...")).toBe("untitled")
    expect(slug("   ")).toBe("untitled")
  })
})

describe("routing", () => {
  test("reports where everything lives", async () => {
    const result = await call("GET", "/flow/api/context")
    expect(result).toEqual({ status: 200, body: paths })
  })

  test("works with or without the prefix", async () => {
    expect(await call("GET", "context")).toEqual({ status: 200, body: paths })
  })

  test("falls through on anything it does not own", async () => {
    expect(await call("GET", "/flow/api/nonsense")).toBeUndefined()
    expect(await call("PATCH", "/flow/api/pipelines/x")).toBeUndefined()
  })
})

describe("env", () => {
  const NAME = "OPENFLOW_TEST_PROVIDER_KEY"

  afterEach(() => {
    delete process.env[NAME]
  })

  test("answers with the asked-for names that are set, and only those", async () => {
    process.env[NAME] = "sk-secret"
    const result = await call("GET", "/flow/api/env", { search: `names=${NAME},MISSING_KEY` })
    expect(result).toEqual({ status: 200, body: { present: [NAME] } })
  })

  test("never returns a value, or a variable nobody asked about", async () => {
    process.env[NAME] = "sk-secret"
    const result = await call("GET", "/flow/api/env", { search: "names=MISSING_KEY" })
    expect(result!.body).toEqual({ present: [] })
    expect(JSON.stringify(result)).not.toContain("sk-secret")
  })

  test("an empty variable does not count as set", async () => {
    process.env[NAME] = ""
    const result = await call("GET", "/flow/api/env", { search: `names=${NAME}` })
    expect(result!.body).toEqual({ present: [] })
  })

  test("no names asked, nothing answered", async () => {
    expect(await call("GET", "/flow/api/env")).toEqual({ status: 200, body: { present: [] } })
  })
})

describe("pipelines", () => {
  test("saves and reads one back", async () => {
    const saved = await call("PUT", "/flow/api/pipelines/feature-build", { body: graph })
    expect(saved!.status).toBe(200)

    const loaded = await call("GET", "/flow/api/pipelines/feature-build")
    expect(loaded).toEqual({ status: 200, body: graph })
  })

  test("404s for one that was never written", async () => {
    const result = await call("GET", "/flow/api/pipelines/ghost")
    expect(result!.status).toBe(404)
  })

  test("lists newest first, with the node count", async () => {
    await call("PUT", "/flow/api/pipelines/one", { body: graph })
    await call("PUT", "/flow/api/pipelines/two", { body: { ...graph, nodes: [{ id: "a" }, { id: "b" }] } })

    const list = (await call("GET", "/flow/api/pipelines"))!.body as any[]
    expect(list.map((entry) => entry.name).sort()).toEqual(["one", "two"])
    expect(list.find((entry) => entry.name === "two").nodes).toBe(2)
  })

  test("lists nothing before anything is saved", async () => {
    expect((await call("GET", "/flow/api/pipelines"))!.body).toEqual([])
  })

  test("deletes", async () => {
    await call("PUT", "/flow/api/pipelines/gone", { body: graph })
    await call("DELETE", "/flow/api/pipelines/gone")
    expect((await call("GET", "/flow/api/pipelines/gone"))!.status).toBe(404)
  })

  test("keeps a traversing name inside the pipelines directory", async () => {
    const result = await call("PUT", `/flow/api/pipelines/${encodeURIComponent("../../evil")}`, { body: graph })

    expect((result!.body as any).path).toBe(path.join(paths.pipelines, "evil.json"))
    await expect(read(path.join(dir, "..", "evil.json"))).rejects.toThrow()
  })

  test("survives a file that is not valid JSON", async () => {
    await fs.mkdir(paths.pipelines, { recursive: true })
    await fs.writeFile(path.join(paths.pipelines, "broken.json"), "{not json")

    const list = (await call("GET", "/flow/api/pipelines"))!.body as any[]
    expect(list[0]).toMatchObject({ name: "broken", nodes: 0 })
  })
})

describe("runs", () => {
  const log = { id: "run-1", pipeline: "feature-build", status: "done", started: 10, finished: 20 }

  test("writes and reads a run log", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    expect((await call("GET", "/flow/api/runs/run-1"))!.body).toEqual(log)
  })

  test("lists with the status and timings", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    await call("PUT", "/flow/api/runs/run-2", { body: { ...log, id: "run-2", started: 30 } })

    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list.map((entry) => entry.id)).toEqual(["run-2", "run-1"])
    expect(list[0]).toMatchObject({ pipeline: "feature-build", status: "done" })
  })

  test("404s for a run that does not exist", async () => {
    expect((await call("GET", "/flow/api/runs/ghost"))!.status).toBe(404)
  })
})

describe("agents", () => {
  const agent = { agent: { "feature-build-planner": { mode: "primary", prompt: "plan" } } }

  test("writes only the generated block unless a merge is asked for", async () => {
    const result = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent })

    expect(result!.body).toMatchObject({ merged: false })
    const written = JSON.parse(await read(path.join(paths.generated, "feature-build.opencode.json")))
    expect(written.agent).toEqual(agent.agent)
    await expect(read(path.join(dir, "opencode.json"))).rejects.toThrow()
  })

  test("merge creates the config when the project has none", async () => {
    const result = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    expect(result!.body).toMatchObject({ merged: true, backup: undefined })
    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.agent).toEqual(agent.agent)
  })

  test("merge keeps what the project already had", async () => {
    await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ model: "opencode/x", agent: { mine: {} } }))

    await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.model).toBe("opencode/x")
    expect(Object.keys(config.agent).sort()).toEqual(["feature-build-planner", "mine"])
  })

  test("a second merge does not overwrite the original backup", async () => {
    const target = path.join(dir, "opencode.json")
    await fs.writeFile(target, JSON.stringify({ agent: { mine: {} } }))

    await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })
    const second = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    expect(second!.body).toMatchObject({ backup: `${target}.prev.bak` })
    expect(JSON.parse(await read(`${target}.bak`)).agent).toEqual({ mine: {} })
  })

  test("refuses to merge into a config it cannot parse", async () => {
    await fs.writeFile(path.join(dir, "opencode.json"), "{not json")

    const result = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    expect(result!.body).toMatchObject({ merged: false, error: expect.stringContaining("not valid JSON") })
    expect(await read(path.join(dir, "opencode.json"))).toBe("{not json")
  })
})

describe("backupConfig", () => {
  test("puts the first copy in .bak and later ones in .prev.bak", async () => {
    // .bak is the config as it was before OpenFlow first touched it. Losing it
    // is quiet, because a project's opencode.json is usually gitignored.
    const target = path.join(dir, "opencode.json")

    expect(await backupConfig(target, "original")).toBe(`${target}.bak`)
    expect(await backupConfig(target, "merged once")).toBe(`${target}.prev.bak`)
    expect(await backupConfig(target, "merged twice")).toBe(`${target}.prev.bak`)

    expect(await read(`${target}.bak`)).toBe("original")
    expect(await read(`${target}.prev.bak`)).toBe("merged twice")
  })
})

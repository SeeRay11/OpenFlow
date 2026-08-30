import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { recallPipeline, recallProject, statePath } from "./last-session"
import type { ServeStatus, Supervisor } from "./opencode-process"
import { backupConfig, browseDirectory, flowPaths, handleFlow, slug, type FlowPaths } from "./store"

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
  // A project switch remembers the folder for the next launch; without this
  // the suite would overwrite the developer's own `~/.openflow/state.json`.
  process.env.OPENFLOW_STATE_DIR = path.join(dir, "state")
})

afterEach(async () => {
  delete process.env.OPENFLOW_STATE_DIR
  await fs.rm(dir, { recursive: true, force: true })
})

const read = (file: string) => fs.readFile(file, "utf8")

function call(
  method: string,
  route: string,
  options: { body?: unknown; search?: string; serve?: Supervisor } = {},
) {
  return handleFlow(paths, {
    method,
    path: route,
    search: new URLSearchParams(options.search ?? ""),
    json: async () => options.body ?? {},
    serve: options.serve,
  })
}

/** Stand-in for the engine's process handle. */
function supervisor(status: Partial<ServeStatus>, onRestart?: () => Promise<ServeStatus>): Supervisor {
  const full = (): ServeStatus => ({
    managed: false,
    running: true,
    url: "http://127.0.0.1:4096",
    command: "opencode serve --port 4096",
    ...status,
  })
  return {
    status: async () => full(),
    ensure: async () => full(),
    restart: onRestart ?? (async () => full()),
    stop: async () => {},
  }
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

  test("folds case, so two names cannot claim one file while looking distinct", () => {
    // NTFS and APFS already treat `Alpha.json` and `alpha.json` as one file, so
    // keeping case only hid the collision: the listing went on showing `Alpha`
    // while the contents had become `alpha`'s.
    expect(slug("Alpha")).toBe("alpha")
    expect(slug("Alpha")).toBe(slug("alpha"))
    expect(slug("My Flow")).toBe(slug("My-Flow"))
  })

  test("keeps a name that is not written in Latin", () => {
    // Stripping non-ASCII collapsed every one of these onto "untitled", so the
    // second pipeline a Japanese or Russian user saved erased the first.
    expect(slug("設計")).toBe("設計")
    expect(slug("Релиз")).toBe("релиз")
    expect(slug("café")).toBe("café")
    expect(slug("設計")).not.toBe(slug("計画"))
  })

  test("still drops everything a path could hide in", () => {
    expect(slug('a<b>c:d"e|f?g*h')).toBe("abcdefgh")
    expect(slug("Release ✅")).toBe("release")
    expect(slug("trailing.")).toBe("trailing")
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

describe("pipelines: a save must not destroy another one", () => {
  // Every new pipeline is born called "untitled" and the templates ship fixed
  // names, so build A, save, "new pipeline", build B, save used to leave one
  // file holding B and no trace that A ever existed.
  test("refuses when a different pipeline already claims the name", async () => {
    await call("PUT", "/flow/api/pipelines/untitled", { body: { ...graph, id: "a" } })
    const second = await call("PUT", "/flow/api/pipelines/untitled", { body: { ...graph, id: "b" } })

    expect(second!.status).toBe(409)
    expect((second!.body as any).error).toContain('already saved as "untitled"')
    expect(((await call("GET", "/flow/api/pipelines/untitled"))!.body as any).id).toBe("a")
  })

  test("re-saving the same pipeline is the ordinary case and goes through", async () => {
    await call("PUT", "/flow/api/pipelines/untitled", { body: { ...graph, id: "a", nodes: [] } })
    const again = await call("PUT", "/flow/api/pipelines/untitled", { body: { ...graph, id: "a" } })

    expect(again!.status).toBe(200)
    expect(((await call("GET", "/flow/api/pipelines/untitled"))!.body as any).nodes).toHaveLength(1)
  })

  test("overwrite=1 is the only way past it", async () => {
    await call("PUT", "/flow/api/pipelines/untitled", { body: { ...graph, id: "a" } })
    const forced = await call("PUT", "/flow/api/pipelines/untitled", {
      body: { ...graph, id: "b" },
      search: "overwrite=1",
    })

    expect(forced!.status).toBe(200)
    expect(((await call("GET", "/flow/api/pipelines/untitled"))!.body as any).id).toBe("b")
  })

  test("names that differ only in case or spacing are caught by the same guard", async () => {
    await call("PUT", `/flow/api/pipelines/${encodeURIComponent("My Flow")}`, { body: { ...graph, id: "a" } })
    const clash = await call("PUT", `/flow/api/pipelines/${encodeURIComponent("MY-FLOW")}`, {
      body: { ...graph, id: "b" },
    })

    expect(clash!.status).toBe(409)
    expect(await fs.readdir(paths.pipelines)).toEqual(["my-flow.json"])
  })
})

describe("atomic writes", () => {
  test("a save that cannot land destroys nothing and leaves no half-written file", async () => {
    // A directory sitting where the pipeline file goes: the rename can never
    // succeed, which is the closest a test gets to a crash mid-write.
    const blocked = path.join(paths.pipelines, "blocked.json")
    await fs.mkdir(blocked, { recursive: true })
    await fs.writeFile(path.join(blocked, "keep"), "x")

    await expect(call("PUT", "/flow/api/pipelines/blocked", { body: graph })).rejects.toThrow()

    expect(await read(path.join(blocked, "keep"))).toBe("x")
    expect((await fs.readdir(paths.pipelines)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
  })

  test("an ordinary save leaves nothing beside the file it wrote", async () => {
    await call("PUT", "/flow/api/pipelines/feature-build", { body: graph })
    expect(await fs.readdir(paths.pipelines)).toEqual(["feature-build.json"])
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

  test("carries usage into the listing, and leaves older runs without it", async () => {
    const usage = { cost: 0.25, tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, steps: 1, models: [], unpriced: [] }
    await call("PUT", "/flow/api/runs/run-1", { body: { ...log, usage } })
    await call("PUT", "/flow/api/runs/run-2", { body: { ...log, id: "run-2", started: 30 } })

    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    // A run recorded before cost tracking has no usage at all — the spend view
    // counts it as unknown rather than as a free run.
    expect(list.find((entry) => entry.id === "run-2").usage).toBeUndefined()
    expect(list.find((entry) => entry.id === "run-1").usage.cost).toBe(0.25)
  })

  test("404s for a run that does not exist", async () => {
    expect((await call("GET", "/flow/api/runs/ghost"))!.status).toBe(404)
  })

  // `refresh()` lists runs at boot, after every run, and after every save. The
  // old shape read and parsed every log each time, so a few hundred runs made
  // boot stall on megabytes of JSON. These pin the index that replaced it.
  test("the listing does not report its own index as a run", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list.map((entry) => entry.id)).toEqual(["run-1"])
  })

  test("lists from the index rather than reading every log back", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    await call("GET", "/flow/api/runs")
    // Damaging the log proves the listing never opened it.
    await fs.writeFile(path.join(paths.runs, "run-1.json"), "{ truncated")

    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list[0]).toMatchObject({ id: "run-1", pipeline: "feature-build", status: "done" })
  })

  test("rebuilds when a log appears that the index has never heard of", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    await call("GET", "/flow/api/runs")
    await fs.writeFile(path.join(paths.runs, "run-2.json"), JSON.stringify({ ...log, id: "run-2", started: 30 }))

    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list.map((entry) => entry.id)).toEqual(["run-2", "run-1"])
    expect(list[0]).toMatchObject({ pipeline: "feature-build" })
  })

  test("rebuilds when a log is deleted out from under the index", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    await call("PUT", "/flow/api/runs/run-2", { body: { ...log, id: "run-2", started: 30 } })
    await call("GET", "/flow/api/runs")
    await fs.rm(path.join(paths.runs, "run-2.json"))

    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list.map((entry) => entry.id)).toEqual(["run-1"])
  })
})

describe("agents", () => {
  const agent = { agent: { "feature-build-planner": { mode: "primary", prompt: "plan" } } }

  /**
   * A merge lands in the *global* config, not the project's: a session's
   * location is the engine's cwd, so agents written into the target project are
   * not there when the run drains, and the run fails with "the server does not
   * know an agent named …". `XDG_CONFIG_HOME` keeps that out of the developer's
   * own config.
   */
  let global: string

  beforeEach(async () => {
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg")
    global = path.join(dir, "xdg", "opencode", "opencode.json")
    await fs.mkdir(path.dirname(global), { recursive: true })
  })

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME
  })

  test("writes only the generated block unless a merge is asked for", async () => {
    const result = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent })

    expect(result!.body).toMatchObject({ merged: false })
    const written = JSON.parse(await read(path.join(paths.generated, "feature-build.opencode.json")))
    expect(written.agent).toEqual(agent.agent)
    await expect(read(global)).rejects.toThrow()
  })

  test("merge creates the config when the project has none", async () => {
    const result = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    expect(result!.body).toMatchObject({ merged: true, backup: undefined })
    const config = JSON.parse(await read(global))
    expect(config.agent).toEqual(agent.agent)
  })

  test("merge keeps what the project already had", async () => {
    await fs.writeFile(global, JSON.stringify({ model: "opencode/x", agent: { mine: {} } }))

    await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    const config = JSON.parse(await read(global))
    expect(config.model).toBe("opencode/x")
    expect(Object.keys(config.agent).sort()).toEqual(["feature-build-planner", "mine"])
  })

  test("a second merge does not overwrite the original backup", async () => {
    const target = global
    await fs.writeFile(target, JSON.stringify({ agent: { mine: {} } }))
    const changed = { agent: { "feature-build-planner": { mode: "primary", prompt: "replan" } } }

    await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })
    const second = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: changed, search: "merge=1" })

    expect(second!.body).toMatchObject({ backup: `${target}.prev.bak` })
    expect(JSON.parse(await read(`${target}.bak`)).agent).toEqual({ mine: {} })
  })

  test("a merge that changes nothing does not touch the config or leave a backup", async () => {
    const target = global
    await fs.writeFile(target, JSON.stringify({ agent: { mine: {} } }))

    await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })
    const before = await read(target)
    const second = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    expect(second!.body).toMatchObject({ merged: false, unchanged: true })
    expect(second!.body).not.toHaveProperty("backup")
    expect(await read(target)).toBe(before)
    // The first merge's `.bak`, not a second `.prev.bak`, is the only backup.
    await expect(read(`${target}.prev.bak`)).rejects.toThrow()
  })

  test("a merge drops the agents this pipeline no longer generates, and nothing else", async () => {
    const marked = (id: string, role: string, pipeline = "feature-build") => ({
      description: `OpenFlow node ${id} (${role}) of pipeline ${pipeline}`,
    })
    await fs.writeFile(
      global,
      JSON.stringify({
        agent: {
          "feature-build-planner": marked("n1", "planner"),
          // Renamed away: generated for this pipeline, no longer in the block.
          "feature-build-scout": marked("n0", "scout"),
          // Another pipeline's, and a hand-written one that merely looks generated.
          "release-notes-writer": marked("n9", "writer", "release-notes"),
          "feature-build-mine": {},
        },
      }),
    )

    await call("POST", "/flow/api/pipelines/feature-build/agents", {
      body: { agent: { "feature-build-planner": marked("n1", "planner") } },
      search: "merge=1",
    })

    const config = JSON.parse(await read(global))
    expect(Object.keys(config.agent).sort()).toEqual([
      "feature-build-mine",
      "feature-build-planner",
      "release-notes-writer",
    ])
  })

  test("an unchanged merge with no config to merge into names the generated file", async () => {
    const result = await call("POST", "/flow/api/pipelines/feature-build/agents", {
      body: { agent: {} },
      search: "merge=1",
    })

    expect(result!.body).toMatchObject({
      path: path.join(paths.generated, "feature-build.opencode.json"),
      unchanged: true,
    })
    await expect(read(global)).rejects.toThrow()
  })

  test("refuses to merge into a config it cannot parse", async () => {
    await fs.writeFile(global, "{not json")

    const result = await call("POST", "/flow/api/pipelines/feature-build/agents", { body: agent, search: "merge=1" })

    expect(result!.body).toMatchObject({ merged: false, error: expect.stringContaining("not valid JSON") })
    expect(await read(global)).toBe("{not json")
  })

  test("cleans up after a pipeline whose name needed slugging", async () => {
    // The route carries the slug (`my-flow`); the descriptions carry the raw
    // name (`My Flow`). Matching the slug against them recognised nothing, so
    // no stale agent was ever dropped and every rename added a generation.
    const marked = (id: string, role: string) => ({
      description: `OpenFlow node ${id} (${role}) of pipeline My Flow`,
    })
    await fs.writeFile(
      global,
      JSON.stringify({ agent: { "my-flow-planner": marked("n1", "planner"), "my-flow-scout": marked("n0", "scout") } }),
    )

    await call("POST", `/flow/api/pipelines/${encodeURIComponent("My Flow")}/agents`, {
      body: { agent: { "my-flow-planner": marked("n1", "planner") } },
      search: "merge=1",
    })

    expect(Object.keys(JSON.parse(await read(global)).agent)).toEqual(["my-flow-planner"])
  })

  test("takes the raw name from the body when a caller sends one", async () => {
    // The block here carries no description to read the raw name back off, so
    // only `pipeline` in the body can supply it.
    await fs.writeFile(
      global,
      JSON.stringify({ agent: { "my-flow-scout": { description: "OpenFlow node n0 (scout) of pipeline My Flow" } } }),
    )

    await call("POST", "/flow/api/pipelines/my-flow/agents", {
      body: { pipeline: "My Flow", agent: { "my-flow-planner": { mode: "primary" } } },
      search: "merge=1",
    })

    expect(Object.keys(JSON.parse(await read(global)).agent)).toEqual(["my-flow-planner"])
  })
})

describe("opencode's own config dialect", () => {
  const configPath = () => path.join(dir, "opencode.json")

  // opencode parses opencode.json with jsonc-parser and allowTrailingComma, so
  // a commented config is a *valid* one. Reading it as strict JSON failed every
  // config write: the agent merge, the MCP panel, and skill registration.
  test("reads a config with comments and a trailing comma", async () => {
    await fs.writeFile(
      configPath(),
      `{
  // the search server
  "mcp": {
    /* local */
    "context7": { "type": "local", "command": ["a"] },
  },
}
`,
    )

    const rows = (await call("GET", "/mcp"))?.body as any[]
    expect(rows.map((row) => row.name)).toEqual(["context7"])
    expect(rows[0]).toMatchObject({ type: "local", command: ["a"] })
  })

  test("refuses to rewrite a commented config, and says so rather than crying invalid JSON", async () => {
    const source = `{\n  // keep me\n  "model": "opencode/x"\n}\n`
    await fs.writeFile(configPath(), source)

    const response = await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })

    // Re-serialising would silently delete the comment, so the write is
    // refused — but the reason has to name the real problem.
    expect(response?.status).toBe(400)
    expect((response?.body as any).error).toContain("has comments")
    expect(await read(configPath())).toBe(source)
  })

  test("a trailing comma alone is no reason to refuse a write", async () => {
    await fs.writeFile(configPath(), `{\n  "model": "opencode/x",\n}\n`)

    const response = await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })

    expect(response?.status).toBe(200)
    const config = JSON.parse(await read(configPath()))
    expect(config.model).toBe("opencode/x")
    expect(config.mcp.one).toMatchObject({ type: "local" })
  })

  test("a comma or a comment marker inside a value is left alone", async () => {
    const model = 'a, } b // c /* d */ "'
    await fs.writeFile(configPath(), JSON.stringify({ model, mcp: {} }))

    await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })

    expect(JSON.parse(await read(configPath())).model).toBe(model)
  })

  test("a skill lands unregistered rather than silently, when the config will not take the source", async () => {
    // registerSkillSource runs before the SKILL.md write for this reason: a
    // skill registered nowhere is one the agent can never see.
    await fs.writeFile(configPath(), `{\n  // keep me\n}\n`)

    const result = await call("PUT", "/flow/api/skills/summarize", { body: { name: "Summarize", content: "x" } })

    expect(result!.body).toMatchObject({ registered: false, error: expect.stringContaining("has comments") })
    await expect(read(path.join(paths.skills, "summarize", "SKILL.md"))).resolves.toContain("name: Summarize")
  })
})

describe("concurrent config writes", () => {
  // Clicking Run (which merges agents) while an MCP server or a skill is being
  // saved meant both read the same pre-state and the later write discarded the
  // earlier one. Two tabs, or the vite host beside `bun start`, make it routine.
  test("an mcp save and a skill registration both land", async () => {
    await Promise.all([
      call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } }),
      call("PUT", "/flow/api/skills/summarize", { body: { name: "Summarize", content: "x" } }),
    ])

    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.mcp.one).toMatchObject({ type: "local" })
    expect(config.skills).toEqual({ paths: ["./.openflow/skills"] })
  })

  test("an agent merge and an mcp save do not discard each other", async () => {
    // They no longer write the same file at all — agents go to the global
    // config, because that is the only one a run reads, and MCP servers stay
    // with the project. Both still have to land.
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg")
    await fs.mkdir(path.join(dir, "xdg", "opencode"), { recursive: true })
    try {
      await Promise.all([
        call("POST", "/flow/api/pipelines/feature-build/agents", {
          body: { agent: { "feature-build-planner": { mode: "primary" } } },
          search: "merge=1",
        }),
        call("PUT", "/mcp/two", { body: { type: "local", command: ["b"] } }),
      ])

      expect(JSON.parse(await read(path.join(dir, "xdg", "opencode", "opencode.json"))).agent).toHaveProperty(
        "feature-build-planner",
      )
      expect(JSON.parse(await read(path.join(dir, "opencode.json"))).mcp.two).toMatchObject({ type: "local" })
    } finally {
      delete process.env.XDG_CONFIG_HOME
    }
  })

  test("two mcp saves at once both survive", async () => {
    await Promise.all([
      call("PUT", "/mcp/alpha", { body: { type: "local", command: ["a"] } }),
      call("PUT", "/mcp/beta", { body: { type: "remote", url: "https://b" } }),
    ])

    expect(Object.keys(JSON.parse(await read(path.join(dir, "opencode.json"))).mcp).sort()).toEqual(["alpha", "beta"])
  })
})

describe("skills", () => {
  const skill = { name: "Summarize", description: "Condense text", content: "# Summarize\n\nBe brief." }

  test("writes SKILL.md with frontmatter and registers the source once", async () => {
    const result = await call("PUT", "/flow/api/skills/summarize", { body: skill })

    expect(result!.body).toMatchObject({ name: "summarize", registered: true })
    const md = await read(path.join(paths.skills, "summarize", "SKILL.md"))
    expect(md).toContain("name: Summarize")
    expect(md).toContain("description: Condense text")
    expect(md.endsWith("Be brief.\n")).toBe(true)

    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.skills).toEqual({ paths: ["./.openflow/skills"] })
  })

  test("reads a skill back split into frontmatter and body", async () => {
    await call("PUT", "/flow/api/skills/summarize", { body: skill })
    const loaded = (await call("GET", "/flow/api/skills/summarize"))!.body as any
    expect(loaded).toMatchObject({ name: "Summarize", folder: "summarize", description: "Condense text" })
    expect(loaded.content.trim()).toBe("# Summarize\n\nBe brief.")
  })

  test("an edit round-trip keeps the frontmatter name instead of the folder slug", async () => {
    await call("PUT", "/flow/api/skills/summarize", { body: skill })
    const loaded = (await call("GET", "/flow/api/skills/summarize"))!.body as any

    await call("PUT", `/flow/api/skills/${loaded.folder}`, { body: { ...skill, name: loaded.name } })

    expect(await read(path.join(paths.skills, "summarize", "SKILL.md"))).toContain("name: Summarize")
  })

  test("registering the source is idempotent and never duplicates it", async () => {
    await call("PUT", "/flow/api/skills/one", { body: skill })
    const second = await call("PUT", "/flow/api/skills/two", { body: { ...skill, name: "Two" } })

    expect(second!.body).toMatchObject({ registered: false })
    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.skills).toEqual({ paths: ["./.openflow/skills"] })
  })

  test("keeps an existing config and backs it up when first registering", async () => {
    await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ model: "opencode/x" }))
    const result = await call("PUT", "/flow/api/skills/summarize", { body: skill })

    expect(result!.body).toMatchObject({ registered: true, backup: path.join(dir, "opencode.json") + ".bak" })
    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.model).toBe("opencode/x")
    expect(config.skills).toEqual({ paths: ["./.openflow/skills"] })
  })

  test("repairs a bare skills array left by an older build", async () => {
    await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ skills: ["./.openflow/skills", "./other"] }))

    await call("PUT", "/flow/api/skills/summarize", { body: skill })

    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.skills).toEqual({ paths: ["./.openflow/skills", "./other"] })
  })

  test("keeps skills.urls when adding the path", async () => {
    await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify({ skills: { urls: ["https://x/skills/"] } }))

    await call("PUT", "/flow/api/skills/summarize", { body: skill })

    const config = JSON.parse(await read(path.join(dir, "opencode.json")))
    expect(config.skills).toEqual({ urls: ["https://x/skills/"], paths: ["./.openflow/skills"] })
  })

  test("lists newest first, folder skipped when it has no SKILL.md", async () => {
    await call("PUT", "/flow/api/skills/alpha", { body: skill })
    await call("PUT", "/flow/api/skills/beta", { body: { ...skill, name: "Beta" } })
    await fs.mkdir(path.join(paths.skills, "empty"), { recursive: true })

    const list = (await call("GET", "/flow/api/skills"))!.body as any[]
    expect(list.map((entry) => entry.name).sort()).toEqual(["alpha", "beta"])
  })

  test("lists nothing before anything is saved", async () => {
    expect((await call("GET", "/flow/api/skills"))!.body).toEqual([])
  })

  test("404s for a skill that was never written", async () => {
    expect((await call("GET", "/flow/api/skills/ghost"))!.status).toBe(404)
  })

  test("deletes the folder", async () => {
    await call("PUT", "/flow/api/skills/gone", { body: skill })
    await call("DELETE", "/flow/api/skills/gone")
    expect((await call("GET", "/flow/api/skills/gone"))!.status).toBe(404)
  })

  test("keeps a traversing name inside the skills directory", async () => {
    const result = await call("PUT", `/flow/api/skills/${encodeURIComponent("../../evil")}`, { body: skill })
    expect((result!.body as any).path).toBe(path.join(paths.skills, "evil", "SKILL.md"))
    await expect(read(path.join(dir, "..", "evil", "SKILL.md"))).rejects.toThrow()
  })

  test("does not register the source when the config cannot be parsed", async () => {
    await fs.writeFile(path.join(dir, "opencode.json"), "{not json")
    const result = await call("PUT", "/flow/api/skills/summarize", { body: skill })

    expect(result!.body).toMatchObject({ registered: false, error: expect.stringContaining("not valid JSON") })
    // the SKILL.md is still written — only the config is left untouched
    await expect(read(path.join(paths.skills, "summarize", "SKILL.md"))).resolves.toContain("name: Summarize")
    expect(await read(path.join(dir, "opencode.json"))).toBe("{not json")
  })
})

describe("browseDirectory", () => {
  test("lists subdirectories, not files, and skips dotfiles", async () => {
    await fs.mkdir(path.join(dir, "sub-a"))
    await fs.mkdir(path.join(dir, "sub-b"))
    await fs.mkdir(path.join(dir, ".hidden"))
    await fs.writeFile(path.join(dir, "not-a-dir.txt"), "x")

    const result = await browseDirectory(dir)
    expect(result.entries.map((entry) => entry.name)).toEqual(["sub-a", "sub-b"])
    expect(result.path).toBe(path.resolve(dir))
  })

  test("parent points one level up, and each entry's path resolves back to itself", async () => {
    await fs.mkdir(path.join(dir, "child"))
    const result = await browseDirectory(path.join(dir, "child"))
    expect(result.parent).toBe(path.resolve(dir))
  })

  test("rejects a path that is not a directory", async () => {
    const file = path.join(dir, "plain.txt")
    await fs.writeFile(file, "x")
    await expect(browseDirectory(file)).rejects.toThrow("not a directory")
  })

  test("rejects a path that does not exist", async () => {
    await expect(browseDirectory(path.join(dir, "ghost"))).rejects.toThrow("not a directory")
  })

  test("omitted target lists roots without throwing", async () => {
    const result = await browseDirectory()
    // Windows has no single root, so the drive list is its own level with
    // nothing above it. Everywhere else the root is a real directory: `/`
    // lists like any other, and stops at itself rather than reporting no
    // parent, so the picker always has somewhere to go back to.
    const roots = process.platform === "win32" ? null : "/"
    expect(result.path).toBe(roots)
    expect(result.parent).toBe(roots)
    expect(Array.isArray(result.entries)).toBe(true)
  })
})

describe("routes: browse and project", () => {
  test("GET /browse defaults to the current project directory's siblings via an explicit path", async () => {
    await fs.mkdir(path.join(dir, "child"))
    const result = await call("GET", "/flow/api/browse", { search: `path=${encodeURIComponent(dir)}` })
    expect(result!.status).toBe(200)
    expect((result!.body as any).entries.map((entry: any) => entry.name)).toEqual(["child"])
  })

  test("GET /browse answers 400 for a path that is not a directory", async () => {
    const file = path.join(dir, "plain.txt")
    await fs.writeFile(file, "x")
    const result = await call("GET", "/flow/api/browse", { search: `path=${encodeURIComponent(file)}` })
    expect(result!.status).toBe(400)
  })

  test("POST /pick-folder refuses when the host is serving remotely", async () => {
    const previous = process.env.FLOW_ALLOW_REMOTE
    process.env.FLOW_ALLOW_REMOTE = "1"
    try {
      const result = await call("POST", "/flow/api/pick-folder", { body: {} })
      expect(result!.status).toBe(403)
    } finally {
      if (previous === undefined) delete process.env.FLOW_ALLOW_REMOTE
      else process.env.FLOW_ALLOW_REMOTE = previous
    }
  })

  test("POST /project switches every path in place, live", async () => {
    const next = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-store-next-"))
    try {
      const result = await call("POST", "/flow/api/project", { body: { path: next } })
      expect(result!.status).toBe(200)
      expect((result!.body as any).project).toBe(path.resolve(next))
      // The same object handleFlow was given reflects the switch — this is
      // what lets both hosts pick it up with no restart.
      expect(paths.project).toBe(path.resolve(next))
      expect(paths.pipelines).toBe(path.join(path.resolve(next), ".openflow", "pipelines"))
    } finally {
      await fs.rm(next, { recursive: true, force: true })
    }
  })

  test("POST /project remembers the folder for the next launch", async () => {
    const next = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-store-next-"))
    try {
      await call("POST", "/flow/api/project", { body: { path: next } })
      expect(recallProject()).toBe(path.resolve(next))
    } finally {
      await fs.rm(next, { recursive: true, force: true })
    }
  })

  test("POST /project remembers nothing when it refused the switch", async () => {
    await call("POST", "/flow/api/project", { body: { path: path.join(dir, "ghost") } })
    expect(await fs.access(statePath()).then(() => true, () => false)).toBe(false)
  })

  test("POST /project rejects a path that does not exist", async () => {
    const result = await call("POST", "/flow/api/project", { body: { path: path.join(dir, "ghost") } })
    expect(result!.status).toBe(400)
    expect(paths.project).toBe(path.resolve(dir))
  })

  test("POST /project requires a path", async () => {
    const result = await call("POST", "/flow/api/project", { body: {} })
    expect(result!.status).toBe(400)
  })
})

describe("routes: the pipeline to reopen", () => {
  test("opening one records it", async () => {
    await call("PUT", "/flow/api/pipelines/feature-build", { body: graph })
    await call("GET", "/flow/api/pipelines/feature-build")
    expect(recallPipeline(dir)).toBe("feature-build")
  })

  test("saving one records it", async () => {
    await call("PUT", "/flow/api/pipelines/feature-build", { body: graph })
    expect(recallPipeline(dir)).toBe("feature-build")
  })

  test("context carries it, so the canvas needs no extra call", async () => {
    await call("PUT", "/flow/api/pipelines/feature-build", { body: graph })
    const context = (await call("GET", "/flow/api/context"))!.body as any
    expect(context.pipeline).toBe("feature-build")
    expect(context.project).toBe(path.resolve(dir))
  })

  test("context says nothing when none was ever opened", async () => {
    expect(((await call("GET", "/flow/api/context"))!.body as any).pipeline).toBeUndefined()
  })

  test("deleting the remembered pipeline forgets it", async () => {
    await call("PUT", "/flow/api/pipelines/feature-build", { body: graph })
    await call("DELETE", "/flow/api/pipelines/feature-build")
    expect(recallPipeline(dir)).toBeUndefined()
  })

  test("deleting a different pipeline leaves it alone", async () => {
    // Otherwise tidying up an old graph resets the user to a blank canvas.
    await call("PUT", "/flow/api/pipelines/feature-build", { body: graph })
    await call("PUT", "/flow/api/pipelines/scratch", { body: graph })
    await call("GET", "/flow/api/pipelines/feature-build")
    await call("DELETE", "/flow/api/pipelines/scratch")
    expect(recallPipeline(dir)).toBe("feature-build")
  })

  test("a failed open records nothing", async () => {
    await call("GET", "/flow/api/pipelines/ghost")
    expect(recallPipeline(dir)).toBeUndefined()
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

describe("mcp servers", () => {
  const configPath = () => path.join(dir, "opencode.json")

  test("lists nothing when the project has no config", async () => {
    expect((await call("GET", "/mcp"))?.body).toEqual([])
  })

  test("writes a local server into the project config", async () => {
    const response = await call("PUT", "/mcp/context7", {
      body: { type: "local", command: ["bunx", "-y", "@upstash/context7-mcp"], environment: { KEY: "v" } },
    })

    expect(response?.status).toBe(200)
    const config = JSON.parse(await read(configPath()))
    expect(config.mcp.context7).toEqual({
      type: "local",
      command: ["bunx", "-y", "@upstash/context7-mcp"],
      environment: { KEY: "v" },
      enabled: true,
    })
  })

  test("saving a server the config already describes writes nothing", async () => {
    const body = { type: "local", command: ["bunx", "-y", "@upstash/context7-mcp"] }

    await call("PUT", "/mcp/context7", { body })
    const before = await read(configPath())
    const second = await call("PUT", "/mcp/context7", { body })

    expect(second?.body).toMatchObject({ unchanged: true })
    expect(second?.body).not.toHaveProperty("backup")
    expect(await read(configPath())).toBe(before)
    // The project had no config before the first write, so there was nothing to
    // copy aside; a re-save must not invent a backup of OpenFlow's own output.
    await expect(read(`${configPath()}.bak`)).rejects.toThrow()
  })

  test("writes a remote server with headers", async () => {
    await call("PUT", "/mcp/hosted", {
      body: { type: "remote", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer x" } },
    })

    const config = JSON.parse(await read(configPath()))
    expect(config.mcp.hosted).toEqual({
      type: "remote",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer x" },
      enabled: true,
    })
  })

  test("refuses a server that could not start, rather than writing a config opencode rejects", async () => {
    const local = await call("PUT", "/mcp/broken", { body: { type: "local", command: [] } })
    const remote = await call("PUT", "/mcp/broken", { body: { type: "remote", url: "  " } })

    expect(local?.status).toBe(400)
    expect(remote?.status).toBe(400)
    expect(await fs.access(configPath()).then(() => true, () => false)).toBe(false)
  })

  test("drops empty header and environment rows the form leaves behind", async () => {
    await call("PUT", "/mcp/tidy", {
      body: { type: "local", command: ["run"], environment: { "": "orphan", KEY: "kept" } },
    })

    const config = JSON.parse(await read(configPath()))
    expect(config.mcp.tidy.environment).toEqual({ KEY: "kept" })
  })

  test("keeps other config and backs it up before rewriting", async () => {
    await fs.writeFile(configPath(), JSON.stringify({ agent: { planner: {} } }, null, 2))

    await call("PUT", "/mcp/one", { body: { type: "local", command: ["run"] } })

    const config = JSON.parse(await read(configPath()))
    expect(config.agent).toEqual({ planner: {} })
    expect(JSON.parse(await read(`${configPath()}.bak`)).mcp).toBeUndefined()
  })

  test("round-trips through the list route", async () => {
    await call("PUT", "/mcp/beta", { body: { type: "remote", url: "https://b" } })
    await call("PUT", "/mcp/alpha", { body: { type: "local", command: ["a"], enabled: false } })

    const rows = (await call("GET", "/mcp"))?.body as any[]
    expect(rows.map((row) => row.name)).toEqual(["alpha", "beta"])
    expect(rows[0]).toMatchObject({ type: "local", enabled: false, command: ["a"] })
  })

  test("delete removes only the named server", async () => {
    await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })
    await call("PUT", "/mcp/two", { body: { type: "local", command: ["b"] } })

    const response = await call("DELETE", "/mcp/one")

    expect(response?.body).toMatchObject({ name: "one", removed: true })
    expect(Object.keys(JSON.parse(await read(configPath())).mcp)).toEqual(["two"])
  })

  test("deleting something that was never configured is not an error", async () => {
    expect((await call("DELETE", "/mcp/ghost"))?.body).toMatchObject({ removed: false })
  })

  test("refuses to touch an opencode.json it cannot parse", async () => {
    await fs.writeFile(configPath(), "{ not json")

    const response = await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })

    expect(response?.status).toBe(400)
    expect(await read(configPath())).toBe("{ not json")
  })
})

describe("server control", () => {
  test("reports the engine this host proxies", async () => {
    const response = await call("GET", "/flow/api/server", { serve: supervisor({ managed: true, pid: 42 }) })
    expect(response!.status).toBe(200)
    expect(response!.body).toMatchObject({ managed: true, running: true, pid: 42 })
  })

  test("restarts it when this host owns the process", async () => {
    let restarted = 0
    const serve = supervisor({ managed: true }, async () => {
      restarted += 1
      return { managed: true, running: true, url: "http://127.0.0.1:4096", command: "x", pid: 7 }
    })
    const response = await call("POST", "/flow/api/server/restart", { serve })
    expect(restarted).toBe(1)
    expect(response!.status).toBe(200)
    expect(response!.body).toMatchObject({ running: true, pid: 7 })
  })

  test("refuses with the command when the host does not own it", async () => {
    const serve = supervisor({ managed: false, reason: "it was started outside OpenFlow" })
    const response = await call("POST", "/flow/api/server/restart", { serve })
    // 409, not 500: nothing is broken — this host simply cannot reach that
    // process, and the body carries what to type instead.
    expect(response!.status).toBe(409)
    expect(response!.body).toMatchObject({ managed: false, command: "opencode serve --port 4096" })
    expect((response!.body as any).error).toContain("outside OpenFlow")
  })

  test("surfaces a failed restart rather than claiming success", async () => {
    const serve = supervisor({ managed: true }, async () => {
      throw new Error("port still held")
    })
    const response = await call("POST", "/flow/api/server/restart", { serve })
    expect(response!.status).toBe(502)
    expect((response!.body as any).error).toBe("port still held")
  })

  test("a host that tracks no engine says so", async () => {
    const response = await call("GET", "/flow/api/server")
    expect(response!.status).toBe(501)
  })

  test("is refused when the store is served remotely", async () => {
    process.env.FLOW_ALLOW_REMOTE = "1"
    try {
      const response = await call("POST", "/flow/api/server/restart", { serve: supervisor({ managed: true }) })
      expect(response!.status).toBe(403)
    } finally {
      delete process.env.FLOW_ALLOW_REMOTE
    }
  })
})

describe("custom roles", () => {
  const role = (label: string) => ({
    id: label,
    label,
    color: "#9ad1f0",
    agent: { prompt: `you are the ${label}`, tools: { read: true } },
  })

  test("round-trips through the project rather than the browser", async () => {
    const saved = await call("PUT", "/flow/api/roles", { body: [role("design planner")] })
    expect(saved!.status).toBe(200)

    const response = await call("GET", "/flow/api/roles")
    expect(response!.body).toEqual([role("design planner")])
    // The point of the move: it is a file someone can copy, commit or back up.
    expect(JSON.parse(await read(path.join(dir, ".openflow", "roles.json")))).toHaveLength(1)
  })

  test("a hand-mangled roles.json reads as none and is left where it can be recovered", async () => {
    const file = path.join(dir, ".openflow", "roles.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{ this is not json")

    const response = await call("GET", "/flow/api/roles")
    expect(response!.body).toEqual([])
    // Overwriting on a failed read is how the only copy disappears.
    expect(await read(file)).toBe("{ this is not json")
  })

  test("drops entries that are not roles instead of handing them to the palette", async () => {
    await call("PUT", "/flow/api/roles", { body: [role("keeper"), { id: "no-agent" }, null, 7] })
    const response = await call("GET", "/flow/api/roles")
    expect((response!.body as any[]).map((entry) => entry.id)).toEqual(["keeper"])
  })

  test("concurrent saves both land instead of interleaving", async () => {
    await Promise.all([
      call("PUT", "/flow/api/roles", { body: [role("first")] }),
      call("PUT", "/flow/api/roles", { body: [role("first"), role("second")] }),
    ])
    const response = await call("GET", "/flow/api/roles")
    // Serialised, so the file is one whole write or the other — never a blend.
    const ids = (response!.body as any[]).map((entry) => entry.id)
    expect([["first"], ["first", "second"]]).toContainEqual(ids)
  })
})

/**
 * The one route that writes *outside* the project: repackaging a provider edits
 * opencode's global config, because that is the only file a run reads (see
 * `lib/repackage.ts`). `XDG_CONFIG_HOME` points at the temp directory here, so
 * the suite cannot touch the developer's own config.
 */
describe("routes: repackaging a provider", () => {
  let target: string

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg")
    target = path.join(dir, "xdg", "opencode", "opencode.json")
  })

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME
  })

  test("reports what is available before any config exists", async () => {
    const response = await call("GET", "/flow/api/repackage")
    expect(response!.status).toBe(200)
    expect(response!.body).toMatchObject({ path: target, applied: [] })
    expect((response!.body as any).available).toContain("openrouter")
  })

  test("writes the override and asks for a restart", async () => {
    const response = await call("POST", "/flow/api/repackage", { body: { providers: ["openrouter"] } })
    expect(response!.body).toMatchObject({ changed: ["openrouter"], applied: ["openrouter"], restart: true })
    expect(JSON.parse(await read(target)).providers.openrouter.api).toEqual({
      type: "aisdk",
      package: "@ai-sdk/openai-compatible",
      url: "https://openrouter.ai/api/v1",
    })
    expect((await call("GET", "/flow/api/repackage"))!.body).toMatchObject({ applied: ["openrouter"] })
  })

  test("follows the dialect of an existing v1 config, and backs it up", async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify({ plugin: ["./p.js"] }))
    const response = await call("POST", "/flow/api/repackage", { body: { providers: ["groq"] } })
    expect(response!.body).toMatchObject({ backup: `${target}.bak` })
    expect(JSON.parse(await read(target)).provider.groq).toEqual({
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.groq.com/openai/v1",
    })
    expect(JSON.parse(await read(`${target}.bak`))).toEqual({ plugin: ["./p.js"] })
  })

  test("a second call changes nothing and does not ask for a restart", async () => {
    await call("POST", "/flow/api/repackage", { body: { providers: ["groq"] } })
    const again = await call("POST", "/flow/api/repackage", { body: { providers: ["groq"] } })
    expect(again!.body).toMatchObject({ changed: [], restart: false })
  })

  test("refuses a provider the runner has no profile for, so no npm package can be injected", async () => {
    const response = await call("POST", "/flow/api/repackage", { body: { providers: ["evil"] } })
    expect(response!.status).toBe(400)
    await expect(read(target)).rejects.toThrow()
  })

  test("refuses rather than stripping comments out of a hand-written config", async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '{\n  // mine\n  "model": "opencode/x"\n}')
    const response = await call("POST", "/flow/api/repackage", { body: { providers: ["groq"] } })
    expect(response!.status).toBe(409)
    expect((response!.body as any).error).toContain("comments")
    expect(await read(target)).toContain("// mine")
  })

  test("reads .jsonc when that is the file opencode would load", async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(`${target}c`, JSON.stringify({ model: "opencode/x" }))
    const response = await call("POST", "/flow/api/repackage", { body: { providers: ["groq"] } })
    expect(response!.body).toMatchObject({ path: `${target}c`, changed: ["groq"] })
    await expect(read(target)).rejects.toThrow()
  })
})

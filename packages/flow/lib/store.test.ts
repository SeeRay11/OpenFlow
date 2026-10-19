import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { recallPipeline, recallProject, statePath } from "./last-session"
import { browseDirectory, flowPaths, handleFlow, slug, type FlowPaths } from "./store"

/**
 * This is the surface that writes to a user's real repository — pipelines, run
 * logs — and to the Omp profile's MCP config and skills, so it is tested
 * against a real temporary directory rather than a mocked filesystem.
 */

let dir: string
let profile: string
let paths: FlowPaths

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-store-"))
  paths = flowPaths(dir)
  // Not created: a profile that has never been written to has no directory yet.
  profile = path.join(dir, "omp-profile", "agent")
  // A project switch remembers the folder for the next launch; without this
  // the suite would overwrite the developer's own `~/.openflow/state.json`.
  process.env.OPENFLOW_STATE_DIR = path.join(dir, "state")
})

afterEach(async () => {
  delete process.env.OPENFLOW_STATE_DIR
  await fs.rm(dir, { recursive: true, force: true })
})

const read = (file: string) => fs.readFile(file, "utf8")

/** `profile: null` is a host that does not know the Omp profile's directory. */
function call(
  method: string,
  route: string,
  options: { body?: unknown; search?: string; profile?: string | null } = {},
) {
  return handleFlow(paths, {
    method,
    path: route,
    search: new URLSearchParams(options.search ?? ""),
    json: async () => options.body ?? {},
    profileDir: async () => (options.profile === undefined ? profile : (options.profile ?? undefined)),
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

  test("records how many cards a run had, so the listing can say it", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: { ...log, nodes: [{ id: "a" }, { id: "b" }] } })
    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list[0].nodes).toBe(2)
  })

  test("deletes a run log and drops it from the listing", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    await call("PUT", "/flow/api/runs/run-2", { body: { ...log, id: "run-2", started: 30 } })

    expect((await call("DELETE", "/flow/api/runs/run-1"))!.body).toEqual({ id: "run-1", removed: true })
    expect(await fs.readdir(paths.runs)).not.toContain("run-1.json")
    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list.map((entry) => entry.id)).toEqual(["run-2"])
  })

  test("404s deleting a run that is not there", async () => {
    expect((await call("DELETE", "/flow/api/runs/ghost"))!.status).toBe(404)
  })

  // The index is rebuilt whenever it stops describing the files on disk, so a
  // deleted log whose row survived would come straight back.
  test("a deleted run does not reappear when the index is rebuilt", async () => {
    await call("PUT", "/flow/api/runs/run-1", { body: log })
    await call("DELETE", "/flow/api/runs/run-1")
    await call("PUT", "/flow/api/runs/run-2", { body: { ...log, id: "run-2" } })
    const list = (await call("GET", "/flow/api/runs"))!.body as any[]
    expect(list.map((entry) => entry.id)).toEqual(["run-2"])
  })

  describe("prune", () => {
    const day = 86_400_000
    const old = () => Date.now() - 40 * day
    const recent = () => Date.now() - day

    test("deletes what is past the age rule and keeps the rest", async () => {
      await call("PUT", "/flow/api/runs/old", { body: { ...log, id: "old", started: old() } })
      await call("PUT", "/flow/api/runs/new", { body: { ...log, id: "new", started: recent() } })

      expect((await call("POST", "/flow/api/runs/prune", { body: { days: 30 } }))!.body).toEqual({
        removed: ["old"],
        kept: 1,
      })
      expect(await fs.readdir(paths.runs)).toContain("new.json")
    })

    test("keeps only the newest when told a count", async () => {
      for (const [id, started] of [["a", 10], ["b", 20], ["c", 30]] as const)
        await call("PUT", `/flow/api/runs/${id}`, { body: { ...log, id, started } })

      expect((await call("POST", "/flow/api/runs/prune", { body: { keep: 2 } }))!.body).toEqual({
        removed: ["a"],
        kept: 2,
      })
    })

    // "At most twenty, and nothing older than a month" is how the two rules
    // read together, so failing either one is enough to be deleted.
    test("applies both rules, not just the stricter one", async () => {
      await call("PUT", "/flow/api/runs/old", { body: { ...log, id: "old", started: old() } })
      await call("PUT", "/flow/api/runs/new", { body: { ...log, id: "new", started: recent() } })
      await call("PUT", "/flow/api/runs/newest", { body: { ...log, id: "newest", started: Date.now() } })

      const body = (await call("POST", "/flow/api/runs/prune", { body: { keep: 2, days: 30 } }))!.body as any
      expect(body.removed.sort()).toEqual(["old"])
      expect(body.kept).toBe(2)
    })

    // The engine runs in the page, so a closed tab leaves a log saying
    // `running` while its sessions are still alive — that is what resume finds.
    test("never prunes a run still marked running, however old", async () => {
      await call("PUT", "/flow/api/runs/live", {
        body: { ...log, id: "live", status: "running", started: old(), finished: undefined },
      })
      expect((await call("POST", "/flow/api/runs/prune", { body: { days: 1 } }))!.body).toMatchObject({ removed: [] })
    })

    test("an empty body deletes nothing", async () => {
      await call("PUT", "/flow/api/runs/old", { body: { ...log, id: "old", started: old() } })
      expect((await call("POST", "/flow/api/runs/prune", { body: {} }))!.body).toEqual({ removed: [], kept: 1 })
    })
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

describe("skills", () => {
  const skill = { name: "Summarize", description: "Condense text", content: "# Summarize\n\nBe brief." }
  const skillsDir = () => path.join(profile, "skills")
  const legacyFile = (name: string) => path.join(paths.skills, name, "SKILL.md")

  async function writeLegacy(name: string, description = "Old one") {
    await fs.mkdir(path.join(paths.skills, name), { recursive: true })
    await fs.writeFile(legacyFile(name), `---\nname: ${name}\ndescription: ${description}\n---\n\nold body\n`)
  }

  test("writes SKILL.md with frontmatter into the profile's skills directory", async () => {
    const result = await call("PUT", "/flow/api/skills/summarize", { body: skill })
    const file = path.join(skillsDir(), "summarize", "SKILL.md")

    expect(result!.body).toEqual({ name: "summarize", path: file })
    expect(await read(file)).toBe("---\nname: Summarize\ndescription: Condense text\n---\n# Summarize\n\nBe brief.\n")
  })

  test("writes nothing into the project: no config, no .openflow/skills", async () => {
    await call("PUT", "/flow/api/skills/summarize", { body: skill })

    const own: Record<string, true> = { "omp-profile": true, state: true }
    expect((await fs.readdir(dir)).filter((entry) => !Object.hasOwn(own, entry))).toEqual([])
  })

  test("reads a skill back split into frontmatter and body", async () => {
    await call("PUT", "/flow/api/skills/summarize", { body: skill })
    const loaded = (await call("GET", "/flow/api/skills/summarize"))!.body as any
    expect(loaded).toMatchObject({ name: "Summarize", folder: "summarize", description: "Condense text" })
    expect(loaded.content).toContain("Be brief.")
    expect(loaded.legacy).toBeUndefined()
  })

  test("an edit round-trip keeps the frontmatter name instead of the folder slug", async () => {
    await call("PUT", "/flow/api/skills/summarize", { body: skill })
    const loaded = (await call("GET", "/flow/api/skills/summarize"))!.body as any

    await call("PUT", "/flow/api/skills/summarize", { body: { ...loaded, content: "# Edited" } })
    expect(((await call("GET", "/flow/api/skills/summarize"))!.body as any).name).toBe("Summarize")
  })

  test("lists newest first, skipping folders without a SKILL.md and stray files", async () => {
    await call("PUT", "/flow/api/skills/alpha", { body: skill })
    await call("PUT", "/flow/api/skills/beta", { body: { ...skill, name: "Beta" } })
    await fs.mkdir(path.join(skillsDir(), "empty"), { recursive: true })
    await fs.writeFile(path.join(skillsDir(), "stray.txt"), "x")
    await fs.utimes(path.join(skillsDir(), "alpha", "SKILL.md"), 2000, 2000)
    await fs.utimes(path.join(skillsDir(), "beta", "SKILL.md"), 1000, 1000)

    const list = (await call("GET", "/flow/api/skills"))!.body as any[]
    expect(list.map((entry) => entry.name)).toEqual(["alpha", "beta"])
    expect(list[0]).toMatchObject({ description: "Condense text" })
    expect(list.some((entry) => "legacy" in entry)).toBe(false)
  })

  // Creating a symlink needs a privilege Windows does not grant by default.
  test.skipIf(process.platform === "win32")("lists a skill folder that is a symlink", async () => {
    const elsewhere = path.join(dir, "shared", "linked")
    await fs.mkdir(elsewhere, { recursive: true })
    await fs.writeFile(path.join(elsewhere, "SKILL.md"), "---\nname: linked\ndescription: Shared\n---\n\nbody\n")
    await fs.mkdir(skillsDir(), { recursive: true })
    await fs.symlink(elsewhere, path.join(skillsDir(), "linked"), "dir")

    const list = (await call("GET", "/flow/api/skills"))!.body as any[]
    expect(list.map((entry) => entry.name)).toEqual(["linked"])
  })

  test("lists nothing before anything is saved", async () => {
    expect((await call("GET", "/flow/api/skills"))!.body).toEqual([])
  })

  test("404s for a skill that was never written", async () => {
    expect((await call("GET", "/flow/api/skills/ghost"))!.status).toBe(404)
  })

  test("deletes the folder", async () => {
    await call("PUT", "/flow/api/skills/gone", { body: skill })
    const result = await call("DELETE", "/flow/api/skills/gone")
    expect(result!.body).toEqual({ name: "gone", removed: true })
    expect((await call("GET", "/flow/api/skills/gone"))!.status).toBe(404)
    const again = await call("DELETE", "/flow/api/skills/gone")
    expect(again!.status).toBe(404)
    expect(again!.body).toMatchObject({ name: "gone", removed: false, error: expect.any(String) })
  })

  test("a folder with a non-slug name is read, edited in place and deleted under its own name", async () => {
    await fs.mkdir(path.join(skillsDir(), "MySkill"), { recursive: true })
    await fs.writeFile(path.join(skillsDir(), "MySkill", "SKILL.md"), "---\nname: MySkill\ndescription: Installed\n---\n\nbody\n")

    expect(((await call("GET", "/flow/api/skills"))!.body as any[]).map((row) => row.name)).toEqual(["MySkill"])
    const loaded = await call("GET", "/flow/api/skills/MySkill")
    expect(loaded!.status).toBe(200)
    expect(loaded!.body).toMatchObject({ name: "MySkill", folder: "MySkill" })

    const saved = await call("PUT", "/flow/api/skills/MySkill", { body: { ...(loaded!.body as object), content: "edited" } })
    expect((saved!.body as any).path).toBe(path.join(skillsDir(), "MySkill", "SKILL.md"))
    expect(await fs.readdir(skillsDir())).toEqual(["MySkill"])

    expect((await call("DELETE", "/flow/api/skills/MySkill"))!.body).toEqual({ name: "MySkill", removed: true })
    expect(await fs.readdir(skillsDir())).toEqual([])
  })

  test("deleting never reaches a differently-cased sibling or a name outside the skills directory", async () => {
    await call("PUT", "/flow/api/skills/myskill", { body: skill })
    await fs.mkdir(path.join(profile, "keep"), { recursive: true })

    expect((await call("DELETE", "/flow/api/skills/MySkill"))!.status).toBe(404)
    expect(await fs.readdir(skillsDir())).toEqual(["myskill"])

    for (const hostile of ["..", "../keep", "a\\b", ".hidden", "bad\u0000name"]) {
      const route = `/flow/api/skills/${encodeURIComponent(hostile)}`
      expect((await call("DELETE", route))!.status).toBe(400)
      expect((await call("GET", route))!.status).toBe(400)
    }
    expect(await fs.readdir(profile)).toContain("keep")
  })

  test("a new name that slugs onto a different existing folder is refused, not overwritten", async () => {
    await call("PUT", "/flow/api/skills/a-b", { body: { ...skill, content: "first" } })
    const before = await read(path.join(skillsDir(), "a-b", "SKILL.md"))

    const clash = await call("PUT", `/flow/api/skills/${encodeURIComponent("A B")}`, { body: { ...skill, content: "second" } })

    expect(clash!.status).toBe(409)
    expect(clash!.body).toMatchObject({ code: "name-taken", error: expect.stringContaining("a-b") })
    expect(await read(path.join(skillsDir(), "a-b", "SKILL.md"))).toBe(before)
    // Saving the existing folder under its own name is still an edit.
    expect((await call("PUT", "/flow/api/skills/a-b", { body: skill }))!.status).toBe(200)
  })

  test("create refuses an exact name that already exists, and without it the same save is an edit", async () => {
    await call("PUT", "/flow/api/skills/a", { body: { ...skill, content: "first" } })
    await call("PUT", "/flow/api/skills/c", { body: { ...skill, content: "keep me" } })
    const before = await read(path.join(skillsDir(), "c", "SKILL.md"))

    // Renaming `a` to `c` is a create under the new name.
    const clash = await call("PUT", "/flow/api/skills/c", { body: { ...skill, content: "from a", create: true } })
    expect(clash!.status).toBe(409)
    expect(clash!.body).toMatchObject({ code: "name-taken", error: expect.stringContaining('"c"') })
    expect(await read(path.join(skillsDir(), "c", "SKILL.md"))).toBe(before)
    expect((await fs.readdir(skillsDir())).sort()).toEqual(["a", "c"])

    const mixed = await call("PUT", `/flow/api/skills/${encodeURIComponent("C")}`, { body: { ...skill, create: true } })
    expect(mixed!.status).toBe(409)

    // A free name is created, and `create` never reaches the file.
    const fresh = await call("PUT", "/flow/api/skills/d", { body: { ...skill, create: true } })
    expect(fresh!.status).toBe(200)
    expect(await read(path.join(skillsDir(), "d", "SKILL.md"))).not.toContain("create")

    // Without `create` an existing name is still edited in place; create:false is the same.
    expect((await call("PUT", "/flow/api/skills/c", { body: { ...skill, content: "edited" } }))!.status).toBe(200)
    expect((await call("PUT", "/flow/api/skills/c", { body: { ...skill, content: "edited again", create: false } }))!.status).toBe(200)
    expect(await read(path.join(skillsDir(), "c", "SKILL.md"))).toContain("edited again")
  })

  test("two concurrent creates of one new name: exactly one wins, and its content is intact", async () => {
    const responses = await Promise.all(
      ["one", "two", "three"].map((content) => call("PUT", "/flow/api/skills/race", { body: { ...skill, content: `body ${content}`, create: true } })),
    )
    const statuses = responses.map((response) => response!.status).sort()
    expect(statuses).toEqual([200, 409, 409])
    const winner = ["one", "two", "three"][responses.findIndex((response) => response!.status === 200)]
    expect(await read(path.join(skillsDir(), "race", "SKILL.md"))).toContain(`body ${winner}`)
    expect((await fs.readdir(path.join(skillsDir(), "race"))).sort()).toEqual(["SKILL.md"])
    for (const response of responses.filter((entry) => entry!.status === 409)) {
      expect(response!.body).toMatchObject({ code: "name-taken", error: expect.stringContaining('"race"') })
    }
  })

  test("a create that is not a boolean is a 400 and writes nothing", async () => {
    const response = await call("PUT", "/flow/api/skills/x", { body: { ...skill, create: "yes" } })
    expect(response!.status).toBe(400)
    await expect(fs.readdir(skillsDir())).rejects.toThrow()
  })

  test("keeps a traversing name inside the skills directory", async () => {
    const result = await call("PUT", `/flow/api/skills/${encodeURIComponent("../../evil")}`, { body: skill })
    expect((result!.body as any).path).toBe(path.join(skillsDir(), "evil", "SKILL.md"))
    await expect(read(path.join(profile, "..", "evil", "SKILL.md"))).rejects.toThrow()
  })

  describe("legacy skills under .openflow/skills", () => {
    test("are listed beside the profile's, marked legacy", async () => {
      await writeLegacy("old")
      await call("PUT", "/flow/api/skills/new", { body: skill })

      const list = (await call("GET", "/flow/api/skills"))!.body as any[]
      const byName = Object.fromEntries(list.map((entry) => [entry.name, entry]))
      expect(Object.keys(byName).sort()).toEqual(["new", "old"])
      expect(byName.old).toMatchObject({ description: "Old one", legacy: true })
      expect(byName.new.legacy).toBeUndefined()
    })

    test("can be read for editing, still marked legacy", async () => {
      await writeLegacy("old")
      expect(((await call("GET", "/flow/api/skills/old"))!.body as any)).toMatchObject({
        name: "old",
        folder: "old",
        legacy: true,
        path: legacyFile("old"),
      })
    })

    test("saving one writes the profile and leaves the legacy copy alone", async () => {
      await writeLegacy("old")
      const before = await read(legacyFile("old"))

      const saved = await call("PUT", "/flow/api/skills/old", { body: { ...skill, name: "old" } })

      expect((saved!.body as any).path).toBe(path.join(skillsDir(), "old", "SKILL.md"))
      expect(await read(legacyFile("old"))).toBe(before)
    })

    test("once re-saved, the profile's copy is the only one listed or read", async () => {
      await writeLegacy("old")
      await call("PUT", "/flow/api/skills/old", { body: { ...skill, name: "old", description: "Fresh" } })

      const list = (await call("GET", "/flow/api/skills"))!.body as any[]
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ name: "old", description: "Fresh" })
      expect(list[0].legacy).toBeUndefined()
      expect(((await call("GET", "/flow/api/skills/old"))!.body as any).legacy).toBeUndefined()
    })

    test("deleting acts on the profile only", async () => {
      await writeLegacy("old")

      const result = await call("DELETE", "/flow/api/skills/old")

      expect(result!.status).toBe(404)
      expect(result!.body).toMatchObject({ name: "old", removed: false })
      await expect(read(legacyFile("old"))).resolves.toContain("old body")
    })
  })

  describe("without a known profile directory", () => {
    test("writing and deleting are 409, and touch nothing", async () => {
      const put = await call("PUT", "/flow/api/skills/summarize", { body: skill, profile: null })
      const del = await call("DELETE", "/flow/api/skills/summarize", { profile: null })

      for (const response of [put, del]) {
        expect(response!.status).toBe(409)
        expect(response!.body).toEqual({ error: "omp profile directory unknown: open Omp settings" })
      }
      expect(await fs.readdir(dir)).toEqual([])
    })

    test("reading still shows the legacy skills", async () => {
      await writeLegacy("old")
      const list = (await call("GET", "/flow/api/skills", { profile: null }))!.body as any[]
      expect(list).toMatchObject([{ name: "old", legacy: true }])
      expect((await call("GET", "/flow/api/skills/old", { profile: null }))!.status).toBe(200)
      expect((await call("GET", "/flow/api/skills/ghost", { profile: null }))!.status).toBe(404)
    })
  })

  test("a request without a profileDir at all behaves as an unknown profile", async () => {
    const response = await handleFlow(paths, {
      method: "PUT",
      path: "/flow/api/skills/summarize",
      search: new URLSearchParams(),
      json: async () => skill,
    })
    expect(response!.status).toBe(409)
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

  test("POST /project answers 409 project-busy while the host reports live work, and moves nothing", async () => {
    const next = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-store-next-"))
    try {
      const result = await handleFlow(paths, {
        method: "POST",
        path: "/flow/api/project",
        search: new URLSearchParams(),
        json: async () => ({ path: next }),
        projectLocked: () => true,
      })
      expect(result!.status).toBe(409)
      expect(result!.body).toMatchObject({ code: "project-busy", error: expect.any(String) })
      expect(paths.project).toBe(dir)
      expect(recallProject()).toBeUndefined()

      const free = await handleFlow(paths, {
        method: "POST",
        path: "/flow/api/project",
        search: new URLSearchParams(),
        json: async () => ({ path: next }),
        projectLocked: () => false,
      })
      expect(free!.status).toBe(200)
      expect(paths.project).toBe(path.resolve(next))
    } finally {
      await fs.rm(next, { recursive: true, force: true })
    }
  })

  test("POST /project re-checks the lock after its awaits, so a run that started meanwhile still wins", async () => {
    const next = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-store-next-"))
    try {
      const state = { locked: false }
      const result = await handleFlow(paths, {
        method: "POST",
        path: "/flow/api/project",
        search: new URLSearchParams(),
        // The lock flips while the body is being read, after the first check.
        json: async () => {
          state.locked = true
          return { path: next }
        },
        projectLocked: () => state.locked,
        projectHolders: () => ["s1"],
      })
      expect(result!.status).toBe(409)
      expect(result!.body).toMatchObject({ code: "project-busy", sessions: ["s1"] })
      expect(paths.project).toBe(dir)
      expect(recallProject()).toBeUndefined()
    } finally {
      await fs.rm(next, { recursive: true, force: true })
    }
  })

  test("the project-busy refusal lists no sessions when the host names none", async () => {
    const result = await handleFlow(paths, {
      method: "POST",
      path: "/flow/api/project",
      search: new URLSearchParams(),
      json: async () => ({ path: dir }),
      projectLocked: () => true,
    })
    expect(result!.body).toMatchObject({ code: "project-busy", sessions: [] })
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

describe("mcp servers", () => {
  const configPath = () => path.join(profile, "mcp.json")
  const config = async () => JSON.parse(await read(configPath()))
  const local = { type: "local", command: ["bunx", "-y", "@upstash/context7-mcp"] }

  test("lists nothing when the profile has no mcp.json", async () => {
    expect((await call("GET", "/mcp"))?.body).toEqual([])
  })

  test("writes a local server as an omp stdio entry, creating the profile directory", async () => {
    const response = await call("PUT", "/mcp/context7", {
      body: { ...local, environment: { KEY: "v" }, cwd: "/work", timeout: 5000 },
    })

    expect(response!.status).toBe(200)
    expect(response!.body).toEqual({ name: "context7", path: configPath(), backup: undefined })
    expect(await config()).toEqual({
      $schema: expect.stringContaining("mcp-schema.json"),
      mcpServers: {
        context7: {
          type: "stdio",
          command: "bunx",
          args: ["-y", "@upstash/context7-mcp"],
          cwd: "/work",
          env: { KEY: "v" },
          timeout: 5000,
          enabled: true,
        },
      },
    })
  })

  test("writes a remote server as http, with headers", async () => {
    await call("PUT", "/mcp/hosted", {
      body: { type: "remote", url: " https://mcp.example.com/mcp ", headers: { Authorization: "Bearer x" } },
    })

    expect((await config()).mcpServers.hosted).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
      enabled: true,
    })
  })

  test("reads entries back in the browser's shape", async () => {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(
      configPath(),
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "srv", "/tmp"], env: { A: "1" }, cwd: "/w", timeout: 9 },
          gh: { type: "http", url: "https://gh", headers: { X: "y" }, enabled: false },
          legacy: { type: "sse", url: "https://sse" },
          bare: { url: "https://only-a-url" },
          junk: "not an entry",
        },
      }),
    )

    expect((await call("GET", "/mcp"))?.body).toEqual([
      { name: "bare", type: "remote", enabled: true, url: "https://only-a-url", headers: undefined, timeout: undefined },
      {
        name: "fs",
        type: "local",
        enabled: true,
        command: ["npx", "-y", "srv", "/tmp"],
        cwd: "/w",
        environment: { A: "1" },
        timeout: 9,
      },
      { name: "gh", type: "remote", enabled: false, url: "https://gh", headers: { X: "y" }, timeout: undefined },
      { name: "legacy", type: "remote", enabled: true, url: "https://sse", headers: undefined, timeout: undefined },
    ])
  })

  test("round-trips through the list route", async () => {
    await call("PUT", "/mcp/beta", { body: { type: "remote", url: "https://b" } })
    await call("PUT", "/mcp/alpha", {
      body: { type: "local", command: ["a", "--flag"], environment: { K: "v" }, enabled: false },
    })

    const list = (await call("GET", "/mcp"))!.body as any[]
    expect(list.map((entry) => [entry.name, entry.type, entry.enabled])).toEqual([
      ["alpha", "local", false],
      ["beta", "remote", true],
    ])
    expect(list[0]).toMatchObject({ command: ["a", "--flag"], environment: { K: "v" } })
    expect(list[1]).toMatchObject({ url: "https://b" })
  })

  test("a name omp would parse differently is rewritten for a new server, not stored as typed", async () => {
    await call("PUT", `/mcp/${encodeURIComponent("my server")}`, { body: local })
    expect(Object.keys((await config()).mcpServers)).toEqual(["my-server"])
  })

  test("an existing key omp accepts is edited and deleted under its own name", async () => {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(
      configPath(),
      JSON.stringify({ mcpServers: { "my.server": { command: "a" }, "github:x": { command: "b" } } }),
    )

    const dotted = encodeURIComponent("my.server")
    await call("PUT", `/mcp/${dotted}`, { body: { type: "local", command: ["edited"] } })
    expect(Object.keys((await config()).mcpServers).sort()).toEqual(["github:x", "my.server"])
    expect((await config()).mcpServers["my.server"].command).toBe("edited")

    expect((await call("DELETE", `/mcp/${dotted}`))!.body).toMatchObject({ name: "my.server", removed: true })
    expect(Object.keys((await config()).mcpServers)).toEqual(["github:x"])
  })

  test("deleting a server that is not there is a 404, not a silent success", async () => {
    expect((await call("DELETE", "/mcp/ghost"))!.status).toBe(404)
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(configPath(), JSON.stringify({ mcpServers: { real: { command: "a" } } }))
    const missing = await call("DELETE", "/mcp/ghost")
    expect(missing!.status).toBe(404)
    expect(missing!.body).toMatchObject({ name: "ghost", removed: false })
    // `constructor` is on every object's prototype but is no server.
    expect((await call("DELETE", "/mcp/constructor"))!.status).toBe(404)
    expect(Object.keys((await config()).mcpServers)).toEqual(["real"])
  })

  test("create refuses an exact name that already exists and leaves the config and its backup byte-identical", async () => {
    await fs.mkdir(profile, { recursive: true })
    const original = JSON.stringify({ mcpServers: { a: { command: "one" }, c: { command: "keep" } } })
    await fs.writeFile(configPath(), original)
    // First rewrite creates the pre-OpenFlow backup.
    await call("PUT", "/mcp/a", { body: { type: "local", command: ["one", "--x"] } })
    const before = await read(configPath())
    expect(await read(`${configPath()}.bak`)).toBe(original)

    // Renaming `a` to `c` is a create under the new name.
    const clash = await call("PUT", "/mcp/c", { body: { type: "local", command: ["from-a"], create: true } })
    expect(clash!.status).toBe(409)
    expect(clash!.body).toMatchObject({ code: "name-taken", error: expect.stringContaining('"c"') })
    expect(await read(configPath())).toBe(before)
    expect(await read(`${configPath()}.bak`)).toBe(original)

    // Without `create`, or with false, it is the edit it always was.
    expect((await call("PUT", "/mcp/c", { body: { type: "local", command: ["edited"] } }))!.status).toBe(200)
    expect((await call("PUT", "/mcp/c", { body: { type: "local", command: ["edited2"], create: false } }))!.status).toBe(200)
    expect((await config()).mcpServers.c.command).toBe("edited2")
    expect(await read(`${configPath()}.bak`)).toBe(original)

    // A free name is created with create:true, and the flag is not stored.
    const fresh = await call("PUT", "/mcp/d", { body: { type: "local", command: ["new"], create: true } })
    expect(fresh!.status).toBe(200)
    expect((await config()).mcpServers.d).not.toHaveProperty("create")
  })

  test("create also refuses a name that slugs onto an existing server, and a non-boolean create is a 400", async () => {
    await call("PUT", "/mcp/a-b", { body: { type: "local", command: ["one"] } })
    const before = await read(configPath())
    expect((await call("PUT", `/mcp/${encodeURIComponent("a.b")}`, { body: { type: "local", command: ["two"], create: true } }))!.status).toBe(409)
    expect((await call("PUT", "/mcp/z", { body: { type: "local", command: ["two"], create: 1 } }))!.status).toBe(400)
    expect(await read(configPath())).toBe(before)
  })

  test("a new name that slugs onto a different existing server is refused and changes nothing", async () => {
    await call("PUT", "/mcp/a-b", { body: { type: "local", command: ["one"] } })
    const before = await read(configPath())

    const clash = await call("PUT", `/mcp/${encodeURIComponent("a.b")}`, { body: { type: "local", command: ["two"] } })

    expect(clash!.status).toBe(409)
    expect(clash!.body).toMatchObject({ code: "name-taken", error: expect.stringContaining("a-b") })
    expect(await read(configPath())).toBe(before)
    // A genuinely new name that slugs to a free key still works, and reports the key it stored.
    const fresh = await call("PUT", `/mcp/${encodeURIComponent("c.d")}`, { body: { type: "local", command: ["three"] } })
    expect(fresh!.body).toMatchObject({ name: "c-d" })
  })

  test("names that cannot be a config key are refused", async () => {
    for (const bad of ["__proto__", "tab\there", "x".repeat(129), " "]) {
      const response = await call("PUT", `/mcp/${encodeURIComponent(bad)}`, { body: local })
      expect(response!.status).toBe(400)
    }
    await expect(read(configPath())).rejects.toThrow()
  })

  test("deleting a server also drops its name from enabledServers and disabledServers", async () => {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(
      configPath(),
      JSON.stringify({
        mcpServers: { a: { command: "a", enabled: false }, b: { command: "b" } },
        enabledServers: ["a", "b"],
        disabledServers: ["a", "x"],
      }),
    )

    await call("DELETE", "/mcp/a")

    const saved = await config()
    expect(saved.enabledServers).toEqual(["b"])
    expect(saved.disabledServers).toEqual(["x"])
    await call("PUT", "/mcp/a", { body: { type: "local", command: ["a"], enabled: false } })
    expect(((await call("GET", "/mcp"))!.body as any[]).find((row) => row.name === "a").enabled).toBe(false)
  })

  test("saving a server the config already describes writes nothing", async () => {
    await call("PUT", "/mcp/context7", { body: local })
    const before = await read(configPath())

    const again = await call("PUT", "/mcp/context7", { body: local })

    expect(again!.body).toMatchObject({ name: "context7", unchanged: true })
    expect(await read(configPath())).toBe(before)
    await expect(read(`${configPath()}.bak`)).rejects.toThrow()
  })

  test("keeps every other server, every unknown key and the file's indentation", async () => {
    await fs.mkdir(profile, { recursive: true })
    const original = {
      $schema: "https://example.test/schema.json",
      mcpServers: {
        keep: { type: "http", url: "https://k", oauth: { clientId: "c" }, instructions: false },
        mine: { command: "old", auth: { type: "bearer" }, requestIdFormat: "string" },
      },
      disabledServers: ["elsewhere"],
      custom: { deep: [1, { two: 2 }] },
    }
    const raw = JSON.stringify(original, null, 4) + "\n"
    await fs.writeFile(configPath(), raw)

    const response = await call("PUT", "/mcp/mine", { body: { type: "local", command: ["new", "--x"] } })

    expect(response!.body).toMatchObject({ name: "mine", backup: `${configPath()}.bak` })
    const written = await read(configPath())
    expect(written).toStartWith('{\n    "$schema"')
    expect(JSON.parse(written)).toEqual({
      ...original,
      mcpServers: {
        keep: original.mcpServers.keep,
        mine: {
          auth: { type: "bearer" },
          requestIdFormat: "string",
          type: "stdio",
          command: "new",
          args: ["--x"],
          enabled: true,
        },
      },
    })
    expect(await read(`${configPath()}.bak`)).toBe(raw)
  })

  test("the backup is the original and a second rewrite does not replace it", async () => {
    await fs.mkdir(profile, { recursive: true })
    const raw = JSON.stringify({ mcpServers: { first: { command: "a" } } })
    await fs.writeFile(configPath(), raw)

    await call("PUT", "/mcp/second", { body: { type: "local", command: ["b"] } })
    await call("PUT", "/mcp/third", { body: { type: "local", command: ["c"] } })
    await call("DELETE", "/mcp/first")

    expect(await read(`${configPath()}.bak`)).toBe(raw)
    expect(Object.keys((await config()).mcpServers)).toEqual(["second", "third"])
  })

  // POSIX permission bits: Windows reports its own, so there is nothing to compare there.
  const posix = process.platform !== "win32"
  const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o777

  test.skipIf(!posix)("a rewrite keeps the file's own mode and the backup is private", async () => {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(configPath(), JSON.stringify({ mcpServers: { first: { command: "a", env: { KEY: "dummy" } } } }))
    await fs.chmod(configPath(), 0o600)

    await call("PUT", "/mcp/second", { body: { type: "local", command: ["b"] } })
    expect(await modeOf(configPath())).toBe(0o600)
    expect(await modeOf(`${configPath()}.bak`)).toBe(0o600)

    await call("DELETE", "/mcp/second")
    expect(await modeOf(configPath())).toBe(0o600)

    // A file somebody made group-readable on purpose stays that way.
    await fs.chmod(configPath(), 0o640)
    await call("PUT", "/mcp/third", { body: { type: "local", command: ["c"] } })
    expect(await modeOf(configPath())).toBe(0o640)
  })

  test.skipIf(!posix)("a config this host creates is private", async () => {
    await call("PUT", "/mcp/fresh", { body: { type: "remote", url: "https://example.test", headers: { authorization: "Bearer dummy" } } })
    expect(await modeOf(configPath())).toBe(0o600)
  })

  test("a server saved as sse stays sse", async () => {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(configPath(), JSON.stringify({ mcpServers: { live: { type: "sse", url: "https://old" } } }))

    await call("PUT", "/mcp/live", { body: { type: "remote", url: "https://new" } })

    expect((await config()).mcpServers.live).toEqual({ type: "sse", url: "https://new", enabled: true })
  })

  test("switching transport drops the other transport's fields but keeps unknown keys", async () => {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(
      configPath(),
      JSON.stringify({ mcpServers: { s: { command: "run", args: ["a"], env: { K: "v" }, cwd: "/w", oauth: { id: 1 } } } }),
    )

    await call("PUT", "/mcp/s", { body: { type: "remote", url: "https://s" } })

    expect((await config()).mcpServers.s).toEqual({ oauth: { id: 1 }, type: "http", url: "https://s", enabled: true })
  })

  test("drops empty header and environment rows the form leaves behind", async () => {
    await call("PUT", "/mcp/tidy", {
      body: { type: "local", command: ["run", ""], environment: { "": "orphan", KEY: "kept" } },
    })
    expect((await config()).mcpServers.tidy).toMatchObject({ command: "run", env: { KEY: "kept" } })
    expect((await config()).mcpServers.tidy.args).toBeUndefined()
  })

  describe("enablement", () => {
    test("a server on omp's disabledServers list reads as disabled, and saving it enabled lifts it off", async () => {
      await fs.mkdir(profile, { recursive: true })
      await fs.writeFile(
        configPath(),
        JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } }, disabledServers: ["a", "x"] }),
      )
      expect(((await call("GET", "/mcp"))!.body as any[]).map((entry) => entry.enabled)).toEqual([false, true])

      await call("PUT", "/mcp/a", { body: { type: "local", command: ["a"] } })

      expect((await config()).disabledServers).toEqual(["x"])
      expect(((await call("GET", "/mcp"))!.body as any[]).map((entry) => entry.enabled)).toEqual([true, true])
    })

    test("saving a server disabled leaves disabledServers alone", async () => {
      await fs.mkdir(profile, { recursive: true })
      await fs.writeFile(configPath(), JSON.stringify({ mcpServers: {}, disabledServers: ["x"] }))
      await call("PUT", "/mcp/a", { body: { type: "local", command: ["a"], enabled: false } })
      expect((await config()).disabledServers).toEqual(["x"])
      expect((await config()).mcpServers.a.enabled).toBe(false)
    })

    test("enabledServers switches an enabled:false entry back on", async () => {
      await fs.mkdir(profile, { recursive: true })
      await fs.writeFile(
        configPath(),
        JSON.stringify({ mcpServers: { a: { command: "a", enabled: false } }, enabledServers: ["a"] }),
      )
      expect(((await call("GET", "/mcp"))!.body as any[])[0].enabled).toBe(true)
    })

    test("saving a forced-on server disabled takes it off enabledServers and keeps the other names, keys and a backup", async () => {
      await fs.mkdir(profile, { recursive: true })
      const original = JSON.stringify({
        mcpServers: { a: { command: "a", enabled: false }, b: { command: "b" } },
        enabledServers: ["a", "b"],
        disabledServers: ["x"],
        extra: { keep: true },
      })
      await fs.writeFile(configPath(), original)
      expect(((await call("GET", "/mcp"))!.body as Array<{ enabled: boolean }>).map((entry) => entry.enabled)).toEqual([true, true])

      await call("PUT", "/mcp/a", { body: { type: "local", command: ["a"], enabled: false } })

      const saved = await config()
      expect(saved.enabledServers).toEqual(["b"])
      expect(saved.disabledServers).toEqual(["x"])
      expect(saved.extra).toEqual({ keep: true })
      expect(((await call("GET", "/mcp"))!.body as Array<{ enabled: boolean }>).map((entry) => entry.enabled)).toEqual([false, true])
      expect(await read(`${configPath()}.bak`)).toBe(original)
    })
  })

  test("refuses a server that could not start, rather than writing a config omp rejects", async () => {
    const local = await call("PUT", "/mcp/broken", { body: { type: "local", command: [] } })
    const remote = await call("PUT", "/mcp/broken", { body: { type: "remote", url: "  " } })

    expect(local!.status).toBe(400)
    expect(remote!.status).toBe(400)
    await expect(read(configPath())).rejects.toThrow()
  })

  test("delete removes only the named server", async () => {
    await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })
    await call("PUT", "/mcp/two", { body: { type: "local", command: ["b"] } })

    const response = await call("DELETE", "/mcp/one")

    expect(response!.body).toMatchObject({ name: "one", removed: true, backup: `${configPath()}.bak` })
    expect(Object.keys((await config()).mcpServers)).toEqual(["two"])
  })

  test("deleting something that was never configured is not an error, and creates nothing", async () => {
    expect((await call("DELETE", "/mcp/ghost"))?.body).toMatchObject({ removed: false })
    await expect(fs.access(profile)).rejects.toThrow()

    await call("PUT", "/mcp/real", { body: { type: "local", command: ["a"] } })
    const before = await read(configPath())
    expect((await call("DELETE", "/mcp/ghost"))?.body).toMatchObject({ removed: false })
    expect(await read(configPath())).toBe(before)
  })

  test("an empty mcp.json is a profile with no servers", async () => {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(configPath(), "")

    expect((await call("GET", "/mcp"))?.body).toEqual([])
    const saved = await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })
    expect(saved!.status).toBe(200)
    expect(Object.keys((await config()).mcpServers)).toEqual(["one"])
  })

  test("refuses to touch an mcp.json it cannot read as an object, and says why", async () => {
    for (const source of ["{ not json", "[]", '{"mcpServers": []}']) {
      await fs.mkdir(profile, { recursive: true })
      await fs.writeFile(configPath(), source)

      const put = await call("PUT", "/mcp/one", { body: { type: "local", command: ["a"] } })
      const del = await call("DELETE", "/mcp/one")

      expect(put!.status).toBe(400)
      expect((put!.body as any).error).toContain("mcp.json")
      expect(del!.status).toBe(400)
      expect(await read(configPath())).toBe(source)
      expect((await call("GET", "/mcp"))?.body).toEqual([])
    }
  })

  test("two saves at once both survive", async () => {
    await Promise.all([
      call("PUT", "/mcp/alpha", { body: { type: "local", command: ["a"] } }),
      call("PUT", "/mcp/beta", { body: { type: "remote", url: "https://b" } }),
    ])
    expect(Object.keys((await config()).mcpServers).sort()).toEqual(["alpha", "beta"])
  })

  test("an unnamed write is a 400, and other verbs fall through", async () => {
    expect((await call("PUT", "/mcp", { body: local }))!.status).toBe(400)
    expect(await call("PATCH", "/mcp/one")).toBeUndefined()
    expect(await call("GET", "/mcp/one")).toBeUndefined()
  })

  describe("without a known profile directory", () => {
    test("every route is 409 and nothing is written", async () => {
      const responses = [
        await call("GET", "/mcp", { profile: null }),
        await call("PUT", "/mcp/one", { body: local, profile: null }),
        await call("DELETE", "/mcp/one", { profile: null }),
      ]
      for (const response of responses) {
        expect(response!.status).toBe(409)
        expect(response!.body).toEqual({ error: "omp profile directory unknown: open Omp settings" })
      }
      expect(await fs.readdir(dir)).toEqual([])
    })

    test("a request that carries no profileDir is the same", async () => {
      const response = await handleFlow(paths, {
        method: "GET",
        path: "/mcp",
        search: new URLSearchParams(),
        json: async () => ({}),
      })
      expect(response!.status).toBe(409)
    })
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

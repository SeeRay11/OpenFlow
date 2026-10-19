import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isLegacySession, legacyModelProblems, migratePipeline, migrateRunLog } from "./migrate"
import { isPipeline } from "./pipeline-io"

const dir = fileURLToPath(new URL("./__fixtures__/legacy/", import.meta.url))
const files = readdirSync(dir).filter((file) => file.endsWith(".json"))

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${dir}${name}.json`, "utf8"))
}

function kinds(notes: { kind: string }[]) {
  return notes.map((note) => note.kind)
}

function nested(depth: number): unknown {
  let value: unknown = { leaf: true }
  for (let i = 0; i < depth; i++) value = { inner: value, list: [value] }
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rec(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("expected an object")
  return value
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array")
  return value
}

/** The `agent` object of every card in a migrated pipeline. */
function agents(pipeline: unknown) {
  return list(rec(pipeline).nodes).map((node) => rec(rec(node).agent))
}

describe("fixtures", () => {
  test("every fixture is covered by a migrator below", () => {
    expect(files.filter((file) => !file.startsWith("pipeline-") && !file.startsWith("run-"))).toEqual([])
  })

  for (const file of files.filter((name) => name.startsWith("pipeline-"))) {
    test(`${file}: migrates to a valid pipeline, without mutating the input, idempotently`, () => {
      const raw = JSON.parse(readFileSync(`${dir}${file}`, "utf8"))
      const before = JSON.stringify(raw)
      const first = migratePipeline(raw)
      expect(JSON.stringify(raw)).toBe(before)
      expect(isPipeline(first.pipeline)).toBe(true)
      const second = migratePipeline(first.pipeline)
      expect(second.pipeline).toEqual(first.pipeline)
      expect(second.notes).toEqual([])
    })
  }

  for (const file of files.filter((name) => name.startsWith("run-"))) {
    test(`${file}: migrates without mutating the input, idempotently`, () => {
      const raw = JSON.parse(readFileSync(`${dir}${file}`, "utf8"))
      const before = JSON.stringify(raw)
      const first = migrateRunLog(raw)
      expect(JSON.stringify(raw)).toBe(before)
      const second = migrateRunLog(first.run)
      expect(second.run).toEqual(first.run)
      expect(second.notes).toEqual([])
    })
  }
})

describe("migratePipeline", () => {
  test("real saved pipeline on opencode zen models: ids kept verbatim, one note per card", () => {
    const { pipeline, notes } = migratePipeline(fixture("pipeline-diamond"))
    expect(agents(pipeline).map((agent) => agent.model)).toEqual(Array(4).fill("opencode/nemotron-3.5-lightning-free"))
    expect(kinds(notes)).toEqual(Array(4).fill("legacy-model"))
    expect(notes.map((note) => note.nodeId)).toEqual(["nmsqpvewx1", "nmsqpvewy2", "nmsqpvewy3", "nmsqpvewy4"])
    expect(notes[0].message).toBe(
      "model opencode/nemotron-3.5-lightning-free is an OpenCode zen model: pick an Omp model",
    )
  })

  test("the other real pipeline migrates too, and reports only models", () => {
    const { notes } = migratePipeline(fixture("pipeline-feature-build"))
    expect(kinds(notes).every((kind) => kind === "legacy-model")).toBe(true)
    expect(notes.length).toBeGreaterThan(0)
  })

  test("FlowAgent.name is dropped with a legacy-agent note; an empty name is dropped silently", () => {
    const { pipeline, notes } = migratePipeline(fixture("pipeline-agent-name"))
    expect(agents(pipeline)[0]).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      prompt: "Build it.",
      tools: { read: true, write: true },
    })
    expect("name" in agents(pipeline)[1]).toBe(false)
    expect(notes).toHaveLength(1)
    expect(notes[0].kind).toBe("legacy-agent")
    expect(notes[0].nodeId).toBe("n1")
    expect(notes[0].message).toContain("agent 'build'")
    expect(notes[0].message).toContain("OpenCode agent")
  })

  test("an old per-card mcp allowlist loads with no note, is dropped, and does not stamp the document", () => {
    const raw = {
      id: "p",
      name: "old",
      nodes: [
        { id: "n1", role: "a", position: { x: 0, y: 0 }, agent: { prompt: "x", model: "anthropic/claude-sonnet-4-5", mcp: ["github"] } },
        { id: "n2", role: "b", position: { x: 0, y: 0 }, agent: { prompt: "y", mcp: [] } },
      ],
      edges: [],
    }
    const before = JSON.stringify(raw)
    const result = migratePipeline(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(result.notes).toEqual([])
    expect(isPipeline(result.pipeline)).toBe(true)
    expect(agents(result.pipeline).map((agent) => "mcp" in agent)).toEqual([false, false])
    expect("migratedFromOpencode" in rec(result.pipeline)).toBe(false)
  })

  test("a pipeline already on Omp models is returned unchanged with no notes", () => {
    const raw = fixture("pipeline-omp-native")
    const result = migratePipeline(raw)
    expect(result.notes).toEqual([])
    expect(result.pipeline).toEqual(raw)
    expect(isPipeline(result.pipeline)).toBe(true)
  })

  test("a pipeline authored with swarm and uplift fields is not flagged or stamped", () => {
    const raw = {
      id: "p",
      name: "fresh",
      defaultSwarm: "auto",
      nodes: [{ id: "n1", role: "a", position: { x: 0, y: 0 }, agent: { prompt: "x", swarm: "off", uplift: false } }],
      edges: [],
    }
    const result = migratePipeline(raw)
    expect(result.notes).toEqual([])
    expect(result.pipeline).toEqual(raw)
  })

  test("a field no build defines is still flagged on the pipeline, the card and the agent", () => {
    const { pipeline, notes } = migratePipeline({
      id: "p",
      name: "x",
      defaultSwarm: "auto",
      nodes: [{ id: "n1", role: "a", position: { x: 0, y: 0 }, agent: { prompt: "x", swarm: "off", mystery: 1 } }],
      edges: [],
      mystery: 1,
    })
    expect(notes.filter((note) => note.kind === "unknown-field")).toHaveLength(2)
    expect(rec(pipeline).migratedFromOpencode).toBe(1)
  })

  test("unknown fields at every level are preserved and named, never valued", () => {
    const { pipeline, notes } = migratePipeline(fixture("pipeline-orchestration"))
    const doc = rec(pipeline)
    expect(doc.futureSetting).toEqual({ enabled: true })
    expect(rec(list(doc.nodes)[0]).collapsed).toBe(true)
    expect(rec(list(doc.edges)[0]).label).toBe("dispatch")
    const unknown = notes.filter((note) => note.kind === "unknown-field")
    expect(unknown.map((note) => note.message)).toEqual([
      "the pipeline has fields this version does not know (futureSetting): kept as written",
      "card 'orchestrator' has fields this version does not know (collapsed): kept as written",
      "edge 'e1' has fields this version does not know (label): kept as written",
    ])
    expect(unknown[1].nodeId).toBe("root")
    // The orchestrator on a zen model also named an opencode agent.
    expect(kinds(notes)).toContain("legacy-agent")
    expect(kinds(notes)).toContain("legacy-model")
    expect(doc.mode).toBe("orchestration")
    expect(doc.gauntlet).toEqual({ maxSpend: 10, maxMinutes: 90, stall: 4 })
  })

  test("models that cannot be provider/id are kept as written and noted", () => {
    const { pipeline, notes } = migratePipeline(fixture("pipeline-bad-models"))
    expect(agents(pipeline).map((agent) => agent.model)).toEqual([
      "gpt-4",
      "anthropic/",
      "/claude",
      7,
      "OpenCode/Big-Pickle",
      "",
      "openrouter/openrouter/free",
    ])
    expect(notes.map((note) => note.nodeId)).toEqual(["n1", "n2", "n3", "n4", "n5"])
    expect(notes.map((note) => note.message)).toEqual([
      'model gpt-4 is not a "provider/id" pair: pick an Omp model',
      'model anthropic/ is not a "provider/id" pair: pick an Omp model',
      'model /claude is not a "provider/id" pair: pick an Omp model',
      'model is number, not a "provider/id" string: pick an Omp model',
      "model OpenCode/Big-Pickle is an OpenCode zen model: pick an Omp model",
    ])
  })

  test("a nested provider slash is a valid Omp model", () => {
    expect(migratePipeline({ id: "p", name: "p", nodes: [], edges: [] }).notes).toEqual([])
    const { notes } = migratePipeline(fixture("pipeline-bad-models"))
    expect(notes.some((note) => note.message.includes("openrouter/openrouter/free"))).toBe(false)
  })

  test("a pipeline with an unsupported mode is passed through for isPipeline to refuse", () => {
    const raw = { id: "p", name: "p", mode: "turbo", nodes: [], edges: [] }
    const { pipeline } = migratePipeline(raw)
    expect(pipeline).toEqual(raw)
    expect(isPipeline(pipeline)).toBe(false)
  })
})

describe("legacyModelProblems", () => {
  test("lists each card that still cannot run, by role, before and after migration", () => {
    const raw = fixture("pipeline-bad-models")
    const expected = [
      "Card 'no-slash': model gpt-4 is not a \"provider/id\" pair: pick an Omp model",
      "Card 'no-id': model anthropic/ is not a \"provider/id\" pair: pick an Omp model",
      "Card 'no-provider': model /claude is not a \"provider/id\" pair: pick an Omp model",
      "Card 'not-a-string': model is number, not a \"provider/id\" string: pick an Omp model",
      "Card 'mixed-case': model OpenCode/Big-Pickle is an OpenCode zen model: pick an Omp model",
    ]
    expect(legacyModelProblems(raw)).toEqual(expected)
    expect(legacyModelProblems(migratePipeline(raw).pipeline)).toEqual(expected)
  })

  test("a migrated zen pipeline keeps reporting, though migrate no longer repeats the notes", () => {
    const { pipeline } = migratePipeline(fixture("pipeline-diamond"))
    expect(legacyModelProblems(pipeline)).toHaveLength(4)
    expect(legacyModelProblems(pipeline)[0]).toBe(
      "Card 'planner': model opencode/nemotron-3.5-lightning-free is an OpenCode zen model: pick an Omp model",
    )
  })

  test("is empty for an Omp pipeline and for shapes it cannot read", () => {
    expect(legacyModelProblems(fixture("pipeline-omp-native"))).toEqual([])
    for (const value of [null, undefined, 3, "x", [], {}, { nodes: 3 }, { nodes: [null, 1, { agent: 1 }] }]) {
      expect(legacyModelProblems(value)).toEqual([])
    }
  })
})

describe("isLegacySession", () => {
  test("recognises opencode's ses_ prefix and not the host's s_ prefix", () => {
    expect(isLegacySession("ses_2a1f0c3d8ffeAbCdEf")).toBe(true)
    expect(isLegacySession("s_01HABC")).toBe(false)
    expect(isLegacySession("")).toBe(false)
    expect(isLegacySession("xses_1")).toBe(false)
  })
})

describe("migrateRunLog", () => {
  test("keeps opencode sessionIDs and says they cannot be resumed", () => {
    const raw = fixture("run-legacy")
    const { run, notes } = migrateRunLog(raw)
    const sessions = (value: unknown) => list(rec(value).nodes).map((node) => rec(node).sessionID)
    expect(sessions(run)).toEqual(sessions(raw))
    expect(rec(run).customerNote).toBe("kept")
    expect(notes).toEqual([
      { kind: "unknown-field", message: "the run log has fields this version does not know (customerNote): kept as written" },
      {
        kind: "legacy-session",
        nodeId: "nmsqpvewx1",
        message: "session ses_2a1f0c3d8ffeAbCdEf is an OpenCode session: it can be read but cannot be resumed",
      },
      {
        kind: "legacy-session",
        nodeId: "nmsqpvewy2",
        message: "session ses_3b2e1d4e9ggfBcDeFg is an OpenCode session: it can be read but cannot be resumed",
      },
    ])
  })

  test("a run recorded by the Omp engine has no notes and is unchanged", () => {
    const raw = fixture("run-omp")
    const result = migrateRunLog(raw)
    expect(result.notes).toEqual([])
    expect(result.run).toEqual(raw)
  })

  test("a run log with uplift, memory and swarm stage data is not flagged or stamped", () => {
    const raw = {
      id: "r",
      pipeline: "p",
      pipelineID: "p",
      input: "x",
      status: "done",
      started: 1,
      nodes: [{ id: "n1", role: "a", status: "done", uplift: { original: "a" }, memory: { read: 0 }, swarm: { mode: "off" } }],
    }
    const result = migrateRunLog(raw)
    expect(result.notes).toEqual([])
    expect(result.run).toEqual(raw)
  })

  test("a run-node field no build defines is still flagged", () => {
    const { notes } = migrateRunLog({
      id: "r",
      pipeline: "p",
      pipelineID: "p",
      input: "x",
      status: "done",
      started: 1,
      nodes: [{ id: "n1", role: "a", status: "done", uplift: {}, mystery: 1 }],
    })
    expect(notes.map((note) => note.kind)).toEqual(["unknown-field"])
  })

  test("malformed nodes never throw; legacy sessions among them are still found", () => {
    const { run, notes } = migrateRunLog(fixture("run-malformed-nodes"))
    expect(list(rec(run).nodes)).toHaveLength(5)
    expect(notes.map((note) => note.kind)).toEqual(["unknown-field", "legacy-session"])
    expect(notes[0].nodeId).toBe("y")
    expect(notes[1].nodeId).toBe("y")
  })
})

describe("malformed input", () => {
  const scalars: unknown[] = [null, undefined, 0, 1.5, true, "", "{}", "ses_1", [], [1, 2], [{ id: "x" }]]

  test("non-objects come back as given with a note, from both migrators", () => {
    for (const value of scalars) {
      const pipeline = migratePipeline(value)
      expect(pipeline.pipeline).toBe(value)
      expect(pipeline.notes).toEqual([
        { kind: "unknown-field", message: "the pipeline is not a JSON object, so it was left untouched" },
      ])
      const run = migrateRunLog(value)
      expect(run.run).toBe(value)
      expect(run.notes).toEqual([
        { kind: "unknown-field", message: "the run log is not a JSON object, so it was left untouched" },
      ])
      expect(isPipeline(pipeline.pipeline)).toBe(false)
    }
  })

  test("deep nesting does not overflow the stack", () => {
    const deep = nested(50_000)
    const asPipeline = { id: "p", name: "p", nodes: [{ id: "n", role: "r", agent: { prompt: "", deep }, position: { x: 0, y: 0 } }], edges: [], deep }
    const result = migratePipeline(asPipeline)
    expect(result.notes.map((note) => note.kind)).toEqual(["unknown-field", "unknown-field"])
    expect(rec(result.pipeline).deep).toBe(deep)
    const run = migrateRunLog({ id: "r", nodes: [{ id: "n", sessionID: "ses_1", deep }], deep })
    expect(run.notes.map((note) => note.kind)).toEqual(["unknown-field", "unknown-field", "legacy-session"])
    expect(migratePipeline(deep).notes).toHaveLength(1)
  })

  test("malformed parts of an otherwise real pipeline are passed through for isPipeline to refuse", () => {
    const graph = fixture("pipeline-agent-name") as Record<string, unknown>
    const broken = { ...graph, nodes: [null, "x", { id: 3, agent: [] }, { id: "ok", role: "r", agent: null }], edges: [7, null, []] }
    const result = migratePipeline(broken)
    expect(result.notes.every((note) => note.kind === "unknown-field")).toBe(true)
    expect(isPipeline(result.pipeline)).toBe(false)
    expect(legacyModelProblems(result.pipeline)).toEqual([])
  })

  test("a stray __proto__ key from JSON.parse is kept as data and does not pollute", () => {
    const raw = JSON.parse('{"id":"p","name":"p","nodes":[],"edges":[],"__proto__":{"polluted":true}}')
    const { pipeline } = migratePipeline(raw)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(pipeline as object)).toContain("__proto__")
  })

  test("fuzz shapes: never throws, always idempotent once stamped", () => {
    const leaves: unknown[] = [null, 0, "", "opencode/x", "ses_1", [], {}, true, nested(3)]
    const keys = ["id", "name", "nodes", "edges", "mode", "agent", "model", "sessionID", "role", "position", "prompt", "extra", "migratedFromOpencode"]
    let seed = 7
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const make = (depth: number): unknown => {
      if (depth === 0 || next(4) === 0) return leaves[next(leaves.length)]
      if (next(3) === 0) return Array.from({ length: next(4) }, () => make(depth - 1))
      const out: Record<string, unknown> = {}
      for (let i = next(6); i > 0; i--) out[keys[next(keys.length)]] = make(depth - 1)
      return out
    }
    for (let i = 0; i < 2000; i++) {
      const value = make(5)
      const pipeline = migratePipeline(value)
      const again = migratePipeline(pipeline.pipeline)
      expect(again.pipeline).toEqual(pipeline.pipeline)
      const run = migrateRunLog(value)
      expect(migrateRunLog(run.run).run).toEqual(run.run)
      expect(Array.isArray(legacyModelProblems(value))).toBe(true)
    }
  })
})

describe("idempotence", () => {
  test("a migrated document migrates to itself with no notes, including after a JSON round trip", () => {
    for (const name of ["pipeline-diamond", "pipeline-agent-name", "pipeline-orchestration", "pipeline-bad-models"]) {
      const first = migratePipeline(fixture(name))
      expect(first.notes.length).toBeGreaterThan(0)
      const reloaded = JSON.parse(JSON.stringify(first.pipeline))
      const second = migratePipeline(reloaded)
      expect(second.notes).toEqual([])
      expect(second.pipeline).toEqual(reloaded)
    }
    const run = migrateRunLog(fixture("run-legacy"))
    const reloaded = JSON.parse(JSON.stringify(run.run))
    expect(migrateRunLog(reloaded).notes).toEqual([])
    expect(migrateRunLog(reloaded).run).toEqual(reloaded)
  })

  test("a stamped document still reports an opencode agent name it somehow regained", () => {
    const first = migratePipeline(fixture("pipeline-diamond")).pipeline
    agents(first)[0].name = "build"
    const { notes } = migratePipeline(first)
    expect(kinds(notes)).toEqual(["legacy-agent"])
  })

  test("the stamp is only added when there was something to report", () => {
    const clean = migratePipeline(fixture("pipeline-omp-native")).pipeline
    expect("migratedFromOpencode" in rec(clean)).toBe(false)
    const dirty = migratePipeline(fixture("pipeline-diamond")).pipeline
    expect(rec(dirty).migratedFromOpencode).toBe(1)
  })
})

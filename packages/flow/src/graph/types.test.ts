import { describe, expect, test } from "bun:test"
import { isPipeline } from "./pipeline-io"
import { pipeline } from "./test-support"
import {
  DEFAULT_DEPTH,
  DEFAULT_MAX_MINUTES,
  DEFAULT_MAX_SPEND,
  DEFAULT_STALL,
  DEFAULT_DISPATCHES,
  DEFAULT_ROUNDS,
  depthOf,
  dispatchesOf,
  gauntletOf,
  emptyPipeline,
  isolationOf,
  MAX_DEPTH,
  MAX_MAX_MINUTES,
  MAX_MAX_SPEND,
  MAX_STALL,
  MAX_DISPATCHES,
  MAX_ROUNDS,
  modeOf,
  MODES,
  roundsOf,
  type Pipeline,
  type RunLog,
  type RunNodeLog,
} from "./types"

describe("modeOf", () => {
  test("a canvas saved before modes existed reads as pipeline", () => {
    const graph = pipeline("a->b")
    expect(graph.mode).toBeUndefined()
    expect(modeOf(graph)).toBe("pipeline")
    expect(modeOf(emptyPipeline())).toBe("pipeline")
  })

  test("every declared mode round-trips", () => {
    for (const mode of MODES) expect(modeOf({ ...pipeline("a"), mode })).toBe(mode)
  })

  test("a mode this build does not know reads as pipeline, not as whatever came last", () => {
    // A hand-edited store file must open as the safest graph there is rather
    // than falling through a scheduler switch.
    const graph = { ...pipeline("a"), mode: "quantum" } as unknown as Pipeline
    expect(modeOf(graph)).toBe("pipeline")
  })
})

describe("roundsOf", () => {
  test("a swarm with no round count set debates the default number of times", () => {
    expect(roundsOf(pipeline("a"))).toBe(DEFAULT_ROUNDS)
  })

  test("clamps to what the engine will actually dispatch", () => {
    // Rounds multiply the whole bill — agents x rounds + 1 sessions — so a
    // hand-edited file cannot talk the engine into an unbounded run.
    expect(roundsOf({ ...pipeline("a"), rounds: MAX_ROUNDS + 40 })).toBe(MAX_ROUNDS)
    expect(roundsOf({ ...pipeline("a"), rounds: 0 })).toBe(1)
    expect(roundsOf({ ...pipeline("a"), rounds: -3 })).toBe(1)
  })

  test("a fractional or unusable count falls back rather than half-running a round", () => {
    expect(roundsOf({ ...pipeline("a"), rounds: 2.7 })).toBe(2)
    expect(roundsOf({ ...pipeline("a"), rounds: Number.NaN })).toBe(DEFAULT_ROUNDS)
  })
})

describe("orchestration budgets", () => {
  test("default until the graph says otherwise", () => {
    expect(depthOf(pipeline("a"))).toBe(DEFAULT_DEPTH)
    expect(dispatchesOf(pipeline("a"))).toBe(DEFAULT_DISPATCHES)
  })

  test("clamp, because depth is the exponent on an orchestration's bill", () => {
    expect(depthOf({ ...pipeline("a"), depth: 99 })).toBe(MAX_DEPTH)
    expect(depthOf({ ...pipeline("a"), depth: 0 })).toBe(1)
    expect(dispatchesOf({ ...pipeline("a"), dispatches: 99 })).toBe(MAX_DISPATCHES)
    expect(dispatchesOf({ ...pipeline("a"), dispatches: -1 })).toBe(1)
  })
})

describe("isolationOf", () => {
  test("off when the canvas has not asked", () => {
    expect(isolationOf({ ...emptyPipeline(), mode: "orchestration" })).toBe(false)
  })

  test("on when it has", () => {
    expect(isolationOf({ ...emptyPipeline(), mode: "orchestration", isolate: true })).toBe(true)
  })

  // The other modes have no orchestrator to hand a merge conflict to, which is
  // what makes isolation worth its cost.
  test("orchestration only, whatever the file says", () => {
    expect(isolationOf({ ...emptyPipeline(), mode: "swarm", isolate: true })).toBe(false)
    expect(isolationOf({ ...emptyPipeline(), isolate: true })).toBe(false)
  })

  // A hand-edited file must not talk the engine into it with a truthy value.
  test("only a real true counts", () => {
    expect(isolationOf({ ...emptyPipeline(), mode: "orchestration", isolate: "yes" as never })).toBe(false)
  })
})

describe("gauntlet settings", () => {
  const gauntlet = (graph: Pipeline, settings: Pipeline["gauntlet"] = {}) => ({ ...graph, gauntlet: settings })
  const orchestration = (graph: Pipeline) => ({ ...graph, mode: "orchestration" as const })

  test("absent unless the canvas asks for one", () => {
    expect(gauntletOf(orchestration(pipeline("a")))).toBeUndefined()
  })

  test("a gauntlet is something an orchestration does, so no other mode reads it", () => {
    // A canvas switched back to pipeline keeps the settings in the file; they
    // must not reach a scheduler that has no builders and critics in it.
    expect(gauntletOf(gauntlet(pipeline("a"), { bar: "beat this" }))).toBeUndefined()
    expect(gauntletOf(gauntlet({ ...pipeline("a"), mode: "swarm" }, { bar: "beat this" }))).toBeUndefined()
    expect(gauntletOf(gauntlet(orchestration(pipeline("a")), { bar: "beat this" }))?.bar).toBe("beat this")
  })

  test("defaults when the canvas sets only a bar", () => {
    const settings = gauntletOf(gauntlet(orchestration(pipeline("a")), { bar: "  beat this  " }))!
    expect(settings.bar).toBe("beat this")
    expect(settings.maxSpend).toBe(DEFAULT_MAX_SPEND)
    expect(settings.maxMinutes).toBe(DEFAULT_MAX_MINUTES)
    expect(settings.stall).toBe(DEFAULT_STALL)
  })

  test("clamps, because these caps are the only thing bounding an hours-long run", () => {
    const huge = gauntletOf(gauntlet(orchestration(pipeline("a")), { maxSpend: 1e9, maxMinutes: 1e9, stall: 1e9 }))!
    expect(huge.maxSpend).toBe(MAX_MAX_SPEND)
    expect(huge.maxMinutes).toBe(MAX_MAX_MINUTES)
    expect(huge.stall).toBe(MAX_STALL)

    const zeroed = gauntletOf(gauntlet(orchestration(pipeline("a")), { maxSpend: 0, maxMinutes: 0, stall: 0 }))!
    expect(zeroed.maxSpend).toBe(0.01)
    expect(zeroed.maxMinutes).toBe(1)
    expect(zeroed.stall).toBe(1)
  })

  test("spend keeps its cents — it is the one budget that is not a count", () => {
    expect(gauntletOf(gauntlet(orchestration(pipeline("a")), { maxSpend: 2.5 }))!.maxSpend).toBe(2.5)
    expect(gauntletOf(gauntlet(orchestration(pipeline("a")), { maxSpend: Number.NaN }))!.maxSpend).toBe(DEFAULT_MAX_SPEND)
  })
})

describe("what a card run records", () => {
  const node: RunNodeLog = {
    id: "a",
    role: "coder",
    status: "done",
    prompt: "<BUILD_PROMPT>spec</BUILD_PROMPT>",
    uplift: { status: "ok", original: "do it", uplifted: "<BUILD_PROMPT>spec</BUILD_PROMPT>", elapsedMs: 12 },
    memory: {
      read: { status: "ok", items: [{ scope: "repo:o/n", subject: "openflow/x/r/b", preview: "p", origin: "brief" }] },
      write: { status: "stored", subject: "openflow/x/r/a" },
    },
    swarm: {
      mode: "auto",
      active: true,
      counts: { queued: 0, running: 1, completed: 0, failed: 0, cancelled: 0 },
      agents: [{ agent: "a05-backend", state: "running", at: 1 }],
      updatedAt: 1,
    },
  }
  const log = (nodes: RunNodeLog[]): RunLog => ({
    id: "run-1",
    pipeline: "p",
    pipelineID: "p1",
    input: "x",
    status: "done",
    started: 1,
    nodes,
  })

  test("the original and uplifted prompts, memory and swarm state survive a JSON round trip", () => {
    const back = JSON.parse(JSON.stringify(log([node]))) as RunLog
    expect(back.nodes[0]).toEqual(node)
    expect(back.nodes[0].uplift?.original).toBe("do it")
    expect(back.nodes[0].prompt).toBe(back.nodes[0].uplift?.uplifted)
  })

  test("a log written before these fields existed still reads, with them absent", () => {
    const old = JSON.parse('{"id":"run-0","pipeline":"p","pipelineID":"p1","input":"x","status":"done","started":1,"nodes":[{"id":"a","role":"coder","status":"done","agent":"flow-a","prompt":"sent"}]}') as RunLog
    expect(old.nodes[0].uplift).toBeUndefined()
    expect(old.nodes[0].memory).toBeUndefined()
    expect(old.nodes[0].swarm).toBeUndefined()
    expect(old.nodes[0].prompt).toBe("sent")
  })
})

describe("a card's engine fields in a saved canvas", () => {
  test("swarm and uplift persist through JSON and a file with them still imports", () => {
    const graph: Pipeline = { ...pipeline("a"), defaultSwarm: "auto" }
    graph.nodes[0].agent.swarm = "always"
    graph.nodes[0].agent.uplift = false
    const back = JSON.parse(JSON.stringify(graph)) as Pipeline
    expect(back.defaultSwarm).toBe("auto")
    expect(back.nodes[0].agent.swarm).toBe("always")
    expect(back.nodes[0].agent.uplift).toBe(false)
    expect(isPipeline(back)).toBe(true)
  })

  test("a file saved before cards ran on Omp, naming an agent, still imports", () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.name = "flow-a"
    expect(isPipeline(JSON.parse(JSON.stringify(graph)))).toBe(true)
  })
})

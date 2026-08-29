import { describe, expect, test } from "bun:test"
import { pipeline } from "./test-support"
import {
  DEFAULT_DEPTH,
  DEFAULT_DISPATCHES,
  DEFAULT_ROUNDS,
  depthOf,
  dispatchesOf,
  emptyPipeline,
  MAX_DEPTH,
  MAX_DISPATCHES,
  MAX_ROUNDS,
  modeOf,
  MODES,
  roundsOf,
  type Pipeline,
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

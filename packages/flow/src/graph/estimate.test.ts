import { describe, expect, test } from "bun:test"
import { TURN_TOKENS, estimate, estimateLabel, turnsOf } from "./estimate"
import { pipeline } from "./test-support"
import type { Pipeline } from "./types"

const PRICE = { input: 2, output: 10 }
const prices = new Map([["openai/gpt-x", PRICE]])

function onModel(graph: Pipeline, model = "openai/gpt-x"): Pipeline {
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, agent: { ...node.agent, model } })) }
}

const turnLow = (TURN_TOKENS.low.input * PRICE.input + TURN_TOKENS.low.output * PRICE.output) / 1_000_000
const turnHigh = (TURN_TOKENS.high.input * PRICE.input + TURN_TOKENS.high.output * PRICE.output) / 1_000_000

describe("turnsOf", () => {
  test("a pipeline card answers once", () => {
    expect([...turnsOf(pipeline("a->b", "b->c")).values()]).toEqual([
      { low: 1, high: 1 },
      { low: 1, high: 1 },
      { low: 1, high: 1 },
    ])
  })

  test("a swarm peer answers once a round, the synthesizer once", () => {
    const graph = { ...pipeline("a", "b", "synthesizer"), mode: "swarm" as const, rounds: 3 }
    const turns = turnsOf(graph)
    expect(turns.get("a")).toEqual({ low: 3, high: 3 })
    expect(turns.get("synthesizer")).toEqual({ low: 1, high: 1 })
  })

  test("an orchestration's ceiling multiplies down the tree, like worstCase", () => {
    const graph = { ...pipeline("root->mid", "mid->leaf"), mode: "orchestration" as const, dispatches: 2 }
    const turns = turnsOf(graph)
    expect(turns.get("root")).toEqual({ low: 2, high: 3 })
    expect(turns.get("mid")).toEqual({ low: 2, high: 6 })
    expect(turns.get("leaf")).toEqual({ low: 1, high: 4 })
  })

  test("a gauntlet has no ceiling but the cap", () => {
    const graph: Pipeline = { ...pipeline("root->builder", "root->reviewer"), mode: "orchestration", gauntlet: {} }
    expect(turnsOf(graph).get("builder")!.high).toBeUndefined()
  })

  test("verification adds a turn per reviewer card", () => {
    const graph: Pipeline = { ...pipeline("coder->reviewer"), verify: {} }
    expect(turnsOf(graph).get("reviewer")).toEqual({ low: 2, high: 2 })
  })
})

describe("estimate", () => {
  test("prices each turn at both ends", () => {
    const value = estimate(onModel(pipeline("a->b")), prices)
    expect(value.low).toBeCloseTo(2 * turnLow)
    expect(value.high).toBeCloseTo(2 * turnHigh)
    expect(value.unpriced).toEqual([])
  })

  test("an unpriced model is named, never counted as free", () => {
    const value = estimate(onModel(pipeline("a")), new Map())
    expect(value.unpriced).toEqual(["openai/gpt-x"])
    expect(estimateLabel(value)).toBe("unpriced")
  })

  test("a model priced at zero — a local one — is free, not unpriced", () => {
    const value = estimate(onModel(pipeline("a->b"), "local-ollama/qwen3"), new Map([["local-ollama/qwen3", { input: 0, output: 0 }]]))
    expect(value.unpriced).toEqual([])
    expect(estimateLabel(value)).toBe("$0")
  })

  test("the label shows the range, clipped at the cap", () => {
    expect(estimateLabel(estimate(onModel(pipeline("a")), prices))).toBe(
      `≈ $${turnLow.toFixed(2)}–$${turnHigh.toFixed(2)}`,
    )
    const capped = estimate({ ...onModel(pipeline("a")), maxSpend: 1 }, new Map([["openai/gpt-x", { input: 100, output: 100 }]]))
    expect(estimateLabel(capped)).toEndWith("(capped)")
  })

  test("an open run says it runs to the cap", () => {
    const graph: Pipeline = { ...onModel(pipeline("root->builder", "root->reviewer")), mode: "orchestration", gauntlet: { maxSpend: 7 } }
    expect(estimateLabel(estimate(graph, prices))).toEndWith("up to the $7 cap")
  })
})

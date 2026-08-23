import { describe, expect, test } from "bun:test"
import { isPipeline } from "./pipeline-io"
import { pipeline } from "./test-support"

describe("isPipeline", () => {
  test("accepts a real pipeline, including one with nodes and edges", () => {
    expect(isPipeline(pipeline())).toBe(true)
    expect(isPipeline(pipeline("a->b", "b->c"))).toBe(true)
  })

  test("rejects non-objects", () => {
    expect(isPipeline(null)).toBe(false)
    expect(isPipeline("{}")).toBe(false)
    expect(isPipeline(42)).toBe(false)
  })

  test("rejects a missing name", () => {
    const graph = pipeline("a") as Record<string, unknown>
    delete graph.name
    expect(isPipeline(graph)).toBe(false)
  })

  test("rejects nodes that are not an array", () => {
    expect(isPipeline({ ...pipeline("a"), nodes: {} })).toBe(false)
  })

  test("rejects an edge missing its target", () => {
    const graph = pipeline("a->b")
    graph.edges[0] = { id: "e0", source: "a" } as (typeof graph.edges)[number]
    expect(isPipeline(graph)).toBe(false)
  })

  test("rejects a node missing its position", () => {
    const graph = pipeline("a")
    delete (graph.nodes[0] as Record<string, unknown>).position
    expect(isPipeline(graph)).toBe(false)
  })

  test("rejects a node whose agent has no prompt string", () => {
    const graph = pipeline("a")
    ;(graph.nodes[0].agent as Record<string, unknown>).prompt = 5
    expect(isPipeline(graph)).toBe(false)
  })

  test("a round-trip through JSON preserves validity", () => {
    const graph = pipeline("a->b", "b->c")
    expect(isPipeline(JSON.parse(JSON.stringify(graph)))).toBe(true)
  })
})

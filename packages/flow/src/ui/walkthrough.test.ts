import { describe, expect, test } from "bun:test"
import { walkthroughState } from "./walkthrough"

const base = { engineReachable: true, unlockedProviders: 0, nodes: 0, edges: 0, dismissed: false }

describe("walkthroughState", () => {
  test("a fresh empty canvas is visible with nothing done", () => {
    const result = walkthroughState({ ...base, engineReachable: false })
    expect(result.visible).toBe(true)
    expect(result.steps).toEqual({ engine: false, provider: false, node: false, connect: false })
  })

  test("the engine step ticks once the server answers", () => {
    expect(walkthroughState(base).steps.engine).toBe(true)
    expect(walkthroughState({ ...base, engineReachable: false }).steps.engine).toBe(false)
  })

  test("an unlocked provider ticks step one", () => {
    expect(walkthroughState({ ...base, unlockedProviders: 1 }).steps.provider).toBe(true)
  })

  test("a node hides the overlay and ticks step two", () => {
    const result = walkthroughState({ ...base, nodes: 1 })
    expect(result.visible).toBe(false)
    expect(result.steps.node).toBe(true)
  })

  test("a single node counts as connected without an edge", () => {
    expect(walkthroughState({ ...base, nodes: 1, edges: 0 }).steps.connect).toBe(true)
  })

  test("a multi-node graph needs an edge to count as connected", () => {
    expect(walkthroughState({ ...base, nodes: 2, edges: 0 }).steps.connect).toBe(false)
    expect(walkthroughState({ ...base, nodes: 2, edges: 1 }).steps.connect).toBe(true)
  })

  test("dismissed hides the overlay even on an empty canvas", () => {
    expect(walkthroughState({ ...base, dismissed: true }).visible).toBe(false)
  })
})

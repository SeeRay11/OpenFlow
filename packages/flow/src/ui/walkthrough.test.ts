import { describe, expect, test } from "bun:test"
import { walkthroughState } from "./walkthrough"

const base = { hostReachable: true, ompReady: true, modelCount: 0, nodes: 0, edges: 0, dismissed: false }

describe("walkthroughState", () => {
  test("a fresh empty canvas is visible with nothing done", () => {
    const result = walkthroughState({ ...base, hostReachable: false, ompReady: false })
    expect(result.visible).toBe(true)
    expect(result.steps).toEqual({ omp: false, models: false, node: false, connect: false })
  })

  test("the omp step needs a reachable host and a ready omp", () => {
    expect(walkthroughState(base).steps.omp).toBe(true)
    expect(walkthroughState({ ...base, hostReachable: false }).steps.omp).toBe(false)
    expect(walkthroughState({ ...base, ompReady: false }).steps.omp).toBe(false)
  })

  test("a listed model ticks the models step", () => {
    expect(walkthroughState({ ...base, modelCount: 1 }).steps.models).toBe(true)
    expect(walkthroughState(base).steps.models).toBe(false)
  })

  test("a node hides the overlay and ticks the node step", () => {
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

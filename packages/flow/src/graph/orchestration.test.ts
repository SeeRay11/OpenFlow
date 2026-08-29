import { describe, expect, test } from "bun:test"
import { orchestrationShape, subagentsOf } from "./orchestration"
import { pipeline } from "./test-support"

describe("orchestrationShape", () => {
  test("finds the card nothing points at, and what hangs under it", () => {
    const shape = orchestrationShape(pipeline("root->a", "root->b"))
    expect(shape.root.id).toBe("root")
    expect(shape.children("root")).toEqual(["a", "b"])
    expect(shape.children("a")).toEqual([])
  })

  test("counts depth in dispatch levels, so a lone card is zero", () => {
    expect(orchestrationShape(pipeline("root")).depth).toBe(0)
    expect(orchestrationShape(pipeline("root->a")).depth).toBe(1)
    expect(orchestrationShape(pipeline("root->a", "a->b")).depth).toBe(2)
    // The deepest branch decides, not the average.
    expect(orchestrationShape(pipeline("root->a", "root->b", "b->c", "c->d")).depth).toBe(3)
  })

  test("names every card two orchestrators both dispatch", () => {
    const shape = orchestrationShape(pipeline("root->a", "root->b", "a->shared", "b->shared"))
    expect(shape.shared.map((node) => node.id)).toEqual(["shared"])
  })

  test("names every root, because a second one is a second run nobody asked for", () => {
    const shape = orchestrationShape(pipeline("root->a", "other->b"))
    expect(shape.roots.map((node) => node.id)).toEqual(["root", "other"])
  })

  test("terminates on a graph that still has a cycle in it", () => {
    // The canvas is read while the user is mid-edit, when the graph is
    // legitimately not yet a tree.
    const shape = orchestrationShape(pipeline("a->b", "b->a"))
    expect(shape.roots).toEqual([])
    expect(shape.depth).toBe(0)
  })
})

describe("subagentsOf", () => {
  test("returns the cards a given orchestrator may dispatch to", () => {
    const graph = pipeline("root->a", "root->b", "a->deep")
    const root = graph.nodes.find((node) => node.id === "root")!
    const a = graph.nodes.find((node) => node.id === "a")!

    expect(subagentsOf(graph, root).map((node) => node.id)).toEqual(["a", "b"])
    expect(subagentsOf(graph, a).map((node) => node.id)).toEqual(["deep"])
  })

  test("a leaf has nobody, which is what makes it a leaf", () => {
    const graph = pipeline("root->a")
    expect(subagentsOf(graph, graph.nodes.find((node) => node.id === "a")!)).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { meshPairs, swarmShape } from "./swarm"
import { pipeline } from "./test-support"

/** The builder names every node after its id, so a synthesizer is made by hand. */
function withSynthesizer(...ids: string[]) {
  const graph = pipeline(...ids)
  for (const id of ids)
    if (id.startsWith("s")) graph.nodes.find((node) => node.id === id)!.role = "synthesizer"
  return graph
}

describe("swarmShape", () => {
  test("splits the canvas by role, and everything unnamed is an agent", () => {
    const shape = swarmShape(withSynthesizer("a", "b", "s1"))
    expect(shape.agents.map((node) => node.id)).toEqual(["a", "b"])
    expect(shape.synthesizers.map((node) => node.id)).toEqual(["s1"])
  })

  test("keeps every synthesizer, because two of them is a mistake worth reporting", () => {
    const shape = swarmShape(withSynthesizer("a", "s1", "s2"))
    expect(shape.synthesizers.map((node) => node.id)).toEqual(["s1", "s2"])
  })

  test("reads the node list, not the edges — a swarm's peers are never wired", () => {
    const wired = swarmShape(withSynthesizer("a->b"))
    expect(wired.agents.map((node) => node.id)).toEqual(["a", "b"])
    expect(wired.synthesizers).toEqual([])
  })
})

describe("meshPairs", () => {
  test("draws each pair once — both directions would lay two lines on one path", () => {
    const agents = swarmShape(pipeline("a", "b", "c")).agents
    expect(meshPairs(agents).map((pair) => `${pair.from.id}${pair.to.id}`)).toEqual(["ab", "ac", "bc"])
  })

  test("a swarm of one has nothing to draw", () => {
    expect(meshPairs(swarmShape(pipeline("a")).agents)).toEqual([])
  })

  test("grows quadratically, which is why the mesh is never stored", () => {
    const agents = swarmShape(pipeline("a", "b", "c", "d", "e")).agents
    expect(meshPairs(agents)).toHaveLength(10)
  })
})

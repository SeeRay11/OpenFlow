import { describe, expect, test } from "bun:test"
import { pipeline } from "../graph/test-support"
import type { Pipeline } from "../graph/types"
import { agentKey, cardSpec, swarmOf, TOOL_ACTIONS, TOOLS, toolMap } from "./card-spec"

describe("toolMap", () => {
  test("folds the edit aliases onto one toggle, and a deny anywhere in the group wins", () => {
    expect(toolMap({ write: true, patch: false, read: true })).toEqual({ edit: false, read: true })
    expect(toolMap({ edit: true, "apply-patch": true })).toEqual({ edit: true })
  })

  test("drops names outside the vocabulary and values that are not booleans", () => {
    expect(toolMap({ ghost: true, read: "yes" as unknown as boolean, bash: false })).toEqual({ bash: false })
    expect(toolMap(undefined)).toEqual({})
  })

  test("the vocabulary is the names the host translates", () => {
    expect(TOOLS).toEqual(Object.keys(TOOL_ACTIONS))
    expect(TOOLS).toEqual([
      "read",
      "grep",
      "glob",
      "edit",
      "bash",
      "webfetch",
      "websearch",
      "todowrite",
      "skill",
      "question",
    ])
  })
})

describe("agentKey", () => {
  test("is pipeline, role and node id, sanitised and lower-cased", () => {
    const graph = { ...pipeline("a"), name: "My Flow!" }
    graph.nodes[0].role = "Code Reviewer"
    expect(agentKey(graph, graph.nodes[0])).toBe("my-flow--code-reviewer-a")
  })

  test("two cards sharing a role still get different keys", () => {
    const graph = pipeline("a", "b")
    graph.nodes[1].role = graph.nodes[0].role
    expect(agentKey(graph, graph.nodes[0])).not.toBe(agentKey(graph, graph.nodes[1]))
  })
})

describe("cardSpec", () => {
  test("carries the key, the role and the role instructions", () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.prompt = "You are the planner."
    expect(cardSpec(graph, graph.nodes[0])).toEqual({
      key: "test-a-a",
      role: "a",
      prompt: "You are the planner.",
    })
  })

  test("a blank role prompt and no tool map say nothing — every tool stays available", () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.prompt = "   "
    graph.nodes[0].agent.tools = {}
    const spec = cardSpec(graph, graph.nodes[0])
    expect(spec).not.toHaveProperty("prompt")
    expect(spec).not.toHaveProperty("tools")
    expect(spec).not.toHaveProperty("mcp")
    expect(spec).not.toHaveProperty("dispatch")
  })

  test("tools go out folded onto the vocabulary", () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.tools = { write: false, read: true, nonsense: true }
    expect(cardSpec(graph, graph.nodes[0]).tools).toEqual({ edit: false, read: true })
  })

  test("a card never carries an MCP selection, even when an old pipeline's agent still has one", () => {
    const graph = pipeline("a")
    // What a pipeline file saved before MCP became profile-wide may still hold in memory.
    Object.assign(graph.nodes[0].agent, { mcp: ["docs"] })
    expect(cardSpec(graph, graph.nodes[0])).not.toHaveProperty("mcp")
  })

  test("only a card with cards of its own, in an orchestration, gets the dispatch tools", () => {
    const tree: Pipeline = { ...pipeline("boss->mid", "mid->leaf"), mode: "orchestration" }
    expect(cardSpec(tree, tree.nodes[0]).dispatch).toBe(true)
    expect(cardSpec(tree, tree.nodes[1]).dispatch).toBe(true)
    expect(cardSpec(tree, tree.nodes[2]).dispatch).toBeUndefined()
    // The same edges in a pipeline are wiring, not dispatch.
    expect(cardSpec({ ...tree, mode: "pipeline" }, tree.nodes[0]).dispatch).toBeUndefined()
  })

  describe("in a gauntlet", () => {
    const gauntlet = (): Pipeline => ({
      ...pipeline("root->builder", "root->reviewer"),
      mode: "orchestration",
      gauntlet: { bar: "it works" },
    })
    const spec = (graph: Pipeline, id: string) => cardSpec(graph, graph.nodes.find((node) => node.id === id)!)

    test("the critic and the orchestrator cannot edit, whatever their own toggles say", () => {
      const graph = gauntlet()
      graph.nodes.find((node) => node.id === "root")!.agent.tools = { edit: true }
      for (const id of ["root", "reviewer"]) expect(spec(graph, id).tools?.edit).toBe(false)
    })

    test("a critic keeps the shell: it proves its verdict by running things", () => {
      const graph = gauntlet()
      graph.nodes.find((node) => node.id === "reviewer")!.agent.tools = { bash: true, write: true }
      expect(spec(graph, "reviewer").tools).toEqual({ bash: true, edit: false })
    })

    test("a builder is launched as authored", () => {
      const graph = gauntlet()
      expect(spec(graph, "builder")).not.toHaveProperty("tools")
      graph.nodes.find((node) => node.id === "builder")!.agent.tools = { edit: true }
      expect(spec(graph, "builder").tools).toEqual({ edit: true })
    })

    test("the same cards are untouched when the canvas is not a gauntlet", () => {
      const graph = { ...gauntlet(), gauntlet: undefined }
      expect(spec(graph, "root")).not.toHaveProperty("tools")
      expect(spec(graph, "reviewer")).not.toHaveProperty("tools")
    })
  })
})

describe("swarmOf", () => {
  test("the card's own mode beats the canvas default, which beats the host's", () => {
    const graph = pipeline("a")
    expect(swarmOf(graph, graph.nodes[0])).toBeUndefined()
    graph.defaultSwarm = "auto"
    expect(swarmOf(graph, graph.nodes[0])).toBe("auto")
    graph.nodes[0].agent.swarm = "off"
    expect(swarmOf(graph, graph.nodes[0])).toBe("off")
  })

  test("a mode this build does not know is ignored instead of passed to the host", () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.swarm = "sometimes" as never
    graph.defaultSwarm = "always"
    expect(swarmOf(graph, graph.nodes[0])).toBe("always")
    graph.defaultSwarm = "bogus" as never
    expect(swarmOf(graph, graph.nodes[0])).toBeUndefined()
  })
})

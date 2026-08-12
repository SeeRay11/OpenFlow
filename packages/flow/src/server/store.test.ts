import { describe, expect, test } from "bun:test"
import { pipeline } from "../graph/test-support"
import type { Pipeline } from "../graph/types"
import { agentBlock, agentKey, TOOL_ACTIONS, TOOLS, toolMap } from "./store"

function withAgents(graph: Pipeline, agents: Record<string, Partial<Pipeline["nodes"][number]["agent"]>>) {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, agent: { ...node.agent, ...(agents[node.id] ?? {}) } })),
  }
}

describe("agentKey", () => {
  test("joins the pipeline name and the role", () => {
    const graph = pipeline("planner")
    expect(agentKey(graph, graph.nodes[0])).toBe("test-planner")
  })

  test("lowercases", () => {
    const graph = { ...pipeline("planner"), name: "Feature-Build" }
    expect(agentKey(graph, graph.nodes[0])).toBe("feature-build-planner")
  })

  test("replaces characters an agent id cannot carry", () => {
    const graph = { ...pipeline("code review!"), name: "my pipeline" }
    expect(agentKey(graph, graph.nodes[0])).toBe("my-pipeline-code-review-")
  })

  test("keeps hyphens and underscores", () => {
    const graph = { ...pipeline("worker_a"), name: "diamond-2" }
    expect(agentKey(graph, graph.nodes[0])).toBe("diamond-2-worker_a")
  })

  test("gives every node in a graph its own key", () => {
    const graph = pipeline("a->b", "b->c")
    const keys = graph.nodes.map((node) => agentKey(graph, node))
    expect(new Set(keys).size).toBe(3)
  })
})

describe("toolMap", () => {
  test("passes through the names the server acts on", () => {
    expect(toolMap({ read: true, bash: false })).toEqual({ read: true, bash: false })
  })

  test("folds write and patch onto edit", () => {
    expect(toolMap({ write: false })).toEqual({ edit: false })
    expect(toolMap({ patch: false })).toEqual({ edit: false })
    expect(toolMap({ "apply-patch": false })).toEqual({ edit: false })
  })

  test("lets a deny win when aliases disagree", () => {
    // Losing the restriction here would hand the agent more access than asked.
    expect(toolMap({ write: false, edit: true })).toEqual({ edit: false })
    expect(toolMap({ edit: true, write: false })).toEqual({ edit: false })
  })

  test("keeps a merged group enabled only when every alias agrees", () => {
    expect(toolMap({ write: true, edit: true })).toEqual({ edit: true })
  })

  test("drops names the server would turn into a dead rule", () => {
    expect(toolMap({ task: false, nonsense: false, read: true })).toEqual({ read: true })
  })

  test("drops question, which the server ignores", () => {
    expect(toolMap({ question: false })).toEqual({})
  })

  test("ignores non-boolean values", () => {
    expect(toolMap({ read: "yes" as any, bash: undefined as any })).toEqual({})
  })

  test("handles a missing map", () => {
    expect(toolMap(undefined)).toEqual({})
  })

  test("every advertised tool maps to an action", () => {
    for (const tool of TOOLS) expect(TOOL_ACTIONS[tool]).toBeTruthy()
  })
})

describe("agentBlock", () => {
  const graph = withAgents(pipeline("planner->coder"), {
    planner: { prompt: "You are the planner.", model: "opencode/some-model", tools: { read: true, edit: false } },
    coder: { prompt: "You are the coder.", tools: { write: true, bash: true } },
  })
  const block = agentBlock(graph) as Record<string, any>

  test("emits one agent per node, keyed by agentKey", () => {
    expect(Object.keys(block).sort()).toEqual(["test-coder", "test-planner"])
  })

  test("uses the config's input vocabulary, not the reported form", () => {
    // The server translates prompt -> system and tools -> permissions on load;
    // emitting the translated names instead gets both fields ignored.
    expect(block["test-planner"].prompt).toBe("You are the planner.")
    expect(block["test-planner"].tools).toEqual({ read: true, edit: false })
    expect(block["test-planner"]).not.toHaveProperty("system")
    expect(block["test-planner"]).not.toHaveProperty("permissions")
  })

  test("runs nodes as primary agents", () => {
    expect(block["test-planner"].mode).toBe("primary")
  })

  test("carries the model when the node pins one", () => {
    expect(block["test-planner"].model).toBe("opencode/some-model")
  })

  test("omits the model when the node has none", () => {
    expect(block["test-coder"]).not.toHaveProperty("model")
  })

  test("normalises tool aliases on the way out", () => {
    expect(block["test-coder"].tools).toEqual({ edit: true, bash: true })
  })

  test("describes which node and pipeline an agent came from", () => {
    expect(block["test-planner"].description).toContain("planner")
    expect(block["test-planner"].description).toContain("test")
  })

  test("omits an empty prompt and an empty tool map", () => {
    const bare = agentBlock(pipeline("solo")) as Record<string, any>
    expect(bare["test-solo"]).not.toHaveProperty("prompt")
    expect(bare["test-solo"]).not.toHaveProperty("tools")
  })

  test("is empty for a pipeline with no nodes", () => {
    expect(agentBlock({ id: "x", name: "empty", nodes: [], edges: [] })).toEqual({})
  })

  test("collides deliberately when two nodes share a role", () => {
    // Same role means the same agent id; the later node wins. Worth knowing
    // before someone builds a graph with two nodes both called "coder".
    const twins = pipeline("coder", "coder2")
    twins.nodes[1].role = "coder"
    const result = agentBlock(twins) as Record<string, any>
    expect(Object.keys(result)).toEqual(["test-coder"])
    expect(result["test-coder"].description).toContain("coder2")
  })
})

import { describe, expect, test } from "bun:test"
import { pipeline } from "../graph/test-support"
import type { Pipeline } from "../graph/types"
import { agentBlock, agentKey, mcpBlock, permissionBlock, TOOL_ACTIONS, TOOLS, toolMap } from "./store"

function withAgents(graph: Pipeline, agents: Record<string, Partial<Pipeline["nodes"][number]["agent"]>>) {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, agent: { ...node.agent, ...(agents[node.id] ?? {}) } })),
  }
}

describe("agentKey", () => {
  test("joins the pipeline name, the role and the node id", () => {
    const graph = pipeline("planner")
    graph.nodes[0].id = "n1"
    expect(agentKey(graph, graph.nodes[0])).toBe("test-planner-n1")
  })

  test("lowercases", () => {
    const graph = { ...pipeline("planner"), name: "Feature-Build" }
    graph.nodes[0].id = "N1"
    expect(agentKey(graph, graph.nodes[0])).toBe("feature-build-planner-n1")
  })

  test("replaces characters an agent id cannot carry", () => {
    const graph = { ...pipeline("code review!"), name: "my pipeline" }
    graph.nodes[0].id = "n1"
    expect(agentKey(graph, graph.nodes[0])).toBe("my-pipeline-code-review--n1")
  })

  test("keeps hyphens and underscores", () => {
    const graph = { ...pipeline("worker_a"), name: "diamond-2" }
    graph.nodes[0].id = "n_1"
    expect(agentKey(graph, graph.nodes[0])).toBe("diamond-2-worker_a-n_1")
  })

  test("gives every node in a graph its own key", () => {
    const graph = pipeline("a->b", "b->c")
    const keys = graph.nodes.map((node) => agentKey(graph, node))
    expect(new Set(keys).size).toBe(3)
  })

  test("keeps two nodes with the same role apart", () => {
    // The whole point of carrying the node id: without it both nodes land on
    // one agent and the permissive one's tools win for both.
    const twins = pipeline("coder", "coder2")
    twins.nodes[1].role = "coder"
    expect(agentKey(twins, twins.nodes[0])).not.toBe(agentKey(twins, twins.nodes[1]))
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

  test("keeps question, which gates whether a node can ask a person anything", () => {
    expect(toolMap({ question: false })).toEqual({ question: false })
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

describe("permissionBlock", () => {
  test("spells out an allow and a deny for every toggle", () => {
    expect(permissionBlock({ read: true, bash: false })).toEqual({ read: "allow", bash: "deny" })
  })

  test("folds aliases before deciding", () => {
    expect(permissionBlock({ write: true, edit: true })).toEqual({ edit: "allow" })
    expect(permissionBlock({ write: false, edit: true })).toEqual({ edit: "deny" })
  })

  test("says nothing about actions the graph never mentions", () => {
    // Silence leaves them on ask, which the engine answers at runtime; naming
    // them here would widen access the graph never asked for.
    const block = permissionBlock({ read: true })
    expect(block).not.toHaveProperty("external_directory")
    expect(block).not.toHaveProperty("question")
    expect(Object.keys(block)).toEqual(["read"])
  })

  test("is empty when there are no toggles", () => {
    expect(permissionBlock(undefined)).toEqual({})
    expect(permissionBlock({})).toEqual({})
  })

  test("only ever emits allow or deny", () => {
    const values = Object.values(permissionBlock({ read: true, grep: false, edit: true, bash: false }))
    expect(new Set(values)).toEqual(new Set(["allow", "deny"]))
  })
})

describe("agentBlock", () => {
  const graph = withAgents(pipeline("planner->coder"), {
    planner: { prompt: "You are the planner.", model: "opencode/some-model", tools: { read: true, edit: false } },
    coder: { prompt: "You are the coder.", tools: { write: true, bash: true } },
  })
  const block = agentBlock(graph) as Record<string, any>

  test("emits one agent per node, keyed by agentKey", () => {
    expect(Object.keys(block).sort()).toEqual(["test-coder-coder", "test-planner-planner"])
  })

  test("uses the config's input vocabulary, not the reported form", () => {
    // The server translates prompt -> system and permission -> permissions on
    // load; emitting the translated names instead gets both fields ignored.
    expect(block["test-planner-planner"].prompt).toBe("You are the planner.")
    expect(block["test-planner-planner"].permission).toEqual({ read: "allow", edit: "deny" })
    expect(block["test-planner-planner"]).not.toHaveProperty("system")
    expect(block["test-planner-planner"]).not.toHaveProperty("permissions")
  })

  test("writes permission, not the deprecated tools field", () => {
    expect(block["test-planner-planner"]).not.toHaveProperty("tools")
  })

  test("runs nodes as primary agents", () => {
    expect(block["test-planner-planner"].mode).toBe("primary")
  })

  test("carries the model when the node pins one", () => {
    expect(block["test-planner-planner"].model).toBe("opencode/some-model")
  })

  test("omits the model when the node has none", () => {
    expect(block["test-coder-coder"]).not.toHaveProperty("model")
  })

  test("normalises tool aliases on the way out", () => {
    expect(block["test-coder-coder"].permission).toEqual({ edit: "allow", bash: "allow" })
  })

  test("describes which node and pipeline an agent came from", () => {
    expect(block["test-planner-planner"].description).toContain("planner")
    expect(block["test-planner-planner"].description).toContain("test")
  })

  test("omits an empty prompt and an empty permission map", () => {
    const bare = agentBlock(pipeline("solo")) as Record<string, any>
    expect(bare["test-solo-solo"]).not.toHaveProperty("prompt")
    expect(bare["test-solo-solo"]).not.toHaveProperty("permission")
  })

  test("is empty for a pipeline with no nodes", () => {
    expect(agentBlock({ id: "x", name: "empty", nodes: [], edges: [] })).toEqual({})
  })

  test("keeps two nodes with the same role on separate agents", () => {
    // These used to collapse onto one agent, so the second node's tools decided
    // the first node's permissions: a node restricted to read/grep inherited
    // edit and bash, and quietly ran with write access to the real project.
    const twins = withAgents(pipeline("coder", "coder2"), {
      coder: { tools: { read: true, grep: true } },
      coder2: { tools: { edit: true, bash: true } },
    })
    twins.nodes[1].role = "coder"

    const result = agentBlock(twins) as Record<string, any>

    expect(Object.keys(result).sort()).toEqual(["test-coder-coder", "test-coder-coder2"])
    expect(result["test-coder-coder"].permission).toEqual({ read: "allow", grep: "allow" })
    expect(result["test-coder-coder2"].permission).toEqual({ edit: "allow", bash: "allow" })
  })
})

describe("mcpBlock", () => {
  test("says nothing for a node that never chose, so an old graph keeps working", () => {
    expect(mcpBlock(undefined, ["context7", "figma"])).toEqual({})
  })

  test("allows the chosen servers and denies the rest by wildcard", () => {
    // MCP tools are named `<server>_<tool>` and permission actions match by
    // wildcard, so one rule per server covers every tool it exposes.
    expect(mcpBlock(["context7"], ["context7", "figma"])).toEqual({
      "context7_*": "allow",
      "figma_*": "deny",
    })
  })

  test("an empty allowlist is a real answer: none of them", () => {
    expect(mcpBlock([], ["context7"])).toEqual({ "context7_*": "deny" })
  })

  test("writes nothing when the project configures no servers", () => {
    expect(mcpBlock(["ghost"], [])).toEqual({})
  })
})

describe("agentBlock with mcp", () => {
  test("folds the node's mcp allowlist into its permission block", () => {
    const graph = withAgents(pipeline("a"), { a: { tools: { read: true }, mcp: ["context7"] } })

    const block = agentBlock(graph, ["context7", "figma"]) as any
    const agent = block[agentKey(graph, graph.nodes[0])]

    expect(agent.permission).toEqual({ read: "allow", "context7_*": "allow", "figma_*": "deny" })
  })
})

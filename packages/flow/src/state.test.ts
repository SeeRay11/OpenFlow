import { beforeEach, describe, expect, test } from "bun:test"
import { setAvailableModels, setDefaultModel } from "./graph/default-model"
import { modeOf } from "./graph/types"
import { actions, runtimeOf, state } from "./state"

/**
 * The store is a module singleton, so every test starts from a reset graph.
 * These cover the parts that quietly corrupt a graph when they go wrong —
 * deleting a node, refusing a cycle, and the permission promises that a stop
 * has to settle.
 */
beforeEach(() => {
  actions.reset()
  actions.rejectPermissions()
  actions.clearNotice()
  setDefaultModel(undefined)
  setAvailableModels(new Set<string>())
})

function graph(...roles: string[]) {
  return roles.map((role) => actions.addNode(role, { x: 0, y: 0 }).id)
}

describe("nodes", () => {
  test("adds a node from a role preset and selects it", () => {
    const [id] = graph("planner")

    expect(state.pipeline.nodes).toHaveLength(1)
    expect(state.selected).toBe(id)
    expect(state.pipeline.nodes[0].role).toBeTruthy()
    expect(state.pipeline.nodes[0].agent.prompt).toBeTruthy()
  })

  test("falls back to the last role for an unknown one", () => {
    const [id] = graph("not-a-role")
    expect(state.pipeline.nodes.find((node) => node.id === id)).toBeTruthy()
  })

  test("applies the default model to a preset that has none, when it is available", () => {
    setAvailableModels(new Set(["opencode/grok-code-free"]))
    setDefaultModel("opencode/grok-code-free")
    const [id] = graph("coder")
    expect(state.pipeline.nodes.find((node) => node.id === id)!.agent.model).toBe("opencode/grok-code-free")
  })

  test("leaves the model blank when the default is not currently available", () => {
    setAvailableModels(new Set(["opencode/other"]))
    setDefaultModel("opencode/grok-code-free")
    const [id] = graph("coder")
    expect(state.pipeline.nodes.find((node) => node.id === id)!.agent.model).toBeUndefined()
  })

  test("gives each node its own tools object", () => {
    const [first, second] = graph("coder", "coder")
    actions.toggleTool(first, "bash", false)

    expect(state.pipeline.nodes.find((node) => node.id === first)!.agent.tools!.bash).toBe(false)
    expect(state.pipeline.nodes.find((node) => node.id === second)!.agent.tools!.bash).not.toBe(false)
  })

  test("removing a node takes its edges, runtime and selection with it", () => {
    const [a, b] = graph("planner", "coder")
    actions.connect(a, b)
    actions.patchRuntime(a, { status: "done", output: "x" })
    actions.select(a)

    actions.removeNode(a)

    expect(state.pipeline.nodes.map((node) => node.id)).toEqual([b])
    expect(state.pipeline.edges).toEqual([])
    expect(runtimeOf(a).status).toBe("idle")
    expect(state.selected).toBeUndefined()
  })

  test("keeps the selection when a different node is removed", () => {
    const [a, b] = graph("planner", "coder")
    actions.select(a)
    actions.removeNode(b)

    expect(state.selected).toBe(a)
  })

  test("moves and edits in place", () => {
    const [id] = graph("planner")
    actions.moveNode(id, { x: 40, y: 90 })
    actions.updateNode(id, { role: "renamed" })
    actions.updateAgent(id, { model: "opencode/x" })

    const node = state.pipeline.nodes[0]
    expect(node.position).toEqual({ x: 40, y: 90 })
    expect(node.role).toBe("renamed")
    expect(node.agent.model).toBe("opencode/x")
  })
})

describe("edges", () => {
  test("connects two nodes", () => {
    const [a, b] = graph("planner", "coder")
    expect(actions.connect(a, b)).toBe(true)
    expect(state.pipeline.edges).toHaveLength(1)
  })

  test("refuses a self-link and a duplicate", () => {
    const [a, b] = graph("planner", "coder")
    actions.connect(a, b)

    expect(actions.connect(a, a)).toBe(false)
    expect(actions.connect(a, b)).toBe(false)
    expect(state.pipeline.edges).toHaveLength(1)
  })

  test("refuses a cycle and says why", () => {
    // The engine only runs a DAG, so a cycle has to be stopped at the gesture
    // that would create it rather than at run time.
    const [a, b, c] = graph("planner", "architect", "coder")
    actions.connect(a, b)
    actions.connect(b, c)

    expect(actions.connect(c, a)).toBe(false)
    expect(state.notice).toMatchObject({ kind: "error" })
    expect(state.notice!.text).toContain("cycle")
    expect(state.pipeline.edges).toHaveLength(2)
  })

  test("disconnects by edge id", () => {
    const [a, b] = graph("planner", "coder")
    actions.connect(a, b)
    actions.disconnect(state.pipeline.edges[0].id)

    expect(state.pipeline.edges).toEqual([])
  })
})

describe("runtime", () => {
  test("patches merge onto what is already there", () => {
    const [id] = graph("planner")
    actions.patchRuntime(id, { status: "running", activity: "thinking" })
    actions.patchRuntime(id, { output: "done" })

    expect(runtimeOf(id)).toMatchObject({ status: "running", activity: "thinking", output: "done" })
  })

  test("resetRuntime clears everything from the previous run", () => {
    const [id] = graph("planner")
    actions.patchRuntime(id, { status: "done", output: "old", error: "old" })
    actions.resetRuntime({ [id]: "queued" })

    expect(runtimeOf(id)).toEqual({ status: "queued" })
  })

  test("loading a pipeline drops the old run state", () => {
    const [id] = graph("planner")
    actions.patchRuntime(id, { status: "done" })
    actions.load({ id: "p2", name: "other", nodes: [], edges: [] })

    expect(state.pipeline.name).toBe("other")
    expect(state.runtime).toEqual({})
    expect(state.run).toBeUndefined()
    expect(state.selected).toBeUndefined()
  })
})

describe("permissions", () => {
  const request = { requestID: "req-1", nodeID: "n1", role: "coder", action: "bash", resources: ["ls"] }

  test("an answer resolves the promise the engine is waiting on", async () => {
    const pending = actions.askPermission(request)
    expect(state.permissions).toHaveLength(1)

    actions.answerPermission("req-1", "once")

    expect(await pending).toBe("once")
    expect(state.permissions).toEqual([])
  })

  test("a stop rejects everything still pending", async () => {
    // An unanswered request strands its node until the idle wait gives up.
    const first = actions.askPermission(request)
    const second = actions.askPermission({ ...request, requestID: "req-2" })

    actions.rejectPermissions()

    expect(await first).toBe("reject")
    expect(await second).toBe("reject")
    expect(state.permissions).toEqual([])
  })

  test("answering something unknown is harmless", () => {
    expect(() => actions.answerPermission("nope", "once")).not.toThrow()
  })
})

describe("dirty", () => {
  test("a fresh graph is clean", () => {
    expect(state.dirty).toBe(false)
  })

  test("every mutating edit marks the graph dirty", () => {
    const [id] = graph("planner")
    expect(state.dirty).toBe(true)

    actions.markSaved()
    actions.moveNode(id, { x: 10, y: 10 })
    expect(state.dirty).toBe(true)

    actions.markSaved()
    actions.updateAgent(id, { prompt: "write the plan" })
    expect(state.dirty).toBe(true)

    actions.markSaved()
    actions.rename("renamed")
    expect(state.dirty).toBe(true)
  })

  test("saving and loading both clear it", () => {
    graph("planner")
    actions.markSaved()
    expect(state.dirty).toBe(false)

    graph("coder")
    actions.load({ id: "p1", name: "loaded", nodes: [], edges: [] })
    expect(state.dirty).toBe(false)
  })
})

describe("mode", () => {
  test("a fresh canvas is a pipeline, and stays one until it is switched", () => {
    expect(modeOf(state.pipeline)).toBe("pipeline")
    expect(state.pipeline.mode).toBeUndefined()

    actions.setMode("swarm")
    expect(modeOf(state.pipeline)).toBe("swarm")
  })

  test("switching is undoable — it changes what an existing graph does", () => {
    graph("planner", "coder")
    actions.setMode("orchestration")

    expect(actions.undo()).toBe(true)
    expect(modeOf(state.pipeline)).toBe("pipeline")
    expect(state.pipeline.nodes).toHaveLength(2)
  })

  test("re-picking the mode it is already in costs no undo step", () => {
    graph("planner")
    actions.setMode("pipeline")

    // Undo steps back past the node, not past a switch that did nothing.
    expect(actions.undo()).toBe(true)
    expect(state.pipeline.nodes).toHaveLength(0)
  })

  test("switching marks the graph dirty", () => {
    actions.markSaved()
    actions.setMode("swarm")
    expect(state.dirty).toBe(true)
  })
})

describe("undo", () => {
  test("restores a deleted node, its edges and its hand-written prompt", () => {
    const [a, b] = graph("planner", "coder")
    actions.updateAgent(a, { prompt: "the prompt nobody wants to retype" })
    actions.connect(a, b)

    actions.removeNode(a)
    expect(state.pipeline.nodes.map((node) => node.id)).toEqual([b])
    expect(state.pipeline.edges).toEqual([])

    expect(actions.undo()).toBe(true)
    expect(state.pipeline.nodes.map((node) => node.id)).toEqual([a, b])
    expect(state.pipeline.edges).toHaveLength(1)
    expect(state.pipeline.nodes[0].agent.prompt).toBe("the prompt nobody wants to retype")
  })

  test("undoing leaves the graph dirty — the file on disk still has the delete", () => {
    graph("planner")
    actions.markSaved()
    actions.removeNode(state.pipeline.nodes[0].id)
    actions.undo()

    expect(state.dirty).toBe(true)
  })

  test("steps back one edit at a time and stops when there is nothing left", () => {
    graph("planner", "coder")

    expect(actions.undo()).toBe(true)
    expect(state.pipeline.nodes).toHaveLength(1)
    expect(actions.undo()).toBe(true)
    expect(state.pipeline.nodes).toHaveLength(0)
    expect(actions.undo()).toBe(false)
  })

  test("loading a pipeline drops the history rather than undoing into another graph", () => {
    graph("planner")
    actions.load({ id: "p1", name: "loaded", nodes: [], edges: [] })

    expect(actions.undo()).toBe(false)
    expect(state.pipeline.name).toBe("loaded")
  })
})

describe("engine reachability", () => {
  test("starts optimistic and follows the last probe", () => {
    expect(state.engineReachable).toBe(true)

    actions.setEngineReachable(false)
    expect(state.engineReachable).toBe(false)

    actions.setEngineReachable(true)
    expect(state.engineReachable).toBe(true)
  })
})

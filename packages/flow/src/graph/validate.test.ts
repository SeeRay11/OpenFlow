import { describe, expect, test } from "bun:test"
import { pipeline } from "./test-support"
import type { Pipeline } from "./types"
import { ancestors, downstream, layer, preflight, upstream, wouldCycle } from "./validate"

function layersOf(graph: Pipeline) {
  const result = layer(graph)
  if (!result.ok) throw new Error(`expected a valid graph, got: ${result.error}`)
  return result.layers
}

function errorOf(graph: Pipeline) {
  const result = layer(graph)
  if (result.ok) throw new Error("expected the graph to be rejected")
  return result.error
}

describe("layer", () => {
  test("rejects an empty pipeline", () => {
    expect(errorOf(pipeline())).toBe("pipeline has no nodes")
  })

  test("puts a lone node in the first layer", () => {
    expect(layersOf(pipeline("a"))).toEqual([["a"]])
  })

  test("gives a linear chain one node per layer", () => {
    expect(layersOf(pipeline("a->b", "b->c"))).toEqual([["a"], ["b"], ["c"]])
  })

  test("groups a diamond's independent nodes into one layer", () => {
    expect(layersOf(pipeline("a->b", "a->c", "b->d", "c->d"))).toEqual([["a"], ["b", "c"], ["d"]])
  })

  test("holds a join back until every branch has landed", () => {
    // d depends on c, which is two hops deep, so d cannot share b's layer.
    expect(layersOf(pipeline("a->b", "a->c", "c->d", "b->d"))).toEqual([["a"], ["b", "c"], ["d"]])
  })

  test("schedules disconnected components side by side", () => {
    expect(layersOf(pipeline("a->b", "c->d"))).toEqual([["a", "c"], ["b", "d"]])
  })

  test("orders each layer deterministically", () => {
    // Same graph, edges declared in the opposite order.
    expect(layersOf(pipeline("a->c", "a->b"))).toEqual(layersOf(pipeline("a->b", "a->c")))
  })

  test("lays out the same graph whether or not an edge is duplicated", () => {
    // Duplicates only reach here through hand-edited JSON; the UI refuses them.
    const graph = pipeline("a->b")
    graph.edges.push({ id: "dupe", source: "a", target: "b" })
    expect(layersOf(graph)).toEqual([["a"], ["b"]])
  })

  test("rejects a cycle", () => {
    expect(errorOf(pipeline("a->b", "b->c", "c->a"))).toBe("pipeline contains a cycle")
  })

  test("rejects a cycle that hangs off a valid root", () => {
    expect(errorOf(pipeline("root->a", "a->b", "b->a"))).toBe("pipeline contains a cycle")
  })

  test("rejects a self-loop", () => {
    const graph = pipeline("a->b")
    graph.edges.push({ id: "loop", source: "a", target: "a" })
    expect(errorOf(graph)).toBe("edge loop is a self-loop")
  })

  test("rejects an edge with an unknown source", () => {
    const graph = pipeline("a->b")
    graph.edges.push({ id: "ghost", source: "nope", target: "b" })
    expect(errorOf(graph)).toBe("edge ghost has unknown source nope")
  })

  test("rejects an edge with an unknown target", () => {
    const graph = pipeline("a->b")
    graph.edges.push({ id: "ghost", source: "a", target: "nope" })
    expect(errorOf(graph)).toBe("edge ghost has unknown target nope")
  })

  test("places every node exactly once", () => {
    const graph = pipeline("a->b", "a->c", "b->d", "c->d", "d->e", "lonely")
    const placed = layersOf(graph).flat()
    expect(placed.length).toBe(graph.nodes.length)
    expect(new Set(placed).size).toBe(graph.nodes.length)
  })
})

describe("preflight", () => {
  // Every node the builder makes starts with no model, so a runnable graph has
  // to have one assigned; this helper does it in place for the whole pipeline.
  /**
   * A model on every node, and a tool set, so these graphs are about whatever
   * each test is about. A node that declares no tools warns on its own account
   * — it inherits the default agent's permissions — and that warning is its own
   * test below.
   */
  function withModel(graph: Pipeline, model: string) {
    for (const node of graph.nodes) {
      node.agent.model = model
      // Denied outright: a tool the map leaves unnamed inherits the default
      // agent's allow, and a swarm peer that can write is its own warning.
      node.agent.tools = { read: true, edit: false, bash: false }
    }
    return graph
  }
  const unlocked = (...models: string[]) => ({ unlockedModels: new Set(models) })

  /** Turns a built graph into a swarm, appending the synthesizer card it needs. */
  function swarm(graph: Pipeline, options: { synthesizer?: boolean } = {}) {
    const next: Pipeline = { ...graph, mode: "swarm", nodes: [...graph.nodes] }
    if (options.synthesizer !== false)
      next.nodes.push({
        id: "verdict",
        role: "synthesizer",
        agent: { prompt: "", model: graph.nodes[0]?.agent.model, tools: { read: true } },
        position: { x: 0, y: 0 },
      })
    return next
  }

  test("an empty pipeline blocks on the structural check", () => {
    const result = preflight(pipeline(), unlocked())
    expect(result.blocking.map((problem) => problem.kind)).toEqual(["structure"])
    expect(result.blocking[0].message).toBe("pipeline has no nodes")
  })

  test("a cycle blocks", () => {
    const result = preflight(withModel(pipeline("a->b", "b->c", "c->a"), "opencode/x"), unlocked("opencode/x"))
    expect(result.blocking.some((problem) => problem.kind === "structure")).toBe(true)
  })

  test("an explicit pipeline mode behaves exactly like an absent one", () => {
    const graph = withModel(pipeline("a->b"), "opencode/x")
    expect(preflight({ ...graph, mode: "pipeline" }, unlocked("opencode/x"))).toEqual(
      preflight(graph, unlocked("opencode/x")),
    )
  })

  test("an unconnected card only warns in pipeline mode — a swarm's peers carry no edges", () => {
    const graph = withModel(pipeline("a->b", "loner"), "opencode/x")
    expect(preflight(graph, unlocked("opencode/x")).warnings.map((problem) => problem.kind)).toEqual(["isolated"])
    expect(preflight(swarm(graph), unlocked("opencode/x")).warnings.map((problem) => problem.kind)).not.toContain(
      "isolated",
    )
  })

  test("a swarm runs on its node list — no synthesizer means nothing writes the verdict", () => {
    const graph = swarm(withModel(pipeline("a", "b"), "opencode/x"), { synthesizer: false })
    expect(preflight(graph, unlocked("opencode/x")).blocking.map((problem) => problem.kind)).toEqual(["no-synthesizer"])
  })

  test("a swarm of one has nobody to debate", () => {
    const graph = swarm(withModel(pipeline("a"), "opencode/x"))
    expect(preflight(graph, unlocked("opencode/x")).blocking.map((problem) => problem.kind)).toEqual([
      "swarm-too-small",
    ])
  })

  test("two synthesizers block, naming the extra card", () => {
    const graph = swarm(withModel(pipeline("a", "b", "s2"), "opencode/x"))
    graph.nodes[2].role = "synthesizer"
    // The first synthesizer in node order is the one the engine would run, so
    // every one after it is what preflight points at.
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking.map((problem) => [problem.kind, problem.nodeId])).toEqual([
      ["duplicate-synthesizer", "verdict"],
    ])
  })

  test("a well-formed swarm passes, and its leftover wiring only warns", () => {
    const clean = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    expect(preflight(clean, unlocked("opencode/x")).blocking).toEqual([])
    expect(preflight(clean, unlocked("opencode/x")).warnings).toEqual([])

    // Switching a pipeline to swarm keeps its edges, which now do nothing.
    const rewired = swarm(withModel(pipeline("a->b"), "opencode/x"))
    expect(preflight(rewired, unlocked("opencode/x")).blocking).toEqual([])
    expect(preflight(rewired, unlocked("opencode/x")).warnings.map((problem) => problem.kind)).toEqual([
      "ignored-edges",
    ])
  })

  test("peers with nothing to tell them apart warn — same role, model and instructions", () => {
    const graph = swarm(withModel(pipeline("a", "b", "c"), "opencode/x"))
    for (const node of graph.nodes.slice(0, 3)) node.role = "coder"

    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking).toEqual([])
    expect(result.warnings.map((problem) => problem.kind)).toEqual(["identical-peers"])
    expect(result.warnings[0].message).toContain("coder, coder, coder")
    expect(result.warnings[0].message).toContain("3 sessions")
  })

  test("one difference is enough to make peers worth billing separately", () => {
    // Role is the axis the palette hands the user, but it is not the only one:
    // a different model or different instructions is a real reason to disagree,
    // and warning about those would train the user to ignore the warning.
    const byRole = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    expect(preflight(byRole, unlocked("opencode/x")).warnings).toEqual([])

    const byModel = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    for (const node of byModel.nodes.slice(0, 2)) node.role = "coder"
    byModel.nodes[1].agent.model = "opencode/y"
    expect(preflight(byModel, unlocked("opencode/x", "opencode/y")).warnings).toEqual([])

    const byPrompt = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    for (const node of byPrompt.nodes.slice(0, 2)) node.role = "coder"
    byPrompt.nodes[1].agent.prompt = "argue for the simplest thing that works"
    expect(preflight(byPrompt, unlocked("opencode/x")).warnings).toEqual([])
  })

  test("identical peers are grouped, so two twins and a third card warn once", () => {
    const graph = swarm(withModel(pipeline("a", "b", "c"), "opencode/x"))
    graph.nodes[0].role = "coder"
    graph.nodes[1].role = "coder"
    graph.nodes[2].role = "architect"

    const warnings = preflight(graph, unlocked("opencode/x")).warnings
    expect(warnings.map((problem) => problem.kind)).toEqual(["identical-peers"])
    expect(warnings[0].message).toContain("coder, coder")
    expect(warnings[0].message).not.toContain("architect")
  })

  test("the synthesizer is not counted among the twins it decides between", () => {
    // `swarm()` gives the verdict card the agents' model on purpose — a decider
    // running the same model as the debate is normal. Only the debating cards
    // can fail to disagree with each other, so the count the user is asked to
    // act on is the peers', not the whole canvas'.
    const graph = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    graph.nodes[0].role = "coder"
    graph.nodes[1].role = "coder"

    const warnings = preflight(graph, unlocked("opencode/x")).warnings
    expect(warnings.map((problem) => problem.kind)).toEqual(["identical-peers"])
    expect(warnings[0].message).toContain("2 sessions")
  })

  test("a peer that can write files warns — peers run at once in one directory", () => {
    const graph = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    graph.nodes[0].role = "coder"
    graph.nodes[0].agent.tools = { read: true, edit: true, bash: false }

    const warnings = preflight(graph, unlocked("opencode/x")).warnings
    expect(warnings.map((problem) => problem.kind)).toEqual(["swarm-writers"])
    expect(warnings[0].message).toStartWith("coder can write files")
  })

  test("an unlisted tool inherits the default agent's allow, so `{ read: true }` is a writer", () => {
    // `permissionBlock` writes a rule only for tools the map names; edit and
    // bash left unnamed stay at the default agent's allow.
    const graph = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    graph.nodes[1].agent.tools = { read: true }
    expect(preflight(graph, unlocked("opencode/x")).warnings.map((problem) => problem.kind)).toEqual([
      "swarm-writers",
    ])
  })

  test("bash alone is enough to write, so denying edit does not clear the warning", () => {
    const graph = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    graph.nodes[1].agent.tools = { read: true, edit: false, bash: true }
    expect(preflight(graph, unlocked("opencode/x")).warnings.map((problem) => problem.kind)).toEqual([
      "swarm-writers",
    ])
  })

  test("the synthesizer may write — it runs alone, after every round", () => {
    const graph = swarm(withModel(pipeline("a", "b"), "opencode/x"))
    graph.nodes[2].agent.tools = { read: true, edit: true, bash: true }
    expect(preflight(graph, unlocked("opencode/x")).warnings).toEqual([])
  })

  test("a cycle left behind by a pipeline does not block a swarm — swarm reads no edges", () => {
    const graph = swarm(withModel(pipeline("a->b", "b->a"), "opencode/x"))
    expect(preflight(graph, unlocked("opencode/x")).blocking).toEqual([])
  })

  /** Turns a built graph into an orchestration with the caps the run will use. */
  function orchestrated(graph: Pipeline, options: { depth?: number; dispatches?: number } = {}) {
    return { ...graph, mode: "orchestration" as const, ...options }
  }

  test("an orchestrator with its subagents wired under it passes", () => {
    const graph = orchestrated(withModel(pipeline("root->a", "root->b"), "opencode/x"))
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test("a card with nobody to dispatch to blocks — that is a pipeline of one", () => {
    const graph = orchestrated(withModel(pipeline("root"), "opencode/x"))
    expect(preflight(graph, unlocked("opencode/x")).blocking.map((problem) => problem.kind)).toEqual(["no-subagents"])
  })

  test("a second card nothing points at blocks, because a run has one result", () => {
    const graph = orchestrated(withModel(pipeline("root->a", "other->b"), "opencode/x"))
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking.map((problem) => [problem.kind, problem.nodeId])).toEqual([
      ["duplicate-orchestrator", "other"],
    ])
  })

  test("a diamond blocks — a card answers to exactly one orchestrator", () => {
    // Two parents means the second dispatch would re-prompt a session that is
    // still working on the first one's task.
    const graph = orchestrated(withModel(pipeline("root->a", "root->b", "a->shared", "b->shared"), "opencode/x"))
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking.map((problem) => [problem.kind, problem.nodeId])).toEqual([
      ["shared-subagent", "shared"],
    ])
  })

  test("a tree deeper than the depth cap blocks, naming both numbers", () => {
    const graph = orchestrated(withModel(pipeline("root->a", "a->b", "b->c"), "opencode/x"), { depth: 2 })
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking.map((problem) => problem.kind)).toEqual(["too-deep"])
    expect(result.blocking[0].message).toContain("3 level(s) deep")
    expect(result.blocking[0].message).toContain("limit is 2")

    // Raising the cap is the other half of the fix, and it works.
    expect(preflight(orchestrated(graph, { depth: 3 }), unlocked("opencode/x")).blocking).toEqual([])
  })

  test("a cycle is still a cycle, whatever the mode calls its edges", () => {
    const graph = orchestrated(withModel(pipeline("root->a", "a->b", "b->a"), "opencode/x"))
    expect(preflight(graph, unlocked("opencode/x")).blocking.map((problem) => problem.kind)).toEqual(["structure"])
  })

  test("a graph that can fan out past a dozen sessions warns before it is run", () => {
    // Depth multiplies: four cards under the root, each dispatchable three
    // times, is the number a user cannot work out by looking at the canvas.
    const graph = orchestrated(
      withModel(pipeline("root->a", "root->b", "root->c", "root->d"), "opencode/x"),
      { dispatches: 3 },
    )
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking).toEqual([])
    expect(result.warnings.map((problem) => problem.kind)).toEqual(["fan-out"])
    expect(result.warnings[0].message).toContain("13 sessions")
  })

  test("a node with no model and no agent blocks, naming the node", () => {
    const result = preflight(pipeline("a"), unlocked())
    expect(result.blocking.map((problem) => [problem.kind, problem.nodeId])).toEqual([["no-model", "a"]])
    expect(result.blocking[0].message).toContain("'a'")
  })

  test("a node with no model but a named agent is fine — it runs on the agent's default", () => {
    const graph = pipeline("a")
    graph.nodes[0].agent.name = "reviewer"
    expect(preflight(graph, unlocked()).blocking).toEqual([])
  })

  test("a model that no connected provider can run blocks and names the node", () => {
    const result = preflight(withModel(pipeline("a"), "groq/llama"), unlocked("opencode/x"))
    expect(result.blocking.map((problem) => problem.kind)).toEqual(["locked-model"])
    expect(result.blocking[0].nodeId).toBe("a")
  })

  test("a fully wired graph on unlocked models has no blocking problems", () => {
    const graph = withModel(pipeline("a->b", "b->c"), "opencode/x")
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking).toEqual([])
  })

  test("a node that sets no tool permissions warns but does not block", () => {
    // The generated agent gets a `permission` block only from `agent.tools`, so
    // a node that declares none inherits the default agent's — edit, write and
    // bash included.
    const graph = withModel(pipeline("a"), "opencode/x")
    graph.nodes[0].agent.tools = undefined
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.blocking).toEqual([])
    expect(result.warnings.map((problem) => problem.kind)).toEqual(["unrestricted-write"])
  })

  test("declaring tools is what restricts a node, so it silences the warning", () => {
    // This warned the other way round once: it fired for six cards that all ran
    // under restricted generated agents, because `agent.name` is filled when the
    // run starts and preflight reads it before that.
    const graph = withModel(pipeline("a"), "opencode/x")
    graph.nodes[0].agent.tools = { bash: true }
    expect(preflight(graph, unlocked("opencode/x")).warnings).toEqual([])
  })

  test("a named agent silences it too — that agent's own permissions apply", () => {
    const graph = withModel(pipeline("a"), "opencode/x")
    graph.nodes[0].agent.tools = undefined
    graph.nodes[0].agent.name = "coder"
    expect(preflight(graph, unlocked("opencode/x")).warnings).toEqual([])
  })

  test("an isolated node in a multi-node graph warns", () => {
    const graph = withModel(pipeline("a->b", "lonely"), "opencode/x")
    const result = preflight(graph, unlocked("opencode/x"))
    expect(result.warnings.map((problem) => [problem.kind, problem.nodeId])).toEqual([["isolated", "lonely"]])
  })

  test("two nodes generating the same agent id block", () => {
    // The key carries the node id, so this only happens if two nodes are given
    // the same id — but a collision silently merges their permission blocks,
    // which is worth refusing rather than running.
    const graph = withModel(pipeline("a", "b"), "opencode/x")
    graph.nodes[1].id = graph.nodes[0].id
    graph.nodes[1].role = graph.nodes[0].role

    const result = preflight(graph, unlocked("opencode/x"))

    expect(result.blocking.map((problem) => problem.kind)).toEqual(["duplicate-agent"])
    expect(result.blocking[0].message).toContain("test-a-a")
  })

  test("two nodes sharing only a role are fine", () => {
    const graph = withModel(pipeline("a->b"), "opencode/x")
    graph.nodes[1].role = graph.nodes[0].role
    expect(preflight(graph, unlocked("opencode/x")).blocking).toEqual([])
  })

  test("a lone single node is not treated as isolated", () => {
    const graph = withModel(pipeline("a"), "opencode/x")
    expect(preflight(graph, unlocked("opencode/x")).warnings).toEqual([])
  })

  test("an unreachable engine blames the engine once and suppresses every locked model", () => {
    // The exact false alarm: with the engine down nothing can read the catalog,
    // so all three nodes look like they picked a model nobody can run.
    const graph = withModel(pipeline("a->b", "b->c"), "anthropic/claude-sonnet-4")
    const result = preflight(graph, { unlockedModels: new Set<string>(), engineReachable: false })

    expect(result.blocking.map((problem) => problem.kind)).toEqual(["engine-unreachable"])
    expect(result.blocking[0].message).toContain("opencode serve")
    expect(result.blocking[0].nodeId).toBeUndefined()
  })

  test("an unreachable engine still reports problems that are not about models", () => {
    const graph = withModel(pipeline("a->b", "b->a"), "opencode/x")
    const kinds = preflight(graph, { unlockedModels: new Set<string>(), engineReachable: false }).blocking.map(
      (problem) => problem.kind,
    )
    expect(kinds).toEqual(["engine-unreachable", "structure"])
  })

  test("a reachable engine still blocks a model no connected provider can run", () => {
    const graph = withModel(pipeline("a"), "groq/llama")
    const result = preflight(graph, { unlockedModels: new Set(["opencode/x"]), engineReachable: true })
    expect(result.blocking.map((problem) => problem.kind)).toEqual(["locked-model"])
  })
})

describe("wouldCycle", () => {
  test("refuses a node connecting to itself", () => {
    expect(wouldCycle(pipeline("a->b"), "a", "a")).toBe(true)
  })

  test("refuses a direct back edge", () => {
    expect(wouldCycle(pipeline("a->b"), "b", "a")).toBe(true)
  })

  test("refuses a back edge across several hops", () => {
    expect(wouldCycle(pipeline("a->b", "b->c", "c->d"), "d", "a")).toBe(true)
  })

  test("allows a forward edge that skips a level", () => {
    expect(wouldCycle(pipeline("a->b", "b->c"), "a", "c")).toBe(false)
  })

  test("allows joining two independent branches", () => {
    expect(wouldCycle(pipeline("a->b", "a->c"), "b", "c")).toBe(false)
  })

  test("allows connecting unrelated nodes", () => {
    expect(wouldCycle(pipeline("a->b", "c->d"), "b", "c")).toBe(false)
  })

  test("terminates on a graph that already contains a cycle", () => {
    const graph = pipeline("a->b", "b->c")
    graph.edges.push({ id: "back", source: "c", target: "a" })
    expect(wouldCycle(graph, "b", "a")).toBe(true)
  })
})

describe("upstream / downstream", () => {
  test("reads a node's direct sources and targets", () => {
    const graph = pipeline("a->b", "b->c")
    expect(upstream(graph, "b")).toEqual(["a"])
    expect(downstream(graph, "b")).toEqual(["c"])
  })

  test("lists every parent of a join", () => {
    const graph = pipeline("a->c", "b->c")
    expect(upstream(graph, "c").sort()).toEqual(["a", "b"])
  })

  test("lists every child of a fan-out", () => {
    const graph = pipeline("a->b", "a->c")
    expect(downstream(graph, "a").sort()).toEqual(["b", "c"])
  })

  test("returns nothing for a root's sources or a leaf's targets", () => {
    const graph = pipeline("a->b")
    expect(upstream(graph, "a")).toEqual([])
    expect(downstream(graph, "b")).toEqual([])
  })
})

describe("ancestors", () => {
  test("walks the whole chain, not just the parent", () => {
    expect([...ancestors(pipeline("a->b", "b->c"), "c")].sort()).toEqual(["a", "b"])
  })

  test("collects both branches of a diamond without duplicates", () => {
    const found = ancestors(pipeline("a->b", "a->c", "b->d", "c->d"), "d")
    expect([...found].sort()).toEqual(["a", "b", "c"])
    expect(found.size).toBe(3)
  })

  test("is empty for a root", () => {
    expect([...ancestors(pipeline("a->b"), "a")]).toEqual([])
  })

  test("excludes the node itself", () => {
    expect(ancestors(pipeline("a->b", "b->c"), "c").has("c")).toBe(false)
  })

  test("ignores unrelated branches", () => {
    expect([...ancestors(pipeline("a->b", "c->d"), "b")]).toEqual(["a"])
  })

  test("terminates on a cyclic graph", () => {
    // Only reachable through validation-bypassing callers, but it must not hang.
    const graph = pipeline("a->b", "b->c")
    graph.edges.push({ id: "back", source: "c", target: "a" })
    expect([...ancestors(graph, "c")].sort()).toEqual(["a", "b", "c"])
  })
})

describe("preflight: gauntlet", () => {
  const withModel = (graph: Pipeline, model: string) => ({
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, agent: { ...node.agent, model, tools: { read: true } } })),
  })
  const unlocked = (...models: string[]) => ({ unlockedModels: new Set(models) })

  function gauntlet(spec: string[], settings: Pipeline["gauntlet"] = { bar: "beat the reference build" }) {
    return {
      ...withModel(pipeline(...spec), "opencode/x"),
      mode: "orchestration" as const,
      gauntlet: settings,
    }
  }

  const kinds = (graph: Pipeline) => ({
    blocking: preflight(graph, unlocked("opencode/x")).blocking.map((problem) => problem.kind),
    warnings: preflight(graph, unlocked("opencode/x")).warnings.map((problem) => problem.kind),
  })

  test("a builder and a critic under one orchestrator passes, with the caps stated", () => {
    const result = kinds(gauntlet(["root->builder", "root->reviewer"]))
    expect(result.blocking).toEqual([])
    expect(result.warnings).toEqual(["gauntlet-cost"])
    expect(preflight(gauntlet(["root->builder", "root->reviewer"]), unlocked("opencode/x")).warnings[0].message).toContain(
      "$5",
    )
  })

  test("no reviewer card blocks — the loop would run to a cap with nothing judging it", () => {
    expect(kinds(gauntlet(["root->builder", "root->other"])).blocking).toEqual(["no-critic"])
  })

  test("a reviewer that dispatches to cards of its own is not a critic", () => {
    expect(kinds(gauntlet(["root->reviewer", "reviewer->helper"])).blocking).toEqual(["orchestrating-critic"])
  })

  test("no bar warns rather than blocks — the orchestrator can be made to find one", () => {
    expect(kinds(gauntlet(["root->builder", "root->reviewer"], {})).warnings).toEqual(["no-bar", "gauntlet-cost"])
  })

  test("reference files pinned to the critic count as a bar", () => {
    const graph = gauntlet(["root->builder", "root->reviewer"], {})
    const withFiles = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "reviewer"
          ? {
              ...node,
              agent: {
                ...node.agent,
                attachments: [{ id: "f1", name: "reference.png", mime: "image/png", url: "data:,", size: 1 }],
              },
            }
          : node,
      ),
    }
    expect(kinds(withFiles).warnings).toEqual(["gauntlet-cost"])
  })

  test("the fan-out session count is not quoted — a gauntlet is bounded by money and time", () => {
    // Six subagents under a root would trip the >12-session warning in a plain
    // orchestration. Here that number would be a fiction: nothing counts down.
    const wide = gauntlet(["root->a", "root->b", "root->c", "root->d", "root->e", "root->reviewer"])
    expect(kinds(wide).warnings).toEqual(["gauntlet-cost"])
  })

  test("the tree rules still apply", () => {
    expect(kinds(gauntlet(["root->reviewer", "other->b"])).blocking).toContain("duplicate-orchestrator")
  })
})

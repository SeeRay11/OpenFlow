import { describe, expect, test } from "bun:test"
import { buildPrompt, pipelineBriefing } from "./prompt"
import { nodeMap, pipeline } from "./test-support"
import type { FlowNode } from "./types"

const graph = pipeline("planner->coder", "architect->coder")
const nodes = nodeMap(graph)

function node(id: string, prompt: string): FlowNode {
  return { ...nodes.get(id)!, agent: { ...nodes.get(id)!.agent, prompt } }
}

/**
 * Everything after the pipeline briefing, which every prompt now carries. The
 * briefing has its own tests below; these assert the sections around it, and
 * exact equality is worth keeping — it is what pins section order and the
 * blank-section rules.
 */
function body(text: string, target: FlowNode) {
  const prefix = pipelineBriefing(graph, target)
  expect(text.startsWith(prefix)).toBe(true)
  return text.slice(prefix.length).replace(/^\n\n/, "")
}

const outputs = new Map([
  ["planner", "1. rename the flag"],
  ["architect", "put it in cli/flags.ts"],
])

describe("buildPrompt", () => {
  test("leads with the role instructions", () => {
    const coder = node("coder", "You are the coder.")
    expect(body(buildPrompt(graph, coder, [], outputs, ""), coder)).toBe("You are the coder.")
  })

  test("omits the role section when the prompt is blank", () => {
    const coder = node("coder", "   ")
    expect(body(buildPrompt(graph, coder, [], outputs, "ship it"), coder)).toBe("# Task\n\nship it")
  })

  test("adds the run task under its own heading", () => {
    const coder = node("coder", "You are the coder.")
    expect(body(buildPrompt(graph, coder, [], outputs, "ship it"), coder)).toBe("You are the coder.\n\n# Task\n\nship it")
  })

  test("omits the task section when the input is whitespace", () => {
    const coder = node("coder", "You are the coder.")
    expect(body(buildPrompt(graph, coder, [], outputs, "  \n "), coder)).toBe("You are the coder.")
  })

  test("labels each upstream output with its role and id", () => {
    const coder = node("coder", "go")
    expect(body(buildPrompt(graph, coder, ["planner"], outputs, ""), coder)).toBe(
      "go\n\n# Upstream output\n\n## planner (planner)\n\n1. rename the flag",
    )
  })

  test("keeps upstream outputs in the order they were passed", () => {
    const text = buildPrompt(graph, node("coder", "go"), ["architect", "planner"], outputs, "")
    expect(text.indexOf("## architect")).toBeLessThan(text.indexOf("## planner"))
  })

  test("carries every source of a join", () => {
    const text = buildPrompt(graph, node("coder", "go"), ["planner", "architect"], outputs, "task")
    expect(text).toContain("## planner (planner)")
    expect(text).toContain("## architect (architect)")
    expect(text).toContain("1. rename the flag")
    expect(text).toContain("put it in cli/flags.ts")
  })

  test("skips a source that has not produced output yet", () => {
    const partial = new Map([["planner", "1. rename the flag"]])
    const text = buildPrompt(graph, node("coder", "go"), ["planner", "architect"], partial, "")
    expect(text).toContain("## planner")
    expect(text).not.toContain("## architect (architect)\n\n")
  })

  test("skips a source id that is not in the graph", () => {
    const coder = node("coder", "go")
    expect(body(buildPrompt(graph, coder, ["ghost"], outputs, ""), coder)).toBe("go")
  })

  test("drops the upstream heading when nothing upstream has output", () => {
    const coder = node("coder", "go")
    const text = buildPrompt(graph, coder, ["planner"], new Map(), "task")
    expect(text).not.toContain("# Upstream output")
    expect(body(text, coder)).toBe("go\n\n# Task\n\ntask")
  })

  test("orders the sections briefing, role, task, upstream", () => {
    const text = buildPrompt(graph, node("coder", "You are the coder."), ["planner"], outputs, "ship it")
    expect(text.indexOf("# OpenFlow")).toBe(0)
    expect(text.indexOf("You are the coder.")).toBeLessThan(text.indexOf("# Task"))
    expect(text.indexOf("# Task")).toBeLessThan(text.indexOf("# Upstream output"))
  })

  test("still briefs a node with no role prompt, task or upstream", () => {
    const coder = node("coder", "")
    expect(body(buildPrompt(graph, coder, [], new Map(), ""), coder)).toBe("")
  })

  test("preserves multi-line upstream output verbatim", () => {
    const multi = new Map([["planner", "1. first\n2. second\n\n- note"]])
    const text = buildPrompt(graph, node("coder", "go"), ["planner"], multi, "")
    expect(text).toContain("1. first\n2. second\n\n- note")
  })
})

describe("pipelineBriefing", () => {
  const chain = pipeline("planner->architect", "architect->coder", "coder->reviewer")
  const card = (graph: typeof chain, id: string) => graph.nodes.find((entry) => entry.id === id)!

  test("names the pipeline and its size", () => {
    const text = pipelineBriefing(chain, card(chain, "architect"))
    expect(text).toContain(`## Pipeline "test" — 4 card(s), 4 layer(s)`)
  })

  test("lists every card, including ones the node is not wired to", () => {
    const text = pipelineBriefing(chain, card(chain, "planner"))
    for (const id of ["planner", "architect", "coder", "reviewer"]) expect(text).toContain(`· ${id} (${id}) ·`)
  })

  test("marks which card the node is", () => {
    const text = pipelineBriefing(chain, card(chain, "coder"))
    expect(text).toContain("coder (coder) · receives: architect (architect) · feeds: reviewer (reviewer)  <-- YOU ARE HERE")
    expect(text.match(/YOU ARE HERE/g)).toHaveLength(1)
  })

  test("groups cards by execution layer", () => {
    const text = pipelineBriefing(chain, card(chain, "coder"))
    expect(text).toContain("- layer 1 · planner (planner)")
    expect(text).toContain("- layer 4 · reviewer (reviewer)")
  })

  test("names the cards that read this one next", () => {
    const text = pipelineBriefing(chain, card(chain, "architect"))
    expect(text).toContain("Your final message is read next by: coder (coder).")
  })

  test("tells a terminal card its output ends the run", () => {
    const text = pipelineBriefing(chain, card(chain, "reviewer"))
    expect(text).toContain("No card runs after you")
    expect(text).toContain("this is the run's final answer")
  })

  test("says a first card receives only the run task", () => {
    const text = pipelineBriefing(chain, card(chain, "planner"))
    expect(text).toContain("- layer 1 · planner (planner) · receives: the run task only")
  })

  test("names every source and target of a join", () => {
    const join = pipeline("planner->coder", "architect->coder", "coder->reviewer", "coder->docs")
    const text = pipelineBriefing(join, join.nodes.find((entry) => entry.id === "coder")!)
    expect(text).toContain("receives: planner (planner), architect (architect)")
    expect(text).toContain("feeds: reviewer (reviewer), docs (docs)")
  })

  test("still maps a cyclic graph rather than dropping the section", () => {
    const cyclic = pipeline("a->b", "b->a")
    const text = pipelineBriefing(cyclic, cyclic.nodes[0])
    expect(text).toContain("2 card(s)")
    expect(text).not.toContain("layer(s)")
    expect(text).toContain("- layer 1 · a (a)")
    expect(text).toContain("- layer 1 · b (b)")
  })
})

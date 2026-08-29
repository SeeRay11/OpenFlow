import { describe, expect, test } from "bun:test"
import {
  buildPrompt,
  dispatchResultPrompt,
  orchestratorPrompt,
  pipelineBriefing,
  reassignPrompt,
  subOrchestratorPrompt,
  subagentPrompt,
  swarmBriefing,
  swarmPrompt,
  synthesisPrompt,
} from "./prompt"
import { nodeMap, pipeline } from "./test-support"
import type { FlowNode, Pipeline } from "./types"

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

describe("swarm prompts", () => {
  /** Three peers and the card that decides, with the roles the run reads. */
  function swarm(rounds = 3): Pipeline {
    const graph = pipeline("alpha", "beta", "verdict")
    graph.nodes[2].role = "synthesizer"
    for (const entry of graph.nodes) entry.agent.model = "opencode/x"
    return { ...graph, mode: "swarm", rounds }
  }

  const at = (graph: Pipeline, id: string) => graph.nodes.find((entry) => entry.id === id)!

  test("the briefing names every peer, the round count and who decides", () => {
    const graph = swarm()
    const text = swarmBriefing(graph, at(graph, "alpha"))

    expect(text).toContain("2 agent(s), 3 round(s)")
    expect(text).toContain("- alpha (alpha) · opencode/x  <-- YOU ARE HERE")
    expect(text).toContain("- beta (beta) · opencode/x")
    expect(text).toContain("verdict: synthesizer (verdict)")
    // The point of the mode: a swarm that agrees because nobody argued has
    // burned every session in it for one opinion.
    expect(text).toContain("Disagree explicitly")
  })

  test("a one-round swarm says so rather than promising a debate that never comes", () => {
    const graph = swarm(1)
    expect(swarmBriefing(graph, at(graph, "alpha"))).toContain("There are no further rounds")
  })

  test("round 1 is the whole setup; later rounds are only what changed", () => {
    const graph = swarm()
    const first = swarmPrompt(graph, at(graph, "alpha"), 1, new Map(), "settle this")
    expect(first).toContain("OpenFlow swarm")
    expect(first).toContain("settle this")

    // The agent is re-prompted into the same session, so the briefing and the
    // task are already in it — paying for them again would be paying R times.
    const second = swarmPrompt(
      graph,
      at(graph, "alpha"),
      2,
      new Map([
        ["alpha", "what alpha said"],
        ["beta", "what beta said"],
      ]),
      "settle this",
    )
    expect(second).not.toContain("OpenFlow swarm")
    expect(second).toContain("Round 2 of 3")
    expect(second).toContain("## beta (beta)")
    expect(second).toContain("what beta said")
    expect(second).not.toContain("what alpha said")
  })

  test("the last round says it is the last, because nothing left out gets another chance", () => {
    const graph = swarm(2)
    const last = swarmPrompt(graph, at(graph, "alpha"), 2, new Map([["beta", "b"]]), "t")
    expect(last).toContain("This is the final round")
  })

  test("a round with every peer gone tells the agent to carry on alone", () => {
    const graph = swarm()
    const text = swarmPrompt(graph, at(graph, "alpha"), 2, new Map([["alpha", "only me"]]), "t")
    expect(text).toContain("No other agent produced an answer")
    expect(text).not.toContain("only me")
  })

  test("the synthesizer gets every position and is told not to average them", () => {
    const graph = swarm()
    const text = synthesisPrompt(
      graph,
      at(graph, "verdict"),
      new Map([
        ["alpha", "alpha's case"],
        ["beta", "beta's case"],
      ]),
      "settle this",
    )
    expect(text).toContain("You are the synthesizer")
    expect(text).toContain("settle this")
    expect(text).toContain("## alpha (alpha)")
    expect(text).toContain("beta's case")
    expect(text).toContain("do not average them")
  })

  test("a peer that produced nothing is named, so the verdict is not written over the hole", () => {
    const graph = swarm()
    const text = synthesisPrompt(graph, at(graph, "verdict"), new Map([["alpha", "alpha's case"]]), "t")
    expect(text).toContain("Agents that produced nothing")
    expect(text).toContain("- beta (beta)")
  })

  test("a swarm where everyone failed is told to say so rather than answer the task itself", () => {
    const graph = swarm()
    const text = synthesisPrompt(graph, at(graph, "verdict"), new Map(), "t")
    expect(text).toContain("Every agent in the swarm failed")
  })
})

describe("orchestration prompts", () => {
  /** A boss with two specialists, one of which has a card of its own. */
  function tree(): Pipeline {
    const graph = pipeline("boss->coder", "boss->reviewer", "coder->helper")
    for (const entry of graph.nodes) entry.agent.model = "opencode/x"
    graph.nodes[1].agent.prompt = "You are the coder.\nKeep diffs tight."
    return { ...graph, mode: "orchestration", dispatches: 2 }
  }
  const at = (graph: Pipeline, id: string) => graph.nodes.find((entry) => entry.id === id)!

  test("the orchestrator sees its cards, what each is for, and the exact block", () => {
    const graph = tree()
    const text = orchestratorPrompt(graph, at(graph, "boss"), "ship the feature")

    expect(text).toContain("Cards you can dispatch to — 2")
    expect(text).toContain("`coder`")
    // Assigning by label alone is how the reviewer gets asked to write code.
    expect(text).toContain("what it is for: You are the coder.")
    expect(text).toContain("it hands work to 1 card(s) of its own")
    expect(text).toContain('{ "dispatch": [ { "card": "<id from the list above>"')
    expect(text).toContain('{ "final": "the answer to the task" }')
    expect(text).toContain("You may dispatch 2 time(s)")
    expect(text).toContain("ship the feature")
  })

  test("a subagent with cards of its own is briefed as an orchestrator and given an assignment", () => {
    const graph = tree()
    const text = subOrchestratorPrompt(graph, at(graph, "coder"), at(graph, "boss"), "do the thing", "ship it")

    expect(text).toContain("You are a subagent of an OpenFlow run")
    expect(text).toContain("Cards you can dispatch to — 1")
    expect(text).toContain("boss (boss) dispatched you")
    expect(text).toContain("do the thing")
  })

  test("a leaf is never shown the protocol it cannot use", () => {
    const graph = tree()
    const text = subagentPrompt(graph, at(graph, "reviewer"), at(graph, "boss"), "audit it", "ship it")

    expect(text).toContain("boss (boss) dispatched you")
    expect(text).toContain("# Your assignment")
    expect(text).toContain("audit it")
    expect(text).not.toContain("Cards you can dispatch to")
    expect(text).not.toContain('"dispatch"')
  })

  test("results come back with the remaining budget, and a failure says what to do about it", () => {
    const graph = tree()
    const text = dispatchResultPrompt(
      graph,
      [
        { card: "coder", text: "wrote it" },
        { card: "reviewer", error: "provider said no" },
      ],
      1,
    )
    expect(text).toContain("You may dispatch 1 more time(s)")
    expect(text).toContain("## coder (coder)\n\nwrote it")
    expect(text).toContain("## reviewer (reviewer) — failed")
    expect(text).toContain("answer without it")
  })

  test("a spent budget says so rather than offering a dispatch that would be refused", () => {
    const graph = tree()
    expect(dispatchResultPrompt(graph, [{ card: "coder", text: "x" }], 0)).toContain("no dispatches left")
  })

  test("a re-dispatched card is told the old assignment is over", () => {
    // Otherwise it reads the second task as more detail on the first.
    const text = reassignPrompt("now do this instead")
    expect(text).toContain("earlier assignment is finished with")
    expect(text).toContain("now do this instead")
  })
})

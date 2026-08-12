import { describe, expect, test } from "bun:test"
import { buildPrompt } from "./prompt"
import { nodeMap, pipeline } from "./test-support"
import type { FlowNode } from "./types"

const graph = pipeline("planner->coder", "architect->coder")
const nodes = nodeMap(graph)

function node(id: string, prompt: string): FlowNode {
  return { ...nodes.get(id)!, agent: { ...nodes.get(id)!.agent, prompt } }
}

const outputs = new Map([
  ["planner", "1. rename the flag"],
  ["architect", "put it in cli/flags.ts"],
])

describe("buildPrompt", () => {
  test("leads with the role instructions", () => {
    const text = buildPrompt(node("coder", "You are the coder."), [], nodes, outputs, "")
    expect(text).toBe("You are the coder.")
  })

  test("omits the role section when the prompt is blank", () => {
    const text = buildPrompt(node("coder", "   "), [], nodes, outputs, "ship it")
    expect(text).toBe("# Task\n\nship it")
  })

  test("adds the run task under its own heading", () => {
    const text = buildPrompt(node("coder", "You are the coder."), [], nodes, outputs, "ship it")
    expect(text).toBe("You are the coder.\n\n# Task\n\nship it")
  })

  test("omits the task section when the input is whitespace", () => {
    const text = buildPrompt(node("coder", "You are the coder."), [], nodes, outputs, "  \n ")
    expect(text).toBe("You are the coder.")
  })

  test("labels each upstream output with its role and id", () => {
    const text = buildPrompt(node("coder", "go"), ["planner"], nodes, outputs, "")
    expect(text).toBe("go\n\n# Upstream output\n\n## planner (planner)\n\n1. rename the flag")
  })

  test("keeps upstream outputs in the order they were passed", () => {
    const text = buildPrompt(node("coder", "go"), ["architect", "planner"], nodes, outputs, "")
    expect(text.indexOf("## architect")).toBeLessThan(text.indexOf("## planner"))
  })

  test("carries every source of a join", () => {
    const text = buildPrompt(node("coder", "go"), ["planner", "architect"], nodes, outputs, "task")
    expect(text).toContain("## planner (planner)")
    expect(text).toContain("## architect (architect)")
    expect(text).toContain("1. rename the flag")
    expect(text).toContain("put it in cli/flags.ts")
  })

  test("skips a source that has not produced output yet", () => {
    const partial = new Map([["planner", "1. rename the flag"]])
    const text = buildPrompt(node("coder", "go"), ["planner", "architect"], nodes, partial, "")
    expect(text).toContain("## planner")
    expect(text).not.toContain("## architect")
  })

  test("skips a source id that is not in the graph", () => {
    const text = buildPrompt(node("coder", "go"), ["ghost"], nodes, outputs, "")
    expect(text).toBe("go")
  })

  test("drops the upstream heading when nothing upstream has output", () => {
    const text = buildPrompt(node("coder", "go"), ["planner"], nodes, new Map(), "task")
    expect(text).not.toContain("# Upstream output")
    expect(text).toBe("go\n\n# Task\n\ntask")
  })

  test("orders the sections role, task, upstream", () => {
    const text = buildPrompt(node("coder", "You are the coder."), ["planner"], nodes, outputs, "ship it")
    expect(text.indexOf("You are the coder.")).toBeLessThan(text.indexOf("# Task"))
    expect(text.indexOf("# Task")).toBeLessThan(text.indexOf("# Upstream output"))
  })

  test("returns an empty string when there is nothing to say", () => {
    expect(buildPrompt(node("coder", ""), [], nodes, new Map(), "")).toBe("")
  })

  test("preserves multi-line upstream output verbatim", () => {
    const multi = new Map([["planner", "1. first\n2. second\n\n- note"]])
    const text = buildPrompt(node("coder", "go"), ["planner"], nodes, multi, "")
    expect(text).toContain("1. first\n2. second\n\n- note")
  })
})

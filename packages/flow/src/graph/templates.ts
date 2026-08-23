import { nodeModel } from "./default-model"
import { role } from "./roles"
import { emptyPipeline, type FlowNode, type Pipeline } from "./types"

/**
 * A ready-made pipeline a first-timer can drop onto the canvas and run with no
 * wiring. Every template is built from the built-in roles, so its colours and
 * prompts read exactly as a hand-built graph would.
 */
export type Template = { id: string; name: string; description: string; build(): Pipeline }

/** One node's role, with an optional prompt override for the `custom` role. */
type Step = { role: string; prompt?: string }

/**
 * Builds a left-to-right chain: one node per step, each wired to the next.
 * Node ids follow the `n<time><counter>` scheme `state.addNode` uses, unique
 * within the pipeline; the default model preference is applied exactly as a
 * freshly dropped node gets it (F3), so a template is runnable on drop.
 */
function chain(name: string, steps: Step[]): Pipeline {
  const pipeline = emptyPipeline(name)
  const stamp = Date.now().toString(36)
  const nodes: FlowNode[] = steps.map((step, index) => {
    const preset = role(step.role)
    const agent = { ...(preset?.agent ?? { prompt: "" }), tools: { ...(preset?.agent.tools ?? {}) } }
    if (step.prompt) agent.prompt = step.prompt
    agent.model = nodeModel(preset?.agent.model)
    return {
      id: `n${stamp}${index.toString(36)}`,
      role: preset?.label ?? step.role,
      agent,
      position: { x: 40 + index * 300, y: 80 },
    }
  })
  pipeline.nodes = nodes
  pipeline.edges = nodes.slice(1).map((node, index) => ({
    id: `e${stamp}${index}`,
    source: nodes[index].id,
    target: node.id,
  }))
  return pipeline
}

const WRITER_PROMPT =
  "You are the writer. Using the plan above, draft a clear, well-structured document in prose. " +
  "Follow the plan's outline, fill in each section, and do not write code."

export const TEMPLATES: Template[] = [
  {
    id: "solo-coder",
    name: "solo coder",
    description: "Make one change to your project.",
    build: () => chain("solo coder", [{ role: "coder" }]),
  },
  {
    id: "plan-and-code",
    name: "plan and code",
    description: "Plan first, then implement.",
    build: () => chain("plan and code", [{ role: "planner" }, { role: "coder" }]),
  },
  {
    id: "plan-code-review",
    name: "plan, code, review",
    description: "The full loop.",
    build: () => chain("plan, code, review", [{ role: "planner" }, { role: "coder" }, { role: "reviewer" }]),
  },
  {
    id: "research-write",
    name: "research and write",
    description: "Draft a document.",
    build: () => chain("research and write", [{ role: "planner" }, { role: "custom", prompt: WRITER_PROMPT }]),
  },
]

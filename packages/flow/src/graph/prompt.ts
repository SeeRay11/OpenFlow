import type { Attachment, FlowNode, Pipeline } from "./types"
import { downstream, layer, upstream } from "./validate"

/** Node prompt = pipeline briefing + role instructions + run task + serialized upstream outputs. */
export function buildPrompt(
  pipeline: Pipeline,
  node: FlowNode,
  sources: string[],
  outputs: Map<string, string>,
  input: string,
  /** Files this node's model cannot read, named so it knows they exist. */
  skipped: Attachment[] = [],
) {
  const nodes = new Map(pipeline.nodes.map((entry) => [entry.id, entry] as const))
  const sections: string[] = [pipelineBriefing(pipeline, node)]
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (input.trim()) sections.push(`# Task\n\n${input.trim()}`)
  if (skipped.length) {
    // Silence would be worse: the node would answer as if the run had no
    // attachments at all, and a downstream node that *can* read them would get
    // a confidently wrong summary handed to it.
    const list = skipped.map((file) => `- ${file.name} (${file.mime})`).join("\n")
    sections.push(
      `# Attachments you cannot read\n\nThe run carries files this model has no input modality for, so they were withheld:\n\n${list}\n\nContinue with the task; do not claim to have seen them.`,
    )
  }
  const upstreamText = sources
    .map((id) => {
      const source = nodes.get(id)
      const output = outputs.get(id)
      if (!source || !output) return undefined
      return `## ${source.role} (${source.id})\n\n${output}`
    })
    .filter(Boolean)
  if (upstreamText.length) sections.push(`# Upstream output\n\n${upstreamText.join("\n\n")}`)
  return sections.join("\n\n")
}

/**
 * What the card is, where it sits, and who reads it next.
 *
 * A card is a plain `opencode` session with no idea it is part of anything, so
 * without this a planner asked to "hand this to the architect" does not know an
 * architect exists — it has never seen the graph. Every card gets the same map,
 * named by the same `role (id)` label the `# Upstream output` headers use, so
 * one card can refer to another and be understood.
 *
 * Kept to the graph and the handoff rules: the map is a few words per card, and
 * the strategy paragraph exists so a card plays only its own part instead of
 * pre-empting the ones after it.
 */
export function pipelineBriefing(pipeline: Pipeline, node: FlowNode) {
  const label = (id: string) => {
    const entry = pipeline.nodes.find((candidate) => candidate.id === id)
    return entry ? `${entry.role} (${entry.id})` : id
  }
  const validation = layer(pipeline)
  // A cyclic or malformed graph still gets a map — just an unordered one. The
  // run itself is blocked elsewhere; a prompt that silently drops the map here
  // would be the confusing half of the failure.
  const order = validation.ok ? validation.layers : [pipeline.nodes.map((entry) => entry.id)]
  const next = downstream(pipeline, node.id)
  const rows = order.flatMap((ids, index) =>
    ids.map((id) => {
      const feeds = downstream(pipeline, id)
      const receives = upstream(pipeline, id)
      const from = receives.length ? receives.map(label).join(", ") : "the run task only"
      const to = feeds.length ? feeds.map(label).join(", ") : "nothing — its output ends the run"
      const here = id === node.id ? "  <-- YOU ARE HERE" : ""
      return `- layer ${index + 1} · ${label(id)} · receives: ${from} · feeds: ${to}${here}`
    }),
  )

  return [
    "# OpenFlow",
    "",
    "You are one card in an OpenFlow pipeline: a graph of separate agent sessions run in",
    "dependency order. Each card is its own session with its own role, model and tools.",
    "Cards share no memory and cannot talk to each other. Every card receives the same run",
    "task; the only thing that crosses a card boundary is a card's final message, which is",
    "pasted verbatim into the prompt of every card wired downstream of it.",
    "",
    `## Pipeline "${pipeline.name}" — ${pipeline.nodes.length} card(s)${validation.ok ? `, ${validation.layers.length} layer(s)` : ""}`,
    "",
    ...rows,
    "",
    "## Your part",
    "",
    upstream(pipeline, node.id).length
      ? `You are ${label(node.id)}. Every card above you has already run; the output you were given is quoted at the end of this prompt — which may be less than the whole chain produced.`
      : `You are ${label(node.id)}. Nothing runs before you: the run task below is all you get.`,
    next.length
      ? `Your final message is read next by: ${next.map(label).join(", ")}.`
      : "No card runs after you: your final message is the result of the whole run.",
    "",
    "- Do your role's part and stop. Work a downstream card owns is that card's job — name",
    "  what it needs and hand it over instead of doing it yourself, unless the task asks",
    "  you specifically to do it.",
    "- Do not redo work an upstream card already did. Build on its output; do not restate it.",
    "- No card can ask you a question and nothing is interactive. Where the task is",
    "  ambiguous, state the assumption you took and continue.",
    next.length
      ? "- Write for the card that reads you next, not for a human: what it needs to act, in\n  the shortest form that carries it. No preamble, no summary of what it already has."
      : "- Write for the person who started the run: this is the run's final answer.",
  ].join("\n")
}

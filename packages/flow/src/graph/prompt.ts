import type { FlowNode } from "./types"

/** Node prompt = role instructions + run task + serialized upstream outputs. */
export function buildPrompt(
  node: FlowNode,
  sources: string[],
  nodes: Map<string, FlowNode>,
  outputs: Map<string, string>,
  input: string,
) {
  const sections: string[] = []
  if (node.agent.prompt.trim()) sections.push(node.agent.prompt.trim())
  if (input.trim()) sections.push(`# Task\n\n${input.trim()}`)
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

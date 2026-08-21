import type { Attachment, FlowNode } from "./types"

/** Node prompt = role instructions + run task + serialized upstream outputs. */
export function buildPrompt(
  node: FlowNode,
  sources: string[],
  nodes: Map<string, FlowNode>,
  outputs: Map<string, string>,
  input: string,
  /** Files this node's model cannot read, named so it knows they exist. */
  skipped: Attachment[] = [],
) {
  const sections: string[] = []
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

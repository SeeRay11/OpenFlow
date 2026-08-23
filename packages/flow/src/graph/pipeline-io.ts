import type { Pipeline } from "./types"

/**
 * Whether a parsed value is a usable OpenFlow pipeline.
 *
 * The exported file is exactly the `Pipeline` JSON the server stores, with no
 * wrapper, so an imported file, a hand-edited file, and a file from
 * `.openflow/pipelines/` all validate here. Kept a pure guard: import reads a
 * file, parses it, and only calls `actions.load` once this returns true — a bad
 * file becomes a notice, never a throw.
 */
export function isPipeline(value: unknown): value is Pipeline {
  if (!isObject(value)) return false
  if (typeof value.id !== "string" || typeof value.name !== "string") return false
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false
  return value.nodes.every(isNode) && value.edges.every(isEdge)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNode(value: unknown): boolean {
  if (!isObject(value)) return false
  if (typeof value.id !== "string" || typeof value.role !== "string") return false
  if (!isObject(value.agent) || typeof value.agent.prompt !== "string") return false
  return isObject(value.position) && typeof value.position.x === "number" && typeof value.position.y === "number"
}

function isEdge(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.target === "string"
  )
}

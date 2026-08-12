import type { FlowNode, Pipeline } from "./types"

/**
 * Test-only builder. Each spec entry is either an edge (`"a->b"`) or a bare
 * node id (`"a"`); nodes are created implicitly in first-seen order and get
 * their id as the role.
 *
 *   pipeline("a->b", "a->c", "b->d", "c->d")   // diamond
 */
export function pipeline(...spec: string[]): Pipeline {
  const nodes: FlowNode[] = []
  const edges: Pipeline["edges"] = []
  const seen = new Set<string>()

  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    nodes.push({
      id,
      role: id,
      agent: { prompt: "" },
      position: { x: nodes.length * 100, y: 0 },
    })
  }

  for (const entry of spec) {
    if (!entry.includes("->")) {
      add(entry.trim())
      continue
    }
    const [source, target] = entry.split("->").map((part) => part.trim())
    add(source)
    add(target)
    edges.push({ id: `e${edges.length}`, source, target })
  }

  return { id: "test-pipeline", name: "test", nodes, edges }
}

export function nodeMap(graph: Pipeline) {
  return new Map(graph.nodes.map((node) => [node.id, node] as const))
}

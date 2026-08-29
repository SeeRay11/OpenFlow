import type { FlowNode, Pipeline } from "./types"

/** The role a card must carry to be the one that assigns the work. */
export const ORCHESTRATOR_ROLE = "orchestrator"

/**
 * An orchestration canvas read as a tree.
 *
 * The root is the card nothing points at; everything else is somebody's
 * subagent. A card with children of its own is an orchestrator for its subtree
 * and runs the identical dispatch loop one level down — that is the whole of
 * "subagents can deploy subagents", and it means every session in a run is a
 * card the user drew, priced and re-runnable, rather than something a model
 * conjured inside a transcript.
 *
 * `roots` and `shared` are lists rather than single values because two roots, or
 * a card two orchestrators both dispatch, are real mistakes preflight has to be
 * able to point at.
 */
export function orchestrationShape(pipeline: Pipeline) {
  const children = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  for (const node of pipeline.nodes) {
    children.set(node.id, [])
    parents.set(node.id, [])
  }
  const seen = new Set<string>()
  for (const edge of pipeline.edges) {
    const key = `${edge.source}->${edge.target}`
    if (seen.has(key) || !children.has(edge.source) || !parents.has(edge.target)) continue
    seen.add(key)
    children.get(edge.source)!.push(edge.target)
    parents.get(edge.target)!.push(edge.source)
  }

  const roots = pipeline.nodes.filter((node) => !parents.get(node.id)!.length)
  // Two parents means one card's answer is owed to two orchestrators, and the
  // second dispatch would re-prompt a session mid-task for somebody else.
  const shared = pipeline.nodes.filter((node) => parents.get(node.id)!.length > 1)

  return {
    root: roots[0],
    roots,
    shared,
    children: (id: string) => children.get(id) ?? [],
    /** How many dispatch levels sit below the root. A lone root is 0. */
    depth: roots.length === 1 ? measure(roots[0].id, children, new Set()) : 0,
  }
}

/**
 * Longest path below `id`, in levels.
 *
 * `guard` makes this terminate on a graph that still has a cycle in it. The
 * shape is validated before a run, but this is also called while the user is
 * mid-edit, when the canvas is legitimately half-built.
 */
function measure(id: string, children: Map<string, string[]>, guard: Set<string>): number {
  if (guard.has(id)) return 0
  guard.add(id)
  const below = (children.get(id) ?? []).map((child) => measure(child, children, guard))
  guard.delete(id)
  return below.length ? 1 + Math.max(...below) : 0
}

/** Every card `node` may dispatch to, in canvas order rather than edge order. */
export function subagentsOf(pipeline: Pipeline, node: FlowNode) {
  const ids = new Set(orchestrationShape(pipeline).children(node.id))
  return pipeline.nodes.filter((entry) => ids.has(entry.id))
}

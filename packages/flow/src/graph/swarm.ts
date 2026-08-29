import type { FlowNode, Pipeline } from "./types"

/** The role a card must carry to be the one that writes a swarm's verdict. */
export const SYNTHESIZER_ROLE = "synthesizer"

/**
 * A swarm's two kinds of card, read off the canvas.
 *
 * There are no edges to read: in swarm mode every agent card is a peer of every
 * other, so membership *is* the mesh and the graph is the node list. The
 * synthesizer is identified by its role text, the same string the palette drops
 * and the inspector edits, so designating one is renaming a card rather than
 * setting a hidden flag.
 *
 * `synthesizers` is a list rather than one node because two of them is a real
 * mistake a user can make, and preflight has to be able to say so.
 */
export function swarmShape(pipeline: Pipeline) {
  const synthesizers: FlowNode[] = []
  const agents: FlowNode[] = []
  for (const node of pipeline.nodes) (node.role === SYNTHESIZER_ROLE ? synthesizers : agents).push(node)
  return { agents, synthesizers }
}

/**
 * Every peer link, each pair once.
 *
 * Only the canvas needs these — the mesh is drawn, never stored — and drawing
 * both directions of a pair would lay two identical lines on top of each other.
 */
export function meshPairs(agents: FlowNode[]) {
  return agents.flatMap((from, index) => agents.slice(index + 1).map((to) => ({ from, to })))
}

import type { Pipeline } from "./types"

export type Validation = { ok: true; layers: string[][] } | { ok: false; error: string }

/**
 * Kahn's algorithm. Produces execution layers: every node in layer N depends
 * only on nodes in layers < N, so a whole layer can be dispatched at once.
 * A leftover node means the graph contains a cycle.
 */
export function layer(pipeline: Pipeline): Validation {
  const ids = new Set(pipeline.nodes.map((node) => node.id))
  if (!pipeline.nodes.length) return { ok: false, error: "pipeline has no nodes" }

  for (const edge of pipeline.edges) {
    if (!ids.has(edge.source)) return { ok: false, error: `edge ${edge.id} has unknown source ${edge.source}` }
    if (!ids.has(edge.target)) return { ok: false, error: `edge ${edge.id} has unknown target ${edge.target}` }
    if (edge.source === edge.target) return { ok: false, error: `edge ${edge.id} is a self-loop` }
  }

  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of ids) {
    indegree.set(id, 0)
    outgoing.set(id, [])
  }
  const seen = new Set<string>()
  for (const edge of pipeline.edges) {
    const key = `${edge.source}->${edge.target}`
    if (seen.has(key)) continue
    seen.add(key)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.get(edge.source)!.push(edge.target)
  }

  const layers: string[][] = []
  let frontier = [...ids].filter((id) => indegree.get(id) === 0)
  let placed = 0
  while (frontier.length) {
    layers.push([...frontier].sort())
    placed += frontier.length
    const next: string[] = []
    for (const id of frontier) {
      for (const target of outgoing.get(id)!) {
        const remaining = indegree.get(target)! - 1
        indegree.set(target, remaining)
        if (remaining === 0) next.push(target)
      }
    }
    frontier = next
  }

  if (placed !== ids.size) return { ok: false, error: "pipeline contains a cycle" }
  return { ok: true, layers }
}

/** One thing wrong with a pipeline, in words a first-timer can act on. */
export type Problem = { nodeId?: string; kind: string; message: string }

/** Blocking problems stop a run; warnings are surfaced but let it proceed. */
export type Preflight = { blocking: Problem[]; warnings: Problem[] }

/**
 * Everything that would make a run fail or surprise the user, gathered in one
 * place before a single session is created. Structural checks reuse `layer()`
 * so the graph rules live in exactly one algorithm; the rest are per-node.
 *
 * `unlockedModels` is the `providerID/modelID` set the user can actually run
 * right now (a keyed, runnable model). A model set but absent from it is the
 * "keyed provider that still 401s" case, so it blocks rather than warns.
 */
export function preflight(pipeline: Pipeline, ctx: { unlockedModels: Set<string> }): Preflight {
  const blocking: Problem[] = []
  const warnings: Problem[] = []

  // One structural problem is enough to stop the run, and `layer` already
  // reports the first it finds (no nodes, a cycle, an unknown or self edge).
  const structure = layer(pipeline)
  if (!structure.ok) blocking.push({ kind: "structure", message: structure.error })

  for (const node of pipeline.nodes) {
    const model = node.agent.model
    if (!model) {
      // No model and no agent to fall back on means nothing to run it on.
      if (!node.agent.name)
        blocking.push({
          nodeId: node.id,
          kind: "no-model",
          message: `Node '${node.role}' has no model — pick one or set a default`,
        })
    } else if (!ctx.unlockedModels.has(model)) {
      blocking.push({
        nodeId: node.id,
        kind: "locked-model",
        message: `Node '${node.role}' uses ${model}, which no connected provider can run — add its key or pick another model`,
      })
    }

    // edit/bash without a restricted agent runs as the default `build` agent,
    // which can write real files — the known hazard, named for the user.
    const tools = node.agent.tools ?? {}
    if ((tools.edit || tools.write || tools.bash) && !node.agent.name)
      warnings.push({
        nodeId: node.id,
        kind: "unrestricted-write",
        message: `Node '${node.role}' can edit files or run commands but has no agent — it may write real files as the default build agent`,
      })
  }

  if (pipeline.nodes.length > 1) {
    const connected = new Set<string>()
    for (const edge of pipeline.edges) {
      connected.add(edge.source)
      connected.add(edge.target)
    }
    for (const node of pipeline.nodes)
      if (!connected.has(node.id))
        warnings.push({
          nodeId: node.id,
          kind: "isolated",
          message: `Node '${node.role}' has no connections — it runs on the task alone`,
        })
  }

  return { blocking, warnings }
}

/** True when adding source->target would close a cycle. */
export function wouldCycle(pipeline: Pipeline, source: string, target: string) {
  if (source === target) return true
  const outgoing = new Map<string, string[]>()
  for (const edge of pipeline.edges) {
    const list = outgoing.get(edge.source) ?? []
    list.push(edge.target)
    outgoing.set(edge.source, list)
  }
  const stack = [target]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (id === source) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(outgoing.get(id) ?? []))
  }
  return false
}

export function upstream(pipeline: Pipeline, id: string) {
  return pipeline.edges.filter((edge) => edge.target === id).map((edge) => edge.source)
}

export function downstream(pipeline: Pipeline, id: string) {
  return pipeline.edges.filter((edge) => edge.source === id).map((edge) => edge.target)
}

/** Every node that can reach `id` through the graph. Excludes `id` itself. */
export function ancestors(pipeline: Pipeline, id: string) {
  const found = new Set<string>()
  const stack = upstream(pipeline, id)
  while (stack.length) {
    const next = stack.pop()!
    if (found.has(next)) continue
    found.add(next)
    stack.push(...upstream(pipeline, next))
  }
  return found
}

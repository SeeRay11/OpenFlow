import { agentKey } from "../server/store"
import { isCritic, orchestrationShape } from "./orchestration"
import { swarmShape } from "./swarm"
import { depthOf, dispatchesOf, gauntletOf, modeOf, type Pipeline } from "./types"

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
 *
 * `engineReachable: false` means the model catalog could not be read at all, so
 * `unlockedModels` is empty for a reason that has nothing to do with any node.
 * Only an explicit `false` counts — an unstated engine is assumed up.
 */
export function preflight(
  pipeline: Pipeline,
  ctx: { unlockedModels: Set<string>; engineReachable?: boolean },
): Preflight {
  const blocking: Problem[] = []
  const warnings: Problem[] = []
  const offline = ctx.engineReachable === false

  // With the engine down every model looks locked, so one true problem replaces
  // a wall of confident, specific, wrong per-node diagnoses.
  if (offline)
    blocking.push({
      kind: "engine-unreachable",
      message:
        "OpenFlow cannot reach `opencode serve`, so no model can run and no provider can be read — start the engine with `bun openflow.ts`, then try again",
    })

  const shape = shapeProblems(pipeline)
  blocking.push(...shape.blocking)
  warnings.push(...shape.warnings)

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
    } else if (!offline && !ctx.unlockedModels.has(model)) {
      blocking.push({
        nodeId: node.id,
        kind: "locked-model",
        message: `Node '${node.role}' uses ${model}, which no connected provider can run — add its key or pick another model`,
      })
    }

    // A node that says nothing about tools runs unrestricted.
    //
    // This used to warn the other way round — "can edit files but has no agent"
    // — and it was backwards twice over. Every node becomes a generated agent
    // the moment a run starts (`syncAgents` fills `agent.name` from
    // `agentKey`), so an empty name at preflight means nothing; it is filled a
    // second later, which is why the warning fired for six cards that all ran
    // under restricted agents. And declaring tools is what *creates* the
    // restriction: `agentBlock` writes a `permission` block only from
    // `agent.tools`, so a node that declares none inherits the default agent's
    // permissions — edit, write and bash included. The hazard is silence, not
    // toggles.
    const tools = node.agent.tools
    if (!node.agent.name && !(tools && Object.keys(tools).length))
      warnings.push({
        nodeId: node.id,
        kind: "unrestricted-write",
        message: `Node '${node.role}' sets no tool permissions, so it runs with the default agent's — it can edit files and run commands`,
      })
  }

  // Two nodes generating the same agent id collapse into one merged agent, and
  // the last one written decides both nodes' tool permissions — a node the user
  // restricted would run with the other's edit/bash access. The key is unique
  // per node today; this refuses the run rather than trusting that to hold.
  const owners = new Map<string, string>()
  for (const node of pipeline.nodes) {
    const key = agentKey(pipeline, node)
    const owner = owners.get(key)
    if (owner)
      blocking.push({
        nodeId: node.id,
        kind: "duplicate-agent",
        message: `Nodes '${owner}' and '${node.role}' both generate the agent id '${key}' — one would overwrite the other's tool permissions`,
      })
    owners.set(key, node.role)
  }

  // Only pipeline mode reads edges, so only pipeline mode can have a node the
  // wiring forgot. A swarm's peers are implicit and carry no edges at all.
  if (modeOf(pipeline) === "pipeline" && pipeline.nodes.length > 1) {
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

/**
 * The structural rules of the mode this canvas is in.
 *
 * Each mode wants a different graph — a DAG, a mesh, a tree — so this is the
 * only part of preflight that differs between them; every per-node check
 * around it is shared. Modes without a scheduler refuse here rather than
 * falling through, because the alternative is a graph the user built as a swarm
 * quietly running as a pipeline.
 */
function shapeProblems(pipeline: Pipeline): Preflight {
  const mode = modeOf(pipeline)
  if (mode === "swarm") return swarmProblems(pipeline)
  if (mode === "orchestration") return orchestrationProblems(pipeline)
  // One structural problem is enough to stop the run, and `layer` already
  // reports the first it finds (no nodes, a cycle, an unknown or self edge).
  const structure = layer(pipeline)
  return { blocking: structure.ok ? [] : [{ kind: "structure", message: structure.error }], warnings: [] }
}

/**
 * A swarm is a node list, not a wiring: enough agents to disagree, and exactly
 * one card to decide.
 *
 * Both counts are blocking rather than defaulted. Auto-adding a synthesizer at
 * run time would put a card on the canvas the user never placed and bill them
 * for it; picking one of the agents to decide would silently privilege whichever
 * one happened to be first.
 */
function swarmProblems(pipeline: Pipeline): Preflight {
  const shape = swarmShape(pipeline)
  const blocking: Problem[] = []
  const warnings: Problem[] = []

  if (shape.agents.length < 2)
    blocking.push({
      kind: "swarm-too-small",
      message: `A swarm needs at least two agent cards to debate — this canvas has ${shape.agents.length}`,
    })
  if (!shape.synthesizers.length)
    blocking.push({
      kind: "no-synthesizer",
      message: "A swarm has no synthesizer card, so nothing would write the verdict — drop one on the canvas",
    })
  for (const extra of shape.synthesizers.slice(1))
    blocking.push({
      nodeId: extra.id,
      kind: "duplicate-synthesizer",
      message: `Only one card can write a swarm's verdict, and this canvas has ${shape.synthesizers.length} synthesizers — delete the extras or change their role`,
    })

  // Peers with nothing to tell them apart. The briefing orders every agent to
  // disagree explicitly, because the measured failure of round 2 is everyone
  // restating whoever sounded most certain — but that assumes there is
  // something real to disagree about. Same role, same model and same
  // instructions leaves no axis to diverge on, so the mandate gets satisfied
  // the only way left: manufactured objections about phrasing. Identical cards
  // are also correlated in their errors, so the synthesizer gets five confident
  // votes for one opinion and no signal to break the tie.
  //
  // A warning rather than a block: N identical drafts judged by a synthesizer
  // is best-of-N sampling, which is a real way to run a swarm — but only at
  // `rounds: 1`, where no peer text is ever quoted and the cards cannot reject
  // each other.
  const twins = new Map<string, typeof shape.agents>()
  for (const agent of shape.agents) {
    const key = JSON.stringify([agent.role, agent.agent.model ?? "", agent.agent.prompt.trim()])
    twins.set(key, [...(twins.get(key) ?? []), agent])
  }
  for (const group of twins.values()) {
    if (group.length < 2) continue
    warnings.push({
      kind: "identical-peers",
      message: `${group.map((agent) => agent.role).join(", ")} are the same role on the same model with the same instructions, so they have nothing to disagree about — the swarm pays for ${group.length} sessions and gets one opinion. Give them different roles, models or instructions, or set rounds to 1 and let the synthesizer pick between independent drafts.`,
    })
  }

  // Switching a pipeline to swarm keeps its wiring, which now does nothing.
  // Silence would read as "the graph still works the way it looks".
  if (pipeline.edges.length)
    warnings.push({
      kind: "ignored-edges",
      message: `Swarm mode ignores the ${pipeline.edges.length} connection(s) drawn here — every agent is a peer of every other automatically`,
    })

  return { blocking, warnings }
}

/**
 * An orchestration is a tree: one card at the top, and every card below it owed
 * to exactly one orchestrator.
 *
 * A diamond is the interesting rejection. Two parents means one card's answer is
 * owed to two orchestrators, and the second dispatch would re-prompt a session
 * that is still working on the first one's task — the sort of thing that
 * produces a plausible answer to a question nobody asked.
 */
function orchestrationProblems(pipeline: Pipeline): Preflight {
  const structure = layer(pipeline)
  if (!structure.ok) return { blocking: [{ kind: "structure", message: structure.error }], warnings: [] }

  const shape = orchestrationShape(pipeline)
  const blocking: Problem[] = []
  const warnings: Problem[] = []

  // A graph with no root at all is a cycle, and `layer` above already refused
  // it — in a DAG something always has nothing pointing at it. For the same
  // reason there is no unreachable-card case: every card is downstream of some
  // root, so a stray one shows up as a second root rather than as an orphan.
  for (const extra of shape.roots.slice(1))
    blocking.push({
      nodeId: extra.id,
      kind: "duplicate-orchestrator",
      message: `An orchestration runs from one card, and this canvas has ${shape.roots.length} with no incoming connection — wire the extras under the orchestrator, or delete them`,
    })
  for (const node of shape.shared)
    blocking.push({
      nodeId: node.id,
      kind: "shared-subagent",
      message: `Card '${node.role}' is dispatched by more than one orchestrator — a card answers to exactly one, or its session gets re-prompted mid-task`,
    })
  const limit = depthOf(pipeline)
  if (shape.depth > limit)
    blocking.push({
      kind: "too-deep",
      message: `The subagent tree is ${shape.depth} level(s) deep and the limit is ${limit} — raise the depth setting or flatten the graph`,
    })
  if (shape.roots.length === 1 && !shape.depth)
    blocking.push({
      nodeId: shape.root.id,
      kind: "no-subagents",
      message: `Card '${shape.root.role}' has nobody to dispatch to — connect the subagent cards it should assign work to`,
    })

  const gauntlet = gauntletOf(pipeline)
  if (gauntlet) {
    // A gauntlet without a critic is an orchestration with no dispatch limit —
    // the most expensive shape on the canvas, and nothing in it judging.
    const critics = pipeline.nodes.filter(isCritic)
    if (!critics.length)
      blocking.push({
        kind: "no-critic",
        message:
          "A gauntlet has no reviewer card, so nothing would judge the work against the bar — drop one on the canvas and wire it under an orchestrator",
      })
    else if (!critics.some((critic) => shape.children(critic.id).length === 0))
      blocking.push({
        kind: "orchestrating-critic",
        message: "Every reviewer card here dispatches to cards of its own — a critic judges work, so at least one has to be a leaf",
      })

    // Not blocking: the briefing makes an orchestrator that was given no bar
    // establish one before it builds anything. That is a real way to run this —
    // it is just the expensive way, and worth saying out loud first.
    if (!gauntlet.bar && !critics.some((critic) => critic.agent.attachments?.length))
      warnings.push({
        kind: "no-bar",
        message:
          "This gauntlet has no bar, so the orchestrator has to invent one before it can start — write what 'good' compares against, or pin reference files to a reviewer card",
      })

    warnings.push({
      kind: "gauntlet-cost",
      message: `A gauntlet runs until the work clears the bar — this one stops at $${gauntlet.maxSpend} or ${gauntlet.maxMinutes} minutes, whichever comes first`,
    })
    return { blocking, warnings }
  }

  // Worst case, stated before a session exists. Every level multiplies, so the
  // number is the one thing a user cannot work out by looking at the canvas.
  const worst = worstCase(pipeline)
  if (worst > 12)
    warnings.push({
      kind: "fan-out",
      message: `This graph can reach ${worst} sessions if every orchestrator uses all ${dispatchesOf(pipeline)} of its dispatches`,
    })

  return { blocking, warnings }
}

/**
 * How many sessions the run can cost if every orchestrator dispatches to
 * everything, every time it is allowed to.
 *
 * A card is one session however often it is re-prompted, so this counts cards
 * weighted by how many times an ancestor could reach them — which is what makes
 * a shallow-looking graph expensive.
 */
function worstCase(pipeline: Pipeline) {
  const shape = orchestrationShape(pipeline)
  if (shape.roots.length !== 1) return pipeline.nodes.length
  const dispatches = dispatchesOf(pipeline)
  const count = (id: string, guard: Set<string>): number => {
    if (guard.has(id)) return 0
    guard.add(id)
    const below = shape.children(id).reduce((total, child) => total + count(child, guard), 0)
    guard.delete(id)
    return 1 + (below ? below * dispatches : 0)
  }
  return count(shape.root.id, new Set())
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

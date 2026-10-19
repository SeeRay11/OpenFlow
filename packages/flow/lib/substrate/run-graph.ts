/**
 * One Substrate Graph ID per workflow run, shared by its cards.
 *
 * The run's ID is minted here (`ut-<ts36>-<8hex>`, the format `graph_bind` enforces),
 * `graph_register`ed with the cards as nodes as they appear, and used as the
 * `graph_id` of every memory write and event. Registration matters for the `graph`
 * ttl: an unregistered graph counts as expired at once. Everything here fails open.
 *
 * Events carry the role and the outcome only: never the prompt, never the output.
 */
import { randomBytes } from "node:crypto"
import type { SubstrateClient } from "./client"

const MAX_RUNS = 200

export type GraphContext = { client: SubstrateClient; repo: string; branch?: string }

type Run = {
  graphId: string
  /** Nodes Substrate has acknowledged. */
  nodes: Set<string>
  started: Set<string>
  /** Registrations of one run are serialised: each sends the full node list. */
  chain: Promise<void>
}

export function createRunGraphs(deps: { now: () => number }): RunGraphs {
  const runs = new Map<string, Run>()

  function run(runId: string): Run {
    const known = runs.get(runId)
    if (known) return known
    const created: Run = {
      graphId: `ut-${deps.now().toString(36)}-${randomBytes(4).toString("hex")}`,
      nodes: new Set(),
      started: new Set(),
      chain: Promise.resolve(),
    }
    runs.set(runId, created)
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value as string)
    return created
  }

  function register(context: GraphContext, runId: string, nodeId: string): Promise<void> {
    const state = run(runId)
    state.chain = state.chain.then(async () => {
      if (state.nodes.has(nodeId)) return
      const nodes = [...state.nodes, nodeId].map((node_id) => ({ node_id, state: "started" as const }))
      const reply = await context.client.graphRegister({ graph_id: state.graphId, repo: context.repo, branch: context.branch, nodes })
      if (reply.ok) state.nodes.add(nodeId)
    })
    return state.chain
  }

  async function emit(
    context: GraphContext,
    kind: "session.start" | "session.end",
    input: { pipeline: string; runId: string; nodeId: string; payload: Record<string, string> },
  ): Promise<void> {
    const state = run(input.runId)
    await context.client.eventsEmit({
      kind,
      summary: `openflow ${input.pipeline} card ${input.nodeId} ${kind === "session.start" ? "started" : "finished"}`.slice(0, 500),
      session_id: `openflow-${input.runId}-${input.nodeId}`,
      graph_id: state.graphId,
      node_id: input.nodeId,
      repo: context.repo,
      branch: context.branch,
      payload: input.payload,
    })
  }

  return {
    graphId(runId: string): string {
      return run(runId).graphId
    },

    /** Registers the node (first time) and emits `session.start` on the first call for the (run, node). */
    async begin(context: GraphContext, input: { pipeline: string; runId: string; nodeId: string; role?: string }): Promise<void> {
      const state = run(input.runId)
      const first = !state.started.has(input.nodeId)
      state.started.add(input.nodeId)
      await register(context, input.runId, input.nodeId)
      if (first) await emit(context, "session.start", { ...input, payload: { role: input.role ?? "" } })
    },

    /** Makes sure the node is registered (a write may be the first call after a restart), then emits `session.end`. */
    async end(context: GraphContext, input: { pipeline: string; runId: string; nodeId: string; role: string; outcome: string }): Promise<void> {
      await register(context, input.runId, input.nodeId)
      await emit(context, "session.end", { ...input, payload: { role: input.role, outcome: input.outcome } })
    },

    /** Registration only; a write needs the graph to exist before a `graph` ttl is set. */
    register,
  }
}

export type RunGraphs = {
  graphId(runId: string): string
  /** Registers the node (first time) and emits `session.start` on the first call for the (run, node). */
  begin(context: GraphContext, input: { pipeline: string; runId: string; nodeId: string; role?: string }): Promise<void>
  /** Makes sure the node is registered (a write may be the first call after a restart), then emits `session.end`. */
  end(context: GraphContext, input: { pipeline: string; runId: string; nodeId: string; role: string; outcome: string }): Promise<void>
  /** Registration only; a write needs the graph to exist before a `graph` ttl is set. */
  register(context: GraphContext, runId: string, nodeId: string): Promise<void>
}

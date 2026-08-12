import { buildPrompt } from "../graph/prompt"
import type { FlowNode, NodeStatus, Pipeline, RunLog, RunNodeLog } from "../graph/types"
import { ancestors, layer, upstream } from "../graph/validate"
import * as api from "./client"
import { store } from "./store"

export type NodePatch = {
  status?: NodeStatus
  sessionID?: string
  output?: string
  error?: string
  prompt?: string
  activity?: string
  started?: number
  finished?: number
}

export type EngineHooks = {
  onNode: (id: string, patch: NodePatch) => void
  onRun?: (run: RunLog) => void
  onNotice?: (kind: "info" | "error", text: string) => void
}

export type Run = {
  log: RunLog
  stop: () => Promise<void>
  done: Promise<RunLog>
}

/**
 * How much upstream context a node receives.
 * - `direct`: only the nodes wired straight into it.
 * - `ancestors`: every node that can reach it, in execution order.
 */
export type PipeMode = "direct" | "ancestors"

/**
 * Executes a pipeline over `opencode serve`.
 *
 * One node = one primary session. Nodes are grouped into topological layers;
 * every node in a layer is dispatched concurrently (`POST /api/session/:id/prompt`
 * only admits the input and schedules the agent loop, so the fan-out is real),
 * then the whole layer is awaited via `POST /api/session/:id/wait` before the
 * next layer starts. Live per-node status comes from the `/api/event` bus.
 */
export function start(pipeline: Pipeline, input: string, hooks: EngineHooks, pipe: PipeMode = "ancestors"): Run {
  const validation = layer(pipeline)
  if (!validation.ok) throw new Error(validation.error)
  const order = new Map(validation.layers.flatMap((ids, index) => ids.map((id) => [id, index] as const)))

  const controller = new AbortController()
  const sessions = new Map<string, string>() // sessionID -> nodeID
  const active = new Set<string>() // sessionIDs still running
  const nodes = new Map(pipeline.nodes.map((node) => [node.id, node] as const))
  const outputs = new Map<string, string>()
  const failed = new Set<string>()

  const log: RunLog = {
    id: `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    pipeline: pipeline.name,
    pipelineID: pipeline.id,
    input,
    status: "running",
    started: Date.now(),
    nodes: pipeline.nodes.map<RunNodeLog>((node) => ({
      id: node.id,
      role: node.role,
      status: "queued",
      agent: node.agent.name,
      model: node.agent.model,
    })),
  }
  const entry = (id: string) => log.nodes.find((node) => node.id === id)!

  function patch(id: string, next: NodePatch) {
    Object.assign(entry(id), next)
    hooks.onNode(id, next)
    hooks.onRun?.(log)
  }

  // Live status from the event bus. Best-effort: execution never depends on it.
  const bus = api
    .subscribe((event) => {
      const sessionID = event.data?.sessionID
      if (!sessionID) return
      const id = sessions.get(sessionID)
      if (!id) return
      switch (event.type) {
        case "session.next.step.started":
          return patch(id, { status: "running", activity: "thinking" })
        case "session.next.tool.called":
          return patch(id, { activity: `tool: ${event.data?.tool ?? event.data?.name ?? "?"}` })
        case "session.next.tool.success":
        case "session.next.tool.failed":
          return patch(id, { activity: "thinking" })
        case "session.next.text.started":
        case "session.next.text.delta":
          return patch(id, { activity: "writing" })
        case "session.next.step.failed":
          return patch(id, { activity: "failed" })
        default:
          return
      }
    }, controller.signal)
    .catch(() => undefined)

  async function runNode(node: FlowNode) {
    const sources = upstream(pipeline, node.id)
    if (sources.some((source) => failed.has(source))) {
      failed.add(node.id)
      patch(node.id, { status: "skipped", activity: undefined, error: "upstream failed" })
      return
    }

    patch(node.id, { status: "running", started: Date.now(), activity: "starting session" })
    try {
      const session = await api.createSession({ agent: node.agent.name, model: node.agent.model })
      sessions.set(session.id, node.id)
      active.add(session.id)
      patch(node.id, { sessionID: session.id, activity: "queued" })

      const context =
        pipe === "direct"
          ? sources
          : [...ancestors(pipeline, node.id)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      const text = buildPrompt(node, context, nodes, outputs, input)
      patch(node.id, { prompt: text })

      await api.prompt(session.id, text)
      if (controller.signal.aborted) throw new StopError()
      await api.waitForIdle(session.id, { signal: controller.signal })
      active.delete(session.id)
      if (controller.signal.aborted) throw new StopError()

      const result = await api.transcript(session.id)
      if (result.error) throw new Error(result.error)
      outputs.set(node.id, result.text)
      patch(node.id, { status: "done", output: result.text, activity: undefined, finished: Date.now() })
    } catch (error) {
      failed.add(node.id)
      if (error instanceof StopError || controller.signal.aborted) {
        patch(node.id, { status: "stopped", activity: undefined, finished: Date.now() })
        return
      }
      patch(node.id, {
        status: "error",
        error: api.describe(error),
        activity: undefined,
        finished: Date.now(),
      })
    }
  }

  const done = (async () => {
    try {
      const unresolved = await unknownModels(pipeline)
      if (unresolved.length) {
        for (const node of unresolved) {
          failed.add(node.id)
          patch(node.id, { status: "error", error: `unknown model "${node.agent.model}"`, finished: Date.now() })
        }
        hooks.onNotice?.("error", `unknown model on ${unresolved.map((node) => node.role).join(", ")}`)
        log.status = "error"
        return log
      }

      for (const ids of validation.layers) {
        if (controller.signal.aborted) break
        await Promise.all(ids.map((id) => runNode(nodes.get(id)!)))
      }
      log.status = controller.signal.aborted
        ? "stopped"
        : log.nodes.some((node) => node.status === "error")
          ? "error"
          : "done"
    } catch (error) {
      log.status = "error"
      hooks.onNotice?.("error", api.describe(error))
    } finally {
      for (const node of log.nodes) {
        if (node.status === "queued" || node.status === "running") node.status = "stopped"
      }
      log.finished = Date.now()
      controller.abort()
      void bus
      hooks.onRun?.(log)
      await store.saveRun(log).catch((error) => hooks.onNotice?.("error", `run log not saved: ${api.describe(error)}`))
    }
    return log
  })()

  return {
    log,
    done,
    async stop() {
      controller.abort()
      await Promise.all([...active].map((sessionID) => api.interrupt(sessionID)))
    },
  }
}

class StopError extends Error {
  constructor() {
    super("stopped")
  }
}

/**
 * Nodes pinned to a model the server does not offer. Checked before any
 * dispatch so a typo fails in a second instead of after a wait timeout.
 */
async function unknownModels(pipeline: Pipeline) {
  const pinned = pipeline.nodes.filter((node) => node.agent.model)
  if (!pinned.length) return []
  const available = await api
    .models()
    .then((list) => new Set(list.map((model) => `${model.providerID}/${model.id}`)))
    .catch(() => undefined)
  if (!available) return []
  return pinned.filter((node) => !available.has(node.agent.model!))
}


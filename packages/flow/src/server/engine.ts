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
  /** Only called under the `manual` policy. Resolve with the reply to send. */
  onPermission?: (request: PermissionRequest) => Promise<api.PermissionReply>
}

export type RunOptions = {
  pipe?: PipeMode
  permissions?: PermissionPolicy
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
 * What to do when an agent asks for permission mid-run.
 * - `auto`: approve immediately, for the current call only.
 * - `manual`: hand the request to the UI and wait for a person.
 *
 * There is no third option where nobody answers: an unanswered request stalls
 * the node until the idle wait times out half an hour later.
 */
export type PermissionPolicy = "auto" | "manual"

export type PermissionRequest = {
  requestID: string
  sessionID: string
  nodeID: string
  role: string
  action: string
  resources: string[]
}

/**
 * Executes a pipeline over `opencode serve`.
 *
 * One node = one primary session. Nodes are grouped into topological layers;
 * every node in a layer is dispatched concurrently (`POST /api/session/:id/prompt`
 * only admits the input and schedules the agent loop, so the fan-out is real),
 * then the whole layer is awaited via `POST /api/session/:id/wait` before the
 * next layer starts. Live per-node status comes from the `/api/event` bus.
 */
export function start(pipeline: Pipeline, input: string, hooks: EngineHooks, options: RunOptions = {}): Run {
  const pipe = options.pipe ?? "ancestors"
  const policy = options.permissions ?? "auto"
  const validation = layer(pipeline)
  if (!validation.ok) throw new Error(validation.error)
  const order = new Map(validation.layers.flatMap((ids, index) => ids.map((id) => [id, index] as const)))

  const controller = new AbortController()
  const sessions = new Map<string, string>() // sessionID -> nodeID
  const active = new Set<string>() // sessionIDs still running
  const answered = new Set<string>() // permission requests already replied to
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
        case "permission.v2.asked":
          void answer(id, sessionID, event.data as any)
          return
        default:
          return
      }
    }, controller.signal)
    .catch(() => undefined)

  /**
   * Answers one permission request. Every decision is recorded on the node and
   * in the run log — an approval that leaves no trace is how a run quietly
   * edits things nobody expected.
   */
  async function answer(nodeID: string, sessionID: string, data: { id: string; action: string; resources?: string[] }) {
    const requestID = data.id
    if (answered.has(requestID)) return
    answered.add(requestID)
    const resources = data.resources ?? []
    const node = nodes.get(nodeID)

    let reply: api.PermissionReply = "once"
    if (controller.signal.aborted) {
      reply = "reject"
    } else if (policy === "manual") {
      patch(nodeID, { activity: `awaiting permission: ${data.action}` })
      reply = hooks.onPermission
        ? await hooks.onPermission({
            requestID,
            sessionID,
            nodeID,
            role: node?.role ?? nodeID,
            action: data.action,
            resources,
          }).catch(() => "reject" as const)
        : "reject"
    }

    try {
      await api.replyPermission(sessionID, requestID, reply)
    } catch (error) {
      hooks.onNotice?.("error", `permission reply failed: ${api.describe(error)}`)
      return
    }

    const decision = { requestID, action: data.action, resources, reply, policy, at: Date.now() }
    const record = entry(nodeID)
    record.permissions = [...(record.permissions ?? []), decision]
    patch(nodeID, { activity: `permission ${data.action}: ${reply}` })
  }

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

      const missing = await unknownAgents(pipeline)
      if (missing.length) {
        for (const node of missing) {
          failed.add(node.id)
          patch(node.id, {
            status: "error",
            error: `the server does not know an agent named "${node.agent.name}" — it loads a project's opencode.json once, so restart \`opencode serve\` after merging agents`,
            finished: Date.now(),
          })
        }
        hooks.onNotice?.("error", `unknown agent on ${missing.map((node) => node.role).join(", ")} — restart the server`)
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

/**
 * Nodes pointing at an agent the server has never heard of.
 *
 * The server reads a project's opencode.json once and caches it, so agents
 * merged after it started are invisible until it restarts. Running anyway is
 * the worst failure mode available: the session comes up with an empty
 * permission ruleset and every tool call dies with "Unable to read ...", which
 * reads like a broken model rather than a stale config.
 */
async function unknownAgents(pipeline: Pipeline) {
  const named = pipeline.nodes.filter((node) => node.agent.name)
  if (!named.length) return []
  const available = await api
    .agents()
    .then((list) => new Set(list.map((agent) => agent.id)))
    .catch(() => undefined)
  if (!available) return []
  return named.filter((node) => !available.has(node.agent.name!))
}


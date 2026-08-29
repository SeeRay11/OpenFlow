import { buildPrompt } from "../graph/prompt"
import type {
  Attachment,
  FlowNode,
  NodeEvent,
  NodeStatus,
  Pipeline,
  RunLog,
  RunNodeLog,
  Spend,
  StepUsage,
} from "../graph/types"
import { modeOf } from "../graph/types"
import { ancestors, layer, upstream } from "../graph/validate"
import { applyEvent, createActivity, persistable } from "./activity"
import * as api from "./client"
import { store, type ServeStatus } from "./store"
import { mergeSpend, summarize, type PricedModel } from "./usage"

export type NodePatch = {
  status?: NodeStatus
  sessionID?: string
  output?: string
  error?: string
  prompt?: string
  activity?: string
  started?: number
  finished?: number
  /** Carried over from an earlier run rather than produced by this one. */
  reused?: boolean
  /** Priced usage for this node so far. Replaced, never added to. */
  usage?: Spend
}

export type EngineHooks = {
  onNode: (id: string, patch: NodePatch) => void
  /**
   * One row of a node's thought process — streamed text, a tool call, a
   * subagent's work. Called on every change to a row, keyed by `event.id`, so
   * the receiver upserts rather than appends.
   */
  onNodeEvent?: (id: string, event: NodeEvent) => void
  onRun?: (run: RunLog) => void
  onNotice?: (kind: "info" | "error", text: string) => void
  /** Only called under the `manual` policy. Resolve with the reply to send. */
  onPermission?: (request: PermissionRequest) => Promise<api.PermissionReply>
  /** Resolve with one array of chosen labels per question, or undefined to reject. */
  onQuestion?: (request: QuestionRequest) => Promise<string[][] | undefined>
  /**
   * Called when a run failed because the engine is running older config than
   * what is on disk — the UI opens its restart affordance.
   */
  onEngineStale?: () => void
  /**
   * Called once a question is settled, including when the engine gave up
   * waiting. Without it a timed-out prompt stays on screen forever, still
   * offering buttons that now answer nothing.
   */
  onQuestionClosed?: (requestID: string) => void
}

export type RunOptions = {
  pipe?: PipeMode
  permissions?: PermissionPolicy
  /** Files attached to the run itself, offered to every node. */
  attachments?: Attachment[]
  /**
   * How long a question may sit unanswered before the engine rejects it for
   * the user, in milliseconds. Rejecting lets the agent carry on with its own
   * assumption; leaving it open holds the node until `nodeTimeout` instead,
   * which is how an unattended run quietly burns half an hour.
   */
  questionTimeout?: number
  /**
   * How many nodes may run at once. A layer is dispatched through a pool of
   * this size rather than all at once: eight parallel workers means eight
   * concurrent sessions against one provider, which is how a wide graph earns
   * 429s and an unplanned bill.
   */
  maxParallel?: number
  /**
   * How long one node may sit without its session finishing, in milliseconds.
   * A node that never goes idle otherwise holds the whole run — and every node
   * behind it — for the full wait.
   */
  nodeTimeout?: number
  /**
   * Shortest gap between two mid-run writes of the run log, in milliseconds.
   * Only worth changing in tests — the run log is checkpointed so that a run
   * killed at minute 25 still leaves what it had on disk.
   */
  checkpointEvery?: number
  /**
   * How long to wait before re-reading a model catalog that did not contain a
   * model some node names, in milliseconds. `0` disables the re-read, which is
   * what a test wants when the unknown model is unknown on purpose.
   */
  catalogRetry?: number
  /**
   * Outputs already known from a previous run, keyed by node id. A node listed
   * here is satisfied the moment its layer starts: no session, no prompt, no
   * tokens, no bill. Its text lands in the same `outputs` map a freshly
   * produced one would, so downstream nodes cannot tell the difference.
   *
   * Re-running a node is the caller's decision, not an inference: leave it out
   * of this map and it runs normally, even if a previous run produced it.
   */
  resume?: Record<string, string>
}

export const DEFAULT_MAX_PARALLEL = 4
export const DEFAULT_NODE_TIMEOUT = 30 * 60_000
export const DEFAULT_QUESTION_TIMEOUT = 5 * 60_000
export const DEFAULT_CHECKPOINT_EVERY = 2_000
/** How long to wait before re-reading a model catalog that looked incomplete. */
export const DEFAULT_CATALOG_RETRY = 1_500

export type Run = {
  log: RunLog
  stop: () => Promise<void>
  done: Promise<RunLog>
}

/**
 * Everything the engine reaches outside itself. Defaults to the real server
 * client and the real store; tests pass fakes instead of standing up a server.
 */
export type EngineDeps = {
  api: Pick<
    typeof api,
    | "subscribe"
    | "createSession"
    | "prompt"
    | "waitForIdle"
    | "transcript"
    | "interrupt"
    | "replyPermission"
    | "replyQuestion"
    | "rejectQuestion"
    | "accepts"
    | "models"
    | "agents"
    | "describe"
  > & {
    /**
     * Authoritative per-step usage for a finished session. Optional so a test
     * double can leave it out — the engine then keeps whatever the event bus
     * reported, which is the same data one round-trip earlier.
     */
    sessionSteps?: typeof api.sessionSteps
  }
  saveRun: (log: RunLog) => Promise<unknown>
  /**
   * The engine process this host proxies, used to print the exact restart
   * command in the one error that can only be fixed by restarting it.
   */
  serveStatus?: () => Promise<ServeStatus>
}

const live: EngineDeps = {
  api,
  saveRun: (log) => store.saveRun(log),
  serveStatus: () => store.serverStatus(),
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

export type QuestionRequest = {
  requestID: string
  sessionID: string
  nodeID: string
  role: string
  questions: api.QuestionInfo[]
}

/**
 * Executes a canvas over `opencode serve`.
 *
 * One node = one primary session, whatever the mode. Everything a session needs
 * — creating it, prompting it, waiting it out, draining its transcript, pricing
 * it, streaming its activity — is `runNode` below and is shared. What a mode
 * changes is only the *scheduler*: which nodes run, in what order, and what text
 * their prompts carry. `runPipeline` is this build's only scheduler.
 */
export function start(
  pipeline: Pipeline,
  input: string,
  hooks: EngineHooks,
  options: RunOptions = {},
  deps: EngineDeps = live,
): Run {
  const api = deps.api
  const pipe = options.pipe ?? "ancestors"
  const policy = options.permissions ?? "auto"
  const limit = Math.max(1, Math.floor(options.maxParallel ?? DEFAULT_MAX_PARALLEL))
  const nodeTimeout = Math.max(1_000, options.nodeTimeout ?? DEFAULT_NODE_TIMEOUT)
  const questionTimeout = Math.max(100, options.questionTimeout ?? DEFAULT_QUESTION_TIMEOUT)
  const checkpointEvery = Math.max(1, options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY)
  const catalogRetry = Math.max(0, options.catalogRetry ?? DEFAULT_CATALOG_RETRY)
  const runFiles = options.attachments ?? []
  const resume = options.resume ?? {}
  // Preflight only covers what this run will dispatch: a reused node creates no
  // session, so a model or agent it names having gone missing cannot break it.
  const dispatching = pipeline.nodes.filter((node) => resume[node.id] === undefined)
  // Preflight says the same thing in words the user can act on, but the engine
  // is callable without it, and running a swarm's graph through the pipeline
  // scheduler would spend real money producing an answer nobody designed.
  const mode = modeOf(pipeline)
  if (mode !== "pipeline") throw new Error(`${mode} mode is not runnable in this build yet`)
  const validation = layer(pipeline)
  if (!validation.ok) throw new Error(validation.error)
  const order = new Map(validation.layers.flatMap((ids, index) => ids.map((id) => [id, index] as const)))

  const controller = new AbortController()
  const sessions = new Map<string, string>() // sessionID -> nodeID
  const active = new Set<string>() // sessionIDs still running
  const answered = new Set<string>() // permission requests already replied to
  const asked = new Set<string>() // question requests already handled
  const catalog = new Map<string, Awaited<ReturnType<typeof api.models>>[number]>()
  const nodes = new Map(pipeline.nodes.map((node) => [node.id, node] as const))
  const outputs = new Map<string, string>()
  const failed = new Set<string>()
  /**
   * Usage, keyed by node and then by assistant message so a replayed or
   * duplicated event cannot double-charge. The bus fills this live; the
   * message history overwrites it per node once the session settles.
   */
  const usage = new Map<string, Map<string, StepUsage>>()
  /** Which model a step is running on — only `step.started` carries it. */
  const stepModel = new Map<string, string>()
  /** The live activity stream per node, kept in full until the run is saved. */
  const events = new Map<string, NodeEvent[]>()

  const activity = createActivity({
    owner: (sessionID) => sessions.get(sessionID),
    emit: (nodeID, event) => {
      events.set(nodeID, applyEvent(events.get(nodeID) ?? [], event))
      hooks.onNodeEvent?.(nodeID, event)
    },
  })

  const log: RunLog = {
    id: `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    pipeline: pipeline.name,
    pipelineID: pipeline.id,
    input,
    ...(runFiles.length ? { attachments: runFiles.map((file) => file.name) } : {}),
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

  /**
   * Re-prices one node from its recorded steps, and the run from its nodes.
   *
   * Pricing needs the catalog, which is read once at the top of the run; until
   * it arrives every model prices as unpriced, and this runs again on every
   * step, so the numbers correct themselves rather than sticking.
   */
  function reprice(id: string) {
    const steps = [...(usage.get(id)?.values() ?? [])]
    const spend = summarize(steps, catalog as unknown as Map<string, PricedModel>)
    const record = entry(id)
    record.steps = steps
    patch(id, { usage: spend })
    log.usage = mergeSpend(log.nodes.map((node) => node.usage))
  }

  /**
   * Replaces a node's live usage with what the server persisted.
   *
   * The bus is best-effort — it reconnects, and events published while it was
   * down are gone — so a run that only trusted it could under-report. The
   * message history is the record the server itself keeps, so it wins.
   */
  async function reconcile(id: string, sessionID: string) {
    if (!api.sessionSteps) return
    const steps = await api.sessionSteps(sessionID).catch(() => undefined)
    if (!steps) {
      hooks.onNotice?.("error", `could not read usage for ${entry(id).role} — showing what the event stream saw`)
      return
    }
    usage.set(id, new Map(steps.map((step) => [step.messageID, step])))
    reprice(id)
  }

  function patch(id: string, next: NodePatch) {
    Object.assign(entry(id), next)
    hooks.onNode(id, next)
    hooks.onRun?.(log)
    checkpoint()
  }

  let checkpointTimer: ReturnType<typeof setTimeout> | undefined
  let writes: Promise<unknown> = Promise.resolve()

  /**
   * Writes the run log as it stands.
   *
   * Saving only at the end loses the whole run when the tab is closed or the
   * host is killed mid-run — half an hour of real spend with nothing on disk —
   * so this also runs while the pipeline is going. Writes are chained behind
   * each other so a slow one cannot be overtaken and land stale; the store's
   * own write is atomic, so a half-written file is not a concern here.
   */
  function save() {
    if (checkpointTimer) clearTimeout(checkpointTimer)
    checkpointTimer = undefined
    // The full stream stays in memory for the open page; the log keeps the
    // tail, with bodies clipped, so reopening a run replays what happened
    // without turning the run file into a transcript store.
    for (const node of log.nodes) {
      const stream = events.get(node.id)
      if (stream?.length) node.events = persistable(stream)
    }
    writes = writes.then(() =>
      deps.saveRun(log).catch((error) => hooks.onNotice?.("error", `run log not saved: ${api.describe(error)}`)),
    )
    return writes
  }

  /**
   * Schedules a checkpoint, at most one per `checkpointEvery`. The timer is
   * never pushed back by later updates, so a run that keeps patching still
   * reaches disk on a fixed cadence, and the final `save()` clears whatever is
   * pending — the last state is written either way.
   */
  function checkpoint() {
    if (checkpointTimer) return
    checkpointTimer = setTimeout(save, checkpointEvery)
  }

  // Live status from the event bus. Best-effort: execution never depends on it.
  const bus = api
    .subscribe((event) => {
      // Activity sees every event, including those from subagent sessions this
      // run never created — it is the thing that knows they belong to a node.
      activity.consume(event)
      const sessionID = event.data?.sessionID
      if (!sessionID) return
      const id = sessions.get(sessionID)
      if (!id) return
      switch (event.type) {
        case "session.next.step.started": {
          const messageID = event.data?.assistantMessageID
          const model = event.data?.model
          if (messageID && model) stepModel.set(messageID, `${model.providerID}/${model.id}`)
          return patch(id, { status: "running", activity: "thinking" })
        }
        case "session.next.step.ended": {
          const messageID = event.data?.assistantMessageID
          const tokens = event.data?.tokens
          if (!messageID || !tokens) return
          const steps = usage.get(id) ?? new Map<string, StepUsage>()
          steps.set(messageID, {
            messageID,
            model: stepModel.get(messageID) ?? nodes.get(id)?.agent.model ?? "unknown",
            tokens: {
              input: tokens.input ?? 0,
              output: tokens.output ?? 0,
              reasoning: tokens.reasoning ?? 0,
              cacheRead: tokens.cache?.read ?? 0,
              cacheWrite: tokens.cache?.write ?? 0,
            },
          })
          usage.set(id, steps)
          reprice(id)
          return
        }
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
        case "question.v2.asked":
          void inquire(id, sessionID, event.data as any)
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
    activity.note(
      nodeID,
      `permission:${requestID}`,
      `permission ${data.action}: ${reply}`,
      resources.join("\n") || undefined,
      reply === "reject" ? "error" : "done",
    )
    patch(nodeID, { activity: `permission ${data.action}: ${reply}` })
  }

  /**
   * Hands one question from an agent to the UI and sends back what a person
   * chose.
   *
   * Unlike a permission ask there is no "auto" answer worth inventing — a made
   * up choice is worse than none, because the agent treats it as the user's
   * intent. So an unanswered question is *rejected* rather than guessed, and
   * rejection is bounded by `questionTimeout` so a run left alone still
   * finishes instead of hanging until the node times out.
   */
  async function inquire(
    nodeID: string,
    sessionID: string,
    data: { id: string; questions?: api.QuestionInfo[] },
  ) {
    const requestID = data.id
    if (asked.has(requestID)) return
    asked.add(requestID)
    const questions = data.questions ?? []
    const node = nodes.get(nodeID)
    const headers = questions.map((question) => question.header || question.question)

    let answers: string[][] | undefined
    if (!controller.signal.aborted && hooks.onQuestion) {
      patch(nodeID, { activity: `asking: ${headers[0] ?? "?"}` })
      answers = await Promise.race([
        hooks
          .onQuestion({ requestID, sessionID, nodeID, role: node?.role ?? nodeID, questions })
          .catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), questionTimeout)),
      ])
    }

    hooks.onQuestionClosed?.(requestID)

    try {
      if (answers) await api.replyQuestion(sessionID, requestID, answers)
      else await api.rejectQuestion(sessionID, requestID)
    } catch (error) {
      hooks.onNotice?.("error", `question reply failed: ${api.describe(error)}`)
      return
    }

    const record = entry(nodeID)
    record.questions = [
      ...(record.questions ?? []),
      { requestID, headers, answers, rejected: !answers, at: Date.now() },
    ]
    activity.note(
      nodeID,
      `question:${requestID}`,
      answers ? `answered: ${headers.join(", ")}` : `unanswered: ${headers.join(", ")}`,
      answers?.map((choices, index) => `${headers[index] ?? index}: ${choices.join(", ")}`).join("\n"),
      answers ? "done" : "error",
    )
    patch(nodeID, { activity: answers ? "answered" : "question unanswered" })
  }

  async function runNode(node: FlowNode) {
    const seeded = resume[node.id]
    if (seeded !== undefined) {
      // Already paid for. Checked before the upstream-failure guard because a
      // reused output does not depend on anything this run does.
      outputs.set(node.id, seeded)
      const at = Date.now()
      activity.note(node.id, `reused:${node.id}`, "reused from a previous run", undefined, "done")
      patch(node.id, { status: "done", output: seeded, activity: undefined, started: at, finished: at, reused: true })
      return
    }

    const sources = upstream(pipeline, node.id)
    if (sources.some((source) => failed.has(source))) {
      failed.add(node.id)
      patch(node.id, { status: "skipped", activity: undefined, error: "upstream failed" })
      return
    }

    patch(node.id, { status: "running", started: Date.now(), activity: "starting session" })
    let sessionID: string | undefined
    try {
      const session = await api.createSession({ agent: node.agent.name, model: node.agent.model })
      sessionID = session.id
      sessions.set(session.id, node.id)
      active.add(session.id)
      patch(node.id, { sessionID: session.id, activity: "queued" })

      const context =
        pipe === "direct"
          ? sources
          : [...ancestors(pipeline, node.id)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      // Run-level files first, then the node's own pins. A file the node's
      // model has no modality for is withheld and named in the text instead,
      // so one blind model in the middle of a chain does not stop the run.
      const files = [...runFiles, ...(node.agent.attachments ?? [])]
      const model = node.agent.model ? catalog.get(node.agent.model) : undefined
      const sendable = files.filter((file) => !model || api.accepts(model, file.mime))
      const skipped = files.filter((file) => !sendable.includes(file))
      if (files.length) {
        entry(node.id).attachments = {
          sent: sendable.map((file) => file.name),
          skipped: skipped.map((file) => file.name),
        }
      }

      const text = buildPrompt(pipeline, node, context, outputs, input, skipped)
      patch(node.id, { prompt: text })

      await api.prompt(session.id, text, sendable)
      if (controller.signal.aborted) throw new StopError()
      await api.waitForIdle(session.id, { signal: controller.signal, timeout: nodeTimeout })
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
      const reason = api.describe(error)
      activity.note(node.id, `failed:${node.id}`, "node failed", reason, "error")
      patch(node.id, {
        status: "error",
        error: reason,
        activity: undefined,
        finished: Date.now(),
      })
    } finally {
      // Tokens are spent whether the node finished, failed or was stopped, so
      // the bill is read back in every case rather than only on success.
      if (sessionID) await reconcile(node.id, sessionID)
    }
  }

  const done = (async () => {
    try {
      // One catalog read serves both jobs: rejecting a model the server does
      // not offer, and knowing which attachments each model can actually read.
      const models = await api.models().catch(() => undefined)
      for (const model of models ?? []) catalog.set(`${model.providerID}/${model.id}`, model)

      // A restarted engine answers `/api/health` before its model catalog has
      // finished filling, so a run started in that window sees a partial list
      // and every node reads as naming a model that does not exist — which
      // sends the user to change a model that was right all along. One re-read
      // separates "still loading" from "genuinely not offered"; a complete
      // catalog resolves on the first pass and never reaches this.
      if (models && unknownModels(dispatching, catalog).length && catalogRetry > 0) {
        await new Promise((resolve) => setTimeout(resolve, catalogRetry))
        for (const model of (await api.models().catch(() => [])) ?? [])
          catalog.set(`${model.providerID}/${model.id}`, model)
      }

      const unresolved = models ? unknownModels(dispatching, catalog) : []
      if (unresolved.length) {
        for (const node of unresolved) {
          failed.add(node.id)
          patch(node.id, { status: "error", error: `unknown model "${node.agent.model}"`, finished: Date.now() })
        }
        hooks.onNotice?.("error", `unknown model on ${unresolved.map((node) => node.role).join(", ")}`)
        log.status = "error"
        return log
      }

      const missing = await unknownAgents(dispatching, api)
      if (missing.length) {
        // The fix is always the same — restart the engine — so the message
        // carries the command for *this* host rather than the generic name of
        // a binary that may not be on PATH, or may be a different version than
        // the one this checkout runs.
        const serve = await deps.serveStatus?.().catch(() => undefined)
        const how = serve
          ? serve.managed
            ? `use the restart button in the titlebar, or run: ${serve.command}`
            : `stop \`opencode serve\` where it is running (Ctrl+C in that window), then run this from the OpenFlow repo root:
${serve.command}`
          : "restart `opencode serve` where it is running"
        for (const node of missing) {
          failed.add(node.id)
          patch(node.id, {
            status: "error",
            error: `the server does not know an agent named "${node.agent.name}" — it loads a project's opencode.json once at boot, so a merged agent stays invisible until it restarts. ${how}`,
            finished: Date.now(),
          })
        }
        hooks.onNotice?.(
          "error",
          `unknown agent on ${missing.map((node) => node.role).join(", ")} — the engine needs a restart to see it`,
        )
        hooks.onEngineStale?.()
        log.status = "error"
        return log
      }

      await runPipeline(validation.layers, limit, controller.signal, (id) => runNode(nodes.get(id)!))
      log.status = controller.signal.aborted
        ? "stopped"
        : log.nodes.some((node) => node.status === "error")
          ? "error"
          : "done"
    } catch (error) {
      log.status = "error"
      hooks.onNotice?.("error", api.describe(error))
    } finally {
      for (const node of log.nodes)
        if (node.status === "queued" || node.status === "running") node.status = "stopped"
      log.finished = Date.now()
      log.usage = mergeSpend(log.nodes.map((node) => node.usage))
      controller.abort()
      void bus
      hooks.onRun?.(log)
      await save()
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
 * The `pipeline` mode scheduler: topological layers, one layer at a time.
 *
 * A layer's nodes depend only on layers before it, so the whole layer is
 * dispatched at once through `pool` and awaited before the next one starts.
 * That barrier is the entire ordering guarantee — a node's upstream output
 * exists because its layer already settled.
 */
async function runPipeline(
  layers: string[][],
  limit: number,
  signal: AbortSignal,
  run: (id: string) => Promise<void>,
) {
  for (const ids of layers) {
    if (signal.aborted) return
    await pool(ids, limit, signal, run)
  }
}

/**
 * Runs `work` over `items` with at most `limit` in flight. Nodes in a layer are
 * independent, so order within the layer does not matter — only that the whole
 * layer finishes before the next one starts.
 */
async function pool<T>(items: T[], limit: number, signal: AbortSignal, work: (item: T) => Promise<void>) {
  if (items.length <= limit) {
    await Promise.all(items.map(work))
    return
  }
  const queue = [...items]
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      if (signal.aborted) return
      await work(queue.shift()!)
    }
  })
  await Promise.all(workers)
}

/**
 * Nodes pinned to a model the server does not offer. Checked before any
 * dispatch so a typo fails in a second instead of after a wait timeout.
 */
function unknownModels(nodes: FlowNode[], catalog: Map<string, unknown>) {
  return nodes.filter((node) => node.agent.model && !catalog.has(node.agent.model))
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
async function unknownAgents(nodes: FlowNode[], api: EngineDeps["api"]) {
  const named = nodes.filter((node) => node.agent.name)
  if (!named.length) return []
  const available = await api
    .agents()
    .then((list) => new Set(list.map((agent) => agent.id)))
    .catch(() => undefined)
  if (!available) return []
  return named.filter((node) => !available.has(node.agent.name!))
}


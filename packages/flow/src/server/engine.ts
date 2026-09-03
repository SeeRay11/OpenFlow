import { collisionNote, collisionsIn, writesOf, type Write } from "../graph/collisions"
import { isolates, mergeNote } from "../graph/worktree"
import { fromToolCall, MCP_REACHES_SESSIONS, parseDispatch } from "../graph/dispatch"
import { isCritic, orchestrationShape } from "../graph/orchestration"
import {
  buildPrompt,
  criticPrompt,
  dispatchResultPrompt,
  forceFinalPrompt,
  imageBlindNote,
  interruptedNote,
  judgeFirstPrompt,
  orchestratorPrompt,
  protocolPrompt,
  reassignPrompt,
  subOrchestratorPrompt,
  subagentPrompt,
  swarmPrompt,
  toolFailureNote,
  synthesisPrompt,
} from "../graph/prompt"
import { swarmShape } from "../graph/swarm"
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
import { depthOf, dispatchesOf, GAUNTLET_DISPATCHES, gauntletOf, modeOf, roundsOf } from "../graph/types"
import { ancestors, layer, upstream } from "../graph/validate"
import { applyEvent, createActivity, persistable } from "./activity"
import * as api from "./client"
import { store, type ServeStatus, type WorktreeRef } from "./store"
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
  /** Priced usage for this node so far, across every session it has held. */
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
   * How long to wait before re-sending a turn the provider refused for rate
   * limiting, in milliseconds; each further retry waits twice as long. `0`
   * fails the card on the first 429, which is what a test wants when it is
   * measuring the failure rather than the recovery.
   */
  rateLimitBackoff?: number
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
  /**
   * Sessions a previous run left open, keyed by node id — what a card was in
   * the middle of when the run was interrupted.
   *
   * The engine runs *in the page*, so a reload, a crash or a closed tab ends a
   * run with no way back, while the sessions themselves are still on the server
   * and still addressable. Seeding them here lets a card be prompted into the
   * session it already holds rather than a fresh one, which is the difference
   * between resuming and starting again wearing the old run's name: an
   * orchestrator seven rounds into a gauntlet remembers every verdict it has
   * read, and re-briefing it from scratch throws exactly that away.
   *
   * A node listed here but not in `resume` is a card that was still working:
   * it keeps its session and is told it was interrupted. A node in both is
   * already finished and never runs, so its session is not reopened.
   */
  sessions?: Record<string, string>
  /**
   * Whether to look for the orchestrator's decision in a tool call before
   * falling back to the fenced block.
   *
   * Defaults to `MCP_REACHES_SESSIONS`, which is `false`: the v2 session runner
   * this fork drives has no MCP bridge, so the scan can only ever come back
   * empty. Tests set it to exercise the channel, and it becomes the default the
   * day upstream wires MCP into v2.
   */
  toolChannel?: boolean
}

export const DEFAULT_MAX_PARALLEL = 4

/**
 * Tool actions that change the work rather than read it.
 *
 * Listed here rather than read off the agent's own `permission` block, because
 * that block is advisory once `auto` is answering: the reply this engine sends
 * is what actually decides, and it says "once" to everything.
 *
 * **`bash` is deliberately not here**, though it can obviously write. It is
 * also the only way either of these cards can look at anything — an
 * orchestrator listing the folder, a critic running `node --check` to prove
 * the thing parses, which is exactly what a bar asks of it. Measured: with
 * `bash` refused, an orchestrator spent both its turns being told it could not
 * run `dir` and produced no control block at all, and the run died on the
 * protocol. A card that edits through a shell command is a smaller problem
 * than a critic that cannot run anything.
 */
const MUTATING = new Set(["edit", "write", "patch"])

/**
 * How many times a card may be re-asked for a control block before its run
 * fails. Protocol re-asks are not charged to the dispatch budget: they buy
 * nothing, and the alternative to asking again is throwing away the run.
 */
const PROTOCOL_RETRIES = 3

/**
 * How many times a turn refused for rate limiting is re-sent, and how long the
 * first wait is — each retry waits twice as long as the one before it.
 *
 * A 429 says "not now", and everywhere else in the engine that reads as "this
 * card is finished". It costs a gauntlet more than anything else: a critic is
 * given a session it has never used before on every single verdict, which is
 * the traffic shape a per-model limit punishes, and it is the one card whose
 * absence the run cannot route around — no verdict, no legal way to stop.
 * Measured on the 2026-09-01 run: two 429s in sixteen minutes ended it.
 */
const RATE_LIMIT_RETRIES = 3
export const DEFAULT_RATE_LIMIT_BACKOFF = 20_000
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
    /**
     * Tool calls a session made, newest first — how an orchestrator's dispatch
     * is read. Optional for the same reason as `sessionSteps`: a test double
     * may leave it out, and a host without the MCP server installed has no tool
     * calls to read anyway. Absent means the text fallback decides.
     */
    sessionCalls?: typeof api.sessionCalls
  }
  saveRun: (log: RunLog) => Promise<unknown>
  /**
   * Per-card git worktrees, so an orchestration batch cannot overwrite itself.
   * Optional: a host without it, or a project that is not a repository, runs
   * every card in the one shared tree exactly as before.
   */
  worktrees?: {
    open: typeof store.openWorktrees
    merge: typeof store.mergeWorktrees
    cleanup: typeof store.cleanupWorktrees
  }
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
  worktrees: { open: store.openWorktrees, merge: store.mergeWorktrees, cleanup: store.cleanupWorktrees },
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
 * their prompts carry — `runPipeline` over topological layers, `runSwarm` over
 * rounds of peers, `orchestrate` down a tree of dispatches.
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
  const rateLimitBackoff = Math.max(0, options.rateLimitBackoff ?? DEFAULT_RATE_LIMIT_BACKOFF)
  const runFiles = options.attachments ?? []
  const resume = options.resume ?? {}
  const toolChannel = options.toolChannel ?? MCP_REACHES_SESSIONS
  // Preflight only covers what this run will dispatch: a reused node creates no
  // session, so a model or agent it names having gone missing cannot break it.
  const dispatching = pipeline.nodes.filter((node) => resume[node.id] === undefined)
  // Preflight says the same thing in words the user can act on, but the engine
  // is callable without it, and running a swarm's graph through the pipeline
  // scheduler would spend real money producing an answer nobody designed.
  const mode = modeOf(pipeline)
  const swarm = mode === "swarm" ? swarmShape(pipeline) : undefined
  if (swarm && !swarm.synthesizers.length) throw new Error("a swarm has no synthesizer card to write its verdict")
  const tree = mode === "orchestration" ? orchestrationShape(pipeline) : undefined
  if (tree) {
    if (tree.roots.length !== 1)
      throw new Error(`an orchestration runs from exactly one card with no incoming connection, and this graph has ${tree.roots.length}`)
    if (tree.shared.length) throw new Error("a card is dispatched by more than one orchestrator")
    if (tree.depth > depthOf(pipeline))
      throw new Error(`the subagent tree is ${tree.depth} level(s) deep and the limit is ${depthOf(pipeline)}`)
  }
  // A gauntlet trades the dispatch budget for money-and-time bounds, so a
  // canvas with nothing to judge the work would loop builders against nobody
  // until one of those caps fired. Preflight says the same in the UI.
  const gauntlet = tree ? gauntletOf(pipeline) : undefined
  if (gauntlet && !pipeline.nodes.some((node) => isCritic(node) && !tree!.children(node.id).length))
    throw new Error("a gauntlet has no reviewer card to judge the work against its bar")
  // Swarm reads no edges at all, so a leftover cycle from a graph that used to
  // be a pipeline is not a reason to refuse it. Orchestration does read them,
  // and `layer` is still what rejects a cycle before the recursion meets one.
  const validation = swarm ? { ok: true as const, layers: [] as string[][] } : layer(pipeline)
  if (!validation.ok) throw new Error(validation.error)
  const order = new Map(validation.layers.flatMap((ids, index) => ids.map((id) => [id, index] as const)))

  const controller = new AbortController()
  const sessions = new Map<string, string>() // sessionID -> nodeID
  /** nodeID -> the session it opened, so a later turn can prompt into it again. */
  const nodeSession = new Map<string, string>()
  /**
   * nodeID -> the git worktree its session runs in, when the batch was isolated.
   *
   * Read at session creation only. A card keeps its tree for the whole run
   * because the session's location cannot be changed afterwards, and a
   * re-dispatched card is deliberately prompted into the session it holds.
   */
  const nodeDir = new Map<string, string>()
  /** Every tree opened this run, so the run can take them all down at the end. */
  const opened = new Map<string, WorktreeRef>()
  /** Said once per run — see the note where it is set. */
  let isolationWarned = false
  /** The commit every tree was branched from, and every merge is measured against. */
  let isolationBase = ""
  /**
   * Cards carrying a session from the interrupted run this one continues.
   *
   * Seeded before anything dispatches so the first turn prompts into the open
   * session instead of creating one. A card that already finished keeps its
   * output through `resume` and never runs, so reopening its session would only
   * buy a bill; those are dropped here.
   */
  const carried = new Set<string>()
  for (const [id, sessionID] of Object.entries(options.sessions ?? {})) {
    if (resume[id] !== undefined || !sessionID) continue
    nodeSession.set(id, sessionID)
    sessions.set(sessionID, id)
    carried.add(id)
  }
  /** Tool-call ids already read, so an old call cannot decide a new turn. */
  const consumed = new Map<string, Set<string>>()
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
   * Folds what the server persisted for one session into a node's live usage.
   *
   * The bus is best-effort — it reconnects, and events published while it was
   * down are gone — so a run that only trusted it could under-report. The
   * message history is the record the server itself keeps, so it wins, and a
   * step already seen on the bus is overwritten by the server's copy of it.
   *
   * Merged rather than replaced, because a card can hold more than one session
   * across a run: a gauntlet drops a critic's session before every verdict, and
   * an orchestrator re-dispatches the same builder round after round. Measured
   * on the 2026-09-01 run — the critic's own cost fell from $0.0204 to $0.0023
   * across a re-dispatch and the run total fell with it, so `maxSpend` was being
   * compared against a number well below what had actually been spent. Steps are
   * keyed by message id, which is unique per session, so folding sessions
   * together adds them up without ever double-counting one.
   */
  async function reconcile(id: string, sessionID: string) {
    if (!api.sessionSteps) return
    const steps = await api.sessionSteps(sessionID).catch(() => undefined)
    if (!steps) {
      hooks.onNotice?.("error", `could not read usage for ${entry(id).role} — showing what the event stream saw`)
      return
    }
    const spent = usage.get(id) ?? new Map<string, StepUsage>()
    for (const step of steps) spent.set(step.messageID, step)
    usage.set(id, spent)
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
    } else if (gauntlet && node && (isCritic(node) || node.id === tree?.root?.id) && MUTATING.has(data.action)) {
      // In a gauntlet these two cards judge and assign; neither may change the
      // work. `auto` answers "once" to everything, so a card configured with
      // `edit: deny` is still granted the tool when it asks — measured, and it
      // is how an orchestrator ends up fixing the bug itself and then grading
      // its own repair. The rule belongs here, where the answer is given.
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

  /**
   * One turn of one card: open or reuse its session, prompt it, wait it out,
   * drain the transcript into `outputs`.
   *
   * `build` is handed the attachments this card's model cannot read and returns
   * the prompt; what goes in it is the mode's business, not this function's.
   * `reuse` keeps the session the card opened on an earlier turn — a swarm agent
   * revising in round 3 is the same session it answered round 1 in, so it
   * remembers its own reasoning and the provider can cache the prefix.
   *
   * Files ride the first turn only. A reused session already holds them, and
   * re-sending a 4MB screenshot once per round is the same picture at four times
   * the price.
   */
  async function runTurn(node: FlowNode, build: (skipped: Attachment[]) => string, reuse = false) {
    // A card carried over from an interrupted run is prompted into the session
    // it was already working in, whichever scheduler is asking. Consumed on the
    // first turn: from the second one on it is an ordinary reused session, and
    // the card should not be told it was interrupted twice.
    const carrying = carried.delete(node.id)
    if (carrying) {
      const opening = build
      build = (skipped) => `${interruptedNote()}\n\n${opening(skipped)}`
    }
    let sessionID = reuse || carrying ? nodeSession.get(node.id) : undefined
    // The log has to name the session a carried card is in. Nothing else writes
    // it — the create path is skipped — so without this the run reports a card
    // with no session while it is answering in one, and the next interruption
    // has nothing left to carry forward.
    if (carrying && sessionID) patch(node.id, { sessionID })
    // Whether this card's files have already reached the session. A reused one
    // holds them; a retry after a refused prompt does not, so the attachments
    // ride the re-send rather than being lost with the turn that never landed.
    let delivered = !!sessionID
    for (let attempt = 0; ; attempt++) {
      const opened = sessionID
      // Only this turn's tool failures count; a card is prompted into the session
      // it already holds, so every earlier turn's are still on the stream.
      const turnStarted = Date.now()
      patch(node.id, {
        status: "running",
        ...(opened ? {} : { started: Date.now() }),
        activity: opened ? "continuing session" : "starting session",
      })
      try {
        if (!sessionID) {
          const session = await api.createSession({
            agent: node.agent.name,
            model: node.agent.model,
            // Fixed for the life of the session, which is why a card keeps the
            // tree it was first given rather than moving between batches.
            directory: nodeDir.get(node.id),
          })
          sessionID = session.id
          nodeSession.set(node.id, session.id)
          sessions.set(session.id, node.id)
          patch(node.id, { sessionID: session.id })
        }
        active.add(sessionID)
        patch(node.id, { activity: "queued" })

        // Run-level files first, then the node's own pins. A file the node's
        // model has no modality for is withheld and named in the text instead,
        // so one blind model in the middle of a chain does not stop the run.
        const files = delivered ? [] : [...runFiles, ...(node.agent.attachments ?? [])]
        const model = node.agent.model ? catalog.get(node.agent.model) : undefined
        const sendable = files.filter((file) => !model || api.accepts(model, file.mime))
        const skipped = files.filter((file) => !sendable.includes(file))
        if (files.length) {
          entry(node.id).attachments = {
            sent: sendable.map((file) => file.name),
            skipped: skipped.map((file) => file.name),
          }
        }

      // A card can reach an image without anyone attaching one: it takes a
      // screenshot, then opens it. `read` on a PNG comes back as an image part,
      // and a model with no image modality answers the whole request with
      // `HTTP 404: No endpoints found that support image input` — which fails
      // the card, not the tool call. Measured on this fork's first gauntlet: a
      // card captured the game, the orchestrator opened the capture, and the run
      // died. The attachment filter above never sees this path, so the card is
      // told what it cannot do instead.
        const text = `${build(skipped)}${model && !api.accepts(model, "image/png") ? `\n\n${imageBlindNote()}` : ""}`
        patch(node.id, { prompt: text })

        await api.prompt(sessionID, text, sendable)
        delivered = true
        if (controller.signal.aborted) throw new StopError()
        await api.waitForIdle(sessionID, { signal: controller.signal, timeout: nodeTimeout })
        active.delete(sessionID)
        if (controller.signal.aborted) throw new StopError()

        const result = await api.transcript(sessionID)
        if (result.error) throw new Error(result.error)
      // A card whose tools were rejected still ends its turn cleanly: the
      // assistant message carries no error, so the node settles `done` and the
      // orchestrator is told the work is finished. Measured: a card burned
      // 1.36M tokens with every `write` bounced as "Invalid JSON input for
      // openai-chat tool call write", reported success, and was re-dispatched on
      // a false premise. The failures are already on the activity stream; this
      // is what makes the control loop see them.
        const rejected = (events.get(node.id) ?? []).filter(
          (event) => event.kind === "tool" && event.status === "error" && event.at >= turnStarted,
        )
        const answer = rejected.length ? `${result.text}\n\n${toolFailureNote(rejected)}` : result.text
        if (rejected.length) {
          entry(node.id).toolFailures = rejected.length
          activity.note(
            node.id,
            `tools:${node.id}:${turnStarted}`,
            `${rejected.length} tool call(s) rejected`,
            rejected.map((event) => `${event.title}: ${event.body ?? "failed"}`).join("\n"),
            "error",
          )
        }
        outputs.set(node.id, answer)
        patch(node.id, { status: "done", output: answer, activity: undefined, finished: Date.now() })
      } catch (error) {
        if (error instanceof StopError || controller.signal.aborted) {
          failed.add(node.id)
          patch(node.id, { status: "stopped", activity: undefined, finished: Date.now() })
          return
        }
        const reason = api.describe(error)
        // "Not now" is not "this card is finished". The provider refused the
        // turn before it produced anything, so the same prompt goes back into
        // the same session after a wait rather than costing the run a card.
        if (rateLimited(reason) && attempt < RATE_LIMIT_RETRIES && rateLimitBackoff > 0) {
          const wait = rateLimitBackoff * 2 ** attempt
          activity.note(
            node.id,
            `ratelimit:${node.id}:${turnStarted}`,
            `rate limited — retrying in ${Math.round(wait / 1000)}s (${attempt + 1} of ${RATE_LIMIT_RETRIES})`,
            reason,
            "done",
          )
          patch(node.id, { activity: `rate limited — retrying in ${Math.round(wait / 1000)}s` })
          if (sessionID) active.delete(sessionID)
          await new Promise((resolve) => setTimeout(resolve, wait))
          if (controller.signal.aborted) {
            failed.add(node.id)
            patch(node.id, { status: "stopped", activity: undefined, finished: Date.now() })
            return
          }
          continue
        }
        failed.add(node.id)
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
      return
    }
  }

  /**
   * Whether a provider refused a turn for rate limiting rather than for
   * anything about the turn itself.
   *
   * Matched on the text because that is all the runner hands back — the status
   * line it composes (`Provider request failed with HTTP 429`) and the phrase
   * providers put in the body when they answer 200 with a refusal.
   */
  function rateLimited(reason: string) {
    return /\b429\b|rate.?limit|too many requests/i.test(reason)
  }

  /** A card's one turn in `pipeline` mode, after its layer's predecessors settled. */
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

    const context =
      pipe === "direct"
        ? sources
        : [...ancestors(pipeline, node.id)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    await runTurn(node, (skipped) => buildPrompt(pipeline, node, context, outputs, input, skipped))
  }

  /**
   * One agent's turn in round `round`, and one round's worth of bookkeeping.
   *
   * An agent that failed an earlier round is left out rather than retried: its
   * session is gone, and re-opening one mid-swarm would answer round 3 with no
   * memory of rounds 1 and 2 while every peer around it has both.
   */
  async function runPeer(node: FlowNode, round: number, peers: Map<string, string>) {
    if (failed.has(node.id)) return
    activity.note(node.id, `round:${node.id}:${round}`, `round ${round} of ${roundsOf(pipeline)}`, undefined, "done")
    await runTurn(node, (skipped) => swarmPrompt(pipeline, node, round, peers, input, skipped), round > 1)
  }

  /**
   * One orchestrator's whole dispatch loop, and every subtree under it.
   *
   * Runs until the card sends `final`, or until its dispatch budget is spent and
   * one last turn is used to make it answer from what it has. A card with
   * children of its own recurses through this same function one level down —
   * that is what "subagents can deploy subagents" is, and it is bounded by the
   * tree the user drew rather than by anything a model decides.
   *
   * Returns the answer, or undefined when the card failed or the run stopped.
   */
  async function orchestrate(node: FlowNode, task: string, first: boolean): Promise<string | undefined> {
    const children = tree!.children(node.id)
    const budget = gauntlet ? GAUNTLET_DISPATCHES : dispatchesOf(pipeline)
    // A card dispatched a second time is prompted into the session it already
    // holds, so it still has its briefing and its earlier task — only the job
    // is new.
    const returning = nodeSession.has(node.id)
    let build = (skipped: Attachment[]) =>
      returning
        ? reassignPrompt(task)
        : first
          ? orchestratorPrompt(pipeline, node, input, skipped)
          : // Only a card with children reaches here; a leaf goes through
            // `runSubagent`. So this is always somebody's subagent that must
            // itself speak the protocol.
            subOrchestratorPrompt(pipeline, node, parentOf(node.id)!, task, input, skipped)
    let spent = 0
    /**
     * Re-asks used on the protocol, not on the work.
     *
     * This was one, on the theory that a model which cannot produce the block
     * twice will not produce it on the third ask. Measured against real runs,
     * that theory cost more than it saved: three separate orchestration runs
     * died here, and in one of them the card was a single stray character away
     * from a correct dispatch it had spent twelve minutes reasoning towards.
     * Killing an hours-long run over two bad turns is the expensive outcome, so
     * the ask is repeated — and made terser each time, because the failure is
     * usually that the card is writing an essay instead of a block.
     */
    let retries = 0
    /** The last batch this card dispatched, and how many times in a row. */
    let repeated = ""
    let repeats = 0
    /** Why the previous turn was told to answer, if it was. */
    let forced: { reason: string; error: string } | undefined
    /** Whether the previous turn's `final` was already sent back for a verdict. */
    let refused = false
    /** Critic children of this card, and which of them have judged since the last build. */
    const judges = children.filter((id) => isCritic(nodes.get(id)!))
    const judged = new Set<string>()
    /** Critics this card sent that came back with nothing, and why the last one did. */
    let criticsLost = 0
    let criticLoss = ""
    /**
     * Whether this card may answer yet.
     *
     * Only a card that actually has critics is held to this — a subtree
     * orchestrator whose children are all builders has nobody to ask, and
     * blocking it would deadlock the level above.
     */
    const unjudged = () => !!gauntlet && judges.length > 0 && judged.size === 0

    while (true) {
      // Always `reuse`: `runTurn` opens a session when the card has none, so
      // this is "keep the one you have" rather than "there must be one".
      await runTurn(node, build, true)
      if (failed.has(node.id) || controller.signal.aborted) return undefined

      const decision = await decide(node, children)

      if (decision.kind === "error") {
        if (retries >= PROTOCOL_RETRIES) {
          failed.add(node.id)
          const reason = `the orchestrator never produced a usable control block — ${decision.reason}`
          activity.note(node.id, `protocol:${node.id}`, "unusable control block", decision.reason, "error")
          patch(node.id, { status: "error", error: reason, activity: undefined, finished: Date.now() })
          return undefined
        }
        retries++
        activity.note(
          node.id,
          `protocol:retry:${node.id}:${retries}`,
          `re-asked for a control block (${retries} of ${PROTOCOL_RETRIES})`,
          decision.reason,
          "done",
        )
        build = () => protocolPrompt(pipeline, node, decision.reason, retries, children)
        continue
      }

      // A retry is spent on the malformed turn, not on the run's budget.
      retries = 0
      if (decision.kind === "final") {
        // A gauntlet ends when the work clears the bar, and the card that
        // decides that is never the card that assigned the work. Measured: an
        // orchestrator handed a broken build repaired it itself and then wrote
        // a `final` certifying its own repair against every line of the bar,
        // three minutes in, having dispatched nobody. So the answer is refused
        // until a critic has judged the state the builders left — once each
        // time, because a card that is asked twice and still will not have the
        // work judged has stopped running a gauntlet.
        if (unjudged() && !refused) {
          refused = true
          activity.note(node.id, `unjudged:${node.id}:${spent}`, "answered without a verdict", undefined, "done")
          build = () => judgeFirstPrompt(pipeline, node)
          continue
        }
        // Asked twice and still no verdict. The old rule accepted the second
        // answer — stop burning turns on a card that will not send the work to
        // a critic. Measured 2026-09-01, that rule certified a build nobody
        // qualified had judged: with the critic failing every dispatch, the
        // orchestrator nominated a *builder* as the independent inspector and
        // wrote a PASS on all seven bar lines, which the engine took. `judged`
        // was right to ignore that opinion; the refusal policy then let the
        // answer through anyway.
        //
        // Both endings stop the burn; only one of them tells the truth about
        // what the run produced. An unjudged pass is the single output a
        // gauntlet must never write, so the card fails instead — and the reason
        // separates a card that *would not* have the work judged from a run
        // whose critics could not be reached, because those are different
        // problems for whoever reads the log.
        if (unjudged()) {
          failed.add(node.id)
          const reason = criticsLost
            ? `the bar was never judged — every critic dispatched failed (${criticLoss})`
            : "the bar was never judged — the card answered twice without sending the work to a critic"
          activity.note(node.id, `unjudged:${node.id}:final`, "answered with no verdict on the work", reason, "error")
          patch(node.id, { status: "error", error: reason, activity: undefined, finished: Date.now() })
          return undefined
        }
        outputs.set(node.id, decision.answer)
        patch(node.id, { output: decision.answer })
        return decision.answer
      }
      refused = false

      // The previous turn was the forced one — it was told to answer and
      // dispatched anyway. Without this the loop never ends, and a model that
      // ignores the bound once will ignore it every time.
      if (forced) {
        failed.add(node.id)
        const reason = `the orchestrator kept dispatching after it was told to answer — ${forced.error}`
        activity.note(node.id, `budget:${node.id}`, "dispatched past its budget", reason, "error")
        patch(node.id, { status: "error", error: reason, activity: undefined, finished: Date.now() })
        return undefined
      }

      // A gauntlet is stopped by no progress as well as by money and time, and
      // the same batch handed out again is what no progress looks like from
      // out here: the same cards, the same words, one more round of paying for
      // them.
      const batch = JSON.stringify(
        [...decision.assignments].sort((a, b) => a.card.localeCompare(b.card)).map((entry) => [entry.card, entry.task]),
      )
      repeats = batch === repeated ? repeats + 1 : 0
      repeated = batch

      spent++
      activity.note(
        node.id,
        `dispatch:${node.id}:${spent}`,
        `dispatch ${spent} of ${budget} — ${decision.assignments.map((entry) => entry.card).join(", ")}`,
        decision.assignments.map((entry) => `${entry.card}: ${entry.task}`).join("\n\n"),
        "done",
      )

      const results: { card: string; text?: string; error?: string }[] = []
      /** Set when folding the batch's work back in left something unapplied. */
      let mergeNotice = ""
      const batchStarted = Date.now()
      // Critics judge by running the work — the build, the tests, the dev
      // server — in the one working directory this fork has. Two of them at
      // once race the same `dist/`, the same port, the same `node_modules`,
      // and each grades the other's half-built output. A critics-only batch is
      // the only batch that judges anything (see `judged` below), so it is the
      // one that has to see a tree holding still: one critic at a time. It
      // costs wall clock, which a gauntlet already bounds.
      const oneAtATime =
        !!gauntlet && decision.assignments.length > 1 && decision.assignments.every((entry) => isCritic(nodes.get(entry.card)!))

      // A working copy per card, so the batch cannot overwrite itself. Only
      // cards that can write get one — a reader isolated from the project would
      // read a copy of it for no benefit — and only cards that do not already
      // hold a session, because a session's location is fixed once it exists.
      if (deps.worktrees && decision.assignments.length > 1) {
        // A card that already holds a session keeps the tree that session was
        // created in — the location cannot be changed afterwards — so only the
        // cards without one are opened here. They still merge below: a card's
        // second batch of work is as easy to lose as its first.
        const wanted = decision.assignments
          .map((entry) => entry.card)
          .filter((card) => isolates(nodes.get(card)!) && !nodeSession.has(card))
        if (wanted.length > 1) {
          const result = await deps.worktrees.open(log.id, wanted).catch(() => undefined)
          if (result?.enabled) {
            isolationBase = result.base
            for (const tree of result.trees) {
              nodeDir.set(tree.card, tree.directory)
              opened.set(tree.card, tree)
            }
          } else if (result && !isolationWarned) {
            // Said once per run: an orchestration in a folder that is not a
            // repository is a normal way to work, and repeating it every batch
            // would bury the batch's real findings.
            isolationWarned = true
            activity.note(node.id, `isolation:${log.id}`, `cards share one working directory — ${result.reason}`, undefined, "done")
          }
        }
      }
      await pool(decision.assignments, oneAtATime ? 1 : limit, controller.signal, async (assignment) => {
        const child = nodes.get(assignment.card)!
        // A critic judges from a session it has never used before. Reusing one
        // would let it read its own earlier verdicts, and a critic that has
        // watched the work improve grades the improvement rather than the
        // work — which is the failure the separate critic exists to prevent.
        // It costs the cached prefix and re-sends the reference files, and
        // that is the price of the method.
        if (gauntlet && isCritic(child)) {
          nodeSession.delete(child.id)
          consumed.delete(child.id)
        }
        const answer = tree!.children(child.id).length
          ? await orchestrate(child, assignment.task, false)
          : await runSubagent(child, node, assignment.task)
        results.push(
          answer === undefined
            ? { card: assignment.card, error: entry(assignment.card).error ?? "the card produced nothing" }
            : { card: assignment.card, text: answer },
        )
      })
      if (controller.signal.aborted) return undefined

      // Fold the isolated cards' work back into the project. A path that will
      // not apply over what is already there is left alone and named, so the
      // conflicting version is discarded rather than layered on top of the
      // card that merged first — and the orchestrator is told, because a card
      // re-dispatched with the same task would conflict the same way.
      // Every dispatched card that has a tree, not only the ones opened for this
      // batch: a card re-dispatched into the session it already holds keeps its
      // original tree, and its later work has to come back out of it too.
      const isolated = decision.assignments
        .map((entry) => opened.get(entry.card))
        .filter((tree): tree is WorktreeRef => !!tree)
      if (isolated.length) {
        const report = await deps
          .worktrees!.merge(isolationBase, isolated)
          .catch(() => ({ merged: [], empty: [], conflicts: [] }))
        const note = mergeNote(report)
        if (note)
          activity.note(
            node.id,
            `merge:${node.id}:${spent}`,
            `${report.conflicts.length} card(s) conflicted on merge`,
            report.conflicts.map((conflict) => `${conflict.card}: ${conflict.paths.join(", ")}`).join("\n"),
            "error",
          )
        mergeNotice = note
      }

      // What this batch did to the standing verdict. A batch that built
      // anything invalidates it — including a critic dispatched alongside a
      // builder, which judged a folder the builder was writing to at the same
      // time. Only a batch that is critics alone judges a state that holds
      // still long enough to be judged.
      if (gauntlet) {
        // A critic that changed the work has judged its own repair. The write
        // tools are already refused to it (`answer` above), so what reaches here
        // is a shell line — `sed -i`, an install, a `git checkout` — read by
        // `writesOf` as far as a shell line can be read. The verdict is
        // discarded rather than the call refused: refusing bash outright was
        // measured to break the critic's own verification, and a verdict that
        // came back over a changed tree is worth nothing whichever way the
        // change went.
        for (const [index, result] of results.entries()) {
          const child = nodes.get(result.card)!
          if (!isCritic(child) || result.text === undefined) continue
          const wrote = [child.id, ...descendants(child.id)].flatMap((id) => writesOf(events.get(id) ?? [], batchStarted))
          if (!wrote.length) continue
          const listed = wrote.map((write) => (write.probable ? `${write.path} (probable)` : write.path)).join(", ")
          const error = `its verdict is discarded: a critic may not change the work it judges, and it wrote ${listed}`
          activity.note(child.id, `critic-wrote:${child.id}:${spent}`, "verdict discarded — the critic changed the work", listed, "error")
          patch(child.id, { status: "error", error })
          results[index] = { card: result.card, error }
        }
        for (const result of results) {
          if (result.text !== undefined || !isCritic(nodes.get(result.card)!)) continue
          criticsLost++
          criticLoss = `${result.card}: ${result.error}`
        }
        if (decision.assignments.some((entry) => !isCritic(nodes.get(entry.card)!))) judged.clear()
        else
          for (const result of results) if (result.text !== undefined) judged.add(result.card)
      }

      // `results` lands in pool completion order; the orchestrator asked in a
      // particular order and reads more easily in it.
      results.sort(
        (a, b) =>
          decision.assignments.findIndex((entry) => entry.card === a.card) -
          decision.assignments.findIndex((entry) => entry.card === b.card),
      )
      // Two cards in one batch writing one file. Nothing in this fork locks a
      // file and the pool ran them at once, so the later write wins silently:
      // the card whose work went under still reports success, and the
      // orchestrator would build its next round on an answer describing a file
      // that no longer says that. The engine cannot know which write was the
      // one worth keeping, so it reports rather than reverts — but it reports
      // before the orchestrator decides anything, which is the only moment the
      // finding is still worth acting on.
      const wrote = new Map<string, Write[]>()
      for (const assignment of decision.assignments) {
        const paths = [assignment.card, ...descendants(assignment.card)].flatMap((id) =>
          writesOf(events.get(id) ?? [], batchStarted),
        )
        if (paths.length) wrote.set(assignment.card, paths)
      }
      const collisions = collisionsIn(wrote)
      // A shell-capable card's writes are read as far as a shell line can be
      // read — redirects, `sed -i`, installs, git — and marked probable. What a
      // build script or a program wrote is not seen at all, so on those cards
      // the list is a floor rather than the whole truth, and saying so is the
      // difference between a finding the orchestrator can trust and one it
      // over-trusts.
      const collided = collisionNote(
        collisions,
        collisions
          .flatMap((collision) => collision.cards)
          .some((card) => {
            const tools = nodes.get(card)?.agent.tools
            return !tools || tools.bash === true
          }),
      )
      if (collided)
        activity.note(
          node.id,
          `collision:${node.id}:${spent}`,
          `${collisions.length} file(s) written by more than one card`,
          collisions
            .map(
              (collision) =>
                `${collision.path}: ${collision.cards
                  .map((card) => (collision.probable.includes(card) ? `${card} (probable)` : card))
                  .join(", ")}`,
            )
            .join("\n"),
          "error",
        )

      const stop = exhausted(spent, repeats)
      forced = stop
      if (stop) activity.note(node.id, `bound:${node.id}:${spent}`, "told to answer", stop.error, "done")
      const status = gauntlet ? spentSoFar() : undefined
      build = () =>
        [
          dispatchResultPrompt(pipeline, results, stop ? 0 : budget - spent, status),
          // Before the collision note: a conflict is work that is definitely
          // not on disk, while a collision is work that may have been
          // overwritten. The certain finding leads.
          ...(mergeNotice ? [mergeNotice] : []),
          ...(collided ? [collided] : []),
          ...(stop ? [forceFinalPrompt(stop.reason)] : []),
        ].join("\n\n")
    }
  }

  /**
   * Every card under this one, however deep.
   *
   * A dispatched card that is itself an orchestrator does its writing through
   * the subtree below it, so attributing those writes to the leaf that held the
   * pen would name a card this orchestrator cannot dispatch. The territory
   * belongs to the card it handed the work to.
   *
   * Guarded because the engine is callable without preflight: a graph with a
   * cycle in it is refused before a run normally starts, but a walk that
   * assumed the tree was a tree would hang the run rather than report anything.
   */
  function descendants(id: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return []
    seen.add(id)
    return (tree?.children(id) ?? []).flatMap((child) => [child, ...descendants(child, seen)])
  }

  /**
   * Why this orchestrator has to answer now, or undefined to keep going.
   *
   * Outside a gauntlet there is one bound and it is a count. Inside one there
   * are four, and they are checked in the order a user would want to hear
   * about them: an unenforceable cap first, because a spend limit nobody can
   * measure is the one failure that would otherwise run for hours before
   * anyone noticed.
   */
  function exhausted(spent: number, repeats: number) {
    if (!gauntlet)
      return spent >= dispatchesOf(pipeline)
        ? {
            reason: "Your dispatch budget is spent.",
            error: `its ${dispatchesOf(pipeline)} dispatch(es) were spent`,
          }
        : undefined

    // The cap the user set is the only thing bounding an hours-long run, and
    // this build prices client-side from the model catalog: a model the
    // catalog quotes no price for makes the cap unmeasurable, not generous.
    const unpriced = log.usage?.unpriced ?? []
    if (unpriced.length)
      return {
        reason: `This run cannot be priced, so its $${gauntlet.maxSpend} cap cannot be enforced. Answer with what you have.`,
        error: `the run has a $${gauntlet.maxSpend} cap and ${unpriced.join(", ")} is unpriced, so nothing can enforce it`,
      }

    const cost = log.usage?.cost ?? 0
    if (cost >= gauntlet.maxSpend)
      return {
        reason: `This run has spent its $${gauntlet.maxSpend} budget.`,
        error: `the run reached its $${gauntlet.maxSpend} spend cap`,
      }

    const minutes = (Date.now() - log.started) / 60_000
    if (minutes >= gauntlet.maxMinutes)
      return {
        reason: `This run has been going for ${gauntlet.maxMinutes} minutes, which is all the time it has.`,
        error: `the run reached its ${gauntlet.maxMinutes} minute cap`,
      }

    if (repeats >= gauntlet.stall)
      return {
        reason: `You have handed out the same work ${repeats + 1} times in a row, so it is not improving. Answer with what you have.`,
        error: `the same batch was dispatched ${repeats + 1} times in a row with nothing changing`,
      }

    return spent >= GAUNTLET_DISPATCHES
      ? {
          reason: `You have dispatched ${GAUNTLET_DISPATCHES} times, which is the hard ceiling on a gauntlet.`,
          error: `the orchestrator reached the ${GAUNTLET_DISPATCHES} dispatch ceiling`,
        }
      : undefined
  }

  /** What a gauntlet's orchestrator is told it has left, in place of a countdown. */
  function spentSoFar() {
    const cost = log.usage?.cost ?? 0
    const minutes = Math.round((Date.now() - log.started) / 60_000)
    return `This run has spent $${cost.toFixed(2)} of $${gauntlet!.maxSpend} and ${minutes} of ${gauntlet!.maxMinutes} minutes.`
  }

  /**
   * What the orchestrator decided this turn, read from whichever channel it
   * used.
   *
   * The tool call wins. It is what a model that follows instructions reaches
   * for, it survives the card carrying on afterwards — the call sits in the
   * message history whatever is written after it — and the arguments arrive
   * already parsed, so a model that is fine at tool use but sloppy at fenced
   * JSON gets through. The text block stays as the fallback for a card whose
   * allowlist does not include the tool, or a run against a host where the MCP
   * server is not installed.
   *
   * A failed history read is not a failed turn: fall back to the text rather
   * than killing a run over one flaky request.
   */
  async function decide(node: FlowNode, children: string[]) {
    // Skipped entirely while the tool channel is parked: no MCP tool can reach
    // a v2 session in this fork, so every scan would be a request per turn that
    // cannot find anything. See `MCP_REACHES_SESSIONS`.
    const calls = toolChannel ? ((await api.sessionCalls?.(nodeSession.get(node.id)!).catch(() => [])) ?? []) : []
    const seen = consumed.get(node.id) ?? new Set<string>()
    let decision: ReturnType<typeof parseDispatch> | undefined
    for (const call of calls) {
      // Only calls this turn made. The orchestrator is re-prompted into the
      // session it already holds, so every earlier turn's calls are still in
      // the history — without this a turn that called nothing would act on the
      // previous turn's dispatch a second time.
      if (seen.has(call.id)) continue
      decision ??= fromToolCall(call.name, call.input, children)
    }
    for (const call of calls) seen.add(call.id)
    consumed.set(node.id, seen)
    return decision ?? parseDispatch(outputs.get(node.id) ?? "", children)
  }

  /** A leaf card: one turn, one assignment, no protocol to speak. */
  async function runSubagent(node: FlowNode, parent: FlowNode, task: string) {
    const returning = nodeSession.has(node.id)
    const critic = gauntlet && isCritic(node)
    await runTurn(
      node,
      (skipped) =>
        returning
          ? reassignPrompt(task)
          : critic
            ? criticPrompt(pipeline, node, parent, task, input, skipped)
            : subagentPrompt(pipeline, node, parent, task, input, skipped),
      true,
    )
    if (failed.has(node.id)) return undefined
    return outputs.get(node.id)
  }

  const parentOf = (id: string) => pipeline.nodes.find((entry) => tree!.children(entry.id).includes(id))

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
            error: `the server does not know an agent named "${node.agent.name}" — it reads its config once at boot, so a merged agent stays invisible until it restarts. ${how}`,
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

      /** What every peer said in the round before the one now running. */
      let said = new Map<string, string>()
      if (swarm)
        await runSwarm(roundsOf(pipeline), limit, controller.signal, {
          // The round about to run overwrites every peer's output, so what they
          // said last round is frozen on the boundary. Without this an agent
          // early in the pool would read round 2 answers while one late in the
          // same pool still reads round 1 — the debate would depend on
          // scheduling order.
          round: (round) => {
            said = new Map(outputs)
            activity.note(
              swarm.synthesizers[0].id,
              `swarm:round:${round}`,
              `round ${round} of ${roundsOf(pipeline)} — ${swarm.agents.filter((node) => !failed.has(node.id)).length} agent(s) still in`,
              undefined,
              "done",
            )
          },
          peers: swarm.agents.map((node) => node.id),
          peer: (id, round) => runPeer(nodes.get(id)!, round, said),
          synthesise: () =>
            runTurn(swarm.synthesizers[0], (skipped) =>
              synthesisPrompt(pipeline, swarm.synthesizers[0], outputs, input, skipped),
            ),
        })
      else if (tree) await orchestrate(tree.root, input, true)
      else await runPipeline(validation.layers, limit, controller.signal, (id) => runNode(nodes.get(id)!))
      // A card nobody dispatched never ran, and "queued" would read as though
      // the run had stopped short of it. It was simply not needed. Through
      // `patch` rather than onto the log directly, or the canvas card keeps
      // saying "queued" while the run log and statusbar say "skipped".
      if (tree)
        for (const node of log.nodes) if (node.status === "queued") patch(node.id, { status: "skipped" })
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
      // Every card's work was folded back in after its own batch, so what is
      // left here is empty checkouts and `openflow/*` branches nobody reads.
      // Done in `finally` because an aborted or failed run leaves the most of
      // them, and a stack of stale worktrees in the user's repository is the
      // thing that would make this feature not worth having.
      if (opened.size && deps.worktrees) await deps.worktrees.cleanup(log.id, [...opened.values()]).catch(() => {})
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
 * The `swarm` mode scheduler: every peer at once, N times, then the synthesizer.
 *
 * A round is a barrier for the same reason a pipeline layer is — a peer can read
 * the round before it only because that round has already settled — and it is
 * the only ordering this mode has. Peers inside a round are unordered by design:
 * they are answering the same question at the same time, which is the whole
 * point of a swarm.
 *
 * The synthesizer runs once, after the last round, and outside the pool: there
 * is one of it and nothing left to run beside it.
 */
async function runSwarm(
  rounds: number,
  limit: number,
  signal: AbortSignal,
  step: {
    peers: string[]
    /** Called on each round boundary, before any peer in it is dispatched. */
    round: (round: number) => void
    peer: (id: string, round: number) => Promise<void>
    synthesise: () => Promise<void>
  },
) {
  for (let round = 1; round <= rounds; round++) {
    if (signal.aborted) return
    step.round(round)
    await pool(step.peers, limit, signal, (id) => step.peer(id, round))
  }
  if (signal.aborted) return
  await step.synthesise()
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


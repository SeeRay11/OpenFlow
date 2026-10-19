import { collisionNote, collisionsIn, exceptUnder, writesOf, type Write } from "../graph/collisions"
import { addDiff, attribute, deltaOf } from "../graph/diff"
import { bestRound, ledgerNote, stalledRounds, verdictSummary, type LedgerRound } from "../graph/ledger"
import { isolates, mergeNote } from "../graph/worktree"
import type { EngineApi, ModelInfo, PermissionReply, QuestionInfo } from "../../shared/engine"
import type { MemoryInfo, MemoryReadRequest, MemoryReadResult, MemoryWriteRequest, MemoryWriteResult } from "../../shared/memory"
import type { SwarmStatus } from "../../shared/swarm"
import type { UpliftInfo, UpliftRequest, UpliftResult } from "../../shared/uplift"
import { fromToolCall, MCP_REACHES_SESSIONS, parseDispatch } from "../graph/dispatch"
import { isCritic, orchestrationShape } from "../graph/orchestration"
import {
  alreadyUplifted,
  buildSections,
  criticPrompt,
  dispatchFirstPrompt,
  dispatchResultPrompt,
  forceFinalPrompt,
  imageBlindNote,
  interruptedNote,
  judgeFirstPrompt,
  noWritesNote,
  scratchNote,
  unverifiedNote,
  verdictPrompt,
  verifyPrompt,
  orchestratorSections,
  plainPrompt,
  protocolPrompt,
  reassignPrompt,
  stripRaw,
  subOrchestratorSections,
  silentWriterNote,
  subagentSections,
  swarmPrompt,
  swarmSections,
  taskOf,
  toolFailureNote,
  synthesisSections,
  upliftedPrompt,
  type PromptSection,
} from "../graph/prompt"
import { swarmShape } from "../graph/swarm"
import { verdictIn } from "../graph/verdict"
import type {
  Attachment,
  CardDiff,
  FlowNode,
  NodeEvent,
  NodeStatus,
  Pipeline,
  RunLog,
  RunNodeLog,
  Spend,
  StepUsage,
} from "../graph/types"
import {
  depthOf,
  dispatchesOf,
  GAUNTLET_DISPATCHES,
  gauntletOf,
  isolationOf,
  modeOf,
  roundsOf,
  verifyOf,
} from "../graph/types"
import { ancestors, downstream, layer, upstream } from "../graph/validate"
import { applyEvent, createActivity, persistable } from "./activity"
import * as api from "./client"
import { cardSpec, swarmOf, toolMap } from "./card-spec"
import { createStages } from "./stages"
import { store, type WorktreeRef } from "./store"
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
  /** Lines this node put into the working tree and took out of it. */
  diff?: CardDiff
  /** Whether the card's last judging turn ran a shell. Absent on any other card. */
  ranShell?: boolean
  /** Prompt Uplift: the original task, what it became, and why when it did not. */
  uplift?: UpliftInfo
  /** Shared memory: what the card read before it ran and what it wrote after. */
  memory?: MemoryInfo
  /** Agent Swarm activity under the card's session, as the host last reported it. */
  swarm?: SwarmStatus
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
  onPermission?: (request: PermissionRequest) => Promise<PermissionReply>
  /** Resolve with one array of chosen labels per question, or undefined to reject. */
  onQuestion?: (request: QuestionRequest) => Promise<string[][] | undefined>
  /**
   * Prompt Uplift failed for a card and nothing has been sent to it. Resolve with
   * what to do: run the original prompt, ask uplift again (three attempts in
   * all), or cancel the card.
   *
   * Absent means `cancel` — the original is never run silently, because a card
   * the user believes was uplifted and was not is the failure this exists to
   * surface. A stopped run settles a pending decision as `cancel`, the way it
   * settles a pending question.
   */
  onUpliftFailure?: (request: UpliftFailureRequest) => Promise<"original" | "retry" | "cancel">
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
   * Defaults to `MCP_REACHES_SESSIONS`, which is `true`: the host answers
   * `openflow_dispatch` / `openflow_finish` as RPC host tools, and the engine
   * reads the calls back through `EngineApi.sessionCalls`. Switching it off
   * leaves only the fenced block, which is what a host without those tools is.
   */
  toolChannel?: boolean
  /**
   * How long the end of the run waits for memory writes and session releases,
   * in milliseconds. They never hold a card, but the run log is more honest if
   * their outcome lands in it; past this the run ends with them still pending.
   */
  backgroundGrace?: number
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
const MUTATING = new Set(["edit", "write", "patch", "ast_edit"])

/**
 * How many times a card may be re-asked for a control block before its run
 * fails. Protocol re-asks are not charged to the dispatch budget: they buy
 * nothing, and the alternative to asking again is throwing away the run.
 */
const PROTOCOL_RETRIES = 3

/**
 * How many times a turn the provider could not take right now is re-sent, and
 * how long the first wait is — each retry waits twice as long as the one before.
 *
 * A 429 says "not now", and everywhere else in the engine that reads as "this
 * card is finished". It costs a gauntlet more than anything else: a critic is
 * given a session it has never used before on every single verdict, which is
 * the traffic shape a per-model limit punishes, and it is the one card whose
 * absence the run cannot route around — no verdict, no legal way to stop.
 * Measured on the 2026-09-01 run: two 429s in sixteen minutes ended it.
 *
 * A gateway that answered 502, a socket that dropped, a `fetch failed` — all of
 * them say the same thing and all of them were nevertheless terminal, which is
 * the difference between a run that lasts an afternoon and one that needs
 * somebody watching it. `transient()` classifies those together with the 429;
 * the counts are separate so a card being rate limited and a card whose
 * connection keeps dropping do not spend each other's budget.
 */
const RATE_LIMIT_RETRIES = 3
const TRANSIENT_RETRIES = 3
export const DEFAULT_RATE_LIMIT_BACKOFF = 20_000
export const DEFAULT_NODE_TIMEOUT = 30 * 60_000
export const DEFAULT_QUESTION_TIMEOUT = 5 * 60_000
export const DEFAULT_CHECKPOINT_EVERY = 2_000
/** How long to wait before re-reading a model catalog that looked incomplete. */
export const DEFAULT_CATALOG_RETRY = 1_500
/** Prompt Uplift attempts per task turn, the first included, before a failure ends the card. */
const UPLIFT_ATTEMPTS = 3
export const DEFAULT_BACKGROUND_GRACE = 10_000

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
  api: EngineApi
  /**
   * Prompt Uplift for a card's task turn. Optional so a test double can omit it:
   * absent means every task is sent as written and the card records no uplift.
   */
  uplift?: (request: UpliftRequest, signal?: AbortSignal) => Promise<UpliftResult>
  /**
   * Shared memory across the cards of a run (Agent Substrate, host-side).
   * Optional for the same reason; `read` fails open and `write` never blocks a
   * card from finishing.
   */
  memory?: {
    read(request: MemoryReadRequest, signal?: AbortSignal): Promise<MemoryReadResult>
    write(request: MemoryWriteRequest, signal?: AbortSignal): Promise<MemoryWriteResult>
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
   * The project tree's line counts, read before and after a batch so the
   * difference can be attributed to the cards that ran in it.
   *
   * Optional, and absent simply means a run records no line counts: there is no
   * fallback worth having, since the only other source is the card's own
   * account of what it did, which is exactly the claim this exists to check.
   */
  treeStat?: typeof store.treeStat
  /**
   * Commits the working tree as a round left it, under a ref of OpenFlow's own.
   * Optional: a host without it, or a project that is not a repository, runs
   * with no way back, exactly as it did before checkpoints existed.
   */
  checkpoint?: typeof store.checkpoint
  /**
   * A directory outside the project for output that is not the work. Optional:
   * without it the cards are simply not told about one, which is how every run
   * before this behaved.
   */
  scratch?: typeof store.scratch
}

const stages = createStages()

const live: EngineDeps = {
  api,
  uplift: stages.uplift,
  memory: stages.memory,
  saveRun: (log) => store.saveRun(log),
  worktrees: { open: store.openWorktrees, merge: store.mergeWorktrees, cleanup: store.cleanupWorktrees },
  treeStat: () => store.treeStat(),
  checkpoint: (run, round) => store.checkpoint(run, round),
  scratch: (run) => store.scratch(run),
}

/** What a turn sends: sections for the card's own task turn, a string for every protocol turn. */
type TurnText = string | PromptSection[]

/** What uplift and memory decided for one task turn. */
type Staged = { uplifted?: string; memory: string }

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
  questions: QuestionInfo[]
}

export type UpliftFailureRequest = {
  nodeID: string
  role: string
  reason: string
  elapsedMs: number
  /** Which attempt just failed, 1-based, out of `attempts`: on the last one a retry is not offered. */
  attempt: number
  attempts: number
}

/**
 * Executes a canvas over the Omp engine (`EngineApi`).
 *
 * One node = one Omp session, whatever the mode. Everything a session needs
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
  const backgroundGrace = Math.max(0, options.backgroundGrace ?? DEFAULT_BACKGROUND_GRACE)
  // Preflight only covers what this run will dispatch: a reused node creates no
  // session, so a model it names having gone missing cannot break it.
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
      throw new Error(
        `an orchestration runs from exactly one card with no incoming connection, and this graph has ${tree.roots.length}`,
      )
    if (tree.shared.length) throw new Error("a card is dispatched by more than one orchestrator")
    if (tree.depth > depthOf(pipeline))
      throw new Error(`the subagent tree is ${tree.depth} level(s) deep and the limit is ${depthOf(pipeline)}`)
  }
  // A gauntlet trades the dispatch budget for money-and-time bounds, so a
  // canvas with nothing to judge the work would loop builders against nobody
  // until one of those caps fired. Preflight says the same in the UI.
  const gauntlet = tree ? gauntletOf(pipeline) : undefined
  /** Off unless the canvas asked: separate working copies change where a run's writes land. */
  const isolate = isolationOf(pipeline)
  if (gauntlet && !pipeline.nodes.some((node) => isCritic(node) && !tree!.children(node.id).length))
    throw new Error("a gauntlet has no reviewer card to judge the work against its bar")
  /**
   * Whether this run ends on a verdict. Every mode, gauntlets excepted — theirs
   * already does.
   */
  const verify = verifyOf(pipeline)
  const verifiers = verify ? pipeline.nodes.filter((node) => isCritic(node)) : []
  // The same shape as the gauntlet check above, and for the same reason: the
  // engine is callable without preflight, and a run that cannot be verified
  // would otherwise report exactly what verification exists to stop it
  // reporting.
  if (verify && !verifiers.length) throw new Error("verification is on and no card has the reviewer role")
  // Swarm reads no edges at all, so a leftover cycle from a graph that used to
  // be a pipeline is not a reason to refuse it. Orchestration does read them,
  // and `layer` is still what rejects a cycle before the recursion meets one.
  const validation = swarm ? { ok: true as const, layers: [] as string[][] } : layer(pipeline)
  if (!validation.ok) throw new Error(validation.error)
  const order = new Map(validation.layers.flatMap((ids, index) => ids.map((id) => [id, index] as const)))

  const controller = new AbortController()
  /**
   * Settles when the run is stopped. Raced against every wait on something
   * outside the engine (uplift, memory, a person's decision), so stopping the
   * run never sits behind a planner that has minutes left to time out.
   */
  const stopped = Promise.withResolvers<undefined>()
  controller.signal.addEventListener("abort", () => stopped.resolve(undefined), { once: true })
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
  /** sessionID -> why the host reports its process gone. Read by the turn using it. */
  const dead = new Map<string, string>()
  /** sessionID -> the abort of the turn waiting on it, so a dead process does not hold the turn until `nodeTimeout`. */
  const waiting = new Map<string, AbortController>()
  /** Every session this run opened or adopted and has not yet handed back to the host. */
  const held = new Set<string>()
  /** Fire-and-forget work (memory writes, session releases), awaited with a cap when the run ends. */
  const background = new Set<Promise<unknown>>()
  /**
   * What every orchestration round produced, across the whole run.
   *
   * Run-scoped rather than per-orchestrator: a subtree keeps its own rounds
   * (`stalledRounds` and `ledgerNote` both filter by card), but they are read
   * back afterwards next to each other, which is the point of writing them
   * down at all.
   */
  const rounds: LedgerRound[] = []
  /** Where cards are told to put output that is not the work, once the host has made one. */
  let scratchDir = ""
  /** Cards already told about it — a briefing repeated every turn is a briefing nobody reads. */
  const toldScratch = new Set<string>()
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
    held.add(sessionID)
    carried.add(id)
  }
  /** Tool-call ids already read, so an old call cannot decide a new turn. */
  const consumed = new Map<string, Set<string>>()
  /**
   * The paths the current assignment said a card would write, when it said.
   *
   * Optional on a dispatch and empty for every other mode, so its absence
   * proves nothing — but when it is there it is the orchestrator's own claim
   * about what should change, which is the only expectation the engine has that
   * did not come from a default.
   */
  const declared = new Map<string, string[]>()
  const active = new Set<string>() // sessionIDs still running
  const answered = new Set<string>() // `sessionID:requestID` of permission requests already replied to
  /** How many times each card has been dispatched, so a later answer can be told from the first in memory. */
  const dispatches = new Map<string, number>()
  const asked = new Set<string>() // question requests already handled
  const catalog = new Map<string, ModelInfo>()
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

  /**
   * Runs a batch of cards and records the lines they changed.
   *
   * The measurement is a pair of snapshots around the batch, never around a
   * card: cards in a batch run at once in one working directory, so the only
   * moment the tree can be read and mean something is a boundary where nothing
   * is running. Which card owns which line is then settled by `attribute`, off
   * the same tool-call file lists the collision check already reads.
   *
   * Isolated cards are skipped here and counted from their own branch instead
   * (`MergeReport.stats`). They have to be: their work lands in the project
   * only when the merge runs, so a snapshot taken around the batch would credit
   * whichever cards happened to be sharing the tree with whatever the merge
   * folded in.
   *
   * Every failure is silent and total — no repository, no host route, a git
   * that errored — because a run must never fail over its own bookkeeping, and
   * a missing count already reads as "not measured" everywhere it is shown.
   */
  async function measured(ids: string[], work: () => Promise<void>) {
    const sharing = ids.filter((id) => !opened.has(id))
    if (!deps.treeStat || !sharing.length) return work()
    const at = Date.now()
    const before = await deps
      .treeStat()
      .then((result) => result.files)
      .catch(() => null)
    await work()
    if (!before) return
    const after = await deps
      .treeStat()
      .then((result) => result.files)
      .catch(() => null)
    if (!after) return
    const wrote = new Map<string, Write[]>()
    for (const id of sharing) {
      const paths = [id, ...descendants(id)].flatMap((child) => writesOf(events.get(child) ?? [], at))
      if (paths.length) wrote.set(id, paths)
    }
    if (!wrote.size) return
    for (const [id, diff] of attribute(deltaOf(before, after), wrote).cards)
      patch(id, { diff: addDiff(entry(id).diff, diff) })
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
      // A notice may belong to no session at all (the host's own, an extension
      // that failed to load). One that names a session this run does not own is
      // another run's, and the stream is shared.
      if (event.type === "flow.notice") {
        const owner = sessionID ? sessions.get(sessionID) : undefined
        if (sessionID && !owner) return
        const message = String(event.data?.message ?? "")
        if (!message) return
        hooks.onNotice?.(event.data?.level === "error" ? "error" : "info", owner ? `${entry(owner).role}: ${message}` : message)
        return
      }
      if (!sessionID) return
      const id = sessions.get(sessionID)
      if (!id) return
      switch (event.type) {
        case "flow.swarm.status":
          if (event.data?.status) patch(id, { swarm: event.data.status })
          return
        case "flow.session.lost":
          return lose(sessionID, String(event.data?.reason ?? "the session process ended"))
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
    const key = `${sessionID}:${requestID}`
    if (answered.has(key)) return
    answered.add(key)
    const resources = data.resources ?? []
    const node = nodes.get(nodeID)

    let reply: PermissionReply = "once"
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
        ? await hooks
            .onPermission({
              requestID,
              sessionID,
              nodeID,
              role: node?.role ?? nodeID,
              action: data.action,
              resources,
            })
            .catch(() => "reject" as const)
        : "reject"
    }

    try {
      await api.replyPermission(sessionID, requestID, reply)
    } catch (error) {
      // The host withdrew the request (the turn ended, the session went): nothing is waiting for an answer.
      if (!gone(error)) hooks.onNotice?.("error", `permission reply failed: ${api.describe(error)}`)
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
  async function inquire(nodeID: string, sessionID: string, data: { id: string; questions?: QuestionInfo[] }) {
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
      if (!gone(error)) hooks.onNotice?.("error", `question reply failed: ${api.describe(error)}`)
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

  /** The text of a turn that was built as sections. */
  function textOf(turn: TurnText) {
    return typeof turn === "string" ? turn : plainPrompt(turn)
  }

  /** Keeps a fire-and-forget promise visible to the end of the run without ever letting it reject. */
  function track(promise: Promise<unknown>) {
    background.add(promise)
    const settle = () => background.delete(promise)
    promise.then(settle, settle)
  }

  /**
   * Hands a session back to the host. Best effort, and once: the host disposes
   * the process, and nothing the run holds refers to the session afterwards.
   */
  function release(sessionID: string) {
    if (!held.delete(sessionID) || !api.release) return
    track(api.release(sessionID).catch(() => undefined))
  }

  /** Forgets a card's session and releases it — for a card that will not be prompted into it again. */
  function abandon(id: string) {
    const sessionID = nodeSession.get(id)
    nodeSession.delete(id)
    if (sessionID) release(sessionID)
  }

  /**
   * The host says a session's process is gone. The turn using it is cut short
   * and failed as a lost session, which the transport budget below recovers by
   * opening a new one — the same path a "session not found" from the server
   * has always taken.
   */
  function lose(sessionID: string, reason: string) {
    dead.set(sessionID, reason)
    waiting.get(sessionID)?.abort()
  }

  function assertOpen(sessionID: string) {
    const reason = dead.get(sessionID)
    if (reason !== undefined) throw new Error(`session closed: ${reason}`)
  }

  function patchMemory(id: string, part: MemoryInfo) {
    patch(id, { memory: { ...entry(id).memory, ...part } })
  }

  /**
   * Everything that happens to a card's task before it is sent: Prompt Uplift,
   * then the memory read. Runs once per turn however many times the send is
   * retried, because a retry re-sends the same turn rather than a new one.
   *
   * `raw:` and `agent.uplift === false` opt the card out of both: a card the
   * user asked to run as written must not have a spec or a block of recalled
   * text put in front of it either.
   */
  async function stage(node: FlowNode, sections: PromptSection[], raw: boolean): Promise<Staged> {
    const original = taskOf(sections)
    const reason = raw ? "raw: prefix" : node.agent.uplift === false ? "uplift is off for this card" : undefined
    if (reason) {
      if (deps.uplift) patch(node.id, { uplift: { status: "skipped", original, reason } })
      return { memory: "" }
    }
    const uplifted = deps.uplift ? await upliftTask(node, sections, original) : undefined
    return { uplifted, memory: await recall(node, original) }
  }

  /**
   * Asks uplift for one card, and the user what to do when it cannot.
   * Resolves the text to send in place of the original, or `undefined` to send
   * the original; throws `UpliftError` when the card must not run.
   */
  async function upliftTask(node: FlowNode, sections: PromptSection[], original: string) {
    if (!original.trim()) return undefined
    if (alreadyUplifted(sections)) {
      patch(node.id, { uplift: { status: "skipped", original, reason: "already a spec" } })
      return undefined
    }
    for (let attempt = 1; ; attempt++) {
      const started = Date.now()
      patch(node.id, { uplift: { status: "running", original }, activity: "uplifting prompt" })
      const result = await Promise.race([
        deps
          .uplift!(
            {
              runId: log.id,
              nodeId: node.id,
              role: node.role,
              original,
              ...(nodeDir.has(node.id) ? { cwd: nodeDir.get(node.id) } : {}),
            },
            controller.signal,
          )
          .catch(
            (error): UpliftResult => ({
              status: "failed",
              original,
              reason: api.describe(error),
              elapsedMs: Date.now() - started,
            }),
          ),
        stopped.promise,
      ])
      if (!result) throw new StopError()
      const info: UpliftInfo = {
        status: result.status,
        original,
        reason: result.reason,
        source: result.source,
        graphId: result.graphId,
        specPath: result.specPath,
        nodes: result.nodes,
        degraded: result.degraded,
        decisions: result.decisions,
        elapsedMs: result.elapsedMs,
      }
      // A conservative fallback spec is what the planner writes when it could
      // not reach its engine: not an uplift, whatever status carries it.
      const spec = result.status === "ok" && result.source !== "fallback" ? result.uplifted?.trim() : undefined
      if (spec) {
        patch(node.id, { uplift: { ...info, uplifted: result.uplifted } })
        return result.uplifted!
      }
      if (result.status === "skipped") {
        patch(node.id, { uplift: info })
        activity.note(
          node.id,
          `uplift:${node.id}:${started}`,
          `prompt uplift skipped${result.reason ? ` — ${result.reason}` : ""}`,
          undefined,
          "done",
        )
        return undefined
      }

      const reason =
        result.reason ??
        (result.status === "ok"
          ? result.source === "fallback"
            ? "the planner fell back to a conservative spec"
            : "the planner returned no spec"
          : "the planner failed")
      patch(node.id, { uplift: { ...info, status: "failed", reason }, activity: "uplift failed — waiting for a decision" })
      activity.note(node.id, `uplift:${node.id}:${started}`, "prompt uplift failed", reason, "error")
      const choice =
        hooks.onUpliftFailure && !controller.signal.aborted
          ? await Promise.race([
              hooks
                .onUpliftFailure({
                  nodeID: node.id,
                  role: node.role,
                  reason,
                  elapsedMs: result.elapsedMs,
                  attempt,
                  attempts: UPLIFT_ATTEMPTS,
                })
                .catch(() => "cancel" as const),
              stopped.promise.then(() => "cancel" as const),
            ])
          : "cancel"
      if (controller.signal.aborted) throw new StopError()
      if (choice === "original") {
        patch(node.id, { uplift: { ...info, status: "declined", reason, declined: true } })
        return undefined
      }
      if (choice === "retry" && attempt < UPLIFT_ATTEMPTS) continue
      throw new UpliftError(reason)
    }
  }

  /**
   * Project memory for one card, as a block to append after its context. Fails
   * open: a card runs without memory when Substrate is unreachable, and the
   * card says so rather than failing.
   */
  async function recall(node: FlowNode, query: string) {
    if (!deps.memory || !query.trim()) return ""
    patchMemory(node.id, { read: { status: "running", items: [] } })
    const result = await Promise.race([
      deps.memory
        .read({ runId: log.id, nodeId: node.id, pipeline: pipeline.name, role: node.role, query }, controller.signal)
        .catch(
          (error): MemoryReadResult => ({
            status: "unavailable",
            block: "",
            items: [],
            scopes: [],
            error: api.describe(error),
            elapsedMs: 0,
          }),
        ),
      stopped.promise,
    ])
    if (!result || controller.signal.aborted) throw new StopError()
    patchMemory(node.id, {
      read: {
        status: result.status,
        items: result.items.map((item) => ({
          scope: item.scope,
          subject: item.subject,
          preview: item.preview,
          run: item.run,
          card: item.card,
          origin: item.origin,
        })),
        briefState: result.briefState,
        error: result.error,
      },
    })
    if (result.status === "unavailable")
      activity.note(
        node.id,
        `memory:${node.id}:read`,
        "project memory unavailable — running without it",
        result.error,
        "error",
      )
    return result.status === "ok" ? result.block : ""
  }

  /**
   * Writes one finished card to project memory. Never awaited by the card: a
   * Substrate that is slow or down must not hold a run, and a failure is
   * patched onto the card where it can be seen.
   */
  function remember(node: FlowNode) {
    if (!deps.memory || resume[node.id] !== undefined) return
    const row = entry(node.id)
    if (row.status !== "done" && row.status !== "error" && row.status !== "stopped") return
    const outcome = row.status
    const output = outcome === "error" ? (row.error ?? "") : (outputs.get(node.id) ?? row.output ?? "")
    const dispatch = dispatches.get(node.id)
    patchMemory(node.id, { write: { status: "running" } })
    track(
      deps.memory
        .write({
          runId: log.id,
          nodeId: node.id,
          pipeline: pipeline.name,
          role: node.role,
          outcome,
          output,
          // A pipeline or swarm card runs once; only a dispatched card can have a second answer to tell apart.
          ...(dispatch ? { dispatch } : {}),
        })
        .then(
          (result) => patchMemory(node.id, { write: { status: result.status, subject: result.subject, error: result.error } }),
          (error) => patchMemory(node.id, { write: { status: "unavailable", error: api.describe(error) } }),
        ),
    )
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
  async function runTurn(node: FlowNode, build: (skipped: Attachment[]) => TurnText, reuse = false) {
    // A card carried over from an interrupted run is prompted into the session
    // it was already working in, whichever scheduler is asking. Consumed on the
    // first turn: from the second one on it is an ordinary reused session, and
    // the card should not be told it was interrupted twice.
    const carrying = carried.delete(node.id)
    if (carrying) {
      const opening = build
      // Not a task turn, so never uplifted: the session already holds the task
      // it was given, and the note alone is what resumes it.
      build = (skipped) => `${interruptedNote()}\n\n${textOf(opening(skipped))}`
    }
    let sessionID = reuse || carrying ? nodeSession.get(node.id) : undefined
    // The session an earlier run left open, to be re-attached by the host on
    // this turn's first `createSession` rather than prompted into blind: a host
    // that restarted since still has the session's files, and only it can say.
    let attach = carrying ? sessionID : undefined
    /** What uplift and memory decided for this turn, kept so a retry re-sends the same text instead of asking again. */
    let staged: Staged | undefined
    // The log has to name the session a carried card is in from the first
    // moment, not only once the host has answered the re-attach: without it a
    // run interrupted again in between reports a card with no session while it
    // is answering in one, and has nothing left to carry forward.
    if (carrying && sessionID) patch(node.id, { sessionID })
    // Whether this card's files have already reached the session. A reused one
    // holds them; a retry after a refused prompt does not, so the attachments
    // ride the re-send rather than being lost with the turn that never landed.
    let delivered = !!sessionID
    // Counted apart: a card being rate limited and a card whose connection keeps
    // dropping are different problems, and one must not spend the other's budget.
    let refusals = 0
    let drops = 0
    for (;;) {
      const opened = sessionID
      // Only this turn's tool failures count; a card is prompted into the session
      // it already holds, so every earlier turn's are still on the stream.
      const turnStarted = Date.now()
      /** Cut short by `flow.session.lost`, so the wait below ends when the process does. */
      const turnWait = new AbortController()
      controller.signal.addEventListener("abort", () => turnWait.abort(), { once: true, signal: turnWait.signal })
      patch(node.id, {
        status: "running",
        ...(opened ? {} : { started: Date.now() }),
        activity: opened ? "continuing session" : "starting session",
      })
      try {
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
        // Said once per card, on the turn that opens its session. A card with
        // no shell has nothing to redirect and is not told.
        const needsScratch = !!scratchDir && !toldScratch.has(node.id) && toolMap(node.agent.tools).bash !== false
        if (needsScratch) toldScratch.add(node.id)
        const appended = [
          ...(model && !api.accepts(model, "image/png") ? [imageBlindNote()] : []),
          ...(needsScratch ? [scratchNote(scratchDir)] : []),
        ]
        const turn = build(skipped)
        // Only a task turn — the card's own instruction, handed over as
        // sections — goes through uplift and memory. A protocol turn is a
        // string, and cannot reach either by construction.
        let text: string
        if (typeof turn === "string") text = [turn, ...appended].join("\n\n")
        else {
          const task = stripRaw(turn)
          staged ??= await stage(node, task.sections, task.raw)
          // A stop that landed while uplift or memory was in flight leaves nothing to send.
          if (controller.signal.aborted) throw new StopError()
          text = [
            staged.uplifted
              ? upliftedPrompt(task.sections, staged.uplifted, appended)
              : [plainPrompt(task.sections), ...appended].join("\n\n"),
            ...(staged.memory ? [staged.memory] : []),
          ].join("\n\n")
        }

        // The session is opened only now that the text is settled, so a card
        // whose uplift is cancelled never costs a process.
        if (!sessionID || attach) {
          const session = await api.createSession({
            runId: log.id,
            nodeId: node.id,
            card: cardSpec(pipeline, node),
            model: node.agent.model,
            // Fixed for the life of the session, which is why a card keeps the
            // tree it was first given rather than moving between batches.
            directory: nodeDir.get(node.id),
            permissions: policy,
            swarm: swarmOf(pipeline, node),
            ...(attach ? { reuse: attach } : {}),
          })
          attach = undefined
          sessionID = session.id
          nodeSession.set(node.id, session.id)
          sessions.set(session.id, node.id)
          held.add(session.id)
          patch(node.id, { sessionID: session.id })
          // A stop that landed while the session was opening must not start a turn in it:
          // it is already held, so teardown releases it.
          if (controller.signal.aborted) throw new StopError()
        }
        active.add(sessionID)
        waiting.set(sessionID, turnWait)
        patch(node.id, { activity: "queued" })
        patch(node.id, { prompt: text })
        assertOpen(sessionID)

        await api.prompt(sessionID, text, sendable)
        delivered = true
        if (controller.signal.aborted) throw new StopError()
        assertOpen(sessionID)
        await api.waitForIdle(sessionID, { signal: turnWait.signal, timeout: nodeTimeout })
        active.delete(sessionID)
        if (controller.signal.aborted) throw new StopError()
        assertOpen(sessionID)

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
        // What this turn actually changed on disk, read off the same tool calls
        // the collision check reads. A card is `done` when its session goes
        // idle, so "answered in prose and touched nothing" and "did the work"
        // are the same event out here unless somebody looks.
        const wrote = writesOf(events.get(node.id) ?? [], turnStarted)
        const owed = declared.get(node.id) ?? []
        const expected = owed.length > 0 || writerByChoice(node)
        // A card that says nothing hands the next card a blank where its input
        // should be, and the next card answers about nothing. If it wrote, the
        // writes are the answer; if it did neither, there is nothing to pass on
        // and nothing to have built — so the card failed, whatever the session
        // reported.
        //
        // Except for an orchestrator, which is asked again instead. A turn that
        // ended on a tool call and said nothing is a normal thing for one to do
        // and `parseDispatch` has a re-ask written for exactly it; failing the
        // card here would take the run down over a turn that only needed the
        // block. Nothing can re-ask any other card, which is why they are held
        // to the stricter rule.
        const orchestrating = !!tree && tree.children(node.id).length > 0
        if (!result.text.trim() && !wrote.length && !orchestrating)
          throw new Error("the card finished without producing any output")

        // A verdict reached without running anything is a review of the
        // source, not of the behaviour — and a boot failure is invisible to
        // one. Only `bash` counts: reading a file is how the critic got here.
        const judging = (gauntlet || verify) && isCritic(node)
        const ran = (events.get(node.id) ?? []).some(
          (event) =>
            event.kind === "tool" &&
            event.at >= turnStarted &&
            event.status !== "error" &&
            event.title.startsWith("bash"),
        )
        const notes = [
          ...(rejected.length ? [toolFailureNote(rejected)] : []),
          ...(judging && !ran ? [unverifiedNote()] : []),
          // Not an error: a card given `edit` that finds nothing to change is
          // legitimate, and no signal here separates that from a card that
          // described work it never did. The reader is told, and decides.
          ...(expected && !wrote.length ? [noWritesNote(owed)] : []),
        ]
        // Only a card that wrote something gets its writes read out as its
        // answer. An orchestrator's empty turn stays empty, because `decide`
        // reads that emptiness and has its own thing to say about it.
        const body =
          !result.text.trim() && wrote.length ? silentWriterNote(wrote.map((write) => write.path)) : result.text
        const answer = notes.length ? `${body}\n\n${notes.join("\n\n")}` : body
        if (expected && !wrote.length)
          activity.note(
            node.id,
            `nowrites:${node.id}:${turnStarted}`,
            owed.length ? `wrote none of its ${owed.length} assigned file(s)` : "wrote no files",
            owed.join("\n"),
            "error",
          )
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
        // Recorded on judging turns only, so a card that was never asked to
        // judge reads as unknown rather than as a critic that ran nothing.
        patch(node.id, {
          status: "done",
          output: answer,
          // A re-dispatched card keeps its log entry, so an error from an earlier
          // dispatch would otherwise outlive the turn that cleared it.
          error: undefined,
          activity: undefined,
          finished: Date.now(),
          ...(judging ? { ranShell: ran } : {}),
        })
      } catch (error) {
        if (error instanceof StopError || controller.signal.aborted) {
          failed.add(node.id)
          patch(node.id, { status: "stopped", activity: undefined, finished: Date.now() })
          return
        }
        // Uplift's own refusal is a conclusion, not transport: asking again is
        // the user's decision (`onUpliftFailure`), never a silent retry, and its
        // text must not be read by the classifiers below.
        const own = error instanceof UpliftError
        const reason = own ? error.message : api.describe(error)
        // A session the server has lost fails every turn prompted into it, so
        // it is forgotten before the retry decision: the next attempt creates a
        // new one instead of re-sending into a dead handle. The card keeps its
        // place in the run either way — only its memory of the turn is gone.
        const lost = !own && sessionLost(reason)
        if (sessionID && lost) {
          nodeSession.delete(node.id)
          sessions.delete(sessionID)
          active.delete(sessionID)
          release(sessionID)
          activity.note(
            node.id,
            `session:${node.id}:${turnStarted}`,
            "its session was lost — starting a new one",
            reason,
            "error",
          )
          sessionID = undefined
          delivered = false
        }
        // "Not now" is not "this card is finished". The provider refused the
        // turn, or the connection to it dropped, before it produced anything —
        // so the same prompt goes back into the same session after a wait
        // rather than costing the run a card.
        const refused = !own && rateLimited(reason)
        // A replaced session is retried on the transport budget: opening a new
        // one is only a recovery if something is then sent into it, and the
        // count bounds the case where every new session is lost as fast as it
        // is made.
        const dropped = !own && !refused && (lost || transient(reason))
        const attempt = refused ? refusals : drops
        const allowed = refused ? RATE_LIMIT_RETRIES : TRANSIENT_RETRIES
        if ((refused || dropped) && attempt < allowed && rateLimitBackoff > 0) {
          const wait = rateLimitBackoff * 2 ** attempt
          const what = refused
            ? "rate limited"
            : lost
              ? "its session was replaced"
              : "the provider could not be reached"
          if (refused) refusals++
          else drops++
          activity.note(
            node.id,
            `${refused ? "ratelimit" : "transport"}:${node.id}:${turnStarted}`,
            `${what} — retrying in ${Math.round(wait / 1000)}s (${attempt + 1} of ${allowed})`,
            reason,
            "done",
          )
          patch(node.id, { activity: `${what} — retrying in ${Math.round(wait / 1000)}s` })
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
        turnWait.abort()
        if (sessionID) waiting.delete(sessionID)
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

  /**
   * Whether a failure means "not right now" rather than "this card is finished".
   *
   * The distinction is the whole of whether a run can be left alone. A 429, a
   * gateway error, a dropped socket and a DNS blip are all the provider or the
   * network being briefly unavailable: the same prompt into the same session a
   * few seconds later is the correct response, and failing the card instead
   * costs the run a card — or, for a gauntlet critic, the run itself, since
   * there is no legal ending without a verdict.
   *
   * Everything else is terminal on purpose, and the list is deliberately narrow
   * rather than "anything that is not obviously fatal". A 401, a 404 from a
   * model id that does not exist, an `UnsupportedApiError` from a provider the
   * runner cannot route: re-sending those is three more waits and the identical
   * error, and the run reports a card that took a minute to fail rather than a
   * second. The engine's *own* refusals — a card that finished without
   * producing anything, a critic that changed the work — never reach here as a
   * transient either, because they are conclusions rather than transport.
   */
  function transient(reason: string) {
    if (rateLimited(reason)) return false
    if (/\b4(0[0-9]|1[0-9]|2[0-9])\b/.test(reason)) return false
    return (
      /\b5[0-9]{2}\b/.test(reason) ||
      /bad gateway|service unavailable|gateway time-?out|internal server error/i.test(reason) ||
      /econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang ?up/i.test(reason) ||
      /fetch failed|network ?error|connection (closed|reset|refused|error)|premature close/i.test(reason)
    )
  }

  /**
   * Whether the session this card holds is the thing that broke.
   *
   * A session the server has lost is not a card that failed: every later turn
   * prompted into it fails the same way, and a swarm peer or a re-dispatched
   * builder would keep being fed the same dead handle. Forgetting it lets the
   * next turn create a new one — which is the whole recovery, since a card's
   * prompt is rebuilt from the graph rather than from the session.
   *
   * The cost is the model's memory of its own reasoning, so this is only done
   * when the session is named as the problem. A card whose session is fine and
   * whose *work* failed keeps it.
   */
  function sessionLost(reason: string) {
    return /session (not found|does not exist|expired|closed|invalid)|unknown session|no such session/i.test(reason)
  }

  /**
   * Whether a card writing nothing is worth remarking on.
   *
   * Deliberately **not** the reading `swarm-writers` uses in preflight. There,
   * the question is what a card *can* do, so an unlisted tool counts as allowed
   * — which is right for a hazard warning and useless here, since it makes
   * almost every card an expected writer and a note on almost every card is a
   * note nobody reads. `edit === true` is the box the user ticked (`write` and
   * `patch` alias onto it), so it is the closest thing to a stated intent.
   *
   * Three exemptions, all cards whose job is explicitly not to write: a swarm
   * peer, told in its briefing not to, a gauntlet critic, whose whole value is
   * that it only inspects, and a card in a verified run, which will be asked to
   * judge one — a note telling a verifier it changed no files is both wrong and
   * stapled to the verdict it just wrote.
   */
  function writerByChoice(node: FlowNode) {
    if (mode === "swarm") return false
    if ((gauntlet || verify) && isCritic(node)) return false
    return toolMap(node.agent.tools).edit === true
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
    await runTurn(node, (skipped) => buildSections(pipeline, node, context, outputs, input, skipped))
    // A pipeline card runs once, so nothing will prompt into its session again.
    remember(node)
    abandon(node.id)
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
    await runTurn(
      node,
      (skipped) =>
        round > 1 ? swarmPrompt(pipeline, node, round, peers, input, skipped) : swarmSections(pipeline, node, input, skipped),
      round > 1,
    )
    // A peer's card is finished after its last round, or the moment it fell out.
    if (round < roundsOf(pipeline) && !failed.has(node.id) && !controller.signal.aborted) return
    remember(node)
    abandon(node.id)
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
  async function orchestrate(node: FlowNode, task: string, first: boolean) {
    dispatches.set(node.id, (dispatches.get(node.id) ?? 0) + 1)
    const answer = await orchestration(node, task, first)
    remember(node)
    // The root's answer is the run's, so nothing prompts into its session
    // again. A subtree orchestrator can be dispatched a second time, and is
    // prompted into the session it holds, so it lives until the run ends.
    if (first) abandon(node.id)
    return answer
  }

  async function orchestration(node: FlowNode, task: string, first: boolean): Promise<string | undefined> {
    const children = tree!.children(node.id)
    const budget = gauntlet ? GAUNTLET_DISPATCHES : dispatchesOf(pipeline)
    // A card dispatched a second time is prompted into the session it already
    // holds, so it still has its briefing and its earlier task — only the job
    // is new.
    const returning = nodeSession.has(node.id)
    let build: (skipped: Attachment[]) => TurnText = (skipped) =>
      returning
        ? reassignPrompt(task)
        : first
          ? orchestratorSections(pipeline, node, input, skipped)
          : // Only a card with children reaches here; a leaf goes through
            // `runSubagent`. So this is always somebody's subagent that must
            // itself speak the protocol.
            subOrchestratorSections(pipeline, node, parentOf(node.id)!, task, input, skipped)
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
    /** Why the previous turn was told to answer, if it was. */
    let forced: { reason: string; error: string } | undefined
    /** Whether the previous turn's `final` was already sent back for a verdict. */
    let refused = false
    /** Whether an answer has already been sent back for having dispatched nobody. */
    let refusedEmpty = false
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
        // An orchestrator that answers having dispatched nobody has produced a
        // run in which every card the user drew is `skipped` and one model's
        // opinion is the output. Nothing about that looks like a failure — the
        // canvas settles green in seconds — which is why it was reported from
        // outside the project rather than caught by a check in it.
        //
        // The gauntlet refusal above is the same rule one level narrower, and
        // it runs first: in a gauntlet with nothing dispatched both are true,
        // and "send the work to a critic" is the more useful thing to be told
        // than "dispatch somebody". A card with no children is not an
        // orchestrator at all — it reached this loop as a subtree root that
        // lost its children to an edit mid-run, and it has nobody to ask.
        if (spent === 0 && children.length > 0) {
          if (!refusedEmpty) {
            refusedEmpty = true
            activity.note(node.id, `undispatched:${node.id}`, "answered without dispatching", undefined, "done")
            build = () => dispatchFirstPrompt(pipeline, node)
            continue
          }
          // Asked once and still nothing dispatched. Fail rather than accept:
          // the answer would be indistinguishable from a real run's, and the
          // whole cost of this bug is that it reports success. The text is kept
          // on the activity stream so the turn is not lost with the card.
          failed.add(node.id)
          const reason = "the orchestrator answered twice without dispatching any of its cards"
          activity.note(
            node.id,
            `undispatched:${node.id}:final`,
            "answered with no card dispatched",
            decision.answer,
            "error",
          )
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
      // What each card had already changed before this batch, so the round's
      // own line counts are the difference rather than the card's running
      // total — a card dispatched three times would otherwise report its whole
      // history as the work of every round it appeared in.
      const linesBefore = new Map(
        decision.assignments.map((assignment) => [assignment.card, entry(assignment.card).diff]),
      )
      // Critics judge by running the work — the build, the tests, the dev
      // server — in the one working directory this fork has. Two of them at
      // once race the same `dist/`, the same port, the same `node_modules`,
      // and each grades the other's half-built output. A critics-only batch is
      // the only batch that judges anything (see `judged` below), so it is the
      // one that has to see a tree holding still: one critic at a time. It
      // costs wall clock, which a gauntlet already bounds.
      const oneAtATime =
        !!gauntlet &&
        decision.assignments.length > 1 &&
        decision.assignments.every((entry) => isCritic(nodes.get(entry.card)!))

      // A working copy per card, so the batch cannot overwrite itself. Only
      // cards that can write get one — a reader isolated from the project would
      // read a copy of it for no benefit — and only cards that do not already
      // hold a session, because a session's location is fixed once it exists.
      if (isolate && deps.worktrees && decision.assignments.length > 1) {
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
            activity.note(
              node.id,
              `isolation:${log.id}`,
              `cards share one working directory — ${result.reason}`,
              undefined,
              "done",
            )
          }
        }
      }
      await measured(
        decision.assignments.map((assignment) => assignment.card),
        () =>
          pool(decision.assignments, oneAtATime ? 1 : limit, controller.signal, async (assignment) => {
            const child = nodes.get(assignment.card)!
            // A critic judges from a session it has never used before. Reusing one
            // would let it read its own earlier verdicts, and a critic that has
            // watched the work improve grades the improvement rather than the
            // work — which is the failure the separate critic exists to prevent.
            // It costs the cached prefix and re-sends the reference files, and
            // that is the price of the method.
            if (gauntlet && isCritic(child)) {
              abandon(child.id)
              consumed.delete(child.id)
            }
            declared.set(child.id, assignment.files ?? [])
            const answer = tree!.children(child.id).length
              ? await orchestrate(child, assignment.task, false)
              : await runSubagent(child, node, assignment.task)
            results.push(
              answer === undefined
                ? { card: assignment.card, error: entry(assignment.card).error ?? "the card produced nothing" }
                : { card: assignment.card, text: answer },
            )
          }),
      )
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
          .catch(() => ({ merged: [], empty: [], conflicts: [], stats: [] }))
        // An isolated card is the one card whose line count needs no
        // attributing: it had a tree to itself, so its branch is its work.
        for (const stat of report.stats ?? [])
          patch(stat.card, {
            diff: addDiff(entry(stat.card).diff, { added: stat.added, removed: stat.removed, files: stat.files }),
          })
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
          // The scratch directory is where the critic was told to put its
          // diagnostics, so a write there is not the work changing.
          const wrote = exceptUnder(
            [child.id, ...descendants(child.id)].flatMap((id) => writesOf(events.get(id) ?? [], batchStarted)),
            scratchDir,
          )
          if (!wrote.length) continue
          const listed = wrote.map((write) => (write.probable ? `${write.path} (probable)` : write.path)).join(", ")
          const error = `its verdict is discarded: a critic may not change the work it judges, and it wrote ${listed}`
          activity.note(
            child.id,
            `critic-wrote:${child.id}:${spent}`,
            "verdict discarded — the critic changed the work",
            listed,
            "error",
          )
          patch(child.id, { status: "error", error })
          results[index] = { card: result.card, error }
        }
        for (const result of results) {
          if (result.text !== undefined || !isCritic(nodes.get(result.card)!)) continue
          criticsLost++
          criticLoss = `${result.card}: ${result.error}`
        }
        if (decision.assignments.some((entry) => !isCritic(nodes.get(entry.card)!))) judged.clear()
        else for (const result of results) if (result.text !== undefined) judged.add(result.card)
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

      // The round, as something other than the model's account of it. Built
      // after the merge and the collision check so it carries what those found,
      // and before the stall decision, which is now measured off it.
      const round: LedgerRound = {
        card: node.id,
        round: spent,
        at: batchStarted,
        cards: decision.assignments.map((assignment) => {
          const answer = results.find((result) => result.card === assignment.card)
          return {
            card: assignment.card,
            ok: answer?.text !== undefined,
            // Only a card whose job was judging has a verdict. Every other
            // card's first line is a status report, and quoting one as a
            // verdict would put an opinion in the ledger nobody asked for.
            ...(answer?.text !== undefined && isCritic(nodes.get(assignment.card)!)
              ? { verdict: verdictSummary(answer.text) }
              : {}),
          }
        }),
        ...batchLines(
          decision.assignments.map((assignment) => assignment.card),
          linesBefore,
        ),
        ...(collisions.length ? { collisions: collisions.map((collision) => collision.path) } : {}),
      }
      // Committed after the ledger entry is built, so the ref is recorded on
      // the round it belongs to. Numbered by the run's rounds rather than this
      // orchestrator's: two orchestrators both dispatching a third time would
      // otherwise write the same ref.
      const saved = await deps.checkpoint?.(log.id, rounds.length + 1).catch(() => null)
      if (saved) round.ref = saved.ref
      rounds.push(round)
      log.rounds = rounds
      // The last round a critic passed. Recorded as the run goes, because the
      // state it names is what the tree looked like then and the ref is the
      // only thing that still knows.
      const best = bestRound(rounds)
      log.best = best ? { round: best.round, card: best.card, ref: best.ref } : undefined

      const stop = exhausted(spent, stalledRounds(rounds, node.id))
      forced = stop
      if (stop) activity.note(node.id, `bound:${node.id}:${spent}`, "told to answer", stop.error, "done")
      const status = gauntlet ? spentSoFar() : undefined
      const history = ledgerNote(rounds, node.id)
      build = () =>
        [
          dispatchResultPrompt(pipeline, results, stop ? 0 : budget - spent, status),
          // Before the collision note: a conflict is work that is definitely
          // not on disk, while a collision is work that may have been
          // overwritten. The certain finding leads.
          ...(mergeNotice ? [mergeNotice] : []),
          ...(collided ? [collided] : []),
          // What its own rounds have produced. After the findings about this
          // batch, because it is context for the next decision rather than
          // something that happened just now.
          ...(history ? [history] : []),
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
  /**
   * Lines this batch changed: each card's total now, less what it had before.
   *
   * A card dispatched three times carries its running total on `diff`, so the
   * subtraction is what makes a round's number the round's own. Undefined when
   * nothing was measured — a project off git, or a host with no measurement —
   * because a round that changed nothing and a round nobody could measure are
   * different facts, and the ledger reads them differently.
   */
  function batchLines(cards: string[], before: Map<string, CardDiff | undefined>) {
    const now = cards.map((card) => entry(card).diff)
    if (now.every((diff) => !diff) && [...before.values()].every((diff) => !diff)) return {}
    const sum = (pick: (diff: CardDiff) => number) =>
      cards.reduce((total, card) => {
        const after = entry(card).diff
        const was = before.get(card)
        return total + (after ? pick(after) : 0) - (was ? pick(was) : 0)
      }, 0)
    return { added: sum((diff) => diff.added), removed: sum((diff) => diff.removed), files: sum((diff) => diff.files) }
  }

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
  function exhausted(spent: number, stalled: number) {
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

    // Measured off the ledger rather than off the batch text: the check this
    // replaces compared consecutive dispatches as strings, so a task reworded
    // by one word read as fresh work and a run could hand out the same job for
    // as long as it kept renaming it.
    if (stalled >= gauntlet.stall)
      return {
        reason: `Your last ${stalled + 1} rounds changed nothing measurable — no lines, the same cards, the same outcomes. Answer with what you have.`,
        error: `${stalled + 1} rounds in a row changed nothing measurable`,
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
    // Skipped when the channel is switched off for the run (`toolChannel`): the
    // host then offers no dispatch tools, and every scan would be a request per
    // turn that cannot find anything. See `MCP_REACHES_SESSIONS`.
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
    dispatches.set(node.id, (dispatches.get(node.id) ?? 0) + 1)
    const returning = nodeSession.has(node.id)
    const critic = gauntlet && isCritic(node)
    await runTurn(
      node,
      (skipped) =>
        returning
          ? reassignPrompt(task)
          : critic
            ? // A critic judges; it is never uplifted, and never given memory
              // that could colour the verdict.
              criticPrompt(pipeline, node, parent, task, input, skipped)
            : subagentSections(pipeline, node, parent, task, input, skipped),
      true,
    )
    remember(node)
    if (failed.has(node.id)) return undefined
    return outputs.get(node.id)
  }

  const parentOf = (id: string) => pipeline.nodes.find((entry) => tree!.children(entry.id).includes(id))

  /**
   * The verification pass: the gauntlet's critic, generalised to any mode.
   *
   * Runs after the scheduler, so it needs to know nothing about which one ran —
   * only what the run produced. That is the cards nothing reads: a pipeline's
   * last layer, a swarm's synthesizer, an orchestration's root.
   *
   * Three rules are carried over from the gauntlet, each because dropping it
   * was measured to break the method there. The critic gets a **new session**,
   * so it grades the work rather than its own memory of the work improving —
   * which in a pipeline also means the reviewer card that already ran in its
   * layer comes to this with clean eyes. Critics run **one at a time**, because
   * judging means running the build and the tests in the one working directory
   * this fork has, and two at once grade each other's half-built output. And
   * the critic is told to inspect the **real output**, never the summary it is
   * shown.
   *
   * The card's own answer is put back afterwards. In a pipeline the reviewer's
   * message was read by the cards downstream of it during the run, and the log
   * is the only record of what they were given; overwriting it with the verdict
   * would lose that to save a field.
   */
  async function verifyRun() {
    const terminal = tree
      ? [tree.root.id]
      : swarm
        ? swarm.synthesizers.map((node) => node.id)
        : pipeline.nodes.filter((node) => !downstream(pipeline, node.id).length).map((node) => node.id)
    const result = terminal
      .map((id) => outputs.get(id))
      .filter((text): text is string => !!text?.trim())
      .join("\n\n")

    for (const critic of verifiers) {
      if (controller.signal.aborted) return
      const before = outputs.get(critic.id)
      // A verdict on work the critic itself helped produce is the failure the
      // fresh session exists to prevent, and in a pipeline the reviewer has
      // usually just run.
      abandon(critic.id)
      consumed.delete(critic.id)
      activity.note(critic.id, `verify:${critic.id}`, "verifying the run's result", undefined, "done")

      let asked = false
      while (true) {
        await runTurn(
          critic,
          (skipped) => (asked ? verdictPrompt() : verifyPrompt(pipeline, critic, result, skipped)),
          asked,
        )
        if (failed.has(critic.id) || controller.signal.aborted) return
        const verdict = verdictIn(outputs.get(critic.id) ?? "")
        // Asked once more for the line alone. A critic that has done the
        // looking and written the reasoning is one line short of an answer, and
        // throwing that away costs the whole pass.
        if (verdict.kind === "unreadable" && !asked) {
          asked = true
          continue
        }
        if (before !== undefined) {
          outputs.set(critic.id, before)
          patch(critic.id, { output: before })
        }
        log.verdict = {
          card: critic.id,
          kind: verdict.kind,
          ...(verdict.kind === "fail" ? { reason: verdict.reason } : {}),
        }
        activity.note(
          critic.id,
          `verdict:${critic.id}`,
          verdict.kind === "pass"
            ? "verified — the run met the bar"
            : verdict.kind === "fail"
              ? "the run did not meet the bar"
              : "the verifier wrote no verdict",
          verdict.kind === "fail" ? verdict.reason : undefined,
          verdict.kind === "pass" ? "done" : "error",
        )
        // The first card to withhold a pass decides the run. Paying the rest to
        // agree changes nothing, and the reason a person needs is already here.
        if (verdict.kind !== "pass") return
        break
      }
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

      // Opened once, before anything is dispatched, so every card's first turn
      // can carry it. A host that cannot make one simply never mentions it.
      scratchDir = (await deps.scratch?.(log.id).catch(() => null))?.path ?? ""

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
          around: measured,
          peer: (id, round) => runPeer(nodes.get(id)!, round, said),
          synthesise: () =>
            runTurn(swarm.synthesizers[0], (skipped) =>
              synthesisSections(pipeline, swarm.synthesizers[0], outputs, input, skipped),
            ).then(() => {
              remember(swarm.synthesizers[0])
              abandon(swarm.synthesizers[0].id)
            }),
        })
      else if (tree) await orchestrate(tree.root, input, true)
      else await runPipeline(validation.layers, limit, controller.signal, (id) => runNode(nodes.get(id)!), measured)
      // A card nobody dispatched never ran, and "queued" would read as though
      // the run had stopped short of it. It was simply not needed. Through
      // `patch` rather than onto the log directly, or the canvas card keeps
      // saying "queued" while the run log and statusbar say "skipped".
      if (tree) for (const node of log.nodes) if (node.status === "queued") patch(node.id, { status: "skipped" })
      // The cards are finished; now something looks at what they produced. Only
      // on a run that actually completed: a run with a failed card has already
      // reported the truth about itself, and paying a critic to confirm it is
      // the one verdict nobody needs.
      if (verify && !controller.signal.aborted && !log.nodes.some((node) => node.status === "error")) await verifyRun()
      log.status = controller.signal.aborted
        ? "stopped"
        : log.nodes.some((node) => node.status === "error")
          ? "error"
          : // A run that did what it was asked for badly, or that nobody could
            // confirm did it at all, has not succeeded — reporting `done` here
            // is the exact thing verification was turned on to prevent.
            log.verdict && log.verdict.kind !== "pass"
            ? "error"
            : "done"
    } catch (error) {
      log.status = "error"
      hooks.onNotice?.("error", api.describe(error))
    } finally {
      for (const node of log.nodes) if (node.status === "queued" || node.status === "running") node.status = "stopped"
      log.finished = Date.now()
      log.usage = mergeSpend(log.nodes.map((node) => node.usage))
      // Every card's work was folded back in after its own batch, so what is
      // left here is empty checkouts and `openflow/*` branches nobody reads.
      // Done in `finally` because an aborted or failed run leaves the most of
      // them, and a stack of stale worktrees in the user's repository is the
      // thing that would make this feature not worth having.
      if (opened.size && deps.worktrees) await deps.worktrees.cleanup(log.id, [...opened.values()]).catch(() => {})
      // Every session the run still holds goes back to the host: the processes
      // are the host's to dispose, and a run that ended leaves nothing for them
      // to wait on. Memory writes are given a moment to land so the log shows
      // what became of them, but never longer than that.
      for (const sessionID of [...held]) release(sessionID)
      if (background.size) {
        const grace = Promise.withResolvers<void>()
        const timer = setTimeout(grace.resolve, backgroundGrace)
        await Promise.race([Promise.allSettled([...background]), grace.promise])
        clearTimeout(timer)
      }
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

/**
 * The host answered 404 to a permission or question reply: the request was
 * already withdrawn or settled, so there is nothing left to answer.
 */
function gone(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404
}

class StopError extends Error {
  constructor() {
    super("stopped")
  }
}

/** Prompt Uplift failed and the card was not allowed to run on the original. */
class UpliftError extends Error {
  constructor(reason: string) {
    super(`prompt uplift failed: ${reason}`)
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
  /**
   * Wraps each layer, so a caller can measure what the whole layer did to the
   * working tree. A layer is the boundary because its nodes run at once in one
   * directory — see `measured` in `run`.
   */
  around: (ids: string[], work: () => Promise<void>) => Promise<void> = (_, work) => work(),
) {
  for (const ids of layers) {
    if (signal.aborted) return
    await around(ids, () => pool(ids, limit, signal, run))
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
    /** Wraps a round, so the caller can measure what it did to the working tree. */
    around: (ids: string[], work: () => Promise<void>) => Promise<void>
  },
) {
  for (let round = 1; round <= rounds; round++) {
    if (signal.aborted) return
    step.round(round)
    await step.around(step.peers, () => pool(step.peers, limit, signal, (id) => step.peer(id, round)))
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

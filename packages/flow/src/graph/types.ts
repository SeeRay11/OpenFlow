export type NodeStatus = "idle" | "queued" | "running" | "done" | "error" | "skipped" | "stopped"

/**
 * How a canvas executes.
 *
 * A mode belongs to the whole document, not to a region of it: modes do not
 * nest, so one graph is one mode and every card in it plays by the same rules.
 *
 * - `pipeline` — topological layers. A card's final message is pasted into the
 *   prompt of every card wired downstream of it.
 * - `swarm` — every agent card is a peer of every other. They answer the same
 *   task in parallel over a fixed number of rounds, reading each other's last
 *   round in between, and a synthesizer card writes the verdict.
 * - `orchestration` — one orchestrator card dispatches tasks to the subagent
 *   cards below it, reads what they returned, and dispatches again until it
 *   answers. A subagent with children orchestrates its own subtree.
 */
export type FlowMode = "pipeline" | "swarm" | "orchestration"

export const MODES: FlowMode[] = ["pipeline", "swarm", "orchestration"]

/**
 * A file handed to a session alongside the prompt text.
 *
 * `url` is a `data:` URL — the whole file, inline. That is what the server
 * accepts as a prompt attachment, and it keeps the browser from needing an
 * upload endpoint or a path on the host it cannot see.
 */
export type Attachment = {
  id: string
  name: string
  mime: string
  url: string
  size: number
}

export type FlowAgent = {
  /** Existing opencode agent to run this node as. Empty = server default. */
  name?: string
  /** "providerID/modelID". Empty = agent/server default. */
  model?: string
  /** Role instructions, prepended to every prompt this node sends. */
  prompt: string
  /** Tool allowlist written into the generated agent config. */
  tools?: Record<string, boolean>
  /**
   * MCP servers this node may use, by config name. `undefined` means the node
   * was authored before per-node MCP existed and inherits whatever the server
   * offers; an empty array means "none", which is a different thing.
   */
  mcp?: string[]
  /** Files pinned to this node, sent with every run. */
  attachments?: Attachment[]
}

export type FlowNode = {
  id: string
  role: string
  agent: FlowAgent
  position: { x: number; y: number }
}

export type FlowEdge = {
  id: string
  source: string
  target: string
}

export type Pipeline = {
  id: string
  name: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  /**
   * How this canvas runs. Absent means `pipeline` — every canvas saved before
   * modes existed, which is why this is optional rather than defaulted at
   * write time.
   */
  mode?: FlowMode
  /**
   * Swarm only: how many rounds of peer exchange before the synthesizer runs.
   * Part of the document rather than the run because it is what the swarm *is*
   * — the briefing tells every agent which round it is on and how many remain.
   */
  rounds?: number
  /**
   * Orchestration only: how many dispatch levels may sit below the root, and
   * how many times one orchestrator may dispatch before it has to answer. Both
   * are caps on the same thing — how many sessions a run can talk itself into.
   */
  depth?: number
  dispatches?: number
}

export type PermissionDecision = {
  requestID: string
  action: string
  resources: string[]
  reply: "once" | "always" | "reject"
  policy: "auto" | "manual"
  at: number
}

export type QuestionExchange = {
  requestID: string
  /** Question headers, in the order they were asked. */
  headers: string[]
  /** One array of chosen labels per question, or undefined when rejected. */
  answers?: string[][]
  rejected?: boolean
  at: number
}

/**
 * Token counts exactly as `opencode serve` reported them for a settled step.
 *
 * `input` excludes cached tokens (they are counted under `cacheRead` /
 * `cacheWrite`) and `output` excludes reasoning, matching the server's own
 * normalisation. Nothing here is estimated locally.
 */
export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** One settled assistant step: which model ran, and what it reported using. */
export type StepUsage = {
  /** Assistant message the step belongs to — the dedupe key. */
  messageID: string
  /** "providerID/modelID" the step actually ran on, per the server. */
  model: string
  tokens: TokenTotals
}

export type ModelSpend = {
  model: string
  provider: string
  tokens: TokenTotals
  steps: number
  /** False when the catalog quotes no price for this model. Not "free". */
  priced: boolean
  /** USD, or undefined when unpriced — never 0 as a stand-in for unknown. */
  cost?: number
}

export type Spend = {
  /** USD across every *priced* model. A floor when `unpriced` is non-empty. */
  cost: number
  tokens: TokenTotals
  steps: number
  models: ModelSpend[]
  /** Models that used tokens the catalog quotes no price for. */
  unpriced: string[]
}

/**
 * One thing that happened inside a node's session, in the order it happened.
 *
 * This is the card's thought process: the model's text as it streams, the tools
 * it calls with their input and result, and the subagents it spawns. Events are
 * *upserted* by `id` rather than appended — a streaming text part and a tool
 * call each arrive as a start, a run of deltas and an end, and all of that is
 * one row on screen, not three hundred.
 */
export type NodeEvent = {
  /** The server's own `textID` / `reasoningID` / `callID`, prefixed by kind. */
  id: string
  at: number
  kind: "text" | "reasoning" | "tool" | "step" | "note"
  /** 0 for the node's own session; 1+ for a subagent it spawned. */
  depth: number
  /** Session that produced it — the node's own, or a child session. */
  sessionID?: string
  /** The `task` call a spawned subagent's events belong under. */
  parentCallID?: string
  status?: "running" | "done" | "error"
  /** One line: the tool and its arguments, the model, the note. */
  title: string
  /** Tool input, as sent. */
  input?: string
  /** Streamed text, tool output, or an error message. */
  body?: string
}

export type RunNodeLog = {
  id: string
  role: string
  status: NodeStatus
  sessionID?: string
  permissions?: PermissionDecision[]
  questions?: QuestionExchange[]
  /** Attachment names actually sent, and those the model could not read. */
  attachments?: { sent: string[]; skipped: string[] }
  model?: string
  agent?: string
  prompt?: string
  output?: string
  error?: string
  started?: number
  finished?: number
  /**
   * Carried over from an earlier run rather than produced by this one, so it
   * cost nothing here. Set when a re-run reuses the output of a node that had
   * already finished — without it the only clue is the absence of a sessionID.
   */
  reused?: boolean
  /** What this node's session reported using, priced. */
  usage?: Spend
  /** Per-step usage behind `usage`, kept so a run log can be re-priced later. */
  steps?: StepUsage[]
  /**
   * The tail of this node's activity, capped and with long bodies clipped, so a
   * reopened run still replays what the card did rather than only what it said.
   */
  events?: NodeEvent[]
}

export type RunLog = {
  id: string
  pipeline: string
  pipelineID: string
  input: string
  /** Names of the files attached to the run itself. Contents are not recorded. */
  attachments?: string[]
  status: "running" | "done" | "error" | "stopped"
  started: number
  finished?: number
  nodes: RunNodeLog[]
  /** Every node's usage, summed. */
  usage?: Spend
}

export function emptyPipeline(name = "untitled"): Pipeline {
  return { id: crypto.randomUUID(), name, nodes: [], edges: [] }
}

/**
 * The mode a pipeline runs in, normalised.
 *
 * Anything unrecognised reads as `pipeline`: a store file hand-edited to a mode
 * this build has never heard of should open as the safest graph there is, not
 * fall through a `switch` into whichever scheduler happens to be last.
 */
export function modeOf(pipeline: Pipeline): FlowMode {
  return MODES.includes(pipeline.mode as FlowMode) ? (pipeline.mode as FlowMode) : "pipeline"
}

export const DEFAULT_ROUNDS = 3
/**
 * A swarm costs `agents × rounds + 1` sessions, so rounds is the multiplier on
 * the whole bill. Six is already 25 sessions for a four-agent swarm; past that
 * the agents are repeating themselves and the run is just expensive.
 */
export const MAX_ROUNDS = 6

/** How many rounds a swarm runs, clamped to what the engine will dispatch. */
export function roundsOf(pipeline: Pipeline) {
  return clamp(pipeline.rounds, DEFAULT_ROUNDS, MAX_ROUNDS)
}

export const DEFAULT_DEPTH = 2
/**
 * Depth is the exponent on an orchestration's bill: each level multiplies by
 * however many children a card has. Four levels of a four-way fan-out is 340
 * sessions, which is not a run anybody meant to start.
 */
export const MAX_DEPTH = 4

export const DEFAULT_DISPATCHES = 3
/**
 * How many times one orchestrator may dispatch before it is made to answer.
 * Without a cap, "that was not quite right, try again" is an unbounded loop
 * that reads as progress the whole way down.
 */
export const MAX_DISPATCHES = 6

/** How deep an orchestration's subagent tree may go. A lone orchestrator is 0. */
export function depthOf(pipeline: Pipeline) {
  return clamp(pipeline.depth, DEFAULT_DEPTH, MAX_DEPTH)
}

/** How many dispatch rounds one orchestrator gets before it must answer. */
export function dispatchesOf(pipeline: Pipeline) {
  return clamp(pipeline.dispatches, DEFAULT_DISPATCHES, MAX_DISPATCHES)
}

/**
 * A hand-edited store file must not be able to talk the engine into a bigger
 * run than the UI can ask for, so every budget is clamped where it is read
 * rather than trusted where it was written.
 */
function clamp(value: number | undefined, fallback: number, max: number) {
  const rounded = Math.floor(value ?? fallback)
  if (!Number.isFinite(rounded)) return fallback
  return Math.min(max, Math.max(1, rounded))
}

import { createStore, produce, reconcile } from "solid-js/store"
import { nodeModel } from "./graph/default-model"
import { ROLES, role } from "./graph/roles"
import type {
  Attachment,
  FlowNode,
  NodeEvent,
  NodeStatus,
  Pipeline,
  RunLog,
  RunNodeLog,
  Spend,
} from "./graph/types"
import { applyEvent } from "./server/activity"
import type { QuestionInfo } from "./server/client"
import { emptyPipeline, modeOf, type FlowMode, type Gauntlet } from "./graph/types"
import { pathThrough, wouldCycle } from "./graph/validate"

export type NodeRuntime = {
  status: NodeStatus
  sessionID?: string
  output?: string
  error?: string
  prompt?: string
  activity?: string
  started?: number
  finished?: number
  /** Priced token usage for this node's session. */
  usage?: Spend
  /** What the card has done, in order — see `NodeEvent`. */
  events?: NodeEvent[]
}

export type PendingPermission = {
  requestID: string
  nodeID: string
  role: string
  action: string
  resources: string[]
}

export type PendingQuestion = {
  requestID: string
  nodeID: string
  role: string
  questions: QuestionInfo[]
}

export type FlowState = {
  pipeline: Pipeline
  /**
   * Cards the user has selected, in the order they were added.
   *
   * The last entry is the primary: the inspector has to show somebody's current
   * value while editing many cards at once, and the last card pointed at is the
   * one the user was just looking at.
   */
  selection: string[]
  /** Node whose activity drawer is open. Independent of selection. */
  expanded?: string
  runtime: Record<string, NodeRuntime>
  run?: RunLog
  running: boolean
  input: string
  /** Files attached to the run itself, offered to every node's first prompt. */
  attachments: Attachment[]
  notice?: { kind: "info" | "error"; text: string }
  permissions: PendingPermission[]
  questions: PendingQuestion[]
  /** Graph edits made since the last load or save — what a replace would destroy. */
  dirty: boolean
  /**
   * Whether `opencode serve` answered the last time anything asked it.
   *
   * The single source of truth for engine reachability. With the engine down
   * every provider read comes back empty, and every surface that reads a model
   * list would otherwise conclude "no provider is connected" — confidently and
   * wrongly. Optimistic until the first probe lands, which is milliseconds.
   */
  engineReachable: boolean
}

const [state, setState] = createStore<FlowState>({
  pipeline: emptyPipeline("untitled"),
  selection: [],
  runtime: {},
  running: false,
  input: "",
  attachments: [],
  permissions: [],
  questions: [],
  dirty: false,
  engineReachable: true,
})

export { state }

/** The card the inspector reads and single-card actions act on. */
export function primary() {
  return state.selection[state.selection.length - 1]
}

/** Resolvers live outside the store — they are callbacks, not state. */
const waiting = new Map<string, (reply: PermissionReply) => void>()
type PermissionReply = "once" | "always" | "reject"

/** Same idea for questions: `undefined` is a rejection, not an empty answer. */
const asking = new Map<string, (answers: string[][] | undefined) => void>()

let counter = 0
function nodeID() {
  counter += 1
  return `n${Date.now().toString(36)}${counter.toString(36)}`
}

/**
 * Bounded snapshot stack behind Ctrl/Cmd+Z.
 *
 * Only graph-shaping edits push. Deleting a card takes its hand-written prompt,
 * model, tool allowlist, MCP allowlist and attachments with it and there is no
 * other way back — a confirm on every keypress would be the wrong fix. Field
 * edits deliberately do not push: they would flood the stack a keystroke at a
 * time and bury the delete this exists to reverse.
 *
 * Kept out of the store because nothing renders it, and cloned through JSON
 * because a pipeline is exactly what the store persists as JSON.
 */
const history: Pipeline[] = []
const HISTORY_LIMIT = 20

function snapshot() {
  history.push(JSON.parse(JSON.stringify(state.pipeline)) as Pipeline)
  if (history.length > HISTORY_LIMIT) history.shift()
}

export const actions = {
  notice(kind: "info" | "error", text: string) {
    setState("notice", { kind, text })
  },

  clearNotice() {
    setState("notice", undefined)
  },

  addNode(roleID: string, position: { x: number; y: number }) {
    snapshot()
    setState("dirty", true)
    const preset = role(roleID) ?? ROLES[ROLES.length - 1]
    // A preset with no model of its own inherits the default model preference,
    // but only when that model is actually runnable now (see `nodeModel`).
    const model = nodeModel(preset.agent.model)
    const node: FlowNode = {
      id: nodeID(),
      role: preset.label,
      agent: { ...preset.agent, model, tools: { ...(preset.agent.tools ?? {}) } },
      position,
    }
    setState("pipeline", "nodes", (nodes) => [...nodes, node])
    setState("selection", [node.id])
    return node
  },

  removeNode(id: string) {
    snapshot()
    setState("dirty", true)
    setState(
      produce((draft) => {
        draft.pipeline.nodes = draft.pipeline.nodes.filter((node) => node.id !== id)
        draft.pipeline.edges = draft.pipeline.edges.filter((edge) => edge.source !== id && edge.target !== id)
        delete draft.runtime[id]
        draft.selection = draft.selection.filter((entry) => entry !== id)
        if (draft.expanded === id) draft.expanded = undefined
      }),
    )
  },

  // No snapshot: a drag fires this on every pointermove, so it would fill the
  // undo stack with one entry per frame.
  moveNode(id: string, position: { x: number; y: number }) {
    setState("dirty", true)
    setState("pipeline", "nodes", (node) => node.id === id, "position", position)
  },

  updateNode(id: string, patch: Partial<FlowNode>) {
    setState("dirty", true)
    setState("pipeline", "nodes", (node) => node.id === id, patch)
  },

  updateAgent(id: string, patch: Partial<FlowNode["agent"]>) {
    setState("dirty", true)
    setState("pipeline", "nodes", (node) => node.id === id, "agent", patch)
  },

  toggleTool(id: string, tool: string, enabled: boolean) {
    setState("dirty", true)
    setState("pipeline", "nodes", (node) => node.id === id, "agent", "tools", (tools) => ({
      ...(tools ?? {}),
      [tool]: enabled,
    }))
  },

  select(id?: string) {
    setState("selection", id ? [id] : [])
  },

  /** Ctrl/Cmd-click: adds a card to the selection, or drops it if it is in it. */
  toggleSelect(id: string) {
    setState("selection", (selection) =>
      selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id],
    )
  },

  /** Shift-click: the whole chain this card sits on. See `pathThrough`. */
  selectPath(id: string) {
    setState("selection", pathThrough(state.pipeline, id))
  },

  /** Marquee drag. Additive keeps what was already selected. */
  selectMany(ids: string[], additive = false) {
    setState("selection", (selection) => {
      const next = additive ? [...selection] : []
      for (const id of ids) if (!next.includes(id)) next.push(id)
      return next
    })
  },

  /**
   * Field edits fanned out over the selection.
   *
   * One card is the ordinary case and stays identical to it — the selection is
   * `[id]`. With several selected the same value lands on all of them, which is
   * the point: setting a model or a prompt card by card is the work this
   * exists to remove. Like every other field edit these do not snapshot.
   */
  updateSelected(patch: Partial<FlowNode>) {
    for (const id of state.selection) actions.updateNode(id, patch)
  },

  updateSelectedAgent(patch: Partial<FlowNode["agent"]>) {
    for (const id of state.selection) actions.updateAgent(id, patch)
  },

  toggleSelectedTool(tool: string, enabled: boolean) {
    for (const id of state.selection) actions.toggleTool(id, tool, enabled)
  },

  /**
   * Delete, and the inspector's delete button: every selected card at once.
   *
   * One snapshot for the whole set, not one per card — deleting four cards was
   * one action to the user, and four presses of undo to get them back would
   * also empty the bounded history of everything before it.
   */
  removeSelected() {
    const ids = new Set(state.selection)
    if (!ids.size) return
    snapshot()
    setState("dirty", true)
    setState(
      produce((draft) => {
        draft.pipeline.nodes = draft.pipeline.nodes.filter((node) => !ids.has(node.id))
        draft.pipeline.edges = draft.pipeline.edges.filter(
          (edge) => !ids.has(edge.source) && !ids.has(edge.target),
        )
        for (const id of ids) delete draft.runtime[id]
        draft.selection = []
        if (draft.expanded && ids.has(draft.expanded)) draft.expanded = undefined
      }),
    )
  },

  /** Opens (or closes, with no id) the activity drawer for one card. */
  expand(id?: string) {
    setState("expanded", id)
  },

  connect(source: string, target: string) {
    if (source === target) return false
    const exists = state.pipeline.edges.some((edge) => edge.source === source && edge.target === target)
    if (exists) return false
    if (wouldCycle(state.pipeline, source, target)) {
      actions.notice("error", "that connection would create a cycle")
      return false
    }
    snapshot()
    setState("dirty", true)
    setState("pipeline", "edges", (edges) => [
      ...edges,
      { id: `e${Date.now().toString(36)}${edges.length}`, source, target },
    ])
    return true
  },

  disconnect(id: string) {
    snapshot()
    setState("dirty", true)
    setState("pipeline", "edges", (edges) => edges.filter((edge) => edge.id !== id))
  },

  rename(name: string) {
    setState("dirty", true)
    setState("pipeline", "name", name)
  },

  /**
   * Switches how the whole canvas executes.
   *
   * Snapshotted like a graph-shaping edit rather than a field edit: the modes
   * disagree about what the edges mean, so this is the one setting that can
   * change what an existing graph does, and undo has to reach it.
   */
  setMode(mode: FlowMode) {
    if (modeOf(state.pipeline) === mode) return
    snapshot()
    setState("dirty", true)
    setState("pipeline", "mode", mode)
  },

  /** How many rounds a swarm debates for. Clamped where it is read, not here. */
  setRounds(rounds: number) {
    setState("dirty", true)
    setState("pipeline", "rounds", rounds)
  },

  /** How deep an orchestration's subagent tree may go. */
  setDepth(depth: number) {
    setState("dirty", true)
    setState("pipeline", "depth", depth)
  },

  /** How many times one orchestrator may dispatch before it has to answer. */
  setDispatches(dispatches: number) {
    setState("dirty", true)
    setState("pipeline", "dispatches", dispatches)
  },

  /**
   * Turns the gauntlet on or off.
   *
   * Snapshotted like `setMode`, and for the same reason: it changes what the
   * graph the user already drew will do — the dispatch budget stops applying
   * and the run keeps going until it runs out of money or time — so undo has to
   * reach it. Off removes the key rather than leaving a dead flag, but the
   * settings survive the round trip in `history` if it is undone.
   */
  setGauntlet(on: boolean) {
    if (!!state.pipeline.gauntlet === on) return
    snapshot()
    setState("dirty", true)
    setState("pipeline", "gauntlet", on ? {} : undefined)
  },

  /** One gauntlet field. Clamped where it is read, not here. */
  setGauntletSetting(patch: Partial<Gauntlet>) {
    if (!state.pipeline.gauntlet) return
    setState("dirty", true)
    setState("pipeline", "gauntlet", (current) => ({ ...current, ...patch }))
  },

  /**
   * Restores the last snapshot. Selection and the drawer are dropped rather
   * than guessed: whatever they pointed at may be the node coming back.
   */
  undo() {
    const previous = history.pop()
    if (!previous) return false
    setState(
      produce((draft) => {
        draft.pipeline = previous
        draft.dirty = true
        draft.selection = []
        draft.expanded = undefined
      }),
    )
    return true
  },

  load(pipeline: Pipeline) {
    migrateAgentNames(pipeline)
    // Snapshots of the graph being replaced would undo into a different
    // pipeline, so loading starts a fresh history.
    history.length = 0
    setState(
      produce((draft) => {
        draft.pipeline = pipeline
        draft.runtime = {}
        draft.run = undefined
        draft.selection = []
        draft.expanded = undefined
        draft.dirty = false
      }),
    )
  },

  reset() {
    actions.load(emptyPipeline("untitled"))
  },

  /** Called once a save lands, so the next replace or reload stops asking. */
  markSaved() {
    setState("dirty", false)
  },

  /** For work that arrives already unsaved — an import has no file here yet. */
  markDirty() {
    setState("dirty", true)
  },

  setEngineReachable(reachable: boolean) {
    setState("engineReachable", reachable)
  },

  setInput(input: string) {
    setState("input", input)
  },

  setRunning(running: boolean) {
    setState("running", running)
  },

  setRun(run?: RunLog) {
    setState("run", run ? reconcile(run) : undefined)
  },

  patchRuntime(id: string, patch: Partial<NodeRuntime>) {
    setState(
      produce((draft) => {
        draft.runtime[id] = { ...(draft.runtime[id] ?? { status: "idle" }), ...patch }
      }),
    )
  },

  /**
   * Upserts one activity row. Rows arrive many times as they stream, keyed by
   * `event.id`, so this replaces in place rather than appending.
   */
  pushEvent(id: string, event: NodeEvent) {
    setState(
      produce((draft) => {
        const runtime = (draft.runtime[id] ??= { status: "idle" })
        runtime.events = applyEvent(runtime.events ?? [], event)
      }),
    )
  },

  /** Shows a permission request and resolves once someone answers it. */
  askPermission(request: PendingPermission) {
    return new Promise<PermissionReply>((resolve) => {
      waiting.set(request.requestID, resolve)
      setState("permissions", (pending) => [...pending, request])
    })
  },

  answerPermission(requestID: string, reply: PermissionReply) {
    waiting.get(requestID)?.(reply)
    waiting.delete(requestID)
    setState("permissions", (pending) => pending.filter((request) => request.requestID !== requestID))
  },

  /** Files attached to the run itself. */
  addAttachments(files: Attachment[]) {
    if (!files.length) return
    setState("attachments", (current) => [...current, ...files])
  },

  removeAttachment(id: string) {
    setState("attachments", (current) => current.filter((file) => file.id !== id))
  },

  clearAttachments() {
    setState("attachments", [])
  },

  /** Files pinned to one node, sent with that node's prompt on every run. */
  addNodeAttachments(id: string, files: Attachment[]) {
    if (!files.length) return
    setState("dirty", true)
    setState("pipeline", "nodes", (node) => node.id === id, "agent", "attachments", (current) => [
      ...(current ?? []),
      ...files,
    ])
  },

  removeNodeAttachment(id: string, attachmentID: string) {
    setState("dirty", true)
    setState("pipeline", "nodes", (node) => node.id === id, "agent", "attachments", (current) =>
      (current ?? []).filter((file) => file.id !== attachmentID),
    )
  },

  /**
   * Which MCP servers a node may use. Writing the array — even empty — is what
   * moves the node from "inherits everything" to an explicit allowlist.
   */
  toggleMcp(id: string, server: string, enabled: boolean, all: string[]) {
    setState("dirty", true)
    setState("pipeline", "nodes", (node) => node.id === id, "agent", "mcp", (current) => {
      const base = current ?? all
      const next = new Set(base)
      if (enabled) next.add(server)
      else next.delete(server)
      return [...next]
    })
  },

  /** Shows a question from an agent and resolves once someone answers or rejects it. */
  askQuestion(request: PendingQuestion) {
    return new Promise<string[][] | undefined>((resolve) => {
      asking.set(request.requestID, resolve)
      setState("questions", (pending) => [...pending, request])
    })
  },

  answerQuestion(requestID: string, answers: string[][] | undefined) {
    asking.get(requestID)?.(answers)
    asking.delete(requestID)
    setState("questions", (pending) => pending.filter((request) => request.requestID !== requestID))
  },

  rejectQuestions() {
    for (const [requestID, resolve] of asking) {
      resolve(undefined)
      asking.delete(requestID)
    }
    setState("questions", [])
  },

  /** Stopping a run must not leave the UI holding unanswered prompts. */
  rejectPermissions() {
    for (const [requestID, resolve] of waiting) {
      resolve("reject")
      waiting.delete(requestID)
    }
    setState("permissions", [])
  },

  resetRuntime(statuses: Record<string, NodeStatus>) {
    setState(
      produce((draft) => {
        draft.runtime = {}
        for (const [id, status] of Object.entries(statuses)) draft.runtime[id] = { status }
      }),
    )
  },
}

export function runtimeOf(id: string): NodeRuntime {
  return state.runtime[id] ?? { status: "idle" }
}

export function runNodeLogs(): RunNodeLog[] {
  return state.run?.nodes ?? []
}

/**
 * Repairs generated agent names saved before the key gained the node id.
 *
 * The key used to be `<pipeline>-<role>`, so two nodes of the same role shared
 * one agent and one permission set. Pipelines saved then still name the old
 * key, and the server has no such agent, so the run aborts with "the server
 * does not know an agent named …" — correct, but a dead end for a file the user
 * did nothing wrong to.
 *
 * Only a name this app is known to have generated is touched. An agent the user
 * picked themselves does not match the old shape and is left exactly as it is.
 */
function migrateAgentNames(pipeline: Pipeline) {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase()
  for (const node of pipeline.nodes) {
    if (!node.agent?.name) continue
    if (node.agent.name !== sanitize(`${pipeline.name}-${node.role}`)) continue
    node.agent.name = sanitize(`${pipeline.name}-${node.role}-${node.id}`)
  }
}

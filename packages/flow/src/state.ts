import { createStore, produce, reconcile } from "solid-js/store"
import { ROLES, role } from "./graph/roles"
import type { Attachment, FlowNode, NodeStatus, Pipeline, RunLog, RunNodeLog } from "./graph/types"
import type { QuestionInfo } from "./server/client"
import { emptyPipeline } from "./graph/types"
import { wouldCycle } from "./graph/validate"

export type NodeRuntime = {
  status: NodeStatus
  sessionID?: string
  output?: string
  error?: string
  prompt?: string
  activity?: string
  started?: number
  finished?: number
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
  selected?: string
  runtime: Record<string, NodeRuntime>
  run?: RunLog
  running: boolean
  input: string
  /** Files attached to the run itself, offered to every node's first prompt. */
  attachments: Attachment[]
  notice?: { kind: "info" | "error"; text: string }
  permissions: PendingPermission[]
  questions: PendingQuestion[]
}

const [state, setState] = createStore<FlowState>({
  pipeline: emptyPipeline("untitled"),
  runtime: {},
  running: false,
  input: "",
  attachments: [],
  permissions: [],
  questions: [],
})

export { state }

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

export const actions = {
  notice(kind: "info" | "error", text: string) {
    setState("notice", { kind, text })
  },

  clearNotice() {
    setState("notice", undefined)
  },

  addNode(roleID: string, position: { x: number; y: number }) {
    const preset = role(roleID) ?? ROLES[ROLES.length - 1]
    const node: FlowNode = {
      id: nodeID(),
      role: preset.label,
      agent: { ...preset.agent, tools: { ...(preset.agent.tools ?? {}) } },
      position,
    }
    setState("pipeline", "nodes", (nodes) => [...nodes, node])
    setState("selected", node.id)
    return node
  },

  removeNode(id: string) {
    setState(
      produce((draft) => {
        draft.pipeline.nodes = draft.pipeline.nodes.filter((node) => node.id !== id)
        draft.pipeline.edges = draft.pipeline.edges.filter((edge) => edge.source !== id && edge.target !== id)
        delete draft.runtime[id]
        if (draft.selected === id) draft.selected = undefined
      }),
    )
  },

  moveNode(id: string, position: { x: number; y: number }) {
    setState("pipeline", "nodes", (node) => node.id === id, "position", position)
  },

  updateNode(id: string, patch: Partial<FlowNode>) {
    setState("pipeline", "nodes", (node) => node.id === id, patch)
  },

  updateAgent(id: string, patch: Partial<FlowNode["agent"]>) {
    setState("pipeline", "nodes", (node) => node.id === id, "agent", patch)
  },

  toggleTool(id: string, tool: string, enabled: boolean) {
    setState("pipeline", "nodes", (node) => node.id === id, "agent", "tools", (tools) => ({
      ...(tools ?? {}),
      [tool]: enabled,
    }))
  },

  select(id?: string) {
    setState("selected", id)
  },

  connect(source: string, target: string) {
    if (source === target) return false
    const exists = state.pipeline.edges.some((edge) => edge.source === source && edge.target === target)
    if (exists) return false
    if (wouldCycle(state.pipeline, source, target)) {
      actions.notice("error", "that connection would create a cycle")
      return false
    }
    setState("pipeline", "edges", (edges) => [
      ...edges,
      { id: `e${Date.now().toString(36)}${edges.length}`, source, target },
    ])
    return true
  },

  disconnect(id: string) {
    setState("pipeline", "edges", (edges) => edges.filter((edge) => edge.id !== id))
  },

  rename(name: string) {
    setState("pipeline", "name", name)
  },

  load(pipeline: Pipeline) {
    setState(
      produce((draft) => {
        draft.pipeline = pipeline
        draft.runtime = {}
        draft.run = undefined
        draft.selected = undefined
      }),
    )
  },

  reset() {
    actions.load(emptyPipeline("untitled"))
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
    setState("pipeline", "nodes", (node) => node.id === id, "agent", "attachments", (current) => [
      ...(current ?? []),
      ...files,
    ])
  },

  removeNodeAttachment(id: string, attachmentID: string) {
    setState("pipeline", "nodes", (node) => node.id === id, "agent", "attachments", (current) =>
      (current ?? []).filter((file) => file.id !== attachmentID),
    )
  },

  /**
   * Which MCP servers a node may use. Writing the array — even empty — is what
   * moves the node from "inherits everything" to an explicit allowlist.
   */
  toggleMcp(id: string, server: string, enabled: boolean, all: string[]) {
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

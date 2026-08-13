import { createStore, produce, reconcile } from "solid-js/store"
import { ROLES, role } from "./graph/roles"
import type { FlowNode, NodeStatus, Pipeline, RunLog, RunNodeLog } from "./graph/types"
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

export type FlowState = {
  pipeline: Pipeline
  selected?: string
  runtime: Record<string, NodeRuntime>
  run?: RunLog
  running: boolean
  input: string
  notice?: { kind: "info" | "error"; text: string }
  permissions: PendingPermission[]
}

const [state, setState] = createStore<FlowState>({
  pipeline: emptyPipeline("untitled"),
  runtime: {},
  running: false,
  input: "",
  permissions: [],
})

export { state }

/** Resolvers live outside the store — they are callbacks, not state. */
const waiting = new Map<string, (reply: PermissionReply) => void>()
type PermissionReply = "once" | "always" | "reject"

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

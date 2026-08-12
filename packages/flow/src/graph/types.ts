export type NodeStatus = "idle" | "queued" | "running" | "done" | "error" | "skipped" | "stopped"

export type FlowAgent = {
  /** Existing opencode agent to run this node as. Empty = server default. */
  name?: string
  /** "providerID/modelID". Empty = agent/server default. */
  model?: string
  /** Role instructions, prepended to every prompt this node sends. */
  prompt: string
  /** Tool allowlist written into the generated agent config. */
  tools?: Record<string, boolean>
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
}

export type RunNodeLog = {
  id: string
  role: string
  status: NodeStatus
  sessionID?: string
  model?: string
  agent?: string
  prompt?: string
  output?: string
  error?: string
  started?: number
  finished?: number
}

export type RunLog = {
  id: string
  pipeline: string
  pipelineID: string
  input: string
  status: "running" | "done" | "error" | "stopped"
  started: number
  finished?: number
  nodes: RunNodeLog[]
}

export function emptyPipeline(name = "untitled"): Pipeline {
  return { id: crypto.randomUUID(), name, nodes: [], edges: [] }
}

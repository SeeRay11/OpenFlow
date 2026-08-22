export type NodeStatus = "idle" | "queued" | "running" | "done" | "error" | "skipped" | "stopped"

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
}

export function emptyPipeline(name = "untitled"): Pipeline {
  return { id: crypto.randomUUID(), name, nodes: [], edges: [] }
}

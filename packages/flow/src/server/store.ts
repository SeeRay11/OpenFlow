import type { Pipeline, RunLog } from "../graph/types"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/flow/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(body?.error ?? `${init?.method ?? "GET"} ${path} failed (${response.status})`)
  return body as T
}

export type PipelineEntry = { name: string; id?: string; nodes: number; updated: number }
export type RunEntry = { id: string; pipeline?: string; status?: string; started?: number; finished?: number }

export const store = {
  pipelines: () => request<PipelineEntry[]>("/pipelines"),
  pipeline: (name: string) => request<Pipeline>(`/pipelines/${encodeURIComponent(name)}`),
  savePipeline: (pipeline: Pipeline) =>
    request<{ path: string }>(`/pipelines/${encodeURIComponent(pipeline.name)}`, {
      method: "PUT",
      body: JSON.stringify(pipeline),
    }),
  deletePipeline: (name: string) => request(`/pipelines/${encodeURIComponent(name)}`, { method: "DELETE" }),
  saveAgents: (name: string, agent: Record<string, unknown>, merge = false) =>
    request<{ path: string; merged: boolean; backup?: string }>(
      `/pipelines/${encodeURIComponent(name)}/agents${merge ? "?merge=1" : ""}`,
      { method: "POST", body: JSON.stringify({ agent }) },
    ),
  runs: () => request<RunEntry[]>("/runs"),
  run: (id: string) => request<RunLog>(`/runs/${encodeURIComponent(id)}`),
  saveRun: (run: RunLog) =>
    request<{ path: string }>(`/runs/${encodeURIComponent(run.id)}`, { method: "PUT", body: JSON.stringify(run) }),
}

/**
 * Graph -> opencode `agent` config block. Each node becomes one agent whose
 * system prompt is the node's role instructions.
 */
export function agentKey(pipeline: Pipeline, node: Pipeline["nodes"][number]) {
  return `${pipeline.name}-${node.role}`.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase()
}

export function agentBlock(pipeline: Pipeline) {
  const block: Record<string, unknown> = {}
  for (const node of pipeline.nodes) {
    const key = agentKey(pipeline, node)
    const tools = Object.fromEntries(Object.entries(node.agent.tools ?? {}).filter(([, value]) => value !== undefined))
    block[key] = {
      mode: "primary",
      description: `OpenFlow node ${node.id} (${node.role}) of pipeline ${pipeline.name}`,
      ...(node.agent.model ? { model: node.agent.model } : {}),
      ...(node.agent.prompt ? { prompt: node.agent.prompt } : {}),
      ...(Object.keys(tools).length ? { tools } : {}),
    }
  }
  return block
}

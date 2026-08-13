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
 * Tool names an `agent.tools` map can switch off, and the permission action
 * each one lands on once the server translates the config.
 *
 * Verified against a running server: `{ tools: { x: false } }` becomes the rule
 * `{ action, resource: "*", effect: "deny" }`. `write`, `edit` and `patch` all
 * collapse onto the single `edit` action, so they are offered here as one
 * toggle — exposing them separately lets a graph ask for contradictory states.
 * `question` is special-cased by the server and produces no rule at all.
 * Unknown names are passed through verbatim and silently do nothing, so this
 * list is the only guard against a typo becoming a no-op toggle.
 */
export const TOOL_ACTIONS: Record<string, string> = {
  read: "read",
  grep: "grep",
  glob: "glob",
  edit: "edit",
  bash: "bash",
  webfetch: "webfetch",
  websearch: "websearch",
  todowrite: "todowrite",
  skill: "skill",
}

export const TOOLS = Object.keys(TOOL_ACTIONS)

/** Older graphs (and the role presets) name the edit capability three ways. */
const TOOL_ALIASES: Record<string, string> = {
  write: "edit",
  patch: "edit",
  "apply-patch": "edit",
}

/**
 * Folds a node's tool map onto the names the server acts on. Aliases merge, and
 * a deny anywhere in a merged group wins — losing a restriction on the way to
 * the config would hand an agent more access than the graph asked for.
 */
export function toolMap(tools: Record<string, boolean> | undefined) {
  const merged: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(tools ?? {})) {
    if (typeof value !== "boolean") continue
    const resolved = TOOL_ALIASES[name] ?? name
    if (!(resolved in TOOL_ACTIONS)) continue
    merged[resolved] = resolved in merged ? merged[resolved] && value : value
  }
  return merged
}

/**
 * A node's tool toggles as an explicit permission map.
 *
 * `agent.tools` is marked "@deprecated Use 'permission' field instead" in the
 * config schema, and it can only say allow or deny. `permission` is the current
 * field and takes "allow" | "ask" | "deny" per action, so every toggle is
 * written out explicitly rather than leaning on whatever the default happens to
 * be. Actions the graph says nothing about are left off the map entirely and
 * keep asking — the engine answers those at runtime.
 */
export function permissionBlock(tools: Record<string, boolean> | undefined) {
  const block: Record<string, "allow" | "deny"> = {}
  for (const [name, enabled] of Object.entries(toolMap(tools))) {
    block[TOOL_ACTIONS[name]] = enabled ? "allow" : "deny"
  }
  return block
}

/**
 * Graph -> opencode `agent` config block. Each node becomes one agent whose
 * system prompt is the node's role instructions.
 *
 * The shape is the config's own input vocabulary — `prompt` and `permission`,
 * not the `system` and `permissions` that `GET /api/agent` reports back. The
 * server translates the former into the latter at load time; feeding it the
 * translated form instead gets both fields ignored.
 */
export function agentKey(pipeline: Pipeline, node: Pipeline["nodes"][number]) {
  return `${pipeline.name}-${node.role}`.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase()
}

export function agentBlock(pipeline: Pipeline) {
  const block: Record<string, unknown> = {}
  for (const node of pipeline.nodes) {
    const key = agentKey(pipeline, node)
    const permission = permissionBlock(node.agent.tools)
    block[key] = {
      mode: "primary",
      description: `OpenFlow node ${node.id} (${node.role}) of pipeline ${pipeline.name}`,
      ...(node.agent.model ? { model: node.agent.model } : {}),
      ...(node.agent.prompt ? { prompt: node.agent.prompt } : {}),
      ...(Object.keys(permission).length ? { permission } : {}),
    }
  }
  return block
}

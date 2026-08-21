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
export type BrowseEntry = { name: string; path: string }
export type BrowseResult = { path: string | null; parent: string | null; entries: BrowseEntry[] }
export type FlowPaths = { project: string; pipelines: string; runs: string; generated: string; skills: string }
export type McpServer = {
  name: string
  type: "local" | "remote"
  enabled: boolean
  command?: string[]
  cwd?: string
  environment?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  timeout?: number
}
export type SkillEntry = { name: string; description?: string; updated: number }
/** `name` is the frontmatter name shown to the agent; `folder` is the slug the API addresses it by. */
export type SkillDoc = { name: string; folder: string; description?: string; content: string; path: string }
export type SkillSave = { name: string; path: string; registered?: boolean; backup?: string; error?: string }

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
  /** MCP servers configured in the project's opencode.json. */
  mcpServers: () => request<McpServer[]>("/mcp"),
  saveMcpServer: (server: McpServer) =>
    request<{ name: string; path: string; backup?: string }>(`/mcp/${encodeURIComponent(server.name)}`, {
      method: "PUT",
      body: JSON.stringify(server),
    }),
  deleteMcpServer: (name: string) =>
    request<{ name: string; removed: boolean }>(`/mcp/${encodeURIComponent(name)}`, { method: "DELETE" }),
  /** Skills authored in OpenFlow, stored under `.openflow/skills` and registered in opencode.json. */
  skills: () => request<SkillEntry[]>("/skills"),
  skill: (name: string) => request<SkillDoc>(`/skills/${encodeURIComponent(name)}`),
  saveSkill: (skill: { name: string; description?: string; content: string }) =>
    request<SkillSave>(`/skills/${encodeURIComponent(skill.name)}`, { method: "PUT", body: JSON.stringify(skill) }),
  deleteSkill: (name: string) => request<{ name: string }>(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
  runs: () => request<RunEntry[]>("/runs"),
  run: (id: string) => request<RunLog>(`/runs/${encodeURIComponent(id)}`),
  saveRun: (run: RunLog) =>
    request<{ path: string }>(`/runs/${encodeURIComponent(run.id)}`, { method: "PUT", body: JSON.stringify(run) }),
  /** Providers the opencode CLI already holds keys for. Names only, no secrets. */
  cliKeys: () => request<{ path: string; providers: string[] }>("/cli-keys"),
  /**
   * Model ids opencode zen actually serves, or `null` when the list could not
   * be read — `null` must leave the catalog unfiltered, not empty it.
   */
  zenModels: () => request<{ ids: string[] | null }>("/zen-models"),
  /** Which of these environment variables the host has set. Names only, no values. */
  envPresent: (names: string[]) =>
    names.length
      ? // Commas stay raw so ~250 provider variables still fit in one URL.
        request<{ present: string[] }>(`/env?names=${names.map(encodeURIComponent).join(",")}`)
      : Promise.resolve({ present: [] as string[] }),
  importCliKeys: (providers?: string[]) =>
    request<{ results: Array<{ providerID: string; ok: boolean; error?: string }> }>("/cli-keys/import", {
      method: "POST",
      body: JSON.stringify({ providers }),
    }),
  /** Subdirectories of `target`, or drive/root listing when omitted — for a folder picker. */
  browse: (target?: string) => request<BrowseResult>(`/browse${target ? `?path=${encodeURIComponent(target)}` : ""}`),
  /**
   * Opens the host's own folder dialog and resolves with what was chosen, or
   * `null` when the user cancelled. Rejects when the host has no dialog (a
   * remote or headless host) — callers fall back to `browse`.
   */
  pickFolder: (start?: string) =>
    request<{ path: string | null }>("/pick-folder", { method: "POST", body: JSON.stringify({ path: start }) }),
  /** Switches the live project directory. Takes effect immediately, no restart. */
  setProject: (path: string) => request<FlowPaths>("/project", { method: "POST", body: JSON.stringify({ path }) }),
}

/**
 * Tool names an `agent.tools` map can switch off, and the permission action
 * each one lands on once the server translates the config.
 *
 * Verified against a running server: `{ tools: { x: false } }` becomes the rule
 * `{ action, resource: "*", effect: "deny" }`. `write`, `edit` and `patch` all
 * collapse onto the single `edit` action, so they are offered here as one
 * toggle — exposing them separately lets a graph ask for contradictory states.
 * Unknown names are passed through verbatim and silently do nothing, so this
 * list is the only guard against a typo becoming a no-op toggle.
 *
 * `question` is what lets a node stop and ask a person something: the builtin
 * tool registers under that name, so a `question: "deny"` rule strips it from
 * the agent and a node with it off runs headless and guesses instead.
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
  question: "question",
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

/**
 * Per-node MCP access, as permission rules.
 *
 * An MCP tool is registered as `<server>_<tool>`, and permission actions are
 * matched by wildcard, so one `"<server>_*"` rule covers a whole server. Rules
 * are only written for servers the project actually configures: a blanket deny
 * would also silence servers added later, and a node that says nothing about
 * MCP (`agent.mcp` undefined — every node authored before this existed) is
 * left alone rather than retroactively locked down.
 */
export function mcpBlock(allowed: string[] | undefined, servers: string[]) {
  const block: Record<string, "allow" | "deny"> = {}
  if (!allowed || !servers.length) return block
  const set = new Set(allowed)
  for (const server of servers) block[`${server}_*`] = set.has(server) ? "allow" : "deny"
  return block
}

export function agentBlock(pipeline: Pipeline, servers: string[] = []) {
  const block: Record<string, unknown> = {}
  for (const node of pipeline.nodes) {
    const key = agentKey(pipeline, node)
    const permission = { ...permissionBlock(node.agent.tools), ...mcpBlock(node.agent.mcp, servers) }
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

import type { Pipeline, RunLog, Spend } from "../graph/types"

async function send(path: string, init?: RequestInit) {
  const response = await fetch(`/flow/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
  })
  const body = await response.json().catch(() => undefined)
  return { response, body }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { response, body } = await send(path, init)
  if (!response.ok) throw new Error(body?.error ?? `${init?.method ?? "GET"} ${path} failed (${response.status})`)
  return body as T
}

/**
 * A DELETE whose target was already gone. The host answers that 404 with
 * `{ removed: false }` (plus an `error` sentence), which is a result the caller
 * reports, not a failure: it is returned as a value so the rest of the flow (a
 * rename, the list refresh) still runs. Every other failure still throws.
 */
async function removal<T extends { removed: boolean }>(path: string): Promise<T> {
  const { response, body } = await send(path, { method: "DELETE" })
  if (response.ok) return body as T
  if (response.status === 404 && body?.removed === false) return body as T
  throw new Error(body?.error ?? `DELETE ${path} failed (${response.status})`)
}

/** The host refused to switch project because cards still hold it; `sessions` names them (it can be empty). */
export class ProjectBusyError extends Error {
  readonly sessions: string[]
  constructor(message: string, sessions: string[]) {
    super(message)
    this.sessions = sessions
  }
}

export type PipelineEntry = { name: string; id?: string; nodes: number; updated: number }
export type RunEntry = {
  id: string
  pipeline?: string
  status?: string
  started?: number
  finished?: number
  /** When the run's log was last written; the engine keeps it moving while the run is live. Missing on logs from before it existed. */
  updatedAt?: number
  /** Cards in the run. Missing on runs indexed before the count was recorded. */
  nodes?: number
  /** Missing on runs recorded before usage was tracked — unknown, not free. */
  usage?: Spend
}
export type WorktreeRef = { card: string; directory: string; branch: string }
export type OpenWorktrees = { enabled: true; base: string; trees: WorktreeRef[] } | { enabled: false; reason: string }
export type MergeReport = {
  merged: string[]
  empty: string[]
  conflicts: { card: string; paths: string[] }[]
  /** Lines each card changed, counted on its own branch before the merge. */
  stats?: { card: string; added: number; removed: number; files: number }[]
}
/** One file's line counts. `null` files means the project is not a git repository. */
export type TreeStat = { files: { path: string; added: number; removed: number; binary?: boolean }[] | null }
export type BrowseEntry = { name: string; path: string }
export type BrowseResult = { path: string | null; parent: string | null; entries: BrowseEntry[] }
export type FlowPaths = {
  project: string
  pipelines: string
  runs: string
  generated: string
  skills: string
  /** Pipeline that was open in this project last time, if any. */
  pipeline?: string
}
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
export type SkillEntry = { name: string; description?: string; updated: number; legacy?: boolean }
/** `name` is the frontmatter name shown to the agent; `folder` is the slug the API addresses it by. */
export type SkillDoc = {
  name: string
  folder: string
  description?: string
  content: string
  path: string
  legacy?: boolean
}
export type SkillSave = { name: string; path: string; backup?: string; error?: string }

export const store = {
  roles: () => request<unknown[]>("/roles"),
  saveRoles: (roles: unknown[]) => request<{ saved: true }>("/roles", { method: "PUT", body: JSON.stringify(roles) }),
  pipelines: () => request<PipelineEntry[]>("/pipelines"),
  pipeline: (name: string) => request<Pipeline>(`/pipelines/${encodeURIComponent(name)}`),
  savePipeline: (pipeline: Pipeline) =>
    request<{ path: string }>(`/pipelines/${encodeURIComponent(pipeline.name)}`, {
      method: "PUT",
      body: JSON.stringify(pipeline),
    }),
  deletePipeline: (name: string) => request(`/pipelines/${encodeURIComponent(name)}`, { method: "DELETE" }),
  /** MCP servers of the OpenFlow Omp profile. */
  mcpServers: () => request<McpServer[]>("/mcp"),
  /** `create` asks the host to refuse (409 `name-taken`) when the name already belongs to a server instead of overwriting it. */
  saveMcpServer: (server: McpServer, create = false) =>
    request<{ name: string; path: string; backup?: string; unchanged?: boolean }>(
      `/mcp/${encodeURIComponent(server.name)}`,
      {
        method: "PUT",
        body: JSON.stringify(create ? { ...server, create: true } : server),
      },
    ),
  deleteMcpServer: (name: string) => removal<{ name: string; removed: boolean }>(`/mcp/${encodeURIComponent(name)}`),
  /**
   * Skills of the OpenFlow Omp profile. Entries flagged `legacy` live in the old
   * `.openflow/skills` folder: listed read-only until saved, which migrates them.
   */
  skills: () => request<SkillEntry[]>("/skills"),
  skill: (name: string) => request<SkillDoc>(`/skills/${encodeURIComponent(name)}`),
  /** `create` refuses (409 `name-taken`) a name that is taken; `address` is the folder to write when it differs from the name. */
  saveSkill: (skill: { name: string; description?: string; content: string }, create = false, address = skill.name) =>
    request<SkillSave>(`/skills/${encodeURIComponent(address)}`, {
      method: "PUT",
      body: JSON.stringify(create ? { ...skill, create: true } : skill),
    }),
  deleteSkill: (name: string) => removal<{ name: string; removed: boolean }>(`/skills/${encodeURIComponent(name)}`),
  /**
   * A git worktree per card, so a batch of cards cannot overwrite each other.
   * `enabled: false` is the ordinary answer for a project that is not a git
   * repository — the run proceeds in the one shared tree, as it always did.
   */
  openWorktrees: (run: string, cards: string[]) =>
    request<OpenWorktrees>("/worktrees", { method: "POST", body: JSON.stringify({ run, cards }) }),
  /** Folds each card's work back in. Paths that would not apply are named, never forced. */
  mergeWorktrees: (base: string, trees: WorktreeRef[]) =>
    request<MergeReport>("/worktrees/merge", { method: "POST", body: JSON.stringify({ base, trees }) }),
  /**
   * What the project's tree holds that its last commit does not, right now.
   *
   * Only useful in pairs: the engine takes one before a batch and one after,
   * and the difference is what that batch wrote. `files: null` says the project
   * is not a repository, which is unmeasurable rather than unchanged.
   */
  treeStat: () => request<TreeStat>("/treestat"),
  /**
   * Commits the working tree as this round left it, under a ref of OpenFlow's
   * own. `null` when the project is not a git repository — the run proceeds
   * with no way back, exactly as it did before checkpoints existed.
   */
  /**
   * A directory outside the project for output that is not the work — greps,
   * diagnostics, anything a shell redirect would otherwise drop into the
   * deliverable. `null` when the host could not make one.
   */
  scratch: (run: string) =>
    request<{ path: string | null }>("/scratch", { method: "POST", body: JSON.stringify({ run }) }),
  checkpoint: (run: string, round: number) =>
    request<{ ref: string; commit: string } | null>("/checkpoint", {
      method: "POST",
      body: JSON.stringify({ run, round }),
    }),
  cleanupWorktrees: (run: string, trees: WorktreeRef[]) =>
    request<{ removed: true }>("/worktrees/cleanup", { method: "POST", body: JSON.stringify({ run, trees }) }),
  runs: () => request<RunEntry[]>("/runs"),
  run: (id: string) => request<RunLog>(`/runs/${encodeURIComponent(id)}`),
  saveRun: (run: RunLog) =>
    request<{ path: string }>(`/runs/${encodeURIComponent(run.id)}`, { method: "PUT", body: JSON.stringify(run) }),
  deleteRun: (id: string) =>
    request<{ id: string; removed: boolean }>(`/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /**
   * Deletes recorded runs that fail either rule — "at most `keep`, and nothing
   * older than `days`". Runs still marked `running` are never pruned: that is
   * the status the resume path looks for.
   */
  pruneRuns: (rules: { keep?: number; days?: number }) =>
    request<{ removed: string[]; kept: number }>("/runs/prune", { method: "POST", body: JSON.stringify(rules) }),
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
  setProject: async (path: string) => {
    const { response, body } = await send("/project", { method: "POST", body: JSON.stringify({ path }) })
    if (response.ok) return body as FlowPaths
    const message = body?.error ?? `POST /project failed (${response.status})`
    if (response.status === 409 && body?.code === "project-busy") {
      const sessions: unknown[] = Array.isArray(body.sessions) ? body.sessions : []
      throw new ProjectBusyError(
        message,
        sessions.filter((id): id is string => typeof id === "string"),
      )
    }
    throw new Error(message)
  },
}

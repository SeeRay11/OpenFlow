import fs from "node:fs/promises"
import path from "node:path"
import { cliAuthPath, importCliKeys, readCliKeys } from "./cli-auth"
import { allowsRemote } from "./guard"
import { hasNativePicker, pickFolderNative } from "./native-picker"
import { zenModels } from "./zen"

/**
 * OpenFlow's persistence, as plain functions over a project directory.
 *
 * The canvas runs in a browser and cannot touch the filesystem, so both hosts —
 * the vite dev server ([../vite/flow-store.ts]) and the standalone server
 * ([../server.ts]) — expose this same REST surface under `/flow/api/*`:
 *
 *   GET    /flow/api/context               -> { project, pipelines, runs, generated }
 *   GET    /flow/api/pipelines             -> [{ name, id, nodes, updated }]
 *   GET    /flow/api/pipelines/:name       -> pipeline json
 *   PUT    /flow/api/pipelines/:name       -> save pipeline json
 *   DELETE /flow/api/pipelines/:name       -> delete pipeline
 *   POST   /flow/api/pipelines/:name/agents?merge=1
 *                                          -> write generated opencode agent defs
 *   GET    /flow/api/mcp                   -> [{ name, type, enabled, command?, url?, ... }]
 *   PUT    /flow/api/mcp/:name             -> upsert an mcp server in opencode.json
 *   DELETE /flow/api/mcp/:name             -> drop it from opencode.json
 *   GET    /flow/api/skills                -> [{ name, description, updated }]
 *   GET    /flow/api/skills/:name          -> { name, folder, description, content, path }
 *   PUT    /flow/api/skills/:name          -> write .openflow/skills/<name>/SKILL.md
 *   DELETE /flow/api/skills/:name          -> delete the skill folder
 *   GET    /flow/api/runs                  -> [{ id, pipeline, status, started, finished }]
 *   GET    /flow/api/runs/:id              -> run log json
 *   PUT    /flow/api/runs/:id              -> write run log json
 *   GET    /flow/api/cli-keys              -> { path, providers } from the CLI's auth.json
 *   POST   /flow/api/cli-keys/import       -> connect those keys to `opencode serve`
 *   GET    /flow/api/env?names=A,B         -> { present: ["A"] } — names only, never values
 *   GET    /flow/api/zen-models            -> { ids: [...] | null } — what zen really serves
 *   GET    /flow/api/browse?path=          -> { path, parent, entries } — subdirectories of `path`
 *                                             (drive roots on Windows when `path` is omitted)
 *   POST   /flow/api/pick-folder           -> { path } — native OS folder dialog on the host,
 *                                             `null` when cancelled (loopback hosts only)
 *   POST   /flow/api/project               -> { path } — switch the live project directory
 *
 * Keeping it host-neutral is the point: the dev server and the built app must
 * not drift into two different stores. `browse`/`project` read the same host
 * filesystem `/flow/api` already writes into, so they carry no wider blast
 * radius than the rest of this surface — both stay behind the loopback-only
 * guard in `lib/guard.ts`.
 */
export type FlowPaths = {
  project: string
  pipelines: string
  runs: string
  generated: string
  skills: string
}

export function flowPaths(project: string): FlowPaths {
  const root = path.resolve(project)
  return {
    project: root,
    pipelines: path.join(root, ".openflow", "pipelines"),
    runs: path.join(root, ".openflow", "runs"),
    generated: path.join(root, ".openflow", "generated"),
    skills: path.join(root, ".openflow", "skills"),
  }
}

/**
 * Points an already-issued `FlowPaths` at a new project, in place.
 *
 * Both hosts (`server.ts`, `vite/flow-store.ts`) hand `handleFlow` the same
 * object on every request rather than a fresh one, so mutating its fields —
 * instead of returning a new object the caller would have to remember to
 * swap in — is what makes a project switch take effect immediately, with no
 * server restart and no route left reading a stale directory.
 */
export function setProjectPath(paths: FlowPaths, project: string) {
  const next = flowPaths(project)
  paths.project = next.project
  paths.pipelines = next.pipelines
  paths.runs = next.runs
  paths.generated = next.generated
  paths.skills = next.skills
}

export type BrowseEntry = { name: string; path: string }
export type BrowseResult = { path: string | null; parent: string | null; entries: BrowseEntry[] }

/**
 * Lists the subdirectories of `target`, for a server-side folder picker.
 *
 * A browser cannot hand back a real OS path from a folder-picker input — the
 * File System Access API only yields a sandboxed handle — so browsing has to
 * happen here, where the process already has a real filesystem. `target`
 * omitted lists roots: on Windows that means probing drive letters (there is
 * no direct "list drives" call in Node), elsewhere it is `/`. Dotfiles are
 * filtered out to keep the listing to things a user would plausibly pick as
 * a project root.
 */
export async function browseDirectory(target?: string): Promise<BrowseResult> {
  if (!target) {
    if (process.platform !== "win32") return browseDirectory("/")
    const entries: BrowseEntry[] = []
    for (let code = 65; code <= 90; code++) {
      const root = `${String.fromCharCode(code)}:\\`
      const reachable = await fs
        .access(root)
        .then(() => true)
        .catch(() => false)
      if (reachable) entries.push({ name: root, path: root })
    }
    return { path: null, parent: null, entries }
  }

  const resolved = path.resolve(target)
  const stat = await fs.stat(resolved).catch(() => undefined)
  if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${resolved}`)

  const names = await fs.readdir(resolved, { withFileTypes: true })
  const entries = names
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const up = path.dirname(resolved)
  const atRoot = up === resolved
  const parent = atRoot ? (process.platform === "win32" ? null : "/") : up
  return { path: resolved, parent: atRoot && process.platform === "win32" ? null : parent, entries }
}

export type FlowRequest = {
  method: string
  /** Path with or without the `/flow/api` prefix. */
  path: string
  search: URLSearchParams
  json: () => Promise<any>
  /** Base URL of the `opencode serve` this host proxies, for the key import. */
  upstream?: string
}

export type FlowResponse = { status: number; body: unknown }

/** Returns undefined when the path is not a store route, so the host can fall through. */
export async function handleFlow(paths: FlowPaths, request: FlowRequest): Promise<FlowResponse | undefined> {
  const segments = request.path
    .replace(/^\/?flow\/api/, "")
    .split("/")
    .filter(Boolean)
  const method = request.method.toUpperCase()

  if (segments[0] === "context" && method === "GET") return ok(paths)

  if (segments[0] === "pipelines") {
    const name = segments[1] ? slug(decodeURIComponent(segments[1])) : undefined

    if (!name && method === "GET") return ok(await listPipelines(paths))
    if (!name) return { status: 400, body: { error: "pipeline name required" } }

    const file = path.join(paths.pipelines, `${name}.json`)

    if (segments[2] === "agents" && method === "POST") {
      return ok(await writeAgents(paths, name, await request.json(), request.search.get("merge") === "1"))
    }

    if (method === "GET") {
      const raw = await fs.readFile(file, "utf8").catch(() => undefined)
      if (raw === undefined) return { status: 404, body: { error: `pipeline "${name}" not found` } }
      return ok(JSON.parse(raw))
    }
    if (method === "PUT") {
      const body = await request.json()
      await fs.mkdir(paths.pipelines, { recursive: true })
      await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n")
      return ok({ name, path: file })
    }
    if (method === "DELETE") {
      await fs.rm(file, { force: true })
      return ok({ name })
    }
  }

  if (segments[0] === "mcp") {
    const name = segments[1] ? mcpName(decodeURIComponent(segments[1])) : undefined

    if (!name && method === "GET") return ok(await listMcpServers(paths))
    if (!name) return { status: 400, body: { error: "mcp server name required" } }

    if (method === "PUT" || method === "DELETE") {
      try {
        if (method === "DELETE") return ok(await deleteMcpServer(paths, name))
        return ok(await writeMcpServer(paths, name, await request.json()))
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
      }
    }
  }

  if (segments[0] === "skills") {
    const name = segments[1] ? slug(decodeURIComponent(segments[1])) : undefined

    if (!name && method === "GET") return ok(await listSkills(paths))
    if (!name) return { status: 400, body: { error: "skill name required" } }

    if (method === "GET") {
      const found = await readSkill(paths, name)
      if (!found) return { status: 404, body: { error: `skill "${name}" not found` } }
      return ok(found)
    }
    if (method === "PUT") return ok(await writeSkill(paths, name, await request.json()))
    if (method === "DELETE") {
      await fs.rm(path.join(paths.skills, name), { recursive: true, force: true })
      return ok({ name })
    }
  }

  if (segments[0] === "cli-keys") {
    // Only the provider names cross to the browser. Importing runs here, so
    // the secrets in auth.json are never served over HTTP.
    if (!segments[1] && method === "GET") {
      const keys = await readCliKeys()
      return ok({ path: cliAuthPath(), providers: keys.map((entry) => entry.providerID) })
    }
    if (segments[1] === "import" && method === "POST") {
      if (!request.upstream) return { status: 500, body: { error: "no opencode server configured" } }
      const body = await request.json()
      const only = Array.isArray(body?.providers) ? body.providers.map(String) : undefined
      const keys = await readCliKeys()
      if (!keys.length) return { status: 404, body: { error: `no API keys in ${cliAuthPath()}` } }
      return ok({ results: await importCliKeys({ upstream: request.upstream, keys, only }) })
    }
  }

  if (segments[0] === "env" && method === "GET") {
    // Which of the asked-for names are set, and nothing else: the answer is a
    // subset of the question, so no value and no unrelated variable can leak
    // to the browser. `opencode serve` reads the same environment when it is
    // started from the same shell — a server launched elsewhere may not, and
    // then a provider reads as locked until its key is stored here instead.
    const asked = (request.search.get("names") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
    return ok({ present: asked.filter((name) => Boolean(process.env[name])) })
  }

  if (segments[0] === "browse" && method === "GET") {
    const target = request.search.get("path") ?? undefined
    try {
      return ok(await browseDirectory(target))
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }

  if (segments[0] === "pick-folder" && method === "POST") {
    // The dialog opens on the *host*, so it only makes sense when the host is
    // the machine the user is sitting at. Served remotely it would pop a window
    // nobody can see and hang the request, so refuse and let the caller fall
    // back to `/browse`.
    if (allowsRemote()) return { status: 403, body: { error: "native picker is unavailable when serving remotely" } }
    if (!hasNativePicker()) return { status: 501, body: { error: `no native folder picker on ${process.platform}` } }
    const body = await request.json().catch(() => ({}))
    const start = typeof body?.path === "string" && body.path ? body.path : paths.project
    try {
      const picked = await pickFolderNative(start)
      return ok({ path: picked ?? null })
    } catch (error) {
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }

  if (segments[0] === "project" && method === "POST") {
    const body = await request.json()
    const target = typeof body?.path === "string" ? body.path : undefined
    if (!target) return { status: 400, body: { error: "path required" } }
    const resolved = path.resolve(target)
    const stat = await fs.stat(resolved).catch(() => undefined)
    if (!stat || !stat.isDirectory()) return { status: 400, body: { error: `not a directory: ${resolved}` } }
    setProjectPath(paths, resolved)
    return ok(paths)
  }

  if (segments[0] === "zen-models" && method === "GET") {
    // Fetched here rather than in the browser: opencode.ai serves no CORS
    // headers for this, and the host is already the side that talks to the
    // network on OpenFlow's behalf. `null` means "could not read" — the caller
    // must then leave the catalog alone rather than empty it.
    return ok({ ids: (await zenModels()) ?? null })
  }

  if (segments[0] === "runs") {
    const id = segments[1] ? slug(decodeURIComponent(segments[1])) : undefined
    if (!id && method === "GET") return ok(await listRuns(paths))
    if (!id) return { status: 400, body: { error: "run id required" } }
    const file = path.join(paths.runs, `${id}.json`)
    if (method === "GET") {
      const raw = await fs.readFile(file, "utf8").catch(() => undefined)
      if (raw === undefined) return { status: 404, body: { error: `run "${id}" not found` } }
      return ok(JSON.parse(raw))
    }
    if (method === "PUT") {
      const body = await request.json()
      await fs.mkdir(paths.runs, { recursive: true })
      await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n")
      return ok({ id, path: file })
    }
  }

  return undefined
}

function ok(body: unknown): FlowResponse {
  return { status: 200, body }
}

async function listPipelines(paths: FlowPaths) {
  const entries = await fs.readdir(paths.pipelines).catch(() => [] as string[])
  const out = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const file = path.join(paths.pipelines, entry)
    const [raw, stat] = await Promise.all([fs.readFile(file, "utf8").catch(() => "{}"), fs.stat(file)])
    let parsed: any = {}
    try {
      parsed = JSON.parse(raw)
    } catch {}
    out.push({
      name: entry.slice(0, -5),
      id: parsed.id,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
      updated: stat.mtimeMs,
    })
  }
  return out.sort((a, b) => b.updated - a.updated)
}

async function listRuns(paths: FlowPaths) {
  const entries = await fs.readdir(paths.runs).catch(() => [] as string[])
  const out = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const raw = await fs.readFile(path.join(paths.runs, entry), "utf8").catch(() => "{}")
    let parsed: any = {}
    try {
      parsed = JSON.parse(raw)
    } catch {}
    out.push({
      id: entry.slice(0, -5),
      pipeline: parsed.pipeline,
      status: parsed.status,
      started: parsed.started,
      finished: parsed.finished,
    })
  }
  return out.sort((a, b) => (b.started ?? 0) - (a.started ?? 0))
}

/**
 * Writes the generated `agent` block. By default it lands in
 * `.openflow/generated/<name>.opencode.json` so the project's own
 * `opencode.json` is never touched behind the user's back; `merge` folds the
 * block into the real config after copying it aside.
 */
async function writeAgents(paths: FlowPaths, name: string, body: any, merge: boolean) {
  const block = { $schema: "https://opencode.ai/config.json", agent: body?.agent ?? {} }
  await fs.mkdir(paths.generated, { recursive: true })
  const file = path.join(paths.generated, `${name}.opencode.json`)
  await fs.writeFile(file, JSON.stringify(block, null, 2) + "\n")
  if (!merge) return { path: file, merged: false }

  const target = path.join(paths.project, "opencode.json")
  const raw = await fs.readFile(target, "utf8").catch(() => undefined)
  let config: any = { $schema: "https://opencode.ai/config.json" }
  let backup: string | undefined
  if (raw !== undefined) {
    backup = await backupConfig(target, raw)
    try {
      config = JSON.parse(raw)
    } catch {
      return { path: file, merged: false, error: "existing opencode.json is not valid JSON" }
    }
  }
  config.agent = { ...(config.agent ?? {}), ...block.agent }
  await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n")
  return { path: target, merged: true, backup }
}

export type McpServer = {
  name: string
  type: "local" | "remote"
  enabled: boolean
  /** local only */
  command?: string[]
  cwd?: string
  environment?: Record<string, string>
  /** remote only */
  url?: string
  headers?: Record<string, string>
  timeout?: number
}

/**
 * MCP server names become part of a tool name (`<server>_<tool>`), so anything
 * the sanitiser would rewrite is rejected here instead of silently producing a
 * server nobody can address from a per-node allowlist.
 */
export function mcpName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9-_]/g, "-")
}

/**
 * The `mcp` block of the project's opencode.json, as rows.
 *
 * This is the *configured* set, not the live one — connection state comes from
 * the server's own `GET /mcp`, and a server can be configured here while the
 * running `opencode serve` has never heard of it (it reads config once at
 * boot). The panel shows both, side by side, for exactly that reason.
 */
async function listMcpServers(paths: FlowPaths): Promise<McpServer[]> {
  const config = await readProjectConfig(paths)
  if ("error" in config) return []
  const block = config.value.mcp
  if (!block || typeof block !== "object") return []
  return Object.entries(block as Record<string, any>)
    .map(([name, entry]) => normalizeMcp(name, entry))
    .filter((entry): entry is McpServer => Boolean(entry))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeMcp(name: string, entry: any): McpServer | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const enabled = entry.enabled !== false
  if (entry.type === "remote") {
    return {
      name,
      type: "remote",
      enabled,
      url: typeof entry.url === "string" ? entry.url : "",
      headers: isStringRecord(entry.headers) ? entry.headers : undefined,
      timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
    }
  }
  return {
    name,
    type: "local",
    enabled,
    command: Array.isArray(entry.command) ? entry.command.map(String) : [],
    cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
    environment: isStringRecord(entry.environment) ? entry.environment : undefined,
    timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && Object.values(value as object).every((v) => typeof v === "string")
}

/**
 * Writes one server into the project config's `mcp` block, after a backup.
 *
 * Validation is not politeness: opencode hard-fails on a config it cannot
 * parse, and a config it refuses takes every card in the project down with it,
 * not just this server. A local server with no command and a remote one with
 * no url are the two ways to produce that, so both are refused here.
 */
async function writeMcpServer(paths: FlowPaths, name: string, body: any) {
  const entry = buildMcpEntry(body)
  const target = path.join(paths.project, "opencode.json")
  const config = await readProjectConfig(paths)
  if ("error" in config) throw new Error(config.error)
  const backup = config.raw === undefined ? undefined : await backupConfig(target, config.raw)
  const next = config.value
  next.mcp = { ...(next.mcp ?? {}), [name]: entry }
  if (!next.$schema) next.$schema = "https://opencode.ai/config.json"
  await fs.writeFile(target, JSON.stringify(next, null, 2) + "\n")
  return { name, path: target, backup }
}

function buildMcpEntry(body: any) {
  const enabled = body?.enabled !== false
  const timeout = typeof body?.timeout === "number" && body.timeout > 0 ? body.timeout : undefined
  if (body?.type === "remote") {
    const url = typeof body.url === "string" ? body.url.trim() : ""
    if (!url) throw new Error("a remote mcp server needs a url")
    const headers = pickStrings(body.headers)
    return {
      type: "remote" as const,
      url,
      ...(headers ? { headers } : {}),
      ...(timeout ? { timeout } : {}),
      enabled,
    }
  }
  const command = Array.isArray(body?.command) ? body.command.map(String).filter((part: string) => part.length) : []
  if (!command.length) throw new Error("a local mcp server needs a command")
  const environment = pickStrings(body?.environment)
  const cwd = typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined
  return {
    type: "local" as const,
    command,
    ...(cwd ? { cwd } : {}),
    ...(environment ? { environment } : {}),
    ...(timeout ? { timeout } : {}),
    enabled,
  }
}

/** Drops empty keys and non-string values, so `{"": ""}` rows from the UI never reach the config. */
function pickStrings(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || typeof entry !== "string") continue
    out[key.trim()] = entry
  }
  return Object.keys(out).length ? out : undefined
}

async function deleteMcpServer(paths: FlowPaths, name: string) {
  const target = path.join(paths.project, "opencode.json")
  const config = await readProjectConfig(paths)
  if ("error" in config) throw new Error(config.error)
  if (config.raw === undefined || !config.value.mcp || !(name in config.value.mcp)) return { name, removed: false }
  const backup = await backupConfig(target, config.raw)
  delete config.value.mcp[name]
  await fs.writeFile(target, JSON.stringify(config.value, null, 2) + "\n")
  return { name, removed: true, path: target, backup }
}

/**
 * Reads the project's opencode.json. A missing file is not an error — it is a
 * project that has never been configured — but an unparseable one is, because
 * writing over it would destroy hand-written config.
 */
async function readProjectConfig(
  paths: FlowPaths,
): Promise<{ value: any; raw: string | undefined } | { error: string }> {
  const target = path.join(paths.project, "opencode.json")
  const raw = await fs.readFile(target, "utf8").catch(() => undefined)
  if (raw === undefined) return { value: { $schema: "https://opencode.ai/config.json" }, raw: undefined }
  try {
    return { value: JSON.parse(raw), raw }
  } catch {
    return { error: "existing opencode.json is not valid JSON" }
  }
}

/** Where OpenFlow-authored skills are registered from, relative to the project. */
const SKILL_SOURCE = "./.openflow/skills"

/**
 * Lists the skills OpenFlow has authored under `.openflow/skills`, reading each
 * folder's `SKILL.md` frontmatter. A folder without a readable `SKILL.md` is
 * skipped rather than surfaced as a broken row.
 */
async function listSkills(paths: FlowPaths) {
  const entries = await fs.readdir(paths.skills, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(paths.skills, entry.name, "SKILL.md")
    const [raw, stat] = await Promise.all([
      fs.readFile(file, "utf8").catch(() => undefined),
      fs.stat(file).catch(() => undefined),
    ])
    if (raw === undefined || !stat) continue
    const meta = parseSkillMarkdown(raw)
    out.push({ name: entry.name, description: meta.description, updated: stat.mtimeMs })
  }
  return out.sort((a, b) => b.updated - a.updated)
}

/**
 * Reads one skill's frontmatter and body back for editing, or undefined if absent.
 *
 * `name` is the frontmatter name when the file carries one — that is the identity
 * the agent sees, and it can differ from the folder slug (`Summarize` in
 * `summarize/`). Returning the slug instead would make an edit round-trip rewrite
 * the frontmatter to the slug and silently rename the skill. `folder` carries the
 * slug for callers that need to address the skill over the API.
 */
async function readSkill(paths: FlowPaths, name: string) {
  const file = path.join(paths.skills, name, "SKILL.md")
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  const meta = parseSkillMarkdown(raw)
  return {
    name: meta.name ?? name,
    folder: name,
    description: meta.description,
    content: meta.content,
    path: file,
  }
}

/**
 * Writes `.openflow/skills/<name>/SKILL.md` and registers the folder as a skill
 * source in the project `opencode.json` the first time — the server only scans
 * `.opencode/skill`(`s`) on its own, so a skill kept under `.openflow` is invisible
 * until this path is listed in the config's `skills.paths`. The frontmatter name
 * defaults to the folder slug so the two never drift.
 *
 * A skill created here does not load until `opencode serve` restarts: the server
 * reads its config and skill sources once at boot.
 */
async function writeSkill(paths: FlowPaths, name: string, body: any) {
  const dir = path.join(paths.skills, name)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, "SKILL.md")
  const md = buildSkillMarkdown({
    name: oneLine(body?.name) || name,
    description: oneLine(body?.description),
    content: typeof body?.content === "string" ? body.content : "",
  })
  await fs.writeFile(file, md)
  const source = await registerSkillSource(paths)
  return { name, path: file, ...source }
}

/**
 * Adds `SKILL_SOURCE` to the project config's `skills.paths` once. The config
 * schema types `skills` as `{ paths?: string[]; urls?: string[] }` (see
 * `ConfigSkillsV1.Info`) and the loader reads `skills.paths` — writing a bare
 * array here would fail config validation and opencode hard-fails on invalid
 * config, which would break every card run in the project.
 *
 * Idempotent: a config that already lists it is left untouched
 * (`registered: false`, no backup), so re-saving a skill does not churn the
 * file or its `.bak`.
 */
async function registerSkillSource(paths: FlowPaths) {
  const target = path.join(paths.project, "opencode.json")
  const raw = await fs.readFile(target, "utf8").catch(() => undefined)
  let config: any = { $schema: "https://opencode.ai/config.json" }
  let backup: string | undefined
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw)
    } catch {
      return { registered: false, error: "existing opencode.json is not valid JSON" }
    }
    // A config written by an older build may hold a bare array here. Treat it as
    // the paths list so this rewrites it into the shape the schema accepts,
    // rather than spreading its indices into the object.
    const legacy = Array.isArray(config.skills)
    const block = legacy ? { paths: config.skills } : config.skills ?? {}
    const current: string[] = Array.isArray(block.paths) ? block.paths : []
    if (!legacy && current.includes(SKILL_SOURCE)) return { registered: false }
    backup = await backupConfig(target, raw)
    config.skills = { ...block, paths: current.includes(SKILL_SOURCE) ? current : [...current, SKILL_SOURCE] }
  } else {
    config.skills = { paths: [SKILL_SOURCE] }
  }
  await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n")
  return { registered: true, backup }
}

/**
 * Serialises a skill to the `SKILL.md` shape opencode discovers: a small YAML
 * frontmatter block (`name`, and `description` when set) followed by the
 * markdown body. Frontmatter values are single-lined by the caller, so no YAML
 * quoting or escaping is needed here.
 */
function buildSkillMarkdown(fields: { name: string; description?: string; content: string }) {
  const lines = ["---", `name: ${fields.name}`]
  if (fields.description) lines.push(`description: ${fields.description}`)
  lines.push("---", "")
  return lines.join("\n") + fields.content.replace(/\s+$/, "") + "\n"
}

/**
 * Reads back the frontmatter this module writes. Deliberately small: it parses
 * `key: value` lines between the first pair of `---` fences, which covers what
 * OpenFlow authors without pulling in a YAML parser. A file with no frontmatter
 * is treated as all body.
 */
function parseSkillMarkdown(raw: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { name: undefined, description: undefined, content: raw }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (entry) meta[entry[1]] = entry[2].trim()
  }
  return { name: meta.name, description: meta.description, content: match[2] }
}

/** Collapses a value to a single trimmed line, so it is safe as a YAML scalar. */
function oneLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const flat = value.replace(/\s+/g, " ").trim()
  return flat || undefined
}

/**
 * Copies the config aside before a merge rewrites it, without ever losing the
 * pre-OpenFlow original.
 *
 * `.bak` is written once and then left alone: it is the config as it was before
 * OpenFlow first touched it. Every later merge writes `.prev.bak` instead, so
 * undoing the last merge stays possible too. Overwriting `.bak` on every merge
 * — which is what this used to do — means the second merge replaces the
 * original with an already-merged copy and the real config is gone, and it is
 * gone quietly, since a project's `opencode.json` is usually gitignored.
 */
export async function backupConfig(target: string, raw: string) {
  const original = `${target}.bak`
  const exists = await fs
    .access(original)
    .then(() => true)
    .catch(() => false)
  const file = exists ? `${target}.prev.bak` : original
  await fs.writeFile(file, raw)
  return file
}

/**
 * Reduces a name to something that cannot leave its directory: separators and
 * anything else a path could hide in are dropped, and leading dots go with
 * them, so `../../etc/passwd` lands as `etcpasswd.json` inside `.openflow`.
 */
export function slug(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9-_ .]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^\.+/, "") || "untitled"
  )
}

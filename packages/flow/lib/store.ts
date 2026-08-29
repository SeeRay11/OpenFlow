import fs from "node:fs/promises"
import path from "node:path"
import { cliAuthPath, importCliKeys, readCliKeys } from "./cli-auth"
import { allowsRemote } from "./guard"
import { recallPipeline, rememberPipeline, rememberProject } from "./last-session"
import { hasNativePicker, pickFolderNative } from "./native-picker"
import type { Supervisor } from "./opencode-process"
import { COMPATIBLE_PROFILES, globalConfigCandidates, repackage, repackaged } from "./repackage"
import { zenModels } from "./zen"

/**
 * OpenFlow's persistence, as plain functions over a project directory.
 *
 * The canvas runs in a browser and cannot touch the filesystem, so both hosts —
 * the vite dev server ([../vite/flow-store.ts]) and the standalone server
 * ([../server.ts]) — expose this same REST surface under `/flow/api/*`:
 *
 *   GET    /flow/api/context               -> { project, pipelines, runs, generated, skills,
 *                                             pipeline } — `pipeline` is the one to reopen
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
 *   POST   /flow/api/project               -> { path } — switch the live project directory,
 *                                             and remember it for the next launch
 *   GET    /flow/api/repackage             -> { path, applied, available, error? } — which
 *                                             OpenAI-compatible providers the global config
 *                                             already repackages
 *   POST   /flow/api/repackage             -> { providers: [...] } repackages them there, so the
 *                                             runner can dispatch their models
 *   GET    /flow/api/server                -> { managed, running, url, command, pid, ... } — the
 *                                             `opencode serve` this host proxies
 *   POST   /flow/api/server/restart        -> restarts it, when this host owns it (loopback only)
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
  /**
   * The engine's process, when this host spawned it. Absent or unmanaged means
   * the restart route reports the command instead of running it.
   */
  serve?: Supervisor
}

export type FlowResponse = { status: number; body: unknown }

/** Returns undefined when the path is not a store route, so the host can fall through. */
export async function handleFlow(paths: FlowPaths, request: FlowRequest): Promise<FlowResponse | undefined> {
  const segments = request.path
    .replace(/^\/?flow\/api/, "")
    .split("/")
    .filter(Boolean)
  const method = request.method.toUpperCase()

  // `pipeline` rides along on the context the canvas already reads at boot, so
  // reopening where the user left off costs no extra round trip.
  if (segments[0] === "context" && method === "GET") return ok({ ...paths, pipeline: recallPipeline(paths.project) })

  // Custom roles used to live only in localStorage, so clearing site data or
  // moving to another browser threw away every hand-written role prompt. They
  // are a project artifact like a pipeline, so they are stored like one.
  if (segments[0] === "roles") {
    if (method === "GET") return ok(await readRoles(paths))
    if (method === "PUT") {
      await writeRoles(paths, await request.json())
      return ok({ saved: true })
    }
  }

  if (segments[0] === "pipelines") {
    const name = segments[1] ? slug(decodeURIComponent(segments[1])) : undefined

    if (!name && method === "GET") return ok(await listPipelines(paths))
    if (!name) return { status: 400, body: { error: "pipeline name required" } }

    const file = path.join(paths.pipelines, `${name}.json`)

    if (segments[2] === "agents" && method === "POST") {
      return ok(await writeAgents(paths, name, await request.json(), request.search.get("merge") === "1"))
    }

    // Opening and saving are the two acts that mean "this is what I am working
    // on", so they are where the pipeline to reopen is recorded. Noting it on a
    // GET is a side effect on a read, which earns its keep here: it keeps the
    // memory right for any client of this store rather than only the canvas,
    // and re-noting the same name is idempotent.
    if (method === "GET") {
      const raw = await fs.readFile(file, "utf8").catch(() => undefined)
      if (raw === undefined) return { status: 404, body: { error: `pipeline "${name}" not found` } }
      rememberPipeline(paths.project, name)
      return ok(JSON.parse(raw))
    }
    if (method === "PUT") {
      const body = await request.json()
      // Every new pipeline is born called "untitled" and the templates ship
      // fixed names, so without this the second one saved silently destroys the
      // first. A save that reclaims its own file — same id — is the ordinary
      // case and goes through; a *different* pipeline landing on the same slug
      // is refused, and only an explicit `?overwrite=1` gets past it.
      const claimed = await claimant(file)
      if (claimed && typeof body?.id === "string" && claimed !== body.id && request.search.get("overwrite") !== "1")
        return {
          status: 409,
          body: { error: pipelineConflict(name), name, id: claimed },
        }
      await fs.mkdir(paths.pipelines, { recursive: true })
      await writeAtomic(file, JSON.stringify(body, null, 2) + "\n")
      rememberPipeline(paths.project, name)
      return ok({ name, path: file })
    }
    if (method === "DELETE") {
      await fs.rm(file, { force: true })
      // Forget it only when it was the remembered one — deleting some other
      // pipeline must not make the next launch open a blank canvas.
      if (recallPipeline(paths.project) === name) rememberPipeline(paths.project, "")
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

  if (segments[0] === "repackage") {
    if (method === "GET") return ok(await repackageStatus())
    if (method === "POST") {
      const body = await request.json().catch(() => ({}))
      const asked = Array.isArray(body?.providers) ? body.providers.map(String) : []
      // Only ids in the profile table are accepted, so no request can name an
      // arbitrary npm package for the engine to load.
      const ids = asked.filter((id: string) => COMPATIBLE_PROFILES[id])
      if (!ids.length) return { status: 400, body: { error: "no repackageable provider named" } }
      const result = await applyRepackage(ids)
      if ("error" in result) return { status: 409, body: result }
      return ok(result)
    }
  }

  if (segments[0] === "server") {
    if (!request.serve) return { status: 501, body: { error: "this host does not track `opencode serve`" } }
    if (segments.length === 1 && method === "GET") return ok(await request.serve.status())
    if (segments[1] === "restart" && method === "POST") {
      // Restarting spawns a process on the host. Served remotely that is a
      // remote process-control hole, so it is refused for the same reason the
      // native folder picker is — see `lib/guard.ts`.
      if (allowsRemote()) return { status: 403, body: { error: "restarting the engine is unavailable when serving remotely" } }
      const before = await request.serve.status()
      if (!before.managed) {
        // The C fallback: say who owns it and what to type, rather than
        // pretending a click can reach a process this host never spawned.
        return {
          status: 409,
          body: { error: before.reason ?? "this host does not own `opencode serve`", ...before },
        }
      }
      try {
        return ok(await request.serve.restart())
      } catch (error) {
        return {
          status: 502,
          body: { error: error instanceof Error ? error.message : String(error), ...(await request.serve.status()) },
        }
      }
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
    // Remembered here rather than in the UI: the browser cannot write to the
    // host, and this is the one place every project switch passes through.
    rememberProject(resolved)
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
      await writeAtomic(file, JSON.stringify(body, null, 2) + "\n")
      await updateRunsIndex(paths, id, body)
      return ok({ id, path: file })
    }
  }

  return undefined
}

function ok(body: unknown): FlowResponse {
  return { status: 200, body }
}

function rolesFile(paths: FlowPaths) {
  return path.join(paths.project, ".openflow", "roles.json")
}

/**
 * The user's own role cards.
 *
 * A file someone hand-edited into nonsense reads as "no custom roles" rather
 * than throwing, and is deliberately left on disk: overwriting it on a failed
 * read is how the recovery copy disappears before anyone can look at it.
 */
async function readRoles(paths: FlowPaths) {
  const raw = await fs.readFile(rolesFile(paths), "utf8").catch(() => undefined)
  if (!raw) return []
  let parsed: any = []
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (entry) => entry && typeof entry.id === "string" && typeof entry.label === "string" && entry.agent,
  )
}

async function writeRoles(paths: FlowPaths, body: unknown) {
  const file = rolesFile(paths)
  return serialize(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeAtomic(file, JSON.stringify(Array.isArray(body) ? body : [], null, 2) + "\n")
  })
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

/**
 * Where the run listing is cached. A leading dot is a name `slug` can never
 * produce, so no run can ever be written to this file.
 */
const RUNS_INDEX = ".index.json"

/**
 * The run listing, from a summary index rather than every run log.
 *
 * `refresh()` calls this at boot, after every run, and after every save, and
 * the old shape read and parsed *every* file in `.openflow/runs` each time —
 * a few hundred runs and boot stalls on megabytes of JSON nobody asked for.
 * The index is maintained on write and rebuilt whenever it stops describing
 * exactly the files on disk, which costs one `readdir` to check. Nothing is
 * ever deleted: a stale index is rebuilt, never trusted over the logs.
 */
async function listRuns(paths: FlowPaths) {
  const entries = (await fs.readdir(paths.runs).catch(() => [] as string[])).filter(
    (entry) => entry.endsWith(".json") && entry !== RUNS_INDEX,
  )
  const ids = entries.map((entry) => entry.slice(0, -5))
  const index = await readRunsIndex(paths)
  if (index && index.length === ids.length && index.every((entry) => ids.includes(entry.id))) return sortRuns(index)

  const rebuilt = await Promise.all(
    entries.map(async (entry) => {
      const raw = await fs.readFile(path.join(paths.runs, entry), "utf8").catch(() => "")
      return runSummary(entry.slice(0, -5), jsonOrUndefined(raw) ?? {})
    }),
  )
  // Best-effort: an index that cannot be written costs the next listing a
  // rebuild, and nothing else.
  await writeAtomic(path.join(paths.runs, RUNS_INDEX), JSON.stringify(rebuilt) + "\n").catch(() => {})
  return sortRuns(rebuilt)
}

function runSummary(id: string, parsed: any) {
  return {
    id,
    pipeline: parsed.pipeline,
    status: parsed.status,
    started: parsed.started,
    finished: parsed.finished,
    // Carried in the listing so the spend view can total every run without
    // reading each log back. Absent on runs written before usage existed —
    // those count as unknown, not as zero.
    usage: parsed.usage,
  }
}

function sortRuns(rows: ReturnType<typeof runSummary>[]) {
  return [...rows].sort((a, b) => (b.started ?? 0) - (a.started ?? 0))
}

async function readRunsIndex(paths: FlowPaths) {
  const raw = await fs.readFile(path.join(paths.runs, RUNS_INDEX), "utf8").catch(() => undefined)
  const parsed = raw === undefined ? undefined : jsonOrUndefined(raw)
  if (!Array.isArray(parsed)) return undefined
  return parsed.filter((entry) => entry && typeof entry.id === "string") as ReturnType<typeof runSummary>[]
}

/** Folds one run into the index, so the listing stays cheap without a rebuild. */
async function updateRunsIndex(paths: FlowPaths, id: string, body: any) {
  const file = path.join(paths.runs, RUNS_INDEX)
  return serialize(file, async () => {
    const current = (await readRunsIndex(paths)) ?? []
    const next = [...current.filter((entry) => entry.id !== id), runSummary(id, body)]
    await writeAtomic(file, JSON.stringify(next) + "\n").catch(() => {})
  })
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
  await writeAtomic(file, JSON.stringify(block, null, 2) + "\n")
  if (!merge) return { path: file, merged: false }

  const target = path.join(paths.project, "opencode.json")
  const pipeline = rawPipelineName(body, name)
  return serialize(target, async () => {
    const config = await readProjectConfig(paths)
    if ("error" in config) return { path: file, merged: false, error: config.error }
    // Fold the generated agents onto whatever is already there, dropping the ones
    // this pipeline generated last time that it no longer generates — a renamed
    // or deleted node would otherwise leave its agent behind forever, and a run
    // merges on every start, so the leftovers accumulate. Only entries this
    // pipeline is known to have written are dropped: they are recognised by the
    // description writeAgents itself stamps on them, so a hand-written agent is
    // never touched, whatever it is called.
    const current: Record<string, unknown> = config.value.agent ?? {}
    const kept = Object.fromEntries(
      Object.entries(current).filter(([key, value]) => key in block.agent || !generatedFor(value, pipeline)),
    )
    const nextAgent = { ...kept, ...block.agent }

    // Bail before touching disk when that leaves the block identical — an
    // auto-merge on every run must not churn opencode.json or litter a `.bak`
    // when nothing actually changed. Key order is ignored so a re-serialised but
    // equivalent config still counts as unchanged. When there is no config at all
    // and nothing to write into one, the generated file is the only path there is
    // to report.
    if (stableEqual(current, nextAgent))
      return { path: config.raw === undefined ? file : target, merged: false, unchanged: true }
    if (config.comments) return { path: file, merged: false, error: CONFIG_HAS_COMMENTS }
    const backup = config.raw === undefined ? undefined : await backupConfig(target, config.raw)
    config.value.agent = nextAgent
    await writeAtomic(target, JSON.stringify(config.value, null, 2) + "\n")
    return { path: target, merged: true, backup }
  })
}

/**
 * The pipeline's name as the user typed it.
 *
 * `agentBlock` stamps that raw name into every generated description, so it is
 * what `generatedFor` has to match on — but the route only ever carries the
 * slug (`my-flow` for `My Flow`), and matching on the slug quietly recognises
 * nothing. The agents of renamed or deleted nodes then survive forever and
 * every rename adds another generation. A caller that sends `pipeline` in the
 * body answers it directly; otherwise it is read back off the descriptions in
 * the block itself, which carry it verbatim.
 */
function rawPipelineName(body: any, slugged: string) {
  if (typeof body?.pipeline === "string" && body.pipeline.trim()) return body.pipeline.trim()
  for (const entry of Object.values<any>(body?.agent ?? {})) {
    const description = entry?.description
    const match = typeof description === "string" ? / of pipeline (.+)$/.exec(description) : undefined
    if (match) return match[1]
  }
  return slugged
}

/**
 * Whether an existing agent entry is one OpenFlow generated for this pipeline.
 *
 * The marker is the description `agentBlock` writes — `OpenFlow node <id>
 * (<role>) of pipeline <name>` — rather than the agent's key, because keys are
 * derived from the pipeline and role and a hand-written agent is free to
 * collide with that shape. An entry that does not carry the marker is somebody
 * else's and is left alone.
 */
function generatedFor(entry: unknown, pipeline: string): boolean {
  if (!entry || typeof entry !== "object") return false
  const description = (entry as { description?: unknown }).description
  return typeof description === "string" && description.endsWith(` of pipeline ${pipeline}`)
}

/** Canonical JSON with object keys sorted, so two equal configs compare equal regardless of key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}

function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
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
  return serialize(target, async () => {
    const config = await readProjectConfig(paths)
    if ("error" in config) throw new Error(config.error)
    // Saving a server the config already describes writes nothing, for the same
    // reason an unchanged agent merge does: a pointless rewrite would push the
    // pre-OpenFlow `.bak` one slot further out of reach.
    if (stableEqual(config.value.mcp?.[name], entry)) return { name, path: target, unchanged: true }
    if (config.comments) throw new Error(CONFIG_HAS_COMMENTS)
    const backup = config.raw === undefined ? undefined : await backupConfig(target, config.raw)
    const next = config.value
    next.mcp = { ...(next.mcp ?? {}), [name]: entry }
    if (!next.$schema) next.$schema = "https://opencode.ai/config.json"
    await writeAtomic(target, JSON.stringify(next, null, 2) + "\n")
    return { name, path: target, backup }
  })
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
  return serialize(target, async () => {
    const config = await readProjectConfig(paths)
    if ("error" in config) throw new Error(config.error)
    if (config.raw === undefined || !config.value.mcp || !(name in config.value.mcp)) return { name, removed: false }
    if (config.comments) throw new Error(CONFIG_HAS_COMMENTS)
    const backup = await backupConfig(target, config.raw)
    delete config.value.mcp[name]
    await writeAtomic(target, JSON.stringify(config.value, null, 2) + "\n")
    return { name, removed: true, path: target, backup }
  })
}

/**
 * Reads the project's opencode.json. A missing file is not an error — it is a
 * project that has never been configured — but an unparseable one is, because
 * writing over it would destroy hand-written config.
 *
 * `comments` says the source carried them. Reading is unaffected; writing is
 * not, because this module re-serialises the parsed value and would drop every
 * comment on the way back out.
 */
async function readProjectConfig(
  paths: FlowPaths,
): Promise<{ value: any; raw: string | undefined; comments: boolean } | { error: string }> {
  const raw = await fs.readFile(path.join(paths.project, "opencode.json"), "utf8").catch(() => undefined)
  if (raw === undefined)
    return { value: { $schema: "https://opencode.ai/config.json" }, raw: undefined, comments: false }
  const stripped = stripJsonc(raw)
  const value = jsonOrUndefined(stripped.text)
  if (value === undefined) return { error: "existing opencode.json is not valid JSON" }
  return { value, raw, comments: stripped.comments }
}

/**
 * Reads opencode's *global* config — the one file that reaches a run.
 *
 * `.jsonc` is preferred when it is the file that exists, because opencode reads
 * both and writing the override into the other one would leave it unread. A
 * missing file is a machine that has never configured opencode, not an error.
 */
async function readGlobalConfig() {
  const candidates = globalConfigCandidates()
  for (const target of candidates) {
    const raw = await fs.readFile(target, "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const stripped = stripJsonc(raw)
    const value = jsonOrUndefined(stripped.text)
    if (value === undefined) return { target, error: `${target} is not valid JSON` }
    return { target, value, raw, comments: stripped.comments }
  }
  return {
    target: candidates[0],
    value: { $schema: "https://opencode.ai/config.json" },
    raw: undefined,
    comments: false,
  }
}

/** Which OpenAI-compatible providers the global config already repackages. */
async function repackageStatus() {
  const config = await readGlobalConfig()
  const available = Object.keys(COMPATIBLE_PROFILES)
  if ("error" in config) return { path: config.target, applied: [], available, error: config.error }
  return { path: config.target, applied: repackaged(config.value), available }
}

/**
 * Writes the override into the global config, backing the file up first.
 *
 * The engine reads config once at boot, so `restart: true` is not advice — the
 * models stay unroutable until `opencode serve` is restarted.
 */
async function applyRepackage(ids: string[]) {
  const config = await readGlobalConfig()
  if ("error" in config) return { error: config.error, path: config.target }
  const result = repackage(config.value, ids)
  if (!result.changed.length)
    return { path: config.target, changed: [], applied: repackaged(config.value), restart: false }
  if (config.comments)
    return {
      error: `${config.target} has comments, and saving would strip them — remove the comments, or add the provider override there by hand`,
      path: config.target,
    }
  return serialize(config.target, async () => {
    const backup = config.raw === undefined ? undefined : await backupConfig(config.target, config.raw)
    await fs.mkdir(path.dirname(config.target), { recursive: true })
    await writeAtomic(config.target, JSON.stringify(result.value, null, 2) + "\n")
    return { path: config.target, changed: result.changed, applied: repackaged(result.value), backup, restart: true }
  })
}

const CONFIG_HAS_COMMENTS =
  "existing opencode.json has comments, and saving would strip them — remove the comments, or make this change in opencode.json by hand"

/**
 * Reads opencode's config dialect rather than strict JSON.
 *
 * `packages/core/src/config.ts` parses `opencode.json` with `jsonc-parser` and
 * `allowTrailingComma`, so comments and a trailing comma are a perfectly valid
 * config there. Rejecting them as "not valid JSON" fails every config write for
 * a user whose config opencode itself is happy with: the agent merge fails, the
 * MCP panel shows nothing, and a skill gets written but never registered.
 * `jsonc-parser` is not reachable from this package, so the two extensions are
 * stripped here instead, string-aware so a comma or a `//` inside a value is
 * left alone.
 */
function stripJsonc(raw: string) {
  let out = ""
  let comments = false
  let index = 0
  while (index < raw.length) {
    const char = raw[index]
    if (char === '"') {
      const start = index
      index++
      while (index < raw.length && raw[index] !== '"') index += raw[index] === "\\" ? 2 : 1
      index++
      out += raw.slice(start, index)
      continue
    }
    if (char === "/" && raw[index + 1] === "/") {
      comments = true
      const end = raw.indexOf("\n", index)
      index = end === -1 ? raw.length : end
      continue
    }
    if (char === "/" && raw[index + 1] === "*") {
      comments = true
      const end = raw.indexOf("*/", index + 2)
      index = end === -1 ? raw.length : end + 2
      continue
    }
    // Strings are consumed whole above, so reaching a closer here means `out`
    // ends at a structural position and a comma sitting there is the trailing
    // one opencode allows and `JSON.parse` does not.
    if (char === "}" || char === "]") out = out.replace(/,\s*$/, "")
    out += char
    index++
  }
  return { text: out, comments }
}

/** Parse guard: `undefined` rather than a throw, for the callers that treat unparseable as a state. */
function jsonOrUndefined(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
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
  // Registration first, on purpose: it is the step that can fail, and a
  // `SKILL.md` written next to an unregistered source is a skill the agent can
  // never see. Its failure rides back out on the response either way, rather
  // than being skipped because an earlier line already reported success.
  const source = await registerSkillSource(paths)
  const dir = path.join(paths.skills, name)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, "SKILL.md")
  await writeAtomic(
    file,
    buildSkillMarkdown({
      name: oneLine(body?.name) || name,
      description: oneLine(body?.description),
      content: typeof body?.content === "string" ? body.content : "",
    }),
  )
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
  return serialize(target, async () => {
    const config = await readProjectConfig(paths)
    if ("error" in config) return { registered: false, error: config.error }
    if (config.raw === undefined) {
      config.value.skills = { paths: [SKILL_SOURCE] }
      await writeAtomic(target, JSON.stringify(config.value, null, 2) + "\n")
      return { registered: true, backup: undefined }
    }
    // A config written by an older build may hold a bare array here. Treat it as
    // the paths list so this rewrites it into the shape the schema accepts,
    // rather than spreading its indices into the object.
    const legacy = Array.isArray(config.value.skills)
    const block = legacy ? { paths: config.value.skills } : config.value.skills ?? {}
    const current: string[] = Array.isArray(block.paths) ? block.paths : []
    if (!legacy && current.includes(SKILL_SOURCE)) return { registered: false }
    if (config.comments) return { registered: false, error: CONFIG_HAS_COMMENTS }
    const backup = await backupConfig(target, config.raw)
    config.value.skills = { ...block, paths: current.includes(SKILL_SOURCE) ? current : [...current, SKILL_SOURCE] }
    await writeAtomic(target, JSON.stringify(config.value, null, 2) + "\n")
    return { registered: true, backup }
  })
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
  await writeAtomic(file, raw)
  return file
}

/**
 * Reduces a name to something that cannot leave its directory: separators and
 * anything else a path could hide in are dropped, and leading and trailing dots
 * go with them, so `../../etc/passwd` lands as `etcpasswd.json` inside
 * `.openflow`.
 *
 * Unicode letters and numbers survive. Restricting this to ASCII collapsed
 * every fully non-Latin name — Japanese, Chinese, Russian, Arabic — onto
 * `untitled`, which means the second such pipeline a user saves erases the
 * first; `café` also lost its accent and landed as `caf`.
 *
 * Lowercasing is deliberate and load-bearing: a filesystem that is
 * case-insensitive (NTFS, APFS by default) already treats `Alpha.json` and
 * `alpha.json` as one file, so leaving case in only hid the collision — the
 * listing kept showing `Alpha` while its content had become `alpha`'s. Folding
 * case here makes the two names collide *visibly*, where the save route can
 * refuse them.
 */
export function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\-_ .]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/^\.+|\.+$/g, "") || "untitled"
  )
}

/** The id stored in the pipeline file already holding this slug, when there is one. */
async function claimant(file: string) {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  const id = raw === undefined ? undefined : jsonOrUndefined(raw)?.id
  return typeof id === "string" ? id : undefined
}

/** The message a UI shows verbatim when a save would land on somebody else's file. */
function pipelineConflict(name: string) {
  return `a different pipeline is already saved as "${name}" — rename this one, or save again to replace it`
}

/**
 * Writes `data` by landing it on a temp file beside the target and renaming it
 * into place.
 *
 * A rename within one directory is atomic on NTFS and on POSIX, so a crash, a
 * power loss, or a full disk leaves either the whole old file or the whole new
 * one — never the truncated middle a plain `writeFile` can leave behind. That
 * matters most for `opencode.json`, which an agent merge rewrites on *every*
 * run and which opencode hard-fails on when it cannot be parsed: one bad write
 * bricks every card in the project. Beside the target rather than in the OS
 * temp directory, because a cross-volume rename is a copy and is not atomic.
 */
async function writeAtomic(file: string, data: string) {
  const temp = `${file}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`
  await fs.writeFile(temp, data)
  // Windows hands back EPERM or EBUSY when a virus scanner or indexer holds the
  // target open for a moment, so the rename is retried before it is fatal.
  for (let attempt = 0; ; attempt++) {
    const failure = await fs.rename(temp, file).then(
      () => undefined,
      (reason) => reason,
    )
    if (!failure) return
    if (attempt === 2) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw failure
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * Runs `work` only after every earlier call for the same `key` has finished.
 *
 * Four routes read-modify-write `opencode.json` — an agent merge (which runs on
 * every click of Run), an MCP upsert, an MCP delete, and a skill registration —
 * and running any two of them interleaved means both read the same pre-state
 * and the second write silently discards the first. Each of them re-reads the
 * file *inside* its turn here rather than before it, which is what makes the
 * serialisation worth anything.
 *
 * In-process only. Two hosts on one project still race, but `writeAtomic` keeps
 * each of their writes whole, so the loser is a lost edit rather than a broken
 * config.
 */
const chains = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  // `work` runs on both settlements: a caller whose turn threw must not wedge
  // the queue for everyone behind it.
  const next = (chains.get(key) ?? Promise.resolve()).then(work, work)
  chains.set(
    key,
    next.catch(() => undefined),
  )
  return next
}

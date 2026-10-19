import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { allowsRemote } from "./guard"
import { recallPipeline, rememberPipeline, rememberProject } from "./last-session"
import { hasNativePicker, pickFolderNative } from "./native-picker"
import { checkpoint, dropCheckpoints } from "./checkpoint"
import { dropScratch, openScratch } from "./scratch"
import { treeStat } from "./diffstat"
import { cleanupWorktrees, mergeWorktrees, openWorktrees } from "./worktree"

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
 *   GET    /flow/api/mcp                   -> [{ name, type, enabled, command?, url?, ... }]
 *   PUT    /flow/api/mcp/:name             -> upsert an mcp server in the Omp profile's mcp.json
 *   DELETE /flow/api/mcp/:name             -> drop it from there
 *   GET    /flow/api/skills                -> [{ name, description, updated, legacy? }]
 *   GET    /flow/api/skills/:name          -> { name, folder, description, content, path, legacy? }
 *   PUT    /flow/api/skills/:name          -> write <profile>/skills/<name>/SKILL.md
 *   DELETE /flow/api/skills/:name          -> delete that skill folder
 *   GET    /flow/api/runs                  -> [{ id, pipeline, status, started, finished }]
 *   GET    /flow/api/runs/:id              -> run log json
 *   PUT    /flow/api/runs/:id              -> write run log json
 *   GET    /flow/api/treestat              -> the tree's line counts right now, or null off git
 *   POST   /flow/api/worktrees             -> { run, cards } -> a git worktree per card
 *   POST   /flow/api/worktrees/merge       -> { trees, base } -> what landed and what conflicted
 *   POST   /flow/api/worktrees/cleanup     -> { run, trees } -> remove the trees and branches
 *   DELETE /flow/api/runs/:id              -> delete one run log
 *   POST   /flow/api/runs/prune            -> { keep?, days? } -> { removed: [id], kept }
 *   GET    /flow/api/env?names=A,B         -> { present: ["A"] } — names only, never values
 *   GET    /flow/api/browse?path=          -> { path, parent, entries } — subdirectories of `path`
 *                                             (drive roots on Windows when `path` is omitted)
 *   POST   /flow/api/pick-folder           -> { path } — native OS folder dialog on the host,
 *                                             `null` when cancelled (loopback hosts only)
 *   POST   /flow/api/project               -> { path } — switch the live project directory,
 *                                             and remember it for the next launch
 *
 * MCP servers and skills belong to the Omp profile the cards run under, not to
 * the project: the composer hands over that profile's config directory as
 * `profileDir`, and both routes answer 409 until it is known. Skills authored
 * by older builds under `.openflow/skills` are still listed (`legacy: true`)
 * but never written, moved or deleted here.
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
  /**
   * The config directory of the Omp profile the cards run under (what
   * `omp --profile <name> config path` prints). Unknown until Omp settings
   * have been resolved, which the mcp and skills routes report as a 409.
   */
  profileDir?: () => Promise<string | undefined>
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

    if (!name && method !== "GET") return { status: 400, body: { error: "mcp server name required" } }

    if (!name || method === "PUT" || method === "DELETE") {
      const profile = await request.profileDir?.()
      if (!profile) return noProfile()
      const file = path.join(profile, "mcp.json")
      if (!name) return ok(await listMcpServers(file))
      try {
        if (method === "DELETE") return ok(await deleteMcpServer(file, name))
        return ok(await writeMcpServer(file, name, await request.json()))
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
      }
    }
  }

  if (segments[0] === "skills") {
    const name = segments[1] ? slug(decodeURIComponent(segments[1])) : undefined

    if (!name && method !== "GET") return { status: 400, body: { error: "skill name required" } }

    // Reading works without a profile — the legacy skills live in the project —
    // but anything that writes has nowhere to go.
    if (!name) return ok(await listSkills(paths, await request.profileDir?.()))

    if (method === "GET") {
      const found = await readSkill(paths, await request.profileDir?.(), name)
      if (!found) return { status: 404, body: { error: `skill "${name}" not found` } }
      return ok(found)
    }
    if (method === "PUT" || method === "DELETE") {
      const profile = await request.profileDir?.()
      if (!profile) return noProfile()
      if (method === "PUT") return ok(await writeSkill(profile, name, await request.json()))
      const dir = path.join(profile, "skills", name)
      const existed = await fs.stat(dir).then(
        () => true,
        () => false,
      )
      await fs.rm(dir, { recursive: true, force: true })
      return ok({ name, removed: existed })
    }
  }

  if (segments[0] === "env" && method === "GET") {
    // Which of the asked-for names are set, and nothing else: the answer is a
    // subset of the question, so no value and no unrelated variable can leak
    // to the browser.
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
    // Remembered here rather than in the UI: the browser cannot write to the
    // host, and this is the one place every project switch passes through.
    rememberProject(resolved)
    return ok(paths)
  }

  // A snapshot of what the project's tree currently has that HEAD does not.
  // Meaningless on its own: the engine takes one before a batch and one after,
  // and the difference is what that batch wrote.
  if (segments[0] === "treestat" && method === "GET") {
    const files = await treeStat(paths.project)
    return ok({ files: files ?? null })
  }

  // A commit of the working tree as this round left it, under a ref of our
  // own. Nothing is restored from here — see `lib/checkpoint.ts`.
  if (segments[0] === "checkpoint" && method === "POST") {
    const body = await request.json().catch(() => ({}) as any)
    return ok((await checkpoint(paths.project, String(body.run ?? ""), Number(body.round ?? 0))) ?? null)
  }

  // A directory outside the project for output that is not the work. See
  // `lib/scratch.ts` — the write refusal stops the tools, not the shell.
  if (segments[0] === "scratch" && method === "POST") {
    const body = await request.json().catch(() => ({}) as any)
    return ok({ path: (await openScratch(String(body.run ?? ""))) ?? null })
  }

  if (segments[0] === "worktrees" && method === "POST") {
    const body = await request.json().catch(() => ({}) as any)
    if (segments[1] === "merge") return ok(await mergeWorktrees(paths.project, body.trees ?? [], body.base ?? ""))
    if (segments[1] === "cleanup") {
      await cleanupWorktrees(paths.project, String(body.run ?? ""), body.trees ?? [])
      return ok({ removed: true })
    }
    if (segments[1]) return { status: 404, body: { error: `unknown worktree route "${segments[1]}"` } }
    return ok(await openWorktrees(paths.project, String(body.run ?? ""), body.cards ?? []))
  }

  if (segments[0] === "runs") {
    // Checked before the id is read: a run id is a uuid, but the literal word
    // would otherwise address a log file rather than the prune it names.
    if (segments[1] === "prune" && method === "POST") {
      const body = await request.json().catch(() => ({}))
      return ok(await pruneRuns(paths, body))
    }
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
    if (method === "DELETE") {
      const removed = await removeRun(paths, id)
      if (!removed) return { status: 404, body: { error: `run "${id}" not found` } }
      return ok({ id, removed: true })
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
    // How big the run was, so the listing can say it without opening the log.
    // An index written before this existed is still a valid description of the
    // files on disk, so it is not rebuilt for this — those rows simply carry no
    // count, and every run recorded from here on does.
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes.length : undefined,
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

/**
 * Deletes one run log, and the index row describing it.
 *
 * The log goes first: an index that still lists a file nobody can read is
 * repaired by the next listing, while a file left behind after its row was
 * dropped comes *back* the next time the index is rebuilt — so a failed delete
 * has to look like no delete at all rather than like a run that keeps
 * reappearing.
 */
async function removeRun(paths: FlowPaths, id: string) {
  const removed = await fs
    .rm(path.join(paths.runs, `${id}.json`))
    .then(() => true)
    .catch(() => false)
  if (removed) await removeFromRunsIndex(paths, [id])
  // Deleting the recording is the moment the user has said they are finished
  // with the run, and it is the only moment: a checkpoint outliving its run is
  // the whole point of taking one, so nothing drops these when a run ends.
  if (removed) await dropCheckpoints(paths.project, id).catch(() => 0)
  if (removed) await dropScratch(id)
  return removed
}

/**
 * Deletes recorded runs the retention rules no longer keep.
 *
 * A run is removed when it fails **any** rule that was given, which is how the
 * two read together out loud: `{ keep: 20, days: 30 }` is "at most twenty, and
 * nothing older than a month". Called with neither rule it deletes nothing —
 * an empty body must not mean "everything" on a route that cannot be undone.
 *
 * A run still marked `running` is never pruned whatever its age. That status
 * on disk is what the resume path looks for — the engine lives in the page, so
 * a closed tab leaves the log saying `running` while its sessions are still
 * alive on the server — and an old one is the *most* likely to be forgotten,
 * so age is exactly the wrong reason to throw it away.
 */
async function pruneRuns(paths: FlowPaths, rules: { keep?: number; days?: number }) {
  const keep = Number.isFinite(rules.keep) ? Math.max(0, Math.floor(rules.keep as number)) : undefined
  const days = Number.isFinite(rules.days) ? Math.max(0, rules.days as number) : undefined
  if (keep === undefined && days === undefined) return { removed: [] as string[], kept: (await listRuns(paths)).length }

  const before = days === undefined ? undefined : Date.now() - days * 86_400_000
  // Newest first, so rank is position in this list.
  const entries = await listRuns(paths)
  const doomed = entries.filter(
    (entry, rank) =>
      entry.status !== "running" &&
      ((keep !== undefined && rank >= keep) || (before !== undefined && (entry.started ?? 0) < before)),
  )
  const removed: string[] = []
  for (const entry of doomed) {
    await dropCheckpoints(paths.project, entry.id).catch(() => 0)
    await dropScratch(entry.id)
    if (
      await fs
        .rm(path.join(paths.runs, `${entry.id}.json`))
        .then(() => true)
        .catch(() => false)
    )
      removed.push(entry.id)
  }
  if (removed.length) await removeFromRunsIndex(paths, removed)
  return { removed, kept: entries.length - removed.length }
}

/** Drops rows from the index. Best-effort: a failure costs the next listing a rebuild. */
async function removeFromRunsIndex(paths: FlowPaths, ids: string[]) {
  const file = path.join(paths.runs, RUNS_INDEX)
  const gone = new Set(ids)
  return serialize(file, async () => {
    const current = await readRunsIndex(paths)
    if (!current) return
    await writeAtomic(file, JSON.stringify(current.filter((entry) => !gone.has(entry.id))) + "\n").catch(() => {})
  })
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

function noProfile(): FlowResponse {
  return { status: 409, body: { error: "omp profile directory unknown: open Omp settings" } }
}

/**
 * MCP server names become part of a tool name (`mcp__<server>_<tool>`), so
 * anything the sanitiser would rewrite is rejected here instead of silently
 * producing a server nobody can address from a per-node allowlist. This is
 * stricter than omp itself, which also accepts `.`, `:` and inner spaces.
 */
export function mcpName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9-_]/g, "-")
}

const MCP_SCHEMA =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json"

/**
 * The keys of a server entry that the browser's `McpServer` form owns. Every
 * other key of an existing entry (`auth`, `oauth`, `instructions`,
 * `requestIdFormat`, ...) belongs to the user and survives an edit untouched.
 */
const MCP_MANAGED = ["type", "command", "args", "env", "cwd", "url", "headers", "timeout", "enabled"]

/**
 * The `mcpServers` block of the Omp profile's `mcp.json`, as rows.
 *
 * An unreadable file lists as empty rather than throwing: the panel must still
 * open so the user can see there is nothing to show. Writes refuse the same
 * file instead, so it is never overwritten.
 */
async function listMcpServers(file: string): Promise<McpServer[]> {
  const config = await readMcpFile(file).catch(() => undefined)
  if (!config) return []
  const servers = (config.value.mcpServers ?? {}) as Record<string, unknown>
  const disabled = stringList(config.value.disabledServers)
  const forced = stringList(config.value.enabledServers)
  return Object.entries(servers)
    .map(([name, entry]) => normalizeMcp(name, entry, !disabled.includes(name), forced.includes(name)))
    .filter((entry): entry is McpServer => Boolean(entry))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * `enabled` follows omp: `disabledServers` always wins, an `enabled: false`
 * entry is switched back on only by `enabledServers`.
 */
function normalizeMcp(name: string, entry: any, listed: boolean, forced: boolean): McpServer | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const enabled = listed && (entry.enabled !== false || forced)
  const timeout = typeof entry.timeout === "number" ? entry.timeout : undefined
  // A URL-only entry is http, which is how omp's own discovery reads it.
  if (entry.type === "http" || entry.type === "sse" || (entry.type === undefined && !entry.command && entry.url)) {
    return {
      name,
      type: "remote",
      enabled,
      url: typeof entry.url === "string" ? entry.url : "",
      headers: isStringRecord(entry.headers) ? entry.headers : undefined,
      timeout,
    }
  }
  return {
    name,
    type: "local",
    enabled,
    command: typeof entry.command === "string" ? [entry.command, ...stringList(entry.args)] : [],
    cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
    environment: isStringRecord(entry.env) ? entry.env : undefined,
    timeout,
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) && typeof value === "object" && Object.values(value as object).every((v) => typeof v === "string")
  )
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/**
 * Reads `mcp.json`. A missing file is a profile that has no MCP servers yet,
 * not an error — but anything else that stops it being read as an object is,
 * because writing over it would destroy hand-written config.
 */
async function readMcpFile(file: string): Promise<{ value: Record<string, any>; raw: string | undefined }> {
  const raw = await fs.readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined || !raw.trim()) return { value: {}, raw }
  const value = jsonOrUndefined(raw)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("existing mcp.json is not a valid JSON object")
  const servers = value.mcpServers
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers)))
    throw new Error("existing mcp.json has an mcpServers that is not an object")
  return { value, raw }
}

/**
 * Writes one server into `mcpServers`, after a backup.
 *
 * Validation is not politeness: a local server with no command and a remote
 * one with no url are entries omp rejects at load, and a config it refuses
 * takes the server list of every card down, not just this server.
 *
 * Saving an enabled server also lifts it off `disabledServers`, which would
 * otherwise keep it off whatever its own `enabled` says.
 */
async function writeMcpServer(file: string, name: string, body: any) {
  return serialize(file, async () => {
    const config = await readMcpFile(file)
    const servers = (config.value.mcpServers ?? {}) as Record<string, any>
    const entry = buildMcpEntry(body, servers[name])
    const disabled = stringList(config.value.disabledServers)
    const lift = entry.enabled && disabled.includes(name)
    // Saving a server the config already describes writes nothing, so a
    // pointless rewrite does not push the pre-OpenFlow `.bak` out of reach.
    if (isDeepStrictEqual(servers[name], entry) && !lift) return { name, path: file, unchanged: true }
    const next: Record<string, unknown> = {
      ...(config.raw?.trim() ? {} : { $schema: MCP_SCHEMA }),
      ...config.value,
      mcpServers: { ...servers, [name]: entry },
    }
    if (lift) next.disabledServers = disabled.filter((item) => item !== name)
    const backup = await backupOnce(file, config.raw)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeAtomic(file, jsonText(next, config.raw))
    return { name, path: file, backup }
  })
}

function buildMcpEntry(body: any, existing: Record<string, unknown> | undefined) {
  const enabled = body?.enabled !== false
  const timeout = typeof body?.timeout === "number" && body.timeout > 0 ? body.timeout : undefined
  const kept = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => !MCP_MANAGED.includes(key)))
  if (body?.type === "remote") {
    const url = typeof body.url === "string" ? body.url.trim() : ""
    if (!url) throw new Error("a remote mcp server needs a url")
    const headers = pickStrings(body.headers)
    return {
      ...kept,
      // The form has no transport switch, so a server saved as sse stays sse.
      type: existing?.type === "sse" ? "sse" : "http",
      url,
      ...(headers ? { headers } : {}),
      ...(timeout ? { timeout } : {}),
      enabled,
    }
  }
  const command = Array.isArray(body?.command) ? body.command.map(String).filter((part: string) => part.length) : []
  if (!command.length) throw new Error("a local mcp server needs a command")
  const env = pickStrings(body?.environment)
  const cwd = typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined
  return {
    ...kept,
    type: "stdio",
    command: command[0],
    ...(command.length > 1 ? { args: command.slice(1) } : {}),
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
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

async function deleteMcpServer(file: string, name: string) {
  return serialize(file, async () => {
    const config = await readMcpFile(file)
    const servers = config.value.mcpServers as Record<string, unknown> | undefined
    if (config.raw === undefined || !servers || !(name in servers)) return { name, removed: false }
    const { [name]: _removed, ...remaining } = servers
    const backup = await backupOnce(file, config.raw)
    await writeAtomic(file, jsonText({ ...config.value, mcpServers: remaining }, config.raw))
    return { name, removed: true, path: file, backup }
  })
}

/** Serialises with the indentation the file already used, so a rewrite does not reflow the whole file. */
function jsonText(value: unknown, original: string | undefined) {
  const indent = original ? /^([ \t]+)"/m.exec(original)?.[1] : undefined
  return JSON.stringify(value, null, indent ?? 2) + "\n"
}

/** Parse guard: `undefined` rather than a throw, for the callers that treat unparseable as a state. */
function jsonOrUndefined(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type SkillRow = { name: string; description?: string; updated: number; legacy?: true }

/**
 * Lists the skills omp will load for the profile (`<profile>/skills/*\/SKILL.md`)
 * followed by the ones older builds authored under `.openflow/skills`, which
 * omp never sees any more and are marked `legacy`. A legacy skill that a
 * profile skill of the same name has superseded is not listed twice.
 */
async function listSkills(paths: FlowPaths, profile: string | undefined) {
  const own = profile ? await skillsIn(path.join(profile, "skills"), false) : []
  const taken = new Set(own.map((row) => row.name))
  const legacy = (await skillsIn(paths.skills, true)).filter((row) => !taken.has(row.name))
  return [...own, ...legacy].sort((a, b) => b.updated - a.updated)
}

/**
 * Reads each folder's `SKILL.md` frontmatter. A folder without a readable
 * `SKILL.md` is skipped rather than surfaced as a broken row; entries are not
 * filtered to directories, because a skill folder may be a symlink.
 */
async function skillsIn(root: string, legacy: boolean): Promise<SkillRow[]> {
  const entries = await fs.readdir(root).catch(() => [] as string[])
  const out: SkillRow[] = []
  for (const entry of entries) {
    const file = path.join(root, entry, "SKILL.md")
    const [raw, stat] = await Promise.all([
      fs.readFile(file, "utf8").catch(() => undefined),
      fs.stat(file).catch(() => undefined),
    ])
    if (raw === undefined || !stat) continue
    out.push({
      name: entry,
      description: parseSkillMarkdown(raw).description,
      updated: stat.mtimeMs,
      ...(legacy ? { legacy: true as const } : {}),
    })
  }
  return out
}

/**
 * Reads one skill's frontmatter and body back for editing, or undefined if
 * absent. The profile's copy wins over a legacy one of the same name.
 *
 * `name` is the frontmatter name when the file carries one — that is the identity
 * the agent sees, and it can differ from the folder slug (`Summarize` in
 * `summarize/`). Returning the slug instead would make an edit round-trip rewrite
 * the frontmatter to the slug and silently rename the skill. `folder` carries the
 * slug for callers that need to address the skill over the API.
 */
async function readSkill(paths: FlowPaths, profile: string | undefined, name: string) {
  const roots = [...(profile ? [{ root: path.join(profile, "skills"), legacy: false }] : []), { root: paths.skills, legacy: true }]
  for (const { root, legacy } of roots) {
    const file = path.join(root, name, "SKILL.md")
    const raw = await fs.readFile(file, "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const meta = parseSkillMarkdown(raw)
    return {
      name: meta.name ?? name,
      folder: name,
      description: meta.description,
      content: meta.content,
      path: file,
      ...(legacy ? { legacy: true as const } : {}),
    }
  }
  return undefined
}

/**
 * Writes `<profile>/skills/<name>/SKILL.md`, which omp discovers on its own
 * (`<agentDir>/skills/*\/SKILL.md`), so there is nothing to register. The
 * frontmatter name defaults to the folder slug so the two never drift. omp
 * loads a skill only at session start, so a new one reaches the next card.
 */
async function writeSkill(profile: string, name: string, body: any) {
  const dir = path.join(profile, "skills", name)
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
  return { name, path: file }
}

/**
 * Serialises a skill to the `SKILL.md` shape omp discovers: a small YAML
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
 * Copies a config aside before it is rewritten, once. `.bak` is the file as it
 * was before OpenFlow first touched it and is never overwritten: every later
 * rewrite would otherwise replace the original with an already-edited copy,
 * quietly. Returns the backup's path, or undefined when there was nothing to
 * back up.
 */
async function backupOnce(target: string, raw: string | undefined) {
  if (raw === undefined) return undefined
  const backup = `${target}.bak`
  await fs.writeFile(backup, raw, { flag: "wx" }).catch((error) => {
    if (error?.code !== "EEXIST") throw error
  })
  return backup
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
 * matters most for `mcp.json`, which a profile's every card session reads at
 * start: one truncated write there breaks them all. Beside the target rather
 * than in the OS temp directory, because a cross-volume rename is a copy and
 * is not atomic.
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
 * Read-modify-write routes (an MCP upsert, an MCP delete, the roles list, the
 * runs index) run two at a time interleaved: both read the same pre-state and
 * the second write silently discards the first. Each of them re-reads the
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

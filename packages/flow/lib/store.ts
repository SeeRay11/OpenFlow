import fs from "node:fs/promises"
import path from "node:path"

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
 *   GET    /flow/api/runs                  -> [{ id, pipeline, status, started, finished }]
 *   GET    /flow/api/runs/:id              -> run log json
 *   PUT    /flow/api/runs/:id              -> write run log json
 *
 * Keeping it host-neutral is the point: the dev server and the built app must
 * not drift into two different stores.
 */
export type FlowPaths = {
  project: string
  pipelines: string
  runs: string
  generated: string
}

export function flowPaths(project: string): FlowPaths {
  const root = path.resolve(project)
  return {
    project: root,
    pipelines: path.join(root, ".openflow", "pipelines"),
    runs: path.join(root, ".openflow", "runs"),
    generated: path.join(root, ".openflow", "generated"),
  }
}

export type FlowRequest = {
  method: string
  /** Path with or without the `/flow/api` prefix. */
  path: string
  search: URLSearchParams
  json: () => Promise<any>
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

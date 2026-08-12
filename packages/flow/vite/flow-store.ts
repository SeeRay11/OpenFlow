import fs from "node:fs/promises"
import path from "node:path"
import type { Connect, Plugin, ViteDevServer } from "vite"

/**
 * Dev-server middleware that persists OpenFlow state on disk.
 *
 * The canvas runs in a browser and cannot touch the filesystem, so the vite dev
 * server exposes a small REST surface under `/flow/api/*`:
 *
 *   GET    /flow/api/context               -> { project, pipelines, runs }
 *   GET    /flow/api/pipelines             -> [{ name, id, updated }]
 *   GET    /flow/api/pipelines/:name       -> pipeline json
 *   PUT    /flow/api/pipelines/:name       -> save pipeline json
 *   DELETE /flow/api/pipelines/:name       -> delete pipeline
 *   POST   /flow/api/pipelines/:name/agents?merge=1
 *                                          -> write generated opencode agent defs
 *   GET    /flow/api/runs                  -> [{ id, pipeline, time, status }]
 *   GET    /flow/api/runs/:id              -> run log json
 *   PUT    /flow/api/runs/:id              -> write run log json
 */
export function flowStore(options: { project: string }): Plugin {
  const project = path.resolve(options.project)
  const root = path.join(project, ".openflow")
  const pipelines = path.join(root, "pipelines")
  const runs = path.join(root, "runs")
  const generated = path.join(root, "generated")

  return {
    name: "openflow-store",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/flow/api", async (req, res, next) => {
        try {
          await handle(req, res, next)
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      })
    },
  }

  async function handle(req: Connect.IncomingMessage, res: any, next: Connect.NextFunction) {
    const url = new URL(req.url ?? "/", "http://localhost")
    const segments = url.pathname.split("/").filter(Boolean)
    const method = req.method ?? "GET"

    if (segments[0] === "context" && method === "GET") {
      return json(res, 200, { project, pipelines, runs, generated })
    }

    if (segments[0] === "pipelines") {
      const name = segments[1] ? slug(decodeURIComponent(segments[1])) : undefined

      if (!name && method === "GET") return json(res, 200, await listPipelines())
      if (!name) return json(res, 400, { error: "pipeline name required" })

      const file = path.join(pipelines, `${name}.json`)

      if (segments[2] === "agents" && method === "POST") {
        const body = await read(req)
        const target = url.searchParams.get("merge") === "1"
        return json(res, 200, await writeAgents(name, body, target))
      }

      if (method === "GET") {
        const raw = await fs.readFile(file, "utf8").catch(() => undefined)
        if (raw === undefined) return json(res, 404, { error: `pipeline "${name}" not found` })
        return json(res, 200, JSON.parse(raw))
      }
      if (method === "PUT") {
        const body = await read(req)
        await fs.mkdir(pipelines, { recursive: true })
        await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n")
        return json(res, 200, { name, path: file })
      }
      if (method === "DELETE") {
        await fs.rm(file, { force: true })
        return json(res, 200, { name })
      }
    }

    if (segments[0] === "runs") {
      const id = segments[1] ? slug(decodeURIComponent(segments[1])) : undefined
      if (!id && method === "GET") return json(res, 200, await listRuns())
      if (!id) return json(res, 400, { error: "run id required" })
      const file = path.join(runs, `${id}.json`)
      if (method === "GET") {
        const raw = await fs.readFile(file, "utf8").catch(() => undefined)
        if (raw === undefined) return json(res, 404, { error: `run "${id}" not found` })
        return json(res, 200, JSON.parse(raw))
      }
      if (method === "PUT") {
        const body = await read(req)
        await fs.mkdir(runs, { recursive: true })
        await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n")
        return json(res, 200, { id, path: file })
      }
    }

    next()
  }

  async function listPipelines() {
    const entries = await fs.readdir(pipelines).catch(() => [] as string[])
    const out = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const file = path.join(pipelines, entry)
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

  async function listRuns() {
    const entries = await fs.readdir(runs).catch(() => [] as string[])
    const out = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await fs.readFile(path.join(runs, entry), "utf8").catch(() => "{}")
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
   * block into the real config after taking a `.bak` copy.
   */
  async function writeAgents(name: string, body: any, merge: boolean) {
    const block = { $schema: "https://opencode.ai/config.json", agent: body?.agent ?? {} }
    await fs.mkdir(generated, { recursive: true })
    const file = path.join(generated, `${name}.opencode.json`)
    await fs.writeFile(file, JSON.stringify(block, null, 2) + "\n")
    if (!merge) return { path: file, merged: false }

    const target = path.join(project, "opencode.json")
    const raw = await fs.readFile(target, "utf8").catch(() => undefined)
    let config: any = { $schema: "https://opencode.ai/config.json" }
    if (raw !== undefined) {
      await fs.writeFile(target + ".bak", raw)
      try {
        config = JSON.parse(raw)
      } catch {
        return { path: file, merged: false, error: "existing opencode.json is not valid JSON" }
      }
    }
    config.agent = { ...(config.agent ?? {}), ...block.agent }
    await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n")
    return { path: target, merged: true, backup: raw === undefined ? undefined : target + ".bak" }
  }
}

function slug(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9-_ .]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^\.+/, "") || "untitled"
  )
}

function json(res: any, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

async function read(req: Connect.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

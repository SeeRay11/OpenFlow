import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ModelInfo, Price } from "../../shared/engine"
import type { OmpSettings } from "../../shared/omp"
import { HttpError } from "../host/respond"
import { checkOmp, resolveBinary } from "./binary"
import { PROBE_MODEL } from "./launch"
import { asArray, asNumber, asRecord, asString } from "./messages"
import type { BuildLaunch, OmpProcess, SpawnOmp } from "./rpc-types"
import { readStamp, type CredentialStamp } from "./stamp"

/**
 * The model catalog, read from omp itself: `get_available_models` on a
 * short-lived process. ~738 models arrive as ~8 `rpc_chunk` frames the RPC core
 * reassembles. A process per read is expensive (~2s to ready, ~3s to answer),
 * so the answer is cached and concurrent callers share one flight.
 */

const CACHE_MS = 10 * 60_000
const COMMAND_TIMEOUT_MS = 60_000

export type ModelCatalogDeps = {
  settings(): Promise<OmpSettings>
  spawn: SpawnOmp
  launch: BuildLaunch
  env?: NodeJS.ProcessEnv
  /** The profile's credential stamp, read on every `list()` and folded into the cache key; see `stamp.ts`. */
  stamp?: CredentialStamp
}

export interface ModelCatalog {
  list(): Promise<ModelInfo[]>
  /** Forgets the cached answer: the profile's logins changed. */
  reset(): void
}

export type ModelCatalogOptions = { ttlMs?: number; timeoutMs?: number }

/** Omp's `Model.cost` is USD per million tokens. All four zero means omp quotes nothing: unpriced, never "free". */
function priceOf(cost: unknown): Price[] | undefined {
  const record = asRecord(cost)
  if (!record) return undefined
  const input = asNumber(record.input) ?? 0
  const output = asNumber(record.output) ?? 0
  const read = asNumber(record.cacheRead) ?? 0
  const write = asNumber(record.cacheWrite) ?? 0
  if (input === 0 && output === 0 && read === 0 && write === 0) return undefined
  return [{ input, output, cache: { read, write } }]
}

/** Maps one omp `Model`; entries without a provider and id are not selectable and are dropped. */
export function toModelInfo(raw: unknown): ModelInfo | undefined {
  const model = asRecord(raw)
  const providerID = asString(model?.provider)
  const id = asString(model?.id)
  if (!model || !providerID || !id) return undefined
  const cost = priceOf(model.cost)
  const contextWindow = asNumber(model.contextWindow)
  return {
    providerID,
    id,
    name: asString(model.name),
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    contextWindow,
    capabilities: { input: asArray(model.input).filter((entry): entry is string => typeof entry === "string") },
    ...(cost ? { cost } : {}),
  }
}

/** The resolved omp binary, or the actionable 503 every route answers with when omp is not usable. */
export async function requireBinary(settings: OmpSettings, env: NodeJS.ProcessEnv): Promise<string> {
  const status = await checkOmp(settings, env)
  const binary = status.binary ?? resolveBinary(settings, env)
  if (!status.available || !binary) {
    const text = status.problems.map((problem) => (problem.fix ? `${problem.message} ${problem.fix}` : problem.message)).join(" ")
    throw new HttpError(503, text || "omp is not available.", "omp-unavailable")
  }
  return binary
}

export function createModelCatalog(deps: ModelCatalogDeps, options: ModelCatalogOptions = {}): ModelCatalog {
  const ttlMs = options.ttlMs ?? CACHE_MS
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  let cached: { key: string; at: number; models: ModelInfo[] } | undefined
  let flight: { key: string; promise: Promise<ModelInfo[]> } | undefined

  async function read(settings: OmpSettings): Promise<ModelInfo[]> {
    const env = deps.env ?? process.env
    const binary = await requireBinary(settings, env)

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openflow-models-"))
    let proc: OmpProcess | undefined
    try {
      const spec = deps.launch({
        settings,
        binary,
        session: { runId: "models", nodeId: "catalog", card: { key: "models", role: "catalog" }, model: PROBE_MODEL, directory: dir, permissions: "auto" },
        stateDir: path.join(dir, "state"),
        env,
      })
      proc = deps.spawn(spec)
      await proc.ready
      const data = asRecord(await proc.command({ type: "get_available_models" }, { timeoutMs }))
      const seen = new Set<string>()
      const models: ModelInfo[] = []
      for (const raw of asArray(data?.models)) {
        const info = toModelInfo(raw)
        if (!info || seen.has(`${info.providerID}/${info.id}`)) continue
        seen.add(`${info.providerID}/${info.id}`)
        models.push(info)
      }
      return models
    } catch (error) {
      if (error instanceof HttpError) throw error
      const detail = error instanceof Error ? error.message.trim().split("\n").filter(Boolean).at(-1) : undefined
      throw new HttpError(502, `could not read the model catalog from omp${detail ? `: ${detail.slice(0, 300)}` : ""}. Run \`omp models\` in the terminal to see why.`, "models-unavailable")
    } finally {
      await proc?.close().catch(() => undefined)
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  return {
    async list() {
      const settings = await deps.settings()
      const key = `${settings.binary}|${settings.profile}|${await readStamp(deps.stamp)}`
      if (cached && cached.key === key && Date.now() - cached.at < ttlMs) return cached.models
      if (flight && flight.key === key) return flight.promise
      const promise = read(settings).then((models) => {
        // A reset while this read was in flight means its answer may predate the new logins.
        if (flight?.promise === promise) cached = { key, at: Date.now(), models }
        return models
      })
      const current = { key, promise }
      flight = current
      // Cleared on success and on failure alike: a failure is never cached.
      const clear = () => {
        if (flight === current) flight = undefined
      }
      promise.then(clear, clear)
      return promise
    },
    reset() {
      cached = undefined
      flight = undefined
    },
  }
}

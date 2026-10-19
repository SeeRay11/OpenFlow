import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { OmpProviderRow, OmpSettings } from "../../shared/omp"
import type { BuildLaunch, OmpProcess, SpawnOmp } from "../omp/rpc-types"

/**
 * Which providers the configured profile can log in to, and which it already
 * has credentials for. omp answers this over RPC (`get_login_providers`), so a
 * short-lived `rpc-ui` process is spawned for the one question and closed.
 *
 * `get_login_providers` rows carry no account data, but its sibling
 * `get_logout_accounts` does (emails), so rows are rebuilt from the four known
 * fields: nothing else can leak through this module even if omp adds some.
 */

const CACHE_MS = 60_000
const DEADLINE_MS = 30_000

export type ProvidersDeps = {
  env: NodeJS.ProcessEnv
  spawn: SpawnOmp
  launch: BuildLaunch
}

export type Providers = {
  /** Cached for 60 s per (binary, profile); concurrent callers share one process. */
  list(settings: OmpSettings, binary: string): Promise<OmpProviderRow[]>
  reset(): void
}

export function parseProviders(data: unknown): OmpProviderRow[] {
  const list = (data as { providers?: unknown } | null)?.providers
  if (!Array.isArray(list)) throw new Error("omp answered get_login_providers without a providers list")
  const rows: OmpProviderRow[] = []
  for (const item of list) {
    if (typeof item?.id !== "string" || !item.id) continue
    rows.push({
      id: item.id,
      name: typeof item.name === "string" && item.name ? item.name : item.id,
      available: item.available === true,
      authenticated: item.authenticated === true,
    })
  }
  return rows
}

export function createProviders(deps: ProvidersDeps): Providers {
  let cached: { key: string; at: number; rows: OmpProviderRow[] } | undefined
  let inflight: { key: string; promise: Promise<OmpProviderRow[]> } | undefined

  async function query(settings: OmpSettings, binary: string): Promise<OmpProviderRow[]> {
    const directory = os.tmpdir()
    const stateDir = await mkdtemp(path.join(directory, "openflow-omp-providers-"))
    let proc: OmpProcess | undefined
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => deadline.reject(new Error("omp did not list its providers in time")), DEADLINE_MS)
    deadline.promise.catch(() => undefined)
    try {
      const spec = deps.launch({
        settings,
        binary,
        session: {
          runId: "omp-config",
          nodeId: "providers",
          card: { key: "omp-config-providers", role: "providers" },
          directory,
          permissions: "auto",
        },
        stateDir,
        env: deps.env,
      })
      proc = deps.spawn(spec)
      const started = proc
      const rows = (async () => {
        await started.ready
        return parseProviders(await started.command({ type: "get_login_providers" }, { timeoutMs: DEADLINE_MS }))
      })()
      rows.catch(() => undefined)
      return await Promise.race([rows, deadline.promise])
    } finally {
      clearTimeout(timer)
      if (proc) await proc.close({ graceMs: 1_000, killMs: 1_000 })
      await rm(stateDir, { recursive: true, force: true })
    }
  }

  return {
    async list(settings, binary) {
      const key = `${binary}|${settings.profile}`
      if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.rows
      if (inflight && inflight.key === key) return inflight.promise

      const promise = query(settings, binary)
        .then((rows) => {
          cached = { key, at: Date.now(), rows }
          return rows
        })
        .finally(() => {
          if (inflight?.promise === promise) inflight = undefined
        })
      inflight = { key, promise }
      return promise
    },
    reset() {
      cached = undefined
      inflight = undefined
    },
  }
}

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * The keys `opencode providers login` already stored, so OpenFlow can adopt
 * them instead of asking for them again.
 *
 * The CLI writes provider credentials to `auth.json` in the opencode data
 * directory. The server OpenFlow drives does not read that file for its model
 * catalog — it keys providers through the integration store instead — so an
 * account with four `auth.json` keys still sees nothing but the free zen
 * models. Importing means reading each one and connecting it as an
 * integration.
 *
 * Keys stay on this side: the browser is told which providers are importable,
 * never their secrets, and the connect call is made from here.
 */
export type CliKey = { providerID: string; key: string }

/** Mirrors `Global.Path.data` (xdg-basedir), which is where the CLI writes. */
export function cliAuthPath(env: Record<string, string | undefined> = process.env, home = os.homedir()) {
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return path.join(data, "opencode", "auth.json")
}

/**
 * API keys from `auth.json`, plus whatever `OPENCODE_AUTH_CONTENT` carries —
 * the same two sources the CLI itself reads, in the same order.
 *
 * OAuth entries are skipped: a refresh token is not something
 * `connect/key` can accept, and pretending otherwise would store a string
 * that fails at the first request.
 */
export async function readCliKeys(
  file = cliAuthPath(),
  env: Record<string, string | undefined> = process.env,
): Promise<CliKey[]> {
  const raw = env.OPENCODE_AUTH_CONTENT ?? (await fs.readFile(file, "utf8").catch(() => undefined))
  if (!raw) return []
  return parseCliKeys(raw)
}

export function parseCliKeys(raw: string): CliKey[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const out: CliKey[] = []
  for (const [providerID, value] of Object.entries(parsed as Record<string, any>)) {
    if (!value || typeof value !== "object") continue
    if (value.type !== "api") continue
    if (typeof value.key !== "string" || !value.key) continue
    out.push({ providerID: providerID.replace(/\/+$/, ""), key: value.key })
  }
  return out
}

export type ImportResult = { providerID: string; ok: boolean; error?: string }

/**
 * Connects each key to the running `opencode serve` as an integration.
 *
 * The server stores what it is given without checking it, so a stale CLI key
 * imports "successfully" and only fails when a node runs. Success here means
 * stored, not valid.
 */
export async function importCliKeys(input: {
  upstream: string
  keys: CliKey[]
  only?: string[]
  fetchImpl?: typeof fetch
}): Promise<ImportResult[]> {
  const call = input.fetchImpl ?? fetch
  const wanted = input.only?.length ? new Set(input.only) : undefined
  const out: ImportResult[] = []
  for (const entry of input.keys) {
    if (wanted && !wanted.has(entry.providerID)) continue
    const url = new URL(`/api/integration/${encodeURIComponent(entry.providerID)}/connect/key`, input.upstream)
    try {
      const response = await call(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: entry.key, label: "opencode cli" }),
      })
      if (response.ok) {
        out.push({ providerID: entry.providerID, ok: true })
        continue
      }
      const text = await response.text().catch(() => "")
      out.push({ providerID: entry.providerID, ok: false, error: `${response.status} ${text.slice(0, 200)}`.trim() })
    } catch (error) {
      out.push({
        providerID: entry.providerID,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return out
}

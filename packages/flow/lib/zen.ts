/**
 * What opencode zen actually serves, as opposed to what the catalog claims.
 *
 * The `opencode` provider's models come from models.dev, which lags: on
 * 2026-08-13 the catalog listed 90 zen models and `GET /zen/v1/models` served
 * 61. The other 29 are not "unavailable to this account" — they are gone, and
 * every one of them answers a run with
 *
 *   HTTP 401 {"type":"error","error":{"type":"ModelError",
 *             "message":"Model kimi-k2 is not supported"}}
 *
 * about 1.4s in. That is the first thing a new user meets, since zen is the
 * provider they are most likely to connect first.
 *
 * The list is public — no key, no account — so the flow host can read it
 * directly. It is the only provider that allows this: everyone else's `/models`
 * needs the credential, which lives in the opencode server's store and never
 * reaches OpenFlow.
 *
 * Public to read is not free to run. The same list carries zen's paid models
 * (claude-*, gpt-5*, gemini-*, glm-*, kimi-*) beside the `-free` ids, and a
 * stored zen key unlocks the paid ones with real billing attached. So being on
 * this list only means "zen still serves it"; whether it costs money is decided
 * by `isFreeModel` in [../src/server/providers.ts], never here.
 */
const ENDPOINT = "https://opencode.ai/zen/v1/models"
const TTL = 10 * 60_000
const TIMEOUT = 5_000

let cache: { ids: string[]; at: number } | undefined

/**
 * Model ids zen currently serves, or undefined when the list cannot be read.
 *
 * Undefined is not an empty list and callers must not treat it as one: failing
 * to reach opencode.ai has to leave the catalog alone, or an offline user loses
 * every zen model at once. Wrong in the direction of showing a dead model beats
 * wrong in the direction of hiding a live one.
 */
export async function zenModels(options: { now?: number } = {}): Promise<string[] | undefined> {
  const now = options.now ?? Date.now()
  if (cache && now - cache.at < TTL) return cache.ids
  try {
    const response = await fetch(ENDPOINT, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!response.ok) return cache?.ids
    const ids = parseZenModels(await response.json())
    if (!ids.length) return cache?.ids
    cache = { ids, at: now }
    return ids
  } catch {
    // Stale beats nothing: a list read ten minutes ago is still closer to the
    // truth than models.dev's copy.
    return cache?.ids
  }
}

/** OpenAI-shaped `{ object: "list", data: [{ id }] }`. */
export function parseZenModels(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((item) => (item as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}

/** Test seam — the cache is process-wide and outlives a single request. */
export function resetZenCache() {
  cache = undefined
}

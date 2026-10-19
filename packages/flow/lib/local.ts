import { COMPATIBLE_PACKAGE, isV1Config } from "./repackage"

/**
 * Makes a model running on the user's own machine — Ollama, LM Studio, or any
 * server that speaks OpenAI chat — a provider every card can run on.
 *
 * Nothing in models.dev describes a local server, so the provider has to be
 * declared in config, with its models listed by hand. That is what this writes,
 * into the *global* config for the reason `lib/repackage.ts` gives: a session's
 * drain reads the engine's own config, never the target project's.
 *
 * Four things a declared provider needs that are not obvious, each because the
 * engine's default for it is wrong for a local model:
 *
 * - **An id models.dev does not know.** `catalog.ts` treats a provider as
 *   available only when it has a connection, *unless* no integration exists for
 *   its id at all. `lmstudio` is a models.dev id, so a provider named that is
 *   hidden until somebody stores a key a local server never asked for. Every id
 *   here is prefixed `local-` so none can collide, now or when models.dev grows.
 * - **Tool calling switched on.** An empty model's capabilities say
 *   `tools: false`, and a card with no tools cannot read a file.
 * - **A limit.** The empty default is `{ context: 0, output: 0 }`. The servers'
 *   `/models` listing does not report a context size, so a conservative one is
 *   written and the user can raise it in the file.
 * - **A price of zero.** Written as a real price row, so `server/usage.ts`
 *   prices it exactly like any other model and a gauntlet's cap stays
 *   enforceable — the "unpriced is never $0" rule is untouched, because this
 *   model is priced, at nothing.
 */

export type LocalRuntime = { id: string; name: string; url: string }

/** Default addresses, from each runtime's own documentation. */
export const LOCAL_RUNTIMES: LocalRuntime[] = [
  { id: "local-ollama", name: "Ollama", url: "http://localhost:11434/v1" },
  { id: "local-lmstudio", name: "LM Studio", url: "http://localhost:1234/v1" },
]

/** The one id a user-supplied address is written under. */
export const CUSTOM_LOCAL_ID = "local-custom"

export const LOCAL_PREFIX = "local-"

/** Written for every model: the listing reports no context size, so this is a floor. */
export const LOCAL_LIMIT = { context: 32_768, output: 8_192 }

export function isLocalProvider(id: string) {
  return id.startsWith(LOCAL_PREFIX)
}

/**
 * The base URL a user typed, normalised, or undefined when it is not one.
 *
 * Only http(s). Trailing slashes are dropped so `…/v1/` and `…/v1` are one
 * address — the runner appends `/chat/completions` itself.
 */
export function normalizeUrl(input: unknown) {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim().replace(/\/+$/, "")
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : undefined
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return undefined
  return trimmed
}

/**
 * Model ids an OpenAI-compatible server lists at `GET <url>/models`.
 *
 * Ollama, LM Studio, llama.cpp's server and vLLM all answer this route the same
 * way. A server that is not running answers nothing, which is reported rather
 * than thrown: "Ollama is not running" is the common case, not an error.
 */
export async function discover(url: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`${url}/models`, { signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
  if (!response) return { running: false, models: [] as string[] }
  if (!response.ok) return { running: true, models: [] as string[], error: `${url}/models answered ${response.status}` }
  const body: any = await response.json().catch(() => undefined)
  const models = Array.isArray(body?.data)
    ? body.data.map((entry: any) => entry?.id).filter((id: unknown): id is string => typeof id === "string" && !!id)
    : []
  return { running: true, models: [...new Set<string>(models)].sort() }
}

/** Local providers this config declares, with the url and models each one lists. */
export function declared(config: any) {
  const v1 = Object.entries(config?.provider ?? {}).map(([id, entry]: [string, any]) => ({
    id,
    url: entry?.api,
    models: Object.keys(entry?.models ?? {}),
  }))
  const v2 = Object.entries(config?.providers ?? {}).map(([id, entry]: [string, any]) => ({
    id,
    url: entry?.api?.url,
    models: Object.keys(entry?.models ?? {}),
  }))
  return [...v1, ...v2].filter((entry) => isLocalProvider(entry.id) && typeof entry.url === "string")
}

/**
 * Declares one local provider with exactly these models, in whichever dialect
 * the file is written in (see `isV1Config` — one v1 key sends the whole file
 * through the v1 migration, where `providers` is never read).
 *
 * The models map is *replaced*, not merged: it is the server's own listing, and
 * a model the user deleted from Ollama should stop being offered to cards.
 * What the user edited on a model that is still listed — a raised context
 * limit, most often — is kept. The price is not: it is always zero.
 */
export function declare(config: any, runtime: LocalRuntime, models: string[]) {
  const value = { ...config }
  if (isV1Config(config)) {
    const previous = config?.provider?.[runtime.id]?.models ?? {}
    value.provider = {
      ...value.provider,
      [runtime.id]: {
        ...value.provider?.[runtime.id],
        name: label(runtime),
        npm: COMPATIBLE_PACKAGE,
        api: runtime.url,
        models: Object.fromEntries(
          models.map((id) => [
            id,
            {
              name: id,
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              limit: LOCAL_LIMIT,
              ...previous[id],
              cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            },
          ]),
        ),
      },
    }
    return value
  }

  const previous = config?.providers?.[runtime.id]?.models ?? {}
  value.providers = {
    ...value.providers,
    [runtime.id]: {
      ...value.providers?.[runtime.id],
      name: label(runtime),
      api: { type: "aisdk", package: COMPATIBLE_PACKAGE, url: runtime.url },
      models: Object.fromEntries(
        models.map((id) => [
          id,
          {
            name: id,
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: LOCAL_LIMIT,
            ...previous[id],
            cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
          },
        ]),
      ),
    },
  }
  return value
}

/** Removes a local provider from either dialect. */
export function undeclare(config: any, id: string) {
  const value = { ...config }
  if (value.provider?.[id]) {
    value.provider = { ...value.provider }
    delete value.provider[id]
  }
  if (value.providers?.[id]) {
    value.providers = { ...value.providers }
    delete value.providers[id]
  }
  return value
}

/** The runtime an id names, with the address the caller supplied for a custom one. */
export function runtimeFor(id: string, url?: string): LocalRuntime | undefined {
  const known = LOCAL_RUNTIMES.find((runtime) => runtime.id === id)
  const address = normalizeUrl(url)
  if (known) return { ...known, url: address ?? known.url }
  if (id === CUSTOM_LOCAL_ID && address) return { id, name: "Local server", url: address }
  return undefined
}

/** What the model menu heads this provider with. */
function label(runtime: LocalRuntime) {
  return runtime.id === CUSTOM_LOCAL_ID ? runtime.name : `${runtime.name} (local)`
}

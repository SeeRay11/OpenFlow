import type { Integration } from "./client"

/**
 * How the model dropdown and the provider panel see the server's catalog.
 *
 * Two lists arrive from the server and neither answers the question on its
 * own. `GET /api/integration` lists every provider models.dev knows —
 * ~184 of them — plus the credentials stored for each. `GET /api/model` lists
 * only the models the server would actually accept right now: a provider
 * appears there once it has a stored key OR its environment variable is set.
 *
 * Joining them is what makes the difference visible: "has models" means
 * usable, "has a connection" means OpenFlow stored the key, and a provider
 * with models but no connection is authenticated by environment variable and
 * must not be offered a remove button — there is nothing here to remove.
 */
export type ModelOption = {
  /** The `providerID/modelID` string a node stores. */
  value: string
  id: string
  name: string
  providerID: string
  providerName: string
  /** False when the session runner has no route for this model's API. */
  runnable: boolean
  /** The API shape, shown when it is the reason a model cannot run. */
  api: string
  /**
   * Zen's free tier: runs with no key, no account and no bill.
   *
   * The only flag here that grants access rather than describing it — a free
   * model is offered on a fresh install while every other model on the same
   * locked provider is not. The quota is shared across everyone using it, so a
   * free model can answer `429 FreeUsageLimit` while the paid ones beside it
   * are fine. See [isFreeModel].
   */
  free: boolean
}

/**
 * Whether the server can actually execute this model, as opposed to merely
 * listing it.
 *
 * The v2 session runner routes exactly three API shapes — OpenAI responses,
 * Anthropic messages, and OpenAI-compatible chat with a base URL
 * (`core/src/session/runner/model.ts`, `fromCatalogModel`). Everything else,
 * `@ai-sdk/groq` and `@openrouter/ai-sdk-provider` among them, fails the
 * moment a node dispatches:
 *
 *   SessionRunnerModel.UnsupportedApiError: Unsupported API for
 *   groq/llama-3.3-70b-versatile: aisdk:@ai-sdk/groq
 *
 * The catalog cheerfully lists all of them, which is what makes a keyed
 * provider look connected and still fail. Mirroring the check here is a
 * duplicate of server logic and will drift when the runner learns a new
 * package — the cost of being wrong is a model marked unusable that works, so
 * these stay selectable rather than hidden.
 */
export function runnable(api?: { type?: string; package?: string; url?: string }) {
  if (!api || api.type !== "aisdk") return false
  if (api.package === "@ai-sdk/openai" || api.package === "@ai-sdk/anthropic") return true
  return api.package === "@ai-sdk/openai-compatible" && Boolean(api.url)
}

export type ProviderRow = {
  id: string
  name: string
  /** Environment variables that authenticate this provider without a stored key. */
  env: string[]
  /** Environment variables from `env` that are actually set on the host. */
  envSet: string[]
  /** Credentials OpenFlow (or the server) stored for this provider. */
  connections: Array<{ id: string; label?: string }>
  models: ModelOption[]
  /** Accepts a key through `connect/key` — every models.dev provider does. */
  keyable: boolean
  /** A key reached this provider: stored here, or an env var that is really set. */
  unlocked: boolean
}

/**
 * The order the connect dialog puts providers in, copied from opencode's own
 * `featured` list in `dialog-connect-provider.tsx`.
 */
export const FEATURED = ["opencode", "anthropic", "openai", "google", "openrouter", "vercel"]

export type RawModel = {
  id: string
  providerID: string
  name?: string
  api?: { type?: string; package?: string; url?: string }
}

/**
 * `env` is the set of environment variable names the *host* actually has set,
 * from `GET /flow/api/env`. Without it every provider reads as locked, which is
 * the safe direction: a fresh install shows providers, not models.
 *
 * `serves` is what a provider says it serves, keyed by provider id — today only
 * `opencode`, from `GET /flow/api/zen-models`. A provider absent from the map
 * is left exactly as the catalog reports it; a provider present in it keeps
 * only the models on its own list. See [../../lib/zen.ts] for why the catalog
 * cannot be trusted on this and why an unreachable list must be omitted rather
 * than passed as an empty set.
 */
export function providerRows(
  integrations: Integration[],
  models: RawModel[],
  env: Iterable<string> = [],
  serves?: Map<string, Set<string>>,
): ProviderRow[] {
  const present = env instanceof Set ? env : new Set(env)
  const names = new Map(integrations.map((item) => [item.id, item.name]))
  const byProvider = new Map<string, ModelOption[]>()
  for (const model of models) {
    const listed = serves?.get(model.providerID)
    if (listed && !listed.has(model.id)) continue
    const list = byProvider.get(model.providerID) ?? []
    const routed = runnable(model.api)
    list.push({
      value: `${model.providerID}/${model.id}`,
      id: model.id,
      name: model.name || model.id,
      providerID: model.providerID,
      providerName: names.get(model.providerID) ?? model.providerID,
      runnable: routed,
      api: model.api?.type === "aisdk" ? (model.api.package ?? "aisdk") : (model.api?.type ?? "unknown"),
      free: isFreeModel({ providerID: model.providerID, id: model.id, runnable: routed }),
    })
    byProvider.set(model.providerID, list)
  }

  const rows: ProviderRow[] = integrations.map((item) => {
    const env = item.methods.flatMap((method) => (method.type === "env" ? (method.names ?? []) : []))
    const envSet = env.filter((name) => present.has(name))
    const connections = (item.connections ?? [])
      .filter((connection) => connection.type === "credential")
      .map((connection) => ({ id: connection.id, label: connection.label }))
    return {
      id: item.id,
      name: item.name || item.id,
      env,
      envSet,
      connections,
      models: sortModels(byProvider.get(item.id) ?? []),
      keyable: item.methods.some((method) => method.type === "key"),
      unlocked: connections.length > 0 || envSet.length > 0,
    }
  })

  // A provider the catalog serves models for but the integration list omits
  // still has to be selectable — otherwise its models would vanish from the
  // dropdown while sessions using them keep working.
  for (const [providerID, list] of byProvider) {
    if (rows.some((row) => row.id === providerID)) continue
    rows.push({
      id: providerID,
      name: names.get(providerID) ?? providerID,
      env: [],
      envSet: [],
      connections: [],
      models: sortModels(list),
      keyable: false,
      // Nothing here can be keyed and nothing else explains the models, so the
      // server authenticated it some other way — hiding them would be a lie.
      unlocked: true,
    })
  }

  return rows.sort(compareRows)
}

/**
 * Zen's free tier marks its keyless models with a `-free` suffix on the id
 * (e.g. `nemotron-3.5-lightning-free`). The suffix is the only stable marker —
 * the exact ids change — so it lives here, in one place, rather than as a
 * hardcoded model id anywhere.
 */
const FREE_SUFFIX = "-free"

/**
 * A free, keyless model: served by the `opencode` (zen) provider, actually
 * runnable, and carrying zen's free-tier suffix. This is what lets a fresh
 * install "just try it" with no key and no signup.
 *
 * All three conditions carry weight. The provider check keeps a `-free` id from
 * some other provider — where the suffix means nothing — from unlocking itself.
 * The suffix check keeps zen's *paid* models (claude-*, gpt-5*, glm-*, kimi-*,
 * which sit on the same row and bill a connected account) locked. The runnable
 * check drops the free ids with no route, zen's `gemini-*-free` among them:
 * they use `@ai-sdk/google`, produce no assistant message at all, and reading
 * as free would make silence look like the free tier's fault.
 *
 * Beyond that, a listed model is still only a claim — `deepseek-v4-flash-free`
 * answered HTTP 400 and `mimo-v2.5-free` 429 on 2026-08-23 while their
 * neighbours ran. Which ids are healthy changes by the hour, so nothing here
 * pins one: only a real prompt proves a model, which is what the per-node test
 * button is for.
 *
 * Takes the fields rather than a whole [ModelOption] because it is what
 * computes that type's `free`.
 */
export function isFreeModel(option: { providerID: string; id: string; runnable: boolean }): boolean {
  return option.providerID === "opencode" && option.runnable && option.id.endsWith(FREE_SUFFIX)
}

/** Every runnable free zen model across the catalog, provider order preserved. */
export function freeModels(rows: ProviderRow[]): ModelOption[] {
  return rows.flatMap((row) => row.models).filter((model) => model.free)
}

/**
 * Every model a node could dispatch right now — the set pre-run validation
 * checks a chosen model against.
 *
 * Not "the models of an unlocked provider". Zen's free tier needs no key, so a
 * fresh install can run those and nothing else, while the paid zen models on
 * that same locked row stay out: dispatching one would bill an account the user
 * never connected. Free-ness is per model, so the gate has to be too.
 */
export function availableModels(rows: ProviderRow[]): ModelOption[] {
  return rows.flatMap((row) => row.models.filter((model) => model.runnable && (row.unlocked || model.free)))
}

/** `opencode/<id>` of the first runnable free model, or undefined when none is served. */
export function suggestedFreeDefault(rows: ProviderRow[]): string | undefined {
  return freeModels(rows)[0]?.value
}

/** The server offers models for this provider — it may still not run them. */
export function isActive(row: ProviderRow) {
  return row.models.length > 0
}

/** Models this build can actually dispatch. The number that matters. */
export function usableCount(row: ProviderRow) {
  return row.models.filter((model) => model.runnable).length
}

/** Keyed by OpenFlow rather than by an environment variable. */
export function isConnected(row: ProviderRow) {
  return row.connections.length > 0
}

/**
 * Providers whose models the picker is allowed to show.
 *
 * A model list is not the same as an entitlement. `opencode serve` hands out
 * the free zen models to a browser that has never seen an API key, so a fresh
 * install would otherwise open onto a dropdown full of models the user never
 * chose a provider for. The rule here is the one the user goes through: pick a
 * provider, give it a key — or have its environment variable already set —
 * and only then do its models exist.
 *
 * This stays whole-row and strict, so it still answers "which providers did the
 * user connect". The free zen tier is an exception granted per model, not per
 * provider — [availableModels] and [searchModels] apply it; a row that owes its
 * only runnable models to that exception is still not connected.
 */
export function unlockedRows(rows: ProviderRow[]) {
  return rows.filter((row) => row.unlocked)
}

/** Providers with at least one model this build can dispatch. */
export function readyRows(rows: ProviderRow[]) {
  return unlockedRows(rows).filter((row) => usableCount(row) > 0)
}

/**
 * The connect dialog's two sections: the six providers opencode features, then
 * everything else alphabetically.
 */
export function splitProviders(rows: ProviderRow[]) {
  const popular = rows
    .filter((row) => FEATURED.includes(row.id))
    .sort((a, b) => FEATURED.indexOf(a.id) - FEATURED.indexOf(b.id))
  const other = rows.filter((row) => !FEATURED.includes(row.id)).sort((a, b) => a.name.localeCompare(b.name))
  return { popular, other }
}

/**
 * Providers that can run something first, then providers that list models
 * none of which this build can dispatch (openrouter's 349, groq's 15 — keyed,
 * listed, and dead), then a stored key with no models at all, then the rest.
 */
function compareRows(a: ProviderRow, b: ProviderRow) {
  const rank = (row: ProviderRow) =>
    usableCount(row) ? 0 : isActive(row) ? 1 : isConnected(row) ? 2 : 3
  const difference = rank(a) - rank(b)
  if (difference !== 0) return difference
  return a.name.localeCompare(b.name)
}

/** Runnable models first, so the top of a provider's list is always usable. */
function sortModels(models: ModelOption[]) {
  return [...models].sort((a, b) => {
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Substring match over provider and model, in the order the dropdown renders.
 *
 * A locked provider contributes only its free models — see [unlockedRows] for
 * why everything else of its is hidden, and [isFreeModel] for why the free zen
 * tier is exempt. `openai/gpt` has to match too, so the joined `provider/model`
 * value is part of the haystack rather than the two halves being matched
 * separately.
 */
export function searchModels(rows: ProviderRow[], query: string, limit = 200): ModelOption[] {
  const needle = query.trim().toLowerCase()
  const out: ModelOption[] = []
  for (const row of rows) {
    if (!row.models.length) continue
    const providerHit = !needle || row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle)
    for (const model of row.models) {
      if (!row.unlocked && !model.free) continue
      if (out.length >= limit) return out
      if (
        providerHit ||
        model.value.toLowerCase().includes(needle) ||
        model.name.toLowerCase().includes(needle)
      ) {
        out.push(model)
      }
    }
  }
  return out
}

/** Filters the provider panel: matches id, display name, or environment variable. */
export function searchProviders(rows: ProviderRow[], query: string): ProviderRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter(
    (row) =>
      row.id.toLowerCase().includes(needle) ||
      row.name.toLowerCase().includes(needle) ||
      row.env.some((name) => name.toLowerCase().includes(needle)),
  )
}

/** Groups a flat match list back into the provider headings the list renders. */
export function groupMatches(models: ModelOption[]): Array<{ providerID: string; providerName: string; models: ModelOption[] }> {
  const out: Array<{ providerID: string; providerName: string; models: ModelOption[] }> = []
  for (const model of models) {
    const last = out[out.length - 1]
    if (last && last.providerID === model.providerID) {
      last.models.push(model)
      continue
    }
    out.push({ providerID: model.providerID, providerName: model.providerName, models: [model] })
  }
  return out
}

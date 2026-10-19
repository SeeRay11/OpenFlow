import type { ModelInfo } from "../../shared/engine"
import type { OmpProviderRow } from "../../shared/omp"

/**
 * How the model dropdown sees Omp's catalog.
 *
 * Two lists arrive from the host and neither answers the question on its own.
 * `GET /flow/api/engine/models` lists the models omp can dispatch; `GET
 * /flow/api/omp/providers` lists every provider omp can log in to, with
 * whether credentials are present. Joining them says which models a user can
 * choose *and* which providers are worth offering to connect.
 *
 * Authentication is three-valued on purpose. `authenticated: undefined` means
 * "nobody said" — the provider list failed to load, or omp serves models for a
 * provider it does not list (a custom `models.yml` provider). Hiding those
 * models would be a lie, since omp itself dispatches them, so unknown reads as
 * available. Only an explicit `false` locks a provider.
 */
export type ModelOption = {
  /** The `providerID/modelID` string a node stores. */
  value: string
  id: string
  name: string
  providerID: string
  providerName: string
  reasoning: boolean
  contextWindow?: number
}

export type ProviderRow = {
  id: string
  name: string
  models: ModelOption[]
  /** Omp's verdict on credentials; `undefined` when it gave none. */
  authenticated?: boolean
  /** The user can pick this provider's models: authenticated, or not known to be otherwise. */
  unlocked: boolean
}

/**
 * `providers` is optional: without it every provider is unknown and therefore
 * unlocked, which is the direction that never hides a model omp would run.
 */
export function providerRows(models: ModelInfo[], providers: OmpProviderRow[] = []): ProviderRow[] {
  const listed = new Map(providers.map((provider) => [provider.id, provider]))
  const byProvider = new Map<string, ModelOption[]>()
  for (const model of models) {
    const list = byProvider.get(model.providerID) ?? []
    list.push({
      value: `${model.providerID}/${model.id}`,
      id: model.id,
      name: model.name || model.id,
      providerID: model.providerID,
      providerName: listed.get(model.providerID)?.name ?? model.providerID,
      reasoning: model.reasoning === true,
      contextWindow: model.contextWindow,
    })
    byProvider.set(model.providerID, list)
  }

  const ids = new Set([...listed.keys(), ...byProvider.keys()])
  const rows: ProviderRow[] = []
  for (const id of ids) {
    const provider = listed.get(id)
    rows.push({
      id,
      name: provider?.name ?? id,
      models: (byProvider.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      authenticated: provider?.authenticated,
      unlocked: provider ? provider.authenticated : true,
    })
  }
  return rows.sort(compareRows)
}

/** Providers the user can use first, then those with models to offer, then the rest by name. */
function compareRows(a: ProviderRow, b: ProviderRow) {
  const rank = (row: ProviderRow) => (row.unlocked ? (row.models.length ? 0 : 1) : row.models.length ? 2 : 3)
  const difference = rank(a) - rank(b)
  if (difference !== 0) return difference
  return a.name.localeCompare(b.name)
}

/**
 * Every model a node could dispatch right now — the set pre-run validation
 * checks a chosen model against.
 */
export function availableModels(rows: ProviderRow[]): ModelOption[] {
  return rows.flatMap((row) => (row.unlocked ? row.models : []))
}

/** Providers whose models the picker is allowed to show. */
export function unlockedRows(rows: ProviderRow[]) {
  return rows.filter((row) => row.unlocked)
}

/** Unlocked providers that have at least one model to pick. */
export function readyRows(rows: ProviderRow[]) {
  return unlockedRows(rows).filter((row) => row.models.length > 0)
}

/**
 * Substring match over provider and model, in the order the dropdown renders.
 *
 * A locked provider contributes nothing: choosing one of its models would fail
 * at the first prompt. `openai/gpt` has to match too, so the joined
 * `provider/model` value is part of the haystack rather than the two halves
 * being matched separately.
 */
export function searchModels(rows: ProviderRow[], query: string, limit = 200): ModelOption[] {
  const needle = query.trim().toLowerCase()
  const out: ModelOption[] = []
  for (const row of rows) {
    if (!row.unlocked) continue
    const providerHit = !needle || row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle)
    for (const model of row.models) {
      if (out.length >= limit) return out
      if (providerHit || model.value.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)) {
        out.push(model)
      }
    }
  }
  return out
}

/** Filters providers by id or display name. */
export function searchProviders(rows: ProviderRow[], query: string): ProviderRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((row) => row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
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

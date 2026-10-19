import {
  OMP_ROUTES,
  type OmpConfigEntry,
  type OmpProviderRow,
  type OmpSettingsPatch,
  type OmpSettingsView,
  type OmpStatusView,
  type ValidationError,
} from "../../shared/omp"

/**
 * Browser client for `OMP_ROUTES`. Every call resolves to a result instead of
 * throwing, because the dialog renders each outcome (host down, refused value,
 * omp missing) in place rather than as a toast.
 *
 * `status` is the HTTP status, or 0 when the host never answered: the one case
 * the UI shows as "disconnected" instead of as an error from omp.
 */
export type OmpResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[]; status: number }

export type OmpClientOptions = {
  /** Origin prefix; empty in the browser, `http://127.0.0.1:<port>` in tests. */
  base?: string
  fetch?: typeof fetch
}

export type OmpClient = {
  status(): Promise<OmpResult<OmpStatusView>>
  settings(): Promise<OmpResult<OmpSettingsView>>
  saveSettings(patch: OmpSettingsPatch): Promise<OmpResult<OmpSettingsView>>
  resetSettings(): Promise<OmpResult<OmpSettingsView>>
  config(): Promise<OmpResult<OmpConfigEntry[]>>
  setConfig(key: string, value: unknown): Promise<OmpResult<OmpConfigEntry>>
  resetConfig(key: string): Promise<OmpResult<OmpConfigEntry>>
  providers(): Promise<OmpResult<OmpProviderRow[]>>
}

function readErrors(body: unknown, status: number): ValidationError[] {
  if (typeof body === "object" && body !== null) {
    if ("errors" in body && Array.isArray(body.errors)) {
      const errors = body.errors.filter(
        (item): item is ValidationError =>
          typeof item === "object" && item !== null && typeof item.path === "string" && typeof item.message === "string",
      )
      if (errors.length) return errors
    }
    if ("error" in body && typeof body.error === "string") return [{ path: "", message: body.error }]
  }
  return [{ path: "", message: `The request failed (${status}).` }]
}

export function createOmpClient(options: OmpClientOptions = {}): OmpClient {
  const base = options.base ?? ""
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))

  async function request<Payload, T = Payload>(
    route: string,
    method: string,
    body?: unknown,
    pick?: (payload: Payload) => T,
  ): Promise<OmpResult<T>> {
    let response: Response
    try {
      response = await doFetch(`${base}${route}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      return { ok: false, status: 0, errors: [{ path: "", message: "The OpenFlow host did not answer." }] }
    }
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) return { ok: false, status: response.status, errors: readErrors(payload, response.status) }
    // The host is this app's own server: its 2xx bodies are the types in `OMP_ROUTES`' contract.
    return { ok: true, value: pick ? pick(payload as Payload) : (payload as T) }
  }

  const key = (name: string) => `${OMP_ROUTES.config}/${encodeURIComponent(name)}`

  return {
    status: () => request<OmpStatusView>(OMP_ROUTES.status, "GET"),
    settings: () => request<OmpSettingsView>(OMP_ROUTES.settings, "GET"),
    saveSettings: (patch) => request<OmpSettingsView>(OMP_ROUTES.settings, "PUT", patch),
    resetSettings: () => request<OmpSettingsView>(OMP_ROUTES.settingsReset, "POST"),
    config: () =>
      request<{ entries: OmpConfigEntry[] }, OmpConfigEntry[]>(OMP_ROUTES.config, "GET", undefined, (payload) => payload.entries),
    setConfig: (name, value) =>
      request<{ entry: OmpConfigEntry }, OmpConfigEntry>(key(name), "PUT", { value }, (payload) => payload.entry),
    resetConfig: (name) =>
      request<{ entry: OmpConfigEntry }, OmpConfigEntry>(`${key(name)}/reset`, "POST", undefined, (payload) => payload.entry),
    providers: () =>
      request<{ providers: OmpProviderRow[] }, OmpProviderRow[]>(OMP_ROUTES.providers, "GET", undefined, (payload) => payload.providers),
  }
}

export const omp: OmpClient = createOmpClient()

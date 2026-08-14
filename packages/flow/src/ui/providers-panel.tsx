import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import * as api from "../server/client"
import {
  isConnected,
  searchProviders,
  splitProviders,
  usableCount,
  type ProviderRow,
} from "../server/providers"
import { store } from "../server/store"
import { IconBack, IconCheck, IconClose, IconSearch } from "./icons"

/**
 * Connect a provider, in opencode's two steps.
 *
 * `packages/app/src/components/dialog-connect-provider.tsx` does exactly this:
 * pick from a searchable list (featured providers first, everything else
 * after), then a single field for that provider's API key. Nothing else is on
 * screen at either step, which is the whole point — a fresh install has no
 * models to choose from, so the only thing to do is choose a provider.
 *
 * The key goes to `POST /api/integration/:id/connect/key`, the store the model
 * catalog actually reads. `opencode providers login` writes somewhere else
 * (`auth.json`), which is why an account can hold four CLI keys and still see
 * nothing here — hence the import row. Nothing validates a key on the way in:
 * the server stores the string it is given, so a typo surfaces later as a 401
 * mid-run.
 */
export function ProvidersPanel(props: {
  rows: ProviderRow[]
  /** Seeded when the dialog is opened from a model search that found nothing. */
  initialQuery?: string
  onClose: () => void
  onChanged: () => Promise<void> | void
  onNotice: (kind: "info" | "error", text: string) => void
}) {
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [picked, setPicked] = createSignal<string>()
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [cli, setCli] = createSignal<{ path: string; providers: string[] }>()

  const matched = createMemo(() => searchProviders(props.rows, query()))
  const connected = createMemo(() => matched().filter((row) => row.unlocked))
  const rest = createMemo(() => splitProviders(matched().filter((row) => !row.unlocked)))
  const provider = createMemo(() => props.rows.find((row) => row.id === picked()))
  const importable = createMemo(() => {
    const found = cli()?.providers ?? []
    const keyed = new Set(props.rows.filter(isConnected).map((row) => row.id))
    return found.filter((id) => !keyed.has(id))
  })

  onMount(async () => {
    setCli(await store.cliKeys().catch(() => undefined))
  })

  function open(row: ProviderRow) {
    setPicked(row.id)
    setKey("")
    setError(undefined)
  }

  async function save(event: Event) {
    event.preventDefault()
    const row = provider()
    if (!row) return
    const value = key().trim()
    if (!value) return setError("Enter an API key.")
    setBusy(true)
    setError(undefined)
    try {
      await api.connectKey(row.id, value, "openflow")
      await props.onChanged()
      props.onNotice("info", `${row.name} connected — the key is not verified until a model runs`)
      setPicked(undefined)
    } catch (failure) {
      setError(api.describe(failure))
    } finally {
      setBusy(false)
    }
  }

  async function remove(row: ProviderRow) {
    setBusy(true)
    try {
      for (const connection of row.connections) await api.removeCredential(connection.id)
      await props.onChanged()
      props.onNotice("info", `removed the stored key for ${row.name}`)
      setPicked(undefined)
    } catch (failure) {
      setError(api.describe(failure))
    } finally {
      setBusy(false)
    }
  }

  async function importCli() {
    setBusy(true)
    try {
      const { results } = await store.importCliKeys(importable())
      await props.onChanged()
      const failed = results.filter((result) => !result.ok)
      if (failed.length) {
        props.onNotice(
          "error",
          `imported ${results.length - failed.length}/${results.length}; failed: ${failed
            .map((result) => `${result.providerID} (${result.error})`)
            .join(", ")}`,
        )
        return
      }
      props.onNotice("info", `imported ${results.length} key${results.length === 1 ? "" : "s"} from the opencode CLI`)
    } catch (failure) {
      props.onNotice("error", api.describe(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <Show when={provider()}>
            <button type="button" class="oc-clear" aria-label="Back" onClick={() => setPicked(undefined)}>
              <IconBack />
            </button>
          </Show>
          <h2>{provider() ? `Connect ${provider()!.name}` : "Connect a provider"}</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>

        <Show when={provider()} fallback={<ProviderList />}>
          {(row) => <KeyForm row={row()} />}
        </Show>
      </section>
    </div>
  )

  function ProviderList() {
    return (
      <>
        <div class="oc-menu-search oc-dialog-search">
          <IconSearch />
          <input
            autofocus
            value={query()}
            placeholder="Search providers…"
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>

        <Show when={importable().length}>
          <div class="oc-banner">
            <span>
              The opencode CLI holds {importable().length} key{importable().length === 1 ? "" : "s"} this server does not
              use ({importable().join(", ")}).
            </span>
            <button type="button" class="oc-button" disabled={busy()} onClick={importCli}>
              Import
            </button>
          </div>
        </Show>

        <div class="oc-dialog-body">
          <Show when={connected().length}>
            <div class="oc-group">Connected</div>
            <For each={connected()}>{(row) => <Row row={row} />}</For>
          </Show>
          <Show when={rest().popular.length}>
            <div class="oc-group">Popular</div>
            <For each={rest().popular}>{(row) => <Row row={row} />}</For>
          </Show>
          <Show when={rest().other.length}>
            <div class="oc-group">All providers</div>
            <For each={rest().other}>{(row) => <Row row={row} />}</For>
          </Show>
          <Show when={!matched().length}>
            <div class="oc-menu-empty">No provider matches “{query()}”.</div>
          </Show>
        </div>
      </>
    )
  }

  function Row(item: { row: ProviderRow }) {
    return (
      <button type="button" class="oc-item" onClick={() => open(item.row)}>
        <span class="oc-item-label">{item.row.name}</span>
        <Show when={item.row.unlocked}>
          <span class="oc-check">
            <IconCheck />
          </span>
        </Show>
        <Show when={item.row.unlocked && usableCount(item.row)}>
          <span class="oc-tag">{usableCount(item.row)} models</span>
        </Show>
        <Show when={item.row.unlocked && !usableCount(item.row)}>
          <span class="oc-tag" title="the key is stored, but this server cannot dispatch any of the provider's models">
            no runnable models
          </span>
        </Show>
        <Show when={!item.row.unlocked && item.row.env.length}>
          <span class="oc-tag oc-faint">{item.row.env[0]}</span>
        </Show>
      </button>
    )
  }

  function KeyForm(item: { row: ProviderRow }) {
    return (
      <form class="oc-form" onSubmit={save}>
        <p class="oc-note">
          <Show
            when={item.row.envSet.length}
            fallback={<>Paste an API key for {item.row.name}. It is stored by the running opencode server.</>}
          >
            {item.row.name} is already authenticated by {item.row.envSet.join(", ")}. A key stored here takes over.
          </Show>
        </p>

        <label>
          {item.row.name} API key
          <input
            autofocus
            type="password"
            name="apiKey"
            placeholder="sk-…"
            spellcheck={false}
            autocomplete="off"
            value={key()}
            onInput={(event) => setKey(event.currentTarget.value)}
          />
        </label>

        <Show when={error()}>{(text) => <p class="oc-error">{text()}</p>}</Show>

        <Show when={!item.row.keyable}>
          <p class="oc-note">
            This provider takes no key — it comes from the catalog itself, and its models appear only when the server
            authenticates it another way.
          </p>
        </Show>

        <div class="oc-form-actions">
          <button type="submit" class="oc-button oc-primary" disabled={busy() || !item.row.keyable}>
            {isConnected(item.row) ? "Replace key" : "Continue"}
          </button>
          <Show when={isConnected(item.row)}>
            <button type="button" class="oc-button oc-danger" disabled={busy()} onClick={() => remove(item.row)}>
              Disconnect
            </button>
          </Show>
        </div>

        <p class="oc-note oc-faint">
          Keys take effect immediately — no restart. They are not checked here; use <strong>test</strong> next to a
          node's model to find out whether one answers.
        </p>
      </form>
    )
  }
}

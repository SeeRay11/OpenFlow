import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import * as api from "../server/client"
import {
  isConnected,
  searchProviders,
  splitProviders,
  usableCount,
  type ProviderRow,
} from "../server/providers"
import { store, type LocalRuntimeStatus } from "../server/store"
import { state } from "../state"
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
  /** Restarts `opencode serve`, when this host owns it — a repackage needs one. */
  onRestart?: () => Promise<void> | void
}) {
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [picked, setPicked] = createSignal<string>()
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [cli, setCli] = createSignal<{ path: string; providers: string[] }>()
  const [repack, setRepack] = createSignal<{ path: string; applied: string[]; available: string[]; error?: string }>()

  const matched = createMemo(() => searchProviders(props.rows, query()))
  const connected = createMemo(() => matched().filter((row) => row.unlocked))
  const rest = createMemo(() => splitProviders(matched().filter((row) => !row.unlocked)))
  const provider = createMemo(() => props.rows.find((row) => row.id === picked()))
  const importable = createMemo(() => {
    const found = cli()?.providers ?? []
    const keyed = new Set(props.rows.filter(isConnected).map((row) => row.id))
    return found.filter((id) => !keyed.has(id))
  })

  /**
   * Connected providers whose models this engine cannot dispatch until the
   * global config repackages them onto `@ai-sdk/openai-compatible`. Only the
   * connected ones: repackaging a provider nobody has a key for fixes nothing
   * and edits a file for no reason. See [../../lib/repackage.ts].
   */
  const repackageable = createMemo(() => {
    const status = repack()
    if (!status || status.error) return []
    const applied = new Set(status.applied)
    const offered = new Set(status.available)
    return props.rows.filter((row) => row.unlocked && offered.has(row.id) && !applied.has(row.id)).map((row) => row.id)
  })

  const [local, setLocal] = createSignal<LocalRuntimeStatus[]>([])
  const [customUrl, setCustomUrl] = createSignal<string>()

  onMount(async () => {
    setCli(await store.cliKeys().catch(() => undefined))
    setRepack(await store.repackageStatus().catch(() => undefined))
    setLocal((await store.localStatus().catch(() => undefined))?.runtimes ?? [])
  })

  /**
   * Declares what a local server serves right now, then restarts the engine —
   * config is read once at boot, so the models do not exist for any card until
   * it does. Re-running it on a declared server is how a newly pulled model gets
   * picked up. See [../../lib/local.ts].
   */
  async function useLocal(id: string, url?: string) {
    setBusy(true)
    try {
      const result = await store.addLocal(id, url)
      setLocal((await store.localStatus().catch(() => undefined))?.runtimes ?? [])
      setCustomUrl(undefined)
      if (!result.changed) return props.onNotice("info", `${result.models.length} local models already set up`)
      props.onNotice("info", `added ${result.models.length} local model${result.models.length === 1 ? "" : "s"} at $0 in ${result.path}`)
      if (result.restart && props.onRestart) await props.onRestart()
      await props.onChanged()
      if (result.restart && !props.onRestart) props.onNotice("info", "restart `opencode serve` for the local models to appear")
    } catch (failure) {
      props.onNotice("error", api.describe(failure))
    } finally {
      setBusy(false)
    }
  }

  async function dropLocal(id: string) {
    setBusy(true)
    try {
      const result = await store.removeLocal(id)
      setLocal((await store.localStatus().catch(() => undefined))?.runtimes ?? [])
      if (result.restart && props.onRestart) await props.onRestart()
      await props.onChanged()
    } catch (failure) {
      props.onNotice("error", api.describe(failure))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Escape backs out one step, then closes — the same two-step retreat
   * opencode's dialog gives you, so a mistyped provider does not force a
   * round trip through the mouse.
   */
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    if (picked()) return setPicked(undefined)
    props.onClose()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

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

  /**
   * Writes the override and restarts the engine, because config is read once at
   * boot — without the restart the models stay exactly as unroutable as before.
   */
  async function applyRepackage() {
    setBusy(true)
    try {
      const result = await store.repackage(repackageable())
      setRepack(await store.repackageStatus().catch(() => undefined))
      props.onNotice("info", `repackaged ${result.changed.join(", ")} in ${result.path}`)
      if (result.restart && props.onRestart) await props.onRestart()
      await props.onChanged()
      if (result.restart && !props.onRestart)
        props.onNotice("info", "restart `opencode serve` for the repackaged providers to dispatch")
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

        <Show when={repackageable().length}>
          <div class="oc-banner">
            <span>
              This engine cannot dispatch {repackageable().join(", ")} — its runner routes only OpenAI, Anthropic and
              OpenAI-compatible APIs. Repackaging rewrites them as OpenAI-compatible in {repack()?.path}.
            </span>
            <button type="button" class="oc-button" disabled={busy()} onClick={applyRepackage}>
              Repackage
            </button>
          </div>
        </Show>

        <div class="oc-dialog-body">
          <Show when={connected().length}>
            <div class="oc-group">Connected</div>
            <For each={connected()}>{(row) => <Row row={row} />}</For>
          </Show>
          <Show when={!query() && local().length}>
            <div class="oc-group">Local models · free, on this machine</div>
            <For each={local()}>{(runtime) => <LocalRow runtime={runtime} />}</For>
            <Show
              when={customUrl() !== undefined}
              fallback={
                <button type="button" class="oc-item" onClick={() => setCustomUrl("http://localhost:8000/v1")}>
                  <span class="oc-item-label">Other OpenAI-compatible server…</span>
                  <span class="oc-tag oc-faint">llama.cpp, vLLM</span>
                </button>
              }
            >
              <form
                class="oc-form oc-inline-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void useLocal("local-custom", customUrl())
                }}
              >
                <input
                  autofocus
                  class="mono"
                  value={customUrl()}
                  spellcheck={false}
                  autocomplete="off"
                  aria-label="Base URL"
                  onInput={(event) => setCustomUrl(event.currentTarget.value)}
                />
                <button type="submit" class="oc-button" disabled={busy()}>
                  Add
                </button>
              </form>
            </Show>
          </Show>
          <Show when={rest().popular.length}>
            <div class="oc-group">Popular</div>
            <For each={rest().popular}>{(row) => <Row row={row} />}</For>
          </Show>
          <Show when={rest().other.length}>
            <div class="oc-group">All providers</div>
            <For each={rest().other}>{(row) => <Row row={row} />}</For>
          </Show>
          {/*
            An unreachable engine leaves `rows` empty, which used to render as
            `No provider matches ""` — blaming an empty search box for a dead
            server. The catalog being unreadable is a different sentence.
          */}
          <Show when={!matched().length}>
            <div class="oc-menu-empty">
              <Show
                when={!state.engineReachable && !props.rows.length}
                fallback={<>No provider matches “{query()}”.</>}
              >
                No providers to show — `opencode serve` is not answering, so the catalog could not be read. Start or
                restart the engine, then reopen this dialog.
              </Show>
            </div>
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

  /**
   * One local server. A click sets it up — or, when it is set up, picks up any
   * model pulled since — and the tag says which of those a click will do.
   */
  function LocalRow(item: { runtime: LocalRuntimeStatus }) {
    const fresh = () => {
      const declared = item.runtime.declared
      return !!declared && declared.length === item.runtime.models.length && declared.every((id) => item.runtime.models.includes(id))
    }
    return (
      <div class="oc-item-row">
        <button
          type="button"
          class="oc-item"
          disabled={busy() || !item.runtime.running || !item.runtime.models.length}
          title={item.runtime.error ?? item.runtime.url}
          onClick={() => useLocal(item.runtime.id, item.runtime.url)}
        >
          <span class="oc-item-label">{item.runtime.name}</span>
          <span class="oc-tag oc-faint mono">{item.runtime.url.replace(/^https?:\/\//, "")}</span>
          <Show when={item.runtime.declared}>
            <span class="oc-check">
              <IconCheck />
            </span>
          </Show>
          <span class="oc-tag">
            {!item.runtime.running
              ? "not running"
              : !item.runtime.models.length
                ? "no models"
                : fresh()
                  ? `${item.runtime.models.length} models · $0`
                  : item.runtime.declared
                    ? "new models — update"
                    : `use ${item.runtime.models.length} models`}
          </span>
        </button>
        <Show when={item.runtime.declared}>
          <button
            type="button"
            class="oc-clear"
            aria-label={`Remove ${item.runtime.name}`}
            disabled={busy()}
            onClick={() => dropLocal(item.runtime.id)}
          >
            <IconClose />
          </button>
        </Show>
      </div>
    )
  }

  function KeyForm(item: { row: ProviderRow }) {
    return (
      <form class="oc-form" onSubmit={save}>
        <Show when={item.row.id === "anthropic"}>
          <p class="oc-note">
            Claude runs here on an API key from <span class="mono">console.anthropic.com</span>, billed per token. A
            Claude Pro or Max subscription cannot be used by other apps. To pay from AWS or Google Cloud credits
            instead, connect OpenRouter and add your Bedrock or Vertex key under its BYOK settings.
          </p>
        </Show>
        <Show when={item.row.id === "openrouter"}>
          <p class="oc-note">
            Claude through OpenRouter bills OpenRouter credits, or your own Anthropic, Bedrock or Vertex key if you add
            one under its BYOK settings. Repackage it after connecting so this engine can dispatch it.
          </p>
        </Show>
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

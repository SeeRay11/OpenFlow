import { For, Show, createResource, createSignal, onCleanup } from "solid-js"
import * as api from "../server/client"
import { store, type BrowseResult } from "../server/store"
import { IconBack, IconClose, IconFolder } from "./icons"

/**
 * Switches the live project directory from a server-side folder browser.
 *
 * A browser input cannot hand back a real OS path — the File System Access
 * API only yields a sandboxed handle — so this drills through directories via
 * `GET /flow/api/browse` instead of a native picker, the same way
 * `dialog-connect-provider` drills through a list rather than free text. The
 * switch itself (`POST /flow/api/project`) takes effect with no server
 * restart, mirroring how a connected provider key needs none either.
 */
export function ProjectPicker(props: { current: string; onClose: () => void; onSwitched: (project: string) => void }) {
  const [target, setTarget] = createSignal<string | undefined>(props.current)
  const [manual, setManual] = createSignal(props.current)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [browsed] = createResource(target, (path) => store.browse(path).catch((failure) => {
    setError(api.describe(failure))
    return undefined
  }))

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    props.onClose()
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  function enter(path: string) {
    setError(undefined)
    setManual(path)
    setTarget(path)
  }

  async function use(path: string) {
    setBusy(true)
    setError(undefined)
    try {
      const paths = await store.setProject(path)
      api.disconnect()
      props.onSwitched(paths.project)
    } catch (failure) {
      setError(api.describe(failure))
    } finally {
      setBusy(false)
    }
  }

  function onManualSubmit(event: Event) {
    event.preventDefault()
    const value = manual().trim()
    if (value) enter(value)
  }

  return (
    <div class="oc oc-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <section class="oc-dialog">
        <header class="oc-dialog-head">
          <Show when={browsed()?.parent}>
            <button type="button" class="oc-clear" aria-label="Up one level" onClick={() => enter(browsed()!.parent!)}>
              <IconBack />
            </button>
          </Show>
          <h2>Switch project</h2>
          <button type="button" class="oc-clear" aria-label="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </header>

        <form class="oc-menu-search oc-dialog-search" onSubmit={onManualSubmit}>
          <IconFolder />
          <input
            value={manual()}
            placeholder="paste or type an absolute path"
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => setManual(event.currentTarget.value)}
          />
        </form>

        <Show when={error()}>{(text) => <p class="oc-error">{text()}</p>}</Show>

        <div class="oc-dialog-body">
          <Show when={browsed.loading}>
            <div class="oc-menu-empty">reading…</div>
          </Show>
          <Show when={browsed()} keyed>
            {(result: BrowseResult) => (
              <>
                <Show when={!result.entries.length}>
                  <div class="oc-menu-empty">No subdirectories here.</div>
                </Show>
                <For each={result.entries}>
                  {(entry) => (
                    <button type="button" class="oc-item" onDblClick={() => enter(entry.path)} onClick={() => setManual(entry.path)}>
                      <span class="oc-item-label">{entry.name}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </Show>
        </div>

        <div class="oc-form-actions">
          <button
            type="button"
            class="oc-button oc-primary"
            disabled={busy() || !manual().trim()}
            onClick={() => use(manual())}
          >
            Use this folder
          </button>
        </div>

        <p class="oc-note oc-faint">
          Double-click a folder to open it, single-click to select it, or type/paste a path directly. Takes effect
          immediately for new sessions — no restart.
        </p>
      </section>
    </div>
  )
}

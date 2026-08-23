import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import {
  freeModels,
  groupMatches,
  readyRows,
  searchModels,
  searchProviders,
  unlockedRows,
  type ProviderRow,
} from "../server/providers"
import { defaultModel, setDefaultModel } from "../graph/default-model"
import { IconChevron, IconClose, IconSearch, IconSliders } from "./icons"

/**
 * The model field, built as opencode's own model menu.
 *
 * Same shape as `packages/app/src/components/dialog-select-model.tsx`: a 284px
 * popover, a search row, provider headings, one row per model, and a single
 * action pinned under a divider at the bottom. Arrow keys move, Enter picks,
 * Escape closes, and typing filters — the pointer never has to be involved.
 *
 * What it will not do is show a model for a provider nobody connected. The
 * server hands out the free zen models to a browser that has never seen a key
 * ([../server/providers.ts], `unlockedRows`), so an unfiltered list would open
 * on a fresh install already full of models. Empty until a key exists is the
 * honest state, and the empty state is a link to the place that fixes it.
 */
export function ModelPicker(props: {
  value?: string
  rows: ProviderRow[]
  onChange: (value: string) => void
  onManage?: (query?: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal("")
  let root: HTMLDivElement | undefined
  let field: HTMLInputElement | undefined

  const CONNECT = "action:connect"
  const matches = createMemo(() => searchModels(props.rows, query()))
  const groups = createMemo(() => groupMatches(matches()))
  const FREE = "free:"
  /**
   * Free zen models pinned above every provider, but only with an empty query —
   * a search should behave exactly as it did before. These carry a `free:` key
   * prefix so arrow-key nav reaches them even though the same model can also
   * appear, un-pinned, under its provider group.
   */
  const free = createMemo(() => (query().trim() ? [] : freeModels(props.rows)))
  const unlocked = createMemo(() => unlockedRows(props.rows))
  const ready = createMemo(() => readyRows(props.rows))
  /**
   * Providers the query names but nobody connected.
   *
   * Searching "anthropic" with no anthropic key would otherwise answer "no
   * models" and leave the user to guess whether the provider exists, is
   * misspelled, or simply has no key — the one case where the empty list is
   * not the whole answer.
   */
  const lockedMatches = createMemo(() =>
    query().trim() ? searchProviders(props.rows.filter((row) => !row.unlocked), query()).slice(0, 3) : [],
  )
  const CLEAR = "action:clear"
  const DEFAULT = "action:default"
  /** Only offer "set as default" when a model is chosen and is not already it. */
  const canSetDefault = createMemo(() => Boolean(props.value) && props.value !== defaultModel())
  const keys = createMemo(() => [
    ...free().map((model) => `${FREE}${model.value}`),
    ...matches().map((model) => model.value),
    ...(props.value ? [CLEAR] : []),
    ...(canSetDefault() ? [DEFAULT] : []),
    CONNECT,
  ])

  function show() {
    if (props.disabled) return
    setQuery("")
    setOpen(true)
    setActive(props.value && matches().some((model) => model.value === props.value) ? props.value : (keys()[0] ?? ""))
    queueMicrotask(() => field?.focus())
  }

  function choose(value: string) {
    props.onChange(value)
    setOpen(false)
  }

  function connect(search?: string) {
    setOpen(false)
    props.onManage?.(search)
  }

  /** Pins the chosen model as the app-wide default for future new nodes. */
  function setAsDefault() {
    if (props.value) setDefaultModel(props.value)
    setOpen(false)
  }

  function move(step: number) {
    const options = keys()
    if (!options.length) return
    const index = options.indexOf(active())
    setActive(options[((index < 0 ? 0 : index) + step + options.length) % options.length])
    queueMicrotask(() =>
      root?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active())}"]`)?.scrollIntoView({ block: "nearest" }),
    )
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") return setOpen(false)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      return move(event.key === "ArrowDown" ? 1 : -1)
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    if (active() === CONNECT) return connect()
    // A pinned free row picks the plain model value its `free:` key wraps.
    if (active().startsWith(FREE)) return choose(active().slice(FREE.length))
    // "clear" carries a key of its own because the value it picks is "", which
    // a truthiness check would swallow.
    if (active() === CLEAR) return choose("")
    if (active() === DEFAULT) return setAsDefault()
    if (active()) choose(active())
  }

  const onPointerDown = (event: MouseEvent) => {
    if (!root || root.contains(event.target as Node)) return
    setOpen(false)
  }
  document.addEventListener("mousedown", onPointerDown)
  onCleanup(() => document.removeEventListener("mousedown", onPointerDown))

  return (
    <div class="oc-picker" ref={root}>
      <button
        type="button"
        class="oc-trigger"
        disabled={props.disabled}
        onClick={() => (open() ? setOpen(false) : show())}
      >
        <span class="oc-trigger-label" classList={{ "oc-faint": !props.value }}>
          {props.value || "Agent default"}
        </span>
        <IconChevron />
      </button>

      <Show when={open()}>
        <div class="oc-menu">
          <div class="oc-menu-search">
            <IconSearch />
            <input
              ref={field}
              value={query()}
              placeholder="Search models…"
              spellcheck={false}
              autocomplete="off"
              autocapitalize="off"
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                setActive(keys()[0] ?? "")
              }}
              onKeyDown={onKey}
            />
            <Show when={query()}>
              <button
                type="button"
                class="oc-clear"
                aria-label="Clear"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  setQuery("")
                  setActive(keys()[0] ?? "")
                  field?.focus()
                }}
              >
                <IconClose />
              </button>
            </Show>
          </div>

          <div class="oc-divider" />

          <div class="oc-menu-list">
            <Show when={free().length}>
              <div class="oc-group">Free — no key needed</div>
              <For each={free()}>
                {(model) => (
                  <button
                    type="button"
                    class="oc-item"
                    data-key={`${FREE}${model.value}`}
                    data-active={active() === `${FREE}${model.value}` ? true : undefined}
                    data-selected={props.value === model.value ? true : undefined}
                    title={model.value}
                    onMouseEnter={() => setActive(`${FREE}${model.value}`)}
                    onClick={() => choose(model.value)}
                  >
                    <span class="oc-item-label">{model.name}</span>
                    <span class="oc-tag">free</span>
                  </button>
                )}
              </For>
              <div class="oc-divider" />
            </Show>

            <Show
              when={matches().length}
              fallback={
                <>
                  <div class="oc-menu-empty">
                    <Show when={unlocked().length} fallback={<>No provider connected yet.</>}>
                      No models match “{query()}”.
                    </Show>
                  </div>
                  <For each={lockedMatches()}>
                    {(row) => (
                      <button type="button" class="oc-item" onClick={() => connect(row.name)}>
                        <span class="oc-item-label oc-faint">Connect {row.name}</span>
                        <span class="oc-tag">not connected</span>
                      </button>
                    )}
                  </For>
                </>
              }
            >
              <For each={groups()}>
                {(group) => (
                  <>
                    <div class="oc-group">{group.providerName}</div>
                    <For each={group.models}>
                      {(model) => (
                        <button
                          type="button"
                          class="oc-item"
                          data-key={model.value}
                          data-active={active() === model.value ? true : undefined}
                          data-selected={props.value === model.value ? true : undefined}
                          title={
                            model.runnable
                              ? model.value
                              : `${model.value} — this server has no route for ${model.api}, so a run fails with UnsupportedApiError`
                          }
                          onMouseEnter={() => setActive(model.value)}
                          onClick={() => choose(model.value)}
                        >
                          <span class="oc-item-label">{model.name}</span>
                          <Show when={!model.runnable}>
                            <span class="oc-tag">no runner</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </Show>

            <Show when={props.value}>
              <div class="oc-divider" />
              <button
                type="button"
                class="oc-item"
                data-key={CLEAR}
                data-active={active() === CLEAR ? true : undefined}
                onMouseEnter={() => setActive(CLEAR)}
                onClick={() => choose("")}
              >
                <span class="oc-item-label oc-faint">Agent default</span>
              </button>
            </Show>
          </div>

          <div class="oc-divider" />

          <Show when={canSetDefault()}>
            <button
              type="button"
              class="oc-item"
              data-key={DEFAULT}
              data-active={active() === DEFAULT ? true : undefined}
              onMouseEnter={() => setActive(DEFAULT)}
              onClick={setAsDefault}
            >
              <span class="oc-item-label">Set as default for new nodes</span>
            </button>
          </Show>

          <Show when={defaultModel()}>
            <div class="oc-group">default for new nodes: {defaultModel()}</div>
          </Show>

          <button
            type="button"
            class="oc-item"
            data-key={CONNECT}
            data-active={active() === CONNECT ? true : undefined}
            onMouseEnter={() => setActive(CONNECT)}
            onClick={() => connect()}
          >
            <IconSliders />
            <span class="oc-item-label">Providers</span>
            <span class="oc-tag">{ready().length}</span>
          </button>
        </div>
      </Show>
    </div>
  )
}
